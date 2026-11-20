import { EventEmitter } from "node:events";
import { type FSWatcher, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENUMERATION_CACHE_TTL_MS } from "@claude-bot/plugin-sessions/scan";
import { FRONTIER_LOOKBACK as CONTRACT_FRONTIER_LOOKBACK } from "@claude-bot/dashboard-web/live-contract";
import { describe, expect, it, vi } from "vitest";
import {
  FRONTIER_LOOKBACK,
  LiveRegistry,
  SessionTailer,
  buildDelta,
  decodeCursor,
  encodeCursor,
  hasUnpairedTool,
  openLocalTail,
  unstableFrontier,
  type TailSource,
  type TailState,
} from "./live.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

const text = (t: string) => ({ role: "assistant", blocks: [{ type: "text", text: t }] });
const pairedTool = () => ({ role: "assistant", blocks: [{ type: "tool", tool: "Bash", input: "x", output: "ok" }] });
const openTool = () => ({ role: "assistant", blocks: [{ type: "tool", tool: "Bash", input: "x" }] });
const state = (messages: unknown[], offset = 0, total = offset + messages.length): TailState => ({
  offset,
  total,
  messages,
});

describe("hasUnpairedTool", () => {
  it("distinguishes open tools from paired/none", () => {
    expect(hasUnpairedTool(openTool())).toBe(true);
    expect(hasUnpairedTool(pairedTool())).toBe(false);
    expect(hasUnpairedTool(text("hi"))).toBe(false);
    expect(hasUnpairedTool(undefined)).toBe(false);
  });
});

describe("unstableFrontier", () => {
  it("uses the exact Dashboard client/server contract constant", () => {
    expect(FRONTIER_LOOKBACK).toBe(CONTRACT_FRONTIER_LOOKBACK);
  });

  it("returns total when everything is settled", () => {
    expect(unstableFrontier(state([text("a"), pairedTool()]))).toBe(2);
  });

  it("points at the earliest in-flight tool", () => {
    expect(unstableFrontier(state([text("a"), openTool(), openTool()]))).toBe(1);
  });

  it("ignores unpaired tools older than the lookback (dead pairs)", () => {
    const msgs = [openTool(), ...Array.from({ length: FRONTIER_LOOKBACK }, () => text("x"))];
    expect(unstableFrontier(state(msgs))).toBe(msgs.length);
  });

  it("uses absolute indices for a runner page window", () => {
    // window holds messages 100..102 of a 103-message session
    expect(unstableFrontier(state([text("a"), openTool(), text("b")], 100))).toBe(101);
  });
});

describe("activity on the wire", () => {
  const busy = { state: "tool" as const, tool: "Bash", since: "2026-07-25T10:00:00Z" };

  it("rides along with every delta so a thinking session isn't a blank tail", () => {
    const d = buildDelta({ ...state([text("m0")]), activity: busy }, 0, 0);
    expect(d.activity).toEqual(busy);
  });

  it("stays absent when the source can't say (old Runner) — the client degrades", () => {
    expect(buildDelta(state([text("m0")]), 0, 0).activity).toBeUndefined();
  });

  it("reaches subscribers through the tailer", async () => {
    const s = scriptedSource();
    const tailer = new SessionTailer(s.src, 60_000, () => {});
    s.set({ ...state([text("m0"), openTool()]), activity: busy });
    const res = fakeRes();
    await tailer.subscribe(res as never, 0, 0);
    expect(deltasOf(res)[0].activity).toEqual(busy);
    res.emitClose();
  });
});

describe("agent interaction state on the wire", () => {
  it("rides independently from transcript messages and can be explicitly cleared", () => {
    const runtime = { turn_state: "needs_input", interaction: { id: "ai_1" } };
    expect(buildDelta({ ...state([text("m0")]), runtime }, 1, 1).runtime).toEqual(runtime);
    expect(buildDelta({ ...state([text("m0")]), runtime: null }, 1, 1)).toMatchObject({ runtime: null });
  });
});

