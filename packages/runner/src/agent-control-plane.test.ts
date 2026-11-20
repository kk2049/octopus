import { CodexContinuationStore } from "./codex-continuation.js";
import { CodexQueueError, type CodexQueueOptions } from "./codex-native-queue.js";
import { CodexDesktopSession } from "./codex-desktop.js";
import { ManagedDependencyUnavailable } from "./managed-execution.js";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentControlPlane } from "./agent-control-plane.js";
import { AgentInteractionBroker } from "./agent-interactions.js";
import {
  AgentRuntimeRegistry,
  type AgentProvider,
  type ProcSnapshot,
  type ProcessReader,
} from "./agent-runtime.js";
import { CodexManagedSession, codexRequestError } from "./codex-app-server.js";
import { TerminalControl } from "./terminal-control.js";
import type { CodexAppServerHost } from "./codex-app-server-host.js";
import { CodexSplitHosts } from "./codex-split-hosts.js";
import {
  ClaudeTranslationService,
  type ClaudeAssistantTranslation,
  type ClaudeTranslationPort,
} from "./claude-translation.js";
import { ManagedRecoveryJournal, RUNNER_RECOVERY_PROMPT } from "./managed-recovery.js";
import { ProviderSessionRefs, type ProviderSessionRef } from "./provider-session-ref.js";
import { AgentExecutableRegistry, usingAgentExecutables } from "./agent-executables.js";

const roots: string[] = [];

