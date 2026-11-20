import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { CodexDaemonObserver, daemonTmuxPeer, openCodexDaemon } from "./codex-daemon.js";
import { AgentRuntimeRegistry, LinuxProcessReader, type ProcSnapshot } from "./agent-runtime.js";
import { AgentControlPlane } from "./agent-control-plane.js";
import { AgentInteractionBroker } from "./agent-interactions.js";
import { CodexManagedSession } from "./codex-app-server.js";
import { queueCodexPrompt } from "./codex-native-queue.js";
import { TerminalControl } from "./terminal-control.js";

const id = "01a0e1c4-bb39-7383-a13f-f228434b5c00";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });

async function fixture() {
  const home = await fs.mkdtemp(path.join(tmpdir(), "codex-daemon-"));
  const dir = path.join(home, "app-server-control"); await fs.mkdir(dir);
  const endpoint = path.join(dir, "app-server-control.sock");
  const server = createServer(); const ws = new WebSocketServer({ server });
  const pid = process.pid;
  const daemon: ProcSnapshot = { pid, ppid: 1, pgid: pid, tty: 0, bootId: "boot", startTicks: "100",
    command: "codex", argv: ["/bin/codex", "app-server", "--listen", "unix://", "--managed-daemon"] };
  let current = { ...daemon };
  vi.spyOn(LinuxProcessReader.prototype, "read").mockImplementation(async (p) => p === pid ? current : null);
  const readFile = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation(((file: Parameters<typeof fs.readFile>[0], options?: unknown) =>
    file === `/proc/${pid}/environ` ? Promise.resolve(`CODEX_HOME=${home}\0`) : readFile(file, options as never)) as typeof fs.readFile);
  const state = { loaded: [id], cursor: null as string | null, response: "ok", turn: { id: "turn-current", status: "inProgress" }, thread: { id, originator: "codex-tui",
    threadSource: "user", canAcceptDirectInput: true, path: path.join(home, "sessions", "rollout.jsonl"),
    status: { type: "idle", activeFlags: [] as string[] }, parentThreadId: null as string | null } };
  await fs.mkdir(path.dirname(state.thread.path)); await fs.writeFile(state.thread.path, "");
  const methods: string[] = [];
  const inputs: Array<{ method: string; params: Record<string, unknown> }> = [];
  ws.on("connection", (socket) => socket.on("message", (data) => {
    const m = JSON.parse(String(data)); methods.push(m.method);
    if (m.id === undefined) return;
    let result: unknown = {};
    if (m.method === "server/diagnostics") result = { process: { id: pid } };
    if (m.method === "thread/loaded/list") result = { data: state.loaded, nextCursor: state.cursor };
    if (m.method === "thread/read") result = { thread: state.thread };
    if (m.method === "thread/turns/list") {
      expect(m.params).toEqual({ threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      result = { data: [state.turn] };
    }
    if (m.method === "turn/start" || m.method === "turn/steer") {
      inputs.push(m);
      if (state.response === "disconnect") { socket.close(); return; }
      if (state.response === "refused") {
        socket.send(JSON.stringify({ id: m.id, error: { code: -32600, message: "no active turn to steer" } })); return;
      }
      result = state.response === "malformed" ? {} : m.method === "turn/steer"
        ? { turnId: state.response === "mismatch" ? "different-turn" : state.turn.id }
        : { turn: state.turn };
    }
    if (m.method === "thread/queue/add") {
      if (state.response === "disconnect") { socket.close(); return; }
      result = { queuedSubmission: { id: "queued-1", clientUserMessageId: m.params.clientUserMessageId } };
    }
    socket.send(JSON.stringify({ id: m.id, result }));
  }));
  server.listen(endpoint); await once(server, "listening"); await fs.chmod(endpoint, 0o600);
  cleanups.push(async () => { for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => server.close(() => resolve())));
    await fs.rm(home, { recursive: true, force: true }); });
  return { home, endpoint, daemon, state, methods, inputs, replaceProcess: () => { current = { ...daemon, startTicks: "101" }; } };
}

const sockets = (daemonPid: number, tuiPid: number) => [
  `u_str ESTAB 0 0 /tmp/native-daemon 200 * 201 users:(("codex",pid=${daemonPid},fd=13))`,
  `u_str ESTAB 0 0 * 201 * 200 users:(("codex",pid=${tuiPid},fd=38))`,
].join("\n");

it("connects only to the native account daemon and never loads a writer", async () => {
  const f = await fixture(); const connection = await openCodexDaemon(f.home);
  try {
    expect(await connection!.loaded()).toEqual([id]);
    expect(await connection!.thread(id)).toMatchObject({ id, turnState: "idle" });
    await connection!.revalidate();
    f.replaceProcess(); await expect(connection!.revalidate()).rejects.toThrow("identity changed");
    expect(f.methods).toEqual(["initialize", "initialized", "server/diagnostics", "thread/loaded/list", "thread/read"]);
  } finally { await connection?.close(); }
});

