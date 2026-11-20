/**
 * The trusted side's narrow seams.
 *
 * Everything the `workspace-files/v1` contract refuses to carry lives in this
 * file: the device the gateway routes on, the Runner's own `workspace_id`, and
 * the POSIX path relative to that workspace. A consumer of the contract can name
 * none of them; the provider rebinds an opaque ref into one of these on its own
 * side of the boundary and hands it to a backend.
 *
 * Two seams, because they answer two different questions:
 *
 *   WorkspaceFilesAuthority   WHICH devices may this scope address, and what
 *                             happens when it addresses one — a Gate call in
 *                             production, `handleRpc` in a harness.
 *   WorkspaceFilesBackend     WHAT a workspace read or write means, once
 *                             authority has been settled: roots, a listing, a
 *                             text window, one committed replace.
 *
 * Keeping them apart is what lets the vertical conformance harness exercise the
 * REAL Runner adapter and the REAL provider without a capability kernel, while
 * production supplies an authority that goes through one — and neither of them
 * can widen what the other decided.
 */

import type { WorkspaceFilesRefusalCode } from "@claude-bot/workspace-files-contract";

/** One machine this scope may address, plus how to name it to a person. */
export interface WorkspaceDevice {
  /**
   * The gateway's routing selector. Trusted-side only: it never appears in a
   * projection, and nothing on the port accepts one back.
   */
  device: string;
  /** Display text. May be the same string; it is used for a different purpose. */
  label: string;
}

/** What a single Gate-mediated Runner call answered. Mirrors the kernel's shape. */
export type RunnerCallOutcome =
  | { status: "succeeded"; result: unknown }
  | { status: "approval_required"; pendingCallId?: string }
  | { status: "denied"; reason?: string }
  | { status: "failed"; reason?: string };

export interface WorkspaceFilesAuthority {
  /** The devices this scope holds authority over, at this moment. */
  devices(): Promise<readonly WorkspaceDevice[]>;
  /**
   * Perform one operation against one device.
   *
   * In production this is `grant.request("resources", operation, args)` on a
   * ControllerRun derived under the App's Context, so the Gate decides. This
   * batch does not wire that up: it provides the seam and a harness that drives
   * the real Runner adapter through it.
   */
  call(device: string, operation: string, args: Record<string, unknown>): Promise<RunnerCallOutcome>;
}

/** The trusted binding an opaque ref rebinds to. Never projected. */
export interface WorkspaceBinding {
  device: string;
  /** Display label for the device. */
  deviceLabel: string;
  /** The Runner's own opaque workspace id. Device-local; never projected. */
  workspaceId: string;
  /** The workspace's own label. */
  workspaceLabel: string;
  /**
   * Owner-local OS root. When true, `workspaceId` is deliberately empty and
   * the stored path is absolute; registered-workspace bindings never set it.
   */
  ownerRoot?: true;
}

export interface BackendRoot {
  binding: WorkspaceBinding;
}

export interface OwnerFileSessionTarget {
  device: string;
  source: string;
  id: string;
  workspaceId?: string;
}

export interface BackendResolvedOwnerFile {
  binding: WorkspaceBinding;
  entry: BackendEntry;
}

