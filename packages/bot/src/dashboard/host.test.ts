import { describe, it, expect, beforeEach } from "vitest";
import { detectPublicHost, resetPublicHostCacheForTest } from "./host.js";

function fakeFetch(routes: Record<string, string | number>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    for (const [needle, out] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (typeof out === "number") return new Response("err", { status: out });
        return new Response(out, { status: 200 });
      }
    }
    throw new Error(`unreachable: ${url}`);
  }) as typeof fetch;
}

describe("detectPublicHost", () => {
  beforeEach(() => resetPublicHostCacheForTest());

  it("prefers EC2 metadata when IMDS answers", async () => {
    const host = await detectPublicHost(
      fakeFetch({ "api/token": "imds-tok", "public-ipv4": "203.0.113.8", "checkip": "9.9.9.9" }),
    );
    expect(host).toBe("203.0.113.8");
  });

  it("falls back to the IP echo when IMDS is unreachable", async () => {
    const host = await detectPublicHost(fakeFetch({ "checkip": "203.0.113.7\n" }));
    expect(host).toBe("203.0.113.7");
  });

  it("returns null when nothing answers, and rejects non-IP garbage", async () => {
    expect(await detectPublicHost(fakeFetch({}))).toBeNull();
    resetPublicHostCacheForTest();
    expect(await detectPublicHost(fakeFetch({ "checkip": "<html>captive portal</html>" }))).toBeNull();
  });

  it("caches the first result across calls", async () => {
    let calls = 0;
    const counting = (async (input: string | URL | Request) => {
      calls++;
      if (String(input).includes("checkip")) return new Response("198.51.100.2");
      throw new Error("imds down");
    }) as typeof fetch;
    await detectPublicHost(counting);
    const again = await detectPublicHost(counting);
    expect(again).toBe("198.51.100.2");
    expect(calls).toBe(2); // one failed IMDS + one echo; second call served from cache
  });
});
