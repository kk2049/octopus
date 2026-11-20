import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeInputReceipt, claudeInputPhase, claudeToolCallEnded, normalizeClaudeInput } from "./claude-input-receipt.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function transcript(...rows: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "claude-input-receipt-"));
  roots.push(root);
  const file = join(root, "session.jsonl");
  writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return file;
}
const append = (file: string, ...rows: unknown[]) => appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
const human = { kind: "human" };
const prompt = "第一行：请改一下《A0》\n第二行\twith a tab";

describe("ClaudeInputReceipt", () => {
  it("takes an idle submission from the human user record Claude appends after the write", async () => {
    const file = transcript({ type: "user", origin: human, message: { role: "user", content: prompt } });
    const receipt = (await ClaudeInputReceipt.open(file, prompt))!;
    // The same words BEFORE the write are someone else's earlier message.
    await expect(receipt.check()).resolves.toBeNull();
    append(file, { type: "assistant", message: { content: [{ type: "text", text: prompt }] } },
      // Claude turns a pasted tab into spaces; the receipt must not depend on it.
      { type: "user", origin: human, message: { role: "user", content: "第一行：请改一下《A0》\n第二行    with a tab" } });
    await expect(receipt.check()).resolves.toBe("input_observed");
  });

  it("reports a busy session's queue first and its delivery to the turn later", async () => {
    const file = transcript();
    const receipt = (await ClaudeInputReceipt.open(file, prompt))!;
    const wrapped = `<pasted_content id="434d">\n${prompt}\n</pasted_content id="434d">`;
    append(file, { type: "queue-operation", operation: "enqueue", content: wrapped });
    await expect(receipt.check()).resolves.toBe("local_queued");
    append(file, { type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", content: wrapped },
      { type: "attachment", attachment: { type: "queued_command", prompt: wrapped, origin: human, commandMode: "prompt" } });
    await expect(receipt.check()).resolves.toBe("input_observed");
  });

  it("ignores other people's words: tool results, meta rows, notifications and other prompts", async () => {
    const file = transcript();
    const receipt = (await ClaudeInputReceipt.open(file, prompt))!;
    append(file,
      { type: "user", origin: human, message: { content: [{ type: "tool_result", content: prompt }] } },
      { type: "user", isMeta: true, origin: human, message: { content: prompt } },
      { type: "user", origin: { kind: "peer", from: "uds:x" }, message: { content: prompt } },
      { type: "attachment", attachment: { type: "queued_command", prompt, origin: { kind: "task-notification" } } },
      { type: "user", origin: human, message: { content: `${prompt} 再加一句` } });
    await expect(receipt.check()).resolves.toBeNull();
  });

  it("waits for a line cut in the middle of a character instead of misreading it", async () => {
    const file = transcript();
    const receipt = (await ClaudeInputReceipt.open(file, prompt))!;
    const line = Buffer.from(`${JSON.stringify({ type: "user", origin: human, message: { content: prompt } })}\n`);
    const cut = line.indexOf(Buffer.from("《")) + 1;
    appendFileSync(file, line.subarray(0, cut));
    await expect(receipt.check()).resolves.toBeNull();
    appendFileSync(file, line.subarray(cut));
    await expect(receipt.check()).resolves.toBe("input_observed");
  });

  it("has nothing to read without a transcript or a prompt", async () => {
    await expect(ClaudeInputReceipt.open(join(tmpdir(), "no-such-claude-session.jsonl"), prompt)).resolves.toBeNull();
    await expect(ClaudeInputReceipt.open(transcript(), "  \n ")).resolves.toBeNull();
  });
});

describe("claudeInputPhase", () => {
  it("accepts transcripts that predate origin stamps", () => {
    const expected = normalizeClaudeInput(prompt);
    expect(claudeInputPhase({ type: "user", message: { content: [{ type: "text", text: prompt }] } }, expected)).toBe("input_observed");
    expect(claudeInputPhase({ type: "queue-operation", operation: "dequeue", content: prompt }, expected)).toBeNull();
  });
});

describe("claudeToolCallEnded", () => {
  const result = (id: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true }] } });

  it("sees only the call's own tool_result appended after the question", async () => {
    const file = transcript({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion" }] } });
    const offset = (await import("node:fs")).statSync(file).size;
    await expect(claudeToolCallEnded(file, offset, "toolu_q")).resolves.toBe(false);
    // A progress record naming the call, and another call's result, are not its end.
    append(file, { type: "progress", toolUseID: "toolu_q", data: { type: "hook_progress" } }, result("toolu_other"));
    await expect(claudeToolCallEnded(file, offset, "toolu_q")).resolves.toBe(false);
    append(file, result("toolu_q"));
    await expect(claudeToolCallEnded(file, offset, "toolu_q")).resolves.toBe(true);
  });

  it("cannot prove a call open in a transcript that shrank or vanished", async () => {
    const file = transcript({ type: "assistant" });
    await expect(claudeToolCallEnded(file, 10_000, "toolu_q")).resolves.toBe(true);
    await expect(claudeToolCallEnded(`${file}.missing`, 0, "toolu_q")).resolves.toBe(true);
  });
});
