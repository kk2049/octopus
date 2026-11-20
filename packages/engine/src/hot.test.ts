import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Projector } from "./projection.js";
import { EventLog } from "./store.js";
import type { Actor } from "./types.js";

// Fixtures must live inside the package so the vitest/tsx transform pipeline
// will compile runtime-generated TypeScript.
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");

const lht: Actor = { kind: "user", username: "lht" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.mkdirSync(tmpRoot, { recursive: true }) ?? tmpRoot, "hot-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProjection(body: string, mtimeSeconds: number): string {
  const file = path.join(dir, "projection.ts");
  fs.writeFileSync(file, body);
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds); // deterministic version bump
  return file;
}

describe("Projector warm hot-plug", () => {
  it("recomputes when the log grows and when the pure function is edited", async () => {
    const file = writeProjection(
      `export function project(events: unknown[]) { return { version: 1, n: events.length }; }`,
      1_000_000_000,
    );
    const log = new EventLog(path.join(dir, "log.jsonl"));
    const projector = new Projector(file);

    expect(await projector.project(log)).toEqual({ version: 1, n: 0 });
    await log.append([{ type: "x", data: null }], lht);
    expect(await projector.project(log)).toEqual({ version: 1, n: 1 });

    writeProjection(
      `export function project(events: unknown[]) { return { version: 2, doubled: events.length * 2 }; }`,
      1_000_000_100,
    );
    expect(await projector.project(log)).toEqual({ version: 2, doubled: 2 });
  });

  it("memoizes: same revision + same module version returns the same object", async () => {
    const file = writeProjection(
      `export function project(events: unknown[]) { return { fresh: Math.random() }; }`,
      1_000_000_000,
    );
    const log = new EventLog(path.join(dir, "log.jsonl"));
    const projector = new Projector(file);
    const a = await projector.project(log);
    const b = await projector.project(log);
    expect(b).toBe(a);
  });
});
