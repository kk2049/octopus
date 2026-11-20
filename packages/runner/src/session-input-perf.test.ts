import { afterEach, expect, it, vi } from "vitest";
import { sessionInputStage, withSessionInputPerf } from "./session-input-perf.js";

afterEach(() => vi.restoreAllMocks());

it("keeps concurrent input stages separate and never logs returned content or errors", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const first = withSessionInputPerf("rpc-a", "op-a", () => sessionInputStage("a", async () => {
    await wait; return "private prompt and token";
  }));
  await expect(withSessionInputPerf("rpc-b", "op-b", () => sessionInputStage("b", async () => {
    throw new Error("private error with credential");
  }))).rejects.toThrow("private error");
  release(); expect(await first).toBe("private prompt and token");
  const rows = log.mock.calls.map(([line]) => JSON.parse(String(line).split("session_input_perf ")[1]));
  expect(rows.map(row => [row.operation_id, row.stages.map((s: { stage: string }) => s.stage)])).toEqual([
    ["op-b", ["b"]], ["op-a", ["a"]],
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/private|credential|token/);
  expect(rows.every(row => row.total_ms >= 0 && row.stages[0].ms >= 0)).toBe(true);
});

it("bounds records and a failing logger cannot fail delivery", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  await withSessionInputPerf("rpc", undefined, async () => {
    for (let n = 0; n < 50; n++) await sessionInputStage("stage", async () => n);
  });
  expect(JSON.parse(String(log.mock.calls[0][0]).split("session_input_perf ")[1]).stages).toHaveLength(32);
  log.mockImplementation(() => { throw new Error("log unavailable"); });
  expect(await withSessionInputPerf("rpc", undefined, async () => "delivered")).toBe("delivered");
});
