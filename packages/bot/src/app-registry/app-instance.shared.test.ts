/**
 * Shared-scope declared Apps (ADR 0007 P1/P2/P5) against a REAL
 * `AppStateService`; only the Runtime sandbox is faked at its client seam.
 *
 * Pinned properties:
 *  · two members of one instance key read and write ONE stream — a move by
 *    one is in the other's next projection, and in their LIVE subscription
 *    without reopening (the in-process fan-out is the v1 push);
 *  · the membership door: non-members cannot open, revoked members cannot
 *    dispatch (fresh read), role allowlists hold, observers act only on
 *    actions that name them;
 *  · schema-3 human events carry `user:<owner>` — a shared board says WHO;
 *  · account Apps refuse an instance key, shared Apps require one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppRuntimeClient, InvokeRequest, InvokeResult, ProjectRequest, RuntimeJson } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { sessionPlusStateAppKey } from "../app-core/identity.js";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import type { InstanceEvent } from "../app-core/instance.js";
import { AppInstanceService, type SharedInstanceDirectory } from "./app-instance.js";

const MANIFEST3: SessionPlusManifest = {
  id: "demo-board",
  schema: 3,
  stateScope: "shared",
  stateEpoch: 0,
  stateEpochDeclared: false,
  roles: {
    white: { max: 1, observer: false },
    black: { max: 1, observer: false },
    watcher: { max: 8, observer: true },
  },
  pageFile: "pages/main.yaml",
  agents: {},
  actions: {
    move: {
      binding: "runtime",
      humanOnly: false,
      agentOnly: false,
      roles: ["white", "black"],
      params: { from: { type: "string", max: 8, required: true }, to: { type: "string", max: 8, required: true } },
    },
    comment: {
      binding: "runtime",
      humanOnly: false,
      agentOnly: false,
      roles: ["white", "black", "watcher"],
      params: { text: { type: "string", max: 80, required: true } },
    },
    // No `roles`: any non-observer member — the declarative default.
    reset: { binding: "runtime", humanOnly: false, agentOnly: false, params: {} },
  },
};

const MANIFEST_ACCOUNT: SessionPlusManifest = {
  id: "demo-board",
  schema: 3,
  stateScope: "account",
  stateEpoch: 0,
  stateEpochDeclared: false,
  roles: {},
  pageFile: "pages/main.yaml",
  agents: {},
  actions: { reset: { binding: "runtime", humanOnly: false, agentOnly: false, params: {} } },
};

class FakeRuntime implements AppRuntimeClient {
  /** What the rules door was told about the caller (ADR 0007 actor evidence). */
  lastContext: Record<string, RuntimeJson> | null = null;
  projectContexts: Array<Record<string, RuntimeJson> | undefined> = [];

  async project(request: ProjectRequest): Promise<RuntimeJson> {
    this.projectContexts.push(request.context);
    const viewer = request.context?.viewer as Record<string, RuntimeJson> | undefined;
    const snapshot = request.snapshot && typeof request.snapshot === "object" && !Array.isArray(request.snapshot)
      ? request.snapshot as Record<string, RuntimeJson>
      : {};
    const moves = Array.isArray(snapshot.moves) ? [...snapshot.moves] : [];
    moves.push(...request.events.filter((e) => e.type === "moved").map((e) => e.data as RuntimeJson));
    return {
      moves,
      comments: Number(snapshot.comments ?? 0) + request.events.filter((e) => e.type === "commented").length,
      ...(viewer ? { viewer } : {}),
    };
  }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    this.lastContext = request.context;
    const stamp = { at: "1999-01-01T00:00:00.000Z", by: "liar" };
    if (request.action === "move") {
      return { events: [{ type: "moved", data: { from: request.params.from, to: request.params.to }, ...stamp }], result: null };
    }
    if (request.action === "comment") return { events: [{ type: "commented", data: {}, ...stamp }], result: null };
    // app-state refuses zero-event commits, so even the trivial action emits.
    return { events: [{ type: "reset", data: {}, ...stamp }], result: null };
  }

  async health(): Promise<{ ok: boolean; backendCodeDigest: string }> {
    return { ok: true, backendCodeDigest: "b".repeat(64) };
  }
}

