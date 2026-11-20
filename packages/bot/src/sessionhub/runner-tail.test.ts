import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, type RichMessage } from "@claude-bot/plugin-sessions/scan";
import { openRunnerTail } from "./runner-tail.js";

describe("openRunnerTail", () => {
  it("keeps refreshing a real long reply when only text beyond 20,000 characters changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "long-reply-tail-"));
    const directory = join(home, ".claude", "projects", "test");
    const id = "long-reply";
    const tail = openRunnerTail((_method, args) => readSession(home, args), "claude", id, undefined, 1);
    try {
      await mkdir(directory, { recursive: true });
      const prefix = "正文内容\n".repeat(5_000);
      const writeReply = async (suffix: string): Promise<void> => {
        await writeFile(join(directory, `${id}.jsonl`), [
          { type: "user", sessionId: id, message: { role: "user", content: "请给出完整报告" } },
          { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: prefix + suffix }] } },
        ].map((row) => JSON.stringify(row)).join("\n"));
      };
      await writeReply("第一版结尾");
      const first = await tail.fetch();
      expect(first).toMatchObject({ offset: 1, total: 2 });
      await expect(tail.fetch()).resolves.toBeNull();

      // Same message count, activity and prefix: growth must still emit a new
      // tail instead of being hidden by the unchanged-page fingerprint.
      await writeReply("第一版结尾\n继续输出：最终结论🙂");
      const grown = await tail.fetch();
      expect(grown).not.toBeNull();
      expect(grown).toMatchObject({ offset: 1, total: 2 });
      expect(grown!.messages).toHaveLength(1);
      const block = (grown!.messages[0] as RichMessage).blocks[0];
      expect(block.text?.length).toBe(prefix.length + "第一版结尾\n继续输出：最终结论🙂".length);
      expect(block.text?.endsWith("继续输出：最终结论🙂")).toBe(true);
      expect(block.truncated).toBeUndefined();
      await expect(tail.fetch()).resolves.toBeNull();

      // An equal-length correction beyond the old cutoff is a change too.
      await writeReply("第一版结尾\n继续输出：更正结论🙂");
      const corrected = await tail.fetch();
      expect((corrected?.messages[0] as RichMessage).blocks[0].text?.endsWith("更正结论🙂")).toBe(true);
    } finally {
      tail.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("bounds and routes read_session while suppressing unchanged pages", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const page = {
      total_messages: 3,
      offset: 1,
      messages: [{ role: "assistant", blocks: [{ type: "text", text: "ready" }] }],
      meta: { activity: { state: "idle" }, runtime: { turn_state: "needs_input" } },
      projection_version: { epoch: "runner-epoch-one", sequence: 7 },
    };
    const tail = openRunnerTail(async (method, args) => {
      calls.push({ method, args });
      return page;
    }, "codex", "session-1", "laptop", 900);

    await expect(tail.fetch()).resolves.toEqual({
      offset: 1,
      total: 3,
      messages: page.messages,
      activity: page.meta.activity,
      runtime: page.meta.runtime,
      version: page.projection_version,
    });
    await expect(tail.fetch()).resolves.toBeNull();
    expect(calls).toEqual([
      {
        method: "read_session",
        args: { id: "session-1", rich: true, max_messages: 500, source: "codex", device: "laptop" },
      },
      {
        method: "read_session",
        args: { id: "session-1", rich: true, max_messages: 500, source: "codex", device: "laptop" },
      },
    ]);
  });

  it("emits an explicit null when Runner interaction state clears", async () => {
    const pages = [
      { messages: [], meta: { runtime: { turn_state: "needs_input" } } },
      { messages: [], meta: {} },
    ];
    const tail = openRunnerTail(async () => pages.shift(), "unknown", "session-2", undefined, 0);

    await expect(tail.fetch()).resolves.toMatchObject({ runtime: { turn_state: "needs_input" } });
    await expect(tail.fetch()).resolves.toMatchObject({ runtime: null });
  });
});
