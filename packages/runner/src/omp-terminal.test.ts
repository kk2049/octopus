import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntimeRegistry, type ProcSnapshot } from "./agent-runtime.js";
import {
  discoverOmpSessions,
  findOmpProcessesByTty,
  readOmpBreadcrumbs,
  turnStateFromActivity,
  ttyNrForTerminal,
  type ProcessLister,
} from "./omp-terminal.js";

const SESSION_ID = "01a00ed4-db09-7000-b549-ac372c282cfa";

async function fixtureHome(files: Record<string, string>): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-terminal-"));
  const dir = path.join(home, ".omp", "agent", "terminal-sessions");
  await fs.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body, "utf8");
  }
  return home;
}

function proc(overrides: Partial<ProcSnapshot> & { pid: number }): ProcSnapshot {
  return {
    ppid: 1,
    pgid: overrides.pid,
    tty: 0,
    startTicks: "111",
    bootId: "boot-1",
    command: "omp",
    argv: ["omp"],
    ...overrides,
  };
}

function lister(pids: number[]): ProcessLister {
  return { list: async () => pids };
}

describe("ttyNrForTerminal", () => {
  it("maps a pts breadcrumb to the kernel tty_nr /proc reports", () => {
    // /dev/pts/3 → major 136, minor 3.
    expect(ttyNrForTerminal("pts-3")).toBe((136 << 8) | 3);
    // Minor rolls into the next of the 8 pty majors past 255.
    expect(ttyNrForTerminal("pts-300")).toBe((137 << 8) | 44);
  });

  it("maps a virtual console and refuses anything else", () => {
    expect(ttyNrForTerminal("tty2")).toBe((4 << 8) | 2);
    expect(ttyNrForTerminal("pts-abc")).toBe(0);
    expect(ttyNrForTerminal("tty0")).toBe(0);
    expect(ttyNrForTerminal("..")).toBe(0);
    // Past the 8 majors omp could never be on.
    expect(ttyNrForTerminal("pts-99999")).toBe(0);
  });
});

describe("readOmpBreadcrumbs", () => {
  it("reads cwd + session file and derives the session id", async () => {
    const home = await fixtureHome({ "pts-3": `/home/u/proj\n/home/u/.omp/agent/sessions/-proj/ts_${SESSION_ID}.jsonl\n` });
    await expect(readOmpBreadcrumbs(home)).resolves.toEqual([{
      terminal: "pts-3",
      ttyNr: (136 << 8) | 3,
      cwd: "/home/u/proj",
      sessionFile: `/home/u/.omp/agent/sessions/-proj/ts_${SESSION_ID}.jsonl`,
      sessionId: SESSION_ID,
    }]);
  });

  it("skips a breadcrumb with no absolute session file rather than guessing", async () => {
    const home = await fixtureHome({
      "pts-1": "/home/u/proj\n",
      "pts-2": "/home/u/proj\nrelative/path.jsonl\n",
    });
    await expect(readOmpBreadcrumbs(home)).resolves.toEqual([]);
  });

  it("returns nothing when omp was never run on this device", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-empty-"));
    await expect(readOmpBreadcrumbs(home)).resolves.toEqual([]);
  });
});

describe("findOmpProcessesByTty", () => {
  const read = (table: ProcSnapshot[]) => async (pid: number) => table.find((row) => row.pid === pid) ?? null;

  it("indexes external omp processes by their controlling terminal", async () => {
    const table = [
      proc({ pid: 10, tty: (136 << 8) | 3, argv: ["omp"] }),
      proc({ pid: 11, tty: (136 << 8) | 4, argv: ["/home/u/.local/bin/omp", "--model", "opus"] }),
      proc({ pid: 12, tty: (136 << 8) | 5, argv: ["claude"], command: "claude" }),
    ];
    const byTty = await findOmpProcessesByTty(lister([10, 11, 12]), read(table));
    expect([...byTty.keys()].sort()).toEqual([(136 << 8) | 3, (136 << 8) | 4]);
    expect(byTty.get((136 << 8) | 4)?.pid).toBe(11);
  });

  it("ignores Octopus's own `--mode rpc` child, which is not a person's TUI", async () => {
    const table = [proc({ pid: 20, tty: (136 << 8) | 6, argv: ["omp", "--mode", "rpc", "--cwd", "/w"] })];
    await expect(findOmpProcessesByTty(lister([20]), read(table))).resolves.toEqual(new Map());
  });

  it("poisons a terminal that has two omp processes instead of picking one", async () => {
    const tty = (136 << 8) | 7;
    const table = [proc({ pid: 30, tty }), proc({ pid: 31, tty })];
    const byTty = await findOmpProcessesByTty(lister([30, 31]), read(table));
    expect(byTty.get(tty)?.pid).toBe(-1);
  });

  it("skips processes with no controlling terminal", async () => {
    const table = [proc({ pid: 40, tty: 0 })];
    await expect(findOmpProcessesByTty(lister([40]), read(table))).resolves.toEqual(new Map());
  });
});

