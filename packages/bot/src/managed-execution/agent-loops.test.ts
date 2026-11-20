import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { ResourceRecoveryService } from "../resources/recovery.js";
import { ManagedExecutionSupervisor } from "./supervisor.js";
import { registerManagedAgentLoop } from "./agent-loops.js";
import type { LoopCheckpoint, LoopOutcome, RunLoopRequest } from "./loop.js";

let dir: string;
let store: Store;
let supervisor: ManagedExecutionSupervisor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "managed-agent-loop-"));
  store = new Store(join(dir, "bot.db"));
  supervisor = new ManagedExecutionSupervisor(store.managedExecutions, new ResourceRecoveryService(store.resourceWaiters));
});
afterEach(async () => {
  await supervisor.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("managed agent loop checkpoint", () => {
  it("persists a conversation larger than the old 2 MiB checkpoint bound and completes", async () => {
    // Four tool results of 20k characters per round across 30 rounds: a long
    // but ordinary run whose history is ~2.4 MB of model messages.
    const history: LoopCheckpoint["history"] = [{ role: "system", content: "s" }];
    for (let round = 0; round < 30; round++) {
      for (let call = 0; call < 4; call++) history.push({ role: "tool", tool_call_id: `c${round}-${call}`, content: "x".repeat(20_000) });
    }
    let persisted = 0;
    const settled: Array<{ outcome?: LoopOutcome; error?: string }> = [];
    registerManagedAgentLoop(supervisor, "app-agent", {
      authorized: () => true,
      open: async () => ({
        request: { systemPrompt: "s", messages: [], tools: [], model: "m", callTool: async () => ({ text: "" }) },
        loop: {
          run: async (request: RunLoopRequest): Promise<LoopOutcome> => {
            request.checkpoint!.save({
              version: 1, phase: "tools", history, pendingCalls: [], nextCall: 0, round: 30, toolCalls: 120, lastText: "", suspend: null,
            });
            const row = store.managedExecutions.get("alice", "turn-1")!;
            persisted = ((row.checkpoint as { loop: LoopCheckpoint }).loop.history).length;
            return { kind: "done", text: "ok", toolCalls: 120 };
          },
        },
      }),
      settled: (_row, result) => { settled.push(result); },
    });
    supervisor.submit({
      id: "turn-1", reference: "turn-1", owner: "alice", source: "app-agent",
      resumeOwner: "head", desired: "running", observed: "running", dispatch: "not_sent",
    });
    await supervisor.sweep();

    expect(JSON.stringify(history).length).toBeGreaterThan(2 * 1024 * 1024);
    expect(persisted).toBe(history.length);
    expect(settled).toEqual([{ outcome: { kind: "done", text: "ok", toolCalls: 120 } }]);
    expect(store.managedExecutions.get("alice", "turn-1")).toMatchObject({ observed: "completed" });
  });
});
