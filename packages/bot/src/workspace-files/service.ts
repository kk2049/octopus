/**
 * The trusted Workspace Files provider.
 *
 * One `WorkspaceFilesPort` per scope. A scope is whatever the trusted side has
 * decided is a lifetime — an App instance, a browser credential, a run — and it
 * is supplied here rather than derived, because deriving it is exactly the kind
 * of guess that ends up with one consumer holding another's refs.
 *
 * ── The order of operations is the security content ────────────────────────
 *
 * Every method rebinds BEFORE it can produce a frame:
 *
 *   ref -> vault.resolve(scope, owner, kind) -> binding -> backend -> device
 *
 * A forged ref, a ref from another scope, a ref from another owner, a ref whose
 * scope has been closed and a directory ref handed to `openText` all stop at
 * step two. No Runner call happens, so no approval card is created and nothing
 * on a laptop is touched. That is a stronger statement than "the call would have
 * been refused".
 *
 * ── What this provider does NOT decide ─────────────────────────────────────
 *
 * Whether the account may read anything at all. It calls an authority seam and
 * reports what comes back; in production that seam is a ControllerRun under the
 * App's Context and the Gate answers. There is no second permission model here,
 * and adding one would create exactly the divergence the capability kernel
 * exists to prevent.
 *
 * ── Closing ────────────────────────────────────────────────────────────────
 *
 * `closeScope()` drops the refs, cancels the streams and releases their cursors,
 * in that order: from the moment the refs are gone nothing new can be started,
 * so a stream cancellation that threw could not leave a way back in.
 */

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
  WORKSPACE_DOWNLOAD_LIMITS,
  WORKSPACE_DOWNLOAD_MEDIA_TYPE,
  WORKSPACE_MEDIA_CHUNK_PAYLOAD,
  WORKSPACE_MEDIA_LIMITS,
  WORKSPACE_TEXT_CHUNK_PAYLOAD,
  WORKSPACE_TEXT_MEDIA_TYPE,
  base64ByteLength,
  isWorkspaceMediaType,
  isWorkspaceContentDigest,
  readWorkspaceFilesDirectory,
  readWorkspaceFilesDirectoryV2,
  readWorkspaceFilesRoots,
  readWorkspaceFilesRootsV2,
  readWorkspaceMutationReceipt,
  readWorkspaceTextChunk,
  readWorkspaceMediaChunk,
  readWorkspaceDownloadDocument,
  readWorkspaceMediaDocument,
  readWorkspaceTextDocument,
  readWorkspaceResolvedEntry,
  workspaceFilesRefusal,
  workspaceMediaRefusal,
  workspaceDownloadRefusal,
  workspaceResolveLabelsProblem,
  workspaceFileLinkProblem,
  compareWorkspaceListPositions,
  isWorkspaceTextUploadToken,
  readWorkspaceListCursor,
  readWorkspaceTextUpload,
  workspaceListCursor,
  type WorkspaceTextUpload,
  type WorkspaceFileLink,
  type WorkspaceResolvedFileLink,
  type WorkspaceFilesDirectoryV2,
  type WorkspaceFilesEntryV2,
  type WorkspaceFilesPort,
  type WorkspaceFilesRefusalCode,
  type WorkspaceDownloadChunk,
  type WorkspaceDownloadOpen,
  type WorkspaceDownloadPort,
  type WorkspaceDownloadReply,
  type WorkspaceMediaChunk,
  type WorkspaceMediaOpen,
  type WorkspaceMediaPort,
  type WorkspaceMediaReply,
  type WorkspaceMediaType,
  type WorkspaceFilesReply,
  type WorkspaceResolvedEntry,
  type WorkspaceFilesRootV2,
  type WorkspaceFilesRootsV2,
  type WorkspaceMutationReceipt,
  type WorkspaceReplaceTextInput,
  type WorkspaceTextChunk,
  type WorkspaceTextDocument,
  type WorkspaceTextOpen,
} from "@claude-bot/workspace-files-contract";
import type {
  ContractResult,
  ResourceStreamPull,
  ResourceStreamRead,
  ResourceStreamRefusalCode,
  ResourceStreamSource,
} from "@claude-bot/resource-stream-contract";
import { isResourceDigest } from "@claude-bot/resource-stream-contract";
import { ResourceStreamBroker } from "../resource-stream/broker.js";
import { WorkspaceRefLimitError, WorkspaceRefVault } from "./refs.js";
import type {
  BackendEntry,
  BackendBinaryWindow,
  BackendMutation,
  BackendResult,
  BackendTextWindow,
  WorkspaceBinding,
  WorkspaceFilesBackend,
  OwnerFileSessionTarget,
} from "./types.js";

export interface WorkspaceFilesServiceOptions {
  /** Share one broker with the rest of the process, or get a private one. */
  broker?: ResourceStreamBroker;
  /** Entries asked for per directory listing. */
  listLimit?: number;
  /** Bytes asked for per stream pull. */
  chunkBytes?: number;
  /** Opaque references one scope may retain before it must be reopened. */
  maxRefsPerScope?: number;
  /** Opaque references one account may retain across all of its scopes. */
  maxRefsPerOwner?: number;
  /** Opaque references retained across all scopes in this process. */
  maxRefsGlobal?: number;
}

export interface WorkspaceFilesScope {
  scope: string;
  /** The authenticated principal. Never taken from a request body. */
  owner: string;
  backend: WorkspaceFilesBackend;
  /**
   * Whether this scope's authority covers the write operation.
   *
   * Absent means no, and that default is the point: a caller composed before
   * writing existed keeps behaving exactly as it did.
   *
   * ── This is NOT the authoriser ────────────────────────────────────────────
   *
   * The Gate is, and it is asked on every call that gets that far. What this
   * boolean buys is a different SENTENCE for a structural fact: a scope derived
   * without `replace_workspace_text` would otherwise reach the kernel, be denied
   * for lack of the right, and be reported as `denied` — which reads like "your
   * save was rejected" rather than "this view does not save". It also means the
   * refusal costs no frame and no approval card.
   *
   * It can only ever narrow: `true` here does not grant anything.
   */
  writable?: boolean;
  /** Write authority for owner-root refs; workspace write never implies it. */
  ownerFilesWritable?: boolean;
  /** Owner-only seam. Shared scopes omit it even if the original owner consented. */
  ownerFileTarget?: (sessionRef: string) => OwnerFileSessionTarget | null;
  /**
   * Which version of the contract this scope answers as.
   *
   * Absent is v1, and that default is the whole compatibility story: a caller
   * composed before v2 existed keeps producing byte-identical answers.
   */
  contract?: string;
  /**
   * Mint the opaque join key for one directory, or return null.
   *
   * A bound function rather than the identity it needs, because the identity
   * includes the publisher and the app — and a service that learned those would
   * be a service that could tell two Apps apart, which is a decision belonging
   * to the layer that already holds them. Absent means this scope projects no
   * keys at all, which is what a `workspace-files/v1` scope is.
   */
  directoryKey?: (binding: WorkspaceBinding, relativePath: string) => string | null;
}

/**
 * One scope's port, plus the two things a TRANSPORT needs that an in-process
 * consumer does not.
 *
 * An in-process consumer holds the `ResourceStream` object. A consumer behind a
 * MessagePort holds a handle, because an object cannot cross. Both address the
 * same guard — the broker's facade and the handle are two faces of one entry, so
 * a stream that ends for one has ended for the other. Minting a second table
 * here would be a second state machine, and the interesting failure is the one
 * where the two disagree about whether a file handle is still open.
 *
 * These three are trusted-side only: nothing on `WorkspaceFilesPort` mentions a
 * handle, so a module cannot name one.
 */
/** One window of a text file, as `readTextWindow` answers it. */
export interface WorkspaceTextWindow {
  readonly document: WorkspaceTextDocument;
  /** UTF-8 byte offset this window starts at. */
  readonly offset: number;
  /** UTF-8 bytes in `text`. */
  readonly bytes: number;
  /** Where the next window starts: `offset + bytes`. */
  readonly nextOffset: number;
  readonly eof: boolean;
  readonly text: string;
}

