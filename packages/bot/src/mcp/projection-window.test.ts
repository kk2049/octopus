import { describe, expect, it } from "vitest";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import { PROJECTION_WINDOW_CHARS, projectionWindow } from "./projection-window.js";

/** Walk every page of one container target and return what it yielded. */
function pages(projection: RuntimeJson, path: string, window: number) {
  const seen: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const answer = projectionWindow(projection, path, cursor, window);
    if (!answer.ok) throw new Error(answer.message);
    const page = answer.value.projection_page as { entries: Array<Record<string, unknown>>; next?: number };
    seen.push(...page.entries);
    if (page.next === undefined) return seen;
    cursor = page.next;
  }
  throw new Error("no progress");
}

describe("an App projection read one window at a time", () => {
  it("answers a projection that fits whole, exactly as before", () => {
    expect(projectionWindow({ notes: ["a"] })).toEqual({ ok: true, value: { path: "", projection: { notes: ["a"] } } });
    expect(projectionWindow(null)).toEqual({ ok: true, value: { path: "", projection: null } });
  });

  it("reaches every row of a projection larger than any one answer", () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => ({ id: index, title: `第 ${index} 条`, body: "x".repeat(200) }));
    const projection = { rows, notice: "ok" };
    expect(JSON.stringify(projection).length).toBeGreaterThan(PROJECTION_WINDOW_CHARS * 4);

    const top = projectionWindow(projection);
    expect(top.ok && top.value.projection_page).toMatchObject({
      kind: "object",
      total: 2,
      entries: [{ key: "rows", omitted_chars: JSON.stringify(rows).length }, { key: "notice", value: "ok" }],
    });

    const seen = pages(projection, "/rows", PROJECTION_WINDOW_CHARS);
    expect(seen.map((item) => item.key)).toEqual(rows.map((_, index) => index));
    expect(seen.map((item) => item.value)).toEqual(rows);
    // Every answer stayed inside the window it promised.
    let cursor = 0;
    for (;;) {
      const answer = projectionWindow(projection, "/rows", cursor);
      expect(JSON.stringify(answer).length).toBeLessThan(PROJECTION_WINDOW_CHARS + 512);
      const next = answer.ok ? (answer.value.projection_page as { next?: number }).next : undefined;
      if (next === undefined) break;
      cursor = next;
    }
  });

  it("drills into a child larger than the window by path, and pages a long string", () => {
    const long = "é".repeat(PROJECTION_WINDOW_CHARS * 2 + 7);
    const projection = { docs: { "a/b": { text: long } } };
    const leaf = projectionWindow(projection, "/docs/a~1b/text");
    expect(leaf.ok && leaf.value.projection_text).toMatchObject({ total_chars: long.length, from: 0, next: PROJECTION_WINDOW_CHARS });
    let text = "";
    let cursor: number | undefined = 0;
    while (cursor !== undefined) {
      const answer = projectionWindow(projection, "/docs/a~1b/text", cursor);
      const page = (answer.ok ? answer.value.projection_text : null) as { text: string; next?: number };
      text += page.text;
      cursor = page.next;
    }
    expect(text).toBe(long);
  });

  it("refuses a path that is not in the projection instead of guessing", () => {
    expect(projectionWindow({ rows: [1] }, "/rows/1")).toMatchObject({ ok: false });
    expect(projectionWindow({ rows: [1] }, "rows")).toMatchObject({ ok: false });
    expect(projectionWindow({ rows: [1] }, "/rows/01")).toMatchObject({ ok: false });
    expect(projectionWindow({ rows: [1] }, "/rows/0")).toEqual({ ok: true, value: { path: "/rows/0", projection: 1 } });
  });
});
