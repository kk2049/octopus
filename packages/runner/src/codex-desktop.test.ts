import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexDesktopSession } from "./codex-desktop.js";
import { notSentRefusalCode } from "./input-handoff.js";

const SESSION = "01a12534-0000-7000-9000-000000000832";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function gui(options: { noOwner?: boolean; drop?: boolean; version?: number; active?: boolean; reject?: boolean;
  legacy?: boolean; snapshotId?: string; protocolAfterSend?: "before-ack" | "with-ack" } = {}) {
  const home = await mkdtemp(join(tmpdir(), "codex-desktop-"));
  await mkdir(join(home, "ipc"), { mode: 0o700 });
  const sockets = new Set<Socket>();
  const requests: Record<string, any>[] = [];
  let revision = 1;
  const key = options.legacy ? "0" : options.active ? "native" : "sent";
  const turnPath = options.legacy ? ["turns"] : ["turnHistory", "history", "entitiesByKey"];
  const turns: Record<string, unknown> = options.active ? { [key]: { turnId: "native-turn", status: "inProgress" } } : {};
  const frame = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    return Buffer.concat([header, body]);
  };
  const stateMessage = (change: unknown, version = options.version ?? 11, params = {}, sourceClientId = "gui") => ({
    type: "broadcast", sourceClientId, method: "thread-stream-state-changed", version,
    params: { conversationId: SESSION, hostId: "local", change, ...params },
  });
  const send = (socket: Socket, value: unknown) => {
    const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(data.length);
    // Exercise partial frame headers and coalesced bodies without assuming packets.
    socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), data]));
  };
  const broadcast = (change: unknown, version = options.version ?? 11, params = {}, sourceClientId = "gui") => {
    for (const socket of sockets) send(socket, stateMessage(change, version, params, sourceClientId));
  };
  const snapshot = () => broadcast({ type: "snapshot", revision, conversationState: { id: options.snapshotId ?? SESSION,
    ...(options.legacy ? { turns: Object.values(turns) } : { turnHistory: { kind: "canonical", history: { entitiesByKey: turns } } }) } });
  const patch = (patches: unknown[]) => broadcast({ type: "patches", baseRevision: revision, revision: ++revision, patches });
  const finish = (status = "completed", error?: string) => patch([
    ...(error ? [{ op: "replace", path: [...turnPath, key, "error"], value: { message: error } }] : []),
    { op: "replace", path: [...turnPath, key, "status"], value: status },
  ]);
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const n = buffer.readUInt32LE(0), m = JSON.parse(buffer.subarray(4, n + 4).toString()); buffer = buffer.subarray(n + 4);
        requests.push(m);
        if (m.type === "broadcast") { snapshot(); continue; }
        const response = (result: unknown) => ({ type: "response", requestId: m.requestId, method: m.method,
          resultType: "success", handledByClientId: m.method === "initialize" ? "client" : "gui", result });
        const reply = (result: unknown) => send(socket, response(result));
        if (m.method === "initialize") reply({ clientId: "client" });
        else if (m.method === "thread-owner-discovery") {
          if (options.noOwner) send(socket, { type: "response", requestId: m.requestId, resultType: "error", error: "no-client-found" });
          else reply({ supportsUntrustedAppInput: true });
        } else if (m.method === "thread-follower-interrupt-turn") { reply({ interruptedTurnId: options.active ? "native-turn" : "sent-turn", ok: true }); finish("interrupted"); }
        else {
          if (options.drop) { socket.destroy(); continue; }
          if (options.reject) { send(socket, { type: "response", requestId: m.requestId, resultType: "error", error: "refused" }); continue; }
          if (!options.active) {
            turns[key] = { turnId: "sent-turn", status: "inProgress" };
            patch([{ op: "add", path: [...turnPath, key], value: turns[key] }]);
          }
          // The official owner wraps start's turn and steer's turnId in result.result.
          const result = { result: options.active ? { turnId: "native-turn" } : { turn: { id: "sent-turn" } } };
          if (options.protocolAfterSend) {
            const unsupported = stateMessage({ type: "patches", baseRevision: revision, revision: ++revision, patches: [] }, 999);
            socket.write(Buffer.concat([...(options.protocolAfterSend === "with-ack" ? [frame(response(result))] : []), frame(unsupported)]));
          } else reply(result);
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(join(home, "ipc/ipc.sock"), resolve));
  await chmod(join(home, "ipc/ipc.sock"), 0o600);
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); });
  const open = async (timeoutMs = 0) => {
    const client = await CodexDesktopSession.connect(SESSION, { codexHome: home, timeoutMs });
    if (client) cleanup.push(() => client.close());
    return client;
  };
  return { home, open, finish, requests, sockets, broadcast, patch, turnPath, key };
}

