import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AgentInteractionBroker } from "./agent-interactions.js";
import { CodexJsonRpcClient, CodexManagedSession, codexRequestError, type CodexManagedSessionOptions } from "./codex-app-server.js";

/** One managed attachment lifecycle: resume, send one turn, close. */
async function managedTurn(child: ChildProcessWithoutNullStreams, prompt: string, options: Partial<CodexManagedSessionOptions> = {}) {
  const session = await CodexManagedSession.resume("thread-1", { cwd: process.cwd(), timeoutMs: 5_000, child, ...options });
  try { return await (await session.dispatch(prompt)).completion; } finally { await session.close(); }
}

describe("Codex managed turn protocol", () => {
  it.each([false, true])("preserves native capacity evidence and willRetry=%s without settling an error notification", async willRetry => {
    const server = `
      const rl = require("readline").createInterface({ input: process.stdin });
      const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
      rl.on("line", line => {
        const row = JSON.parse(line);
        if (!row.id) return;
        send({ id: row.id, result: row.method === "turn/start" ? { turn: { id: "capacity-turn" } } : {} });
        if (row.method === "turn/start") {
          send({ method: "error", params: { threadId: "thread-1", turnId: "capacity-turn",
            willRetry: ${willRetry}, error: { message: "overloaded", codexErrorInfo: "serverOverloaded" } } });
          send({ method: "error", params: { threadId: "other-thread", turnId: "capacity-turn",
            willRetry: true, error: { message: "wrong", codexErrorInfo: "unauthorized" } } });
          setTimeout(() => send({ method: "turn/completed", params: { threadId: "thread-1",
            turn: { id: "capacity-turn", status: "failed", error: { message: "overloaded", codexErrorInfo: "serverOverloaded" } } } }), 20);
        }
      });
    `;
    const child = spawn(process.execPath, ["-e", server], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const result = await managedTurn(child, "original", { timeoutMs: 2_000, interactions: new AgentInteractionBroker() });
    expect(result).toMatchObject({ status: "failed", providerError: {
      code: "serverOverloaded", threadId: "thread-1", turnId: "capacity-turn", willRetry,
    } });
  });

  it("routes request_user_input and command approval through one broker", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const interactions = new AgentInteractionBroker({ managedTtlMs: 5_000 });
    const running = managedTurn(child, "continue", { interactions, permissionProfile: "manual" });

    const question = await waitFor(() => interactions.publicInteraction("codex", "thread-1"));
    expect(question).toMatchObject({ kind: "question", questions: [{ id: "scope" }] });
    interactions.respond({
      provider: "codex",
      session_id: "thread-1",
      interaction_id: question.id,
      response_json: JSON.stringify({ decision: "allow", answers: { scope: ["small"] } }),
    });

    const permission = await waitFor(() => {
      const current = interactions.publicInteraction("codex", "thread-1");
      return current?.kind === "permission" ? current : undefined;
    });
    expect(permission).toMatchObject({ kind: "permission", tool: "commandExecution" });
    interactions.respond({
      provider: "codex",
      session_id: "thread-1",
      interaction_id: permission.id,
      response_json: JSON.stringify({ decision: "allow" }),
    });

    await expect(running).resolves.toMatchObject({
      started: true,
      ok: true,
      status: "completed",
      resultText: "done",
    });
  });

  it.each(["allow", "deny", "cancel"] as const)("routes empty MCP tool confirmation through explicit %s", async decision => {
    const child = spawn(process.execPath, ["-e", elicitationServer({ mode: "form", requestedSchema: { type: "object", properties: {} } })],
      { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const interactions = new AgentInteractionBroker({ managedTtlMs: 5_000 });
    const running = managedTurn(child, "continue", { interactions });
    const permission = await waitFor(() => interactions.publicInteraction("codex", "thread-1"));
    expect(permission).toMatchObject({ kind: "permission", tool: "octopus_execution", description: "Allow run_workspace_command?" });
    if (decision === "cancel") interactions.cancel("codex", "thread-1");
    else interactions.respond({ provider: "codex", session_id: "thread-1", interaction_id: permission.id, response_json: JSON.stringify({ decision }) });
    const result = await running;
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.resultText!)).toEqual(decision === "allow"
      ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null });
  });

  it.each([
    { mode: "url", url: "https://example.invalid/auth" },
    { mode: "form", requestedSchema: { type: "object", properties: { secret: { type: "string" } } } },
    { mode: "form", requestedSchema: { type: "object", properties: {}, required: ["secret"] } },
  ])("never fabricates structured or URL elicitation answers", async params => {
    const child = spawn(process.execPath, ["-e", elicitationServer(params)], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const result = await managedTurn(child, "continue", { interactions: new AgentInteractionBroker(), timeoutMs: 2_000 });
    expect(JSON.parse(result.resultText!)).toEqual({ action: "decline", content: null, _meta: null });
  });

  it("applies model, effort, and the selected full-access profile at the sticky protocol layers", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_FULL_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    await expect(managedTurn(child, "continue", { timeoutMs: 1_000, permissionProfile: "full_access",
      model: "gpt-5.6-terra", effort: "xhigh" })).resolves.toMatchObject({ started: true, ok: true, status: "completed" });
  });
});