type TmuxRun = (bin: string, args: string[], input?: string) => Promise<{ stdout: string }>;
/** tmux answers for a Claude composer that is focused and empty; other commands reach `run`. */
function withEmptyComposer(run: TmuxRun): TmuxRun {
  return async (bin, args, input) => args[0] === "display-message" ? { stdout: "1 2 0\n" }
    : args[0] === "capture-pane" && args.includes("-e") ? { stdout: "\u276f\u00a0\n" }
    : run(bin, args, input);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class Processes implements ProcessReader {
  rows = new Map<number, ProcSnapshot>();
  signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  read = async (pid: number): Promise<ProcSnapshot | null> => this.rows.get(pid) ?? null;
  signal = (pid: number, signal: NodeJS.Signals): void => { this.signals.push({ pid, signal }); };
}

function proc(pid: number, ppid: number, argv: string[]): ProcSnapshot {
  return { pid, ppid, pgid: pid, tty: 8, startTicks: String(pid * 10), bootId: "boot-a", command: argv[0], argv };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function sessionRef(id: string, rolloutPath?: string): ProviderSessionRef {
  return {
    logicalId: id,
    currentProviderId: id,
    ...(rolloutPath ? { rolloutPath } : {}),
    lineage: [id],
  };
}

function seedManagedAttachment(
  plane: AgentControlPlane,
  provider: AgentProvider,
  sessionId: string,
  value: Record<string, unknown>,
): ProviderSessionRef {
  const sessions = (plane as unknown as {
    sessions: ProviderSessionRefs<Record<string, unknown>>;
  }).sessions;
  const session = sessions.reference(provider, sessionId);
  sessions.attach(session, { provider, session, ...value });
  return session;
}

type PaneProbeHarness = {
  tmuxPane(pid: number, force?: boolean): Promise<{ paneId: string; ttyPath: string } | null>;
  paneProbes: Map<number, unknown>;
};

function paneProbePlane(attachmentForPid: (pid: number) => Promise<{ paneId: string; ttyPath: string } | null>): PaneProbeHarness {
  const plane = new AgentControlPlane({
    runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
    interactions: new AgentInteractionBroker(),
    terminal: { attachmentForPid } as TerminalControl,
    timeoutMs: 5_000,
  });
  return plane as unknown as PaneProbeHarness;
}

function fakeClaudeTranslations(english: string, bilingual = true) {
  const translateUser = vi.fn(async (text: string) => ({
    turnId: "translation-turn",
    zh: text,
    en: english,
  }));
  const recordUser = vi.fn(async () => {});
  const port = {
    isBilingualSession: async () => bilingual,
    translateUser,
    recordUser,
    translateAssistant: async (
      _sessionId: string,
      _turnId: string,
      text: string,
    ): Promise<ClaudeAssistantTranslation> => ({
      ok: true,
      bilingual: { zh: "已完成。", en: text },
    }),
    decorateTranscript: async (raw: unknown) => raw,
    observeClaudeHook: async () => {},
  } satisfies ClaudeTranslationPort;
  return { port, translateUser, recordUser };
}

function fakeCodexController(options: {
  sessionId?: string;
  transcriptPath?: string;
  dispatchKind?: "started" | "steered";
  completion?: Promise<{
    started: true;
    ok: boolean;
    status: string;
    error?: string;
    usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
  }>;
  close?: () => Promise<void>;
  interrupt?: () => Promise<void>;
} = {}): CodexManagedSession {
  const controller = Object.create(CodexManagedSession.prototype) as CodexManagedSession;
  const completion = options.completion ?? Promise.resolve({ started: true as const, ok: true, status: "completed" });
  Object.defineProperties(controller, {
    sessionId: { value: options.sessionId ?? "thread-dedicated" },
    transcriptPath: { value: options.transcriptPath },
    options: { value: { cwd: "/tmp" } },
    active: { value: null, writable: true },
    dispatch: {
      value: vi.fn(async () => {
        const turnId = "turn-dedicated";
        (controller as unknown as { active: unknown }).active = { turnId, completion };
        void completion.then(
          () => { (controller as unknown as { active: unknown }).active = null; },
          () => { (controller as unknown as { active: unknown }).active = null; },
        );
        return { kind: options.dispatchKind ?? "started", turnId, completion };
      }),
    },
    interrupt: { value: vi.fn(options.interrupt ?? (async () => {})) },
    close: { value: vi.fn(options.close ?? (async () => {})), writable: true },
  });
  return controller;
}

describe("AgentControlPlane managed restart recovery", () => {
  it("steers a managed turn when a ticket repeats its current model and effort", async () => {
    const completion = deferred<{ started: true; ok: boolean; status: string }>();
    const controller = fakeCodexController({ completion: completion.promise });
    const start = vi.spyOn(CodexManagedSession, "start").mockResolvedValue(controller);
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 0 });
    const turn = await plane.startManaged({ provider: "codex", cwd: "/tmp", prompt: "original task",
      model: "gpt-6-astra", effort: "xhigh" });
    vi.mocked(controller.dispatch).mockResolvedValue({ kind: "steered", turnId: turn.turnId,
      completion: completion.promise });
    const input = { provider: "codex" as const, sessionId: turn.sessionId, cwd: "/tmp", prompt: "请继续",
      model: "gpt-6-astra", effort: "xhigh", takeover: false };
    const onInput = vi.fn();
    await expect(plane.continueSession({ ...input, onInput })).resolves.toMatchObject({ control_action: "steer", turn_id: turn.turnId });
    expect(start).toHaveBeenCalledTimes(1);
    expect(controller.dispatch).toHaveBeenCalledTimes(2);
    expect(controller.dispatch).toHaveBeenLastCalledWith("请继续");
    expect(onInput).toHaveBeenCalledWith(expect.objectContaining({ phase: "provider_accepted" }));
    await expect(plane.continueSession({ ...input, effort: "high" })).rejects.toMatchObject({ code: "effort_turn_active" });
    await expect(plane.continueSession({ ...input, model: "different" })).rejects.toMatchObject({ code: "model_turn_active" });
    expect(controller.dispatch).toHaveBeenCalledTimes(2);
    completion.resolve({ started: true, ok: true, status: "completed" });
    await turn.completion;
    await plane.close();
  });

  it("preserves a capacity-waiting operation through a planned restart and resumes its original selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "capacity-restart-")); roots.push(root);
    const stateFile = join(root, "recovery.json");
    let clock = Date.parse("2026-09-24T12:00:00Z");
    const journal = new ManagedRecoveryJournal({ stateFile, now: () => new Date(clock) }); await journal.load();
    const controller = fakeCodexController({ completion: Promise.resolve({ started: true, ok: false, status: "failed",
      error: "Selected model is at capacity. Please try a different model." }) });
    vi.spyOn(CodexManagedSession, "start").mockResolvedValue(controller);
    const options = { runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 0, now: () => new Date(clock), recoveryJournal: journal };
    const plane = new AgentControlPlane(options);
    const turn = await plane.startManaged({ provider: "codex", cwd: root, prompt: "original effects",
      model: "selected", effort: "xhigh", codexHome: join(root, "account-d"), permissionProfile: "manual" });
    await vi.waitFor(() => expect(journal.snapshot()[0]?.capacityRetry?.phase).toBe("waiting"));
    const finished = vi.fn(); void turn.completion.then(finished);
    await plane.close({ preserveRecoveries: true });
    expect(finished).not.toHaveBeenCalled();
    const restored = new ManagedRecoveryJournal({ stateFile, now: () => new Date(clock) }); await restored.load();
    const resumed = fakeCodexController();
    const resume = vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(resumed);
    const next = new AgentControlPlane({ ...options, recoveryJournal: restored });
    expect(await next.recoverInterrupted(true)).toEqual({ recovered: 0, unknown: 0 });
    expect(next.hasPendingRecovery()).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    clock += 30_000;
    expect(await next.recoverInterrupted(true)).toEqual({ recovered: 1, unknown: 0 });
    expect(resume).toHaveBeenCalledWith(turn.sessionId, expect.objectContaining({
      model: "selected", effort: "xhigh", codexHome: join(root, "account-d"), permissionProfile: "manual" }));
    expect(resumed.dispatch).toHaveBeenCalledExactlyOnceWith("继续执行");
    await vi.waitFor(() => expect(restored.capacityReceipt(turn.sessionId, turn.turnId)).toMatchObject({ state: "succeeded" }));
    expect(restored.snapshot()[0]?.capacityRetry).toMatchObject({ attempts: 1, deadlineAt: "2026-09-24T12:30:00.000Z" });
    await next.close();
  });

  it("holds one logical operation through capacity wait, exposes Stop, and never notifies early", async () => {
    const first = deferred<{ started: true; ok: boolean; status: string; error?: string }>();
    const controller = fakeCodexController({ completion: first.promise });
    vi.spyOn(CodexManagedSession, "start").mockResolvedValue(controller);
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 0 });
    const completed = vi.fn(); plane.onManagedCompletion(completed);
    const turn = await plane.startManaged({ provider: "codex", cwd: "/tmp", prompt: "original effects", model: "pinned", effort: "high" });
    first.resolve({ started: true, ok: false, status: "failed",
      error: "Selected model is at capacity. Please try a different model." });
    await vi.waitFor(async () => expect(await plane.publicRuntime("codex", turn.sessionId)).toMatchObject({
      recovery: { state: "waiting_capacity", attempts: 0, max_attempts: 6 },
      capabilities: { interrupt: true, protocol_append: false } }));
    expect(completed).not.toHaveBeenCalled();
    expect(controller.close).not.toHaveBeenCalled();
    await plane.interruptSession("codex", turn.sessionId);
    expect(await turn.completion).toMatchObject({ status: "interrupted", ok: false });
    expect(controller.dispatch).toHaveBeenCalledExactlyOnceWith("original effects");
    await plane.close();
  });

  it.each([null, "Please continue.", "繼續執行"])("continues on the same controller with configured text %s and only one final notification", async customPrompt => {
    vi.useFakeTimers();
    try {
      const controller = fakeCodexController();
      vi.mocked(controller.dispatch)
        .mockResolvedValueOnce({ kind: "started", turnId: "original", completion: Promise.resolve({ started: true, ok: false,
          status: "failed", providerError: { code: "serverOverloaded", message: "full", threadId: controller.sessionId, turnId: "original" } }) })
        .mockResolvedValueOnce({ kind: "started", turnId: "retry", completion: Promise.resolve({ started: true, ok: true, status: "completed" }) });
      const start = vi.spyOn(CodexManagedSession, "start").mockResolvedValue(controller);
      const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
        interactions: new AgentInteractionBroker(), timeoutMs: 0 });
      const settingsRoot = mkdtempSync(join(tmpdir(), "continuation-capacity-")); roots.push(settingsRoot);
      const settings = new CodexContinuationStore(join(settingsRoot, "settings.json")); await settings.load();
      (plane as unknown as { codexContinuations: CodexContinuationStore }).codexContinuations = settings;
      const completed = vi.fn(); plane.onManagedCompletion(completed);
      const turn = await plane.startManaged({ provider: "codex", cwd: "/tmp", prompt: "effectful original",
        model: "pinned", effort: "xhigh", codexHome: "/tmp/account-d", permissionProfile: "manual" });
      if (customPrompt !== null) await plane.saveContinuationSettings("codex", turn.sessionId, customPrompt, "0");
      expect(controller.dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await turn.completion).toMatchObject({ ok: true });
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0]?.[0]).toMatchObject({ model: "pinned", effort: "xhigh", codexHome: "/tmp/account-d", permissionProfile: "manual" });
      expect(controller.dispatch).toHaveBeenNthCalledWith(1, "effectful original");
      expect(controller.dispatch).toHaveBeenNthCalledWith(2, customPrompt ?? "继续执行");
      expect(completed).toHaveBeenCalledOnce();
      await plane.close();
    } finally { vi.useRealTimers(); }
  });

  it("starts and resumes a named split account on its own endpoint and persists the exact native home", async () => {
    const root = mkdtempSync(join(tmpdir(), "split-account-plane-")); roots.push(root);
    const hosts = new CodexSplitHosts({ home: root, defaultCodexHome: join(root, "default"),
      splitHome: join(root, ".octopus/codex-split-home"), endpointFile: join(root, "endpoint"),
      accounts: [{ label: "a", codexHome: join(root, "account-a") }] });
    const selected = hosts.select(join(root, "account-a"));
    const release = vi.fn();
    vi.spyOn(selected.host, "acquire").mockImplementation(async () => {
      let released = false;
      return { endpoint: "ws://127.0.0.1:5951", release: () => { if (!released) { released = true; release(); } } };
    });
    vi.spyOn(selected.host, "endpoint", "get").mockReturnValue("ws://127.0.0.1:5951");
    const defaultAcquire = vi.spyOn(hosts.defaultHost, "acquire");
    const journal = new ManagedRecoveryJournal({ stateFile: join(root, "recovery.json") }); await journal.load();
    const options = { runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 0, recoveryJournal: journal,
      codexRemoteHostForHome: (home?: string) => hosts.select(home) };
    const completion = deferred<{ started: true; ok: boolean; status: string }>();
    const start = vi.spyOn(CodexManagedSession, "start").mockResolvedValue(fakeCodexController({ completion: completion.promise }));
    const plane = new AgentControlPlane(options);
    const environment = { environmentId: "remote-595", endpoint: "ws://127.0.0.1:5952" };
    const first = await plane.startManaged({ provider: "codex", cwd: root, prompt: "first", codexHome: join(root, "account-a"),
      codexEnvironment: environment, recoveryPlacement: { executionDevice: "4090", workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(start.mock.calls[0]![0]).toMatchObject({ endpoint: "ws://127.0.0.1:5951", environment: { environmentId: "remote-595" } });
    expect(start.mock.calls[0]![0]).not.toHaveProperty("codexHome");
    expect(journal.snapshot()[0]).toMatchObject({ codexHome: selected.codexHome, status: "active" });
    plane.prepareForRestart();
    completion.resolve({ started: true, ok: true, status: "completed" }); await first.completion;
    await plane.close({ preserveRecoveries: true });
    const restored = new ManagedRecoveryJournal({ stateFile: join(root, "recovery.json") }); await restored.load();
    const resume = vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(fakeCodexController());
    const next = new AgentControlPlane({ ...options, recoveryJournal: restored,
      recoveryScopes: { request: async () => ({ token: "mcp_fresh", executionDevice: "4090", workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaa",
        endpoint: "http://127.0.0.1:5953/mcp", expiresAt: Date.parse("2099-01-01T00:00:00Z"), operationId: "recover-595" }) },
      openRecoveryRemote: async () => ({ remoteMcpUrl: "http://127.0.0.1:5953/mcp", codexEnvironment: environment, close: async () => {} }) });
    expect(await next.recoverInterrupted()).toEqual({ recovered: 1, unknown: 0 });
    expect(resume.mock.calls[0]![1]).toMatchObject({ endpoint: "ws://127.0.0.1:5951" });
    expect(resume.mock.calls[0]![1]).not.toHaveProperty("codexHome");
    resume.mockResolvedValue(fakeCodexController());
    expect(await next.continueSession({ provider: "codex", sessionId: first.sessionId, cwd: root, prompt: "next", takeover: false,
      codexHome: selected.codexHome, codexEnvironment: environment })).toMatchObject({ ok: true });
    expect(resume.mock.calls[1]![1]).toMatchObject({ endpoint: "ws://127.0.0.1:5951" });
    expect(resume.mock.calls[1]![1]).not.toHaveProperty("codexHome");
    expect(defaultAcquire).not.toHaveBeenCalled();
    await next.close();
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("retains native transcript evidence for discovery after a managed turn detaches", async () => {
    const completion = deferred<{ started: true; ok: boolean; status: string }>();
    const file = "/native/account-b/sessions/rollout-thread-dedicated.jsonl";
    vi.spyOn(CodexManagedSession, "start").mockResolvedValue(fakeCodexController({
      completion: completion.promise, transcriptPath: file,
    }));
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 0 });
    const activity = vi.fn(); plane.onManagedTranscriptActivity(activity);
    try {
      await plane.startManaged({ provider: "codex", cwd: "/tmp", prompt: "quick task" });
      expect(plane.managedSessions()).toEqual([{ source: "codex", id: "thread-dedicated", path: file }]);
      completion.resolve({ started: true, ok: true, status: "completed" });
      await vi.waitFor(() => expect(plane.managedSessions()).toEqual([]));
      expect(activity).toHaveBeenCalledWith("codex", "thread-dedicated", file);
    } finally { await plane.close(); }
  });

  it("persists a fresh Codex identity before dispatch and exposes stop during the acknowledgement wait", async () => {
    const completion = deferred<{ started: true; ok: boolean; status: string }>();
    const accepted = deferred<{ kind: "started"; turnId: string; completion: typeof completion.promise }>();
    const controller = fakeCodexController({ completion: completion.promise });
    vi.mocked(controller.dispatch).mockReturnValue(accepted.promise);
    vi.spyOn(CodexManagedSession, "start").mockResolvedValue(controller);
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 0 });
    const onPrepared = vi.fn(async (id: string) => {
      expect(id).toBe("thread-dedicated");
      expect(controller.dispatch).not.toHaveBeenCalled();
    });
    const starting = plane.startManaged({ provider: "codex", cwd: "/tmp", prompt: "once", onPrepared });
    await vi.waitFor(() => expect(controller.dispatch).toHaveBeenCalledOnce());
    expect(onPrepared).toHaveBeenCalledOnce();
    expect(controller.close).not.toHaveBeenCalled();
    expect(await plane.interruptSession("codex", "thread-dedicated")).toMatchObject({ control_action: "interrupt_pending" });
    expect(controller.interrupt).toHaveBeenCalledOnce();
    accepted.resolve({ kind: "started", turnId: "original-turn", completion: completion.promise });
    const managed = await starting;
    completion.resolve({ started: true, ok: false, status: "interrupted" });
    await managed.completion;
    await plane.close();
  });

  it("never sends input when native identity persistence fails", async () => {
    const controller = fakeCodexController();
    vi.spyOn(CodexManagedSession, "start").mockResolvedValue(controller);
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 0 });
    await expect(plane.startManaged({ provider: "codex", cwd: "/tmp", prompt: "once",
      onPrepared: async () => { throw new Error("journal unavailable"); } })).rejects.toThrow("journal unavailable");
    expect(controller.dispatch).not.toHaveBeenCalled();
    expect(controller.close).toHaveBeenCalledOnce();
    await plane.close();
  });

  it("preserves a Codex setup refusal that explicitly forbids legacy fallback", async () => {
    const refusal = codexRequestError("direct app-server input is not allowed for multi-agent v2 sub-agents");
    vi.spyOn(CodexManagedSession, "resume").mockRejectedValue(refusal);
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 5_000 });
    try {
      await expect(plane.continueSession({ provider: "codex", sessionId: "closed-child", cwd: "/tmp",
        prompt: "do not replay", takeover: false })).rejects.toMatchObject({
        code: "codex_subagent_thread", safeFallback: false,
      });
    } finally { await plane.close(); }
  });

  it("steer-only never resumes an idle session or starts a replacement provider", async () => {
    const resume = vi.spyOn(CodexManagedSession, "resume");
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 5_000 });
    await expect(plane.continueSession({ provider: "codex", sessionId: "idle", cwd: "/tmp",
      prompt: "late input", takeover: false, steerOnly: true })).resolves.toMatchObject({ ok: false, code: "turn_not_active" });
    expect(resume).not.toHaveBeenCalled();
  });

  it("uses the provider's steer-only method and returns an independent input acknowledgement", async () => {
    const controller = fakeCodexController();
    (controller as unknown as { active: unknown }).active = { turnId: "original" };
    const steer = vi.fn(async () => true);
    Object.defineProperty(controller, "steer", { value: steer });
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 5_000 });
    seedManagedAttachment(plane, "codex", "native", { cwd: "/tmp", transport: "app-server", turnId: "original",
      startedAt: new Date().toISOString(), controller });
    const onInput = vi.fn();
    await expect(plane.continueSession({ provider: "codex", sessionId: "native", cwd: "/tmp",
      prompt: "more context", takeover: false, steerOnly: true, onInput })).resolves.toMatchObject({ control_action: "steer", turn_id: "original" });
    expect(steer).toHaveBeenCalledWith("more context");
    expect(controller.dispatch).not.toHaveBeenCalled();
    expect(onInput).toHaveBeenCalledWith(expect.objectContaining({ phase: "provider_accepted", turn_id: "original" }));
  });
  it.each([null, "Please continue", "繼續執行"])("resumes a Claude team and split Codex with persisted text %s", async customPrompt => {
    const root = mkdtempSync(join(tmpdir(), "agent-control-recovery-"));
    roots.push(root);
    const stateFile = join(root, "managed-recovery.json");
    const before = new ManagedRecoveryJournal({ stateFile });
    await before.load();
    const claudeRef = sessionRef("claude-local");
    const codexRef = sessionRef("codex-split");
    await before.prepare({ provider: "claude", session: claudeRef, cwd: root });
    await before.activate("claude", claudeRef, "turn-local");
    await before.setBackgroundTasks("claude", claudeRef, [{
      taskId: "research-agent",
      description: "检索相关工作",
    }]);
    await before.prepare({
      provider: "codex",
      session: codexRef,
      cwd: root,
      remotePlacement: {
        executionDevice: "val15",
        workspaceId: "ws_0123456789abcdef01234567",
      },
    });
    await before.activate("codex", codexRef, "turn-split");

    const configured = new CodexContinuationStore(join(root, "continuation.json")); await configured.load();
    if (customPrompt !== null) await configured.save(codexRef, customPrompt, "0");
    const codexContinuations = new CodexContinuationStore(join(root, "continuation.json")); await codexContinuations.load();
    const journal = new ManagedRecoveryJournal({ stateFile });
    await journal.load();
    const requestScope = vi.fn(async () => ({
      token: "mcp_fresh",
      endpoint: "http://127.0.0.1:9820/api/mcp",
      expiresAt: Date.now() + 60_000,
      operationId: "op_recovery",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
    }));
    const remoteClose = vi.fn(async () => {});
    const openRecoveryRemote = vi.fn(async () => ({
      remoteMcpUrl: "http://127.0.0.1:39001/mcp",
      codexEnvironment: { environmentId: "env-recovery", endpoint: "ws://127.0.0.1:39002" },
      close: remoteClose,
    }));
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      timeoutMs: 5_000,
      recoveryJournal: journal,
      codexContinuations,
      recoveryScopes: { request: requestScope },
      openRecoveryRemote,
    });
    const completions: Array<ReturnType<typeof deferred<Record<string, unknown>>>> = [];
    const openManaged = vi.fn(async (input: {
      provider: "claude" | "codex" | "omp";
      session: ProviderSessionRef;
      cwd: string;
      prompt: string;
      recoveryPlacement?: { executionDevice: string; workspaceId: string };
      remoteMcpUrl?: string;
      codexEnvironment?: { environmentId: string; endpoint: string };
    }) => {
      const completion = deferred<Record<string, unknown>>();
      completions.push(completion);
      const turnId = `turn-recovered-${input.provider}`;
      await journal.prepare({
        provider: input.provider,
        session: input.session,
        cwd: input.cwd,
        ...(input.recoveryPlacement ? { remotePlacement: input.recoveryPlacement } : {}),
      });
      await journal.activate(input.provider, input.session, turnId);
      return {
        provider: input.provider,
        session: input.session,
        cwd: input.cwd,
        transport: input.provider === "claude" ? "agent-sdk" : "app-server",
        turnId,
        startedAt: new Date().toISOString(),
        controller: {},
        completion: completion.promise,
        leaseHolder: "protocol",
      };
    });
    (plane as unknown as { openManaged: typeof openManaged }).openManaged = openManaged;

    await expect(plane.recoverInterrupted()).resolves.toEqual({ recovered: 2, unknown: 0 });
    expect(openManaged).toHaveBeenCalledTimes(2);
    expect(openManaged.mock.calls.map(([input]) => input.prompt)).toEqual([
      expect.stringMatching(/Octopus 重启续接[\s\S]*research-agent[\s\S]*旧 subagent 进程已经结束/),
      customPrompt ?? RUNNER_RECOVERY_PROMPT,
    ]);
    expect(requestScope).toHaveBeenCalledOnce();
    expect(requestScope).toHaveBeenCalledWith("codex", "codex-split");
    expect(openRecoveryRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        session: expect.objectContaining({ currentProviderId: "codex-split" }),
      }),
      expect.objectContaining({ token: "mcp_fresh", executionDevice: "val15" }),
    );
    expect(openManaged).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      prompt: customPrompt ?? RUNNER_RECOVERY_PROMPT,
      remoteMcpUrl: "http://127.0.0.1:39001/mcp",
      codexEnvironment: { environmentId: "env-recovery", endpoint: "ws://127.0.0.1:39002" },
    }));
    expect(JSON.stringify(journal.snapshot())).not.toContain("mcp_fresh");

    completions[0]!.resolve({ ok: true });
    // A recovered transport may reject. Its detached remote cleanup must
    // consume that outcome instead of cloning it into an unhandled `finally`
    // rejection on the resident Runner process.
    completions[1]!.reject(new Error("recovered transport failed"));
    await vi.waitFor(() => expect(remoteClose).toHaveBeenCalledOnce());
  });
});

