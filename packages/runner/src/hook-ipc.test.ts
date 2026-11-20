import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeRegistry, type ProcSnapshot, type ProcessReader } from "./agent-runtime.js";
import { AgentInteractionBroker } from "./agent-interactions.js";
import { reportHook, requestHook, startHookServer, type ClaudeOpenQuestion } from "./hook-ipc.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private hook IPC", () => {
  it("accepts a hook over a mode-0600 Unix socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-ipc-"));
    roots.push(root);
    const socketPath = join(root, "private", "hooks.sock");
    const hookPid = process.pid;
    const rows = new Map<number, ProcSnapshot>([
      [hookPid, proc(hookPid, 50, ["node", "runner.js"])],
      [50, proc(50, 1, ["codex"])],
    ]);
    const reader: ProcessReader = { read: async (pid) => rows.get(pid) ?? null, signal: () => {} };
    const registry = new AgentRuntimeRegistry({ processReader: reader });
    const server = await startHookServer(registry, socketPath);
    try {
      await expect(reportHook("codex", {
        session_id: "codex-session",
        hook_event_name: "UserPromptSubmit",
      }, socketPath)).resolves.toBe(true);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      expect(registry.publicRuntime("codex", "codex-session")).toMatchObject({
        process_state: "alive",
        turn_state: "working",
      });
    } finally {
      await server.close();
    }
  });

  it("acknowledges Stop before the final-prose observer finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-ipc-observer-"));
    roots.push(root);
    const socketPath = join(root, "hooks.sock");
    const hookPid = process.pid;
    const rows = new Map<number, ProcSnapshot>([
      [hookPid, proc(hookPid, 50, ["node", "runner.js"])],
      [50, proc(50, 1, ["claude"])],
    ]);
    const registry = new AgentRuntimeRegistry({
      processReader: { read: async (pid) => rows.get(pid) ?? null, signal: () => {} },
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let observed: unknown;
    const server = await startHookServer(registry, socketPath, undefined, async (provider, payload) => {
      observed = { provider, payload };
      await blocked;
    });
    try {
      await expect(reportHook("claude", {
        session_id: "claude-session",
        hook_event_name: "Stop",
      }, socketPath, 100)).resolves.toBe(true);
      expect(observed).toEqual({
        provider: "claude",
        payload: { session_id: "claude-session", hook_event_name: "Stop" },
      });
    } finally {
      release();
      await server.close();
    }
  });

  it("fails open when no Runner is listening", async () => {
    await expect(reportHook("claude", {}, join(tmpdir(), "definitely-no-octopus.sock"), 20)).resolves.toBe(false);
  });

  it("keeps a lifecycle report through a brief loaded-Runner delay", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-ipc-loaded-"));
    roots.push(root);
    const socketPath = join(root, "hooks.sock");
    const hookPid = process.pid;
    const rows = new Map<number, ProcSnapshot>([
      [hookPid, proc(hookPid, 50, ["node", "runner.js"])],
      [50, proc(50, 1, ["codex"])],
    ]);
    let firstRead = true;
    const reader: ProcessReader = {
      read: async (pid) => {
        if (firstRead) {
          firstRead = false;
          await new Promise((resolve) => setTimeout(resolve, 550));
        }
        return rows.get(pid) ?? null;
      },
      signal: () => {},
    };
    const registry = new AgentRuntimeRegistry({ processReader: reader });
    const server = await startHookServer(registry, socketPath);
    try {
      await expect(reportHook("codex", {
        session_id: "slow-session",
        hook_event_name: "Stop",
      }, socketPath)).resolves.toBe(true);
      expect(registry.publicRuntime("codex", "slow-session")).toMatchObject({ turn_state: "idle" });
    } finally {
      await server.close();
    }
  });

  it("returns Claude AskUserQuestion control output while a browser is watching", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-ipc-question-"));
    roots.push(root);
    const socketPath = join(root, "hooks.sock");
    const hookPid = process.pid;
    const rows = new Map<number, ProcSnapshot>([
      [hookPid, proc(hookPid, 50, ["node", "runner.js"])],
      [50, proc(50, 1, ["claude"])],
    ]);
    const registry = new AgentRuntimeRegistry({
      processReader: { read: async (pid) => rows.get(pid) ?? null, signal: () => {} },
    });
    const interactions = new AgentInteractionBroker({ watchTtlMs: 2_000 });
    interactions.watch("claude", "claude-session");
    const server = await startHookServer(registry, socketPath, interactions);
    try {
      const waiting = requestHook("claude", {
        session_id: "claude-session",
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{
            header: "Scope",
            question: "Which scope?",
            options: [{ label: "small", description: "Small" }],
          }],
        },
      }, socketPath, 2_000);
      const shown = await waitFor(() => interactions.publicInteraction("claude", "claude-session"));
      interactions.respond({
        provider: "claude",
        session_id: "claude-session",
        interaction_id: shown.id,
        response_json: JSON.stringify({ decision: "allow", answers: { question_1: ["small"] } }),
      });
      await expect(waiting).resolves.toMatchObject({
        ok: true,
        hook_output: {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { answers: { "Which scope?": "small" } },
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it("leaves SDK-managed Claude interactions to canUseTool instead of creating a duplicate card", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-ipc-sdk-question-"));
    roots.push(root);
    const socketPath = join(root, "hooks.sock");
    const hookPid = process.pid;
    const rows = new Map<number, ProcSnapshot>([
      [hookPid, proc(hookPid, 50, ["node", "runner.js"])],
      [50, proc(50, 1, ["claude"])],
    ]);
    const registry = new AgentRuntimeRegistry({
      processReader: { read: async (pid) => rows.get(pid) ?? null, signal: () => {} },
    });
    const interactions = new AgentInteractionBroker();
    const finishManaged = interactions.beginManaged("claude", "claude-session", { providerControl: true });
    const server = await startHookServer(registry, socketPath, interactions);
    try {
      await expect(requestHook("claude", {
        session_id: "claude-session",
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ header: "Scope", question: "Which?", options: [{ label: "One" }] }] },
      }, socketPath, 2_000)).resolves.toEqual({ ok: true });
      expect(interactions.publicInteraction("claude", "claude-session")).toBeUndefined();
    } finally {
      finishManaged();
      await server.close();
    }
  });

  /** A Claude CLI (pid 50) whose hooks this test reports, plus a terminal that records answers. */
  async function claudeHooks(watch: boolean) {
    const root = mkdtempSync(join(tmpdir(), "octopus-ipc-released-"));
    roots.push(root);
    const socketPath = join(root, "hooks.sock");
    const transcriptPath = join(root, "claude-session.jsonl");
    writeFileSync(transcriptPath, '{"type":"assistant"}\n');
    const rows = new Map<number, ProcSnapshot>([
      [process.pid, proc(process.pid, 50, ["node", "runner.js"])],
      [50, proc(50, 1, ["claude"])],
    ]);
    const registry = new AgentRuntimeRegistry({
      processReader: { read: async (pid) => rows.get(pid) ?? null, signal: () => {} },
    });
    const interactions = new AgentInteractionBroker({ watchTtlMs: 60_000 });
    if (watch) interactions.watch("claude", "claude-session");
    const answered: Array<{ question: ClaudeOpenQuestion; prompt: string | null }> = [];
    const server = await startHookServer(registry, socketPath, interactions, undefined, {
      reachable: async () => true,
      answer: async (_sessionId, question, prompt) => { answered.push({ question, prompt }); },
    });
    const hook = (payload: Record<string, unknown>) => requestHook("claude", {
      session_id: "claude-session", transcript_path: transcriptPath, ...payload,
    }, socketPath, 2_000);
    const ask = {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_q",
      tool_input: { questions: [{ header: "Scope", question: "  Which scope?\n", options: [{ label: "small" }] }] },
    };
    const respond = () => interactions.respond({
      provider: "claude",
      session_id: "claude-session",
      interaction_id: interactions.publicInteraction("claude", "claude-session")!.id,
      response_json: JSON.stringify({ decision: "allow", answers: { question_1: ["small"] } }),
    });
    return { socketPath, server, interactions, hook, ask, respond, answered, transcriptPath };
  }

  it("answers with the exact question text Claude asked, not its trimmed projection", async () => {
    const { server, interactions, hook, ask, respond } = await claudeHooks(true);
    try {
      const waiting = hook(ask);
      await waitFor(() => interactions.publicInteraction("claude", "claude-session"));
      await respond();
      await expect(waiting).resolves.toMatchObject({
        hook_output: { hookSpecificOutput: { updatedInput: { answers: { "  Which scope?\n": "small" } } } },
      });
    } finally {
      await server.close();
    }
  });

  it("leaves an unwatched question in the TUI and answers it there from the browser", async () => {
    const { server, interactions, hook, ask, respond, answered, transcriptPath } = await claudeHooks(false);
    try {
      // The hook returns at once, so Claude shows its own dialog.
      await expect(hook(ask)).resolves.toEqual({ ok: true });
      // The dialog's own permission prompt and a subagent's tool call leave it open.
      await expect(hook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion" })).resolves.toEqual({ ok: true });
      await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_q", agent_id: "a1" });
      expect(interactions.publicInteraction("claude", "claude-session")).toMatchObject({ kind: "question", status: "pending" });

      await respond();
      expect(answered).toEqual([{
        question: { toolUseId: "toolu_q", transcriptPath, transcriptOffset: statSync(transcriptPath).size },
        prompt: expect.stringContaining("-   Which scope?\n → small"),
      }]);
      expect(interactions.publicInteraction("claude", "claude-session")).toMatchObject({ status: "resolved" });
    } finally {
      await server.close();
    }
  });

  it("drops a released question once Claude reports its tool call finished", async () => {
    const { server, interactions, hook, ask } = await claudeHooks(false);
    try {
      await hook(ask);
      await hook({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_q" });
      expect(interactions.publicInteraction("claude", "claude-session")).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("answers in the terminal when the held hook's helper is already gone", async () => {
    const { socketPath, server, interactions, ask, respond, answered, transcriptPath } = await claudeHooks(true);
    try {
      // A helper Claude killed after half-closing its request: no socket event reaches the server.
      const helper = createConnection(socketPath);
      await new Promise<void>((resolve) => helper.once("connect", () => resolve()));
      helper.end(JSON.stringify({ provider: "claude", reporter_pid: process.pid,
        payload: { session_id: "claude-session", transcript_path: transcriptPath, ...ask } }));
      await waitFor(() => interactions.publicInteraction("claude", "claude-session"));
      helper.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));

      await respond();
      expect(answered).toHaveLength(1);
      expect(interactions.publicInteraction("claude", "claude-session")).toMatchObject({ status: "resolved" });
    } finally {
      await server.close();
    }
  });

  it("does not unlink a live Runner socket when a second Runner starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-ipc-live-"));
    roots.push(root);
    const socketPath = join(root, "hooks.sock");
    const registry = new AgentRuntimeRegistry();
    const first = await startHookServer(registry, socketPath);
    try {
      await expect(startHookServer(registry, socketPath)).rejects.toThrow(/already serving/);
      await expect(reportHook("claude", {}, socketPath)).resolves.toBe(false);
    } finally {
      await first.close();
    }
  });
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for interaction");
}

function proc(pid: number, ppid: number, argv: string[]): ProcSnapshot {
  return { pid, ppid, pgid: pid, tty: 1, startTicks: String(pid), bootId: "boot", command: argv[0], argv };
}
