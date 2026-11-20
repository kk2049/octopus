import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { describeDevelopmentSession, interruptNativeDevelopment, resolveNativeDevelopmentWorkspace } from "./development-session.js";
import { machineAppendSession } from "./machine.js";
import { openCodexDaemon, CodexDaemonObserver, type CodexDaemonConnection } from "./codex-daemon.js";
import { addWorkspace } from "./workspaces.js";
import { AgentControlPlane } from "./agent-control-plane.js";
import { AgentRuntimeRegistry } from "./agent-runtime.js";
import { AgentInteractionBroker } from "./agent-interactions.js";

vi.mock("./codex-daemon.js", async original => ({ ...await original<typeof import("./codex-daemon.js")>(), openCodexDaemon: vi.fn() }));
let root: string, repo: string, codexHome: string, transcript: string;
const id = "11111111-1111-4111-8111-111111111111";
let connection: CodexDaemonConnection;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "native-cli-proof-")); repo = path.join(root, "feature"); codexHome = path.join(root, "account");
  const sessions = path.join(codexHome, "sessions", "2026", "10", "08"); await mkdir(sessions, { recursive: true });
  transcript = path.join(sessions, `rollout-2026-10-08T00-00-00-${id}.jsonl`);
  await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: repo, source: "cli", originator: "codex_cli_rs" } }) + "\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--initial-branch=dev/alice-feature", repo); git("-C", repo, "remote", "add", "origin", "git@gitlab.example:team/octopus.git");
  git("-C", repo, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "base");
  await addWorkspace(root, repo);
  connection = { loaded: vi.fn(async () => [id]), thread: vi.fn(async () => ({ id, path: transcript, turnState: "working" as const })),
    revalidate: vi.fn(async () => {}), close: vi.fn(async () => {}),
    client: { request: vi.fn(async (method: string) => method === "thread/turns/list" ? { data: [{ id: "turn-1", status: "inProgress" }] } : {}) },
  } as unknown as CodexDaemonConnection;
  vi.mocked(openCodexDaemon).mockResolvedValue(connection);
});
afterEach(async () => { vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });
const describe = (worktree?: string) => describeDevelopmentSession(root, { home: root, codexHome },
  { resolve: async () => ({ path: transcript, scan: { home: root, codexHome } }) }, { session_id: id, source: "codex", title: "Feature", ...(worktree ? { worktree } : {}) });
it("proves the loaded exact account/session and registered feature worktree without publishing private paths", async () => {
  const proof = await describe(); expect(proof).toMatchObject({ session_id: id, source: "codex", branch: "dev/alice-feature", relative_path: "" });
  expect(JSON.stringify(proof)).not.toContain(root); expect(connection.revalidate).toHaveBeenCalled();
});
it("refuses an unloaded session or another transcript in the same daemon", async () => {
  vi.mocked(connection.loaded).mockResolvedValue([]); await expect(describe()).rejects.toThrow(/loaded/);
  vi.mocked(connection.loaded).mockResolvedValue([id]);
  vi.mocked(connection.thread).mockResolvedValue({ id, path: path.join(root, "other"), turnState: "working" });
  await expect(describe()).rejects.toBeDefined();
});
it("registers an explicitly declared worktree for an existing CLI without changing its initial cwd", async () => {
  await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: root, source: "cli" } }) + "\n");
  const proof = await describe(repo);
  expect(proof).toMatchObject({ branch: "dev/alice-feature", relative_path: "" });
  expect(await resolveNativeDevelopmentWorkspace(root, proof.workspace_id, proof.relative_path)).toBe(repo);
  const continueSession = vi.fn(async () => ({ ok: true }));
  await machineAppendSession(root, { id, source: "codex", prompt: "continue", native_cli_only: true,
    native_workspace_id: proof.workspace_id, native_relative_path: proof.relative_path },
    undefined, undefined, { continueSession } as unknown as AgentControlPlane, undefined, { home: root, codexHome });
  expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({ nativeOnly: true, sessionId: id, cwd: root, takeover: false }));
  await expect(describe(root)).rejects.toThrow(/workspace/);
  await expect(resolveNativeDevelopmentWorkspace(root, proof.workspace_id, "../account")).rejects.toThrow(/invalid/);
  await symlink(codexHome, path.join(repo, "escape"));
  await expect(resolveNativeDevelopmentWorkspace(root, proof.workspace_id, "escape")).rejects.toThrow(/changed/);
  await rm(repo, { recursive: true });
  await expect(resolveNativeDevelopmentWorkspace(root, proof.workspace_id, "")).rejects.toBeDefined();
});
it("interrupts exactly the current native turn, and preserves uncertainty without another write", async () => {
  expect(await interruptNativeDevelopment(codexHome, id, transcript)).toMatchObject({ ok: true, turn_id: "turn-1" });
  expect(connection.client.request).toHaveBeenCalledWith("turn/interrupt", { threadId: id, turnId: "turn-1" }, 10000);
  vi.mocked(connection.client.request).mockImplementation(async method => { if (method === "turn/interrupt") throw new Error("lost ACK"); return { data: [{ id: "turn-2", status: "inProgress" }] }; });
  expect(await interruptNativeDevelopment(codexHome, id, transcript)).toMatchObject({ ok: false, code: "native_control_unknown" });
  expect(vi.mocked(connection.client.request).mock.calls.filter(row => row[0] === "turn/interrupt")).toHaveLength(2);
});
it("native-only input fails closed when the original CLI has exited; no managed agent is opened", async () => {
  const runtime = new AgentRuntimeRegistry(), interaction = new AgentInteractionBroker();
  const plane = new AgentControlPlane({ runtime, interactions: interaction, timeoutMs: 1000, codexDaemon: new CodexDaemonObserver(async () => null) });
  try {
    await expect(plane.continueSession({ nativeOnly: true, provider: "codex", sessionId: id, sessionPath: transcript,
      codexHome, prompt: "continue", cwd: repo, takeover: false })).rejects.toThrow(/no agent was started/);
  } finally { await plane.close(); }
});

