/**
 * The trusted replica: what it persists, what it refuses, and what it does not
 * lose.
 *
 * The load-bearing case is "the process died immediately after the ack" — a
 * second store opened on the same directory without the first one closing. That
 * is what the append-then-apply order buys, and it is the one property
 * decision 12 actually asks this layer for.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CrdtDocumentStore } from "./store.js";

const roots: string[] = [];
const stores: CrdtDocumentStore[] = [];

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crdt-store-"));
  roots.push(dir);
  return dir;
}

function store(dir: string, options: Partial<{ maxDocumentBytes: number; compactAfterRecords: number }> = {}) {
  const made = new CrdtDocumentStore({ root: dir, ...options });
  stores.push(made);
  return made;
}

afterEach(() => {
  for (const made of stores.splice(0)) made.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A client-side replica, which is exactly what a View holds. */
function replica(): { doc: Y.Doc; type: Y.Text } {
  const doc = new Y.Doc();
  return { doc, type: doc.getText("body") };
}

/** One update carrying an edit, as a client would produce it. */
function edit(doc: Y.Doc, write: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  write();
  return Y.encodeStateAsUpdate(doc, before);
}

function textOf(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc.getText("body").toString();
}

describe("persistence", () => {
  it("has the update on disk before it answers", () => {
    const dir = root();
    const first = store(dir);
    const client = replica();
    const update = edit(client.doc, () => client.type.insert(0, "hello"));

    expect(first.applyUpdate("notes", update).ok).toBe(true);

    // The process dies here: `first` is never closed, and nothing else runs.
    const raw = readFileSync(path.join(dir, "notes", "log.bin"));
    expect(raw.includes(Buffer.from(update))).toBe(true);

    const restarted = store(dir);
    const read = restarted.read("notes");
    expect(read.ok).toBe(true);
    if (read.ok) expect(textOf(read.value.update)).toBe("hello");
  });

  it("replays a sequence of updates in order", () => {
    const dir = root();
    const first = store(dir);
    const client = replica();
    for (const word of ["a", "b", "c"]) {
      const update = edit(client.doc, () => client.type.insert(client.type.length, word));
      expect(first.applyUpdate("notes", update).ok).toBe(true);
    }
    first.close();

    const read = store(dir).read("notes");
    expect(read.ok).toBe(true);
    if (read.ok) expect(textOf(read.value.update)).toBe("abc");
  });
});

