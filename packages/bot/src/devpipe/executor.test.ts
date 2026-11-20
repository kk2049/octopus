import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sessionTranscriptExists, transcriptDirFor } from "./executor.js";

describe("transcript probe", () => {
  it("transcriptDirFor mirrors Claude Code's project-dir encoding", () => {
    expect(transcriptDirFor("/home/ubuntu/lht/octopus-worktrees/ticket-2")).toBe(
      join(homedir(), ".claude", "projects", "-home-ubuntu-lht-octopus-worktrees-ticket-2"),
    );
  });

  it("sessionTranscriptExists: only true once the CLI wrote non-empty JSONL for the given id (ticket #20)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    try {
      const cwd = join(dir, "worktree");
      mkdirSync(cwd, { recursive: true });
      const sid = "abc-123";
      // No transcript dir at all yet.
      expect(sessionTranscriptExists(cwd, sid)).toBe(false);
      // Dir exists but the target file doesn't.
      const tdir = transcriptDirFor(cwd).replace(homedir(), dir);
      mkdirSync(tdir, { recursive: true });
      writeFileSync(join(tdir, "other.jsonl"), "x");
      expect(sessionTranscriptExists(cwd, sid)).toBe(false);
      // Missing/empty session id — always false, never crashes.
      expect(sessionTranscriptExists(cwd, null)).toBe(false);
      expect(sessionTranscriptExists(cwd, undefined)).toBe(false);
      expect(sessionTranscriptExists(cwd, "")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