export interface BackendEntry {
  name: string;
  kind: "file" | "directory" | "other";
  /** Absent for `other`, which is how a symlink stays unaddressable. */
  relativePath?: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface BackendListing {
  entries: readonly BackendEntry[];
  /** More entries follow the last one; `after` its `<kind>/<name>` reaches them. */
  truncated: boolean;
}

export interface BackendTextWindow {
  /** Size of the whole file. */
  sizeBytes: number;
  digest: string;
  modifiedAt: string;
  offset: number;
  bytes: number;
  eof: boolean;
  text: string;
}

export interface BackendBinaryWindow {
  readonly offset: number;
  /** RFC 4648 base64, without a data URL prefix. */
  readonly data: string;
  readonly bytes: number;
  readonly sizeBytes: number;
  readonly eof: boolean;
  readonly digest: string;
  readonly modifiedAt: string;
}

/**
 * What the device reported after committing one replace.
 *
 * `previousDigest` is here rather than assumed because the caller has to be able
 * to check that the device swapped the version it was ASKED to swap: a device
 * that answered with somebody else's precondition would otherwise produce a
 * receipt saying an edit was applied to a version it was not.
 */
export interface BackendMutation {
  /** Size of the whole file afterwards. */
  sizeBytes: number;
  /** Whole-file digest afterwards. */
  digest: string;
  /** The precondition the device verified, echoed. */
  previousDigest: string;
  modifiedAt: string;
}

/** One non-final step of a staged replacement (see `@claude-bot/runner/workspace-files`). */
export type BackendTextStage =
  | { stage: "begin"; uploadId: string; expectedDigest: string }
  | { stage: "append"; uploadId: string; offset: number; text: string };

/** What the device holds for a staged replacement after one step. */
export interface BackendStagedText {
  uploadId: string;
  /** Bytes staged so far: the offset the next append must name. */
  sizeBytes: number;
}

export type BackendResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: WorkspaceFilesRefusalCode; message: string };

export interface WorkspaceFilesBackend {
  resolveOwnerFile?(target: OwnerFileSessionTarget, href: string): Promise<BackendResult<BackendResolvedOwnerFile>>;
  statOwnerFile?(binding: WorkspaceBinding, absolutePath: string): Promise<BackendResult<BackendEntry>>;
  listRoots(): Promise<BackendResult<readonly BackendRoot[]>>;
  /**
   * One page of a directory. `after` is the previous page's last
   * `<kind>/<name>`; a device that does not echo it is refused as an older
   * Runner rather than trusted to have continued.
   */
  listEntries(
    binding: WorkspaceBinding,
    relativePath: string,
    limit: number,
    after?: string,
  ): Promise<BackendResult<BackendListing>>;
  readText(
    binding: WorkspaceBinding,
    relativePath: string,
    offset: number,
    maxBytes: number,
  ): Promise<BackendResult<BackendTextWindow>>;
  /** Optional until a v3 contract is bound; older v1/v2 backends remain valid. */
  readBinary?(
    binding: WorkspaceBinding,
    relativePath: string,
    offset: number,
    maxBytes: number,
  ): Promise<BackendResult<BackendBinaryWindow>>;
  /** Optional until a v4 contract is bound; every window spends the download operation. */
  downloadBinary?(
    binding: WorkspaceBinding,
    relativePath: string,
    offset: number,
    maxBytes: number,
  ): Promise<BackendResult<BackendBinaryWindow>>;
  /**
   * Replace one file's whole content, if it still hashes to `expectedDigest`.
   *
   * Optional, and its absence is a statement: a backend without it is a
   * read-only backend, and the provider answers `read_only` without inventing a
   * write path. Making it required would force every fixture and every future
   * read-only adapter to carry a stub that could only ever lie.
   */
  replaceText?(
    binding: WorkspaceBinding,
    relativePath: string,
    expectedDigest: string,
    text: string,
  ): Promise<BackendResult<BackendMutation>>;
  /**
   * `begin` or `append` of a staged replacement: the same write operation, one
   * window per call. Present exactly when `commitStagedText` is.
   */
  stageText?(
    binding: WorkspaceBinding,
    relativePath: string,
    step: BackendTextStage,
  ): Promise<BackendResult<BackendStagedText>>;
  /** Commit a staged replacement: the same CAS and atomic rename as `replaceText`. */
  commitStagedText?(
    binding: WorkspaceBinding,
    relativePath: string,
    uploadId: string,
    expectedDigest: string,
    sizeBytes: number,
  ): Promise<BackendResult<BackendMutation>>;
}

export function backendRefusal<T>(code: WorkspaceFilesRefusalCode, message: string): BackendResult<T> {
  return { ok: false, code, message };
}
