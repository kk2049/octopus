import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntimeRegistry,
  findAgentAncestor,
  type ProcSnapshot,
  type ProcessReader,
} from "./agent-runtime.js";

class FakeProcesses implements ProcessReader {
  readonly rows = new Map<number, ProcSnapshot>();
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  stopOnSignal = true;

  read = async (pid: number): Promise<ProcSnapshot | null> => this.rows.get(pid) ?? null;
  signal = (pid: number, signal: NodeJS.Signals): void => {
    this.signals.push({ pid, signal });
    if (this.stopOnSignal) this.rows.delete(pid);
  };
}

function proc(pid: number, ppid: number, argv: string[], startTicks = String(pid * 10)): ProcSnapshot {
  return { pid, ppid, pgid: pid, tty: 3, startTicks, bootId: "boot-a", command: argv[0], argv };
}

describe("agent process identity", () => {
  it("revokes refused rollout evidence even while the old PID is alive", async () => {
    const reader = new FakeProcesses();
    reader.rows.set(10, proc(10, 1, ["codex"]));
    const registry = new AgentRuntimeRegistry({ processReader: reader });
    await registry.observeExternalCli({ provider: "codex", sessionId: "old-child", identity: reader.rows.get(10)!,
      turnState: "idle", event: "CodexRolloutObserved" });
    // Ordinary absence checks still retain a live process.
    await registry.forgetExternalCli("codex", "old-child");
    expect(registry.publicRuntime("codex", "old-child")?.capabilities.takeover).toBe(true);
    await registry.forgetExternalCli("codex", "old-child", "CodexRolloutObserved");
    expect(registry.publicRuntime("codex", "old-child")).toMatchObject({
      process_state: "unknown", control_mode: "unknown", capabilities: { takeover: false },
    });
    await registry.reconcile();
    expect(registry.publicRuntime("codex", "old-child")?.capabilities.takeover).toBe(false);
    expect(reader.signals).toEqual([]);
    expect(reader.rows.has(10)).toBe(true);
  });

  it("does not revoke current hook evidence when rollout discovery refuses", async () => {
    const reader = new FakeProcesses();
    reader.rows.set(10, proc(10, 1, ["codex"]));
    reader.rows.set(31, proc(31, 10, ["node", "runner.js", "hook", "report", "codex"]));
    const registry = new AgentRuntimeRegistry({ processReader: reader });
    await registry.recordHook("codex", { session_id: "hook-root", hook_event_name: "SessionStart" }, 31);
    expect(registry.publicRuntime("codex", "hook-root")?.capabilities.takeover).toBe(true);
    await registry.forgetExternalCli("codex", "hook-root", "CodexRolloutObserved");
    expect(registry.publicRuntime("codex", "hook-root")).toMatchObject({
      process_state: "alive", control_mode: "external_cli", capabilities: { takeover: true },
    });
    expect(reader.signals).toEqual([]);
  });

  it("walks past the hook shell and selects Claude Code's real ancestor", async () => {
    const reader = new FakeProcesses();
    reader.rows.set(30, proc(30, 20, ["node", "runner.js", "hook", "report", "claude"]));
    reader.rows.set(20, proc(20, 10, ["/bin/sh", "-c", "node runner.js hook report claude"]));
    reader.rows.set(10, proc(10, 1, ["node", "/opt/node_modules/@anthropic-ai/claude-code/cli.js"]));
    await expect(findAgentAncestor(reader, 30, "claude")).resolves.toMatchObject({ pid: 10, startTicks: "100" });
  });

  it("recognises the native Codex ancestor without matching the reporter argument", async () => {
    const reader = new FakeProcesses();
    reader.rows.set(31, proc(31, 21, ["node", "runner.js", "hook", "report", "codex"]));
    reader.rows.set(21, proc(21, 11, ["sh", "-c", "hook report codex"]));
    reader.rows.set(11, proc(11, 1, ["/usr/local/bin/codex"]));
    await expect(findAgentAncestor(reader, 31, "codex")).resolves.toMatchObject({ pid: 11 });
  });

  it("does not attribute Runner's shared Codex app-server as a user's CLI", async () => {
    const reader = new FakeProcesses();
    reader.rows.set(31, proc(31, 21, ["node", "runner.js", "hook", "report", "codex"]));
    reader.rows.set(21, proc(21, 11, ["sh", "-c", "hook report codex"]));
    reader.rows.set(11, proc(11, 1, [
      "/usr/local/bin/codex",
      "app-server",
      "--listen",
      "ws://127.0.0.1:43210",
    ]));
    await expect(findAgentAncestor(reader, 31, "codex")).resolves.toBeNull();
  });

  it("keeps opt-in Codex remote evidence private while retaining it for routing", async () => {
    const reader = new FakeProcesses();
    reader.rows.set(31, proc(31, 11, ["node", "runner.js", "hook", "report", "codex"]));
    reader.rows.set(11, proc(11, 1, ["/usr/local/bin/codex", "--remote", "ws://127.0.0.1:43210"]));
    const registry = new AgentRuntimeRegistry({ processReader: reader });
    await registry.recordHook("codex", { session_id: "session-remote", hook_event_name: "SessionStart" }, 31);
    await expect(registry.inspect("codex", "session-remote")).resolves.toMatchObject({
      process: { codexRemoteEndpoint: "ws://127.0.0.1:43210" },
    });
    expect(JSON.stringify(registry.publicRuntime("codex", "session-remote"))).not.toContain("43210");
  });
});

