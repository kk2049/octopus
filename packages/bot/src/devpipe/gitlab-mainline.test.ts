import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabMainline, type IntegrationLease } from "./gitlab-mainline.js";

const actor = (id: string) => ({ id, owner: "developer", label: `CLI ${id}` });
let root: string, remote: string, a: string, b: string, base: string, now: number;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function client(repoDir = a) { return new GitLabMainline({ repoDir, leaseMs: 10_000, reservationMs: 2000, now: () => now }); }
async function commit(cwd: string, name = "change") {
  await writeFile(path.join(cwd, name), name); git(cwd, "add", name); git(cwd, "commit", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}
async function claim(c: GitLabMainline, id: string): Promise<IntegrationLease> {
  const result = await c.acquire(actor(id)); expect(result.acquired).toBe(true);
  if (!result.acquired) throw Error("lease not acquired"); return result.lease;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "octopus-mainline-test-"));
  remote = path.join(root, "remote.git"); a = path.join(root, "a"); b = path.join(root, "b"); now = 1_000_000;
  git(root, "init", "--bare", remote); git(root, "clone", remote, a);
  git(a, "config", "user.name", "Test"); git(a, "config", "user.email", "test@localhost");
  git(a, "checkout", "-b", "v4"); base = await commit(a, "base"); git(a, "push", "origin", "v4");
  git(root, "clone", "-b", "v4", remote, b);
  git(b, "config", "user.name", "Test"); git(b, "config", "user.email", "test@localhost");
  git(remote, "config", "receive.denyNonFastForwards", "true");
  git(remote, "config", "core.hooksPath", path.join(remote, "hooks"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("GitLab-owned mainline integration", () => {
  it("requires an explicit cutover at the agreed SHA", async () => {
    const c = client(); await expect(c.acquire(actor("a"))).rejects.toMatchObject({ code: "inactive" });
    await expect(c.activate("0".repeat(40))).rejects.toMatchObject({ code: "invalid" });
    expect((await c.activate(base)).main).toBe(base);
    await expect(c.activate(base)).rejects.toMatchObject({ code: "invalid" });
  });
  it("publishes a fast-forward and receipt together, without modifying a local branch", async () => {
    const c = client(); await c.activate(base); const lease = await claim(c, "a");
    git(a, "checkout", "-b", "feature"); const candidate = await commit(a);
    expect(await c.publish(lease, candidate)).toBe(candidate);
    expect(git(a, "rev-parse", "v4")).toBe(base);
    const snapshot = await client(b).snapshot();
    expect(snapshot.main).toBe(candidate); expect(snapshot.state.holder).toBeNull();
    expect(snapshot.state.lastLanding).toMatchObject({ id: "a", base, sha: candidate });
  });
  it("has one winner when independent clients race to acquire", async () => {
    const one = client(), two = client(b); await one.activate(base);
    const results = await Promise.allSettled([one.acquire(actor("a")), two.acquire(actor("b"))]);
    expect(results.filter(r => r.status === "fulfilled" && r.value.acquired)).toHaveLength(1);
    const s = await one.snapshot(); expect(["a", "b"]).toContain(s.state.holder?.id);
    expect(git(remote, "rev-parse", "v4")).toBe(base);
  });
  it("keeps FIFO order and prevents a late arrival from stealing the reservation", async () => {
    const c = client(); await c.activate(base); const lease = await claim(c, "a");
    expect(await c.acquire(actor("b"))).toMatchObject({ acquired: false, position: 1 });
    expect(await c.acquire(actor("c"))).toMatchObject({ acquired: false, position: 2 });
    await c.acquire(actor("b")); await c.release(lease);
    expect(await c.acquire(actor("c"))).toMatchObject({ acquired: false, reservedFor: "b", position: 2 });
    expect((await claim(c, "b")).base).toBe(base);
  });
  it("expires a dead holder, fences its delayed writes and ignores its stale release", async () => {
    const c = client(), next = client(b); await c.activate(base); const old = await claim(c, "a");
    await next.acquire(actor("b")); now += 10_001; const lease = await claim(next, "b");
    const candidate = await commit(a);
    await expect(c.publish(old, candidate)).rejects.toMatchObject({ code: "lost_lease" });
    await expect(c.renew(old)).rejects.toMatchObject({ code: "lost_lease" });
    await c.release(old); expect((await next.snapshot()).state.holder?.epoch).toBe(lease.epoch);
    expect(git(remote, "rev-parse", "v4")).toBe(base);
  });
  it("advances past an abandoned FIFO reservation", async () => {
    const c = client(); await c.activate(base); const lease = await claim(c, "a");
    await c.acquire(actor("b")); await c.acquire(actor("c")); await c.release(lease);
    now += 2001; expect((await claim(c, "c")).id).toBe("c");
  });
  it("requires revalidation if an emergency writer has moved mainline", async () => {
    const c = client(); await c.activate(base); const lease = await claim(c, "a");
    const external = await commit(b); git(b, "push", "origin", "v4");
    const candidate = await commit(a, "other");
    await expect(c.publish(lease, candidate)).rejects.toMatchObject({ code: "base_moved" });
    expect(git(remote, "rev-parse", "v4")).toBe(external);
  });
  it("does not advance mainline if the server rejects the coordination update", async () => {
    const c = client(); await c.activate(base); const lease = await claim(c, "a");
    const candidate = await commit(a);
    git(remote, "config", "receive.hideRefs", "refs/heads/octopus-coordination");
    await expect(c.publish(lease, candidate)).rejects.toBeDefined();
    expect(git(remote, "rev-parse", "v4")).toBe(base);
    expect((await c.snapshot()).state.holder?.epoch).toBe(lease.epoch);
  });
  it("reconciles an accepted push whose ACK was lost without replaying it", async () => {
    const c = client(); await c.activate(base); const lease = await claim(c, "a"); const candidate = await commit(a);
    const wrapper = path.join(root, "bin"); await mkdir(wrapper);
    await writeFile(path.join(wrapper, "git"), '#!/bin/sh\n/usr/bin/git "$@"\nrc=$?\n[ "$1" = push ] && exit 1\nexit "$rc"\n', { mode: 0o755 });
    vi.stubEnv("PATH", `${wrapper}:${process.env.PATH}`);
    expect(await c.publish(lease, candidate)).toBe(candidate);
    expect((await c.snapshot()).state.lastLanding?.sha).toBe(candidate);
  });
  it("records explicit takeover and invalidates a still-live prior lease", async () => {
    const c = client(); await c.activate(base); const old = await claim(c, "a");
    const lease = await c.takeover(actor("b"), "repair abandoned integration");
    await expect(c.renew(old)).rejects.toMatchObject({ code: "lost_lease" });
    expect((await c.snapshot()).state.holder?.epoch).toBe(lease.epoch);
    expect(git(remote, "log", "-1", "--format=%s", "octopus-coordination")).toContain("repair abandoned integration");
  });
  it("keeps emergency advancement linear and records the exact reason atomically", async () => {
    const candidate = await commit(a); const c = client();
    await c.emergencyPublish(actor("repair"), base, candidate, "coordination is unavailable");
    expect(git(remote, "rev-parse", "v4")).toBe(candidate);
    const ref = git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/octopus-emergency/");
    expect(JSON.parse(git(remote, "show", `${ref}:state.json`))).toMatchObject({ base, sha: candidate, reason: "coordination is unavailable" });
    await expect(c.emergencyPublish(actor("bad"), candidate, base, "do not rewind")).rejects.toMatchObject({ code: "base_moved" });
    expect(git(remote, "rev-parse", "v4")).toBe(candidate);
  });
});