describe("Codex managed attachment", () => {
  it("probes a cold parent-owned child and refuses it before resume or fork", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_COLD_SUBAGENT_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    await expect(CodexManagedSession.resume("thread-leaf", {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      child,
      permissionProfile: "full_access",
    })).rejects.toMatchObject({
      code: "codex_subagent_thread",
      safeFallback: false,
      message: expect.stringContaining("父 agent"),
    });
  });

  it("loads a cold input-capable lineage root-first and resumes its child once", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_COLD_WRITABLE_SUBAGENT_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const session = await CodexManagedSession.resume("thread-leaf", {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      child,
      permissionProfile: "full_access",
    });
    expect(session.sessionId).toBe("thread-leaf");
    const turn = await session.dispatch("continue the child");
    await expect(turn.completion).resolves.toMatchObject({
      ok: true,
      resultText: "child resumed",
    });
    await session.close();
  });

  it("steers through the native app-server method", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_STEER_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const session = await CodexManagedSession.resume("thread-1", {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      child,
      permissionProfile: "full_access",
      model: "gpt-test",
      effort: "high",
      config: { mcp_servers: { devpipe: { command: "node" } } },
    });
    const first = await session.dispatch("first");
    await expect(session.dispatch("/compact")).rejects.toThrow(/当前轮次仍在运行/);
    const accepted = await session.steer("more context");
    expect(first).toMatchObject({ kind: "started", turnId: "turn-1" });
    expect(accepted).toBe(true);
    await expect(first.completion).resolves.toMatchObject({
      ok: true,
      resultText: "steered",
      usage: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 9 },
    });
    expect(await session.steer("too late")).toBe(false);
    await session.close();
  });

  it("tracks the provider turn created by native history compaction", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_COMPACT_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const session = await CodexManagedSession.resume("thread-1", {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      child,
      permissionProfile: "full_access",
    });
    const compact = await session.dispatch("/compact");
    expect(compact).toMatchObject({ kind: "started", turnId: "turn-compact" });
    const completed = await compact.completion;
    expect(completed).toMatchObject({
      ok: true,
      status: "completed",
    });
    expect(completed.resultText).toBeUndefined();
    await session.close();
  });

  it("rejoins an opt-in external TUI without overriding its existing policy", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_PRESERVE_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const session = await CodexManagedSession.resume("thread-1", {
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child,
      preserveThreadPolicy: true,
    });
    const turn = await session.dispatch("inherit external policy");
    await expect(turn.completion).resolves.toMatchObject({ ok: true });
    expect(session.permissionProfile).toBeUndefined();
    await session.close();
  });

  it("forks a trusted rollout path into a new managed thread", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_FORK_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const session = await CodexManagedSession.forkFromPath("thread-a", "/srv/codex/a/session.jsonl", {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      child,
      permissionProfile: "full_access",
    });
    expect(session.sessionId).toBe("thread-b");
    const turn = await session.dispatch("continue on reserve");
    await expect(turn.completion).resolves.toMatchObject({
      ok: true,
      resultText: "fallback done",
    });
    await session.close();
  });

  it.each(["start", "resume", "fork", "preserve-policy"] as const)(
    "selects the acquired remote environment on every %s turn",
    async (mode) => {
      const child = spawn(process.execPath, ["-e", FAKE_TURN_ENVIRONMENT_SERVER], {
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
      const options = {
        cwd: "/tmp/runtime-control",
        timeoutMs: 5_000,
        child,
        permissionProfile: "full_access" as const,
        ...(mode === "preserve-policy" ? { preserveThreadPolicy: true } : {}),
        environment: { environmentId: "fresh-relay", execServerUrl: "ws://127.0.0.1:32123" },
      };
      const session = mode === "start" ? await CodexManagedSession.start(options)
        : mode === "fork" ? await CodexManagedSession.forkFromPath("source-thread", "/trusted/source.jsonl", options)
        : await CodexManagedSession.resume("thread-environment", options);
      try {
        expect(session.transcriptPath).toBe("/host/codex/sessions/thread-environment.jsonl");
        for (const prompt of ["first turn", "second turn"]) {
          const dispatch = await session.dispatch(prompt);
          await expect(dispatch.completion).resolves.toMatchObject({ ok: true, resultText: "remote environment selected" });
        }
      } finally {
        await session.close();
      }
    },
  );

  it("converts environment file URIs into target-native thread paths", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_ENVIRONMENT_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const session = await CodexManagedSession.start({
      cwd: "/tmp/runtime-control",
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child,
      permissionProfile: "full_access",
      environment: {
        environmentId: "octopus-op",
        execServerUrl: "ws://127.0.0.1:32123",
      },
    });
    expect(session.sessionId).toBe("thread-environment");
    expect(session.transcriptPath).toBeUndefined();
    await session.close();
  });
});

