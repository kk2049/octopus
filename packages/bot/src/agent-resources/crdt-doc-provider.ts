/**
 * The `crdt-doc/v1` provider, as the catalog installs it.
 *
 * A composition, like `workspace-files-provider.ts` and `notify-provider.ts`:
 * an authority the DEPLOYMENT opened (`openGrant`), a document store the
 * deployment already had, and the contract package's declaration for everything
 * about the request shape. Nothing about permissions or storage is decided here.
 *
 * ── Four properties this file is responsible for ───────────────────────────
 *
 *  1. **A ref is kept, not encoded.** The map from ref to document id lives in
 *     this scope's state and dies with it. A forged ref, another scope's ref and
 *     a ref from a closed scope are therefore one thing — a lookup miss — rather
 *     than three checks somebody has to remember to write.
 *  2. **`read_document` does not imply `edit_document`.** A scope without the
 *     edit token gets a port whose `apply_update` refuses; it still opens and
 *     follows the same documents, because "read-only" must not silently mean
 *     "fewer documents".
 *  3. **The wire clamp is not applied to a CRDT update.** This is the one place
 *     in the repository that decodes with something other than the kit's
 *     `decodeWireParams`, and the reason is written out in
 *     `@claude-bot/crdt-doc-contract`'s `decode.ts`: two of this contract's
 *     parameters are larger than the View wire's flat 512 characters, so
 *     applying that bound here would refuse every update a real editor makes,
 *     including on the in-process and MCP faces where the bound does not apply.
 *  4. **Update floods are refused, not dropped.** `rate_limited` means "later",
 *     and it is a bounded refusal the consumer can show, because a consumer that
 *     cannot tell "slow down" from "broken" will retry for ever.
 *  5. **Every answer stands on a kernel decision (2026-08-10).** Reads ask the
 *     Gate for `read_document` per call; a merge happens only inside a kernel-
 *     approved `edit_document` LEASE — one gated call per (scope, document),
 *     whose approval card names the document and the sitting. Between merges
 *     the lease is a boolean, so `alive()` is re-checked before every one:
 *     a revocation that lands mid-sitting stops the next merge, not the next
 *     scope. The bytes themselves still flow through the store's validated
 *     path and never enter the kernel.
 *  6. **v2 bounds the window, not the document (2026-10-20).** The same
 *     composition serves `crdt-doc/v2` (`crdtDocProviderV2`): an answer larger
 *     than one window becomes a `resource-stream/v1` stream over a snapshot of
 *     the encoded bytes, and an update larger than one window arrives as
 *     offset-addressed parts staged per (scope, document) — only inside the
 *     edit lease, discarded on restart, on any gap and on scope close — and is
 *     merged once, through the same validated path. v1 is unchanged.
 */

import { randomBytes } from "node:crypto";
import {
  CRDT_DOC_CONTRACT,
  CRDT_DOC_CONTRACT_V2,
  CRDT_DOC_DECLARATION,
  CRDT_DOC_DECLARATION_V2,
  CRDT_DOC_LIMITS,
  CRDT_DOC_V2_LIMITS,
  CRDT_EDIT_OPERATION,
  CRDT_READ_OPERATION,
  CRDT_SCHEMA_MAJOR,
  CRDT_UPDATE_CHUNK_PAYLOAD,
  CRDT_UPDATE_MEDIA_TYPE,
  base64ByteLength,
  crdtActionOf,
  crdtActionOfV2,
  decodeCrdtParams,
  isBase64,
  readCrdtUpdateChunk,
  type CrdtUpdateChunk,
} from "@claude-bot/crdt-doc-contract";
import {
  RESOURCE_STREAM_CONTRACT,
  type ResourceStreamOpenFrame,
  type ResourceStreamRead,
  type ResourceStreamResponseFrame,
  type ResourceStreamSource,
} from "@claude-bot/resource-stream-contract";
import { STREAM_CLOSE_ACTION, STREAM_PULL_ACTION, wireActionOf, type PortActionDeclaration } from "@claude-bot/typed-port-kit";
import { createLogger } from "../logger.js";
import type { CrdtDocumentDescriptor, CrdtScopeGrant } from "../crdt-doc/types.js";
import type { StoreRefusal } from "../crdt-doc/store.js";
import { ResourceStreamBroker } from "../resource-stream/broker.js";
import {
  resourceRefusal,
  type ResourceAnswer,
  type ResourceProviderContext,
  type ResourceProviderDefinition,
} from "./types.js";

