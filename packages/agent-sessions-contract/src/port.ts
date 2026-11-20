/**
 * The typed port a sessions module is bound to.
 *
 * ── What the port is for ────────────────────────────────────────────────────
 *
 * It is the whole reason a chat, a roster and a search box can be reused: they
 * take a `SessionsPort` and nothing else. They do not know whether the other
 * side is a MessagePort to a trusted coordinator, an in-memory fixture, or some
 * future adapter — and they cannot find out, because the port has no method that
 * would tell them.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 *
 * No owner, no username, no app or scope id, no instance handle, no grant, no
 * capability, no context id, no canonical path, no cookie, no URL. Not filtered
 * — ABSENT. A hook that returned any of them could only invent it, and inventing
 * an identity is the one failure this whole architecture is arranged to prevent.
 *
 * ── Why proposals return a reply instead of throwing ────────────────────────
 *
 * "The trusted side said no" is an answer, not an exception. Every method
 * resolves; a refusal carries bounded text somebody wrote for a person to read,
 * and the module's job is to show it, not to retry it.
 */

import type { FileAnnotation, SessionsProjection } from "./projection.js";
import type { AgentPermissionProfile } from "./actions.js";

/** Whether there is a channel at all. Never an error state — see the header. */
export type SessionsPhase = "waiting" | "open" | "closed";

/** Evidence of input delivery, independent of the provider turn's completion. */
export interface SessionInputReceipt {
  phase: "dispatched" | "local_queued" | "provider_accepted" | "input_observed";
  /** `transcript`: the provider recorded the input in its own session transcript. */
  evidence: "terminal_write" | "local_queue" | "provider_ack" | "native_hook" | "provider_completion" | "launch_identity" | "transcript";
  at: string;
  sessionId?: string;
  turnId?: string;
  transport?: string;
  controlAction?: string;
}

/** One submission's lifecycle, as the trusted coordinator writes it. */
export interface SessionOperation {
  id?: string;
  status?: string;
  /** A raw terminal write alone is not proof that the provider consumed the input. */
  input?: SessionInputReceipt;
  /** Observation of the original input continues; this never authorizes re-send. */
  recovery?: { state: "reconnecting" | "waiting_resource"; since: string; retry_at: string | null };
  /** The WORDING is the server's: what "unknown" means is its statement. */
  message?: string;
  detail?: string;
  operation?: string;
  resourceId?: string;
  sessionId?: string;
  /** Opaque session resource minted by the trusted Host after a start or provider replacement succeeds. */
  newResourceId?: string;
}

/** A receipt's terminal reading of one operation; see `operationOutcomePhase`. */
export type OperationOutcomePhase = "succeeded" | "refused" | "failed" | "uncertain";

/**
 * The one mapping from an operation status to what a receipt the person is
 * watching should say about it. Every receipt that follows a `SessionOperation`
 * (a send, a stop, a launch, a control release) reads it from here.
 *
 * `unknown` is a finished outcome of its own: the effect may have happened and
 * nothing will replay it, so it is neither a failure ("it did not happen") nor
 * a wait. It reads `uncertain` everywhere. `rejected` is a definite refusal.
 * Anything still in flight, or a status this build does not know, is `null`:
 * the caller keeps its own in-flight phase.
 */
export function operationOutcomePhase(status: unknown): OperationOutcomePhase | null {
  switch (status) {
    case "succeeded": return "succeeded";
    case "rejected": return "refused";
    case "failed": return "failed";
    case "unknown": return "uncertain";
    default: return null;
  }
}

/**
 * The complete runtime projection allowlist for transport adapters.
 *
 * Keep this beside `SessionOperation`: adapters must not copy arbitrary
 * transport fields merely because TypeScript permits extra properties.
 */
export const SESSION_OPERATION_FIELDS = [
  "id",
  "status",
  "input",
  "recovery",
  "message",
  "detail",
  "operation",
  "resourceId",
  "sessionId",
  "newResourceId",
] as const satisfies readonly (keyof SessionOperation)[];

export interface SessionsReply {
  ok: boolean;
  code?: string;
  result?: unknown;
  /** Bounded refusal text, or "" when accepted. */
  message: string;
}

export interface SessionsSnapshot {
  phase: SessionsPhase;
  /** Replaced wholesale on every update, never merged locally. */
  projection: SessionsProjection | null;
  /** Newest first, one record per id. */
  operations: readonly SessionOperation[];
  /** The last bounded refusal, for showing a person. "" when there is none. */
  refusal: string;
}

