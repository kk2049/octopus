import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexManagedSession, type CodexManagedSessionOptions } from "./codex-app-server.js";

const METHODS = ["thread/start", "thread/resume", "thread/fork"] as const;
type InitializationMethod = typeof METHODS[number];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Codex thread initialization budgets", () => {
  it.each(METHODS)("keeps split %s alive beyond 30 seconds without replay", async (method) => {
    const server = fakeServer(method);
    const running = initialize(method, server.child, true);
    const outcome = observe(running);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(outcome.settled()).toBe(false);
    expect(server.kill).not.toHaveBeenCalled();
    const request = server.only(method);
    expect(request.params.cwd).toBe("/remote/worktree");
    if (method === "thread/start") {
      expect(request.params.environments).toEqual([{
        environmentId: "remote-execution",
        cwd: "/remote/worktree",
        runtimeWorkspaceRoots: ["/remote/worktree"],
      }]);
    } else {
      // Resume/fork do not accept thread-level environments in the native schema.
      expect(request.params).not.toHaveProperty("environments");
    }
    server.reply(request, { thread: { id: "thread-1" } });
    const session = await running;
    expect(session.sessionId).toBe("thread-1");
    expect(server.requests.filter((row) => row.method === "turn/start")).toHaveLength(0);
    await session.close();
    expect(server.kill).toHaveBeenCalledTimes(1);
  });

  it.each(METHODS)("fails split %s once at 120 seconds and closes its transport", async (method) => {
    const server = fakeServer(method);
    const outcome = observe(initialize(method, server.child, true));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(outcome.settled()).toBe(false);
    expect(server.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome.result).toEqual({
      error: expect.objectContaining({ message: `codex app-server ${method} timed out` }),
    });
    expect(server.kill).toHaveBeenCalledTimes(1);
    expect(server.kill).toHaveBeenCalledWith("SIGTERM");
    expect(server.only(method)).toBeDefined();
    // A provider can finish late; a closed client must not create another request.
    server.reply(server.only(method), { thread: { id: "late-thread" } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.requests.filter((row) => row.method === method)).toHaveLength(1);
    expect(server.requests.filter((row) => row.method === "turn/start")).toHaveLength(0);
  });

  it.each(METHODS)("keeps local %s bounded to 30 seconds", async (method) => {
    const server = fakeServer(method);
    const outcome = observe(initialize(method, server.child, false));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome.result).toEqual({
      error: expect.objectContaining({ message: `codex app-server ${method} timed out` }),
    });
    expect(server.kill).toHaveBeenCalledTimes(1);
    expect(server.only(method).params).not.toHaveProperty("environments");
    expect(server.requests.some((row) => row.method.startsWith("environment/"))).toBe(false);
  });

  it.each([55_000, 180_000])("keeps one resident input and its transport alive for a %dms acknowledgement", async (delay) => {
    const server = fakeServer("turn/start");
    const session = await initialize("thread/start", server.child, true, 0);
    const outcome = observe(session.dispatch("one input"));
    await vi.advanceTimersByTimeAsync(delay);
    expect(outcome.settled()).toBe(false);
    expect(server.kill).not.toHaveBeenCalled();
    await expect(session.dispatch("duplicate")).rejects.toThrow("不能重复发送");
    expect(server.only("turn/start").params.environments).toEqual([{
      environmentId: "remote-execution",
      cwd: "/remote/worktree",
      runtimeWorkspaceRoots: ["/remote/worktree"],
    }]);
    server.reply(server.only("turn/start"), { turn: { id: "turn-1" } });
    const action = await outcome.result;
    if (!("value" in action)) throw action.error;
    server.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    expect(await action.value.completion).toMatchObject({ ok: true });
    await session.close();
    expect(server.kill).toHaveBeenCalledOnce();
  });

  it("captures a fast answer from native completion even when the RPC response never arrives", async () => {
    const server = fakeServer("turn/start");
    const session = await initialize("thread/start", server.child, true, 0);
    const outcome = observe(session.dispatch("one input"));
    server.notify("turn/started", { threadId: "other-thread", turn: { id: "wrong" } });
    server.notify("item/agentMessage/delta", { threadId: "other-thread", delta: "wrong answer" });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(outcome.settled()).toBe(false);
    server.notify("item/completed", { threadId: "thread-1", item: { type: "agentMessage", text: "original answer" } });
    server.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    const result = await outcome.result;
    if (!("value" in result)) throw result.error;
    expect(result.value.turnId).toBe("turn-1");
    expect(await result.value.completion).toMatchObject({ ok: true, resultText: "original answer" });
    server.reply(server.only("turn/start"), { turn: { id: "turn-1" } });
    await session.close();
  });

  it("queues an explicit stop while start is pending and interrupts only that eventual turn", async () => {
    const server = fakeServer("turn/start");
    const session = await initialize("thread/start", server.child, true, 0);
    const starting = session.dispatch("one input");
    await session.interrupt();
    expect(server.requests.filter((row) => row.method === "turn/interrupt")).toHaveLength(0);
    server.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    const action = await starting;
    expect(server.only("turn/interrupt").params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    server.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } });
    expect(await action.completion).toMatchObject({ status: "interrupted" });
    await session.close();
  });

  it("settles a pending resident input on transport loss without resending", async () => {
    const server = fakeServer("turn/start");
    const session = await initialize("thread/start", server.child, true, 0);
    const outcome = observe(session.dispatch("one input"));
    server.kill("SIGTERM");
    expect(await outcome.result).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("exited") }) });
    expect(server.only("turn/start")).toBeDefined();
    await session.close();
  });

  it("keeps observing the accepted turn when a queued stop is rejected", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = fakeServer("turn/start", "turn/interrupt");
    const session = await initialize("thread/start", server.child, true, 0);
    try {
      const starting = session.dispatch("one input");
      await session.interrupt();
      server.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
      const action = await starting;
      server.reject(server.only("turn/interrupt"), "temporary control failure");
      await vi.advanceTimersByTimeAsync(0);
      expect(warning).toHaveBeenCalledOnce();
      expect(server.kill).not.toHaveBeenCalled();
      server.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
      expect(await action.completion).toMatchObject({ ok: true });
      expect(server.only("turn/start")).toBeDefined();
    } finally {
      await session.close();
      warning.mockRestore();
    }
  });

  it("settles a pending start when its owner explicitly closes the attachment", async () => {
    const server = fakeServer("turn/start");
    const session = await initialize("thread/start", server.child, true, 0);
    const outcome = observe(session.dispatch("one input"));
    await session.close();
    expect(await outcome.result).toMatchObject({ error: expect.objectContaining({ message: "codex app-server closed" }) });
  });

  it("retains an explicit embedding deadline and distinguishes a native rejection", async () => {
    const server = fakeServer("turn/start");
    const session = await initialize("thread/start", server.child, true, 10_000);
    const outcome = observe(session.dispatch("one input"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome.result).toMatchObject({ error: expect.objectContaining({ message: "codex app-server turn/start timed out" }) });
    await session.close();
    const refused = fakeServer("turn/start");
    const second = await initialize("thread/start", refused.child, true, 0);
    const rejected = observe(second.dispatch("rejected input"));
    refused.reject(refused.only("turn/start"), "model unavailable");
    expect(await rejected.result).toMatchObject({ error: expect.objectContaining({ message: "model unavailable", inputRejected: true }) });
    await second.close();
  });
});

