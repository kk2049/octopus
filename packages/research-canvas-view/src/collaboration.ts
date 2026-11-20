import type { GraphEdgePorts, GraphPosition, LayoutSnapshot, LayoutEdit, GraphEditResult } from "@claude-bot/research-canvas-contract";
import { persist, stored, requestId, type Call } from "./client.js";
import { WHOLE_TEXT_BYTES } from "./budgets.js";
import { saveText } from "./text-save.js";
import * as Y from "yjs";
export const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
export const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value), letter => letter.charCodeAt(0));
export interface DocState { ready: boolean; pending: boolean; error: string; revision: number; notice?: string; undo?: boolean; queued?: number;
  /** Set when only the leading part of a body larger than the view's budget is loaded; it is then read-only. */
  partial?: { loaded: number; total: number } }
/**
 * Reads a body in bounded windows, every window pinned to the first one's revision.
 * Stops once `budget` bytes are loaded and says so; the file itself has no size limit.
 */
export async function readTextWindows(call: Call, node: string, budget: number): Promise<{ text: string; revision: string; loaded: number; total: number; complete: boolean }> {
  let offset = 0, revision: string | undefined, text = "";
  for (;;) {
    const result = await call<{ revision: string; data: { text: string; next?: number | null; bytes?: number } }>("document_read", { node, field: "text", offset });
    if (revision !== undefined && result.revision !== revision) throw new Error("正文在读取期间已变化，请重新读取");
    revision = result.revision; text += result.data.text;
    const next = result.data.next ?? null, total = result.data.bytes ?? offset;
    if (next === null) return { text, revision, loaded: total, total, complete: true };
    if (!Number.isSafeInteger(next) || next <= offset) throw new Error("正文分段读取进度异常，请重新读取");
    offset = next;
    if (offset >= budget) return { text, revision, loaded: offset, total, complete: false };
  }
}
interface LayoutOperation { request: string; action: "layout_patch" | "layout_arrange"; params: Record<string, unknown>; edits?: Record<string, LayoutEdit>; ports?: Record<string, GraphEdgePorts> }
interface Draft { text: string; dirty: boolean; outgoing?: { request: string; text: string } }
/** Local file draft and imperative layout controller. No text CRDT crosses the wire. */
export class CanvasDocument {
  private state: DocState = { ready: false, pending: false, error: "", revision: 0 };
  private readonly listeners = new Set<() => void>();
  private body = "";
  readonly positions = new Map<string, GraphPosition>();
  readonly edgePorts = new Map<string, GraphEdgePorts>();
  revision = "";
  private dirty = false;
  private outgoing?: Draft["outgoing"];
  private inFlight: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private closed = false;
  private gesture?: Map<string, GraphPosition>;
  private trusted: LayoutSnapshot = { revision: "", positions: {} };
  private queue: LayoutOperation[] = [];
  private sending = false;
  private layoutGeneration = 0;
  private syncAgain = false;
  private completions = new Map<string, (accepted: boolean) => void>();
  private undoEdit?: { points: Record<string, GraphPosition>; fields: (keyof LayoutEdit)[] };
  private budget = WHOLE_TEXT_BYTES;
  constructor(private readonly call: Call, readonly node: string, readonly field: "text" | "layout", private readonly key: string) {
    if (field === "layout") {
      this.queue = stored<LayoutOperation[]>(key + ":operations", []);
      if (this.queue.length) this.state.error = "有未确认的本地布局；重试会核对原请求，或可放弃本地调整";
    }
    const saved = stored<Draft & { update?: string } | null>(key, null);
    if (saved && field === "text") {
      if (typeof saved.text === "string") { this.body = saved.text; this.dirty = saved.dirty; this.outgoing = saved.outgoing; }
      else if (saved.update && saved.dirty) {
        const legacy = new Y.Doc();
        try { Y.applyUpdate(legacy, fromBase64(saved.update)); this.body = legacy.getText("text").toString(); this.dirty = true; }
        catch { this.state.error = "旧本地草稿无法读取，请保留浏览器数据"; }
        finally { legacy.destroy(); }
      }
    }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (): DocState => this.state;
  text = (): string => this.body;
  private save(): void { if (this.field === "text") persist(this.key, { text: this.body, dirty: this.dirty, outgoing: this.outgoing }); else persist(this.key + ":operations", this.queue); }
  private publish(patch: Partial<DocState>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...patch, queued: this.queue.length, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.sync(); }, 650);
  }
  replaceText(value: string): void {
    // Saving a partly loaded body would cut the file; it stays read-only until loaded whole.
    if (this.state.partial) { this.publish({ error: "正文只载入了前一部分供阅读，不能在此保存；请先「载入全部」" }); return; }
    this.body = value; this.dirty = true; this.save(); this.publish({}); this.schedule();
  }
  /** Lifts the view budget for this body, on request. */
  loadAll(): Promise<void> { this.budget = Number.POSITIVE_INFINITY; return this.sync(true); }
  private acceptLayout(layout: LayoutSnapshot): void {
    if (layout.sequence !== undefined && this.trusted.sequence !== undefined && layout.sequence < this.trusted.sequence) return;
    this.trusted = layout; this.revision = layout.revision; this.projectLayout();
  }
  private projectLayout(): void {
    this.positions.clear();
    this.edgePorts.clear();
    for (const [id, ports] of Object.entries(this.trusted.edgePorts ?? {})) this.edgePorts.set(id, ports);
    for (const op of this.queue) for (const [id, ports] of Object.entries(op.ports ?? {})) this.edgePorts.set(id, { ...this.edgePorts.get(id), ...ports });
    for (const [id, point] of Object.entries(this.trusted.positions)) this.positions.set(id, point);
    for (const op of this.queue) for (const [id, edit] of Object.entries(op.edits ?? {})) {
      const current = this.positions.get(id) ?? (op.params.base as Record<string, GraphPosition> | undefined)?.[id];
      if (current) this.positions.set(id, { ...current, ...edit.position, ...edit.size, ...(edit.pinned === undefined ? {} : { pinned: edit.pinned }) });
    }
  }
  sync = (retry = false): Promise<void> => {
    if (this.closed || this.state.error && !retry && this.state.ready) return Promise.resolve();
    if (retry) { this.publish({ error: "" }); if (this.field === "layout") void this.drain(); }
    if (this.inFlight) { this.syncAgain = true; return this.inFlight; }
    this.syncAgain = false;
    const generation = this.generation, layoutGeneration = this.layoutGeneration;
    this.inFlight = (async () => {
      this.publish({ pending: this.field === "text" || this.queue.length > 0, ...(this.field === "text" ? { error: "" } : {}) });
      try {
        if (this.field === "layout") {
          const layout = await this.call<LayoutSnapshot>("layout_read");
          if (generation === this.generation && (layout.sequence !== undefined || layoutGeneration === this.layoutGeneration)) this.acceptLayout(layout);
        } else if (this.dirty || this.outgoing) {
          this.outgoing ??= { request: requestId(), text: this.body }; this.save();
          const sent = this.outgoing;
          // A body of any size: one call, or staged past one call's window.
          const result = await saveText<{ revision: string }>(this.call, "document_write", { node: this.node, request: sent.request }, sent.text);
          if (generation !== this.generation) return;
          this.revision = result.revision; this.dirty = this.body !== sent.text; this.outgoing = undefined; this.save();
        } else {
          const result = await readTextWindows(this.call, this.node, this.budget);
          if (generation !== this.generation) return;
          if (!this.dirty) {
            this.body = result.text; this.revision = result.revision; this.save();
            this.publish({ partial: result.complete ? undefined : { loaded: result.loaded, total: result.total } });
          }
        }
        this.publish({ ready: true });
      } catch (error) { if (generation === this.generation) this.publish({ error: error instanceof Error ? error.message : "保存失败，草稿已保留" }); }
      finally { if (generation === this.generation) this.publish({ pending: this.field === "layout" && this.queue.length > 0 }); }
    })().finally(() => {
      this.inFlight = null;
      if (this.closed || generation !== this.generation || this.state.error) return;
      if (this.field === "layout" && retry) void this.drain();
      if (this.syncAgain) { this.syncAgain = false; void this.sync(); }
      else if (this.dirty) this.schedule();
    });
    return this.inFlight;
  };
  /** Pointer gestures are entirely local. Synchronization never gates admission. */
  beginMove(): boolean {
    if (this.gesture || this.closed || !this.state.ready || this.field !== "layout" || this.queue.length >= 512) return false;
    this.gesture = new Map(this.positions);
    return true;
  }
  endMove(node?: string, point?: GraphPosition, fields: (keyof LayoutEdit)[] = ["position", "size", "pinned"], original?: GraphPosition): Promise<boolean> {
    return this.endMoves(node && point ? { [node]: point } : {}, fields, node && original ? { [node]: original } : undefined);
  }
  /** One durable action for the complete selection; relative positions cannot split across receipts. */
  endMoves(points: Record<string, GraphPosition>, fields: (keyof LayoutEdit)[] = ["position"], originals?: Record<string, GraphPosition>): Promise<boolean> {
    const gesture = this.gesture; this.gesture = undefined;
    if (!gesture) return Promise.resolve(false);
    const edits: Record<string, LayoutEdit> = {}, baseline: Record<string, GraphPosition> = {}, undo: Record<string, GraphPosition> = {};
    for (const [node, point] of Object.entries(points)) {
      const base = originals?.[node] ?? gesture.get(node) ?? this.positions.get(node) ?? point, edit: LayoutEdit = {};
      if (fields.includes("position") && (base.x !== point.x || base.y !== point.y)) edit.position = { x: point.x, y: point.y };
      if (fields.includes("size") && point.width !== undefined && point.height !== undefined && (base.width !== point.width || base.height !== point.height)) edit.size = { width: point.width, height: point.height };
      if (fields.includes("pinned") && base.pinned !== point.pinned) edit.pinned = point.pinned ?? false;
      if (!Object.keys(edit).length) continue;
      edits[node] = edit; baseline[node] = base; undo[node] = originals?.[node] ?? base;
    }
    if (!Object.keys(edits).length) return Promise.resolve(true);
    this.undoEdit = { points: undo, fields }; this.publish({ undo: true });
    return this.enqueue({ request: requestId(), action: "layout_patch", params: { base: baseline }, edits });
  }
  undo(): Promise<boolean> {
    const undo = this.undoEdit;
    if (!undo || !this.beginMove()) return Promise.resolve(false);
    const result = this.endMoves(undo.points, undo.fields);
    this.undoEdit = undefined; this.publish({ undo: false });
    return result;
  }
  routeEdge(edge: string, ports: GraphEdgePorts): Promise<boolean> {
    if (this.closed || !this.state.ready) return Promise.resolve(false);
    return this.enqueue({ request: requestId(), action: "layout_patch", params: { base: {}, basePorts: { [edge]: this.edgePorts.get(edge) ?? {} } }, edits: {}, ports: { [edge]: ports } });
  }
  arrange(mode: "tree" | "compact", nodes: string[], resetPins = false): Promise<boolean> {
    if (this.closed || !this.state.ready) return Promise.resolve(false);
    if (resetPins) {
      const pinned = nodes.filter(node => this.positions.get(node)?.pinned);
      if (pinned.length) {
        const base = Object.fromEntries(pinned.map(node => [node, this.positions.get(node)!]));
        // Queue before arrange so a retained old pin cannot leave cards overlapping.
        void this.enqueue({ request: requestId(), action: "layout_patch", params: { base }, edits: Object.fromEntries(pinned.map(node => [node, { pinned: false }])) });
      }
    }
    const base = Object.fromEntries(nodes.flatMap(node => this.positions.has(node) ? [[node, this.positions.get(node)]] : []));
    return this.enqueue({ request: requestId(), action: "layout_arrange", params: { nodes, mode, base, revision: this.revision } });
  }
  private enqueue(operation: LayoutOperation): Promise<boolean> {
    this.queue.push(operation); this.layoutGeneration++; this.projectLayout(); this.save(); this.publish({ pending: true });
    const completion = new Promise<boolean>(resolve => this.completions.set(operation.request, resolve));
    void this.drain(); return completion;
  }
  private async drain(): Promise<void> {
    if (this.sending || this.closed || this.state.error) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.closed) {
        const op = this.queue[0];
        try {
          const result = await this.call<GraphEditResult & { layout: LayoutSnapshot; error?: { message?: string } }>(op.action, { request: op.request, data: { ...op.params, ...(op.edits ? { edits: op.edits } : {}), ...(op.ports ? { ports: op.ports } : {}) } });
          if (this.closed) return;
          if ((result.status as string) === "rejected" || !result.layout) throw new Error(result.error?.message ?? "布局未确认");
          this.queue.shift(); this.layoutGeneration++; this.acceptLayout(result.layout); this.save();
          this.completions.get(op.request)?.(true); this.completions.delete(op.request);
          this.publish({ pending: this.queue.length > 0, notice: result.conflicts?.length ? "同一卡片有并发调整，已合并；可撤销本次调整" : result.issues?.[0]?.message ?? "" });
        } catch (reason) {
          if (!this.closed) { this.publish({ error: `${reason instanceof Error ? reason.message : "同步失败"}；本地调整已保留`, pending: false }); this.completions.get(op.request)?.(false); this.completions.delete(op.request); }
          break;
        }
      }
    } finally { this.sending = false; }
  }
  discardLayout(): void {
    if (this.sending) return;
    for (const complete of this.completions.values()) complete(false);
    this.completions.clear(); this.queue = []; this.projectLayout(); this.save(); this.publish({ error: "", pending: false });
    void this.sync(true);
  }
  close(): void {
    this.closed = true; this.generation++; clearTimeout(this.timer);
    this.gesture = undefined; this.save(); this.listeners.clear();
    for (const complete of this.completions.values()) complete(false);
    this.completions.clear();
  }
}
