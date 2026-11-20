import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

export const haveCaddy = spawnSync("caddy", ["version"], { stdio: "ignore" }).status === 0;

export async function startupFixture() {
  const requests: Array<{ method: string; url: string; cookie?: string; authorization?: string }> = [];
  let loginStatus = 200;
  const backend = createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url!, cookie: req.headers.cookie, authorization: req.headers.authorization });
    const path = new URL(req.url!, "http://localhost").pathname;
    const statuses: Record<string, number> = { "/denied": 403, "/missing": 404, "/broken": 500, "/api/action": 503 };
    res.writeHead(path === "/login" ? loginStatus : statuses[path] ?? 401, { "content-type": "text/html" });
    res.end("<!doctype html><html><body>Backend response</body></html>");
  });
  await new Promise<void>((done) => backend.listen(0, "127.0.0.1", done));
  const upstreamPort = (backend.address() as { port: number }).port;
  const reserve = createServer();
  await new Promise<void>((done) => reserve.listen(0, "127.0.0.1", done));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((done) => reserve.close(() => done()));
  const dir = mkdtempSync(join(tmpdir(), "octopus-startup-test-"));
  const root = resolve(import.meta.dirname, "../..");
  const assets = join(dir, "assets");
  cpSync(join(root, "packages/dashboard-web/public/startup"), assets, { recursive: true });
  mkdirSync(join(dir, "status"));
  const config = join(dir, "Caddyfile");
  writeFileSync(config, `{
  admin off
  auto_https off
  persist_config off
}
import ${root}/ops/caddy/startup.caddy
http://127.0.0.1:${port} {
  handle /octopus-runner/v1* {
    reverse_proxy 127.0.0.1:${upstreamPort}
  }
  import octopus_startup ${assets} 127.0.0.1:${upstreamPort}
}
`);
  const caddy = spawn("caddy", ["run", "--config", config, "--adapter", "caddyfile"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir },
  });
  let log = "";
  caddy.stderr.on("data", (data: Buffer) => { log = (log + data).slice(-8000); });
  const base = `http://127.0.0.1:${port}`;
  const close = async () => {
    if (caddy.exitCode === null) {
      const exited = once(caddy, "exit");
      caddy.kill("SIGTERM");
      await exited;
    }
    backend.closeAllConnections();
    if (backend.listening) await new Promise<void>((done) => backend.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    for (let i = 0; ; i++) {
      try {
        await fetch(`${base}/__octopus/startup/loading.css`);
        break;
      } catch {
        if (i === 100 || caddy.exitCode !== null) throw new Error(`Caddy did not start: ${log}`);
        await new Promise((done) => setTimeout(done, 50));
      }
    }
  } catch (error) { await close(); throw error; }
  return {
    base, requests, close,
    setDeployment: (status: string, id = 1, observedAt = Date.now(), updatedAt = new Date(observedAt).toISOString()) => writeFileSync(join(dir, "status/status.json"), JSON.stringify({ id, status, observed_at: observedAt, created_at: updatedAt, updated_at: updatedAt, http_ready: backend.listening })),
    setLoginStatus: (status: number) => { loginStatus = status; },
    stopBackend: async () => {
      backend.closeAllConnections();
      await new Promise<void>((done) => backend.close(() => done()));
    },
    startBackend: async () => {
      await new Promise<void>((done) => backend.listen(upstreamPort, "127.0.0.1", done));
    },
  };
}
