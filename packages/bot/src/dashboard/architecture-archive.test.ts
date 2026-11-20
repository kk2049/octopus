import { describe, expect, it } from "vitest";
import {
  ARCHIVE_RETENTION,
  archiveCommitFromName,
  parseArchiveMetadata,
  retainedArchiveCommits,
} from "./architecture-archive.js";

const commit = (index: number): string => index.toString(16).padStart(40, "0");

describe("architecture archive metadata", () => {
  it("distinguishes data snapshots from metadata sidecars", () => {
    expect(archiveCommitFromName(`${commit(1)}.json`)).toBe(commit(1));
    expect(archiveCommitFromName(`${commit(1)}.meta.json`)).toBeNull();
  });

  it("accepts only a complete sidecar bound to the expected commit", () => {
    const metadata = {
      commit: commit(1),
      branch: "v4",
      dirty: false,
      generatedAt: "2026-08-30T00:00:00Z",
    };
    expect(parseArchiveMetadata(metadata, commit(1))).toEqual(metadata);
    expect(parseArchiveMetadata(metadata, commit(2))).toBeNull();
    expect(parseArchiveMetadata({ ...metadata, dirty: "false" }, commit(1))).toBeNull();
  });
});

describe("architecture archive retention", () => {
  it("keeps dense recent history and bounded weekly/monthly history", () => {
    const start = Date.parse("2024-01-01T00:00:00Z");
    const candidates = Array.from({ length: 80 }, (_, index) => ({
      commit: commit(index + 1),
      generatedAt: new Date(start + index * 7 * 24 * 60 * 60_000).toISOString(),
      mtimeMs: start + index * 7 * 24 * 60 * 60_000,
    }));
    const retained = retainedArchiveCommits(candidates);

    expect(retained.size).toBe(ARCHIVE_RETENTION.max);
    for (const entry of candidates.slice(-ARCHIVE_RETENTION.recent)) {
      expect(retained.has(entry.commit)).toBe(true);
    }
    // Sparse history reaches well beyond the dense recent/weekly window.
    expect(candidates.slice(0, 40).some((entry) => retained.has(entry.commit))).toBe(true);
  });

  it("never removes the pinned live commit and still honors the hard ceiling", () => {
    const candidates = Array.from({ length: 80 }, (_, index) => ({
      commit: commit(index + 1),
      mtimeMs: index,
    }));
    const live = candidates[0].commit;
    const retained = retainedArchiveCommits(candidates, new Set([live]));

    expect(retained.has(live)).toBe(true);
    expect(retained.size).toBeLessThanOrEqual(ARCHIVE_RETENTION.max);
  });
});
