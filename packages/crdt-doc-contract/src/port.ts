/**
 * The narrow surface a `crdt-doc/v1` consumer is written against.
 *
 * Three named methods, and the reason it is three named methods rather than one
 * `call(action, params)` is the reason every port in this family gives: a single
 * generic method is how a component ends up naming an operation the App never
 * meant to expose. What a consumer may ask for IS this interface.
 *
 * Every method resolves. "Nobody has agreed to let this App edit documents",
 * "that update did not decode" and "you are sending too fast" are all answers a
 * person should be shown, not exceptions a component must catch — and a thrown
 * error is the one thing on this path that reliably carries an internal
 * identifier across the boundary.
 *
 * ── What is deliberately absent, and what that costs ───────────────────────
 *
 * There is no `subscribe`, no `follow`, no callback, no event emitter. That is
 * NOT a simplification: a collaborative editor without server push is a
 * collaborative editor with a manual sync button, and this is the central
 * finding of this slice rather than an oversight. The reason it is absent is
 * structural — an Agent View has `connect-src 'none'` and one MessagePort whose
 * only verb is `propose`, so "the server tells you something happened" has no
 * spelling on this side of the boundary. Adding a fourth method here would be
 * declaring a capability the transport cannot deliver.
 *
 * The shape that WOULD work is written down in the worklog: the trusted parent
 * page holds the SSE subscription (it may — it is same-origin and already holds
 * the credential) and forwards a wake-up over the same MessagePort. That is a
 * platform change, not a contract change, which is why nothing is stubbed here.
 *
 * There is also no `createDocument`: it would let an untrusted bundle allocate
 * durable server storage, which is a permission-contract expansion. `listDocs`
 * (2026-08-10) is narrower than the `listDocuments` this header used to refuse:
 * it enumerates exactly the set the trusted grant seam granted this scope, and
 * exists because every other action needs a ref and nothing else could hand a
 * View its first one — see the note on `list_docs` in `contract.ts`.
 */

import type { ContractBound, PortRefusal, PortReply } from "@claude-bot/typed-port-kit";

import { CRDT_DOC_CONTRACT, CRDT_DOC_REFUSALS, type CrdtDocRefusalCode } from "./contract.js";
import type { CRDT_DOC_CONTRACT_V2 } from "./contract-v2.js";
import type { CrdtDocAck, CrdtDocDelta, CrdtDocList, CrdtDocSnapshot } from "./projection.js";

export type CrdtDocReply<T> = PortReply<T, CrdtDocRefusalCode>;
export type CrdtDocRefusal = PortRefusal<CrdtDocRefusalCode>;

/**
 * Either version. v2 carries any document size behind the same four methods,
 * so an editor holds one interface and the binding plan decides the version.
 */
export interface CrdtDocPort extends ContractBound<typeof CRDT_DOC_CONTRACT | typeof CRDT_DOC_CONTRACT_V2> {
  /** The documents this scope was granted, as refs plus display titles. */
  listDocs(): Promise<CrdtDocReply<CrdtDocList>>;
  /** Fetch a document's whole state, as one update, plus its state vector. */
  openDoc(doc: string): Promise<CrdtDocReply<CrdtDocSnapshot>>;
  /** Merge one locally produced update. Idempotent, as CRDT merges are. */
  applyUpdate(doc: string, update: string): Promise<CrdtDocReply<CrdtDocAck>>;
  /** Everything that happened since a state vector the caller already holds. */
  readUpdates(doc: string, since: string): Promise<CrdtDocReply<CrdtDocDelta>>;
}

/** Build a refusal with its text bounded the same way everywhere. */
export function crdtRefusal(code: CrdtDocRefusalCode, message: string): CrdtDocRefusal {
  return CRDT_DOC_REFUSALS.refuse(code, message);
}

/**
 * A port that may look but not write.
 *
 * Not a different interface — the same one, with `applyUpdate` refusing. A
 * consumer that holds `read_document` and not `edit_document` therefore reuses
 * its components unchanged and discovers the limit the way it discovers every
 * other limit: a bounded refusal from the other side. `agent-sessions/v1`'s
 * `READ_ONLY_REFUSAL` and `notify/v1`'s `NOT_AUTHORISED_REFUSAL` are the
 * precedents.
 */
export const READ_ONLY_REFUSAL: CrdtDocRefusal = crdtRefusal(
  "no_authority",
  "这个视图只被授予了读取协作文档，没有被授予写入。",
);

/** Nothing at all is bound for this contract in this scope. */
export const NOT_AUTHORISED_REFUSAL: CrdtDocRefusal = crdtRefusal(
  "no_authority",
  "这个视图没有被授予任何协作文档 operation。",
);
