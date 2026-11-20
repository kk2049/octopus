import { describe, expect, it } from "vitest";
import { ResearchSourceSummarizer, discussionSegmentsText } from "./source-summary.js";
import type { ResourceBinding } from "@claude-bot/research-canvas-contract";
const binding = { owner: "alice" } as ResourceBinding;
describe("discussion source summaries", () => {
  it("produces editable source-linked minutes when no model is configured without inventing tasks", async () => {
    const result = await new ResearchSourceSummarizer({ baseUrl: "", apiKey: "", models: [], defaultModel: "", filterModel: "" }).summarize(binding, {
      source: "workgroup:record", title: "细节讨论", segments: [{ id: "message-1", text: "这个参数还需要确认。", speaker: "甲" }],
    }, new AbortController().signal);
    expect(result.minutes).toContain("[message-1]"); expect(result.minutes).toContain("这个参数还需要确认");
    expect(result.candidates).toEqual([]); expect(result.warning).toContain("未配置");
  });
  it("keeps source IDs, speaker labels and timestamps in the model input", () => {
    expect(discussionSegmentsText([{ id: "D000001", text: "暂不发布", speaker: "B", start: 60, end: 62 }])).toBe("[D000001] 60.00–62.00s B：暂不发布");
  });
});
