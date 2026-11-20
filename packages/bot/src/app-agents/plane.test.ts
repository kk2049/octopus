/**
 * The vertical proof, end to end and with no network.
 *
 * Real `Store` (real migration v29), real `AppStateService`, real
 * `AppRuntimeService` running the shipped App's own `actions.ts` in its
 * sandbox, real `SessionPlusAppService`, real `SessionPlusAgentBackend`, real
 * `AppAgentPlane`. The only thing scripted is the model: `fetchImpl` answers
 * with chat-completions payloads, which is the same seam `hq/chat.test.ts`
 * uses, so no test here reaches an API.
 *
 * What that combination buys is the claim the whole change is about: a message
 * goes into the App's own event stream, the pump picks it up, the model asks
 * for an action by name, and the action arrives at THE SAME `dispatch` a
 * person's button reaches — with a different actor and no auto-allow.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntimeService, InProcessRuntimeClient } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { MemoryConvergenceUsage, setConvergenceUsageForTest } from "@claude-bot/convergence-gates";
import { bundledAppDir } from "../app-core/app-path.js";
import { SessionPlusAppService } from "../session-plus/app-service.js";
import { SessionPlusAgentBackend } from "../session-plus/agent-backend.js";
import { sessionPlusIdentity, sessionPlusStateAppKey } from "../app-core/identity.js";
import { loadSessionPlusManifest } from "../app-core/manifest.js";
import { Store } from "../store/store.js";
import { AgentLoop } from "./loop.js";
import { ManagedExecutionSupervisor } from "../managed-execution/supervisor.js";
import { ResourceRecoveryService } from "../resources/recovery.js";
import { AppAgentPlane } from "./plane.js";

const dirs: string[] = [];
const closers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scripted chat-completions endpoint. Each entry is one assistant message. */
function scriptedFetch(queue: Array<Record<string, unknown>>) {
  const seen: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string, init: { body: string }) => {
    seen.push(JSON.parse(init.body) as Record<string, unknown>);
    const message = queue.shift() ?? { content: "(没有更多脚本)" };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message }] }),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, seen };
}

