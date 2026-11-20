/**
 * Transcript logic, where "wrong" means the page lies about a running session.
 *
 * The two properties under test each cost a real defect when they were
 * duplicated or derived once: activity must be a function of NOW or a finished
 * session counts upward forever; and the fold-unit count must mirror the
 * renderer or "load earlier" moves the viewport by the wrong amount.
 */

import { describe, expect, it } from "vitest";
import {
  activityPhase,
  countUnits,
  deriveActivity,
  entriesOf,
  fileOf,
  groupEntries,
  shouldFollow,
  type RichMessage,
} from "./transcript.js";

const at = "2026-08-01T10:00:00.000Z";

function toolMessage(output?: string): RichMessage {
  return {
    role: "assistant",
    timestamp: at,
    blocks: [{ type: "tool", tool: "Bash", input: '{"command":"ls"}', output }],
  };
}

describe("entriesOf", () => {
  it("maps a write tool to a `file` entry named by its path", () => {
    const entries = entriesOf([
      {
        role: "assistant",
        blocks: [{ type: "tool", tool: "Edit", input: '{"file_path":"/x/y.ts"}', output: "ok" }],
      },
    ]);
    expect(entries[0]).toMatchObject({ kind: "file", text: "/x/y.ts" });
  });

  it("maps codex's patch format the same way — the browser never branches on CLI", () => {
    expect(fileOf("*** Update File: packages/a/b.ts\n@@")).toBe("packages/a/b.ts");
    const entries = entriesOf([
      {
        role: "assistant",
        blocks: [{ type: "tool", tool: "apply_patch", input: "*** Add File: a/b.ts\n" }],
      },
    ]);
    expect(entries[0]).toMatchObject({ kind: "file", text: "a/b.ts" });
  });

  it("maps a Task to a subagent, and strips the mcp prefix from tool names", () => {
    const entries = entriesOf([
      { role: "assistant", blocks: [{ type: "tool", tool: "Task" }] },
      { role: "assistant", blocks: [{ type: "tool", tool: "mcp__board__update" }] },
    ]);
    expect(entries[0].kind).toBe("subagent");
    expect(entries[1]).toMatchObject({ kind: "tool", text: "update" });
  });

  it("marks a tool with no recorded output as unpaired", () => {
    expect(entriesOf([toolMessage()])[0].unpaired).toBe(true);
    expect(entriesOf([toolMessage("done")])[0].unpaired).toBe(false);
  });

  it("degrades an old Runner's flat message honestly rather than dropping it", () => {
    const entries = entriesOf([{ role: "assistant", text: "hi", tool: "Bash" }]);
    expect(entries.map((e) => e.kind)).toEqual(["tool", "assistant"]);
  });

  it("drops whitespace-only text blocks", () => {
    expect(entriesOf([{ role: "assistant", blocks: [{ type: "text", text: "   " }] }])).toHaveLength(0);
  });
});

describe("countUnits mirrors the renderer's folding", () => {
  it("counts a run of consecutive work entries as one", () => {
    const entries = entriesOf([toolMessage("a"), toolMessage("b"), toolMessage("c")]);
    expect(entries).toHaveLength(3);
    expect(countUnits(entries)).toBe(1);
  });

  it("counts prose either side of a run separately", () => {
    const entries = entriesOf([
      { role: "user", blocks: [{ type: "text", text: "go" }] },
      toolMessage("a"),
      toolMessage("b"),
      { role: "assistant", blocks: [{ type: "text", text: "done" }] },
    ]);
    expect(countUnits(entries)).toBe(3);
    // And the renderer agrees, which is the property that matters.
    expect(groupEntries(entries)).toHaveLength(3);
  });
});

describe("groupEntries", () => {
  it("merges consecutive prose of one role into a single turn", () => {
    const groups = groupEntries(
      entriesOf([
        {
          role: "assistant",
          blocks: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
        },
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "prose", role: "assistant" });
  });

  it("treats an unpaired tool in the LAST run as in flight only when running", () => {
    const entries = entriesOf([toolMessage("done"), toolMessage()]);
    const idle = groupEntries(entries, false);
    const busy = groupEntries(entries, true);
    expect(idle[0]).toMatchObject({ kind: "work", busy: false });
    expect(busy[0]).toMatchObject({ kind: "work", busy: true });
  });

  it("does not treat an unpaired tool ABOVE the last run as in flight", () => {
    const entries = entriesOf([
      toolMessage(), // dead
      { role: "assistant", blocks: [{ type: "text", text: "spoke" }] },
      toolMessage(), // in flight
    ]);
    const groups = groupEntries(entries, true);
    expect(groups[0]).toMatchObject({ kind: "work", busy: false });
    expect(groups[2]).toMatchObject({ kind: "work", busy: true });
  });
});

describe("activity is a function of NOW", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");

  it("shows a model that owes us output only while it is still writing", () => {
    const fresh = { state: "thinking", since: new Date(now - 10_000).toISOString() };
    const quiet = { state: "thinking", since: new Date(now - 120_000).toISOString() };
    expect(activityPhase(fresh, now)).toBe("live");
    // 90 s of silence means the turn is over — not "still thinking for 2 minutes".
    expect(activityPhase(quiet, now)).toBe("");
  });

  it("gives a long tool call a much longer grace, then calls it possibly dead", () => {
    const building = { state: "tool", tool: "Bash", since: new Date(now - 300_000).toISOString() };
    const corpse = { state: "tool", tool: "Bash", since: new Date(now - 900_000).toISOString() };
    expect(activityPhase(building, now)).toBe("live");
    expect(activityPhase(corpse, now)).toBe("stale");
  });

  it("measures silence from the last log line, not from when the state began", () => {
    const longButAlive = {
      state: "tool",
      since: new Date(now - 3_600_000).toISOString(),
      observed_at: new Date(now - 5_000).toISOString(),
    };
    expect(activityPhase(longButAlive, now)).toBe("live");
  });

  it("never claims `thinking` it did not observe", () => {
    const fresh = new Date().toISOString();
    const openTool: RichMessage = {
      role: "assistant",
      timestamp: fresh,
      blocks: [{ type: "tool", tool: "Bash", input: "{}" }],
    };
    const derived = deriveActivity({ last_activity: fresh }, [openTool]);
    expect(derived).toMatchObject({ state: "tool", degraded: true });
    const noTool = deriveActivity({ last_activity: fresh }, [
      { role: "assistant", timestamp: fresh, blocks: [{ type: "text", text: "hi" }] },
    ]);
    expect(noTool).toMatchObject({ state: "running", degraded: true });
  });

  it("borrows the meta's last write when an old Runner sends no observed_at", () => {
    const derived = deriveActivity(
      { activity: { state: "tool" }, last_activity: at },
      [],
    );
    expect(derived?.observed_at).toBe(at);
  });

  it("does not follow a session that is merely busy-looking but dead", () => {
    const corpse = { state: "tool", since: new Date(now - 900_000).toISOString() };
    expect(shouldFollow(corpse, now)).toBe(false);
  });
});
