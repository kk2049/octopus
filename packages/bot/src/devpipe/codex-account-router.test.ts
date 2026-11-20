import { describe, expect, it, vi } from "vitest";
import {
  CodexAccountRouter,
  parseCodexRoutingWindow,
  selectCodexRateLimitBucket,
} from "./codex-account-router.js";

const NOW = 2_000_000_000_000;
const seconds = (offsetMs: number): number => (NOW + offsetMs) / 1000;
const accountSnapshot = (usedPercent: number, resetInMs: number, duration = 10_080): unknown => ({
  rateLimitsByLimitId: {
    codex: {
      primary: { usedPercent, windowDurationMins: duration, resetsAt: seconds(resetInMs) },
    },
  },
});

describe("CodexAccountRouter", () => {
  it("prefers the exact codex bucket and the longest window", () => {
    const raw = {
      rateLimits: { primary: { usedPercent: 1, windowDurationMins: 10_080, resetsAt: seconds(10_000) } },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: seconds(5_000) },
          secondary: { usedPercent: 65, windowDurationMins: 10_080, resetsAt: seconds(20_000) },
        },
      },
    };
    expect(selectCodexRateLimitBucket(raw)).toBe(raw.rateLimitsByLimitId.codex);
    expect(parseCodexRoutingWindow(raw, NOW)).toEqual({
      remainingPercent: 35,
      resetsAt: NOW + 20_000,
      windowDurationMins: 10_080,
    });
  });

  it("selects the eligible account whose long window resets first", async () => {
    const readRateLimits = vi.fn(async (slot: string) =>
      slot === "earlier" ? accountSnapshot(65, 3_000) : accountSnapshot(33, 5_000));
    const router = new CodexAccountRouter({
      accounts: { earlier: "/srv/codex/earlier", later: "/srv/codex/later" },
      now: () => NOW,
      readRateLimits,
    });
    await expect(router.selectForNewSession()).resolves.toMatchObject({
      slot: "earlier",
      label: "a",
      codexHome: "/srv/codex/earlier",
      remainingPercent: 35,
    });
    expect(router.labelForSlot("later")).toBe("b");
    expect(router.roots()).toEqual([
      { slot: "earlier", label: "a", codexHome: "/srv/codex/earlier" },
      { slot: "later", label: "b", codexHome: "/srv/codex/later" },
    ]);
  });

  it("routes an explicit fallback away from the session's owning account", async () => {
    const router = new CodexAccountRouter({
      accounts: {
        current: "/srv/codex/current",
        reserve: "/srv/codex/reserve",
        exhausted: "/srv/codex/exhausted",
      },
      now: () => NOW,
      readRateLimits: async (slot) =>
        slot === "reserve" ? accountSnapshot(30, 5_000) : accountSnapshot(99, 1_000),
    });
    await expect(router.selectForFallback("/srv/codex/current")).resolves.toMatchObject({
      slot: "reserve",
      label: "b",
      codexHome: "/srv/codex/reserve",
    });
    await expect(router.selectForFallback("/srv/codex/not-configured"))
      .rejects.toThrow("不属于 Runner 配置的账号池");
  });

  it("skips an earlier reset below the configured reserve", async () => {
    const router = new CodexAccountRouter({
      accounts: { low: "/srv/codex/low", healthy: "/srv/codex/healthy" },
      now: () => NOW,
      readRateLimits: async (slot) =>
        slot === "low" ? accountSnapshot(96, 1_000) : accountSnapshot(33, 5_000),
    });
    await expect(router.selectForNewSession()).resolves.toMatchObject({ slot: "healthy" });
  });

  it("fails closed when every probe is unknown or below reserve", async () => {
    const router = new CodexAccountRouter({
      accounts: { broken: "/srv/codex/broken", low: "/srv/codex/low" },
      now: () => NOW,
      readRateLimits: async (slot) => {
        if (slot === "broken") throw new Error("contains private account detail");
        return accountSnapshot(99, 1_000);
      },
    });
    await expect(router.selectForNewSession()).rejects.toThrow("至少 5%");
  });

  it("rejects ambiguous or unsafe account configuration", () => {
    expect(() => new CodexAccountRouter({ accounts: { "bad slot": "/srv/a" } })).toThrow("槽名");
    expect(() => new CodexAccountRouter({ accounts: { a: "relative" } })).toThrow("绝对路径");
    expect(() => new CodexAccountRouter({ accounts: { a: "/srv/a", b: "/srv/a/../a" } })).toThrow("互不相同");
  });
});
