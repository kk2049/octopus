/**
 * The canonical transcript rules, pinned in their permission-free package.
 *
 * Agent Views and the trusted Dashboard import this same implementation in the
 * safe direction (trusted → permission-free). Dashboard integration tests may
 * exercise it again, but there is no second source copy to keep in sync.
 */

import { describe, expect, it } from "vitest";
import type { RichMessage } from "@claude-bot/agent-sessions-contract";
import {
  QUIET_MS,
  TOOL_STALE_MS,
  activityPhase,
  activityStatus,
  countUnits,
  deriveActivity,
  elapsedOf,
  entriesOf,
  fileOf,
  groupEntries,
  shouldFollow,
} from "./transcript.js";

const NOW = Date.parse("2026-08-06T10:00:00.000Z");
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

describe("rich blocks → one vocabulary", () => {
  it("does not branch on which CLI wrote the log", () => {
    const claude: RichMessage = {
      role: "assistant",
      blocks: [{ type: "tool", tool: "Edit", input: JSON.stringify({ file_path: "/x/a.ts" }), output: "ok" }],
    };
    const codex: RichMessage = {
      role: "assistant",
      blocks: [{ type: "tool", tool: "apply_patch", input: "*** Update File: /x/a.ts\n", output: "ok" }],
    };
    expect(entriesOf([claude])[0]).toMatchObject({ kind: "file", text: "/x/a.ts" });
    expect(entriesOf([codex])[0]).toMatchObject({ kind: "file", text: "/x/a.ts" });
  });

  it("calls a Task a subagent and strips the MCP prefix from a tool name", () => {
    const entries = entriesOf([
      { role: "assistant", blocks: [{ type: "tool", tool: "Task", output: "done" }] },
      { role: "assistant", blocks: [{ type: "tool", tool: "mcp__board__update_card", output: "done" }] },
    ]);
    expect(entries[0].kind).toBe("subagent");
    expect(entries[1]).toMatchObject({ kind: "tool", text: "update_card" });
  });

  it("marks a tool with no recorded output as unpaired rather than empty", () => {
    const entry = entriesOf([{ role: "assistant", blocks: [{ type: "tool", tool: "Bash", input: "ls" }] }])[0];
    expect(entry).toMatchObject({ unpaired: true, detail: undefined });
  });

  it("degrades a pre-rich message honestly instead of dropping it", () => {
    expect(entriesOf([{ role: "assistant", text: "旧 Runner", tool: "Bash" }])).toEqual([
      { kind: "tool", text: "Bash", at: undefined, input: "", unpaired: true, anchor: "0.0" },
      { kind: "assistant", text: "旧 Runner", at: undefined, anchor: "0.1" },
    ]);
  });

  it("anchors entries by absolute message index, so a prepended page cannot move them", () => {
    const message = { role: "assistant" as const, blocks: [{ type: "text" as const, text: "hi" }] };
    // The same message at window offset 40 keeps its anchor when the window
    // grows backwards to offset 20 — that is what makes anchors usable as
    // React keys and expansion-state keys across "load earlier".
    const later = entriesOf([message], 40)[0];
    const grown = entriesOf([message, message], 39)[1];
    expect(later.anchor).toBe("40.0");
    expect(grown.anchor).toBe("40.0");
  });

  it("skips a whitespace-only text block but keeps a whitespace-only thinking block", () => {
    const entries = entriesOf([
      { role: "assistant", blocks: [{ type: "text", text: "   " }, { type: "thinking", text: "" }] },
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["thinking"]);
  });

  it("reads a file name out of a patch and out of JSON, and says nothing when it cannot", () => {
    expect(fileOf(JSON.stringify({ notebook_path: "/n.ipynb" }))).toBe("/n.ipynb");
    expect(fileOf("*** Add File: src/new.ts\n+x")).toBe("src/new.ts");
    expect(fileOf("just a string")).toBe("");
  });
});

describe("folding", () => {
  const work = (n: number): RichMessage[] =>
    Array.from({ length: n }, () => ({ role: "assistant", blocks: [{ type: "tool", tool: "Bash", output: "ok" }] }));

  it("counts a run of consecutive tool calls as ONE visible unit", () => {
    // This is the rule the tail window is measured in. If it disagrees with the
    // renderer, "load earlier" stops matching what is on screen.
    const entries = entriesOf([...work(10), { role: "user", blocks: [{ type: "text", text: "hi" }] }]);
    expect(entries).toHaveLength(11);
    expect(countUnits(entries)).toBe(2);
  });

  it("groups work runs exactly the way the counter folds them", () => {
    const entries = entriesOf([
      { role: "user", blocks: [{ type: "text", text: "a" }] },
      ...work(3),
      { role: "assistant", blocks: [{ type: "text", text: "b" }] },
    ]);
    const groups = groupEntries(entries);
    expect(groups.map((g) => g.kind)).toEqual(["prose", "work", "prose"]);
    expect(countUnits(entries)).toBe(groups.length);
  });

  it("reads several text blocks from one assistant as a single turn", () => {
    const entries = entriesOf([
      { role: "assistant", blocks: [{ type: "text", text: "b" }, { type: "text", text: "c" }] },
    ]);
    const groups = groupEntries(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "prose", role: "assistant" });
    // The counter does not model this merge, so it over-counts prose rows. That
    // is deliberate and documented: the tail window comes out a little longer
    // than strictly needed, never shorter.
    expect(countUnits(entries)).toBe(2);
  });

  it("treats unpaired work as in flight only in the LAST run", () => {
    const entries = entriesOf([
      { role: "assistant", blocks: [{ type: "tool", tool: "Old" }] },
      { role: "user", blocks: [{ type: "text", text: "again" }] },
      { role: "assistant", blocks: [{ type: "tool", tool: "New" }] },
    ]);
    const groups = groupEntries(entries, true);
    expect(groups[0]).toMatchObject({ kind: "work", busy: false });
    expect(groups[2]).toMatchObject({ kind: "work", busy: true });
  });
});

