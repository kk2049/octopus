import { withAgentExecutable } from "./agent-executables.js";
import { siteOperationId } from "./gateway-sites.js";
/**
 * Deterministic new-session launch adapters.
 *
 * The supervision window decides only what the RPC can honestly report. It
 * never kills a CLI that may still be working. Idempotency comes from the
 * device-local LaunchJournal written before spawn, not from process discovery.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MACHINE_LIMITS } from "./limits.js";
import { LaunchJournal, type LaunchJournalRecord } from "./launch-journal.js";
import { probeCodex, type CodexProbeResult } from "./probe.js";
import { resolveWorkspace } from "./workspaces.js";
import { resolveLaunchDirectory } from "./directories.js";
import { isAgentProvider, type AgentProvider, type AgentRuntimeRegistry } from "./agent-runtime.js";
import type { AgentControlPlane } from "./agent-control-plane.js";
import {
  codexExecPermissionArgs,
  codexPermissionProfile,
} from "./codex-permissions.js";
import {
  AGENT_PERMISSION_PROFILES,
  agentEffort,
  agentModel,
  agentPermissionProfile,
  type AgentPermissionProfile,
} from "./agent-permissions.js";
import { ScopedMcpProxy } from "./scoped-mcp-proxy.js";
import type { CodexExecRelayCoordinator, CodexRemoteEnvironment } from "./codex-exec-relay.js";
import {
  launchIndependentCliInTmux,
  sessionIdFromOmpScreen,
  type IndependentCliLaunchInput,
  type IndependentCliLaunchResult,
} from "./independent-cli-launch.js";
import { readHeadlessCapture, spawnHeadlessCli } from "./headless-cli-launch.js";
import {
  type ClaudePromptTranslation,
  type ClaudeTranslationPort,
} from "./claude-translation.js";
import type { CodexAccountSelection } from "./codex-account-routing.js";
import type { SessionInputReceipt } from "./gateway-protocol.js";
import { sessionIdFromCodexEvent } from "./launch-evidence.js";
import { markInputHandoff } from "./input-handoff.js";
export { sessionIdFromCodexEvent } from "./launch-evidence.js";

export type StartSessionResult =
  | {
      ok: true;
      agent: AgentProvider;
      session_id: string;
      pid?: number;
      transport?: "agent-sdk" | "app-server" | "omp-rpc" | "tmux-cli" | "exec";
      duration_ms: number;
      replayed?: true;
      account_label?: string;
    }
  | {
      ok: false;
      agent: AgentProvider;
      code: "failed" | "unknown" | "unsupported_cli_version";
      error: string;
      duration_ms: number;
      version?: string;
      pid?: number;
      replayed?: true;
    };

export interface StartSessionDeps {
  developmentId?: string;
  developmentMcpUrl?: string;
  onManagedSettled?: () => void;
  onCompletion?: (result: Record<string, unknown>) => Promise<void>;
  onInput?: (input: SessionInputReceipt) => Promise<void>;
  gatewaySite?: string;
  supervisionMs?: number;
  probe?: (home: string) => Promise<CodexProbeResult>;
  newClaudeSessionId?: () => string;
  journal?: LaunchJournal;
  runtime?: AgentRuntimeRegistry;
  /** Preferred provider-native managed start; legacy detached launch is fallback. */
  controlPlane?: AgentControlPlane;
  /** Opens a launch-scoped remote environment for Codex native execution. */
  codexExecRelay?: CodexExecRelayCoordinator;
  /** Effective trusted CODEX_HOME for attributing an interactive Codex launch. */
  codexHome?: string;
  /** Explicit slots resolve only against device-local registration; paths never cross RPC. */
  selectCodexAccount?: (slot?: string) => Promise<Pick<CodexAccountSelection, "codexHome" | "label">>;
  /** Trusted Runner policy; a new launch cannot use a retired default home. */
  requireCodexAccountSelection?: boolean;
  /** Test seam for the device-local tmux launcher. */
  independentCliLaunch?: (input: IndependentCliLaunchInput) => Promise<IndependentCliLaunchResult>;
  /** Tool-free translator used only for Claude's legacy detached fallback. */
  claudeTranslations?: ClaudeTranslationPort;
}

interface ExitResult {
  code: number | null;
  signal: string | null;
}