export interface WorkspaceFilesScopePort extends WorkspaceFilesPort, WorkspaceMediaPort, WorkspaceDownloadPort {
  resolveFileLink(input: WorkspaceFileLink): Promise<WorkspaceFilesReply<WorkspaceResolvedFileLink>>;
  /**
   * The two answers that carry a `directoryKey` are typed as the v2 supersets.
   *
   * v2's shapes are v1's plus one optional field, so a v1 scope satisfies both
   * and an in-process consumer written against v1 keeps compiling. Doing it the
   * other way — one port type per version — would have split every trusted-side
   * caller in two for a field that is optional by construction.
   */
  refreshRoots(after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesRootsV2>>;
  listDirectory(ref: string, after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesDirectoryV2>>;
  /**
   * The three steps of a staged replacement (2026-10-20), for a text larger
   * than one call. Trusted-side: a remote module calls `replaceText` and its
   * port issues these through `resource.replace_text` + `stage`; MCP calls them
   * directly. Each spends the same write operation through the Gate.
   */
  beginTextUpload(ref: string, input: { expectedDigest: string }): Promise<WorkspaceFilesReply<WorkspaceTextUpload>>;
  appendTextUpload(
    ref: string,
    input: { upload: string; offset: number; text: string },
  ): Promise<WorkspaceFilesReply<WorkspaceTextUpload>>;
  commitTextUpload(
    ref: string,
    input: { upload: string; expectedDigest: string; sizeBytes: number },
  ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>>;
  /**
   * Always present on a trusted scope port, unlike the optional member it
   * satisfies: which WIRE carries the verb is the dispatcher's closed-set
   * decision (v2 only), not this implementation's. An in-process v1 consumer
   * calling it gets version-neutral data and spends the same listing token.
   */
  resolvePath(ref: string, labels: readonly string[]): Promise<WorkspaceFilesReply<WorkspaceResolvedEntry>>;
  /**
   * Always present on a trusted scope port, unlike the optional member it
   * satisfies: whether this scope may write is answered per call (`read_only`),
   * not by the method being missing. Absence is for ports that structurally
   * cannot write; a provider always can, for some scope.
   */
  replaceText(
    ref: string,
    input: WorkspaceReplaceTextInput,
  ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>>;
  /**
   * One window of a text file at a byte offset, without a stream (2026-10-20).
   * Trusted-side, for a caller that pages a file across separate calls (MCP):
   * one device read per call, at most one stream chunk of bytes, every window
   * carrying the whole file's digest and size so windows of two versions are
   * never silently joined. `offset` must be a window boundary (`nextOffset`).
   */
  readTextWindow(ref: string, offset: number, maxBytes?: number): Promise<WorkspaceFilesReply<WorkspaceTextWindow>>;
  /** The same open as `openText`, plus the handle a transport addresses it by. */
  openTextForTransport(ref: string): Promise<WorkspaceFilesReply<WorkspaceTextOpen & { handle: string }>>;
  /** The media open plus the stream handle carried over a MessagePort. */
  openMediaForTransport(ref: string): Promise<WorkspaceMediaReply<WorkspaceMediaOpen & { handle: string }>>;
  /** The explicit download open plus the stream handle carried over a MessagePort. */
  openDownloadForTransport(
    ref: string,
  ): Promise<WorkspaceDownloadReply<WorkspaceDownloadOpen & { handle: string }>>;
  /** One pull, by handle, inside THIS scope. A handle from another answers `expired`. */
  pullStream(handle: string, seq: number): Promise<ResourceStreamRead<unknown>>;
  /** Release one stream by handle. Idempotent, like the stream's own `close()`. */
  closeStream(handle: string): Promise<boolean>;
}

/**
 * How a contract refusal reads once it is INSIDE a stream.
 *
 * The two vocabularies are deliberately different sizes: a port refusal is about
 * a request that has not started, a stream refusal is about one that has. So
 * "somebody needs to approve this" becomes `denied` mid-stream — there is no
 * way to pause a half-read file for a click, and pretending otherwise would
 * leave a stream open against an authority that no longer answers.
 */
function streamCode(code: WorkspaceFilesRefusalCode): ResourceStreamRefusalCode {
  switch (code) {
    case "unknown_ref":
    case "scope_closed":
      return "expired";
    case "digest_mismatch":
      // The file changed underneath a stream that was already running. That is
      // the same thing `unavailable` means here — a partly-read file whose two
      // halves are two versions — and it must never be a resumable state.
      return "unavailable";
    case "read_only":
    case "wrong_kind":
    case "invalid_request":
      return "protocol";
    case "no_authority":
    case "approval_required":
    case "denied":
      return "denied";
    case "not_found":
    case "not_a_directory":
    case "not_a_file":
      return "not_found";
    case "not_text":
    case "outside_workspace":
      return "unsupported";
    case "too_large":
      return "too_large";
    default:
      return "unavailable";
  }
}

/** Backend text is trusted-side diagnostics, not View copy; never forward it. */
function publicRefusalText(code: WorkspaceFilesRefusalCode): string {
  switch (code) {
    case "unknown_ref":
      return "这个引用不属于当前视图。";
    case "wrong_kind":
      return "这个引用指向的不是要打开的那类资源。";
    case "scope_closed":
      return "这个视图的会话已经结束，请重新打开。";
    case "no_authority":
      return "当前视图没有读取这个工作区的权限。";
    case "approval_required":
      return "这次读取需要设备主人先在可信审批栏确认。";
    case "not_found":
      return "这个文件或目录已经不在了。";
    case "not_a_directory":
      return "这不是一个目录。";
    case "not_a_file":
      return "这不是一个普通文件。";
    case "not_text":
      return "这个文件不是 UTF-8 文本，本视图不打开它。";
    case "too_large":
      // Reads and listings have no total cap since 2026-10-20; only a Runner
      // bundle from before that still refuses a large file or ignores a
      // listing cursor, so say what fixes it.
      return "设备上的 Runner 版本较旧，仍对大文件或长目录设有上限；升级 Runner 后即可完整访问。";
    case "outside_workspace":
      return "这个资源指向了已登记工作区之外。";
    case "denied":
      return "当前授权拒绝了这次操作。";
    case "invalid_request":
      return "这次请求的格式无效。";
    case "digest_mismatch":
      return "这个文件已经不是你打开时的那个版本了，没有写入任何内容。请重新打开后再改一次。";
    case "read_only":
      return "当前视图只能读取这个工作区，不能改写。";
    default:
      return "设备暂时无法完成这次操作。";
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** One call carries one window; this is never a verdict on the file's size. */
const ONE_CALL_TOO_LARGE = "这次调用携带的内容超过了单次调用的窗口；更大的内容请分段保存（begin / append / commit）。";

/** Any staged step that did not complete: the target is untouched either way. */
const STAGED_UNAVAILABLE =
  "分段保存没有完成，目标文件没有被改动；请重新保存。分段保存需要较新的 Runner，如设备上的 Runner 较旧请先升级。";

/**
 * Validate the backend seam independently of its concrete Runner adapter.
 * A malformed EOF is especially dangerous: accepting it turns a prefix into a
 * successful whole-file read, which is precisely the truncation v1 forbids.
 */
function validTextWindow(window: BackendTextWindow, expectedOffset: number, maxBytes: number): boolean {
  const row = window as unknown as Record<string, unknown>;
  const size = row.sizeBytes;
  const offset = row.offset;
  const bytes = row.bytes;
  const eof = row.eof;
  const text = row.text;
  if (
    !Number.isInteger(size)
    || !Number.isInteger(offset)
    || !Number.isInteger(bytes)
    || typeof eof !== "boolean"
    || typeof text !== "string"
    || (size as number) < 0
    || (size as number) > WORKSPACE_FILES_LIMITS.maxTextBytes
    || offset !== expectedOffset
    || (bytes as number) < 0
    || (bytes as number) > Math.min(WORKSPACE_FILES_LIMITS.textChunkBytes, maxBytes + 3)
    || (offset as number) + (bytes as number) > (size as number)
    || Buffer.byteLength(text, "utf8") !== bytes
    || (bytes === 0 && !eof)
    || eof !== ((offset as number) + (bytes as number) === size)
    || !isResourceDigest(row.digest)
    || typeof row.modifiedAt !== "string"
    || !ISO_INSTANT.test(row.modifiedAt)
    || text.includes("\u0000")
  ) {
    return false;
  }
  return readWorkspaceTextChunk({ text }).ok;
}

/**
 * The pull source behind one opened text file.
 *
 * It holds a byte offset and nothing else. The device keeps no cursor, so there
 * is no server-side reading position to expire, to get out of step, or to leak
 * between two consumers — every window is a self-describing read that states the
 * whole file's size and digest.
 *
 * Those two are checked on every window, which is what turns "the file changed
 * while somebody was reading it" from a seamless mixture of two versions into a
 * refusal.
 */
/**
 * One backend read kept in flight ahead of the consumer.
 *
 * A pull crosses two legs in series: the consumer's (browser -> Host) and the
 * device's (Host -> Runner). Starting the next window's device read as soon
 * as a chunk is handed over overlaps them, so a chunk costs the slower leg
 * rather than both. It never runs further than one window ahead, a pull still
 * starts at most one backend read, and a read that fails or throws becomes
 * the next pull's refusal; closing drops whatever arrives afterwards.
 */
class ReadAhead<T> {
  private ahead: Promise<ResourceStreamPull<T>> | null = null;

  constructor(private readonly read: () => Promise<ResourceStreamPull<T>>) {}

  get pending(): boolean {
    return this.ahead !== null;
  }

  start(): void {
    if (this.ahead) return;
    this.ahead = this.read().catch(() => ({
      kind: "refused" as const,
      code: "unavailable" as const,
      message: "读取工作区时出现内部错误，本次请求没有完成。",
    }));
  }

  take(): Promise<ResourceStreamPull<T>> {
    const next = this.ahead ?? this.read();
    this.ahead = null;
    return next;
  }

  drop(): void {
    this.ahead = null;
  }
}

class WorkspaceTextSource implements ResourceStreamSource<WorkspaceTextChunk> {
  readonly metadata: {
    payload: string;
    mediaType: string;
    totalBytes: number;
    digest: string;
  };

  private pending: BackendTextWindow | null;
  private offset = 0;
  private finished = false;
  private closed = false;
  /** Test/diagnostics: cursors must be released exactly once. */
  closes = 0;

  constructor(
    private readonly backend: WorkspaceFilesBackend,
    private readonly binding: WorkspaceBinding,
    private readonly relativePath: string,
    private readonly chunkBytes: number,
    first: BackendTextWindow,
  ) {
    this.metadata = {
      payload: WORKSPACE_TEXT_CHUNK_PAYLOAD,
      mediaType: WORKSPACE_TEXT_MEDIA_TYPE,
      totalBytes: first.sizeBytes,
      digest: first.digest,
    };
    // An empty file is an empty stream, not a zero-length chunk followed by one.
    this.pending = first.bytes > 0 ? first : null;
    this.offset = first.offset + first.bytes;
    this.finished = first.eof;
  }

  async pull(): Promise<ResourceStreamPull<WorkspaceTextChunk>> {
    if (this.closed) return { kind: "refused", code: "cancelled", message: "这次读取已经被取消。" };
    // The window fetched while opening. Serving it here is what makes the
    // FIRST pull cost zero backend reads instead of two.
    if (this.pending) {
      const window = this.pending;
      this.pending = null;
      if (!this.finished) this.readAhead.start();
      return { kind: "chunk", value: { text: window.text }, bytes: window.bytes };
    }
    if (this.finished && !this.readAhead.pending) return { kind: "end" };
    const next = await this.readAhead.take();
    if (next.kind === "chunk" && !this.finished && !this.closed) this.readAhead.start();
    return next;
  }

  private readonly readAhead = new ReadAhead<WorkspaceTextChunk>(() => this.readNext());

  private async readNext(): Promise<ResourceStreamPull<WorkspaceTextChunk>> {
    if (this.closed) return { kind: "refused", code: "cancelled", message: "这次读取已经被取消。" };
    const next = await this.backend.readText(this.binding, this.relativePath, this.offset, this.chunkBytes);
    if (!next.ok) {
      return { kind: "refused", code: streamCode(next.code), message: publicRefusalText(next.code) };
    }
    const window = next.value;
    if (!validTextWindow(window, this.offset, this.chunkBytes)) {
      return { kind: "refused", code: "protocol", message: "设备返回了无法识别的文件窗口。" };
    }
    if (window.digest !== this.metadata.digest || window.sizeBytes !== this.metadata.totalBytes) {
      return { kind: "refused", code: "unavailable", message: "这个文件在读取过程中被改动了，本次读取已停止。" };
    }
    if (window.offset !== this.offset) {
      return { kind: "refused", code: "protocol", message: "设备返回的读取位置与请求不一致。" };
    }
    this.offset = window.offset + window.bytes;
    this.finished = window.eof;
    if (window.bytes === 0) return { kind: "end" };
    return { kind: "chunk", value: { text: window.text }, bytes: window.bytes };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readAhead.drop();
    this.closes += 1;
  }
}

function validBinaryWindow(window: BackendBinaryWindow, expectedOffset: number, maxBytes: number): boolean {
  const row = window as unknown as Record<string, unknown>;
  const size = row.sizeBytes;
  const offset = row.offset;
  const bytes = row.bytes;
  const eof = row.eof;
  const data = row.data;
  if (
    !Number.isInteger(size)
    || !Number.isInteger(offset)
    || !Number.isInteger(bytes)
    || typeof eof !== "boolean"
    || typeof data !== "string"
    || (size as number) < 0
    || (size as number) > WORKSPACE_MEDIA_LIMITS.maxBytes
    || offset !== expectedOffset
    || (bytes as number) < 0
    || (bytes as number) > Math.min(WORKSPACE_MEDIA_LIMITS.chunkBytes, maxBytes)
    || (offset as number) + (bytes as number) > (size as number)
    || base64ByteLength(data) !== bytes
    || (bytes === 0 && !eof)
    || eof !== ((offset as number) + (bytes as number) === size)
    || !isResourceDigest(row.digest)
    || typeof row.modifiedAt !== "string"
    || !ISO_INSTANT.test(row.modifiedAt)
  ) {
    return false;
  }
  return readWorkspaceMediaChunk({ offset, bytes, data }).ok;
}

/** Content identification is trusted-side and never inferred from the file name. */
function sniffWorkspaceMediaType(data: string): WorkspaceMediaType | null {
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const prefix = bytes.subarray(0, 12).toString("ascii");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
  if (bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) return "application/pdf";
  return null;
}

class WorkspaceBinarySource implements ResourceStreamSource<WorkspaceMediaChunk> {
  readonly metadata: {
    payload: string;
    mediaType: string;
    totalBytes: number;
    digest: string;
  };

  private pending: BackendBinaryWindow | null;
  private offset: number;
  private finished: boolean;
  private closed = false;

  constructor(
    private readonly backend: WorkspaceFilesBackend,
    private readonly readWindow: NonNullable<WorkspaceFilesBackend["readBinary"]>,
    private readonly binding: WorkspaceBinding,
    private readonly relativePath: string,
    private readonly chunkBytes: number,
    first: BackendBinaryWindow,
    payload: string,
    mediaType: string,
  ) {
    this.metadata = {
      payload,
      mediaType,
      totalBytes: first.sizeBytes,
      digest: first.digest,
    };
    this.pending = first.bytes > 0 ? first : null;
    this.offset = first.offset + first.bytes;
    this.finished = first.eof;
  }

  async pull(): Promise<ResourceStreamPull<WorkspaceMediaChunk>> {
    if (this.closed) return { kind: "refused", code: "cancelled", message: "这次读取已经被取消。" };
    if (this.pending) {
      const window = this.pending;
      this.pending = null;
      if (!this.finished) this.readAhead.start();
      return {
        kind: "chunk",
        value: { offset: window.offset, bytes: window.bytes, data: window.data },
        bytes: window.bytes,
      };
    }
    if (this.finished && !this.readAhead.pending) return { kind: "end" };
    const next = await this.readAhead.take();
    if (next.kind === "chunk" && !this.finished && !this.closed) this.readAhead.start();
    return next;
  }

  private readonly readAhead = new ReadAhead<WorkspaceMediaChunk>(() => this.readNext());

  private async readNext(): Promise<ResourceStreamPull<WorkspaceMediaChunk>> {
    if (this.closed) return { kind: "refused", code: "cancelled", message: "这次读取已经被取消。" };
    const next = await this.readWindow.call(
      this.backend,
      this.binding,
      this.relativePath,
      this.offset,
      this.chunkBytes,
    );
    if (!next.ok) {
      return { kind: "refused", code: streamCode(next.code), message: publicRefusalText(next.code) };
    }
    const window = next.value;
    if (!validBinaryWindow(window, this.offset, this.chunkBytes)) {
      return { kind: "refused", code: "protocol", message: "设备返回了无法识别的二进制文件窗口。" };
    }
    if (window.digest !== this.metadata.digest || window.sizeBytes !== this.metadata.totalBytes) {
      return { kind: "refused", code: "unavailable", message: "这个文件在读取过程中被改动了，本次读取已停止。" };
    }
    this.offset = window.offset + window.bytes;
    this.finished = window.eof;
    if (window.bytes === 0) return { kind: "end" };
    return {
      kind: "chunk",
      value: { offset: window.offset, bytes: window.bytes, data: window.data },
      bytes: window.bytes,
    };
  }

  close(): void {
    this.closed = true;
    this.pending = null;
    this.readAhead.drop();
  }
}

class WorkspaceFilesProvider implements WorkspaceFilesScopePort {
  /**
   * The port ABI's family id stays v1 on this trusted in-process facade.
   *
   * Remote modules hold a versioned port. v2 and v3 share the stable directory
   * projection, while v3 adds a media method; `projectsV2` therefore means
   * "project the v2-shaped directory identity fields", not "speak only v2".
   */
  readonly contract = WORKSPACE_FILES_CONTRACT;
  /**
   * Declared by the composition root, never inferred from whether a minter was
   * supplied: "which contract is this scope" is a statement about the binding,
   * and deriving it from a side effect would make a missing minter look like v1.
   */
  private readonly projectsV2: boolean;
  private closed = false;

  constructor(
    private readonly scope: WorkspaceFilesScope,
    private readonly vault: WorkspaceRefVault,
    private readonly broker: ResourceStreamBroker,
    private readonly listLimit: number,
    private readonly chunkBytes: number,
  ) {
    this.projectsV2 = scope.contract === WORKSPACE_FILES_CONTRACT_V2
      || scope.contract === WORKSPACE_FILES_CONTRACT_V3
      || scope.contract === WORKSPACE_FILES_CONTRACT_V4;
  }

  /**
   * The key for one directory, or undefined.
   *
   * Undefined is a promise not made. There is no fallback path here on purpose:
   * a key derived from a label would compare equal for two directories called
   * `src`, which is the exact defect this field exists to remove.
   */
  private keyFor(binding: WorkspaceBinding, relativePath: string): string | undefined {
    return this.scope.directoryKey?.(binding, relativePath) ?? undefined;
  }

  /**
   * Project through the reader of the version this scope answers as.
   *
   * A v1 scope goes through v1's reader, which refuses the new field — so "a v1
   * binding cannot be handed a v2 answer" is checked on the producing side too,
   * not only by the consumer.
   */
  private projectRoots(value: Record<string, unknown>): ContractResult<WorkspaceFilesRootsV2> {
    return this.projectsV2
      ? readWorkspaceFilesRootsV2(value)
      : readWorkspaceFilesRoots(value);
  }

  private projectDirectory(value: Record<string, unknown>): ContractResult<WorkspaceFilesDirectoryV2> {
    return this.projectsV2
      ? readWorkspaceFilesDirectoryV2(value)
      : readWorkspaceFilesDirectory(value);
  }

  markClosed(): void {
    this.closed = true;
  }

  /**
   * One page of roots, continued after the root `after` names.
   *
   * The order is the backend's, unchanged, so page one is byte-for-byte what
   * every earlier build answered. `after` is a root ref this scope minted; the
   * vault — not the View — holds the binding it stands for, and the next page
   * starts right after that root in a fresh enumeration. Roots added or removed
   * elsewhere therefore neither repeat nor hide a root; if the cursor root
   * ITSELF was unregistered meanwhile its position is gone, and the answer says
   * so instead of guessing one.
   */
  async refreshRoots(after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesRootsV2>> {
    if (this.closed) return this.scopeClosed();
    let from: WorkspaceBinding | null = null;
    if (after !== undefined) {
      const resolved = this.vault.resolve(this.scope.scope, this.scope.owner, after, "directory");
      if (!resolved.ok) return this.refRefusal(resolved.code);
      from = resolved.record.binding;
    }
    const answer = await guard(() => this.scope.backend.listRoots());
    if (this.closed) return this.scopeClosed();
    if (!answer.ok) return workspaceFilesRefusal(answer.code, publicRefusalText(answer.code));

    let all = answer.value;
    if (from) {
      const at = findLastIndex(all, (root) => sameRoot(root.binding, from!));
      if (at < 0) {
        return workspaceFilesRefusal("unavailable", "工作区列表在翻页期间发生了变化，请重新刷新工作区列表。");
      }
      all = all.slice(at + 1);
    }
    const visible = all.slice(0, WORKSPACE_FILES_LIMITS.maxRoots);
    let refs: string[];
    try {
      refs = this.vault.mintMany(
        visible.map((root) => ({
          scope: this.scope.scope,
          owner: this.scope.owner,
          kind: "directory",
          binding: root.binding,
          relativePath: root.binding.ownerRoot ? "/" : "",
          label: root.binding.workspaceLabel,
        })),
      );
    } catch (err) {
      if (err instanceof WorkspaceRefLimitError) return this.refCapacity();
      throw err;
    }
    const roots: WorkspaceFilesRootV2[] = visible.map((root, index) => trimRoot({
      ref: refs[index]!,
      label: root.binding.workspaceLabel,
      // The device's DISPLAY label, never the selector the gateway routes on.
      sourceLabel: root.binding.deviceLabel,
      // Owner OS roots are not workspace identities and deliberately receive
      // no equality key. Registered roots keep the existing `""` coordinate.
      directoryKey: root.binding.ownerRoot ? undefined : this.keyFor(root.binding, ""),
    }));
    const projected = this.projectRoots({ roots, truncated: all.length > roots.length });
    return projected.ok
      ? { ok: true, value: projected.value }
      : workspaceFilesRefusal("unavailable", "工作区列表没有通过公开契约校验。");
  }

  /**
   * One page of a directory. `after` is the previous page's last
   * `<kind>/<label>`; every row of the answer must sort strictly after it (the
   * device sorts, this layer checks), so a page can never repeat a row.
   */
  async listDirectory(ref: string, after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesDirectoryV2>> {
    if (this.closed) return this.scopeClosed();
    if (after !== undefined && !readWorkspaceListCursor(after)) {
      return workspaceFilesRefusal("invalid_request", "这次翻页给出的目录位置无效。");
    }
    const resolved = this.vault.resolve(this.scope.scope, this.scope.owner, ref, "directory");
    if (!resolved.ok) return this.refRefusal(resolved.code);
    const { record } = resolved;

    const answer = await guard(() =>
      this.scope.backend.listEntries(record.binding, record.relativePath, this.listLimit, after));
    if (this.closed) return this.scopeClosed();
    if (!answer.ok) return workspaceFilesRefusal(answer.code, publicRefusalText(answer.code));
    if (!continuesAfter(answer.value.entries, after)) {
      return workspaceFilesRefusal("unavailable", "设备没有按位置继续列出这个目录。");
    }

    const visible = answer.value.entries.slice(0, this.listLimit);
    const addressable = visible.filter(
      (entry): entry is BackendEntry & { kind: "file" | "directory"; relativePath: string } =>
        entry.kind !== "other" && entry.relativePath !== undefined,
    );
    let refs: string[];
    try {
      refs = this.vault.mintMany(addressable.map((entry) => ({
        scope: this.scope.scope,
        owner: this.scope.owner,
        kind: entry.kind,
        binding: record.binding,
        relativePath: entry.relativePath,
        label: entry.name,
      })));
    } catch (err) {
      if (err instanceof WorkspaceRefLimitError) return this.refCapacity();
      throw err;
    }
    let refIndex = 0;
    const entries: WorkspaceFilesEntryV2[] = [];
    for (const entry of visible) {
      if (entry.kind === "other" || entry.relativePath === undefined) {
        // No ref: a symlink or a device node is reported, and unaddressable.
        entries.push(trimEntry({ label: entry.name, kind: "other" }));
        continue;
      }
      const projected: {
        ref: string;
        label: string;
        kind: "file" | "directory";
        sizeBytes?: number;
        modifiedAt?: string;
        exceedsTextLimit?: boolean;
        directoryKey?: string;
      } = {
        ref: refs[refIndex++]!,
        label: entry.name,
        kind: entry.kind,
      };
      if (entry.sizeBytes !== undefined) projected.sizeBytes = entry.sizeBytes;
      if (entry.modifiedAt !== undefined) projected.modifiedAt = entry.modifiedAt;
      if (entry.kind === "file" && entry.sizeBytes !== undefined) {
        projected.exceedsTextLimit = entry.sizeBytes > WORKSPACE_FILES_LIMITS.wholeTextBytes;
      }
      // Only a directory. A key on a file would invite a consumer to join a
      // file row against a directory row, and the v2 reader refuses one there.
      if (entry.kind === "directory") {
        projected.directoryKey = this.keyFor(record.binding, entry.relativePath);
      }
      entries.push(trimEntry(projected));
    }
    const projected = this.projectDirectory(dropUndefined({
      ref,
      label: record.label,
      entries,
      truncated: answer.value.truncated || answer.value.entries.length > visible.length,
      // The listed directory's own key, so a consumer holding a session's key
      // can recognise the listing it is looking at without walking its parent.
      directoryKey: this.keyFor(record.binding, record.relativePath),
    }));
    return projected.ok
      ? { ok: true, value: projected.value }
      : workspaceFilesRefusal("unavailable", "目录列表没有通过公开契约校验。");
  }

  /**
   * Owner links bind a session/file reference before addressing a path. No
   * root inventory or ancestor listings participate in this read authority.
   * The same vault and streams serve the resolved file; shared scopes lack
   * this seam and continue through their narrowed workspace grant.
   */
  async resolveFileLink(input: WorkspaceFileLink): Promise<WorkspaceFilesReply<WorkspaceResolvedFileLink>> {
    if (this.closed) return this.scopeClosed();
    const problem = workspaceFileLinkProblem(input);
    if (problem) return workspaceFilesRefusal("invalid_request", problem);
    if (!this.scope.ownerFileTarget) return workspaceFilesRefusal("denied", "当前访问仅允许已授权的工作区文件。");
    let binding: WorkspaceBinding;
    let entry: BackendEntry;
    if (input.sessionRef !== undefined) {
      const target = this.scope.ownerFileTarget(input.sessionRef);
      if (!target || !this.scope.backend.resolveOwnerFile) return workspaceFilesRefusal("denied", "无法使用这个会话定位本人文件。");
      const answer = await guard(() => this.scope.backend.resolveOwnerFile!(target, input.href));
      if (this.closed) return this.scopeClosed();
      if (!answer.ok) return workspaceFilesRefusal(answer.code, publicRefusalText(answer.code));
      ({ binding, entry } = answer.value);
    } else {
      const source = this.vault.resolve(this.scope.scope, this.scope.owner, input.fileRef!, "file");
      if (!source.ok) return this.refRefusal(source.code);
      binding = source.record.binding;
      if (binding.ownerRoot && this.scope.backend.statOwnerFile) {
        const absolute = path.posix.resolve(path.posix.dirname(source.record.relativePath), input.href);
        const answer = await guard(() => this.scope.backend.statOwnerFile!(binding, absolute));
        if (this.closed) return this.scopeClosed();
        if (!answer.ok) return workspaceFilesRefusal(answer.code, publicRefusalText(answer.code));
        entry = answer.value;
      } else if (this.scope.backend.resolveOwnerFile) {
        const href = path.posix.isAbsolute(input.href) ? input.href
          : path.posix.join(path.posix.dirname(source.record.relativePath), input.href);
        const answer = await guard(() => this.scope.backend.resolveOwnerFile!({ device: binding.device,
          workspaceId: binding.workspaceId, source: "", id: "" }, href));
        if (this.closed) return this.scopeClosed();
        if (!answer.ok) return workspaceFilesRefusal(answer.code, publicRefusalText(answer.code));
        ({ binding, entry } = answer.value);
      } else return workspaceFilesRefusal("unavailable", "文件链接解析暂不可用。");
    }
    const labels = entry.relativePath?.split("/").filter(Boolean) ?? [];
    if (!binding.ownerRoot || workspaceResolveLabelsProblem(labels)) return workspaceFilesRefusal("invalid_request", "文件路径超出了链接解析范围。");
    let base: string;
    try {
      base = this.vault.mintMany([{ scope: this.scope.scope, owner: this.scope.owner, kind: "directory",
        binding, relativePath: "/", label: "/" }])[0]!;
    } catch (error) {
      if (error instanceof WorkspaceRefLimitError) return this.refCapacity();
      throw error;
    }
    const resolved = this.mintResolvedEntry(base, labels, binding, entry);
    return resolved.ok ? { ok: true, value: { source: input.sessionRef ?? input.fileRef!, href: input.href,
      entry: resolved.value, root: trimRoot({ ref: base, label: "/", sourceLabel: binding.deviceLabel }) } } : resolved;
  }

  private mintResolvedEntry(base: string, labels: readonly string[], binding: WorkspaceBinding, entry: BackendEntry): WorkspaceFilesReply<WorkspaceResolvedEntry> {
    if (entry.kind === "other" || entry.relativePath === undefined) return workspaceFilesRefusal("not_a_file", "该路径不是普通文件或目录。");
    try {
      const ref = this.vault.mintMany([{ scope: this.scope.scope, owner: this.scope.owner,
        kind: entry.kind, binding, relativePath: entry.relativePath, label: entry.name }])[0]!;
      const value = readWorkspaceResolvedEntry({ base, path: labels.join("/"), ref, label: entry.name, kind: entry.kind,
        ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes,
          ...(entry.kind === "file" ? { exceedsTextLimit: entry.sizeBytes > WORKSPACE_FILES_LIMITS.wholeTextBytes } : {}) }) });
      return value.ok ? { ok: true, value: value.value } : workspaceFilesRefusal("unavailable", "文件解析结果无效。");
    } catch (error) {
      if (error instanceof WorkspaceRefLimitError) return this.refCapacity();
      throw error;
    }
  }

  /** Owner refs use stat; registered workspace refs retain the scoped listing walk. */
  async resolvePath(
    ref: string,
    labels: readonly string[],
  ): Promise<WorkspaceFilesReply<WorkspaceResolvedEntry>> {
    if (this.closed) return this.scopeClosed();
    const problem = workspaceResolveLabelsProblem(labels);
    if (problem) return workspaceFilesRefusal("invalid_request", problem);
    const resolved = this.vault.resolve(this.scope.scope, this.scope.owner, ref, "directory");
    if (!resolved.ok) return this.refRefusal(resolved.code);
    const { record } = resolved;

    if (record.binding.ownerRoot && this.scope.backend.statOwnerFile) {
      const absolute = path.posix.join(record.relativePath, ...labels);
      const answer = await guard(() => this.scope.backend.statOwnerFile!(record.binding, absolute));
      if (this.closed) return this.scopeClosed();
      return answer.ok ? this.mintResolvedEntry(ref, labels, record.binding, answer.value)
        : workspaceFilesRefusal(answer.code, publicRefusalText(answer.code));
    }

    let at = record.relativePath;
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index]!;
      // Page until the label appears or the directory ends: a name past the
      // first page is still a name in this directory.
      let entry: BackendEntry | undefined;
      let after: string | undefined;
      for (;;) {
        const page = after;
        const answer = await guard(() =>
          this.scope.backend.listEntries(record.binding, at, this.listLimit, page));
        if (this.closed) return this.scopeClosed();
        if (!answer.ok) return workspaceFilesRefusal(answer.code, publicRefusalText(answer.code));
        if (!continuesAfter(answer.value.entries, page)) {
          return workspaceFilesRefusal("unavailable", "设备没有按位置继续列出这个目录。");
        }
        entry = answer.value.entries.find((row) => row.name === label);
        const last = answer.value.entries.at(-1);
        if (entry || !answer.value.truncated || !last) break;
        after = workspaceListCursor({ kind: last.kind, label: last.name });
      }
      if (!entry) {
        // The label is the View's own claim, echoed back bounded — the same
        // string a chat rendered as a link, never a canonical path.
        return workspaceFilesRefusal("not_found", `路径不存在或不可见：${label}`);
      }
      if (index < labels.length - 1) {
        if (entry.kind !== "directory" || entry.relativePath === undefined) {
          return workspaceFilesRefusal("not_a_directory", `${label} 不是可进入的目录。`);
        }
        at = entry.relativePath;
        continue;
      }
      if (entry.kind === "other" || entry.relativePath === undefined) {
        return workspaceFilesRefusal("not_a_file", "该路径不是可打开的文本文件。");
      }
      let minted: string;
      try {
        minted = this.vault.mintMany([{
          scope: this.scope.scope,
          owner: this.scope.owner,
          kind: entry.kind,
          binding: record.binding,
          relativePath: entry.relativePath,
          label: entry.name,
        }])[0]!;
      } catch (err) {
        if (err instanceof WorkspaceRefLimitError) return this.refCapacity();
        throw err;
      }
      const row: {
        base: string;
        path: string;
        ref: string;
        label: string;
        kind: "file" | "directory";
        sizeBytes?: number;
        exceedsTextLimit?: boolean;
      } = { base: ref, path: labels.join("/"), ref: minted, label: entry.name, kind: entry.kind };
      if (entry.sizeBytes !== undefined) row.sizeBytes = entry.sizeBytes;
      if (entry.kind === "file" && entry.sizeBytes !== undefined) {
        row.exceedsTextLimit = entry.sizeBytes > WORKSPACE_FILES_LIMITS.wholeTextBytes;
      }
      const projected = readWorkspaceResolvedEntry(dropUndefined(row));
      return projected.ok
        ? { ok: true, value: projected.value }
        : workspaceFilesRefusal("unavailable", "解析结果没有通过公开契约校验。");
    }
    // Unreachable: the validator refused an empty label list above.
    return workspaceFilesRefusal("invalid_request", "这次解析没有给出要查找的路径。");
  }

  async openText(ref: string): Promise<WorkspaceFilesReply<WorkspaceTextOpen>> {
    const opened = await this.openTextForTransport(ref);
    if (!opened.ok) return opened;
    // The handle is dropped, not hidden: the contract's own method answers
    // exactly what the contract declares, and an in-process consumer holds the
    // object. There is one implementation, so the two faces cannot diverge.
    return { ok: true, value: { document: opened.value.document, stream: opened.value.stream } };
  }

  async openMedia(ref: string): Promise<WorkspaceMediaReply<WorkspaceMediaOpen>> {
    const opened = await this.openMediaForTransport(ref);
    if (!opened.ok) return opened;
    return { ok: true, value: { document: opened.value.document, stream: opened.value.stream } };
  }

  async downloadFile(ref: string): Promise<WorkspaceDownloadReply<WorkspaceDownloadOpen>> {
    const opened = await this.openDownloadForTransport(ref);
    if (!opened.ok) return opened;
    return { ok: true, value: { document: opened.value.document, stream: opened.value.stream } };
  }

  /**
   * Replace one file's whole content in one call, if it is still the version
   * the caller had. See `writeTarget` for the order every write starts with;
   * a text larger than one call is a staged upload (the three methods below).
   */
  async replaceText(
    ref: string,
    input: WorkspaceReplaceTextInput,
  ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>> {
    const target = this.writeTarget(ref);
    if (!target.ok) return target;
    const { record } = target.value;

    const expectedDigest = input?.expectedDigest;
    if (!isWorkspaceContentDigest(expectedDigest)) {
      return workspaceFilesRefusal("invalid_request", "这次改写没有给出这次编辑所基于的文件摘要。");
    }
    const text = input?.text;
    if (typeof text !== "string") {
      return workspaceFilesRefusal("invalid_request", "这次改写没有给出新的文件内容。");
    }
    const sizeBytes = Buffer.byteLength(text, "utf8");
    // Refused here rather than on the device, so the size a person is asked to
    // approve is a size that could actually be written. One call carries one
    // window; a larger text is a staged upload, not a refusal of the file.
    if (sizeBytes > WORKSPACE_FILES_LIMITS.maxWriteTextBytes) {
      return workspaceFilesRefusal("too_large", ONE_CALL_TOO_LARGE);
    }

    const answer = await guard(() =>
      this.scope.backend.replaceText!(record.binding, record.relativePath, expectedDigest, text));
    if (this.closed) return this.scopeClosed();
    if (!answer.ok) return this.writeRefusal(answer.code);
    return this.receiptFor(ref, answer.value, expectedDigest, sizeBytes);
  }

  /**
   * Begin a staged replacement: the trusted side mints the upload token, and
   * the device stages under a key derived from it AND this scope — so a token
   * presented in any other scope addresses nothing on the device.
   */
  async beginTextUpload(
    ref: string,
    input: { expectedDigest: string },
  ): Promise<WorkspaceFilesReply<WorkspaceTextUpload>> {
    const target = this.writeTarget(ref, true);
    if (!target.ok) return target;
    const { record } = target.value;
    const expectedDigest = input?.expectedDigest;
    if (!isWorkspaceContentDigest(expectedDigest)) {
      return workspaceFilesRefusal("invalid_request", "这次分段保存没有给出这次编辑所基于的文件摘要。");
    }
    const upload = randomBytes(16).toString("hex");
    const answer = await guard(() => this.scope.backend.stageText!(record.binding, record.relativePath, {
      stage: "begin",
      uploadId: this.deviceUploadId(upload),
      expectedDigest,
    }));
    if (this.closed) return this.scopeClosed();
    if (!answer.ok) return this.writeRefusal(answer.code, true);
    if (answer.value.sizeBytes !== 0) {
      return workspaceFilesRefusal("unavailable", STAGED_UNAVAILABLE);
    }
    return this.uploadReply(upload, 0);
  }

  async appendTextUpload(
    ref: string,
    input: { upload: string; offset: number; text: string },
  ): Promise<WorkspaceFilesReply<WorkspaceTextUpload>> {
    const target = this.writeTarget(ref, true);
    if (!target.ok) return target;
    const { record } = target.value;
    const { upload, offset, text } = input ?? {};
    if (!isWorkspaceTextUploadToken(upload) || !Number.isSafeInteger(offset) || offset < 0) {
      return workspaceFilesRefusal("invalid_request", "这次分段保存没有给出有效的令牌或位置。");
    }
    if (typeof text !== "string") {
      return workspaceFilesRefusal("invalid_request", "这次分段保存没有给出这一段的内容。");
    }
    if (Buffer.byteLength(text, "utf8") > WORKSPACE_FILES_LIMITS.maxWriteTextBytes) {
      return workspaceFilesRefusal("too_large", ONE_CALL_TOO_LARGE);
    }
    const answer = await guard(() => this.scope.backend.stageText!(record.binding, record.relativePath, {
      stage: "append",
      uploadId: this.deviceUploadId(upload),
      offset,
      text,
    }));
    if (this.closed) return this.scopeClosed();
    if (!answer.ok) return this.writeRefusal(answer.code, true);
    const expected = offset + Buffer.byteLength(text, "utf8");
    if (answer.value.sizeBytes !== expected) return workspaceFilesRefusal("unavailable", STAGED_UNAVAILABLE);
    return this.uploadReply(upload, expected);
  }

  async commitTextUpload(
    ref: string,
    input: { upload: string; expectedDigest: string; sizeBytes: number },
  ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>> {
    const target = this.writeTarget(ref, true);
    if (!target.ok) return target;
    const { record } = target.value;
    const { upload, expectedDigest, sizeBytes } = input ?? {};
    if (
      !isWorkspaceTextUploadToken(upload)
      || !isWorkspaceContentDigest(expectedDigest)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 0
    ) {
      return workspaceFilesRefusal("invalid_request", "这次分段保存的提交缺少令牌、文件摘要或总长度。");
    }
    const answer = await guard(() => this.scope.backend.commitStagedText!(
      record.binding,
      record.relativePath,
      this.deviceUploadId(upload),
      expectedDigest,
      sizeBytes,
    ));
    if (this.closed) return this.scopeClosed();
    if (!answer.ok) return this.writeRefusal(answer.code, true);
    return this.receiptFor(ref, answer.value, expectedDigest, sizeBytes);
  }

  /**
   * The order every write starts with, and what each step alone is enough for:
   *
   *   1. scope closed?                    nothing happens after a scope ends
   *   2. does this scope write at all?     `read_only`, no frame, no card
   *   3. does the ref resolve, as a FILE?  a forged/foreign/wrong-kind ref stops
   *                                        here, exactly as it does for a read
   *   4. may this scope write THAT file?   workspace and owner-root writes are
   *                                        separate authorities
   *
   * Then the caller checks its request is well formed, the device decides
   * (Gate, then compare-and-swap) and the adapter checks the answer describes
   * THIS request. Every step before the device refuses before any frame exists
   * — which matters more for a write than for a read, since each would
   * otherwise become an approval card for an edit that was never going to be
   * applied.
   */
  private writeTarget(
    ref: string,
    staged = false,
  ): WorkspaceFilesReply<{ record: { binding: WorkspaceBinding; relativePath: string } }> {
    if (this.closed) return this.scopeClosed();
    const backend = this.scope.backend;
    const canWrite = staged
      ? typeof backend.stageText === "function" && typeof backend.commitStagedText === "function"
      : typeof backend.replaceText === "function";
    if ((!this.scope.writable && !this.scope.ownerFilesWritable) || !canWrite) {
      return workspaceFilesRefusal("read_only", publicRefusalText("read_only"));
    }
    const resolved = this.vault.resolve(this.scope.scope, this.scope.owner, ref, "file");
    if (!resolved.ok) return this.refRefusal(resolved.code);
    const { record } = resolved;
    const writable = record.binding.ownerRoot ? this.scope.ownerFilesWritable : this.scope.writable;
    if (!writable) return workspaceFilesRefusal("read_only", publicRefusalText("read_only"));
    return { ok: true, value: { record } };
  }

  /** This scope's device-side key for an upload token. Never projected. */
  private deviceUploadId(upload: string): string {
    return createHash("sha256").update(`${this.scope.scope}\u0000${this.scope.owner}\u0000${upload}`).digest("hex").slice(0, 32);
  }

  private uploadReply(upload: string, sizeBytes: number): WorkspaceFilesReply<WorkspaceTextUpload> {
    const read = readWorkspaceTextUpload({ upload, sizeBytes });
    return read.ok ? { ok: true, value: read.value } : workspaceFilesRefusal("unavailable", STAGED_UNAVAILABLE);
  }

  /**
   * A write refusal in a person's words. `too_large` on a write is the Gate's
   * per-call bound (never a file-size verdict), and `unavailable` during a
   * staged save covers what a person can act on: retry, or upgrade an older
   * Runner that does not stage.
   */
  private writeRefusal<T>(code: WorkspaceFilesRefusalCode, staged = false): WorkspaceFilesReply<T> {
    if (code === "too_large") return workspaceFilesRefusal(code, ONE_CALL_TOO_LARGE);
    if (staged && code === "unavailable") return workspaceFilesRefusal(code, STAGED_UNAVAILABLE);
    return workspaceFilesRefusal(code, publicRefusalText(code));
  }

  /**
   * Mint the receipt for one committed replacement — one-call or staged.
   *
   * The adapter checks the device's answer too. It is repeated because this is
   * the layer that mints the receipt, and a receipt is the sentence a person
   * reads as "saved" — it must not be constructible from an answer about
   * something else even if a future backend forgets.
   */
  private receiptFor(
    ref: string,
    mutation: BackendMutation,
    expectedDigest: string,
    sizeBytes: number,
  ): WorkspaceFilesReply<WorkspaceMutationReceipt> {
    if (
      mutation.previousDigest !== expectedDigest
      || mutation.sizeBytes !== sizeBytes
      || !isWorkspaceContentDigest(mutation.digest)
    ) {
      return workspaceFilesRefusal("unavailable", "设备的写入回执与本次提交不一致，无法确认这次改写。");
    }
    const projected = readWorkspaceMutationReceipt({
      ref,
      // Minted here, once per committed mutation. It names nothing on a device
      // and is not derived from the content: it exists so a later ledger, an
      // activity feed or an audit line has something stable to point at.
      mutationId: randomBytes(16).toString("hex"),
      operation: "replace_text" as const,
      beforeDigest: mutation.previousDigest,
      afterDigest: mutation.digest,
      sizeBytes: mutation.sizeBytes,
      committedAt: mutation.modifiedAt,
      // No preimage is retained anywhere on this path, so there is nothing to
      // undo with. Saying `unsupported` is what keeps a UI from offering a
      // button that would have to lie.
      undo: "unsupported" as const,
    });
    return projected.ok
      ? { ok: true, value: projected.value }
      : workspaceFilesRefusal("unavailable", "写入回执没有通过公开契约校验。");
  }

  async pullStream(handle: string, seq: number): Promise<ResourceStreamRead<unknown>> {
    if (this.closed) {
      return { kind: "refused", code: "cancelled", message: "这个视图的会话已经结束。" };
    }
    return await this.broker.pull(this.scope.scope, handle, seq);
  }

  async closeStream(handle: string): Promise<boolean> {
    return await this.broker.close(this.scope.scope, handle);
  }

  async readTextWindow(ref: string, offset: number, maxBytes = this.chunkBytes): Promise<WorkspaceFilesReply<WorkspaceTextWindow>> {
    if (this.closed) return this.scopeClosed();
    const resolved = this.vault.resolve(this.scope.scope, this.scope.owner, ref, "file");
    if (!resolved.ok) return this.refRefusal(resolved.code);
    const { record } = resolved;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      return workspaceFilesRefusal("invalid_request", "offset 必须是上一次回答的 next_offset（从 0 开始）。");
    }
    const window = Math.min(maxBytes, this.chunkBytes);
    const read = await guard(() => this.scope.backend.readText(record.binding, record.relativePath, offset, window));
    if (this.closed) return this.scopeClosed();
    if (!read.ok) return workspaceFilesRefusal(read.code, publicRefusalText(read.code));
    if (!validTextWindow(read.value, offset, window)) {
      return workspaceFilesRefusal("unavailable", "设备返回了无法识别的文件窗口。");
    }
    const document = readWorkspaceTextDocument({
      ref,
      label: record.label,
      mediaType: WORKSPACE_TEXT_MEDIA_TYPE,
      sizeBytes: read.value.sizeBytes,
      digest: read.value.digest,
      modifiedAt: read.value.modifiedAt,
    });
    if (!document.ok) return workspaceFilesRefusal("unavailable", "文件信息没有通过公开契约校验。");
    const { bytes, eof, text } = read.value;
    return { ok: true, value: { document: document.value, offset, bytes, nextOffset: offset + bytes, eof, text } };
  }

  async openTextForTransport(
    ref: string,
  ): Promise<WorkspaceFilesReply<WorkspaceTextOpen & { handle: string }>> {
    if (this.closed) return this.scopeClosed();
    const resolved = this.vault.resolve(this.scope.scope, this.scope.owner, ref, "file");
    if (!resolved.ok) return this.refRefusal(resolved.code);
    const { record } = resolved;

    const first = await guard(() =>
      this.scope.backend.readText(record.binding, record.relativePath, 0, this.chunkBytes));
    if (this.closed) return this.scopeClosed();
    if (!first.ok) return workspaceFilesRefusal(first.code, publicRefusalText(first.code));
    if (!validTextWindow(first.value, 0, this.chunkBytes)) {
      return workspaceFilesRefusal("unavailable", "设备返回了无法识别的文件窗口。");
    }

    const document = readWorkspaceTextDocument({
      ref,
      label: record.label,
      mediaType: WORKSPACE_TEXT_MEDIA_TYPE,
      sizeBytes: first.value.sizeBytes,
      digest: first.value.digest,
      modifiedAt: first.value.modifiedAt,
    });
    if (!document.ok) {
      return workspaceFilesRefusal("unavailable", "文件信息没有通过公开契约校验。");
    }

    const source = new WorkspaceTextSource(
      this.scope.backend,
      record.binding,
      record.relativePath,
      this.chunkBytes,
      first.value,
    );
    const opened = this.broker.open<WorkspaceTextChunk>(this.scope.scope, source, {
      maxChunkBytes: WORKSPACE_FILES_LIMITS.textChunkBytes,
      maxStreamBytes: WORKSPACE_FILES_LIMITS.maxTextBytes,
    });
    if (!opened.ok) {
      source.close();
      return workspaceFilesRefusal("unavailable", "同时打开的文件太多了，先关掉一个再试。");
    }

    return {
      ok: true,
      value: {
        document: document.value,
        stream: opened.stream,
        handle: opened.handle,
      },
    };
  }

  async openMediaForTransport(
    ref: string,
  ): Promise<WorkspaceMediaReply<WorkspaceMediaOpen & { handle: string }>> {
    if (this.closed) {
      return workspaceMediaRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
    }
    const readBinary = this.scope.backend.readBinary;
    if (!readBinary) return workspaceMediaRefusal("unsupported_media", "当前设备不支持图片或 PDF 预览。");
    const resolved = this.vault.resolve(this.scope.scope, this.scope.owner, ref, "file");
    if (!resolved.ok) {
      return resolved.code === "wrong_kind"
        ? workspaceMediaRefusal("wrong_kind", "这个引用指向的不是文件。")
        : workspaceMediaRefusal("unknown_ref", "这个引用不属于当前视图。");
    }
    const { record } = resolved;
    const chunkBytes = Math.min(this.chunkBytes, WORKSPACE_MEDIA_LIMITS.chunkBytes);
    const first = await guard(() =>
      readBinary.call(this.scope.backend, record.binding, record.relativePath, 0, chunkBytes));
    if (this.closed) {
      return workspaceMediaRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
    }
    if (!first.ok) return workspaceMediaRefusal(first.code, publicRefusalText(first.code));
    if (!validBinaryWindow(first.value, 0, chunkBytes)) {
      return workspaceMediaRefusal("unavailable", "设备返回了无法识别的媒体窗口。");
    }
    const mediaType = sniffWorkspaceMediaType(first.value.data);
    if (!mediaType || !isWorkspaceMediaType(mediaType)) {
      return workspaceMediaRefusal("unsupported_media", "当前只预览 PNG、JPEG、GIF、WebP 和 PDF。");
    }
    const document = readWorkspaceMediaDocument({
      ref,
      label: record.label,
      mediaType,
      sizeBytes: first.value.sizeBytes,
      digest: first.value.digest,
      modifiedAt: first.value.modifiedAt,
    });
    if (!document.ok) {
      return workspaceMediaRefusal("unavailable", "媒体文件信息没有通过公开契约校验。");
    }
    const source = new WorkspaceBinarySource(
      this.scope.backend,
      readBinary,
      record.binding,
      record.relativePath,
      chunkBytes,
      first.value,
      WORKSPACE_MEDIA_CHUNK_PAYLOAD,
      mediaType,
    );
    const opened = this.broker.open<WorkspaceMediaChunk>(this.scope.scope, source, {
      maxChunkBytes: WORKSPACE_MEDIA_LIMITS.chunkBytes,
      maxStreamBytes: WORKSPACE_MEDIA_LIMITS.maxBytes,
    });
    if (!opened.ok) {
      source.close();
      return workspaceMediaRefusal("unavailable", "同时打开的文件太多了，先关掉一个再试。");
    }
    return {
      ok: true,
      value: {
        document: document.value,
        stream: opened.stream,
        handle: opened.handle,
      },
    };
  }

  async openDownloadForTransport(
    ref: string,
  ): Promise<WorkspaceDownloadReply<WorkspaceDownloadOpen & { handle: string }>> {
    if (this.closed) {
      return workspaceDownloadRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
    }
    const downloadBinary = this.scope.backend.downloadBinary;
    if (!downloadBinary) return workspaceDownloadRefusal("unavailable", "当前设备不支持文件下载。");
    const resolved = this.vault.resolve(this.scope.scope, this.scope.owner, ref, "file");
    if (!resolved.ok) {
      return resolved.code === "wrong_kind"
        ? workspaceDownloadRefusal("wrong_kind", "这个引用指向的不是文件。")
        : workspaceDownloadRefusal("unknown_ref", "这个引用不属于当前视图。");
    }
    const { record } = resolved;
    const chunkBytes = Math.min(this.chunkBytes, WORKSPACE_DOWNLOAD_LIMITS.chunkBytes);
    const first = await guard(() =>
      downloadBinary.call(this.scope.backend, record.binding, record.relativePath, 0, chunkBytes));
    if (this.closed) {
      return workspaceDownloadRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
    }
    if (!first.ok) return workspaceDownloadRefusal(first.code, publicRefusalText(first.code));
    if (!validBinaryWindow(first.value, 0, chunkBytes)) {
      return workspaceDownloadRefusal("unavailable", "设备返回了无法识别的二进制文件窗口。");
    }
    const document = readWorkspaceDownloadDocument({
      ref,
      label: record.label,
      mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE,
      sizeBytes: first.value.sizeBytes,
      digest: first.value.digest,
      modifiedAt: first.value.modifiedAt,
    });
    if (!document.ok) {
      return workspaceDownloadRefusal("unavailable", "下载文件信息没有通过公开契约校验。");
    }
    const source = new WorkspaceBinarySource(
      this.scope.backend,
      downloadBinary,
      record.binding,
      record.relativePath,
      chunkBytes,
      first.value,
      WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
      WORKSPACE_DOWNLOAD_MEDIA_TYPE,
    );
    const opened = this.broker.open<WorkspaceDownloadChunk>(this.scope.scope, source, {
      maxChunkBytes: WORKSPACE_DOWNLOAD_LIMITS.chunkBytes,
      maxStreamBytes: WORKSPACE_DOWNLOAD_LIMITS.maxBytes,
    });
    if (!opened.ok) {
      source.close();
      return workspaceDownloadRefusal("unavailable", "同时打开的文件太多了，先关掉一个再试。");
    }
    return {
      ok: true,
      value: {
        document: document.value,
        stream: opened.stream,
        handle: opened.handle,
      },
    };
  }

  private scopeClosed<T>(): WorkspaceFilesReply<T> {
    return workspaceFilesRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
  }

  private refRefusal<T>(code: "unknown_ref" | "wrong_kind"): WorkspaceFilesReply<T> {
    return code === "wrong_kind"
      ? workspaceFilesRefusal("wrong_kind", "这个引用指向的不是要打开的那类资源。")
      : workspaceFilesRefusal("unknown_ref", "这个引用不属于当前视图。");
  }

  private refCapacity<T>(): WorkspaceFilesReply<T> {
    return workspaceFilesRefusal("unavailable", "这个视图可持有的文件引用已达到上限，请刷新或重新打开。");
  }
}

/**
 * A backend that throws is a bug, and it still must not reach the consumer.
 *
 * Every method of this port promises to resolve, and an exception on this path
 * is the one thing that reliably carries a canonical path out of the trusted
 * side — Node's own `fs` errors are built that way. So the error object is
 * dropped rather than formatted, and the caller gets the same bounded answer it
 * would get from an unreachable device.
 */
async function guard<T>(call: () => Promise<BackendResult<T>>): Promise<BackendResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, code: "unavailable", message: "读取工作区时出现内部错误，本次请求没有完成。" };
  }
}

/** Does every row of a page sort strictly after the cursor it was asked for? */
function continuesAfter(entries: readonly BackendEntry[], after: string | undefined): boolean {
  const position = after === undefined ? null : readWorkspaceListCursor(after);
  return !position || entries.every((entry) =>
    compareWorkspaceListPositions({ kind: entry.kind, label: entry.name }, position) > 0);
}

/** The same registered workspace (or the same owner root) on the same device. */
function sameRoot(a: WorkspaceBinding, b: WorkspaceBinding): boolean {
  return a.device === b.device && a.workspaceId === b.workspaceId && (a.ownerRoot === true) === (b.ownerRoot === true);
}

/** The last index whose row matches; a duplicated root is continued after its last copy. */
function findLastIndex<T>(rows: readonly T[], match: (row: T) => boolean): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) if (match(rows[index]!)) return index;
  return -1;
}

