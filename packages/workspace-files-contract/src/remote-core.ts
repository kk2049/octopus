/**
 * `workspace-files` over somebody else's transport — the half both versions share.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * v2 differs from v1 in one optional field on two of the answers. Everything
 * else — the action vocabulary, the echo checks, the stream accounting, the
 * "every method resolves" promise, the destroy semantics — is the same code, and
 * it is the part that took the failure modes to get right. A copy of it for v2
 * would be a copy that drifts, and the drift would be silent in exactly the
 * places (an unchecked `end` frame, a believed byte count) where being wrong
 * produces a plausible-looking truncated file.
 *
 * So the version-specific part is a `dialect`: a contract id and two readers.
 * `remote.ts` and `remote-v2.ts` are thin wrappers that name one, and v1's
 * public factory keeps the signature it always had — a version parameter on it
 * would make every existing caller a caller that could have asked for something
 * else.
 *
 * ── Why this reuses the App's ONE channel ──────────────────────────────────
 *
 * An Agent View has exactly one MessagePort, transferred once by the trusted
 * shell after a handshake that compares the sender. A second port for resources
 * would mean a second handshake, a second generation to keep in step, a second
 * thing to close on teardown — and every one of those is a place where a stale
 * channel keeps answering. So a resource read is an ordinary `propose(action,
 * params)` on the channel that already exists, and `session-plus/2` does not
 * move.
 *
 * `ProposalTransport` below is the smallest shape that supports it. It is
 * declared here rather than imported so this package keeps its promise of
 * knowing nothing about React, the Host, or who is logged in; the Agent View
 * client satisfies it structurally.
 *
 * ── What a module sees, and what it does not ───────────────────────────────
 *
 * A module holds a `WorkspaceFilesPort`: four named methods. It never sees an
 * action string, a binding name, a stream handle or a sequence number — those
 * are this file's private vocabulary. That is the same reason `agent-sessions/v1`
 * has named methods rather than `call(action, params)`: a generic method is how
 * a component ends up naming an operation the App never meant to expose.
 *
 * ── This client writes ─────────────────────────────────────────────────────
 *
 * P6a left `replaceText` out because a proposal parameter carried 512
 * characters and a file body does not fit in one; it wrote the incompatibility
 * down (`wireProblems`) rather than declaring a bound that would have truncated
 * an edit. The editor batch made the WIRE decision it named: a contract may
 * declare ONE parameter of one action larger, up to 384 KiB, and the trusted
 * dispatcher reads the bound out of the declaration it compiled in
 * (`WIRE_PARAM_LIMITS.maxDeclaredValueLength`; `PORT_MESSAGE_BYTES` rose to 512
 * KiB to carry it). No staged upload, no second channel, and `session-plus/2`
 * does not move.
 *
 * So `workspaceFilesCanWrite(port)` is true for an Agent View — which is a
 * statement about the TRANSPORT and nothing else. Whether this scope may write
 * is still the Gate's answer, and it arrives as `read_only`,
 * `approval_required` or `digest_mismatch` like any other refusal.
 *
 * ── Why every answer is validated again on arrival ─────────────────────────
 *
 * Because "the other side is our own code" stops being true one release later,
 * and because a transport is a place where a value can be edited. Two checks are
 * worth naming:
 *
 *  · **A chunk's `bytes` is re-measured, never believed.** The in-process guard
 *    in `resource-stream/v1` validates the size a producer STATES, which is
 *    enough when the producer is trusted code in the same process. Across a
 *    transport it is not: an understated count would let a stream carry more
 *    than its cap while the accounting said otherwise. So the measured UTF-8
 *    length is what the guard is given, and a frame whose claim disagrees with
 *    its own payload is a `protocol` termination.
 *  · **A handle is compared, never parsed.** It names something the producer is
 *    holding; the only operation performed on it here is equality.
 *
 * Every termination is one termination, and it closes the remote stream on the
 * way out — best effort, because by then there may be nobody listening.
 */

import { encodeWireParams } from "@claude-bot/typed-port-kit";
import { RESOURCE_RESOLVE_FILE_LINK_ACTION, workspaceFileLinkProblem, readWorkspaceResolvedFileLink,
  type WorkspaceFileLink, type WorkspaceResolvedFileLink } from "./file-link.js";