function initialize(method: InitializationMethod, child: ChildProcessWithoutNullStreams, split: boolean, timeoutMs = 300_000) {
  const options: CodexManagedSessionOptions = {
    cwd: "/runtime/worktree",
    timeoutMs,
    child,
    ...(split ? {
      environment: {
        environmentId: "remote-execution",
        execServerUrl: "ws://127.0.0.1:43210",
      },
    } : {}),
  };
  if (method === "thread/start") return CodexManagedSession.start(options);
  if (method === "thread/resume") return CodexManagedSession.resume("thread-1", options);
  return CodexManagedSession.forkFromPath("source-thread", "/trusted/rollout.jsonl", options);
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    (value) => { settled = true; return { value }; },
    (error: unknown) => { settled = true; return { error }; },
  );
  return { result, settled: () => settled };
}

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** In-memory stdio exercises the actual JSON-RPC request timers and cleanup. */
function fakeServer(...heldMethods: string[]) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Request[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  const kill = vi.fn((signal: NodeJS.Signals) => {
    child.signalCode = signal;
    child.emit("exit", null, signal);
    return true;
  });
  const transport = Object.assign(child, { kill });
  const reply = (request: Request, result: unknown) => {
    stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  };
  stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as Request;
    if (request.id === undefined) return;
    requests.push(request);
    if (heldMethods.includes(request.method)) return;
    // Like a real pipe, response delivery follows registration of the waiter.
    queueMicrotask(() => reply(request,
      request.method === "environment/info"
        ? { cwd: "file:///remote/worktree" }
        : { thread: { id: "thread-1", status: { type: "notLoaded" } } }));
  });
  return {
    child: transport as unknown as ChildProcessWithoutNullStreams,
    kill,
    requests,
    reply,
    notify(method: string, params: unknown) { stdout.write(JSON.stringify({ method, params }) + "\n"); },
    reject(request: Request, message: string) { stdout.write(JSON.stringify({ id: request.id, error: { message } }) + "\n"); },
    only(method: string) {
      const matching = requests.filter((row) => row.method === method);
      expect(matching).toHaveLength(1);
      return matching[0]!;
    },
  };
}
