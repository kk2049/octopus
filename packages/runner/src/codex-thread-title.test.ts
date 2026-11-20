import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexManagedSession } from "./codex-app-server.js";
import { CODEX_TITLE_MODEL, codexTitlePrompt, generateCodexThreadTitle, parseCodexTitle, type CodexTitleClient } from "./codex-thread-title.js";

afterEach(() => vi.useRealTimers());

function fixture(options: {
  provider?: string; account?: string; models?: string[]; name?: string;
  response?: string; status?: string; noCompletion?: boolean; configFails?: boolean;
  insecure?: boolean; writeFails?: boolean;
} = {}) {
  let listener: ((method: string, params: unknown) => void) | undefined;
  const stop = vi.fn(() => { listener = undefined; });
  const request = vi.fn(async (method: string, raw: unknown) => {
    const params = raw as Record<string, unknown>;
    if (method === "config/read") {
      if (options.configFails) throw new Error("unsupported");
      return { config: { mcp_servers: { dangerous: { command: "shell" } } } };
    }
    if (method === "account/read") return { account: { type: options.account ?? "chatgpt" } };
    if (method === "model/list") return { data: (options.models ?? [CODEX_TITLE_MODEL]).map(model => ({ model })) };
    if (method === "thread/start") return {
      thread: { id: "hidden", ephemeral: true },
      sandbox: { type: options.insecure ? "dangerFullAccess" : "readOnly" },
    };
    if (method === "turn/start") {
      expect(params.threadId).toBe("hidden");
      if (!options.noCompletion) {
        listener?.("item/completed", { threadId: "hidden", turnId: "title-turn",
          item: { type: "agentMessage", text: options.response ?? '{"title":"  “整理工作分类。”  "}' } });
        listener?.("turn/completed", { threadId: "hidden", turn: { id: "other-turn", status: "failed" } });
        listener?.("turn/completed", { threadId: "hidden", turn: { id: "title-turn", status: options.status ?? "completed" } });
      }
      return { turn: { id: "title-turn" } };
    }
    if (method === "thread/read") return { thread: { id: "main", name: options.name ?? null } };
    if (method === "thread/name/set" && options.writeFails) throw new Error("unknown");
    return {};
  });
  const client: CodexTitleClient = { request, observeIsolatedThread: (_id, callback) => { listener = callback; return stop; } };
  const run = () => generateCodexThreadTitle(client, {
    threadId: "main", model: "current-model", modelProvider: options.provider ?? "openai",
    cwd: "/workspace", config: { mcp_servers: { ticket: { command: "secret bridge" } } },
  }, "替我琢磨一下，这几个工作都是和什么相关的？");
  const params = (method: string) => request.mock.calls.find(call => call[0] === method)?.[1] as Record<string, unknown> | undefined;
  return { run, request, params, stop };
}

