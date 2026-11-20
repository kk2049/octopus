/**
 * Append-only event log — the StateStore primitive.
 *
 * One log per (app, scope), one JSON object per line. All in-process writers
 * go through `append()`, which serializes on a per-log promise chain: two
 * concurrent dispatches queue instead of interleaving, which is the engine's
 * first line of defence against races — sequential consistency per scope by
 * construction, no locks in app code.
 *
 * Each append is a single write() of complete lines, so a crash can at worst
 * tear the final line. Reads skip a torn tail (and remember to lead the next
 * append with a newline) instead of refusing the whole log.
 *
 * `read()` stats the file before trusting its cache, so an out-of-band writer
 * degrades to a full re-parse rather than silent divergence — but the probe's
 * contract is that every writer lives in this process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type Actor, actorId, type EngineEvent, type EventInput } from "./types.js";

export type AppendListener = (events: EngineEvent[]) => void;

export class EventLog {
  private cache: EngineEvent[] = [];
  private cachedSize = -1;
  private cachedMtime = -1;
  /** File does not end with "\n" (torn tail); next append must lead with one. */
  private needsLeadingNewline = false;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<AppendListener>();

  constructor(readonly file: string) {}

  /** Current events, oldest first. Cheap when nothing changed on disk. */
  read(): readonly EngineEvent[] {
    this.refresh();
    return this.cache;
  }

  /** Events with seq strictly greater than `after`. */
  readSince(after: number): EngineEvent[] {
    this.refresh();
    return this.cache.filter((e) => e.seq > after);
  }

  /** Seq of the newest event, 0 for an empty log. */
  get revision(): number {
    this.refresh();
    return this.cache.length ? this.cache[this.cache.length - 1].seq : 0;
  }

  /**
   * Append a batch of events, stamped with seq/at/`by`. The whole batch goes
   * out in one write, so a dispatch's events are all-or-nothing on disk.
   */
  append(events: EventInput[], by: Actor): Promise<EngineEvent[]> {
    const run = this.chain.then(() => this.doAppend(events, by));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Append only if `already` says this batch is not in the log yet — the test
   * and the write happen in the SAME link of the serial chain.
   *
   * Idempotent cross-scope delivery needs exactly this: a read followed by an
   * `append()` is two links, so two concurrent deliveries of one `delivery_id`
   * both read "absent" and both write. Doing the check inside the chain makes
   * "at most one receipt per delivery id" a structural property rather than a
   * race the caller usually wins.
   */
  appendUnique(
    events: EventInput[],
    by: Actor,
    already: (existing: readonly EngineEvent[]) => boolean,
  ): Promise<{ events: EngineEvent[]; duplicate: boolean }> {
    const run = this.chain.then(() => {
      this.refresh();
      if (already(this.cache)) return { events: [] as EngineEvent[], duplicate: true };
      return { events: this.doAppend(events, by), duplicate: false };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  onAppend(cb: AppendListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private doAppend(inputs: EventInput[], by: Actor): EngineEvent[] {
    if (!inputs.length) return [];
    this.refresh();
    const at = new Date().toISOString();
    const byId = actorId(by);
    const base = this.cache.length ? this.cache[this.cache.length - 1].seq : 0;
    const out: EngineEvent[] = inputs.map((e, i) => ({
      seq: base + 1 + i,
      at,
      by: byId,
      type: e.type,
      data: e.data,
    }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = out.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(this.file, (this.needsLeadingNewline ? "\n" : "") + body, "utf8");
    this.needsLeadingNewline = false;
    const st = fs.statSync(this.file);
    this.cachedSize = st.size;
    this.cachedMtime = st.mtimeMs;
    this.cache = [...this.cache, ...out];
    for (const cb of this.listeners) {
      try {
        cb(out);
      } catch (err) {
        // A broken subscriber must not poison the append chain.
        console.error(`[engine] append listener failed for ${this.file}:`, err);
      }
    }
    return out;
  }

  private refresh(): void {
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(this.file);
    } catch {
      st = null;
    }
    if (!st) {
      this.cache = [];
      this.cachedSize = -1;
      this.cachedMtime = -1;
      this.needsLeadingNewline = false;
      return;
    }
    if (st.size === this.cachedSize && st.mtimeMs === this.cachedMtime) return;
    const text = fs.readFileSync(this.file, "utf8");
    const events: EngineEvent[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as EngineEvent);
      } catch {
        if (i === lines.length - 1 && !text.endsWith("\n")) {
          // Torn tail from a crash mid-write: skip, and remember to start the
          // next append on a fresh line so the torn fragment stays inert.
          continue;
        }
        console.error(`[engine] skipping corrupt line ${i + 1} in ${this.file}`);
      }
    }
    this.cache = events;
    this.cachedSize = st.size;
    this.cachedMtime = st.mtimeMs;
    this.needsLeadingNewline = text.length > 0 && !text.endsWith("\n");
  }
}
