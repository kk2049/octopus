/**
 * `crdt-doc/v1` — pull one collaborative document's state, push one update back.
 *
 * ── What this contract is, in one sentence ─────────────────────────────────
 *
 * A consumer holds an opaque document ref somebody handed it; with that ref it
 * can fetch the document's current state as a CRDT update, push an update it
 * produced locally, and ask for everything that happened since a state vector it
 * already has. It cannot enumerate documents, cannot name one it was not given,
 * and cannot learn where one is stored.
 *
 * ── Why exactly three actions ──────────────────────────────────────────────
 *
 * Because three is the complete pull-based synchronisation protocol, and a
 * fourth would be a push channel this architecture cannot yet deliver (see
 * `wire.test.ts` and the worklog's wall record). `open_doc` is "give me
 * everything", `apply_update` is "here is what I did", `read_updates` is "what
 * did others do since <state vector>". Yjs's own sync protocol is these three
 * messages; naming them as actions rather than inventing a fourth is the point
 * of using an audited CRDT rather than writing one (design doc §12).
 *
 * ── Why base64 and not a binary channel ────────────────────────────────────
 *
 * The transport underneath a typed port is a flat map of STRINGS: the trusted
 * dispatcher has to bound a proposal without knowing what any parameter means,
 * and eight short strings is something it can measure. A CRDT update is bytes,
 * so it travels base64-encoded and is decoded by this contract's own reader.
 * That is a real cost — 4 characters per 3 bytes — and it is stated here rather
 * than hidden, because it is one of the two numbers that decide whether this
 * contract is serviceable over that transport at all.
 *
 * ── The honest state of the wire, today ────────────────────────────────────
 *
 * It is NOT serviceable over the View wire today, and this file does not pretend
 * otherwise. `WIRE_PARAM_LIMITS.maxValueLength` is a flat 512 characters for
 * every parameter of every action; the smallest useful Yjs update is already
 * near that, and a state vector for a document a handful of colleagues have
 * edited over months is past it. So the bounds below are the REAL ones, and
 * `CRDT_DOC_DECLARATION.wireProblems` records — as data, checked by a test —
 * exactly which parameters do not fit and by how much. Declaring a fake 512-byte
 * bound to make the numbers line up would produce a port that is structurally
 * unable to carry a second edit, and would say so only at the first call.
 *
 * The dependency this creates is named: per-action wire bounds (the convergence
 * plan's sideline 6, scheduled as P6b). Until they land, the port is reachable
 * from an in-process trusted consumer and from the MCP face — which decision 5
 * states explicitly is NOT bounded by the View wire's 8 keys × 512 characters —
 * and not from an Agent View.
 *
 * ── One document, two permission tokens ────────────────────────────────────
 *
 * `open_doc` and `read_updates` spend `read_document`; `apply_update` spends
 * `edit_document`. Reading a colleague's notes and writing into them are not one
 * authorisation, and a CRDT makes the difference sharper rather than softer: an
 * accepted update is merged into a shared history that everyone else will
 * receive, so "read implies write" would be a much larger claim here than on a
 * file.
 */

import { ID_PATTERNS, declareContract, refusalVocabulary } from "@claude-bot/typed-port-kit";

export const CRDT_DOC_CONTRACT = "crdt-doc/v1";

/**
 * The resource kind an `open-resource/v1` link carries for one of these
 * documents.
 *
 * It lives with the ABI rather than with any particular editor, for the reason
 * `WORKSPACE_TEXT_RESOURCE_KIND` does: a second editor implementation must be
 * able to declare that it opens the same kind without depending on the first.
 */
export const CRDT_NOTE_RESOURCE_KIND = "crdt-note";