it.each([11, 13])("stream v%s sends through the GUI owner, preserves policy, and follows exact completion", async version => {
  const fixture = await gui({ version }); const client = (await fixture.open())!;
  const action = await client.dispatch("hello");
  expect(action.kind).toBe("started"); expect(client.turnActive).toBe(true);
  const request = fixture.requests.find(row => row.method === "thread-follower-start-turn")!;
  expect(request.targetClientId).toBe("gui");
  expect(request.version).toBe(2);
  expect(request.params.conversationId).toBe(SESSION);
  expect(fixture.requests.filter(row => row.method === "thread-follower-start-turn")).toHaveLength(1);
  expect(request.params.turnStart.request).toEqual({ threadId: SESSION, input: [{ type: "text", text: "hello", text_elements: [] }] });
  expect(request.params.turnStart.context.inheritThreadSettings).toBe(true);
  fixture.finish(); expect(await action.completion).toMatchObject({ ok: true, status: "completed" });
  expect(client.turnActive).toBe(false); await client.close();
  expect((await stat(join(fixture.home, "ipc/ipc.sock"))).isSocket()).toBe(true);
});
it.each([11, 13])("stream v%s steers a GUI-owned active turn and pins stop to its exact turn", async version => {
  const fixture = await gui({ active: true, version }); const client = (await fixture.open())!;
  const action = await client.dispatch("follow-up"); expect(action.kind).toBe("steered");
  await client.interrupt(); expect(await action.completion).toMatchObject({ status: "interrupted" });
  expect(fixture.requests.filter(row => row.method === "thread-follower-start-turn")).toHaveLength(0);
  expect(fixture.requests.filter(row => row.method === "thread-follower-steer-turn")).toEqual([expect.objectContaining({
    version: 1, targetClientId: "gui", params: { conversationId: SESSION, input: [{ type: "text", text: "follow-up", text_elements: [] }] },
  })]);
  expect(fixture.requests.find(row => row.method === "thread-follower-interrupt-turn")).toMatchObject({ version: 4,
    params: { conversationId: SESSION, mode: "user-stop", expectedTurnId: "native-turn" } });
});
it("closes follower connections on teardown without interrupting the external GUI", async () => {
  const fixture = await gui(); const client = (await fixture.open())!; const action = await client.dispatch("hello");
  await client.close(); expect(await action.completion).toMatchObject({ ok: false });
  await expect.poll(() => fixture.sockets.size).toBe(0);
  expect(fixture.requests.some(row => row.method === "thread-follower-interrupt-turn")).toBe(false);
});
it("never retries an input when acknowledgement is lost", async () => {
  const fixture = await gui({ drop: true }); const client = (await fixture.open())!;
  await expect(client.dispatch("once")).rejects.toThrow(/closed/);
  expect(fixture.requests.filter(row => row.method === "thread-follower-start-turn")).toHaveLength(1);
});
it("allows native fallback only for absent GUI or explicit no owner", async () => {
  const fixture = await gui({ noOwner: true }); expect(await fixture.open()).toBeNull();
  expect(await CodexDesktopSession.connect(SESSION, { codexHome: join(fixture.home, "absent"), timeoutMs: 0 })).toBeNull();
});
it("fails closed on incompatible versions and writable sockets", async () => {
  const fixture = await gui({ version: 999 }); await expect(fixture.open()).rejects.toMatchObject({ code: "codex_gui_protocol_unsupported", inputNotSent: true,
    message: expect.stringMatching(/收到版本 999，支持版本 11、13.*消息尚未发送/) });
  expect(fixture.requests.some(row => row.method.startsWith("thread-follower-"))).toBe(false);
  await chmod(join(fixture.home, "ipc/ipc.sock"), 0o666);
  await expect(fixture.open()).rejects.toThrow(/private/);
});
it("rejects provider failures without holding a writer lock", async () => {
  const fixture = await gui({ reject: true }); const client = (await fixture.open())!;
  await expect(client.dispatch("hello")).rejects.toThrow(/refused/); await client.close();
  await expect.poll(() => fixture.sockets.size).toBe(0);
});
it("interrupts only the admitted turn at deadline then detaches", async () => {
  const fixture = await gui(); const client = (await fixture.open(30))!;
  const action = await client.dispatch("hello"); expect((await action.completion).ok).toBe(false);
  await expect.poll(() => fixture.sockets.size).toBe(0);
});