describe("Codex native title request", () => {
  it("bounds the native prompt without breaking multibyte input", () => {
    const prompt = codexTitlePrompt("  " + "😀汉".repeat(400) + "  ");
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(960);
    expect(prompt).toContain("at most 36 characters and under five words");
    expect(prompt).toContain("Write in the user's language.");
    expect(prompt).toContain("\n\nUser prompt:\n😀汉");
    expect(prompt).not.toContain("\ufffd");
    expect(codexTitlePrompt("  Fix ABC-42  ")).toMatch(/User prompt:\nFix ABC-42$/);
  });

  it("normalizes titles and rejects malformed or oversized responses", () => {
    expect(parseCodexTitle('{"title":"  “Fix   ABC-42!”  "}')).toBe("Fix ABC-42");
    expect(parseCodexTitle(JSON.stringify({ title: "😀".repeat(40) }))).toBe("😀".repeat(36));
    for (const value of ['title', '{"title":""}', '{"title":"x","extra":1}', '{"title":1}', '[]', " ".repeat(9000)]) {
      expect(parseCodexTitle(value)).toBeUndefined();
    }
  });

  it("isolates tools, uses Luna low and persists on the originating thread", async () => {
    const f = fixture();
    await f.run();
    expect(f.params("thread/start")).toMatchObject({
      model: CODEX_TITLE_MODEL, modelProvider: "openai", ephemeral: true,
      approvalPolicy: "never", sandbox: "read-only", environments: [],
      runtimeWorkspaceRoots: [], dynamicTools: [], selectedCapabilityRoots: [],
      config: { mcp_servers: { dangerous: { enabled: false }, ticket: { enabled: false } },
        "features.hooks": false, "features.shell_tool": false, "features.plugins": false,
        "features.multi_agent": false, "orchestrator.skills.enabled": false, web_search: "disabled" },
    });
    expect(f.params("turn/start")).toMatchObject({
      effort: "low", outputSchema: { additionalProperties: false, required: ["title"] },
    });
    expect(f.params("thread/name/set")).toEqual({ threadId: "main", name: "整理工作分类。" });
    expect(f.params("thread/unsubscribe")).toEqual({ threadId: "hidden" });
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it.each([
    { provider: "custom" }, { account: "apiKey" }, { models: ["current-model"] },
  ])("preserves the resolved model for %j", async options => {
    const f = fixture(options);
    await f.run();
    expect(f.params("thread/start")?.model).toBe("current-model");
    expect(f.params("turn/start")).not.toHaveProperty("effort");
  });

  it("treats an empty native name as unnamed", async () => {
    const f = fixture({ name: "" });
    await f.run();
    expect(f.params("thread/name/set")).toMatchObject({ threadId: "main", name: "整理工作分类。" });
  });

  it("honors a native name saved during generation", async () => {
    const f = fixture({ name: "My chosen name" });
    await f.run();
    expect(f.params("thread/name/set")).toBeUndefined();
    expect(f.params("thread/unsubscribe")).toBeDefined();
  });

  it.each([
    { configFails: true }, { insecure: true }, { response: "not json" },
    { response: JSON.stringify({ title: "x".repeat(9000) }) }, { status: "failed" },
  ])("keeps title tools isolated and names the task from its prompt on failure (%#)", async options => {
    const f = fixture(options);
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.params("thread/name/set")).toEqual({ threadId: "main", name: "替我琢磨一下，这几个工作都是和什么相关的？" });
    if (options.configFails) expect(f.params("thread/start")).toBeUndefined();
    if (options.insecure) expect(f.params("turn/start")).toBeUndefined();
  });

  it("does not replay an uncertain name write", async () => {
    const f = fixture({ writeFails: true });
    await f.run();
    expect(f.request.mock.calls.filter(call => call[0] === "thread/name/set")).toHaveLength(1);
  });

  it("bounds a silent title turn and cleans up without interrupting the main turn", async () => {
    vi.useFakeTimers();
    const f = fixture({ noCompletion: true });
    const running = f.run();
    await vi.runAllTimersAsync();
    await running;
    expect(f.params("thread/name/set")).toEqual({ threadId: "main", name: "替我琢磨一下，这几个工作都是和什么相关的？" });
    expect(f.params("thread/unsubscribe")).toEqual({ threadId: "hidden" });
    expect(f.params("turn/interrupt")).toBeUndefined();
  });
});

describe("managed title lifecycle over JSON-RPC", () => {
  it("starts once, isolates main answers and preserves title work during fast-turn cleanup", async () => {
    const { child, requests } = fakeServer();
    const session = await CodexManagedSession.start({ child, cwd: process.cwd(), timeoutMs: 2_000 });
    try {
      const first = await session.dispatch("first user prompt");
      expect(await first.completion).toMatchObject({ ok: true, resultText: "main answer" });
      const second = await session.dispatch("second prompt");
      expect(await second.completion).toMatchObject({ ok: true, resultText: "main answer" });
      await session.close();
      expect(requests.filter(row => row.method === "thread/name/set")).toHaveLength(1);
      expect(requests.find(row => row.method === "thread/name/set")?.params)
        .toEqual({ threadId: "main", name: "Summarize first task" });
      const title = requests.find(row => row.method === "turn/start" && row.params?.threadId === "hidden");
      expect(JSON.stringify(title?.params)).toContain("first user prompt");
      expect(JSON.stringify(title?.params)).not.toContain("second prompt");
      expect(requests.some(row => row.id === "blocked" && row.error)).toBe(true);
    } finally { await session.close(); }
  });

  it.each(["resume", "fork"] as const)("never auto-renames on %s", async kind => {
    const { child, requests } = fakeServer();
    const options = { child, cwd: process.cwd(), timeoutMs: 2_000 };
    const session = kind === "resume"
      ? await CodexManagedSession.resume("main", options)
      : await CodexManagedSession.forkFromPath("main", "/fake/rollout", options);
    try {
      const turn = await session.dispatch("continue");
      await turn.completion;
    } finally { await session.close(); }
    expect(requests.filter(row => row.method === "config/read")).toHaveLength(0);
  });
});

function fakeServer() {
  const requests: Array<{ id?: string; method?: string; params?: Record<string, unknown>; error?: unknown }> = [];
  const child = spawn(process.execPath, ["-e", String.raw`
    const rl = require("readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\n");
    let n = 0;
    rl.on("line", line => {
      const row = JSON.parse(line);
      process.stderr.write(line + "\n");
      if (!row.method || row.id === undefined) return;
      let result = {};
      if (["thread/start", "thread/resume", "thread/fork"].includes(row.method)) {
        result = { thread: { id: row.params.ephemeral ? "hidden" : "main", ephemeral: !!row.params.ephemeral },
          model: "main-model", modelProvider: "openai", sandbox: { type: "readOnly" } };
      } else if (row.method === "thread/read") {
        result = { thread: { id: "main", name: null, status: { type: "idle" } } };
      } else if (row.method === "config/read") result = { config: {} };
      else if (row.method === "account/read") result = { account: { type: "chatgpt" } };
      else if (row.method === "model/list") result = { data: [{ model: "gpt-5.6-luna" }] };
      else if (row.method === "turn/start") {
        const threadId = row.params.threadId, turnId = "turn-" + ++n;
        send({ id: row.id, result: { turn: { id: turnId } } });
        if (threadId === "hidden") send({ id: "blocked", method: "item/commandExecution/requestApproval",
          params: { threadId, command: "should never run" } });
        setTimeout(() => {
          send({ method: "item/completed", params: { threadId, turnId,
            item: { type: "agentMessage", text: threadId === "hidden" ? '{"title":"Summarize first task"}' : "main answer" } } });
          send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
        }, threadId === "hidden" ? 40 : 1);
        return;
      }
      send({ id: row.id, result });
    });
  `], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  let buffer = "";
  child.stderr.on("data", data => {
    buffer += String(data);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      requests.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  return { child, requests };
}
