/**
 * `@claude-bot/resource-stream-contract` — the `resource-stream/v1` ABI.
 *
 * One bounded, pull-based, cancellable read, defined so that a Node producer
 * holding a file handle and a sandboxed bundle behind a MessagePort can agree
 * about it without either of them importing the other's runtime.
 *
 * What is here: the semantics (`stream.ts`), the JSON framing a transport
 * adapter carries (`envelope.ts`), the constants both sides bound themselves by
 * (`limits.ts`), and the minimal in-memory source every conformance test needs
 * (`testing.ts`).
 *
 * What is NOT here, and cannot be added without changing what this package is:
 * React, DOM, Node, the Bot, a transport, or anything that knows what a
 * capability or an owner is. It has NO dependencies at all — see `issues.ts` for
 * why the refusal machinery is defined here rather than imported from
 * `@claude-bot/agent-module-contract`, which keeps its copy internal.
 */

export {
  RESOURCE_STREAM_CONTRACT,
  RESOURCE_STREAM_LIMITS,
  RESOURCE_STREAM_REFUSALS,
  isResourceDigest,
  isResourceStreamHandle,
  isResourceStreamRefusalCode,
  type ResourceStreamRefusalCode,
} from "./limits.js";

export {
  createResourceStream,
  type ResourceStream,
  type ResourceStreamCaps,
  type ResourceStreamMetadata,
  type ResourceStreamPull,
  type ResourceStreamRead,
  type ResourceStreamSource,
} from "./stream.js";

export {
  IssueBag,
  booleanAt,
  boundedIntAt,
  boundedStringAt,
  objectAt,
  refuseUnknownFields,
  type ContractIssue,
  type ContractIssueCode,
  type ContractResult,
} from "./issues.js";

export {
  readResourceStreamMetadata,
  readResourceStreamRequest,
  readResourceStreamResponse,
  type ResourceStreamChunkFrame,
  type ResourceStreamCloseFrame,
  type ResourceStreamEndFrame,
  type ResourceStreamOpenFrame,
  type ResourceStreamPullFrame,
  type ResourceStreamRefusedFrame,
  type ResourceStreamRequestFrame,
  type ResourceStreamResponseFrame,
} from "./envelope.js";

export {
  drainResourceStream,
  memoryResourceStreamSource,
  type DrainedResourceStream,
  type MemoryResourceStreamSource,
} from "./testing.js";