describe("AgentRuntimeRegistry", () => {
  function fixture(): { reader: FakeProcesses; registry: AgentRuntimeRegistry } {
    const reader = new FakeProcesses();
    reader.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    reader.rows.set(10, proc(10, 1, ["claude"]));
    return {
      reader,
      registry: new AgentRuntimeRegistry({
        processReader: reader,
        interruptGraceMs: 2,
        terminateGraceMs: 2,
        quiescenceMs: 0,
        wait: async () => {},
        now: () => new Date("2026-08-11T10:00:00.000Z"),
      }),
    };
  }

  it("maps hook events to useful but bounded public capabilities", async () => {
    const { registry } = fixture();
    const changed: number[] = [];
    registry.onChanged(() => changed.push(changed.length + 1));
    await registry.recordHook("claude", {
      session_id: "session-a",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      transcript_path: "/secret/transcript.jsonl",
      cwd: "/secret/project",
    }, 30);
    expect(registry.publicRuntime("claude", "session-a")).toEqual({
      process_state: "alive",
      turn_state: "needs_input",
      control_mode: "external_cli",
      observed_at: "2026-08-11T10:00:00.000Z",
      event: "PermissionRequest",
      tool: "Bash",
      degraded: false,
      capabilities: {
        observe: true,
        append_when_idle: false,
        takeover: true,
        interrupt: false,
        steer: false,
      },
    });
    expect(JSON.stringify(registry.publicRuntime("claude", "session-a"))).not.toContain("/secret");
    expect(changed).toHaveLength(1);
  });

  it("ends a working foreground turn only on newer evidence for the same process", async () => {
    const { reader, registry } = fixture();
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "PreToolUse", tool_name: "Bash" }, 30);
    const started = registry.publicRuntime("claude", "session-a")!.observed_at;
    // Older transcript evidence (the previous turn's end) cannot end this turn.
    expect(await registry.observeTurnEnded("claude", "session-a", { after: "2000-01-01T00:00:00.000Z" })).toBe(false);
    // The Runner's own stop needs the exact observation it checked and the same process incarnation.
    const identity = (await registry.inspect("claude", "session-a"))!.process!;
    expect(await registry.observeTurnEnded("claude", "session-a", { unchangedSince: "2000-01-01T00:00:00.000Z", identity })).toBe(false);
    expect(await registry.observeTurnEnded("claude", "session-a", { unchangedSince: started, identity: { ...identity, startTicks: "other" } })).toBe(false);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({ turn_state: "working" });
    expect(await registry.observeTurnEnded("claude", "session-a", { unchangedSince: started, identity })).toBe(true);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({ process_state: "alive", turn_state: "idle", event: "TurnEnded" });
    expect(registry.publicRuntime("claude", "session-a")).not.toHaveProperty("tool");
    // A new prompt makes the turn working again; newer transcript evidence can end it.
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({ turn_state: "working" });
    expect(await registry.observeTurnEnded("claude", "session-a", { after: new Date(Date.parse(started) + 1_000).toISOString() })).toBe(true);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({ turn_state: "idle" });
    void reader;
  });

  it("refuses ordinary resume while the exact external CLI is alive", async () => {
    const { registry } = fixture();
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "Stop" }, 30);
    await expect(registry.assertAppendable("claude", "session-a", false)).rejects.toMatchObject({ code: "session_active" });
  });

  it("explicit takeover interrupts the exact incarnation and then permits resume", async () => {
    const { reader, registry } = fixture();
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    await expect(registry.assertAppendable("claude", "session-a", true)).resolves.toBeUndefined();
    expect(reader.signals).toEqual([{ pid: 10, signal: "SIGINT" }]);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({ process_state: "exited", turn_state: "idle" });
  });

  it("does not signal a reused pid", async () => {
    const { reader, registry } = fixture();
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    reader.rows.set(10, proc(10, 1, ["claude"], "different-start"));
    await expect(registry.takeover("claude", "session-a")).rejects.toThrow(/已经退出/);
    expect(reader.signals).toEqual([]);
  });

  it("moves one CLI process to its newly observed session instead of exposing stale takeover", async () => {
    const { registry } = fixture();
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "SessionStart" }, 30);
    await registry.recordHook("claude", { session_id: "session-b", hook_event_name: "SessionStart" }, 30);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({
      process_state: "unknown",
      control_mode: "unknown",
      capabilities: { takeover: false },
    });
    expect(registry.publicRuntime("claude", "session-b")).toMatchObject({
      process_state: "alive",
      capabilities: { takeover: true },
    });

    await registry.recordHook("claude", { session_id: "session-b", hook_event_name: "SessionEnd" }, 30);
    expect(registry.publicRuntime("claude", "session-b")).toMatchObject({
      process_state: "unknown",
      control_mode: "unknown",
      capabilities: { takeover: false },
    });
  });

  it("renames runtime ownership to the current provider id", async () => {
    const { registry } = fixture();
    await registry.recordHook("claude", { session_id: "thread-old", hook_event_name: "Stop" }, 30);
    await registry.renameSession("claude", "thread-old", "thread-fork");

    expect(registry.publicRuntime("claude", "thread-old")).toBeUndefined();
    expect(registry.publicRuntime("claude", "thread-fork")).toMatchObject({
      process_state: "alive",
      event: "Stop",
      capabilities: { takeover: true },
    });
  });

  it("does not expose Octopus-launched headless work as an external CLI", async () => {
    const { reader, registry } = fixture();
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    await registry.markHeadless("claude", "session-a");
    // The label stays Octopus-owned; only the STOP route is offered, because a
    // detached launch has neither an attachment to steer nor a pane to type in.
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({
      control_mode: "octopus_headless",
      capabilities: { takeover: true, interrupt: false, append_when_idle: false },
    });
    // Later hooks from the same process incarnation (including after registry
    // state reload) must not relabel Runner-owned work as an external CLI.
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "PreToolUse" }, 30);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({
      control_mode: "octopus_headless",
      capabilities: { takeover: true },
    });

    // A later interactive incarnation of the same resumed session is distinct
    // evidence and must not inherit the old managed label.
    reader.rows.set(30, proc(30, 11, ["node", "runner.js", "hook", "report", "claude"]));
    reader.rows.set(11, proc(11, 1, ["claude"]));
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "SessionStart" }, 30);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({
      control_mode: "external_cli",
      capabilities: { takeover: true },
    });
  });

  it("lets a detached Octopus launch be stopped and taken over, but never silently joined", async () => {
    const { reader, registry } = fixture();
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    await registry.markHeadless("claude", "session-a");

    // Ordinary resume would put a second writer on one transcript — the shape
    // that makes one instruction show up twice. It is refused with a reason.
    const refused = await registry.assertAppendable("claude", "session-a", false)
      .then(() => null, (error: unknown) => error);
    expect((refused as { code?: string }).code).toBe("session_active");
    expect(String((refused as Error).message)).toContain("后台启动");
    expect(reader.signals).toEqual([]);

    await expect(registry.assertAppendable("claude", "session-a", true)).resolves.toBeUndefined();
    expect(reader.signals).toEqual([{ pid: 10, signal: "SIGINT" }]);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({
      process_state: "exited",
      capabilities: { takeover: false, append_when_idle: true },
    });
  });

  it("refuses to signal an attachment this process is driving", async () => {
    const { reader, registry } = fixture();
    await registry.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    await registry.beginHeadless("claude", "session-a");
    // A native attachment has its own interrupt; a signal would race its owner.
    await expect(registry.takeover("claude", "session-a")).rejects.toThrow(/停止本轮/);
    expect(registry.publicRuntime("claude", "session-a")).toMatchObject({
      control_mode: "octopus_headless",
      capabilities: { takeover: false },
    });
    expect(reader.signals).toEqual([]);
  });

  it("keeps a restored headless record reachable after a Runner restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-runtime-detached-"));
    try {
      const stateFile = join(root, "agent-runtime.json");
      const first = fixture();
      const writer = new AgentRuntimeRegistry({ processReader: first.reader, stateFile });
      await writer.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
      await writer.markHeadless("claude", "session-a");

      // No attachment survives the restart, so whatever is still alive is
      // something nobody drives. It must keep a stop route rather than become a
      // session with no possible action at all.
      const reloaded = new AgentRuntimeRegistry({ processReader: first.reader, stateFile });
      await reloaded.load();
      expect(reloaded.publicRuntime("claude", "session-a")).toMatchObject({
        process_state: "alive",
        control_mode: "octopus_headless",
        capabilities: { takeover: true },
      });
      await expect(reloaded.inspect("claude", "session-a")).resolves.toMatchObject({ detached: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes simultaneous hook snapshots without losing the newer state", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-runtime-state-"));
    try {
      const { reader } = fixture();
      const stateFile = join(root, "agent-runtime.json");
      const registry = new AgentRuntimeRegistry({ processReader: reader, stateFile });
      await Promise.all([
        registry.recordHook("claude", { session_id: "session-a", hook_event_name: "SessionStart" }, 30),
        registry.recordHook("claude", { session_id: "session-b", hook_event_name: "UserPromptSubmit" }, 30),
      ]);
      const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { records: Array<{ sessionId: string }> };
      expect(saved.records.map((row) => row.sessionId).sort()).toEqual(["session-a", "session-b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("does not fan out unchanged discovery at the next hook, and invalidates both sides of a rename", async () => {
  const reader = new FakeProcesses();
  const registry = new AgentRuntimeRegistry({ processReader: reader });
  const observation = { provider: "codex" as const, sessionId: "quiet", identity: proc(10, 1, ["codex"]),
    turnState: "idle" as const, event: "CodexRolloutObserved" };
  await registry.observeExternalCli(observation);
  const changes: unknown[] = [];
  registry.onChanged(change => changes.push(change));
  await registry.observeExternalCli(observation);
  await registry.recordHook("claude", { session_id: "active", hook_event_name: "SessionStart" }, 31);
  expect(changes).toEqual([{ provider: "claude", sessionId: "active" }]);
  changes.length = 0;
  await registry.renameSession("claude", "active", "renamed");
  expect(changes).toEqual(expect.arrayContaining([
    { provider: "claude", sessionId: "active" }, { provider: "claude", sessionId: "renamed" },
  ]));
  expect(changes).toHaveLength(2);
});

describe("the session behind an MCP server process (\"self\")", () => {
  it("is the live session of the CLI that spawned the server, found by process ancestry", async () => {
    const reader = new FakeProcesses();
    reader.rows.set(10, proc(10, 1, ["claude"]));
    reader.rows.set(31, proc(31, 10, ["node", "runner.js", "hook", "report", "claude"]));
    reader.rows.set(40, proc(40, 10, ["node", "/home/u/.octopus/runner/standalone.js", "mcp", "stdio"]));
    reader.rows.set(20, proc(20, 1, ["codex"]));
    reader.rows.set(21, proc(21, 20, ["node", "runner.js", "hook", "report", "codex"]));
    reader.rows.set(50, proc(50, 20, ["node", "standalone.js", "mcp", "stdio"]));
    const registry = new AgentRuntimeRegistry({ processReader: reader });
    await registry.recordHook("claude", { session_id: "claude-a", hook_event_name: "SessionStart" }, 31);
    await registry.recordHook("codex", { session_id: "codex-b", hook_event_name: "SessionStart" }, 21);
    expect(await registry.sessionOfCaller(40)).toEqual({ provider: "claude", sessionId: "claude-a" });
    expect(await registry.sessionOfCaller(50)).toEqual({ provider: "codex", sessionId: "codex-b" });
    // After /resume in the same process the newest session is "self".
    await registry.recordHook("claude", { session_id: "claude-c", hook_event_name: "SessionStart" }, 31);
    expect(await registry.sessionOfCaller(40)).toEqual({ provider: "claude", sessionId: "claude-c" });
  });

  it("is nobody when the server was not spawned by an observed CLI, or that CLI was replaced", async () => {
    const reader = new FakeProcesses();
    reader.rows.set(10, proc(10, 1, ["claude"]));
    reader.rows.set(31, proc(31, 10, ["node", "runner.js", "hook", "report", "claude"]));
    reader.rows.set(60, proc(60, 1, ["bash"]));
    reader.rows.set(61, proc(61, 60, ["node", "standalone.js", "mcp", "stdio"]));
    const registry = new AgentRuntimeRegistry({ processReader: reader });
    await registry.recordHook("claude", { session_id: "claude-a", hook_event_name: "SessionStart" }, 31);
    expect(await registry.sessionOfCaller(61)).toBeNull();
    // Same pid, new process (different start ticks): the old session is not "self".
    reader.rows.set(10, proc(10, 1, ["claude"], "999"));
    reader.rows.set(40, proc(40, 10, ["node", "standalone.js", "mcp", "stdio"]));
    expect(await registry.sessionOfCaller(40)).toBeNull();
  });
});
