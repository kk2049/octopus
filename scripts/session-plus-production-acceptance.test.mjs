import { describe, expect, it } from "vitest";
import {
  loginExchangeOptions,
  parseArgs,
  summarize,
  trustExchangeOptions,
} from "./session-plus-production-acceptance.mjs";

describe("Sessions+ production acceptance harness", () => {
  it("defaults to the production cold-open acceptance shape", () => {
    expect(parseArgs([
      "--origin",
      "https://bot.example.com",
      "--token-file",
      "/private/token",
    ])).toEqual({
      help: false,
      origin: "https://bot.example.com",
      tokenFile: "/private/token",
      storageState: undefined,
      expectedFrameHost: null,
      trustCurrentRelease: false,
      pages: 18,
      timeoutMs: 55_000,
    });
  });

  it("requires one private authentication source and an HTTPS origin", () => {
    expect(() => parseArgs(["--origin", "https://bot.example.com"])).toThrow(/exactly one/);
    expect(() => parseArgs([
      "--origin", "https://bot.example.com",
      "--token-file", "/private/token",
      "--storage-state", "/private/state",
    ])).toThrow(/exactly one/);
    expect(() => parseArgs([
      "--origin", "http://bot.example.com",
      "--token-file", "/private/token",
    ])).toThrow(/HTTPS origin/);
  });

  it("binds the login exchange to the validated dashboard origin", () => {
    expect(loginExchangeOptions("https://bot.example.com", "dt_fixture")).toEqual({
      data: { token: "dt_fixture", next: "/" },
      headers: { origin: "https://bot.example.com" },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
  });

  it("requires explicit opt-in and binds trust to origin plus CSRF", () => {
    const parsed = parseArgs([
      "--origin", "https://bot.example.com",
      "--token-file", "/private/token",
      "--trust-current-release",
    ]);
    expect(parsed.trustCurrentRelease).toBe(true);
    expect(trustExchangeOptions("https://bot.example.com", "csrf_fixture")).toEqual({
      data: { decision: "trust", follow_updates: true },
      headers: {
        origin: "https://bot.example.com",
        "x-csrf-token": "csrf_fixture",
      },
      failOnStatusCode: false,
    });
  });

  it("fails the batch if one page misses readiness or frame hosts diverge", () => {
    const ready = {
      outcome: "ready",
      within_55s: true,
      frame_hostname: "app-0123456789abcdef0123.apps.example.com",
    };
    expect(summarize([ready, { ...ready }])).toMatchObject({
      passed: true,
      ready_within_55s: 2,
      distinct_frame_hostnames: ["app-0123456789abcdef0123.apps.example.com"],
    });
    expect(summarize([
      ready,
      { outcome: "timeout", within_55s: false, frame_hostname: ready.frame_hostname },
    ]).passed).toBe(false);
    expect(summarize([
      ready,
      {
        outcome: "ready",
        within_55s: true,
        frame_hostname: "app-abcdef01234567890123.apps.example.com",
      },
    ]).passed).toBe(false);
  });
});
