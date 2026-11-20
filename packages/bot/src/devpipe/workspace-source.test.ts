import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSourceState } from "./workspace-source.js";

describe("workspace source probe", () => {
  it("uses only known destination refs and distinguishes an absent workspace", async () => {
    const sha = "a".repeat(40), other = "b".repeat(40);
    expect(await workspaceSourceState(async () => ({ ok: true, stdout: `${sha}\n${other}\n${sha}\n`, stderr: "" }), "/work/repo", "land"))
      .toEqual({ head: sha, refs: [sha, other] });
    expect(await workspaceSourceState(async () => ({ ok: true, stdout: "MISSING\n", stderr: "" }), "/work/repo", "land"))
      .toEqual({ head: null, refs: [] });
  });
  it("refuses a failed probe instead of silently sending the full repository", async () => {
    await expect(workspaceSourceState(async () => ({ ok: false, stdout: "", stderr: "offline" }), "/work/repo", "land"))
      .rejects.toThrow("refusing an unmeasured full-bundle fallback");
  });
  it("does not require remote-tracking-only objects when seeding a fresh clone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "source-seed-")), source = join(dir, "source");
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const exec = async ({ command }: { command: string }) => ({ ok: true, stdout: execFileSync("sh", ["-c", command], { encoding: "utf8" }), stderr: "" });
    try {
      git("init", "-q", source);
      const commit = () => git("-C", source, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
      commit(); const base = git("-C", source, "rev-parse", "HEAD");
      commit(); const remoteOnly = git("-C", source, "rev-parse", "HEAD");
      git("-C", source, "update-ref", "refs/remotes/prior-job/land", remoteOnly);
      git("-C", source, "reset", "--hard", base);
      const seed = await workspaceSourceState(exec, source, "new-workspace");
      expect(seed).toEqual({ head: base, refs: [base] });
      const parent = join(source, ".octopus-ci/workspaces"); mkdirSync(parent, { recursive: true });
      const target = join(parent, "new-workspace");
      git("clone", "--no-local", "--no-checkout", source, target);
      for (const sha of seed.refs) expect(() => git("-C", target, "cat-file", "-e", `${sha}^{commit}`)).not.toThrow();
      expect(() => git("-C", target, "cat-file", "-e", `${remoteOnly}^{commit}`)).toThrow();
      git("-C", target, "fetch", source, remoteOnly);
      git("-C", target, "update-ref", "refs/remotes/known/land", remoteOnly);
      expect((await workspaceSourceState(exec, source, "new-workspace")).refs).toContain(remoteOnly);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
