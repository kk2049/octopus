/**
 * Live session view — server side of doc/design-session-live-view.md.
 *
 * Truth is the session JSONL file, not an event bus: "live" is an incremental
 * replay of the same file through the same parseSessionRich the static viewer
 * uses, so history and live can never render differently, and it works for
 * sessions the bot did not spawn (a laptop's own CLI run, via Runner polling).
 *
 * Delta protocol ("unstable frontier"): the raw log is append-only but the
 * PARSED messages are not — a tool call's result lands in a later line and is
 * backfilled into the earlier assistant message. Each delta therefore resends
 * the suffix from the earliest message that could still change (an already
 * delivered, content-equal prefix is skipped within one connection):
 *
 *     from = min(client's frontier, client's message count)
 *
 * where a message is "unstable" while it holds a tool block without output.
 * Only the last FRONTIER_LOOKBACK messages are considered — an unpaired tool
 * from an aborted turn hours ago will never get its result, and treating it
 * as unstable forever would resend the whole session on every change (the
 * static viewer shows those as "未记录结果", which live view then matches).
 *
 * The SSE id encodes the client state after applying a delta
 * ("frontier:total"), so a reconnect's Last-Event-ID resumes exactly — any
 * region that was unstable when the client last heard from us is resent.
 *
 * Every delta also carries `activity` (thinking / running a tool / responding
 * / idle), parsed from the same file: without it a session that is thinking
 * or blocked on a tool renders as an empty tail, indistinguishable from a
 * finished one. It is advisory — old Runners omit it and the client derives a
 * coarser state itself.
 *
 * One tailer per (user, device, source, id), shared by all subscribers via
 * refcount; the last unsubscribe destroys it (timers cleared, watcher closed).
 * Local sessions get fs.watch + a 2s poll fallback; Runner sessions are
 * polled through the existing read_session RPC — no Runner protocol change.
 */

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import {
  FRONTIER_LOOKBACK,
  hasOpenTool,
  type FrontierMessage,
} from "@claude-bot/dashboard-web/live-contract";
import {
  parseSessionRich,
  resolveSessionPath,
  type SessionScanRoot,
  type SessionActivity,
  type Source,
} from "@claude-bot/plugin-sessions/scan";
import { createLogger } from "../logger.js";
import type { TailSource, TailState } from "../sessionhub/runner-tail.js";

export { openRunnerTail } from "../sessionhub/runner-tail.js";
export type { TailSource, TailState } from "../sessionhub/runner-tail.js";

const log = createLogger("live");

export { FRONTIER_LOOKBACK };

const HEARTBEAT_MS = 20_000;

export interface LiveDelta {
  from: number;
  total: number;
  messages: unknown[];
  /**
   * Rides along with every delta so the viewer can show "thinking" / "running
   * Bash" while nothing new is being appended. Absent from old Runners — the
   * client falls back to deriving a coarse state from the messages it has.
   */
  activity?: SessionActivity;
  /** Changes independently from the append-only transcript. */
  runtime?: unknown;
}

export function hasUnpairedTool(message: FrontierMessage): boolean {
  return hasOpenTool(message);
}

/**
 * Earliest message index (absolute, not window-relative) that may still be
 * backfilled; `state.total` when everything visible is settled.
 */
export function unstableFrontier(state: TailState, lookback = FRONTIER_LOOKBACK): number {
  const end = state.offset + state.messages.length;
  const start = Math.max(state.offset, end - lookback);
  for (let i = start; i < end; i++) {
    if (hasUnpairedTool(state.messages[i - state.offset] as FrontierMessage)) return i;
  }
  return state.total;
}

/**
 * Delta for a client that holds `clientSent` messages and whose knowledge is
 * stable below `clientFrontier`. When the client is further behind than the
 * window we hold (Runner pages cap at 500), `from` lands beyond its length —
 * the client detects the gap and falls back to a full reload.
 */
export function buildDelta(state: TailState, clientSent: number, clientFrontier: number): LiveDelta {
  let from = Math.max(0, Math.min(clientFrontier, clientSent, state.total));
  if (from < state.offset) from = state.offset;
  return {
    from,
    total: state.total,
    messages: state.messages.slice(Math.max(0, from - state.offset)),
    ...(state.activity !== undefined ? { activity: state.activity } : {}),
    ...(state.runtime !== undefined ? { runtime: state.runtime } : {}),
  };
}

export function encodeCursor(frontier: number, total: number): string {
  return `${frontier}:${total}`;
}