const log = createLogger("crdt-doc-provider");

/** `resource.open_doc` and friends, derived so they cannot drift. */
export const CRDT_PROPOSAL_ACTIONS: readonly string[] = Object.freeze(
  CRDT_DOC_DECLARATION.actionIds.map((action) => wireActionOf(action)),
);

/** v2: the same four verbs plus the two `resource-stream/v1` verbs its answers open. */
export const CRDT_PROPOSAL_ACTIONS_V2: readonly string[] = Object.freeze([
  ...CRDT_DOC_DECLARATION_V2.actionIds.map((action) => wireActionOf(action)),
  STREAM_PULL_ACTION,
  STREAM_CLOSE_ACTION,
]);

type CrdtActionId = (typeof CRDT_DOC_DECLARATION.actionIds)[number];

/** What differs between the two versions this file serves. Everything else is shared. */
interface CrdtDialect {
  readonly version: 1 | 2;
  readonly contract: string;
  readonly actions: readonly string[];
  readonly actionIds: readonly CrdtActionId[];
  actionOf(id: string): PortActionDeclaration<CrdtActionId> | null;
}

const V1: CrdtDialect = Object.freeze({
  version: 1,
  contract: CRDT_DOC_CONTRACT,
  actions: CRDT_PROPOSAL_ACTIONS,
  actionIds: CRDT_DOC_DECLARATION.actionIds,
  actionOf: crdtActionOf,
});

const V2: CrdtDialect = Object.freeze({
  version: 2,
  contract: CRDT_DOC_CONTRACT_V2,
  actions: CRDT_PROPOSAL_ACTIONS_V2,
  actionIds: CRDT_DOC_DECLARATION_V2.actionIds,
  actionOf: crdtActionOfV2,
});

export interface CrdtDocProviderOptions {
  /**
   * Open this scope's authority, or return null when it holds none.
   *
   * Supplied by the composition root, and the only place "may this instance read
   * or edit documents, and which" is answered. Null also covers "this deployment
   * has no document store at all".
   */
  openGrant: (context: ResourceProviderContext) => CrdtScopeGrant | null;
  /**
   * Updates one scope may push per window. Default 120 per 60 s.
   *
   * The number is chosen against the two fuses that sit ABOVE this one on the
   * View path — 100 messages per rolling 10 s on the frame host, which does not
   * refuse but CLOSES the channel — so a client that stays inside this limit is
   * comfortably inside that one. It also states the design constraint on any
   * editor built against this contract: one proposal per keystroke is not a
   * viable client, so an update has to be debounced and merged locally before it
   * is pushed. See the worklog's wall record.
   */
  limit?: { updates: number; windowMs: number };
  now?: () => number;
  /**
   * Tell the trusted composition root which refs this scope minted.
   *
   * ── Why this seam has to exist ─────────────────────────────────────────
   *
   * `crdt-doc/v1` has no enumeration verb, deliberately: a consumer holds refs
   * it was HANDED, and a `list_documents` action would disclose a document
   * inventory to an untrusted bundle. But then somebody has to do the handing,
   * and the ref is minted here, inside the provider, at scope open.
   *
   * So a trusted App shell that wants to put a document in front of a person
   * needs this callback to build the `open-resource/v1` link — the same
   * information flow `workspace-files/v1` gets from its `refresh_roots` action
   * and `notify/v1` does not have at all. It is trusted-side to trusted-side:
   * nothing a View says can reach it, and it is called exactly once per scope,
   * synchronously, before the scope can serve anything.
   *
   * This is a bootstrap seam, not a feature. It is recorded in the worklog as
   * one of the slice's structural gaps: today the only consumer is a test,
   * because no App is wired to this contract.
   */
  onScopeOpened?: (context: ResourceProviderContext, refs: ReadonlyMap<string, CrdtDocumentDescriptor>) => void;
  /**
   * The other half of the seam above: the scope can no longer serve anything.
   *
   * Called synchronously from the provider's `close`, before the grant is
   * released, so a wake fan-out that learned about this scope's refs from
   * `onScopeOpened` can forget them before a late change tries to wake a
   * scope that is gone.
   */
  onScopeClosed?: (context: ResourceProviderContext) => void;
}

