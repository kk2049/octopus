import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { HOOK_REPORTER_SOURCE } from "./hook-reporter.js";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function run(provider: string, payload: unknown, reply?: unknown) {
  const home = await mkdtemp(path.join(tmpdir(), "hook-reporter-")); directories.push(home);
  await mkdir(path.join(home, "octopus-runner"));
  const file = path.join(home, "reporter.mjs"); await writeFile(file, HOOK_REPORTER_SOURCE);
  let envelope: Record<string, unknown> | undefined;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let text = ""; socket.on("data", (data) => { text += data; });
    socket.on("end", () => { envelope = JSON.parse(text); socket.end(JSON.stringify(reply) + "\n"); });
  });
  if (reply) await new Promise<void>((resolve) => server.listen(path.join(home, "octopus-runner", "hooks.sock"), resolve));
  const child = spawn(process.execPath, [file, provider], { env: { ...process.env, XDG_RUNTIME_DIR: home } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (reply) await new Promise<void>((resolve) => server.close(() => resolve()));
  return { code, stdout, stderr, envelope, pid: child.pid };
}
describe("small standalone hook reporter", () => {
  it("reports its own PID and native payload, preserving Codex Stop JSON", async () => {
    const result = await run("codex", { hook_event_name: "Stop", session_id: "one" }, { ok: true });
    expect(result).toMatchObject({ code: 0, stdout: "{}\n", stderr: "" });
    expect(result.envelope).toEqual({ provider: "codex", reporter_pid: result.pid, payload: { hook_event_name: "Stop", session_id: "one" } });
  });
  it("passes native Claude control replies and fails open on an absent Runner", async () => {
    const output = { hookSpecificOutput: { permissionDecision: "deny" } };
    expect((await run("claude", { hook_event_name: "PermissionRequest" }, { ok: true, hook_output: output })).stdout).toBe(JSON.stringify(output) + "\n");
    expect(await run("codex", { hook_event_name: "Stop" })).toMatchObject({ code: 0, stdout: "{}\n" });
  });
});
