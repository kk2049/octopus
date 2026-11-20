/**
 * `crdt-doc/v2` — the same four verbs as v1, with no ceiling on a document.
 *
 * ── What v1 got wrong, precisely ───────────────────────────────────────────
 *
 * v1 carried a whole document as ONE update in ONE answer, and a whole local
 * diff as ONE update in ONE proposal. Both are per-call windows (64 KiB of
 * base64), but each was also the only way to move that value — so the window
 * became the document's total size ("这份文档已经超过一次读取能承载的大小") and the
 * total of a person's unsynced work. A paste past the window could never be
 * pushed, and kept every later edit in the same replica from being pushed too.
 *
 * ── What v2 changes, and only that ─────────────────────────────────────────
 *
 * The window stays; the value is cut to fit it, in both directions:
 *
 *  · **Down.** `open_doc` and `read_updates` answer inline exactly as v1 did
 *    when the update fits one window. Otherwise the answer carries a
 *    `resource-stream/v1` open frame instead of `update`, and the consumer pulls
 *    the bytes chunk by chunk (`resource.stream_pull`), each chunk a bounded
 *    base64 slice. Exactly one of `update` / `stream` is present.
 *  · **Up.** `apply_update` accepts the whole update as before, or a PART of it:
 *    `offset` and `total` (decimal bytes) address the part inside the update.
 *    The trusted side stages parts in order and merges once, when the last one
 *    arrives — validate, append, apply, reply, as for any update. A part that
 *    restarts at 0 discards an unfinished upload; any other gap is refused.
 *
 * Parts and chunks are cut at multiples of three bytes, so each slice's base64
 * is padding-free and the slices concatenate to the base64 of the whole without
 * either side decoding anything it does not have to.
 *
 * ── What did not change ────────────────────────────────────────────────────
 *
 * The verbs, both permission tokens and what each spends, the refusal
 * vocabulary, the echo rule and the schema major. A stream pull continues a read
 * the Gate already allowed; a part is staged only inside the edit lease. So a
 * release may bind v2 under the SAME permission contract it bound v1 under —
 * nothing a person consented to grows.
 */

import { WIRE_PARAM_LIMITS, declareContract } from "@claude-bot/typed-port-kit";

import { CRDT_DOC_DECLARATION, CRDT_DOC_REFUSALS } from "./contract.js";

export const CRDT_DOC_CONTRACT_V2 = "crdt-doc/v2";

/**
 * Windows, not totals. Every number here bounds one message; none of them
 * bounds a document, a diff, or an upload.
 */
export const CRDT_DOC_V2_LIMITS = Object.freeze({
  /**
   * Base64 characters of one update part pushed, or of one update answered
   * inline. A multiple of 4, so a slice of a padding-free base64 string at this
   * stride is itself well-formed base64.
   */
  maxPartEncodedLength: 256 * 1024,
  /** Decoded bytes of one part. A multiple of 3; derived so the two cannot drift. */
  maxPartBytes: ((256 * 1024) / 4) * 3,
  /** Decoded bytes of one stream chunk. Same stride as a part, under the stream's chunk cap. */
  chunkBytes: ((256 * 1024) / 4) * 3,
  /**
   * Base64 characters of one state vector — a single value that grows with the
   * number of distinct writers, so it gets the wire's one oversized slot
   * (≈ 39 000 client ids) rather than v1's 4 KiB (≈ 300).
   */
  maxStateVectorEncodedLength: WIRE_PARAM_LIMITS.maxDeclaredValueLength,
  /** Decimal digits of a byte offset or total: any length a safe integer can name. */
  maxOffsetDigits: 15,
});

/** A byte count, in the one spelling both sides compare. */
const BYTE_COUNT = /^(?:0|[1-9][0-9]{0,14})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const v1 = CRDT_DOC_DECLARATION.byAction;

const COUNT_FIELD = (description: string) => Object.freeze({
  type: "string" as const,
  description,
  maxLength: CRDT_DOC_V2_LIMITS.maxOffsetDigits,
  pattern: BYTE_COUNT,
  optional: true as const,
});

export const CRDT_DOC_DECLARATION_V2 = declareContract({
  contract: CRDT_DOC_CONTRACT_V2,
  summary:
    "读写 CRDT 协作文档（不限文档大小）：枚举被授予的文档、取回全量状态（超过一个窗口时以资源流分块取回）、"
    + "推送一条本地 update（超过一个窗口时按字节偏移分段推送）、按状态向量取增量。",
  refusals: CRDT_DOC_REFUSALS,
  actions: {
    list_docs: { summary: v1.list_docs.summary, operation: v1.list_docs.operation, params: v1.list_docs.params },
    open_doc: {
      summary: "取回一份文档的当前全量状态与状态向量；超过一个窗口时答复一条资源流",
      operation: v1.open_doc.operation,
      params: v1.open_doc.params,
    },
    apply_update: {
      summary: "把一条本地 update（或它按字节偏移切出的一段）合并进文档；最后一段到达时整体合并",
      operation: v1.apply_update.operation,
      params: {
        doc: v1.apply_update.params.doc,
        update: {
          type: "string",
          description:
            `一条 CRDT update 或它的一段的 base64 编码，最多 ${CRDT_DOC_V2_LIMITS.maxPartEncodedLength} 个字符`
            + `（${CRDT_DOC_V2_LIMITS.maxPartBytes} 字节）。整条 update 的大小不受此限制。`,
          maxLength: CRDT_DOC_V2_LIMITS.maxPartEncodedLength,
          pattern: BASE64,
        },
        offset: COUNT_FIELD("分段推送时，这一段在整条 update 中的字节偏移（十进制）；与 total 同时出现。"),
        total: COUNT_FIELD("分段推送时，整条 update 的字节数（十进制）；与 offset 同时出现。"),
      },
    },
    read_updates: {
      summary: v1.read_updates.summary,
      operation: v1.read_updates.operation,
      params: {
        doc: v1.read_updates.params.doc,
        since: {
          type: "string",
          description: `调用方已持有的状态向量的 base64 编码，最多 ${CRDT_DOC_V2_LIMITS.maxStateVectorEncodedLength} 个字符。`,
          maxLength: CRDT_DOC_V2_LIMITS.maxStateVectorEncodedLength,
          pattern: BASE64,
        },
      },
    },
  },
});

export type CrdtDocActionIdV2 = (typeof CRDT_DOC_DECLARATION_V2.actionIds)[number];

/** `resource-stream/v1` payload id for one slice of an update. */
export const CRDT_UPDATE_CHUNK_PAYLOAD = `${CRDT_DOC_CONTRACT_V2}#update-chunk`;
/** Media type a streamed update announces. Opaque bytes to everyone but Yjs. */
export const CRDT_UPDATE_MEDIA_TYPE = "application/octet-stream";

/**
 * Decoded byte length of well-formed base64, by arithmetic. Callers have
 * already checked the grammar; this never decodes.
 */
export function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
