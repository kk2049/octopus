/** P2: one durable stream remains correctly routed across retained releases. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AppRuntimeClient,
  InvokeRequest,
  InvokeResult,
  ProjectRequest,
  RuntimeJson,
} from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import type { InstanceEvent, SessionPlusPrincipal } from "../app-core/instance.js";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import { AppInstanceService, type AppInstanceRelease } from "./app-instance.js";

const OLD_BACKEND = "a".repeat(64);
const NEW_BACKEND = "b".repeat(64);

const OLD_RELEASE: AppInstanceRelease = {
  stableAppId: "versioned-notes",
  publisher: "demo:versioning",
  packageDigest: "1".repeat(64),
  permissionContractDigest: "c".repeat(64),
  backendCodeDigest: OLD_BACKEND,
  appDir: "/prepared/versioned-notes/old",
};

const NEW_RELEASE: AppInstanceRelease = {
  ...OLD_RELEASE,
  packageDigest: "2".repeat(64),
  backendCodeDigest: NEW_BACKEND,
  appDir: "/prepared/versioned-notes/new",
};

const alice: SessionPlusPrincipal = { owner: "alice", credential: "browser-old", session: true };
const aliceNew: SessionPlusPrincipal = { owner: "alice", credential: "browser-new", session: true };

function manifest(action: "legacy_append" | "modern_append"): SessionPlusManifest {
  return {
    id: "versioned-notes",
    schema: 3,
    stateScope: "account",
    stateEpoch: 0,
    stateEpochDeclared: true,
    roles: {},
    pageFile: "pages/main.yaml",
    agents: {
      fixer: { name: "fixer", adapter: "openai-loop", prompt: "Keep the notes tidy." },
    },
    actions: {
      [action]: {
        binding: "runtime",
        humanOnly: false,
        agentOnly: false,
        params: { text: { type: "string", max: 80, required: true } },
      },
    },
  };
}

class VersionedRuntime implements AppRuntimeClient {
  activeInvokes = 0;
  maxConcurrentInvokes = 0;
  failOldProjection = false;
  readonly invokes: Array<{ digest: string; action: string }> = [];
  readonly projects: Array<{ digest: string; viewer: RuntimeJson | undefined }> = [];

  async project(request: ProjectRequest): Promise<RuntimeJson> {
    this.projects.push({ digest: request.backendCodeDigest, viewer: request.context?.viewer });
    if (
      this.failOldProjection
      && request.backendCodeDigest === OLD_BACKEND
      && request.events.some((event) => event.type === "entry" && (event.data as { backend?: unknown }).backend === "new")
    ) {
      throw new Error("old projector does not understand the new event");
    }
    const snapshot = request.snapshot && typeof request.snapshot === "object" && !Array.isArray(request.snapshot)
      ? request.snapshot as Record<string, RuntimeJson>
      : {};
    const entries = Array.isArray(snapshot.entries) ? [...snapshot.entries] : [];
    entries.push(...request.events.filter((event) => event.type === "entry").map((event) => event.data));
    return {
      projectedBy: request.backendCodeDigest,
      entries,
      ...(request.context?.viewer === undefined ? {} : { viewer: request.context.viewer }),
    };
  }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    this.activeInvokes += 1;
    this.maxConcurrentInvokes = Math.max(this.maxConcurrentInvokes, this.activeInvokes);
    this.invokes.push({ digest: request.backendCodeDigest, action: request.action });
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.activeInvokes -= 1;
    return {
      events: [{
        type: "entry",
        data: {
          backend: request.backendCodeDigest === OLD_BACKEND ? "old" : "new",
          text: request.params.text ?? "",
        },
        at: "1999-01-01T00:00:00.000Z",
        by: "untrusted-runtime",
      }],
      result: { acceptedBy: request.backendCodeDigest },
    };
  }

  async health(): Promise<{ ok: boolean; backendCodeDigest: string }> {
    return { ok: true, backendCodeDigest: NEW_BACKEND };
  }
}

interface Harness {
  active: { value: AppInstanceRelease };
  servable: Map<string, AppInstanceRelease>;
  runtime: VersionedRuntime;
  state: AppStateService;
  service: AppInstanceService;
  destroyed: Array<{ packageDigest: string; reason: string }>;
  dir: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stop();
    await harness.state.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "app-version-routing-"));
  const state = new AppStateService(join(dir, "state"));
  const active = { value: OLD_RELEASE };
  const servable = new Map([[OLD_RELEASE.packageDigest, OLD_RELEASE]]);
  const runtime = new VersionedRuntime();
  const destroyed: Array<{ packageDigest: string; reason: string }> = [];
  const service = new AppInstanceService({
    state: new InProcessStateClient(state),
    runtime,
    activeRelease: () => active.value,
    servableRelease: (packageDigest) => servable.get(packageDigest) ?? null,
    servablePackageDigests: () => new Set(servable.keys()),
    onInstanceDestroyed: (binding, reason) => destroyed.push({ packageDigest: binding.packageDigest, reason }),
    loadManifest: (appDir) => appDir === OLD_RELEASE.appDir
      ? manifest("legacy_append")
      : manifest("modern_append"),
  });
  const value = { active, servable, runtime, state, service, destroyed, dir };
  harnesses.push(value);
  return value;
}

function activateNew(h: Harness): void {
  h.active.value = NEW_RELEASE;
  h.servable.set(NEW_RELEASE.packageDigest, NEW_RELEASE);
}

describe("AppInstanceService multi-version routing", () => {
  it("notifies browser bindings, closes agent turns, and persists reconnect modes", async () => {
    const h = harness();
    const oldTab = await h.service.open(alice);
    const agentTurn = await h.service.openAgentTurn({ owner: "alice", agent: "fixer", turnId: "turn-1" });
    const browserEvents: InstanceEvent[] = [];
    const agentEvents: InstanceEvent[] = [];
    const browserSub = h.service.subscribe(oldTab.handle, alice, (event) => browserEvents.push(event));
    const agentSub = h.service.subscribe(agentTurn.handle, agentTurn.principal, (event) => agentEvents.push(event));

    activateNew(h);
    expect(h.service.markReleaseAvailable({
      availableDigest: NEW_RELEASE.packageDigest,
      mode: "multi_version",
    })).toBe(1);
    expect(browserEvents).toContainEqual({
      type: "release_available",
      current_package_digest: OLD_RELEASE.packageDigest,
      available_package_digest: NEW_RELEASE.packageDigest,
      mode: "multi_version",
    });
    expect(agentEvents).toContainEqual({ type: "closed", reason: "instance_stale" });
    expect(h.service.markReleaseAvailable({
      availableDigest: NEW_RELEASE.packageDigest,
      mode: "multi_version",
    })).toBe(0);

    browserSub?.close();
    agentSub?.close();
    expect(h.service.closeInstance(agentTurn.handle, agentTurn.principal)).toBe(false);
    h.servable.delete(OLD_RELEASE.packageDigest);
    expect(h.service.markReleaseAvailable({
      availableDigest: NEW_RELEASE.packageDigest,
      mode: "refresh_required",
    })).toBe(1);
    expect(h.service.instances.reapExpired()).toBe(0);
    const reconnect = h.service.subscribe(oldTab.handle, alice, () => {});
    expect(reconnect?.releaseAvailable).toEqual({
      type: "release_available",
      current_package_digest: OLD_RELEASE.packageDigest,
      available_package_digest: NEW_RELEASE.packageDigest,
      mode: "refresh_required",
    });

    reconnect?.close();
  });

  it("keeps an old SSE/handle alive, opens the new release, serialises both writers and reprojects per backend", async () => {
    const h = harness();
    const oldTab = await h.service.open(alice);
    activateNew(h);

    const oldEvents: InstanceEvent[] = [];
    const oldReconnect = h.service.subscribe(oldTab.handle, alice, (event) => oldEvents.push(event));
    expect(oldReconnect).not.toBeNull();

    const newTab = await h.service.open(aliceNew);
    expect(h.service.instances.resolve(oldTab.handle, alice)).toMatchObject({
      ok: true,
      binding: { packageDigest: OLD_RELEASE.packageDigest },
    });
    expect(h.service.instances.resolve(newTab.handle, aliceNew)).toMatchObject({
      ok: true,
      binding: { packageDigest: NEW_RELEASE.packageDigest },
    });

    const [oldResult, newResult] = await Promise.all([
      h.service.dispatch(oldTab.handle, alice, { action: "legacy_append", params: { text: "from old" } }),
      h.service.dispatch(newTab.handle, aliceNew, { action: "modern_append", params: { text: "from new" } }),
    ]);
    expect(oldResult.ok).toBe(true);
    expect(newResult.ok).toBe(true);
    expect(h.runtime.maxConcurrentInvokes).toBe(1);
    expect(h.runtime.invokes).toEqual(expect.arrayContaining([
      { digest: OLD_BACKEND, action: "legacy_append" },
      { digest: NEW_BACKEND, action: "modern_append" },
    ]));

    const oldBinding = h.service.instances.resolve(oldTab.handle, alice);
    const newBinding = h.service.instances.resolve(newTab.handle, aliceNew);
    expect(oldBinding.ok && oldBinding.binding.projection).toMatchObject({
      projectedBy: OLD_BACKEND,
      entries: expect.arrayContaining([
        expect.objectContaining({ backend: "old" }),
        expect.objectContaining({ backend: "new" }),
      ]),
    });
    expect(newBinding.ok && newBinding.binding.projection).toMatchObject({
      projectedBy: NEW_BACKEND,
      entries: expect.arrayContaining([
        expect.objectContaining({ backend: "old" }),
        expect.objectContaining({ backend: "new" }),
      ]),
    });
    expect(oldEvents.some((event) => event.type === "view")).toBe(true);

    const log = await h.service.readLog("alice");
    expect(log.ok).toBe(true);
    if (log.ok) {
      expect(log.commits.map((commit) => commit.backendCodeDigest)).toEqual(
        expect.arrayContaining([OLD_BACKEND, NEW_BACKEND]),
      );
    }
    oldReconnect?.close();
  });

  it("closes only the projection cohort whose retained projector fails", async () => {
    const h = harness();
    const oldTab = await h.service.open(alice);
    const oldEvents: InstanceEvent[] = [];
    const oldSub = h.service.subscribe(oldTab.handle, alice, (event) => oldEvents.push(event));
    activateNew(h);
    const newTab = await h.service.open(aliceNew);
    const newEvents: InstanceEvent[] = [];
    const newSub = h.service.subscribe(newTab.handle, aliceNew, (event) => newEvents.push(event));

    h.runtime.failOldProjection = true;
    const result = await h.service.dispatch(newTab.handle, aliceNew, {
      action: "modern_append",
      params: { text: "new event" },
    });

    expect(result.ok).toBe(true);
    expect(oldEvents).toContainEqual({ type: "closed", reason: "projection_failed" });
    expect(h.service.instances.resolve(oldTab.handle, alice)).toMatchObject({ ok: false, code: "invalid_instance" });
    expect(h.service.instances.resolve(newTab.handle, aliceNew)).toMatchObject({ ok: true });
    expect(newEvents.some((event) => event.type === "view")).toBe(true);
    expect(newEvents.some((event) => event.type === "closed")).toBe(false);
    oldSub?.close();
    newSub?.close();
  });

  it("returns stale and preserves the existing destruction signal after a retained release retires", async () => {
    const h = harness();
    const oldTab = await h.service.open(alice);
    const events: InstanceEvent[] = [];
    h.service.subscribe(oldTab.handle, alice, (event) => events.push(event));
    activateNew(h);
    h.servable.delete(OLD_RELEASE.packageDigest);

    const result = await h.service.dispatch(oldTab.handle, alice, {
      action: "legacy_append",
      params: { text: "too late" },
    });
    expect(result).toMatchObject({ ok: false, code: "instance_stale" });
    expect(events).toContainEqual({ type: "closed", reason: "instance_stale" });
    expect(h.destroyed).toContainEqual({ packageDigest: OLD_RELEASE.packageDigest, reason: "instance_stale" });
    expect(h.service.instances.size).toBe(0);
  });
});
