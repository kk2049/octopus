import { describe, expect, it } from "vitest";
import {
  CI_ROSTER_GATE_MAX_FILES,
  decodeCiRoster,
  encodeCiRoster,
  isCiRepairTicket,
  mergeCiRoster,
  rosterGateFiles,
} from "./ci-roster.js";

describe("the CI lane marker", () => {
  it("is the presence of the column, not its contents", () => {
    expect(isCiRepairTicket({ ci_roster: null })).toBe(false);
    expect(isCiRepairTicket(undefined)).toBe(false);
    // An infrastructure red parses no roster, and that ticket still belongs to
    // the repair lane — it must get the repair contract, not the ordinary one.
    expect(isCiRepairTicket({ ci_roster: "[]" })).toBe(true);
    expect(isCiRepairTicket({ ci_roster: '["a.test.ts"]' })).toBe(true);
  });
});

describe("decoding", () => {
  it("round-trips", () => {
    const files = ["packages/bot/src/a.test.ts", "packages/bot/src/b.test.ts"];
    expect(decodeCiRoster(encodeCiRoster(files))).toEqual(files);
  });

  it("treats corruption as an empty roster rather than an unlandable ticket", () => {
    expect(decodeCiRoster("{not json")).toEqual([]);
    expect(decodeCiRoster('{"file":"a.test.ts"}')).toEqual([]);
    expect(decodeCiRoster('["a.test.ts", 7, null, ""]')).toEqual(["a.test.ts"]);
  });
});

describe("merging a second red into the same conversation", () => {
  it("unions instead of replacing, so a fix cannot ping-pong between two reds", () => {
    const first = mergeCiRoster(null, ["a.test.ts", "b.test.ts"]);
    const second = mergeCiRoster(encodeCiRoster(first), ["b.test.ts", "c.test.ts"]);
    expect(second).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
  });

  it("keeps first-seen order so two gate logs read the same way", () => {
    expect(mergeCiRoster(encodeCiRoster(["b.test.ts"]), ["a.test.ts"])).toEqual(["b.test.ts", "a.test.ts"]);
  });
});

describe("what the gate actually runs", () => {
  const all = () => true;

  it("drops files the fix deleted, and says which", () => {
    const sel = rosterGateFiles(["kept.test.ts", "gone.test.ts"], (f) => f === "kept.test.ts");
    expect(sel.files).toEqual(["kept.test.ts"]);
    expect(sel.missing).toEqual(["gone.test.ts"]);
    expect(sel.overflow).toEqual([]);
  });

  it("reports the overflow instead of silently running a slice", () => {
    const roster = Array.from({ length: CI_ROSTER_GATE_MAX_FILES + 3 }, (_, i) => `f${i}.test.ts`);
    const sel = rosterGateFiles(roster, all);
    expect(sel.files).toHaveLength(CI_ROSTER_GATE_MAX_FILES);
    expect(sel.overflow).toEqual([
      `f${CI_ROSTER_GATE_MAX_FILES}.test.ts`,
      `f${CI_ROSTER_GATE_MAX_FILES + 1}.test.ts`,
      `f${CI_ROSTER_GATE_MAX_FILES + 2}.test.ts`,
    ]);
  });

  it("counts the cap against present files only", () => {
    const sel = rosterGateFiles(["gone.test.ts", "a.test.ts", "b.test.ts"], (f) => f !== "gone.test.ts", 2);
    expect(sel.files).toEqual(["a.test.ts", "b.test.ts"]);
    expect(sel.overflow).toEqual([]);
  });
});
