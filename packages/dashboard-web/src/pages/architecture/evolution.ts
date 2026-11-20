import { uiText } from "../../i18n/ui-text.js";
/**
 * Pure computation for the 演进 (evolution) cut: wire types for the three
 * evolution endpoints, the commit-axis geometry of the range selector, and the
 * defensive normalisation of the diff response.
 *
 * The server never recomputes an analysis for a drag — architecture change
 * comes from archived snapshots, code change from `git log`. This module's job
 * is only the index arithmetic between "a pointer position on a track" and "a
 * commit in the axis", so the view stays free of untested math.
 */

// ── Wire types (kept in step with the server's /api/architecture/*) ─────────

export interface EvoCommit {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

export interface EvoCommitsResponse {
  commits: EvoCommit[];
  /** History continues past this window. */
  truncated: boolean;
  /** The commit every window of this axis is anchored on. */
  head?: string;
  /** Where the next older window starts; present exactly when `truncated`. */
  next_offset?: number;
}

/** An older commit-axis window: the anchor plus how many commits precede it. */
export interface EvoCommitsCursor {
  head: string;
  offset: number;
}

/** The next older window of the same anchored axis, or null at the root commit. */
export function nextCommitsCursor(page: EvoCommitsResponse | undefined): EvoCommitsCursor | null {
  if (!page?.truncated || typeof page.head !== "string" || !page.head) return null;
  const offset = page.next_offset;
  return typeof offset === "number" && Number.isSafeInteger(offset) && offset > 0 ? { head: page.head, offset } : null;
}

export interface EvoSnapshot {
  commit: string;
  branch: string;
  dirty: boolean;
  generatedAt: string;
  current: boolean;
}

export interface EvoSnapshotsResponse {
  snapshots: EvoSnapshot[];
}

export interface EvoFileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface EvoModuleChange {
  moduleId: string;
  additions: number;
  deletions: number;
  commits: number;
  files: EvoFileChange[];
  filesTotal: number;
}

export interface EvoCodeSummary {
  commitCount: number;
  aggregatedCommits: number;
  additions: number;
  deletions: number;
  modules: EvoModuleChange[];
  commits: EvoCommit[];
}

export interface EvoSnapshotRef {
  commit: string;
  branch: string;
  dirty: boolean;
  generatedAt: string;
}

export interface EvoTotals {
  files: number;
  codeLoc: number;
  symbols: number;
  calls: number;
  annotations: number;
}

export interface EvoModuleEntry {
  id: string;
  label: string;
  zone: string;
  codeLoc: number;
  files: number;
}

export interface EvoModuleResize {
  id: string;
  label: string;
  zone: string;
  codeLocBefore: number;
  codeLocAfter: number;
  filesBefore: number;
  filesAfter: number;
}

export interface EvoEdge {
  from: string;
  to: string;
}

export interface EvoArchitectureDiff {
  base: EvoSnapshotRef;
  head: EvoSnapshotRef;
  modules: { added: EvoModuleEntry[]; removed: EvoModuleEntry[]; resized: EvoModuleResize[] };
  dependencies: {
    added: Array<EvoEdge & { runtimeCount: number; dynamicCount: number; circular: boolean }>;
    removed: EvoEdge[];
    becameCircular: EvoEdge[];
    becameAcyclic: EvoEdge[];
  };
  constraints: {
    added: Array<{ id: string; title: string; status: string }>;
    removed: Array<{ id: string; title: string }>;
    changed: Array<{ id: string; title: string; before: string; after: string }>;
  };
  totals: { before: EvoTotals; after: EvoTotals };
}

export interface EvoDiffResponse {
  from: string;
  to: string;
  code: EvoCodeSummary;
  architecture: EvoArchitectureDiff | null;
  architectureUnavailable?: string;
}

/** The server's bucket for paths no module rule owns. */
export const UNMAPPED_MODULE = "(unmapped)";

// ── Defensive normalisation ─────────────────────────────────────────────────

function arr<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

/** Missing arrays become empty; the views never touch the raw wire. */
export function safeDiff(data: Partial<EvoDiffResponse> | undefined | null): EvoDiffResponse | null {
  if (!data || typeof data !== "object") return null;
  const code = data.code;
  const architecture = data.architecture;
  return {
    from: data.from ?? "",
    to: data.to ?? "",
    code: {
      commitCount: code?.commitCount ?? 0,
      aggregatedCommits: code?.aggregatedCommits ?? 0,
      additions: code?.additions ?? 0,
      deletions: code?.deletions ?? 0,
      modules: arr(code?.modules).map((m) => ({ ...m, files: arr(m?.files) })),
      commits: arr(code?.commits),
    },
    architecture: architecture
      ? {
          base: architecture.base ?? { commit: "", branch: "", dirty: false, generatedAt: "" },
          head: architecture.head ?? { commit: "", branch: "", dirty: false, generatedAt: "" },
          modules: {
            added: arr(architecture.modules?.added),
            removed: arr(architecture.modules?.removed),
            resized: arr(architecture.modules?.resized),
          },
          dependencies: {
            added: arr(architecture.dependencies?.added),
            removed: arr(architecture.dependencies?.removed),
            becameCircular: arr(architecture.dependencies?.becameCircular),
            becameAcyclic: arr(architecture.dependencies?.becameAcyclic),
          },
          constraints: {
            added: arr(architecture.constraints?.added),
            removed: arr(architecture.constraints?.removed),
            changed: arr(architecture.constraints?.changed),
          },
          totals: {
            before: architecture.totals?.before ?? { files: 0, codeLoc: 0, symbols: 0, calls: 0, annotations: 0 },
            after: architecture.totals?.after ?? { files: 0, codeLoc: 0, symbols: 0, calls: 0, annotations: 0 },
          },
        }
      : null,
    ...(data.architectureUnavailable ? { architectureUnavailable: data.architectureUnavailable } : {}),
  };
}

// ── Commit-axis geometry ────────────────────────────────────────────────────

/** The wire is newest-first; the axis runs oldest→newest, left→right. */
export function axisCommits(commits: EvoCommit[] | undefined | null): EvoCommit[] {
  return arr(commits).slice().reverse();
}

/** Clamp an index into the axis. */
export function clampIndex(index: number, length: number): number {
  if (!(length > 0)) return 0;
  return Math.max(0, Math.min(length - 1, Math.round(index)));
}

/**
 * Normalise a candidate range: both ends inside the axis and at least one
 * commit apart (equal endpoints have no range to describe). `which` names the
 * handle being moved so the OTHER end stays put.
 */
export function clampRange(
  range: readonly [number, number],
  length: number,
  which: "from" | "to",
): [number, number] {
  let from = clampIndex(range[0], length);
  let to = clampIndex(range[1], length);
  if (length < 2) return [0, 0];
  if (from >= to) {
    if (which === "from") from = Math.max(0, to - 1);
    else to = Math.min(length - 1, from + 1);
  }
  // Both clamps above stay in bounds, but a degenerate pair (0,0) can survive
  // when `to` was already at the left wall; push it right, deterministically.
  if (from >= to) {
    from = 0;
    to = 1;
  }
  return [from, to];
}

/** Handle position along the track, 0..100. */
export function positionPercent(index: number, length: number): number {
  if (length < 2) return 0;
  return (clampIndex(index, length) / (length - 1)) * 100;
}

/** Pointer offset (px from track left) → axis index. */
export function indexAtOffset(offsetX: number, trackWidth: number, length: number): number {
  if (!(trackWidth > 0) || length < 2) return 0;
  return clampIndex((offsetX / trackWidth) * (length - 1), length);
}

/** Keyboard steps for a handle. Unknown keys return the index unchanged. */
export function stepIndex(index: number, key: string, length: number): number {
  const deltas: Record<string, number> = {
    ArrowLeft: -1,
    ArrowDown: -1,
    ArrowRight: 1,
    ArrowUp: 1,
    PageDown: -10,
    PageUp: 10,
  };
  if (key === "Home") return 0;
  if (key === "End") return clampIndex(length - 1, length);
  const delta = deltas[key];
  return delta === undefined ? index : clampIndex(index + delta, length);
}

/** Axis indices that hold an archived snapshot, for the track markers. */
export function snapshotIndices(axis: EvoCommit[], snapshots: EvoSnapshot[] | undefined | null): Map<number, EvoSnapshot> {
  const bySha = new Map(arr(snapshots).map((snap) => [snap.commit, snap]));
  const marks = new Map<number, EvoSnapshot>();
  axis.forEach((commit, at) => {
    const snap = bySha.get(commit.sha);
    if (snap) marks.set(at, snap);
  });
  return marks;
}

/** True when two snapshots differ in NOTHING the diff tracks. */
export function archDiffEmpty(diff: EvoArchitectureDiff): boolean {
  return (
    diff.modules.added.length === 0 &&
    diff.modules.removed.length === 0 &&
    diff.modules.resized.length === 0 &&
    diff.dependencies.added.length === 0 &&
    diff.dependencies.removed.length === 0 &&
    diff.dependencies.becameCircular.length === 0 &&
    diff.dependencies.becameAcyclic.length === 0 &&
    diff.constraints.added.length === 0 &&
    diff.constraints.removed.length === 0 &&
    diff.constraints.changed.length === 0
  );
}

// ── Small formatting helpers the view shares ────────────────────────────────

export function shortSha(sha: string): string {
  return (sha ?? "").slice(0, 8);
}

export function shortDate(iso: string): string {
  // "2026-08-10T12:34:56+08:00" → "08-10"; anything unparsable passes through.
  const match = /^\d{4}-(\d{2}-\d{2})/.exec(iso ?? "");
  return match ? match[1] : iso ?? "";
}

/** "+120 −45", with true zeroes kept honest. */
export function fmtDelta(additions: number, deletions: number): string {
  return `+${additions} −${deletions}`;
}

/** Signed difference for resize rows: 150→120 is "−30". */
export function fmtSigned(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${-value}`;
  return "±0";
}

export function moduleLabel(moduleId: string): string {
  return moduleId === UNMAPPED_MODULE ? uiText("（未归属：doc/配置等）") : moduleId;
}
