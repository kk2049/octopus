/**
 * The narrow surface a workspace-files consumer is written against.
 *
 * Four methods, and the reason they are named methods rather than one
 * `call(action, params)` is the same reason `agent-sessions/v1` made the same
 * choice: a single generic method is how a component ends up naming an operation
 * the App never meant to expose. What a consumer may ask for IS this interface.
 *
 * ── Why the write is optional and the reads are not ────────────────────────
 *
 * `replaceText` is declared `?` because "this port does not write at all" is a
 * real and common state that a consumer has to be able to see BEFORE it renders
 * a save button: a memory harness, a read-only composition, or an Agent View
 * whose transport cannot carry a file body. Its absence is the same enforcement
 * as an `other` entry having no ref — there is nothing to submit.
 *
 * That is different from a port which CAN write refusing a particular write,
 * which is `read_only` (this scope's authority covers the reads only),
 * `digest_mismatch` (somebody else changed the file) or `approval_required`.
 * Present-and-refusing and absent are two different sentences, and a UI that
 * conflated them would either hide a working button or offer a broken one.
 *
 * Every method resolves. "You do not have permission", "somebody has to approve
 * that first", "that file is 40 MB" and "that ref is not yours" are all answers
 * a person should be shown, not exceptions a component must catch — and a thrown
 * error is the one thing on this path that reliably carries a canonical path
 * across the boundary.
 *
 * `openText` hands back a header plus a `ResourceStream`, never the whole file.
 * A component that wanted the entire text at once would have to pull it itself,
 * which is exactly the bounded, cancellable behaviour this contract is for.
 */

import type { ResourceStream } from "@claude-bot/resource-stream-contract";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_LIMITS,
  type WorkspaceFilesRefusalCode,
} from "./limits.js";
import type {
  WorkspaceFilesDirectory,
  WorkspaceFilesRoots,
  WorkspaceTextChunk,
  WorkspaceTextDocument,
} from "./projection.js";
import type { WorkspaceResolvedEntry } from "./resolve.js";
import type { WorkspaceMutationReceipt, WorkspaceReplaceTextInput } from "./write.js";

export interface WorkspaceFilesRefusal {
  readonly ok: false;
  readonly code: WorkspaceFilesRefusalCode;
  /** Bounded text somebody wrote for a person to read. */
  readonly message: string;
}

export type WorkspaceFilesReply<T> = { readonly ok: true; readonly value: T } | WorkspaceFilesRefusal;

/** An opened text file: the header, and the bytes as a bounded pull stream. */
export interface WorkspaceTextOpen {
  readonly document: WorkspaceTextDocument;
  readonly stream: ResourceStream<WorkspaceTextChunk>;
}

export interface WorkspaceFilesPort {
  readonly contract: typeof WORKSPACE_FILES_CONTRACT;
  /**
   * Re-enumerate the registered workspaces this scope may see, one page at a
   * time: `after` is the last root ref of the previous page (see `paging.ts`).
   */
  refreshRoots(after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesRoots>>;
  /**
   * List one directory, named by a ref this port minted earlier, one page at a
   * time: `after` is `workspaceListCursor(last entry of the previous page)`.
   */
  listDirectory(ref: string, after?: string): Promise<WorkspaceFilesReply<WorkspaceFilesDirectory>>;
  /** Open one text file, named by a ref this port minted earlier. */
  openText(ref: string): Promise<WorkspaceFilesReply<WorkspaceTextOpen>>;
  /**
   * Resolve a descendant by child labels, in one round trip (ticket #243).
   *
   * Optional like `replaceText`, and for the same reason: "this port cannot do
   * that at all" is a real composition state (a v1 wire, a memory harness) that
   * a consumer must be able to see before choosing the per-level walk instead.
   * The trusted side still descends one listing at a time and only mints the
   * answer's ref from the final listing row; see `resolve.ts`.
   */
  resolvePath?(
    ref: string,
    labels: readonly string[],
  ): Promise<WorkspaceFilesReply<WorkspaceResolvedEntry>>;
  /**
   * Replace one existing text file's whole content, if it is still the version
   * `expectedDigest` names. Absent on a port that does not write at all.
   *
   * There is no partial success: either the receipt describes a file that now
   * holds exactly `text`, or nothing was written.
   */
  replaceText?(
    ref: string,
    input: WorkspaceReplaceTextInput,
  ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>>;
}

/** A port that is known to write, for a consumer that has already checked. */
export interface WorkspaceFilesWritablePort extends WorkspaceFilesPort {
  replaceText(
    ref: string,
    input: WorkspaceReplaceTextInput,
  ): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>>;
}

/**
 * Does this port offer writes at all?
 *
 * One named predicate rather than `typeof port.replaceText === "function"`
 * scattered around: a consumer asking "can I save?" is asking a question about
 * the composition, and it should read like one.
 *
 * Generic so a consumer holding either version's port (the v1/v2 union) may
 * ask; for a plain `WorkspaceFilesPort` the answer narrows to
 * `WorkspaceFilesWritablePort` exactly as before.
 */
export function workspaceFilesCanWrite<P extends Pick<WorkspaceFilesPort, "replaceText">>(
  port: P,
): port is P & Pick<WorkspaceFilesWritablePort, "replaceText"> {
  return typeof port.replaceText === "function";
}

/** Build a refusal with its text bounded the same way everywhere. */
export function workspaceFilesRefusal(
  code: WorkspaceFilesRefusalCode,
  message: string,
): WorkspaceFilesRefusal {
  return Object.freeze({
    ok: false as const,
    code,
    message: message
      .replace(/[\u0000-\u001f\u007f]/g, "\uFFFD")
      .slice(0, WORKSPACE_FILES_LIMITS.maxMessageLength),
  });
}