interface CrdtScopeState {
  grant: CrdtScopeGrant;
  /** ref → document. Minted at open; never derived from anything a caller said. */
  refs: Map<string, CrdtDocumentDescriptor>;
  pushed: number[];
  /**
   * Documents whose edit lease the kernel has ALLOWED for this scope.
   *
   * A boolean per document, which is why `authority.alive()` is re-checked
   * before every merge — the lease records a decision, the liveness check is
   * what notices the decision being revoked mid-sitting.
   */
  leases: Set<string>;
  /** Documents whose lease request produced a card that is still undecided. */
  pendingEdits: Map<string, string>;
  /**
   * v2 only: an update arriving in parts, per document. One unfinished upload
   * per document; a part at offset 0 replaces it, any gap discards it.
   */
  staging: Map<string, { total: number; staged: number; parts: Uint8Array[] }>;
  closed: boolean;
}

export function crdtDocProvider(options: CrdtDocProviderOptions): ResourceProviderDefinition<CrdtScopeState> {
  return createCrdtDocProvider(options, V1);
}

/** `crdt-doc/v2`: the same authority and store, with no ceiling on a document. */
export function crdtDocProviderV2(options: CrdtDocProviderOptions): ResourceProviderDefinition<CrdtScopeState> {
  return createCrdtDocProvider(options, V2);
}

function createCrdtDocProvider(
  options: CrdtDocProviderOptions,
  dialect: CrdtDialect,
): ResourceProviderDefinition<CrdtScopeState> {
  const now = options.now ?? Date.now;
  const limit = options.limit ?? { updates: 120, windowMs: 60_000 };
  // One per provider: a stream belongs to the scope that opened it, and the
  // broker refuses a handle presented by any other scope.
  const streams = new ResourceStreamBroker({ caps: { maxChunkBytes: CRDT_DOC_V2_LIMITS.chunkBytes } });

  return {
    contract: dialect.contract,
    actions: dialect.actions,

    open(context: ResourceProviderContext): CrdtScopeState | null {
      const grant = options.openGrant(context);
      if (!grant) return null;
      const refs = new Map<string, CrdtDocumentDescriptor>();
      for (const document of grant.documents) refs.set(`cd_${randomBytes(12).toString("hex")}`, document);
      if (!refs.size) {
        // A scope that may reach no document holds nothing. Closing the grant
        // here keeps "no authority" and "no documents" the same observable
        // state, which is what `notify/v1` does for the same reason.
        grant.close();
        return null;
      }
      // Before the scope can serve anything, so a shell cannot observe a scope
      // that is answering with refs it has not been told about.
      options.onScopeOpened?.(context, refs);
      return { grant, refs, pushed: [], leases: new Set(), pendingEdits: new Map(), staging: new Map(), closed: false };
    },

    async dispatch(
      state: CrdtScopeState,
      action: string,
      params: Readonly<Record<string, string>>,
      context: ResourceProviderContext,
    ): Promise<ResourceAnswer> {
      if (state.closed) return resourceRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");

      if (dialect.version === 2 && (action === STREAM_PULL_ACTION || action === STREAM_CLOSE_ACTION)) {
        try {
          return await streamVerb(streams, context.scope, action, params);
        } catch (err) {
          log.error({ err, app: context.app, owner: context.owner }, "crdt document stream threw");
          return resourceRefusal("unavailable", "协作文档服务暂时不可用。");
        }
      }

      const id = dialect.actionIds.find((candidate) => wireActionOf(candidate) === action);
      const declared = id ? dialect.actionOf(id) : null;
      if (!id || !declared) return resourceRefusal("invalid_request", "这个资源不支持被请求的动作。");

      const decoded = decodeCrdtParams(declared, withoutBinding(params));
      if (!decoded.ok) {
        const first = decoded.issues[0];
        return resourceRefusal("invalid_request", `这次请求的参数不被接受：${first?.message ?? "校验失败"}`);
      }

      try {
        if (id === "list_docs") return listDocs(state);

        const document = state.refs.get(String(decoded.value.doc ?? ""));
        if (!document) return resourceRefusal("unknown_doc", "这个文档引用不属于当前视图。");

        switch (id) {
          case "open_doc": {
            const gate = await readGate(state, document);
            if (gate) return gate;
            if (dialect.version === 1) return openDoc(state, document);
            // A stream outlives this call; never open one for a scope that
            // closed while the Gate was deciding.
            if (state.closed) return resourceRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
            return openDocV2(state, document, streams, context.scope);
          }
          case "read_updates": {
            const gate = await readGate(state, document);
            if (gate) return gate;
            const since = String(decoded.value.since ?? "");
            if (dialect.version === 1) return readUpdates(state, document, since);
            if (state.closed) return resourceRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
            return readUpdatesV2(state, document, since, streams, context.scope);
          }
          case "apply_update":
            if (dialect.version === 2) {
              return await applyUpdateV2(state, context, document, decoded.value, now, limit);
            }
            return await applyUpdate(state, context, document, String(decoded.value.update ?? ""), now, limit);
        }
        return resourceRefusal("invalid_request", "这个资源不支持被请求的动作。");
      } catch (err) {
        // A throwing store or Gate is a bug on the trusted side, and its
        // message is exactly the field that reliably carries a path out.
        log.error({ err, app: context.app, owner: context.owner }, "crdt document store threw");
        return resourceRefusal("unavailable", "协作文档服务暂时不可用。");
      }
    },

    close(state: CrdtScopeState, context: ResourceProviderContext): void {
      // Synchronous, and before anything else: on return the refs no longer
      // resolve, so a late proposal is `unknown_doc` rather than a write made
      // under an authority that has been given up. The wake seam is told while
      // the context is still identifiable, then the grant is released — the
      // reverse order would leave a window where a change wakes a scope whose
      // authority is already gone.
      state.closed = true;
      state.refs.clear();
      state.leases.clear();
      state.pendingEdits.clear();
      state.staging.clear();
      options.onScopeClosed?.(context);
      // No handle this scope opened can produce another byte after this; the
      // snapshots they held are released with them.
      void streams.closeScope(context.scope);
      state.grant.close();
    },
  };
}

