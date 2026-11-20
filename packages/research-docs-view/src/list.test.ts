import { describe, expect, it } from "vitest";
import { LIST_PAGE_ENTRIES, type Call } from "@claude-bot/research-docs-contract";
import { readAll } from "./list.js";
/** A trusted list answered as the plane does: id cursor, at most `limit` per page. */
function server(ids: string[]) {
  const asked: Record<string, unknown>[] = [];
  const call: Call = async (_action, p = {}) => {
    asked.push(p);
    const start = p.after ? ids.indexOf(String(p.after)) + 1 : 0,
      rows = ids.slice(start, start + Number(p.limit));
    return {
      comments: rows.map((id) => ({ id })),
      next: start + rows.length < ids.length ? rows[rows.length - 1] : null,
    } as never;
  };
  return { call, asked };
}
describe("paged lists", () => {
  it("follows the cursor to every entry of a list past the old 1000-comment count", async () => {
    const ids = Array.from({ length: 2345 }, (_, i) => "comment_" + i),
      { call, asked } = server(ids);
    const all = await readAll<{ id: string }>(call, "comments", "comments", { doc: "d" }, () => true);
    expect(all?.map((r) => r.id)).toEqual(ids);
    expect(asked).toHaveLength(Math.ceil(ids.length / LIST_PAGE_ENTRIES));
    expect(asked.every((p) => p.doc === "d" && p.limit === LIST_PAGE_ENTRIES)).toBe(true);
  });
  it("drops a read a newer one superseded", async () => {
    const { call } = server(Array.from({ length: 450 }, (_, i) => "c" + i));
    let current = true;
    const pending = readAll(call, "comments", "comments", {}, () => current);
    current = false;
    expect(await pending).toBeNull();
  });
  it("refuses an answer that is not a page instead of showing it as the whole list", async () => {
    const whole: Call = async () => ({ comments: [{ id: "a" }] }) as never;
    await expect(readAll(whole, "comments", "comments", {}, () => true)).rejects.toThrow("分页");
    const stuck: Call = async () => ({ comments: [{ id: "a" }], next: "a" }) as never;
    await expect(readAll(stuck, "comments", "comments", {}, () => true)).rejects.toThrow("分页");
  });
});
