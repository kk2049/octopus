/**
 * `fetchLlm` is the one place all direct LLM HTTP calls converge on for retry
 * and timeout. These tests pin down the failure taxonomy that the rest of the
 * bot relies on: 429/5xx retry with backoff, 4xx die immediately, Retry-After
 * beats jitter, upstream aborts skip pending retries, timeouts don't consume
 * the whole budget.
 */
import { describe, it, expect } from "vitest";
import { fetchLlm, parseRetryAfter, type FetchLlmError, type RetryInfo } from "./llm-fetch.js";

/** Build a Response-shaped object without pulling in undici / node-fetch. */
function fakeResponse(init: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: init.ok ?? (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: init.statusText ?? "",
    text: async () => init.body ?? "",
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null } as unknown as Headers,
  } as unknown as Response;
}

/** A scripted fetch: each call pops one step; step is either a Response or an Error to throw. */
function scriptedFetch(
  steps: Array<Response | Error | Promise<Response>>,
): { impl: typeof globalThis.fetch; seen: RequestInit[]; count: () => number } {
  const seen: RequestInit[] = [];
  let calls = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    calls++;
    seen.push(init);
    const step = steps.shift();
    if (step === undefined) throw new Error("scriptedFetch: ran out of steps");
    if (step instanceof Error) throw step;
    return await step;
  }) as unknown as typeof globalThis.fetch;
  return { impl, seen, count: () => calls };
}

/** A sleep stub that records every requested delay and resolves immediately. */
function recordedSleep(): { impl: (ms: number, signal?: AbortSignal) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const impl = async (ms: number, signal?: AbortSignal) => {
    delays.push(ms);
    if (signal?.aborted) throw new Error("aborted");
  };
  return { impl, delays };
}

describe("parseRetryAfter", () => {
  it("parses a seconds header", () => {
    expect(parseRetryAfter("5", 0)).toBe(5000);
    expect(parseRetryAfter("0", 0)).toBe(0);
  });
  it("parses an HTTP-date header as delay from now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
  });
  it("clamps past dates to 0", () => {
    const now = Date.parse("2026-01-01T00:00:10Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });
  it("returns null for missing / unparseable input", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("", 0)).toBeNull();
    expect(parseRetryAfter("not-a-date-nor-number", 0)).toBeNull();
  });
});

describe("fetchLlm — happy path", () => {
  it("returns the response on the first try when the server is OK", async () => {
    const { impl, count } = scriptedFetch([fakeResponse({ status: 200 })]);
    const res = await fetchLlm("https://x/y", { method: "POST" }, { fetchImpl: impl });
    expect(res.status).toBe(200);
    expect(count()).toBe(1);
  });

  it("forwards method/headers/body to the underlying fetch", async () => {
    const { impl, seen } = scriptedFetch([fakeResponse({ status: 200 })]);
    await fetchLlm(
      "https://x/y",
      { method: "POST", headers: { "x-foo": "bar" }, body: "hello" },
      { fetchImpl: impl },
    );
    expect(seen[0].method).toBe("POST");
    expect((seen[0].headers as Record<string, string>)["x-foo"]).toBe("bar");
    expect(seen[0].body).toBe("hello");
  });
});

