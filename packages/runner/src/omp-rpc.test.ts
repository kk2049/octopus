import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AgentInteractionBroker } from "./agent-interactions.js";
import {
  OmpFrameDecoder,
  OmpManagedSession,
  assertOmpPermissionProfile,
  lastAssistantText,
  ompRpcArgs,
} from "./omp-rpc.js";

describe("ompRpcArgs", () => {
  it("resumes by exact file path, never by an id prefix", () => {
    const args = ompRpcArgs({ cwd: "/w", resumePath: "/home/u/.omp/agent/sessions/-w/x_1-2-3-4-5.jsonl" });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("/home/u/.omp/agent/sessions/-w/x_1-2-3-4-5.jsonl");
  });

  it("always pins the one profile RPC mode can honour", () => {
    expect(ompRpcArgs({ cwd: "/w" })).toEqual(["--mode", "rpc", "--cwd", "/w", "--auto-approve"]);
  });

  it("passes the model and maps effort onto omp's thinking level", () => {
    const args = ompRpcArgs({ cwd: "/w", model: "gpt-5.6-sol", effort: "xhigh" });
    expect(args).toEqual(["--mode", "rpc", "--cwd", "/w", "--model", "gpt-5.6-sol", "--thinking", "xhigh", "--auto-approve"]);
  });

  it("disables every built-in tool when execution is delegated through MCP", () => {
    expect(ompRpcArgs({ cwd: "/control", remoteMcpUrl: "http://127.0.0.1:1234/session/x/mcp" }))
      .toEqual(["--mode", "rpc", "--cwd", "/control", "--auto-approve", "--no-tools"]);
  });
});

describe("assertOmpPermissionProfile", () => {
  it("refuses manual rather than silently auto-approving the session", () => {
    expect(() => assertOmpPermissionProfile("manual")).toThrow(/审批界面/);
    try {
      assertOmpPermissionProfile("manual");
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe("permission_profile_unsupported");
    }
  });

  it("accepts full access and an unset profile", () => {
    expect(() => assertOmpPermissionProfile("full_access")).not.toThrow();
    expect(() => assertOmpPermissionProfile(undefined)).not.toThrow();
  });
});

describe("OmpFrameDecoder", () => {
  const chunksFor = (value: unknown, count: number): Record<string, unknown>[] => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    const size = Math.ceil(bytes.byteLength / count);
    return Array.from({ length: count }, (_, index) => ({
      type: "rpc_chunk",
      chunkId: "rpc-1",
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
    }));
  };

  it("passes ordinary frames straight through", () => {
    const decoder = new OmpFrameDecoder();
    expect(decoder.push({ type: "ready" })).toEqual({ type: "ready" });
  });

  it("reassembles a chunked frame only once the whole sequence lands", () => {
    const decoder = new OmpFrameDecoder();
    const frame = { type: "response", command: "get_messages", data: { text: "x".repeat(500) } };
    const chunks = chunksFor(frame, 4);
    expect(decoder.push(chunks[0])).toBeNull();
    expect(decoder.push(chunks[1])).toBeNull();
    expect(decoder.push(chunks[2])).toBeNull();
    expect(decoder.push(chunks[3])).toEqual(frame);
  });

  it("rejects an interleaved sequence instead of parsing half a transcript", () => {
    const decoder = new OmpFrameDecoder();
    const chunks = chunksFor({ type: "response", data: "y".repeat(200) }, 3);
    decoder.push(chunks[0]);
    expect(() => decoder.push({ type: "agent_end", messages: [] })).toThrow(/打断/);
    // The aborted sequence must not poison the next one.
    expect(decoder.push({ type: "ready" })).toEqual({ type: "ready" });
  });

  it("rejects a skipped index and a sequence that does not start at 0", () => {
    const decoder = new OmpFrameDecoder();
    const chunks = chunksFor({ type: "response", data: "z".repeat(200) }, 3);
    decoder.push(chunks[0]);
    expect(() => decoder.push(chunks[2])).toThrow(/交错或跳号/);
    expect(() => new OmpFrameDecoder().push(chunks[1])).toThrow(/index 0/);
  });

  it("rejects a byte length that disagrees with the reassembled payload", () => {
    const decoder = new OmpFrameDecoder();
    const data = Buffer.from(`{"type":"ready"}`, "utf8").toString("base64");
    expect(() => decoder.push({
      type: "rpc_chunk",
      chunkId: "rpc-9",
      index: 0,
      count: 1,
      byteLength: 999,
      data,
    })).toThrow(/字节数与声明不符/);
  });
});

