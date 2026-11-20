import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasDocument } from "./collaboration.js";
import type { Call } from "./client.js";
const documents: CanvasDocument[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => { for (const doc of documents.splice(0)) doc.close(); });
const draft = (call: Call, key: string, field: "text" | "layout" = "text") => {
  const doc = new CanvasDocument(call, field === "text" ? "note" : "board", field, key); documents.push(doc); return doc;
};
describe("workspace drafts and imperative layout", () => {
  it("reads a body in windows, shows past the budget read-only, and loads all on request", async () => {
    const body = "正文".repeat(9 * 1024 * 1024), bytes = new TextEncoder().encode(body).length, window = 256 * 1024;
    const reads: number[] = []; let writes = 0;
    const call = (async (action: string, params: Record<string, unknown> = {}) => {
      if (action === "document_write") { writes++; return { revision: "x" }; }
      const offset = Number(params.offset); reads.push(offset);
      // Three bytes per character: one window is a whole number of characters.
      const start = offset / 3, end = Math.min(body.length, start + Math.floor(window / 3));
      return { revision: "r1", data: { text: body.slice(start, end), next: end < body.length ? end * 3 : null, bytes } };
    }) as Call;
    const doc = draft(call, "large");
    await doc.sync();
    expect(doc.snapshot().partial).toMatchObject({ total: bytes });
    expect(doc.snapshot().partial!.loaded).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(doc.text().length).toBeLessThan(body.length);
    doc.replaceText("覆盖");
    await doc.sync();
    expect(writes).toBe(0);
    await doc.loadAll();
    expect(doc.snapshot().partial).toBeUndefined();
    expect(doc.text()).toBe(body);
    expect(Math.max(...reads.slice(1).map((offset, index) => offset - reads[index]!).filter(step => step > 0))).toBeLessThanOrEqual(window);
  }, 60_000);
  it("never restores an older draft after the quota refused a newer one", async () => {
    const call = (async () => ({ revision: "r", data: { text: "服务器上的正文" } })) as Call;
    const doc = draft(call, "quota");
    doc.replaceText("旧草稿");
    expect(JSON.parse(localStorage.getItem("quota")!)).toMatchObject({ text: "旧草稿", dirty: true });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    try { doc.replaceText("新".repeat(1000)); } finally { setItem.mockRestore(); }
    // The document still edits the newest text; a reload finds no draft to
    // restore (and so to save over the file) rather than the older one.
    expect(doc.text()).toBe("新".repeat(1000));
    expect(localStorage.getItem("quota")).toBeNull();
    expect(draft(call, "quota").text()).toBe("");
  });
  it("saves a body far past one call's window through a staged save, keeping the draft until commit", async () => {
    let text = "原文";
    const steps: string[] = [];
    let staged = "";
    const call = (async (action: string, params: Record<string, unknown> = {}) => {
      if (action === "document_read") return { revision: text, data: { text } };
      if (action !== "document_write") throw new Error("Unexpected " + action);
      steps.push(String(params.stage ?? "whole"));
      if (params.stage === "begin") { staged = ""; return { status: "staged", upload: "c".repeat(32), size: 0, revision: text }; }
      if (params.stage === "append") { staged += String(params.text); return { status: "staged", size: new TextEncoder().encode(staged).length }; }
      if (params.stage === "commit") { text = staged; return { revision: "after-commit" }; }
      text = String(params.text); return { revision: text };
    }) as Call;
    const doc = draft(call, "staged-body");
    await doc.sync();
    const long = "很长的正文".repeat(100_000);
    doc.replaceText(long);
    await doc.sync();
    expect(steps[0]).toBe("begin");
    expect(steps.at(-1)).toBe("commit");
    expect(text).toBe(long);
    expect(doc.snapshot().error).toBe("");
    expect(JSON.parse(localStorage.getItem("staged-body")!)).toMatchObject({ dirty: false });
    expect(doc.revision).toBe("after-commit");
  });
  it("saves whole file contents and a read-only refresh never writes", async () => {
    let text = "原文", writes = 0;
    const call = (async (action: string, params: Record<string, unknown> = {}) => {
      if (action === "document_read") return { revision: text, data: { text } };
      if (action === "document_write") { writes++; text = String(params.text); return { revision: text }; }
      throw new Error("Unexpected " + action);
    }) as Call;
    const a = draft(call, "a"), b = draft(call, "b");
    await Promise.all([a.sync(), b.sync()]);
    a.replaceText("甲原文"); b.replaceText("乙原文");
    await a.sync(); await b.sync(); await a.sync();
    expect(a.text()).toBe("乙原文");
    expect(b.text()).toBe("乙原文");
    const count = writes; await draft(call, "a").sync(); expect(writes).toBe(count);
  });
  it("preserves an uncertain save's request and edits made while it was in flight", async () => {
    const sent: Record<string, unknown>[] = []; let fail = true;
    let release: (() => void) | undefined;
    const call = (async (action: string, params: Record<string, unknown> = {}) => {
      if (action === "document_read") return { revision: "start", data: { text: "原文" } };
      sent.push(params);
      if (fail) throw new Error("连接断开");
      await new Promise<void>(resolve => { release = resolve; });
      return { revision: "written" };
    }) as Call;
    const a = draft(call, "a"); await a.sync(); a.replaceText("first"); await a.sync();
    expect(a.snapshot().error).toBe("连接断开");
    await a.sync(); expect(sent).toHaveLength(1);
    fail = false; const pending = a.sync(true); a.replaceText("second"); release!(); await pending;
    expect(sent[0].request).toBe(sent[1].request); expect(sent[1].text).toBe("first");
    expect(a.text()).toBe("second");
  });
  it("keeps ten local drags and resize interactive while the first receipt is delayed", async () => {
    let finish!: (value: unknown) => void, sequence = 0;
    let positions = { n: { x: 0, y: 0, width: 400, height: 300 } };
    const actions: string[] = [];
    const call = (async (action: string, params: Record<string, any> = {}) => {
      actions.push(action);
      if (action === "layout_read") return { revision: String(sequence), sequence, positions: structuredClone(positions) };
      const edit = params.data.edits.n;
      positions = { n: { ...positions.n, ...edit.position, ...edit.size } }; sequence++;
      const receipt = { status: "merged", layout: { revision: String(sequence), sequence, positions: structuredClone(positions) } };
      if (sequence === 1) return new Promise<unknown>(resolve => { finish = () => resolve(receipt); });
      return receipt;
    }) as Call;
    const layout = draft(call, "continuous", "layout"); await layout.sync();
    const saves: Promise<boolean>[] = [];
    for (let i = 1; i <= 10; i++) {
      expect(layout.beginMove()).toBe(true);
      saves.push(layout.endMove("n", { x: i * 10, y: i * 20 }, ["position"]));
      expect(layout.positions.get("n")).toMatchObject({ x: i * 10, y: i * 20 });
    }
    expect(layout.beginMove()).toBe(true);
    saves.push(layout.endMove("n", { x: 100, y: 200, width: 600, height: 500 }, ["size"]));
    expect(actions.filter(action => action === "layout_patch")).toHaveLength(1);
    finish(null); await Promise.all(saves);
    expect(layout.positions.get("n")).toEqual({ x: 100, y: 200, width: 600, height: 500 });
    expect(layout.snapshot().pending).toBe(false);
    expect(actions).not.toContain("layout_lease");
    expect(actions).not.toContain("layout_release");
  });
  it("never lets an old read or receipt remove a newer optimistic gesture", async () => {
    let read!: (value: unknown) => void, move!: (value: unknown) => void, reads = 0;
    const call = (async (action: string) => {
      if (action === "layout_read") return ++reads === 1 ? { revision: "0", sequence: 0, positions: { n: { x: 0, y: 0 } } } : new Promise<unknown>(resolve => { read = resolve; });
      return new Promise<unknown>(resolve => { move = resolve; });
    }) as Call;
    const layout = draft(call, "old-read", "layout"); await layout.sync();
    const reading = layout.sync(); layout.beginMove(); const first = layout.endMove("n", { x: 10, y: 20 });
    layout.beginMove(); const second = layout.endMove("n", { x: 30, y: 40 });
    move({ status: "merged", layout: { revision: "1", sequence: 1, positions: { n: { x: 10, y: 20 } } } }); await first;
    expect(layout.positions.get("n")).toEqual({ x: 30, y: 40 });
    read({ revision: "0", sequence: 0, positions: { n: { x: 0, y: 0 } } }); await reading;
    expect(layout.positions.get("n")).toEqual({ x: 30, y: 40 });
    move({ status: "merged", layout: { revision: "2", sequence: 2, positions: { n: { x: 30, y: 40 } } } }); await second;
    expect(layout.revision).toBe("2");
  });
  it("preserves an uncertain operation across reload and retries the same id explicitly", async () => {
    let fail = true; const sent: Record<string, any>[] = [];
    const call = (async (action: string, params: Record<string, any> = {}) => {
      if (action === "layout_read") return { revision: "0", sequence: 0, positions: { n: { x: 0, y: 0 } } };
      sent.push(params); if (fail) throw new Error("offline");
      return { status: "merged", layout: { revision: "1", sequence: 1, positions: { n: params.data.edits.n.position } } };
    }) as Call;
    const first = draft(call, "durable", "layout"); await first.sync(); first.beginMove(); await first.endMove("n", { x: 10, y: 20 }); first.close();
    const restored = draft(call, "durable", "layout"); await restored.sync();
    expect(restored.positions.get("n")).toEqual({ x: 10, y: 20 }); expect(sent).toHaveLength(1);
    fail = false; await restored.sync(true); await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(restored.snapshot().error).toBe("");
  });
  it("queues automatic layout with a per-node baseline without locking subsequent moves", async () => {
    let finish!: (value: unknown) => void;
    const sent: { action: string; params: Record<string, unknown> }[] = [];
    const call = (async (action: string, params: Record<string, unknown> = {}) => {
      sent.push({ action, params });
      if (action === "layout_read") return { revision: "0", sequence: 0, positions: { n: { x: 0, y: 0 } } };
      if (action === "layout_arrange") return new Promise<unknown>(resolve => { finish = resolve; });
      return { status: "merged", layout: { revision: "2", sequence: 2, positions: { n: { x: 30, y: 40 } } } };
    }) as Call;
    const layout = draft(call, "auto", "layout"); await layout.sync(); const arranged = layout.arrange("tree", ["n"]);
    expect(layout.beginMove()).toBe(true); const moved = layout.endMove("n", { x: 30, y: 40 });
    finish({ status: "merged", layout: { revision: "1", sequence: 1, positions: { n: { x: 100, y: 100 } } } }); await arranged;
    expect(layout.positions.get("n")).toEqual({ x: 30, y: 40 }); await moved;
    expect(sent.find(item => item.action === "layout_arrange")?.params).toMatchObject({ data: { base: { n: { x: 0, y: 0 } }, mode: "tree" } });
  });
  it("undoes a resize back to the original default dimensions and clears its pin", async () => {
    let position: Record<string, unknown> = { x: 0, y: 0 }, sequence = 0;
    const call = (async (action: string, params: Record<string, any> = {}) => {
      if (action !== "layout_read") { const edit = params.data.edits.n; position = { ...position, ...edit.position, ...edit.size, ...(edit.pinned === undefined ? {} : { pinned: edit.pinned }) }; sequence++; }
      return { status: "merged", layout: { revision: String(sequence), sequence, positions: { n: position } }, revision: String(sequence), sequence, positions: { n: position } };
    }) as Call;
    const layout = draft(call, "undo", "layout"); await layout.sync(); layout.beginMove();
    await layout.endMove("n", { x: 0, y: 0, width: 600, height: 500, pinned: true }, ["size", "pinned"], { x: 0, y: 0, width: 380, height: 230 });
    expect(await layout.undo()).toBe(true);
    expect(layout.positions.get("n")).toEqual({ x: 0, y: 0, width: 380, height: 230, pinned: false });
  });

});