describe("buildDelta", () => {
  const st = state([text("m0"), text("m1"), text("m2"), text("m3")]);

  it("resends from min(frontier, sent)", () => {
    const d = buildDelta(st, 3, 2);
    expect(d.from).toBe(2);
    expect(d.total).toBe(4);
    expect(d.messages).toHaveLength(2);
  });

  it("clamps to total when the file shrank under the client", () => {
    const d = buildDelta(st, 9, 9);
    expect(d.from).toBe(4);
    expect(d.messages).toHaveLength(0);
  });

  it("cannot serve below the window offset — client detects the gap", () => {
    const windowed = state([text("m100"), text("m101")], 100, 102);
    const d = buildDelta(windowed, 5, 5);
    expect(d.from).toBe(100); // > client's 5 messages → client falls back to reload
    expect(d.messages).toHaveLength(2);
  });
});

describe("cursor", () => {
  it("round-trips and rejects garbage", () => {
    expect(decodeCursor(encodeCursor(7, 42))).toEqual({ frontier: 7, total: 42 });
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("1:2:3")).toBeNull();
  });
});

describe("openLocalTail", () => {
  it("keeps the source constructible while a newly announced log is still undiscoverable", async () => {
    vi.useFakeTimers();
    const home = mkdtempSync(join(tmpdir(), "octopus-live-late-log-"));
    const id = "00000000-0000-4000-8000-000000000144";
    let source: TailSource | undefined;
    try {
      // The old eager resolver rejected here. In production startSse converted
      // that rejection to a terminal `err`, so no later file could wake the
      // already-open ticket page.
      source = await openLocalTail(home, "codex", id);
      await expect(source.fetch()).rejects.toThrow(`session not found for id: ${id}`);

      const dir = join(home, ".codex", "sessions", "2026", "08", "15");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `rollout-2026-08-15T14-00-00-${id}.jsonl`),
        [
          JSON.stringify({
            timestamp: "2026-08-15T14:00:00.000Z",
            type: "session_meta",
            payload: { id, cwd: "/worktree" },
          }),
          JSON.stringify({
            timestamp: "2026-08-15T14:00:01.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "后续进展" },
          }),
        ].join("\n"),
      );

      // Session discovery intentionally has a short cache. Once it expires,
      // the SAME source (and therefore the same SSE subscriber) finds the log.
      vi.advanceTimersByTime(ENUMERATION_CACHE_TTL_MS + 1);
      await expect(source.fetch()).resolves.toMatchObject({
        total: 1,
        messages: [{ role: "assistant", blocks: [{ type: "text", text: "后续进展" }] }],
      });
    } finally {
      source?.close();
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("turns an asynchronous watcher error into the existing poll fallback", async () => {
    const home = mkdtempSync(join(tmpdir(), "octopus-live-watch-error-"));
    const id = "00000000-0000-4000-8000-000000000145";
    const dir = join(home, ".codex", "sessions", "2026", "08", "15");
    const path = join(dir, `rollout-2026-08-15T14-00-00-${id}.jsonl`);
    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    watcher.close = vi.fn();
    vi.mocked(watch).mockReturnValueOnce(watcher as unknown as FSWatcher);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({
      timestamp: "2026-08-15T14:00:00.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "before" },
    }));

    const source = await openLocalTail(home, "codex", id);
    try {
      await expect(source.fetch()).resolves.toMatchObject({ total: 1 });
      expect(() => watcher.emit("error", new Error("inotify failed"))).not.toThrow();
      expect(watcher.close).toHaveBeenCalledOnce();

      // The watcher is gone, but the next ordinary poll still observes the
      // append through stat/read, which is the intended degradation path.
      writeFileSync(path, [
        JSON.stringify({
          timestamp: "2026-08-15T14:00:00.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "before" },
        }),
        JSON.stringify({
          timestamp: "2026-08-15T14:00:01.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "after" },
        }),
      ].join("\n"));
      await expect(source.fetch()).resolves.toMatchObject({ total: 2 });
    } finally {
      source.close();
      // `error` cleared the stored watcher, so closing the source is idempotent.
      expect(watcher.close).toHaveBeenCalledOnce();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── Tailer end-to-end with a scripted source and fake responses ──

interface FakeRes {
  chunks: string[];
  closed: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  handlers: Record<string, Array<() => void>>;
  write(c: string): boolean;
  end(): void;
  on(ev: string, cb: () => void): void;
  emitClose(): void;
  emitError(): void;
  emitFinish(): void;
}

function fakeRes(): FakeRes {
  return {
    chunks: [],
    closed: false,
    writableEnded: false,
    destroyed: false,
    handlers: {},
    write(c: string) {
      this.chunks.push(c);
      return true;
    },
    end() {
      this.closed = true;
      this.writableEnded = true;
      this.emitFinish();
    },
    on(ev: string, cb: () => void) {
      (this.handlers[ev] ??= []).push(cb);
    },
    emitClose() {
      for (const handler of this.handlers["close"] ?? []) handler();
    },
    emitError() {
      for (const handler of this.handlers["error"] ?? []) handler();
    },
    emitFinish() {
      for (const handler of this.handlers["finish"] ?? []) handler();
    },
  };
}

function deltasOf(res: FakeRes): Array<{ from: number; total: number; messages: unknown[]; activity?: unknown }> {
  return res.chunks
    .filter((c) => c.includes("event: delta"))
    .map((c) => JSON.parse(c.split("data: ")[1].split("\n")[0]));
}

function scriptedSource(): { src: TailSource; set(st: TailState): void; hint(): void; closed(): boolean } {
  let next: TailState | null = null;
  let hintCb: (() => void) | null = null;
  let closed = false;
  return {
    src: {
      async fetch() {
        const out = next;
        next = null;
        return out;
      },
      close() {
        closed = true;
      },
      onHint(cb) {
        hintCb = cb;
      },
    },
    set(st) {
      next = st;
    },
    hint() {
      hintCb?.();
    },
    closed: () => closed,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SessionTailer", () => {
  it("omits a large unchanged open tool on activity changes but delivers its later result", async () => {
    const s = scriptedSource();
    const tailer = new SessionTailer(s.src, 60_000, () => {});
    const large = { ...openTool(), detail: "long tool input ".repeat(40_000) };
    const res = fakeRes();
    s.set(state([large]));
    await tailer.subscribe(res as never, 0, 0);
    const initialBytes = Buffer.byteLength(res.chunks.at(-1)!);

    s.set({ ...state([large]), activity: { state: "tool", tool: "Bash", since: "2026-09-22T00:00:00Z" } });
    s.hint();
    await tick();
    expect(deltasOf(res).at(-1)).toMatchObject({ from: 1, total: 1, messages: [], activity: { state: "tool" } });
    expect(Buffer.byteLength(res.chunks.at(-1)!)).toBeLessThan(initialBytes / 100);
    // Last-Event-ID still covers the unfinished tool if this connection drops.
    expect(res.chunks.at(-1)).toContain("id: 0:1");

    s.set(state([pairedTool()]));
    s.hint();
    await tick();
    expect(deltasOf(res).at(-1)).toMatchObject({ from: 0, messages: [pairedTool()] });
    res.emitClose();
  });

  it("sends only new suffixes after unchanged open tools and replays them for a fresh subscriber", async () => {
    const s = scriptedSource();
    const tailer = new SessionTailer(s.src, 60_000, () => {});
    const res = fakeRes();
    s.set(state([openTool(), text("existing")]));
    await tailer.subscribe(res as never, 0, 0);
    s.set(state([openTool(), text("existing"), text("new")]));
    s.hint();
    await tick();
    expect(deltasOf(res).at(-1)).toEqual({ from: 2, total: 3, messages: [text("new")] });

    const resumed = fakeRes();
    await tailer.subscribe(resumed as never, 3, 0);
    expect(deltasOf(resumed)[0]).toEqual({ from: 0, total: 3, messages: [openTool(), text("existing"), text("new")] });
    s.set(state([pairedTool(), text("existing"), text("new")]));
    s.hint();
    await tick();
    expect(deltasOf(res).at(-1)?.from).toBe(0);
    expect(deltasOf(resumed).at(-1)).toEqual(deltasOf(res).at(-1));
    res.emitClose();
    resumed.emitClose();
  });

  it("detects in-place source changes instead of trusting object identity", async () => {
    const s = scriptedSource();
    const tailer = new SessionTailer(s.src, 60_000, () => {});
    const message = { ...openTool(), detail: "before" };
    const res = fakeRes();
    s.set(state([message]));
    await tailer.subscribe(res as never, 0, 0);
    message.detail = "after";
    s.set(state([message]));
    s.hint();
    await tick();
    expect(deltasOf(res).at(-1)).toMatchObject({ from: 0, messages: [{ detail: "after" }] });
    res.emitClose();
  });

  it("syncs a fresh subscriber immediately, streams increments, shares state, and tears down", async () => {
    const s = scriptedSource();
    let emptied = false;
    const tailer = new SessionTailer(s.src, 60_000, () => {
      emptied = true;
    });

    s.set(state([text("m0"), openTool()]));
    const a = fakeRes();
    await tailer.subscribe(a as never, 0, 0);
    expect(deltasOf(a)).toEqual([{ from: 0, total: 2, messages: [text("m0"), openTool()] }]);

    // Second subscriber arrives later with history already loaded (sent=2),
    // its own frontier at the open tool (1) — gets only the unstable region.
    const b = fakeRes();
    await tailer.subscribe(b as never, 2, 1);
    expect(deltasOf(b)[0].from).toBe(1);

    // The open tool gets its output and a new message lands: both clients
    // must be resent from index 1 (their recorded frontier).
    s.set(state([text("m0"), pairedTool(), text("m2")]));
    s.hint();
    await tick();
    const lastA = deltasOf(a).at(-1)!;
    expect(lastA.from).toBe(1);
    expect(lastA.total).toBe(3);
    expect(lastA.messages).toEqual([pairedTool(), text("m2")]);
    expect(deltasOf(b).at(-1)).toEqual(lastA);

    // Now everything is settled → recorded frontier equals total, so the next
    // delta only carries genuinely new messages.
    s.set(state([text("m0"), pairedTool(), text("m2"), text("m3")]));
    s.hint();
    await tick();
    expect(deltasOf(a).at(-1)!.from).toBe(3);

    a.emitClose();
    expect(emptied).toBe(false);
    b.emitClose();
    expect(emptied).toBe(true);
    expect(s.closed()).toBe(true);
    expect(tailer.destroyed).toBe(true);
  });

  it("registry retries when a subscription races teardown", async () => {
    const reg = new LiveRegistry();
    let made = 0;
    const res = fakeRes();
    await reg.subscribe(
      "k",
      async () => {
        made++;
        const s = scriptedSource();
        s.set(state([text("m0")]));
        return { src: s.src, intervalMs: 60_000 };
      },
      res as never,
      0,
      0,
    );
    expect(made).toBe(1);
    expect(deltasOf(res)).toHaveLength(1);
    res.emitClose(); // last subscriber → tailer destroyed, registry emptied

    const res2 = fakeRes();
    await reg.subscribe(
      "k",
      async () => {
        made++;
        const s = scriptedSource();
        s.set(state([text("m0"), text("m1")]));
        return { src: s.src, intervalMs: 60_000 };
      },
      res2 as never,
      0,
      0,
    );
    expect(made).toBe(2); // fresh tailer, not the destroyed one
    expect(deltasOf(res2)[0].total).toBe(2);
    reg.destroyAll();
  });

  it("drops an errored response immediately and destroys the last subscriber's timers", async () => {
    const source = scriptedSource();
    let emptied = false;
    const tailer = new SessionTailer(source.src, 60_000, () => {
      emptied = true;
    });
    source.set(state([text("m0")]));
    const response = fakeRes();
    await tailer.subscribe(response as never, 0, 0);

    response.emitError();

    expect(tailer.destroyed).toBe(true);
    expect(source.closed()).toBe(true);
    expect(emptied).toBe(true);
  });
});
