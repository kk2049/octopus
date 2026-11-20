import { createHash } from "node:crypto";
import * as Y from "yjs";
import { CrdtDocumentStore } from "../crdt-doc/store.js";
import {
  LIST_PAGE_BYTES,
  LIST_PAGE_ENTRIES,
  type PageInfo,
  type DocComment,
} from "@claude-bot/research-docs-contract";
import { seedDocument } from "./seed.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Listed = { id: string; createdAt: string };
const byCreation = (a: Listed, b: Listed) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const withoutSeed = ({ seed: _, ...p }: PageInfo): PageInfo => p;
/**
 * One bounded page of `rows` (in creation order) after the entry whose id is
 * `after`. The lists only grow — pages and comments are never deleted, and a
 * new one sorts last — so an id cursor stays valid and skips nothing.
 */
function pageOf<T extends Listed>(
  rows: T[],
  limit = String(LIST_PAGE_ENTRIES),
  after?: string,
) {
  if (!/^[1-9][0-9]{0,3}$/.test(limit)) throw new Error("分页参数无效");
  const max = Math.min(Number(limit), LIST_PAGE_ENTRIES);
  let start = 0;
  if (after !== undefined) {
    start = rows.findIndex((r) => r.id === after) + 1;
    if (!start) throw new Error("分页游标无效，请重新读取");
  }
  const out: T[] = [];
  for (let i = start, bytes = 0; i < rows.length && out.length < max; i++) {
    bytes += Buffer.byteLength(JSON.stringify(rows[i]));
    if (out.length && bytes > LIST_PAGE_BYTES) break;
    out.push(rows[i]);
  }
  return {
    rows: out,
    next: start + out.length < rows.length ? out[out.length - 1].id : null,
  };
}
export class DocsStore {
  readonly contents: CrdtDocumentStore;
  /** Per space: the page directory and create requests. Server-owned metadata. */
  private readonly libraries: CrdtDocumentStore;
  /** Per page: its discussions by comment id (until 2026-10-20 they lived in the library). */
  private readonly discussions: CrdtDocumentStore;
  constructor(
    root: string,
    private readonly changed: (space: string, doc?: string) => void,
  ) {
    // Nothing here is answered whole: pages move in windows (ResearchDocsPlane),
    // the directory and each page's discussions in cursor pages, and calls read
    // the live replicas in place. So no store sets a ceiling of its own; each
    // keeps only the shared replica's memory ceiling (CrdtDocumentStore).
    this.contents = new CrdtDocumentStore({ root: root + "/pages" });
    this.libraries = new CrdtDocumentStore({ root: root + "/libraries" });
    this.discussions = new CrdtDocumentStore({ root: root + "/comments" });
  }
  key(space: string, page: string) {
    return hash(space + "\0" + page);
  }
  /** Reads the directory in place — no decode per call — once legacy discussions have moved out. */
  private library<T>(space: string, read: (d: Y.Doc) => T): T {
    this.migrate(space);
    const r = this.libraries.inspect(hash(space), read);
    if (!r.ok) throw new Error("文档目录暂不可用");
    return r.value;
  }
  /** Changes a copy and merges the difference through the store's validate → append → apply order. */
  private write<T>(
    store: CrdtDocumentStore,
    key: string,
    failure: string,
    fn: (d: Y.Doc) => T,
  ): T {
    const r = store.read(key);
    if (!r.ok) throw new Error(failure + "：" + r.code);
    const d = new Y.Doc();
    try {
      Y.applyUpdate(d, r.value.update);
      const vector = Y.encodeStateVector(d),
        result = fn(d);
      const saved = store.applyUpdate(key, Y.encodeStateAsUpdate(d, vector));
      if (!saved.ok) throw new Error(failure + "：" + saved.code);
      return result;
    } finally {
      d.destroy();
    }
  }
  private transaction<T>(space: string, fn: (d: Y.Doc) => T): T {
    this.migrate(space);
    const result = this.write(this.libraries, hash(space), "文档目录保存失败", fn);
    this.changed(space);
    return result;
  }
  /**
   * Before 2026-10-20 every discussion of every page lived in the library CRDT,
   * which each call decoded whole. They move to their page's own store at the
   * space's first access. Idempotent and lossless: rows are copied by id (a row
   * already there is kept), and the library entry is removed only after its
   * rows are durable, so a crash in between copies the same rows again. Nothing
   * visible changes, so nobody is woken.
   */
  private migrate(space: string) {
    const legacy = this.libraries.inspect(hash(space), (d) => [
      ...d.getMap<DocComment[]>("comments").entries(),
    ]);
    if (!legacy.ok) throw new Error("文档目录暂不可用");
    if (!legacy.value.length) return;
    for (const [doc, rows] of legacy.value)
      this.write(this.discussions, this.key(space, doc), "讨论迁移失败", (d) => {
        const map = d.getMap<DocComment>("comments");
        for (const row of rows) if (!map.has(row.id)) map.set(row.id, row);
      });
    this.write(this.libraries, hash(space), "讨论迁移失败", (d) => {
      const map = d.getMap("comments");
      for (const [doc] of legacy.value) map.delete(doc);
    });
  }
  /** The whole directory in creation order: an older View's answer. */
  list(space: string): PageInfo[] {
    return this.library(space, (d) =>
      [...d.getMap<PageInfo>("pages").values()].map(withoutSeed),
    ).sort(byCreation);
  }
  /** One page of the directory in creation order; `next` continues it. */
  libraryPage(space: string, limit?: string, after?: string) {
    const { rows, next } = pageOf(this.list(space), limit, after);
    return { pages: rows, next };
  }
  /** The space's title: its first root page still in use. */
  title(space: string): string | undefined {
    return this.library(space, (d) => {
      let first: PageInfo | undefined;
      for (const p of d.getMap<PageInfo>("pages").values())
        if (!p.archived && !p.parent && (!first || byCreation(p, first) < 0))
          first = p;
      return first?.title;
    });
  }
  page(space: string, id: string) {
    const p = this.library(space, (d) => d.getMap<PageInfo>("pages").get(id));
    if (!p) throw new Error("文档不存在或不属于此空间");
    return withoutSeed(p);
  }
  create(space: string, owner: string, p: Record<string, string>): PageInfo {
    const id = "doc_" + hash(owner + "\0" + p.request).slice(0, 32),
      fingerprint = hash(JSON.stringify(p));
    return this.transaction(space, (d) => {
      const requests = d.getMap<{ fingerprint: string; id: string }>(
          "requests",
        ),
        prior = requests.get(id);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error("请求 ID 已用于其他内容");
        return d.getMap<PageInfo>("pages").get(prior.id)!;
      }
      const pages = d.getMap<PageInfo>("pages");
      const title = p.title.trim();
      if (!title) throw new Error("请输入文档标题");
      const parent = p.parent ?? "";
      if (parent && !pages.has(parent)) throw new Error("父文档不存在");
      const seed = p.seed ? JSON.parse(p.seed) : [];
      if (!Array.isArray(seed)) throw new Error("初始块必须是数组");
      const update = seedDocument(id, seed);
      if (update.byteLength > 180000)
        throw new Error("初始文档过大，请拆分页面");
      // Initialize once on the trusted side. Two first-open clients cannot insert duplicate templates.
      const existing = this.contents.read(this.key(space, id));
      if (!existing.ok) throw new Error("文档内容不可用");
      if (existing.value.update.length <= 2) {
        const r = this.contents.applyUpdate(this.key(space, id), update);
        if (!r.ok) throw new Error("初始化文档失败");
      }
      const at = new Date().toISOString(),
        page: PageInfo = {
          id,
          title,
          parent,
          archived: false,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          createdBy: owner,
        };
      pages.set(id, page);
      requests.set(id, { fingerprint, id });
      return page;
    });
  }
  metadata(space: string, p: Record<string, string>) {
    return this.transaction(space, (d) => {
      const pages = d.getMap<PageInfo>("pages"),
        page = pages.get(p.doc);
      if (!page) throw new Error("文档不存在");
      if (String(page.revision) !== p.expected) {
        const same =
          (p.title === undefined || p.title.trim() === page.title) &&
          (p.parent === undefined ||
            (p.parent === "root" ? "" : p.parent) === page.parent) &&
          (p.archived === undefined || p.archived === String(page.archived));
        if (same) return page;
        throw new Error("标题或位置已被其他人修改，请核对最新内容后选择");
      }
      const next = {
        ...page,
        revision: page.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (p.title !== undefined) {
        if (!p.title.trim()) throw new Error("标题不能为空");
        next.title = p.title.trim();
      }
      if (p.archived !== undefined) {
        if (!["true", "false"].includes(p.archived))
          throw new Error("归档参数无效");
        next.archived = p.archived === "true";
      }
      if (p.parent !== undefined) {
        next.parent = p.parent === "root" ? "" : p.parent;
        let parent = next.parent;
        const seen = new Set([next.id]);
        while (parent) {
          if (seen.has(parent)) throw new Error("文档不能包含自身");
          seen.add(parent);
          const item = pages.get(parent);
          if (!item) throw new Error("父文档不存在");
          parent = item.parent;
        }
      }
      pages.set(next.id, next);
      return next;
    });
  }
  /** The page's state (or the diff since `vector`) as raw bytes; the caller windows it. */
  state(space: string, id: string, vector?: string) {
    const page = this.page(space, id),
      state = vector
        ? this.contents.diff(this.key(space, id), decode(vector, 8192))
        : this.contents.read(this.key(space, id));
    if (!state.ok) throw new Error("文档读取失败：" + state.code);
    return {
      page,
      update: Buffer.from(state.value.update),
      vector: Buffer.from(state.value.stateVector).toString("base64"),
    };
  }
  read(space: string, id: string, vector?: string) {
    const state = this.state(space, id, vector);
    return { ...state, update: state.update.toString("base64") };
  }
  /** Validate, append and fsync, apply: the CRDT store's order, for one whole update. */
  merge(space: string, id: string, bytes: Uint8Array) {
    if (this.page(space, id).archived) throw new Error("请先恢复归档文档");
    const r = this.contents.applyUpdate(this.key(space, id), bytes);
    if (!r.ok) throw new Error("文档合并失败：" + r.code);
    this.changed(space, id);
  }
  update(space: string, id: string, update: string, vector: string) {
    if (this.page(space, id).archived) throw new Error("请先恢复归档文档");
    const bytes = decode(update, 262144);
    decode(vector, 8192);
    this.merge(space, id, bytes);
    return this.read(space, id, vector);
  }
  /** A document's whole discussion in posting order: an older View's answer. */
  comments(space: string, id: string): DocComment[] {
    this.page(space, id);
    const r = this.discussions.inspect(this.key(space, id), (d) =>
      [...d.getMap<DocComment>("comments").values()].map((row) => ({ ...row })),
    );
    if (!r.ok) throw new Error("讨论暂不可用");
    return r.value.sort(byCreation);
  }
  /** One page of a document's discussion in posting order; `next` continues it. */
  commentsPage(space: string, id: string, limit?: string, after?: string) {
    const { rows, next } = pageOf(this.comments(space, id), limit, after);
    return { comments: rows, next };
  }
  comment(space: string, owner: string, p: Record<string, string>) {
    this.page(space, p.doc);
    const id = "comment_" + hash(owner + "\0" + p.request).slice(0, 32);
    const row = this.write(
      this.discussions,
      this.key(space, p.doc),
      "讨论保存失败",
      (d) => {
        const map = d.getMap<DocComment>("comments"),
          existing = map.get(id);
        if (existing) {
          if (
            existing.text !== p.text ||
            existing.block !== (p.block ?? "") ||
            existing.thread !== (p.thread ?? "")
          )
            throw new Error("讨论请求已用于不同内容");
          return existing;
        }
        if (!p.text.trim()) throw new Error("讨论内容不能为空");
        if (p.thread && map.get(p.thread)?.thread !== "")
          throw new Error("原讨论不存在");
        const row: DocComment = {
          id,
          author: owner,
          text: p.text,
          block: p.block ?? "",
          thread: p.thread ?? "",
          createdAt: new Date().toISOString(),
          resolved: false,
        };
        map.set(id, row);
        return row;
      },
    );
    // Views refresh their discussion on the library epoch, as before.
    this.changed(space);
    return row;
  }
  resolve(space: string, p: Record<string, string>) {
    this.page(space, p.doc);
    if (!["true", "false"].includes(p.resolved))
      throw new Error("讨论状态无效");
    this.write(this.discussions, this.key(space, p.doc), "讨论保存失败", (d) => {
      const map = d.getMap<DocComment>("comments"),
        row = map.get(p.comment);
      if (!row) throw new Error("讨论不存在");
      map.set(row.id, { ...row, resolved: p.resolved === "true" });
    });
    this.changed(space);
    return { ok: true };
  }
  close() {
    this.contents.close();
    this.libraries.close();
    this.discussions.close();
  }
}
export function decode(value: string, max: number) {
  if (
    value.length > max ||
    value.length % 4 ||
    !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("无效或过大的二进制数据");
  return Buffer.from(value, "base64");
}
