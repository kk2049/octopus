import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitLabReleaseCatalog, releaseTag } from "./gitlab-release.js";
import { DeployService } from "./deploy.js";
import { Store } from "../store/store.js";

const api = "https://gitlab.example/api/v4", project = `${api}/projects/1`;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let root: string, repo: string, tokenFile: string, older: string, newer: string, tip: string;
let records: Array<{ tag_name: string; commit: { id: string }; assets: { links: Array<{ name: string; url: string }> } }>;
let objects: Map<string, Buffer>, requests: string[], ranged: boolean;
let fetcher: typeof fetch;
function release(sha: string) {
  const parts = ["dependencies", "outputs"].map(name => {
    const bytes = Buffer.from(`${sha}:${name}`), sha256 = hash(bytes);
    const part = { name, file: `${name}.tar.gz`, bytes: bytes.length, sha256 };
    objects.set(`${project}/packages/generic/octopus-release/${sha}/${sha256}-${part.file}`, bytes); return part;
  });
  const raw = Buffer.from(JSON.stringify({ version: 1, repoSha: sha, node: process.version, platform: process.platform, arch: process.arch,
    nodeAbi: process.versions.modules, lockSha256: "a".repeat(64), parts, outputs: [] }));
  const manifestSha256 = hash(raw), url = `${project}/packages/generic/octopus-release/${sha}/${manifestSha256}-release.json`;
  objects.set(url, raw);
  records.push({ tag_name: releaseTag(sha), commit: { id: sha }, assets: { links: [{ name: `release.json@${manifestSha256}`, url }] } });
  return { sha, manifestSha256 };
}
function catalog() { return new GitLabReleaseCatalog({ apiUrl: api, project: "1", tokenFile, repoDir: repo, fetch: fetcher, stateFile: path.join(root, "check.json") }); }
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "octopus-releases-")); repo = path.join(root, "repo"); tokenFile = path.join(root, "token");
  await writeFile(tokenFile, "test-token", { mode: 0o600 });
  git(root, "init", "--initial-branch=v4", repo); git(repo, "config", "user.name", "test"); git(repo, "config", "user.email", "test@localhost");
  await writeFile(path.join(repo, "source"), "older"); git(repo, "add", "."); git(repo, "commit", "-m", "older"); older = git(repo, "rev-parse", "HEAD");
  await writeFile(path.join(repo, "source"), "newer"); git(repo, "commit", "-am", "newer"); newer = git(repo, "rev-parse", "HEAD"); tip = newer;
  git(repo, "remote", "add", "origin", repo);
  records = []; objects = new Map(); requests = []; ranged = true;
  fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url); requests.push(key);
    expect(init?.redirect).toBe("error"); expect(new Headers(init?.headers).get("PRIVATE-TOKEN")).toBe("test-token");
    if (key.endsWith("/repository/branches/v4")) return Response.json({ commit: { id: tip } });
    if (key.includes("/releases?")) return Response.json(records);
    if (key.includes("/releases/")) {
      const record = records.find(row => key.endsWith(row.tag_name)); return record ? Response.json(record) : new Response(null, { status: 404 });
    }
    const bytes = objects.get(key); if (!bytes) return new Response(null, { status: 404 });
    if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": String(bytes.length) } });
    const range = /^bytes=(\d+)-(\d+)$/u.exec(new Headers(init?.headers).get("range") ?? "");
    if (range && ranged) {
      const start = Number(range[1]), end = Number(range[2]);
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` } });
    }
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("selects commit order, ignores off-mainline releases, persists the checked pin", async () => {
  const latest = release(newer); release(older); release("d".repeat(40));
  expect(await catalog().check()).toMatchObject({ mainlineSha: newer, ready: latest });
  expect(await catalog().snapshot()).toMatchObject({ ready: latest });
});
it("shows mainline ahead of its last complete release", async () => {
  const ready = release(older); expect(await catalog().check()).toMatchObject({ mainlineSha: newer, ready });
});
it.each(["pending", "receiving", "staging", "failed"])("offers the staged ancestor while the newest release is %s, including after restart", async state => {
  const ready = release(older), latest = release(newer), c = catalog(); await c.check();
  const store = new Store(":memory:");
  const service = new DeployService({ store, repoDir: repo, baseBranch: "v4", releaseCatalog: catalog(),
    stagedReleaseShas: async () => [newer, "d".repeat(40), older],
    releaseStatus: async sha => ({ sha, state: sha === older ? "ready" : state,
      manifestSha256: sha === older ? ready.manifestSha256 : latest.manifestSha256 }) });
  try {
    expect(await service.releaseCatalogStatus()).toMatchObject({ deployable: ready, snapshot: { ready: latest } });
    expect(await service.preparationStatus()).toMatchObject({ sha: newer, state });
    const intent = await service.trigger("owner", ready.sha, undefined, ready);
    expect(intent).toMatchObject({ target_sha: older, release_manifest_sha256: ready.manifestSha256 });
  } finally { service.stop(); store.close(); }
});
it("accepts a reviewed pin after discovery advances, but refuses changed bytes, missing staging and off-mainline commits", async () => {
  const ready = release(older), c = catalog(); await c.check();
  release(newer); await c.check();
  const store = new Store(":memory:");
  let staged = false;
  const service = new DeployService({ store, repoDir: repo, baseBranch: "v4", releaseCatalog: c,
    releaseStatus: async sha => ({ sha, state: staged ? "ready" : "pending", manifestSha256: ready.manifestSha256 }) });
  try {
    await expect(service.trigger("owner", older, undefined, ready)).rejects.toThrow(/暂存/);
    staged = true;
    await expect(service.trigger("owner", older, undefined, { ...ready, manifestSha256: "f".repeat(64) })).rejects.toThrow(/changed/);
    await expect(service.trigger("owner", "d".repeat(40), undefined, { ...ready, sha: "d".repeat(40) })).rejects.toThrow(/主线/);
    expect(store.devTickets.getActiveDeployIntent()).toBeUndefined();
    expect((await service.trigger("owner", older, undefined, ready)).target_sha).toBe(older);
  } finally { service.stop(); store.close(); }
});
it("automatically discovers a completed CI release without a manual check or another mainline push", async () => {
  const previous = release(older), c = catalog();
  git(repo, "checkout", "--detach", older);
  const store = new Store(":memory:"), prewarm = vi.fn(async () => {});
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const service = new DeployService({ store, repoDir: repo, baseBranch: "v4", releaseCatalog: c, prewarmRelease: prewarm });
  try {
    await service.pollOnce();
    await vi.waitFor(async () => expect((await c.snapshot())?.ready).toEqual(previous));
    await new Promise(resolve => setImmediate(resolve));
    expect(prewarm).not.toHaveBeenCalled(); // already live
    const latest = release(newer); // CI finished; the branch has not advanced
    now += 31000;
    await service.pollOnce();
    await vi.waitFor(() => expect(prewarm).toHaveBeenCalledWith(latest.sha));
    expect((await c.snapshot())?.ready).toEqual(latest);
    expect(store.devTickets.getActiveDeployIntent()).toBeUndefined();
    await service.pollOnce();
    expect(prewarm).toHaveBeenCalledTimes(1);
  } finally { service.stop(); clock.mockRestore(); store.close(); }
});
it("does not start staging after shutdown or after a deployment wins an in-flight discovery", async () => {
  for (const outcome of ["stop", "deploy"] as const) {
    const c = catalog(), store = new Store(":memory:");
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const pin = { sha: older, manifestSha256: "a".repeat(64) };
    vi.spyOn(c, "check").mockImplementation(async () => { await blocked; return { mainlineSha: newer, ready: pin, checkedAt: new Date().toISOString() }; });
    const prewarm = vi.fn(async () => {});
    const service = new DeployService({ store, repoDir: repo, baseBranch: "v4", releaseCatalog: c, prewarmRelease: prewarm });
    try {
      await service.pollOnce();
      if (outcome === "stop") service.stop();
      else vi.spyOn(store.devTickets, "getActiveDeployIntent").mockReturnValue({ id: 17 } as ReturnType<typeof store.devTickets.getActiveDeployIntent>);
      finish();
      await new Promise(resolve => setImmediate(resolve));
      expect(prewarm).not.toHaveBeenCalled();
    } finally { service.stop(); store.close(); }
  }
});
it("does not silently replace a checked manifest after release metadata changes", async () => {
  release(newer); const c = catalog(); await c.check();
  records[0]!.assets.links[0]!.name = `release.json@${"f".repeat(64)}`;
  await expect(c.provider(newer)).rejects.toThrow(/changed/);
});
it("rejects foreign download origins without forwarding the token", async () => {
  release(newer); records[0]!.assets.links[0]!.url = "https://elsewhere.example/steal";
  await expect(catalog().check()).rejects.toThrow(/configured project/);
  expect(requests.every(url => url.startsWith(`${project}/`))).toBe(true);
});
it("refuses incomplete or corrupted packages", async () => {
  release(newer); const key = [...objects.keys()][0]!; objects.delete(key);
  await expect(catalog().check()).rejects.toThrow(/404/);
  objects.clear(); records = []; release(newer);
  objects.set(records[0]!.assets.links[0]!.url, Buffer.from("tampered"));
  await expect(catalog().check()).rejects.toThrow(/digest/);
});
it("enforces bounded exact byte ranges and never builds on the application host", async () => {
  const pin = release(newer), provider = await catalog().provider(newer, pin.manifestSha256);
  expect(await provider.artifact("release", "outputs.tar.gz", 0, 3)).toMatchObject({ data: Buffer.from(newer.slice(0, 3)), eof: false });
  ranged = false;
  await expect(provider.artifact("release", "outputs.tar.gz", 0, 3)).rejects.toThrow(/byte range/);
});
it("deploys the reviewed release even when mainline has advanced and refuses an unpinned click", async () => {
  const pin = release(older), c = catalog(); await c.check();
  const store = new Store(":memory:");
  store.saveUser({ username: "owner", uid: 1, home_dir: "/owner", created_at: new Date().toISOString() });
  const late = store.devTickets.createDevTicket({ kind: "simple", app_id: null, title: "Not in this release", body: "later", requester: "owner", model: "codex", effort: "high" });
  store.devTickets.updateDevTicket(late.id, { dev_status: "landed", commit_sha: newer, deploy_status: "pending" });
  const prepare = vi.fn();
  const service = new DeployService({ store, repoDir: repo, baseBranch: "v4", releaseCatalog: c,
    prepareTarget: prepare, releaseStatus: async sha => ({ sha, state: "ready", manifestSha256: pin.manifestSha256 }) });
  try {
    await expect(service.trigger("owner")).rejects.toThrow(/SHA/);
    const intent = await service.trigger("owner", older, undefined, pin);
    expect(intent.target_sha).toBe(older); expect(intent.release_manifest_sha256).toBe(pin.manifestSha256);
    expect(prepare).not.toHaveBeenCalled();
    expect(store.devTickets.getDevTicket(late.id)?.deploy_status).toBe("pending");
    release(newer);
    await service.checkUpdates();
    expect((await c.snapshot())?.ready?.sha).toBe(newer);
    expect(store.devTickets.getActiveDeployIntent()).toMatchObject({ target_sha: older, release_manifest_sha256: pin.manifestSha256 });
  } finally { service.stop(); store.close(); }
});
