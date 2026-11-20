import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { StartupIngress } from "./startup-ingress.js";

it("requires live matching edge assets, rejects stale snapshots and mismatched served bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ingress-check-"));
  const assets: Record<string, string> = {};
  const bodies: Record<string, string> = {};
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    mkdirSync(join(dir, "packages/dashboard-web/public/startup"), { recursive: true });
    mkdirSync(join(dir, "ops/caddy"), { recursive: true });
    for (const name of ["index.html", "loading.js", "loading.css", "startup.caddy"]) {
      bodies[name] = `asset ${name}\n`;
      writeFileSync(join(dir, name === "startup.caddy" ? "ops/caddy" : "packages/dashboard-web/public/startup", name), bodies[name]);
      assets[name] = createHash("sha256").update(bodies[name]).digest("hex");
    }
    git("init", "-q"); git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "assets");
    const sha = git("rev-parse", "HEAD");
    let observed = Date.now(); let corrupt = false;
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => new Response(url.pathname === "/__octopus/deploy"
      ? JSON.stringify({ observed_at: observed, status: "idle", assets })
      : corrupt ? "wrong resource" : bodies[url.pathname.split("/").at(-1)!], { headers: { "cache-control": "no-store" } })));
    const check = new StartupIngress(dir, "https://example.com");
    expect(await check.check(sha, true)).toEqual({ ready: true, reason: null });
    observed -= 60_000;
    expect((await check.check(sha, true)).ready).toBe(false);
    observed = Date.now(); corrupt = true;
    expect((await check.check(sha, true)).reason).toContain("实际提供");
    corrupt = false; assets["index.html"] = "outdated";
    expect((await check.check(sha, true)).reason).toContain("待部署版本不一致");
  } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
});