/** What a new agent is started with. No field is an owner or credential. */
export interface StartSessionRequest {
  /** Execution machine. */
  device: string;
  /** Agent-runtime machine; omitted by old callers means colocated execution. */
  runtimeDevice?: string;
  /** Public registration id on the selected runtime; never a path or credential. */
  codexAccount?: string;
  /** Free path for colocated launches. */
  directory: string;
  /** Registered workspace evidence for a split launch. */
  workspaceId?: string;
  workspaceLabel?: string;
  workspaceDisplay?: string;
  source: string;
  model: string;
  effort: string;
  permissionProfile?: AgentPermissionProfile;
  /**
   * Start Claude in the bilingual lane: the prompt is translated to English
   * before Claude sees it and the reply is projected in both languages.
   *
   * Absent means the plain lane. It stays a launch option on the Claude
   * provider rather than a fourth `CliKind`, because the session this produces
   * IS an ordinary Claude session — the roster, the scanner and every
   * projection that names a provider must keep seeing exactly three.
   */
  translatePrompt?: boolean;
  prompt: string;
}

export interface ReadWindowRequest {
  resource: string;
  limit: number;
  /** Absent asks for the tail; a number asks for that exact page. */
  offset?: number;
}

/** One field of the block at `offset.block` (a transcript entry's anchor), from `charOffset`. */
export interface ReadBlockRequest {
  resource: string;
  offset: number;
  block: number;
  field: "text" | "input" | "output";
  charOffset: number;
}

/** The bounded answer shape shared by Claude Code and Codex interactions. */
export interface AgentInteractionResponse {
  decision: "allow" | "deny";
  answers: Record<string, string[]>;
  message?: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalSnapshot {
  terminalId: string;
  screen: string;
  closed: boolean;
}

/**
 * Everything a sessions module may ask for.
 *
 * The capability-shaped reads (`readWindow`, `refreshSessions`, `search`,
 * `listWorkspaces`) and the execute-shaped writes (`start`, `append`, `resume`,
 * `takeover`, and `fallback`) are separate methods rather than one
 * `call(action, params)`, because a generic method lets a module name an
 * operation the App never meant to expose. This interface is the complete boundary.
 */
export interface SessionsPort {
  openShare?(shareId: string): Promise<SessionsReply>;
  snapshot(): SessionsSnapshot;
  /** Subscribe to snapshot changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Clear the last refusal — e.g. because the reader started something new. */
  clearRefusal(): void;

  refreshSessions(): Promise<SessionsReply>;
  browseSessions?(request: { device: string; source: string; cursor: string }): Promise<SessionsReply>;
  /** One page of a complete search; `cursor` is a previous page's `nextCursor`. */
  search(query: string, limit: number, cursor?: string): Promise<SessionsReply>;
  readWindow(request: ReadWindowRequest): Promise<SessionsReply>;
  /**
   * One character window of one complete block a transcript page capped
   * (`truncated_fields`). Same read authority as `readWindow`; the answer is
   * `{ text, totalChars, charOffset, nextCharOffset? }` in the reply, never
   * written into the projection.
   */
  readBlock?(request: ReadBlockRequest): Promise<SessionsReply>;
  /** Release only this resource's live transcript demand; preserve the Agent, history and draft. */
  closeSession?(resource: string): Promise<SessionsReply>;
  listWorkspaces(device: string): Promise<SessionsReply>;