it.each([11, 13])("stream v%s retains legacy turns snapshots and patches", async version => {
  const fixture = await gui({ version, legacy: true }); const client = (await fixture.open())!;
  const action = await client.dispatch("once");
  fixture.finish();
  expect(await action.completion).toMatchObject({ ok: true, status: "completed" });
});

it.each(["completed", "failed", "interrupted"])("v13 follows canonical turn insertion, identity, error and %s patches", async status => {
  const fixture = await gui({ version: 13 }); const client = (await fixture.open())!;
  const action = await client.dispatch("once");
  fixture.patch([
    { op: "add", path: [...fixture.turnPath, "unrelated"], value: { turnId: "other", status: "completed" } },
    { op: "remove", path: [...fixture.turnPath, "unrelated"] },
    { op: "replace", path: [...fixture.turnPath, fixture.key, "turnId"], value: "sent-turn" },
    // Transcript/tool payloads are irrelevant to lifecycle projection.
    { op: "add", path: [...fixture.turnPath, fixture.key, "items", 0], value: { type: "agentMessage", text: "ignored" } },
  ]);
  fixture.finish(status, status === "failed" ? "native failure" : undefined);
  expect(await action.completion).toMatchObject({ started: true, ok: status === "completed", status,
    ...(status === "failed" ? { error: "native failure" } : {}) });
});

it("v13 ignores foreign broadcasts and still requires exact revision continuity", async () => {
  const fixture = await gui({ version: 13 }); const client = (await fixture.open())!;
  const action = await client.dispatch("once");
  fixture.broadcast({}, 999, { conversationId: "foreign" });
  fixture.broadcast({}, 999, { hostId: "remote" });
  fixture.broadcast({}, 999, {}, "foreign-owner");
  fixture.broadcast({ type: "patches", baseRevision: 99, revision: 100, patches: [] });
  expect(await action.completion).toMatchObject({ ok: false, error: "Codex GUI stream revision gap" });
  expect(fixture.requests.filter(row => row.method === "thread-follower-start-turn")).toHaveLength(1);
});

it("v13 refuses a snapshot for the wrong session before dispatch", async () => {
  const fixture = await gui({ version: 13, snapshotId: "foreign" });
  await expect(fixture.open()).rejects.toThrow("snapshot identity mismatch");
  expect(fixture.requests.some(row => row.method.startsWith("thread-follower-"))).toBe(false);
});

it("does not accept an unverified intermediate version", async () => {
  const fixture = await gui({ version: 12 });
  await expect(fixture.open()).rejects.toMatchObject({ code: "codex_gui_protocol_unsupported", inputNotSent: true,
    message: expect.stringContaining("收到版本 12，支持版本 11、13") });
});

it("does not mark a protocol error before acknowledgement as not sent", async () => {
  const fixture = await gui({ version: 13, protocolAfterSend: "before-ack" }); const client = (await fixture.open())!;
  const error = await client.dispatch("once").catch(error => error);
  expect(error).toMatchObject({ code: "codex_gui_protocol_unsupported", message: expect.stringContaining("消息可能已发送") });
  expect(notSentRefusalCode(error)).toBeUndefined();
  expect(fixture.requests.filter(row => row.method === "thread-follower-start-turn")).toHaveLength(1);
});

it("retains an acknowledgement followed by an unsupported update in the same frame batch", async () => {
  const fixture = await gui({ version: 13, protocolAfterSend: "with-ack" }); const client = (await fixture.open())!;
  const action = await client.dispatch("once");
  expect(action).toMatchObject({ kind: "started", turnId: "sent-turn" });
  expect(await action.completion).toMatchObject({ started: true, ok: false, error: expect.stringContaining("消息可能已发送") });
  expect(client.turnActive).toBe(false);
});

it.each(["protocol", "disconnect"])("retains accepted input when following later fails: %s", async failure => {
  const fixture = await gui({ version: 13 }); const client = (await fixture.open())!;
  const action = await client.dispatch("once");
  if (failure === "protocol") fixture.broadcast({}, 999);
  else for (const socket of fixture.sockets) socket.destroy();
  const result = await action.completion;
  expect(result).toMatchObject({ started: true, ok: false });
  expect(result.error).not.toContain("消息尚未发送");
  expect(fixture.requests.filter(row => row.method === "thread-follower-start-turn")).toHaveLength(1);
});

