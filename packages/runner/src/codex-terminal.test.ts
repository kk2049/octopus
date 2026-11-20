import { describe, expect, it } from "vitest";
import { AgentRuntimeRegistry, type ProcSnapshot, type ProcessReader } from "./agent-runtime.js";
import {
  discoverCodexTerminalSessions,
  discoverLiveCodexTerminals,
  type CodexSessionDiscoveryCandidate,
} from "./codex-terminal.js";
import type { ProcessLister } from "./omp-terminal.js";

const SESSION_A = "019d1234-1111-7000-8000-000000000001";
const SESSION_B = "019d1234-2222-7000-8000-000000000002";

class Processes implements ProcessReader {
  constructor(readonly rows: Map<number, ProcSnapshot>) {}
  read = async (pid: number): Promise<ProcSnapshot | null> => this.rows.get(pid) ?? null;
  signal = (): void => {};
}

function proc(pid: number, overrides: Partial<ProcSnapshot> = {}): ProcSnapshot {
  return {
    pid,
    ppid: 1,
    pgid: pid,
    tty: 34_819,
    startTicks: String(pid * 10),
    bootId: "boot-a",
    command: "codex",
    argv: ["/usr/local/bin/codex"],
    ...overrides,
  };
}

function candidate(sessionId: string, sessionPath: string): CodexSessionDiscoveryCandidate {
  return { sessionId, sessionPath, cwd: "/work/project", turnState: "idle" };
}

function header(id: string, parent?: string): string {
  return JSON.stringify({ type: "session_meta", payload: {
    id, thread_source: parent ? "subagent" : "user", source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli",
    ...(parent ? { parent_thread_id: parent } : {}),
  } }) + "\n";
}

function lister(pids: number[]): ProcessLister {
  return { list: async () => pids };
}

function fakeStat(entries: Record<string, number>): (file: string) => Promise<{ dev: number; ino: number }> {
  return async (file) => {
    const ino = entries[file];
    if (!ino) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { dev: 7, ino };
  };
}