describe("Codex transport death between beginTurn and completed", () => {
  it("rejects protocol work when stdin reports an asynchronous EPIPE", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const client = new CodexJsonRpcClient(child, "thread-1", new AgentInteractionBroker());
    const pending = client.request("initialize", {}, 60_000);
    const handled = child.stdin.emit(
      "error",
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    );

    expect(handled).toBe(true);
    await expect(pending).rejects.toThrow(/EPIPE/);
    await client.close();
  });

  it("rejects the completion instead of waiting for the turn timeout", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(3), 30)"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const client = new CodexJsonRpcClient(child, "thread-1", new AgentInteractionBroker());
    client.beginTurn();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // With the completion left pending, this would sit out the full 60s and
    // time the test run out; the transport failure must surface immediately.
    await expect(client.completed(60_000)).rejects.toThrow(/exited/);
  });
});

describe("Codex provider refusals", () => {
  it("explains a thread that is structurally closed to outside input as a permanent answer", () => {
    const error = codexRequestError("direct app-server input is not allowed for multi-agent v2 sub-agents");
    expect(error.code).toBe("codex_subagent_thread");
    // Every Codex entry point refuses the same thread for the same reason.
    expect(error.safeFallback).toBe(false);
    expect(error.message).toContain("子 agent");
    expect(error.message).toContain("父 agent");
    // The provider's own sentence survives as evidence.
    expect(error.message).toContain("multi-agent v2 sub-agents");
  });

  it("leaves every other provider error alone", () => {
    const error = codexRequestError("turn result unavailable");
    expect(error.message).toBe("turn result unavailable");
    expect(error.code).toBeUndefined();
    expect(error.safeFallback).toBeUndefined();
    expect(codexRequestError(undefined).message).toBe("codex app-server request failed");
  });

  it("surfaces the explanation through a resume that the app-server refuses", async () => {
    const child = spawn(process.execPath, ["-e", FAKE_SUBAGENT_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    await expect(CodexManagedSession.resume("thread-sub", {
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 1_000,
      child,
      permissionProfile: "full_access",
    })).rejects.toMatchObject({
      // Refused BEFORE turn/start: nothing owns the prompt, but the answer is
      // permanent, so the caller still must not retry another way.
      safeFallback: false,
      message: expect.stringContaining("子 agent"),
    });
  });
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for interaction");
}

const FAKE_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/read") return send({ id: msg.id, result: { thread: { id: msg.params.threadId, status: { type: "idle" } } } });
  if (msg.method === "thread/resume") {
    const p = msg.params || {};
    if (p.approvalPolicy !== "untrusted" || p.approvalsReviewer !== "user" || p.sandbox !== "read-only" || !p.cwd) {
      return send({ id: msg.id, error: { message: "browser-managed turn did not request manual review" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  }
  if (msg.method === "turn/start") {
    const p = msg.params || {};
    if (p.approvalPolicy !== "untrusted" || p.approvalsReviewer !== "user" ||
        !p.sandboxPolicy || p.sandboxPolicy.type !== "readOnly" || p.sandboxPolicy.networkAccess !== false) {
      return send({ id: msg.id, error: { message: "manual turn override missing" } });
    }
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    return send({ id: 99, method: "item/tool/requestUserInput", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-q", isBlocking: true,
      questions: [{ id: "scope", header: "Scope", question: "Which?", options: [{ label: "small", description: "Small" }] }]
    }});
  }
  if (msg.id === 99 && msg.result) return send({ id: 100, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-c", startedAtMs: Date.now(), command: "echo ok", cwd: process.cwd()
  }});
  if (msg.id === 100 && msg.result) {
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "a", delta: "done" } });
    return send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [], error: null } } });
  }
});
`;

const FAKE_SUBAGENT_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/read") return send({ id: msg.id, result: { thread: { id: msg.params.threadId, status: { type: "idle" }, canAcceptDirectInput: false } } });
  if (msg.method === "thread/resume") {
    return send({ id: msg.id, error: { message: "direct app-server input is not allowed for multi-agent v2 sub-agents" } });
  }
});
`;

