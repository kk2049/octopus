import { describe, expect, it } from "vitest";
import { createSessionRichParser, createSessionSummaryParser, parseSessionRich, parseSessionText } from "./parse.js";

const context = (model?: unknown, effort?: unknown) => ({ type: "turn_context", payload: { model, effort, cwd: "/workspace" } });

describe("Codex native turn settings", () => {
  it.each(["rich", "summary"])("replaces the whole snapshot on %s incremental reads", (mode) => {
    const parser = mode === "rich" ? createSessionRichParser("codex") : createSessionSummaryParser("codex");
    const settings = () => {
      const snapshot = parser.snapshot();
      return ("meta" in snapshot ? snapshot.meta : snapshot).turn_configuration;
    };
    expect(settings()).toBeUndefined();
    parser.append([context("gpt-6-luna", "high")]);
    expect(settings()).toEqual({ model: "gpt-6-luna", effort: "high" });
    const previous = settings();
    parser.append([{ type: "event_msg", payload: { type: "agent_message", message: "done", model: "fake", effort: "low" } }]);
    expect(settings()).toEqual(previous);
    parser.append([context("gpt-6-astra", "xhigh")]);
    expect(settings()).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
    expect(previous).toEqual({ model: "gpt-6-luna", effort: "high" });
    parser.append([context("custom-model", null)]);
    expect(settings()).toEqual({ model: "custom-model" });
    parser.append([context()]);
    expect(settings()).toBeNull();
  });

  it("agrees for full flat/rich reads, tolerates malformed lines and supports unwrapped contexts", () => {
    const text = [JSON.stringify(context("gpt-6-luna", "high")), "{broken",
      JSON.stringify({ type: "turn_context", model: "gpt-6-astra", effort: "ultra" })].join("\n");
    for (const parse of [parseSessionText, parseSessionRich]) {
      expect(parse("codex", text).meta).toMatchObject({
        cwd: "/workspace", turn_configuration: { model: "gpt-6-astra", effort: "ultra" },
      });
      expect(parse("claude", text).meta).not.toHaveProperty("turn_configuration");
      expect(parse("omp", text).meta).not.toHaveProperty("turn_configuration");
    }
  });
});
