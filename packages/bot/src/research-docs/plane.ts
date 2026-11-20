import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import type {
  CapabilityService,
  OperationSpec,
} from "@claude-bot/capability-kernel";
import {
  DOCS_APP,
  DOCS_PUBLISHER,
  DOCS_CONTRACT,
  DOCS_OPERATIONS,
  type DocsAction,
  type DocsRole,
} from "@claude-bot/research-docs-contract";
import {
  CANVAS_CONTRACT,
  type CanvasAction,
} from "@claude-bot/research-canvas-contract";
import { actionOf, decodeWireParams } from "@claude-bot/typed-port-kit";
import type { Store } from "../store/store.js";
import type { SessionPlusInstanceBinding } from "../app-core/instance.js";
import type { DeclaredResourcePlane } from "../app-registry/resource-plane.js";
import type { PermissionService } from "../permissions/service.js";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { IntentGrantResolver } from "../session-resource/intent-resolver.js";
import type { ResearchCanvasPlane } from "../research-canvas/plane.js";
import { DOCS_PERMISSION, DOCS_CATALOG, isDocsContract } from "./contract.js";
import { DocsStore, decode } from "./store.js";
import { DocsAttachments } from "./attachments.js";
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as RuntimeJson;
const SOURCE_ACTIONS = new Set([
  "canvas_read",
  "ref_describe",
  "document_read",
  "document_write",
  "session_history",
  "session_read",
  "session_status",
  "session_send",
  "agent_send",
  "agent_stop",
  "session_attach",
  "session_respond",
  "session_file_read",
  "file_read",
  "file_write",
  "file_versions",
  "file_download",
  "audio_read",
  "audio_transcribe",
  "audio_upload",
  "file_upload",
  "file_begin",
  "file_chunk",
  "file_commit",
  "file_upload_begin",
  "file_upload_chunk",
  "file_upload_commit",
  "resource_read",
  "source_read",
  "source_segments",
  "meeting_options",
  "source_summarize",
  "source_retry",
  "workflow_read",
  "candidates_save",
  "candidates_publish",
  "workflow_execution_stop",
  "evidence_read",
  "adapter_read",
]);
/** One window of page bytes in either direction: what one `update` parameter can carry. */
export const DOCS_WINDOW_BYTES = 196_608;
/** The single answer an older View's `read`/`update` (no offset) can receive: the old page ceiling. */
export const DOCS_LEGACY_INLINE_BYTES = 2 * 1024 * 1024;
/**
 * The whole list an older View's `library` / `comments` (no limit) can receive:
 * the old library bound, which held every page entry and comment. Past it the
 * View is told to refresh; the new one reads cursor pages.
 */
