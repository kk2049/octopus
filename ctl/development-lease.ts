/**
 * How long a native CLI may hold the shared integration lease.
 *
 * A hold lasts DEFAULT_HOLD_MINUTES (or the requested 1–MAX_HOLD_MINUTES) from
 * an explicit acquire/takeover, and renewal stops as soon as the acquiring
 * process is gone, so a live owner keeps its lease and a dead one loses it. `acquire` returns
 * immediately, so the lease cannot follow the command's own process. It follows
 * the nearest long-lived caller instead: the agent CLI (Claude Code, Codex, omp)
 * or the interactive/script shell that ran the command. Transient wrappers in
 * between (`bash -c`, flock, pnpm, tsx, timeout...) end with the command and
 * are skipped. The identity is the pid + starttime + boot id tuple the Runner
 * uses, so pid reuse cannot keep a dead holder's lease alive. When no owner
 * can be proven, the hold deadline alone bounds the lease.
 */
import path from "node:path";
import { LinuxProcessReader, matchesProvider, type ProcessReader, type ProcSnapshot } from "../packages/runner/src/agent-runtime.js";

export const DEFAULT_HOLD_MINUTES = 60;
export const MAX_HOLD_MINUTES = 480;
export interface LeaseOwner { pid: number; startTicks: string; bootId: string; command: string }

/** The absolute end of a new hold (the same 1–480 minute choice as before owner tracking). */
export function holdDeadline(requestedMinutes: string | undefined, now = Date.now()): number {
  const minutes = Number(requestedMinutes ?? DEFAULT_HOLD_MINUTES);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_HOLD_MINUTES) {
    throw new Error(`hold-minutes must be between 1 and ${MAX_HOLD_MINUTES}`);
  }
  return now + minutes * 60_000;
}

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "mksh", "ash", "fish"]);

/** A shell evaluating one `-c` command string exits with that command. */
function longLivedShell(proc: ProcSnapshot): boolean {
  if (!SHELLS.has(path.basename(proc.argv[0] || proc.command).replace(/^-/, ""))) return false;
  return !proc.argv.slice(1).some(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg) || arg === "--command" || arg.startsWith("--command="));
}

export async function leaseOwner(reader: ProcessReader = new LinuxProcessReader(), start = process.ppid): Promise<LeaseOwner | null> {
  let pid = start;
  for (let depth = 0; pid > 1 && depth < 32; depth += 1) {
    const proc = await reader.read(pid);
    if (!proc) return null;
    if (matchesProvider(proc, "claude") || matchesProvider(proc, "codex") || matchesProvider(proc, "omp") || longLivedShell(proc)) {
      return { pid: proc.pid, startTicks: proc.startTicks, bootId: proc.bootId, command: proc.command };
    }
    if (proc.ppid === pid) return null;
    pid = proc.ppid;
  }
  return null;
}

export async function leaseOwnerAlive(owner: LeaseOwner, reader: ProcessReader = new LinuxProcessReader()): Promise<boolean> {
  const proc = await reader.read(owner.pid);
  return Boolean(proc && proc.startTicks === owner.startTicks && proc.bootId === owner.bootId);
}

/** The heartbeat's only renewal rule: same lease, inside its hold, owner alive. */
export async function keepRenewing(
  current: { lease?: { epoch: string }; deadline?: number; owner?: LeaseOwner } | null,
  epoch: string, now = Date.now(), reader?: ProcessReader,
): Promise<boolean> {
  if (current?.lease?.epoch !== epoch || !current.deadline || now >= current.deadline) return false;
  return !current.owner || await leaseOwnerAlive(current.owner, reader);
}
