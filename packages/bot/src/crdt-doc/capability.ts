/**
 * The CRDT document capability plane — `crdt-doc-v1:<owner>`.
 *
 * ── The first capability Object not backed by a Runner ─────────────────────
 *
 * `workspace-files-runner-v2` reaches a laptop through the shared
 * `RunnerTransport`; this Object reaches a document store that lives in the
 * bot's own data directory. The "adding a backend resource" recipe says to
 * reuse `AccountAuthority` and `runner/dispatch.ts` — the first applies (it is
 * generic over its binding type and none of its logic is Runner-shaped), the
 * second does not, because there is no socket: the binding is the store itself
 * plus the owner name, and the adapter never leaves the process.
 *
 * ── What the Gate decides here, and what it deliberately does not carry ────
 *
 * The 2026-08-09 attempt to declare `edit_document` in a permission contract
 * was refused by the platform itself: the provider served merges directly from
 * a grant, so a consent row had only two spellings — `alwaysApprove` with
 * nothing to deliver the approval (the notify gap), or `mayAutoAllow` on a
 * `modify`, which `defineOperationCatalog` structurally forbids. This Object is
 * the missing enforcer, and its two operations are AUTHORISATION verbs:
 *
 *  · `read_document` — spent by every `list_docs` / `open_doc` / `read_updates`
 *    a scope serves. `read` effect, so a grant may auto-allow it.
 *  · `edit_document` — an EDIT LEASE: "this App instance may merge updates into
 *    this document until the instance ends or the authority is revoked". It is
 *    `modify`, it can never be auto-allowed (the account root's terms only ever
 *    cover observe/read, and `derive` attenuates), so every lease is an
 *    approval card — ONE per (instance, document) sitting, not one per
 *    keystroke burst. That granularity is the honest middle between "a card per
 *    update", which no collaborative editor survives, and "silent standing
 *    write authority", which the catalog invariant exists to refuse.
 *
 * The adapter therefore moves no document content. Updates keep flowing
 * through the provider's own validated store path (validate → append+fsync →
 * apply → answer), and what the kernel records is the decision — which is also
 * why a 64 KiB base64 update never lands in the kernel's result rows. The cost
 * of that split is stated: between two updates inside one lease the Gate is
 * not consulted again, so mid-sitting revocation is enforced by the provider
 * re-checking `alive()` (context liveness + rights) before every merge, and by
 * scope teardown destroying the Context outright.
 *
 * ── Why the lease is safe to retry ─────────────────────────────────────────
 *
 * `retrySafe: true`, stated rather than inherited: granting the same lease
 * twice leaves the world exactly where granting it once did — the scope keeps
 * a boolean per document, and a merge is idempotent anyway. So an interrupted
 * claim goes back to the owner as a pending decision instead of `unknown`.
 */

import {
  CapabilityService,
  type ContextId,
  type ObjectDefinition,
  type Operation,
  type OperationSpec,
  type PolicyDecision,
  type PolicyInput,
} from "@claude-bot/capability-kernel";
import { CRDT_DOC_LIMITS, CRDT_EDIT_OPERATION, CRDT_READ_OPERATION } from "@claude-bot/crdt-doc-contract";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { createLogger } from "../logger.js";
import type { CrdtDocumentStore } from "./store.js";
import { isDocumentId } from "./log.js";

const log = createLogger("crdt-doc-capability");

/** The Context-local slot every CRDT document grant is installed under. */
export const CRDT_DOC_SLOT = "crdt-doc";

/**
 * `${prefix}:${owner}` is the Object id. `v1` moves only when THIS closed
 * table changes — the same containment the workspace-files split bought.
 */
export const CRDT_DOC_OBJECT_PREFIX = "crdt-doc-v1";

/** A store document id: a directory name under the store root, never a path. */
const DOC_ARG = { type: "string", required: true, maxLength: 64 } as const;

/**
 * The closed operation table: one read, one lease.
 *
 * What is absent is the content: there is no `update`, no `stateVector`, no
 * bytes of any kind. The kernel decides WHO may read and who may merge; the
 * bytes flow through the provider's store path, which is where the durability
 * ordering (validate → append+fsync → apply → answer) already lives and is
 * tested. `title` exists so an approval card can name the document in words a
 * person recognises; it is display text supplied by trusted composition data,
 * never by a View.
 */
export const CRDT_DOC_OPERATIONS: Record<Operation, OperationSpec> = {
  [CRDT_READ_OPERATION]: {
    args: { doc: DOC_ARG },
    effect: "read",
    title: "读取协作文档",
  },
  [CRDT_EDIT_OPERATION]: {
    args: {
      doc: DOC_ARG,
      title: { type: "string", maxLength: CRDT_DOC_LIMITS.maxTitleLength },
    },
    effect: "modify",
    retrySafe: true,
    title: "编辑协作文档",
  },
};

/** Every operation this plane can back. Used by the permission projection. */
export const CRDT_DOC_OPERATION_NAMES: readonly string[] = Object.keys(CRDT_DOC_OPERATIONS);

/**
 * Mandatory policy: the same three decisions, in the same order, as every
 * other plane's — exact human approval evidence, then this grant's own terms,
 * then a card addressed to the Object's bound owner.
 */
function crdtDocPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "crdt-doc object has no bound owner" };

  const a = input.approval;
  if (
    a
    && a.objectId === input.object.id
    && a.operation === input.operation
    && a.argsHash === input.argsHash
    && a.contextId === input.context.id
    && a.slot === input.slot
    && a.approver === owner
  ) {
    return { kind: "allow" };
  }

  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };

  const details: string[] = [];
  const title = String(input.args.title ?? "").slice(0, CRDT_DOC_LIMITS.maxTitleLength);
  details.push(`文档：${title || String(input.args.doc ?? "")}`);
  if (input.operation === CRDT_EDIT_OPERATION) {
    // A person approving a lease needs its extent, not a diff preview: the
    // content is the person's own typing, arriving continuously, and a card
    // that pretended to summarise it would describe one burst out of many.
    details.push("授权范围：这个应用实例在本次打开期间对这份文档的持续编辑。");
    details.push("关闭页面、撤销授权或结束实例后，这次授权立即失效。");
  }
  details.push(`动作类别：${input.effect}`);
  details.push(`发起方：${input.context.metadata.purpose ?? input.context.kind}`);
  details.push(`参数指纹：${input.argsHash.slice(0, 16)}`);
  return {
    kind: "approval_required",
    summary: {
      title: `${input.spec.title ?? input.operation} · ${owner}`,
      target: `${owner}/协作文档`,
      details,
      allowedApprover: owner,
    },
  };
}

/** What the adapter is bound to: the process-local store, and whose plane it is. */
interface CrdtDocBinding {
  owner: string;
  store: CrdtDocumentStore;
}

/**
 * The adapter: an authorisation answer, not a data path.
 *
 * It verifies the named document is one the store can even hold (grammar, not
 * existence — existence is the provider's `unknown_doc`, and answering it here
 * would make the Gate an oracle for probing ids) and returns a marker the
 * caller can read back through `resultOf` after an approval lands.
 */
async function crdtDocAdapter(
  binding: CrdtDocBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const doc = String(args.doc ?? "");
  if (!isDocumentId(doc)) throw new Error("crdt-doc: not a document id");
  return { granted: true, operation, doc };
}

/** A narrow, closable authority over one account's collaborative documents. */
export class CrdtDocGrant extends SlotGrant {
  constructor(svc: CapabilityService, contextId: ContextId, purpose: string, owner: string, borrowed = false) {
    super(svc, contextId, CRDT_DOC_SLOT, purpose, owner, borrowed);
  }

  /**
   * Whether this Context still stands and still holds anything on its slot.
   *
   * The provider asks this before every merge INSIDE an approved edit lease:
   * the lease itself is a boolean in scope state, and a boolean cannot notice
   * a revocation. `rightsOf` walks the whole ancestry, so a revoked root, a
   * destroyed parent or a rotated account authority all answer false here.
   */
  alive(): boolean {
    return this.svc.contextIsLive(this.contextId) && this.svc.rightsOf(this.contextId, this.slot).length > 0;
  }
}

export interface CrdtDocCapabilitiesOptions {
  /** The process's ONE capability service, shared with the Runner planes. */
  service: CapabilityService;
  /** Where the documents live. The plane exists only while the store does. */
  store: CrdtDocumentStore;
  /** The trusted user directory. An account that does not exist holds nothing. */
  userExists: (username: string) => boolean;
  now?: () => number;
}

export class CrdtDocCapabilities {
  private authority: AccountAuthority<CrdtDocBinding>;

  constructor(private opts: CrdtDocCapabilitiesOptions) {
    this.authority = new AccountAuthority<CrdtDocBinding>({
      service: opts.service,
      slot: CRDT_DOC_SLOT,
      objectPrefix: CRDT_DOC_OBJECT_PREFIX,
      kind: "crdt-doc",
      operations: CRDT_DOC_OPERATIONS,
      policy: crdtDocPolicy,
      adapter: crdtDocAdapter as ObjectDefinition<CrdtDocBinding>["adapter"],
      now: opts.now,
      /**
       * No device precondition: the documents live on the bot host, so the only
       * trusted fact that can end this plane is the account itself going away.
       * Returning null revokes whatever root is still standing.
       */
      bindingFor: (name) => (opts.userExists(name) ? { owner: name, store: opts.store } : null),
      onWarning: (message, fields) => log.warn(fields, message),
    });
  }

  /** Shared process kernel, for the trusted composition that owns the planes. */
  get service(): CapabilityService {
    return this.opts.service;
  }

  /**
   * Derive a Context over this account's documents for one App instance.
   *
   * Null is a fail-closed answer: no user row, or none of `rights` survives
   * the intersection with what the account root holds.
   */
  open(o: {
    username: string;
    purpose: string;
    kind?: "app-instance" | "controller-run" | "agent-run" | "session" | "job";
    rights: readonly Operation[];
    /** Which of `rights` may be exercised WITHOUT a per-call approval. */
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
    pool?: string;
  }): CrdtDocGrant | null {
    const username = String(o.username ?? "").trim();
    const derived = this.authority.derive({
      username,
      purpose: o.purpose,
      kind: o.kind ?? "app-instance",
      rights: o.rights,
      autoAllow: o.autoAllow,
      metadata: o.metadata,
      pool: o.pool,
    });
    if (!derived) return null;
    return new CrdtDocGrant(this.opts.service, derived.contextId, o.purpose, username, derived.borrowed);
  }

  /** What this account's CRDT root holds right now. */
  accountOperations(username: string): string[] {
    return this.authority.rightsOfAccount(username);
  }

  /** Teardown half of a revocation; `surface` narrows to one pool prefix. */
  dropPooled(username: string, surface?: string): number {
    return this.authority.dropPooled(username, surface);
  }

  revokeAccount(username: string): void {
    this.authority.revokeAccount(username);
  }

  /** Test/diagnostics. */
  get pooledContexts(): number {
    return this.authority.pooledContexts;
  }
}
