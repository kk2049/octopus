import { describe, expect, it } from "vitest";
import { controlAdapter, createAdapterDescriptor, normalizeRows, normalizeSchema, publishAdapter } from "./projections.js";
const actor = { kind: "agent" as const, owner: "alice", trigger: "run", agent: "a", run: "r", model: "m", at: "now" };
const schema = { view: "table" as const, columns: [{ key: "name", label: "名称", kind: "text" as const }, { key: "score", label: "分数", kind: "number" as const }], primary: "name" };
describe("adapter projections", () => {
  it("normalizes bounded scalar rows and replaces a source revision atomically", () => {
    const descriptor = createAdapterDescriptor({ title: "指标", source: "runner:file", entry: "watch.mjs", schema }, actor, "t0");
    const published = publishAdapter(descriptor, { sourceRevision: "sha-1", rows: [{ id: "a", cells: { name: "ACC", score: 3 } }] }, actor, "t1");
    expect(published).toMatchObject({ status: "live", sourceRevision: "sha-1", rows: [{ id: "a" }] });
    expect(() => publishAdapter(published, { sourceRevision: "sha-2", rows: [{ id: "b", cells: { unknown: "x" } }] }, actor, "t2")).toThrow("未声明");
  });
  it("rejects nested cells, duplicate columns and oversized batches", () => {
    expect(() => normalizeSchema({ view: "table", columns: [{ key: "x", label: "x" }, { key: "x", label: "y" }] })).toThrow("重复");
    expect(() => normalizeRows([{ id: "x", cells: { name: { nested: true } } }], schema)).toThrow("标量");
    expect(() => normalizeRows(Array.from({ length: 201 }, (_, i) => ({ id: String(i), cells: {} })), schema)).toThrow("上限");
  });
  it("isolates agent namespaces even for the same resource owner", () => {
    const descriptor = createAdapterDescriptor({ title: "指标", source: "runner:file", entry: "watch.mjs", schema }, actor, "t0");
    expect(() => publishAdapter(descriptor, { sourceRevision: "x", rows: [] }, { ...actor, agent: "other" }, "t1")).toThrow("登记者");
  });
  it("allows only controlled lifecycle states", () => {
    const descriptor = createAdapterDescriptor({ title: "指标", source: "runner:file", entry: "watch.mjs", schema }, actor, "t0");
    const paused = controlAdapter(descriptor, "paused", actor, "t1");
    expect(paused.status).toBe("paused");
    expect(() => publishAdapter(paused, { sourceRevision: "x", rows: [] }, actor, "t2")).toThrow("暂停");
    expect(() => publishAdapter(controlAdapter(descriptor, "removed", actor, "t1"), { sourceRevision: "x", rows: [] }, actor, "t2")).toThrow("移除");
  });
});
