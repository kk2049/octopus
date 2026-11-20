import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runnerAppPacker } from "./app-pack-runner.js";
import type { WorkspaceProvider } from "./workspace-provider.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const worktree = mkdtempSync(path.join(tmpdir(), "prepared-app-")); dirs.push(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  execFileSync("git", ["-C", worktree, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "test"]);
  const sha = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const bytes = Buffer.from('{"app":"fixture"}');
  const file = "packages/bot/dist/release-apps/app-pack.json";
  mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  writeFileSync(path.join(worktree, file), bytes);
  const marker = { version: 1, repoSha: sha, node: process.version, platform: process.platform, arch: process.arch,
    nodeAbi: process.versions.modules, lockSha256: "a".repeat(64), outputs: [],
    parts: ["dependencies", "outputs"].map(name => ({ name, file: `${name}.tar.gz`, bytes: 1, sha256: "b".repeat(64) })),
    apps: [{ script: "app:pack", file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] };
  writeFileSync(path.join(worktree, ".octopus-release.json"), JSON.stringify(marker));
  const wait = vi.fn(() => { throw new Error("unexpected remote build"); });
  const pack = runnerAppPacker({ wait } as unknown as WorkspaceProvider, new AbortController().signal);
  return { worktree, bytes, file, wait, pack, out: path.join(worktree, "result.json") };
}
it("activates exact prepared App bytes without any remote build or download", async () => {
  const f = fixture();
  expect(await f.pack({ worktree: f.worktree, script: "app:pack", out: f.out })).toMatchObject({ ok: true });
  expect(readFileSync(f.out)).toEqual(f.bytes);
  expect(f.wait).not.toHaveBeenCalled();
});
it("fails closed on missing or corrupted prepared App artifacts", async () => {
  const f = fixture();
  expect(await f.pack({ worktree: f.worktree, script: "app:pack:unknown", out: f.out })).toMatchObject({ ok: false, log: expect.stringContaining("omitted") });
  writeFileSync(path.join(f.worktree, f.file), "x".repeat(f.bytes.length));
  expect(await f.pack({ worktree: f.worktree, script: "app:pack", out: f.out })).toMatchObject({ ok: false, log: expect.stringContaining("digest") });
  expect(f.wait).not.toHaveBeenCalled();
});
