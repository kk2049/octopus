import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AppRuntimeClient,
  InvokeRequest,
  InvokeResult,
  ProjectRequest,
  RuntimeJson,
} from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient, type CommitRequest } from "@claude-bot/app-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceCanonicalProjection,
  loadCanonicalProjection,
  projectionCacheDigest,
  readCachedViewerProjection,
  renderViewerProjection,
} from "./projection-cache.js";

const roots: string[] = [];
const services: AppStateService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class IncrementalRuntime implements AppRuntimeClient {
  readonly projects: ProjectRequest[] = [];

  async invoke(_request: InvokeRequest): Promise<InvokeResult> { return { events: [] }; }

  async project(request: ProjectRequest): Promise<RuntimeJson> {
    this.projects.push(request);
    const snapshot = request.snapshot && typeof request.snapshot === "object" && !Array.isArray(request.snapshot)
      ? request.snapshot as Record<string, RuntimeJson>
      : {};
    return {
      count: Number(snapshot.count ?? 0) + request.events.length,
      viewer: request.context?.viewer ?? null,
    };
  }

  async health() { return { ok: true, backendCodeDigest: "a".repeat(64) }; }
}

class LegacyRuntime extends IncrementalRuntime {
  override async project(request: ProjectRequest): Promise<RuntimeJson> {
    if (request.snapshot !== undefined) {
      throw Object.assign(new Error("old projector"), { code: "incremental_projection_unsupported" });
    }
    return await super.project(request);
  }
}

function state(options: ConstructorParameters<typeof AppStateService>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "projection-cache-"));
  roots.push(root);
  const service = new AppStateService(root, options);
  services.push(service);
  return { root, service, client: new InProcessStateClient(service) };
}

function commit(streamId: string, revision: number, count: number, dispatchId: string = randomUUID()): CommitRequest {
  return {
    streamId,
    expectedRevision: revision,
    dispatchId,
    actor: "test",
    action: "append",
    paramsHash: "p".repeat(64),
    backendCodeDigest: "a".repeat(64),
    contractDigest: "c".repeat(64),
    events: Array.from({ length: count }, (_, index) => ({
      type: "added",
      data: { index: revision + index + 1 },
      at: "2026-08-30T00:00:00.000Z",
      by: "test",
    })),
  };
}

