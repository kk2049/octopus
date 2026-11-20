/**
 * `crdt-doc/v2` over the App's one MessagePort.
 *
 * The port it returns is the SAME `CrdtDocPort` v1's adapter returns: four
 * methods, base64 strings in and out, every method resolving. What this file
 * adds is invisible to an editor and is exactly the two things v1 could not do:
 *
 *  · an answer that arrives as a stream is drained here — chunk by chunk,
 *    through the kit's measuring stream source and the `resource-stream/v1`
 *    guard — and handed up as one update, so "the document is bigger than one
 *    message" is no longer a refusal;
 *  · an update larger than one window is pushed as consecutive parts, each a
 *    padding-free slice of the caller's base64 at a 4-character stride, so no
 *    byte is decoded or re-encoded on the way and the far side merges once.
 *
 * Everything v1's adapter checks still holds: the echo rule on every answer,
 * the contract's own readers, no retries. A part refused midway is the whole
 * push refused — the edit stays in the caller's replica, exactly as a refused
 * v1 push left it, and the next push restarts at offset 0.
 */

import {
  createResourceStream,
  type ResourceStreamRefusalCode,
} from "@claude-bot/resource-stream-contract";
import {
  createRemoteCall,
  createRemoteStreamSource,
  streamRefusalFold,
  type ProposalTransport,
  type RemoteMessages,
  type RemoteStreamMessages,
} from "@claude-bot/typed-port-kit";

import type { CrdtDocRefusalCode } from "./contract.js";
import {
  CRDT_DOC_CONTRACT_V2,
  CRDT_DOC_DECLARATION_V2,
  CRDT_DOC_V2_LIMITS,
  base64ByteLength,
} from "./contract-v2.js";
import { crdtRefusal, type CrdtDocPort, type CrdtDocReply } from "./port.js";
import type { CrdtDocAck, CrdtDocDelta, CrdtDocList, CrdtDocSnapshot } from "./projection.js";
import { readCrdtDocList } from "./projection.js";
import {
  readCrdtDocAckWire,
  readCrdtDocDeltaWire,
  readCrdtDocSnapshotWire,
  readCrdtUpdateChunk,
  type CrdtUpdateChunk,
  type CrdtUpdateStream,
} from "./projection-v2.js";
import type { RemoteCrdtDoc } from "./remote.js";

const MESSAGES: RemoteMessages = {
  noAnswer: "协作文档通道没有作答。",
  malformedAnswer: "协作文档通道给出了无法识别的回复。",
  refusedWithoutReason: "这次协作文档操作没有完成。",
  closed: "这个视图的会话已经结束，请重新打开。",
};

const MALFORMED_SNAPSHOT = "文档快照没有通过公开契约校验。";
const MALFORMED_ACK = "合并回执没有通过公开契约校验。";
const MALFORMED_DELTA = "增量没有通过公开契约校验。";
const MALFORMED_LIST = "文档列表没有通过公开契约校验。";
const MALFORMED_STREAM = "文档分块没有拼成一条完整的 update。";
const WRONG_STAGE = "分段推送的回执与已发送的字节数不一致，本次推送没有完成。";
const WRONG_DOC = "收到的回复不是所请求的那份文档的。";
const ECHO_DOC = [{ field: "doc", param: "doc", message: WRONG_DOC }] as const;

const STREAM_MESSAGES: RemoteStreamMessages = {
  closed: "文档分块读取已经结束。",
  badFrame: "文档分块不是合法的资源流帧。",
  wrongStream: "收到的分块属于另一条资源流。",
  outOfOrder: "文档分块的顺序不一致。",
  badPayload: "文档分块没有通过公开契约校验。",
  sizeMismatch: "文档分块声明的大小与内容不符。",
  chunkTooLarge: "文档分块超过了单块上限。",
  overran: "文档分块超过了声明的总大小。",
  endMismatch: "文档分块的结束帧与已收到的内容不符。",
  truncated: "文档在全部分块到达之前就结束了。",
  refusedWithoutReason: "文档分块读取没有完成。",
};

/** A pull refused at the proposal layer, in the stream's own vocabulary. */
const STREAM_FOLD = streamRefusalFold(
  {
    scope_closed: "expired",
    unknown_doc: "not_found",
    no_authority: "denied",
    approval_required: "denied",
    invalid_request: "protocol",
    doc_too_large: "too_large",
  },
  STREAM_MESSAGES.refusedWithoutReason,
);

/** …and a stream's terminal back in this contract's vocabulary. */
const CRDT_CODE_OF: Readonly<Record<ResourceStreamRefusalCode, CrdtDocRefusalCode>> = {
  closed: "scope_closed",
  cancelled: "scope_closed",
  expired: "scope_closed",
  denied: "no_authority",
  not_found: "unknown_doc",
  too_large: "doc_too_large",
  unsupported: "unavailable",
  unavailable: "unavailable",
  protocol: "unavailable",
};

/**
 * Present a proposal transport as `crdt-doc/v2`.
 *
 * `binding` is the App-local name from its `agent-resource-bindings/v1` plan,
 * exactly as for v1; which contract it resolves to is the trusted side's
 * reading of that plan, not this function's.
 */
