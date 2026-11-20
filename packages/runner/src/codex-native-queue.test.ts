import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { queueCodexPrompt } from "./codex-native-queue.js";

const sessionId = "01996aee-1111-7111-8111-111111111111";
function fixture(mode = "ok") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line); if (m.id === undefined) return;
      const mode=${JSON.stringify(mode)};
      let result={};
      const refusedMethod = mode === 'init-error' ? 'initialize'
        : mode === 'read-error' ? 'thread/read'
        : mode === 'list-error' ? 'thread/queue/list' : '';
      if(m.method===refusedMethod) {
        process.stdout.write(JSON.stringify({id:m.id,error:{code:mode==='list-error'?-32603:-32601,message:'request failed'}})+'\\n'); return;
      }
      if(m.method==='thread/queue/list' && mode==='unsupported-enum') {
        process.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:"unknown variant 'thread/queue/list'"}})+'\\n'); return;
      }
      if(m.method==='thread/queue/list' && mode==='unsupported') {
        process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Method not found'}})+'\\n'); return;
      }
      if(m.method==='thread/read') result={thread:{id:mode==='mismatch'?'another':m.params.threadId,canAcceptDirectInput:mode!=='child'}};
      if(m.method==='thread/queue/add') {
        if(mode==='timeout') return;
        if(mode==='exit') process.exit(0);
        if(mode==='refused') {
          process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:'direct input rejected'}})+'\\n'); return;
        }
        result=mode==='malformed'?{}:{queuedSubmission:{id:'queue-123',clientUserMessageId:mode==='correlation'?'other':m.params.clientUserMessageId}};
      }
      process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
    });
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const writes = vi.spyOn(child.stdin, "write");
  return { child, messages: () => writes.mock.calls.map(([value]) => JSON.parse(String(value)) as {
    method: string; params: Record<string, unknown>;
  }) };
}
const base = { sessionId, codexHome: "/test/account-b", cwd: "/tmp", timeoutMs: 2_000,
  beforeSubmit: async () => {} };

describe("Codex native queue observer", () => {
  it("queues exact multiline input and correlation once without loading a writer", async () => {
    const f = fixture();
    const prompt = "第一行\n`$(keep literal)`\n最后一行";
    await expect(queueCodexPrompt({ ...base, prompt, child: f.child })).resolves.toEqual({ sessionId, queuedSubmissionId: "queue-123" });
    const messages = f.messages();
    expect(messages.map(m => m.method)).toEqual(["initialize", "initialized", "thread/queue/list", "thread/read", "thread/queue/add"]);
    expect(messages.at(-1)?.params).toEqual({ threadId: sessionId, clientUserMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      input: [{ type: "text", text: prompt, text_elements: [] }] });
    expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
  });
  it.each(["child", "mismatch"])("refuses %s before input transfer", async mode => {
    const f = fixture(mode);
    await expect(queueCodexPrompt({ ...base, prompt: "once", child: f.child })).rejects.toMatchObject({ safeFallback: false });
    expect(f.messages().some(m => m.method === "thread/queue/add")).toBe(false);
  });
  it.each(["unsupported", "unsupported-enum"])("marks %s as safe compatibility fallback", async mode => {
    const f = fixture(mode);
    await expect(queueCodexPrompt({ ...base, prompt: "once", child: f.child })).rejects.toMatchObject({ code: "codex_queue_unsupported", safeFallback: true });
    expect(f.messages().some(m => m.method === "thread/queue/add")).toBe(false);
  });
  it.each(["init-error", "read-error", "list-error"])("never grants fallback for %s", async mode => {
    const f = fixture(mode);
    await expect(queueCodexPrompt({ ...base, prompt: "once", child: f.child })).rejects.toMatchObject({ code: "codex_queue_unavailable", safeFallback: false });
    expect(f.messages().some(m => m.method === "thread/queue/add")).toBe(false);
  });
  it.each(["timeout", "exit", "malformed", "correlation"])("treats %s after transfer as unknown, without retry", async mode => {
    const f = fixture(mode);
    await expect(queueCodexPrompt({ ...base, timeoutMs: 500, prompt: "once", child: f.child })).rejects.toMatchObject({ code: "unknown", safeFallback: false });
    expect(f.messages().filter(m => m.method === "thread/queue/add")).toHaveLength(1);
  });
  it("keeps explicit provider refusal non-fallback", async () => {
    const f = fixture("refused");
    await expect(queueCodexPrompt({ ...base, prompt: "once", child: f.child })).rejects.toMatchObject({ code: "codex_queue_unavailable", safeFallback: false });
    expect(f.messages().filter(m => m.method === "thread/queue/add")).toHaveLength(1);
  });
  it("revalidates after setup and never submits when the original process changed", async () => {
    const f = fixture();
    const beforeSubmit = vi.fn(async () => { throw new Error("process changed"); });
    await expect(queueCodexPrompt({ ...base, prompt: "once", beforeSubmit, child: f.child })).rejects.toMatchObject({ safeFallback: false });
    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(f.messages().map(m => m.method)).toContain("thread/read");
    expect(f.messages().map(m => m.method)).not.toContain("thread/queue/add");
  });
  it("serializes one account while allowing a different account to progress", async () => {
    const first = fixture(); const second = fixture(); const other = fixture();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = vi.fn(async () => blocked);
    const one = queueCodexPrompt({ ...base, prompt: "one", beforeSubmit: entered, child: first.child });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    const two = queueCodexPrompt({ ...base, prompt: "two", child: second.child });
    try {
      await queueCodexPrompt({ ...base, codexHome: "/test/account-c", prompt: "other", child: other.child });
      expect(second.messages()).toEqual([]);
    } finally { release(); }
    await Promise.all([one, two]);
  });
  it("requires a full UUID and an absolute account root", async () => {
    await expect(queueCodexPrompt({ ...base, sessionId: "short-name", prompt: "x" })).rejects.toMatchObject({ safeFallback: false });
    await expect(queueCodexPrompt({ ...base, codexHome: "relative", prompt: "x" })).rejects.toMatchObject({ safeFallback: false });
  });
});