/**
 * The scope's granted set, as refs and titles.
 *
 * No per-document Gate call: the set IS the trusted grant seam's decision
 * (`documentsFor` ∩ a live `read_document` grant), and enumerating titles
 * discloses nothing a single `open_doc` would not. What it does check is that
 * the authority still stands, so a revoked scope stops listing before its
 * instance is torn down.
 */
function listDocs(state: CrdtScopeState): ResourceAnswer {
  if (!state.grant.authority.alive()) {
    return resourceRefusal("no_authority", "这个视图的协作文档授权已经结束。");
  }
  const docs = [...state.refs.entries()].map(([ref, document]) => ({
    doc: ref,
    title: document.label.slice(0, CRDT_DOC_LIMITS.maxTitleLength),
  }));
  return { ok: true, result: { docs } };
}

/**
 * One `read_document` decision, or the refusal that stands in for the answer.
 *
 * Null means "allowed, go read the store". Everything else is the bounded
 * refusal to hand back INSTEAD of content — including `approval_required`,
 * which for an auto-allowed deployment never happens but for a grant without
 * read auto-allow is a card, exactly as workspace reads behave.
 */
async function readGate(state: CrdtScopeState, document: CrdtDocumentDescriptor): Promise<ResourceAnswer | null> {
  const decision = await state.grant.authority.request(CRDT_READ_OPERATION, { doc: document.id });
  switch (decision.status) {
    case "succeeded":
      return null;
    case "approval_required":
      return resourceRefusal("approval_required", "读取这份文档需要文档主人在待批准列表里确认。");
    case "denied":
      return resourceRefusal("no_authority", "当前登录没有读取这份协作文档的授权。");
    default:
      return resourceRefusal("unavailable", "协作文档服务暂时不可用。");
  }
}

