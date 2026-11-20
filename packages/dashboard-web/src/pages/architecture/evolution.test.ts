import { describe, expect, it } from "vitest";
import {
  archDiffEmpty,
  axisCommits,
  clampIndex,
  clampRange,
  fmtSigned,
  indexAtOffset,
  moduleLabel,
  positionPercent,
  safeDiff,
  shortDate,
  snapshotIndices,
  stepIndex,
  UNMAPPED_MODULE,
  type EvoArchitectureDiff,
  type EvoCommit,
  type EvoSnapshot,
} from "./evolution.js";

function commit(sha: string, date = "2026-08-10T10:00:00+08:00"): EvoCommit {
  return { sha, date, author: "a", subject: "s" };
}

function snap(sha: string): EvoSnapshot {
  return { commit: sha, branch: "v4", dirty: false, generatedAt: "2026-08-10T00:00:00Z", current: false };
}

describe("axisCommits", () => {
  it("reverses the newest-first wire into an oldest→newest axis", () => {
    expect(axisCommits([commit("c"), commit("b"), commit("a")]).map((c) => c.sha)).toEqual(["a", "b", "c"]);
  });

  it("treats a missing list as empty and does not mutate its input", () => {
    expect(axisCommits(undefined)).toEqual([]);
    const wire = [commit("b"), commit("a")];
    axisCommits(wire);
    expect(wire[0].sha).toBe("b");
  });
});

describe("range arithmetic", () => {
  it("clamps indices into the axis", () => {
    expect(clampIndex(-3, 10)).toBe(0);
    expect(clampIndex(42, 10)).toBe(9);
    expect(clampIndex(4.6, 10)).toBe(5);
    expect(clampIndex(5, 0)).toBe(0);
  });

  it("keeps at least one commit between the handles", () => {
    // Dragging `from` onto/past `to` stops one short of it.
    expect(clampRange([7, 7], 10, "from")).toEqual([6, 7]);
    expect(clampRange([9, 7], 10, "from")).toEqual([6, 7]);
    // Dragging `to` onto/past `from` stops one past it.
    expect(clampRange([3, 3], 10, "to")).toEqual([3, 4]);
    expect(clampRange([3, 1], 10, "to")).toEqual([3, 4]);
  });

  it("recovers deterministically from a degenerate pair at the wall", () => {
    expect(clampRange([0, 0], 10, "from")).toEqual([0, 1]);
    expect(clampRange([2, 2], 1, "from")).toEqual([0, 0]);
  });

  it("maps indices to track percentages and back", () => {
    expect(positionPercent(0, 5)).toBe(0);
    expect(positionPercent(4, 5)).toBe(100);
    expect(positionPercent(2, 5)).toBe(50);
    expect(positionPercent(0, 1)).toBe(0);
    expect(indexAtOffset(0, 200, 5)).toBe(0);
    expect(indexAtOffset(200, 200, 5)).toBe(4);
    expect(indexAtOffset(99, 200, 5)).toBe(2);
    expect(indexAtOffset(50, 0, 5)).toBe(0);
  });

  it("steps by key: arrows ±1, page ±10, Home/End to the walls", () => {
    expect(stepIndex(5, "ArrowLeft", 20)).toBe(4);
    expect(stepIndex(5, "ArrowRight", 20)).toBe(6);
    expect(stepIndex(5, "PageUp", 20)).toBe(15);
    expect(stepIndex(5, "PageDown", 20)).toBe(0);
    expect(stepIndex(5, "Home", 20)).toBe(0);
    expect(stepIndex(5, "End", 20)).toBe(19);
    expect(stepIndex(19, "ArrowRight", 20)).toBe(19);
    expect(stepIndex(5, "Enter", 20)).toBe(5);
  });
});

describe("snapshotIndices", () => {
  it("marks the axis positions whose commit has an archived snapshot", () => {
    const axis = [commit("a"), commit("b"), commit("c")];
    const marks = snapshotIndices(axis, [snap("c"), snap("a"), snap("zz-not-on-axis")]);
    expect([...marks.keys()].sort()).toEqual([0, 2]);
    expect(marks.get(2)?.commit).toBe("c");
  });

  it("is empty when there are no snapshots", () => {
    expect(snapshotIndices([commit("a")], undefined).size).toBe(0);
  });
});

describe("safeDiff", () => {
  it("normalises a sparse wire object without inventing an architecture diff", () => {
    const out = safeDiff({ from: "a", to: "b", architecture: null });
    expect(out).not.toBeNull();
    expect(out!.code.modules).toEqual([]);
    expect(out!.code.commitCount).toBe(0);
    expect(out!.architecture).toBeNull();
  });

  it("fills missing arrays inside a present architecture diff", () => {
    const out = safeDiff({
      from: "a",
      to: "b",
      architecture: {
        base: { commit: "a", branch: "v4", dirty: false, generatedAt: "" },
        head: { commit: "b", branch: "v4", dirty: false, generatedAt: "" },
        modules: { added: [{ id: "m", label: "M", zone: "z", codeLoc: 1, files: 1 }] },
      } as never,
    });
    expect(out!.architecture!.modules.added).toHaveLength(1);
    expect(out!.architecture!.modules.removed).toEqual([]);
    expect(out!.architecture!.dependencies.added).toEqual([]);
    expect(out!.architecture!.constraints.changed).toEqual([]);
    expect(out!.architecture!.totals.before.codeLoc).toBe(0);
  });

  it("returns null for nothing", () => {
    expect(safeDiff(undefined)).toBeNull();
  });
});

describe("archDiffEmpty", () => {
  const empty: EvoArchitectureDiff = {
    base: { commit: "a", branch: "", dirty: false, generatedAt: "" },
    head: { commit: "b", branch: "", dirty: false, generatedAt: "" },
    modules: { added: [], removed: [], resized: [] },
    dependencies: { added: [], removed: [], becameCircular: [], becameAcyclic: [] },
    constraints: { added: [], removed: [], changed: [] },
    totals: {
      before: { files: 0, codeLoc: 0, symbols: 0, calls: 0, annotations: 0 },
      after: { files: 0, codeLoc: 0, symbols: 0, calls: 0, annotations: 0 },
    },
  };

  it("is true only when every tracked list is empty", () => {
    expect(archDiffEmpty(empty)).toBe(true);
    expect(
      archDiffEmpty({ ...empty, constraints: { added: [], removed: [], changed: [{ id: "c", title: "t", before: "pass", after: "fail" }] } }),
    ).toBe(false);
  });
});

describe("formatting", () => {
  it("keeps signs honest", () => {
    expect(fmtSigned(30)).toBe("+30");
    expect(fmtSigned(-30)).toBe("−30");
    expect(fmtSigned(0)).toBe("±0");
  });

  it("shortens ISO dates without pretending to parse garbage", () => {
    expect(shortDate("2026-08-10T12:00:00+08:00")).toBe("08-10");
    expect(shortDate("garbage")).toBe("garbage");
    expect(shortDate("")).toBe("");
  });

  it("labels the unmapped bucket honestly", () => {
    expect(moduleLabel(UNMAPPED_MODULE)).toContain("未归属");
    expect(moduleLabel("bot-core")).toBe("bot-core");
  });
});
