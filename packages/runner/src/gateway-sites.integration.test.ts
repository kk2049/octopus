import { writeCapabilityRegistration, removeCapabilityRegistration } from "./capability-registry.js";
import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { writeInstalledConfig, type RunnerInstallConfig } from "./install-config.js";

const roots: string[] = [];
const servers: WebSocketServer[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } }
  for (const server of servers.splice(0)) { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function gateway() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); servers.push(server); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const frames: Array<{ socket: WebSocket; message: Record<string, any> }> = [];
  let connections = 0;
  server.on("connection", (socket) => {
    connections++;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)); frames.push({ socket, message });
      if (message.type === "register") socket.send(JSON.stringify({ type: "registered", username: "test", device: "test", update_available: true, bundle_sha: "f".repeat(64) }));
      if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    });
  });
  return { frames, url: `ws://127.0.0.1:${port}/runner`, dashboard: `http://127.0.0.1:${port}`, connections: () => connections };
}

it("returns command output to its caller; only Windows/macOS erase legacy endpoint logs and keep daemon output empty", async () => {
  const peer = await gateway();
  const home = mkdtempSync(path.join(tmpdir(), "runner-private-ws-")); roots.push(home);
  const logs = path.join(home, ".octopus", "runner", "logs"); mkdirSync(logs, { recursive: true });
  const oldLog = path.join(logs, "runner.out.log"); writeFileSync(oldLog, "old private command");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/standalone.js", import.meta.url))], {
    env: { ...process.env, RUNNER_SCAN_HOME: home, OCTOPUS_URL: peer.url, OCTOPUS_RUNNER_TOKEN: `rt_${"a".repeat(32)}`,
      RUNNER_DEVICE: "test", RUNNER_EXECUTION_ONLY: "1", RUNNER_ALLOW_MACHINE_OPS: "1", RUNNER_SELF_UPDATE: "0",
      RUNNER_LOCAL_MCP: "off", RUNNER_AGENT_HOOKS: "manual", CODEX_HOME: path.join(home, ".codex") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let output = "";
  child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  await expect.poll(() => peer.frames.find(row => row.message.type === "register"), { timeout: 15000 }).toBeTruthy();
  const connection = peer.frames.find(row => row.message.type === "register")!;
  connection.socket.send(JSON.stringify({ type: "rpc", id: "private", method: "exec",
    args: { command: "printf private-result; printf private-error >&2; exit 7" } }));
  await expect.poll(() => peer.frames.find(row => row.message.id === "private"), { timeout: 5000 }).toBeTruthy();
  expect(peer.frames.find(row => row.message.id === "private")!.message.result)
    .toMatchObject({ stdout: "private-result", stderr: "private-error", exit_code: 7 });
  if (process.platform === "linux") {
    // Linux servers keep their resident log, including the machine-op audit line.
    expect(readFileSync(oldLog, "utf8")).toBe("old private command");
    await expect.poll(() => output, { timeout: 5000 }).toContain("machine-op exec");
  } else {
    expect(readFileSync(oldLog, "utf8")).toBe("");
    expect(output).toBe("");
  }
}, 20000);

it("hot-adds a second gateway, routes colliding RPC ids independently, and keeps primary alive through secondary reconnect/removal", async () => {
  const primary = await gateway(); const secondary = await gateway();
  const home = mkdtempSync(path.join(tmpdir(), "runner-multi-ws-")); roots.push(home);
  const tokenFile = path.join(home, "secondary.token"); writeFileSync(tokenFile, `rt_${"b".repeat(32)}\n`, { mode: 0o600 });
  const config: RunnerInstallConfig = { version: 1, dashboard_url: primary.dashboard, runner_url: primary.url, device: "test", scan_home: home, codex_home: path.join(home, ".codex"), installed_at: new Date().toISOString(), update_site: "none" };
  writeInstalledConfig(config);
  const bundle = fileURLToPath(new URL("../dist/standalone.js", import.meta.url));
  const child = spawn(process.execPath, [bundle], { env: { ...process.env, RUNNER_SCAN_HOME: home, OCTOPUS_URL: primary.url, OCTOPUS_RUNNER_TOKEN: `rt_${"a".repeat(32)}`, RUNNER_DEVICE: "test", RUNNER_EXECUTION_ONLY: "1", RUNNER_ALLOW_MACHINE_OPS: "1", RUNNER_SELF_UPDATE: "1", RUNNER_LOCAL_MCP: "off", RUNNER_AGENT_HOOKS: "manual", CODEX_HOME: config.codex_home }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let output = ""; child.stdout!.on("data", (data) => { output += data; }); child.stderr!.on("data", (data) => { output += data; });
  await expect.poll(() => primary.frames.find((row) => row.message.type === "register"), { timeout: 15000 }).toBeTruthy();
  config.additional_sites = [{ id: "octo", dashboard_url: secondary.dashboard, runner_url: secondary.url, token_file: tokenFile }]; writeInstalledConfig(config);
  await expect.poll(() => secondary.frames.find((row) => row.message.type === "register"), { timeout: 10000 }).toBeTruthy();
  const p = primary.frames.find((row) => row.message.type === "register")!;
  const s = secondary.frames.find((row) => row.message.type === "register")!;
  expect(p.message.token).toBe(`rt_${"a".repeat(32)}`); expect(s.message.token).toBe(`rt_${"b".repeat(32)}`);
  expect(p.message.self_update_enabled).toBe(false); expect(s.message.self_update_enabled).toBe(false);
  p.socket.send(JSON.stringify({ type: "rpc", id: "collision", method: "exec", args: { command: "printf primary" } }));
  s.socket.send(JSON.stringify({ type: "rpc", id: "collision", method: "exec", args: { command: "printf secondary" } }));
  await expect.poll(() => primary.frames.find((row) => row.message.id === "collision"), { timeout: 5000 }).toBeTruthy();
  await expect.poll(() => secondary.frames.find((row) => row.message.id === "collision"), { timeout: 5000 }).toBeTruthy();
  expect(primary.frames.find((row) => row.message.id === "collision")!.message.result.stdout).toBe("primary");
  expect(secondary.frames.find((row) => row.message.id === "collision")!.message.result.stdout).toBe("secondary");
  s.socket.terminate();
  await expect.poll(() => secondary.connections(), { timeout: 10000 }).toBe(2);
  expect(primary.connections(), output).toBe(1);
  config.additional_sites = []; writeInstalledConfig(config);
  await expect.poll(() => [...servers[1]!.clients].length, { timeout: 10000 }).toBe(0);
  p.socket.send(JSON.stringify({ type: "rpc", id: "still-alive", method: "host_info", args: {} }));
  await expect.poll(() => primary.frames.find((row) => row.message.id === "still-alive"), { timeout: 5000 }).toBeTruthy();
  expect(primary.connections(), output).toBe(1);
  expect([...primary.frames, ...secondary.frames].some((row) => row.message.type === "bundle_request")).toBe(false);
  expect(child.exitCode, output).toBeNull();
}, 45000);

it("hot-registers and removes a capability without reconnecting the resident, and refuses secondary-site calls", async () => {
  const primary = await gateway(), secondary = await gateway();
  const home = mkdtempSync(path.join(tmpdir(), "runner-capability-ws-")); roots.push(home);
  const tokenFile = path.join(home, "secondary.token"); writeFileSync(tokenFile, `rt_${"b".repeat(32)}\n`, { mode: 0o600 });
  const config: RunnerInstallConfig = { version: 1, dashboard_url: primary.dashboard, runner_url: primary.url, device: "test",
    scan_home: home, codex_home: path.join(home, ".codex"), installed_at: new Date().toISOString(), update_site: "none",
    additional_sites: [{ id: "second", dashboard_url: secondary.dashboard, runner_url: secondary.url, token_file: tokenFile }] };
  writeInstalledConfig(config);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/standalone.js", import.meta.url))], {
    env: { ...process.env, RUNNER_SCAN_HOME: home, OCTOPUS_URL: primary.url, OCTOPUS_RUNNER_TOKEN: `rt_${"a".repeat(32)}`,
      RUNNER_DEVICE: "test", RUNNER_EXECUTION_ONLY: "1", RUNNER_ALLOW_MACHINE_OPS: "1", RUNNER_SELF_UPDATE: "0",
      RUNNER_LOCAL_MCP: "off", RUNNER_AGENT_HOOKS: "manual", CODEX_HOME: config.codex_home }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let output = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  await expect.poll(() => primary.frames.find(row => row.message.type === "register"), { timeout: 15000 }).toBeTruthy();
  await expect.poll(() => secondary.frames.find(row => row.message.type === "register"), { timeout: 15000 }).toBeTruthy();
  const p = primary.frames.find(row => row.message.type === "register")!, s = secondary.frames.find(row => row.message.type === "register")!;
  expect(s.message.inventory.capabilities).toBeUndefined();
  const program = path.join(home, "echo.mjs");
  writeFileSync(program, `import readline from "node:readline";
readline.createInterface({input:process.stdin}).on("line",line=>{
 const r=JSON.parse(line);if(r.id===undefined)return;
 const result=r.method==="initialize"?{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"demo",version:"1"}}:
 r.method==="tools/list"?{tools:[{name:"echo",inputSchema:{type:"object"}}]}:
 {content:[{type:"text",text:"ok"}]};
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\n");
});`);
  const digest = await writeCapabilityRegistration(home, { schema: "runner-capability-registration/v1", id: "demo",
    title: "Demo", version: "1", command: process.execPath, args: [program], enabled: true }, "absent");
  const ready = () => primary.frames.find(row => row.message.type === "inventory_changed"
    && row.message.inventory?.capabilities?.providers?.[0]?.status === "ready");
  await expect.poll(ready, { timeout: 10000 }).toBeTruthy();
  const revision = ready()!.message.inventory.capabilities.providers[0].revision;
  const args = { provider: "demo", revision, tool: "echo", request_id: "req", input_json: "{}" };
  p.socket.send(JSON.stringify({ type: "rpc", id: "extension", method: "invoke_runner_capability", args }));
  s.socket.send(JSON.stringify({ type: "rpc", id: "secondary-extension", method: "invoke_runner_capability", args }));
  await expect.poll(() => primary.frames.find(row => row.message.id === "extension"), { timeout: 5000 }).toBeTruthy();
  await expect.poll(() => secondary.frames.find(row => row.message.id === "secondary-extension"), { timeout: 5000 }).toBeTruthy();
  expect(primary.frames.find(row => row.message.id === "extension")!.message.result.status, output).toBe("succeeded");
  expect(secondary.frames.find(row => row.message.id === "secondary-extension")!.message.ok).toBe(false);
  const before = primary.frames.length;
  await removeCapabilityRegistration(home, "demo", digest);
  await expect.poll(() => primary.frames.slice(before).some(row => row.message.type === "inventory_changed"
    && row.message.inventory?.capabilities?.providers?.length === 0), { timeout: 10000 }).toBe(true);
  expect(secondary.frames.filter(row => row.message.type === "inventory_changed").every(row => row.message.inventory.capabilities === undefined)).toBe(true);
  expect(primary.connections(), output).toBe(1);
  expect(secondary.connections(), output).toBe(1);
  expect(child.exitCode, output).toBeNull();
}, 45000);