it("rejects accessible sockets and partial native inventories", async () => {
  const f = await fixture(); await fs.chmod(f.endpoint, 0o666);
  await expect(openCodexDaemon(f.home)).rejects.toThrow("not private"); expect(f.methods).toEqual([]);
  await fs.chmod(f.endpoint, 0o600); f.state.cursor = "more";
  const c = await openCodexDaemon(f.home);
  try { await expect(c!.loaded()).rejects.toThrow("Incomplete"); } finally { await c?.close(); }
});

it.each(["child", "wrong-id", "internal", "waiting"])("keeps %s out of ordinary daemon input", async (mode) => {
  const f = await fixture();
  if (mode === "child") f.state.thread.canAcceptDirectInput = false;
  if (mode === "wrong-id") f.state.thread.id = "different";
  if (mode === "internal") f.state.thread.threadSource = "thread_title";
  if (mode === "waiting") f.state.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  const c = await openCodexDaemon(f.home);
  try {
    const result = await c!.thread(id);
    if (mode === "waiting") expect(result?.turnState).toBe("needs_input"); else expect(result).toBeNull();
  } finally { await c?.close(); }
});

it("projects one socket-proven tmux TUI without granting takeover, signals or terminal writes", async () => {
  const f = await fixture();
  const tui = { ...f.daemon, pid: process.pid + 1, tty: 8, argv: ["codex"] };
  vi.spyOn(fs, "readlink").mockResolvedValue("/dev/pts/8");
  const observer = new CodexDaemonObserver(openCodexDaemon, async () => sockets(f.daemon.pid, tui.pid));
  const rows = [f.daemon, tui];
  expect(await observer.refresh(f.home, rows, new Set(["/dev/pts/8"]), async () => true)).toHaveLength(1);
  expect(observer.runtime(id)).toMatchObject({ process_state: "alive", attachment: { kind: "terminal_tmux" },
    capabilities: { protocol_append: true, takeover: false, interrupt: false, terminal_append: false } });
  // Several loaded identities make terminal association ambiguous, but do not
  // remove the exact daemon queue route for a native root.
  f.state.loaded.push("00000000-0000-0000-0000-000000000002");
  await observer.refresh(f.home, rows, new Set(["/dev/pts/8"]), async () => true);
  expect(observer.runtime(id)?.attachment.kind).toBe("codex_app_server");
  await observer.refresh(f.home, rows, new Set(["/dev/pts/8"]), async () => false);
  expect(observer.runtime(id)).toBeUndefined();
  f.replaceProcess();
  expect(await observer.refresh(f.home, rows, new Set(["/dev/pts/8"]), async () => true)).toEqual([]);
});

it("refuses one-way socket matches and multiple TUI clients", () => {
  const proc = (pid: number): ProcSnapshot => ({ pid, ppid: 1, pgid: pid, tty: 8, bootId: "b", startTicks: "1", command: "codex", argv: ["codex"] });
  expect(daemonTmuxPeer(10, [proc(20)], new Set([20]), sockets(10, 20))).toBe(true);
  expect(daemonTmuxPeer(10, [proc(20)], new Set([20]), sockets(10, 20).split("\n")[0])).toBe(false);
  const another = sockets(10, 21).replaceAll("200", "300").replaceAll("201", "301");
  expect(daemonTmuxPeer(10, [proc(20), proc(21)], new Set([20]), sockets(10, 20) + "\n" + another)).toBe(false);
});

it.each(["idle", "working", "needs_input"] as const)("keeps exact hook tmux evidence alongside daemon %s when ss is absent", async (state) => {
  const f = await fixture();
  f.state.thread.status = state === "idle" ? { type: "idle", activeFlags: [] }
    : { type: "active", activeFlags: state === "needs_input" ? ["waitingOnUserInput"] : [] };
  const tui: ProcSnapshot = { ...f.daemon, pid: process.pid + 100, tty: 8, argv: ["codex"], startTicks: "200" };
  const hook: ProcSnapshot = { ...tui, pid: tui.pid + 1, ppid: tui.pid, argv: ["node", "runner", "hook"] };
  let alive = true;
  const runtime = new AgentRuntimeRegistry({ processReader: {
    read: async (pid) => pid === hook.pid ? hook : pid === tui.pid && alive ? tui : null,
    signal: () => { throw new Error("observation must not signal"); },
  } });
  await runtime.recordHook("codex", { session_id: id, hook_event_name: "PreToolUse" }, hook.pid);
  const observer = new CodexDaemonObserver(openCodexDaemon, async () => { throw new Error("ss ENOENT"); });
  // A second loaded thread cannot steal the exact hook's terminal evidence.
  f.state.loaded.push("00000000-0000-0000-0000-000000000002");
  await observer.refresh(f.home, [f.daemon, tui], new Set(), async () => true);
  const run = vi.fn(async (_bin: string, _args: string[]) => ({ stdout: "%4\t/dev/pts/8\t0\t0\n" }));
  const plane = new AgentControlPlane({ runtime, interactions: new AgentInteractionBroker(), timeoutMs: 1000,
    codexDaemon: observer, terminal: new TerminalControl({ readlink: async () => "/dev/pts/8", run }) });
  expect(await plane.publicRuntime("codex", id)).toMatchObject({ turn_state: state,
    attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" },
    capabilities: { protocol_append: state !== "needs_input", takeover: false, interrupt: false, terminal_append: false } });
  expect(run.mock.calls.map((call) => call[1][0])).toEqual(["list-panes"]);
  alive = false;
  expect(await plane.publicRuntime("codex", id)).toMatchObject({ attachment: { kind: "codex_app_server" } });
  expect(await plane.publicRuntime("codex", "00000000-0000-0000-0000-000000000002")).toBeUndefined();
});

