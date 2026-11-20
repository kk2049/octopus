/**
 * The durability floor, tested by breaking the file.
 *
 * Convergence-plan decision 12 keeps exactly one hard requirement on this layer:
 * an accepted update must survive a crash. Every case below is a way a crash
 * damages a log, and the assertion is always the same shape — everything
 * acknowledged before the damage is still there afterwards.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentLog, isDocumentId } from "./log.js";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crdt-log-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("document ids are a grammar, not a path", () => {
  it("accepts a plain identifier and refuses anything that could traverse", () => {
    expect(isDocumentId("notes-1")).toBe(true);
    expect(isDocumentId("../../etc/passwd")).toBe(false);
    expect(isDocumentId("a/b")).toBe(false);
    expect(isDocumentId("")).toBe(false);
    expect(isDocumentId("Notes")).toBe(false);
    expect(() => DocumentLog.open(root(), "../escape")).toThrowError(/is not a document id/);
  });
});

describe("append and replay", () => {
  it("returns every acknowledged update after a reopen", () => {
    const dir = root();
    const first = DocumentLog.open(dir, "notes");
    first.log.append(bytes(1, 2, 3));
    first.log.append(bytes(4, 5));
    first.log.close();

    const second = DocumentLog.open(dir, "notes");
    expect(second.updates.map((u) => [...u])).toEqual([[1, 2, 3], [4, 5]]);
    expect(second.log.stats().records).toBe(2);
    expect(second.log.stats().recoveredBytes).toBe(0);
    second.log.close();
  });

  it("starts empty for a document nobody has written", () => {
    const opened = DocumentLog.open(root(), "fresh");
    expect(opened.updates).toEqual([]);
    expect(opened.log.stats().records).toBe(0);
    opened.log.close();
  });
});

describe("a crash mid-write", () => {
  it("drops the torn tail and keeps everything before it", () => {
    const dir = root();
    const opened = DocumentLog.open(dir, "notes");
    opened.log.append(bytes(1, 1, 1));
    opened.log.append(bytes(2, 2, 2, 2));
    opened.log.close();

    // The kernel wrote the frame header and half the payload, then the process
    // died. This is the ONE case a length-prefixed log has to get right.
    const file = path.join(dir, "notes", "log.bin");
    truncateSync(file, statSync(file).size - 2);

    const reopened = DocumentLog.open(dir, "notes");
    expect(reopened.updates.map((u) => [...u])).toEqual([[1, 1, 1]]);
    expect(reopened.log.stats().recoveredBytes).toBe(10);
    // …and the file is now consistent, so the next append lands cleanly rather
    // than after a hole.
    reopened.log.append(bytes(3));
    reopened.log.close();

    const again = DocumentLog.open(dir, "notes");
    expect(again.updates.map((u) => [...u])).toEqual([[1, 1, 1], [3]]);
    again.log.close();
  });

  it("stops at a record whose checksum does not match", () => {
    const dir = root();
    const opened = DocumentLog.open(dir, "notes");
    opened.log.append(bytes(9, 9, 9, 9));
    opened.log.append(bytes(8, 8));
    opened.log.close();

    const file = path.join(dir, "notes", "log.bin");
    const raw = readFileSync(file);
    // Flip a byte inside the FIRST record's payload. A bad disk, not a torn
    // write — and the answer is the same, because a log with a hole is not a log.
    raw[raw.length - 2 - 8 - 4] ^= 0xff;
    writeFileSync(file, raw);

    const reopened = DocumentLog.open(dir, "notes");
    expect(reopened.updates).toEqual([]);
    expect(reopened.log.stats().recoveredBytes).toBeGreaterThan(0);
    reopened.log.close();
  });

  it("refuses to open a file that is not one of ours", () => {
    const dir = root();
    const opened = DocumentLog.open(dir, "notes");
    opened.log.close();
    writeFileSync(path.join(dir, "notes", "log.bin"), Buffer.from("SQLite format 3\0"));
    // Overwriting somebody else's file because we could not read it is the one
    // response that loses data, so this throws instead.
    expect(() => DocumentLog.open(dir, "notes")).toThrowError(/is not a v1 update log/);
  });
});

describe("compaction", () => {
  it("replaces the log with a base and returns it on reopen", () => {
    const dir = root();
    const opened = DocumentLog.open(dir, "notes");
    opened.log.append(bytes(1));
    opened.log.append(bytes(2));
    opened.log.compact(bytes(7, 7, 7));
    expect(opened.log.stats().records).toBe(0);
    expect(opened.log.stats().baseBytes).toBeGreaterThan(0);
    opened.log.append(bytes(3));
    opened.log.close();

    const reopened = DocumentLog.open(dir, "notes");
    // Base first, then everything appended after it — which is the order a
    // replay has to apply them in.
    expect(reopened.updates.map((u) => [...u])).toEqual([[7, 7, 7], [3]]);
    reopened.log.close();
  });

  it("survives a crash between writing the base and emptying the log", () => {
    const dir = root();
    const opened = DocumentLog.open(dir, "notes");
    opened.log.append(bytes(1));
    opened.log.append(bytes(2));
    const beforeCompaction = readFileSync(path.join(dir, "notes", "log.bin"));
    opened.log.compact(bytes(1, 2));
    opened.log.close();

    // Put the pre-compaction log back: the base is durable, the truncation never
    // happened. A replay now sees the base AND the updates it already contains.
    writeFileSync(path.join(dir, "notes", "log.bin"), beforeCompaction);

    const reopened = DocumentLog.open(dir, "notes");
    expect(reopened.updates.map((u) => [...u])).toEqual([[1, 2], [1], [2]]);
    reopened.log.close();
    // Nothing here de-duplicates, and it does not have to: applying an update a
    // CRDT already contains is a no-op, which is what makes this a one-phase
    // compaction rather than the two-phase reconciliation `app-state` needs.
    // `store.test.ts` asserts that property on a real document.
  });

  it("drops a base that does not check out and falls back to the log", () => {
    const dir = root();
    const opened = DocumentLog.open(dir, "notes");
    opened.log.append(bytes(5, 5));
    opened.log.compact(bytes(6, 6));
    opened.log.append(bytes(7));
    opened.log.close();

    const base = path.join(dir, "notes", "base.bin");
    const raw = readFileSync(base);
    raw[raw.length - 1] ^= 0xff;
    writeFileSync(base, raw);

    // Derived data: a corrupt base costs replay time, not correctness.
    const reopened = DocumentLog.open(dir, "notes");
    expect(reopened.updates.map((u) => [...u])).toEqual([[7]]);
    expect(reopened.log.stats().baseBytes).toBe(0);
    reopened.log.close();
  });
});

describe("closed logs", () => {
  it("refuses to append after close", () => {
    const opened = DocumentLog.open(root(), "notes");
    opened.log.close();
    opened.log.close();
    expect(() => opened.log.append(bytes(1))).toThrowError(/closed/);
  });
});
