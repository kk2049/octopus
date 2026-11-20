/**
 * `@claude-bot/crdt-doc-contract` — the `crdt-doc/v1` ABI.
 *
 * List the documents a scope was granted, pull one document's state, push one
 * update back, ask for the diff since a state vector you already have. Four
 * actions, two permission tokens, no presence, no push.
 *
 * ── What is NOT here ───────────────────────────────────────────────────────
 *
 * **No CRDT.** Nothing in this package merges anything: it moves opaque base64
 * between two halves that each hold a real CRDT library. Writing one is
 * explicitly out of bounds (design doc §12), and the audited implementation
 * lives in the trusted process where the document's authority already is.
 *
 * **No provider, no bot-side wiring, no storage.** A provider satisfying this
 * contract is trusted code in `packages/bot`, written by a deployer and reviewed
 * and deployed like every other platform capability.
 *
 * **A remote adapter, as of 2026-08-09 — and the delay is the story.** This
 * package shipped without one, because two of its three actions declared
 * parameters the View wire's flat 512-character bound could not carry and
 * `createRemoteCall` refused to construct a port. `wire.test.ts` was left as a
 * tripwire: "the day per-action bounds land (convergence plan sideline 6, P6b)
 * the test fails and tells whoever is holding it that an adapter is now
 * possible." P6b landed, the tripwire fired, and `remote.ts` is the answer to
 * it. Nothing about the contract was widened to make this happen — the numbers
 * it always declared are now numbers the wire can be told about.
 *
 * Its one dependency is `@claude-bot/typed-port-kit`, which itself depends only
 * on two other dependency-free contract packages. No React, no DOM, no Node, no
 * transport, and nothing that knows what a capability or an owner is.
 */

export {
  CRDT_DOC_CONTRACT,
  CRDT_DOC_DECLARATION,
  CRDT_DOC_LIMITS,
  CRDT_DOC_OPERATIONS,
  CRDT_DOC_REFUSALS,
  CRDT_EDIT_OPERATION,
  CRDT_NOTE_RESOURCE_KIND,
  CRDT_READ_OPERATION,
  isBase64,
  type CrdtDocActionId,
  type CrdtDocRefusalCode,
} from "./contract.js";

export {
  CRDT_SCHEMA_MAJOR,
  readCrdtDocAck,
  readCrdtDocDelta,
  readCrdtDocList,
  readCrdtDocSnapshot,
  type CrdtDocAck,
  type CrdtDocDelta,
  type CrdtDocEntry,
  type CrdtDocList,
  type CrdtDocSnapshot,
} from "./projection.js";

export {
  NOT_AUTHORISED_REFUSAL,
  READ_ONLY_REFUSAL,
  crdtRefusal,
  type CrdtDocPort,
  type CrdtDocRefusal,
  type CrdtDocReply,
} from "./port.js";

export { crdtActionOf, crdtActionOfV2, decodeCrdtParams } from "./decode.js";

export { createRemoteCrdtDocPort, type RemoteCrdtDoc } from "./remote.js";

export {
  CRDT_DOC_CONTRACT_V2,
  CRDT_DOC_DECLARATION_V2,
  CRDT_DOC_V2_LIMITS,
  CRDT_UPDATE_CHUNK_PAYLOAD,
  CRDT_UPDATE_MEDIA_TYPE,
  base64ByteLength,
  type CrdtDocActionIdV2,
} from "./contract-v2.js";

export {
  readCrdtDocAckWire,
  readCrdtDocDeltaWire,
  readCrdtDocSnapshotWire,
  readCrdtUpdateChunk,
  type CrdtDocAckWire,
  type CrdtDocDeltaWire,
  type CrdtDocSnapshotWire,
  type CrdtUpdateCarrier,
  type CrdtUpdateChunk,
  type CrdtUpdateStream,
} from "./projection-v2.js";

export { createRemoteCrdtDocPortV2 } from "./remote-v2.js";