describe("turnStateFromActivity", () => {
  it("collapses the transcript's activity into a turn state", () => {
    expect(turnStateFromActivity("thinking")).toBe("working");
    expect(turnStateFromActivity("tool")).toBe("working");
    expect(turnStateFromActivity("responding")).toBe("working");
    expect(turnStateFromActivity("idle")).toBe("idle");
    expect(turnStateFromActivity("unknown")).toBe("unknown");
    expect(turnStateFromActivity(undefined)).toBe("unknown");
  });
});

describe("discoverOmpSessions", () => {
  const transcript = [
    `{"type":"session","version":3,"id":"${SESSION_ID}","timestamp":"2026-08-17T08:00:00.000Z","cwd":"/home/u/proj"}`,
    `{"type":"message","id":"u","timestamp":"2026-08-17T08:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"跑一下"}]}}`,
    `{"type":"message","id":"a","timestamp":"2026-08-17T08:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{}}]}}`,
  ].join("\n");

  it("binds a live omp TUI to its session and records it as an external CLI", async () => {
    const sessionFile = `/home/u/.omp/agent/sessions/-proj/ts_${SESSION_ID}.jsonl`;
    const home = await fixtureHome({ "pts-3": `/home/u/proj\n${sessionFile}\n` });
    const registry = new AgentRuntimeRegistry();
    const table = [proc({ pid: 50, tty: (136 << 8) | 3 })];

    const bound = await discoverOmpSessions(home, registry, {
      lister: lister([50]),
      read: async (pid) => table.find((row) => row.pid === pid) ?? null,
      readSessionText: async () => transcript,
    });

    expect(bound).toHaveLength(1);
    // The transcript tail says a tool call is outstanding — that IS the turn state.
    expect(bound[0]).toMatchObject({ sessionId: SESSION_ID, turnState: "working", tool: "bash" });
    expect(registry.publicRuntime("omp", SESSION_ID)).toMatchObject({
      process_state: "alive",
      turn_state: "working",
      control_mode: "external_cli",
      capabilities: { takeover: true },
    });
  });

  it("leaves nothing bound when the terminal no longer has an omp in it", async () => {
    const sessionFile = `/home/u/.omp/agent/sessions/-proj/ts_${SESSION_ID}.jsonl`;
    const home = await fixtureHome({ "pts-3": `/home/u/proj\n${sessionFile}\n` });
    const registry = new AgentRuntimeRegistry();
    await expect(discoverOmpSessions(home, registry, {
      lister: lister([]),
      read: async () => null,
      readSessionText: async () => transcript,
    })).resolves.toEqual([]);
    expect(registry.publicRuntime("omp", SESSION_ID)).toBeUndefined();
  });

  it("still records a live process when its transcript cannot be read", async () => {
    const sessionFile = `/home/u/.omp/agent/sessions/-proj/ts_${SESSION_ID}.jsonl`;
    const home = await fixtureHome({ "pts-3": `/home/u/proj\n${sessionFile}\n` });
    const registry = new AgentRuntimeRegistry();
    const table = [proc({ pid: 51, tty: (136 << 8) | 3 })];
    const bound = await discoverOmpSessions(home, registry, {
      lister: lister([51]),
      read: async (pid) => table.find((row) => row.pid === pid) ?? null,
      readSessionText: async () => {
        throw new Error("EACCES");
      },
    });
    expect(bound[0]).toMatchObject({ turnState: "unknown" });
    expect(registry.publicRuntime("omp", SESSION_ID)?.process_state).toBe("alive");
  });

  it("refuses to relabel a session an Octopus attachment is driving", async () => {
    const sessionFile = `/home/u/.omp/agent/sessions/-proj/ts_${SESSION_ID}.jsonl`;
    const home = await fixtureHome({ "pts-3": `/home/u/proj\n${sessionFile}\n` });
    const registry = new AgentRuntimeRegistry();
    await registry.beginHeadless("omp", SESSION_ID);
    const table = [proc({ pid: 52, tty: (136 << 8) | 3 })];
    await expect(discoverOmpSessions(home, registry, {
      lister: lister([52]),
      read: async (pid) => table.find((row) => row.pid === pid) ?? null,
      readSessionText: async () => transcript,
    })).resolves.toEqual([]);
  });
});
