import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backendRelease, RuntimeProcessClient } from "@claude-bot/app-runtime";
import { StateProcessClient } from "@claude-bot/app-state";
import { afterEach, describe, expect, it } from "vitest";
import { loadCanonicalProjection, projectionCacheDigest, renderViewerProjection } from "./projection-cache.js";

const stateMain = fileURLToPath(new URL("../../../app-state/src/main.ts", import.meta.url));
const runtimeMain = fileURLToPath(new URL("../../../app-runtime/src/main.ts", import.meta.url));
const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const EVENTS = 1_000;
const BLOB = 3_000;

describe("non-incremental projection over real State and Runtime children", () => {
  it("folds a 1000-event history larger than one child-rpc frame, both directions", async () => {
    const appDir = tempDir("legacy-app-");
    writeFileSync(join(appDir, "actions.ts"), "export function noop() { return { events: [] }; }\n");
    // No projectIncremental: this release can only fold the whole history. Its
    // output deliberately echoes every payload so the reply is also > 2 MiB.
    writeFileSync(join(appDir, "projection.ts"), [
      "export function project(events, context = {}) {",
      "  return { count: events.length, last: events.at(-1)?.seq ?? 0,",
      "    blobs: events.map((event) => event.data.blob), viewer: context.viewer ?? null };",
      "}",
      "",
    ].join("\n"));
    const backendCodeDigest = backendRelease(appDir).backendCodeDigest;

    const state = new StateProcessClient({
      modulePath: stateMain,
      stateDir: tempDir("legacy-state-"),
      execArgv: ["--import", "tsx"],
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
      readyTimeoutMs: 15_000,
    });
    stops.push(() => state.stop());
    const runtime = new RuntimeProcessClient({
      modulePath: runtimeMain,
      appDir,
      execArgv: ["--import", "tsx"],
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
      readyTimeoutMs: 15_000,
    });
    stops.push(() => runtime.stop());
    await Promise.all([state.start(), runtime.start()]);

    const stream = await state.resolveStream({ app: "legacy", scope: { kind: "account", key: "alice" } });
    const blobs: string[] = [];
    for (let revision = 0; revision < EVENTS; revision += 100) {
      const events = Array.from({ length: 100 }, () => {
        const blob = randomBytes(BLOB / 2).toString("hex");
        blobs.push(blob);
        return { type: "added", data: { blob }, at: "2026-10-20T00:00:00.000Z", by: "test" };
      });
      await expect(state.commit({
        streamId: stream.streamId,
        expectedRevision: revision,
        dispatchId: `d-${revision}`,
        actor: "test",
        action: "append",
        paramsHash: "p".repeat(64),
        backendCodeDigest,
        contractDigest: "c".repeat(64),
        events,
      })).resolves.toMatchObject({ ok: true, revision: revision + 100 });
    }
    expect(blobs.join("").length).toBeGreaterThan(2 * 1024 * 1024);

    const input = { state, runtime, streamId: stream.streamId, backendCodeDigest };
    const canonical = await loadCanonicalProjection(input);
    expect(canonical.head).toBe(EVENTS);
    expect(canonical.projection).toMatchObject({ count: EVENTS, last: EVENTS, viewer: null });
    expect((canonical.projection as { blobs: string[] }).blobs).toEqual(blobs);

    // The > 2 MiB checkpoint also crossed into State and comes back from it.
    const cached = await state.snapshot(stream.streamId, projectionCacheDigest(backendCodeDigest));
    expect(cached?.revision).toBe(EVENTS);
    expect((cached?.view as { blobs: string[] }).blobs).toHaveLength(EVENTS);

    const viewer = { user: "alice", role: "owner" };
    const view = await renderViewerProjection({ ...input, canonical, context: { viewer } });
    expect(view).toMatchObject({ count: EVENTS, viewer });
  }, 60_000);
});
