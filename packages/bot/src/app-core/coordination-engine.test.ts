import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AppRuntimeClient,
  InvokeRequest,
  InvokeResult,
  ProjectRequest,
  RuntimeJson,
} from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient, type StateClient } from "@claude-bot/app-state";
import {
  AGENT_INBOX_EVENT,
  AGENT_INBOX_MAX_CHARS,
  AppCoordinationEngine,
  agentInboxText,
} from "./coordination-engine.js";

const BACKEND_DIGEST = "b".repeat(64);
const CONTRACT_DIGEST = "c".repeat(64);
const NOW = Date.parse("2026-08-30T20:16:00.000Z");

class Runtime implements AppRuntimeClient {
  invokeCount = 0;
  systemEvent = false;

  async invoke(_request: InvokeRequest): Promise<InvokeResult> {
    this.invokeCount += 1;
    return {
      events: [{
        type: this.systemEvent ? "sys_forged" : "changed",
        data: { value: this.invokeCount },
        at: "1999-01-01T00:00:00.000Z",
        by: "app:forged",
      }],
      result: { accepted: true },
    };
  }

  async project(request: ProjectRequest): Promise<RuntimeJson> {
    const snapshot = request.snapshot && typeof request.snapshot === "object" && !Array.isArray(request.snapshot)
      ? request.snapshot as Record<string, RuntimeJson>
      : {};
    return {
      count: Number(snapshot.count ?? 0) + request.events.filter((event) => event.type === "changed").length,
      ...(request.context?.viewer === undefined ? {} : { viewer: request.context.viewer }),
    };
  }

  async health() {
    return { ok: true, backendCodeDigest: BACKEND_DIGEST };
  }
}