export const DOCS_LEGACY_LIST_BYTES = 4 * 1024 * 1024;
const whole = <T>(rows: T[]): T[] => {
  if (Buffer.byteLength(JSON.stringify(rows)) > DOCS_LEGACY_LIST_BYTES)
    throw new Error("目录或讨论已超过旧版页面一次读取的大小；请刷新页面，新版本分页读取");
  return rows;
};
/** A held read snapshot or staged push not continued for this long is dropped. */
const STAGING_MS = 10 * 60_000;
/** Per-instance number of documents with a read snapshot or staged push at once. */
const STAGED_PER_INSTANCE = 8;
type Snapshot = { id: string; page: unknown; vector: string; bytes: Buffer; at: number };
type Staged = { total: number; parts: Buffer[]; size: number; at: number };
type Watch = {
  space: string;
  doc: string;
  sources: Set<string>;
  current: () => SessionPlusInstanceBinding | null;
  publish: () => void;
};
export class ResearchDocsPlane implements DeclaredResourcePlane {
  readonly documents: DocsStore;
  readonly attachments: DocsAttachments;
  private readonly authority: AccountAuthority<{ owner: string }>;
  private readonly grants: IntentGrantResolver;
  private readonly watches = new Map<string, Watch>();
  private readonly sourceEpochs = new Map<string, number>();
  private readonly unsubscribeSources: () => void;
  private readonly epochs = new Map<string, number>();
  private readonly revisions = new Map<string, Record<string, number>>();
  private readonly libraries = new Map<string, number>();
  /**
   * Windowed reads and pushes, keyed by instance and document. A read answers
   * from one snapshot so its windows never mix versions; a push is staged until
   * its last part and then merged once. Both are dropped with the instance.
   */
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly staged = new Map<string, Staged>();
  constructor(
    private readonly store: Store,
    kernel: CapabilityService,
    permissions: PermissionService,
    root: string,
    private readonly research?: ResearchCanvasPlane,
  ) {
    this.unsubscribeSources =
      research?.observeChanges((project) => {
        const spaces = new Set(
          [...this.watches.values()]
            .filter((w) => w.sources.has(project))
            .map((w) => w.space),
        );
        for (const space of spaces)
          this.sourceEpochs.set(space, (this.sourceEpochs.get(space) ?? 0) + 1);
        for (const [id, w] of this.watches)
          if (spaces.has(w.space)) {
            const b = w.current();
            try {
              if (!b) throw new Error();
              this.allowed(b, "read_sources");
              w.publish();
            } catch {
              this.watches.delete(id);
            }
          }
      }) ?? (() => {});
    this.kernel = kernel;
    this.documents = new DocsStore(join(root, "documents"), (s, d) =>
      this.changed(s, d),
    );
    this.attachments = new DocsAttachments(join(root, "attachments"));
    this.grants = new IntentGrantResolver(
      permissions,
      Date.now,
      new Map([[DOCS_APP, DOCS_PUBLISHER]]),
    );
    const operations: Record<string, OperationSpec> = Object.fromEntries(
      DOCS_CATALOG.operations.map((o) => [
        o.id,
        {
          title: o.title,
          effect: o.effect,
          args: { space: { type: "string", required: true, maxLength: 160 } },
          retrySafe: o.id !== "interact_sources",
        },
      ]),
    );
    this.authority = new AccountAuthority({
      service: kernel,
      slot: "research-docs",
      objectPrefix: "research-docs-v1",
      kind: "shared-documents",
      operations,
      bindingFor: (owner) => ({ owner }),
      rootAutoAllow: () => DOCS_OPERATIONS,
      policy: (i) =>
        i.terms.autoAllow.includes(i.operation)
          ? { kind: "allow" }
          : { kind: "deny", reason: "请在权限中心授权研究文档操作" },
      adapter: async (binding, operation, args) => {
        this.role(String(args.space), binding.owner, operation);
        return { authorized: true };
      },
    });
  }
  private readonly kernel: CapabilityService;
  private role(
    space: string,
    owner: string,
    operation = "read_documents",
  ): DocsRole {
    const app = this.store.getSharedAppInstance(DOCS_APP, space),
      seat = this.store.getSharedAppMember(DOCS_APP, space, owner);
    if (
      !app ||
      app.status !== "open" ||
      !seat ||
      !["owner", "editor", "viewer"].includes(seat.role)
    )
      throw new Error("文档空间不存在或成员权限已撤销");
    if (operation === "edit_documents" && seat.role === "viewer")
      throw new Error("此文档为只读，请联系空间管理者");
    return seat.role as DocsRole;
  }
  private binding(b: SessionPlusInstanceBinding) {
    if (
      !b.sharedInstanceKey ||
      !isDocsContract(b.stableAppId, DOCS_PUBLISHER, b.contractDigest)
    )
      throw new Error("文档契约或共享实例不匹配");
    this.role(b.sharedInstanceKey, b.owner);
    return b.sharedInstanceKey;
  }
  private allowed(b: SessionPlusInstanceBinding, op: string) {
    const space = this.binding(b);
    this.role(space, b.owner, op);
    const grant = this.grants.effective(DOCS_PERMISSION, b.owner);
    if (!grant.operations.includes(op) || !grant.autoAllow.includes(op))
      throw new Error("请在权限中心授权研究文档对应操作");
    if (b.actor.kind === "agent")
      throw new Error("此文档版本未启用后台 Agent 编辑授权");
    return space;
  }
  private async check(b: SessionPlusInstanceBinding, op: string) {
    const space = this.allowed(b, op),
      derived = this.authority.derive({
        username: b.owner,
        purpose: "研究文档 · " + space,
        kind: "app-instance",
        rights: [op],
        autoAllow: [op],
      });
    if (!derived) throw new Error("文档能力不可用");
    const grant = new SlotGrant(
      this.kernel,
      derived.contextId,
      "research-docs",
      "研究文档",
      b.owner,
      derived.borrowed,
    );
    try {
      await grant.call(op, { space });
      this.allowed(b, op);
    } finally {
      grant.close();
    }
    return space;
  }
  sharedInstanceTitle(space: string) {
    return this.documents.title(space) ?? "新文档空间";
  }
  project(b: SessionPlusInstanceBinding, durable: RuntimeJson): RuntimeJson {
    try {
      const space = this.binding(b);
      return json({
        ...(durable as object),
        docs: {
          space,
          viewer: b.owner,
          role: this.role(space, b.owner),
          title: this.sharedInstanceTitle(space),
          sourceEpoch: this.sourceEpochs.get(space) ?? 0,
          epoch: this.epochs.get(space) ?? 0,
          libraryEpoch: this.libraries.get(space) ?? 0,
          revisions: this.revisions.get(space) ?? {},
          peers: [...this.watches.values()]
            .filter((w) => w.space === space && w.current())
            .map((w) => ({ user: w.current()!.owner, doc: w.doc })),
        },
      });
    } catch {
      return json({ ...(durable as object), docs: null });
    }
  }
  changed(space: string, doc?: string) {
    this.epochs.set(space, (this.epochs.get(space) ?? 0) + 1);
    if (doc) {
      const old = this.revisions.get(space) ?? {};
      this.revisions.set(space, { ...old, [doc]: (old[doc] ?? 0) + 1 });
    } else this.libraries.set(space, (this.libraries.get(space) ?? 0) + 1);
    for (const [k, w] of this.watches)
      if (w.space === space) {
        if (w.current()) w.publish();
        else this.watches.delete(k);
      }
  }
  close(instance: string) {
    const w = this.watches.get(instance);
    this.watches.delete(instance);
    this.dropStaging(instance);
    if (w) this.changed(w.space, "");
  }
  shutdown() {
    this.unsubscribeSources();
    this.watches.clear();
    this.documents.close();
  }
  revoke(owner: string) {
    this.authority.revokeAccount(owner);
    for (const [k, w] of this.watches) {
      const b = w.current();
      if (!b || b.owner === owner) {
        this.watches.delete(k);
        this.dropStaging(k);
      }
    }
  }
  private dropStaging(instance: string) {
    for (const map of [this.snapshots, this.staged])
      for (const key of map.keys())
        if (key.startsWith(instance + "\0")) map.delete(key);
  }
  /** Bounded staging: expire idle entries and keep at most a few documents per instance. */
  private admit<T extends { at: number }>(map: Map<string, T>, instance: string, key: string, value: T) {
    const now = Date.now();
    for (const [k, v] of map) if (now - v.at > STAGING_MS) map.delete(k);
    map.delete(key);
    const mine = [...map.keys()].filter((k) => k.startsWith(instance + "\0"));
    for (const k of mine.slice(0, Math.max(0, mine.length - STAGED_PER_INSTANCE + 1))) map.delete(k);
    map.set(key, value);
  }
  /**
   * Answers page state in windows. A state that fits one window is answered
   * inline (as before, plus `offset`/`total`/`next`); a larger one is held as a
   * snapshot and continued with `snapshot` + `offset` until `next` is null.
   */
  private window(instance: string, doc: string, state: { page: unknown; vector: string; update: Buffer }, offset = 0, id?: string) {
    const key = instance + "\0" + doc;
    let snapshot: Snapshot | undefined;
    if (id) {
      snapshot = this.snapshots.get(key);
      if (!snapshot || snapshot.id !== id)
        throw new Error("分段读取已失效，请重新打开文档");
      snapshot.at = Date.now();
    } else if (state.update.length > DOCS_WINDOW_BYTES) {
      snapshot = { id: randomUUID(), page: state.page, vector: state.vector, bytes: state.update, at: Date.now() };
      this.admit(this.snapshots, instance, key, snapshot);
    }
    const bytes = snapshot?.bytes ?? state.update;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
      throw new Error("分段读取偏移无效");
    const end = Math.min(bytes.length, offset + DOCS_WINDOW_BYTES),
      next = end < bytes.length ? end : null;
    if (snapshot && next === null) this.snapshots.delete(key);
    return {
      page: snapshot?.page ?? state.page,
      vector: snapshot?.vector ?? state.vector,
      update: bytes.subarray(offset, end).toString("base64"),
      offset,
      total: bytes.length,
      next,
      ...(snapshot ? { snapshot: snapshot.id } : {}),
    };
  }
  /** Stages one part of a push; merges once the last part arrives, as one update. */
  private push(instance: string, space: string, p: Record<string, string>) {
    const key = instance + "\0" + p.doc,
      offset = Number(p.offset),
      total = Number(p.total),
      part = decode(p.update, 262144);
    decode(p.vector, 8192);
    if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(offset) || offset < 0 || offset + part.length > total || !part.length) {
      this.staged.delete(key);
      throw new Error("分段推送范围无效");
    }
    if (this.documents.page(space, p.doc).archived) throw new Error("请先恢复归档文档");
    let staging = this.staged.get(key);
    if (offset === 0) {
      staging = { total, parts: [], size: 0, at: Date.now() };
      this.admit(this.staged, instance, key, staging);
    } else if (!staging || staging.total !== total || staging.size !== offset) {
      // A gap or a different push: discard, and the client restarts at 0.
      this.staged.delete(key);
      throw new Error("分段推送缺口，请从头重新推送");
    }
    staging.parts.push(part);
    staging.size += part.length;
    staging.at = Date.now();
    if (staging.size < total) return { staged: staging.size, total };
    this.staged.delete(key);
    this.documents.merge(space, p.doc, Buffer.concat(staging.parts));
    return this.window(instance, p.doc, this.documents.state(space, p.doc, p.vector));
  }
  /** An older View takes the whole state in one answer; past the old page ceiling it is told to refresh. */
  private legacy<T extends { update: string }>(state: T): T {
    if (state.update.length > Math.ceil(DOCS_LEGACY_INLINE_BYTES / 3) * 4)
      throw new Error("文档已超过旧版页面一次读取的大小；请刷新页面，新版本按分段读取");
    return state;
  }
  async dispatch(
    input: Parameters<DeclaredResourcePlane["dispatch"]>[0],
  ): ReturnType<DeclaredResourcePlane["dispatch"]> {
    try {
      const b = input.current();
      if (!b) throw new Error("文档连接已失效");
      const declaration = actionOf(DOCS_CONTRACT, input.action as DocsAction);
      if (!declaration) throw new Error("文档动作未登记");
      const p = Object.fromEntries(
        Object.entries(input.params).filter(
          ([k, v]) => !(v === "" && declaration.params[k]?.optional),
        ),
      );
      if (!decodeWireParams(declaration, p).ok) throw new Error("文档参数无效");
      const space = await this.check(b, declaration.operation!);
      const current = () => {
        const now = input.current();
        if (!now || now.owner !== b.owner || now.sharedInstanceKey !== space)
          throw new Error("文档连接已失效");
        this.allowed(now, declaration.operation!);
      };
      current();
      const before = this.watches.get(b.id);
      this.watches.set(b.id, {
        space,
        doc: p.doc ?? before?.doc ?? "",
        sources: before?.sources ?? new Set(),
        current: input.current,
        publish: input.publish,
      });
      let result: unknown;
      switch (input.action) {
        case "library":
          result =
            p.limit !== undefined || p.after !== undefined
              ? this.documents.libraryPage(space, p.limit, p.after)
              : { pages: whole(this.documents.list(space)) };
          break;
        case "create":
          result = this.documents.create(space, b.owner, p);
          break;
        case "metadata":
          result = this.documents.metadata(space, p);
          break;
        case "read":
          if (p.offset !== undefined)
            result = p.snapshot
              ? this.window(b.id, p.doc, { page: null, vector: "", update: Buffer.alloc(0) }, Number(p.offset), p.snapshot)
              : this.window(b.id, p.doc, this.documents.state(space, p.doc, p.vector));
          else result = this.legacy(this.documents.read(space, p.doc, p.vector));
          break;
        case "update":
          result =
            p.offset !== undefined || p.total !== undefined
              ? this.push(b.id, space, p)
              : this.legacy(this.documents.update(space, p.doc, p.update, p.vector));
          break;
        case "comments":
          result =
            p.limit !== undefined || p.after !== undefined
              ? this.documents.commentsPage(space, p.doc, p.limit, p.after)
              : { comments: whole(this.documents.comments(space, p.doc)) };
          break;
        case "comment":
          result = this.documents.comment(space, b.owner, p);
          break;
        case "resolve":
          result = this.documents.resolve(space, p);
          break;
        case "upload":
          if (this.documents.page(space, p.doc).archived)
            throw new Error("请先恢复归档文档");
          result = this.attachments.upload(space, b.owner, p);
          break;
        case "attachment":
          this.documents.page(space, p.doc);
          result = this.attachments.read(space, p);
          break;
        case "members":
          result = {
            members: this.store
              .listSharedAppMembers(DOCS_APP, space)
              .map((m) => ({ username: m.username, role: m.role })),
          };
          break;
        case "sources":
          result = {
            projects: this.store
              .listSharedAppInstancesFor("research-v2", b.owner)
              .filter((p) => p.status === "open")
              .map((p) => ({
                id: p.instance_key,
                title:
                  this.research?.projectTitle(p.instance_key) ?? p.instance_key,
              })),
          };
          break;
        case "source":
        case "source_call": {
          if (!this.research) throw new Error("科研资源暂不可用");
          const action = input.action === "source" ? "canvas_read" : p.action;
          if (!SOURCE_ACTIONS.has(action))
            throw new Error("此元件动作尚未开放");
          const d = actionOf(CANVAS_CONTRACT, action as CanvasAction);
          if (!d) throw new Error("源资源动作未登记");
          if (
            this.role(space, b.owner) === "viewer" &&
            d.operation !== "read_project" &&
            d.operation !== "read_cloud_document"
          )
            throw new Error("只读文档不能执行源资源操作");
          const values =
            input.action === "source"
              ? p.after
                ? { after: p.after }
                : {}
              : JSON.parse(p.params);
          if (!values || Array.isArray(values) || typeof values !== "object")
            throw new Error("源资源参数无效");
          const watch = this.watches.get(b.id)!;
          watch.sources.add(p.project);
          if (watch.sources.size > 8)
            watch.sources.delete(watch.sources.values().next().value!);
          current();
          result = await this.research.invokeTool(
            { project: p.project, actor: { kind: "human", owner: b.owner } },
            action,
            values,
          );
          current();
          break;
        }
        default:
          throw new Error("未实现的文档动作");
      }
      current();
      input.publish();
      return { ok: true, result: json(result) };
    } catch (error) {
      return {
        ok: false,
        message: (error instanceof Error
          ? error.message
          : "文档操作失败"
        ).slice(0, 500),
      };
    }
  }
}
