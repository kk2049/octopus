import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventLog } from "./store.js";
import type { Actor } from "./types.js";

const lht: Actor = { kind: "user", username: "lht" };
const bot: Actor = { kind: "agent", app: "hq", agent: "page", onBehalfOf: "lht" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-store-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const logFile = () => path.join(dir, "log.jsonl");

describe("EventLog", () => {
  it("stamps seq/at/by and persists across instances", async () => {
    const log = new EventLog(logFile());
    const [a] = await log.append([{ type: "note", data: { text: "hi" } }], lht);
    expect(a.seq).toBe(1);
    expect(a.by).toBe("user:lht");
    expect(new Date(a.at).getTime()).toBeGreaterThan(0);
    const [b] = await log.append([{ type: "note", data: { text: "yo" } }], bot);
    expect(b.seq).toBe(2);
    expect(b.by).toBe("agent:hq/page@lht");

    const fresh = new EventLog(logFile());
    const events = fresh.read();
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[1].data).toEqual({ text: "yo" });
  });

  it("serializes concurrent appends into unique ordered seqs", async () => {
    const log = new EventLog(logFile());
    const batches = await Promise.all(
      Array.from({ length: 20 }, (_, i) => log.append([{ type: "n", data: i }], lht)),
    );
    const seqs = batches.flat().map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new EventLog(logFile()).revision).toBe(20);
  });

  it("writes a batch as one all-or-nothing block with shared timestamp", async () => {
    const log = new EventLog(logFile());
    const out = await log.append(
      [
        { type: "a", data: 1 },
        { type: "b", data: 2 },
      ],
      lht,
    );
    expect(out.map((e) => e.seq)).toEqual([1, 2]);
    expect(out[0].at).toBe(out[1].at);
    expect(fs.readFileSync(logFile(), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("survives a torn tail: skips it, appends on a fresh line", async () => {
    const log = new EventLog(logFile());
    await log.append([{ type: "ok", data: null }], lht);
    fs.appendFileSync(logFile(), '{"seq":2,"at":"2026-'); // crash mid-write
    const fresh = new EventLog(logFile());
    expect(fresh.revision).toBe(1);
    const [next] = await fresh.append([{ type: "after", data: null }], lht);
    expect(next.seq).toBe(2);
    const reread = new EventLog(logFile()).read();
    expect(reread.map((e) => e.type)).toEqual(["ok", "after"]);
  });

  it("readSince returns only newer events", async () => {
    const log = new EventLog(logFile());
    await log.append([{ type: "a", data: null }], lht);
    await log.append([{ type: "b", data: null }], lht);
    expect(log.readSince(1).map((e) => e.type)).toEqual(["b"]);
    expect(log.readSince(2)).toEqual([]);
  });

  it("notifies subscribers and shields the chain from their failures", async () => {
    const log = new EventLog(logFile());
    const seen: number[] = [];
    log.onAppend(() => {
      throw new Error("bad subscriber");
    });
    log.onAppend((events) => seen.push(...events.map((e) => e.seq)));
    await log.append([{ type: "x", data: null }], lht);
    await log.append([{ type: "y", data: null }], lht);
    expect(seen).toEqual([1, 2]);
  });

  it("notices out-of-band writes via stat instead of trusting the cache", async () => {
    const log = new EventLog(logFile());
    await log.append([{ type: "mine", data: null }], lht);
    fs.appendFileSync(
      logFile(),
      JSON.stringify({ seq: 2, at: new Date().toISOString(), by: "system:oob", type: "theirs", data: null }) + "\n",
    );
    expect(log.read().map((e) => e.type)).toEqual(["mine", "theirs"]);
  });
});
