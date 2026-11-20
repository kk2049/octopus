/**
 * Discover the omp TUIs a person is running, without installing anything.
 *
 * Claude and Codex are observed through hooks: Octopus writes a hook command
 * into the user's CLI config, the CLI runs it, and the reporter's pid is walked
 * up to the real process. omp has no external hook command — its extension
 * points are in-process TypeScript modules — so the equivalent would mean
 * putting Octopus code inside `~/.omp`. It does not have to:
 *
 *   · omp itself writes `~/.omp/agent/terminal-sessions/<tty>` containing the
 *     session's cwd and its session-file path, refreshed when the terminal
 *     switches sessions. That is the binding a hook would have told us.
 *   · the session file's own tail says what the agent is doing right now; the
 *     sessions plugin already parses it into a normalized `activity`.
 *
 * So a discovery sweep is: read the breadcrumbs, find the live `omp` process
 * that owns each tty, and hand the pair to the runtime registry. Nothing is
 * injected into the person's tooling and nothing is inferred from a process
 * name alone — the tty is what ties a specific process to a specific session.
 *
 * This covers every external shape equally: a bare `omp` in a terminal, one
 * inside a tmux pane, and one under any other multiplexer. tmux only matters
 * later, when something wants to TYPE into it.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  deriveIdFromPath,
  parseSessionText,
  readSessionSummaryFile,
  type ActivityState,
} from "@claude-bot/plugin-sessions/scan";
import {
  matchesProvider,
  type AgentRuntimeRegistry,
  type AgentTurnState,
  type ProcessIdentity,
  type ProcSnapshot,
} from "./agent-runtime.js";

/** Linux allocates 8 majors of 256 minors each to UNIX98 pty slaves. */
const PTS_MAJOR_BASE = 136;
const PTS_MAJOR_COUNT = 8;
/** Virtual consoles (`/dev/ttyN`). */
const VC_MAJOR = 4;

/** A terminal breadcrumb omp wrote for one tty. */
export interface OmpTerminalBreadcrumb {
  /** Basename of the breadcrumb file, e.g. `pts-3`. */
  terminal: string;
  /** Kernel `tty_nr` this terminal corresponds to, or 0 when unrecognised. */
  ttyNr: number;
  cwd: string;
  sessionFile: string;
  sessionId: string;
}

/** One discovered external omp TUI: which process owns which session. */
export interface OmpTerminalBinding extends OmpTerminalBreadcrumb {
  identity: ProcessIdentity;
  turnState: AgentTurnState;
  event: string;
  tool?: string;
}

/** Lists candidate pids. Split from `ProcessReader` so tests stay deterministic. */
export interface ProcessLister {
  list(): Promise<number[]>;
}

export class LinuxProcessLister implements ProcessLister {
  async list(): Promise<number[]> {
    if (process.platform !== "linux") return [];
    try {
      const entries = await fs.readdir("/proc");
      const pids: number[] = [];
      for (const entry of entries) {
        const pid = Number(entry);
        if (Number.isInteger(pid) && pid > 1) pids.push(pid);
      }
      return pids;
    } catch {
      return [];
    }
  }
}

export function ompTerminalSessionsDir(home: string): string {
  return path.join(home, ".omp", "agent", "terminal-sessions");
}

/**
 * `pts-3` → the `tty_nr` value `/proc/<pid>/stat` reports for `/dev/pts/3`.
 *
 * Comparing device numbers rather than readlink-ing every process's fd 0 keeps
 * the sweep to one `stat` read per pid and works for a process whose stdin was
 * redirected while its controlling terminal stayed the same.
 */
export function ttyNrForTerminal(name: string): number {
  const pts = /^pts-(\d+)$/.exec(name);
  if (pts) {
    const index = Number(pts[1]);
    if (!Number.isInteger(index) || index < 0) return 0;
    const major = PTS_MAJOR_BASE + Math.floor(index / 256);
    if (major >= PTS_MAJOR_BASE + PTS_MAJOR_COUNT) return 0;
    return (major << 8) | (index % 256);
  }
  const vc = /^tty(\d+)$/.exec(name);
  if (vc) {
    const index = Number(vc[1]);
    if (!Number.isInteger(index) || index < 1 || index > 63) return 0;
    return (VC_MAJOR << 8) | index;
  }
  return 0;
}

/**
 * Read every breadcrumb under the omp agent dir.
 *
 * File shape (omp 17.x): first line the session's cwd, second line the absolute
 * session-file path. Anything else is skipped rather than guessed at — a
 * breadcrumb we cannot read is one fewer discovered session, never a wrong one.
 */
