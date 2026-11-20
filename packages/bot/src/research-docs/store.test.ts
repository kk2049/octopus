import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import type { DocComment, PageInfo } from "@claude-bot/research-docs-contract";
import { CrdtDocumentStore } from "../crdt-doc/store.js";
import { DocsStore } from "./store.js";
import { DocsAttachments } from "./attachments.js";
const roots: string[] = [];
const stores: DocsStore[] = [];
const create = () => {
  const root = mkdtempSync(join(tmpdir(), "research-docs-"));
  roots.push(root);
  const store = new DocsStore(root, vi.fn());
  stores.push(store);
  return { root, store };
};
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Writes the library CRDT directly, as a Head before 2026-10-20 left it on disk. */
function rawLibrary(root: string, space: string, write?: (d: Y.Doc) => void) {
  const raw = new CrdtDocumentStore({ root: root + "/libraries" }),
    read = raw.read(sha(space));
  if (!read.ok) throw new Error(read.code);
  const d = new Y.Doc();
  Y.applyUpdate(d, read.value.update);
  if (write) {
    const vector = Y.encodeStateVector(d);
    write(d);
    expect(raw.applyUpdate(sha(space), Y.encodeStateAsUpdate(d, vector)).ok).toBe(true);
  }
  const bytes = Y.encodeStateAsUpdate(d).byteLength;
  d.destroy();
  raw.close();
  return bytes;
}
/** Follows a list's cursor to its end, as the View does. */
function walk<T extends { id: string }>(page: (after?: string) => { rows: T[]; next: string | null }) {
  const rows: T[] = [];
  let after: string | undefined, calls = 0;
  for (;;) {
    const answer = page(after);
    calls++;
    rows.push(...answer.rows);
    if (answer.next === null) return { rows, calls };
    after = answer.next;
  }
}
const ordered = (rows: { id: string; createdAt: string }[]) =>
  rows.every((r, i) => !i || rows[i - 1].createdAt.localeCompare(r.createdAt) < 0 ||
    (rows[i - 1].createdAt === r.createdAt && rows[i - 1].id < r.id));
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
describe("shared document durability", () => {
  it("initializes once, preserves page isolation, and survives restart", () => {
    const { root, store } = create();
    const params = {
      request: "one",
      title: "研究计划",
      seed: JSON.stringify([{ type: "paragraph", content: "原文" }]),
    };
    const page = store.create("space", "alice", params);
    expect(store.create("space", "alice", params).id).toBe(page.id);
    expect(() =>
      store.create("space", "alice", { ...params, title: "变更" }),
    ).toThrow("请求 ID");
    expect(() => store.read("other", page.id)).toThrow("不属于");
    const doc = new Y.Doc();
    Y.applyUpdate(
      doc,
      Buffer.from(store.read("space", page.id).update, "base64"),
    );
    expect(doc.getXmlFragment("content").toString()).toContain("原文");
    const saved = store.read("space", page.id);
    store.close();
    const reopened = new DocsStore(root, () => {});
    stores.push(reopened);
    expect(reopened.read("space", page.id)).toEqual(saved);
    doc.destroy();
  });
  it("converges two concurrent rich text edits", () => {
    const { store } = create(),
      page = store.create("space", "alice", {
        request: "one",
        title: "并发",
        seed: JSON.stringify([{ type: "paragraph", content: "正文" }]),
      });
    const state = store.read("space", page.id),
      a = new Y.Doc(),
      b = new Y.Doc();
    for (const d of [a, b])
      Y.applyUpdate(d, Buffer.from(state.update, "base64"));
    const text = (d: Y.Doc) =>
      (
        (d.getXmlFragment("content").get(0) as Y.XmlElement).get(
          0,
        ) as Y.XmlElement
      ).get(0) as Y.XmlElement;
    (text(a).get(0) as Y.XmlText).insert(0, "A");
    (text(b).get(0) as Y.XmlText).insert(0, "B");
    for (const d of [a, b])
      store.update(
        "space",
        page.id,
        b64(Y.encodeStateAsUpdate(d, Buffer.from(state.vector, "base64"))),
        b64(Y.encodeStateVector(d)),
      );
    const final = store.read("space", page.id);
    for (const d of [a, b])
      Y.applyUpdate(d, Buffer.from(final.update, "base64"));
    expect(a.getXmlFragment("content").toString()).toBe(
      b.getXmlFragment("content").toString(),
    );
    expect(a.getXmlFragment("content").toString()).toMatch(/AB正文|BA正文/);
    a.destroy();
    b.destroy();
  });
  it("refuses corrupt updates without damaging the prior content", () => {
    const { store } = create(),
      page = store.create("s", "a", { request: "r", title: "页面" }),
      before = store.read("s", page.id);
    expect(() => store.update("s", page.id, "/w==", before.vector)).toThrow();
    expect(store.read("s", page.id)).toEqual(before);
  });
  it("keeps metadata conflicts explicit and prevents hierarchy cycles", () => {
    const { store } = create(),
      a = store.create("s", "a", { request: "a", title: "A" }),
      b = store.create("s", "a", { request: "b", title: "B", parent: a.id });
    expect(() =>
      store.metadata("s", { doc: a.id, expected: "1", parent: b.id }),
    ).toThrow("自身");
    store.metadata("s", { doc: a.id, expected: "1", title: "A2" });
    expect(() =>
      store.metadata("s", { doc: a.id, expected: "1", title: "lost" }),
    ).toThrow("其他人");
    expect(store.page("s", a.id).title).toBe("A2");
  });
  it("binds discussion authors on the server and retries the same comment exactly once", () => {
    const { store } = create(),
      page = store.create("s", "a", { request: "a", title: "A" }),
      params = { doc: page.id, request: "c", text: "证据不足", block: "b1" };
    const c = store.comment("s", "alice", params);
    expect(store.comment("s", "alice", params)).toEqual(c);
    expect(store.comments("s", page.id)).toHaveLength(1);
    expect(c.author).toBe("alice");
    store.resolve("s", { doc: page.id, comment: c.id, resolved: "true" });
    expect(store.comments("s", page.id)[0].resolved).toBe(true);
  });
  it("supports bounded attachment retries and confines bytes to the document", () => {
    const { root } = create(),
      files = new DocsAttachments(join(root, "attachments")),
      p = {
        doc: "d",
        request: "file",
        name: "../../paper.txt",
        media: "text/plain",
        size: "6",
        offset: "0",
        data: b64(Buffer.from("abc")),
      };
    const a = files.upload("s", "alice", p);
    expect(a.next).toBe(3);
    expect(files.upload("s", "alice", p)).toMatchObject({ next: 3 });
    expect(() =>
      files.upload("s", "alice", { ...p, data: b64(Buffer.from("xyz")) }),
    ).toThrow("不一致");
    const complete = files.upload("s", "alice", {
      ...p,
      offset: "3",
      data: b64(Buffer.from("def")),
    });
    expect(complete.complete).toBe(true);
    const read = files.read("s", { doc: "d", file: a.file.id, offset: "0" });
    expect(Buffer.from(read.data, "base64").toString()).toBe("abcdef");
    expect(() =>
      files.read("other", { doc: "d", file: a.file.id, offset: "0" }),
    ).toThrow("不存在");
  });
  it("accepts an attachment past the old 64 MiB ceiling, one bounded block per call", () => {
    const { root } = create(),
      files = new DocsAttachments(join(root, "attachments")),
      size = 64 * 1024 * 1024 + 5,
      block = Buffer.alloc(36_000, 7),
      base = { doc: "d", request: "big", name: "talk.mp4", media: "video/mp4", size: String(size) };
    let next = 0, last: ReturnType<DocsAttachments["upload"]> | undefined;
    while (next < size) {
      last = files.upload("s", "alice", { ...base, offset: String(next), data: b64(block.subarray(0, Math.min(block.length, size - next))) });
      next = last.next;
    }
    expect(last).toMatchObject({ complete: true, next: size, file: { size } });
    const tail = files.read("s", { doc: "d", file: last!.file.id, offset: String(size - 5) });
    expect(tail).toMatchObject({ next: null });
    expect(Buffer.from(tail.data, "base64")).toEqual(Buffer.alloc(5, 7));
  }, 120_000);
});
describe("a library of any size", () => {
  it("creates past the old 500-document count and reaches every document by cursor", () => {
    const { store } = create();
    const ids = Array.from({ length: 620 }, (_, i) =>
      store.create("s", "alice", { request: "r" + i, title: "文档 " + i }).id,
    );
    const { rows, calls } = walk((after) => {
      const { pages, next } = store.libraryPage("s", "200", after);
      return { rows: pages, next };
    });
    expect(calls).toBe(4);
    expect(rows.map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(ordered(rows)).toBe(true);
    expect(store.list("s")).toEqual(rows);
    expect(() => store.libraryPage("s", "200", "doc_unknown")).toThrow("游标");
    expect(() => store.libraryPage("s", "0")).toThrow("分页参数");
  }, 60_000);
  it("posts past the old 1000-discussion count and reaches every comment by cursor, in bounded pages", () => {
    const { store } = create(),
      page = store.create("s", "alice", { request: "p", title: "讨论很多的文档" });
    const long = "长".repeat(8000);
    const posted = Array.from({ length: 1050 }, (_, i) =>
      store.comment("s", i % 2 ? "bob" : "alice", {
        doc: page.id,
        request: "c" + i,
        text: i < 20 ? long : "意见 " + i,
      }),
    );
    const reply = store.comment("s", "bob", { doc: page.id, request: "reply", text: "回复", thread: posted[1049].id });
    expect(reply.thread).toBe(posted[1049].id);
    store.resolve("s", { doc: page.id, comment: posted[700].id, resolved: "true" });
    const { rows, calls } = walk((after) => {
      const { comments, next } = store.commentsPage("s", page.id, "200", after);
      expect(Buffer.byteLength(JSON.stringify(comments))).toBeLessThanOrEqual(192 * 1024 + 1024);
      return { rows: comments, next };
    });
    expect(rows).toHaveLength(1051);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1051);
    expect(ordered(rows)).toBe(true);
    expect(calls).toBeGreaterThan(6);
    expect(rows.find((r) => r.id === posted[700].id)?.resolved).toBe(true);
    // A retried request is the same comment, not a second one.
    expect(store.comment("s", "alice", { doc: page.id, request: "c1048", text: "意见 1048" })).toEqual(posted[1048]);
    expect(store.comments("s", page.id)).toHaveLength(1051);
  }, 60_000);
  it("works past the old 4 MiB library bound, without decoding the library per call", () => {
    const { root, store } = create(),
      first = store.create("s", "alice", { request: "first", title: "主页" });
    store.close();
    const at = Date.parse("2026-01-01T00:00:00.000Z");
    const bytes = rawLibrary(root, "s", (d) => {
      const pages = d.getMap<PageInfo>("pages");
      for (let i = 0; i < 5000; i++) {
        const id = "doc_" + sha("bulk" + i).slice(0, 32),
          stamp = new Date(at + i).toISOString();
        pages.set(id, { id, title: "长标题".repeat(80), parent: first.id, archived: false, revision: 1,
          createdAt: stamp, updatedAt: stamp, createdBy: "alice" });
      }
    });
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
    const reopened = new DocsStore(root, () => {});
    stores.push(reopened);
    const added = reopened.create("s", "bob", { request: "after", title: "超过 4 MiB 之后" });
    expect(reopened.page("s", added.id).title).toBe("超过 4 MiB 之后");
    expect(reopened.title("s")).toBe("主页");
    const { rows } = walk((after) => {
      const { pages, next } = reopened.libraryPage("s", "200", after);
      expect(Buffer.byteLength(JSON.stringify(pages))).toBeLessThanOrEqual(192 * 1024 + 2048);
      return { rows: pages, next };
    });
    expect(rows).toHaveLength(5002);
    expect(new Set(rows.map((p) => p.id)).size).toBe(5002);
    expect(ordered(rows)).toBe(true);
    expect(reopened.comment("s", "bob", { doc: added.id, request: "c", text: "可以讨论" }).author).toBe("bob");
  }, 60_000);
});
describe("discussions moved out of the library", () => {
  const legacyRow = (owner: string, request: string, text: string, at: string, extra: Partial<DocComment> = {}): DocComment => ({
    id: "comment_" + sha(owner + "\0" + request).slice(0, 32),
    author: owner,
    text,
    block: "",
    thread: "",
    createdAt: at,
    resolved: false,
    ...extra,
  });
  it("migrates every legacy discussion once, losslessly, and keeps working on it", () => {
    const { root, store } = create(),
      a = store.create("s", "alice", { request: "a", title: "A" }),
      b = store.create("s", "alice", { request: "b", title: "B" });
    store.close();
    const c1 = legacyRow("alice", "r1", "第一条", "2026-09-01T00:00:00.000Z", { block: "blk" }),
      c2 = legacyRow("bob", "r2", "回复", "2026-09-01T00:00:01.000Z", { thread: c1.id }),
      c3 = legacyRow("bob", "r3", "已解决", "2026-09-01T00:00:02.000Z", { resolved: true }),
      c4 = legacyRow("alice", "r4", "另一份文档", "2026-09-01T00:00:03.000Z");
    rawLibrary(root, "s", (d) => {
      const map = d.getMap<DocComment[]>("comments");
      map.set(a.id, [c1, c2, c3]);
      map.set(b.id, [c4]);
    });
    const migrated = new DocsStore(root, () => {});
    stores.push(migrated);
    expect(migrated.comments("s", a.id)).toEqual([c1, c2, c3]);
    expect(migrated.comments("s", b.id)).toEqual([c4]);
    expect(migrated.list("s").map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    migrated.resolve("s", { doc: a.id, comment: c1.id, resolved: "true" });
    migrated.close();
    // The library no longer holds them. A crash after the copy but before this
    // removal leaves the legacy entry behind: the next access copies by id
    // again, keeps the rows already moved (and their later state), adds none twice.
    let legacy: unknown[] = [];
    rawLibrary(root, "s", (d) => {
      legacy = [...d.getMap("comments").keys()];
      d.getMap<DocComment[]>("comments").set(a.id, [c1, c2, c3]);
    });
    expect(legacy).toEqual([]);
    const again = new DocsStore(root, () => {});
    stores.push(again);
    expect(again.comments("s", a.id)).toEqual([{ ...c1, resolved: true }, c2, c3]);
    expect(again.comments("s", b.id)).toEqual([c4]);
    // Retrying a pre-migration request returns the migrated comment; replies and new posts work.
    expect(again.comment("s", "alice", { doc: a.id, request: "r1", text: "第一条", block: "blk" })).toEqual({ ...c1, resolved: true });
    expect(again.comment("s", "carol", { doc: a.id, request: "r5", text: "新回复", thread: c1.id }).thread).toBe(c1.id);
    expect(() => again.comment("s", "carol", { doc: a.id, request: "r6", text: "回复的回复", thread: c2.id })).toThrow("原讨论");
    expect(again.comments("s", a.id)).toHaveLength(4);
    again.close();
    let after: unknown[] = [];
    rawLibrary(root, "s", (d) => {
      after = [...d.getMap("comments").keys()];
    });
    expect(after).toEqual([]);
  });
});
