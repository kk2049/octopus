import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInteractionBroker } from "./agent-interactions.js";
import { MACHINE_LIMITS } from "./limits.js";

describe("AgentInteractionBroker", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  it("keeps the managed turn alive longer than its default browser interaction", async () => {
    const broker = new AgentInteractionBroker({ now: () => 0 });
    const done = broker.beginManaged("claude", "managed-default");
    const waiting = broker.request({
      provider: "claude",
      sessionId: "managed-default",
      kind: "question",
      title: "Question",
    });

    expect(broker.publicInteraction("claude", "managed-default")?.expires_at).toBe(
      new Date(MACHINE_LIMITS.managedInteractionTtlMs).toISOString(),
    );
    expect(MACHINE_LIMITS.appendTimeoutMs).toBeGreaterThan(MACHINE_LIMITS.managedInteractionTtlMs);
    broker.cancel("claude", "managed-default");
    await expect(waiting).resolves.toBeNull();
    done();
  });

  it("does not intercept an external CLI nobody is watching", async () => {
    const broker = new AgentInteractionBroker();
    await expect(broker.request({
      provider: "claude",
      sessionId: "s1",
      kind: "permission",
      title: "Run Bash",
      requireWatcher: true,
    })).resolves.toBeNull();
    expect(broker.publicInteraction("claude", "s1")).toBeUndefined();
  });

  it("publishes a watched question and resolves one exact response", async () => {
    const broker = new AgentInteractionBroker({ watchTtlMs: 1_000 });
    const changes: number[] = [];
    broker.onChanged(() => changes.push(changes.length + 1));
    broker.watch("claude", "s1");
    const waiting = broker.request({
      provider: "claude",
      sessionId: "s1",
      kind: "question",
      title: "Question",
      requireWatcher: true,
      questions: [{
        id: "q1",
        header: "Scope",
        prompt: "Which scope?",
        options: [{ label: "small" }, { label: "large" }],
        multiple: false,
        allow_other: true,
        secret: false,
      }],
    });
    const shown = broker.publicInteraction("claude", "s1")!;
    expect(changes).toHaveLength(1);
    expect(shown).toMatchObject({ kind: "question", questions: [{ id: "q1" }] });
    broker.respond({
      provider: "claude",
      session_id: "s1",
      interaction_id: shown.id,
      response_json: JSON.stringify({ decision: "allow", answers: { q1: ["small"] } }),
    });
    await expect(waiting).resolves.toEqual({ decision: "allow", answers: { q1: ["small"] } });
    expect(changes).toHaveLength(2);
    await expect(broker.respond({
      provider: "claude",
      session_id: "s1",
      interaction_id: shown.id,
      response_json: JSON.stringify({ decision: "deny" }),
    })).rejects.toThrow(/已结束|已回答/);
  });

  const question = {
    id: "q1", header: "Scope", prompt: "Which scope?", options: [{ label: "small" }], multiple: false,
    allow_other: true, secret: false,
  };
  const answer = (broker: AgentInteractionBroker, sessionId = "s1") => broker.respond({
    provider: "claude",
    session_id: sessionId,
    interaction_id: broker.publicInteraction("claude", sessionId)!.id,
    response_json: JSON.stringify({ decision: "allow", answers: { q1: ["small"] } }),
  });

  it("leaves an unwatched question to the provider but answerable through its released path", async () => {
    const broker = new AgentInteractionBroker();
    const delivered: unknown[] = [];
    await expect(broker.request({
      provider: "claude", sessionId: "s1", kind: "question", title: "Q", questions: [question],
      requireWatcher: true, ref: "toolu_1", answerReleased: async (response) => { delivered.push(response); },
    })).resolves.toBeNull();
    expect(broker.publicInteraction("claude", "s1")).toMatchObject({ status: "pending", capabilities: { respond: true } });

    await expect(answer(broker)).resolves.toMatchObject({ ok: true, decision: "allow" });
    expect(delivered).toEqual([{ decision: "allow", answers: { q1: ["small"] } }]);
    expect(broker.publicInteraction("claude", "s1")).toMatchObject({ status: "resolved", resolution: { summary: "small" } });
  });

  it("releases a hold that lapses instead of dropping its question", async () => {
    const broker = new AgentInteractionBroker({ watchTtlMs: 20 });
    const delivered: unknown[] = [];
    broker.watch("claude", "s1");
    const waiting = broker.request({
      provider: "claude", sessionId: "s1", kind: "question", title: "Q", questions: [question],
      requireWatcher: true, answerReleased: async (response) => { delivered.push(response); },
    });
    await expect(waiting).resolves.toBeNull();
    // A later browser read must not put the released question back on the short watch lease.
    broker.watch("claude", "s1");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await answer(broker);
    expect(delivered).toHaveLength(1);
  });

  it("never reports an answer handed to a hold nobody waits on any more", async () => {
    const broker = new AgentInteractionBroker({ watchTtlMs: 60_000 });
    broker.watch("claude", "s1");
    const permission = broker.request({
      provider: "claude", sessionId: "s1", kind: "permission", title: "Run Bash",
      requireWatcher: true, stillWaiting: async () => false,
    });
    await expect(broker.respond({
      provider: "claude", session_id: "s1", interaction_id: broker.publicInteraction("claude", "s1")!.id,
      response_json: JSON.stringify({ decision: "allow" }),
    })).rejects.toThrow(/已结束/);
    await expect(permission).resolves.toBeNull();
    expect(broker.publicInteraction("claude", "s1")).toBeUndefined();

    const delivered: unknown[] = [];
    broker.watch("claude", "s2");
    const held = broker.request({
      provider: "claude", sessionId: "s2", kind: "question", title: "Q", questions: [question],
      requireWatcher: true, stillWaiting: async () => false,
      answerReleased: async (response) => { delivered.push(response); },
    });
    await answer(broker, "s2");
    await expect(held).resolves.toBeNull();
    expect(delivered).toHaveLength(1);
  });

  it("ends a released question without a receipt when its answer cannot be delivered", async () => {
    const broker = new AgentInteractionBroker();
    await broker.request({
      provider: "claude", sessionId: "s1", kind: "question", title: "Q", questions: [question],
      requireWatcher: true, answerReleased: async () => { throw new Error("CLI 已经退出"); },
    });
    await expect(answer(broker)).rejects.toThrow("CLI 已经退出");
    expect(broker.publicInteraction("claude", "s1")).toBeUndefined();
  });

  it("dismisses only a released question whose provider ref ended", async () => {
    const broker = new AgentInteractionBroker();
    let finishDelivery!: () => void;
    await broker.request({
      provider: "claude", sessionId: "s1", kind: "question", title: "Q", questions: [question],
      requireWatcher: true, ref: "toolu_1",
      answerReleased: () => new Promise<void>((resolve) => { finishDelivery = resolve; }),
    });
    broker.dismissReleased("claude", "s1", (ref) => ref === "toolu_other");
    expect(broker.publicInteraction("claude", "s1")?.status).toBe("pending");
    // The delivery's own prompt ends the turn boundary; it must not erase its receipt.
    const answering = answer(broker);
    broker.dismissReleased("claude", "s1", () => true);
    finishDelivery();
    await answering;
    expect(broker.publicInteraction("claude", "s1")?.status).toBe("resolved");

    await broker.request({
      provider: "claude", sessionId: "s2", kind: "question", title: "Q", questions: [question],
      requireWatcher: true, ref: "toolu_2", answerReleased: async () => {},
    });
    broker.dismissReleased("claude", "s2", (ref) => ref === "toolu_2");
    expect(broker.publicInteraction("claude", "s2")).toBeUndefined();
  });

  it("keeps a managed Codex interaction available without a watcher", async () => {
    let now = 0;
    const broker = new AgentInteractionBroker({
      now: () => now,
      watchTtlMs: 100,
      managedTtlMs: 1_000,
    });
    const done = broker.beginManaged("codex", "thread-1");
    const waiting = broker.request({
      provider: "codex",
      sessionId: "thread-1",
      kind: "permission",
      title: "Run command",
    });
    const shown = broker.publicInteraction("codex", "thread-1")!;
    now = 50;
    broker.watch("codex", "thread-1");
    expect(broker.publicInteraction("codex", "thread-1")!.expires_at).toBe(
      new Date(1_050).toISOString(),
    );
    broker.respond({
      provider: "codex",
      session_id: "thread-1",
      interaction_id: shown.id,
      response_json: JSON.stringify({ decision: "deny", message: "not now" }),
    });
    await expect(waiting).resolves.toMatchObject({ decision: "deny", message: "not now" });
    done();
  });

  it("persists a compact resolved receipt without persisting answer text", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-interactions-"));
    roots.push(root);
    const stateFile = join(root, "interactions.json");
    const broker = new AgentInteractionBroker({ stateFile, watchTtlMs: 1_000 });
    broker.watch("claude", "s1");
    const waiting = broker.request({
      provider: "claude",
      sessionId: "s1",
      kind: "question",
      title: "Secret",
      requireWatcher: true,
      questions: [{
        id: "q1", header: "Token", prompt: "Token?", options: [], multiple: false, allow_other: true, secret: true,
      }],
    });
    const shown = broker.publicInteraction("claude", "s1")!;
    broker.respond({
      provider: "claude",
      session_id: "s1",
      interaction_id: shown.id,
      response_json: JSON.stringify({ decision: "allow", answers: { q1: ["do-not-persist"] } }),
    });
    await waiting;
    const receipt = broker.publicInteraction("claude", "s1");
    expect(receipt).toMatchObject({
      status: "resolved",
      resolution: { decision: "allow", summary: "已提交私密回答" },
      capabilities: { respond: false },
    });

    // Wait for the serialized receipt, then prove a fresh broker restores it.
    const restored = new AgentInteractionBroker({ stateFile });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await restored.load(); } catch { /* retry an in-flight rename */ }
      if (restored.publicInteraction("claude", "s1")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(restored.publicInteraction("claude", "s1")).toMatchObject({ status: "resolved" });
    expect(JSON.stringify(restored.publicInteraction("claude", "s1"))).not.toContain("do-not-persist");
  });

  it("restores an omp receipt after a restart instead of dropping the provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-interactions-"));
    roots.push(root);
    const stateFile = join(root, "interactions.json");
    const broker = new AgentInteractionBroker({ stateFile, watchTtlMs: 1_000 });
    broker.watch("omp", "s1");
    const waiting = broker.request({
      provider: "omp",
      sessionId: "s1",
      kind: "permission",
      title: "继续吗",
      requireWatcher: true,
    });
    const shown = broker.publicInteraction("omp", "s1")!;
    broker.respond({
      provider: "omp",
      session_id: "s1",
      interaction_id: shown.id,
      response_json: JSON.stringify({ decision: "allow" }),
    });
    await waiting;

    const restored = new AgentInteractionBroker({ stateFile });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await restored.load(); } catch { /* retry an in-flight rename */ }
      if (restored.publicInteraction("omp", "s1")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(restored.publicInteraction("omp", "s1")).toMatchObject({
      provider: "omp",
      status: "resolved",
      resolution: { decision: "allow" },
    });
  });
});