export async function readOmpBreadcrumbs(home: string): Promise<OmpTerminalBreadcrumb[]> {
  const dir = ompTerminalSessionsDir(home);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: OmpTerminalBreadcrumb[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, entry.name), "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const cwd = lines[0] ?? "";
    const sessionFile = lines.find((line) => line.endsWith(".jsonl")) ?? "";
    if (!sessionFile || !path.isAbsolute(sessionFile)) continue;
    const sessionId = deriveIdFromPath("omp", sessionFile);
    if (!sessionId) continue;
    out.push({
      terminal: entry.name,
      ttyNr: ttyNrForTerminal(entry.name),
      cwd,
      sessionFile,
      sessionId,
    });
  }
  return out;
}

/** Map `tty_nr` → the live external omp process owning that terminal. */
export async function findOmpProcessesByTty(
  lister: ProcessLister,
  read: (pid: number) => Promise<ProcSnapshot | null>,
): Promise<Map<number, ProcSnapshot>> {
  const byTty = new Map<number, ProcSnapshot>();
  const pids = await lister.list();
  for (const pid of pids) {
    let snapshot: ProcSnapshot | null;
    try {
      snapshot = await read(pid);
    } catch {
      continue;
    }
    if (!snapshot || !snapshot.tty || !matchesProvider(snapshot, "omp")) continue;
    // Two omp processes on one tty means a shell backgrounded one of them and
    // no breadcrumb can say which is in the foreground. Refuse the terminal
    // rather than bind a session to the wrong incarnation.
    const existing = byTty.get(snapshot.tty);
    if (existing && existing.pid !== snapshot.pid) {
      byTty.set(snapshot.tty, { ...snapshot, pid: -1 });
      continue;
    }
    byTty.set(snapshot.tty, snapshot);
  }
  return byTty;
}

/** The session file's own tail is the turn state for a discovered TUI. */
export function turnStateFromActivity(state: ActivityState | undefined): AgentTurnState {
  switch (state) {
    case "thinking":
    case "tool":
    case "responding":
      return "working";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

export interface OmpDiscoveryOptions {
  lister?: ProcessLister;
  read: (pid: number) => Promise<ProcSnapshot | null>;
  readSessionText?: (file: string) => Promise<string>;
}

/**
 * One discovery sweep: breadcrumbs × live processes → runtime records.
 *
 * Returns the bindings it recorded so a caller can log or test them. Errors on
 * an individual session are contained: discovery must never be able to fail a
 * roster read.
 */
export async function discoverOmpSessions(
  home: string,
  registry: AgentRuntimeRegistry,
  options: OmpDiscoveryOptions,
): Promise<OmpTerminalBinding[]> {
  const breadcrumbs = await readOmpBreadcrumbs(home);
  if (breadcrumbs.length === 0) return [];
  const byTty = await findOmpProcessesByTty(options.lister ?? new LinuxProcessLister(), options.read);
  const readText = options.readSessionText ?? ((file: string) => fs.readFile(file, "utf8"));

  const bound: OmpTerminalBinding[] = [];
  for (const crumb of breadcrumbs) {
    const snapshot = crumb.ttyNr ? byTty.get(crumb.ttyNr) : undefined;
    if (!snapshot || snapshot.pid <= 1) {
      await registry.forgetExternalCli("omp", crumb.sessionId).catch(() => {});
      continue;
    }
    let turnState: AgentTurnState = "unknown";
    let tool: string | undefined;
    try {
      const meta = options.readSessionText ? parseSessionText("omp", await readText(crumb.sessionFile)).meta
        : await readSessionSummaryFile(crumb.sessionFile, "omp");
      turnState = turnStateFromActivity(meta.activity?.state);
      tool = meta.activity?.tool;
    } catch {
      /* an unreadable transcript still leaves a live, observable process */
    }
    const identity: ProcessIdentity = {
      pid: snapshot.pid,
      startTicks: snapshot.startTicks,
      bootId: snapshot.bootId,
      pgid: snapshot.pgid,
      tty: snapshot.tty,
      command: snapshot.command,
    };
    const binding: OmpTerminalBinding = {
      ...crumb,
      identity,
      turnState,
      event: "OmpTerminalObserved",
      ...(tool ? { tool } : {}),
    };
    const recorded = await registry.observeExternalCli({
      provider: "omp",
      sessionId: crumb.sessionId,
      identity,
      turnState,
      event: binding.event,
      ...(tool ? { tool } : {}),
      ...(crumb.cwd ? { cwd: crumb.cwd } : {}),
      transcriptPath: crumb.sessionFile,
    }).catch(() => false);
    if (recorded) bound.push(binding);
  }
  return bound;
}