/** Drop undefined keys so a projection carries exactly what it states. */
/**
 * Drop absent fields rather than sending `undefined` ones.
 *
 * Not cosmetic: a v1 reader refuses unknown fields by looking at the KEYS, and
 * `{directoryKey: undefined}` has that key. So a v1 scope that merely declined
 * to mint a key would fail its own projection check.
 */
function dropUndefined<T = Record<string, unknown>>(value: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as unknown as T;
}

function trimEntry(entry: Record<string, unknown>): WorkspaceFilesEntryV2 {
  return dropUndefined<WorkspaceFilesEntryV2>(entry);
}

function trimRoot(root: Record<string, unknown>): WorkspaceFilesRootV2 {
  return dropUndefined<WorkspaceFilesRootV2>(root);
}

export class WorkspaceFilesService {
  private readonly vault: WorkspaceRefVault;
  private readonly broker: ResourceStreamBroker;
  private readonly providers = new Map<string, WorkspaceFilesProvider[]>();
  private readonly closingScopes = new Map<string, Promise<{ refs: number; streams: number }>>();
  private readonly listLimit: number;
  private readonly chunkBytes: number;

  constructor(options: WorkspaceFilesServiceOptions = {}) {
    this.vault = new WorkspaceRefVault({
      maxPerScope: options.maxRefsPerScope,
      maxPerOwner: options.maxRefsPerOwner,
      maxGlobal: options.maxRefsGlobal,
    });
    this.broker = options.broker ?? new ResourceStreamBroker();
    this.listLimit = clamp(options.listLimit, 1, WORKSPACE_FILES_LIMITS.maxEntries, WORKSPACE_FILES_LIMITS.maxEntries);
    this.chunkBytes = clamp(
      options.chunkBytes,
      1,
      WORKSPACE_FILES_LIMITS.textChunkBytes,
      WORKSPACE_FILES_LIMITS.textChunkBytes,
    );
  }

