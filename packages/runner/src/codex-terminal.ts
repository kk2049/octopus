/**
 * Discover ordinary Codex TUIs from the exact rollout file they currently own.
 *
 * A Codex hook is the preferred observation path, but it cannot describe a TUI
 * that was already running before Runner installed/opened its hook endpoint.
 * The Codex rollout writer keeps the active session file open for the lifetime
 * of that session. On Linux, matching the file's `(dev, ino)` with one live
 * terminal Codex process's `/proc/<pid>/fd/*` is therefore an exact binding —
 * unlike a process-name scan or "newest transcript" guess.
 *
 * Native session headers must also prove the terminal's root thread. A process
 * may hold its root plus descendant rollouts, but unrelated/unknown roots or
 * several processes with the same root produce no binding or signal authority.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseSessionText, readSessionSummaryFile, deriveIdFromPath, type ActivityState } from "@claude-bot/plugin-sessions/scan";
import {
  matchesProvider,
  type AgentRuntimeRegistry,
  type AgentTurnState,
  type ProcessIdentity,
  type ProcSnapshot,
} from "./agent-runtime.js";
import { LinuxProcessLister, type ProcessLister } from "./omp-terminal.js";

export interface CodexSessionDiscoveryCandidate {
  sessionId: string;
  sessionPath: string;
  cwd?: string;
  turnState?: AgentTurnState;
  tool?: string;
}

export interface CodexTerminalBinding extends CodexSessionDiscoveryCandidate {
  identity: ProcessIdentity;
  turnState: AgentTurnState;
  event: "CodexRolloutObserved";
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

export interface CodexDiscoveryOptions {
  lister?: ProcessLister;
  read: (pid: number) => Promise<ProcSnapshot | null>;
  listFds?: (pid: number) => Promise<readonly string[]>;
  stat?: (file: string) => Promise<FileIdentity>;
  readSessionHeader?: (file: string) => Promise<string>;
  readSessionText?: (file: string) => Promise<string>;
}

/** Only live fd matches need a header; never load whole transcripts to prove lineage. */
async function readSessionHeader(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function terminalRoot(
  candidates: readonly CodexSessionDiscoveryCandidate[],
  readHeader: (file: string) => Promise<string>,
): Promise<CodexSessionDiscoveryCandidate | null> {
  const parents = new Map<string, string | null>();
  for (const candidate of candidates) {
    try {
      const header = await readHeader(candidate.sessionPath);
      const end = header.indexOf("\n");
      if (end < 0 || end > 64 * 1024) return null;
      const line = header.slice(0, end);
      const record = JSON.parse(line);
      const payload = record?.payload;
      if (record?.type !== "session_meta" || payload?.id !== candidate.sessionId) return null;
      if (payload.source === "cli" && !payload.parent_thread_id
        && (payload.thread_source === undefined || payload.thread_source === "user")) {
        parents.set(candidate.sessionId, null);
      } else {
        // Reuse the provider parser's conflict checks, not titles or recency.
        const { meta } = parseSessionText("codex", line);
        if (!meta.is_subagent || !meta.parent_session_id) return null;
        parents.set(candidate.sessionId, meta.parent_session_id);
      }
    } catch {
      return null;
    }
  }
  const roots = candidates.filter((row) => parents.get(row.sessionId) === null);
  if (roots.length !== 1) return null;
  const root = roots[0];
  for (const candidate of candidates) {
    const seen = new Set<string>();
    let id: string | null | undefined = candidate.sessionId;
    while (id !== root.sessionId) {
      if (!id || seen.has(id)) return null;
      seen.add(id);
      id = parents.get(id);
    }
  }
  return root;
}

function inodeKey(identity: FileIdentity): string {
  return `${String(identity.dev)}:${String(identity.ino)}`;
}

function turnStateFromActivity(state: ActivityState | undefined): AgentTurnState {
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

async function linuxFds(pid: number): Promise<readonly string[]> {
  try {
    const root = `/proc/${pid}/fd`;
    return (await fs.readdir(root)).slice(0, 4_096).map((entry) => path.join(root, entry));
  } catch {
    return [];
  }
}

/**
 * Bind trusted scanner candidates to live terminal Codex processes.
 *
 * Candidate paths are supplied by the device-local sessions scanner, never by
 * the browser. File identity is compared rather than path spelling so symlinks
 * cannot create a false mismatch. Individual `/proc` races are contained.
 */
export async function discoverCodexTerminalSessions(
  candidates: readonly CodexSessionDiscoveryCandidate[],
  registry: AgentRuntimeRegistry,
  options: CodexDiscoveryOptions,
): Promise<CodexTerminalBinding[]> {
  if (process.platform !== "linux" || candidates.length === 0) return [];
  const stat = options.stat ?? (async (file: string) => await fs.stat(file));
  const listFds = options.listFds ?? linuxFds;
  const readText = options.readSessionText ?? (async (file: string) => await fs.readFile(file, "utf8"));

  const candidateCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.sessionId || !path.isAbsolute(candidate.sessionPath)) continue;
    candidateCounts.set(candidate.sessionId, (candidateCounts.get(candidate.sessionId) ?? 0) + 1);
  }

  // More than one candidate for an inode (hard links or duplicate roster
  // facts) is not enough evidence to choose a session id.
  const byInode = new Map<string, CodexSessionDiscoveryCandidate | null>();
  for (const candidate of candidates) {
    if (!candidate.sessionId || !path.isAbsolute(candidate.sessionPath)) continue;
    if (candidateCounts.get(candidate.sessionId) !== 1) continue;
    try {
      const key = inodeKey(await stat(candidate.sessionPath));
      byInode.set(key, byInode.has(key) ? null : candidate);
    } catch {
      /* A rotated/unreadable transcript simply cannot be discovered. */
    }
  }
  const bySession = new Map<string, { candidate: CodexSessionDiscoveryCandidate; snapshot: ProcSnapshot } | null>();
  const pids = byInode.size ? await (options.lister ?? new LinuxProcessLister()).list() : [];
  for (const pid of pids) {
    let snapshot: ProcSnapshot | null;
    try {
      snapshot = await options.read(pid);
    } catch {
      continue;
    }
    // A controlling terminal excludes Runner-owned `codex exec`; the provider
    // matcher separately excludes app-server infrastructure.
    if (
      !snapshot
      || !snapshot.tty
      || !matchesProvider(snapshot, "codex")
      // An opt-in `codex --remote` TUI belongs to the existing native protocol
      // path. Hook evidence carries its trusted loopback endpoint; fd discovery
      // deliberately cannot manufacture or overwrite that stronger binding.
      || snapshot.argv.some((arg) => arg === "--remote" || arg.startsWith("--remote="))
    ) continue;
    const matches = new Map<string, CodexSessionDiscoveryCandidate>();
    for (const fd of await listFds(pid)) {
      try {
        const candidate = byInode.get(inodeKey(await stat(fd)));
        if (candidate) matches.set(`${candidate.sessionId}\0${candidate.sessionPath}`, candidate);
      } catch {
        // File descriptors disappear while they are being enumerated. That is
        // an ordinary process race, not a reason to fail the roster.
      }
    }
    // A lone child is not a terminal root either: a truncated roster used to
    // bind that child to its parent's TUI. Require explicit native evidence.
    const candidate = await terminalRoot([...matches.values()], options.readSessionHeader ?? readSessionHeader);
    if (!candidate) continue;
    bySession.set(candidate.sessionId, bySession.has(candidate.sessionId)
      ? null
      : { candidate, snapshot });
  }

  const bound: CodexTerminalBinding[] = [];
  for (const candidate of candidates) {
    const found = bySession.get(candidate.sessionId);
    if (!found) {
      await registry.forgetExternalCli("codex", candidate.sessionId, "CodexRolloutObserved").catch(() => {});
      continue;
    }
    let turnState = candidate.turnState ?? "unknown";
    let tool = candidate.tool;
    let cwd = candidate.cwd;
    if (turnState === "unknown" || !cwd) {
      try {
        const meta = options.readSessionText ? parseSessionText("codex", await readText(candidate.sessionPath)).meta
          : await readSessionSummaryFile(candidate.sessionPath, "codex");
        if (turnState === "unknown") turnState = turnStateFromActivity(meta.activity?.state);
        tool ??= meta.activity?.tool;
        cwd ||= meta.cwd;
      } catch {
        /* Exact process ownership remains useful when transcript parsing fails. */
      }
    }
    const identity: ProcessIdentity = {
      pid: found.snapshot.pid,
      startTicks: found.snapshot.startTicks,
      bootId: found.snapshot.bootId,
      pgid: found.snapshot.pgid,
      tty: found.snapshot.tty,
      command: found.snapshot.command,
    };
    const binding: CodexTerminalBinding = {
      ...candidate,
      identity,
      turnState,
      event: "CodexRolloutObserved",
      ...(tool ? { tool } : {}),
      ...(cwd ? { cwd } : {}),
    };
    const recorded = await registry.observeExternalCli({
      provider: "codex",
      sessionId: candidate.sessionId,
      identity,
      turnState,
      event: binding.event,
      ...(tool ? { tool } : {}),
      ...(cwd ? { cwd } : {}),
      transcriptPath: candidate.sessionPath,
    }).catch(() => false);
    if (recorded) bound.push(binding);
  }
  return bound;
}

