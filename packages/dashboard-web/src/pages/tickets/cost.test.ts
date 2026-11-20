import { describe, expect, it } from "vitest";
import { compactCount, compactDuration, ticketCostStrip } from "./cost.js";
import type { Ticket } from "./model.js";

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 1,
    title: "t",
    requester: "lht",
    kind: "simple",
    dev_status: "open",
    deploy_status: "pending",
    model: "codex-gpt-5.6-sol",
    effort: "high",
    ...over,
  };
}

describe("compactDuration", () => {
  it("keeps every magnitude to three characters or so", () => {
    expect(compactDuration(45_000)).toBe("45s");
    expect(compactDuration(12 * 60_000)).toBe("12m");
    expect(compactDuration(90 * 60_000)).toBe("1.5h");
    expect(compactDuration(14 * 3_600_000)).toBe("14h");
  });

  it("renders nothing for absent or nonsense input", () => {
    expect(compactDuration(0)).toBe("");
    expect(compactDuration(-1)).toBe("");
    expect(compactDuration(Number.NaN)).toBe("");
  });
});

describe("compactCount", () => {
  it("switches units so five orders of magnitude fit the same width", () => {
    expect(compactCount(840)).toBe("840");
    expect(compactCount(1_400)).toBe("1.4k");
    expect(compactCount(28_400)).toBe("28k");
    expect(compactCount(1_400_000)).toBe("1.4M");
    expect(compactCount(24_000_000)).toBe("24M");
  });

  it("renders nothing for zero", () => {
    expect(compactCount(0)).toBe("");
  });
});

describe("ticketCostStrip", () => {
  it("shows nothing for a ticket that has not run", () => {
    expect(ticketCostStrip(ticket()).parts).toEqual([]);
  });

  it("sums the three token buckets into one number", () => {
    const strip = ticketCostStrip(ticket({ tokens_in: 20_000, tokens_out: 8_000, tokens_cached: 900_000 }));
    expect(strip.parts).toEqual(["928k tokens"]);
    expect(strip.hint).toContain("缓存读 900,000");
  });

  it("only spends characters on the turn count when there was more than one", () => {
    expect(ticketCostStrip(ticket({ agent_ms: 720_000, agent_turns: 1 })).parts).toEqual(["12m"]);
    expect(ticketCostStrip(ticket({ agent_ms: 720_000, agent_turns: 4 })).parts).toEqual(["12m×4"]);
  });

  it("renders the full strip for a landed ticket, compactly", () => {
    const strip = ticketCostStrip(ticket({
      agent_ms: 1_920_000,
      agent_turns: 3,
      tokens_in: 30_000,
      tokens_out: 12_000,
      tokens_cached: 1_200_000,
      diff_files: 11,
      diff_modules: 3,
      diff_added: 420,
      diff_removed: 96,
    }));
    expect(strip.parts).toEqual(["32m×3", "1.2M tokens", "3模11文", "+420−96"]);
    // The whole strip has to survive a ~220px sidebar row.
    expect(strip.parts.join(" ").length).toBeLessThan(40);
  });

  it("treats a measured zero diff as data, and a null diff as absent", () => {
    const measured = ticketCostStrip(ticket({ diff_files: 0, diff_modules: 0, diff_added: 0, diff_removed: 0 }));
    expect(measured.parts).toEqual(["0模0文"]);
    const unmeasured = ticketCostStrip(ticket({ diff_files: null, diff_modules: null }));
    expect(unmeasured.parts).toEqual([]);
  });

  it("makes a wide-blast-radius ticket visibly different from a narrow one", () => {
    const narrow = ticketCostStrip(ticket({ diff_files: 3, diff_modules: 1, diff_added: 40, diff_removed: 5 }));
    const wide = ticketCostStrip(ticket({ diff_files: 118, diff_modules: 14, diff_added: 5_100, diff_removed: 964 }));
    expect(narrow.parts).toEqual(["1模3文", "+40−5"]);
    expect(wide.parts).toEqual(["14模118文", "+5.1k−964"]);
  });
});
