/** Stop only a child/process group created by this attachment, never discovered CLIs. */
import type { ChildProcess } from "node:child_process";

const owned = new Map<ChildProcess, boolean>();
process.once("exit", () => {
  for (const [child, group] of owned) {
    try { signalCodexProcess(child, "SIGKILL", group); } catch { /* continue releasing the other owners */ }
  }
});

/** Register at spawn, before initialize/resume can fail or shutdown can race setup. */
export function trackCodexProcess(child: ChildProcess, group: boolean): void {
  owned.set(child, group);
  child.once("exit", () => {
    // A launcher exiting does not prove its native writer exited. A private
    // group is ours; never apply this to discovered GUI/CLI processes.
    try { if (group) signalCodexProcess(child, "SIGKILL", true); }
    finally { owned.delete(child); }
  });
  child.once("error", () => { if (!child.pid) owned.delete(child); });
}

export function signalCodexProcess(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
  if (group && child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

export async function closeCodexProcess(child: ChildProcess, group: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalCodexProcess(child, "SIGTERM", group);
  const exited = await childExited(child, 1000);
  // npm's launcher is an extra process. Its exit alone does not prove the
  // native writer or its children exited. The private group is ours alone.
  if (group || !exited) signalCodexProcess(child, "SIGKILL", group);
  if (!await childExited(child, 1000)) throw new Error("owned Codex process did not exit after SIGKILL");
}

function childExited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const onExit = (): void => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(child.exitCode !== null || child.signalCode !== null); }, timeoutMs);
    child.once("exit", onExit);
  });
}
