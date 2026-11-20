/** Deterministic coverage for the Runner's whole-roster in-flight join. */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleRpc,
  RunnerRpcDispatcher,
  type RpcHandler,
  type RpcRequest,
  type RpcResponse,
} from "./core.js";

describe("Runner machine-operation audit", () => {
  it("records prompt size and digest without logging prompt text", async () => {
    const onMachineOp = vi.fn();
    const prompt = "private prompt: rotate the launch credentials";
    await handleRpc("/tmp", {
      id: "rpc-audit",
      method: "start_session",
      args: { source: "invalid", prompt, directory: "/tmp" },
    }, { allowMachineOps: true, onMachineOp });
    const expectedHash = createHash("sha256").update(prompt).digest("hex").slice(0, 12);
    expect(onMachineOp).toHaveBeenCalledOnce();
    expect(onMachineOp).toHaveBeenCalledWith(
      "start_session",
      expect.stringContaining(`prompt bytes=${Buffer.byteLength(prompt)} sha256=${expectedHash}`),
    );
    expect(onMachineOp.mock.calls[0][1]).not.toContain(prompt);
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function request(id: string, args: Record<string, unknown> = {}): RpcRequest {
  return { id, method: "list_recent_sessions", args };
}

function success(id: string, result: unknown = { sessions: [] }): RpcResponse {
  return { type: "rpc_result", id, ok: true, result };
}

describe("RunnerRpcDispatcher list_recent_sessions in-flight join", () => {
  it("runs one scan and runtime-enrichment pass for 20 equivalent concurrent RPCs, then rebinds every id", async () => {
    const release = deferred<void>();
    let scanPasses = 0;
    let runtimeEnrichmentPasses = 0;
    const seenArgs: Record<string, unknown>[] = [];
    const handler: RpcHandler = async (_home, req) => {
      scanPasses += 1;
      seenArgs.push(req.args);
      await release.promise;
      runtimeEnrichmentPasses += 1;
      return success(req.id, { marker: "shared-read" });
    };
    const dispatcher = new RunnerRpcDispatcher("/scan-home", {}, handler);

    const calls = Array.from({ length: 20 }, (_, index) => dispatcher.handle(request(`rpc-${index}`, {
      source: index % 2 ? "not-a-source" : undefined,
      limit: index % 2 ? "200" : 200,
      since_hours: index % 2 ? "24" : 24,
      ignored: index,
    })));
    await Promise.resolve();

    expect(scanPasses).toBe(1);
    expect(seenArgs).toEqual([{ source: "all", limit: 200, since_hours: 24 }]);
    release.resolve();
    const replies = await Promise.all(calls);

    expect(runtimeEnrichmentPasses).toBe(1);
    expect(replies.map((reply) => reply.id)).toEqual(Array.from({ length: 20 }, (_, index) => `rpc-${index}`));
    expect(replies.every((reply) => reply.ok && (reply.result as { marker?: string }).marker === "shared-read")).toBe(true);
    expect(new Set(replies.map((reply) => reply)).size).toBe(20);
  });

  it("does not join different sources, limits, ages or primary-window modes", async () => {
    const release = deferred<void>();
    const seen: Array<Record<string, unknown>> = [];
    const handler: RpcHandler = async (_home, req) => {
      seen.push(req.args);
      await release.promise;
      return success(req.id);
    };
    const dispatcher = new RunnerRpcDispatcher("/scan-home", {}, handler);

    const calls = [
      dispatcher.handle(request("base", { source: "all", limit: 200, since_hours: 24 })),
      dispatcher.handle(request("source", { source: "codex", limit: 200, since_hours: 24 })),
      dispatcher.handle(request("limit", { source: "all", limit: 199, since_hours: 24 })),
      dispatcher.handle(request("since", { source: "all", limit: 200, since_hours: 23 })),
      dispatcher.handle(request("primary", { source: "all", limit: 200, since_hours: 24, primary_window: true })),
    ];
    await Promise.resolve();

    expect(seen).toHaveLength(5);
    expect(seen).toContainEqual({ source: "all", limit: 200, since_hours: 24, primary_window: true });
    release.resolve();
    await Promise.all(calls);
  });

  it("keeps a canonical exact-id selector apart from the recent window and joins equal selectors", async () => {
    const release = deferred<void>();
    const seen: Array<Record<string, unknown>> = [];
    const handler: RpcHandler = async (_home, req) => {
      seen.push(req.args);
      await release.promise;
      return success(req.id);
    };
    const dispatcher = new RunnerRpcDispatcher("/scan-home", {}, handler);
    const calls = [
      dispatcher.handle(request("window", { limit: 2 })),
      dispatcher.handle(request("ids", { limit: 2, ids: "codex:a,claude:b" })),
      // Malformed and duplicate entries are dropped before the flight key.
      dispatcher.handle(request("same", { limit: 2, ids: "codex:a,bogus:x,claude:b,codex:a" })),
      dispatcher.handle(request("garbage", { limit: 2, ids: "nonsense" })),
    ];
    await Promise.resolve();
    expect(seen).toEqual([
      { source: "all", limit: 2 },
      { source: "all", limit: 2, ids: "codex:a,claude:b" },
    ]);
    release.resolve();
    await Promise.all(calls);
  });

  it("shares an RPC error, cleans the failed flight, and starts a fresh read for the next caller", async () => {
    const releaseFailure = deferred<void>();
    let attempts = 0;
    const handler: RpcHandler = async (_home, req) => {
      attempts += 1;
      if (attempts === 1) {
        await releaseFailure.promise;
        return { type: "rpc_result", id: req.id, ok: false, error: "cold read failed" };
      }
      return success(req.id, { attempt: attempts });
    };
    const dispatcher = new RunnerRpcDispatcher("/scan-home", {}, handler);

    const failed = [dispatcher.handle(request("failed-a")), dispatcher.handle(request("failed-b"))];
    await Promise.resolve();
    expect(attempts).toBe(1);
    releaseFailure.resolve();
    await expect(Promise.all(failed)).resolves.toMatchObject([
      { id: "failed-a", ok: false, error: "cold read failed" },
      { id: "failed-b", ok: false, error: "cold read failed" },
    ]);
    await expect(dispatcher.handle(request("retry"))).resolves.toMatchObject({
      id: "retry",
      ok: true,
      result: { attempt: 2 },
    });
    expect(attempts).toBe(2);
  });

  it("keeps the shared read alive when one caller times out and abandons its waiter", async () => {
    const release = deferred<void>();
    let calls = 0;
    const handler: RpcHandler = async (_home, req) => {
      calls += 1;
      await release.promise;
      return success(req.id);
    };
    const dispatcher = new RunnerRpcDispatcher("/scan-home", {}, handler);

    const abandoned = dispatcher.handle(request("timed-out"));
    const live = dispatcher.handle(request("still-waiting"));
    const callerDeadline = await Promise.race([
      abandoned.then(() => "completed"),
      Promise.resolve("caller-timeout"),
    ]);
    expect(callerDeadline).toBe("caller-timeout");
    expect(calls).toBe(1);

    release.resolve();
    await expect(live).resolves.toMatchObject({ id: "still-waiting", ok: true });
    await expect(abandoned).resolves.toMatchObject({ id: "timed-out", ok: true });
    expect(calls).toBe(1);
  });

  it("has no completed cache: a read after settlement starts a new flight", async () => {
    let calls = 0;
    const handler: RpcHandler = async (_home, req) => success(req.id, { pass: ++calls });
    const dispatcher = new RunnerRpcDispatcher("/scan-home", {}, handler);

    await expect(dispatcher.handle(request("one"))).resolves.toMatchObject({ result: { pass: 1 } });
    await expect(dispatcher.handle(request("two"))).resolves.toMatchObject({ result: { pass: 2 } });
    expect(calls).toBe(2);
  });

  it("never joins across dispatcher instances with different runtime/control-plane ownership", async () => {
    const release = deferred<void>();
    const calls = [0, 0];
    const handler = (index: number): RpcHandler => async (_home, req) => {
      calls[index] += 1;
      await release.promise;
      return success(req.id, { runtime: index });
    };
    const first = new RunnerRpcDispatcher("/scan-home", {}, handler(0));
    const second = new RunnerRpcDispatcher("/scan-home", {}, handler(1));

    const reads = [first.handle(request("first")), second.handle(request("second"))];
    await Promise.resolve();
    expect(calls).toEqual([1, 1]);
    release.resolve();
    await expect(Promise.all(reads)).resolves.toMatchObject([
      { id: "first", result: { runtime: 0 } },
      { id: "second", result: { runtime: 1 } },
    ]);
  });
});