describe("projection snapshot + tail folding", () => {
  it("resumes a failed cold replay from its exact prefix without exposing an incomplete directory row", async () => {
    const { service, client } = state();
    const stream = service.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
    service.commit(commit(stream.streamId, 0, 16));
    service.commit(commit(stream.streamId, 16, 16));
    service.commit(commit(stream.streamId, 32, 2));
    const runtime = new IncrementalRuntime();
    const original = runtime.project.bind(runtime);
    let fail = true;
    const project = vi.spyOn(runtime, "project").mockImplementation(async request => {
      if (request.events[0]?.seq === 17 && fail) { fail = false; throw new Error("interrupted replay"); }
      return await original(request);
    });
    const input = { state: client, runtime, streamId: stream.streamId, backendCodeDigest: "a".repeat(64) };
    await expect(loadCanonicalProjection(input)).rejects.toThrow("interrupted replay");
    await expect(client.snapshot(stream.streamId, projectionCacheDigest(input.backendCodeDigest)))
      .resolves.toMatchObject({ revision: 16, view: { count: 16 } });
    await expect(readCachedViewerProjection({ ...input, head: 34, context: { viewer: { user: "alice", role: "owner" } } })).resolves.toBeNull();
    project.mockClear();
    await expect(loadCanonicalProjection(input)).resolves.toMatchObject({ head: 34, projection: { count: 34 } });
    expect(project).toHaveBeenCalledTimes(2);
    expect(project.mock.calls[0]![0].snapshot).toMatchObject({ count: 16 });
    expect(project.mock.calls[0]![0].events[0]).toMatchObject({ seq: 17 });
  });

  it("shares simultaneous canonical loads, then reads fresh history after the shared work settles", async () => {
    const { service, client } = state();
    const stream = service.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
    service.commit(commit(stream.streamId, 0, 16));
    service.commit(commit(stream.streamId, 16, 3));
    const runtime = new IncrementalRuntime();
    const original = runtime.project.bind(runtime);
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const project = vi.spyOn(runtime, "project").mockImplementation(async request => { started(); await gate; return await original(request); });
    const input = { state: client, runtime, streamId: stream.streamId, backendCodeDigest: "a".repeat(64) };
    const first = loadCanonicalProjection(input);
    await entered;
    const second = loadCanonicalProjection(input);
    finish();
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ head: 19, projection: { count: 19, viewer: null } }),
      expect.objectContaining({ head: 19, projection: { count: 19, viewer: null } }),
    ]);
    expect(project).toHaveBeenCalledTimes(2);
    service.commit(commit(stream.streamId, 19, 1));
    await expect(loadCanonicalProjection(input)).resolves.toMatchObject({ head: 20, projection: { count: 20 } });
    expect(project).toHaveBeenCalledTimes(3);
  });

  it.each(["client", "runtime", "stream", "backend"] as const)("keeps a different %s independent of an in-flight load", async difference => {
    const { service, client } = state();
    const firstStream = service.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
    const secondStream = service.resolveStream({ app: "demo", scope: { kind: "account", key: "bob" } });
    service.commit(commit(firstStream.streamId, 0, 1));
    service.commit(commit(secondStream.streamId, 0, 2));
    const runtime = new IncrementalRuntime();
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const original = runtime.project.bind(runtime);
    let firstCall = true;
    vi.spyOn(runtime, "project").mockImplementation(async request => {
      if (firstCall) { firstCall = false; started(); await gate; }
      return await original(request);
    });
    const input = { state: client, runtime, streamId: firstStream.streamId, backendCodeDigest: "a".repeat(64) };
    const first = loadCanonicalProjection(input);
    await entered;
    const otherRuntime = difference === "runtime" ? new IncrementalRuntime() : runtime;
    try {
      const other = await loadCanonicalProjection({ ...input, runtime: otherRuntime,
        ...(difference === "client" ? { state: new InProcessStateClient(service) } : {}),
        ...(difference === "stream" ? { streamId: secondStream.streamId } : {}),
        ...(difference === "backend" ? { backendCodeDigest: "b".repeat(64) } : {}),
      });
      expect(other.projection).toMatchObject({ count: difference === "stream" ? 2 : 1 });
      expect(otherRuntime.projects).toHaveLength(1);
    } finally { finish(); await first; }
  });

  it("cold-folds bounded pages once, then opens and advances from the indexed snapshot", async () => {
    const { service, client } = state();
    const stream = service.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
    const total = 2_048;
    for (let revision = 0; revision < total; revision += 16) {
      service.commit(commit(stream.streamId, revision, 16));
    }
    const runtime = new IncrementalRuntime();
    const input = {
      state: client,
      runtime,
      streamId: stream.streamId,
      backendCodeDigest: "a".repeat(64),
    };

    const cold = await loadCanonicalProjection(input);
    expect(cold).toMatchObject({ head: total, projection: { count: total } });
    expect(runtime.projects).toHaveLength(total / 16);
    expect(runtime.projects[0]).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ seq: 1 })]) });
    expect(runtime.projects[0]!.snapshot).toBeUndefined();
    expect(runtime.projects.at(-1)!.snapshot).toMatchObject({ count: total - 16 });

    runtime.projects.length = 0;
    await expect(loadCanonicalProjection(input)).resolves.toMatchObject({ head: total, projection: { count: total } });
    expect(runtime.projects).toEqual([]);

    service.commit(commit(stream.streamId, total, 1));
    await expect(loadCanonicalProjection(input)).resolves.toMatchObject({ head: total + 1, projection: { count: total + 1 } });
    expect(runtime.projects).toHaveLength(1);
    expect(runtime.projects[0]).toMatchObject({ events: [expect.objectContaining({ seq: total + 1 })] });
    expect(runtime.projects[0]!.snapshot).toMatchObject({ count: total });
  });

  it("invalidates by backend and viewer digest while directory reads remain snapshot-only", async () => {
    const { service, client } = state();
    const stream = service.resolveStream({ app: "demo", scope: { kind: "shared", key: "room" } });
    service.commit(commit(stream.streamId, 0, 3));
    const runtime = new IncrementalRuntime();
    const base = await loadCanonicalProjection({
      state: client, runtime, streamId: stream.streamId, backendCodeDigest: "a".repeat(64),
    });
    const context = { viewer: { user: "alice", role: "owner" } };
    const first = await renderViewerProjection({
      state: client, runtime, streamId: stream.streamId, backendCodeDigest: "a".repeat(64), canonical: base, context,
    });
    expect(first).toEqual({ count: 3, viewer: context.viewer });
    runtime.projects.length = 0;
    await expect(readCachedViewerProjection({
      state: client,
      runtime,
      streamId: stream.streamId,
      backendCodeDigest: "a".repeat(64),
      head: 3,
      context,
    })).resolves.toEqual(first);
    expect(runtime.projects).toEqual([]);

    expect(await client.snapshot(stream.streamId, projectionCacheDigest("b".repeat(64)))).toBeNull();
    await expect(loadCanonicalProjection({
      state: client, runtime, streamId: stream.streamId, backendCodeDigest: "b".repeat(64),
    })).resolves.toMatchObject({ head: 3, projection: { count: 3 } });
    expect(runtime.projects).toHaveLength(1);
  });

  it("snapshots a commit adopted after rename and reuses it after restart", async () => {
    let armed = true;
    const held = state({
      fault(point) {
        if (armed && point === "after_rename") {
          armed = false;
          throw new Error("injected adopt window");
        }
      },
    });
    const stream = held.service.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
    expect(held.service.commit(commit(stream.streamId, 0, 1, "adopt"))).toMatchObject({
      ok: true, revision: 1, duplicate: true,
    });
    const runtime = new IncrementalRuntime();
    await expect(loadCanonicalProjection({
      state: held.client, runtime, streamId: stream.streamId, backendCodeDigest: "a".repeat(64),
    })).resolves.toMatchObject({ head: 1, projection: { count: 1 } });
    held.service.close();
    services.splice(services.indexOf(held.service), 1);

    const reopened = new AppStateService(held.root);
    services.push(reopened);
    runtime.projects.length = 0;
    await expect(loadCanonicalProjection({
      state: new InProcessStateClient(reopened),
      runtime,
      streamId: stream.streamId,
      backendCodeDigest: "a".repeat(64),
    })).resolves.toMatchObject({ head: 1, projection: { count: 1 } });
    expect(runtime.projects).toEqual([]);
  });

  it("folds a long legacy release's complete history in one projection call", async () => {
    const { service, client } = state();
    const stream = service.resolveStream({ app: "legacy", scope: { kind: "account", key: "alice" } });
    for (let revision = 0; revision < 1_000; revision += 200) service.commit(commit(stream.streamId, revision, 200));
    const runtime = new LegacyRuntime();
    const input = { state: client, runtime, streamId: stream.streamId, backendCodeDigest: "a".repeat(64) };
    const canonical = await loadCanonicalProjection(input);
    expect(canonical).toMatchObject({ head: 1_000, projection: { count: 1_000 } });
    const full = runtime.projects.at(-1)!;
    expect(full.snapshot).toBeUndefined();
    expect(full.events.map((event) => event.seq)).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));

    service.commit(commit(stream.streamId, 1_000, 1));
    const advanced = await advanceCanonicalProjection({
      ...input, canonical, events: [{ ...commit(stream.streamId, 1_000, 1).events[0]!, seq: 1_001 }], revision: 1_001,
    });
    expect(advanced).toMatchObject({ head: 1_001, projection: { count: 1_001 } });
    const context = { viewer: { user: "alice", role: "owner" } };
    await expect(renderViewerProjection({ ...input, canonical: advanced, context }))
      .resolves.toEqual({ count: 1_001, viewer: context.viewer });
  });

  it("does not fold an idempotent duplicate into an already-current checkpoint", async () => {
    const { service, client } = state();
    const stream = service.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
    const original = commit(stream.streamId, 0, 1, "same-dispatch");
    expect(service.commit(original)).toMatchObject({ ok: true, revision: 1, duplicate: false });
    const runtime = new IncrementalRuntime();
    const canonical = await loadCanonicalProjection({
      state: client, runtime, streamId: stream.streamId, backendCodeDigest: "a".repeat(64),
    });
    expect(service.commit(original)).toMatchObject({ ok: true, revision: 1, duplicate: true });
    runtime.projects.length = 0;
    await expect(advanceCanonicalProjection({
      state: client,
      runtime,
      streamId: stream.streamId,
      backendCodeDigest: "a".repeat(64),
      canonical,
      events: original.events.map((event) => ({ ...event, seq: 1 })),
      revision: 1,
    })).resolves.toEqual(canonical);
    expect(runtime.projects).toEqual([]);
  });
});