function toolCall(name: string, args: Record<string, unknown>, id = "c1") {
  return { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

describe("AppAgentPlane", () => {
  it("runs an App action through the durable supervisor without moving authority out of its existing door", async () => {
    const f = live([toolCall("pin_session", { session: "managed-codex" }), { content: "已收藏。" }], { managed: true });
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "收藏 managed-codex" });
    await f.plane.pump();
    await vi.waitFor(() => expect(f.store.listAppAgentTurns({ appId: "session-plus", scopeKey: "account:alice", agent: "keeper" })[0]?.status).toBe("succeeded"));
    const tab = await f.app.open({ owner: "alice", credential: "ws:managed", session: true });
    expect(tab.projection).toMatchObject({ pinned: ["managed-codex"] });
    expect(f.store.managedExecutions.listOwned("alice")).toMatchObject([{ source: "app-agent", observed: "completed", resumeOwner: "head" }]);
    expect(f.store.managedExecutions.listOwned("bob")).toEqual([]);
    expect(f.plane.readActivity({ appId: "session-plus", owner: "alice" })).toMatchObject([
      { agent: "keeper", state: "ended", reply: "已收藏。", canStop: false },
    ]);
    expect(f.plane.readActivity({ appId: "session-plus", owner: "bob" })).toEqual([]);
    expect(JSON.stringify(f.plane.readActivity({ appId: "session-plus", owner: "alice" }))).not.toContain("checkpoint");
  });

  it("stops a suspended turn without replay and keeps the current scope private", async () => {
    const f = live([{ content: "must not execute" }], { managed: true });
    f.dropLlm();
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "network test" });
    await vi.waitFor(() => expect(f.store.managedExecutions.listOwned("alice")[0]?.observed).toBe("reconnecting"));
    const before = f.plane.readActivity({ appId: "session-plus", owner: "alice" })[0]!;
    expect(before).toMatchObject({ state: "reconnecting", canStop: true });
    expect(f.plane.stopActivity({ appId: "session-plus", owner: "bob" }, before.id)).toBe(false);
    expect(f.plane.stopActivity({ appId: "other-app", owner: "alice" }, before.id)).toBe(false);
    expect(f.plane.stopActivity({ appId: "session-plus", owner: "alice" }, before.id)).toBe(true);
    await f.supervisor!.sweep();
    expect(f.plane.readActivity({ appId: "session-plus", owner: "alice" })[0]).toMatchObject({ state: "stopped", canStop: false });
    expect(f.store.managedExecutions.listOwned("alice")[0]?.desired).toBe("cancelled");
    expect(f.fetch.seen).toHaveLength(0);
    expect(f.plane.stopActivity({ appId: "session-plus", owner: "alice" }, before.id)).toBe(true);
  });

  it("keeps approval a terminal domain handoff under durable execution", async () => {
    const f = live([toolCall("pin_session", { session: "approval" })], { managed: true });
    const dispatch = vi.fn(async () => ({ ok: true as const, result: { status: "waiting_approval" } }));
    f.stubDispatch(dispatch);
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "收藏 approval" });
    await f.plane.pump();
    await vi.waitFor(() => expect(f.store.managedExecutions.listOwned("alice")[0]?.observed).toBe("waiting_approval"));
    await f.supervisor!.sweep();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(f.fetch.seen).toHaveLength(1);
  });

  it("carries a message from the inbox to the App's own action, through one door", async () => {
    const f = live([
      toolCall("pin_session", { session: "demo-codex" }),
      { content: "已经把 demo-codex 收藏了。" },
    ]);
    expect((await f.plane.deliver({
      appId: "session-plus",
      owner: "alice",
      agent: "keeper",
      text: "帮我收藏 demo-codex",
    })).ok).toBe(true);
    await f.plane.pump();

    // The App's durable state really changed, through its own handler in the
    // Runtime sandbox — not through a shortcut this test wrote.
    const tab = await f.app.open({ owner: "alice", credential: "ws:1", session: true });
    expect(tab.projection).toMatchObject({ pinned: ["demo-codex"] });

    const key = { appId: "session-plus", scopeKey: "account:alice", agent: "keeper" };
    const turns = f.store.listAppAgentTurns(key);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("succeeded");
    expect(turns[0]!.trigger).toBe("inbox");
    const roles = f.store.listAppAgentMessages(key).map((row) => `${row.role}:${row.tool_name ?? ""}`);
    expect(roles).toContain("user:");
    expect(roles).toContain("tool:pin_session");
    expect(roles).toContain("assistant:");
  });

  it("publishes one terminal event for a real turn, but none for a skipped trigger", async () => {
    const completions: import("../agent-completion/relay.js").AgentCompletionEvent[] = [];
    const f = live([{ content: "完成" }], { onCompletion: (event) => completions.push(event) });
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "看看" });
    await f.plane.pump();
    await f.plane.trigger({ appId: "missing", owner: "alice", agent: "keeper" });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      owner: "alice",
      surface: "app",
      label: "App session-plus · keeper",
      status: "succeeded",
    });
  });

  it("signs the event as the agent, not as the App", async () => {
    // "A person pressed this" and "a model chose this" have to be two different
    // strings in the log, or an audit after the fact is guesswork.
    const f = live([toolCall("pin_session", { session: "demo-codex" }), { content: "好了" }]);
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "收藏 demo-codex" });
    await f.plane.pump();
    const stream = await f.stateClient.resolveStream({
      app: sessionPlusStateAppKey(f.identity),
      scope: { kind: "account", key: "alice" },
    });
    const read = await f.stateClient.readSince(stream.streamId, 0, 16);
    const pin = read.events.find((event) => event.type === "session_pin_set");
    expect(pin?.by).toBe("agent:session-plus/keeper@alice");
    // …while the inbox message is signed by the person who wrote it.
    expect(read.events.find((event) => event.type === "sys_agent_inbox")?.by).toBe("user:alice");
  });

  it("refuses a human_only action at the door and never offers it as a tool", async () => {
    const f = live([toolCall("start_session", { device: "laptop" }), { content: "看来我不能这么做。" }]);
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "起一个新会话" });
    await f.plane.pump();
    const offered = (f.fetch.seen[0]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(offered).not.toContain("start_session");
    expect(offered).toContain("pin_session");
    // …and naming it anyway is refused rather than reaching the resource plane.
    const rows = f.store.listAppAgentMessages({ appId: "session-plus", scopeKey: "account:alice", agent: "keeper" });
    expect(rows.some((row) => row.tool_name === "start_session" && row.content.includes("只接受本人操作"))).toBe(true);
  });

  it("consumes the inbox at the START, so a failed turn does not replay it", async () => {
    // The tool calls a failing turn already made are not undone by a retry, and
    // a deterministically failing turn would otherwise retry for ever.
    const f = live([]);
    f.breakLlm();
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "收藏 demo-codex" });
    await f.plane.pump();
    const key = { appId: "session-plus", scopeKey: "account:alice", agent: "keeper" };
    expect(f.store.listAppAgentTurns(key)[0]!.status).toBe("failed");
    expect(f.store.getAppAgentCursor(key)!.upto_seq).toBeGreaterThan(0);
    const notes = f.store.listAppAgentMessages(key).map((row) => row.content).join("\n");
    expect(notes).toContain("不会重投");
    // A second pump finds nothing to do: the batch is gone, not queued.
    const before = f.store.listAppAgentTurns(key).length;
    await f.plane.pump();
    expect(f.store.listAppAgentTurns(key)).toHaveLength(before);
  });

  it("preserves the caller-visible failure while recording only a closed metric reason", async () => {
    const f = live([]);
    const privateReason = "模型端点泄漏了 /srv/private/token.txt";
    (f.plane as unknown as { o: { loop: AgentLoop } }).o.loop = {
      configured: true,
      run: async () => { throw new Error(privateReason); },
    } as unknown as AgentLoop;
    const usage = new MemoryConvergenceUsage(Buffer.alloc(32, 5));
    setConvergenceUsageForTest(usage);
    try {
      const report = await f.plane.trigger({
        appId: "session-plus",
        owner: "alice",
        agent: "keeper",
        prompt: "运行一次",
      });
      expect(report).toMatchObject({ status: "failed", reason: privateReason });
    } finally {
      setConvergenceUsageForTest(null);
    }
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]).toMatchObject({ outcome: "failed", reason: "turn_failed" });
    expect(JSON.stringify(usage.events)).not.toContain(privateReason);
  });

  it("settles a turn a previous process left running as unknown, and re-dispatches nothing", async () => {
    const f = live([toolCall("pin_session", { session: "demo-codex" }), { content: "好了" }]);
    const key = { appId: "session-plus", scopeKey: "account:alice", agent: "keeper" };
    f.store.ensureAppAgentCursor(key);
    f.store.claimAppAgentInbox({ key, owner: "alice", turnId: "agt_old", trigger: "inbox", fromSeq: 0, uptoSeq: 3 });
    expect(f.plane.recover()).toBe(1);
    const turn = f.store.getAppAgentTurn("agt_old")!;
    expect(turn.status).toBe("unknown");
    expect(turn.note).toContain("不会重放");
    expect(f.fetch.seen).toHaveLength(0);
  });

  it("ends the turn when a tool says a person still has to approve", async () => {
    const f = live([toolCall("append_session", { resource: "r1", prompt: "继续" }), { content: "不该到这里" }]);
    f.stubDispatch(async () => ({ ok: true, result: { opId: "op1", status: "waiting_approval", message: "等待批准" } }));
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "继续那条会话" });
    const report = await f.plane.trigger({ appId: "session-plus", owner: "alice", agent: "keeper" });
    expect(report.status).toBe("suspended");
    // One request only: the loop collapsed instead of asking the model again,
    // and it certainly did not retry the action into a second approval card.
    expect(f.fetch.seen).toHaveLength(1);
  });

  it("ends the turn when the agent asks the user something", async () => {
    const f = live([toolCall("ask_user", { question: "要收藏哪一条？" }), { content: "不该到这里" }]);
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "收藏一下" });
    await f.plane.pump();
    const rows = f.store.listAppAgentMessages({ appId: "session-plus", scopeKey: "account:alice", agent: "keeper" });
    expect(rows.some((row) => row.role === "note" && row.content.includes("要收藏哪一条"))).toBe(true);
    expect(f.fetch.seen).toHaveLength(1);
  });

  it("only pumps accounts that have used an agent — it has no account enumerator", async () => {
    const f = live([{ content: "hi" }]);
    // Nothing delivered, nothing registered: a sweep finds no work at all, even
    // though the store is full of users the plane could have guessed at.
    await f.plane.pump();
    expect(f.fetch.seen).toHaveLength(0);
    expect(f.store.listAppAgentCursors("session-plus")).toHaveLength(0);
  });

  it("refuses to talk to an agent the active release does not declare", async () => {
    const f = live([]);
    expect(await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "ghost", text: "hi" }))
      .toMatchObject({ ok: false });
    expect(await f.plane.deliver({ appId: "other-app", owner: "alice", agent: "keeper", text: "hi" }))
      .toMatchObject({ ok: false });
  });

  it("stops a runaway account at the deployment's daily budget", async () => {
    const f = live([{ content: "ok" }, { content: "ok" }, { content: "ok" }], { turnsPerAccountPerDay: 1 });
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "一" });
    await f.plane.pump();
    await f.plane.deliver({ appId: "session-plus", owner: "alice", agent: "keeper", text: "二" });
    await f.plane.pump();
    const key = { appId: "session-plus", scopeKey: "account:alice", agent: "keeper" };
    expect(f.store.listAppAgentTurns(key)).toHaveLength(1);
    expect(f.store.listAppAgentMessages(key).some((row) => row.content.includes("部署预算"))).toBe(true);
  });
});