describe("AgentControlPlane tmux observation single-flight", () => {
  it("joins concurrent read probes for one pid without joining a different pid", async () => {
    const gate = deferred<{ paneId: string; ttyPath: string } | null>();
    const attachmentForPid = vi.fn(async () => await gate.promise);
    const plane = paneProbePlane(attachmentForPid);

    const samePid = Array.from({ length: 18 }, () => plane.tmuxPane(41));
    const otherPid = plane.tmuxPane(42);
    await vi.waitFor(() => expect(attachmentForPid).toHaveBeenCalledTimes(2));

    gate.resolve({ paneId: "%4", ttyPath: "/dev/pts/8" });
    await expect(Promise.all([...samePid, otherPid])).resolves.toHaveLength(19);
    expect(plane.paneProbes.size).toBe(0);
  });

  it("forces a new probe and prevents the displaced read from poisoning its cache", async () => {
    const oldGate = deferred<{ paneId: string; ttyPath: string } | null>();
    const freshGate = deferred<{ paneId: string; ttyPath: string } | null>();
    const attachmentForPid = vi.fn()
      .mockImplementationOnce(async () => await oldGate.promise)
      .mockImplementationOnce(async () => await freshGate.promise);
    const plane = paneProbePlane(attachmentForPid);

    const oldRead = plane.tmuxPane(51);
    await vi.waitFor(() => expect(attachmentForPid).toHaveBeenCalledTimes(1));
    const forced = plane.tmuxPane(51, true);
    await vi.waitFor(() => expect(attachmentForPid).toHaveBeenCalledTimes(2));

    const fresh = { paneId: "%new", ttyPath: "/dev/pts/9" };
    freshGate.resolve(fresh);
    await expect(forced).resolves.toEqual(fresh);
    oldGate.resolve({ paneId: "%old", ttyPath: "/dev/pts/9" });
    await expect(oldRead).resolves.toMatchObject({ paneId: "%old" });

    // The completed 2s cache belongs to the force generation. If the older
    // read had published late this would be %old or a third terminal probe.
    await expect(plane.tmuxPane(51)).resolves.toEqual(fresh);
    expect(attachmentForPid).toHaveBeenCalledTimes(2);
    expect(plane.paneProbes.size).toBe(0);
  });

  it("cleans up a failed probe so the next observation can retry", async () => {
    const attachmentForPid = vi.fn()
      .mockRejectedValueOnce(new Error("probe failed"))
      .mockResolvedValueOnce({ paneId: "%retry", ttyPath: "/dev/pts/10" });
    const plane = paneProbePlane(attachmentForPid);

    await expect(plane.tmuxPane(61)).rejects.toThrow("probe failed");
    expect(plane.paneProbes.size).toBe(0);
    await expect(plane.tmuxPane(61)).resolves.toMatchObject({ paneId: "%retry" });
    expect(attachmentForPid).toHaveBeenCalledTimes(2);
  });
});

