import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backendRelease } from "./release.js";
import { AppRuntimeService } from "./service.js";

const dirs: string[] = [];
const services: AppRuntimeService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function app(): string {
  const dir = mkdtempSync(join(tmpdir(), "app-runtime-"));
  dirs.push(dir);
  writeFileSync(join(dir, "actions.ts"), `
    export async function pin_session(ctx, params) {
      const denied = await ctx.capabilities.request("resources", "read_session", {});
      return {
        events: [{ type: "session_pinned", data: { session: String(params.session || "") }, at: String(ctx.now), by: "session-plus" }],
        result: { denied: denied.status }
      };
    }
  `);
  writeFileSync(join(dir, "projection.ts"), `
    export function project(events) {
      const pinned = [];
      for (const event of events) if (event.type === "session_pinned" && !pinned.includes(event.data.session)) pinned.push(event.data.session);
      return { pinned };
    }
  `);
  return dir;
}

describe("AppRuntimeService", () => {
  it("runs handlers and projections in the existing sandbox without a capability broker", async () => {
    const dir = app();
    const release = backendRelease(dir);
    const service = new AppRuntimeService(dir);
    services.push(service);
    const out = await service.invoke({
      backendCodeDigest: release.backendCodeDigest,
      action: "pin_session",
      context: { now: "2026-08-04T00:00:00.000Z" },
      params: { session: "demo-1" },
    });
    expect(out.result).toEqual({ denied: "denied" });
    expect(out.events).toEqual([
      { type: "session_pinned", data: { session: "demo-1" }, at: "2026-08-04T00:00:00.000Z", by: "session-plus" },
    ]);
    expect(await service.project({ backendCodeDigest: release.backendCodeDigest, events: out.events })).toEqual({
      pinned: ["demo-1"],
    });
  });

  it("accepts a projection list longer than any element-count bound, but not unbounded nesting", async () => {
    const dir = app();
    writeFileSync(join(dir, "projection.ts"), `
      export function project(events) {
        if (events.length) { let deep = []; for (let i = 0; i < 40; i++) deep = [deep]; return { deep }; }
        return { rows: Array.from({ length: 25000 }, (_, i) => ({ i })) };
      }
    `);
    const release = backendRelease(dir);
    const service = new AppRuntimeService(dir);
    services.push(service);
    const view = await service.project({ backendCodeDigest: release.backendCodeDigest, events: [] }) as { rows: unknown[] };
    expect(view.rows).toHaveLength(25_000);
    await expect(service.project({
      backendCodeDigest: release.backendCodeDigest,
      events: [{ type: "x", data: null, at: "", by: "" }],
    })).rejects.toMatchObject({ code: "invalid_projection" });
  });

  it("refuses a caller whose release digest is stale", async () => {
    const dir = app();
    const service = new AppRuntimeService(dir);
    services.push(service);
    await expect(service.project({ backendCodeDigest: "0".repeat(64), events: [] })).rejects.toMatchObject({
      code: "stale_backend",
    });
  });

  it("changes the digest when either executable asset changes", () => {
    const dir = app();
    const before = backendRelease(dir).backendCodeDigest;
    writeFileSync(join(dir, "projection.ts"), "export function project() { return { changed: true }; }");
    expect(backendRelease(dir).backendCodeDigest).not.toBe(before);
  });

  it("passes trusted viewer evidence as a second projection argument", async () => {
    const dir = app();
    writeFileSync(
      join(dir, "projection.ts"),
      "export function project(events, context) { return { count: events.length, viewer: context.viewer }; }",
    );
    const release = backendRelease(dir);
    const service = new AppRuntimeService(dir);
    services.push(service);
    await expect(service.project({
      backendCodeDigest: release.backendCodeDigest,
      events: [],
      context: { viewer: { user: "alice", kind: "user", role: "manager" } },
    })).resolves.toEqual({ count: 0, viewer: { user: "alice", kind: "user", role: "manager" } });
  });

  it("uses only an explicit incremental export for trusted snapshot-tail folds", async () => {
    const dir = app();
    writeFileSync(join(dir, "projection.ts"), `
      export function project(events, context) {
        return { count: events.length, viewer: context.viewer || null };
      }
      export function projectIncremental(snapshot, events, context) {
        return { count: snapshot.count + events.length, viewer: context.viewer || null };
      }
    `);
    const release = backendRelease(dir);
    const service = new AppRuntimeService(dir);
    services.push(service);
    await expect(service.project({
      backendCodeDigest: release.backendCodeDigest,
      snapshot: { count: 20, viewer: null },
      events: [{ type: "next", data: null, at: "", by: "" }],
      context: { viewer: { user: "alice" } },
    })).resolves.toEqual({ count: 21, viewer: { user: "alice" } });
  });

  it("refuses to reinterpret a tail as complete history for an old projector", async () => {
    const dir = app();
    const release = backendRelease(dir);
    const service = new AppRuntimeService(dir);
    services.push(service);
    await expect(service.project({
      backendCodeDigest: release.backendCodeDigest,
      snapshot: { pinned: ["old"] },
      events: [],
    })).rejects.toMatchObject({ code: "incremental_projection_unsupported" });
  });
});

describe("rules-gate refusal fidelity", () => {
  function rulesApp(): string {
    const dir = mkdtempSync(join(tmpdir(), "app-runtime-rules-"));
    dirs.push(dir);
    writeFileSync(join(dir, "actions.ts"), `
      export function move(ctx, params) {
        throw new Error("it is not white's turn to move");
      }
    `);
    writeFileSync(join(dir, "projection.ts"), "export function project(events) { return { ok: true }; }");
    return dir;
  }

  it("carries the handler's own thrown message out as handler_rejected", async () => {
    // ADR 0007: a rules-gate refusal is the app explaining itself, and its
    // text was authored inside a Compartment that holds no paths or host
    // internals — so a bounded copy may reach that same publisher's View,
    // where the optimistic revert needs a reason to show.
    const dir = rulesApp();
    const release = backendRelease(dir);
    const service = new AppRuntimeService(dir);
    services.push(service);
    await expect(service.invoke({
      backendCodeDigest: release.backendCodeDigest,
      action: "move",
      context: { now: "2026-08-13T00:00:00.000Z" },
      params: {},
    })).rejects.toMatchObject({
      code: "handler_rejected",
      message: "it is not white's turn to move",
    });
  });

  it("keeps machinery failures generic — a missing export never leaks loader text", async () => {
    const dir = rulesApp();
    const release = backendRelease(dir);
    const service = new AppRuntimeService(dir);
    services.push(service);
    await expect(service.invoke({
      backendCodeDigest: release.backendCodeDigest,
      action: "no_such_action",
      context: { now: "2026-08-13T00:00:00.000Z" },
      params: {},
    })).rejects.toMatchObject({
      code: "handler_failed",
      message: "app handler rejected the action",
    });
  });
});