/**
 * The numbers both halves bound themselves by.
 *
 * Each one is a real limit somebody has to live inside, and each is stated with
 * the reason it is that number rather than a rounder one:
 *
 * `maxUpdateEncodedLength` — 64 KiB of base64 is 48 KiB of update. A whole
 * paragraph of typing is a few hundred bytes; 48 KiB is a document of a few tens
 * of thousands of characters delivered in one `open_doc`. Past that the answer
 * is `doc_too_large`, NOT a truncated update: half a CRDT update is not a
 * smaller document, it is a document that will not decode.
 *
 * `maxStateVectorEncodedLength` — a Yjs state vector is roughly ten bytes per
 * distinct client id that has ever written, and a browser mints a NEW client id
 * on every reload unless one is persisted. Five colleagues reloading a tab a few
 * times a day for a year is thousands of ids, so 4 KiB of base64 (≈3 KiB, ≈300
 * ids) is a deliberately modest ceiling that a real document WILL eventually
 * exceed. Recording that here is more useful than picking a number large enough
 * to look safe: it is the second thing that has to be solved before this port is
 * a product (`gc`/client-id reuse), and it is now a checked bound rather than a
 * surprise.
 *
 * `maxDocumentBytes` — the trusted side's ceiling on one document's whole
 * encoded state. Independent of the per-call bound above, because a document may
 * legitimately grow past what a single `open_doc` can carry; when it does, this
 * contract's answer is `doc_too_large` and the fix is a streamed open
 * (`resource-stream/v1`, which design doc §15.4 already names), not a bigger
 * number here.
 *
 * 2026-10-20: that fix is `crdt-doc/v2` (`contract-v2.ts`), which streams an
 * answer and parts a push, so the trusted store no longer applies this number
 * by default. v1 keeps its per-call window and answers `doc_too_large` past it;
 * the figure stays exported only because v1's frozen limit table includes it.
 */
export const CRDT_DOC_LIMITS = Object.freeze({
  /** An opaque document ref. Bounded at what `ResourceLink.ref` allows. */
  maxDocRefLength: 200,
  /** Documents one scope may hold. A trusted composition input, not a page. */
  maxDocs: 32,
  /** Display title of one document. Presentation text, never an identifier. */
  maxTitleLength: 120,
  /** Base64 characters of one update. */
  maxUpdateEncodedLength: 64 * 1024,
  /** Base64 characters of one state vector. */
  maxStateVectorEncodedLength: 4 * 1024,
  /** Decoded bytes of one update. Derived, so the two cannot drift. */
  maxUpdateBytes: Math.floor(((64 * 1024) / 4) * 3),
  /** Decoded bytes of one state vector. */
  maxStateVectorBytes: Math.floor(((4 * 1024) / 4) * 3),
  /** One document's whole encoded state, on the trusted side. */
  maxDocumentBytes: 1024 * 1024,
  /** Refusal text: written for a person, and it ends up in a log. */
  maxMessageLength: 200,
});

/**
 * Every way this port can say no.
 *
 * All of them RESOLVE. "Nobody has agreed to let this App edit documents",
 * "that document has outgrown what one call can carry" and "that update did not
 * decode" are answers a person needs to read, not exceptions a component has to
 * catch.
 *
 * The three that are specific to this contract:
 *
 *  · `unknown_doc` — the ref was never minted here, belongs to another scope, or
 *    the scope has forgotten it. One refusal for all three, because a vault
 *    lookup that misses cannot tell them apart and should not try.
 *  · `bad_update` — the bytes arrived but are not a CRDT update this document
 *    can merge. Distinct from `invalid_request` (which is about the proposal's
 *    shape) because they have different fixes: one is a caller bug, the other is
 *    usually a version or corruption problem.
 *  · `doc_too_large` — the document exceeds what this contract can carry or
 *    store. NEVER a silent truncation; see `maxUpdateEncodedLength`.
 */
export const CRDT_DOC_REFUSALS = refusalVocabulary(
  [
    /** The document store is unreachable, or it failed. The fallback. */
    "unavailable",
    /** The trusted side declined. Policy, not a fault. */
    "refused",
    /** No such document in this scope. Forged, foreign or forgotten. */
    "unknown_doc",
    /** The bytes are not an update this document can merge. */
    "bad_update",
    /** The document, or this update, exceeds a declared bound. */
    "doc_too_large",
    /** A human has to approve this first. */
    "approval_required",
    /** No authority is bound for this contract, or not for this action. */
    "no_authority",
    /** The instance this port belonged to has ended. */
    "scope_closed",
    /** The request itself was malformed. */
    "invalid_request",
    /** Too many updates too quickly. Later, not never. */
    "rate_limited",
  ],
  { fallback: "unavailable", maxMessageLength: CRDT_DOC_LIMITS.maxMessageLength },
);

