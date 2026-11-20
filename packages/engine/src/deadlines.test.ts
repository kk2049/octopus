import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DeadlineEngine, pendingDeadlines } from "./deadlines.js";
import { Host } from "./host/server.js";
import type { Actor, EngineEvent } from "./types.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");
const sys: Actor = { kind: "user", username: "lht" };

let dir: string;
let engine: DeadlineEngine | null = null;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(tmpRoot, "deadline-"));
  const appDir = path.join(dir, "apps", "mail");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.yaml"),
    `
app: mail
scope: per-user
deadlines:
  nag: { start: got, cancel: [read], after_s: 0.1, emit: overdue }
pages: {}
`,
  );
  fs.writeFileSync(path.join(appDir, "projection.ts"), "export function project(){ return {}; }");
});

afterEach(() => {
  engine?.stop();
  engine = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeHost(): Host {
  const host = new Host({
    port: 0,
    appsDir: path.join(dir, "apps"),
    dataDir: path.join(dir, "data"),
    users: { lht: { token: "t" } },
  });
  host.reload();
  return host;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DeadlineEngine", () => {
  it("emits after the clock runs out, stamped system:deadline", async () => {
    const host = makeHost();
    engine = new DeadlineEngine(host);
    engine.attach();
    const inst = host.instance("mail", "lht");
    await inst.log.append([{ type: "got", data: { id: "r1" } }], sys);
    await wait(300);
    const emitted = inst.log.read().find((e) => e.type === "overdue");
    expect(emitted).toBeDefined();
    expect(emitted!.by).toBe("system:deadline");
    expect(emitted!.data).toEqual({ id: "r1", deadline: "nag" });
  });

  it("a cancel event disarms the clock; no emit, ever", async () => {
    const host = makeHost();
    engine = new DeadlineEngine(host);
    engine.attach();
    const inst = host.instance("mail", "lht");
    await inst.log.append([{ type: "got", data: { id: "r2" } }], sys);
    await inst.log.append([{ type: "read", data: { id: "r2" } }], sys);
    await wait(300);
    expect(inst.log.read().some((e) => e.type === "overdue")).toBe(false);
  });

  it("restart recovery: an already-overdue start fires immediately on attach", async () => {
    const host = makeHost();
    // Log written 'before the restart': started long ago, never cancelled.
    const logFile = path.join(dir, "data", "apps", "mail", "lht", "log.jsonl");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(
      logFile,
      JSON.stringify({ seq: 1, at: new Date(Date.now() - 60_000).toISOString(), by: "user:lht", type: "got", data: { id: "old" } }) + "\n",
    );
    engine = new DeadlineEngine(host);
    engine.attach();
    const inst = host.instance("mail", "lht"); // instance-created hook recomputes
    await wait(200);
    expect(inst.log.read().some((e) => e.type === "overdue" && (e.data as { id: string }).id === "old")).toBe(true);
  });

  it("pendingDeadlines is a pure scan: emit-once, cancel-after-start", () => {
    const def = { name: "nag", start: "got", cancel: ["read"], afterS: 1, emit: "overdue" };
    const ev = (seq: number, type: string, id: string): EngineEvent => ({
      seq,
      at: new Date().toISOString(),
      by: "user:x",
      type,
      data: { id },
    });
    expect(pendingDeadlines([ev(1, "got", "a")], def).has("a")).toBe(true);
    expect(pendingDeadlines([ev(1, "got", "a"), ev(2, "read", "a")], def).has("a")).toBe(false);
    expect(pendingDeadlines([ev(1, "got", "a"), ev(2, "overdue", "a")], def).has("a")).toBe(false);
    expect(pendingDeadlines([ev(1, "read", "a"), ev(2, "got", "a")], def).has("a")).toBe(true);
  });
});
