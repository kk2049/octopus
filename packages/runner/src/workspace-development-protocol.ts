/** Authenticated Runner protocol. Identity is bound by the Head capability;
 * gateway site is supplied by the receiving connection, never by this payload.
 * No canonical device path or reusable credential is returned. */
export const WORKSPACE_DEVELOPMENT_PROTOCOL = "workspace-development/v1";
export const WORKSPACE_DEVELOPMENT_METHODS = [
  "workspace_development_prepare", "workspace_development_sync",
  "workspace_development_status", "workspace_development_export",
  "workspace_development_artifact",
] as const;
export type WorkspaceDevelopmentMethod = typeof WORKSPACE_DEVELOPMENT_METHODS[number];
export const WORKSPACE_DEVELOPMENT_LIMITS = {
  bundleBytes: 128 * 1024 * 1024,
  artifactChunkBytes: 1024 * 1024,
  operationTimeoutMs: 120_000,
  idCharacters: 100,
} as const;

export interface WorkspaceDevelopmentIdentity {
  /** Registered parent, retained for authorization and revocation. */
  workspace_id: string;
  repository_id: string;
  development_id: string;
  ticket_id: number;
}
export interface WorkspaceDevelopmentInput {
  /** Expiring BundleHandoff URL; omitted from durable records/fingerprints. */
  url: string;
  sha256: string;
  bytes: number;
}
export interface WorkspaceDevelopmentPrepare extends WorkspaceDevelopmentIdentity {
  request_id: string;
  /** Immutable initial authoritative base for this development identity. */
  base_sha: string;
  /** May be omitted only when the exact commit is already in this mirror. */
  input?: WorkspaceDevelopmentInput;
}
export interface WorkspaceDevelopmentSync extends WorkspaceDevelopmentPrepare {
  /** Updates the mirror ref only; never checks out or rebases the worktree. */
  target_sha: string;
}
export interface WorkspaceDevelopmentExport extends WorkspaceDevelopmentIdentity {
  request_id: string;
  /** Candidate's required authoritative ancestor; may advance after rebase. */
  expected_base_sha: string;
  expected_head_sha: string;
}
export interface WorkspaceDevelopmentStatusRequest extends WorkspaceDevelopmentIdentity {
  /** Without it, read current development facts; with it, also reconcile intent. */
  request_id?: string;
}
export interface WorkspaceDevelopmentArtifactRequest extends WorkspaceDevelopmentIdentity {
  candidate_id: string;
  artifact_id: string;
  offset: number;
  length: number;
}
export type WorkspaceDevelopmentAction = "prepare" | "sync" | "export";
export type WorkspaceDevelopmentOperationState =
  | "accepted" | "running" | "succeeded" | "failed" | "unknown" | "missing";
export type WorkspaceDevelopmentError =
  | "invalid_request" | "binding_mismatch" | "workspace_unavailable"
  | "workspace_busy" | "request_conflict" | "input_unavailable" | "input_invalid"
  | "base_missing" | "head_mismatch" | "dirty_worktree" | "conflicted_worktree"
  | "candidate_invalid" | "artifact_unavailable" | "operation_interrupted"
  | "timed_out" | "internal_error";
export interface WorkspaceDevelopmentSnapshot {
  /** Register the managed child path, then bind native exec and attachments here. */
  worktree_workspace_id: string;
  base_sha: string;
  head_sha: string;
  synced_head_sha: string;
  dirty: boolean;
  conflicted: boolean;
  /** Present after sync; the agent must reconcile this base on the Runner. */
  required_head_sha?: string;
}
export interface WorkspaceDevelopmentCandidate {
  candidate_id: string;
  development_id: string;
  base_sha: string;
  head_sha: string;
  /** Cleanliness observed at export, not a promise about subsequent editing. */
  clean: true;
  bundle: { artifact_id: string; sha256: string; bytes: number };
}
export interface WorkspaceDevelopmentOperation {
  request_id: string;
  action?: WorkspaceDevelopmentAction;
  state: WorkspaceDevelopmentOperationState;
  created_at?: string;
  finished_at?: string;
  error?: WorkspaceDevelopmentError;
  candidate?: WorkspaceDevelopmentCandidate;
}
export interface WorkspaceDevelopmentStatus extends WorkspaceDevelopmentIdentity {
  protocol: typeof WORKSPACE_DEVELOPMENT_PROTOCOL;
  development?: WorkspaceDevelopmentSnapshot;
  operation?: WorkspaceDevelopmentOperation;
}
export interface WorkspaceDevelopmentArtifact extends WorkspaceDevelopmentIdentity {
  protocol: typeof WORKSPACE_DEVELOPMENT_PROTOCOL;
  candidate_id: string;
  artifact_id: string;
  offset: number;
  bytes: number;
  total: number;
  eof: boolean;
  /** Bounded base64 bytes; the consumer verifies the candidate's whole digest. */
  data: string;
}
