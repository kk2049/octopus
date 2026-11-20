/** Content-free completion receipts survive a disconnected Head or Runner restart. */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  runnerManagedCompletionFromWire,
  type RunnerManagedCompletion,
  type RunnerManagedCompletionAck,
} from "./gateway-protocol.js";

/** Bound reconnect traffic; receipts remain on disk for local diagnosis. */
const REPLAY_WINDOW = 4096;
const RECEIPT_NAME = /^\d{13}-([a-f0-9]{64})\.json$/;
const MARKER_NAME = /^[a-f0-9]{64}$/;

function receiptKey(provider: string, turnId: string): string {
  return createHash("sha256").update(JSON.stringify([provider, turnId])).digest("hex");
}

export class ManagedCompletionJournal {
  constructor(private readonly directory: string) {}
  async record(completion: RunnerManagedCompletion): Promise<void> {
    const event = runnerManagedCompletionFromWire(completion);
    if (!event) throw new Error("Invalid managed completion");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(
        this.directory,
        `${Date.parse(event.completed_at)}-${receiptKey(event.provider, event.turn_id)}.json`,
      ),
      temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(event));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    if (process.platform !== "win32") {
      const directory = await fs.open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }

  /** The newest receipts, minus those the named site already acknowledged. */
  async recent(site?: string): Promise<RunnerManagedCompletion[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.directory))
        .filter((name) => RECEIPT_NAME.test(name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const window = names.slice(-REPLAY_WINDOW);
    const acknowledged = site === undefined ? new Set<string>() : await this.acknowledged(site, window);
    const events: RunnerManagedCompletion[] = [];
    for (const name of window) {
      if (acknowledged.has(RECEIPT_NAME.exec(name)![1]!)) continue;
      try {
        const event = runnerManagedCompletionFromWire(
          JSON.parse(await fs.readFile(join(this.directory, name), "utf8")),
        );
        if (event) events.push(event);
      } catch {
        /* Ignore an individual damaged receipt. */
      }
    }
    return events;
  }

  /**
   * One site's receivers handled this receipt. The marker is not synced: losing
   * it only costs one more replay, which every receiver deduplicates.
   */
  async acknowledge(site: string, ack: RunnerManagedCompletionAck): Promise<void> {
    const directory = this.acknowledgements(site);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(directory, receiptKey(ack.provider, ack.turn_id)), "", { mode: 0o600 });
  }

  /** Sites are acknowledged independently: one site's Head says nothing about another's. */
  private acknowledgements(site: string): string {
    return join(this.directory, "acknowledged", createHash("sha256").update(site).digest("hex").slice(0, 32));
  }

  /** Markers for receipts still inside the replay window; older markers are removed. */
  private async acknowledged(site: string, window: readonly string[]): Promise<Set<string>> {
    const directory = this.acknowledgements(site);
    let markers: string[];
    try {
      markers = (await fs.readdir(directory)).filter((name) => MARKER_NAME.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
    }
    const current = new Set(window.map((name) => RECEIPT_NAME.exec(name)![1]!));
    const kept = new Set<string>();
    for (const marker of markers) {
      if (current.has(marker)) kept.add(marker);
      else await fs.rm(join(directory, marker), { force: true });
    }
    return kept;
  }
}