import {
  RESOURCE_STREAM_LIMITS,
  createResourceStream,
  readResourceStreamResponse,
  type ResourceStream,
  type ResourceStreamMetadata,
  type ResourceStreamPull,
  type ResourceStreamRefusalCode,
  type ResourceStreamSource,
  type ContractResult,
  IssueBag,
  objectAt,
  refuseUnknownFields,
} from "@claude-bot/resource-stream-contract";
import {
  WORKSPACE_FILES_ACTIONS,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_TEXT_CHUNK_PAYLOAD,
  WORKSPACE_TEXT_MEDIA_TYPE,
  isWorkspaceFilesRefusalCode,
  type WorkspaceFilesRefusalCode,
} from "./limits.js";
import {
  readWorkspaceTextChunk,
  readWorkspaceTextDocument,
  utf8ByteLength,
  type WorkspaceFilesDirectory,
  type WorkspaceFilesRoots,
  type WorkspaceTextChunk,
  type WorkspaceTextDocument,
} from "./projection.js";
import {
  workspaceFilesRefusal,
  type WorkspaceFilesReply,
  type WorkspaceTextOpen,
} from "./port.js";
import {
  RESOLVE_PATH_PARAM,
  RESOURCE_RESOLVE_PATH_ACTION,
  readWorkspaceResolvedEntry,
  workspaceResolveLabelsProblem,
  type WorkspaceResolvedEntry,
} from "./resolve.js";
import {
  WORKSPACE_FILES_DECLARATION,
  readWorkspaceMutationReceipt,
  type WorkspaceMutationReceipt,
  type WorkspaceReplaceTextInput,
} from "./write.js";
import {
  RESOURCE_PAGE_PARAM,
  compareWorkspaceListPositions,
  readWorkspaceListCursor,
} from "./paging.js";
import {
  readWorkspaceTextUpload,
  replaceWorkspaceTextInWindows,
  type WorkspaceTextUpload,
} from "./upload.js";
import {
  WORKSPACE_MEDIA_ACTION,
  WORKSPACE_MEDIA_CHUNK_PAYLOAD,
  WORKSPACE_MEDIA_LIMITS,
  base64ByteLength,
  isWorkspaceMediaType,
  readWorkspaceMediaChunk,
  readWorkspaceMediaDocument,
  workspaceMediaRefusal,
  type WorkspaceMediaChunk,
  type WorkspaceMediaDocument,
  type WorkspaceMediaOpen,
  type WorkspaceMediaReply,
} from "./media.js";
import {
  WORKSPACE_DOWNLOAD_ACTION,
  WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
  WORKSPACE_DOWNLOAD_LIMITS,
  WORKSPACE_DOWNLOAD_MEDIA_TYPE,
  readWorkspaceDownloadChunk,
  readWorkspaceDownloadDocument,
  workspaceDownloadRefusal,
  type WorkspaceDownloadChunk,
  type WorkspaceDownloadDocument,
  type WorkspaceDownloadOpen,
  type WorkspaceDownloadReply,
} from "./download.js";

/**
 * The Host's answer to one proposal, as the Agent View client publishes it.
 *
 * Structural rather than imported: this package does not depend on the browser
 * runtime, and a transport that is not that runtime (a test, a Node consumer)
 * satisfies the same shape.
 */
export interface ProposalAnswer {
  ok: boolean;
  code?: string;
  result?: unknown;
  /** Bounded refusal text the Host wrote, or "" when it accepted. */
  message: string;
}

/** The one method a resource port needs from an App's transport. */
export interface ProposalTransport {
  propose(action: string, params?: Record<string, string>): Promise<ProposalAnswer>;
}

/**
 * The action ids a resource proposal uses.
 *
 * They are prefixed so they cannot collide with an App's own vocabulary, and
 * they do NOT name a contract: the trusted dispatcher resolves the contract from
 * the binding in the App's resource plan, which is a document it holds and the
 * View cannot edit. An action string is therefore a verb and nothing else — and
 * it is why v2 needs no new action ids: the same verbs, resolved through a
 * binding that names a different contract.
 *
 * The first four mirror `WORKSPACE_FILES_ACTIONS` one for one. The last two are
 * the `resource-stream/v1` verbs, which live in this set because the stream they
 * drive is opened by `open_text` — a provider's closed action set is what the
 * dispatcher checks, and a stream verb that belonged to no provider would need a
 * second dispatch path with its own scoping story.
 */
export const RESOURCE_ACTIONS = Object.freeze({
  refreshRoots: `resource.${WORKSPACE_FILES_ACTIONS[0]}`,
  listDirectory: `resource.${WORKSPACE_FILES_ACTIONS[1]}`,
  openText: `resource.${WORKSPACE_FILES_ACTIONS[2]}`,
  replaceText: `resource.${WORKSPACE_FILES_ACTIONS[3]}`,
  streamPull: "resource.stream_pull",
  streamClose: "resource.stream_close",
} as const);

/** v3's media verb stays outside v1's frozen six-action public surface. */
export const RESOURCE_OPEN_MEDIA_ACTION = `resource.${WORKSPACE_MEDIA_ACTION}`;
/** v4's explicit download verb stays outside every older version's closed set. */
export const RESOURCE_DOWNLOAD_FILE_ACTION = `resource.${WORKSPACE_DOWNLOAD_ACTION}`;

/** Parameter names, so a client and a dispatcher agree without a second literal. */
export const RESOURCE_PARAMS = Object.freeze({
  binding: "binding",
  ref: "ref",
  handle: "handle",
  seq: "seq",
  expectedDigest: "expected_digest",
  text: "text",
} as const);

/**
 * Every action a workspace-files provider serves. A closed set, shared by both
 * contract versions because the verbs are the same ones.
 */
export const WORKSPACE_FILES_PROPOSAL_ACTIONS: readonly string[] = Object.freeze([
  RESOURCE_ACTIONS.refreshRoots,
  RESOURCE_ACTIONS.listDirectory,
  RESOURCE_ACTIONS.openText,
  RESOURCE_ACTIONS.replaceText,
  RESOURCE_ACTIONS.streamPull,
  RESOURCE_ACTIONS.streamClose,
]);

/** What `open_text` answers with: the header, and how to reach the bytes. */
export interface WorkspaceTextOpenPayload {
  document: WorkspaceTextDocument;
  stream: { handle: string; metadata: ResourceStreamMetadata };
}

const OPEN_PAYLOAD_FIELDS = ["document", "stream"] as const;

/**
 * Read an `open_text` payload.
 *
 * The stream half goes through `readResourceStreamResponse` rather than a reader
 * of its own, so the handle grammar and the metadata bounds have exactly one
 * implementation on this wire.
 */
