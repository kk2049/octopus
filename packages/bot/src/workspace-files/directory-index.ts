/**
 * The one normalizer for device replies to `list_session_workspaces`, plus the
 * bounded index used by the sessions projection.
 *
 * Sessions and workspace-files ask the same Runner question through separate
 * capability Objects, so both use the parser below and therefore agree on the
 * wire facts. They do NOT share an authorized read: workspace-files consumes
 * only `roots` from its own answer and never writes this index; sessions writes
 * the full snapshot only after its own Gate succeeds.
 *
 * Nothing here caches an authority decision. Every external request still
 * crosses its own Gate, and an index hit is never a reason to skip that Gate.
 */

import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { workspaceRelativePathProblem } from "@claude-bot/runner/workspace-files";
import { WORKSPACE_FILES_LIMITS } from "@claude-bot/workspace-files-contract";
import { ENUMERATED_SOURCES, type Source as ScanSource } from "@claude-bot/plugin-sessions/scan";
import type { WorkspaceGroup } from "@claude-bot/agent-sessions-contract";

const WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;

/** Trusted identity that partitions sessions-plane snapshots. */
export interface WorkspaceDirectorySnapshotScope {
  owner: string;
  publisher: string;
  app: string;
  instance: string;
}

/** The public registry half of one device root. Canonical paths never enter. */
export interface WorkspaceDirectoryRoot {
  workspaceId: string;
  label: string;
  /** Display-only path, retained for the sessions launch list when valid. */
  display?: string;
}

/** The directory a device says one session currently occupies. */
export interface WorkspaceSessionDirectory {
  source: ScanSource;
  id: string;
  workspaceId: string;
  relativePath: string;
}

/** One successful, normalized answer from one device. */
export interface WorkspaceDirectorySnapshot {
  device: string;
  terminal?: WorkspaceGroup["terminal"];
  roots: readonly WorkspaceDirectoryRoot[];
  sessionDirectories: readonly WorkspaceSessionDirectory[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Workspace-files v1 compatibility: non-empty, bounded, otherwise untouched. */
function workspaceLabel(value: unknown): string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= WORKSPACE_FILES_LIMITS.maxLabelLength
    ? value
    : "";
}

/**
 * Normalize one device reply once for both consumers.
 *
 * A malformed envelope is not an empty registry.  Malformed individual rows
 * are omitted, while associations are accepted only for a workspace listed in
 * this same answer.  Conflicting locations for one `(source,id)` drop both.
 *
 * Every valid row is kept (2026-10-20). The reply is one Runner result, already
 * bounded as a whole by the kernel's result window; a second count here used to
 * drop every workspace past the 500th without saying so, and workspace-files'
 * roots paging could never reach them. A registry too large for one result
 * fails that call loudly instead of being cut.
 */
export function readWorkspaceDirectorySnapshot(
  raw: unknown,
  device: string,
): WorkspaceDirectorySnapshot | null {
  const row = record(raw);
  if (!row || !Array.isArray(row.workspaces) || !device) return null;

  const roots: WorkspaceDirectoryRoot[] = [];
  const known = new Set<string>();
  for (const value of row.workspaces) {
    const workspace = record(value);
    if (!workspace) continue;
    const workspaceId = typeof workspace.id === "string" ? workspace.id : "";
    const label = workspaceLabel(workspace.label);
    if (!WORKSPACE_ID.test(workspaceId) || !label) continue;
    // Sessions' historical order is slice THEN trim. Keep that exact display
    // fact here; workspace-files never consumes it.
    const display = typeof workspace.display === "string" ? workspace.display.slice(0, 240).trim() : "";
    roots.push({ workspaceId, label, ...(display ? { display } : {}) });
    // Duplicate roots stay in their original order for workspace-files/v1;
    // membership alone is de-duplicated for association validation.
    known.add(workspaceId);
  }

  const bySession = new Map<string, WorkspaceSessionDirectory | null>();
  const rawAssociations = Array.isArray(row.session_directories) ? row.session_directories : [];
  for (const value of rawAssociations) {
    const association = record(value);
    if (!association) continue;
    const source = ENUMERATED_SOURCES.includes(association.source as ScanSource)
      ? association.source as ScanSource
      : null;
    // Validate the wire identity; never repair it. In particular, trimming a
    // hostile `" s1 "` into `"s1"` could attach facts to a different session.
    const id = typeof association.id === "string" ? association.id : "";
    const workspaceId = typeof association.workspace_id === "string" ? association.workspace_id : "";
    const relativePath = typeof association.relative_path === "string" ? association.relative_path : null;
    if (!source || !id || Buffer.byteLength(id, "utf8") > MACHINE_LIMITS.sessionIdMaxBytes) continue;
    if (!known.has(workspaceId) || relativePath === null) continue;
    if (workspaceRelativePathProblem(relativePath) !== null) continue;

    const key = JSON.stringify([source, id]);
    const next: WorkspaceSessionDirectory = { source, id, workspaceId, relativePath };
    const seen = bySession.get(key);
    if (seen === null) continue;
    if (seen && (seen.workspaceId !== workspaceId || seen.relativePath !== relativePath)) {
      bySession.set(key, null);
      continue;
    }
    bySession.set(key, next);
  }

  const terminal = record(row.terminal);
  return Object.freeze({
    device,
    ...(typeof terminal?.available === "boolean" ? {
      terminal: Object.freeze({
        available: terminal.available,
        ...(typeof terminal.reason === "string" ? { reason: terminal.reason.slice(0, 240) } : {}),
      }),
    } : {}),
    roots: Object.freeze(roots.map((root) => Object.freeze({ ...root }))),
    sessionDirectories: Object.freeze(
      [...bySession.values()]
        .filter((value): value is WorkspaceSessionDirectory => value !== null)
        .map((value) => Object.freeze({ ...value })),
    ),
  });
}

interface HeldScope {
  scope: WorkspaceDirectorySnapshotScope;
  byDevice: Map<string, {
    snapshot: WorkspaceDirectorySnapshot;
    /** O(1) session lookup; rebuilt on whole-device replace. */
    bySession: Map<string, WorkspaceSessionDirectory>;
  }>;
}

function scopeKey(scope: WorkspaceDirectorySnapshotScope): string | null {
  if (!scope.owner || !scope.publisher || !scope.app || !scope.instance) return null;
  return JSON.stringify([scope.owner, scope.publisher, scope.app, scope.instance]);
}

/**
 * Bounded process-local directory snapshots.
 *
 * Replacing a device is atomic at this level: rows absent from its new answer
 * disappear rather than accumulating forever.  Failed/absent devices are not
 * replaced, so a partial fan-out can retain its last known facts until a later
 * successful answer, matching the platform's stale-row policy.
 */
export class WorkspaceDirectorySnapshotIndex {
  private readonly byScope = new Map<string, HeldScope>();