describe("fetchLlm — retry taxonomy", () => {
  it("retries a 429 and returns the recovered response", async () => {
    const { impl, count } = scriptedFetch([
      fakeResponse({ status: 429, body: '{"error":"slow down"}' }),
      fakeResponse({ status: 200, body: "ok" }),
    ]);
    const sleep = recordedSleep();
    const retries: RetryInfo[] = [];
    const res = await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: sleep.impl,
        random: () => 0.5,
        retry: { initialDelayMs: 100, maxAttempts: 5, jitter: 0 },
        onRetry: (info) => retries.push(info),
      },
    );
    expect(res.status).toBe(200);
    expect(count()).toBe(2);
    expect(sleep.delays).toEqual([100]); // 100 * 2^0 with no jitter
    expect(retries).toHaveLength(1);
    expect(retries[0].reason).toBe("http");
    expect(retries[0].status).toBe(429);
  });

  it("retries 5xx as well as 429", async () => {
    const { impl } = scriptedFetch([
      fakeResponse({ status: 500, body: "boom" }),
      fakeResponse({ status: 502 }),
      fakeResponse({ status: 200 }),
    ]);
    const res = await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: async () => {},
        random: () => 0.5,
        retry: { initialDelayMs: 10, maxAttempts: 5, jitter: 0 },
      },
    );
    expect(res.status).toBe(200);
  });

  it("does NOT retry a 400/401/403/404", async () => {
    for (const status of [400, 401, 403, 404]) {
      const { impl, count } = scriptedFetch([fakeResponse({ status, body: "nope" })]);
      const sleep = recordedSleep();
      await expect(
        fetchLlm(
          "https://x/y",
          { method: "POST" },
          { fetchImpl: impl, sleep: sleep.impl, retry: { maxAttempts: 5, initialDelayMs: 10 } },
        ),
      ).rejects.toMatchObject({ status });
      expect(count()).toBe(1);
      expect(sleep.delays).toEqual([]);
    }
  });

  it("throws with rich error props after exhausting attempts", async () => {
    const { impl } = scriptedFetch([
      fakeResponse({ status: 429, body: "1" }),
      fakeResponse({ status: 429, body: "2" }),
      fakeResponse({ status: 429, body: "3" }),
    ]);
    try {
      await fetchLlm(
        "https://x/y",
        { method: "POST" },
        {
          fetchImpl: impl,
          sleep: async () => {},
          random: () => 0.5,
          retry: { maxAttempts: 3, initialDelayMs: 10, jitter: 0 },
          label: "test",
        },
      );
      throw new Error("expected throw");
    } catch (e) {
      const err = e as FetchLlmError;
      expect(err.status).toBe(429);
      expect(err.body).toBe("3");
      expect(err.attempts).toBe(3);
      expect(err.reason).toBe("http");
      expect(err.message).toContain("after 3 attempts");
      expect(err.message).toContain("test failed");
    }
  });

  it("retries a network error (fetch throws)", async () => {
    const { impl } = scriptedFetch([
      new TypeError("fetch failed"),
      fakeResponse({ status: 200 }),
    ]);
    const res = await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: async () => {},
        random: () => 0.5,
        retry: { maxAttempts: 3, initialDelayMs: 10, jitter: 0 },
      },
    );
    expect(res.status).toBe(200);
  });

  it("retries a per-attempt timeout without eating the whole budget", async () => {
    // First attempt: hang past the tiny 20ms timeout. Second: succeed instantly.
    const impl = (async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      if (!(impl as { firstDone?: boolean }).firstDone) {
        (impl as { firstDone?: boolean }).firstDone = true;
        return await new Promise<Response>((_res, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
        });
      }
      return fakeResponse({ status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const sleep = recordedSleep();
    const retries: RetryInfo[] = [];
    const res = await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: sleep.impl,
        random: () => 0.5,
        timeoutMs: 20,
        retry: { maxAttempts: 3, initialDelayMs: 5, jitter: 0 },
        onRetry: (info) => retries.push(info),
      },
    );
    expect(res.status).toBe(200);
    expect(retries[0].reason).toBe("timeout");
  });
});

describe("fetchLlm — backoff shape", () => {
  it("doubles delay per attempt (exponential, no jitter)", async () => {
    const { impl } = scriptedFetch([
      fakeResponse({ status: 500 }),
      fakeResponse({ status: 500 }),
      fakeResponse({ status: 500 }),
      fakeResponse({ status: 200 }),
    ]);
    const sleep = recordedSleep();
    await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: sleep.impl,
        random: () => 0.5, // with jitter=0 the random value is unused; keep deterministic
        retry: { maxAttempts: 4, initialDelayMs: 100, jitter: 0 },
      },
    );
    expect(sleep.delays).toEqual([100, 200, 400]);
  });

  it("caps delay at maxDelayMs", async () => {
    const { impl } = scriptedFetch([
      fakeResponse({ status: 500 }),
      fakeResponse({ status: 500 }),
      fakeResponse({ status: 500 }),
      fakeResponse({ status: 200 }),
    ]);
    const sleep = recordedSleep();
    await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: sleep.impl,
        random: () => 0.5,
        retry: { maxAttempts: 4, initialDelayMs: 1000, maxDelayMs: 1500, jitter: 0 },
      },
    );
    // 1000, min(1500, 2000)=1500, min(1500, 4000)=1500
    expect(sleep.delays).toEqual([1000, 1500, 1500]);
  });

  it("applies symmetric jitter around the exponential base", async () => {
    // With jitter=0.5 and random=0, factor = 1 - 0.5 + 0*1 = 0.5 → half of base.
    const { impl } = scriptedFetch([
      fakeResponse({ status: 500 }),
      fakeResponse({ status: 200 }),
    ]);
    const sleep = recordedSleep();
    await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: sleep.impl,
        random: () => 0,
        retry: { maxAttempts: 3, initialDelayMs: 400, jitter: 0.5 },
      },
    );
    expect(sleep.delays).toEqual([200]);
  });

  it("honors Retry-After (seconds) over exponential", async () => {
    const { impl } = scriptedFetch([
      fakeResponse({ status: 429, headers: { "retry-after": "3" } }),
      fakeResponse({ status: 200 }),
    ]);
    const sleep = recordedSleep();
    await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: sleep.impl,
        random: () => 0.5,
        retry: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 30_000, jitter: 0 },
      },
    );
    expect(sleep.delays).toEqual([3000]);
  });

  it("caps Retry-After at maxDelayMs so a malicious server can't stall us", async () => {
    const { impl } = scriptedFetch([
      fakeResponse({ status: 429, headers: { "retry-after": "600" } }),
      fakeResponse({ status: 200 }),
    ]);
    const sleep = recordedSleep();
    await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: sleep.impl,
        random: () => 0.5,
        retry: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 5000, jitter: 0 },
      },
    );
    expect(sleep.delays).toEqual([5000]);
  });
});