export function decodeCursor(raw: string | string[] | undefined | null): { frontier: number; total: number } | null {
  const m = /^(\d+):(\d+)$/.exec(String(raw ?? ""));
  if (!m) return null;
  return { frontier: Number(m[1]), total: Number(m[2]) };
}

// ── Tail sources ──

/** Local bot-host session: resolve the file once, stat-gate full reparses. */
export async function openLocalTail(home: SessionScanRoot, source: Source | undefined, id: string): Promise<TailSource> {
  // Codex publishes `thread.started` before its rollout file is guaranteed to
  // be discoverable. Discovery itself is cached for a few seconds, so resolving
  // here used to turn that ordinary startup window into an in-band SSE `err`.
  // EventSource correctly treats `err` as terminal; the ticket page would then
  // show whatever its paced static read happened to catch and never receive
  // another delta until a manual refresh.
  //
  // Resolve lazily from fetch instead. SessionTailer already treats fetch
  // failures as transient and keeps its subscriber + interval alive, which is
  // exactly the lifecycle a not-yet-created append-only log needs. Permanent
  // route/auth failures still happen before this source is constructed and
  // remain terminal.
  let resolved: Awaited<ReturnType<typeof resolveSessionPath>> | null = null;
  let fingerprint = "";
  let hint: (() => void) | null = null;
  let watcher: FSWatcher | null = null;

  async function ensureResolved(): Promise<Awaited<ReturnType<typeof resolveSessionPath>>> {
    if (resolved) return resolved;
    const found = await resolveSessionPath(home, source, id, undefined);
    resolved = found;
    try {
      const current = watch(found.path, () => hint?.());
      watcher = current;
      // `fs.watch()` reports many backend failures asynchronously. Without an
      // error listener EventEmitter turns one watcher failure into a process
      // exception, even though polling is already the authoritative fallback.
      current.on("error", (err) => {
        if (watcher !== current) return;
        watcher = null;
        try { current.close(); } catch { /* already failed/closed */ }
        log.debug({ err, path: found.path }, "live file watcher failed; polling fallback remains active");
      });
    } catch {
      watcher = null; // some filesystems can't watch — the poll fallback covers
    }
    return found;
  }

  return {
    async fetch() {
      const current = await ensureResolved();
      const st = await stat(current.path);
      const fp = `${st.mtimeMs}:${st.size}`;
      if (fp === fingerprint) return null;
      const text = await readFile(current.path, "utf8");
      fingerprint = fp;
      const { meta, messages } = parseSessionRich(current.source, text);
      return { offset: 0, total: messages.length, messages, activity: meta.activity };
    },
    close() {
      const current = watcher;
      watcher = null;
      current?.close();
    },
    onHint(cb) {
      hint = cb;
    },
  };
}

// ── Tailer: one per session, fan-out to subscribers ──

interface Subscriber {
  res: ServerResponse;
  sent: number;
  frontier: number;
  /** Only content actually sent on this connection can suppress a resend. */
  fingerprints?: ReadonlyMap<number, string>;
}

export class SessionTailer {
  private subs = new Set<Subscriber>();
  private state: TailState | null = null;
  private fingerprints: ReadonlyMap<number, string> = new Map();
  private timer: NodeJS.Timeout;
  private heartbeat: NodeJS.Timeout;
  private fetching = false;
  private pendingTick = false;
  destroyed = false;

  constructor(
    private src: TailSource,
    intervalMs: number,
    private onEmpty: () => void,
  ) {
    this.src.onHint?.(() => void this.tick());
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.heartbeat = setInterval(() => {
      for (const s of [...this.subs]) this.write(s, ": ping\n\n");
    }, HEARTBEAT_MS);
    // Timers must not keep a draining process alive on their own.
    this.timer.unref?.();
    this.heartbeat.unref?.();
  }