export function readWorkspaceTextOpenPayload(value: unknown): ContractResult<WorkspaceTextOpenPayload> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "open");
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, OPEN_PAYLOAD_FIELDS, "open");
  const document = readWorkspaceTextDocument(row.document, "open.document");
  if (!document.ok) return { ok: false, issues: [...bag.drain(), ...document.issues] };
  const frame = readResourceStreamResponse(row.stream);
  if (!frame.ok) return { ok: false, issues: [...bag.drain(), ...frame.issues] };
  if (frame.value.kind !== "open") {
    bag.add("schema", "open.stream must be an `open` frame", "open.stream");
    return bag.fail();
  }

  /**
   * Two halves of one answer, so they have to AGREE.
   *
   * Each half survives its own reader on its own; the interesting failure is the
   * one where a header describes a 40-byte file and the stream it hands over is
   * something else. Every field below is checked because a consumer will act on
   * it: the digest is what makes "the file changed while you were reading" a
   * refusal instead of a seam, and `totalBytes` is what lets this client refuse
   * a transport that ends a stream early.
   */
  const metadata = frame.value.metadata;
  if (metadata.payload !== WORKSPACE_TEXT_CHUNK_PAYLOAD) {
    bag.add("schema", `stream payload must be ${WORKSPACE_TEXT_CHUNK_PAYLOAD}`, "open.stream.metadata.payload");
  }
  if (document.value.mediaType !== WORKSPACE_TEXT_MEDIA_TYPE) {
    bag.add("schema", `document mediaType must be ${WORKSPACE_TEXT_MEDIA_TYPE}`, "open.document.mediaType");
  }
  if (metadata.mediaType !== document.value.mediaType) {
    bag.add("schema", "stream mediaType must match the document's", "open.stream.metadata.mediaType");
  }
  if (metadata.totalBytes !== document.value.sizeBytes) {
    bag.add("schema", "stream totalBytes must match the document's sizeBytes", "open.stream.metadata.totalBytes");
  }
  if (metadata.digest !== document.value.digest) {
    bag.add("schema", "stream digest must match the document's", "open.stream.metadata.digest");
  }
  if (!bag.empty) return bag.fail();
  return {
    ok: true,
    value: { document: document.value, stream: { handle: frame.value.handle, metadata } },
  };
}

/** What `open_media` answers with: a content-sniffed header and byte stream. */
export interface WorkspaceMediaOpenPayload {
  document: WorkspaceMediaDocument;
  stream: { handle: string; metadata: ResourceStreamMetadata };
}

export function readWorkspaceMediaOpenPayload(value: unknown): ContractResult<WorkspaceMediaOpenPayload> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "open");
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, OPEN_PAYLOAD_FIELDS, "open");
  const document = readWorkspaceMediaDocument(row.document, "open.document");
  if (!document.ok) return { ok: false, issues: [...bag.drain(), ...document.issues] };
  const frame = readResourceStreamResponse(row.stream);
  if (!frame.ok) return { ok: false, issues: [...bag.drain(), ...frame.issues] };
  if (frame.value.kind !== "open") {
    bag.add("schema", "open.stream must be an `open` frame", "open.stream");
    return bag.fail();
  }
  const metadata = frame.value.metadata;
  if (metadata.payload !== WORKSPACE_MEDIA_CHUNK_PAYLOAD) {
    bag.add("schema", `stream payload must be ${WORKSPACE_MEDIA_CHUNK_PAYLOAD}`, "open.stream.metadata.payload");
  }
  if (!isWorkspaceMediaType(document.value.mediaType)) {
    bag.add("schema", "document mediaType is not previewable", "open.document.mediaType");
  }
  if (metadata.mediaType !== document.value.mediaType) {
    bag.add("schema", "stream mediaType must match the document's", "open.stream.metadata.mediaType");
  }
  if (metadata.totalBytes !== document.value.sizeBytes) {
    bag.add("schema", "stream totalBytes must match the document's sizeBytes", "open.stream.metadata.totalBytes");
  }
  if (metadata.digest !== document.value.digest) {
    bag.add("schema", "stream digest must match the document's", "open.stream.metadata.digest");
  }
  if (!bag.empty) return bag.fail();
  return {
    ok: true,
    value: { document: document.value, stream: { handle: frame.value.handle, metadata } },
  };
}

/** What `download_file` answers with: an attachment header and byte stream. */
export interface WorkspaceDownloadOpenPayload {
  document: WorkspaceDownloadDocument;
  stream: { handle: string; metadata: ResourceStreamMetadata };
}

export function readWorkspaceDownloadOpenPayload(value: unknown): ContractResult<WorkspaceDownloadOpenPayload> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "open");
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, OPEN_PAYLOAD_FIELDS, "open");
  const document = readWorkspaceDownloadDocument(row.document, "open.document");
  if (!document.ok) return { ok: false, issues: [...bag.drain(), ...document.issues] };
  const frame = readResourceStreamResponse(row.stream);
  if (!frame.ok) return { ok: false, issues: [...bag.drain(), ...frame.issues] };
  if (frame.value.kind !== "open") {
    bag.add("schema", "open.stream must be an `open` frame", "open.stream");
    return bag.fail();
  }
  const metadata = frame.value.metadata;
  if (metadata.payload !== WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD) {
    bag.add("schema", `stream payload must be ${WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD}`, "open.stream.metadata.payload");
  }
  if (metadata.mediaType !== WORKSPACE_DOWNLOAD_MEDIA_TYPE) {
    bag.add("schema", `stream mediaType must be ${WORKSPACE_DOWNLOAD_MEDIA_TYPE}`, "open.stream.metadata.mediaType");
  }
  if (metadata.totalBytes !== document.value.sizeBytes) {
    bag.add("schema", "stream totalBytes must match the document's sizeBytes", "open.stream.metadata.totalBytes");
  }
  if (metadata.digest !== document.value.digest) {
    bag.add("schema", "stream digest must match the document's digest", "open.stream.metadata.digest");
  }
  if (!bag.empty) return bag.fail();
  return {
    ok: true,
    value: { document: document.value, stream: { handle: frame.value.handle, metadata } },
  };
}

