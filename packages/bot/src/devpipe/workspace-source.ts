import path from "node:path";
import { shellQuote, type MachineExec } from "./runner-machine-sync.js";

export interface WorkspaceSourceState { head: string | null; refs: string[] }

/** Read only the destination's own Git objects; preparation stays inside the durable worker's slot. */
export async function workspaceSourceState(exec: MachineExec, checkoutDir: string, workspaceKey: string): Promise<WorkspaceSourceState> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(workspaceKey)) throw new Error("invalid workspace source key");
  const directory = path.posix.join(checkoutDir, ".octopus-ci", "workspaces", workspaceKey);
  const q = shellQuote;
  const result = await exec({ command: `if [ ! -e ${q(directory)} ]; then `
    // A fresh clone is guaranteed to receive advertised heads, not the seed's remote-tracking refs.
    // --shared may be disabled by transport/config; those extra objects cannot be bundle prerequisites.
    + `if [ -e ${q(path.posix.join(checkoutDir, ".git"))} ]; then git -C ${q(checkoutDir)} rev-parse --verify HEAD && git -C ${q(checkoutDir)} for-each-ref --format='%(objectname)' refs/heads | head -n 63; else echo MISSING; fi; else `
    + `git -C ${q(directory)} rev-parse --verify HEAD && git -C ${q(directory)} for-each-ref --format='%(objectname)' refs/heads refs/remotes | head -n 63; fi`, timeout_ms: 30000 });
  if (!result.ok) throw new Error("workspace source probe unavailable; refusing an unmeasured full-bundle fallback");
  if (result.stdout.trim() === "MISSING") return { head: null, refs: [] };
  const refs = result.stdout.trim().split(/\s+/).slice(0, 64);
  if (!refs.length || refs.some((sha) => !/^[0-9a-f]{40}$/.test(sha))) throw new Error("invalid workspace source probe");
  return { head: refs[0], refs: [...new Set(refs)] };
}