export type CrdtDocRefusalCode = (typeof CRDT_DOC_REFUSALS.codes)[number];

/**
 * Standard base64, anchored.
 *
 * Not base64url: the encoding an update travels in is decided once, here, and
 * two spellings of the same bytes would make "the same update twice" fail to
 * look the same — which is exactly the property an idempotent CRDT merge relies
 * on being able to observe cheaply. Length-mod-4 is checked by the reader
 * because a pattern cannot express it.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const DOC = Object.freeze({
  type: "string" as const,
  description: "文档引用：由可信侧铸出、只对它有意义的不透明串。不是路径、不是文件名、不是数据库 id。",
  maxLength: CRDT_DOC_LIMITS.maxDocRefLength,
  pattern: ID_PATTERNS.resourceRef,
});

/**
 * The declaration. One source; the MCP face, the trusted-side decoder and the
 * conformance harness are all derived from it.
 */
export const CRDT_DOC_DECLARATION = declareContract({
  contract: CRDT_DOC_CONTRACT,
  summary:
    "读写 CRDT 协作文档：枚举这个视图被授予的文档、取回全量状态、推送一条本地 update、"
    + "按状态向量取增量。它说不出文档存在哪里，也够不到没有授予它的文档。",
  refusals: CRDT_DOC_REFUSALS,
  actions: {
    /**
     * The bootstrap verb, added 2026-08-10 alongside the first real App.
     *
     * P6c deliberately shipped no enumeration action, reasoning that a consumer
     * only ever holds refs it was handed — and then nothing in any App could do
     * the handing, because every other action requires a ref and a scope's refs
     * are minted inside the provider. `workspace-files/v1` answers the same
     * bootstrap with `refresh_roots`, and this is that answer here.
     *
     * What it discloses is exactly the set the trusted grant seam already
     * decided this scope may reach (`documentsFor(owner)`), with display
     * titles — not an inventory of anything beyond the scope. It spends
     * `read_document`, the same token every other read spends.
     */
    list_docs: {
      summary: "枚举这个视图被授予的协作文档（引用与显示标题）",
      operation: "read_document",
      params: {},
    },
    open_doc: {
      summary: "取回一份文档的当前全量状态（一条 update）与状态向量",
      operation: "read_document",
      params: { doc: DOC },
    },
    apply_update: {
      summary: "把一条本地产生的 update 合并进文档",
      operation: "edit_document",
      params: {
        doc: DOC,
        update: {
          type: "string",
          description: `一条 CRDT update 的 base64 编码，最多 ${CRDT_DOC_LIMITS.maxUpdateEncodedLength} 个字符（约 ${CRDT_DOC_LIMITS.maxUpdateBytes} 字节）。`,
          maxLength: CRDT_DOC_LIMITS.maxUpdateEncodedLength,
          pattern: BASE64,
        },
      },
    },
    read_updates: {
      summary: "取回自某个状态向量以来的增量",
      operation: "read_document",
      params: {
        doc: DOC,
        since: {
          type: "string",
          description: `调用方已持有的状态向量的 base64 编码，最多 ${CRDT_DOC_LIMITS.maxStateVectorEncodedLength} 个字符。`,
          maxLength: CRDT_DOC_LIMITS.maxStateVectorEncodedLength,
          pattern: BASE64,
        },
      },
    },
  },
});

export type CrdtDocActionId = (typeof CRDT_DOC_DECLARATION.actionIds)[number];

/** Which permission token each action spends. Derived, not written twice. */
export const CRDT_DOC_OPERATIONS: readonly string[] = CRDT_DOC_DECLARATION.operations;

/** The token `open_doc` and `read_updates` spend. */
export const CRDT_READ_OPERATION = "read_document";
/** The token `apply_update` spends. Not implied by the one above. */
export const CRDT_EDIT_OPERATION = "edit_document";

/** Whether a string is well-formed standard base64 of a bounded length. */
export function isBase64(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length > maxLength) return false;
  // A pattern cannot express "a multiple of four", and a base64 string whose
  // length is not is one a decoder will either reject or silently round — the
  // second of which produces bytes nobody sent.
  if (value.length % 4 !== 0) return false;
  return BASE64.test(value);
}