describe("AgentControlPlane external CLI routing", () => {
  async function queueFixture(event = "Stop") {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js"]));
    processes.rows.set(10, proc(10, 1, ["codex"]));
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("codex", { session_id: sessionId, hook_event_name: event }, 30);
    const terminal = { attachmentForPid: vi.fn(async (): Promise<{ paneId: string; ttyPath: string } | null> => null),
      writableAttachmentForPid: vi.fn(async (): Promise<{ paneId: string; ttyPath: string } | null> => null), append: vi.fn() };
    const queue = vi.fn(async (options: CodexQueueOptions) => {
      await options.beforeSubmit();
      return { sessionId, queuedSubmissionId: "queue-1" };
    });
    const plane = new AgentControlPlane({ runtime, interactions: new AgentInteractionBroker(), timeoutMs: 5_000,
      terminal: terminal as unknown as TerminalControl, queueCodexPrompt: queue });
    const input = { provider: "codex" as const, sessionId, prompt: "next turn", cwd: "/tmp", codexHome: "/test/account-c", takeover: false };
    return { processes, runtime, terminal, queue, plane, input };
  }

  it.each(["Stop", "UserPromptSubmit"])("queues a live Codex CLI after %s without any tmux operation", async event => {
    const { plane, input, terminal, queue, processes } = await queueFixture(event);
    const onInput = vi.fn(async () => {});
    await expect(plane.continueSession({ ...input, onInput })).resolves.toMatchObject({
      ok: true, transport: "codex-queue", queued_submission_id: "queue-1",
      input: { phase: "local_queued", evidence: "local_queue" },
    });
    expect(onInput).toHaveBeenCalledWith(expect.objectContaining({ phase: "local_queued" }));
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: input.sessionId, codexHome: input.codexHome }));
    expect(terminal.attachmentForPid).not.toHaveBeenCalled();
    expect(terminal.append).not.toHaveBeenCalled();
    expect(processes.signals).toEqual([]);
  });

  it("advertises native append while retaining the existing proven-pane stop", async () => {
    const { plane, input, terminal } = await queueFixture("UserPromptSubmit");
    terminal.attachmentForPid.mockResolvedValue({ paneId: "%1", ttyPath: "/dev/pts/8" });
    await expect(plane.publicRuntime("codex", input.sessionId)).resolves.toMatchObject({
      capabilities: { terminal_append: false, protocol_append: true, terminal_interrupt: true, interrupt: true },
    });
    expect(terminal.append).not.toHaveBeenCalled();
  });

  it.each(["codex_queue_unavailable", "codex_subagent_thread", "unknown"])("never falls back after queue %s", async code => {
    const { plane, input, terminal, queue } = await queueFixture();
    const resume = vi.spyOn(CodexManagedSession, "resume");
    queue.mockRejectedValue(new CodexQueueError("queue failure", code));
    await expect(plane.continueSession(input)).resolves.toMatchObject({ ok: false, code });
    expect(queue).toHaveBeenCalledOnce();
    expect(terminal.append).not.toHaveBeenCalled();
    expect(terminal.attachmentForPid).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it.each(["exit", "pid-reuse", "needs-input"])("refuses %s racing queue setup", async mode => {
    const { plane, input, queue, processes, runtime } = await queueFixture();
    queue.mockImplementation(async options => {
      if (mode === "exit") processes.rows.delete(10);
      if (mode === "pid-reuse") processes.rows.set(10, { ...proc(10, 1, ["codex"]), startTicks: "101" });
      if (mode === "needs-input") await runtime.recordHook("codex", { session_id: input.sessionId, hook_event_name: "PermissionRequest" }, 30);
      await options.beforeSubmit();
      throw new Error("must never submit");
    });
    await expect(plane.continueSession(input)).resolves.toMatchObject({ ok: false, code: "codex_queue_unavailable" });
  });

  it("keeps steer-only and model changes out of the external next-turn queue", async () => {
    const { plane, input, queue } = await queueFixture();
    await expect(plane.continueSession({ ...input, steerOnly: true })).resolves.toMatchObject({ code: "turn_not_active" });
    await expect(plane.continueSession({ ...input, model: "other" })).rejects.toMatchObject({ code: "model_external_cli" });
    expect(queue).not.toHaveBeenCalled();
  });

  it("uses tmux only after an explicit pre-add queue capability refusal", async () => {
    const { plane, input, queue, terminal } = await queueFixture();
    queue.mockRejectedValue(new CodexQueueError("old Codex", "codex_queue_unsupported", true));
    terminal.writableAttachmentForPid.mockResolvedValue({ paneId: "%1", ttyPath: "/dev/pts/8" });
    await expect(plane.continueSession(input)).resolves.toMatchObject({ ok: true, transport: "tmux" });
    expect(terminal.append).toHaveBeenCalledOnce();
  });

  it("does not turn an attachment identity change into a managed-resume replacement", async () => {
    const controller = fakeCodexController({ sessionId: "thread-fork" });
    const resume = vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(controller);
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
    });
    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-child",
      sessionPath: "/srv/codex/thread-child.jsonl",
      prompt: "continue",
      cwd: "/tmp",
      takeover: false,
    })).resolves.toMatchObject({
      session_id: "thread-child",
      new_session_id: "thread-child",
      control_action: "managed_resume",
    });
    expect(resume).toHaveBeenCalledWith("thread-child", expect.not.objectContaining({
      forkClosedSubagentPath: expect.anything(),
    }));
    await plane.close();
  });

  it("routes old-id status, interrupt and release through one confirmed rename", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-control-fork-alias-"));
    roots.push(root);
    const journal = new ManagedRecoveryJournal({ stateFile: join(root, "managed-recovery.json") });
    await journal.load();
    const completion = deferred<{ started: true; ok: boolean; status: string }>();
    const controller = fakeCodexController({
      sessionId: "thread-child",
      completion: completion.promise,
      close: vi.fn()
        .mockRejectedValueOnce(new Error("child still alive"))
        .mockResolvedValueOnce(undefined),
    });
    vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(controller);
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      recoveryJournal: journal,
      timeoutMs: 5_000,
    });
    const completionEvents: import("./gateway-protocol.js").RunnerManagedCompletion[] = [];
    plane.onManagedCompletion((event) => completionEvents.push(event));

    const continuing = plane.continueSession({
      provider: "codex",
      sessionId: "thread-child",
      sessionPath: join(root, "thread-child.jsonl"),
      prompt: "continue",
      cwd: root,
      takeover: false,
    });
    await vi.waitFor(() => expect(controller.dispatch).toHaveBeenCalledOnce());
    const sessions = (plane as unknown as {
      sessions: ProviderSessionRefs<Record<string, unknown>>;
    }).sessions;
    await sessions.rename("codex", "thread-child", "thread-rebound");
    expect(journal.snapshot()).toMatchObject([{
      status: "active",
      session: {
        logicalId: "thread-child",
        currentProviderId: "thread-rebound",
        rolloutPath: join(root, "thread-child.jsonl"),
        lineage: ["thread-child", "thread-rebound"],
      },
    }]);
    await expect(plane.publicRuntime("codex", "thread-child")).resolves.toMatchObject({
      turn_state: "working",
      attachment: { kind: "codex_app_server" },
      capabilities: { interrupt: true },
    });
    await expect(plane.interruptSession("codex", "thread-child")).resolves.toMatchObject({
      session_id: "thread-child",
      new_session_id: "thread-rebound",
      control_action: "interrupt",
    });
    expect(controller.interrupt).toHaveBeenCalledOnce();

    completion.resolve({ started: true, ok: true, status: "completed" });
    await expect(continuing).resolves.toMatchObject({
      session_id: "thread-child",
      new_session_id: "thread-rebound",
    });
    await vi.waitFor(() => expect(controller.close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(completionEvents).toEqual([
      expect.objectContaining({
        provider: "codex",
        logical_session_id: "thread-child",
        session_id: "thread-rebound",
        turn_id: "turn-dedicated",
        status: "succeeded",
      }),
    ]));
    await expect(plane.publicRuntime("codex", "thread-child")).resolves.toMatchObject({
      event: "ProtocolReleaseRequired",
      capabilities: { release_control: true },
    });
    await expect(plane.releaseSession("codex", "thread-child")).resolves.toMatchObject({
      session_id: "thread-child",
      new_session_id: "thread-rebound",
      released: true,
    });
    expect(controller.close).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "wrong_ticket"])("refuses development recovery before provider setup when Head lacks the exact scope (%s)", async (developmentId) => {
    const root = mkdtempSync(join(tmpdir(), "agent-development-recovery-"));
    roots.push(root);
    const stateFile = join(root, "managed-recovery.json");
    const before = new ManagedRecoveryJournal({ stateFile });
    await before.load();
    const ref = sessionRef("sid-created-before-head-saved");
    const placement = {
      executionDevice: "compute",
      workspaceId: "ws_0123456789abcdef01234567",
      developmentId: "development_ticket_578",
    };
    await before.prepare({ provider: "codex", session: ref, cwd: root, remotePlacement: placement });
    await before.activate("codex", ref, "turn-before-crash");
    const journal = new ManagedRecoveryJournal({ stateFile });
    await journal.load();
    const openRecoveryRemote = vi.fn(async () => ({
      remoteMcpUrl: "http://127.0.0.1:39001/mcp", close: async () => {},
    }));
    const resume = vi.spyOn(CodexManagedSession, "resume");
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 2_000,
      recoveryJournal: journal,
      recoveryScopes: { request: async () => ({
        token: "mcp_execution", endpoint: "http://127.0.0.1:9820/api/mcp",
        expiresAt: Date.now() + 60_000, operationId: "op_recovery",
        executionDevice: placement.executionDevice, workspaceId: placement.workspaceId,
        ...(developmentId ? { development: {
          developmentId, token: "mcp_development", endpoint: "http://127.0.0.1:9820/api/mcp",
          expiresAt: Date.now() + 60_000,
        } } : {}),
      }) },
      openRecoveryRemote,
    });
    await expect(plane.recoverInterrupted()).resolves.toEqual({ recovered: 0, unknown: 1 });
    expect(openRecoveryRemote).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(journal.snapshot()).toMatchObject([{
      status: "unknown", remotePlacement: placement,
      detail: expect.stringContaining("等待可信开发范围恢复"),
    }]);
    await expect(plane.recoverInterrupted()).resolves.toEqual({ recovered: 0, unknown: 0 });
    await plane.close();
  });

  it("keeps pre-dispatch recovery retryable, single-flight, and stoppable during an offline probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-recovery-wait-")); roots.push(root);
    const journal = new ManagedRecoveryJournal({ stateFile: join(root, "recovery.json") });
    await journal.load();
    const ref = sessionRef("offline-recovery");
    await journal.prepare({ provider: "codex", session: ref, cwd: root, remotePlacement: {
      executionDevice: "compute", workspaceId: "ws_0123456789abcdef01234567",
    } });
    await journal.activate("codex", ref, "before-restart");
    const probe = deferred<never>();
    const request = vi.fn(() => probe.promise);
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 2000, recoveryJournal: journal,
      recoveryScopes: { request }, openRecoveryRemote: vi.fn(),
    });
    const activity = vi.fn();
    plane.onManagedTranscriptActivity(activity);
    const first = plane.recoverInterrupted();
    const twin = plane.recoverInterrupted();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    probe.reject(new ManagedDependencyUnavailable("gateway closed"));
    expect(await first).toEqual({ recovered: 0, unknown: 0 });
    await twin;
    expect(journal.snapshot()[0]).toMatchObject({ status: "recovering", recoveryPhase: "waiting_resource" });
    await expect(plane.publicRuntime("codex", ref.logicalId)).resolves.toMatchObject({
      recovery: { state: "reconnecting" }, turn_state: "unknown", capabilities: { interrupt: true, protocol_append: false },
    });
    await plane.recoverInterrupted();
    expect(request).toHaveBeenCalledTimes(1);
    activity.mockClear();
    expect(await plane.interruptSession("codex", ref.logicalId)).toMatchObject({ control_action: "interrupt_recovery" });
    expect(activity).toHaveBeenCalledWith("codex", ref.logicalId);
    const stoppedRuntime = await plane.publicRuntime("codex", ref.logicalId);
    expect(stoppedRuntime).toMatchObject({ turn_state: "idle", event: "ManagedIdle",
      capabilities: { interrupt: false, managed_resume: true } });
    expect(stoppedRuntime?.recovery).toBeUndefined();
    expect(journal.snapshot()[0]?.recoveryPhase).toBeUndefined();
    await plane.recoverInterrupted(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(plane.hasPendingRecovery()).toBe(false);
    await plane.close();
  });

  it("retains a runtime wake arriving while an offline scope probe is in flight", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-recovery-wake-")); roots.push(root);
    const journal = new ManagedRecoveryJournal({ stateFile: join(root, "recovery.json") }); await journal.load();
    const ref = sessionRef("wake-race");
    await journal.prepare({ provider: "codex", session: ref, cwd: root, remotePlacement: {
      executionDevice: "compute", workspaceId: "ws_0123456789abcdef01234567",
    } });
    await journal.activate("codex", ref, "original-turn");
    const held = deferred<never>();
    const request = vi.fn().mockImplementationOnce(() => held.promise)
      .mockRejectedValue(new ManagedDependencyUnavailable("still offline"));
    const remote = vi.fn();
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 2000, recoveryJournal: journal,
      recoveryScopes: { request }, openRecoveryRemote: remote });
    const first = plane.recoverInterrupted();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const wake = plane.recoverInterrupted(true);
    held.reject(new ManagedDependencyUnavailable("stale offline answer"));
    await Promise.all([first, wake]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(remote).not.toHaveBeenCalled();
    expect(journal.snapshot()[0]).toMatchObject({ status: "recovering", recoveryPhase: "waiting_resource", recoveryCount: 1 });
    await plane.close({ preserveRecoveries: true });
  });

  it("cancels an in-flight recovery scope lookup before it opens another provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-recovery-cancel-probe-")); roots.push(root);
    const journal = new ManagedRecoveryJournal({ stateFile: join(root, "recovery.json") });
    await journal.load();
    const ref = sessionRef("cancel-probe");
    await journal.prepare({ provider: "codex", session: ref, cwd: root, remotePlacement: {
      executionDevice: "compute", workspaceId: "ws_0123456789abcdef01234567",
    } });
    await journal.activate("codex", ref, "original-turn");
    const held = deferred<never>();
    const request = vi.fn(() => held.promise), remote = vi.fn();
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 2000, recoveryJournal: journal,
      recoveryScopes: { request }, openRecoveryRemote: remote });
    const recovering = plane.recoverInterrupted();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(await plane.interruptSession("codex", ref.logicalId)).toMatchObject({ control_action: "interrupt_recovery" });
    held.reject(new ManagedDependencyUnavailable("late offline result"));
    expect(await recovering).toEqual({ recovered: 0, unknown: 0 });
    expect(remote).not.toHaveBeenCalled();
    expect(plane.hasPendingRecovery()).toBe(false);
    await plane.close();
  });

  it("restarts from the current provider id while retaining the original rollout path", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-control-refork-"));
    roots.push(root);
    const stateFile = join(root, "managed-recovery.json");
    const before = new ManagedRecoveryJournal({ stateFile });
    await before.load();
    const original = sessionRef("thread-child", join(root, "thread-child.jsonl"));
    const firstRebound: ProviderSessionRef = {
      logicalId: "thread-child",
      currentProviderId: "thread-rebound-1",
      rolloutPath: original.rolloutPath,
      lineage: ["thread-child", "thread-rebound-1"],
    };
    const recoveryPlacement = {
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
      developmentId: "development_ticket_578",
    };
    await before.prepare({
      provider: "codex",
      session: original,
      cwd: root,
      remotePlacement: recoveryPlacement,
    });
    await before.renameSession("codex", "thread-child", firstRebound);
    await before.activate("codex", firstRebound, "turn-before-restart");

    const journal = new ManagedRecoveryJournal({ stateFile });
    await journal.load();
    const completion = deferred<{ started: true; ok: boolean; status: string }>();
    const controller = fakeCodexController({ sessionId: "thread-rebound-1", completion: completion.promise });
    const resume = vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(controller);
    const requestScope = vi.fn(async () => ({
      token: "mcp_fresh",
      endpoint: "http://127.0.0.1:9820/api/mcp",
      expiresAt: Date.now() + 60_000,
      operationId: "op_recovery",
      executionDevice: recoveryPlacement.executionDevice,
      workspaceId: recoveryPlacement.workspaceId,
      development: {
        developmentId: recoveryPlacement.developmentId, token: "mcp_development_fresh",
        endpoint: "http://127.0.0.1:9820/api/mcp", expiresAt: Date.now() + 60_000,
      },
    }));
    const remoteClose = vi.fn(async () => {});
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      recoveryJournal: journal,
      recoveryScopes: { request: requestScope },
      openRecoveryRemote: async () => ({
        remoteMcpUrl: "http://127.0.0.1:39001/mcp",
        developmentMcpUrl: "http://127.0.0.1:39003/devpipe",
        close: remoteClose,
      }),
      timeoutMs: 5_000,
    });

    await expect(plane.recoverInterrupted()).resolves.toEqual({ recovered: 1, unknown: 0 });
    expect(requestScope).toHaveBeenCalledWith("codex", "thread-child");
    expect(resume).toHaveBeenCalledWith("thread-rebound-1", expect.objectContaining({
      config: expect.objectContaining({ mcp_servers: {
        octopus_execution: { url: "http://127.0.0.1:39001/mcp" },
        octopus_devpipe: { url: "http://127.0.0.1:39003/devpipe" },
      } }),
    }));
    expect(resume).toHaveBeenCalledWith("thread-rebound-1", expect.not.objectContaining({
      forkClosedSubagentPath: expect.anything(),
    }));
    expect(journal.snapshot()).toMatchObject([{
      status: "active",
      remotePlacement: recoveryPlacement,
      session: {
        logicalId: "thread-child",
        currentProviderId: "thread-rebound-1",
        rolloutPath: join(root, "thread-child.jsonl"),
        lineage: ["thread-child", "thread-rebound-1"],
      },
    }]);
    await expect(plane.publicRuntime("codex", "thread-child")).resolves.toMatchObject({
      turn_state: "working",
      capabilities: { interrupt: true },
    });
    completion.resolve({ started: true, ok: true, status: "completed" });
    await vi.waitFor(() => expect(controller.close).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(remoteClose).toHaveBeenCalledOnce());
  });

  it("inherits an active Codex attachment profile even when the request carries a different fallback", async () => {
    const dispatch = vi.fn(async () => ({
      kind: "steered" as const,
      turnId: "turn-1",
      completion: Promise.resolve({ started: true, ok: true }),
    }));
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
    });
    seedManagedAttachment(plane, "codex", "thread-profile", {
      cwd: "/tmp",
      transport: "app-server",
      turnId: "turn-1",
      startedAt: new Date().toISOString(),
      permissionProfile: "manual",
      controller: { turnActive: true, dispatch, close: async () => {} },
      completion: Promise.resolve({ ok: true }),
      leaseHolder: "protocol",
    });

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-profile",
      prompt: "试图改当前轮次模型",
      cwd: "/tmp",
      takeover: false,
      model: "gpt-5.6-terra",
    })).rejects.toThrow(/当前托管轮次已经开始/);
    expect(dispatch).not.toHaveBeenCalled();

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-profile",
      prompt: "试图改当前轮次",
      cwd: "/tmp",
      takeover: false,
      effort: "xhigh",
    })).rejects.toThrow(/当前托管轮次已经开始/);
    expect(dispatch).not.toHaveBeenCalled();

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-profile",
      prompt: "继承并 steer",
      cwd: "/tmp",
      takeover: false,
    })).resolves.toMatchObject({ control_action: "steer" });
    expect(dispatch).toHaveBeenCalledTimes(1);

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-profile",
      prompt: "试图切换",
      cwd: "/tmp",
      takeover: false,
      permissionProfile: "full_access",
    })).resolves.toMatchObject({ control_action: "steer" });
    expect(dispatch).toHaveBeenCalledTimes(2);
    await plane.close();
  });

  it("steers an active managed Claude turn with translated English", async () => {
    const translations = fakeClaudeTranslations("Continue with the active turn.");
    const dispatch = vi.fn(async () => ({
      kind: "steered" as const,
      turnId: "turn-claude",
      completion: Promise.resolve({ started: true, ok: true }),
    }));
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      claudeTranslations: translations.port,
    });
    // Test-only access seeds the already-attached controller branch.
    seedManagedAttachment(plane, "claude", "session-managed", {
      cwd: "/tmp",
      transport: "agent-sdk",
      turnId: "turn-claude",
      startedAt: new Date().toISOString(),
      controller: { turnActive: true, dispatch, close: async () => {} },
      completion: Promise.resolve({ ok: true }),
      leaseHolder: "protocol",
    });

    await expect(plane.continueSession({
      provider: "claude",
      sessionId: "session-managed",
      prompt: "继续当前任务。",
      cwd: "/tmp",
      takeover: false,
    })).resolves.toMatchObject({ control_action: "steer" });
    expect(dispatch).toHaveBeenCalledWith("Continue with the active turn.");
    expect(translations.recordUser).toHaveBeenCalledWith(
      "session-managed",
      expect.objectContaining({ en: "Continue with the active turn." }),
    );
    await plane.close();
  });

  it("leaves the plain Claude lane untranslated and never reaches the translator", async () => {
    // The lane people fall back to when this system misbehaves. A translator
    // that is present, slow or broken must not be able to touch it.
    const translations = fakeClaudeTranslations("Continue with the active turn.", false);
    const dispatch = vi.fn(async () => ({
      kind: "steered" as const,
      turnId: "turn-claude",
      completion: Promise.resolve({ started: true, ok: true }),
    }));
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      claudeTranslations: translations.port,
    });
    seedManagedAttachment(plane, "claude", "session-plain", {
      cwd: "/tmp",
      transport: "agent-sdk",
      turnId: "turn-claude",
      startedAt: new Date().toISOString(),
      controller: { turnActive: true, dispatch, close: async () => {} },
      completion: Promise.resolve({ ok: true }),
      leaseHolder: "protocol",
    });

    await expect(plane.continueSession({
      provider: "claude",
      sessionId: "session-plain",
      prompt: "继续当前任务。",
      cwd: "/tmp",
      takeover: false,
    })).resolves.toMatchObject({ control_action: "steer" });
    expect(dispatch).toHaveBeenCalledWith("继续当前任务。");
    expect(translations.translateUser).not.toHaveBeenCalled();
    expect(translations.recordUser).not.toHaveBeenCalled();
    await plane.close();
  });

  it("forces the bilingual lane for a turn that asks for it", async () => {
    const translations = fakeClaudeTranslations("Continue with the active turn.", false);
    const dispatch = vi.fn(async () => ({
      kind: "steered" as const,
      turnId: "turn-claude",
      completion: Promise.resolve({ started: true, ok: true }),
    }));
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      timeoutMs: 5_000,
      claudeTranslations: translations.port,
    });
    seedManagedAttachment(plane, "claude", "session-forced", {
      cwd: "/tmp",
      transport: "agent-sdk",
      turnId: "turn-claude",
      startedAt: new Date().toISOString(),
      controller: { turnActive: true, dispatch, close: async () => {} },
      completion: Promise.resolve({ ok: true }),
      leaseHolder: "protocol",
    });

    await plane.continueSession({
      provider: "claude",
      sessionId: "session-forced",
      prompt: "继续当前任务。",
      cwd: "/tmp",
      takeover: false,
      translatePrompt: true,
    });
    expect(dispatch).toHaveBeenCalledWith("Continue with the active turn.");
    await plane.close();
  });

  it("keeps terminal ownership and appends through one exact tmux pane", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-control-plane-"));
    roots.push(root);
    mkdirSync(join(root, "proj"));
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);

    const calls: Array<{ args: string[]; input?: string }> = [];
    let captures = 0;
    const terminal = new TerminalControl({
      readlink: async () => "/dev/pts/8",
      run: withEmptyComposer(async (_bin, args, input) => {
        calls.push({ args, ...(input !== undefined ? { input } : {}) });
        return {
          stdout: args[0] === "list-panes"
            ? "%4\t/dev/pts/8\t0\t0\n"
            : args[0] === "capture-pane" ? (captures++ === 0 ? "prompt" : "working") : "",
        };
      }),
      wait: async () => {},
    });
    const translations = fakeClaudeTranslations("Continue, but do not take over.");
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal,
      timeoutMs: 5_000,
      claudeTranslations: translations.port,
    });

    await expect(plane.continueSession({
      provider: "claude",
      sessionId: "session-a",
      prompt: "尝试改变模型和 effort",
      cwd: join(root, "proj"),
      takeover: false,
      model: "opus",
      effort: "max",
    })).rejects.toThrow(/tmux \/ 外部 CLI 不支持/);

    await expect(plane.continueSession({
      provider: "claude",
      sessionId: "session-a",
      prompt: "继续做，但不要接管",
      cwd: join(root, "proj"),
      takeover: false,
    })).resolves.toMatchObject({ transport: "tmux", control_action: "terminal_queue" });
    expect(processes.signals).toEqual([]);
    expect(calls.some(({ args }) => args[0] === "paste-buffer" && args.includes("%4"))).toBe(true);
    expect(calls.find(({ args }) => args[0] === "load-buffer")?.input)
      .toBe("Continue, but do not take over.");
    expect(translations.recordUser).toHaveBeenCalledWith(
      "session-a",
      expect.objectContaining({ en: "Continue, but do not take over." }),
    );
    await expect(plane.publicRuntime("claude", "session-a")).resolves.toMatchObject({
      attachment: { kind: "terminal_tmux" },
      control_lease: { holder: "terminal" },
      capabilities: { terminal_append: true, takeover: true },
    });
  });

  it("applies selected model and effort after an explicit external CLI takeover", async () => {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "codex"]));
    processes.rows.set(10, proc(10, 1, ["codex"]));
    processes.signal = (pid, signal): void => {
      processes.signals.push({ pid, signal });
      processes.rows.delete(pid);
    };
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("codex", { session_id: "thread-dedicated", hook_event_name: "Stop" }, 30);
    const controller = fakeCodexController();
    const resume = vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(controller);
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      timeoutMs: 5_000,
    });

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-dedicated",
      prompt: "结束外部 CLI 后用新模型和 effort 继续",
      cwd: "/tmp",
      takeover: true,
      model: "gpt-5.6-terra",
      effort: "xhigh",
    })).resolves.toMatchObject({
      ok: true,
      control_action: "takeover",
      transport: "app-server",
    });
    expect(processes.signals).toEqual([{ pid: 10, signal: "SIGINT" }]);
    expect(resume).toHaveBeenCalledWith("thread-dedicated", expect.objectContaining({
      model: "gpt-5.6-terra",
      effort: "xhigh",
    }));
    await plane.close();
  });

  it("does not associate a failed terminal injection with a later Claude Stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-control-plane-failed-translation-"));
    roots.push(root);
    const cwd = join(root, "proj");
    const transcriptDir = join(root, ".claude", "projects", "proj");
    mkdirSync(cwd);
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, "session.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-21T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Unrelated answer." }] },
    }));

    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-failed", hook_event_name: "UserPromptSubmit" }, 30);
    const requests: Array<{ direction: string; text: string }> = [];
    const translations = new ClaudeTranslationService(root, {
      run: async (request) => {
        requests.push({ direction: request.direction, text: request.text });
        return request.direction === "zh-en" ? "Rejected prompt." : "不相关回答。";
      },
    });
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: withEmptyComposer(async (_bin, args) => {
          if (args[0] === "list-panes") return { stdout: "%4\t/dev/pts/8\t0\t0\n" };
          if (args[0] === "load-buffer") throw new Error("tmux rejected buffer");
          return { stdout: "" };
        }),
        wait: async () => {},
      }),
      timeoutMs: 5_000,
      claudeTranslations: translations,
    });

    await expect(plane.continueSession({
      provider: "claude",
      sessionId: "session-failed",
      prompt: "这条不能提交。",
      cwd,
      takeover: false,
      translatePrompt: true,
    })).rejects.toThrow("tmux rejected buffer");
    await translations.observeClaudeHook({
      hook_event_name: "Stop",
      session_id: "session-failed",
      transcript_path: transcriptPath,
      cwd,
    });
    expect(requests).toEqual([{ direction: "zh-en", text: "这条不能提交。" }]);
    await plane.close();
  });

  it("offers explicit Codex takeover until a later projection proves a writable tmux pane", async () => {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "codex"]));
    processes.rows.set(10, proc(10, 1, ["codex"]));
    const observedMs = Date.parse("2026-08-27T12:00:00.000Z");
    const runtime = new AgentRuntimeRegistry({
      processReader: processes,
      now: () => new Date(observedMs),
    });
    await runtime.recordHook("codex", { session_id: "thread-idle", hook_event_name: "Stop" }, 30);

    let paneLists = 0;
    let wallMs = observedMs;
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wallMs);
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async (_bin, args) => {
          return {
            stdout: args[0] === "list-panes"
              ? paneLists++ === 0 ? "" : "%4\t/dev/pts/8\t0\t0\n"
              : "",
          };
        },
        wait: async () => {},
      }),
      timeoutMs: 5_000,
    });

    try {
      // A standalone Codex process with no proven pane must never invite a
      // speculative key injection. Its only web write route is explicit
      // background takeover through app-server.
      await expect(plane.publicRuntime("codex", "thread-idle")).resolves.toMatchObject({
        attachment: { kind: "hook_observer" },
        control_lease: { holder: "terminal" },
        capabilities: { terminal_append: false, takeover: true },
      });

      // The same process is moved into tmux. Once the short read cache expires,
      // a fresh projection replaces takeover with the ordinary tmux send route
      // without requiring a restart or changing session identity.
      wallMs += 2_001;
      await expect(plane.publicRuntime("codex", "thread-idle")).resolves.toMatchObject({
        attachment: { kind: "terminal_tmux", transport: "tmux" },
        control_lease: { holder: "terminal" },
        capabilities: { terminal_append: true, takeover: true },
      });
      expect(paneLists).toBe(2);
      expect(processes.signals).toEqual([]);
    } finally {
      wallClock.mockRestore();
    }
  });

  it("runs an ordinary Codex resume on one dedicated app-server and closes it at completion", async () => {
    const runtime = new AgentRuntimeRegistry({ processReader: new Processes() });
    const controller = fakeCodexController({
      completion: Promise.resolve({
        started: true,
        ok: true,
        status: "completed",
        usage: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 9 },
      }),
    });
    const resume = vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(controller);
    const codexHost = {
      ensure: vi.fn(async () => "ws://127.0.0.1:43123"),
      currentEndpoint: null,
      endpoint: "ws://127.0.0.1:43123",
      close: vi.fn(async () => {}),
    } as unknown as CodexAppServerHost;
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      codexHost,
      timeoutMs: 5_000,
    });
    const completions: import("./gateway-protocol.js").RunnerManagedCompletion[] = [];
    plane.onManagedCompletion((event) => completions.push(event));

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-dedicated",
      prompt: "后台继续",
      cwd: "/tmp",
      takeover: false,
      permissionProfile: "full_access",
    })).resolves.toMatchObject({ ok: true, transport: "app-server", control_action: "managed_resume" });

    await vi.waitFor(() => expect(controller.close).toHaveBeenCalledTimes(1));
    expect(completions).toEqual([
      expect.objectContaining({
        provider: "codex",
        logical_session_id: "thread-dedicated",
        session_id: "thread-dedicated",
        turn_id: "turn-dedicated",
        status: "succeeded",
        usage: { tokens_in: 20, tokens_out: 9, tokens_cached: 100 },
      }),
    ]);
    expect(codexHost.ensure).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[1].endpoint).toBeUndefined();
    await expect(plane.publicRuntime("codex", "thread-dedicated")).resolves.toBeUndefined();
  });

  it("cleans up a rejected managed completion without a detached rejection", async () => {
    const completion = deferred<{ started: true; ok: boolean; status: string }>();
    const controller = fakeCodexController({ completion: completion.promise });
    vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(controller);
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      timeoutMs: 5_000,
    });
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", recordUnhandled);
    try {
      const continuing = plane.continueSession({
        provider: "codex",
        sessionId: "thread-dedicated",
        prompt: "继续",
        cwd: "/tmp",
        takeover: false,
      });
      await vi.waitFor(() => expect(controller.dispatch).toHaveBeenCalledOnce());
      completion.reject(new Error("transport failed"));
      await expect(continuing).rejects.toThrow("transport failed");
      await vi.waitFor(() => expect(controller.close).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  it("routes app-server activity to the exact managed transcript without exposing provider content", async () => {
    const completion = deferred<{ started: true; ok: boolean; status: string }>();
    const controller = fakeCodexController({ completion: completion.promise });
    let onActivity: (() => void) | undefined;
    vi.spyOn(CodexManagedSession, "resume").mockImplementation(async (_sessionId, options) => {
      onActivity = options.onActivity;
      return controller;
    });
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      timeoutMs: 5_000,
    });
    const activity: Array<{ provider: string; sessionId: string }> = [];
    plane.onManagedTranscriptActivity((provider, sessionId) => activity.push({ provider, sessionId }));

    const continuing = plane.continueSession({
      provider: "codex",
      sessionId: "thread-dedicated",
      prompt: "继续",
      cwd: "/tmp",
      takeover: false,
    });
    await vi.waitFor(() => expect(onActivity).toBeTypeOf("function"));
    onActivity?.();
    expect(activity).toEqual([{ provider: "codex", sessionId: "thread-dedicated" }]);

    completion.resolve({ started: true, ok: true, status: "completed" });
    await expect(continuing).resolves.toMatchObject({ ok: true });
  });

  it("reports a failed managed turn without copying its result or error", async () => {
    const controller = fakeCodexController({
      completion: Promise.resolve({ started: true, ok: false, status: "failed", error: "private detail" }),
    });
    vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(controller);
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      timeoutMs: 5_000,
    });
    const completions: import("./gateway-protocol.js").RunnerManagedCompletion[] = [];
    plane.onManagedCompletion((event) => completions.push(event));

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-dedicated",
      prompt: "继续",
      cwd: "/tmp",
      takeover: false,
    })).resolves.toMatchObject({ ok: false });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ status: "failed", session_id: "thread-dedicated" });
    expect(JSON.stringify(completions[0])).not.toContain("private detail");
  });

  it("retains only a failed settled dedicated Codex close as a manual release target", async () => {
    const close = vi.fn()
      .mockRejectedValueOnce(new Error("child still alive"))
      .mockResolvedValueOnce(undefined);
    const controller = fakeCodexController({ close });
    vi.spyOn(CodexManagedSession, "resume").mockResolvedValue(controller);
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      timeoutMs: 5_000,
    });

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-dedicated",
      prompt: "完成后放锁",
      cwd: "/tmp",
      takeover: false,
    })).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    await expect(plane.publicRuntime("codex", "thread-dedicated")).resolves.toMatchObject({
      turn_state: "idle",
      event: "ProtocolReleaseRequired",
      capabilities: { release_control: true, interrupt: false, protocol_append: false },
    });
    await expect(plane.releaseSession("codex", "thread-dedicated")).resolves.toMatchObject({
      ok: true,
      released: true,
      control_action: "release_control",
    });
    expect(close).toHaveBeenCalledTimes(2);
    await expect(plane.publicRuntime("codex", "thread-dedicated")).resolves.toBeUndefined();
  });

  it("best-effort force-probes an idle discovered omp tmux pane before offering takeover", async () => {
    const processes = new Processes();
    const omp = proc(10, 1, ["omp"]);
    processes.rows.set(10, omp);
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.observeExternalCli({
      provider: "omp",
      sessionId: "omp-idle",
      identity: {
        pid: omp.pid,
        pgid: omp.pgid,
        tty: omp.tty,
        startTicks: omp.startTicks,
        bootId: omp.bootId,
        command: omp.command,
      },
      turnState: "idle",
      event: "OmpTerminalObserved",
      cwd: "/tmp",
    });

    let paneLists = 0;
    let captures = 0;
    const calls: string[][] = [];
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async (_bin, args) => {
          calls.push(args);
          return {
            stdout: args[0] === "list-panes"
              ? `%4\t/dev/pts/8\t0\t${paneLists++ < 2 ? "1" : "0"}\n`
              : args[0] === "capture-pane" ? (captures++ === 0 ? "idle omp" : "working omp") : "",
          };
        },
        wait: async () => {},
      }),
      timeoutMs: 5_000,
    });

    // Omp discovery proves the exact process/session binding. Copy/history
    // mode hides the live pane from the cheap read-only probe, but still
    // exposes one ordinary attempt without changing the terminal yet.
    await expect(plane.publicRuntime("omp", "omp-idle")).resolves.toMatchObject({
      attachment: { kind: "omp_terminal" },
      control_lease: { holder: "terminal" },
      capabilities: { terminal_append: true, takeover: true },
    });
    expect(calls.some((args) => args[0] === "copy-mode")).toBe(false);
    await expect(plane.continueSession({
      provider: "omp",
      sessionId: "omp-idle",
      prompt: "继续原来的 omp 会话",
      cwd: "/tmp",
      takeover: false,
      permissionProfile: "full_access",
    })).resolves.toMatchObject({
      ok: true,
      transport: "tmux",
      control_action: "terminal_send",
    });
    const copyMode = calls.findIndex((args) => args[0] === "copy-mode");
    const paste = calls.findIndex((args) => args[0] === "paste-buffer" && args.includes("%4"));
    expect(paneLists).toBe(3);
    expect(calls[copyMode]).toEqual(["copy-mode", "-q", "-t", "%4"]);
    expect(copyMode).toBeGreaterThan(-1);
    expect(paste).toBeGreaterThan(copyMode);
    expect(processes.signals).toEqual([]);
  });

  it("answers an identical terminal resend instead of stacking a second copy", async () => {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "codex"]));
    processes.rows.set(10, proc(10, 1, ["codex"]));
    // An explicit observation clock: two hooks in the same millisecond would
    // otherwise be indistinguishable evidence.
    let observedMs = Date.parse("2026-08-16T07:56:00.000Z");
    const runtime = new AgentRuntimeRegistry({
      processReader: processes,
      now: () => new Date(observedMs),
    });
    await runtime.recordHook("codex", { session_id: "thread-a", hook_event_name: "Stop" }, 30);

    let captures = 0;
    const pastes: string[] = [];
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async (_bin, args, input) => {
          if (args[0] === "load-buffer") pastes.push(String(input ?? ""));
          return {
            stdout: args[0] === "list-panes"
              ? "%4\t/dev/pts/8\t0\t0\n"
              // Every submit visibly changes the pane, which is all tmux can
              // ever prove — the TUI may still be holding the text unsent.
              : args[0] === "capture-pane" ? `pane-${captures++}` : "",
          };
        },
        wait: async () => {},
      }),
      timeoutMs: 5_000,
    });

    const send = async (prompt: string): Promise<Record<string, unknown>> => await plane.continueSession({
      provider: "codex",
      sessionId: "thread-a",
      prompt,
      cwd: "/tmp",
      takeover: false,
    });

    await expect(send("先把可以不用的 sub agent 都停下来")).resolves.toMatchObject({
      ok: false,
      code: "unknown",
      control_action: "terminal_send",
    });
    const refused = await send("先把可以不用的 sub agent 都停下来").catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe("duplicate_terminal_send");
    expect(String((refused as Error).message)).toContain("秒前已经送进");
    // A different instruction is a different intent and gets its own single
    // attempt, but a redraw still cannot manufacture a Codex receipt.
    await expect(send("换个思路")).resolves.toMatchObject({ ok: false, code: "unknown" });

    // Once a fresh Codex hook proves the CLI progressed, repeating the same
    // words is a new instruction again, not a lost one.
    observedMs += 1_000;
    await runtime.recordHook("codex", { session_id: "thread-a", hook_event_name: "UserPromptSubmit" }, 30);
    await expect(send("先把可以不用的 sub agent 都停下来")).resolves.toMatchObject({ ok: true });
    expect(pastes).toEqual([
      "先把可以不用的 sub agent 都停下来",
      "换个思路",
      "先把可以不用的 sub agent 都停下来",
    ]);
  });

  it("confirms a terminal submit when the exact Codex TUI rebounds to a new session", async () => {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "codex"]));
    processes.rows.set(10, proc(10, 1, ["codex"]));
    let observedMs = Date.parse("2026-08-29T12:15:18.000Z");
    const runtime = new AgentRuntimeRegistry({
      processReader: processes,
      now: () => new Date(observedMs),
    });
    await runtime.recordHook("codex", { session_id: "thread-old", hook_event_name: "Stop" }, 30);
    const terminalCalls: string[][] = [];

    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async (_bin, args) => {
          terminalCalls.push(args);
          if (args[0] === "send-keys" && args.includes("C-m")) {
            observedMs += 1_000;
            await runtime.recordHook("codex", {
              session_id: "thread-new",
              hook_event_name: "UserPromptSubmit",
            }, 30);
          }
          return {
            stdout: args[0] === "list-panes"
              ? "%4\t/dev/pts/8\t0\t0\n"
              : args[0] === "capture-pane" ? "codex pane" : "",
          };
        },
        wait: async () => {},
      }),
      timeoutMs: 5_000,
    });

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-old",
      prompt: "继续完成当前任务",
      cwd: "/tmp",
      takeover: false,
    })).resolves.toMatchObject({
      ok: true,
      session_id: "thread-old",
      new_session_id: "thread-new",
      transport: "tmux",
      control_action: "terminal_send",
    });
    expect(runtime.publicRuntime("codex", "thread-old")).toBeUndefined();
    expect(runtime.publicRuntime("codex", "thread-new")).toMatchObject({
      process_state: "alive",
      event: "UserPromptSubmit",
      capabilities: { takeover: true },
    });
    await expect(plane.publicRuntime("codex", "thread-old")).resolves.toMatchObject({
      process_state: "alive",
      event: "UserPromptSubmit",
      capabilities: { takeover: true },
    });
    await expect(plane.interruptSession("codex", "thread-old")).resolves.toMatchObject({
      session_id: "thread-old",
      new_session_id: "thread-new",
      control_action: "terminal_interrupt",
      confirmed: false,
    });
    expect(terminalCalls).toContainEqual(["send-keys", "-t", "%4", "Escape"]);
  });

  it("suppresses an unconfirmed terminal resend after Runner restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-control-terminal-dedup-"));
    roots.push(root);
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js"]));
    processes.rows.set(10, proc(10, 1, ["codex"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("codex", { session_id: "thread-a", hook_event_name: "Stop" }, 30);
    let pastes = 0;
    const terminal = new TerminalControl({
      readlink: async () => "/dev/pts/8",
      run: async (_bin, args) => {
        if (args[0] === "load-buffer") pastes += 1;
        return {
          stdout: args[0] === "list-panes" ? "%4\t/dev/pts/8\t0\t0\n" : args[0] === "capture-pane" ? "unchanged" : "",
        };
      },
      wait: async () => {},
    });
    const stateFile = join(root, "managed-recovery.json");
    const journal = new ManagedRecoveryJournal({ stateFile });
    await journal.load();
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal,
      recoveryJournal: journal,
      timeoutMs: 5_000,
    });

    // Indeterminate is exactly when a resend is most tempting and most likely
    // to duplicate: the first attempt may well have crossed the submit line.
    await expect(plane.continueSession({
      provider: "codex", sessionId: "thread-a", prompt: "继续", cwd: "/tmp", takeover: false,
    })).resolves.toMatchObject({ ok: false, code: "unknown" });
    const restartedJournal = new ManagedRecoveryJournal({ stateFile });
    await restartedJournal.load();
    const restarted = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal,
      recoveryJournal: restartedJournal,
      timeoutMs: 5_000,
    });
    await expect(restarted.continueSession({
      provider: "codex", sessionId: "thread-a", prompt: "继续", cwd: "/tmp", takeover: false,
    })).rejects.toMatchObject({ code: "duplicate_terminal_send" });
    expect(pastes).toBe(1);
  });

  it("discovers a Codex TUI that predates Runner before selecting app-server", async () => {
    const processes = new Processes();
    processes.rows.set(10, proc(10, 1, ["codex"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    const codexDiscovery = vi.fn(async (
      candidates: readonly { sessionId: string; sessionPath: string; cwd?: string }[],
      target: AgentRuntimeRegistry,
    ) => {
      expect(candidates).toEqual([{
        sessionId: "thread-pre-runner",
        sessionPath: "/tmp/thread-pre-runner.jsonl",
        cwd: "/tmp",
      }]);
      await target.observeExternalCli({
        provider: "codex",
        sessionId: candidates[0].sessionId,
        identity: {
          pid: 10,
          pgid: 10,
          tty: 8,
          startTicks: "100",
          bootId: "boot-a",
          command: "codex",
        },
        turnState: "idle",
        event: "CodexRolloutObserved",
        cwd: "/tmp",
        transcriptPath: candidates[0].sessionPath,
      });
    });
    const resume = vi.spyOn(CodexManagedSession, "resume");
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/null",
        run: async () => ({ stdout: "" }),
      }),
      codexDiscovery,
      timeoutMs: 5_000,
    });

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-pre-runner",
      sessionPath: "/tmp/thread-pre-runner.jsonl",
      prompt: "继续",
      cwd: "/tmp",
      takeover: false,
    })).rejects.toMatchObject({ code: "session_active" });
    expect(codexDiscovery).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    await expect(plane.publicRuntime("codex", "thread-pre-runner")).resolves.toMatchObject({
      attachment: { kind: "hook_observer" },
      capabilities: { takeover: true, managed_resume: false },
    });
  });

  it("preserves the exact old CLI when its registered replacement cannot run", async () => {
    // Executable ancestors must be trusted too: a container's user-owned
    // sticky /tmp is intentionally rejected even when its child is private.
    const root = mkdtempSync(join(homedir(), ".octopus-takeover-executable-"));
    roots.push(root);
    const executable = join(root, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const registry = new AgentExecutableRegistry({ home: root, directories: [], systemDirectories: [] });
    registry.bind("codex", { entry: executable });
    const runtime = new AgentRuntimeRegistry({ processReader: new Processes() });
    vi.spyOn(runtime, "inspect").mockResolvedValue({ exactProcessAlive: true, controlMode: "external_cli" } as never);
    const takeover = vi.spyOn(runtime, "takeover");
    const resume = vi.spyOn(CodexManagedSession, "resume");
    const plane = new AgentControlPlane({ runtime, interactions: new AgentInteractionBroker(), timeoutMs: 5_000 });
    await expect(usingAgentExecutables(registry, () => plane.continueSession({
      provider: "codex", sessionId: "old", prompt: "continue", cwd: root, takeover: true,
    }))).rejects.toThrow();
    expect(takeover).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("refuses an interrupt takeover without an exact Codex binding before re-sending", async () => {
    const codexDiscovery = vi.fn(async () => []);
    const resume = vi.spyOn(CodexManagedSession, "resume");
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      codexDiscovery,
      timeoutMs: 5_000,
    });

    const refused = await plane.continueSession({
      provider: "codex",
      sessionId: "thread-unknown",
      sessionPath: "/tmp/thread-unknown.jsonl",
      prompt: "再试一次",
      cwd: "/tmp",
      takeover: true,
    }).catch((error: unknown) => error);
    expect(codexDiscovery).toHaveBeenCalledTimes(1);
    expect((refused as { code?: string }).code).toBe("session_not_interruptible");
    expect(String((refused as Error).message)).toContain("本次没有重发");
    expect(resume).not.toHaveBeenCalled();
  });

  it("refuses to write beside a detached Octopus launch and takes it over on request", async () => {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({
      processReader: processes,
      interruptGraceMs: 2,
      terminateGraceMs: 2,
      quiescenceMs: 0,
      wait: async () => {},
    });
    await runtime.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    await runtime.markHeadless("claude", "session-a");
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({ readlink: async () => "/dev/null", run: async () => ({ stdout: "" }) }),
      timeoutMs: 5_000,
    });

    // Before: every capability was false here, so the composer had no route at
    // all. The takeover route is the one honest thing Octopus can offer.
    await expect(plane.publicRuntime("claude", "session-a")).resolves.toMatchObject({
      attachment: { kind: "legacy_exec", state: "attached" },
      capabilities: { takeover: true, terminal_append: false, managed_resume: false, protocol_append: false },
    });
    const refused = await plane.continueSession({
      provider: "claude", sessionId: "session-a", prompt: "再看一眼", cwd: "/tmp", takeover: false,
    }).catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe("session_active");
    expect(String((refused as Error).message)).toContain("后台启动");
    expect(processes.signals).toEqual([]);

    // With takeover the detached CLI must be stopped BEFORE any managed resume
    // opens. This fake process ignores both signals, so the existing "refuse
    // rather than escalate" rule ends the attempt — and proves the route ran.
    await expect(plane.continueSession({
      provider: "claude", sessionId: "session-a", prompt: "再看一眼", cwd: "/tmp", takeover: true,
    })).rejects.toThrow(/没有在 SIGINT\/SIGTERM 后退出/);
    expect(processes.signals).toEqual([
      { pid: 10, signal: "SIGINT" },
      { pid: 10, signal: "SIGTERM" },
    ]);
  });

  it("refuses key injection while the CLI is answering a provider prompt", async () => {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-a", hook_event_name: "PermissionRequest" }, 30);
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async () => ({ stdout: "%4\t/dev/pts/8\t0\t0\n" }),
      }),
      timeoutMs: 5_000,
    });
    await expect(plane.continueSession({
      provider: "claude",
      sessionId: "session-a",
      prompt: "不要把它当成选项输入",
      cwd: "/tmp",
      takeover: false,
    })).rejects.toThrow(/等待问题或权限/);
  });

  it("returns an unknown result when tmux does not visibly accept the prompt", async () => {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js"]));
    processes.rows.set(10, proc(10, 1, ["codex"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("codex", { session_id: "thread-a", hook_event_name: "Stop" }, 30);
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async (_bin, args) => ({
          stdout: args[0] === "list-panes" ? "%4\t/dev/pts/8\t0\t0\n" : args[0] === "capture-pane" ? "unchanged" : "",
        }),
        wait: async () => {},
      }),
      timeoutMs: 5_000,
    });

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-a",
      prompt: "继续",
      cwd: "/tmp",
      takeover: false,
    })).resolves.toMatchObject({
      ok: false,
      code: "unknown",
      transport: "tmux",
      error: expect.stringContaining("本机 CLI"),
    });
  });

  it("projects an opt-in Codex remote TUI as terminal-owned native protocol", async () => {
    const endpoint = "ws://127.0.0.1:43123";
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js"]));
    processes.rows.set(10, proc(10, 1, ["codex", "--remote", endpoint]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("codex", { session_id: "thread-a", hook_event_name: "UserPromptSubmit" }, 30);
    const codexHost = { currentEndpoint: endpoint } as unknown as CodexAppServerHost;
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async () => ({ stdout: "%4\t/dev/pts/8\t0\t0\n" }),
      }),
      codexHost,
      timeoutMs: 5_000,
    });

    await expect(plane.publicRuntime("codex", "thread-a")).resolves.toMatchObject({
      attachment: { kind: "codex_app_server", transport: "app-server" },
      control_lease: { holder: "terminal" },
      capabilities: { protocol_append: true, terminal_append: true, takeover: true },
    });
  });

  it("recovers a cooperative Codex steer after restart and emits its completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-control-cooperative-recovery-"));
    roots.push(root);
    const endpoint = "ws://127.0.0.1:43123";
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "codex"]));
    processes.rows.set(10, proc(10, 1, ["codex", "--remote", endpoint]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("codex", { session_id: "thread-a", hook_event_name: "Stop" }, 30);
    const stateFile = join(root, "managed-recovery.json");
    const journal = new ManagedRecoveryJournal({ stateFile });
    await journal.load();
    const firstCompletion = deferred<{ started: true; ok: boolean; status: string }>();
    const recoveredCompletion = deferred<{ started: true; ok: boolean; status: string }>();
    const first = fakeCodexController({
      sessionId: "thread-a",
      dispatchKind: "steered",
      completion: firstCompletion.promise,
    });
    const recovered = fakeCodexController({
      sessionId: "thread-a",
      completion: recoveredCompletion.promise,
    });
    const resume = vi.spyOn(CodexManagedSession, "resume")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(recovered);
    const codexHost = {
      ensure: vi.fn(async () => endpoint),
      currentEndpoint: endpoint,
      endpoint,
      close: vi.fn(async () => {}),
    } as unknown as CodexAppServerHost;
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      codexHost,
      recoveryJournal: journal,
      timeoutMs: 5_000,
    });

    await expect(plane.continueSession({
      provider: "codex",
      sessionId: "thread-a",
      prompt: "append cooperatively",
      cwd: root,
      takeover: false,
    })).resolves.toMatchObject({
      control_action: "protocol_steer",
      turn_id: "turn-dedicated",
    });
    expect(resume.mock.calls[0]).toEqual([
      "thread-a",
      expect.objectContaining({ endpoint, preserveThreadPolicy: true }),
    ]);
    expect(journal.snapshot()).toMatchObject([{ status: "active", turnId: "turn-dedicated" }]);
    expect(runtime.publicRuntime("codex", "thread-a")).toMatchObject({
      control_mode: "octopus_headless",
    });

    await plane.close({ preserveRecoveries: true });
    const restartedJournal = new ManagedRecoveryJournal({ stateFile });
    await restartedJournal.load();
    const restarted = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl(),
      codexHost,
      recoveryJournal: restartedJournal,
      timeoutMs: 5_000,
    });
    const events: import("./gateway-protocol.js").RunnerManagedCompletion[] = [];
    restarted.onManagedCompletion((event) => events.push(event));

    await expect(restarted.recoverInterrupted()).resolves.toEqual({ recovered: 1, unknown: 0 });
    expect(resume).toHaveBeenCalledTimes(2);
    expect(recovered.dispatch).toHaveBeenCalledWith(RUNNER_RECOVERY_PROMPT);
    recoveredCompletion.resolve({ started: true, ok: true, status: "completed" });
    await vi.waitFor(() => expect(events).toEqual([
      expect.objectContaining({
        provider: "codex",
        session_id: "thread-a",
        turn_id: "turn-dedicated",
        status: "succeeded",
      }),
    ]));
    await vi.waitFor(() => expect(restartedJournal.snapshot()).toEqual([]));
  });

  it("retires a completed attachment before routing a fresh prompt", async () => {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-a", hook_event_name: "Stop" }, 30);
    const calls: string[][] = [];
    let captures = 0;
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: withEmptyComposer(async (_bin, args) => {
          calls.push(args);
          return {
            stdout: args[0] === "list-panes"
              ? "%4\t/dev/pts/8\t0\t0\n"
              : args[0] === "capture-pane" ? (captures++ === 0 ? "prompt" : "working") : "",
          };
        }),
        wait: async () => {},
      }),
      timeoutMs: 5_000,
    });
    let closed = 0;
    seedManagedAttachment(plane, "claude", "session-a", {
      cwd: "/tmp",
      transport: "agent-sdk",
      turnId: "old-turn",
      startedAt: new Date().toISOString(),
      controller: { turnActive: false, close: async () => { closed += 1; } },
      completion: Promise.resolve({ ok: true }),
      leaseHolder: "protocol",
    });
    await expect(plane.continueSession({
      provider: "claude",
      sessionId: "session-a",
      prompt: "fresh prompt",
      cwd: "/tmp",
      takeover: false,
    })).resolves.toMatchObject({ transport: "tmux" });
    expect(closed).toBe(1);
    expect(calls.some((args) => args[0] === "paste-buffer")).toBe(true);
  });
});