class FakeDirectory implements SharedInstanceDirectory {
  instances = new Map<string, { status: string }>();
  members = new Map<string, { role: string }>();

  instance(appId: string, key: string): { status: string } | undefined {
    return this.instances.get(`${appId}/${key}`);
  }

  member(appId: string, key: string, username: string): { role: string } | undefined {
    return this.members.get(`${appId}/${key}/${username}`);
  }
}

const release = {
  stableAppId: "demo-board",
  publisher: "demo:acme",
  packageDigest: "pkg-digest-1",
  permissionContractDigest: "c".repeat(64),
  backendCodeDigest: "b".repeat(64),
  appDir: "/nonexistent/prepared/demo-board",
};

const alice = { owner: "alice", credential: "web:a", session: true };
const bob = { owner: "bob", credential: "web:b", session: true };
const carol = { owner: "carol", credential: "web:c", session: true };
const mallory = { owner: "mallory", credential: "web:m", session: true };

describe("shared-scope AppInstanceService", () => {
  let dir: string;
  let state: AppStateService;
  let directory: FakeDirectory;
  let service: AppInstanceService;
  let runtime: FakeRuntime;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "app-shared-"));
    state = new AppStateService(join(dir, "state"));
    directory = new FakeDirectory();
    directory.instances.set("demo-board/asi_g1", { status: "open" });
    directory.members.set("demo-board/asi_g1/alice", { role: "white" });
    directory.members.set("demo-board/asi_g1/bob", { role: "black" });
    directory.members.set("demo-board/asi_g1/carol", { role: "watcher" });
    runtime = new FakeRuntime();
    service = new AppInstanceService({
      state: new InProcessStateClient(state),
      runtime,
      activeRelease: () => release,
      servableRelease: (digest) => digest === release.packageDigest ? release : null,
      servablePackageDigests: () => new Set([release.packageDigest]),
      shared: directory,
      loadManifest: () => MANIFEST3,
    });
  });

  afterAll(async () => {
    service.stop();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("two members share one stream, and the second sees the first's move live", async () => {
    const a = await service.open(alice, { instanceKey: "asi_g1" });
    const b = await service.open(bob, { instanceKey: "asi_g1" });

    const seen: InstanceEvent[] = [];
    const sub = service.subscribe(b.handle, bob, (event) => seen.push(event));
    expect(sub).not.toBeNull();

    const moved = await service.dispatch(a.handle, alice, { action: "move", params: { from: "e2", to: "e4" } });
    expect(moved.ok).toBe(true);

    // The rules door was handed trusted actor evidence (T8-C′): user, kind and
    // seated role — what a chess handler needs to refuse an out-of-turn mover.
    expect(runtime.lastContext?.actor).toEqual({ user: "alice", kind: "user", role: "white" });

    // P5: bob's OPEN subscription heard the commit without reopening.
    const view = seen.find((event) => event.type === "view");
    expect(view && (view as { projection: RuntimeJson }).projection).toMatchObject({
      moves: [{ from: "e2", to: "e4" }],
    });

    // And a later open by the other member folds the same history.
    const b2 = await service.open(bob, { instanceKey: "asi_g1" });
    expect(b2.projection).toMatchObject({ moves: [{ from: "e2", to: "e4" }] });
    sub?.close();
  });

  it("folds one shared log through each live member's trusted viewer context", async () => {
    const a = await service.open(alice, { instanceKey: "asi_g1" });
    const b = await service.open(bob, { instanceKey: "asi_g1" });
    const seen: RuntimeJson[] = [];
    const sub = service.subscribe(b.handle, bob, (event) => {
      if (event.type === "view") seen.push(event.projection);
    });

    await service.dispatch(a.handle, alice, { action: "comment", params: { text: "private fold proof" } });

    const aliceView = service.instances.resolve(a.handle, alice);
    const bobView = service.instances.resolve(b.handle, bob);
    expect(aliceView.ok && aliceView.binding.projection).toMatchObject({
      viewer: { user: "alice", kind: "user", role: "white" },
    });
    expect(bobView.ok && bobView.binding.projection).toMatchObject({
      viewer: { user: "bob", kind: "user", role: "black" },
    });
    expect(seen.at(-1)).toMatchObject({ viewer: { user: "bob", role: "black" } });
    sub?.close();
  });

  it("reads a deduplicated trusted project directory through the same viewer and membership doors", async () => {
    await service.open(alice, { instanceKey: "asi_g1" });
    const projectsBefore = runtime.projectContexts.length;
    const snapshots = await service.readSharedProjections(alice, ["asi_g1", "asi_g1"]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      instanceKey: "asi_g1",
      projection: { viewer: { user: "alice", kind: "user", role: "white" } },
    });

    // A directory read creates no driveable handle and a non-member gets no
    // projection row, even if the caller hands the service a known key.
    expect(Object.keys(snapshots[0]!)).toEqual(["instanceKey", "projection"]);
    expect(runtime.projectContexts).toHaveLength(projectsBefore);
    expect(await service.readSharedProjections(mallory, ["asi_g1"])).toEqual([]);
    await expect(service.readSharedProjections(
      { owner: "alice", credential: "agent:a", session: false },
      ["asi_g1"],
    )).rejects.toThrow(/browser session/);
  });

  it("refreshes viewer role evidence on every shared re-projection", async () => {
    const a = await service.open(alice, { instanceKey: "asi_g1" });
    const b = await service.open(bob, { instanceKey: "asi_g1" });
    directory.members.set("demo-board/asi_g1/bob", { role: "watcher" });
    await service.dispatch(a.handle, alice, { action: "comment", params: { text: "role changed" } });
    const changed = service.instances.resolve(b.handle, bob);
    expect(changed.ok && changed.binding.projection).toMatchObject({
      viewer: { user: "bob", kind: "user", role: "watcher" },
    });

    directory.members.delete("demo-board/asi_g1/bob");
    await service.dispatch(a.handle, alice, { action: "comment", params: { text: "role revoked" } });
    const revoked = service.instances.resolve(b.handle, bob);
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) throw new Error("open binding unexpectedly disappeared");
    expect(revoked.binding.projection).toEqual(expect.objectContaining({
      viewer: { user: "bob", kind: "user" },
    }));
    expect((revoked.binding.projection as any).viewer).not.toHaveProperty("role");
    directory.members.set("demo-board/asi_g1/bob", { role: "black" });
  });

  it("reads shared commit evidence only through the same fresh membership door", async () => {
    const member = await service.readLog("alice", { instanceKey: "asi_g1" });
    expect(member.ok).toBe(true);
    if (member.ok) expect(member.commits.some((commit) => commit.action === "move")).toBe(true);
    expect(await service.readLog("alice")).toMatchObject({ ok: false, code: "invalid_instance" });
    expect(await service.readLog("mallory", { instanceKey: "asi_g1" }))
      .toMatchObject({ ok: false, code: "forbidden" });
  });

  it("stamps schema-3 human events with the real author (P2)", async () => {
    const a = await service.open(alice, { instanceKey: "asi_g1" });
    await service.dispatch(a.handle, alice, { action: "move", params: { from: "d2", to: "d4" } });
    // The same stream the service rode, addressed the same way it was minted.
    const client = new InProcessStateClient(state);
    const stream = await client.resolveStream({
      app: sessionPlusStateAppKey(release),
      scope: { kind: "shared", key: "asi_g1" },
    });
    const history = await client.readSince(stream.streamId, 0, 16);
    const authors = history.events.filter((e) => e.type === "moved").map((e) => e.by);
    expect(authors.length).toBeGreaterThan(0);
    for (const by of authors) expect(["user:alice", "user:bob"]).toContain(by);
  });

  it("holds the membership door: non-member, revocation, role allowlists, observers", async () => {
    await expect(service.open(mallory, { instanceKey: "asi_g1" })).rejects.toThrow(/成员/);
    await expect(service.open(alice, { instanceKey: "asi_missing" })).rejects.toThrow(/不存在/);
    await expect(service.open(alice, {})).rejects.toThrow(/实例标识/);

    // Observer: named actions work, unnamed default is refused.
    const c = await service.open(carol, { instanceKey: "asi_g1" });
    const comment = await service.dispatch(c.handle, carol, { action: "comment", params: { text: "nice" } });
    expect(comment.ok).toBe(true);
    const move = await service.dispatch(c.handle, carol, { action: "move", params: { from: "a2", to: "a3" } });
    expect(move).toMatchObject({ ok: false, code: "action_rejected" });
    const reset = await service.dispatch(c.handle, carol, { action: "reset", params: {} });
    expect(reset).toMatchObject({ ok: false, code: "action_rejected" });

    // A player may use the role-less default action.
    const a = await service.open(alice, { instanceKey: "asi_g1" });
    expect((await service.dispatch(a.handle, alice, { action: "reset", params: {} })).ok).toBe(true);

    // Revocation lands on the NEXT dispatch, not the next open.
    const b = await service.open(bob, { instanceKey: "asi_g1" });
    directory.members.delete("demo-board/asi_g1/bob");
    const afterRevoke = await service.dispatch(b.handle, bob, { action: "move", params: { from: "e7", to: "e5" } });
    expect(afterRevoke).toMatchObject({ ok: false, code: "action_rejected" });
    directory.members.set("demo-board/asi_g1/bob", { role: "black" });
  });

  /**
   * The window between the door and the commit.
   *
   * Every dispatch decides "may this person drive this action" and then awaits
   * a State read and a sandbox invocation before it writes. Those awaits are
   * long enough for a person to be removed from the room, moved to another
   * seat, or have their instance destroyed — and the events in hand were
   * produced under the authority that has just changed. A Runtime whose
   * `invoke` blocks until the test says so is the only way to stand inside that
   * window and prove nothing is written from it.
   */
  describe("the commit-time re-authorization", () => {
    let deferredDir: string;
    let deferredState: AppStateService;

    class DeferredRuntime extends FakeRuntime {
      /** Resolves when `invoke` has been entered; awaits `release` to finish. */
      entered!: Promise<void>;
      private enter!: () => void;
      private gate = Promise.resolve();
      private open!: () => void;

      hold(): void {
        this.entered = new Promise<void>((resolve) => { this.enter = resolve; });
        this.gate = new Promise<void>((resolve) => { this.open = resolve; });
      }

      release(): void {
        this.open?.();
      }

      override async invoke(request: InvokeRequest): Promise<InvokeResult> {
        this.enter?.();
        await this.gate;
        return await super.invoke(request);
      }
    }

    async function boardWith(runtime: DeferredRuntime) {
      const service = new AppInstanceService({
        state: new InProcessStateClient(deferredState),
        runtime,
        activeRelease: () => release,
        servableRelease: (digest) => digest === release.packageDigest ? release : null,
        servablePackageDigests: () => new Set([release.packageDigest]),
        shared: directory,
        loadManifest: () => MANIFEST3,
      });
      return service;
    }

    beforeAll(() => {
      deferredDir = mkdtempSync(join(tmpdir(), "app-shared-deferred-"));
      deferredState = new AppStateService(join(deferredDir, "state"));
    });

    afterAll(async () => {
      await deferredState.close();
      rmSync(deferredDir, { recursive: true, force: true });
    });

    async function movesIn(service: AppInstanceService, owner: string): Promise<number> {
      const log = await service.readLog(owner, { instanceKey: "asi_race" });
      return log.ok ? log.commits.filter((commit) => commit.action === "move").length : -1;
    }

    it("does not commit a proposal whose member was removed while it ran", async () => {
      directory.instances.set("demo-board/asi_race", { status: "open" });
      directory.members.set("demo-board/asi_race/alice", { role: "white" });
      const runtime = new DeferredRuntime();
      const service = await boardWith(runtime);
      try {
        const a = await service.open(alice, { instanceKey: "asi_race" });
        runtime.hold();
        const dispatch = service.dispatch(a.handle, alice, { action: "move", params: { from: "e2", to: "e4" } });
        await runtime.entered;
        // The seat goes away while the sandbox is still running.
        directory.members.delete("demo-board/asi_race/alice");
        runtime.release();
        expect(await dispatch).toMatchObject({ ok: false, code: "action_rejected" });
        // Seated again only so the log is readable: what is being asserted is
        // that the refused proposal wrote nothing.
        directory.members.set("demo-board/asi_race/alice", { role: "white" });
        expect(await movesIn(service, "alice")).toBe(0);
      } finally {
        service.stop();
      }
    });

    it("does not commit a white move for somebody who became a watcher while it ran", async () => {
      directory.instances.set("demo-board/asi_race2", { status: "open" });
      directory.members.set("demo-board/asi_race2/alice", { role: "white" });
      const runtime = new DeferredRuntime();
      const service = await boardWith(runtime);
      try {
        const a = await service.open(alice, { instanceKey: "asi_race2" });
        runtime.hold();
        const dispatch = service.dispatch(a.handle, alice, { action: "move", params: { from: "e2", to: "e4" } });
        await runtime.entered;
        // A downgrade, not a removal: "a member is a member" would commit a
        // white move authored by somebody who is now watching.
        directory.members.set("demo-board/asi_race2/alice", { role: "watcher" });
        runtime.release();
        expect(await dispatch).toMatchObject({ ok: false, code: "action_rejected" });
        const log = await service.readLog("alice", { instanceKey: "asi_race2" });
        expect(log.ok && log.commits.filter((commit) => commit.action === "move")).toHaveLength(0);
      } finally {
        service.stop();
      }
    });

    it("does not commit a proposal whose instance was destroyed while it ran", async () => {
      directory.instances.set("demo-board/asi_race3", { status: "open" });
      directory.members.set("demo-board/asi_race3/alice", { role: "white" });
      const runtime = new DeferredRuntime();
      const service = await boardWith(runtime);
      try {
        const a = await service.open(alice, { instanceKey: "asi_race3" });
        runtime.hold();
        const dispatch = service.dispatch(a.handle, alice, { action: "move", params: { from: "e2", to: "e4" } });
        await runtime.entered;
        // What a revocation does: the credential's instances are destroyed.
        service.releaseCredential(alice.owner, alice.credential);
        runtime.release();
        expect(await dispatch).toMatchObject({ ok: false, code: "invalid_instance" });
        const log = await service.readLog("alice", { instanceKey: "asi_race3" });
        expect(log.ok && log.commits.filter((commit) => commit.action === "move")).toHaveLength(0);
      } finally {
        service.stop();
      }
    });

    it("still commits when nothing changed underneath it", async () => {
      directory.instances.set("demo-board/asi_race4", { status: "open" });
      directory.members.set("demo-board/asi_race4/alice", { role: "white" });
      const runtime = new DeferredRuntime();
      const service = await boardWith(runtime);
      try {
        const a = await service.open(alice, { instanceKey: "asi_race4" });
        runtime.hold();
        const dispatch = service.dispatch(a.handle, alice, { action: "move", params: { from: "e2", to: "e4" } });
        await runtime.entered;
        runtime.release();
        expect(await dispatch).toMatchObject({ ok: true });
        const log = await service.readLog("alice", { instanceKey: "asi_race4" });
        expect(log.ok && log.commits.filter((commit) => commit.action === "move")).toHaveLength(1);
      } finally {
        service.stop();
      }
    });
  });

  it("account-scope schema-3 Apps refuse an instance key and stay per-owner", async () => {
    const accountRelease = { ...release, packageDigest: "pkg-digest-2" };
    const accountService = new AppInstanceService({
      state: new InProcessStateClient(state),
      runtime: new FakeRuntime(),
      activeRelease: () => accountRelease,
      servableRelease: (digest) => digest === accountRelease.packageDigest ? accountRelease : null,
      servablePackageDigests: () => new Set([accountRelease.packageDigest]),
      loadManifest: () => MANIFEST_ACCOUNT,
    });
    try {
      await expect(accountService.open(alice, { instanceKey: "asi_g1" })).rejects.toThrow(/按账户/);
      const a = await accountService.open(alice, {});
      expect(a.handle).toBeTruthy();
    } finally {
      accountService.stop();
    }
  });

  it("refuses shared opens when no directory is wired", async () => {
    const bareRelease = { ...release, packageDigest: "pkg-digest-3" };
    const bare = new AppInstanceService({
      state: new InProcessStateClient(state),
      runtime: new FakeRuntime(),
      activeRelease: () => bareRelease,
      servableRelease: (digest) => digest === bareRelease.packageDigest ? bareRelease : null,
      servablePackageDigests: () => new Set([bareRelease.packageDigest]),
      loadManifest: () => MANIFEST3,
    });
    try {
      await expect(bare.open(alice, { instanceKey: "asi_g1" })).rejects.toThrow(/共享实例目录/);
    } finally {
      bare.stop();
    }
  });
});
