import { describe, expect, it } from "vitest";
import {
  accumulateTurnCost,
  EMPTY_TICKET_COST,
  moduleOf,
  parseNumstat,
} from "./ticket-cost.js";

describe("accumulateTurnCost", () => {
  it("folds turns into a running total", () => {
    const one = accumulateTurnCost(null, { duration_ms: 1_000, tokens_in: 10, tokens_out: 5, tokens_cached: 900 });
    const two = accumulateTurnCost(one, { duration_ms: 2_500, tokens_in: 20, tokens_out: 7, tokens_cached: 1_100 });
    expect(two).toEqual({
      agent_ms: 3_500,
      agent_turns: 2,
      tokens_in: 30,
      tokens_out: 12,
      tokens_cached: 2_000,
    });
  });

  it("counts a turn that reported nothing measurable", () => {
    const cost = accumulateTurnCost(EMPTY_TICKET_COST, {});
    expect(cost).toEqual({ ...EMPTY_TICKET_COST, agent_turns: 1 });
  });

  it("ignores negative, NaN and non-numeric usage rather than corrupting the total", () => {
    const cost = accumulateTurnCost(null, {
      duration_ms: -5,
      tokens_in: Number.NaN,
      tokens_out: Number.POSITIVE_INFINITY,
      tokens_cached: "900" as unknown as number,
    });
    expect(cost).toEqual({ ...EMPTY_TICKET_COST, agent_turns: 1 });
  });

  it("rounds fractional durations so the column stays an integer", () => {
    expect(accumulateTurnCost(null, { duration_ms: 10.6 }).agent_ms).toBe(11);
  });
});

describe("moduleOf", () => {
  it("treats each workspace package as its own module", () => {
    expect(moduleOf("packages/bot/src/devpipe/pipeline.ts")).toBe("bot");
    expect(moduleOf("packages/dashboard-web/src/pages/TicketsPage.tsx")).toBe("dashboard-web");
  });

  it("collapses everything else to its top directory", () => {
    expect(moduleOf("doc/deliveries/x.md")).toBe("doc");
    expect(moduleOf("scripts/ops/land.sh")).toBe("scripts");
  });

  it("names root files and degenerate paths without throwing", () => {
    expect(moduleOf("package.json")).toBe("(root)");
    expect(moduleOf("")).toBe("(root)");
    expect(moduleOf("packages")).toBe("(root)");
  });
});

describe("parseNumstat", () => {
  it("counts files, modules and churn", () => {
    const stat = parseNumstat(
      [
        "12\t3\tpackages/bot/src/devpipe/pipeline.ts",
        "40\t0\tpackages/bot/src/devpipe/ci-trace-digest.ts",
        "5\t5\tpackages/dashboard-web/src/pages/TicketsPage.tsx",
        "7\t1\tdoc/deliveries/2026-08-16-x.md",
      ].join("\n"),
    );
    expect(stat).toEqual({
      files: 4,
      modules: 3,
      moduleNames: ["bot", "dashboard-web", "doc"],
      added: 64,
      removed: 9,
    });
  });

  it("counts a binary file as touched but contributes no line churn", () => {
    const stat = parseNumstat("-\t-\tpackages/bot/assets/logo.png\n3\t1\tpackages/bot/src/a.ts");
    expect(stat).toMatchObject({ files: 2, modules: 1, added: 3, removed: 1 });
  });

  it("ignores blank lines and unparseable rows", () => {
    const stat = parseNumstat("\n\nnot a numstat row\n2\t2\tpackages/bot/src/a.ts\n");
    expect(stat).toMatchObject({ files: 1, added: 2, removed: 2 });
  });

  it("returns zeroes for an empty diff", () => {
    expect(parseNumstat("")).toEqual({ files: 0, modules: 0, moduleNames: [], added: 0, removed: 0 });
  });

  it("keeps module names sorted so the stored value is stable across runs", () => {
    const a = parseNumstat("1\t0\tpackages/zzz/a.ts\n1\t0\tpackages/aaa/b.ts");
    const b = parseNumstat("1\t0\tpackages/aaa/b.ts\n1\t0\tpackages/zzz/a.ts");
    expect(a.moduleNames).toEqual(["aaa", "zzz"]);
    expect(a.moduleNames).toEqual(b.moduleNames);
  });
});