const FAKE_COLD_SUBAGENT_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/read") {
    const p = msg.params || {};
    if (p.includeTurns !== false) return send({ id: msg.id, error: { message: "turns must stay unread" } });
    return send({ id: msg.id, result: { thread: {
      id: p.threadId,
      parentThreadId: "thread-middle",
      status: { type: "notLoaded" },
      canAcceptDirectInput: false
    } } });
  }
  if (msg.method === "thread/resume") {
    return send({ id: msg.id, error: { message: "closed child must be forked without resume" } });
  }
  if (msg.method === "thread/fork") {
    const p = msg.params || {};
    if (p.threadId !== "thread-leaf" || p.path !== "/srv/codex/thread-leaf.jsonl" ||
        p.approvalPolicy !== "never" || p.sandbox !== "danger-full-access") {
      return send({ id: msg.id, error: { message: "closed sub-agent fork contract mismatch" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-fork", canAcceptDirectInput: true } } });
  }
  if (msg.method === "turn/start") {
    if (msg.params.threadId !== "thread-fork") {
      return send({ id: msg.id, error: { message: "wrong target thread" } });
    }
    send({ id: msg.id, result: { turn: { id: "turn-child" } } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-fork", turnId: "turn-child", delta: "child continued"
    } });
    return send({ method: "turn/completed", params: {
      threadId: "thread-fork", turn: { id: "turn-child", status: "completed" }
    } });
  }
});
`;

const FAKE_COLD_WRITABLE_SUBAGENT_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const loaded = [];
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/read") {
    const p = msg.params || {};
    if (p.includeTurns !== false) return send({ id: msg.id, error: { message: "turns must stay unread" } });
    const parents = { "thread-leaf": "thread-middle", "thread-middle": "thread-root", "thread-root": null };
    return send({ id: msg.id, result: { thread: {
      id: p.threadId,
      parentThreadId: parents[p.threadId],
      status: { type: "notLoaded" },
      canAcceptDirectInput: true
    } } });
  }
  if (msg.method === "thread/resume") {
    const p = msg.params || {};
    loaded.push(p.threadId);
    if (p.threadId !== "thread-leaf" && (p.approvalPolicy || p.sandbox || p.permissions)) {
      return send({ id: msg.id, error: { message: "ancestor policy was changed" } });
    }
    if (p.threadId === "thread-leaf") {
      if (loaded.join(",") !== "thread-root,thread-middle,thread-leaf") {
        return send({ id: msg.id, error: { message: "lineage was not loaded root-first exactly once" } });
      }
      if (p.approvalPolicy !== "never" || p.sandbox !== "danger-full-access") {
        return send({ id: msg.id, error: { message: "target policy missing" } });
      }
    }
    return send({ id: msg.id, result: { thread: { id: p.threadId, canAcceptDirectInput: true } } });
  }
  if (msg.method === "turn/start") {
    if (msg.params.threadId !== "thread-leaf") {
      return send({ id: msg.id, error: { message: "wrong target thread" } });
    }
    send({ id: msg.id, result: { turn: { id: "turn-child" } } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-leaf", turnId: "turn-child", delta: "child resumed"
    } });
    return send({ method: "turn/completed", params: {
      threadId: "thread-leaf", turn: { id: "turn-child", status: "completed" }
    } });
  }
});
`;

const FAKE_FULL_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/read") return send({ id: msg.id, result: { thread: { id: msg.params.threadId, status: { type: "idle" } } } });
  if (msg.method === "thread/resume") {
    const p = msg.params || {};
    if (p.approvalPolicy !== "never" || p.approvalsReviewer !== "user" || p.sandbox !== "danger-full-access" ||
        p.model !== "gpt-5.6-terra" || !p.config || p.config.model_reasoning_effort !== "xhigh") {
      return send({ id: msg.id, error: { message: "full thread model/effort override missing" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  }
  if (msg.method === "turn/start") {
    const p = msg.params || {};
    if (p.approvalPolicy !== "never" || p.approvalsReviewer !== "user" ||
        !p.sandboxPolicy || p.sandboxPolicy.type !== "dangerFullAccess") {
      return send({ id: msg.id, error: { message: "full turn override missing" } });
    }
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    return send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
});
`;

const FAKE_COMPACT_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/read") {
    return send({ id: msg.id, result: { thread: { id: msg.params.threadId, status: { type: "idle" } } } });
  }
  if (msg.method === "thread/resume") {
    return send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  }
  if (msg.method === "turn/start" || msg.method === "turn/steer") {
    return send({ id: msg.id, error: { message: "compact command leaked into a text turn" } });
  }
  if (msg.method === "thread/compact/start") {
    const keys = Object.keys(msg.params || {});
    if (keys.length !== 1 || keys[0] !== "threadId" || msg.params.threadId !== "thread-1") {
      return send({ id: msg.id, error: { message: "compact params were not thread-only" } });
    }
    send({ method: "turn/started", params: {
      threadId: "thread-neighbor", turn: { id: "turn-neighbor", status: "inProgress", items: [] }
    } });
    send({ method: "turn/completed", params: {
      threadId: "thread-neighbor", turn: { id: "turn-neighbor", status: "completed" }
    } });
    send({ method: "turn/started", params: {
      threadId: "thread-1", turn: { id: "turn-compact", status: "inProgress", items: [] }
    } });
    send({ method: "item/started", params: {
      threadId: "thread-1", turnId: "turn-compact", item: { type: "contextCompaction", id: "compact-1" }
    } });
    send({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-compact", status: "completed" }
    } });
    return send({ id: msg.id, result: {} });
  }
});
`;

const FAKE_FORK_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => {
  const line = JSON.stringify(value) + "\n";
  process.stdout.write(line);
};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/fork") {
    const p = msg.params || {};
    if (p.threadId !== "thread-a" || p.path !== "/srv/codex/a/session.jsonl" ||
        p.approvalPolicy !== "never" || p.sandbox !== "danger-full-access") {
      return send({ id: msg.id, error: { message: "fork contract mismatch" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-b" } } });
  }
  if (msg.method === "turn/start") {
    if (msg.params.threadId !== "thread-b") {
      return send({ id: msg.id, error: { message: "wrong fallback thread" } });
    }
    send({ id: msg.id, result: { turn: { id: "turn-b" } } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-b", turnId: "turn-b", delta: "fallback done"
    } });
    return send({ method: "turn/completed", params: {
      threadId: "thread-b", turn: { id: "turn-b", status: "completed" }
    } });
  }
});
`;

const FAKE_STEER_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/read") return send({ id: msg.id, result: { thread: { id: msg.params.threadId, status: { type: "idle" } } } });
  if (msg.method === "thread/resume") return send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  if (msg.method === "turn/start") {
    const p = msg.params || {};
    if (p.approvalPolicy !== "never" || !p.sandboxPolicy || p.sandboxPolicy.type !== "dangerFullAccess") {
      return send({ id: msg.id, error: { message: "managed full profile missing" } });
    }
    return send({ id: msg.id, result: { turn: { id: "turn-1" } } });
  }
  if (msg.method === "turn/steer") {
    if (msg.params.expectedTurnId !== "turn-1") return send({ id: msg.id, error: { message: "wrong turn" } });
    if (msg.params.approvalPolicy || msg.params.sandboxPolicy || msg.params.sandbox) {
      return send({ id: msg.id, error: { message: "steer must inherit profile" } });
    }
    send({ id: msg.id, result: { turnId: "turn-1" } });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "steered" } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: {
      total: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 9 },
      last: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 9 }
    } } });
    return send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
});
`;

const FAKE_PRESERVE_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/read") return send({ id: msg.id, result: { thread: { id: msg.params.threadId, status: { type: "idle" } } } });
  if (msg.method === "thread/resume") {
    const p = msg.params || {};
    if (p.approvalPolicy || p.approvalsReviewer || p.sandbox || p.permissions) {
      return send({ id: msg.id, error: { message: "external thread policy was overridden" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  }
  if (msg.method === "turn/start") {
    const p = msg.params || {};
    if (p.approvalPolicy || p.approvalsReviewer || p.sandboxPolicy || p.permissions) {
      return send({ id: msg.id, error: { message: "external turn policy was overridden" } });
    }
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    return send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
});
`;

const FAKE_ENVIRONMENT_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "environment/add") return send({ id: msg.id, result: {} });
  if (msg.method === "environment/info") {
    return send({
      id: msg.id,
      result: {
        cwd: "file:///tmp/execution/project",
        shell: { name: "bash", path: "/bin/bash" }
      }
    });
  }
  if (msg.method === "thread/start") {
    const p = msg.params || {};
    const environment = Array.isArray(p.environments) ? p.environments[0] : {};
    if (p.cwd !== "/tmp/execution/project" ||
        environment.cwd !== "/tmp/execution/project" ||
        environment.environmentId !== "octopus-op") {
      return send({ id: msg.id, error: { message: "environment cwd was not converted" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-environment" } } });
  }
});
`;

// This models the installed 0.154 protocol: resume/fork do not accept
// environments, and loading a thread does not select this attachment's relay.
const FAKE_TURN_ENVIRONMENT_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let turn = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize" || msg.method === "environment/add") return send({ id: msg.id, result: {} });
  if (msg.method === "environment/info") return send({ id: msg.id, result: {
    cwd: "file:///tmp/execution/project", shell: { name: "bash", path: "/bin/bash" }
  } });
  if (msg.method === "thread/read") return send({ id: msg.id, result: { thread: {
    id: "thread-environment", status: { type: "notLoaded" }, canAcceptDirectInput: true
  } } });
  if (["thread/start", "thread/resume", "thread/fork"].includes(msg.method)) {
    if (msg.method !== "thread/start" && msg.params.environments !== undefined) {
      return send({ id: msg.id, error: { message: "unsupported thread environment field" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-environment", path: "/host/codex/sessions/thread-environment.jsonl" } } });
  }
  if (msg.method === "turn/start") {
    const e = msg.params.environments;
    if (!Array.isArray(e) || e.length !== 1 || e[0].environmentId !== "fresh-relay" ||
        e[0].cwd !== "/tmp/execution/project" ||
        JSON.stringify(e[0].runtimeWorkspaceRoots) !== '["/tmp/execution/project"]') {
      return send({ id: msg.id, error: { message: "native tools would execute in a stale or local environment" } });
    }
    const turnId = "turn-" + (++turn);
    send({ id: msg.id, result: { turn: { id: turnId } } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-environment", turnId, delta: "remote environment selected"
    } });
    return send({ method: "turn/completed", params: {
      threadId: "thread-environment", turn: { id: turnId, status: "completed" }
    } });
  }
});
`;


function elicitationServer(params: Record<string, unknown>): string {
  return `
const readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
 const msg = JSON.parse(line);
 if (msg.method === "initialize") return send({id:msg.id,result:{}});
 if (msg.method === "thread/read") return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:{type:"idle"}}}});
 if (msg.method === "thread/resume") return send({id:msg.id,result:{thread:{id:"thread-1"}}});
 if (msg.method === "turn/start") {
  send({id:msg.id,result:{turn:{id:"turn-1"}}});
  return send({id:99,method:"mcpServer/elicitation/request",params:{threadId:"thread-1",serverName:"octopus_execution",message:"Allow run_workspace_command?",...${JSON.stringify(params)}}});
 }
 if (msg.id === 99) {
  send({method:"item/agentMessage/delta",params:{threadId:"thread-1",turnId:"turn-1",itemId:"reply",delta:JSON.stringify(msg.result)}});
  send({method:"turn/completed",params:{threadId:"thread-1",turn:{id:"turn-1",status:"completed",items:[],error:null}}});
 }
});`;
}