  constructor(
    private readonly maxScopes = 256,
    private readonly maxDevicesPerScope = 64,
  ) {}

  replace(scope: WorkspaceDirectorySnapshotScope, snapshot: WorkspaceDirectorySnapshot): boolean {
    const key = scopeKey(scope);
    if (!key || !snapshot.device) return false;
    let held = this.byScope.get(key);
    if (!held) {
      if (this.byScope.size >= this.maxScopes) {
        const oldest = this.byScope.keys().next().value as string | undefined;
        if (oldest !== undefined) this.byScope.delete(oldest);
      }
      held = { scope: Object.freeze({ ...scope }), byDevice: new Map() };
      this.byScope.set(key, held);
    }
    if (!held.byDevice.has(snapshot.device) && held.byDevice.size >= this.maxDevicesPerScope) {
      const oldest = held.byDevice.keys().next().value as string | undefined;
      if (oldest !== undefined) held.byDevice.delete(oldest);
    }
    held.byDevice.set(snapshot.device, {
      snapshot,
      bySession: new Map(snapshot.sessionDirectories.map((row) => [JSON.stringify([row.source, row.id]), row])),
    });
    return true;
  }

  snapshot(scope: WorkspaceDirectorySnapshotScope, device: string): WorkspaceDirectorySnapshot | null {
    const key = scopeKey(scope);
    return key ? this.byScope.get(key)?.byDevice.get(device)?.snapshot ?? null : null;
  }

  snapshots(scope: WorkspaceDirectorySnapshotScope): readonly WorkspaceDirectorySnapshot[] {
    const key = scopeKey(scope);
    return key ? [...(this.byScope.get(key)?.byDevice.values() ?? [])].map((held) => held.snapshot) : [];
  }

  location(
    scope: WorkspaceDirectorySnapshotScope,
    device: string,
    source: string,
    id: string,
  ): WorkspaceSessionDirectory | null {
    const key = scopeKey(scope);
    if (!key) return null;
    return this.byScope.get(key)?.byDevice.get(device)?.bySession.get(JSON.stringify([source, id])) ?? null;
  }

  forget(scope: WorkspaceDirectorySnapshotScope): void {
    const key = scopeKey(scope);
    if (key) this.byScope.delete(key);
  }

  prune(isLive: (scope: WorkspaceDirectorySnapshotScope) => boolean): void {
    for (const [key, held] of this.byScope) {
      if (!isLive(held.scope)) this.byScope.delete(key);
    }
  }

  /** Diagnostics and tests. */
  size(scope?: WorkspaceDirectorySnapshotScope): number {
    if (!scope) return this.byScope.size;
    const key = scopeKey(scope);
    return key ? this.byScope.get(key)?.byDevice.size ?? 0 : 0;
  }
}
