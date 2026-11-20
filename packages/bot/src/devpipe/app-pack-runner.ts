import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AppTicketRefreshOptions } from "./app-ticket-refresh.js";
import type { WorkspaceProvider } from "./workspace-provider.js";
import { gitOrThrow } from "./worktree.js";
import { shellQuote } from "./runner-machine-sync.js";
import { parseReleaseManifest } from "./deploy-artifact.js";

export function runnerAppPacker(provider: WorkspaceProvider, signal: AbortSignal): NonNullable<AppTicketRefreshOptions["remotePack"]> {
  return async ({ worktree, script, out }) => {
    try {
      const sha = await gitOrThrow(worktree, ["rev-parse", "HEAD"]);
      const staged = await fs.readFile(path.join(worktree, ".octopus-release.json"), "utf8").catch(() => null);
      if (staged) {
        const release = parseReleaseManifest(staged, sha);
        const app = release.apps?.find(a => a.script === script);
        if (app) {
          const source = path.join(worktree, app.file);
          if ((await fs.stat(source)).size !== app.bytes) throw new Error("prepared App artifact size mismatch");
          const bytes = await fs.readFile(source);
          if (createHash("sha256").update(bytes).digest("hex") !== app.sha256) throw new Error("prepared App artifact digest mismatch");
          await fs.writeFile(out, bytes, { mode: 0o600 });
          return { ok: true, log: `App prepared with release ${sha}; no build or transfer during activation` };
        }
        if (release.apps) throw new Error(`prepared release omitted App script ${script}; refusing an after-deploy build`);
      }
      const key = `app-pack:${sha}:${script}`;
      const task = { key, workspaceKey: "app-pack", sha, sourceDir: worktree,
        command: `node scripts/ops/app-artifact-build.mjs ${sha} ${shellQuote(script)}`, timeoutMs: 1200000 };
      let status;
      const queuedAt = Date.now();
      do {
        status = await provider.wait(task, signal);
        if (status.state !== "not_started" || status.error !== "workspace_busy") break;
        if (Date.now() - queuedAt > 300000) break;
        await delay(5000, undefined, { signal });
      } while (!signal.aborted);
      if (status.state !== "succeeded") throw new Error(`App build Runner ${status.state}: ${status.error ?? status.exit_code}`);
      const raw = await provider.artifact(key, "app-manifest.json", 0, 8192, signal);
      const m = JSON.parse(raw.data.toString("utf8")) as { version: number; sha: string; bytes: number; sha256: string };
      if (!raw.eof || m.version !== 1 || m.sha !== sha || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > 24 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error("invalid App artifact identity");
      const h = await fs.open(out, "w", 0o600), hash = createHash("sha256"); let offset = 0;
      try {
        while (offset < m.bytes) {
          signal.throwIfAborted();
          const part = await provider.artifact(key, "app.json", offset, Math.min(1048576, m.bytes - offset), signal);
          if (part.total !== m.bytes || !part.data.length) throw new Error("App artifact changed during download");
          hash.update(part.data); await h.writeFile(part.data); offset += part.data.length;
        }
      } finally { await h.close(); }
      if (hash.digest("hex") !== m.sha256) throw new Error("App artifact digest mismatch");
      return { ok: true, log: `App built and packed on ${provider.target.device}; ${sha}; job ${status.job_id}` };
    } catch (error) { return { ok: false, log: String(error) }; }
  };
}
