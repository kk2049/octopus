import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsage, QuotaProbe } from "./quota.js";

/** Trimmed copy of a real payload observed on the bot host (2026-07-25). */
const REAL_PAYLOAD = {
  five_hour: { utilization: 3.0, resets_at: "2026-07-25T13:10:00.317318+00:00" },
  seven_day: { utilization: 37.0, resets_at: "2026-07-27T19:00:00.317339+00:00" },
  seven_day_opus: null,
  limits: [
    { kind: "session", group: "session", percent: 3, severity: "normal", resets_at: "2026-07-25T13:10:00.317318+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 37, severity: "normal", resets_at: "2026-07-27T19:00:00.317339+00:00", scope: null },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 64,
      severity: "normal",
      resets_at: "2026-07-27T19:00:00.317567+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
  extra_usage: { monthly_limit: 4000, used_credits: 829.0 },
};

describe("parseUsage", () => {
  it("maps the three live windows in display order", () => {
    const cards = parseUsage(REAL_PAYLOAD);
    expect(cards.map((c) => c.key)).toEqual(["session", "weekly_all", "scoped:fable"]);
    expect(cards.map((c) => c.label)).toEqual(["5 小时", "一周", "Fable · 周"]);
    expect(cards.map((c) => c.usedPercent)).toEqual([3, 37, 64]);
    expect(cards.map((c) => c.remainPercent)).toEqual([97, 63, 36]);
    expect(cards[2].resetsAt).toBe("2026-07-27T19:00:00.317567+00:00");
  });

  it("never leaks dollar figures into the cards", () => {
    expect(JSON.stringify(parseUsage(REAL_PAYLOAD))).not.toContain("829");
    expect(JSON.stringify(parseUsage(REAL_PAYLOAD))).not.toContain("4000");
  });

  it("computes severity locally at 80/95, ignoring upstream's own field", () => {
    const sev = (percent: number) =>
      parseUsage({ limits: [{ kind: "session", percent, severity: "normal" }] })[0].severity;
    expect(sev(79)).toBe("normal");
    expect(sev(80)).toBe("warning");
    expect(sev(94)).toBe("warning");
    expect(sev(95)).toBe("critical");
    expect(sev(100)).toBe("critical");
  });

  it("falls back to the flat windows when limits[] is missing", () => {
    const cards = parseUsage({ five_hour: { utilization: 12.4 }, seven_day: { utilization: 88.6 } });
    expect(cards.map((c) => [c.key, c.usedPercent, c.severity])).toEqual([
      ["session", 12, "normal"],
      ["weekly_all", 89, "warning"],
    ]);
    expect(cards[0].resetsAt).toBeUndefined();
  });

  it("prefers limits[] over the flat windows and fills only the gaps", () => {
    const cards = parseUsage({
      five_hour: { utilization: 99 },
      seven_day: { utilization: 42 },
      limits: [{ kind: "session", percent: 7 }],
    });
    expect(cards.map((c) => [c.key, c.usedPercent])).toEqual([
      ["session", 7],
      ["weekly_all", 42],
    ]);
  });

  it("renders any scoped model, not just Fable, and keeps them after the windows", () => {
    const cards = parseUsage({
      limits: [
        { kind: "weekly_scoped", percent: 10, scope: { model: { display_name: "Opus" } } },
        { kind: "weekly_all", percent: 20 },
        { kind: "weekly_scoped", percent: 30, scope: { model: { display_name: "Fable" } } },
      ],
    });
    expect(cards.map((c) => c.key)).toEqual(["weekly_all", "scoped:opus", "scoped:fable"]);
  });

  it("drops entries it cannot recognise instead of surfacing junk", () => {
    const cards = parseUsage({
      limits: [
        null,
        "nonsense",
        { kind: "session" }, // no percent
        { kind: "session", percent: "3" }, // wrong type
        { kind: "weekly_scoped", percent: 50, scope: null }, // unnamed model
        { kind: "brand_new_window", percent: 50 }, // unknown kind
        { kind: "weekly_all", percent: 5, resets_at: "not-a-date" },
      ],
    });
    expect(cards.map((c) => c.key)).toEqual(["weekly_all"]);
    expect(cards[0].resetsAt).toBeUndefined();
  });

  it("clamps out-of-range percentages", () => {
    const cards = parseUsage({ limits: [{ kind: "session", percent: 140 }, { kind: "weekly_all", percent: -5 }] });
    expect(cards.map((c) => [c.usedPercent, c.remainPercent])).toEqual([
      [100, 0],
      [0, 100],
    ]);
  });

  it("returns nothing for payloads with no usable shape", () => {
    for (const junk of [null, undefined, 42, "x", [], {}, { limits: {} }]) {
      expect(parseUsage(junk)).toEqual([]);
    }
  });
});

describe("QuotaProbe", () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-"));
  const credsPath = join(dir, "creds.json");
  writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-secret", subscriptionType: "max" } }));

  const okFetch = (calls: Request[] | { url: string; init?: RequestInit }[]) =>
    (async (url: unknown, init?: RequestInit) => {
      (calls as { url: string; init?: RequestInit }[]).push({ url: String(url), init });
      return new Response(JSON.stringify(REAL_PAYLOAD), { status: 200 });
    }) as unknown as typeof fetch;

  it("sends the OAuth token upstream and returns only percentages", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const probe = new QuotaProbe({ credentialsPath: credsPath, fetchImpl: okFetch(calls) });
    const snap = await probe.snapshot();
    expect(snap.error).toBeUndefined();
    expect(snap.cards).toHaveLength(3);
    expect(snap.fetchedAt).toMatch(/^\d{4}-/);
    expect(calls[0].url).toBe("https://api.anthropic.com/api/oauth/usage");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-ant-oat01-secret");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(JSON.stringify(snap)).not.toContain("sk-ant-oat");
  });

  it("caches successes for the TTL and refetches after it lapses", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let now = 1_000_000;
    const probe = new QuotaProbe({
      credentialsPath: credsPath,
      fetchImpl: okFetch(calls),
      now: () => now,
      okTtlMs: 60_000,
    });
    await probe.snapshot();
    await probe.snapshot();
    now += 59_000;
    await probe.snapshot();
    expect(calls).toHaveLength(1);
    now += 2_000;
    await probe.snapshot();
    expect(calls).toHaveLength(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const probe = new QuotaProbe({
      credentialsPath: credsPath,
      fetchImpl: (async () => {
        started++;
        await gate;
        return new Response(JSON.stringify(REAL_PAYLOAD), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const all = Promise.all([probe.snapshot(), probe.snapshot(), probe.snapshot()]);
    release();
    const results = await all;
    expect(started).toBe(1);
    expect(results.every((r) => r.cards.length === 3)).toBe(true);
  });

  it("reports a missing local login without touching the network", async () => {
    let called = false;
    const probe = new QuotaProbe({
      credentialsPath: join(dir, "nope.json"),
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    const snap = await probe.snapshot();
    expect(snap.error).toBe("no_credentials");
    expect(snap.message).toContain("未登录");
    expect(snap.cards).toEqual([]);
    expect(called).toBe(false);
  });

  it("maps 401 to an expired-credential message and other failures to unavailable", async () => {
    const status = (code: number) =>
      new QuotaProbe({
        credentialsPath: credsPath,
        fetchImpl: (async () => new Response("", { status: code })) as unknown as typeof fetch,
      }).snapshot();
    expect((await status(401)).error).toBe("expired");
    expect((await status(403)).error).toBe("expired");
    const bad = await status(500);
    expect(bad.error).toBe("unavailable");
    expect(bad.message).toContain("500");
  });

  it("degrades rather than throwing when the network or the payload misbehaves", async () => {
    const thrown = await new QuotaProbe({
      credentialsPath: credsPath,
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    }).snapshot();
    expect(thrown.error).toBe("unavailable");

    const garbled = await new QuotaProbe({
      credentialsPath: credsPath,
      fetchImpl: (async () => new Response("<html>nope</html>", { status: 200 })) as unknown as typeof fetch,
    }).snapshot();
    expect(garbled.error).toBe("unavailable");

    const unknownShape = await new QuotaProbe({
      credentialsPath: credsPath,
      fetchImpl: (async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 })) as unknown as typeof fetch,
    }).snapshot();
    expect(unknownShape.error).toBe("unavailable");
    expect(unknownShape.message).toContain("无法识别");
  });

  it("caches failures on a shorter TTL so a fix shows up within a poll cycle", async () => {
    let now = 0;
    let hits = 0;
    const probe = new QuotaProbe({
      credentialsPath: credsPath,
      now: () => now,
      okTtlMs: 60_000,
      errTtlMs: 30_000,
      fetchImpl: (async () => {
        hits++;
        return new Response("", { status: 500 });
      }) as unknown as typeof fetch,
    });
    await probe.snapshot();
    now += 29_000;
    await probe.snapshot();
    expect(hits).toBe(1);
    now += 2_000;
    await probe.snapshot();
    expect(hits).toBe(2);
  });

  it("reuses a recent successful snapshot on transient errors, then lets it expire", async () => {
    let now = 0;
    let hits = 0;
    const probe = new QuotaProbe({
      credentialsPath: credsPath,
      now: () => now,
      okTtlMs: 60,
      errTtlMs: 30,
      staleMaxAgeMs: 300,
      fetchImpl: (async () => {
        hits++;
        if (hits === 1) return new Response(JSON.stringify(REAL_PAYLOAD), { status: 200 });
        return new Response("", { status: 500 });
      }) as unknown as typeof fetch,
    });

    const fresh = await probe.snapshot();
    now = 61;
    const fallback = await probe.snapshot();
    expect(fallback).toMatchObject({ fetchedAt: fresh.fetchedAt, stale: true });
    expect(fallback.error).toBeUndefined();
    expect(fallback.cards).toHaveLength(3);
    expect(fallback.cards.every((card) => card.stale === true)).toBe(true);

    // A cached fallback must still respect the age of the underlying success,
    // even when its shorter error retry TTL has not elapsed yet.
    now = 301;
    const expired = await probe.snapshot();
    expect(expired.error).toBe("unavailable");
    expect(expired.cards).toEqual([]);
    expect(expired.stale).toBeUndefined();
    expect(hits).toBe(3);
  });

  it("does not mask an explicit credential failure with old quota", async () => {
    let now = 0;
    let status = 200;
    const probe = new QuotaProbe({
      credentialsPath: credsPath,
      now: () => now,
      okTtlMs: 10,
      fetchImpl: (async () => new Response(JSON.stringify(REAL_PAYLOAD), { status })) as unknown as typeof fetch,
    });
    await probe.snapshot();
    now = 11;
    status = 401;
    const expired = await probe.snapshot();
    expect(expired.error).toBe("expired");
    expect(expired.cards).toEqual([]);
  });

  it("cleans up", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