function openDoc(state: CrdtScopeState, document: CrdtDocumentDescriptor): ResourceAnswer {
  const read = state.grant.store.read(document.id);
  if (!read.ok) return refuseStore(read.code);
  const update = encode(read.value.update);
  if (update.length > CRDT_DOC_LIMITS.maxUpdateEncodedLength) {
    // Never a truncation: half a CRDT update is not a smaller document, it is a
    // document that will not decode. v1 has no streamed open; `crdt-doc/v2`
    // (below) streams exactly this answer, and a release binds it instead.
    return resourceRefusal("doc_too_large", "这份文档已经超过一次读取能承载的大小。");
  }
  return {
    ok: true,
    result: {
      doc: refOf(state, document),
      schemaMajor: CRDT_SCHEMA_MAJOR,
      stateVector: encode(read.value.stateVector),
      update,
    },
  };
}

function readUpdates(state: CrdtScopeState, document: CrdtDocumentDescriptor, since: string): ResourceAnswer {
  const bytes = decode(since, CRDT_DOC_LIMITS.maxStateVectorEncodedLength);
  if (!bytes) return resourceRefusal("invalid_request", "状态向量不是合法的 base64。");
  const diff = state.grant.store.diff(document.id, bytes);
  if (!diff.ok) return refuseStore(diff.code);
  const update = encode(diff.value.update);
  if (update.length > CRDT_DOC_LIMITS.maxUpdateEncodedLength) {
    return resourceRefusal("doc_too_large", "这次增量已经超过一次读取能承载的大小。");
  }
  return {
    ok: true,
    result: {
      doc: refOf(state, document),
      stateVector: encode(diff.value.stateVector),
      update,
      empty: diff.value.empty,
    },
  };
}

async function applyUpdate(
  state: CrdtScopeState,
  context: ResourceProviderContext,
  document: CrdtDocumentDescriptor,
  update: string,
  now: () => number,
  limit: { updates: number; windowMs: number },
  maxEncoded: number = CRDT_DOC_LIMITS.maxUpdateEncodedLength,
): Promise<ResourceAnswer> {
  if (!state.grant.mayEdit) {
    return resourceRefusal("no_authority", "这个视图只被授予了读取协作文档，没有被授予写入。");
  }
  const bytes = decode(update, maxEncoded);
  if (!bytes) return resourceRefusal("invalid_request", "update 不是合法的 base64。");

  const limited = spendPush(state, now, limit);
  if (limited) return limited;

  const lease = await editLease(state, document);
  if (lease) return lease;

  // Inside the lease. The origin is this scope's derived key, so the change
  // seam can wake every OTHER holder of the document and skip the author.
  const merged = state.grant.store.applyUpdate(document.id, bytes, context.scope);
  if (!merged.ok) return refuseStore(merged.code);
  return { ok: true, result: { doc: refOf(state, document), stateVector: encode(merged.value.stateVector) } };
}

/**
 * One push against the scope's rate window, or the refusal that replaces it.
 *
 * A push is one update, whatever number of parts carried it: the window bounds
 * how often a View may change a document, not how large a change may be.
 */
function spendPush(
  state: CrdtScopeState,
  now: () => number,
  limit: { updates: number; windowMs: number },
): ResourceAnswer | null {
  const at = now();
  state.pushed = state.pushed.filter((stamp) => at - stamp < limit.windowMs);
  if (state.pushed.length >= limit.updates) {
    return resourceRefusal("rate_limited", "这个视图短时间内推送得太多了，请稍后再试。");
  }
  state.pushed.push(at);
  return null;
}

/**
 * `crdt-doc/v2`'s `apply_update`: a whole update as in v1 (one window larger),
 * or one offset-addressed part of an update of any size.
 *
 * Parts are staged in arrival order per (scope, document) and merged once, by
 * the same validated path a whole update takes, when `staged === total`.
 * Nothing is staged outside the edit lease, a part at offset 0 starts over, and
 * any other gap discards the upload — the caller still holds the edit in its
 * replica and restarts from 0, which is the whole recovery story.
 */
