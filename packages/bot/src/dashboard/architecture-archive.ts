/** Pure naming, metadata validation and retention rules for atlas archives. */

import * as path from "node:path";
import { COMMIT_SHA_RE } from "./architecture-evolution.js";

export interface ArchitectureArchiveMetadata {
  commit: string;
  branch: string;
  dirty: boolean;
  generatedAt: string;
}

export interface ArchitectureArchiveCandidate {
  commit: string;
  generatedAt?: string;
  mtimeMs: number;
}

/** Dense recent history plus progressively sparse older checkpoints. */
export const ARCHIVE_RETENTION = Object.freeze({
  recent: 16,
  weekly: 8,
  monthly: 8,
  max: 32,
});

const ARCHIVE_DATA_NAME_RE = /^([0-9a-f]{7,40})\.json$/;

/** A data archive name, excluding `<commit>.meta.json` sidecars. */
export function archiveCommitFromName(name: string): string | null {
  return ARCHIVE_DATA_NAME_RE.exec(name)?.[1] ?? null;
}

export function archiveMetadataPath(snapshotFile: string): string {
  return path.join(path.dirname(snapshotFile), `${path.basename(snapshotFile, ".json")}.meta.json`);
}

/** Validate the deliberately tiny sidecar without trusting its filename claim. */
export function parseArchiveMetadata(value: unknown, expectedCommit?: string): ArchitectureArchiveMetadata | null {
  const row = asRecord(value);
  if (
    typeof row.commit !== "string"
    || !COMMIT_SHA_RE.test(row.commit)
    || (expectedCommit !== undefined && row.commit !== expectedCommit)
    || typeof row.branch !== "string"
    || typeof row.dirty !== "boolean"
    || typeof row.generatedAt !== "string"
  ) {
    return null;
  }
  return {
    commit: row.commit,
    branch: row.branch,
    dirty: row.dirty,
    generatedAt: row.generatedAt,
  };
}

/** Old atlases may omit optional meta fields; preserve the existing DTO defaults. */
export function archiveMetadataFromAtlas(value: unknown): ArchitectureArchiveMetadata | null {
  const meta = asRecord(asRecord(value).meta);
  if (typeof meta.commit !== "string" || !COMMIT_SHA_RE.test(meta.commit)) return null;
  return {
    commit: meta.commit,
    branch: typeof meta.branch === "string" ? meta.branch : "",
    dirty: Boolean(meta.dirty),
    generatedAt: typeof meta.generatedAt === "string" ? meta.generatedAt : "",
  };
}

/**
 * Keep the newest 16 snapshots, then the newest point in each of eight older
 * UTC weeks and eight still-older UTC months. A pinned live commit consumes the
 * same hard budget but is never selected for deletion.
 */
export function retainedArchiveCommits(
  candidates: readonly ArchitectureArchiveCandidate[],
  pinned: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const ordered = [...candidates].sort((a, b) => {
    const byTime = retentionTime(b) - retentionTime(a);
    return byTime || a.commit.localeCompare(b.commit);
  });
  const retained = new Set(ordered.slice(0, ARCHIVE_RETENTION.recent).map((entry) => entry.commit));
  for (const commit of pinned) {
    if (ordered.some((entry) => entry.commit === commit)) retained.add(commit);
  }

  const history = ordered.slice(ARCHIVE_RETENTION.recent);
  const keptHistory = (): ArchitectureArchiveCandidate[] => history.filter((entry) => retained.has(entry.commit));
  const weeklyBuckets = new Set(keptHistory().map((entry) => utcWeek(retentionTime(entry))));
  let weeklyAdded = 0;
  for (const entry of history) {
    if (retained.size >= ARCHIVE_RETENTION.max || weeklyAdded >= ARCHIVE_RETENTION.weekly) break;
    const bucket = utcWeek(retentionTime(entry));
    if (weeklyBuckets.has(bucket)) continue;
    weeklyBuckets.add(bucket);
    retained.add(entry.commit);
    weeklyAdded += 1;
  }

  const monthlyBuckets = new Set(keptHistory().map((entry) => utcMonth(retentionTime(entry))));
  let monthlyAdded = 0;
  for (const entry of history) {
    if (retained.size >= ARCHIVE_RETENTION.max || monthlyAdded >= ARCHIVE_RETENTION.monthly) break;
    const bucket = utcMonth(retentionTime(entry));
    if (monthlyBuckets.has(bucket)) continue;
    monthlyBuckets.add(bucket);
    retained.add(entry.commit);
    monthlyAdded += 1;
  }
  return retained;
}

function retentionTime(candidate: ArchitectureArchiveCandidate): number {
  const generated = candidate.generatedAt ? Date.parse(candidate.generatedAt) : Number.NaN;
  return Number.isFinite(generated) ? generated : Number.isFinite(candidate.mtimeMs) ? candidate.mtimeMs : 0;
}

function utcWeek(timestamp: number): string {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function utcMonth(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