// ── harness ──

function live(
  script: Array<Record<string, unknown>>,
  planeOptions: {
    managed?: boolean;
    turnsPerAccountPerDay?: number;
    onCompletion?: import("../agent-completion/relay.js").AgentCompletionSink;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "app-agents-"));
  dirs.push(dir);
  const state = new AppStateService(dir);
  const runtime = new AppRuntimeService(bundledAppDir("session-plus"));
  const store = new Store(":memory:");
  closers.push(async () => {
    store.close();
    state.close();
    await runtime.stop();
  });
  const identity = sessionPlusIdentity();
  const manifest = loadSessionPlusManifest();
  const stateClient = new InProcessStateClient(state);
  const app = new SessionPlusAppService({
    state: stateClient,
    runtime: new InProcessRuntimeClient(runtime),
    identity,
    manifest,
  });
  closers.push(() => app.stop());
  const fetch = scriptedFetch(script);
  const backend = new SessionPlusAgentBackend({ app, manifest: () => manifest });
  const supervisor = planeOptions.managed ? new ManagedExecutionSupervisor(store.managedExecutions, new ResourceRecoveryService(store.resourceWaiters)) : undefined;
  if (supervisor) closers.push(() => supervisor.close());
  const plane = new AppAgentPlane({
    supervisor,
    store,
    backends: [backend],
    loop: new AgentLoop({ baseUrl: "http://llm.invalid/v1", apiKey: "k", fetchImpl: fetch.impl }),
    defaultModel: "test-model",
    ...planeOptions,
  });
  plane.completeBackendRegistration();
  closers.push(() => plane.stop());
  return {
    app,
    plane,
    store,
    fetch,
    identity,
    stateClient,
    supervisor,
    dropLlm() {
      (plane as unknown as { o: { loop: AgentLoop } }).o.loop = new AgentLoop({
        baseUrl: "http://llm.invalid/v1", apiKey: "k",
        fetchImpl: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); },
      });
    },
    /** Make every completion fail, to exercise the failed-turn path. */
    breakLlm() {
      (plane as unknown as { o: { loop: AgentLoop } }).o.loop = new AgentLoop({
        baseUrl: "http://llm.invalid/v1",
        apiKey: "k",
        fetchImpl: (async () => {
          throw new Error("模型端点不可用");
        }) as unknown as typeof globalThis.fetch,
      });
    },
    /**
     * Replace what one turn's dispatch answers.
     *
     * Only used where the point is the PLANE's reaction to an answer (an
     * approval that has not happened yet); every other test lets the call go
     * all the way into the sandbox.
     */
    stubDispatch(answer: () => Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }>) {
      const original = backend.openTurn.bind(backend);
      backend.openTurn = async (input) => {
        const handle = await original(input);
        return { ...handle, dispatch: () => answer() };
      };
    },
  };
}
