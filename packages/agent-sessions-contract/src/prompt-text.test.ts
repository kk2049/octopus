import { describe, expect, it } from "vitest";
import { promptMatchKey, unwrapPastedContent } from "./prompt-text.js";

// Claude Code 2.1.322 recorded this for a four-line tmux paste (2026-11-12).
const RECORDED = "\n\n<pasted_content id=\"c5ef\">\n多行测试 DELTA-4：第一行  \n    第二行以Tab开头\n```\ncode block\n```\n最后一行，请只回复 DELTA-4\n</pasted_content id=\"c5ef\">\n";
const SENT = "多行测试 DELTA-4：第一行  \n\t第二行以Tab开头\n```\ncode block\n```\n最后一行，请只回复 DELTA-4";

describe("prompt text after a provider round trip", () => {
  it("shows a paste as it was pasted", () => {
    expect(unwrapPastedContent(RECORDED).trim()).toBe("多行测试 DELTA-4：第一行  \n    第二行以Tab开头\n```\ncode block\n```\n最后一行，请只回复 DELTA-4");
    expect(unwrapPastedContent("看：\n<pasted_content id=\"1\">\na\n</pasted_content id=\"1\"> 和 <pasted_content id=\"2\">b</pasted_content id=\"2\">"))
      .toBe("看：\na 和 b");
    expect(unwrapPastedContent("no wrapper <b>kept</b>")).toBe("no wrapper <b>kept</b>");
  });

  it("matches the sent prompt despite the wrapper and whitespace changes", () => {
    expect(promptMatchKey(RECORDED)).toBe(promptMatchKey(SENT));
    expect(promptMatchKey("a\r\nb")).toBe(promptMatchKey("a b"));
    expect(promptMatchKey("请只回复 ETA-7")).not.toBe(promptMatchKey("本地草稿未发送请只回复 ETA-7"));
  });
});
