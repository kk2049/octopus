/**
 * `@claude-bot/typed-port-kit` — the machine that makes typed ports.
 *
 * ── What a typed port is ───────────────────────────────────────────────────
 *
 * A narrow interface of NAMED methods that a module or an App is written
 * against, whose implementation may be a MessagePort to a trusted coordinator,
 * an in-memory fixture, or a provider inside the trusted process — and which has
 * no method that would let a consumer find out which. Three exist today
 * (`agent-sessions/v1`, `workspace-files/v1`, and `resource-stream/v1` as their
 * shared streaming half), and building the third one cost about a thousand lines
 * of which perhaps two hundred were the contract and the rest were machinery.
 *
 * This package is that machinery, extracted. The target the convergence plan
 * (decision 5) sets is a new port at roughly 200 lines of declaration.
 *
 * ── What is here ───────────────────────────────────────────────────────────
 *
 *   reply.ts        one reply shape, generic over a closed refusal code set
 *   refusals.ts     declaring that closed set, and folding into it
 *   declaration.ts  the contract as data — the single source both faces derive from
 *   wire.ts         the transport constants a proposal is bounded by
 *   params.ts       declaration → flat wire strings, and back
 *   arrival.ts      the checks an answer is re-validated by
 *   remote.ts       "declaration + transport → a call that runs those checks"
 *   stream.ts       the `resource-stream/v1` verbs, with the accounting
 *   mcp.ts          declaration → MCP tool JSON, as pure data
 *
 * `./testing` has the conformance harness and a transport that lies. It is a
 * separate entry so a production bundle cannot pick it up by reaching for the
 * obvious import.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * Not a runtime framework. Nothing here starts, schedules, retries, caches,
 * subscribes or holds global state; the only stateful object is one
 * `PortLifecycle`, and the App owns it. A port composes the pieces it needs and a
 * reviewer can see which ones it did not.
 *
 * It also contains no identity of any kind. There is no owner, no username, no
 * app or scope id, no instance handle, no grant, no capability, no context id, no
 * canonical path, no cookie, no URL — not filtered, ABSENT. A helper that
 * returned one could only invent it.
 *
 * ── Its dependencies, and why exactly these ────────────────────────────────
 *
 * Zero third-party packages, and two workspace ones — the same two
 * `@claude-bot/workspace-files-contract` already has, which is the port this kit
 * was extracted from:
 *
 *  · `@claude-bot/resource-stream-contract` for the streaming ABI, the refusal
 *    machinery (`IssueBag` and friends) and the issue vocabulary. Copying those
 *    would make a THIRD implementation of a validator whose header already
 *    explains why there are two; this repository has documented evidence about
 *    what happens next (`.claude/rules/dev-conventions.md` names the browser
 *    trust rules, which drifted in five places).
 *  · `@claude-bot/agent-module-contract` for the identifier grammars. A contract
 *    id that this kit accepted and a binding plan rejected would be a port
 *    nothing could be wired to, so there is one grammar and it lives with the
 *    document that references it.
 *
 * Both are themselves dependency-free, so the closure stays free of React, DOM,
 * Node, the Bot, and anything that knows what a capability is.
 */

export {
  REPLY_LIMITS,
  boundedMessage,
  isRefusal,
  portRefusal,
  portValue,
  type PortRefusal,
  type PortReply,
  type PortValue,
} from "./reply.js";

export {
  foldRefusalInto,
  isRefusalCode,
  refusalVocabulary,
  type RefusalVocabulary,
  type RefusalVocabularyOptions,
} from "./refusals.js";

export {
  declareContract,
  wireServiceableActions,
  wireValueLimit,
  type ContractBound,
  type ContractDeclaration,
  type DeclareContractInput,
  type JsonSchemaFragment,
  type PortActionDeclaration,
  type PortActionSpec,
  type PortField,
  type PortFieldType,
} from "./declaration.js";

export {
  RESERVED_PARAMS,
  RESOURCE_ACTION_PREFIX,
  STREAM_CLOSE_ACTION,
  STREAM_PULL_ACTION,
  WIRE_PARAM_LIMITS,
  isWireParamKey,
  wireActionOf,
} from "./wire.js";

export { actionOf, canonicalJson, decodeWireParams, encodeWireParams } from "./params.js";

export {
  corroborate,
  echoMatches,
  portLifecycle,
  readProposalAnswer,
  transportFailure,
  type Corroboration,
  type PortLifecycle,
  type ProposalAnswer,
} from "./arrival.js";

export {
  createRemoteCall,
  type EchoRule,
  type ProposalTransport,
  type RemoteCall,
  type RemoteCallOptions,
  type RemoteCallRequest,
  type RemoteMessages,
} from "./remote.js";

export {
  STREAM_REFUSALS,
  createRemoteStreamSource,
  streamRefusalFold,
  type RemoteStreamMessages,
  type RemoteStreamOptions,
  type StreamRefusalFold,
} from "./stream.js";

export {
  mcpErrorOf,
  mcpToolsOf,
  type McpDerivationOptions,
  type McpInputSchema,
  type McpToolDefinition,
} from "./mcp.js";

/**
 * Re-exported so a contract package built on this kit imports ONE package.
 *
 * A contract's own readers are written with these — that is the pattern every
 * existing reader in this family uses — and making an author remember which of
 * two packages a given helper lives in is exactly the kind of friction that ends
 * with a fourth copy of `IssueBag`.
 */
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
} from "@claude-bot/resource-stream-contract";

/**
 * The identifier grammars, for the same reason.
 *
 * An opaque ref minted by a trusted side is the standard currency of these
 * contracts, and `resourceRef` is the grammar an `open-resource/v1` link already
 * has to satisfy. A contract that wrote its own copy would be declaring a ref it
 * can mint and a layout cannot carry.
 */
export { ID_PATTERNS, isContractId, isResourceKind, isResourceRef } from "@claude-bot/agent-module-contract";