  /** False when this tailer has already been destroyed — caller must retry with a fresh one. */
  async subscribe(res: ServerResponse, sent: number, frontier: number): Promise<boolean> {
    if (this.destroyed) return false;
    // The caller may have disconnected while the shared tailer was being
    // created. That response needs no retry and must not become a subscriber.
    if (res.writableEnded || res.destroyed) {
      if (this.subs.size === 0) this.destroy();
      return true;
    }
    const sub: Subscriber = { res, sent, frontier };
    this.subs.add(sub);
    let removed = false;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      this.unsubscribe(sub);
    };
    res.on("error", remove);
    res.on("finish", remove);
    res.on("close", remove);
    await this.tick(sub); // immediate catch-up for this subscriber
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.src.close();
    for (const s of this.subs) {
      if (s.res.writableEnded || s.res.destroyed) continue;
      try { s.res.end(); } catch { /* the response already failed */ }
    }
    this.subs.clear();
    this.onEmpty();
  }

  /**
   * Poll the source; dispatch to everyone on change, and always to a fresh
   * subscriber (`only`) so it syncs even when the file is quiet.
   */
  private async tick(only?: Subscriber): Promise<void> {
    if (this.destroyed) return;
    if (this.fetching) {
      this.pendingTick = true;
      return;
    }
    this.fetching = true;
    try {
      const next = await this.src.fetch();
      if (next) {
        this.state = next;
        // One bounded hash window shared by subscribers; never retain a second
        // copy of long tool output. Hashing also handles sources that mutate objects.
        const fingerprints = new Map<number, string>();
        const start = Math.max(0, next.messages.length - FRONTIER_LOOKBACK);
        for (let i = start; i < next.messages.length; i++) {
          fingerprints.set(next.offset + i, createHash("sha256")
            .update(JSON.stringify(next.messages[i]) ?? "null").digest("hex"));
        }
        this.fingerprints = fingerprints;
      }
      if (!this.state) return;
      const targets = only ? [only] : next ? [...this.subs] : [];
      for (const sub of targets) this.dispatch(sub);
    } catch (err) {
      // Transient (file mid-rotation, runner briefly offline): keep polling.
      log.debug({ err }, "live tail fetch failed");
    } finally {
      this.fetching = false;
      if (this.pendingTick) {
        this.pendingTick = false;
        void this.tick();
      }
    }
  }

  private dispatch(sub: Subscriber): void {
    const st = this.state!;
    const delta = buildDelta(st, sub.sent, sub.frontier);
    // The cursor stays conservative for reconnects. Within this connection,
    // skip the proven-equal prefix, including long open tools on activity-only
    // updates. Stop at the first change so the existing suffix-replace protocol
    // still delivers tool-result backfills and truncation exactly.
    let equal = 0;
    while (equal < delta.messages.length) {
      const index = delta.from + equal;
      const digest = this.fingerprints.get(index);
      if (!digest || digest !== sub.fingerprints?.get(index)) break;
      equal++;
    }
    if (equal) {
      delta.from += equal;
      delta.messages = delta.messages.slice(equal);
    }
    sub.fingerprints = this.fingerprints;
    sub.sent = st.total;
    sub.frontier = Math.min(unstableFrontier(st), st.total);
    this.write(sub, `id: ${encodeCursor(sub.frontier, sub.sent)}\nevent: delta\ndata: ${JSON.stringify(delta)}\n\n`);
  }

  private write(sub: Subscriber, chunk: string): void {
    if (!this.subs.has(sub)) return;
    if (sub.res.writableEnded || sub.res.destroyed) {
      this.unsubscribe(sub);
      return;
    }
    try {
      sub.res.write(chunk);
    } catch {
      this.unsubscribe(sub);
    }
  }

  private unsubscribe(sub: Subscriber): void {
    if (!this.subs.delete(sub)) return;
    if (this.subs.size === 0) this.destroy();
  }
}

// ── Registry: share tailers across subscribers, clean up after the last one ──

export class LiveRegistry {
  private tailers = new Map<string, Promise<SessionTailer>>();

  async subscribe(
    key: string,
    make: () => Promise<{ src: TailSource; intervalMs: number }>,
    res: ServerResponse,
    sent: number,
    frontier: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let p = this.tailers.get(key);
      if (!p) {
        p = (async () => {
          const { src, intervalMs } = await make();
          return new SessionTailer(src, intervalMs, () => {
            if (this.tailers.get(key) === p) this.tailers.delete(key);
          });
        })();
        this.tailers.set(key, p);
        p.catch(() => {
          if (this.tailers.get(key) === p) this.tailers.delete(key);
        });
      }
      const tailer = await p;
      if (await tailer.subscribe(res, sent, frontier)) return;
      // Lost the race against the last unsubscribe — retry with a fresh tailer.
      if (this.tailers.get(key) === p) this.tailers.delete(key);
    }
    throw new Error("live subscription raced tailer teardown repeatedly");
  }

  destroyAll(): void {
    for (const p of this.tailers.values()) void p.then((t) => t.destroy()).catch(() => {});
    this.tailers.clear();
  }
}