describe("fetchLlm — abort semantics", () => {
  it("aborts immediately when the upstream signal is already fired", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { impl, count } = scriptedFetch([fakeResponse({ status: 200 })]);
    await expect(
      fetchLlm(
        "https://x/y",
        { method: "POST" },
        { fetchImpl: impl, signal: ctl.signal, retry: { maxAttempts: 5 } },
      ),
    ).rejects.toThrow(/aborted/);
    expect(count()).toBe(0);
  });

  it("aborts mid-backoff when the upstream signal fires during sleep", async () => {
    const ctl = new AbortController();
    const { impl } = scriptedFetch([
      fakeResponse({ status: 429 }),
      fakeResponse({ status: 200 }),
    ]);
    const sleep = async (_ms: number, signal?: AbortSignal) => {
      // Simulate the upstream aborting while we're sleeping.
      ctl.abort();
      if (signal?.aborted) throw new Error("aborted");
    };
    await expect(
      fetchLlm(
        "https://x/y",
        { method: "POST" },
        {
          fetchImpl: impl,
          sleep,
          signal: ctl.signal,
          retry: { maxAttempts: 5, initialDelayMs: 10, jitter: 0 },
        },
      ),
    ).rejects.toThrow(/aborted/);
  });
});

describe("fetchLlm — retry:false disables retries", () => {
  it("makes exactly one attempt and throws on the first failure", async () => {
    const { impl, count } = scriptedFetch([fakeResponse({ status: 429, body: "no" })]);
    const sleep = recordedSleep();
    await expect(
      fetchLlm(
        "https://x/y",
        { method: "POST" },
        { fetchImpl: impl, sleep: sleep.impl, retry: false },
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(count()).toBe(1);
    expect(sleep.delays).toEqual([]);
  });
});

describe("fetchLlm — onRetry callback", () => {
  it("is invoked with attempt/nextAttempt/delayMs/reason/status", async () => {
    const { impl } = scriptedFetch([
      fakeResponse({ status: 429, body: "1", headers: { "retry-after": "1" } }),
      fakeResponse({ status: 500, body: "2" }),
      fakeResponse({ status: 200 }),
    ]);
    const infos: RetryInfo[] = [];
    await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: async () => {},
        random: () => 0.5,
        retry: { maxAttempts: 5, initialDelayMs: 100, jitter: 0 },
        onRetry: (info) => infos.push(info),
      },
    );
    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({ attempt: 1, nextAttempt: 2, delayMs: 1000, reason: "http", status: 429 });
    expect(infos[1]).toMatchObject({ attempt: 2, nextAttempt: 3, reason: "http", status: 500 });
  });

  it("swallows exceptions thrown from onRetry so a bad callback can't kill retry", async () => {
    const { impl } = scriptedFetch([
      fakeResponse({ status: 500 }),
      fakeResponse({ status: 200 }),
    ]);
    const res = await fetchLlm(
      "https://x/y",
      { method: "POST" },
      {
        fetchImpl: impl,
        sleep: async () => {},
        random: () => 0.5,
        retry: { maxAttempts: 3, initialDelayMs: 10, jitter: 0 },
        onRetry: () => { throw new Error("callback boom"); },
      },
    );
    expect(res.status).toBe(200);
  });
});
