import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseReleaseManifest, type ReleaseManifest, type ReleaseProvider } from "./deploy-artifact.js";
import { gitOrThrow } from "./worktree.js";
import { WorkspaceProviderUnavailable } from "./workspace-provider.js";

export interface ReleasePin { sha: string; manifestSha256: string }
export interface ReleaseCatalogSnapshot {
  mainlineSha: string; ready: ReleasePin | null; checkedAt: string; error?: string;
}
export interface GitLabReleaseOptions {
  apiUrl: string; project: string; tokenFile: string; repoDir: string; remote?: string; branch?: string;
  fetch?: typeof fetch; stateFile?: string;
}
interface ReleaseRecord { tag_name: string; commit: { id: string }; assets: { links: Array<{ name: string; url: string }> } }
const SHA = /^[a-f0-9]{40}$/u, HASH = /^[a-f0-9]{64}$/u;
export const RELEASE_PACKAGE = "octopus-release";
export const releaseTag = (sha: string): string => `octopus-v4-${sha}`;
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Bounded requests never follow redirects with a credential. Only the configured
 * GitLab project is a download origin; asset URLs are checked, never followed.
 */
export class GitLabReleaseCatalog {
  private readonly api: string;
  private readonly projectUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly pins = new Map<string, string>();
  private checking?: Promise<ReleaseCatalogSnapshot>;
  private checked: ReleaseCatalogSnapshot | null = null;
  constructor(private readonly opts: GitLabReleaseOptions) {
    const url = new URL(opts.apiUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || !url.pathname.replace(/\/$/u, "").endsWith("/api/v4")) throw new Error("GitLab API must be an HTTPS /api/v4 URL without credentials");
    this.api = url.href.replace(/\/$/u, "");
    this.projectUrl = `${this.api}/projects/${encodeURIComponent(opts.project)}`;
    this.fetcher = opts.fetch ?? fetch;
  }
  packageUrl(sha: string, file: string): string {
    if (!SHA.test(sha) || !/^[a-f0-9]{64}-(?:release\.json|dependencies\.tar\.gz|outputs\.tar\.gz)$/u.test(file)) throw new Error("invalid release object");
    return `${this.projectUrl}/packages/generic/${RELEASE_PACKAGE}/${sha}/${file}`;
  }
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    if (!url.startsWith(`${this.projectUrl}/`)) throw new Error("release request leaves the configured project");
    const stat = await fs.lstat(this.opts.tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 8192) throw new Error("GitLab credential must be a private file");
    const token = (await fs.readFile(this.opts.tokenFile, "utf8")).trim();
    if (!token || /[\r\n]/u.test(token)) throw new Error("invalid GitLab credential file");
    const response = await this.fetcher(url, { ...init, redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      headers: { "PRIVATE-TOKEN": token, "User-Agent": "octopus-development/1.0", ...init.headers } })
      .catch(() => { throw new WorkspaceProviderUnavailable("GitLab release transport is unavailable; current version is retained"); });
    if (response.status === 429 || response.status >= 500) { await response.body?.cancel(); throw new WorkspaceProviderUnavailable(`GitLab release service unavailable (HTTP ${response.status})`); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitLab release request failed (HTTP ${response.status})`); }
    return response;
  }
  private async bytes(response: Response, limit: number): Promise<Buffer> {
    if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("release response exceeds its limit"); }
    const chunks: Buffer[] = []; let size = 0;
    if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > limit) { throw new Error("release response exceeds its limit"); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  private async json(url: string): Promise<unknown> { return JSON.parse((await this.bytes(await this.request(url), 2 * 1024 ** 2)).toString("utf8")); }
  async release(sha: string, expectedDigest?: string): Promise<{ pin: ReleasePin; manifest: ReleaseManifest; raw: Buffer }> {
    if (!SHA.test(sha) || (expectedDigest && !HASH.test(expectedDigest))) throw new Error("release requires an exact SHA and digest");
    const record = await this.json(`${this.projectUrl}/releases/${releaseTag(sha)}`) as ReleaseRecord;
    if (record.tag_name !== releaseTag(sha) || record.commit?.id !== sha || !Array.isArray(record.assets?.links)) throw new Error("release tag does not identify the exact commit");
    const links = record.assets.links.filter(link => /^release\.json@[a-f0-9]{64}$/u.test(link.name));
    if (links.length !== 1) throw new Error("release must name one immutable manifest");
    const manifestSha256 = links[0]!.name.slice("release.json@".length);
    if ((expectedDigest && manifestSha256 !== expectedDigest) || (this.pins.has(sha) && this.pins.get(sha) !== manifestSha256)) throw new Error("release manifest changed after it was checked");
    const url = this.packageUrl(sha, `${manifestSha256}-release.json`);
    if (links[0]!.url !== url) throw new Error("release asset does not belong to the configured project");
    const raw = await this.bytes(await this.request(url), 65536);
    if (digest(raw) !== manifestSha256) throw new Error("release manifest digest mismatch");
    const manifest = parseReleaseManifest(raw.toString("utf8"), sha);
    if (Buffer.from(JSON.stringify(manifest)).compare(raw) !== 0) throw new Error("release manifest must use canonical JSON");
    for (const part of manifest.parts) {
      const response = await this.request(this.packageUrl(sha, `${part.sha256}-${part.file}`), { method: "HEAD" });
      if (Number(response.headers.get("content-length")) !== part.bytes) throw new Error("release package is incomplete");
    }
    this.pins.set(sha, manifestSha256);
    return { pin: { sha, manifestSha256 }, manifest, raw };
  }
  async snapshot(): Promise<ReleaseCatalogSnapshot | null> {
    if (!this.checked && this.opts.stateFile) {
      const stat = await fs.lstat(this.opts.stateFile).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || (stat.mode & 0o077))) throw new Error("saved release check must be a bounded private file");
      const saved = stat ? await fs.readFile(this.opts.stateFile, "utf8") : "null";
      const value = JSON.parse(saved) as ReleaseCatalogSnapshot | null;
      if (value && (!SHA.test(value.mainlineSha) || !Number.isFinite(Date.parse(value.checkedAt))
        || (value.ready && (!SHA.test(value.ready.sha) || !HASH.test(value.ready.manifestSha256))))) throw new Error("invalid saved release check");
      this.checked = value;
    }
    if (this.checked?.ready) this.pins.set(this.checked.ready.sha, this.checked.ready.manifestSha256);
    return this.checked;
  }
  check(): Promise<ReleaseCatalogSnapshot> {
    if (this.checking) return this.checking;
    this.checking = this.checkOnce().finally(() => { this.checking = undefined; }); return this.checking;
  }
  private async checkOnce(): Promise<ReleaseCatalogSnapshot> {
    await this.snapshot();
    const branch = this.opts.branch ?? "v4";
    const tip = await this.json(`${this.projectUrl}/repository/branches/${encodeURIComponent(branch)}`) as { commit?: { id?: string } };
    const sha = tip.commit?.id;
    if (!sha || !SHA.test(sha)) throw new Error("GitLab mainline response is invalid");
    const remote = this.opts.remote ?? "origin";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(remote)) throw new Error("invalid Git remote");
    await gitOrThrow(this.opts.repoDir, ["fetch", "--no-tags", "--no-write-fetch-head", remote, sha]);
    const history = (await gitOrThrow(this.opts.repoDir, ["rev-list", "--first-parent", "--max-count=5000", sha])).split("\n");
    const candidates = new Set<string>();
    for (let page = 1; page <= 5; page++) {
      const records = await this.json(`${this.projectUrl}/releases?per_page=50&page=${page}`) as ReleaseRecord[];
      if (!Array.isArray(records)) throw new Error("invalid GitLab release list");
      for (const record of records) if (record.tag_name === releaseTag(record.commit?.id ?? "") && SHA.test(record.commit?.id ?? "")) candidates.add(record.commit.id);
      if (records.length < 50) break;
    }
    // Commit order, never upload timestamps: a slow older build cannot win.
    const latest = history.find(candidate => candidates.has(candidate));
    const snapshot = { mainlineSha: sha, ready: latest ? (await this.release(latest)).pin : null, checkedAt: new Date().toISOString() };
    if (this.opts.stateFile) {
      await fs.mkdir(path.dirname(this.opts.stateFile), { recursive: true, mode: 0o700 });
      const temp = `${this.opts.stateFile}.${randomUUID()}.tmp`, handle = await fs.open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(snapshot)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.opts.stateFile);
    }
    this.checked = snapshot; return snapshot;
  }
  async provider(sha: string, expectedDigest?: string): Promise<ReleaseProvider> {
    const release = await this.release(sha, expectedDigest);
    return {
      target: { owner: "gitlab", device: "gitlab-ci", workspaceId: "immutable-releases" },
      manifestSha256: release.pin.manifestSha256,
      wait: async (task) => {
        if (task.sha !== sha) throw new Error("release source changed");
        return { state: "succeeded", job_id: releaseTag(sha) };
      },
      artifact: async (_key, file, offset = 0, length = 65536, signal) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 256 * 1024) throw new Error("invalid release byte range");
        if (file === "release.json") return { data: release.raw.subarray(offset, offset + length), total: release.raw.length, eof: offset + length >= release.raw.length };
        const part = release.manifest.parts.find(candidate => candidate.file === file);
        if (!part || offset >= part.bytes) throw new Error("unknown release object or offset");
        const end = Math.min(offset + length, part.bytes) - 1;
        const response = await this.request(this.packageUrl(sha, `${part.sha256}-${part.file}`), { signal, headers: { Range: `bytes=${offset}-${end}`, "Accept-Encoding": "identity" } });
        if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${offset}-${end}/${part.bytes}`) {
          await response.body?.cancel(); throw new Error("GitLab package server did not honor the pinned byte range");
        }
        const data = await this.bytes(response, end - offset + 1);
        if (data.length !== end - offset + 1) throw new Error("release object was truncated");
        return { data, total: part.bytes, eof: end + 1 === part.bytes };
      },
    };
  }
}