it("proves a native Claude Code session through its exact hook-observed process, never a daemon", async () => {
  const claudeId = "22222222-2222-4222-8222-222222222222";
  const claudeTranscript = path.join(root, ".claude", "projects", "-feature", `${claudeId}.jsonl`);
  await mkdir(path.dirname(claudeTranscript), { recursive: true });
  await writeFile(claudeTranscript, JSON.stringify({ type: "user", sessionId: claudeId, cwd: repo, timestamp: "2026-10-14T00:00:00Z",
    message: { role: "user", content: "start" } }) + "\n");
  const process = { pid: 4242, startTicks: "99", bootId: "boot", pgid: 4242, tty: 1, command: "claude" };
  const inspect = vi.fn(async () => ({ process, processState: "alive", turnState: "working", controlMode: "external_cli",
    event: "PreToolUse", observedAt: new Date().toISOString(), exactProcessAlive: true, detached: false }));
  const prove = () => describeDevelopmentSession(root, { home: root, codexHome },
    { resolve: async () => ({ path: claudeTranscript, scan: { home: root, codexHome } }) },
    { session_id: claudeId, source: "claude", title: "Claude feature" }, { inspect } as never);
  expect(await prove()).toMatchObject({ source: "claude", session_id: claudeId, branch: "dev/alice-feature", relative_path: "" });
  expect(openCodexDaemon).not.toHaveBeenCalled();
  expect(inspect).toHaveBeenCalledTimes(2);
  // A process that exits or is replaced during registration does not produce a proof.
  inspect.mockResolvedValueOnce(await inspect()).mockResolvedValueOnce({ ...(await inspect()), process: { ...process, startTicks: "100" } });
  await expect(prove()).rejects.toThrow(/exited/);
  inspect.mockResolvedValue({ ...(await inspect()), controlMode: "octopus_headless" });
  await expect(prove()).rejects.toThrow(/live Claude Code CLI/);
  await expect(describeDevelopmentSession(root, { home: root, codexHome },
    { resolve: async () => ({ path: claudeTranscript, scan: { home: root, codexHome } }) },
    { session_id: claudeId, source: "omp" })).rejects.toThrow(/Codex or Claude Code/);
});
it("routes native Claude input and stop only to the registered CLI, never an SDK resume", async () => {
  const claudeId = "22222222-2222-4222-8222-222222222222";
  const claudeTranscript = path.join(root, ".claude", "projects", "-feature", `${claudeId}.jsonl`);
  await mkdir(path.dirname(claudeTranscript), { recursive: true });
  await writeFile(claudeTranscript, JSON.stringify({ type: "user", sessionId: claudeId, cwd: repo, timestamp: "2026-10-14T00:00:00Z",
    message: { role: "user", content: "start" } }) + "\n");
  const proof = await describeDevelopmentSession(root, { home: root, codexHome },
    { resolve: async () => ({ path: claudeTranscript, scan: { home: root, codexHome } }) },
    { session_id: claudeId, source: "claude" }, { inspect: async () => ({ process: { pid: 1, startTicks: "1", bootId: "b" },
      processState: "alive", turnState: "idle", controlMode: "external_cli", event: "Stop", observedAt: "", exactProcessAlive: true, detached: false }) } as never);
  const continueSession = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true })), interruptNativeCli = vi.fn(async (_provider: string, _id: string) => ({ ok: true }));
  const plane = { continueSession, interruptNativeCli } as unknown as AgentControlPlane;
  const native = { id: claudeId, source: "claude", native_cli_only: true, native_workspace_id: proof.workspace_id, native_relative_path: proof.relative_path };
  await machineAppendSession(root, { ...native, prompt: "continue" }, undefined, undefined, plane, undefined, { home: root, codexHome });
  expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({ nativeOnly: true, provider: "claude", sessionId: claudeId, takeover: false }));
  expect(continueSession.mock.calls[0]![0]).not.toHaveProperty("codexHome");
  await machineAppendSession(root, { ...native, interrupt: true }, undefined, undefined, plane, undefined, { home: root, codexHome });
  expect(interruptNativeCli).toHaveBeenCalledWith("claude", claudeId);
  await expect(machineAppendSession(root, { ...native, prompt: "x", model: "other" }, undefined, undefined, plane, undefined, { home: root, codexHome }))
    .rejects.toThrow(/cannot launch/);
});
it("native-only Claude input refuses without a live external CLI instead of resuming through the SDK", async () => {
  const runtime = new AgentRuntimeRegistry(), interaction = new AgentInteractionBroker();
  const plane = new AgentControlPlane({ runtime, interactions: interaction, timeoutMs: 1000, codexDaemon: new CodexDaemonObserver(async () => null) });
  try {
    await expect(plane.continueSession({ nativeOnly: true, provider: "claude", sessionId: "22222222-2222-4222-8222-222222222222",
      prompt: "continue", cwd: repo, takeover: false })).rejects.toThrow(/no agent was started/);
    await expect(plane.interruptNativeCli("claude", "22222222-2222-4222-8222-222222222222")).rejects.toThrow(/not by the registered native CLI/);
  } finally { await plane.close(); }
});
