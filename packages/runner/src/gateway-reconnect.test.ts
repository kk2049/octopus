import { describe, expect, it } from "vitest";
import {
  planRunnerReconnect,
  validateRunnerGatewayUrl,
  RUNNER_GATEWAY_HANDSHAKE_TIMEOUT_MS,
  RUNNER_RECONNECT_MAX_MS,
  RUNNER_RECONNECT_MIN_MS,
} from "./gateway-reconnect.js";

describe("Runner gateway reconnect policy", () => {
  it("bounds a failed handshake plus retry wait to twenty seconds", () => {
    let backoff = RUNNER_RECONNECT_MIN_MS;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const plan = planRunnerReconnect(backoff, () => 1);
      expect(plan.delayMs).toBeLessThanOrEqual(RUNNER_RECONNECT_MAX_MS);
      expect(RUNNER_GATEWAY_HANDSHAKE_TIMEOUT_MS + plan.delayMs).toBeLessThanOrEqual(20_000);
      backoff = plan.nextBackoffMs;
    }
    expect(backoff).toBe(RUNNER_RECONNECT_MAX_MS);
  });

  it("adds equal jitter without permitting a busy loop", () => {
    expect(planRunnerReconnect(10_000, () => 0)).toEqual({
      delayMs: 5_000,
      nextBackoffMs: 10_000,
    });
    expect(planRunnerReconnect(10_000, () => 1)).toEqual({
      delayMs: 10_000,
      nextBackoffMs: 10_000,
    });
    expect(planRunnerReconnect(Number.NaN, () => Number.NaN)).toEqual({
      delayMs: 500,
      nextBackoffMs: 1_700,
    });
  });

  it("requires WSS except for explicit loopback websocket endpoints", () => {
    expect(validateRunnerGatewayUrl("wss://bot.example/runner")).toBe("wss://bot.example/runner");
    for (const endpoint of ["ws://127.0.0.1:9910", "ws://localhost:9910", "ws://[::1]:9910"]) {
      expect(validateRunnerGatewayUrl(endpoint)).toBe(endpoint);
    }
    for (const endpoint of ["ws://bot.example:9910", "ws://10.0.0.2:9910", "http://bot.example", "wss://user:secret@bot.example"]) {
      expect(() => validateRunnerGatewayUrl(endpoint)).toThrow(/WSS/);
    }
  });
});