  /** A port bound to one scope, one owner and one backend. */
  open(scope: WorkspaceFilesScope): WorkspaceFilesScopePort {
    const provider = new WorkspaceFilesProvider(scope, this.vault, this.broker, this.listLimit, this.chunkBytes);
    if (this.closingScopes.has(scope.scope)) {
      provider.markClosed();
      return provider;
    }
    const held = this.providers.get(scope.scope);
    if (held) held.push(provider);
    else this.providers.set(scope.scope, [provider]);
    return provider;
  }

  /** End a scope: no ref of it resolves, no stream of it produces another byte. */
  closeScope(scope: string): Promise<{ refs: number; streams: number }> {
    const existing = this.closingScopes.get(scope);
    if (existing) return existing;
    for (const provider of this.providers.get(scope) ?? []) provider.markClosed();
    this.providers.delete(scope);
    const refs = this.vault.closeScope(scope);
    const closing = this.broker.closeScope(scope).then((streams) => ({ refs, streams }));
    this.closingScopes.set(scope, closing);
    void closing.then(
      () => { if (this.closingScopes.get(scope) === closing) this.closingScopes.delete(scope); },
      () => { if (this.closingScopes.get(scope) === closing) this.closingScopes.delete(scope); },
    );
    return closing;
  }

  /** Diagnostics and tests. */
  get openStreams(): number {
    return this.broker.openStreams();
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}
