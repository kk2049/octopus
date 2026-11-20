import { describe, expect, it } from "vitest";
import { CodexQuotaProbe, parseOmpCodexUsage } from "./codex-quota.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const RESET = 1_800_000_000_000;

function codexReport(accountLabel: string, remaining: number, resetsAt = RESET) {
  return {
    provider: "openai-codex",
    limits: [
      {
        id: "openai-codex:primary",
        label: "7 days",
        scope: { provider: "openai-codex", windowId: "7d", shared: true },
        window: { id: "7d", durationMs: WEEK_MS, resetsAt },
        amount: {
          used: 100 - remaining,
          remaining,
          usedFraction: (100 - remaining) / 100,
          remainingFraction: remaining / 100,
          unit: "percent",
        },
      },
      {
        id: "openai-codex:spark:primary",
        label: "7 days (Spark)",
        scope: { provider: "openai-codex", tier: "spark", windowId: "7d" },
        window: { id: "7d", durationMs: WEEK_MS, resetsAt: RESET + WEEK_MS },
        amount: { used: 0, remaining: 100, unit: "percent" },
      },
    ],
    metadata: {
      email: accountLabel,
      accountId: "must-not-leave-the-probe",
      planType: "pro",
    },
  };
}

function usage(...reports: unknown[]) {
  return { generatedAt: RESET - 1_000, reports };
}

describe("parseOmpCodexUsage", () => {
  it("projects the two routed Codex accounts into distinct main-window cards", () => {
    const cards = parseOmpCodexUsage(usage(
      codexReport("ol*", 0, RESET),
      codexReport("li*", 94, RESET + WEEK_MS),
    ));

    expect(cards).toEqual([
      {
        key: "codex:account:1:10080m",
        label: "Codex · 一周",
        accountLabel: "ol*",
        usedPercent: 100,
        remainPercent: 0,
        severity: "critical",
        resetsAt: new Date(RESET).toISOString(),
      },
      {
        key: "codex:account:2:10080m",
        label: "Codex · 一周",
        accountLabel: "li*",
        usedPercent: 6,
        remainPercent: 94,
        severity: "normal",
        resetsAt: new Date(RESET + WEEK_MS).toISOString(),
      },
    ]);
  });

  it("drops Spark, unrelated providers, ids, plan metadata, and unredacted fields", () => {
    const cards = parseOmpCodexUsage(usage(
      { provider: "cursor", limits: [], metadata: { email: "cursor@example.com" } },
      codexReport("ol*", 52),
    ));
    expect(cards).toHaveLength(1);
    const serialized = JSON.stringify(cards);
    expect(serialized).not.toContain("spark");
    expect(serialized).not.toContain("must-not-leave");
    expect(serialized).not.toContain("planType");
    expect(serialized).not.toContain("cursor@example.com");
  });

  it("accepts OMP fraction fallbacks and clamps them to a percentage", () => {
    const first = codexReport("a*", 50);
    const second = codexReport("b*", 50);
    const firstAmount = first.limits[0]!.amount as Record<string, unknown>;
    const secondAmount = second.limits[0]!.amount as Record<string, unknown>;
    delete firstAmount.remaining;
    firstAmount.remainingFraction = 1.4;
    delete secondAmount.remaining;
    delete secondAmount.remainingFraction;
    secondAmount.usedFraction = 0.125;

    const cards = parseOmpCodexUsage(usage(first, second));
    expect(cards.map((card) => [card.usedPercent, card.remainPercent])).toEqual([
      [0, 100],
      [12, 88],
    ]);
  });

  it("returns no cards for malformed projections or accounts without a main percentage", () => {
    for (const raw of [null, undefined, {}, { reports: 42 }, { reports: [] }]) {
      expect(parseOmpCodexUsage(raw)).toEqual([]);
    }
    expect(parseOmpCodexUsage(usage({
      provider: "openai-codex",
      limits: [{ id: "openai-codex:spark:primary" }],
      metadata: { email: "x*" },
    }))).toEqual([]);
  });
});

describe("CodexQuotaProbe", () => {
  it("uses the OMP account-pool projection and accepts an explicit empty roster", async () => {
    const full = new CodexQuotaProbe({
      readUsageSnapshot: async () => usage(codexReport("a*", 72), codexReport("b*", 41)),
    });
    expect((await full.snapshot()).cards.map((card) => card.accountLabel)).toEqual(["a*", "b*"]);

    const empty = new CodexQuotaProbe({ readUsageSnapshot: async () => usage() });
    const snapshot = await empty.snapshot();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.cards).toEqual([]);
  });

  it("reports unavailable for malformed output or a failed OMP read", async () => {
    const malformed = new CodexQuotaProbe({ readUsageSnapshot: async () => ({ hello: "world" }) });
    expect(await malformed.snapshot()).toMatchObject({ cards: [], error: "unavailable" });

    const failed = new CodexQuotaProbe({
      readUsageSnapshot: async () => {
        throw new Error("EIO");
      },
    });
    expect(await failed.snapshot()).toMatchObject({ cards: [], error: "unavailable" });
  });

  it("caches successful reads for the success TTL", async () => {
    let now = 1_000_000;
    let hits = 0;
    const probe = new CodexQuotaProbe({
      now: () => now,
      okTtlMs: 60_000,
      readUsageSnapshot: async () => {
        hits++;
        return usage(codexReport("a*", 90));
      },
    });
    await probe.snapshot();
    now += 59_000;
    await probe.snapshot();
    expect(hits).toBe(1);
    now += 2_000;
    await probe.snapshot();
    expect(hits).toBe(2);
  });

  it("shares one in-flight OMP read between concurrent callers", async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = new CodexQuotaProbe({
      readUsageSnapshot: async () => {
        started++;
        await gate;
        return usage(codexReport("a*", 80), codexReport("b*", 70));
      },
    });
    const all = Promise.all([probe.snapshot(), probe.snapshot(), probe.snapshot()]);
    release();
    const results = await all;
    expect(started).toBe(1);
    expect(results.every((result) => result.cards.length === 2)).toBe(true);
  });

  it("caches failures on the shorter error TTL", async () => {
    let now = 0;
    let hits = 0;
    const probe = new CodexQuotaProbe({
      now: () => now,
      errTtlMs: 30_000,
      readUsageSnapshot: async () => {
        hits++;
        throw new Error("still broken");
      },
    });
    await probe.snapshot();
    now += 29_000;
    await probe.snapshot();
    expect(hits).toBe(1);
    now += 2_000;
    await probe.snapshot();
    expect(hits).toBe(2);
  });
});
