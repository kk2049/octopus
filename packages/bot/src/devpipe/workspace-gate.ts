import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { RemoteGateUnavailable, type RemoteGateSession } from "./remote-gate.js";
import { shellQuote } from "./runner-machine-sync.js";
import { WorkspaceProvider, WorkspaceProviderUnavailable, type WorkspaceTask } from "./workspace-provider.js";

/** A new request joins an unfinished gate. Only an explicitly repeated check
 * after a known terminal verdict allocates another run; unknown never does.
 */
export function workspaceProviderGate(provider: WorkspaceProvider, stateDir: string): RemoteGateSession {
  let sha = "", runId = "", file = "", settled = false;
  const persistRun = async (terminal: boolean) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const h = await fs.open(temporary, "wx", 0o600);
    try { await h.writeFile(JSON.stringify({ runId, sha, target: provider.target, terminal })); await h.sync(); }
    finally { await h.close(); }
    await fs.rename(temporary, file);
    const parent = await fs.open(stateDir, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  };
  const workspace = `workspace:${provider.target.workspaceId}/land`;
  const wrap = (error: unknown): never => {
    throw new RemoteGateUnavailable(`workspace provider gate run=${runId} source=${sha}: ${error instanceof Error ? error.message : String(error)}`, error instanceof WorkspaceProviderUnavailable ? "offline" : "unknown");
  };
  const execute = async (task: WorkspaceTask) => {
    settled = false;
    try { const result = await provider.wait(task); settled = true; return result; } catch (error) { return wrap(error); }
  };
  return {
    device: provider.target.device, workspace, cacheDir: ".octopus-gate-cache",
    async sync(sourceDir, sourceSha) {
      sha = sourceSha;
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
      file = path.join(stateDir, `${createHash("sha256").update(JSON.stringify([provider.target, sha])).digest("hex")}.json`);
      let previous: { runId: string; terminal: boolean } | null = null;
      try { previous = JSON.parse(await fs.readFile(file, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return wrap(error); }
      runId = previous && !previous.terminal ? previous.runId : randomUUID();
      await persistRun(false);
      const result = await execute({ key: `${runId}:prepare`, workspaceKey: "land", sha, sourceDir,
        command: "mkdir -p .octopus-gate-cache", timeoutMs: 300000 });
      return { ok: result.state === "succeeded", ...(result.state === "succeeded" ? {} : { refusal: result.state === "not_started" ? "remote_unavailable" as const : result.state === "timed_out" ? "timeout" as const : "deps_build" as const }), detail: `provider=${provider.target.device} workspace=${provider.target.workspaceId} run=${runId} job=${result.job_id} state=${result.state} sha=${sha}` };
    },
    async run(step, timeoutMs) {
      if (!runId || !sha) throw new RemoteGateUnavailable("workspace gate has no exact prepared source");
      const command = [step.bin, ...step.args].map(shellQuote).join(" ");
      const digest = createHash("sha256").update(command).digest("hex");
      const key = `${runId}:${step.id ?? "step"}:${digest}`;
      const result = await execute({ key, workspaceKey: "land", sha, command, timeoutMs: Math.min(2700000, Math.max(1000, timeoutMs)) });
      if (result.state === "not_started") throw new RemoteGateUnavailable(`workspace gate step not started: ${result.error}`, "offline");
      let text = "";
      try { text = (await provider.log(key, Math.max(0, (result.log_bytes ?? 0) - 12000), 12000)).text; }
      catch (error) { text = `log unavailable; read original job=${result.job_id}: ${String(error)}`; }
      return { ok: result.state === "succeeded", timedOut: result.state === "timed_out",
        log: `$ ${step.bin} ${step.args.join(" ")}\n${text}\n# provider=${provider.target.device} workspace=${provider.target.workspaceId} run=${runId} job=${result.job_id} state=${result.state} sha=${sha} exit=${result.exit_code}` };
    },
    async close() {
      if (settled && file) {
        await persistRun(true);
      }
    },
  };
}
