/** Content-free, operation-local timings for the input delivery path. */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

type Stage = { stage: string; ms: number };
const timing = new AsyncLocalStorage<Stage[]>();
const ms = (start: number): number => Math.round((performance.now() - start) * 100) / 100;

export async function sessionInputStage<T>(stage: string, run: () => Promise<T>): Promise<T> {
  const stages = timing.getStore();
  if (!stages) return await run();
  const start = performance.now();
  try { return await run(); }
  finally { if (stages.length < 32) stages.push({ stage, ms: ms(start) }); }
}

export async function withSessionInputPerf<T>(rpcId: string, operationId: string | undefined, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const stages: Stage[] = [];
  return await timing.run(stages, async () => {
    try { return await run(); }
    finally {
      // No args, prompt, transcript, path, credential, or error text. Logging
      // cannot change delivery success or authorize a retry.
      try { console.info("[runner] session_input_perf " + JSON.stringify({
        rpc_id: rpcId.slice(0, 100), operation_id: operationId?.slice(0, 100),
        total_ms: ms(start), stages,
      })); } catch { /* best effort only */ }
    }
  });
}
