import http from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentControlPlane } from "./agent-control-plane.js";
import type { CodexExecRelayCoordinator } from "./codex-exec-relay.js";
import type {
  ClaudeAssistantTranslation,
  ClaudeTranslationPort,
} from "./claude-translation.js";
import { machineStartSession, sessionIdFromCodexEvent } from "./launch.js";
import { LaunchJournal } from "./launch-journal.js";
import { MACHINE_LIMITS } from "./limits.js";
import { addWorkspace } from "./workspaces.js";
import { fakeExecutables, type FakeExecutables } from "../../../tools/test-support/fake-executables.mjs";

const dirs: string[] = [];
const servers: http.Server[] = [];
const fakes: FakeExecutables[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0).reverse()) fake.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** Only the fake CLIs (never a real one) are reachable while a test runs. */
function hermeticBin(home: string, files: Record<string, string> = {}): string {
  const fake = fakeExecutables(files, { home });
  fakes.push(fake);
  fake.apply();
  return fake.bin;
}

async function fixture(binName: "claude" | "codex" | "omp", body: string) {
  const home = mkdtempSync(join(tmpdir(), "runner-launch-"));
  dirs.push(home);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const bin = hermeticBin(home, { [binName]: `#!/bin/sh\n${body}\n` });
  const workspace = await addWorkspace(home, cwd, "Demo");
  return { home, cwd, bin, workspace };
}

function args(source: "claude" | "codex" | "omp", workspaceId: string, id = "op_12345678") {
  return {
    source,
    workspace_id: workspaceId,
    prompt: "实现这个需求",
    client_request_id: id,
  };
}

async function executionMcp(): Promise<{ url: string; methods: string[] }> {
  const methods: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      methods.push(request.method ?? "");
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      const parsed = body ? JSON.parse(body) as { id?: unknown; method?: unknown } : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(parsed.method === "initialize"
        ? JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "octopus", version: "1.0.0" },
            },
          })
        : JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { tools: [{ name: "run_workspace_command" }] },
          }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return { url: `http://127.0.0.1:${address.port}/api/mcp`, methods };
}