/**
 * Ticket #184. A person watching their own CLI work needs a stop button that
 * stops the TURN. Everything below exists to keep it from becoming a stop
 * button that ends the program: the pane must be proven, the CLI must be
 * working, and the only thing ever sent is one Escape.
 */
describe("AgentControlPlane external CLI interrupt", () => {
  function terminalPlane(calls: string[][], panes = "%4\t/dev/pts/8\t0\t0\n") {
    let captures = 0;
    return {
      processes: new Processes(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async (_bin, args) => {
          calls.push(args);
          return {
            stdout: args[0] === "list-panes"
              ? panes
              : args[0] === "capture-pane" ? (captures++ === 0 ? "working…" : "stopped") : "",
          };
        },
        wait: async () => {},
      }),
    };
  }

  it("sends exactly one Escape to a working CLI's own pane and signals nothing", async () => {
    const calls: string[][] = [];
    const { processes, terminal } = terminalPlane(calls);
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal,
      timeoutMs: 5_000,
    });

    await expect(plane.interruptSession("claude", "session-a")).resolves.toMatchObject({
      ok: true,
      transport: "tmux",
      control_action: "terminal_interrupt",
      confirmed: true,
      session_id: "session-a",
      new_session_id: "session-a",
    });
    expect(calls.filter((args) => args[0] === "send-keys")).toEqual([
      ["send-keys", "-t", "%4", "Escape"],
    ]);
    // The pane, the process and the session all survive a stop. Claude Code
    // fires no hook for an interrupted turn, so the confirmed stop ends it.
    expect(processes.signals).toEqual([]);
    await expect(plane.publicRuntime("claude", "session-a")).resolves.toMatchObject({
      process_state: "alive",
      turn_state: "idle",
      attachment: { kind: "terminal_tmux" },
      capabilities: { interrupt: false, terminal_interrupt: false, terminal_append: true },
    });
  });

  it("refuses to press Escape at an idle CLI, where it would clear an unsent draft", async () => {
    const calls: string[][] = [];
    const { processes, terminal } = terminalPlane(calls);
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-a", hook_event_name: "Stop" }, 30);
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal,
      timeoutMs: 5_000,
    });

    await expect(plane.interruptSession("claude", "session-a"))
      .rejects.toMatchObject({ code: "session_not_working" });
    expect(calls.filter((args) => args[0] === "send-keys")).toEqual([]);
    // An idle CLI may still be APPENDED to; only stopping is withheld.
    await expect(plane.publicRuntime("claude", "session-a")).resolves.toMatchObject({
      capabilities: { interrupt: false, terminal_interrupt: false, terminal_append: true },
    });
  });

  it("refuses when no single pane is proven, instead of signalling the process", async () => {
    const calls: string[][] = [];
    const { processes, terminal } = terminalPlane(calls, "%4\t/dev/pts/8\t0\t0\n%9\t/dev/pts/8\t0\t0\n");
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal,
      timeoutMs: 5_000,
    });

    await expect(plane.interruptSession("claude", "session-a"))
      .rejects.toMatchObject({ code: "session_not_interruptible" });
    expect(calls.filter((args) => args[0] === "send-keys")).toEqual([]);
    expect(processes.signals).toEqual([]);
    await expect(plane.publicRuntime("claude", "session-a")).resolves.toMatchObject({
      capabilities: { interrupt: false, terminal_interrupt: false },
    });
  });

  it("stops a detached Octopus launch with signals it already refuses to escalate", async () => {
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({
      processReader: processes,
      interruptGraceMs: 2,
      terminateGraceMs: 2,
      quiescenceMs: 0,
      wait: async () => {},
    });
    await runtime.recordHook("claude", { session_id: "session-a", hook_event_name: "UserPromptSubmit" }, 30);
    await runtime.markHeadless("claude", "session-a");
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({ readlink: async () => "/dev/null", run: async () => ({ stdout: "" }) }),
      timeoutMs: 5_000,
    });

    // A background launch has no TUI and no draft, so it offers a stop without
    // needing a prompt — which is what made this shape reachable only through
    // takeover before.
    await expect(plane.publicRuntime("claude", "session-a")).resolves.toMatchObject({
      attachment: { kind: "legacy_exec" },
      capabilities: { interrupt: true, terminal_interrupt: false },
    });

    // The fake process ignores both signals, so the registry's "refuse rather
    // than escalate to SIGKILL" rule ends the attempt — and proves which
    // signals a stop is allowed to use.
    await expect(plane.interruptSession("claude", "session-a"))
      .rejects.toThrow(/没有在 SIGINT\/SIGTERM 后退出/);
    expect(processes.signals).toEqual([
      { pid: 10, signal: "SIGINT" },
      { pid: 10, signal: "SIGTERM" },
    ]);
    expect(processes.signals.some((sent) => sent.signal === "SIGKILL")).toBe(false);
  });

  it("keeps refusing a session nothing is observing", async () => {
    const plane = new AgentControlPlane({
      runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({ readlink: async () => "/dev/pts/8", run: async () => ({ stdout: "" }) }),
      timeoutMs: 5_000,
    });
    await expect(plane.interruptSession("claude", "session-gone"))
      .rejects.toMatchObject({ code: "session_not_managed" });
  });
});