describe("lastAssistantText", () => {
  it("takes the last assistant text and ignores toolResult entries", () => {
    expect(lastAssistantText([
      { role: "assistant", content: [{ type: "text", text: "早先的回答" }] },
      { role: "toolResult", content: [{ type: "text", text: "工具输出" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "最终回答" }] },
    ])).toBe("最终回答");
  });

  it("returns empty for a non-array or text-free run", () => {
    expect(lastAssistantText(undefined)).toBe("");
    expect(lastAssistantText([{ role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash" }] }])).toBe("");
  });
});

describe("OmpManagedSession over a fake `omp --mode rpc`", () => {
  const fake = (script: string): ChildProcessWithoutNullStreams =>
    spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

  it("handshakes, negotiates v2 and reports the session omp minted", async () => {
    const session = await OmpManagedSession.start({
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child: fake(FAKE_OMP),
    });
    expect(session.sessionId).toBe("01a00ed4-db09-7000-b549-ac372c282cfa");
    expect(session.sessionFile).toBe("/tmp/sessions/-w/x_01a00ed4-db09-7000-b549-ac372c282cfa.jsonl");
    await session.close();
  });

  it("completes a turn at agent_end and carries the assistant text back", async () => {
    const session = await OmpManagedSession.start({
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child: fake(FAKE_OMP),
    });
    const dispatched = await session.dispatch("跑一轮");
    expect(dispatched.kind).toBe("started");
    await expect(dispatched.completion).resolves.toMatchObject({
      ok: true,
      status: "completed",
      resultText: "完成了",
      usage: { tokens_in: 12, tokens_out: 3, tokens_cached: 5 },
    });
    expect(session.turnActive).toBe(false);
    await session.close();
  });

  it("treats a non-terminal agent_end as work still in flight", async () => {
    const session = await OmpManagedSession.start({
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child: fake(FAKE_OMP_NON_TERMINAL),
    });
    const dispatched = await session.dispatch("跑一轮");
    await expect(dispatched.completion).resolves.toMatchObject({ ok: true, resultText: "第二段才是结论" });
    await session.close();
  });

  it("steers a prompt into the running turn instead of opening a second one", async () => {
    const session = await OmpManagedSession.start({
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child: fake(FAKE_OMP_STEER),
    });
    const first = await session.dispatch("先做 A");
    const second = await session.dispatch("顺便做 B");
    expect(second.kind).toBe("steered");
    expect(second.turnId).toBe(first.turnId);
    await expect(first.completion).resolves.toMatchObject({ ok: true, resultText: "A+B 都做完了" });
    await session.close();
  });

  it("completes a local-only prompt that never starts an agent turn", async () => {
    const session = await OmpManagedSession.start({
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child: fake(FAKE_OMP_LOCAL),
    });
    const dispatched = await session.dispatch("/tools");
    await expect(dispatched.completion).resolves.toMatchObject({ ok: true, status: "local" });
    await session.close();
  });

  it("bridges an extension confirm dialog to the interaction broker", async () => {
    const interactions = new AgentInteractionBroker({ managedTtlMs: 5_000 });
    const session = await OmpManagedSession.start({
      cwd: process.cwd(),
      interactions,
      timeoutMs: 5_000,
      child: fake(FAKE_OMP_CONFIRM),
    });
    const dispatched = await session.dispatch("要不要继续");
    const pending = await waitFor(() => interactions.publicInteraction("omp", session.sessionId));
    expect(pending).toMatchObject({ kind: "permission", provider: "omp", title: "继续吗" });
    interactions.respond({
      provider: "omp",
      session_id: session.sessionId,
      interaction_id: pending.id,
      response_json: JSON.stringify({ decision: "allow" }),
    });
    await expect(dispatched.completion).resolves.toMatchObject({ ok: true, resultText: "confirmed=true" });
    await session.close();
  });

  it("reports a dead child as a failed turn rather than hanging", async () => {
    const session = await OmpManagedSession.start({
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child: fake(FAKE_OMP_DIES),
    });
    const dispatched = await session.dispatch("跑一轮");
    await expect(dispatched.completion).resolves.toMatchObject({ ok: false });
    await session.close();
  });

  it("routes an asynchronous stdin EPIPE into the active turn failure", async () => {
    const child = fake(FAKE_OMP_STEER);
    const session = await OmpManagedSession.start({
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child,
    });
    const dispatched = await session.dispatch("跑一轮");
    const handled = child.stdin.emit(
      "error",
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    );

    expect(handled).toBe(true);
    await expect(dispatched.completion).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("EPIPE"),
    });
    await session.close();
  });

  it("fails a prompt issued after omp died immediately with the exit cause", async () => {
    const session = await OmpManagedSession.start({
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      child: fake(FAKE_OMP_DIES),
    });
    const dispatched = await session.dispatch("跑一轮");
    await expect(dispatched.completion).resolves.toMatchObject({ ok: false });
    // The old behaviour parked this request in `pending` for the full command
    // timeout; it must throw the recorded exit error right away instead.
    await expect(session.dispatch("再跑一轮")).rejects.toThrow(/已退出/);
    await session.close();
  });

  it("reports a missing omp binary in plain words", async () => {
    await expect(OmpManagedSession.start({
      cwd: process.cwd(),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 1_000,
      bin: "omp-definitely-missing-binary",
    })).rejects.toThrow(/未找到 omp 命令/);
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

/** Shared preamble: ready frame, v2 negotiation and get_state. */
const OMP_PREAMBLE = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 });
const base = (msg) => {
  if (msg.type === "negotiate_protocol") { send({ id: msg.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } }); return true; }
  if (msg.type === "get_state") {
    send({ id: msg.id, type: "response", command: "get_state", success: true, data: {
      sessionId: "01a00ed4-db09-7000-b549-ac372c282cfa",
      sessionFile: "/tmp/sessions/-w/x_01a00ed4-db09-7000-b549-ac372c282cfa.jsonl",
      isStreaming: false } });
    return true;
  }
  return false;
};
const ok = (msg, data) => send({ id: msg.id, type: "response", command: msg.type, success: true, ...(data ? { data } : {}) });
const assistant = (text, usage) => ({ role: "assistant", content: [{ type: "text", text }], ...(usage ? { usage } : {}) });
`;

const FAKE_OMP = OMP_PREAMBLE + String.raw`
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (base(msg)) return;
  if (msg.type === "prompt") {
    ok(msg);
    send({ type: "agent_start" });
    send({ type: "agent_end", messages: [assistant("完成了", { input: 12, output: 3, cacheRead: 4, cacheWrite: 1 })], isTerminal: true });
  }
});
`;

const FAKE_OMP_NON_TERMINAL = OMP_PREAMBLE + String.raw`
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (base(msg)) return;
  if (msg.type === "prompt") {
    ok(msg);
    send({ type: "agent_end", messages: [assistant("第一段")], isTerminal: false });
    setTimeout(() => send({ type: "agent_end", messages: [assistant("第二段才是结论")], isTerminal: true }), 20);
  }
});
`;

const FAKE_OMP_STEER = OMP_PREAMBLE + String.raw`
let prompts = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (base(msg)) return;
  if (msg.type !== "prompt") return;
  prompts += 1;
  if (prompts === 1) { ok(msg); send({ type: "agent_start" }); return; }
  if (msg.streamingBehavior !== "steer") { send({ id: msg.id, type: "response", command: "prompt", success: false, error: "second prompt was not steered" }); return; }
  ok(msg);
  send({ type: "agent_end", messages: [assistant("A+B 都做完了")], isTerminal: true });
});
`;

const FAKE_OMP_LOCAL = OMP_PREAMBLE + String.raw`
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (base(msg)) return;
  if (msg.type === "prompt") { send({ type: "command_output", text: "tools…" }); ok(msg, { agentInvoked: false }); }
});
`;

const FAKE_OMP_CONFIRM = OMP_PREAMBLE + String.raw`
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (base(msg)) return;
  if (msg.type === "prompt") {
    ok(msg);
    send({ type: "extension_ui_request", id: "ui_1", method: "confirm", title: "继续吗", message: "这一步会写文件" });
    return;
  }
  if (msg.type === "extension_ui_response" && msg.id === "ui_1") {
    send({ type: "agent_end", messages: [assistant("confirmed=" + String(msg.confirmed))], isTerminal: true });
  }
});
`;

const FAKE_OMP_DIES = OMP_PREAMBLE + String.raw`
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (base(msg)) return;
  if (msg.type === "prompt") { ok(msg); process.stderr.write("omp crashed\n"); setTimeout(() => process.exit(3), 10); }
});
`;