  start(request: StartSessionRequest): Promise<SessionsReply>;
  append(
    resource: string,
    prompt: string,
    permissionProfile?: AgentPermissionProfile,
    effort?: string,
    model?: string,
  ): Promise<SessionsReply>;
  resume(
    resource: string,
    prompt: string,
    permissionProfile?: AgentPermissionProfile,
    effort?: string,
    model?: string,
  ): Promise<SessionsReply>;
  /** Explicitly cancel a hook-observed CLI incarnation, then resume headlessly. */
  takeover(
    resource: string,
    prompt: string,
    permissionProfile?: AgentPermissionProfile,
    effort?: string,
    model?: string,
  ): Promise<SessionsReply>;
  /** Fork a Codex thread into a healthy configured account, preserving the source. */
  fallback(
    resource: string,
    prompt: string,
    permissionProfile?: AgentPermissionProfile,
    effort?: string,
    model?: string,
  ): Promise<SessionsReply>;
  /** Stop only a provider-native Octopus-managed turn. */
  interrupt(resource: string): Promise<SessionsReply>;
  /** Release one settled, Runner-owned Codex attachment whose automatic close failed. */
  releaseControl(resource: string): Promise<SessionsReply>;
  /** Answer the exact single-use interaction projected for this resource. */
  respondInteraction(
    resource: string,
    interactionId: string,
    response: AgentInteractionResponse,
  ): Promise<SessionsReply>;
  openTerminal(device: string, workspaceId: string, size: TerminalSize): Promise<SessionsReply>;
  readTerminal(device: string, terminalId: string, size: TerminalSize): Promise<SessionsReply>;
  sendTerminal(device: string, terminalId: string, input: string, size: TerminalSize): Promise<SessionsReply>;
  closeTerminal(device: string, terminalId: string): Promise<SessionsReply>;
  pin(resource: string): Promise<SessionsReply>;
  /**
   * Idempotent form of `pin`: a drop onto "favorites" must not unpin a chat
   * that already was one. Optional so older ports keep the toggle only.
   */
  setPinned?(resource: string, pinned: boolean): Promise<SessionsReply>;
  /** Create or rename one App-owned folder; the View mints the opaque id. */
  saveFolder?(folder: string, name: string): Promise<SessionsReply>;
  /** Delete one folder; its chats return to the unfiled list. */
  deleteFolder?(folder: string): Promise<SessionsReply>;
  /** Move chats into a folder, or out of every folder when `folder` is empty. */
  fileSessions?(resources: readonly string[], folder: string): Promise<SessionsReply>;
  /** Set an App-owned display title; an empty title restores the provider fallback. */
  setTitle(resource: string, title: string): Promise<SessionsReply>;
  readContinuation?(resource: string): Promise<SessionsReply>;
  saveContinuation?(resource: string, prompt: string | null, revision: string): Promise<SessionsReply>;
  /** Acknowledge the exact completed turn the user explicitly opened. */
  markReviewed(resource: string, completedAt: string): Promise<SessionsReply>;
  /**
   * Replace this file's App-owned annotation list. An empty array clears every
   * annotation for the key. The App mints `fileKey` from listing lineage and
   * the trusted side treats both fields as opaque bounded text.
   */
  setFileAnnotations(fileKey: string, annotations: readonly FileAnnotation[]): Promise<SessionsReply>;
  /**
   * Send one bounded chunk of a user-selected file to the selected session's
   * physical device. The trusted side resolves `resource`; the View never names
   * a device or destination path. The first chunk returns an opaque upload id,
   * and the final chunk returns the completed absolute `/tmp` path.
   *
   * Calls are ordered and never retried automatically. A refusal is a value,
   * like every other refusal on this port.
   */
  attachFile(input: AttachFileChunkRequest): Promise<SessionsReply>;
}

/** Re-exports for consumers assembling both the port shape and projection types. */
export type { FileAnnotation, AnnotationTarget, AnnotationTargetMarkdown, AnnotationTargetPdf } from "./projection.js";

/** One bounded chunk of a file upload crossing the frame boundary. */
export interface AttachFileChunkRequest {
  /** Existing session resource, or an explicit new-session execution target. */
  resource?: string;
  device?: string;
  workspaceId?: string;
  /** Advisory display name. The device constructs the stored file name. */
  name: string;
  /** Advisory MIME type; arbitrary files are accepted. */
  mediaType: string;
  /** Zero-based chunk position and immutable total. */
  chunkIndex: number;
  chunkCount: number;
  /** Opaque id returned by the first chunk; absent only for chunk zero. */
  uploadId?: string;
  /** Base64 for this chunk, bounded by the action declaration. */
  data: string;
}

/** What the final `attachFile` call returns in `SessionsReply.result`. */
export interface AttachedFile {
  label: string;
  path: string;
  bytes: number;
  mediaType: string;
}

/**
 * A port that can only read.
 *
 * Not a different interface — the same one, with the four writes refusing. A
 * read-only consumer therefore reuses the modules unchanged, and the modules
 * discover the limit the way they discover every other limit: a bounded refusal
 * from the other side.
 */
export const READ_ONLY_REFUSAL: SessionsReply = Object.freeze({
  ok: false,
  code: "read_only",
  result: null,
  message: "这个视图是只读的：它没有被授予任何写入或执行 operation。",
});