it("serializes two distinct cold prompts until admission and then steers the same session before completion", async () => {
  const setup = deferred<void>();
  const completed = deferred<{ started: true; ok: boolean; status: string }>();
  const runtime = new AgentRuntimeRegistry({ processReader: new Processes() });
  const plane = new AgentControlPlane({ runtime, interactions: new AgentInteractionBroker(), timeoutMs: 5_000 });
  const controller = fakeCodexController({ sessionId: "original-cold-session", completion: completed.promise });
  const prompts: string[] = [];
  vi.mocked(controller.dispatch).mockImplementation(async (prompt) => {
    const kind = prompts.length ? "steered" as const : "started" as const;
    prompts.push(prompt);
    (controller as unknown as { active: unknown }).active = { turnId: "one-turn", completion: completed.promise };
    return { kind, turnId: "one-turn", completion: completed.promise };
  });
  const resume = vi.spyOn(CodexManagedSession, "resume").mockImplementation(async () => { await setup.promise; return controller; });
  const inputs: unknown[] = [];
  const base = { provider: "codex" as const, sessionId: "original-cold-session", cwd: "/tmp", takeover: false,
    onInput: async (receipt: unknown) => { inputs.push(receipt); } };
  let firstFinished = false;
  const first = plane.continueSession({ ...base, prompt: "first distinct prompt" }).then((result) => { firstFinished = true; return result; });
  const second = plane.continueSession({ ...base, prompt: "second distinct prompt" });
  await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
  setup.resolve();
  await expect(second).resolves.toMatchObject({ control_action: "steer", new_session_id: "original-cold-session" });
  expect(firstFinished).toBe(false);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(prompts).toEqual(["first distinct prompt", "second distinct prompt"]);
  expect(inputs).toHaveLength(2);
  expect(inputs).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "provider_accepted", session_id: "original-cold-session" })]));
  completed.resolve({ started: true, ok: true, status: "completed" });
  await expect(first).resolves.toMatchObject({ new_session_id: "original-cold-session" });
  await plane.close();
});