/**
 * One proposal, with the transport's own failures folded into the answer.
 *
 * `propose()` is declared to resolve, but this module is the consumer of somebody
 * else's implementation of it — and every method of `WorkspaceFilesPort` promises
 * to resolve. So a rejection, or an answer that is not an object at all, becomes
 * a bounded `unavailable` here rather than an exception a module would have to
 * catch. Rejections are also where a stack trace lives, which is the one thing on
 * this path that reliably carries a canonical path.
 */
async function ask(
  transport: ProposalTransport,
  action: string,
  params: Record<string, string>,
): Promise<ProposalAnswer> {
  try {
    const answer = await transport.propose(action, params);
    if (
      !answer
      || typeof answer !== "object"
      || typeof answer.ok !== "boolean"
      || typeof answer.message !== "string"
      || (answer.code !== undefined && typeof answer.code !== "string")
    ) {
      return { ok: false, code: "unavailable", result: null, message: "资源通道给出了无法识别的回复。" };
    }
    return answer;
  } catch {
    return { ok: false, code: "unavailable", result: null, message: "资源通道没有作答。" };
  }
}

/**
 * Turn any transport-level answer into a bounded domain refusal.
 *
 * Every refusal RESOLVES, including the ones the transport invented (`no_channel`,
 * `channel_closed`). A code this build does not recognise becomes `unavailable`
 * rather than being rendered as if it meant something — the Host's vocabulary is
 * this contract's, and anything else is a version of it we cannot interpret.
 */
function refusalOf(answer: ProposalAnswer): ReturnType<typeof workspaceFilesRefusal> {
  const code: WorkspaceFilesRefusalCode = isWorkspaceFilesRefusalCode(answer.code) ? answer.code : "unavailable";
  return workspaceFilesRefusal(code, answer.message || "这次读取没有完成。");
}

function mediaRefusalOf(answer: ProposalAnswer): WorkspaceMediaReply<never> {
  const code = answer.code === "unsupported_media"
    ? "unsupported_media"
    : isWorkspaceFilesRefusalCode(answer.code)
      ? answer.code
      : "unavailable";
  return workspaceMediaRefusal(code, answer.message || "这次媒体读取没有完成。");
}

function downloadRefusalOf(answer: ProposalAnswer): WorkspaceDownloadReply<never> {
  const code: WorkspaceFilesRefusalCode = isWorkspaceFilesRefusalCode(answer.code)
    ? answer.code
    : "unavailable";
  return workspaceDownloadRefusal(code, answer.message || "这次文件下载没有完成。");
}

/** Same, for a refusal that arrives while a stream is in flight. */
function streamRefusalOf(answer: ProposalAnswer): { code: ResourceStreamRefusalCode; message: string } {
  const code = answer.code;
  if (code === "scope_closed" || code === "unknown_ref") return { code: "expired", message: answer.message };
  if (code === "no_authority" || code === "approval_required" || code === "denied") {
    return { code: "denied", message: answer.message };
  }
  if (code === "too_large") return { code: "too_large", message: answer.message };
  if (code === "not_found") return { code: "not_found", message: answer.message };
  if (code === "invalid_request" || code === "wrong_kind") return { code: "protocol", message: answer.message };
  return { code: "unavailable", message: answer.message || "这条资源流没有继续。" };
}

/**
 * The producer half of one remote text stream.
 *
 * It holds a handle, the chunk index it expects next, and its own count of what
 * has actually arrived. There is no retry anywhere in it: a refusal is a
 * terminal answer, and re-issuing a read that a Gate refused is how one revoked
 * grant becomes a stream of approval cards.
 *
 * ── Why it counts ─────────────────────────────────────────────────────────
 *
 * An `end` frame is a claim that the file is finished. Believed, a transport
 * that dropped a chunk — or a hostile one that sent `end` after the first
 * window — would produce a PREFIX that every layer above reports as a complete,
 * digest-identified file. That is the single outcome `resource-stream/v1` exists
 * to make impossible, so the end is checked against two independent facts: the
 * chunks and bytes this side actually received, and, when the header declared
 * one, the whole file's `totalBytes`.
 */
class RemoteFileSource<T> implements ResourceStreamSource<T> {
  private seq = 0;
  private closed = false;
  /** What actually arrived, counted here rather than taken from a frame. */
  private received = 0;
  private bytes = 0;

  constructor(
    readonly metadata: ResourceStreamMetadata,
    private readonly transport: ProposalTransport,
    private readonly binding: string,
    private readonly handle: string,
    private readonly readChunk: (value: unknown) => ContractResult<T>,
    private readonly measureBytes: (value: T) => number | null,
    private readonly maxChunkBytes: number,
    private readonly positionOk?: (value: T, receivedBytes: number) => boolean,
  ) {}

