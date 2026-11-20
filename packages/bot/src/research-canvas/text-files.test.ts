import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchCollaboration } from "./collaboration.js";
import { TEXT_STAGED_IDLE_MS, TEXT_STAGED_MAX, TEXT_WINDOW_BYTES } from "./text-files.js";
import { digest } from "./validation.js";

describe("note bodies of any size", () => {
  let root: string, store: Store, graph: ResearchGraph, collaboration: ResearchCollaboration, note: ResearchNode;
  const context: ResearchContext = { project: "project", actor: { kind: "human", owner: "alice" } };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "research-text-"));
    store = new Store(join(root, "state.db"));
    graph = new ResearchGraph(store, root);
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "project", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    collaboration = new ResearchCollaboration(graph, root, () => {});
    note = (graph.mutate(context, "node_add", { request: "note", data: JSON.stringify({ type: "note", title: "长笔记" }) }) as { node: ResearchNode }).node;
  });
  afterEach(() => { graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  // Mixed one-, two-, three- and four-byte characters so windows must find character boundaries.
  const body = Array.from({ length: 300_000 }, (_, i) => `a${i % 10}é中😀\n`).join("");
  const path = () => (collaboration.document(context, { node: note.id, field: "text", offset: "0" }).data as { path: string }).path;

  it("reads a 3 MiB body in bounded windows pinned to one revision", () => {
    writeFileSync(path(), body);
    let offset: number | null = 0, text = "", windows = 0;
    const revisions = new Set<string>();
    while (offset !== null) {
      const answer = collaboration.document(context, { node: note.id, field: "text", offset: String(offset) });
      const data = answer.data as { text: string; next: number | null; offset: number; bytes: number };
      expect(Buffer.byteLength(data.text)).toBeLessThanOrEqual(TEXT_WINDOW_BYTES);
      expect(data.bytes).toBe(Buffer.byteLength(body));
      revisions.add(answer.revision); text += data.text; offset = data.next; windows++;
    }
    expect(Buffer.byteLength(body)).toBeGreaterThan(3 * 1024 * 1024);
    expect(text).toBe(body);
    expect(windows).toBeGreaterThanOrEqual(12);
    expect([...revisions]).toEqual([digest(body)]);
    expect(() => collaboration.document(context, { node: note.id, field: "text", offset: "3" })).toThrow("字符边界");
    // An older View without an offset is refused with a pointer instead of a partial body.
    expect(() => collaboration.document(context, { node: note.id, field: "text" })).toThrow("offset");
    // A canvas node read carries the first window and says where the rest continues.
    expect(collaboration.textPreview(context, note.id)).toMatchObject({ textNext: expect.any(Number), textBytes: Buffer.byteLength(body) });
  });

  it("keeps and restores a large previous version without loading it, and checks the expected revision", () => {
    writeFileSync(path(), body);
    const expected = collaboration.document(context, { node: note.id, field: "text", offset: "0" }).revision;
    expect(() => collaboration.write(context, { request: "stale", node: note.id, text: "短", expected: "0".repeat(64) })).toThrow("已变化");
    collaboration.write(context, { request: "edit", node: note.id, text: "短", expected });
    const version = graph.texts.versions("project", note.id).versions[0]!;
    expect(version).toMatchObject({ digest: expected, bytes: Buffer.byteLength(body) });
    expect(collaboration.write(context, { request: "restore", node: note.id, restore: version.id })).toMatchObject({ revision: expected });
    expect(collaboration.document(context, { node: note.id, field: "text", offset: "0" }).revision).toBe(expected);
  });

  it("saves a body far larger than one call through begin / append / commit, one window per call", () => {
    writeFileSync(path(), "旧正文");
    const base = collaboration.document(context, { node: note.id, field: "text", offset: "0" }).revision;
    const begun = collaboration.write(context, { request: "big", node: note.id, stage: "begin", expected: base }) as { upload: string; size: number; revision: string };
    expect(begun).toMatchObject({ status: "staged", size: 0, revision: base });
    const windows = body.match(/[\s\S]{1,60000}/gu)!;
    let offset = 0;
    for (const window of windows) {
      const appended = collaboration.write(context, { request: "big", node: note.id, stage: "append", upload: begun.upload, offset: String(offset), text: window }) as { size: number };
      offset += Buffer.byteLength(window);
      expect(appended.size).toBe(offset);
    }
    // A replayed window changes nothing; a gap is refused; nothing is replaced before commit.
    expect((collaboration.write(context, { request: "big", node: note.id, stage: "append", upload: begun.upload, offset: "0", text: windows[0]! }) as { size: number }).size)
      .toBe(Buffer.byteLength(windows[0]!));
    expect(() => collaboration.write(context, { request: "big", node: note.id, stage: "append", upload: begun.upload, offset: String(offset + 1), text: "x" })).toThrow("不连续");
    expect(readFileSync(path(), "utf8")).toBe("旧正文");
    // Another actor's token stages nothing of this upload.
    const bob: ResearchContext = { project: "project", actor: { kind: "agent", owner: "alice", agent: "other" } };
    expect(() => collaboration.write(bob, { request: "big", node: note.id, stage: "commit", upload: begun.upload, size: String(offset) })).toThrow("过期");
    expect(() => collaboration.write(context, { request: "big", node: note.id, stage: "commit", upload: begun.upload, size: String(offset - 1), expected: base })).toThrow("长度");
    const committed = collaboration.write(context, { request: "big", node: note.id, stage: "commit", upload: begun.upload, size: String(offset), expected: base });
    expect(committed).toEqual({ revision: digest(body), path: path(), bytes: Buffer.byteLength(body) });
    expect(readFileSync(path(), "utf8")).toBe(body);
    expect(collaboration.document(context, { node: note.id, field: "text", offset: "0" }).revision).toBe(digest(body));
    // The old version was kept; a retried save with a fresh upload joins the first receipt.
    expect(graph.texts.versions("project", note.id).versions[0]).toMatchObject({ digest: base });
    expect(collaboration.write(context, { request: "big", node: note.id, stage: "commit", upload: "f".repeat(32), size: String(offset), expected: base })).toEqual(committed);
  });

  it("never reads a whole save without text as an empty body", () => {
    writeFileSync(path(), "保留");
    expect(() => collaboration.write(context, { request: "empty", node: note.id })).toThrow("text");
    expect(() => collaboration.write(context, { request: "bogus", node: note.id, stage: "replace", text: "" })).toThrow("步骤");
    expect(readFileSync(path(), "utf8")).toBe("保留");
  });

  it("refuses a stale staged save at commit and bounds abandoned uploads per project", () => {
    writeFileSync(path(), "v1");
    const base = collaboration.document(context, { node: note.id, field: "text", offset: "0" }).revision;
    const begun = collaboration.write(context, { request: "stale", node: note.id, stage: "begin" }) as { upload: string; revision: string };
    collaboration.write(context, { request: "stale", node: note.id, stage: "append", upload: begun.upload, offset: "0", text: "mine" });
    writeFileSync(path(), "theirs");
    expect(() => collaboration.write(context, { request: "stale", node: note.id, stage: "commit", upload: begun.upload, size: "4", expected: begun.revision })).toThrow("已变化");
    expect(readFileSync(path(), "utf8")).toBe("theirs");
    expect(begun.revision).toBe(base);
    // Abandoned uploads are bounded per project and swept once idle.
    for (let i = 1; i < TEXT_STAGED_MAX; i++) collaboration.write(context, { request: `abandon-${i}`, node: note.id, stage: "begin" });
    expect(() => collaboration.write(context, { request: "one-too-many", node: note.id, stage: "begin" })).toThrow("过多");
    const staging = join(dirname(dirname(path())), "staging");
    const old = (Date.now() - TEXT_STAGED_IDLE_MS - 1000) / 1000;
    for (const name of readdirSync(staging)) utimesSync(join(staging, name), old, old);
    collaboration.write(context, { request: "after-sweep", node: note.id, stage: "begin" });
    expect(readdirSync(staging)).toHaveLength(1);
  });
});
