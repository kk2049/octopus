import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ManagedCompletionJournal } from "./managed-completions.js";
import {
  RUNNER_MANAGED_COMPLETION_SCHEMA,
  type RunnerManagedCompletion,
} from "./gateway-protocol.js";

it("replays durable content-free completion evidence after restart and rejects lookalikes", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-completions-"));
  try {
    const event: RunnerManagedCompletion = {
      schema: RUNNER_MANAGED_COMPLETION_SCHEMA,
      provider: "codex",
      session_id: "s1",
      turn_id: "turn1",
      status: "succeeded",
      completed_at: "2026-09-17T12:00:00Z",
      usage: { tokens_in: 100, tokens_out: 40 },
    };
    const journal = new ManagedCompletionJournal(root);
    await journal.record(event);
    await journal.record(event);
    await writeFile(
      join(root, "1758100000000-" + "a".repeat(64) + ".json"),
      "{corrupt",
    );
    expect(await new ManagedCompletionJournal(root).recent()).toEqual([event]);
    await expect(
      journal.record({
        ...event,
        prompt: "private",
      } as RunnerManagedCompletion),
    ).rejects.toThrow("Invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("stops replaying receipts one site acknowledged without hiding them from another site", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-completions-ack-"));
  try {
    const journal = new ManagedCompletionJournal(root);
    const receipt = (turn: string, second: number): RunnerManagedCompletion => ({
      schema: RUNNER_MANAGED_COMPLETION_SCHEMA, provider: "codex", session_id: "s1", turn_id: turn,
      status: "succeeded", completed_at: `2026-10-15T12:00:${String(second).padStart(2, "0")}Z`,
    });
    await journal.record(receipt("turn-1", 1));
    await journal.record(receipt("turn-2", 2));
    await journal.acknowledge("primary", { provider: "codex", turn_id: "turn-1" });
    // An acknowledgement for a receipt this journal never kept is harmless.
    await journal.acknowledge("primary", { provider: "codex", turn_id: "never-recorded" });
    expect((await journal.recent("primary")).map((event) => event.turn_id)).toEqual(["turn-2"]);
    expect((await journal.recent("mirror")).map((event) => event.turn_id)).toEqual(["turn-1", "turn-2"]);
    expect((await new ManagedCompletionJournal(root).recent("primary")).map((event) => event.turn_id)).toEqual(["turn-2"]);
    // Markers outside the replay window are pruned; receipts stay for diagnosis.
    const markers = join(root, "acknowledged", (await readdir(join(root, "acknowledged")))[0]!);
    expect(await readdir(markers)).toHaveLength(1);
    expect((await readdir(root)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
