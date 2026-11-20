/**
 * Deadlines — the lease shape as an engine primitive (the probe's answer to
 * report §5 point 4, "heavy state machines").
 *
 * An app DECLARES clocks in app.yaml:
 *
 *   deadlines:
 *     reply_nag: { start: report_received, cancel: [report_read], after_s: 259200, emit: report_overdue }
 *
 * The engine watches each instance's log: a `start` event (keyed by data.id)
 * arms a timer; any `cancel` type with the same id disarms it; if the clock
 * runs out first, the engine APPENDS the `emit` event as system:deadline.
 * Time never lives inside projections — it arrives as one more event, so
 * folds stay pure and replayable, and a restart just re-derives the pending
 * clocks from the log (overdue ones fire immediately).
 */

import type { AppInstance } from "./dispatch.js";
import type { Host } from "./host/server.js";
import type { EngineEvent } from "./types.js";

export interface DeadlineDef {
  name: string;
  start: string;
  cancel: string[];
  afterS: number;
  emit: string;
}

const idOf = (e: EngineEvent): string => String((e.data as { id?: unknown } | null)?.id ?? "");

/** Pure scan: which started ids are still pending, and when did they start. */
export function pendingDeadlines(events: readonly EngineEvent[], def: DeadlineDef): Map<string, EngineEvent> {
  const started = new Map<string, EngineEvent>();
  for (const e of events) {
    const id = idOf(e);
    if (!id) continue;
    if (e.type === def.start) started.set(id, e);
    else if (def.cancel.includes(e.type) || e.type === def.emit) started.delete(id);
  }
  return started;
}

export class DeadlineEngine {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private host: Host) {}

  attach(): void {
    this.host.onInstanceCreated((inst) => {
      this.recompute(inst);
      inst.log.onAppend(() => this.recompute(inst));
    });
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private recompute(inst: AppInstance): void {
    const defs = this.host.getManifest(inst.app)?.deadlines ?? [];
    const prefix = `${inst.app}/${inst.scope}/`;
    for (const [key, t] of this.timers) {
      if (key.startsWith(prefix)) {
        clearTimeout(t);
        this.timers.delete(key);
      }
    }
    if (!defs.length) return;
    const events = inst.log.read();
    for (const def of defs) {
      for (const [id, startEvent] of pendingDeadlines(events, def)) {
        const due = Date.parse(startEvent.at) + def.afterS * 1000;
        const delay = Math.min(Math.max(0, due - Date.now()), 2 ** 31 - 1);
        const key = `${prefix}${def.name}/${id}`;
        const timer = setTimeout(() => {
          this.timers.delete(key);
          void this.fire(inst, def, id);
        }, delay);
        timer.unref?.();
        this.timers.set(key, timer);
      }
    }
  }

  private async fire(inst: AppInstance, def: DeadlineDef, id: string): Promise<void> {
    // Re-check against the CURRENT log — a cancel may have landed while the
    // timer was in flight; the emit must never contradict the log.
    if (!pendingDeadlines(inst.log.read(), def).has(id)) return;
    try {
      await inst.log.append(
        [{ type: def.emit, data: { id, deadline: def.name } }],
        { kind: "system", name: "deadline" },
      );
    } catch (err) {
      console.error(`[engine] deadline emit failed for ${inst.app}/${inst.scope} ${def.name}/${id}:`, err);
    }
  }
}