  async pull(): Promise<ResourceStreamPull<T>> {
    if (this.closed) return { kind: "refused", code: "closed", message: "这条资源流已经关闭。" };
    const answer = await ask(this.transport, RESOURCE_ACTIONS.streamPull, {
      [RESOURCE_PARAMS.binding]: this.binding,
      [RESOURCE_PARAMS.handle]: this.handle,
      // Stated rather than implied, so a producer can refuse a pull that does
      // not match its own cursor instead of silently reordering a file.
      [RESOURCE_PARAMS.seq]: String(this.seq),
    });
    if (!answer.ok) {
      const refusal = streamRefusalOf(answer);
      return { kind: "refused", code: refusal.code, message: refusal.message };
    }

    const frame = readResourceStreamResponse(answer.result);
    if (!frame.ok) return protocolPull("资源流返回了无法识别的帧。");
    if (frame.value.handle !== this.handle) return protocolPull("资源流返回了另一条流的帧。");
    if (frame.value.kind === "end") return this.accountForEnd(frame.value.chunks, frame.value.bytes);
    if (frame.value.kind === "refused") {
      return { kind: "refused", code: frame.value.code, message: frame.value.message };
    }
    if (frame.value.kind !== "chunk") return protocolPull("资源流返回了无法识别的帧。");
    if (frame.value.seq !== this.seq) return protocolPull("资源流的读取顺序不一致。");

    const chunk = this.readChunk(frame.value.value);
    if (!chunk.ok) return protocolPull("资源块没有通过内容契约校验。");
    const bytes = this.measureBytes(chunk.value);
    if (bytes === null || bytes !== frame.value.bytes) {
      return protocolPull("资源块声明的字节数与内容不符。");
    }
    if (this.positionOk && !this.positionOk(chunk.value, this.bytes)) {
      return protocolPull("资源块的读取位置与已经收到的内容不连续。");
    }
    if (bytes > this.maxChunkBytes || bytes > RESOURCE_STREAM_LIMITS.maxChunkBytes) {
      return { kind: "refused", code: "too_large", message: "资源块超过了单块上限。" };
    }
    const total = this.metadata.totalBytes;
    if (total !== undefined && this.bytes + bytes > total) {
      return protocolPull("资源流送来的内容超过了这个文件声明的长度。");
    }
    this.seq += 1;
    this.received += 1;
    this.bytes += bytes;
    return { kind: "chunk", value: chunk.value, bytes };
  }

  private accountForEnd(chunks: number, bytes: number): ResourceStreamPull<T> {
    if (chunks !== this.received || bytes !== this.bytes) {
      return protocolPull("资源流声称的结束位置与实际收到的内容不一致。");
    }
    const total = this.metadata.totalBytes;
    if (total !== undefined && this.bytes !== total) {
      return protocolPull("资源流在文件读完之前就结束了。");
    }
    return { kind: "end" };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Best effort by definition: scope teardown remains authoritative.
    void this.transport
      .propose(RESOURCE_ACTIONS.streamClose, {
        [RESOURCE_PARAMS.binding]: this.binding,
        [RESOURCE_PARAMS.handle]: this.handle,
      })
      .catch(() => undefined);
  }
}

function protocolPull<T>(message: string): ResourceStreamPull<T> {
  return { kind: "refused", code: "protocol", message };
}

/**
 * The only thing that differs between contract versions.
 *
 * Two readers and an id. Everything a dialect could plausibly also want to
 * change — the actions, the parameter names, the stream accounting — is the same
 * in both versions, and keeping it out of here is what stops this from becoming
 * a place where a version can quietly relax a check.
 */
export interface WorkspaceFilesDialect<
  C extends string,
  R extends WorkspaceFilesRoots,
  D extends WorkspaceFilesDirectory,
> {
  readonly contract: C;
  /**
   * Whether this dialect's wire carries `resource.resolve_path` (ticket #243).
   *
   * v1 is golden-frozen and does not; a v1 port therefore has NO `resolvePath`
   * member, which is the same "absence is the statement" enforcement the write
   * uses. This is the one place a version may differ beyond the two readers,
   * because it can only ADD a method — never relax a check the six shared
   * verbs perform.
   */
  readonly resolves?: boolean;
  /** v3 adds `openMedia`; older dialects have no such method or action. */
  readonly media?: boolean;
  /** v4 adds a user-initiated download method; older dialects cannot name it. */
  readonly download?: boolean;
  readonly fileLinks?: boolean;
  readRoots(value: unknown): ContractResult<R>;
  readDirectory(value: unknown): ContractResult<D>;
}

/** The port shape a dialect produces. Four named methods and a contract id. */
export interface WorkspaceFilesCorePort<
  C extends string,
  R extends WorkspaceFilesRoots,
  D extends WorkspaceFilesDirectory,