it("moves and undoes a multi-selection atomically and persists routing in the same layout queue", async () => {
  let positions: Record<string, any> = { a: { x: 0, y: 0 }, b: { x: 300, y: 50 } }, edgePorts: Record<string, any> = {}, sequence = 0;
  const submitted: Record<string, any>[] = [];
  const call = (async (action: string, params: Record<string, any> = {}) => {
    if (action === "layout_read") return { revision: String(sequence), sequence, positions, edgePorts };
    submitted.push(params.data);
    positions = { ...positions }; edgePorts = { ...edgePorts };
    for (const [id, edit] of Object.entries(params.data.edits) as [string, any][]) positions[id] = { ...positions[id], ...edit.position };
    for (const [id, ports] of Object.entries(params.data.ports ?? {})) edgePorts[id] = ports;
    return { status: "merged", layout: { revision: String(++sequence), sequence, positions, edgePorts } };
  }) as Call;
  const doc = draft(call, "selection", "layout"); await doc.sync(); doc.beginMove();
  const saved = doc.endMoves({ a: { x: 70, y: 80 }, b: { x: 370, y: 130 } });
  expect(doc.positions.get("b")!.x - doc.positions.get("a")!.x).toBe(300);
  await saved; expect(submitted[0].edits).toEqual({ a: { position: { x: 70, y: 80 } }, b: { position: { x: 370, y: 130 } } });
  await doc.undo(); expect(doc.positions.get("a")).toEqual({ x: 0, y: 0 }); expect(doc.positions.get("b")).toEqual({ x: 300, y: 50 });
  await doc.routeEdge("ab", { sourceSide: "top", targetSide: "left" });
  expect(submitted[2]).toMatchObject({ basePorts: { ab: {} }, ports: { ab: { sourceSide: "top", targetSide: "left" } } });
  expect(doc.edgePorts.get("ab")).toEqual({ sourceSide: "top", targetSide: "left" });
});

it("moves a newly acknowledged node before the layout read catches up", async () => {
  let finish!: (value: unknown) => void;
  const call = (async (action: string) => action === "layout_read"
    ? { revision: "0", sequence: 0, positions: {} }
    : new Promise<unknown>(resolve => { finish = resolve; })) as Call;
  const doc = draft(call, "new-card", "layout"); await doc.sync();
  expect(doc.beginMove()).toBe(true);
  const saved = doc.endMoves({ new: { x: 80, y: 90 } }, ["position"], { new: { x: 10, y: 20 } });
  expect(doc.positions.get("new")).toEqual({ x: 80, y: 90 });
  expect(doc.beginMove()).toBe(true); void doc.endMove();
  finish({ status: "merged", layout: { revision: "1", sequence: 1, positions: { new: { x: 80, y: 90 } } } });
  expect(await saved).toBe(true);
});
