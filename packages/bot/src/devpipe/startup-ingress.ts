import { runChild } from "./child-output.js";
import { createHash } from "node:crypto";

const paths = {
  "index.html": "packages/dashboard-web/public/startup/index.html",
  "loading.js": "packages/dashboard-web/public/startup/loading.js",
  "loading.css": "packages/dashboard-web/public/startup/loading.css",
  "startup.caddy": "ops/caddy/startup.caddy",
};
export interface StartupIngressStatus { ready: boolean; reason: string | null }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Probe public, credential-free edge artifacts; never retries a capability. */
export class StartupIngress {
  constructor(private readonly repo: string, private readonly origin: string) {}
  private cache: { sha: string; at: number; result: Promise<StartupIngressStatus> } | null = null;

  check(sha: string, fresh = false): Promise<StartupIngressStatus> {
    if (!fresh && this.cache?.sha === sha && Date.now() - this.cache.at < 10_000) return this.cache.result;
    const result = this.probe(sha).catch(() => ({ ready: false, reason: "入口加载页或独立部署状态不可达" }));
    this.cache = { sha, at: Date.now(), result };
    return result;
  }

  private async probe(sha: string): Promise<StartupIngressStatus> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("expected commit SHA");
    const read = async (path: string) => {
      const response = await fetch(new URL(path, this.origin), {
        redirect: "error", signal: AbortSignal.timeout(3000),
      });
      if (!response.ok || response.headers.get("cache-control") !== "no-store") throw new Error("edge unavailable");
      const body = await response.text();
      if (body.length > 64_000) throw new Error("edge response too large");
      return body;
    };
    const state = JSON.parse(await read("/__octopus/deploy"));
    if (!Number.isFinite(state.observed_at) || Math.abs(Date.now() - state.observed_at) > 8000 || state.status === "unknown") {
      return { ready: false, reason: "独立部署状态未就绪或已停止更新" };
    }
    for (const [name, path] of Object.entries(paths)) {
      const shown = await runChild("git", ["show", `${sha}:${path}`], { cwd: this.repo, timeoutMs: 3000 });
      if (shown.error) throw shown.error;
      const stdout = shown.stdout.text();
      if (state.assets?.[name] !== hash(stdout)) return { ready: false, reason: "入口加载页与待部署版本不一致，请先安装该版本的入口资源" };
      if (name === "loading.js" || name === "loading.css") {
        if (hash(await read(`/__octopus/startup/${name}`)) !== hash(stdout)) {
          return { ready: false, reason: "入口实际提供的资源与安装记录不一致" };
        }
      }
    }
    return { ready: true, reason: null };
  }
}