describe.sequential("start_session launch adapters", () => {
  it("preassigns a Claude id and journal-dedupes a replay to exactly one spawn", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-launch-"));
    dirs.push(home);
    const count = join(home, "spawn-count");
    const cwd = join(home, "project");
    mkdirSync(cwd);
    hermeticBin(home, { claude: `#!/bin/sh\necho x >> '${count}'\nsleep 0.25\n` });
    const workspace = await addWorkspace(home, cwd, "Demo");

    const first = await machineStartSession(home, args("claude", workspace.id), {
      supervisionMs: 20,
      newClaudeSessionId: () => "11111111-2222-4333-8444-555555555555",
    });
    expect(first).toMatchObject({ ok: true, agent: "claude", session_id: "11111111-2222-4333-8444-555555555555" });
    const second = await machineStartSession(home, args("claude", workspace.id), { supervisionMs: 20 });
    expect(second).toMatchObject({ ok: true, session_id: "11111111-2222-4333-8444-555555555555", replayed: true });
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
    if (first.ok && first.pid !== undefined) {
      const pid = first.pid;
      expect(() => process.kill(pid, 0)).not.toThrow();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("reports an early non-zero Claude exit as failed", async () => {
    const f = await fixture("claude", "echo 'distinct launch failure' >&2\nexit 7");
    const result = await machineStartSession(f.home, args("claude", f.workspace.id), {
      supervisionMs: 200,
      newClaudeSessionId: () => "11111111-2222-4333-8444-555555555556",
    });
    expect(result).toMatchObject({ ok: false, code: "failed" });
    if (!result.ok) expect(result.error).toContain("distinct launch failure");
  });

  it("feeds translated English to the legacy Claude launcher and records the turn", async () => {
    const f = await fixture("claude", 'printf "%s\\n" "$@" > "$PWD/translated-args"');
    const translateUser = vi.fn(async (text: string) => ({
      turnId: "translation-launch",
      zh: text,
      en: "Check the build.",
    }));
    const recordUser = vi.fn(async () => {});
    const claudeTranslations = {
      isBilingualSession: async () => false,
      translateUser,
      recordUser,
      translateAssistant: async (
        _sessionId: string,
        _turnId: string,
        text: string,
      ): Promise<ClaudeAssistantTranslation> => ({
        ok: true,
        bilingual: { zh: "构建已检查。", en: text },
      }),
      decorateTranscript: async (raw: unknown) => raw,
      observeClaudeHook: async () => {},
    } satisfies ClaudeTranslationPort;

    const result = await machineStartSession(f.home, {
      ...args("claude", f.workspace.id, "op_claude_translated"),
      translate_prompt: true,
      prompt: "检查构建。",
    }, {
      supervisionMs: 100,
      newClaudeSessionId: () => "11111111-2222-4333-8444-555555555558",
      claudeTranslations,
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(f.cwd, "translated-args"), "utf8"))
      .toContain("-p\nCheck the build.\n");
    expect(recordUser).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-555555555558",
      expect.objectContaining({ en: "Check the build.", zh: "检查构建。" }),
    );
  });

  it("starts plain Claude without consulting the translator", async () => {
    const f = await fixture("claude", 'printf "%s\\n" "$@" > "$PWD/plain-args"');
    const translateUser = vi.fn(async () => {
      throw new Error("the plain lane must never reach the translator");
    });
    const claudeTranslations = {
      isBilingualSession: async () => false,
      translateUser,
      recordUser: vi.fn(async () => {}),
      translateAssistant: async (
        _sessionId: string,
        _turnId: string,
        text: string,
      ): Promise<ClaudeAssistantTranslation> => ({
        ok: true,
        bilingual: { zh: "不应调用", en: text },
      }),
      decorateTranscript: async (raw: unknown) => raw,
      observeClaudeHook: async () => {},
    } satisfies ClaudeTranslationPort;

    const result = await machineStartSession(f.home, {
      ...args("claude", f.workspace.id, "op_claude_plain"),
      prompt: "检查构建。",
    }, {
      supervisionMs: 100,
      newClaudeSessionId: () => "11111111-2222-4333-8444-555555555561",
      claudeTranslations,
    });

    expect(result.ok).toBe(true);
    expect(translateUser).not.toHaveBeenCalled();
    expect(readFileSync(join(f.cwd, "plain-args"), "utf8")).toContain("-p\n检查构建。\n");
  });

  it("journals input translation failure and replays it without launching Claude", async () => {
    const f = await fixture("claude", "touch should-not-run");
    const translateUser = vi.fn(async () => {
      throw new Error("translation transport unavailable");
    });
    const recordUser = vi.fn(async () => {});
    const claudeTranslations = {
      isBilingualSession: async () => false,
      translateUser,
      recordUser,
      translateAssistant: async (
        _sessionId: string,
        _turnId: string,
        text: string,
      ): Promise<ClaudeAssistantTranslation> => ({
        ok: true,
        bilingual: { zh: "不应调用", en: text },
      }),
      decorateTranscript: async (raw: unknown) => raw,
      observeClaudeHook: async () => {},
    } satisfies ClaudeTranslationPort;
    const request = {
      ...args("claude", f.workspace.id, "op_translation_failed"),
      translate_prompt: true,
      prompt: "检查构建。",
    };

    const first = await machineStartSession(f.home, request, { claudeTranslations });
    const replay = await machineStartSession(f.home, request, { claudeTranslations });

    expect(first).toMatchObject({ ok: false, code: "failed" });
    if (!first.ok) expect(first.error).toContain("translation transport unavailable");
    expect(replay).toMatchObject({ ok: false, code: "failed", replayed: true });
    expect(translateUser).toHaveBeenCalledOnce();
    expect(recordUser).not.toHaveBeenCalled();
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
    expect((await new LaunchJournal(f.home).read("op_translation_failed"))?.exit?.error)
      .toContain("Claude 输入翻译失败");
  });

  it("journals an unowned managed preparation failure before replay", async () => {
    const f = await fixture("claude", "touch should-not-run");
    const startManaged = vi.fn(async () => {
      throw new Error("translation preparation failed");
    });
    const request = args("claude", f.workspace.id, "op_managed_prepare_failed");

    const first = await machineStartSession(f.home, request, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
    });
    const replay = await machineStartSession(f.home, request, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
    });

    expect(first).toMatchObject({ ok: false, code: "failed" });
    if (!first.ok) expect(first.error).toContain("translation preparation failed");
    expect(replay).toMatchObject({ ok: false, code: "failed", replayed: true });
    expect(startManaged).toHaveBeenCalledOnce();
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it("reads a Codex thread id only from that child process JSONL", async () => {
    const f = await fixture(
      "codex",
      "echo '{\"type\":\"thread.started\",\"thread_id\":\"019f0000-1111-7000-8000-000000000123\"}'\nsleep 0.2",
    );
    const result = await machineStartSession(f.home, args("codex", f.workspace.id), {
      supervisionMs: 300,
      probe: async () => ({ supported: true, version: "0.146.0" }),
    });
    expect(result).toMatchObject({
      ok: true,
      agent: "codex",
      session_id: "019f0000-1111-7000-8000-000000000123",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  it("passes the selected model and effort as structured CLI arguments", async () => {
    const claude = await fixture("claude", 'printf "%s\\n" "$@" > "$PWD/claude-args"');
    const claudeResult = await machineStartSession(claude.home, {
      ...args("claude", claude.workspace.id, "op_claude_tuning"),
      model: "opus",
      effort: "max",
    }, {
      supervisionMs: 1_000,
      newClaudeSessionId: () => "11111111-2222-4333-8444-555555555557",
    });
    expect(claudeResult.ok).toBe(true);
    expect(readFileSync(join(claude.cwd, "claude-args"), "utf8")).toContain("--model\nopus\n--effort\nmax\n");

    const codex = await fixture(
      "codex",
      'printf "%s\\n" "$@" > "$PWD/codex-args"\necho \'{"type":"thread.started","thread_id":"thread_tuned_123456"}\'\nsleep 0.2',
    );
    const codexResult = await machineStartSession(codex.home, {
      ...args("codex", codex.workspace.id, "op_codex_tuning"),
      model: "gpt-5.6-sol",
      effort: "max",
      permission_profile: "manual",
    }, { supervisionMs: 1_000, probe: async () => ({ supported: true, version: "0.146.0" }) });
    expect(codexResult.ok).toBe(true);
    expect(readFileSync(join(codex.cwd, "codex-args"), "utf8")).toContain(
      '--model\ngpt-5.6-sol\n--config\nmodel_reasoning_effort="max"\n',
    );
    expect(readFileSync(join(codex.cwd, "codex-args"), "utf8")).toContain(
      '--strict-config\n--config\napproval_policy="untrusted"\n--config\nsandbox_mode="read-only"\n',
    );

    const full = await fixture(
      "codex",
      'printf "%s\\n" "$@" > "$PWD/codex-full-args"\necho \'{"type":"thread.started","thread_id":"thread_full_123456"}\'\nsleep 0.2',
    );
    // An omitted profile is the shared full-access default; only explicit manual narrows it.
    const fullResult = await machineStartSession(full.home, {
      ...args("codex", full.workspace.id, "op_codex_full"),
    }, { supervisionMs: 1_000, probe: async () => ({ supported: true, version: "0.147.0" }) });
    expect(fullResult.ok).toBe(true);
    expect(readFileSync(join(full.cwd, "codex-full-args"), "utf8"))
      .toContain("--dangerously-bypass-approvals-and-sandbox\n");
  });

  it("rejects an effort unsupported by the selected CLI before creating launch evidence", async () => {
    const f = await fixture("codex", "touch should-not-run");
    await expect(machineStartSession(f.home, {
      ...args("codex", f.workspace.id, "op_invalid_effort"), effort: "ultra",
    })).rejects.toThrow(/codex effort/);
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it("rejects an unknown Codex profile at the device boundary", async () => {
    const f = await fixture("codex", "touch should-not-run");
    await expect(machineStartSession(f.home, {
      ...args("codex", f.workspace.id, "op_invalid_profile"),
      permission_profile: "root",
    })).rejects.toThrow(/权限档位无效/);
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
    expect(await new LaunchJournal(f.home).read("op_invalid_profile")).toBeNull();
  });

  it("passes Claude manual mode to the SDK control plane", async () => {
    const f = await fixture("claude", "touch should-not-run");
    const startManaged = vi.fn(async () => ({
      sessionId: "claude_manual_123456",
      transport: "agent-sdk" as const,
      completion: Promise.resolve({ ok: true }),
    }));
    const result = await machineStartSession(f.home, {
      ...args("claude", f.workspace.id, "op_claude_profile"),
      permission_profile: "manual",
    }, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
      newClaudeSessionId: () => "11111111-2222-4333-8444-555555555558",
    });
    expect(result).toMatchObject({ ok: true, transport: "agent-sdk" });
    expect(startManaged).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      permissionProfile: "manual",
    }));
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it.each([undefined, "@default"])("retains an unlabelled custom home for local managed Codex starts (%s)", async (account) => {
    const f = await fixture("codex", "touch should-not-run");
    const codexHome = join(f.home, "custom-native-state");
    const startManaged = vi.fn(async () => ({ sessionId: "codex_custom_home_123456", transport: "app-server" as const,
      completion: Promise.resolve({ ok: true }) }));
    await expect(machineStartSession(f.home, {
      ...args("codex", f.workspace.id, "op_custom_home"),
      ...(account ? { codex_account: account } : {}),
    }, { codexHome, controlPlane: { startManaged } as unknown as AgentControlPlane }))
      .resolves.toMatchObject({ ok: true, transport: "app-server" });
    expect(startManaged).toHaveBeenCalledWith(expect.objectContaining({ codexHome }));
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it("passes a first prompt beyond the old 8KB ceiling and keeps the transport ceiling", async () => {
    const f = await fixture("codex", "touch should-not-run");
    const prompt = "x".repeat(8_001);
    const startManaged = vi.fn(async (_input: { prompt: string }) => ({
      sessionId: "codex_large_prompt_123456",
      transport: "app-server" as const,
      completion: Promise.resolve({ ok: true }),
    }));
    const result = await machineStartSession(f.home, {
      ...args("codex", f.workspace.id, "op_large_prompt"),
      prompt,
    }, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
    });
    expect(result).toMatchObject({ ok: true, transport: "app-server" });
    expect((startManaged.mock.calls[0]![0] as { prompt: string }).prompt).toBe(prompt);
    await expect(machineStartSession(f.home, {
      ...args("codex", f.workspace.id, "op_over_prompt"),
      prompt: "x".repeat(MACHINE_LIMITS.startMaxPromptBytes + 1),
    })).rejects.toThrow(`prompt 过长 (最多 ${MACHINE_LIMITS.startMaxPromptBytes} 字节)`);
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it("fails closed instead of launching the bypass CLI for Claude manual mode", async () => {
    const f = await fixture("claude", "touch should-not-run");
    const result = await machineStartSession(f.home, {
      ...args("claude", f.workspace.id, "op_claude_manual_fallback"),
      permission_profile: "manual",
    });
    expect(result).toMatchObject({ ok: false, code: "failed" });
    if (!result.ok) expect(result.error).toContain("Agent SDK");
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it("returns unknown without killing a live Codex process that has not reported an id", async () => {
    const f = await fixture("codex", "sleep 0.25");
    const result = await machineStartSession(f.home, args("codex", f.workspace.id), {
      supervisionMs: 20,
      probe: async () => ({ supported: true, version: "0.146.0" }),
    });
    expect(result).toMatchObject({ ok: false, code: "unknown", version: "0.146.0" });
    if (!result.ok && result.pid) expect(() => process.kill(result.pid!, 0)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("records the original Codex identity and completion after the foreground launch became unknown", async () => {
    const f = await fixture("codex", "printf x >> launch-count; sleep 0.12; printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"late-original-thread\"}'; sleep 0.15");
    const input = vi.fn(async () => {});
    const complete = vi.fn(async () => {});
    const result = await machineStartSession(f.home, args("codex", f.workspace.id), {
      supervisionMs: 10, probe: async () => ({ supported: true, version: "0.146.0" }), onInput: input, onCompletion: complete,
    });
    expect(result).toMatchObject({ ok: false, code: "unknown" });
    await vi.waitFor(() => expect(input).toHaveBeenCalledWith(expect.objectContaining({ session_id: "late-original-thread", evidence: "launch_identity" })));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(await new LaunchJournal(f.home).reconcile("op_12345678")).toMatchObject({ started: { session_id: "late-original-thread" }, exit: { code: 0 } });
    expect(await machineStartSession(f.home, args("codex", f.workspace.id))).toMatchObject({ ok: true, session_id: "late-original-thread", replayed: true });
    expect(readFileSync(join(f.cwd, "launch-count"), "utf8")).toBe("x");
  });

  it("does not create a journal or spawn when the installed Codex contract is unsupported", async () => {
    const f = await fixture("codex", "touch should-not-run");
    const result = await machineStartSession(f.home, args("codex", f.workspace.id), {
      probe: async () => ({ supported: false, version: "0.19.0", reason: "version_too_old" }),
    });
    expect(result).toMatchObject({ ok: false, code: "unsupported_cli_version", version: "0.19.0" });
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it("uses native app-server launch without requiring the legacy exec-json probe", async () => {
    const f = await fixture("codex", "touch should-not-run");
    const probe = vi.fn(async () => ({
      supported: false as const,
      version: "0.19.0",
      reason: "version_too_old" as const,
    }));
    const startManaged = vi.fn(async () => ({
      sessionId: "thread_native_123456",
      transport: "app-server" as const,
      turnId: "turn_native_123456",
      completion: Promise.resolve({ ok: true }),
    }));

    const result = await machineStartSession(f.home, args("codex", f.workspace.id, "op_native001"), {
      probe,
      controlPlane: { startManaged } as unknown as AgentControlPlane,
    });

    expect(result).toMatchObject({
      ok: true,
      session_id: "thread_native_123456",
      transport: "app-server",
    });
    expect(startManaged).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it("lets Sessions+ select a tmux-owned CLI without touching the managed control plane", async () => {
    const f = await fixture("claude", "touch should-not-run");
    const startManaged = vi.fn();
    const independentCliLaunch = vi.fn(async () => ({
      kind: "started" as const,
      sessionId: "11111111-2222-4333-8444-555555555560",
      pid: 4242,
    }));
    const recordUser = vi.fn(async () => {});
    const claudeTranslations = {
      isBilingualSession: async () => false,
      translateUser: vi.fn(async (text: string) => ({
        turnId: "translation-independent",
        zh: text,
        en: "Implement this requirement.",
      })),
      recordUser,
      translateAssistant: async (
        _sessionId: string,
        _turnId: string,
        text: string,
      ): Promise<ClaudeAssistantTranslation> => ({
        ok: true,
        bilingual: { zh: "不应调用", en: text },
      }),
      decorateTranscript: async (raw: unknown) => raw,
      observeClaudeHook: async () => {},
    } satisfies ClaudeTranslationPort;
    const result = await machineStartSession(f.home, {
      ...args("claude", f.workspace.id, "op_independent_claude"),
      translate_prompt: true,
      _octopus_launch_mode: "independent_cli",
      permission_profile: "full_access",
    }, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
      independentCliLaunch,
      newClaudeSessionId: () => "11111111-2222-4333-8444-555555555560",
      claudeTranslations,
    });

    expect(result).toMatchObject({
      ok: true,
      session_id: "11111111-2222-4333-8444-555555555560",
      transport: "tmux-cli",
      pid: 4242,
    });
    expect(startManaged).not.toHaveBeenCalled();
    expect(independentCliLaunch).toHaveBeenCalledWith(expect.objectContaining({
      source: "claude",
      cwd: f.cwd,
      prompt: "Implement this requirement.",
      permissionProfile: "full_access",
    }));
    expect(recordUser).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-555555555560",
      expect.objectContaining({ zh: "实现这个需求", en: "Implement this requirement." }),
    );
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
    expect((await new LaunchJournal(f.home).read("op_independent_claude"))?.requested.launch_mode)
      .toBe("independent_cli");
  });

  it("uses detached provider CLI fallback when tmux is unavailable, never app-server", async () => {
    const f = await fixture("codex", [
      "echo '{\"type\":\"thread.started\",\"thread_id\":\"019f0000-1111-7000-8000-000000000124\"}'",
      "sleep 0.2",
    ].join("\n"));
    const startManaged = vi.fn();
    const result = await machineStartSession(f.home, {
      ...args("codex", f.workspace.id, "op_independent_no_tmux"),
      _octopus_launch_mode: "independent_cli",
      permission_profile: "full_access",
    }, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
      independentCliLaunch: async () => ({ kind: "unavailable" }),
      probe: async () => ({ supported: true, version: "0.147.0" }),
      supervisionMs: 1_000,
    });
    expect(result).toMatchObject({
      ok: true,
      session_id: "019f0000-1111-7000-8000-000000000124",
      transport: "exec",
    });
    expect(startManaged).not.toHaveBeenCalled();
  });

  it("routes a Sessions+ Codex launch before starting the independent CLI", async () => {
    const f = await fixture("codex", "touch should-not-run");
    const independentCliLaunch = vi.fn(async () => ({
      kind: "started" as const,
      sessionId: "019f0000-1111-7000-8000-000000000125",
      pid: 4343,
    }));
    const selectCodexAccount = vi.fn(async () => ({
      slot: "private-b",
      label: "b",
      codexHome: "/srv/codex/account-b",
      remainingPercent: 42,
      resetsAt: Date.now() + 60_000,
      windowDurationMins: 10_080,
    }));
    const result = await machineStartSession(f.home, {
      ...args("codex", f.workspace.id, "op_independent_routed"),
      _octopus_launch_mode: "independent_cli",
      permission_profile: "full_access",
    }, {
      independentCliLaunch,
      selectCodexAccount,
      probe: async () => ({ supported: true, version: "0.147.0" }),
    });

    expect(result).toMatchObject({
      ok: true,
      session_id: "019f0000-1111-7000-8000-000000000125",
      account_label: "b",
    });
    expect(selectCodexAccount).toHaveBeenCalledOnce();
    expect(independentCliLaunch).toHaveBeenCalledWith(expect.objectContaining({
      source: "codex",
      codexHome: "/srv/codex/account-b",
    }));
  });

  it("starts omp as a resumable headless CLI when independent mode has no tmux", async () => {
    const f = await fixture("omp", [
      "echo '{\"type\":\"session\",\"version\":3,\"id\":\"01a00ed4-db09-7000-b549-ac372c282cfa\"}'",
      "sleep 0.2",
    ].join("\n"));
    const result = await machineStartSession(f.home, {
      ...args("omp", f.workspace.id, "op_independent_omp"),
      _octopus_launch_mode: "independent_cli",
      permission_profile: "full_access",
    }, {
      independentCliLaunch: async () => ({ kind: "unavailable" }),
      supervisionMs: 1_000,
    });
    expect(result).toMatchObject({
      ok: true,
      agent: "omp",
      session_id: "01a00ed4-db09-7000-b549-ac372c282cfa",
      transport: "exec",
    });
  });

  it("starts a split Claude turn in an inert control directory with only a loopback MCP URL", async () => {
    const f = await fixture("claude", "touch should-not-run");
    const mcp = await executionMcp();
    const startManaged = vi.fn(async (input: { cwd: string; remoteMcpUrl?: string }) => {
      expect(input.cwd).not.toBe(f.cwd);
      expect(input.cwd).toContain(join(".octopus-runner", "remote-sessions"));
      expect(input.remoteMcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/session\/[a-f0-9]+\/mcp$/);
      expect(JSON.stringify(input)).not.toContain("mcp_split_secret");
      return {
        sessionId: "claude_split_123456",
        transport: "agent-sdk" as const,
        turnId: "turn_split_123456",
        completion: Promise.resolve({ ok: true }),
      };
    });
    const result = await machineStartSession(f.home, {
      ...args("claude", f.workspace.id, "op_split_claude"),
      _octopus_execution_mcp_url: mcp.url,
      execution_device: "val15",
      _octopus_execution_mcp_token: "mcp_split_secret",
    }, {
      developmentId: "development_ticket_578",
      developmentMcpUrl: "http://127.0.0.1:39003/devpipe",
      controlPlane: { startManaged } as unknown as AgentControlPlane,
      newClaudeSessionId: () => "11111111-2222-4333-8444-555555555559",
    });
    expect(result).toMatchObject({ ok: true, session_id: "claude_split_123456" });
    expect(startManaged).toHaveBeenCalledOnce();
    expect(startManaged).toHaveBeenCalledWith(expect.objectContaining({
      recoveryPlacement: expect.objectContaining({ developmentId: "development_ticket_578" }),
    }));
    expect((await new LaunchJournal(f.home).read("op_split_claude"))?.requested.remote_execution).toBe(true);
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it("journals a split setup refusal so replay cannot poison the operation id", async () => {
    const f = await fixture("claude", "touch should-not-run");
    const startManaged = vi.fn();
    const request = {
      ...args("claude", f.workspace.id, "op_split_bad_endpoint"),
      _octopus_execution_mcp_url: "http://example.com/api/mcp",
      _octopus_execution_mcp_token: "mcp_split_secret",
      execution_device: "val15",
    };
    const first = await machineStartSession(f.home, request, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
    });
    const replay = await machineStartSession(f.home, request, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
    });
    expect(first).toMatchObject({ ok: false, code: "failed" });
    expect(replay).toMatchObject({ ok: false, code: "failed", replayed: true });
    expect(startManaged).not.toHaveBeenCalled();
    expect((await new LaunchJournal(f.home).read("op_split_bad_endpoint"))?.exit?.error).toContain("HTTPS");
  });

  it("journals a split managed-start rejection for trusted lifecycle cleanup", async () => {
    const f = await fixture("claude", "touch should-not-run");
    const mcp = await executionMcp();
    const startManaged = vi.fn(async () => {
      throw new Error("SDK unavailable");
    });
    const request = {
      ...args("claude", f.workspace.id, "op_split_start_reject"),
      _octopus_execution_mcp_url: mcp.url,
      _octopus_execution_mcp_token: "mcp_split_secret",
      execution_device: "val15",
    };
    const first = await machineStartSession(f.home, request, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
    });
    const replay = await machineStartSession(f.home, request, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
    });
    expect(first).toMatchObject({ ok: false, code: "failed" });
    expect(replay).toMatchObject({ ok: false, code: "failed", replayed: true });
    expect(startManaged).toHaveBeenCalledOnce();
    expect(mcp.methods).not.toContain("DELETE");
  });

  it("starts split Codex through a launch-scoped native exec-server environment", async () => {
    const f = await fixture("codex", "touch should-not-run");
    const mcp = await executionMcp();
    const closeEnvironment = vi.fn(async () => {});
    const openEnvironment = vi.fn(async () => ({
      environmentId: "octopus-op-split-codex",
      endpoint: "ws://127.0.0.1:32123",
      close: closeEnvironment,
    }));
    const startManaged = vi.fn(async (input: {
      cwd: string;
      remoteMcpUrl?: string;
      codexEnvironment?: { environmentId: string; endpoint: string };
    }) => {
      expect(input.cwd).not.toBe(f.cwd);
      expect(input.remoteMcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      expect(input.codexEnvironment).toEqual({
        environmentId: "octopus-op-split-codex",
        endpoint: "ws://127.0.0.1:32123",
      });
      expect(JSON.stringify(input)).not.toContain("mcp_split_secret");
      return {
        sessionId: "codex_split_123456",
        transport: "app-server" as const,
        turnId: "turn_split_codex",
        completion: Promise.resolve({ ok: true }),
      };
    });
    const result = await machineStartSession(f.home, {
      ...args("codex", f.workspace.id, "op_split_codex"),
      execution_device: "val15",
      _octopus_session_catalog_id: `spc_${"c".repeat(64)}`,
      _octopus_execution_mcp_url: mcp.url,
      _octopus_execution_mcp_token: "mcp_split_secret",
    }, {
      controlPlane: { startManaged } as unknown as AgentControlPlane,
      codexExecRelay: { open: openEnvironment } as unknown as CodexExecRelayCoordinator,
    });
    expect(result).toMatchObject({
      ok: true,
      session_id: "codex_split_123456",
      transport: "app-server",
    });
    expect(openEnvironment).toHaveBeenCalledWith({
      executionDevice: "val15",
      workspaceId: f.workspace.id,
      executionToken: "mcp_split_secret",
      operationId: "op_split_codex",
    });
    await expect(new LaunchJournal(f.home).sessionPlacement("codex_split_123456")).resolves.toEqual({
      version: 2,
      session_id: "codex_split_123456",
      source: "codex",
      execution_device: "val15",
      workspace_id: f.workspace.id,
      catalog_id: `spc_${"c".repeat(64)}`,
    });
    await vi.waitFor(() => expect(closeEnvironment).toHaveBeenCalledOnce());
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });

  it("restores requested-without-started as unknown and never spawns it", async () => {
    const f = await fixture("claude", "touch should-not-run");
    const requestId = "op_abcdefgh";
    await new LaunchJournal(f.home).begin({
      client_request_id: requestId,
      workspace_id: f.workspace.id,
      source: "claude",
      prompt_hash: createHash("sha256").update("hello").digest("hex"),
    });
    // Bind the fixture to the exact prompt hash by using the prompt that
    // produced the recorded value.
    const result = await machineStartSession(f.home, {
      ...args("claude", f.workspace.id, requestId),
      prompt: "hello",
    });
    expect(result).toMatchObject({ ok: false, code: "unknown", replayed: true });
    expect(existsSync(join(f.cwd, "should-not-run"))).toBe(false);
  });
});

describe("sessionIdFromCodexEvent", () => {
  it("accepts known start events and ignores unrelated JSON ids", () => {
    expect(sessionIdFromCodexEvent('{"type":"thread.started","thread_id":"thread_123456"}')).toBe("thread_123456");
    expect(sessionIdFromCodexEvent('{"type":"item.completed","id":"secret_123456"}')).toBeNull();
  });
});

/**
 * Starting in a directory the device was simply told about.
 *
 * The property under test is not "a path works" but the three that make it safe
 * to accept one: the cwd is the directory that was asked for, the idempotency
 * record is bound to it (so a retry replays THIS launch and a different
 * directory is a loud refusal rather than a second agent), and the older
 * `workspace_id` form still works unchanged — an old Agent View may still be the
 * active release, and a rollback puts one back.
 */
describe.sequential("start_session in an arbitrary directory", () => {
  it("runs in a directory nothing registered, and records it", async () => {
    const { home, bin } = await fixture("claude", "printf %s \"$PWD\" > \"$OUT\"\n");
    const target = join(home, "unregistered", "deep");
    mkdirSync(target, { recursive: true });
    const out = join(home, "cwd.txt");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf %s "$PWD" > '${out}'\n`);
    chmodSync(join(bin, "claude"), 0o755);

    const result = await machineStartSession(home, {
      source: "claude",
      directory: target,
      prompt: "实现这个需求",
      client_request_id: "op_directory1",
    }, { supervisionMs: 400 });
    expect(result.ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(target);

    const record = await new LaunchJournal(home).read("op_directory1");
    expect(record?.requested.directory).toBe(target);
    expect(record?.requested.workspace_id).toBe("");
  });

  it("resolves `~` against this Runner's scan home", async () => {
    const { home, bin } = await fixture("claude", "true\n");
    mkdirSync(join(home, "tilde"));
    const out = join(home, "cwd2.txt");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf %s "$PWD" > '${out}'\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const result = await machineStartSession(home, {
      source: "claude",
      directory: "~/tilde",
      prompt: "go",
      client_request_id: "op_tilde001",
    }, { supervisionMs: 400 });
    expect(result.ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(join(home, "tilde"));
  });

  it("replays one launch rather than starting a second agent", async () => {
    const { home, bin } = await fixture("claude", "true\n");
    const target = join(home, "retry");
    mkdirSync(target);
    const count = join(home, "spawns");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho x >> '${count}'\nsleep 0.2\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const call = { source: "claude" as const, directory: target, prompt: "go", client_request_id: "op_retry0001" };
    const first = await machineStartSession(home, call, { supervisionMs: 300 });
    const second = await machineStartSession(home, call, { supervisionMs: 300 });
    expect(first.ok && second.ok).toBe(true);
    expect(second).toMatchObject({ replayed: true });
    if (first.ok && second.ok) expect(second.session_id).toBe(first.session_id);
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("admits secondary-site IDs through the real journal and deduplicates within each site", async () => {
    const { home, bin, workspace } = await fixture("claude", "true\n");
    const count = join(home, "site-spawns");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho x >> '${count}'\nsleep 0.2\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const call = args("claude", workspace.id, "op_same_site_request");
    const primary = await machineStartSession(home, call, { supervisionMs: 300 });
    const secondary = await machineStartSession(home, call, { supervisionMs: 300, gatewaySite: "octo" });
    const replay = await machineStartSession(home, call, { supervisionMs: 300, gatewaySite: "octo" });
    expect(primary.ok && secondary.ok && replay.ok).toBe(true);
    expect(replay).toMatchObject({ replayed: true });
    if (primary.ok && secondary.ok && replay.ok) {
      expect(secondary.session_id).not.toBe(primary.session_id);
      expect(replay.session_id).toBe(secondary.session_id);
    }
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("replays durable launch evidence even if the requested directory no longer exists", async () => {
    const { home } = await fixture("claude", "true\n");
    const target = join(home, "gone-after-launch");
    mkdirSync(target);
    const call = {
      source: "claude" as const,
      directory: target,
      prompt: "go",
      client_request_id: "op_gonedir001",
    };
    const first = await machineStartSession(home, call, { supervisionMs: 300 });
    expect(first.ok).toBe(true);
    rmSync(target, { recursive: true, force: true });

    const replay = await machineStartSession(home, call, { supervisionMs: 300 });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    if (first.ok && replay.ok) expect(replay.session_id).toBe(first.session_id);
  });

  it("refuses to rebind one request id to another directory", async () => {
    const { home } = await fixture("claude", "true\n");
    mkdirSync(join(home, "one"));
    mkdirSync(join(home, "two"));
    const base = { source: "claude" as const, prompt: "go", client_request_id: "op_rebind001" };
    await machineStartSession(home, { ...base, directory: join(home, "one") }, { supervisionMs: 300 });
    await expect(
      machineStartSession(home, { ...base, directory: join(home, "two") }, { supervisionMs: 300 }),
    ).rejects.toThrow(/已绑定到另一组启动参数/);
  });

  it("refuses a directory that does not exist, and never writes a journal row for it", async () => {
    const { home } = await fixture("claude", "true\n");
    await expect(machineStartSession(home, {
      source: "claude",
      directory: join(home, "missing"),
      prompt: "go",
      client_request_id: "op_missing01",
    })).rejects.toThrow(/不存在/);
    expect(await new LaunchJournal(home).read("op_missing01")).toBeNull();
  });

  it("refuses an ambiguous relative path", async () => {
    const { home } = await fixture("claude", "true\n");
    await expect(machineStartSession(home, {
      source: "claude",
      directory: "src/app",
      prompt: "go",
      client_request_id: "op_relative1",
    })).rejects.toThrow(/绝对路径/);
  });

  it("refuses both forms at once, rather than picking a winner", async () => {
    // The approval card named ONE of them. Resolving by precedence here would
    // mean the card and the cwd can disagree, which is the whole thing the
    // frozen args exist to prevent.
    const { home, workspace } = await fixture("claude", "true\n");
    mkdirSync(join(home, "other"));
    await expect(machineStartSession(home, {
      source: "claude",
      workspace_id: workspace.id,
      directory: join(home, "other"),
      prompt: "go",
      client_request_id: "op_bothforms",
    })).rejects.toThrow(/只能给/);
    await expect(machineStartSession(home, {
      source: "claude",
      prompt: "go",
      client_request_id: "op_neither01",
    })).rejects.toThrow(/workspace_id.*directory/);
  });

  it("still honours a registered workspace, unchanged", async () => {
    // An older Agent View sends only this, including after a rollback. The
    // canonical path still never crosses the wire.
    const { home, cwd, bin, workspace } = await fixture("claude", "true\n");
    const out = join(home, "cwd3.txt");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf %s "$PWD" > '${out}'\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const result = await machineStartSession(home, args("claude", workspace.id, "op_legacy001"), {
      supervisionMs: 400,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(cwd);
    const record = await new LaunchJournal(home).read("op_legacy001");
    expect(record?.requested.workspace_id).toBe(workspace.id);
    expect(record?.requested.directory).toBeUndefined();
  });
});

it("pins explicit Codex accounts, bypasses automatic routing for default, and binds replay identity", async () => {
  const f = await fixture("codex", "exit 0");
  const startManaged = vi.fn(async () => ({ id: "019f0000-1111-7000-8000-000000000129", transport: "app-server" }));
  const selectCodexAccount = vi.fn(async (slot?: string) => {
    if (slot !== "pool-b") throw new Error("unregistered account");
    return { codexHome: "/private/account-b", label: "b" };
  });
  const deps = { controlPlane: { startManaged } as unknown as AgentControlPlane, selectCodexAccount };
  await machineStartSession(f.home, { ...args("codex", f.workspace.id, "op_account_default"), codex_account: "@default" }, deps);
  expect(selectCodexAccount).not.toHaveBeenCalled();
  expect(startManaged).toHaveBeenCalledWith(expect.objectContaining({ codexHome: join(f.home, ".codex") }));
  await machineStartSession(f.home, { ...args("codex", f.workspace.id, "op_account_selected"), codex_account: "pool-b" }, deps);
  expect(selectCodexAccount).toHaveBeenCalledWith("pool-b");
  expect(startManaged).toHaveBeenCalledWith(expect.objectContaining({ codexHome: "/private/account-b" }));
  await expect(machineStartSession(f.home, { ...args("codex", f.workspace.id, "op_account_selected"), codex_account: "@default" }, deps)).rejects.toThrow();
  await expect(machineStartSession(f.home, { ...args("codex", f.workspace.id, "op_account_missing"), codex_account: "missing" }, { controlPlane: deps.controlPlane })).rejects.toThrow("未在此 Runner 登记");
});

it.each([
  [undefined, false], ["@default", false], [undefined, true], ["@default", true],
] as const)("uses the active pool for a new default launch (%s, split=%s), but replays the original receipt", async (account, split) => {
  const f = await fixture("codex", "exit 0");
  const startManaged = vi.fn(async () => ({ sessionId: "codex_active_pool_123", transport: "app-server" as const,
    turnId: "pool-turn", completion: Promise.resolve({ ok: true }) }));
  const selectCodexAccount = vi.fn(async () => ({ codexHome: "/private/account-a", label: "a" }));
  const mcp = split ? await executionMcp() : undefined;
  const request = { ...args("codex", f.workspace.id, "op_active_pool"), ...(account ? { codex_account: account } : {}),
    ...(mcp ? { execution_device: "val15", _octopus_execution_mcp_url: mcp.url, _octopus_execution_mcp_token: "mcp_fixture_token" } : {}) };
  const deps = { controlPlane: { startManaged } as unknown as AgentControlPlane,
    codexHome: "/private/retired-b", requireCodexAccountSelection: true, selectCodexAccount,
    codexExecRelay: { open: async () => ({ environmentId: "pool-environment", endpoint: "ws://127.0.0.1:32123", close: async () => {} }) } as unknown as CodexExecRelayCoordinator };
  const result = await machineStartSession(f.home, request, deps);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(selectCodexAccount).toHaveBeenCalledWith(undefined);
  expect(startManaged).toHaveBeenCalledWith(expect.objectContaining({ codexHome: "/private/account-a" }));
  const replay = await machineStartSession(f.home, request, { ...deps, selectCodexAccount: async () => { throw new Error("pool is now unavailable"); } });
  expect(replay).toMatchObject({ ok: true, replayed: true, session_id: "codex_active_pool_123" });
  expect(startManaged).toHaveBeenCalledOnce();
});

it("refuses a new default launch when the required pool cannot select an account", async () => {
  const f = await fixture("codex", "exit 0");
  const startManaged = vi.fn();
  await expect(machineStartSession(f.home, { ...args("codex", f.workspace.id, "op_empty_pool"), codex_account: "@default" }, {
    controlPlane: { startManaged } as unknown as AgentControlPlane, requireCodexAccountSelection: true,
  })).rejects.toThrow("不能回退到旧默认登录");
  expect(startManaged).not.toHaveBeenCalled();
});