async function applyUpdateV2(
  state: CrdtScopeState,
  context: ResourceProviderContext,
  document: CrdtDocumentDescriptor,
  params: Readonly<Record<string, unknown>>,
  now: () => number,
  limit: { updates: number; windowMs: number },
): Promise<ResourceAnswer> {
  const update = String(params.update ?? "");
  if ((params.offset === undefined) !== (params.total === undefined)) {
    return resourceRefusal("invalid_request", "分段推送需要同时给出 offset 与 total。");
  }
  if (params.total === undefined) {
    return await applyUpdate(state, context, document, update, now, limit, CRDT_DOC_V2_LIMITS.maxPartEncodedLength);
  }
  if (!state.grant.mayEdit) {
    return resourceRefusal("no_authority", "这个视图只被授予了读取协作文档，没有被授予写入。");
  }
  const part = decode(update, CRDT_DOC_V2_LIMITS.maxPartEncodedLength);
  if (!part) return resourceRefusal("invalid_request", "update 不是合法的 base64。");
  // Both are digit strings the declaration bounded at 15 places: safe integers.
  const offset = Number(params.offset);
  const total = Number(params.total);
  if (part.byteLength === 0 || offset + part.byteLength > total) {
    state.staging.delete(document.id);
    return resourceRefusal("invalid_request", "这一段超出了声明的 update 大小。");
  }
  // Staging holds the parts in this process until they merge, so an upload
  // the replica would refuse anyway is refused before it holds anything.
  if (total > state.grant.store.maxDocumentBytes) {
    state.staging.delete(document.id);
    return resourceRefusal("doc_too_large", "这次改动会让文档超过单个协作文档在服务端内存中的上限，没有被接受。");
  }

  const before = state.staging.get(document.id);
  if (offset === 0) {
    const limited = spendPush(state, now, limit);
    if (limited) return limited;
  } else if (!before || before.total !== total || before.staged !== offset) {
    state.staging.delete(document.id);
    return resourceRefusal("invalid_request", "分段推送的偏移与已收到的不一致，请从头重新推送。");
  }

  const lease = await editLease(state, document);
  if (lease) {
    state.staging.delete(document.id);
    return lease;
  }
  // Re-checked after the await: the scope may have closed, or another push for
  // this document may have restarted the upload meanwhile.
  if (state.closed) return resourceRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
  let staging = state.staging.get(document.id);
  if (offset === 0) {
    staging = { total, staged: 0, parts: [] };
    state.staging.set(document.id, staging);
  } else if (staging !== before) {
    return resourceRefusal("invalid_request", "分段推送的偏移与已收到的不一致，请从头重新推送。");
  }
  staging!.parts.push(part);
  staging!.staged += part.byteLength;

  if (staging!.staged < total) {
    const vector = state.grant.store.stateVector(document.id);
    if (!vector.ok) return refuseStore(vector.code);
    return {
      ok: true,
      result: { doc: refOf(state, document), stateVector: encode(vector.value), staged: staging!.staged },
    };
  }
  state.staging.delete(document.id);
  const whole = Buffer.concat(staging!.parts);
  const merged = state.grant.store.applyUpdate(document.id, new Uint8Array(whole.buffer, whole.byteOffset, whole.byteLength), context.scope);
  if (!merged.ok) return refuseStore(merged.code);
  return { ok: true, result: { doc: refOf(state, document), stateVector: encode(merged.value.stateVector) } };
}

/** v2's `open_doc`: v1's answer, with the update inline or streamed. */
function openDocV2(
  state: CrdtScopeState,
  document: CrdtDocumentDescriptor,
  streams: ResourceStreamBroker,
  scope: string,
): ResourceAnswer {
  const read = state.grant.store.read(document.id);
  if (!read.ok) return refuseStore(read.code);
  const carried = carryUpdate(read.value.update, streams, scope);
  if ("refusal" in carried) return carried.refusal;
  return {
    ok: true,
    result: {
      doc: refOf(state, document),
      schemaMajor: CRDT_SCHEMA_MAJOR,
      stateVector: encode(read.value.stateVector),
      ...carried,
    },
  };
}

/** v2's `read_updates`: v1's answer, with the diff inline or streamed. */
function readUpdatesV2(
  state: CrdtScopeState,
  document: CrdtDocumentDescriptor,
  since: string,
  streams: ResourceStreamBroker,
  scope: string,
): ResourceAnswer {
  const bytes = decode(since, CRDT_DOC_V2_LIMITS.maxStateVectorEncodedLength);
  if (!bytes) return resourceRefusal("invalid_request", "状态向量不是合法的 base64。");
  const diff = state.grant.store.diff(document.id, bytes);
  if (!diff.ok) return refuseStore(diff.code);
  const carried = carryUpdate(diff.value.update, streams, scope);
  if ("refusal" in carried) return carried.refusal;
  return {
    ok: true,
    result: {
      doc: refOf(state, document),
      stateVector: encode(diff.value.stateVector),
      empty: diff.value.empty,
      ...carried,
    },
  };
}