> {
  readonly contract: C;
  resolveFileLink?(input: WorkspaceFileLink): Promise<WorkspaceFilesReply<WorkspaceResolvedFileLink>>;
  refreshRoots(after?: string): Promise<WorkspaceFilesReply<R>>;
  listDirectory(ref: string, after?: string): Promise<WorkspaceFilesReply<D>>;
  /** Present exactly when the dialect declares `resolves` — a v1 port has none. */
  resolvePath?(
    ref: string,
    labels: readonly string[],
  ): Promise<WorkspaceFilesReply<WorkspaceResolvedEntry>>;
  openText(ref: string): Promise<WorkspaceFilesReply<WorkspaceTextOpen>>;
  /** Present exactly when the dialect declares media preview support. */
  openMedia?(ref: string): Promise<WorkspaceMediaReply<WorkspaceMediaOpen>>;
  /** Present exactly when the dialect declares regular-file download support. */
  downloadFile?(ref: string): Promise<WorkspaceDownloadReply<WorkspaceDownloadOpen>>;
  replaceText(
    ref: string,
    input: WorkspaceReplaceTextInput,
  ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>>;
}

/**
 * Present a proposal transport as one version of workspace-files.
 *
 * `binding` is the App-local name from its `agent-resource-bindings/v1` plan. It
 * selects among what the plan already declared; it is not authority, and the
 * trusted dispatcher resolves it against its own copy of that document.
 */
export function createRemoteWorkspaceFilesCore<
  C extends string,
  R extends WorkspaceFilesRoots,
  D extends WorkspaceFilesDirectory,
>(
  transport: ProposalTransport,
  binding: string,
  dialect: WorkspaceFilesDialect<C, R, D>,
): { port: WorkspaceFilesCorePort<C, R, D>; destroy(): void } {
  let destroyed = false;
  const live = new Set<{ close(): Promise<void> }>();

  const gone = <T>(): WorkspaceFilesReply<T> =>
    workspaceFilesRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
  const goneMedia = (): WorkspaceMediaReply<never> =>
    workspaceMediaRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
  const goneDownload = (): WorkspaceDownloadReply<never> =>
    workspaceDownloadRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");

  const trackStream = <T>(stream: ResourceStream<T>): ResourceStream<T> => {
    const tracked: ResourceStream<T> = {
      contract: stream.contract,
      metadata: stream.metadata,
      next: async () => {
        const read = await stream.next();
        if (read.kind !== "chunk") live.delete(tracked);
        return read;
      },
      close: async () => {
        live.delete(tracked);
        await stream.close();
      },
    };
    live.add(tracked);
    return tracked;
  };

  /**
   * One resolve is one proposal. Labels are validated HERE, before a proposal
   * exists — an invalid claim never spends the wire, let alone a Gate frame.
   * The answer must echo the exact question (base ref plus joined path): the
   * resolved ref is newly minted, so only the echo ties answer to request, and
   * accepting an unechoed answer would be accepting a ref for something else.
   */
  const resolvePath = async (
    ref: string,
    labels: readonly string[],
  ): Promise<WorkspaceFilesReply<WorkspaceResolvedEntry>> => {
    if (destroyed) return gone();
    const asked = String(ref ?? "");
    const problem = workspaceResolveLabelsProblem(labels);
    if (problem) return workspaceFilesRefusal("invalid_request", problem);
    const joined = labels.join("/");
    const answer = await ask(transport, RESOURCE_RESOLVE_PATH_ACTION, {
      [RESOURCE_PARAMS.binding]: binding,
      [RESOURCE_PARAMS.ref]: asked,
      [RESOLVE_PATH_PARAM]: joined,
    });
    if (destroyed) return gone();
    if (!answer.ok) return refusalOf(answer);
    const read = readWorkspaceResolvedEntry(answer.result);
    if (!read.ok) return workspaceFilesRefusal("unavailable", "解析结果没有通过公开契约校验。");
    if (read.value.base !== asked || read.value.path !== joined) {
      return workspaceFilesRefusal("unavailable", "收到的解析结果不是这次请求的那一个。");
    }
    return { ok: true, value: read.value };
  };

  const port: WorkspaceFilesCorePort<C, R, D> = {
    contract: dialect.contract,
    ...(dialect.resolves ? { resolvePath } : {}),
    ...(dialect.fileLinks ? { resolveFileLink: async (input: WorkspaceFileLink): Promise<WorkspaceFilesReply<WorkspaceResolvedFileLink>> => {
      if (destroyed) return gone();
      const problem = workspaceFileLinkProblem(input);
      if (problem) return workspaceFilesRefusal("invalid_request", problem);
      const answer = await ask(transport, RESOURCE_RESOLVE_FILE_LINK_ACTION, {
        binding, href: input.href,
        ...(input.sessionRef !== undefined ? { session: input.sessionRef } : { ref: input.fileRef! }),
      });
      if (destroyed) return gone();
      if (!answer.ok) return refusalOf(answer);
      const value = readWorkspaceResolvedFileLink(answer.result);
      return value && value.source === (input.sessionRef ?? input.fileRef) && value.href === input.href
        ? { ok: true, value }
        : workspaceFilesRefusal("unavailable", "收到的文件链接结果与本次请求不匹配。");
    } } : {}),

    async refreshRoots(after?: string): Promise<WorkspaceFilesReply<R>> {
      if (destroyed) return gone();
      if (after !== undefined && (typeof after !== "string" || !after)) {
        return workspaceFilesRefusal("invalid_request", "这次翻页给出的位置无效。");
      }
      const answer = await ask(transport, RESOURCE_ACTIONS.refreshRoots, {
        [RESOURCE_PARAMS.binding]: binding,
        // Absent rather than empty for page one: an installed provider sees
        // exactly the proposal it always saw.
        ...(after !== undefined ? { [RESOURCE_PAGE_PARAM]: after } : {}),
      });
      // Checked again after the await: `destroy()` means this port hands nothing
      // back, and a call that was already in flight is exactly the one that
      // would otherwise deliver data into a torn-down panel.
      if (destroyed) return gone();
      if (!answer.ok) return refusalOf(answer);
      const read = dialect.readRoots(answer.result);
      return read.ok
        ? { ok: true, value: read.value }
        : workspaceFilesRefusal("unavailable", "工作区列表没有通过公开契约校验。");
    },

    async listDirectory(ref: string, after?: string): Promise<WorkspaceFilesReply<D>> {
      if (destroyed) return gone();
      const asked = String(ref ?? "");
      const position = after === undefined ? null : readWorkspaceListCursor(after);
      if (after !== undefined && !position) {
        return workspaceFilesRefusal("invalid_request", "这次翻页给出的目录位置无效。");
      }
      const answer = await ask(transport, RESOURCE_ACTIONS.listDirectory, {
        [RESOURCE_PARAMS.binding]: binding,
        [RESOURCE_PARAMS.ref]: asked,
        ...(after !== undefined ? { [RESOURCE_PAGE_PARAM]: after } : {}),
      });
      if (destroyed) return gone();
      if (!answer.ok) return refusalOf(answer);
      const read = dialect.readDirectory(answer.result);
      if (!read.ok) return workspaceFilesRefusal("unavailable", "目录列表没有通过公开契约校验。");
      // The listing echoes the ref it is FOR. A consumer keys its tree on that
      // field, so an answer for a different directory would silently reparent a
      // subtree — the reader cannot catch it, because the wrong answer is a
      // perfectly valid one for somewhere else.
      if (read.value.ref !== asked) {
        return workspaceFilesRefusal("unavailable", "收到的目录列表不是所请求的那个目录。");
      }
      // A continued page is self-verifying: every row must sort strictly after
      // the cursor. A provider that ignored `after` answers page one again, and
      // accepting it would show those rows twice.
      if (position && read.value.entries.some((entry) => compareWorkspaceListPositions(entry, position) <= 0)) {
        return workspaceFilesRefusal(
          "unavailable",
          "服务端没有按位置继续列出这个目录（可能是较旧的版本），没有重复显示已有条目。",
        );
      }
      return { ok: true, value: read.value };
    },

    async openText(ref: string): Promise<WorkspaceFilesReply<WorkspaceTextOpen>> {
      if (destroyed) return gone();
      const asked = String(ref ?? "");
      const answer = await ask(transport, RESOURCE_ACTIONS.openText, {
        [RESOURCE_PARAMS.binding]: binding,
        [RESOURCE_PARAMS.ref]: asked,
      });
      if (destroyed) return gone();
      if (!answer.ok) return refusalOf(answer);
      const read = readWorkspaceTextOpenPayload(answer.result);
      if (!read.ok) return workspaceFilesRefusal("unavailable", "文件信息没有通过公开契约校验。");
      if (read.value.document.ref !== asked) {
        return workspaceFilesRefusal("unavailable", "收到的文件信息不是所请求的那个文件。");
      }

      const source = new RemoteFileSource<WorkspaceTextChunk>(
        read.value.stream.metadata,
        transport,
        binding,
        read.value.stream.handle,
        readWorkspaceTextChunk,
        (chunk) => utf8ByteLength(chunk.text),
        WORKSPACE_FILES_LIMITS.textChunkBytes,
      );
      const stream = createResourceStream<WorkspaceTextChunk>(source, {
        maxChunkBytes: WORKSPACE_FILES_LIMITS.textChunkBytes,
        maxStreamBytes: WORKSPACE_FILES_LIMITS.maxTextBytes,
      });
      if (destroyed) {
        void stream.close();
        return gone();
      }
      const tracked = trackStream(stream);
      return { ok: true, value: { document: read.value.document, stream: tracked } };
    },

    ...(dialect.media
      ? {
          async openMedia(ref: string): Promise<WorkspaceMediaReply<WorkspaceMediaOpen>> {
            if (destroyed) return goneMedia();
            const asked = String(ref ?? "");
            const answer = await ask(transport, RESOURCE_OPEN_MEDIA_ACTION, {
              [RESOURCE_PARAMS.binding]: binding,
              [RESOURCE_PARAMS.ref]: asked,
            });
            if (destroyed) return goneMedia();
            if (!answer.ok) return mediaRefusalOf(answer);
            const read = readWorkspaceMediaOpenPayload(answer.result);
            if (!read.ok) return workspaceMediaRefusal("unavailable", "媒体文件信息没有通过公开契约校验。");
            if (read.value.document.ref !== asked) {
              return workspaceMediaRefusal("unavailable", "收到的文件信息不是所请求的那个文件。");
            }
            const source = new RemoteFileSource<WorkspaceMediaChunk>(
              read.value.stream.metadata,
              transport,
              binding,
              read.value.stream.handle,
              readWorkspaceMediaChunk,
              (chunk) => chunk.bytes,
              WORKSPACE_MEDIA_LIMITS.chunkBytes,
              (chunk, receivedBytes) => chunk.offset === receivedBytes
                && base64ByteLength(chunk.data) === chunk.bytes,
            );
            const stream = createResourceStream<WorkspaceMediaChunk>(source, {
              maxChunkBytes: WORKSPACE_MEDIA_LIMITS.chunkBytes,
              maxStreamBytes: WORKSPACE_MEDIA_LIMITS.maxBytes,
            });
            if (destroyed) {
              void stream.close();
              return goneMedia();
            }
            const tracked = trackStream(stream);
            return { ok: true, value: { document: read.value.document, stream: tracked } };
          },
        }
      : {}),

    ...(dialect.download
      ? {
          async downloadFile(ref: string): Promise<WorkspaceDownloadReply<WorkspaceDownloadOpen>> {
            if (destroyed) return goneDownload();
            const asked = String(ref ?? "");
            const answer = await ask(transport, RESOURCE_DOWNLOAD_FILE_ACTION, {
              [RESOURCE_PARAMS.binding]: binding,
              [RESOURCE_PARAMS.ref]: asked,
            });
            if (destroyed) return goneDownload();
            if (!answer.ok) return downloadRefusalOf(answer);
            const read = readWorkspaceDownloadOpenPayload(answer.result);
            if (!read.ok) return workspaceDownloadRefusal("unavailable", "下载文件信息没有通过公开契约校验。");
            if (read.value.document.ref !== asked) {
              return workspaceDownloadRefusal("unavailable", "收到的下载文件信息不是所请求的那个文件。");
            }
            const source = new RemoteFileSource<WorkspaceDownloadChunk>(
              read.value.stream.metadata,
              transport,
              binding,
              read.value.stream.handle,
              readWorkspaceDownloadChunk,
              (chunk) => chunk.bytes,
              WORKSPACE_DOWNLOAD_LIMITS.chunkBytes,
              (chunk, receivedBytes) => chunk.offset === receivedBytes
                && base64ByteLength(chunk.data) === chunk.bytes,
            );
            const stream = createResourceStream<WorkspaceDownloadChunk>(source, {
              maxChunkBytes: WORKSPACE_DOWNLOAD_LIMITS.chunkBytes,
              maxStreamBytes: WORKSPACE_DOWNLOAD_LIMITS.maxBytes,
            });
            if (destroyed) {
              void stream.close();
              return goneDownload();
            }
            const tracked = trackStream(stream);
            return { ok: true, value: { document: read.value.document, stream: tracked } };
          },
        }
      : {}),

    /**
     * Submit one whole-file replacement, conditional on the version it was based
     * on — in one call when it fits one window, else as one staged upload.
     *
     * Encoded through the DECLARATION rather than by hand, so the bounds the
     * contract states and the bounds the dispatcher enforces are the same ones.
     * The windows come from `workspaceTextWindows`, which keeps every call
     * inside both the wire's raised parameter and the Gate's encoded-argument
     * bound, so a body is never refused for its size.
     *
     * Every answer is checked against what was asked for, because a receipt is
     * the thing a person reads as "saved": one describing another file, the
     * wrong precondition or a different byte count would be a success message
     * about somebody else's write. A staged answer must name the upload that was
     * begun and account for exactly the bytes sent so far.
     */
    async replaceText(
      ref: string,
      input: WorkspaceReplaceTextInput,
    ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>> {
      if (destroyed) return gone();
      const asked = String(ref ?? "");
      const expectedDigest = String(input?.expectedDigest ?? "");
      const text = typeof input?.text === "string" ? input.text : null;
      if (text === null) {
        // Not `?? ""`: an absent body would become "please empty this file",
        // and emptying a file is a legal edit somebody has to have asked for.
        return workspaceFilesRefusal("invalid_request", "这次保存没有带上文件内容。");
      }
      const call = async <T>(
        values: Record<string, unknown>,
        readAnswer: (value: unknown) => ContractResult<T>,
        check: (value: T) => boolean,
      ): Promise<WorkspaceFilesReply<T>> => {
        if (destroyed) return gone();
        const encoded = encodeWireParams(WORKSPACE_FILES_DECLARATION.byAction.replace_text, { ref: asked, ...values });
        if (!encoded.ok) {
          return workspaceFilesRefusal(
            "invalid_request",
            `这次保存不符合契约声明：${encoded.issues.map((issue) => issue.message).join("；")}`,
          );
        }
        const answer = await ask(transport, RESOURCE_ACTIONS.replaceText, {
          [RESOURCE_PARAMS.binding]: binding,
          ...encoded.value,
        });
        if (destroyed) return gone();
        if (!answer.ok) return refusalOf(answer);
        const read = readAnswer(answer.result);
        if (!read.ok) return workspaceFilesRefusal("unavailable", "保存回执没有通过公开契约校验。");
        if (!check(read.value)) return workspaceFilesRefusal("unavailable", "收到的保存回执不是这次提交的那一个。");
        return { ok: true, value: read.value };
      };
      const receiptFor = (receipt: WorkspaceMutationReceipt): boolean =>
        receipt.ref === asked && receipt.beforeDigest === expectedDigest;
      return await replaceWorkspaceTextInWindows(text, {
        whole: (body) => call({ expected_digest: expectedDigest, text: body }, readWorkspaceMutationReceipt, receiptFor),
        begin: () => call<WorkspaceTextUpload>(
          { stage: "begin", expected_digest: expectedDigest },
          readWorkspaceTextUpload,
          () => true,
        ),
        append: (upload, offset, window) => call<WorkspaceTextUpload>(
          { stage: "append", upload, offset, text: window },
          readWorkspaceTextUpload,
          () => true,
        ),
        commit: (upload, size) => call(
          { stage: "commit", upload, expected_digest: expectedDigest, size },
          readWorkspaceMutationReceipt,
          receiptFor,
        ),
      });
    },
  };

  return {
    port,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const stream of [...live]) void stream.close();
      live.clear();
    },
  };
}