export async function machineStartSession(
  home: string,
  args: Record<string, unknown>,
  deps: StartSessionDeps = {},
): Promise<StartSessionResult> {
  const startedAt = Date.now();
  const source = String(args.source ?? "") as AgentProvider;
  if (!isAgentProvider(source)) throw new Error("start_session requires source=claude|codex|omp");
  const prompt = String(args.prompt ?? "");
  if (!prompt.trim()) throw new Error("start_session requires `prompt`");
  if (Buffer.byteLength(prompt, "utf8") > MACHINE_LIMITS.startMaxPromptBytes) {
    throw new Error(`prompt 过长 (最多 ${MACHINE_LIMITS.startMaxPromptBytes} 字节)`);
  }
  // ── Two ways to name where the Agent starts, and exactly one per call ─────
  //
  // `workspace_id` is the original: an opaque id the device resolves against
  // its own private registry, so the canonical path never crosses the wire.
  // `directory` is the one added in v4: the person typed a path, and the device
  // adjudicates it (`directories.ts`).
  //
  // Both are accepted because an OLDER Agent View — one the release registry
  // may still have active, or one an operator rolls back to — sends the first
  // form and must keep working. Sending both is refused rather than resolved by
  // precedence: the approval card named one of them, and picking a winner here
  // would mean the card and the cwd can disagree.
  const workspaceId = String(args.workspace_id ?? "").trim();
  const directory = typeof args.directory === "string" ? args.directory : "";
  if (workspaceId && directory) {
    throw new Error("start_session 只能给 workspace_id 或 directory 其中一个");
  }
  if (!workspaceId && !directory) throw new Error("start_session requires `workspace_id` or `directory`");
  const rawClientRequestId = String(args.client_request_id ?? "").trim();
  if (!rawClientRequestId || Buffer.byteLength(rawClientRequestId, "utf8") > MACHINE_LIMITS.clientRequestIdMaxBytes) {
    throw new Error("start_session requires a valid `client_request_id`");
  }
  const clientRequestId = siteOperationId(deps.gatewaySite, rawClientRequestId);
  const model = agentModel(args.model, "start_session");
  const effort = launchEffort(source, args.effort);
  const codexAccount = args.codex_account;
  if (codexAccount !== undefined && (source !== "codex" || typeof codexAccount !== "string"
    || (codexAccount !== "@default" && !/^[A-Za-z0-9_-]{1,32}$/.test(codexAccount)))) throw new Error("无效的 Codex 账号选择");
  const permissionProfile = agentPermissionProfile(source, args.permission_profile);
  // Opt-in, and only for Claude. The bilingual lane runs a second provider
  // (GPT over OMP ACP) before Claude is handed the prompt; a caller that did
  // not ask for that must not inherit its failure modes, because the plain
  // Claude lane is the one people fall back to when this system misbehaves.
  const translatePrompt = source === "claude" && args.translate_prompt === true;
  const launchMode = launchModeOf(args._octopus_launch_mode);
  if (deps.developmentMcpUrl && (launchMode || !deps.controlPlane)) throw new Error("开发 MCP 需要托管 Agent 控制面");
  const remoteMcpEndpoint = String(args._octopus_execution_mcp_url ?? "").trim();
  const remoteMcpToken = String(args._octopus_execution_mcp_token ?? "").trim();
  const sessionCatalogId = String(args._octopus_session_catalog_id ?? "").trim();
  const executionDevice = String(args.execution_device ?? "").trim();
  if (Boolean(remoteMcpEndpoint) !== Boolean(remoteMcpToken)) {
    throw new Error("跨机器执行的 MCP endpoint 与凭证必须同时存在");
  }
  const remoteExecution = Boolean(remoteMcpEndpoint);
  if (remoteExecution && (!workspaceId || directory)) {
    throw new Error("跨机器执行只接受已登记 workspace_id");
  }
  if (remoteExecution && !executionDevice) {
    throw new Error("跨机器执行需要明确的 execution_device");
  }
  if (remoteExecution && launchMode) {
    throw new Error("跨机器执行需要托管控制面，不能使用本机独立 CLI 模式");
  }
  if (sessionCatalogId && !/^spc_[0-9a-f]{64}$/.test(sessionCatalogId)) {
    throw new Error("Sessions+ session catalog id 无效");
  }
  if (!remoteExecution && sessionCatalogId) {
    throw new Error("本机会话不应携带 split session catalog id");
  }

  const journal = deps.journal ?? new LaunchJournal(home);
  const request = {
    client_request_id: clientRequestId,
    workspace_id: workspaceId,
    // Bound into the idempotency record, so the same request id can never be
    // reused for a different target: a retry after a timeout replays THIS
    // launch, and a caller that changed the directory gets a loud refusal
    // instead of a second Agent in a second place.
    directory,
    source,
    model,
    effort,
    ...(permissionProfile ? { permission_profile: permissionProfile } : {}),
    ...(launchMode ? { launch_mode: launchMode } : {}),
    remote_execution: remoteExecution,
    ...(remoteExecution ? { execution_device: executionDevice } : {}),
    ...(codexAccount ? { codex_account: codexAccount } : {}),
    prompt_hash: createHash("sha256").update(prompt).digest("hex"),
  } as const;

  // Replays consult durable evidence before probing binaries or spawning.
  // Calling begin again also verifies that this id was not rebound to another
  // prompt/workspace by a buggy caller.
  const prior = await journal.reconcile(clientRequestId);
  if (prior) {
    // A prior launch may have run; anything that fails while joining it is unknown.
    markInputHandoff();
    const joined = await journal.begin(request);
    if (sessionCatalogId && joined.record.started?.session_id) {
      await journal.bindSessionCatalog(clientRequestId, sessionCatalogId);
    }
    deps.onManagedSettled?.();
    return replayResult(joined.record, Date.now() - startedAt);
  }

  return await withAgentExecutable(source, async () => {
  // The device is the final authority on where a NEW launch may start work. A
  // registered workspace resolves through the private registry; a typed
  // directory is realpath'd and proved accessible. This deliberately comes
  // after the journal replay above: durable evidence remains replayable even if
  // the directory was renamed or removed after the already-recorded process
  // started. Neither form is a sandbox; the CLI runs as this account either way.
  const cwd = remoteExecution
    ? await remoteControlDirectory(home, clientRequestId)
    : workspaceId
      ? (await resolveWorkspace(home, workspaceId)).path
      : (await resolveLaunchDirectory(home, directory)).path;

  // Managed local Codex starts retain the same reset-first account routing the
  // old independent CLI path used. The selected CODEX_HOME stays device-local
  // and is handed to an account-specific app-server attachment.
  if (codexAccount && codexAccount !== "@default" && !deps.selectCodexAccount) {
    throw new Error("所选 Codex 账号未在此 Runner 登记");
  }
  const requireAccount = source === "codex" && deps.requireCodexAccountSelection === true;
  const selectedCodexAccount = requireAccount || (source === "codex" && codexAccount !== "@default" && (!remoteExecution || codexAccount))
    ? await deps.selectCodexAccount?.(codexAccount === "@default" ? undefined : codexAccount)
    : undefined;
  if (requireAccount && !selectedCodexAccount) throw new Error("显式 Codex 账号池没有可用账号，不能回退到旧默认登录");
  if (selectedCodexAccount) deps = { ...deps, codexHome: selectedCodexAccount.codexHome };

  let probe: CodexProbeResult | undefined;
  // A provider-native control plane does not depend on the legacy
  // `codex exec --json` surface. Probe that surface up front only when it is
  // the sole available launcher; otherwise give app-server first refusal and
  // probe lazily if a pre-prompt setup failure requires the compatibility
  // path.
  if (source === "codex" && !deps.controlPlane) {
    probe = await (deps.probe ?? probeCodex)(home);
    if (!probe.supported) {
      return {
        ok: false,
        agent: source,
        code: "unsupported_cli_version",
        error: codexUnavailableMessage(probe),
        version: probe.version,
        duration_ms: Date.now() - startedAt,
      };
    }
  }

  // Validation, workspace and account selection precede this record; a failure
  // before it is a definite refusal, and nothing after it is replayed.
  markInputHandoff();
  const begun = await journal.begin(request);
  if (!begun.created) return replayResult(begun.record, Date.now() - startedAt);
  void journal.prune().catch(() => {});
  let codexEnvironment: CodexRemoteEnvironment | null = null;
  let mcpProxy: ScopedMcpProxy | null = null;
  let remoteMcpUrl = "";
  if (remoteExecution) {
    try {
      if (!deps.controlPlane) {
        const message = "跨机器执行需要 Runner 的托管 Agent 控制面";
        await journal.markExit(clientRequestId, null, null, message);
        return failed(source, message, startedAt);
      }
      mcpProxy = new ScopedMcpProxy(
        new URL(remoteMcpEndpoint),
        remoteMcpToken,
        { revokeOnClose: false },
      );
      remoteMcpUrl = await mcpProxy.start();
      if (source === "omp") {
        await fs.writeFile(
          path.join(cwd, ".mcp.json"),
          JSON.stringify({ mcpServers: { octopus_execution: { url: remoteMcpUrl },
            ...(deps.developmentMcpUrl ? { octopus_devpipe: { url: deps.developmentMcpUrl } } : {}) } }, null, 2),
          { encoding: "utf8", mode: 0o600 },
        );
      }
      if (source === "codex") {
        if (!deps.codexExecRelay || !executionDevice) {
          throw new Error("Codex 跨机器执行需要已认证的 Runner exec-server relay");
        }
        codexEnvironment = await deps.codexExecRelay.open({
          executionDevice,
          workspaceId,
          executionToken: remoteMcpToken,
          operationId: clientRequestId,
        });
      }
    } catch (error) {
      await mcpProxy?.close().catch(() => {});
      await codexEnvironment?.close().catch(() => {});
      const message = `跨机器执行环境准备失败：${error instanceof Error ? error.message : String(error)}`;
      await journal.markExit(clientRequestId, null, null, message);
      return failed(source, message, startedAt);
    }
  }

  if (source === "omp" && deps.developmentMcpUrl && !remoteExecution) {
    await fs.writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
      octopus_devpipe: { url: deps.developmentMcpUrl },
    } }), { encoding: "utf8", mode: 0o600 });
  }

  const claudeSessionId = source === "claude" ? (deps.newClaudeSessionId ?? randomUUID)() : undefined;
  let claudeTranslation: ClaudePromptTranslation | undefined;
  if (launchMode === "independent_cli") {
    if (translatePrompt && deps.claudeTranslations) {
      const prepared = await prepareClaudeTranslation(
        deps.claudeTranslations,
        prompt,
        cwd,
        clientRequestId,
        journal,
        startedAt,
      );
      if (!prepared.ok) return prepared.result;
      claudeTranslation = prepared.translation;
    }
    const terminal = await (deps.independentCliLaunch ?? launchIndependentCliInTmux)({
      source,
      cwd,
      prompt: claudeTranslation?.en ?? prompt,
      model,
      effort,
      permissionProfile: permissionProfile!,
      requestId: clientRequestId,
      ...(claudeSessionId ? { claudeSessionId } : {}),
      ...(source === "codex" ? { codexHome: deps.codexHome ?? path.join(home, ".codex") } : {}),
      supervisionMs: deps.supervisionMs ?? MACHINE_LIMITS.startSupervisionMs,
    });
    if (terminal.kind === "started") {
      if (claudeTranslation && deps.claudeTranslations) {
        await deps.claudeTranslations.recordUser(claudeSessionId!, claudeTranslation).catch(() => {});
      }
      await journal.markStarted(clientRequestId, terminal.sessionId, terminal.pid, "tmux-cli");
      await deps.runtime?.markHeadless(source, terminal.sessionId);
      return {
        ok: true,
        agent: source,
        session_id: terminal.sessionId,
        pid: terminal.pid,
        transport: "tmux-cli",
        duration_ms: Date.now() - startedAt,
        ...(selectedCodexAccount ? { account_label: selectedCodexAccount.label } : {}),
      };
    }
    if (terminal.kind !== "unavailable") {
      if (terminal.kind === "unknown" && claudeTranslation && deps.claudeTranslations) {
        await deps.claudeTranslations.recordUser(claudeSessionId!, claudeTranslation).catch(() => {});
      }
      if (terminal.kind === "failed") {
        await journal.markExit(clientRequestId, null, null, terminal.error);
      } else if (terminal.pid) {
        await journal.markSpawned(clientRequestId, terminal.pid);
      }
      return terminal.kind === "unknown"
        ? {
            ok: false,
            agent: source,
            code: "unknown",
            error: terminal.error,
            ...(terminal.pid ? { pid: terminal.pid } : {}),
            duration_ms: Date.now() - startedAt,
          }
        : failed(source, terminal.error, startedAt, terminal.pid);
    }
    // No usable tmux and no prompt crossed: continue to the detached CLI
    // compatibility path below. Explicit independent mode never falls back
    // into SDK/app-server/RPC merely because those objects are available.
  }

  if (deps.controlPlane && launchMode !== "independent_cli") {
    // Reuse the same preallocated id if a pre-prompt SDK failure falls back to
    // detached Claude; its bilingual sidecar is keyed by this exact id.
    try {
      const managed = await deps.controlPlane.startManaged({
        provider: source,
        onPrepared: async (sessionId, transport) => {
          await journal.markManagedPrepared(clientRequestId, sessionId, transport, sessionCatalogId || undefined);
        },
        cwd,
        prompt,
        ...(translatePrompt ? { translatePrompt } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(claudeSessionId ? { sessionId: claudeSessionId } : {}),
        ...(permissionProfile ? { permissionProfile } : {}),
        // Split default uses the registered isolated host; its CODEX_HOME is fixed.
        // Named accounts must still be explicit, never silently routed to default.
        ...(source === "codex" && (selectedCodexAccount || !remoteExecution)
          ? { codexHome: deps.codexHome ?? path.join(home, ".codex") } : {}),
        ...(remoteExecution
          ? {
              recoveryPlacement: {
                ...(deps.gatewaySite ? { gatewaySite: deps.gatewaySite } : {}),
                executionDevice,
                workspaceId,
                ...(deps.developmentId ? { developmentId: deps.developmentId } : {}),
              },
            }
          : {}),
        ...(remoteMcpUrl ? { remoteMcpUrl } : {}),
        ...(deps.developmentMcpUrl ? { developmentMcpUrl: deps.developmentMcpUrl } : {}),
        ...(codexEnvironment
          ? {
              codexEnvironment: {
                environmentId: codexEnvironment.environmentId,
                endpoint: codexEnvironment.endpoint,
              },
            }
          : {}),
      });
      await journal.markManagedStarted(
        clientRequestId,
        managed.sessionId,
        managed.transport,
        sessionCatalogId || undefined,
      );
      await deps.onInput?.({ phase: source === "claude" ? "local_queued" : "provider_accepted",
        evidence: source === "claude" ? "local_queue" : "provider_ack", at: new Date().toISOString(),
        session_id: managed.sessionId, turn_id: managed.turnId, transport: managed.transport, control_action: "start" }).catch(() => {});
      void managed.completion.then(async (outcome) => {
        // Persist before delivering: a lost observer or resident restart can
        // read the original answer without replaying any provider input.
        try {
          await journal.markManagedCompleted(clientRequestId, { ...outcome, durationMs: Date.now() - startedAt });
        } finally {
          await deps.onCompletion?.({ ok: outcome.ok, session_id: managed.sessionId,
            ...(outcome.newSessionId ? { new_session_id: outcome.newSessionId } : {}),
            result_text: outcome.resultText ?? "", error: outcome.error,
            usage: outcome.usage, duration_ms: Date.now() - startedAt });
        }
      }).catch(() => {}).finally(async () => {
        deps.onManagedSettled?.();
        await Promise.allSettled([
          mcpProxy?.close() ?? Promise.resolve(),
          codexEnvironment?.close() ?? Promise.resolve(),
        ]);
      });
      return {
        ok: true,
        agent: source,
        session_id: managed.sessionId,
        transport: managed.transport,
        duration_ms: Date.now() - startedAt,
        ...(selectedCodexAccount ? { account_label: selectedCodexAccount.label } : {}),
      };
    } catch (error) {
      await mcpProxy?.close().catch(() => {});
      await codexEnvironment?.close().catch(() => {});
      const safeFallback = (error as Error & { safeFallback?: boolean }).safeFallback;
      if ((error as Error & { inputRejected?: boolean }).inputRejected) {
        const message = error instanceof Error ? error.message : String(error);
        await journal.markExit(clientRequestId, 1, null, message);
        return failed(source, message, startedAt);
      }
      // Durable ticket callers need a conclusive pre-input refusal recorded as
      // failed. Unmarked/post-input errors remain unknown and never replay.
      if (deps.onCompletion && !deps.onInput && safeFallback !== true) throw error;
      if (safeFallback === undefined || (deps.onCompletion && !deps.onInput)) {
        const message = `托管 Agent 启动准备失败：${error instanceof Error ? error.message : String(error)}`;
        await journal.markExit(clientRequestId, null, null, message);
        return failed(source, message, startedAt);
      }
      if (remoteExecution || deps.developmentMcpUrl) {
        const message = `托管 Agent 启动失败：${error instanceof Error ? error.message : String(error)}`;
        await journal.markExit(clientRequestId, null, null, message);
        return failed(source, message, startedAt);
      }
      if (safeFallback !== true) throw error;
      if (source === "claude" && permissionProfile === AGENT_PERMISSION_PROFILES.manual) {
        const message = `Claude 手动确认档需要 Agent SDK，当前协议启动失败：${error instanceof Error ? error.message : String(error)}`;
        await journal.markExit(clientRequestId, null, null, message);
        return failed(source, message, startedAt);
      }
      await journal.markFallback(clientRequestId, "native_setup", error instanceof Error ? error.message : String(error));
      // Provider protocol failed before owning the prompt. Preserve the old
      // detached launch path; once a prompt may have crossed, fallback is
      // forbidden because it could duplicate the turn.
    }
  }

  if (source === "claude" && permissionProfile === AGENT_PERMISSION_PROFILES.manual) {
    const message = launchMode === "independent_cli"
      ? "Claude 手动确认档需要 tmux 中的交互 CLI；当前机器没有可用的 tmux，不能安全降级为绕过权限的 headless CLI"
      : "Claude 手动确认档需要 Runner 的 Agent SDK；旧版 detached CLI 不支持网页审批";
    await journal.markExit(clientRequestId, null, null, message);
    return failed(source, message, startedAt);
  }

  if (source === "omp" && launchMode !== "independent_cli") {
    const message = "omp 会话只能通过 Runner 的 RPC 控制面启动；这个 Runner 没有启用控制面，请升级 Runner 后重试。";
    await journal.markExit(clientRequestId, null, null, message);
    return failed(source, message, startedAt);
  }

  if (source === "codex" && !probe) {
    probe = await (deps.probe ?? probeCodex)(home);
    if (!probe.supported) {
      const error = codexUnavailableMessage(probe);
      await journal.markExit(clientRequestId, null, null, error);
      return {
        ok: false,
        agent: source,
        code: "unsupported_cli_version",
        error,
        version: probe.version,
        duration_ms: Date.now() - startedAt,
      };
    }
  }

  if (source === "claude") {
    if (translatePrompt && !claudeTranslation && deps.claudeTranslations) {
      const prepared = await prepareClaudeTranslation(
        deps.claudeTranslations,
        prompt,
        cwd,
        clientRequestId,
        journal,
        startedAt,
      );
      if (!prepared.ok) return prepared.result;
      claudeTranslation = prepared.translation;
    }
    return await launchClaude(
      home,
      cwd,
      claudeTranslation?.en ?? prompt,
      model,
      effort,
      clientRequestId,
      journal,
      startedAt,
      claudeSessionId!,
      claudeTranslation,
      deps,
    );
  }
  if (source === "codex") {
    const result = await launchCodex(
        home,
        cwd,
        prompt,
        model,
        effort,
        permissionProfile!,
        clientRequestId,
        journal,
        startedAt,
        probe!,
        deps,
      );
    return result.ok && selectedCodexAccount
      ? { ...result, account_label: selectedCodexAccount.label }
      : result;
  }
  return await launchOmp(home, cwd, prompt, model, effort, clientRequestId, journal, startedAt, deps);
  });
}