/**
 * Inline when the update fits one window, otherwise a stream over these exact
 * bytes. The stream holds the snapshot it was opened on, so a document edited
 * while somebody is pulling it cannot splice two states into one answer.
 */
function carryUpdate(
  update: Uint8Array,
  streams: ResourceStreamBroker,
  scope: string,
): { update: string } | { stream: ResourceStreamOpenFrame } | { refusal: ResourceAnswer } {
  if (update.byteLength <= CRDT_DOC_V2_LIMITS.maxPartBytes) return { update: encode(update) };
  const opened = streams.open(scope, updateSource(update));
  if (!opened.ok) {
    return { refusal: resourceRefusal("rate_limited", "这个视图同时打开的文档读取太多了，请稍后再试。") };
  }
  return {
    stream: { contract: RESOURCE_STREAM_CONTRACT, kind: "open", handle: opened.handle, metadata: opened.stream.metadata },
  };
}

/**
 * A pull source over one encoded update, in chunks of `chunkBytes` — a multiple
 * of three, so every chunk but the last is padding-free base64 and the chunks
 * concatenate to the base64 of the whole.
 */
function updateSource(bytes: Uint8Array): ResourceStreamSource<CrdtUpdateChunk> {
  let at = 0;
  return {
    metadata: { payload: CRDT_UPDATE_CHUNK_PAYLOAD, mediaType: CRDT_UPDATE_MEDIA_TYPE, totalBytes: bytes.byteLength },
    async pull() {
      if (at >= bytes.byteLength) return { kind: "end" };
      const slice = bytes.subarray(at, at + CRDT_DOC_V2_LIMITS.chunkBytes);
      at += slice.byteLength;
      return { kind: "chunk", value: { data: encode(slice) }, bytes: slice.byteLength };
    },
    close() {
      at = bytes.byteLength;
    },
  };
}

/** `resource.stream_pull` / `resource.stream_close`, scoped to the caller's own streams. */
async function streamVerb(
  streams: ResourceStreamBroker,
  scope: string,
  action: string,
  params: Readonly<Record<string, string>>,
): Promise<ResourceAnswer> {
  const handle = String(params.handle ?? "");
  if (action === STREAM_CLOSE_ACTION) return { ok: true, result: { closed: await streams.close(scope, handle) } };
  const seq = Number(params.seq);
  if (!Number.isInteger(seq) || seq < 0) {
    return resourceRefusal("invalid_request", "这次读取没有给出合法的分块序号。");
  }
  return { ok: true, result: streamFrame(handle, await streams.pull(scope, handle, seq)) };
}

/**
 * One broker answer as a `resource-stream/v1` response frame. The chunk is
 * re-read by the contract's reader and its size measured from the base64, not
 * taken from the source's claim.
 */
function streamFrame(handle: string, read: ResourceStreamRead<unknown>): ResourceStreamResponseFrame {
  if (read.kind === "end") {
    return { contract: RESOURCE_STREAM_CONTRACT, kind: "end", handle, chunks: read.chunks, bytes: read.bytes };
  }
  if (read.kind === "refused") {
    return { contract: RESOURCE_STREAM_CONTRACT, kind: "refused", handle, code: read.code, message: read.message };
  }
  const chunk = readCrdtUpdateChunk(read.value);
  if (!chunk.ok) {
    return { contract: RESOURCE_STREAM_CONTRACT, kind: "refused", handle, code: "protocol", message: "文档分块没有通过内容契约校验。" };
  }
  return {
    contract: RESOURCE_STREAM_CONTRACT,
    kind: "chunk",
    handle,
    seq: read.seq,
    bytes: base64ByteLength(chunk.value.data),
    value: chunk.value,
  };
}

