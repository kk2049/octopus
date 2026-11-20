import { describe, expect, it } from "vitest";
import type { RichMessage } from "@claude-bot/agent-sessions-contract";
import {
  FRONTIER_LOOKBACK,
  clientFrontier,
  hasOpenTool,
} from "./live-contract.js";

const toolMessage = (output?: string): RichMessage => ({
  role: "assistant",
  blocks: [{ type: "tool", tool: "Bash", output }],
});

describe("Dashboard SSE unstable-frontier contract", () => {
  it("stops at the first open tool inside the shared bounded lookback", () => {
    const messages = [toolMessage("a"), toolMessage(), toolMessage("b")];
    expect(clientFrontier(messages, 100)).toBe(101);
  });

  it("ends at the loaded window when every recent tool is settled", () => {
    const messages = [toolMessage("a"), toolMessage("b")];
    expect(clientFrontier(messages, 100)).toBe(102);
  });

  it("isolates abandoned open tools older than the bounded lookback", () => {
    const messages = [toolMessage(), ...Array.from({ length: FRONTIER_LOOKBACK }, () => toolMessage("x"))];
    expect(clientFrontier(messages, 0)).toBe(messages.length);
  });

  it("treats only an absent output as open", () => {
    expect(hasOpenTool({ blocks: [{ type: "tool", output: undefined }] })).toBe(true);
    expect(hasOpenTool({ blocks: [{ type: "tool", output: null }] })).toBe(false);
  });
});