describe("discoverCodexTerminalSessions", () => {
  it("discovers a live tmux transcript directly from fds without a history inventory", async () => {
    const file = `/home/user/.codex/sessions/rollout-${SESSION_A}.jsonl`;
    const processes = new Processes(new Map([[20, proc(20)], [21, proc(21)]]));
    const registry = new AgentRuntimeRegistry({ processReader: processes });
    const accepted: string[] = [];
    const bound = await discoverLiveCodexTerminals([...processes.rows.values()], new Set(["/dev/pts/8"]), registry,
      async (value) => { accepted.push(value); return value === file; }, {
        listFds: async () => ["/proc/20/fd/9"],
        readlink: async (p) => p.endsWith("/fd/0") ? (p.includes("/20/") ? "/dev/pts/8" : "/dev/pts/9") : file,
        stat: async () => ({ dev: 1, ino: 100 }), readSessionHeader: async () => header(SESSION_A),
        readSessionText: async () => header(SESSION_A),
      });
    expect(bound.map((row) => row.sessionId)).toEqual([SESSION_A]);
    expect(accepted).toEqual([file]); expect(bound[0].identity.pid).toBe(20);
  });
  it("binds a pre-Runner Codex TUI through its exact open rollout inode", async () => {
    const a = "/home/u/.codex/sessions/2026/08/28/a.jsonl";
    const rows = new Map([[10, proc(10)]]);
    const registry = new AgentRuntimeRegistry({ processReader: new Processes(rows) });

    const bound = await discoverCodexTerminalSessions([candidate(SESSION_A, a)], registry, {
      readSessionHeader: async (file) => header(file.includes("b.jsonl") ? SESSION_B : SESSION_A),
      lister: lister([10]),
      read: async (pid) => rows.get(pid) ?? null,
      listFds: async () => ["/proc/10/fd/7", "/proc/10/fd/8"],
      stat: fakeStat({ [a]: 101, "/proc/10/fd/7": 101, "/proc/10/fd/8": 999 }),
    });

    expect(bound).toMatchObject([{
      sessionId: SESSION_A,
      identity: { pid: 10, startTicks: "100", bootId: "boot-a" },
      turnState: "idle",
      event: "CodexRolloutObserved",
    }]);
    expect(registry.publicRuntime("codex", SESSION_A)).toMatchObject({
      process_state: "alive",
      control_mode: "external_cli",
      capabilities: { takeover: true },
    });
  });

  it("refuses one Codex process that has more than one candidate rollout open", async () => {
    const a = "/home/u/.codex/sessions/a.jsonl";
    const b = "/home/u/.codex/sessions/b.jsonl";
    const rows = new Map([[20, proc(20)]]);
    const registry = new AgentRuntimeRegistry({ processReader: new Processes(rows) });

    await expect(discoverCodexTerminalSessions([
      candidate(SESSION_A, a),
      candidate(SESSION_B, b),
    ], registry, {
      readSessionHeader: async (file) => header(file.includes("b.jsonl") ? SESSION_B : SESSION_A),
      lister: lister([20]),
      read: async (pid) => rows.get(pid) ?? null,
      listFds: async () => ["/proc/20/fd/4", "/proc/20/fd/5"],
      stat: fakeStat({ [a]: 101, [b]: 202, "/proc/20/fd/4": 101, "/proc/20/fd/5": 202 }),
    })).resolves.toEqual([]);
    expect(registry.publicRuntime("codex", SESSION_A)).toBeUndefined();
    expect(registry.publicRuntime("codex", SESSION_B)).toBeUndefined();
  });

  it("binds only the proven root when its TUI also owns child and grandchild rollouts", async () => {
    const paths = ["/home/u/.codex-accounts/account-a/sessions/root.jsonl", "/tmp/child.jsonl", "/tmp/grandchild.jsonl"];
    const ids = [SESSION_A, SESSION_B, "019d1234-3333-7000-8000-000000000003"];
    const rows = new Map([[20, proc(20)]]);
    const registry = new AgentRuntimeRegistry({ processReader: new Processes(rows) });
    // Old partial-roster discovery incorrectly bound the child to this PID.
    await registry.observeExternalCli({ provider: "codex", sessionId: SESSION_B,
      identity: proc(20), turnState: "idle", event: "CodexRolloutObserved" });
    const bound = await discoverCodexTerminalSessions(ids.map((id, i) => candidate(id, paths[i])), registry, {
      lister: lister([20]), read: async (pid) => rows.get(pid) ?? null,
      listFds: async () => paths.map((_, i) => `/proc/20/fd/${i}`),
      stat: fakeStat(Object.fromEntries(paths.flatMap((file, i) => [[file, i + 1], [`/proc/20/fd/${i}`, i + 1]]))),
      readSessionHeader: async (file) => { const i = paths.indexOf(file); return header(ids[i], ids[i - 1]); },
    });
    expect(bound.map((row) => row.sessionId)).toEqual([SESSION_A]);
    expect(registry.publicRuntime("codex", SESSION_A)?.process_state).toBe("alive");
    expect(registry.publicRuntime("codex", SESSION_B)?.process_state).not.toBe("alive");
    expect(registry.publicRuntime("codex", ids[2])).toBeUndefined();
  });

  it.each([
    ["child without root", header(SESSION_A, SESSION_B)],
    ["wrong header id", header(SESSION_B)],
    ["truncated header", header(SESSION_A).trim()],
    ["unknown source", JSON.stringify({ type: "session_meta", payload: { id: SESSION_A } }) + "\n"],
    ["contradictory parent", JSON.stringify({ type: "session_meta", payload: { id: SESSION_A, source: "cli", parent_thread_id: SESSION_B } }) + "\n"],
  ])("refuses %s without manufacturing terminal control", async (_label, text) => {
    const a = "/tmp/a.jsonl";
    const rows = new Map([[20, proc(20)]]);
    const registry = new AgentRuntimeRegistry({ processReader: new Processes(rows) });
    await registry.observeExternalCli({ provider: "codex", sessionId: SESSION_A,
      identity: proc(20), turnState: "idle", event: "CodexRolloutObserved" });
    expect(await discoverCodexTerminalSessions([candidate(SESSION_A, a)], registry, {
      lister: lister([20]), read: async (pid) => rows.get(pid) ?? null,
      listFds: async () => ["/proc/20/fd/4"],
      stat: fakeStat({ [a]: 101, "/proc/20/fd/4": 101 }),
      readSessionHeader: async () => text,
    })).toEqual([]);
    expect(registry.publicRuntime("codex", SESSION_A)).toMatchObject({
      process_state: "unknown", control_mode: "unknown", capabilities: { takeover: false },
    });
  });

  it.each([
    ["session id", SESSION_A, 202],
    ["inode", SESSION_B, 101],
  ])("revokes old discovery when two candidate rollouts share their %s", async (_label, secondId, secondInode) => {
    const a = "/home/u/.codex/sessions/a.jsonl";
    const b = "/home/u/.codex/sessions/a-copy.jsonl";
    const rows = new Map([[21, proc(21)]]);
    const registry = new AgentRuntimeRegistry({ processReader: new Processes(rows) });
    await registry.observeExternalCli({ provider: "codex", sessionId: SESSION_A,
      identity: proc(21), turnState: "idle", event: "CodexRolloutObserved" });

    await expect(discoverCodexTerminalSessions([
      candidate(SESSION_A, a),
      candidate(String(secondId), b),
    ], registry, {
      readSessionHeader: async (file) => header(file.includes("b.jsonl") ? SESSION_B : SESSION_A),
      lister: lister([21]),
      read: async (pid) => rows.get(pid) ?? null,
      // Even if only one of the duplicate-id files is open, choosing it would
      // silently decide which roster fact owns the id.
      listFds: async () => ["/proc/21/fd/4"],
      stat: fakeStat({ [a]: 101, [b]: Number(secondInode), "/proc/21/fd/4": 101, "/proc/21/fd/5": 202 }),
    })).resolves.toEqual([]);
    expect(registry.publicRuntime("codex", SESSION_A)).toMatchObject({
      process_state: "unknown", capabilities: { takeover: false },
    });
  });

  it("refuses two terminal processes that point at the same rollout", async () => {
    const a = "/home/u/.codex/sessions/a.jsonl";
    const rows = new Map([[30, proc(30)], [31, proc(31)]]);
    const registry = new AgentRuntimeRegistry({ processReader: new Processes(rows) });

    await expect(discoverCodexTerminalSessions([candidate(SESSION_A, a)], registry, {
      readSessionHeader: async (file) => header(file.includes("b.jsonl") ? SESSION_B : SESSION_A),
      lister: lister([30, 31]),
      read: async (pid) => rows.get(pid) ?? null,
      listFds: async (pid) => [`/proc/${pid}/fd/3`],
      stat: fakeStat({ [a]: 303, "/proc/30/fd/3": 303, "/proc/31/fd/3": 303 }),
    })).resolves.toEqual([]);
    expect(registry.publicRuntime("codex", SESSION_A)).toBeUndefined();
  });

  it("ignores app-server infrastructure, non-terminal exec, and opt-in remote TUIs", async () => {
    const a = "/home/u/.codex/sessions/a.jsonl";
    const rows = new Map([
      [40, proc(40, { argv: ["codex", "app-server"] })],
      [41, proc(41, { tty: 0, argv: ["codex", "exec", "resume", SESSION_A] })],
      [42, proc(42, { argv: ["codex", "--remote", "ws://127.0.0.1:43123"] })],
    ]);
    const registry = new AgentRuntimeRegistry({ processReader: new Processes(rows) });

    await expect(discoverCodexTerminalSessions([candidate(SESSION_A, a)], registry, {
      readSessionHeader: async (file) => header(file.includes("b.jsonl") ? SESSION_B : SESSION_A),
      lister: lister([40, 41, 42]),
      read: async (pid) => rows.get(pid) ?? null,
      listFds: async (pid) => [`/proc/${pid}/fd/3`],
      stat: fakeStat({
        [a]: 404,
        "/proc/40/fd/3": 404,
        "/proc/41/fd/3": 404,
        "/proc/42/fd/3": 404,
      }),
    })).resolves.toEqual([]);
    expect(registry.publicRuntime("codex", SESSION_A)).toBeUndefined();
  });
});