describe("Codex Desktop follower admission", () => {
  it("keeps GUI ownership, acknowledges once, and closes the follower on Runner stop", async () => {
    const completion = deferred<{ started: boolean; ok: boolean }>();
    const close = vi.fn(async () => { completion.resolve({ started: true, ok: false }); });
    const interrupt = vi.fn(async () => {});
    const controller = { turnActive: true, close, interrupt,
      dispatch: vi.fn(async () => ({ kind: "started", turnId: "gui-turn", completion: completion.promise })) };
    vi.spyOn(CodexDesktopSession, "connect").mockResolvedValue(controller as unknown as CodexDesktopSession);
    const native = vi.spyOn(CodexManagedSession, "resume");
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 5000 });
    const onInput = vi.fn(async () => {});
    const result = await plane.continueSession({ provider: "codex", sessionId: "gui", prompt: "hello", cwd: "/tmp", takeover: false, onInput });
    expect(result).toMatchObject({ ok: true, control_action: "protocol_send", turn_id: "gui-turn" });
    expect(onInput).toHaveBeenCalledOnce(); expect(native).not.toHaveBeenCalled();
    expect(await plane.publicRuntime("codex", "gui")).toMatchObject({ control_lease: { holder: "terminal" }, capabilities: { interrupt: true, takeover: false } });
    await plane.interruptSession("codex", "gui"); expect(interrupt).toHaveBeenCalledOnce();
    await plane.close(); expect(close).toHaveBeenCalled();
  });
  it("does not launch a second writer after GUI rejection or an unknown acknowledgement", async () => {
    const close = vi.fn(async () => {});
    vi.spyOn(CodexDesktopSession, "connect").mockResolvedValue({ close,
      dispatch: async () => { throw new Error("acknowledgement lost"); } } as unknown as CodexDesktopSession);
    const native = vi.spyOn(CodexManagedSession, "resume");
    const plane = new AgentControlPlane({ runtime: new AgentRuntimeRegistry({ processReader: new Processes() }),
      interactions: new AgentInteractionBroker(), timeoutMs: 5000 });
    await expect(plane.continueSession({ provider: "codex", sessionId: "gui", prompt: "once", cwd: "/tmp", takeover: false }))
      .rejects.toMatchObject({ message: "acknowledgement lost", safeFallback: false });
    expect(native).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); await plane.close();
  });
});

