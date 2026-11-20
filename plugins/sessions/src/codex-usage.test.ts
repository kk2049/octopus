import { describe, expect, it } from "vitest";
import { parseSessionText, parseSessionRich } from "./parse.js";

describe("native Codex usage", () => {
  it("takes the last cumulative counter without double counting cache, reasoning, or repeated snapshots", () => {
    const line = (input: number, output: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 90, output_tokens: output, reasoning_output_tokens: 4 } }, rate_limits: { primary: { used_percent: 37, window_minutes: 10080 } } } });
    const text = [line(100, 5), line(200, 10), line(200, 10), "{broken"].join("\n");
    for (const parse of [parseSessionText, parseSessionRich]) expect(parse("codex", text).meta.usage).toEqual({ inputTokens: 200, cachedInputTokens: 90, outputTokens: 10, totalTokens: 210, weeklyUsagePercent: null, weeklyUsageStatus: "unattributable" });
  });
  it("does not fabricate zero usage or accept malformed counters", () => {
    expect(parseSessionText("codex", "").meta.usage).toBeUndefined();
    const text = JSON.stringify({ payload: { type: "token_count", info: { total_token_usage: { input_tokens: -1, cached_input_tokens: 99, output_tokens: 1 } } } });
    expect(parseSessionRich("codex", text).meta.usage).toBeUndefined();
  });
});