describe("AppCoordinationEngine", () => {
  it("uses one canonical checkpoint for open and viewer projection", async () => {
    const fixture = stateFixture();
    try {
      const runtime = new Runtime();
      const engine = new AppCoordinationEngine({ state: fixture.client, runtime });
      const stream = await fixture.client.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
      const projected = await engine.project({
        streamId: stream.streamId,
        backendCodeDigest: BACKEND_DIGEST,
        context: { viewer: { user: "alice", role: "editor" } },
      });

      expect(projected.canonical).toMatchObject({ head: 0, projection: { count: 0 } });
      expect(projected.projection).toEqual({
        count: 0,
        viewer: { user: "alice", role: "editor" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("retries one conflict and stamps trusted commit evidence", async () => {
    const fixture = stateFixture();
    try {
      const runtime = new Runtime();
      const state = conflictOnce(fixture.client);
      const engine = new AppCoordinationEngine({ state, runtime, now: () => NOW });
      const stream = await state.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
      let authorizations = 0;
      const outcome = await engine.dispatch({
        streamId: stream.streamId,
        backendCodeDigest: BACKEND_DIGEST,
        contractDigest: CONTRACT_DIGEST,
        dispatchId: "dispatch-1",
        action: "change",
        params: { value: "one" },
        context: ({ state: current, now }) => ({ state: current, now }),
        authorizeCommit: () => {
          authorizations += 1;
          return { ok: true, actor: "user:alice" };
        },
      });

      expect(outcome).toMatchObject({ ok: true, canonical: { head: 1, projection: { count: 1 } } });
      expect(runtime.invokeCount).toBe(2);
      expect(authorizations).toBe(2);
      const stored = await fixture.client.readSince(stream.streamId, 0, 16);
      expect(stored.events).toEqual([expect.objectContaining({
        type: "changed",
        at: "2026-08-30T20:16:00.000Z",
        by: "user:alice",
      })]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects trusted event prefixes before policy or commit", async () => {
    const fixture = stateFixture();
    try {
      const runtime = new Runtime();
      runtime.systemEvent = true;
      const engine = new AppCoordinationEngine({ state: fixture.client, runtime, now: () => NOW });
      const stream = await fixture.client.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
      let authorizations = 0;
      const outcome = await engine.dispatch({
        streamId: stream.streamId,
        backendCodeDigest: BACKEND_DIGEST,
        contractDigest: CONTRACT_DIGEST,
        dispatchId: "dispatch-2",
        action: "change",
        params: {},
        context: ({ state, now }) => ({ state, now }),
        authorizeCommit: () => {
          authorizations += 1;
          return { ok: true, actor: "user:alice" };
        },
      });

      expect(outcome).toMatchObject({ ok: false, code: "action_rejected" });
      expect(authorizations).toBe(0);
      expect((await fixture.client.readSince(stream.streamId, 0, 16)).head).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});

function stateFixture(): {
  client: StateClient;
  close: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "app-coordination-"));
  const service = new AppStateService(dir);
  return {
    client: new InProcessStateClient(service),
    close: async () => {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function conflictOnce(delegate: StateClient): StateClient {
  let conflict = true;
  return {
    resolveStream: (request) => delegate.resolveStream(request),
    commit: async (request) => {
      if (conflict) {
        conflict = false;
        return { ok: false, code: "conflict", head: request.expectedRevision };
      }
      return await delegate.commit(request);
    },
    readSince: (streamId, after, limit) => delegate.readSince(streamId, after, limit),
    readCommits: (streamId, after, limit) => delegate.readCommits(streamId, after, limit),
    putSnapshot: (streamId, revision, digest, view) => delegate.putSnapshot(streamId, revision, digest, view),
    snapshot: (streamId, digest) => delegate.snapshot(streamId, digest),
    health: () => delegate.health(),
  };
}

describe('own-stream history context and read-only handlers', () => {
  it('pages only the bound stream and reauthorizes before returning a read result', async () => {
    const fixture = stateFixture();
    try {
      const runtime = new Runtime();
      const engine = new AppCoordinationEngine({ state: fixture.client, runtime, now: () => NOW });
      const a = await fixture.client.resolveStream({ app: 'history-app', scope: { kind: 'shared', key: 'project-a' } });
      const b = await fixture.client.resolveStream({ app: 'history-app', scope: { kind: 'shared', key: 'project-b' } });
      const base = { backendCodeDigest: BACKEND_DIGEST, contractDigest: CONTRACT_DIGEST, action: 'change', params: {}, context: ({ state }: { state: RuntimeJson }) => ({ state }), authorizeCommit: () => ({ ok: true as const, actor: 'user:alice' }) };
      await engine.dispatch({ ...base, streamId: a.streamId, dispatchId: 'a1' });
      await engine.dispatch({ ...base, streamId: b.streamId, dispatchId: 'b1' });
      let observed: RuntimeJson | undefined;
      runtime.invoke = async request => {
        observed = request.context.history;
        return { events: [], result: request.context.history };
      };
      const read = await engine.dispatch({ ...base, streamId: a.streamId, dispatchId: 'read-a', historyAfter: 0 });
      expect(read.ok).toBe(true);
      expect(observed).toMatchObject({ cursor: 1, head: 1, hasMore: false, events: [{ data: { value: 1 }, by: 'user:alice' }] });
      expect((await fixture.client.readSince(a.streamId, 0, 16)).head).toBe(1);
      const denied = await engine.dispatch({ ...base, streamId: a.streamId, dispatchId: 'denied', historyAfter: 0, authorizeCommit: () => ({ ok: false as const, refusal: { ok: false as const, code: 'revoked', message: 'Membership revoked' } }) });
      expect(denied).toEqual({ ok: false, code: 'revoked', message: 'Membership revoked' });
      expect(await engine.dispatch({ ...base, streamId: a.streamId, dispatchId: 'bad', historyAfter: -1 })).toMatchObject({ ok: false, code: 'action_rejected' });
      expect(await engine.dispatch({ ...base, streamId: a.streamId, dispatchId: 'future', historyAfter: 2 })).toMatchObject({ ok: false, code: 'action_rejected' });
    } finally { await fixture.close(); }
  });
});

describe("agent inbox and per-stream turns shared by every App coordinator", () => {
  it("bounds inbox text once for every App", () => {
    expect(AGENT_INBOX_MAX_CHARS).toBe(8_192);
    expect(agentInboxText(`  ${"x".repeat(AGENT_INBOX_MAX_CHARS + 50)}`)).toHaveLength(AGENT_INBOX_MAX_CHARS - 2);
    expect(agentInboxText("   ")).toBe("");
    expect(agentInboxText(undefined)).toBe("");
  });

  it("appends one stamped system event, answers a repeat as a duplicate and reads one lane", async () => {
    const fixture = stateFixture();
    try {
      const runtime = new Runtime();
      const engine = new AppCoordinationEngine({ state: fixture.client, runtime, now: () => NOW });
      const stream = await fixture.client.resolveStream({ app: "demo", scope: { kind: "shared", key: "room" } });
      const base = {
        streamId: stream.streamId,
        backendCodeDigest: BACKEND_DIGEST,
        contractDigest: CONTRACT_DIGEST,
        agent: "keeper",
      };
      const first = await engine.appendAgentInbox({ ...base, text: "hello", from: "user:alice", owner: "alice", dispatchId: "d1" });
      const repeat = await engine.appendAgentInbox({ ...base, text: "hello", from: "user:alice", owner: "alice", dispatchId: "d1" });
      await engine.appendAgentInbox({ ...base, text: "mine", from: "user:bob", owner: "bob", dispatchId: "d2" });
      await engine.appendAgentInbox({ ...base, agent: "other", text: "elsewhere", from: "user:alice", owner: "alice", dispatchId: "d3" });

      expect(first).toEqual({ ok: true, revision: 1, duplicate: false });
      expect(repeat).toEqual({ ok: true, revision: 1, duplicate: true });
      const stored = await fixture.client.readSince(stream.streamId, 0, 16);
      expect(stored.head).toBe(3);
      expect(stored.events[0]).toMatchObject({
        type: AGENT_INBOX_EVENT,
        data: { to: "keeper", text: "hello", from: "user:alice", owner: "alice" },
        at: "2026-08-30T20:16:00.000Z",
        by: "user:alice",
      });
      expect(await engine.readAgentInbox({ streamId: stream.streamId, agent: "keeper", cursor: 0, owner: "alice" })).toEqual({
        head: 3,
        messages: [{ seq: 1, text: "hello", from: "user:alice", at: "2026-08-30T20:16:00.000Z" }],
      });
      expect((await engine.readAgentInbox({ streamId: stream.streamId, agent: "keeper", cursor: 1 })).messages)
        .toEqual([expect.objectContaining({ seq: 2, text: "mine", from: "user:bob" })]);
    } finally {
      await fixture.close();
    }
  });

  it("re-asks composition policy after the State read and commits nothing on refusal", async () => {
    const fixture = stateFixture();
    try {
      const engine = new AppCoordinationEngine({ state: fixture.client, runtime: new Runtime(), now: () => NOW });
      const stream = await fixture.client.resolveStream({ app: "demo", scope: { kind: "account", key: "alice" } });
      const refused = await engine.appendAgentInbox({
        streamId: stream.streamId,
        backendCodeDigest: BACKEND_DIGEST,
        contractDigest: CONTRACT_DIGEST,
        agent: "keeper",
        text: "hello",
        from: "user:alice",
        dispatchId: "d1",
        authorizeCommit: () => ({ ok: false, message: "成员角色刚刚发生了变化，请重新发送" }),
      });
      expect(refused).toEqual({ ok: false, message: "成员角色刚刚发生了变化，请重新发送" });
      expect((await fixture.client.readSince(stream.streamId, 0, 16)).head).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("runs one stream's turns in order without blocking another stream", async () => {
    const engine = new AppCoordinationEngine({ state: {} as StateClient, runtime: new Runtime() });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = engine.serialize("a", async () => { await gate; order.push("a1"); });
    const second = engine.serialize("a", async () => { order.push("a2"); });
    await engine.serialize("b", async () => { order.push("b1"); });
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["b1", "a1", "a2"]);
    await expect(engine.serialize("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await engine.serialize("a", async () => "after")).toBe("after");
  });

  it("reports the Runtime healthy only for the release being served", async () => {
    const fixture = stateFixture();
    try {
      const engine = new AppCoordinationEngine({ state: fixture.client, runtime: new Runtime() });
      expect(await engine.health(BACKEND_DIGEST)).toEqual({ ok: true, state: true, runtime: true });
      expect(await engine.health("d".repeat(64))).toEqual({ ok: false, state: true, runtime: false });
      expect(await engine.health(undefined)).toEqual({ ok: false, state: true, runtime: false });
    } finally {
      await fixture.close();
    }
  });
});