/** Reverse discovery: only live terminal fds become candidates, never history. */
export async function discoverLiveCodexTerminals(
  processes: readonly ProcSnapshot[],
  ttys: ReadonlySet<string>,
  registry: AgentRuntimeRegistry,
  acceptPath: (file: string) => Promise<boolean>,
  options: Pick<CodexDiscoveryOptions, "listFds" | "stat" | "readSessionHeader" | "readSessionText">
    & { readlink?: (file: string) => Promise<string> } = {},
): Promise<CodexTerminalBinding[]> {
  const links = options.readlink ?? fs.readlink;
  const fds = new Map<number, readonly string[]>();
  const snapshots = new Map<number, ProcSnapshot>();
  const paths = new Map<string, CodexSessionDiscoveryCandidate>();
  for (const process of processes) {
    if (!process.tty || !matchesProvider(process, "codex")
      || process.argv.some((arg) => arg === "--remote" || arg.startsWith("--remote="))) continue;
    if (!ttys.has(await links(`/proc/${process.pid}/fd/0`).catch(() => ""))) continue;
    snapshots.set(process.pid, process);
    const files = await (options.listFds ?? linuxFds)(process.pid); fds.set(process.pid, files);
    for (const fd of files) {
      const file = await links(fd).catch(() => "");
      if (!file.endsWith(".jsonl") || paths.has(file) || !await acceptPath(file)) continue;
      paths.set(file, { sessionId: deriveIdFromPath("codex", file), sessionPath: file });
    }
  }
  return discoverCodexTerminalSessions([...paths.values()], registry, {
    ...options, lister: { list: async () => [...snapshots.keys()] },
    read: async (pid) => snapshots.get(pid) ?? null, listFds: async (pid) => fds.get(pid) ?? [],
  });
}
