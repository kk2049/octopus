export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ScopeRef {
  kind: string;
  key: string;
}

export interface ResolveStreamRequest {
  app: string;
  scope: ScopeRef;
}

export interface StreamHead {
  streamId: string;
  head: number;
}

export interface EventInput {
  type: string;
  data: JsonValue;
  at: string;
  by: string;
}

export interface StoredEvent extends EventInput {
  seq: number;
}

export interface CommitRequest {
  streamId: string;
  expectedRevision: number;
  dispatchId: string;
  actor: string;
  action: string;
  paramsHash: string;
  backendCodeDigest: string;
  contractDigest: string;
  events: readonly EventInput[];
}

export type CommitResult =
  | { ok: true; revision: number; duplicate: boolean }
  | { ok: false; code: "conflict"; head: number };

export interface ReadResult {
  events: StoredEvent[];
  head: number;
  /** Last event sequence returned by this page (or the requested cursor for an empty page). */
  cursor: number;
  hasMore: boolean;
}

/**
 * One read's window: 16 events of at most 64 KiB each, so a page is at most
 * ~1 MiB however long the stream is. It bounds a call, not history; callers
 * that need everything page with `cursor` (child-rpc carries any result larger
 * than one IPC frame as ordered parts).
 */
export const STATE_READ_PAGE_LIMIT = 16;

/** One commit's evidence fields (`at` is the coordinator's per-commit stamp) — never raw params or payloads. */
export interface CommitSummary {
  seqFrom: number; seqTo: number; at: string; actor: string; action: string; dispatchId: string;
  paramsHash: string; backendCodeDigest: string; contractDigest: string; eventCount: number;
}

export interface ReadCommitsResult { commits: CommitSummary[]; head: number }

export interface SnapshotResult {
  revision: number;
  view: JsonValue;
}

export interface AppStateHealth {
  ok: boolean;
  recoveredStreams: number;
  stateDir?: string;
}

export interface StateClient {
  resolveStream(request: ResolveStreamRequest): Promise<StreamHead>;
  commit(request: CommitRequest): Promise<CommitResult>;
  readSince(streamId: string, after: number, limit: number): Promise<ReadResult>;
  readCommits(streamId: string, after: number, limit: number): Promise<ReadCommitsResult>;
  putSnapshot(streamId: string, revision: number, projectionDigest: string, view: JsonValue): Promise<void>;
  snapshot(streamId: string, projectionDigest: string): Promise<SnapshotResult | null>;
  health(): Promise<AppStateHealth>;
}