describe("activity is a function of NOW", () => {
  it("derives the same honest fallback for every Host", () => {
    const timestamp = new Date().toISOString();
    const openTool: RichMessage = {
      role: "assistant",
      timestamp,
      blocks: [{ type: "tool", tool: "Bash", input: "{}" }],
    };
    expect(deriveActivity({ last_activity: timestamp }, [openTool])).toMatchObject({
      state: "tool",
      degraded: true,
    });
    expect(
      deriveActivity(
        { activity: { state: "responding" }, last_activity: timestamp },
        [],
      ),
    ).toMatchObject({ state: "responding", observed_at: timestamp });
  });

  it("expires a quiet thinking state instead of counting up forever", () => {
    // The bug this exists for: a finished headless run writes nothing to say it
    // finished, so a state derived once and repainted by a ticker kept counting
    // for an hour.
    const activity = { state: "thinking", since: iso(QUIET_MS + 60_000), observed_at: iso(QUIET_MS + 60_000) };
    expect(activityPhase(activity, NOW)).toBe("");
    expect(activityStatus(activity, NOW)).toBe("");
    expect(shouldFollow(activity, NOW)).toBe(false);
  });

  it("gives a long tool run its grace, then calls it possibly interrupted", () => {
    const running = { state: "tool", tool: "Bash", since: iso(0), observed_at: iso(TOOL_STALE_MS - 1_000) };
    const dead = { state: "tool", tool: "Bash", since: iso(0), observed_at: iso(TOOL_STALE_MS + 1_000) };
    expect(activityPhase(running, NOW)).toBe("live");
    expect(activityPhase(dead, NOW)).toBe("stale");
    expect(activityStatus(dead, NOW)).toContain("可能已中断");
  });

  it("measures silence from the last log line, not from when the state began", () => {
    // A long tool run that keeps logging is alive; a short thinking state that
    // stopped logging is not.
    const alive = { state: "tool", since: iso(TOOL_STALE_MS * 2), observed_at: iso(1_000) };
    expect(activityPhase(alive, NOW)).toBe("live");
    expect(elapsedOf(alive, NOW)).toBeGreaterThan(TOOL_STALE_MS);
  });

  it("stays live when there is no usable timestamp — it cannot prove it stopped", () => {
    expect(activityPhase({ state: "running" }, NOW)).toBe("live");
    expect(activityStatus({ state: "running" }, NOW)).toBe("⏳ 运行中…");
  });

  it("says nothing at all when idle", () => {
    expect(activityPhase({ state: "idle" }, NOW)).toBe("");
    expect(activityPhase(null, NOW)).toBe("");
  });
});