describe("AgentControlPlane Claude terminal receipts", () => {
  /** A Claude TUI in one tmux pane; `onEnter` plays Claude writing its transcript. */
  async function claudeInPane(turn: "Stop" | "UserPromptSubmit", onEnter: (file: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "octopus-claude-receipt-"));
    roots.push(root);
    const file = join(root, "session-c.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "user", origin: { kind: "human" }, message: { content: "更早的一句话" } })}\n`);
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-c", hook_event_name: turn }, 30);
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: withEmptyComposer(async (_bin, args) => {
          if (args[0] === "send-keys" && args.includes("C-m")) onEnter(file);
          // The pane always redraws: a redraw must no longer count as a receipt.
          return { stdout: args[0] === "list-panes" ? "%4\t/dev/pts/8\t0\t0\n" : args[0] === "capture-pane" ? String(Math.random()) : "" };
        }),
        wait: async () => {},
      }),
      timeoutMs: 5_000,
    });
    const received: unknown[] = [];
    const send = (prompt: string) => plane.continueSession({ provider: "claude", sessionId: "session-c", sessionPath: file, prompt,
      cwd: root, takeover: false, onInput: async (receipt) => { received.push(receipt); } });
    return { plane, send, received, file };
  }
  const line = (row: unknown) => `${JSON.stringify(row)}\n`;

  it("confirms an idle submission from the human record Claude writes", async () => {
    const { plane, send } = await claudeInPane("Stop", (file) => appendFileSync(file,
      line({ type: "user", origin: { kind: "human" }, message: { content: "看一下《ProjectX》里 A0 的意见" } })));
    await expect(send("看一下《ProjectX》里 A0 的意见")).resolves.toMatchObject({ ok: true, control_action: "terminal_send",
      input: { phase: "input_observed", evidence: "transcript", transport: "tmux" } });
    await plane.close();
  });

  it("confirms a busy session's input from Claude's own queue", async () => {
    const { plane, send } = await claudeInPane("UserPromptSubmit", (file) => appendFileSync(file,
      line({ type: "queue-operation", operation: "enqueue", content: "等这一步结束后再改 A1" })));
    await expect(send("等这一步结束后再改 A1")).resolves.toMatchObject({ ok: true, control_action: "terminal_queue",
      input: { phase: "local_queued", evidence: "transcript" } });
    await plane.close();
  });

  it("stays uncertain without a record, then records the input once Claude takes it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { plane, send, received, file } = await claudeInPane("Stop", () => {});
      await expect(send("把第三节改短")).resolves.toMatchObject({ ok: false, code: "unknown",
        input: { phase: "dispatched", evidence: "terminal_write" }, error: expect.stringContaining("会话记录里还没有出现") });
      expect(received).toMatchObject([{ phase: "dispatched", evidence: "terminal_write" }]);
      // The person presses Enter in the CLI a little later; nothing is resent.
      appendFileSync(file, line({ type: "user", origin: { kind: "human" }, message: { content: "把第三节改短" } }));
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => expect(received).toMatchObject([{ phase: "dispatched" },
        { phase: "input_observed", evidence: "transcript", control_action: "terminal_send" }]));
      await plane.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a composer holding a draft without counting it as sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-claude-composer-"));
    roots.push(root);
    const file = join(root, "session-d.jsonl");
    writeFileSync(file, line({ type: "user", origin: { kind: "human" }, message: { content: "更早的一句话" } }));
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-d", hook_event_name: "Stop" }, 30);
    let composer = "\u276f\u00a0half typed";
    const writes: string[][] = [];
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async (_bin, args) => {
          if (["load-buffer", "paste-buffer", "send-keys"].includes(args[0]!)) writes.push(args);
          if (args[0] === "send-keys" && args.includes("C-m")) {
            appendFileSync(file, line({ type: "user", origin: { kind: "human" }, message: { content: "把第三节改短" } }));
          }
          if (args[0] === "display-message") return { stdout: "1 2 0\n" };
          if (args[0] === "capture-pane" && args.includes("-e")) return { stdout: `${composer}\n` };
          return { stdout: args[0] === "list-panes" ? "%4\t/dev/pts/8\t0\t0\n" : args[0] === "capture-pane" ? String(Math.random()) : "" };
        },
        wait: async () => {},
      }),
      timeoutMs: 5_000,
    });
    const send = () => plane.continueSession({ provider: "claude", sessionId: "session-d", sessionPath: file,
      prompt: "把第三节改短", cwd: root, takeover: false });

    await expect(send()).rejects.toMatchObject({ code: "terminal_composer_busy", inputNotSent: true });
    expect(writes).toEqual([]);
    // Once the person clears the composer the same words go through: the
    // refusal sent nothing, so it is not a duplicate of anything.
    composer = "\u276f\u00a0";
    await expect(send()).resolves.toMatchObject({ ok: true, input: { phase: "input_observed" } });
    expect(writes.map((args) => args[0])).toEqual(["load-buffer", "paste-buffer", "send-keys"]);
    await plane.close();
  });
});

describe("AgentControlPlane released Claude questions", () => {
  /** A Claude TUI showing question `toolu_q` in pane %4; each key plays what Claude writes. */
  async function questionInPane(onKey: (key: "Escape" | "Enter", file: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "octopus-claude-question-"));
    roots.push(root);
    const file = join(root, "session-q.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_q" }] } })}\n`);
    const question = { toolUseId: "toolu_q", transcriptPath: file, transcriptOffset: statSync(file).size };
    const processes = new Processes();
    processes.rows.set(30, proc(30, 10, ["node", "runner.js", "hook", "report", "claude"]));
    processes.rows.set(10, proc(10, 1, ["claude"]));
    const runtime = new AgentRuntimeRegistry({ processReader: processes });
    await runtime.recordHook("claude", { session_id: "session-q", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }, 30);
    await runtime.recordHook("claude", { session_id: "session-q", hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion" }, 30);
    const keys: string[][] = [];
    let panes = "%4\t/dev/pts/8\t0\t0\n";
    const plane = new AgentControlPlane({
      runtime,
      interactions: new AgentInteractionBroker(),
      terminal: new TerminalControl({
        readlink: async () => "/dev/pts/8",
        run: async (_bin, args) => {
          if (args[0] === "send-keys" || args[0] === "paste-buffer") keys.push(args);
          if (args[0] === "send-keys" && args.includes("Escape")) onKey("Escape", file);
          if (args[0] === "send-keys" && args.includes("C-m")) onKey("Enter", file);
          return { stdout: args[0] === "list-panes" ? panes : args[0] === "capture-pane" ? String(Math.random()) : "" };
        },
        wait: async () => {},
      }),
      timeoutMs: 5_000,
    });
    return { plane, question, keys, file, leavePane: () => { panes = ""; } };
  }
  const line = (row: unknown) => `${JSON.stringify(row)}\n`;
  const answer = "我在 Octopus 网页上回答了你刚才的提问：\n- Which scope? → small";

  it("closes the dialog with one Escape, then sends the answer as an ordinary prompt", async () => {
    const { plane, question, keys } = await questionInPane((key, file) => appendFileSync(file, key === "Escape"
      ? line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_q", is_error: true }] } })
      : line({ type: "user", origin: { kind: "human" }, message: { content: answer } })));
    await expect(plane.claudeQuestionReachable("session-q")).resolves.toBe(true);
    await expect(plane.answerClaudeQuestion("session-q", question, answer)).resolves.toBeUndefined();
    expect(keys.map((args) => args[0] === "paste-buffer" ? "paste" : args.at(-1))).toEqual(["Escape", "paste", "C-m"]);
    await plane.close();
  });

  it("touches nothing once the question ended in the terminal itself", async () => {
    const { plane, question, keys, file } = await questionInPane(() => {});
    appendFileSync(file, line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_q" }] } }));
    await expect(plane.answerClaudeQuestion("session-q", question, answer)).rejects.toThrow(/已经在终端里回答或取消/);
    expect(keys).toEqual([]);
    await plane.close();
  });

  it("does not type the answer when Escape leaves no record that the dialog closed", async () => {
    const { plane, question, keys } = await questionInPane(() => {});
    await expect(plane.answerClaudeQuestion("session-q", question, answer)).rejects.toThrow(/没有发送答案/);
    expect(keys.map((args) => args.at(-1))).toEqual(["Escape"]);
    await plane.close();
  }, 10_000);

  it("offers no terminal answer for a CLI outside a provable tmux pane", async () => {
    const { plane, question, keys, leavePane } = await questionInPane(() => {});
    leavePane();
    await expect(plane.claudeQuestionReachable("session-q")).resolves.toBe(false);
    await expect(plane.answerClaudeQuestion("session-q", question, answer)).rejects.toThrow(/tmux pane/);
    expect(keys).toEqual([]);
    await plane.close();
  });
});