describe("refusals", () => {
  it("refuses bytes that are not an update, and writes nothing", () => {
    const dir = root();
    const made = store(dir);
    expect(made.read("notes").ok).toBe(true);
    const before = made.stats("notes")!.records;

    const bad = made.applyUpdate("notes", new Uint8Array([200, 201, 202, 203]));
    expect(bad).toEqual({ ok: false, code: "bad_update" });
    // The point of validating first: a record that cannot be decoded would make
    // the document permanently unopenable, because the log is replayed on every
    // open.
    expect(made.stats("notes")!.records).toBe(before);

    expect(made.applyUpdate("notes", new Uint8Array())).toEqual({ ok: false, code: "bad_update" });
  });

  it("takes a document far past the old 1 MiB default and replays it", () => {
    const dir = root();
    const made = store(dir);
    const client = replica();
    // Past the old 1 MiB default in one write and then some.
    for (let round = 0; round < 3; round++) {
      const next = edit(client.doc, () => client.type.insert(client.type.length, String(round).repeat(600_000)));
      expect(made.applyUpdate("notes", next).ok).toBe(true);
    }
    made.close();
    const read = store(dir).read("notes");
    expect(read.ok).toBe(true);
    if (read.ok) expect(textOf(read.value.update)).toHaveLength(1_800_000);
  });

  it("refuses a write that would take the document past its ceiling", () => {
    const dir = root();
    const made = store(dir, { maxDocumentBytes: 2048 });
    const client = replica();

    const small = edit(client.doc, () => client.type.insert(0, "x".repeat(200)));
    expect(made.applyUpdate("notes", small).ok).toBe(true);

    const large = edit(client.doc, () => client.type.insert(0, "y".repeat(4000)));
    expect(made.applyUpdate("notes", large)).toEqual({ ok: false, code: "doc_too_large" });

    // Refused, not truncated: the earlier content is intact and the writer still
    // holds its own copy of what it tried to add.
    const read = made.read("notes");
    expect(read.ok).toBe(true);
    if (read.ok) expect(textOf(read.value.update)).toBe("x".repeat(200));
  });

  it("refuses a state vector that does not decode rather than sending everything", () => {
    const made = store(root());
    expect(made.read("notes").ok).toBe(true);
    expect(made.diff("notes", new Uint8Array([255, 255, 255]))).toEqual({ ok: false, code: "bad_update" });
  });

  it("answers nothing once closed", () => {
    const made = store(root());
    made.close();
    expect(made.read("notes")).toEqual({ ok: false, code: "unavailable" });
    expect(made.applyUpdate("notes", new Uint8Array([0]))).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("diffs", () => {
  it("says so when the caller is already up to date", () => {
    const made = store(root());
    const client = replica();
    expect(made.applyUpdate("notes", edit(client.doc, () => client.type.insert(0, "hi"))).ok).toBe(true);

    const read = made.read("notes");
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const same = made.diff("notes", read.value.stateVector);
    expect(same.ok && same.value.empty).toBe(true);

    expect(made.applyUpdate("notes", edit(client.doc, () => client.type.insert(2, "!"))).ok).toBe(true);
    const moved = made.diff("notes", read.value.stateVector);
    expect(moved.ok && moved.value.empty).toBe(false);
  });

  it("reports a deletion-only diff as non-empty", () => {
    // A delete carries no structs, only a delete-set, so a check that looked at
    // structs alone would call a deletion "nothing happened" and leave every
    // other replica showing text that is gone.
    const made = store(root());
    const client = replica();
    expect(made.applyUpdate("notes", edit(client.doc, () => client.type.insert(0, "hello"))).ok).toBe(true);
    const read = made.read("notes");
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(made.applyUpdate("notes", edit(client.doc, () => client.type.delete(0, 2))).ok).toBe(true);
    const diff = made.diff("notes", read.value.stateVector);
    expect(diff.ok && diff.value.empty).toBe(false);
    if (diff.ok) {
      const replayed = new Y.Doc();
      Y.applyUpdate(replayed, read.value.update);
      Y.applyUpdate(replayed, diff.value.update);
      expect(replayed.getText("body").toString()).toBe("llo");
    }
  });
});

describe("reading in place", () => {
  it("answers from the live replica, and a write slipped in is dropped with the replica", () => {
    const dir = root();
    const made = store(dir);
    const client = replica();
    expect(made.applyUpdate("notes", edit(client.doc, () => client.type.insert(0, "kept"))).ok).toBe(true);

    expect(made.inspect("notes", (doc) => doc.getText("body").toString())).toEqual({ ok: true, value: "kept" });
    expect(made.inspect("notes", (doc) => doc.getText("body").insert(0, "unlogged "))).toEqual({
      ok: false,
      code: "unavailable",
    });
    // The next access replays the log, which never saw that write.
    expect(made.inspect("notes", (doc) => doc.getText("body").toString())).toEqual({ ok: true, value: "kept" });
    expect(made.applyUpdate("notes", edit(client.doc, () => client.type.insert(4, "!"))).ok).toBe(true);
    const reopened = store(dir).read("notes");
    expect(reopened.ok && textOf(reopened.value.update)).toBe("kept!");
  });
});

describe("compaction", () => {
  it("compacts once the log has enough records, and keeps the document", () => {
    const dir = root();
    const made = store(dir, { compactAfterRecords: 4 });
    const client = replica();
    for (let n = 0; n < 10; n += 1) {
      expect(made.applyUpdate("notes", edit(client.doc, () => client.type.insert(client.type.length, "x"))).ok).toBe(
        true,
      );
    }
    const stats = made.stats("notes")!;
    expect(stats.records).toBeLessThan(4);
    expect(stats.baseBytes).toBeGreaterThan(0);
    made.close();

    const read = store(dir).read("notes");
    expect(read.ok).toBe(true);
    if (read.ok) expect(textOf(read.value.update)).toBe("x".repeat(10));
  });

  it("is safe across the crash window, because a CRDT merge is idempotent", () => {
    const dir = root();
    const made = store(dir, { compactAfterRecords: 1_000_000 });
    const client = replica();
    for (const word of ["one ", "two ", "three"]) {
      expect(made.applyUpdate("notes", edit(client.doc, () => client.type.insert(client.type.length, word))).ok).toBe(
        true,
      );
    }
    const logBefore = readFileSync(path.join(dir, "notes", "log.bin"));
    made.compact("notes");
    made.close();

    // The base was fsynced and renamed; the truncation never happened. Every
    // update is now present TWICE on the replay path — once inside the base and
    // once in the log — which is precisely the state `app-state` has to
    // reconcile with a fault-point protocol and this layer does not.
    writeFileSync(path.join(dir, "notes", "log.bin"), logBefore);

    const read = store(dir).read("notes");
    expect(read.ok).toBe(true);
    if (read.ok) expect(textOf(read.value.update)).toBe("one two three");
  });
});

describe("what the store is not", () => {
  it("keeps two documents apart", () => {
    const made = store(root());
    const a = replica();
    const b = replica();
    expect(made.applyUpdate("notes", edit(a.doc, () => a.type.insert(0, "alpha"))).ok).toBe(true);
    expect(made.applyUpdate("other", edit(b.doc, () => b.type.insert(0, "beta"))).ok).toBe(true);

    const first = made.read("notes");
    const second = made.read("other");
    expect(first.ok && textOf(first.value.update)).toBe("alpha");
    expect(second.ok && textOf(second.value.update)).toBe("beta");
  });

  it("refuses a document id that is not a plain identifier", () => {
    const made = store(root());
    expect(made.read("../escape")).toEqual({ ok: false, code: "unavailable" });
  });

  it("refuses, never drops, a write past the memory ceiling of the shared replica", () => {
    const made = new CrdtDocumentStore({ root: root(), maxDocumentBytes: 64 * 1024 });
    const client = replica();
    const first = edit(client.doc, () => client.type.insert(0, "a".repeat(40_000)));
    expect(made.applyUpdate("notes", first).ok).toBe(true);
    const second = edit(client.doc, () => client.type.insert(client.type.length, "b".repeat(40_000)));
    expect(made.applyUpdate("notes", second)).toEqual({ ok: false, code: "doc_too_large" });
    expect(made.maxDocumentBytes).toBe(64 * 1024);
    expect(new CrdtDocumentStore({ root: root() }).maxDocumentBytes).toBe(64 * 1024 * 1024);
  });
});
