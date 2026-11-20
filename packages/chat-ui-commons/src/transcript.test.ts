import { describe, expect, it } from "vitest";
import { countUnits, entriesOf, formatTime, groupEntries, todoProgressOf } from "./transcript.js";

describe("neutral transcript vocabulary", () => {
  it("formats transcript timestamps in Beijing time regardless of the host timezone", () => {
    expect(formatTime("2026-08-24T08:30:45.000Z")).toBe("2026/8/24 16:30:45");
  });

  it("normalizes and folds without knowing which host will render it", () => {
    const entries = entriesOf([
      { role: "user", blocks: [{ type: "text", text: "开始" }] },
      { role: "assistant", blocks: [{ type: "tool", tool: "Bash", output: "one" }] },
      { role: "assistant", blocks: [{ type: "tool", tool: "Edit", input: "{\"file_path\":\"/x/a.ts\"}", output: "two" }] },
      { role: "assistant", blocks: [{ type: "text", text: "完成" }] },
    ], 20);

    expect(entries[1]).toMatchObject({ kind: "tool", anchor: "21.0" });
    expect(entries[2]).toMatchObject({ kind: "file", text: "/x/a.ts", anchor: "22.0" });
    expect(groupEntries(entries).map((group) => group.kind)).toEqual(["prose", "work", "prose"]);
    expect(countUnits(entries)).toBe(3);
  });
  it("carries bilingual prose without changing provider text or tool cards", () => {
    const entries = entriesOf([
      {
        role: "user",
        blocks: [{
          type: "text",
          text: "Check the build.",
          bilingual: { zh: "检查构建。", en: "Check the build." },
        }],
      },
      {
        role: "assistant",
        blocks: [
          { type: "tool", tool: "Bash", output: "secret tool output" },
          {
            type: "text",
            text: "The build passes.",
            bilingual: { zh: "构建已通过。", en: "The build passes." },
          },
        ],
      },
    ]);

    expect(entries[0]).toMatchObject({
      kind: "user",
      text: "Check the build.",
      bilingual: { zh: "检查构建。", en: "Check the build." },
    });
    expect(entries[1]).toMatchObject({ kind: "tool" });
    expect(entries[1]).not.toHaveProperty("bilingual");
    expect(entries[2]).toMatchObject({
      kind: "assistant",
      text: "The build passes.",
      bilingual: { zh: "构建已通过。", en: "The build passes." },
    });
  });

  it("keeps a text-only streaming frontier on the completed rich block's identity", () => {
    const streaming = entriesOf([{ role: "assistant", text: "正在生成" }], 14)[0];
    const completed = entriesOf([{
      role: "assistant",
      blocks: [{ type: "text", text: "已经生成完成" }],
    }], 14)[0];

    expect(streaming.anchor).toBe("14.0");
    expect(completed.anchor).toBe(streaming.anchor);
  });


  it("folds OMP thinking and tools into one ordered work run only when requested", () => {
    const entries = entriesOf([{
      role: "assistant",
      blocks: [
        { type: "thinking", text: "先查入口" },
        { type: "tool", tool: "Read", output: "one" },
        { type: "thinking", text: "再改实现" },
        { type: "tool", tool: "Edit", output: "two" },
      ],
    }]);

    expect(groupEntries(entries).map((group) => group.kind)).toEqual([
      "thinking",
      "work",
      "thinking",
      "work",
    ]);
    expect(countUnits(entries)).toBe(4);

    const omp = groupEntries(entries, false, true);
    expect(omp).toHaveLength(1);
    expect(omp[0]).toMatchObject({ kind: "work", entries });
    expect(omp[0]?.kind === "work" ? omp[0].entries.map((entry) => entry.live) : [])
      .toEqual([false, false, false, false]);
    expect(countUnits(entries, true)).toBe(1);
  });

  it("derives OMP todo progress without treating its readable output as trusted markup", () => {
    const progress = todoProgressOf({
      anchor: "todo:0",
      kind: "tool",
      text: "todo",
      input: JSON.stringify({ op: "done", task: "Build changed view" }),
      detail: [
        "Remaining items (2):",
        "  - Run focused tests [in_progress] (Verification)",
        "  - Submit ticket [pending] (Verification)",
        "Overall: 1/3 done, 2 open.",
        'Active phase 2/2 "Verification" (1/3).',
        "  Verification:",
        "    - [x] Build changed view",
        "    - [ ] Run focused tests (in progress)",
        "    - [ ] Submit ticket",
      ].join("\n"),
    });

    expect(progress).toMatchObject({
      completed: 1,
      total: 3,
      open: 2,
      activePhase: "Verification",
      items: [
        { text: "Run focused tests", state: "in_progress", phase: "Verification" },
        { text: "Submit ticket", state: "pending", phase: "Verification" },
        { text: "Build changed view", state: "done", phase: "Verification" },
      ],
    });
  });
});
