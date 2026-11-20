import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { listRecentSessions, readSession, resolveSessionPath } from "@claude-bot/plugin-sessions/scan";
import { CodexSplitHosts } from "./codex-split-hosts.js";
import { CodexSessionRoots } from "./codex-session-roots.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "codex-split-accounts-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const account = (name: string) => path.join(home, name);
  for (const name of ["default", "account-a", "account-b"]) {
    await mkdir(account(name));
    await writeFile(path.join(account(name), "auth.json"), JSON.stringify({ token: name }));
    await writeFile(path.join(account(name), "config.toml"), '[mcp_servers.unsafe]\ncommand="user-tool"\n');
  }
  const options = { home, defaultCodexHome: account("default"), splitHome: path.join(home, ".octopus", "codex-split-home"),
    endpointFile: path.join(home, "runtime", "codex-split-app-server.endpoint"),
    accounts: [{ label: "a", codexHome: account("account-a") }, { label: "b", codexHome: account("account-b") }] };
  return { home, account, options };
}

it("uses distinct credential/config-isolated processes while reusing the selected account's host", async () => {
  const { account, options } = await fixture();
  const spawnProcess = vi.fn(() => spawn(process.execPath, ["--input-type=module", "-e", `
    import { WebSocketServer } from "ws";
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("listening", () => process.stderr.write("listening on: ws://127.0.0.1:" + server.address().port + "\\n"));
  `], { cwd: path.join(process.cwd(), "packages/runner"), stdio: ["ignore", "pipe", "pipe"] }));
  const hosts = new CodexSplitHosts({ ...options, spawnProcess: spawnProcess as unknown as typeof spawn });
  const a = hosts.select(account("account-a")), b = hosts.select(account("account-b"));
  cleanups.push(async () => { await Promise.all([a.host.close(), b.host.close(), hosts.defaultHost.close()]); });
  const first = await a.host.acquire(), second = await a.host.acquire(), other = await b.host.acquire();
  expect(first.endpoint).toBe(second.endpoint);
  expect(first.endpoint).not.toBe(other.endpoint);
  expect(spawnProcess).toHaveBeenCalledTimes(2);
  expect(hosts.defaultHost.currentEndpoint).toBeNull();
  for (const [selection, name] of [[a, "account-a"], [b, "account-b"]] as const) {
    expect(JSON.parse(await readFile(path.join(selection.codexHome, "auth.json"), "utf8"))).toEqual({ token: name });
    await expect(readFile(path.join(selection.codexHome, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(hosts.select(selection.codexHome)).toBe(selection);
  }
  first.release(); second.release(); other.release();
  // Restart/label changes preserve the native home; unregistered accounts cannot default.
  const restored = new CodexSplitHosts({ ...options, accounts: [...options.accounts].reverse() });
  expect(restored.select(a.codexHome).codexHome).toBe(a.codexHome);
  expect(restored.select().codexHome).toBe(options.splitHome);
  expect(() => restored.select(account("unregistered"))).toThrow("不能切换到默认账号");
  const terminated = [hosts.defaultHost, a.host, b.host].map((host) => vi.spyOn(host, "terminate").mockImplementation(() => {}));
  hosts.terminate();
  for (const stop of terminated) expect(stop).toHaveBeenCalledOnce();
});

it("reads named split history through the authorized corpus and excludes it from ordinary discovery", async () => {
  const { home, account, options } = await fixture();
  const hosts = new CodexSplitHosts(options);
  const a = hosts.select(account("account-a"));
  const id = "00000000-0000-0000-0000-000000000595";
  await mkdir(path.join(a.codexHome, "sessions"), { recursive: true });
  await writeFile(path.join(a.codexHome, "sessions", `rollout-${id}.jsonl`), JSON.stringify({
    type: "session_meta", payload: { id, cwd: "/remote/ticket-595", source: "exec" },
  }));
  expect(await readSession(hosts.scanRoot, { source: "codex", id })).toMatchObject({ meta: { id } });
  expect(await resolveSessionPath(hosts.scanRoot, "codex", id, undefined))
    .toMatchObject({ codexHome: a.codexHome, account_label: "a" });
  const ordinary = await new CodexSessionRoots({ home, codexHome: options.defaultCodexHome,
    discover: async () => [a.codexHome] }).refresh();
  expect(ordinary.codexHomes?.map((root) => root.codexHome)).not.toContain(a.codexHome);
  const listed = await listRecentSessions(ordinary, { limit: 20 }) as { sessions: Array<{ id: string }> };
  expect(listed.sessions.map((row) => row.id)).not.toContain(id);
});