export function createRemoteCrdtDocPortV2(transport: ProposalTransport, binding: string): RemoteCrdtDoc {
  const call = createRemoteCall({
    declaration: CRDT_DOC_DECLARATION_V2,
    transport,
    binding,
    invalidRequest: "invalid_request",
    closed: "scope_closed",
    messages: MESSAGES,
  });

  /** Pull one announced update to its end and return its base64, or why not. */
  const drain = async (stream: CrdtUpdateStream): Promise<CrdtDocReply<string>> => {
    const source = createRemoteStreamSource<CrdtUpdateChunk>({
      ask: (action, params) => call.ask(action, params),
      metadata: stream.metadata,
      handle: stream.handle,
      readChunk: (value) => readCrdtUpdateChunk(value),
      measure: (chunk) => base64ByteLength(chunk.data),
      maxChunkBytes: CRDT_DOC_V2_LIMITS.chunkBytes,
      fold: STREAM_FOLD,
      messages: STREAM_MESSAGES,
    });
    const guarded = createResourceStream<CrdtUpdateChunk>(source, { maxChunkBytes: CRDT_DOC_V2_LIMITS.chunkBytes });
    const untrack = call.lifecycle.track(() => void guarded.close());
    const slices: string[] = [];
    try {
      for (;;) {
        const read = await guarded.next();
        if (read.kind === "end") break;
        if (read.kind === "refused") return crdtRefusal(CRDT_CODE_OF[read.code], read.message);
        // Only the final slice may be padded: then the joined slices ARE the
        // base64 of the whole update, and a slice padded mid-stream (a producer
        // that cut at the wrong stride) is refused instead of mis-decoded.
        if (slices.length > 0 && slices[slices.length - 1]!.endsWith("=")) {
          return crdtRefusal("unavailable", MALFORMED_STREAM);
        }
        slices.push(read.value.data);
      }
    } finally {
      untrack();
      await guarded.close();
    }
    return { ok: true, value: slices.join("") };
  };

  const port: CrdtDocPort = {
    contract: CRDT_DOC_CONTRACT_V2,

    async listDocs(): Promise<CrdtDocReply<CrdtDocList>> {
      return call.call({ action: "list_docs", params: {}, read: readCrdtDocList, malformed: MALFORMED_LIST });
    },

    async openDoc(doc: string): Promise<CrdtDocReply<CrdtDocSnapshot>> {
      return call.lifecycle.guard<CrdtDocSnapshot>(async () => {
        const answer = await call.call({
          action: "open_doc",
          params: { doc },
          read: readCrdtDocSnapshotWire,
          malformed: MALFORMED_SNAPSHOT,
          echo: ECHO_DOC,
        });
        if (!answer.ok) return answer;
        const { schemaMajor, stateVector } = answer.value;
        const update = "update" in answer.value ? answer.value.update : await drain(answer.value.stream);
        if (typeof update !== "string" && !update.ok) return update;
        const bytes = typeof update === "string" ? update : update.value;
        return { ok: true, value: { doc: answer.value.doc, schemaMajor, stateVector, update: bytes } };
      });
    },

    async applyUpdate(doc: string, update: string): Promise<CrdtDocReply<CrdtDocAck>> {
      return call.lifecycle.guard<CrdtDocAck>(async () => {
        const window = CRDT_DOC_V2_LIMITS.maxPartEncodedLength;
        if (update.length <= window) {
          const answer = await call.call({
            action: "apply_update",
            params: { doc, update },
            read: readCrdtDocAckWire,
            malformed: MALFORMED_ACK,
            echo: ECHO_DOC,
          });
          if (!answer.ok) return answer;
          if (answer.value.staged !== undefined) return crdtRefusal("unavailable", WRONG_STAGE);
          return { ok: true, value: { doc: answer.value.doc, stateVector: answer.value.stateVector } };
        }
        // Larger than one window: consecutive parts. A string that is not
        // whole base64 quanta cannot be cut on byte boundaries, and the kit
        // would refuse its last part anyway; say so before sending the first.
        if (update.length % 4 !== 0) {
          return crdtRefusal("invalid_request", "update 不是合法的 base64。");
        }
        const total = base64ByteLength(update);
        for (let at = 0; at < update.length; at += window) {
          const part = update.slice(at, at + window);
          const offset = (at / 4) * 3;
          const answer = await call.call({
            action: "apply_update",
            params: { doc, update: part, offset: String(offset), total: String(total) },
            read: readCrdtDocAckWire,
            malformed: MALFORMED_ACK,
            echo: ECHO_DOC,
          });
          if (!answer.ok) return answer;
          const end = offset + base64ByteLength(part);
          if (end < total) {
            if (answer.value.staged !== end) return crdtRefusal("unavailable", WRONG_STAGE);
            continue;
          }
          if (answer.value.staged !== undefined) return crdtRefusal("unavailable", WRONG_STAGE);
          return { ok: true, value: { doc: answer.value.doc, stateVector: answer.value.stateVector } };
        }
        /* c8 ignore next */
        return crdtRefusal("invalid_request", "update 不能为空。");
      });
    },

    async readUpdates(doc: string, since: string): Promise<CrdtDocReply<CrdtDocDelta>> {
      return call.lifecycle.guard<CrdtDocDelta>(async () => {
        const answer = await call.call({
          action: "read_updates",
          params: { doc, since },
          read: readCrdtDocDeltaWire,
          malformed: MALFORMED_DELTA,
          echo: ECHO_DOC,
        });
        if (!answer.ok) return answer;
        const { stateVector, empty } = answer.value;
        const update = "update" in answer.value ? answer.value.update : await drain(answer.value.stream);
        if (typeof update !== "string" && !update.ok) return update;
        const bytes = typeof update === "string" ? update : update.value;
        return { ok: true, value: { doc: answer.value.doc, stateVector, update: bytes, empty } };
      });
    },
  };

  return { port, destroy: () => call.destroy() };
}