async function remoteControlDirectory(home: string, requestId: string): Promise<string> {
  const key = createHash("sha256").update(requestId).digest("hex").slice(0, 24);
  const directory = path.join(home, ".octopus-runner", "remote-sessions", key);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function prepareHeadless(
  home: string,
  cwd: string,
  requestId: string,
  command: { bin: string; args: string[] },
  journal: LaunchJournal,
  source: AgentProvider,
  startedAt: number,
  env?: NodeJS.ProcessEnv,
): Promise<
  | { ok: true; process: Awaited<ReturnType<typeof spawnHeadlessCli>> }
  | { ok: false; result: StartSessionResult }
> {
  try {
    return { ok: true, process: await spawnHeadlessCli(home, cwd, requestId, command, env) };
  } catch (error) {
    const message = `${source} detached CLI 准备失败：${error instanceof Error ? error.message : String(error)}`;
    await journal.markExit(requestId, null, null, message);
    return { ok: false, result: failed(source, message, startedAt) };
  }
}

async function prepareClaudeTranslation(
  translations: ClaudeTranslationPort,
  prompt: string,
  cwd: string,
  requestId: string,
  journal: LaunchJournal,
  startedAt: number,
): Promise<
  | { ok: true; translation: ClaudePromptTranslation }
  | { ok: false; result: StartSessionResult }
> {
  try {
    return { ok: true, translation: await translations.translateUser(prompt, cwd) };
  } catch (error) {
    const message = `Claude 输入翻译失败：${error instanceof Error ? error.message : String(error)}`;
    await journal.markExit(requestId, null, null, message);
    return { ok: false, result: failed("claude", message, startedAt) };
  }
}

async function launchClaude(
  home: string,
  cwd: string,
  prompt: string,
  model: string,
  effort: string,
  requestId: string,
  journal: LaunchJournal,
  startedAt: number,
  sessionId: string,
  translation: ClaudePromptTranslation | undefined,
  deps: StartSessionDeps,
): Promise<StartSessionResult> {
  const launched = await prepareHeadless(home, cwd, requestId, {
    bin: "claude",
    args: [
      "-p", prompt,
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
      "--session-id", sessionId,
      "--output-format", "json",
      "--dangerously-skip-permissions",
    ],
  }, journal, "claude", startedAt);
  if (!launched.ok) return launched.result;
  const headless = launched.process;
  const child = headless.child;
  const exit = observeExit(child, journal, requestId, async () => await readHeadlessCapture(headless.errorFile));
  const spawned = await waitForSpawn(child);
  if (!spawned.ok) {
    await headless.cleanup();
    await journal.markExit(requestId, null, null, spawned.error);
    return failed("claude", spawned.error, startedAt);
  }
  const pid = child.pid!;
  await journal.markStarted(requestId, sessionId, pid, "exec");
  if (translation && deps.claudeTranslations) {
    await deps.claudeTranslations.recordUser(sessionId, translation).catch(() => {});
    void exit.then(async (result) => {
      if (result.code !== 0) return;
      const english = claudeResultText(await readHeadlessCapture(headless.outputFile));
      if (!english) return;
      await deps.claudeTranslations!.translateAssistant(
        sessionId,
        translation.turnId,
        english,
        cwd,
      );
    }).catch(() => {});
  }

  await deps.runtime?.markHeadless("claude", sessionId);
  await deps.onInput?.({ phase: "dispatched", evidence: "launch_identity", at: new Date().toISOString(),
    session_id: sessionId, transport: "exec", control_action: "start" }).catch(() => {});
  void exit.then(async (value) => {
    await deps.onCompletion?.({ ok: value.code === 0, session_id: sessionId,
      exit_code: value.code, duration_ms: Date.now() - startedAt });
  }).catch(() => {});
  detachHandles(child);
  const observed = await observeWindow(exit, deps.supervisionMs ?? MACHINE_LIMITS.startSupervisionMs);
  if (observed && observed.code !== 0) {
    const error = await readHeadlessCapture(headless.errorFile);
    await headless.cleanup();
    return failed("claude", error || `claude 提前退出 (exit ${String(observed.code)})`, startedAt, pid);
  }
  return {
    ok: true,
    agent: "claude",
    session_id: sessionId,
    pid,
    transport: "exec",
    duration_ms: Date.now() - startedAt,
  };
}

async function launchCodex(
  home: string,
  cwd: string,
  prompt: string,
  model: string,
  effort: string,
  permissionProfile: AgentPermissionProfile,
  requestId: string,
  journal: LaunchJournal,
  startedAt: number,
  probe: CodexProbeResult,
  deps: StartSessionDeps,
): Promise<StartSessionResult> {
  const launched = await prepareHeadless(home, cwd, requestId, {
    bin: "codex",
    args: [
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...codexExecPermissionArgs(permissionProfile),
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--config", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      prompt,
    ],
  }, journal, "codex", startedAt, deps.codexHome
    ? { ...process.env, CODEX_HOME: deps.codexHome }
    : undefined);
  if (!launched.ok) return launched.result;
  const headless = launched.process;
  const child = headless.child;
  const supervisionMs = deps.supervisionMs ?? MACHINE_LIMITS.startSupervisionMs;
  const exit = observeExit(child, journal, requestId, async () => await readHeadlessCapture(headless.errorFile));
  const spawned = await waitForSpawn(child);
  if (!spawned.ok) {
    await headless.cleanup();
    await journal.markExit(requestId, null, null, spawned.error);
    return failed("codex", spawned.error, startedAt, undefined, probe.version);
  }
  const pid = child.pid!;
  await journal.markSpawned(requestId, pid);
  detachHandles(child);

  // Continue recording a late id even if this RPC has already returned
  // `unknown`. The journal is evidence for the next reconnect/replay.
  const idSignal = sessionIdFromCapture(headless.outputFile, sessionIdFromCodexEvent, exit);
  const durableId = idSignal.then(async (sessionId) => {
    if (sessionId) {
      await journal.markStarted(requestId, sessionId, pid, "exec");
      await deps.runtime?.markHeadless("codex", sessionId);
      await deps.onInput?.({ phase: "provider_accepted", evidence: "launch_identity", at: new Date().toISOString(),
        session_id: sessionId, transport: "exec", control_action: "start" }).catch(() => {});
    }
    return sessionId;
  });
  void exit.then(async (value) => {
    const sessionId = await durableId;
    await deps.onCompletion?.({ ok: value.code === 0, ...(sessionId ? { session_id: sessionId } : {}),
      exit_code: value.code, duration_ms: Date.now() - startedAt });
    if (sessionId) await headless.cleanup();
  }).catch(() => {});
  const observed = await Promise.race([
    durableId.then((sessionId) => ({ kind: "id" as const, sessionId })),
    exit.then(async (value) => { await durableId; return { kind: "exit" as const, value }; }),
    delay(supervisionMs).then(() => ({ kind: "timeout" as const })),
  ]);
  if (observed.kind === "id" && observed.sessionId) {
    return {
      ok: true,
      agent: "codex",
      session_id: observed.sessionId,
      pid,
      transport: "exec",
      duration_ms: Date.now() - startedAt,
    };
  }
  if (observed.kind === "exit") {
    const error = await readHeadlessCapture(headless.errorFile);
    await headless.cleanup();
    return failed(
      "codex",
      error || `codex 在报告会话 id 前退出 (exit ${String(observed.value.code)})`,
      startedAt,
      pid,
      probe.version,
    );
  }
  return {
    ok: false,
    agent: "codex",
    code: "unknown",
    error: "codex 仍在运行，但尚未报告会话 id；不会自动重启，请稍后查看会话列表。",
    version: probe.version,
    pid,
    duration_ms: Date.now() - startedAt,
  };
}

async function launchOmp(
  home: string,
  cwd: string,
  prompt: string,
  model: string,
  effort: string,
  requestId: string,
  journal: LaunchJournal,
  startedAt: number,
  deps: StartSessionDeps,
): Promise<StartSessionResult> {
  const launched = await prepareHeadless(home, cwd, requestId, {
    bin: "omp",
    args: [
      "-p",
      "--mode",
      "json",
      "--cwd",
      cwd,
      "--auto-approve",
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--thinking", effort] : []),
      prompt,
    ],
  }, journal, "omp", startedAt);
  if (!launched.ok) return launched.result;
  const headless = launched.process;
  const child = headless.child;
  const supervisionMs = deps.supervisionMs ?? MACHINE_LIMITS.startSupervisionMs;
  const exit = observeExit(child, journal, requestId, async () => await readHeadlessCapture(headless.errorFile));
  const spawned = await waitForSpawn(child);
  if (!spawned.ok) {
    await headless.cleanup();
    await journal.markExit(requestId, null, null, spawned.error);
    return failed("omp", spawned.error, startedAt);
  }
  const pid = child.pid!;
  await journal.markSpawned(requestId, pid);
  detachHandles(child);

  const idSignal = sessionIdFromCapture(headless.outputFile, sessionIdFromOmpScreen, exit);
  const durableId = idSignal.then(async (sessionId) => {
    if (sessionId) {
      await journal.markStarted(requestId, sessionId, pid, "exec");
      await deps.runtime?.markHeadless("omp", sessionId);
      await deps.onInput?.({ phase: "provider_accepted", evidence: "launch_identity", at: new Date().toISOString(),
        session_id: sessionId, transport: "exec", control_action: "start" }).catch(() => {});
    }
    return sessionId;
  });
  void exit.then(async (value) => {
    const sessionId = await durableId;
    await deps.onCompletion?.({ ok: value.code === 0, ...(sessionId ? { session_id: sessionId } : {}),
      exit_code: value.code, duration_ms: Date.now() - startedAt });
    if (sessionId) await headless.cleanup();
  }).catch(() => {});
  const observed = await Promise.race([
    durableId.then((sessionId) => ({ kind: "id" as const, sessionId })),
    exit.then(async (value) => { await durableId; return { kind: "exit" as const, value }; }),
    delay(supervisionMs).then(() => ({ kind: "timeout" as const })),
  ]);
  if (observed.kind === "id" && observed.sessionId) {
    return {
      ok: true,
      agent: "omp",
      session_id: observed.sessionId,
      pid,
      transport: "exec",
      duration_ms: Date.now() - startedAt,
    };
  }
  if (observed.kind === "exit") {
    const error = await readHeadlessCapture(headless.errorFile);
    await headless.cleanup();
    return failed(
      "omp",
      error || `omp 在报告会话 id 前退出 (exit ${String(observed.value.code)})`,
      startedAt,
      pid,
    );
  }
  return {
    ok: false,
    agent: "omp",
    code: "unknown",
    error: "omp 仍在运行，但尚未报告会话 id；不会自动重启，请稍后查看会话列表。",
    pid,
    duration_ms: Date.now() - startedAt,
  };
}

function launchEffort(source: AgentProvider, value: unknown): string {
  return agentEffort(source, value, "start_session");
}

function launchModeOf(value: unknown): "independent_cli" | "" {
  if (value === undefined || value === null || value === "") return "";
  if (value !== "independent_cli") throw new Error("start_session 启动模式无效");
  return value;
}

function replayResult(record: LaunchJournalRecord, durationMs: number): StartSessionResult {
  const agent = record.requested.source;
  if (record.exit && (record.exit.error || record.exit.code !== 0)) {
    return {
      ok: false,
      agent,
      code: "failed",
      error: record.exit.error || `${agent} 已退出 (exit ${String(record.exit.code)})`,
      ...(record.started?.pid ?? record.spawned?.pid ? { pid: record.started?.pid ?? record.spawned?.pid } : {}),
      duration_ms: durationMs,
      replayed: true,
    };
  }
  if (record.started) {
    return {
      ok: true,
      agent,
      session_id: record.started.session_id,
      ...(record.started.pid ? { pid: record.started.pid } : {}),
      ...(record.started.transport ? { transport: record.started.transport } : {}),
      duration_ms: durationMs,
      replayed: true,
    };
  }
  return {
    ok: false,
    agent,
    code: "unknown",
    error: "这次启动已有设备侧记录，但没有足够证据确认会话 id；不会自动重发。",
    ...(record.spawned ? { pid: record.spawned.pid } : {}),
    duration_ms: durationMs,
    replayed: true,
  };
}

function waitForSpawn(child: ChildProcess): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      child.on("error", () => {});
      resolve({ ok: true });
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      resolve({ ok: false, error: error.message });
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function observeExit(
  child: ChildProcess,
  journal: LaunchJournal,
  requestId: string,
  error: () => string | Promise<string>,
): Promise<ExitResult> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      const value = { code, signal: signal ? String(signal) : null };
      void Promise.resolve(code && code !== 0 ? error() : undefined)
        .then(async (detail) => await journal.markExit(requestId, code, value.signal, detail))
        .catch(() => {})
        .finally(() => resolve(value));
    });
  });
}