it.each(["ok", "disconnect", "takeover", "waiting", "replaced", "path-changed", "socket-mode"])("routes a hookless daemon %s through its existing writer without managed resume", async (mode) => {
  const f = await fixture(); f.state.response = mode;
  if (mode === "waiting") f.state.thread.status = { type: "active", activeFlags: ["waitingOnUserInput"] };
  const resume = vi.spyOn(CodexManagedSession, "resume");
  const runtime = new AgentRuntimeRegistry(); const signal = vi.spyOn(process, "kill");
  const queue = vi.fn(async (options: Parameters<typeof queueCodexPrompt>[0]) => {
    if (mode === "replaced") f.replaceProcess();
    if (mode === "socket-mode") await fs.chmod(f.endpoint, 0o666);
    return queueCodexPrompt(options);
  });
  const plane = new AgentControlPlane({ runtime, interactions: new AgentInteractionBroker(), timeoutMs: 1000,
    codexDaemon: new CodexDaemonObserver(), queueCodexPrompt: queue });
  const onInput = vi.fn(async () => {});
  const call = plane.continueSession({ provider: "codex", sessionId: id, codexHome: f.home,
    sessionPath: mode === "path-changed" ? f.home : f.state.thread.path,
    cwd: f.home, prompt: "one native prompt", takeover: mode === "takeover", onInput });
  if (mode === "ok") {
    await expect(call).resolves.toMatchObject({ ok: true, transport: "app-server", turn_id: "turn-current", control_action: "protocol_send" });
    expect(onInput).toHaveBeenCalledWith(expect.objectContaining({ phase: "provider_accepted", evidence: "provider_ack" }));
  } else if (mode === "disconnect") await expect(call).resolves.toMatchObject({ ok: false, code: "unknown" });
  else await expect(call).resolves.toMatchObject({ ok: false, code: expect.not.stringMatching(/^unknown$/) });
  expect(f.methods.filter((m) => m === "turn/start")).toHaveLength(["ok", "disconnect"].includes(mode) ? 1 : 0);
  expect(f.methods).not.toContain("thread/resume"); expect(f.methods).not.toContain("thread/queue/add");
  expect(resume).not.toHaveBeenCalled(); expect(signal).not.toHaveBeenCalled();
  expect(runtime.publicRuntime("codex", id)).toBeUndefined();
  await plane.close();
});

it.each(["ok", "observer-origin", "refused", "disconnect", "malformed", "mismatch", "ended", "missing-turn", "unloaded"])(
  "steers a working native TUI once with exact turn evidence: %s", async mode => {
    const f = await fixture(); f.state.response = mode;
    if (mode === "observer-origin") f.state.thread.originator = "octopus_daemon_observer";
    f.state.thread.status = { type: mode === "unloaded" ? "notLoaded" : "active", activeFlags: [] };
    if (mode === "ended") f.state.turn.status = "completed";
    if (mode === "missing-turn") f.state.turn.id = "";
    const resume = vi.spyOn(CodexManagedSession, "resume");
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry(), interactions: new AgentInteractionBroker(),
      codexDaemon: new CodexDaemonObserver(), timeoutMs: 1000 });
    const onInput = vi.fn(async () => {});
    const prompt = "下一次工具调用边界接收\n`$(literal)`";
    const result = await plane.continueSession({ provider: "codex", sessionId: id, codexHome: f.home,
      sessionPath: f.state.thread.path, cwd: f.home, prompt, takeover: false, onInput });
    if (mode === "ok" || mode === "observer-origin") {
      expect(result).toMatchObject({ ok: true, transport: "app-server", control_action: "protocol_steer", turn_id: "turn-current" });
      expect(onInput).toHaveBeenCalledWith(expect.objectContaining({ phase: "provider_accepted", turn_id: "turn-current" }));
    } else {
      expect(result).toMatchObject({ ok: false, code: ["disconnect", "malformed", "mismatch"].includes(mode)
        ? "unknown" : expect.not.stringMatching(/^unknown$/) });
      expect(onInput).not.toHaveBeenCalled();
    }
    const sent = !["ended", "missing-turn", "unloaded"].includes(mode);
    expect(f.inputs).toHaveLength(sent ? 1 : 0);
    if (sent) expect(f.inputs[0]).toMatchObject({ method: "turn/steer", params: {
      threadId: id, expectedTurnId: "turn-current", clientUserMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      input: [{ type: "text", text: prompt, text_elements: [] }],
    } });
    for (const method of ["turn/start", "thread/queue/add", "thread/resume"]) expect(f.methods).not.toContain(method);
    expect(resume).not.toHaveBeenCalled();
    await plane.close();
  },
);
