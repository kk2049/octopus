import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "@claude-bot/agent-sessions-contract";
import { QUIET_MS } from "./transcript.js";
import {
  currentRuntimeOf,
  currentTurnState,
  devicesOf,
  preferredTranscriptWindow,
  rosterOf,
  sessionNeedsReview,
  sortedSessions,
  tailNeedsMore,
  titleOf,
  titleText,
} from "./projection.js";
import { sessionCliKindLabel } from "./cli.js";

describe("session projection helpers", () => {
  it("counts a Claude/OMP thought-tool sequence as one tail unit while Codex retains separate thoughts", () => {
    const messages = [
      { role: "user", text: "开始" },
      ...Array.from({ length: 25 }, () => ({ role: "assistant", blocks: [
        { type: "thinking", text: "检查" },
        { type: "tool", tool: "Read", output: "ok" },
      ] })),
    ];
    expect(tailNeedsMore(messages, "claude")).toBe(true);
    expect(tailNeedsMore(messages, "omp")).toBe(true);
    expect(tailNeedsMore(messages, "codex")).toBe(false);
    expect(tailNeedsMore(messages)).toBe(false);
  });
  it("retains explicit naming and fills an unknown row count from an already-read transcript", () => {
    const child = { resourceId: "child", sessionId: "child", parentResourceId: "parent" };
    expect(rosterOf([child])[0].messageCount).toBeUndefined();
    const [row] = rosterOf([child], {}, { child: "Town 4" }, {
      child: { offset: 940, totalMessages: 946, messages: [] },
    });
    expect(row).toMatchObject({ userNamed: true, messageCount: 946, parentResourceId: "parent" });
    expect(child).not.toHaveProperty("messageCount");
    expect(rosterOf([{ ...child, messageCount: 0 }], {}, {}, {
      child: { totalMessages: 946, messages: [] },
    })[0].messageCount).toBe(0);
  });

  it("prefers a provider-owned title, then falls back to the user instruction", () => {
    expect(titleOf({
      title: "调研 dsh 生态",
      projectLabel: "home-ubuntu",
      firstUserText: "  # 验收\n这是全手动权限验收。必须使用 shell 执行测试。",
    })).toBe("调研 dsh 生态");
    expect(titleOf({
      projectLabel: "home-ubuntu",
      firstUserText: "  # 验收\n这是全手动权限验收。必须使用 shell 执行测试。",
    })).toBe("验收");
    expect(titleOf({ projectLabel: "home-ubuntu", firstUserText: "hi" })).toBe("hi");
    expect(titleOf({ title: "发布复盘", accountLabel: "b" })).toBe("发布复盘");
    expect(titleOf({ title: "发布复盘", accountLabel: "private-slot" })).toBe("发布复盘");
  });

  it("strips code blocks and bounds titles by unicode characters", () => {
    expect(titleText("```sh\necho hidden\n```\n- 请继续完成这个任务。后面的解释不应进入标题")).toBe("请继续完成这个任务。");
    expect(Array.from(titleText("甲".repeat(80))).length).toBe(48);
    expect(titleText("甲".repeat(80))).toMatch(/…$/);
  });

  it("puts a safe account marker on Codex instead of the session title", () => {
    expect(sessionCliKindLabel("codex", "b")).toBe("Codex-b");
    expect(sessionCliKindLabel("codex", "private-slot")).toBe("Codex");
    expect(sessionCliKindLabel("claude", "b")).toBe("claude");
  });

  it("uses a newer transcript runtime but lets the roster win ties", () => {
    const roster: AgentRuntime = { turn_state: "working", observed_at: "2026-08-12T10:00:00Z" };
    const transcript: AgentRuntime = { turn_state: "needs_input", observed_at: "2026-08-12T10:00:01Z" };
    expect(currentRuntimeOf(roster, transcript)).toBe(transcript);
    expect(currentRuntimeOf(roster, { ...transcript, observed_at: roster.observed_at })).toBe(roster);
  });

  it("expires timestamped working evidence without guessing about legacy runtimes", () => {
    const now = Date.parse("2026-08-21T14:00:00Z");
    expect(currentTurnState({
      turn_state: "working",
      observed_at: new Date(now - QUIET_MS).toISOString(),
    }, now)).toBe("working");
    expect(currentTurnState({
      turn_state: "working",
      observed_at: new Date(now - QUIET_MS - 1).toISOString(),
    }, now)).toBe("unknown");
    expect(currentTurnState({ turn_state: "working" }, now)).toBe("working");
    expect(currentTurnState({ turn_state: "needs_input" }, now)).toBe("needs_input");
  });

  it("sorts on stable activity and compares completion acknowledgement exactly", () => {
    const projection = {
      sessions: [
        {
          resourceId: "chatty",
          sortActivity: "2026-08-25T10:00:00Z",
          lastActivity: "2026-08-25T10:10:00Z",
          completedAt: "2026-08-25T10:00:00Z",
        },
        {
          resourceId: "finished",
          sortActivity: "2026-08-25T10:05:00Z",
          lastActivity: "2026-08-25T10:05:00Z",
          completedAt: "2026-08-25T10:05:00Z",
        },
      ],
    };
    expect(sortedSessions(projection).map((session) => session.resourceId))
      .toEqual(["finished", "chatty"]);
    expect(sessionNeedsReview(projection.sessions[1], undefined)).toBe(true);
    expect(sessionNeedsReview(projection.sessions[1], "2026-08-25T10:05:00Z")).toBe(false);
    expect(sessionNeedsReview(projection.sessions[1], "2026-08-25T10:04:59Z")).toBe(true);
  });

  it("uses favorites as a group without replacing activity order", () => {
    const projection = {
      pinned: ["older-favorite", "newer-favorite"],
      sessions: [
        { resourceId: "newest", sortActivity: "2026-08-25T10:10:00Z" },
        { resourceId: "older-favorite", sortActivity: "2026-08-25T10:00:00Z" },
        { resourceId: "older", sortActivity: "2026-08-25T09:50:00Z" },
        { resourceId: "newer-favorite", sortActivity: "2026-08-25T10:05:00Z" },
      ],
    };
    expect(sortedSessions(projection).map((session) => session.resourceId))
      .toEqual(["newer-favorite", "older-favorite", "newest", "older"]);
  });

  it("groups a split session by the execution device without changing its runtime resource", () => {
    const session = {
      resourceId: "runtime-resource",
      deviceId: "runtime-a",
      directoryDeviceId: "exec-b",
      cwdDisplay: "~/lht/octopus",
    };
    expect(devicesOf({ sessions: [session] })).toEqual(["exec-b", "runtime-a"]);
    expect(rosterOf([session])).toEqual([expect.objectContaining({
      id: "runtime-resource",
      resourceId: "runtime-resource",
      device: "exec-b",
      cwd: "~/lht/octopus",
    })]);
  });

  it("keeps per-resource transcript freshness ahead of later frame arrival", () => {
    const version = (sequence: number, epoch = "runner-epoch-one") => ({ epoch, sequence });
    const window = (offset: number, totalMessages: number, text: string, sequence?: number) => ({
      offset,
      totalMessages,
      messages: [{ role: "assistant", text }],
      ...(sequence === undefined ? {} : { version: version(sequence) }),
    });
    const current = window(9, 10, "completed", 10);

    expect(preferredTranscriptWindow(current, window(0, 9, "old boundary", 9))).toBe(current);
    expect(preferredTranscriptWindow(current, window(9, 10, "same snapshot", 10))).toBe(current);
    expect(preferredTranscriptWindow(current, window(9, 10, "rewritten", 11)))
      .toMatchObject({ messages: [{ text: "rewritten" }], version: version(11) });
    expect(preferredTranscriptWindow(current, window(0, 8, "smaller despite sequence", 11))).toBe(current);

    const reset = window(0, 1, "new lineage", 1);
    reset.version = version(1, "runner-epoch-two");
    expect(preferredTranscriptWindow(current, reset)).toBe(reset);
  });

  it("accepts richer history but rejects an unversioned older or narrower window", () => {
    const current = {
      offset: 5,
      totalMessages: 10,
      messages: Array.from({ length: 5 }, (_, index) => ({ role: "assistant", text: String(index + 5) })),
    };
    const richer = {
      ...current,
      offset: 3,
      messages: Array.from({ length: 7 }, (_, index) => ({ role: "assistant", text: String(index + 3) })),
    };
    expect(preferredTranscriptWindow(current, richer)).toBe(richer);
    expect(preferredTranscriptWindow(richer, current)).toMatchObject(richer);
    expect(preferredTranscriptWindow(current, { ...current, totalMessages: 9 })).toBe(current);
  });
});