async function sessionIdFromCapture(
  file: string,
  parse: (text: string) => string | null,
  exit: Promise<ExitResult>,
): Promise<string | null> {
  let exited = false;
  void exit.then(() => { exited = true; });
  // The foreground RPC has its own short deadline. Persisted captures also
  // permit read-only reconciliation after this bounded watcher or a restart.
  const deadline = Date.now() + 30 * 60_000;
  do {
    const text = await readHeadlessCapture(file);
    if (text) {
      for (const line of text.split("\n")) {
        const id = parse(line);
        if (id) return id;
      }
    }
    if (exited) return null; // This iteration already performed the final drain read.
    await delay(100);
  } while (Date.now() < deadline);
  return null;
}

export function claudeResultText(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const result = (parsed as Record<string, unknown>).result;
    return typeof result === "string" ? result.trim() : "";
  } catch {
    return "";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function observeWindow(exit: Promise<ExitResult>, ms: number): Promise<ExitResult | null> {
  return await Promise.race([exit, delay(ms).then(() => null)]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

function detachHandles(child: ChildProcess): void {
  child.unref();
  (child.stdout as { unref?: () => void } | null)?.unref?.();
  (child.stderr as { unref?: () => void } | null)?.unref?.();
}

function failed(
  agent: AgentProvider,
  error: string,
  startedAt: number,
  pid?: number,
  version?: string,
): StartSessionResult {
  return {
    ok: false,
    agent,
    code: "failed",
    error: error.slice(-1_000),
    ...(version ? { version } : {}),
    ...(pid ? { pid } : {}),
    duration_ms: Date.now() - startedAt,
  };
}

function codexUnavailableMessage(probe: CodexProbeResult): string {
  if (probe.reason === "command_unavailable") return "Runner 未找到可用的 Codex 安装；请用 agents list 检查本机注册表";
  if (probe.reason && !["version_too_old", "unparseable_version", "json_flag_missing"].includes(probe.reason)) {
    return `Runner 无法使用 Codex：${probe.reason}；请用 agents list 检查本机诊断`;
  }
  if (probe.reason === "version_too_old") {
    return `codex ${probe.version} 低于受支持版本，无法可靠报告新会话 id`;
  }
  return `codex ${probe.version} 没有可验证的 exec --json 会话 id 契约`;
}
