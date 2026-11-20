import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { resetRecentSessionIndexes } from "@claude-bot/plugin-sessions/scan";
import { handleRpc } from "./core.js";
import type { AgentControlPlane } from "./agent-control-plane.js";

it("discovers and retains an old tmux session before the first 500 candidates, then projects its proof", async () => {
  const home = mkdtempSync(join(tmpdir(), "runner-roster-priority-"));
  try {
    const dir = join(home, ".codex", "sessions");
    mkdirSync(dir, { recursive: true });
    const id = (n: number) => "00000000-0000-0000-0000-" + String(n).padStart(12, "0");
    for (let n = 1; n <= 1000; n++) {
      const file = join(dir, `rollout-${id(n)}.jsonl`);
      writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: id(n), cwd: "/project" } }) + "\n");
      const time = new Date(n === 1 ? "2020-01-01" : "2026-09-08");
      utimesSync(file, time, time);
    }
    let discovered = false;
    const runtime = { process_state: "alive", turn_state: "idle",
      attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } };
    const discover = vi.fn(async (candidates: Array<{ sessionId: string }>) => {
      if (!discovered) expect(candidates).toHaveLength(1000);
      discovered ||= candidates.some((row) => row.sessionId === id(1));
    });
    const control = { discover, publicRuntime: vi.fn(async (_source: string, sessionId: string) =>
      discovered && sessionId === id(1) ? runtime : undefined) } as unknown as AgentControlPlane;
    const result = await handleRpc(home, { id: "priority", method: "list_recent_sessions",
      args: { primary_window: true, limit: 200 } }, { agentControlPlane: control });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ returned: 200, total_found: 1000,
      sessions: [expect.objectContaining({ id: id(1), runtime }), ...Array(199).fill(expect.anything())] });
  } finally {
    resetRecentSessionIndexes();
    rmSync(home, { recursive: true, force: true });
  }
});
