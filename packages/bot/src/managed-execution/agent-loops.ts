import { AgentEffectUnknown, AgentModelUnavailable, type AgentLoop, type LoopCheckpoint, type LoopOutcome,
  type RunLoopRequest } from "./loop.js";
import type { ManagedExecutionRow } from "../store/repositories/managed-executions.js";
import type { ExecutionStep, ManagedExecutionSupervisor } from "./supervisor.js";
import { createLogger } from "../logger.js";
import { isManagedDependencyUnavailable } from "@claude-bot/runner/managed-execution";

const log = createLogger("managed-agent-loop");

export type HeadAgentSource = "app-agent" | "discussion" | "knowledge-chat" | "research-canvas";
export interface ManagedLoopAdapter {
  maxConcurrent?: number;
  authorized(row: ManagedExecutionRow): boolean | Promise<boolean>;
  open(row: ManagedExecutionRow): Promise<{ loop: Pick<AgentLoop, "run">; request: RunLoopRequest; close?(): Promise<void> } | null>;
  settled(row: ManagedExecutionRow, result: { outcome?: LoopOutcome; error?: string; unknown?: boolean }): void;
  changed?(row: ManagedExecutionRow): void;
}

/** Shared HTTP agent adapter; callers retain tool Gates, actor identity and domain transcripts. */
export function registerManagedAgentLoop(supervisor: ManagedExecutionSupervisor, source: HeadAgentSource,
  adapter: ManagedLoopAdapter): () => void {
  return supervisor.register(source, {
    maxConcurrent: adapter.maxConcurrent,
    authorized: row => adapter.authorized(row),
    changed: row => adapter.changed?.(row),
    reconcile: async (lease): Promise<ExecutionStep> => {
      const current = lease.row.checkpoint as { loop?: LoopCheckpoint } | undefined;
      if (current?.loop?.phase === "effect") {
        adapter.settled(lease.row, { error: new AgentEffectUnknown().message, unknown: true });
        return { kind: "unknown", detail: new AgentEffectUnknown().message };
      }
      let opened: Awaited<ReturnType<ManagedLoopAdapter["open"]>> = null;
      try {
        opened = await adapter.open(lease.row);
        if (!opened) return { kind: "completed" };
        lease.assertCurrent();
        const outcome = await opened.loop.run({ ...opened.request,
          signal: opened.request.signal ? AbortSignal.any([opened.request.signal, lease.signal]) : lease.signal,
          checkpoint: {
          load: () => (lease.row.checkpoint as { loop?: LoopCheckpoint } | undefined)?.loop,
          save: loop => {
            // Only the journal owns this private data. Public projections use
            // ManagedExecution fields and never serialize this checkpoint.
            const previous = (lease.row.checkpoint as { loop?: LoopCheckpoint } | undefined)?.loop;
            if (lease.row.dependency && loop.phase !== "model" && (!previous || loop.history.length > previous.history.length)) lease.dependencyAvailable();
            // No size bound of its own: `loop.history` is exactly the message
            // list the loop sends to the model each round, so the model's
            // context window already bounds it. A smaller fixed cap here only
            // failed long runs that the model itself would have accepted.
            const next = { ...(lease.row.checkpoint as Record<string, unknown> | undefined), loop };
            lease.checkpoint(next, loop.phase === "effect" ? "uncertain" : "not_sent");
          },
        } });
        lease.assertCurrent();
        adapter.settled(lease.row, { outcome });
        return { kind: outcome.kind === "suspended" ? "waiting_approval" : "completed" };
      } catch (error) {
        if (error instanceof AgentModelUnavailable) return { kind: "wait", dependency: `model:${source}`, detail: error.message };
        if (isManagedDependencyUnavailable(error)) return { kind: "wait", dependency: `runtime:${source}`, detail: error.message };
        lease.assertCurrent();
        const unknown = error instanceof AgentEffectUnknown
          || (lease.row.checkpoint as { loop?: LoopCheckpoint } | undefined)?.loop?.phase === "effect";
        const detail = unknown ? new AgentEffectUnknown().message : error instanceof Error ? error.message.slice(0, 600) : "Agent 执行失败";
        adapter.settled(lease.row, { error: detail, unknown });
        return { kind: unknown ? "unknown" : "failed", detail };
      } finally {
        // Releasing a handle cannot erase a committed domain result or turn a
        // proven model-only wait into an uncertain tool effect.
        try { await opened?.close?.(); }
        catch (error) { log.warn({ source, id: lease.row.id, err: error }, "agent handle cleanup failed"); }
      }
    },
  });
}