/**
 * Hold, or acquire, this scope's edit lease on one document.
 *
 * Null means "the lease stands, merge". The state machine is deliberately
 * small: no lease and no card → ask the Gate once; a card → read its recorded
 * outcome rather than asking again (a second ask while one is pending would
 * be answered by the kernel's retry-join, but reading the record is the
 * honest spelling of "we already asked"); decided against → clear, so the
 * next EXPLICIT push may ask again. Nothing here retries on its own — the
 * View does not auto-retry a refusal, so a fresh card requires a person's
 * gesture on each side.
 */
async function editLease(state: CrdtScopeState, document: CrdtDocumentDescriptor): Promise<ResourceAnswer | null> {
  if (state.leases.has(document.id)) {
    // The lease is a boolean; the liveness check is what notices revocation.
    if (!state.grant.authority.alive()) {
      state.leases.delete(document.id);
      return resourceRefusal("no_authority", "这个视图的编辑授权已经被撤销。");
    }
    return null;
  }

  const pending = state.pendingEdits.get(document.id);
  if (pending) {
    const outcome = state.grant.authority.result(pending);
    if (outcome && (outcome.state === "pending" || outcome.state === "claimed")) {
      return resourceRefusal("approval_required", "编辑授权还在等待文档主人确认；确认后再点一次同步。");
    }
    state.pendingEdits.delete(document.id);
    if (outcome && outcome.state === "finished" && outcome.outcome === "succeeded") {
      state.leases.add(document.id);
      return null;
    }
    if (outcome && outcome.state === "rejected") {
      return resourceRefusal("no_authority", "文档主人拒绝了这次编辑授权。再次同步会重新询问。");
    }
    // Expired, unknown, or a record the kernel no longer holds: fall through
    // and ask again — the next answer will be a fresh card, not a merge.
  }

  const decision = await state.grant.authority.request(CRDT_EDIT_OPERATION, {
    doc: document.id,
    title: document.label.slice(0, CRDT_DOC_LIMITS.maxTitleLength),
  });
  switch (decision.status) {
    case "succeeded":
      state.leases.add(document.id);
      return null;
    case "approval_required":
      state.pendingEdits.set(document.id, decision.pendingCallId);
      return resourceRefusal(
        "approval_required",
        "第一次编辑这份文档需要文档主人在待批准列表里确认；确认后你的改动会在下一次同步时合并。",
      );
    case "denied":
      return resourceRefusal("no_authority", "当前登录没有编辑这份协作文档的授权。");
    default:
      return resourceRefusal("unavailable", "协作文档服务暂时不可用。");
  }
}

/** The store's refusal codes are already this contract's. Nothing is translated. */
function refuseStore(code: StoreRefusal): ResourceAnswer {
  switch (code) {
    case "bad_update":
      return resourceRefusal("bad_update", "这条 update 不是当前文档能合并的内容。");
    case "doc_too_large":
      return resourceRefusal("doc_too_large", "这份文档已经达到单个协作文档在服务端内存中的上限，本次写入没有被接受。");
    case "unavailable":
      return resourceRefusal("unavailable", "协作文档服务暂时不可用。");
  }
}

/**
 * The ref this scope minted for a document.
 *
 * Looked up rather than remembered on the descriptor, because the descriptor
 * comes from the grant and is shared across scopes — writing a per-scope ref
 * onto it would leak one scope's ref into another's answers.
 */
function refOf(state: CrdtScopeState, document: CrdtDocumentDescriptor): string {
  for (const [ref, candidate] of state.refs) if (candidate === document) return ref;
  /* c8 ignore next */
  throw new Error("crdt-doc: a document resolved from a ref has no ref");
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * Decode base64, or nothing.
 *
 * `Buffer.from(x, "base64")` is famously permissive — it skips characters it
 * does not recognise and rounds a truncated quantum — so the string is checked
 * against the contract's grammar FIRST. Without that, a corrupted parameter
 * would decode to bytes nobody sent and be diagnosed as `bad_update` rather
 * than as a malformed request.
 */
function decode(value: string, max: number): Uint8Array | null {
  if (!isBase64(value, max)) return null;
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** The catalog's routing parameter is not part of any action's declaration. */
function withoutBinding(params: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "binding") continue;
    out[key] = value;
  }
  return out;
}
