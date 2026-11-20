/** Shared agent vertical: trusted role actor, viewer fold, revocation and conflict. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppRuntimeClient, InvokeRequest, InvokeResult, ProjectRequest, RuntimeJson } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient, type StateClient } from "@claude-bot/app-state";
import { sessionPlusStateAppKey } from "../app-core/identity.js";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import { DeclaredAppAgentBackend } from "./declared-agent-backend.js";
import { AppInstanceService, type AppInstanceServiceDeps, type SharedInstanceDirectory } from "./app-instance.js";

const MANIFEST: SessionPlusManifest = {
  id: "research-board",
  schema: 4,
  stateScope: "shared",
  stateEpoch: 1,
  stateEpochDeclared: true,
  roles: {
    lead: { max: 1, observer: false },
    researcher: { max: 4, observer: false },
    viewer: { max: 32, observer: true },
  },
  agents: {
    scout: { name: "scout", adapter: "openai-loop", prompt: "research", role: "researcher" },
  },
  actions: {
    ask: {
      binding: "agent",
      agent: "scout",
      humanOnly: true,
      agentOnly: false,
      roles: ["lead"],
      params: { prompt: { type: "string", max: 2_000, required: true } },
    },
    annotate: {
      binding: "runtime",
      handler: "annotate",
      humanOnly: true,
      agentOnly: false,
      roles: ["lead"],
      params: {
        lead: { type: "string", max: 200, required: true },
        viewer: { type: "string", max: 200, required: true },
      },
    },
    publish: {
      binding: "runtime",
      handler: "publish",
      humanOnly: false,
      agentOnly: true,
      roles: ["researcher"],
      params: {
        lead: { type: "string", max: 200, required: true },
        viewer: { type: "string", max: 200, required: true },
      },
    },
  },
  pageFile: "pages/main.yaml",
};

const RELEASE = {
  stableAppId: "research-board",
  publisher: "demo:acme",
  packageDigest: "p".repeat(64),
  permissionContractDigest: "c".repeat(64),
  backendCodeDigest: "b".repeat(64),
  appDir: "/prepared/research-board",
};

class Directory implements SharedInstanceDirectory {
  status = "open";
  members = new Map([["alice", { role: "lead" }], ["bob", { role: "viewer" }]]);

  instance(appId: string, key: string) {
    return appId === RELEASE.stableAppId && key === "asi_research" ? { status: this.status } : undefined;
  }

  member(appId: string, key: string, username: string) {
    return appId === RELEASE.stableAppId && key === "asi_research" ? this.members.get(username) : undefined;
  }
}

class Runtime implements AppRuntimeClient {
  invokes = 0;
  lastActor: RuntimeJson | undefined;

  async project(request: ProjectRequest): Promise<RuntimeJson> {
    const snapshot = asObject(request.snapshot);
    const records = Array.isArray(snapshot.records) ? [...snapshot.records] : [];
    for (const event of request.events) {
      if (event.type === "annotated" || event.type === "published") records.push(event.data);
    }
    const viewer = asObject(request.context?.viewer);
    if (!Object.keys(viewer).length) return { records };
    const role = String(viewer.role ?? "");
    return {
      viewer,
      notes: records.map((entry) => {
        const row = asObject(entry);
        return role === "viewer" ? row.viewer ?? null : row.lead ?? null;
      }),
    };
  }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    this.invokes += 1;
    this.lastActor = request.context.actor;
    return {
      events: [{
        type: request.action === "publish" ? "published" : "annotated",
        data: { lead: request.params.lead, viewer: request.params.viewer },
        at: "forged",
        by: "forged",
      }],
      result: { accepted: true },
    };
  }

  async health() {
    return { ok: true, backendCodeDigest: RELEASE.backendCodeDigest };
  }
}

interface Harness {
  dir: string;
  state: AppStateService;
  client: StateClient;
  directory: Directory;
  runtime: Runtime;
  service: AppInstanceService;
  backend: DeclaredAppAgentBackend;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.service.stop();
    await h.state.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

function harness(options: { conflictAgent?: boolean; agentActivity?: AppInstanceServiceDeps["agentActivity"] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "shared-agent-"));
  const state = new AppStateService(join(dir, "state"));
  const base = new InProcessStateClient(state);
  const client = options.conflictAgent ? conflictAgentCommit(base) : base;
  const directory = new Directory();
  const runtime = new Runtime();
  const service = new AppInstanceService({
    state: client,
    runtime,
    shared: directory,
    agentActivity: options.agentActivity,
    activeRelease: () => RELEASE,
    servableRelease: (digest) => digest === RELEASE.packageDigest ? RELEASE : null,
    servablePackageDigests: () => new Set([RELEASE.packageDigest]),
    loadManifest: () => MANIFEST,
  });
  const value = {
    dir,
    state,
    client,
    directory,
    runtime,
    service,
    backend: new DeclaredAppAgentBackend(RELEASE.stableAppId, service),
  };
  harnesses.push(value);
  return value;
}

describe("shared App agent turns", () => {
  it("binds private activity to the live browser member and rejects revocation, other credentials and delegated reads", async () => {
    const readActivity = vi.fn(() => []);
    const stopActivity = vi.fn(() => true);
    const h = harness({ agentActivity: { readActivity, stopActivity } });
    const alice = { owner: "alice", credential: "web:activity", session: true };
    const tab = await h.service.open(alice, { instanceKey: "asi_research" });
    expect(h.service.agentActivity(tab.handle, alice)).toEqual([]);
    expect(readActivity).toHaveBeenCalledWith({ appId: "research-board", owner: "alice", instanceKey: "asi_research" });
    expect(h.service.agentActivity(tab.handle, { ...alice, owner: "bob" })).toBeNull();
    expect(h.service.agentActivity(tab.handle, { ...alice, credential: "other" })).toBeNull();
    expect(h.service.agentActivity(tab.handle, { ...alice, delegation: { shareId: "s", viewer: "bob" } })).toBeNull();
    expect(h.service.stopAgentActivity(tab.handle, alice, "turn")).toBe(true);
    h.directory.members.delete("alice");
    expect(h.service.agentActivity(tab.handle, alice)).toBeNull();
    expect(h.service.stopAgentActivity(tab.handle, alice, "turn")).toBe(false);
    expect(readActivity).toHaveBeenCalledTimes(1);
    expect(stopActivity).toHaveBeenCalledTimes(1);
  });

  it("binds agent identity and role, audits it, and folds one event for two viewer roles", async () => {
    const h = harness();
    const alice = { owner: "alice", credential: "web:a", session: true };
    const bob = { owner: "bob", credential: "web:b", session: true };
    const lead = await h.service.open(alice, { instanceKey: "asi_research" });
    const viewer = await h.service.open(bob, { instanceKey: "asi_research" });

    expect((await h.service.dispatch(lead.handle, alice, {
      action: "annotate",
      params: { lead: "lead-human", viewer: "viewer-human" },
    })).ok).toBe(true);

    const scope = { kind: "shared" as const, owner: "alice", instanceKey: "asi_research" };
    expect(h.backend.tools(scope, "scout").map((tool) => tool.name)).toEqual(["publish"]);
    const turn = await h.backend.openTurn({ scope, agent: "scout", turnId: "turn-1" });
    expect(turn.projection).toMatchObject({
      viewer: { kind: "agent", app: "research-board", agent: "scout", role: "researcher" },
    });
    expect(await turn.dispatch("publish", { lead: "lead-agent", viewer: "viewer-agent" }))
      .toMatchObject({ ok: true });
    expect(h.runtime.lastActor).toEqual({
      kind: "agent",
      app: "research-board",
      agent: "scout",
      role: "researcher",
    });

    const leadAfter = h.service.instances.resolve(lead.handle, alice);
    const viewerAfter = h.service.instances.resolve(viewer.handle, bob);
    expect(leadAfter.ok && leadAfter.binding.projection).toMatchObject({
      viewer: { user: "alice", kind: "user", role: "lead" },
      notes: ["lead-human", "lead-agent"],
    });
    expect(viewerAfter.ok && viewerAfter.binding.projection).toMatchObject({
      viewer: { user: "bob", kind: "user", role: "viewer" },
      notes: ["viewer-human", "viewer-agent"],
    });

    const log = await h.service.readLog("alice", { instanceKey: "asi_research" });
    expect(log.ok && log.commits.map((commit) => [commit.action, commit.actor])).toEqual([
      ["annotate", "user:alice"],
      ["publish", "agent:research-board/scout#researcher"],
    ]);
    await turn.close();
  });

  it("keeps shared inbox cursors owner-scoped and dispatch ids idempotent", async () => {
    const h = harness();
    const scope = { kind: "shared" as const, owner: "alice", instanceKey: "asi_research" };
    const first = await h.backend.appendInbox({
      scope,
      agent: "scout",
      text: "summarise",
      from: "user:alice",
      dispatchId: "same-message",
    });
    const duplicate = await h.backend.appendInbox({
      scope,
      agent: "scout",
      text: "summarise",
      from: "user:alice",
      dispatchId: "same-message",
    });
    const bobScope = { kind: "shared" as const, owner: "bob", instanceKey: "asi_research" };
    const otherMember = await h.backend.appendInbox({
      scope: bobScope,
      agent: "scout",
      text: "same id, different member",
      from: "user:bob",
      dispatchId: "same-message",
    });
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(duplicate).toMatchObject({ ok: true, duplicate: true });
    expect(otherMember).toMatchObject({ ok: true, duplicate: false });
    expect((await h.backend.readInbox(scope, "scout", 0)).messages).toHaveLength(1);
    expect((await h.backend.readInbox(bobScope, "scout", 0)).messages).toHaveLength(1);
    expect(h.backend.scopeFromKey(h.backend.scopeKey(scope))).toEqual(scope);
  });

  it("aborts the live turn as soon as the sponsoring member is revoked", async () => {
    const h = harness();
    const scope = { kind: "shared" as const, owner: "alice", instanceKey: "asi_research" };
    const turn = await h.backend.openTurn({ scope, agent: "scout", turnId: "turn-revoke" });
    h.directory.members.delete("alice");
    expect(h.service.releaseSharedInstance("asi_research", "shared_membership_revoked", "alice")).toBe(1);
    expect(turn.signal.aborted).toBe(true);
    expect(await turn.dispatch("publish", { lead: "x", viewer: "y" }))
      .toMatchObject({ ok: false, code: "invalid_instance" });
    await turn.close();
  });

  it("rejects a concurrent revision conflict without reinvoking the agent action", async () => {
    const h = harness({ conflictAgent: true });
    const scope = { kind: "shared" as const, owner: "alice", instanceKey: "asi_research" };
    const turn = await h.backend.openTurn({ scope, agent: "scout", turnId: "turn-conflict" });
    expect(await turn.dispatch("publish", { lead: "x", viewer: "y" }))
      .toMatchObject({ ok: false, code: "state_conflict" });
    expect(h.runtime.invokes).toBe(1);
    await turn.close();
  });
});

function asObject(value: unknown): Record<string, RuntimeJson> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, RuntimeJson>
    : {};
}

function conflictAgentCommit(delegate: StateClient): StateClient {
  return {
    resolveStream: (request) => delegate.resolveStream(request),
    commit: async (request) => request.actor.startsWith("agent:")
      ? { ok: false, code: "conflict" as const, head: request.expectedRevision + 1 }
      : delegate.commit(request),
    readSince: (streamId, after, limit) => delegate.readSince(streamId, after, limit),
    readCommits: (streamId, after, limit) => delegate.readCommits(streamId, after, limit),
    putSnapshot: (streamId, revision, digest, view) => delegate.putSnapshot(streamId, revision, digest, view),
    snapshot: (streamId, digest) => delegate.snapshot(streamId, digest),
    health: () => delegate.health(),
  };
}