// Exercise real sockets, admission, handleRpc and on-disk receipts together.
// Only external process discovery/execution is replaced, never the GUI adapter.
async function durableGui(options: Parameters<typeof gui>[0]) {
  const fixture = await gui(options);
  const [{ handleRpc }, { AgentControlPlane }, { AgentRuntimeRegistry }, { AgentInteractionBroker },
    { RunnerSessionOperations }, { CodexManagedSession }] = await Promise.all([
    import("./core.js"), import("./agent-control-plane.js"), import("./agent-runtime.js"), import("./agent-interactions.js"),
    import("./session-operations.js"), import("./codex-app-server.js"),
  ]);
  const native = vi.spyOn(CodexManagedSession, "resume").mockRejectedValue(new Error("unexpected second writer"));
  const queue = vi.fn().mockRejectedValue(new Error("unexpected queue fallback"));
  const plane = new AgentControlPlane({ timeoutMs: 0, interactions: new AgentInteractionBroker(),
    runtime: new AgentRuntimeRegistry({ processReader: { read: async () => null, signal: () => {} } }),
    codexDiscovery: async () => {}, queueCodexPrompt: queue });
  cleanup.push(() => plane.close());
  const continueSession = vi.spyOn(plane, "continueSession");
  const directory = join(fixture.home, "sessions", "2026", "11", "15");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-2026-11-15T00-00-00-${SESSION}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: fixture.home } }) + "\n");
  const journal = new RunnerSessionOperations(fixture.home);
  const rpcOptions = { allowMachineOps: true, sessionOperations: journal, agentControlPlane: plane,
    sessionScanRoot: { home: fixture.home, codexHome: fixture.home }, gatewaySite: "desktop-test" };
  const args = { id: SESSION, source: "codex", prompt: "one synthetic input", operation_id: "desktop-input", input_receipt: true };
  const append = (store = journal) => handleRpc(fixture.home, { id: "append", method: "append_session", args }, { ...rpcOptions, sessionOperations: store });
  const status = (store = journal) => handleRpc(fixture.home, { id: "status", method: "get_session_operation",
    args: { operation_id: args.operation_id } }, { ...rpcOptions, sessionOperations: store });
  return { ...fixture, journal, append, status, native, queue, continueSession, restart: () => new RunnerSessionOperations(fixture.home) };
}

it.each([
  { version: 999, state: "failed", code: "codex_gui_protocol_unsupported", sends: 0 },
  { version: 13, drop: true, state: "unknown", code: "unknown", sends: 1 },
  { version: 13, protocolAfterSend: "before-ack" as const, state: "unknown", code: "unknown", sends: 1 },
])("persists $state/$code through RPC and restart with $sends dispatches", async ({ state, code, sends, ...options }) => {
  const fixture = await durableGui(options);
  await expect(fixture.append()).resolves.toMatchObject({ ok: true });
  const expected = { ok: true, result: { state, session_id: SESSION, result: { ok: false, code } } };
  await expect.poll(() => fixture.status()).toMatchObject(expected);
  if (sends === 0) expect(await fixture.status()).toMatchObject({ result: {
    result: { error: expect.stringMatching(/收到版本 999，支持版本 11、13.*消息尚未发送/) },
  } });
  await fixture.append();
  const restarted = fixture.restart();
  expect(await fixture.status(restarted)).toMatchObject(expected);
  await fixture.append(restarted);
  expect(fixture.continueSession).toHaveBeenCalledOnce();
  expect(fixture.requests.filter(row => row.method.startsWith("thread-follower-"))).toHaveLength(sends);
  expect(fixture.native).not.toHaveBeenCalled(); expect(fixture.queue).not.toHaveBeenCalled();
}, 15_000);

it.each([false, true])("v13 RPC retains provider acceptance without replay after later failure (active=%s)", async active => {
  const fixture = await durableGui({ version: 13, active });
  await fixture.append();
  const turnId = active ? "native-turn" : "sent-turn";
  const expected = { ok: true, result: { input: { phase: "provider_accepted", session_id: SESSION, turn_id: turnId },
    result: { ok: true, turn_id: turnId, control_action: active ? "protocol_steer" : "protocol_send" } } };
  await expect.poll(() => fixture.status()).toMatchObject(expected);
  fixture.broadcast({}, 999);
  await expect.poll(() => fixture.sockets.size).toBe(0);
  const restarted = fixture.restart();
  expect(await fixture.status(restarted)).toMatchObject(expected);
  await fixture.append(restarted);
  expect(fixture.continueSession).toHaveBeenCalledOnce();
  expect(fixture.requests.filter(row => row.method.startsWith("thread-follower-"))).toHaveLength(1);
  expect(fixture.native).not.toHaveBeenCalled(); expect(fixture.queue).not.toHaveBeenCalled();
}, 15_000);
