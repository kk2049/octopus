import { readCodexModelsFromAppServer } from "./codex-account-routing.js";
import { createHash } from "node:crypto";
import { RunnerCapabilityManager } from "./capability-manager.js";
import { MeetingTranscriptionManager, readMeetingTranscriptionConfig, transcriptionAdvertisement } from "./meeting-transcription.js";
/**
 * claude-bot-runner — the laptop-resident front-end head of the secretary
 * network. One process per machine:
 *   - dials the bot's RunnerGateway over WebSocket (outbound only, NAT-safe),
 *   - authenticates with a per-device token (minted via /runner-token),
 *   - heartbeats, reconnects with backoff,
 *   - serves session investigation (list/search/read) against THIS machine's
 *     ~/.claude and ~/.codex, and executes explicit session copies when the
 *     user files a report.
 *
 * Run:
 *   OCTOPUS_URL=wss://bot-host/runner OCTOPUS_RUNNER_TOKEN=rt_xxx \
 *     node packages/runner/dist/index.js
 *
 * Register a launchable workspace locally (its canonical path never leaves
 * this device):
 *   node packages/runner/dist/index.js workspace add <directory> [label]
 *
 * Optional env:
 *   OCTOPUS_RUNNER_TOKEN_FILE
 *                     read the device token from this mode-0600 file instead
 *                     of placing it in a service definition
 *   RUNNER_DEVICE     device label; must match the token's device (display only)
 *   RUNNER_SCAN_HOME  which home to scan (default: this user's home)
 *   CODEX_HOME        Codex state root; inherited from Codex, defaulting to
 *                     RUNNER_SCAN_HOME/.codex for session scans and hooks
 *   RUNNER_CODEX_ACCOUNT_DISCOVERY
 *                     set to 0 to use only the explicit account map below
 *   RUNNER_CODEX_ACCOUNTS
 *                     trusted local JSON map of opaque slot to CODEX_HOME;
 *                     new Sessions Plus Codex chats use reset-first routing
 *                     and scans cover every configured root
 *   RUNNER_CODEX_MIN_REMAINING_PERCENT
 *                     minimum long-window remainder for a new chat (default 5)
 *   RUNNER_ALLOW_MACHINE_OPS
 *                     "0" turns this device into a read-only investigation
 *                     endpoint: exec / file ops are refused locally, whatever
 *                     the bot asks. Default on — the point of a Runner is to
 *                     let your own agent work on your own machine.
 *   RUNNER_EXECUTION_ONLY
 *                     "1" exposes only shell/file/registered-workspace ops.
 *                     Session scans, Agent control, Codex relays, DSH and
 *                     knowledge jobs are refused locally and not advertised.
 *   RUNNER_EXEC_SHELL  trusted absolute shell path for machine exec. The
 *                     Windows installer sets this to Git Bash; Unix defaults
 *                     to /bin/bash.
 *   RUNNER_AGENT_HOOKS "install" (default) idempotently installs the Claude
 *                     Code/Codex hooks and the opt-in `octopus-codex` shared
 *                     app-server launcher. "manual" leaves config untouched;
 *                     "off" removes those marker-owned entries at startup.
 *                     Stop, restart and self-update leave every integration
 *                     installed (hooks fail open while the Runner is down);
 *                     only `octopus-runner uninstall` removes them.
 *   RUNNER_LOCAL_MCP   "managed" (default) keeps a stable private Runner MCP
 *                     launcher discoverable while Dashboard device policy
 *                     decides whether ordinary Codex, Claude and OMP receive
 *                     user-level MCP + routing-prompt injection. "install"
 *                     is an explicit always-on local override; "manual"
 *                     leaves configs untouched and "off" removes integration.
 *   RUNNER_SELF_UPDATE "0" keeps this device on the build it runs. Default on:
 *                     the Runner reports the sha256 of its entry file, and when
 *                     the bot serves a different standalone build it downloads
 *                     it over this same socket, verifies it, stages it at
 *                     <scan home>/.octopus/runner/standalone.js and hands over
 *                     (src/self-update.ts).
 *   RUNNER_KNOWLEDGE_INPUT_ORIGIN
 *                     exact trusted dashboard HTTPS origin for one-use
 *                     privacy-filtered index inputs (HTTP is loopback-only);
 *                     without it this Runner does not advertise job support
 *   OCTOPUS_RUNNER_SUPERVISED
 *                     "1" = something restarts this process when it exits
 *                     (docker --restart, systemd Restart=, our own shim).
 *                     OS services still use the old process as an update shim;
 *                     only an internal shim child exits 75 after staging.
 *
 * Keep it resident with systemd/launchd, e.g.:
 *   [Service]
 *   Environment=OCTOPUS_URL=wss://bot-host/runner
 *   Environment=OCTOPUS_RUNNER_TOKEN_FILE=/run/secrets/octopus-runner-token
 *   Environment=OCTOPUS_RUNNER_SUPERVISED=1
 *   ExecStart=/usr/bin/node /opt/claude-bot/runner/index.js
 *   Restart=always
 *   (point ExecStart at <scan home>/.octopus/runner/standalone.js once it exists)
 */

import {ManagedCompletionJournal} from './managed-completions.js';
import os from "node:os";
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { resolveSessionPath } from "@claude-bot/plugin-sessions/scan";
import { RunnerRpcDispatcher } from "./core.js";
import { RunnerSessionOperations } from "./session-operations.js";
import { RunnerSessionProjector } from "./session-projector.js";
import { LaunchJournal } from "./launch-journal.js";
import { watchTranscriptSource } from "./transcript-source-watch.js";
import { SessionObservationIndex } from "./session-observation.js";
import { AgentProcessObservation, LiveSessionObserver } from "./live-session-observer.js";
import { runnerSessionProjectionCommandFromWire } from "./session-projection.js";
import { describeDevelopmentSession } from "./development-session.js";
import { addWorkspace, ensureDefaultWorkspace } from "./workspaces.js";
import { AgentRuntimeRegistry } from "./agent-runtime.js";
import { AgentInteractionBroker } from "./agent-interactions.js";
import { AgentControlPlane } from "./agent-control-plane.js";
import { MACHINE_LIMITS } from "./limits.js";
import { CodexAppServerHost } from "./codex-app-server-host.js";
import { CodexSplitHosts } from "./codex-split-hosts.js";
import { WorkspaceJobManager } from "./workspace-jobs.js";
import { WorkspaceDevelopmentManager } from "./workspace-development.js";
import { DevelopmentMcpManager } from "./development-mcp.js";
import { WorkspaceTerminalManager } from "./workspace-terminal.js";
import { agentHookStatus, installAgentHooks, uninstallAgentHooks } from "./agent-hooks.js";
import {
  HOOK_REPORT_TIMEOUT_MS,
  defaultHookSocketPath,
  readHookStdin,
  requestHook,
  startHookServer,
} from "./hook-ipc.js";
import {
  agentIntegrationStatus,
  codexIntegrationHomes,
  installAgentIntegrations,
  installLocalAgentIntegrations,
  localAgentIntegrationStatus,
  prepareLocalAgentIntegrations,
  refreshLocalMcpLauncher,
  uninstallAgentIntegrations,
  uninstallLocalAgentIntegrations,
} from "./agent-integrations.js";
import { AgentIntegrationPolicyReconciler } from "./agent-integration-policy.js";
import { discoverRunnerInventory, RunnerInventoryRefresh, runnerAgentPath } from "./inventory.js";
import {
  MacGuiAutomationController,
  NativeMacGuiAutomationBackend,
} from "./macos-gui-automation.js";
import { CodexExecRelayCoordinator, CodexExecServerManager } from "./codex-exec-relay.js";
import { CodexAgentRelayManager } from "./codex-agent-relay.js";
import { RunnerPeerRpcClient } from "./peer-rpc.js";
import {
  probeLocalDsh,
  runnerDshTunnelSettings,
  RunnerDshTunnelRuntime,
} from "./dsh-tunnel.js";
import { GuestSessionHost, RunnerGuestTunnelRuntime } from "./guest-sessions.js";
import {
  planRunnerReconnect,
  RUNNER_GATEWAY_HANDSHAKE_TIMEOUT_MS,
  RUNNER_RECONNECT_MIN_MS,
  validateRunnerGatewayUrl,
} from "./gateway-reconnect.js";
import {
  RUNNER_GATEWAY_PROTOCOL, RUNNER_MANAGED_COMPLETION_ACK, RUNNER_SYSTEM_STATUS_SCHEMA, RUNNER_RECOVERY_WAKE,
  runnerManagedCompletionAckFromWire,
} from "./gateway-protocol.js";
import { SystemStatusProbe } from "./system-status.js";
import {
  UPDATE_EXIT_CODE,
  bundleFrameFrom,
  fileSha256,
  selfUpdateSettings,
  stageBundle,
  superviseManagedRunner,
} from "./self-update.js";
import { ClaudeTranslationService } from "./claude-translation.js";
import { CodexAccountRouter, parseRunnerCodexAccounts } from "./codex-account-routing.js";
import { codexAccountInventory, discoverCodexAccountHomes } from "./codex-account-inventory.js";
import { claudeAccountInventory } from "./claude-account-inventory.js";
import { QuotaProbe } from "./claude-quota.js";
import { KnowledgeIndexManager, knowledgeIndexEnabled, runKnowledgeIndexJobWrapper } from "./knowledge-index.js";
import {
  defaultLocalAgentBridgeSocket,
  localAgentMcpDiscovery,
  RunnerLocalAgentBridgeRuntime,
  runLocalAgentMcpStdio,
} from "./local-agent-bridge.js";
import { CodexSessionRoots } from "./codex-session-roots.js";
import { CodexContinuationStore } from "./codex-continuation.js";
import { ManagedRecoveryJournal } from "./managed-recovery.js";
import { openManagedRemoteExecution } from "./managed-remote-execution.js";
import { runRunnerCli } from "./cli.js";
import { claimRunnerInstance } from "./resident-instance.js";
import { installedAgentRegistry, readInstalledConfig, runnerInstallPaths, type RunnerInstallConfig } from "./install-config.js";
import { resolveRunnerSites, type RunnerSite } from "./gateway-sites.js";
import { configureAgentExecutables } from "./agent-executables.js";
import { reconcileRunnerService } from "./service-manager.js";
import { clearLegacyRunnerLogs, isResidentInvocation, silenceResidentOutput } from "./resident-privacy.js";

// Windows/macOS endpoints are often personal machines short on space: keep no
// resident log there. Linux servers keep their journal/container log.
const DISCARD_RESIDENT_LOGS = process.platform !== "linux";
if (DISCARD_RESIDENT_LOGS && isResidentInvocation(process.argv.slice(2))) silenceResidentOutput();
const CLI_EXIT = await runRunnerCli();
if (CLI_EXIT !== null) process.exit(CLI_EXIT);
const SCAN_HOME = process.env.RUNNER_SCAN_HOME ?? os.homedir();
// Keep new and already-installed Runners useful without requiring a separate
// workspace add: the user's own home is the default opaque workspace root.
try {
  await ensureDefaultWorkspace(SCAN_HOME);
} catch (error) {
  console.warn("[workspace] cannot register default home workspace: " + (error instanceof Error ? error.message : String(error)));
}
// systemd does not promise to inherit the user's login-shell PATH. Keep Agent
// discovery and every later provider spawn on the same safe user-local PATH.
process.env.PATH = runnerAgentPath(SCAN_HOME, process.env.PATH);
const CODEX_HOME = path.resolve(process.env.CODEX_HOME?.trim() || path.join(SCAN_HOME, ".codex"));
const CODEX_SPLIT_HOME = path.join(SCAN_HOME, ".octopus", "codex-split-home");
const CODEX_ACCOUNT_DISCOVERY = process.env.RUNNER_CODEX_ACCOUNT_DISCOVERY !== "0";
const CODEX_ACCOUNTS = process.platform === "win32" || process.env.RUNNER_EXECUTION_ONLY === "1" ? undefined
  : await discoverCodexAccountHomes(SCAN_HOME, parseRunnerCodexAccounts(process.env.RUNNER_CODEX_ACCOUNTS), CODEX_ACCOUNT_DISCOVERY);
const CLAUDE_QUOTA = new QuotaProbe({
  credentialsPath: process.env.CLAUDE_CREDENTIALS_PATH || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(SCAN_HOME, ".claude"), ".credentials.json"),
  // Inventory retains the timestamp of each measurement; failed reads are explicit.
  staleMaxAgeMs: 0,
});
const CODEX_ACCOUNT_ROUTER = CODEX_ACCOUNTS
  ? new CodexAccountRouter({
      accounts: CODEX_ACCOUNTS,
      ...(process.env.RUNNER_CODEX_MIN_REMAINING_PERCENT
        ? { minimumRemainingPercent: Number(process.env.RUNNER_CODEX_MIN_REMAINING_PERCENT) }
        : {}),
    })
  : null;
const sessionProcesses = new AgentProcessObservation();
const SESSION_ROOT_DISCOVERY = new CodexSessionRoots({
  home: SCAN_HOME,
  codexHome: CODEX_HOME,
  accounts: CODEX_ACCOUNT_ROUTER?.roots(),
  discover: () => sessionProcesses.codexHomes(SCAN_HOME),
  onWarning: (code) => console.warn(`[session-discovery] ${code}`),
});
const SESSION_SCAN_ROOT = { home: SCAN_HOME, codexHome: CODEX_HOME };
const CODEX_HOOK_HOMES = codexIntegrationHomes(SCAN_HOME, CODEX_HOME,
  CODEX_ACCOUNT_ROUTER?.roots().map((account) => account.codexHome));

if (process.argv[2] === "mcp" && process.argv[3] === "discover") {
  console.log(JSON.stringify(
    localAgentMcpDiscovery(path.join(SCAN_HOME, ".local", "bin", "octopus-runner-mcp")),
    null,
    2,
  ));
  process.exit(0);
}

if (process.argv[2] === "mcp" && process.argv[3] === "stdio") {
  try {
    await runLocalAgentMcpStdio(
      process.env.RUNNER_LOCAL_MCP_SOCKET?.trim() || defaultLocalAgentBridgeSocket(SCAN_HOME),
    );
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[2] === "hook" && process.argv[3] === "report") {
  const provider = process.argv[4];
  try {
    if (provider === "claude" || provider === "codex") {
      const payload = await readHookStdin();
      // Fail open: observability may disappear, but the coding CLI must never
      // be blocked because its optional Runner is down or restarting.
      const reply = await requestHook(
        provider,
        payload,
        defaultHookSocketPath(),
        provider === "claude" && isBlockingClaudeHook(payload) ? 10 * 60_000 : HOOK_REPORT_TIMEOUT_MS,
      );
      if (reply?.hook_output) console.log(JSON.stringify(reply.hook_output));
      // Codex Stop hooks require a JSON object on stdout for exit code 0.
      // Other lifecycle hooks stay silent so they add no model-visible context.
      if (provider === "codex" && isHookEvent(payload, "Stop")) console.log("{}");
    }
  } catch {
    // Even when parsing or IPC fails, Codex Stop still needs syntactically
    // valid output. Reporting remains observation-only and fail-open.
    if (provider === "codex") console.log("{}");
  }
  process.exit(0);
}

if (process.argv[2] === "hooks") {
  const action = process.argv[3];
  try {
    const executable = path.resolve(process.argv[1]);
    const result = action === "install"
      ? await installAgentHooks(SCAN_HOME, executable, CODEX_HOME)
      : action === "uninstall"
        ? await uninstallAgentHooks(SCAN_HOME, CODEX_HOME)
        : action === "status"
          ? await agentHookStatus(SCAN_HOME, CODEX_HOME)
          : null;
    if (!result) {
      console.error("usage: runner.js hooks install|uninstall|status");
      process.exit(2);
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[2] === "integrations") {
  const action = process.argv[3];
  try {
    const executable = path.resolve(process.argv[1]);
    const result = action === "install"
      ? await installAgentIntegrations(SCAN_HOME, executable, CODEX_HOME, {
          additionalCodexHomes: CODEX_HOOK_HOMES.slice(1),
        })
      : action === "uninstall"
        ? await uninstallAgentIntegrations(SCAN_HOME, CODEX_HOME, {
            additionalCodexHomes: CODEX_HOOK_HOMES.slice(1),
          })
        : action === "status"
          ? await agentIntegrationStatus(SCAN_HOME, CODEX_HOME, {
              additionalCodexHomes: CODEX_HOOK_HOMES.slice(1),
            })
          : null;
    if (!result) {
      console.error("usage: runner.js integrations install|uninstall|status");
      process.exit(2);
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[2] === "workspace") {
  if (process.argv[3] !== "add" || !process.argv[4]) {
    console.error("usage: runner.js workspace add <directory> [label]");
    process.exit(2);
  }
  try {
    const added = await addWorkspace(SCAN_HOME, process.argv[4], process.argv.slice(5).join(" ") || undefined);
    // Public projection only. In particular, do not print the canonical path
    // the registry stores as device-local authority material.
    console.log(JSON.stringify(added, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
if (process.argv[2] === "knowledge-index-job") {
  const specFile = process.argv[3];
  if (!specFile) {
    console.error("knowledge-index-job requires its trusted wrapper spec");
    process.exit(2);
  }
  try {
    await runKnowledgeIndexJobWrapper(specFile);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}


const residentInstance = await claimRunnerInstance(SCAN_HOME);
if (DISCARD_RESIDENT_LOGS) await clearLegacyRunnerLogs(SCAN_HOME);

const RAW_URL = process.env.OCTOPUS_URL;
const TOKEN = process.env.OCTOPUS_RUNNER_TOKEN
  ?? readTokenFile(process.env.OCTOPUS_RUNNER_TOKEN_FILE);
const DEVICE = process.env.RUNNER_DEVICE ?? os.hostname();
const ALLOW_MACHINE_OPS = process.env.RUNNER_ALLOW_MACHINE_OPS !== "0";
const EXECUTION_ONLY = process.env.RUNNER_EXECUTION_ONLY === "1";
configureAgentExecutables(installedAgentRegistry(SCAN_HOME, { executionOnly: EXECUTION_ONLY, persistSelections: true }));
const KNOWLEDGE_INDEX_ELIGIBLE = knowledgeIndexEnabled({
  allowMachineOps: ALLOW_MACHINE_OPS,
  executionOnly: EXECUTION_ONLY,
  platform: process.platform,
  setting: process.env.RUNNER_KNOWLEDGE_INDEX,
}) && writableWorkRoot();
const DSH_TUNNEL_SETTINGS = runnerDshTunnelSettings();
const AGENT_HOOK_MODE = process.env.RUNNER_AGENT_HOOKS ?? "install";
const LOCAL_MCP_MODE = process.env.RUNNER_LOCAL_MCP ?? "managed";
const inventoryOptions = {
  allowMachineOps: ALLOW_MACHINE_OPS,
  executionOnly: EXECUTION_ONLY,
  ...(!EXECUTION_ONLY ? { dsh: () => probeLocalDsh(DSH_TUNNEL_SETTINGS) } : {}),
};

/**
 * 15s beats the ~30s idle cutoff of typical NAT/firewall middleboxes, and the
 * first ping goes out immediately on register — a fresh connection must not
 * sit silent while the middlebox clock runs.
 */
const PING_INTERVAL_MS = 15_000;
/** Re-probe installed backends and bounded execution facts without reconnecting. */
const INVENTORY_REFRESH_INTERVAL_MS = 60_000;
/** No inbound traffic for this long ⇒ half-open zombie; tear down and redial. */
const STALE_AFTER_MS = PING_INTERVAL_MS * 2 + 5_000;
/**
 * The register → registered exchange had no bound at all: a register frame
 * lost on a stalled path left the process waiting forever (nothing ran until
 * `registered`). One more bounded phase, next to the handshake timeout.
 */
const REGISTER_TIMEOUT_MS = 15_000;
/** After the gateway announces a restart: redial at this fixed pace for this long. */
const FAST_REDIAL_DELAY_MS = 2_000;
const FAST_REDIAL_WINDOW_MS = 90_000;

if (!RAW_URL || !TOKEN) {
  console.error(
    "OCTOPUS_URL and either OCTOPUS_RUNNER_TOKEN or OCTOPUS_RUNNER_TOKEN_FILE are required "
      + "(mint a token with /runner-token in Feishu).",
  );
  process.exit(1);
}
let URL: string;
try {
  URL = validateRunnerGatewayUrl(RAW_URL);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
/** Once a newer bundle is staged this process only hands over; it never redials. */
let handingOver = false;
const activeGatewaySockets = new Set<WebSocket>();
const SELF_UPDATE = selfUpdateSettings();
const ENTRY_FILE = path.resolve(process.argv[1]);
/** This build's identity on the wire; null when the entry file is unreadable. */
const SELF_SHA = fileSha256(ENTRY_FILE);
const systemStatusProbe = new SystemStatusProbe();
let knowledgeIndex: KnowledgeIndexManager | null = null;
if (KNOWLEDGE_INDEX_ELIGIBLE) {
  try {
    const inputOrigin = process.env.RUNNER_KNOWLEDGE_INPUT_ORIGIN?.trim();
    if (!inputOrigin) throw new Error("RUNNER_KNOWLEDGE_INPUT_ORIGIN is required");
    knowledgeIndex = new KnowledgeIndexManager({
      wrapperEntry: ENTRY_FILE,
      inputOrigins: [inputOrigin],
    });
    await knowledgeIndex.start();
    console.log(`[runner ${new Date().toISOString()}] knowledge index jobs ready`);
  } catch (error) {
    knowledgeIndex = null;
    console.warn(`knowledge index jobs unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
let meetingTranscription: MeetingTranscriptionManager | null = null;
let meetingTranscriptionUnavailable = transcriptionAdvertisement(false, !ALLOW_MACHINE_OPS ? "machine_ops_disabled" : process.platform !== "linux" ? "unsupported_platform" : "not_configured");
if (ALLOW_MACHINE_OPS && process.platform === "linux") {
  try {
    const config = await readMeetingTranscriptionConfig(SCAN_HOME);
    if (config) { meetingTranscription = new MeetingTranscriptionManager(config); await meetingTranscription.start(); }
  } catch (error) {
    meetingTranscription?.close(); meetingTranscription = null;
    meetingTranscriptionUnavailable = transcriptionAdvertisement(false, "configuration_invalid");
    console.warn(`meeting transcription configuration unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// One options source for registration AND periodic refresh: an inventory
// update replaces the gateway's copy wholesale, so a refresh built from a
// narrower option set silently withdraws advertised capabilities (the
// knowledge_index_jobs omission froze artifact reconciliation in production
// three times on 2026-08-24, at exactly register+5min each).
let localAgentBridge: RunnerLocalAgentBridgeRuntime | null = null;
let localMcpClients: Array<"claude" | "codex" | "omp"> = [];
const macGuiAutomation = (() => {
  if (EXECUTION_ONLY || !ALLOW_MACHINE_OPS || process.platform !== "darwin") return null;
  const backend = new NativeMacGuiAutomationBackend();
  return backend.available ? new MacGuiAutomationController(backend) : null;
})();
const workspaceJobs = ALLOW_MACHINE_OPS && process.platform === "linux" && process.env.RUNNER_WORKSPACE_JOBS === "1"
  ? new WorkspaceJobManager(SCAN_HOME, { inputOrigins: [process.env.RUNNER_WORKSPACE_INPUT_ORIGIN ?? ""].filter(Boolean) }) : null;
const workspaceDevelopmentEnabled = ALLOW_MACHINE_OPS && process.platform === "linux"
  && process.env.RUNNER_WORKSPACE_DEVELOPMENT !== "0";
const capabilityInventoryListeners = new Set<(inventory?: Awaited<ReturnType<typeof discoverRunnerInventory>>) => void>();
const capabilities = new RunnerCapabilityManager(SCAN_HOME, {
  enabled: ALLOW_MACHINE_OPS,
  onChanged: () => { for (const listener of capabilityInventoryListeners) listener(); },
});
// One failed re-probe keeps a backend's previous facts for a single refresh.
const backendProbeMemory: NonNullable<Parameters<typeof discoverRunnerInventory>[1]>["probeMemory"] = new Map();
const currentInventoryOptions = () => ({
  probeMemory: backendProbeMemory,
  ...(capabilities ? { capabilities: capabilities.advertisement() } : {}),
  codexAccounts: CODEX_ACCOUNT_ROUTER?.roots().map(({ slot, label }) => ({ slot, label })),
  codexAccountInventory: () => codexAccountInventory({ defaultHome: CODEX_HOME, accounts: CODEX_ACCOUNT_ROUTER?.roots() ?? [], includeDefault: CODEX_ACCOUNT_DISCOVERY,
    ...(CODEX_ACCOUNT_ROUTER ? { read: (home: string) => CODEX_ACCOUNT_ROUTER.rateLimitsForHome(home) } : {}),
    readModels: (codexHome, timeoutMs) => readCodexModelsFromAppServer({ codexHome, timeoutMs }) }),
  claudeAccountInventory: () => claudeAccountInventory(CLAUDE_QUOTA),
  ...inventoryOptions,
  meetingTranscription: () => meetingTranscription?.readiness() ?? Promise.resolve(meetingTranscriptionUnavailable),
  knowledgeIndexJobs: knowledgeIndex != null,
  workspaceJobs: workspaceJobs != null,
  workspaceDevelopment: workspaceDevelopmentEnabled,
  localMcp: { available: localAgentBridge != null, clients: localMcpClients },
  guiAutomation: { available: macGuiAutomation?.available === true },
});
if (!EXECUTION_ONLY && process.platform !== "win32") {
  try {
    localAgentBridge = new RunnerLocalAgentBridgeRuntime(
      process.env.RUNNER_LOCAL_MCP_SOCKET?.trim() || defaultLocalAgentBridgeSocket(SCAN_HOME),
      {
        development: async (args) => describeDevelopmentSession(SCAN_HOME, await SESSION_ROOT_DISCOVERY.refresh(), sessionObservation.ordinary, args, agentRuntime),
        // `agentRuntime` is created below; the bridge only asks after the gateway registers.
        resolveCaller: async (pid) => agentRuntime.sessionOfCaller(pid),
      },
    );
    await localAgentBridge.start();
  } catch (error) {
    localAgentBridge = null;
    console.warn(`local agent bridge unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (AGENT_HOOK_MODE !== "install" && AGENT_HOOK_MODE !== "manual" && AGENT_HOOK_MODE !== "off") {
  console.error("RUNNER_AGENT_HOOKS must be manual, off, or install");
  process.exit(1);
}

if (!EXECUTION_ONLY && AGENT_HOOK_MODE === "off") {
  try {
    const result = await uninstallAgentIntegrations(SCAN_HOME, CODEX_HOOK_HOMES[0] ?? CODEX_HOME,
      { localMcp: false, additionalCodexHomes: CODEX_HOOK_HOMES.slice(1) });
    console.log(`[runner ${new Date().toISOString()}] Agent runtime integrations off: ${result.hooks.map((row) => `${row.provider}=${row.installed}`).join(", ")}, codex-launcher=${result.codexLauncher.installed}`);
  } catch (error) {
    console.warn(`cannot remove agent integrations for RUNNER_AGENT_HOOKS=off; continuing without changes: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (!EXECUTION_ONLY && AGENT_HOOK_MODE === "install") {
  try {
    const executable = path.resolve(process.argv[1]);
    const result = await installAgentIntegrations(
      SCAN_HOME,
      executable,
      CODEX_HOOK_HOMES[0] ?? CODEX_HOME,
      { localMcp: false, additionalCodexHomes: CODEX_HOOK_HOMES.slice(1) },
    );
    console.log(`[runner ${new Date().toISOString()}] Agent runtime integrations checked: ${result.hooks.map((row) => `${row.provider}=${row.installed}`).join(", ")}, codex-launcher=${result.codexLauncher.installed}`);
    for (const row of result.hooks) if (row.warning) console.warn(row.warning);
    for (const warning of result.localMcp.warnings) console.warn(`local MCP integration skipped: ${warning}`);
  } catch (error) {
    // A user-owned launcher or malformed existing config is a reason to skip
    // automatic integration, not a reason to take the entire Runner offline.
    // The explicit `integrations install` command still exits non-zero so the
    // distributor can surface and repair the conflict.
    console.warn(`cannot automatically install agent integrations; continuing without changes: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (!["managed", "install", "manual", "off"].includes(LOCAL_MCP_MODE)) {
  console.error("RUNNER_LOCAL_MCP must be managed, install, manual, or off");
  process.exit(1);
}
if (!EXECUTION_ONLY) {
  try {
    const executable = path.resolve(process.argv[1]);
    const primaryCodexHome = CODEX_HOOK_HOMES[0] ?? CODEX_HOME;
    const additionalCodexHomes = CODEX_HOOK_HOMES.slice(1);
    const result = LOCAL_MCP_MODE === "install"
      ? await installLocalAgentIntegrations(SCAN_HOME, executable, primaryCodexHome, additionalCodexHomes)
      : LOCAL_MCP_MODE === "managed"
        ? await refreshLocalMcpLauncher(SCAN_HOME, executable, primaryCodexHome, additionalCodexHomes)
        : LOCAL_MCP_MODE === "off"
          ? await uninstallLocalAgentIntegrations(SCAN_HOME, primaryCodexHome, additionalCodexHomes)
          : await localAgentIntegrationStatus(SCAN_HOME, primaryCodexHome, additionalCodexHomes);
    // Managed injection is left as found; the first control-site policy
    // message reconciles it idempotently instead of a strip-and-reinstall.
    localMcpClients = LOCAL_MCP_MODE === "off" ? [] : result.clients;
    console.log(`[runner ${new Date().toISOString()}] local MCP mode=${LOCAL_MCP_MODE}: ${result.clients.join("+") || "no ordinary CLI injection"}`);
    for (const warning of result.warnings) console.warn(`local MCP integration skipped: ${warning}`);
  } catch (error) {
    console.warn(`cannot reconcile local MCP integrations; continuing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const runnerInventory = new RunnerInventoryRefresh(() => discoverRunnerInventory(SCAN_HOME, currentInventoryOptions()));

void capabilities?.start().catch(() => log("capability registry unavailable"));

const localIntegrationPolicy = !EXECUTION_ONLY && LOCAL_MCP_MODE === "managed"
  ? new AgentIntegrationPolicyReconciler(async (enabled) => {
      const primaryCodexHome = CODEX_HOOK_HOMES[0] ?? CODEX_HOME;
      const additionalCodexHomes = CODEX_HOOK_HOMES.slice(1);
      const result = enabled
        ? await installLocalAgentIntegrations(
            SCAN_HOME,
            path.resolve(process.argv[1]),
            primaryCodexHome,
            additionalCodexHomes,
          )
        : await prepareLocalAgentIntegrations(
            SCAN_HOME,
            path.resolve(process.argv[1]),
            primaryCodexHome,
            additionalCodexHomes,
          );
      localMcpClients = result.clients;
      const inventory = await runnerInventory.refresh();
      if (inventory) {
        // Each authenticated socket applies its own control-site projection.
        for (const publish of capabilityInventoryListeners) publish(inventory);
      }
      log(`default Agent injection ${enabled ? "enabled" : "disabled"}: ${result.clients.join("+") || "no ordinary CLI injection"}`);
    })
  : null;

const agentRuntime = new AgentRuntimeRegistry({
  stateFile: path.join(SCAN_HOME, ".octopus", "agent-runtime.json"),
});
const agentInteractions = new AgentInteractionBroker({
  stateFile: path.join(SCAN_HOME, ".octopus", "agent-interactions.json"),
});
const managedRecovery = new ManagedRecoveryJournal({
  stateFile: path.join(SCAN_HOME, ".octopus", "managed-recovery.json"),
});
await agentRuntime.load();
await agentInteractions.load();
await managedRecovery.load();
const codexContinuations = new CodexContinuationStore(path.join(SCAN_HOME, ".octopus", "codex-continuations.json"));
await codexContinuations.load();
const sitePeers = new Map<string, RunnerPeerRpcClient>();
function peerFor(siteId = "primary"): RunnerPeerRpcClient {
  let peer = sitePeers.get(siteId);
  if (!peer) { peer = new RunnerPeerRpcClient(); sitePeers.set(siteId, peer); }
  return peer;
}
const codexExecServers = new CodexExecServerManager(SCAN_HOME);
// Dev-ticket turns driven by the trusted bot run against the isolated split
// host below: this device's own model credentials, none of its user config.
const codexAgentRelay = new CodexAgentRelayManager({ ensure: () => codexRemoteHost.ensure(), acquire: () => codexRemoteHost.acquire() });
const codexHost = new CodexAppServerHost({ cwd: SCAN_HOME });
const codexSplitHosts = new CodexSplitHosts({
  home: SCAN_HOME,
  defaultCodexHome: CODEX_HOME,
  splitHome: CODEX_SPLIT_HOME,
  accounts: CODEX_ACCOUNT_ROUTER?.roots(),
  endpointFile: path.join(path.dirname(codexHost.endpointFile), "codex-split-app-server.endpoint"),
});
const codexRemoteHost = codexSplitHosts.defaultHost;
const claudeTranslations = new ClaudeTranslationService(SCAN_HOME);
const developmentMcp = new DevelopmentMcpManager();
const managedCompletions = new ManagedCompletionJournal(path.join(SCAN_HOME, '.octopus', 'managed-completions'));
const agentControlPlane = new AgentControlPlane({
  persistManagedCompletion: event => managedCompletions.record(event).catch(error => {log(`managed completion could not be persisted: ${String(error)}`); throw error;}),
  runtime: agentRuntime,
  interactions: agentInteractions,
  // A managed provider turn belongs to the Runner, not to one browser or Bot
  // connection. Transport loss must not manufacture a provider interrupt;
  // explicit Stop and provider completion remain the lifecycle boundaries.
  timeoutMs: 0,
  codexHost,
  codexRemoteHost,
  codexRemoteHostForHome: (codexHome) => codexSplitHosts.select(codexHome),
  // omp publishes its own tty→session breadcrumbs, so its TUIs are discovered
  // from this scan root instead of reporting through the hook socket.
  scanHome: SCAN_HOME,
  claudeTranslations,
  recoveryJournal: managedRecovery,
  codexContinuations,
  recoveryScopes: { request: (provider, sessionId, gatewaySite) => peerFor(gatewaySite).request(provider, sessionId) },
  openRecoveryRemote: async (record, scope) => await openManagedRemoteExecution({
    provider: record.provider,
    cwd: record.cwd,
    scope,
    developmentMcp,
    gatewaySite: record.remotePlacement?.gatewaySite,
    codexExecRelay: new CodexExecRelayCoordinator(peerFor(record.remotePlacement?.gatewaySite)),
  }),
  onRecoveryEvent: (event, record, detail) => {
    const suffix = detail ? `: ${detail.slice(0, 240)}` : "";
    log(`managed recovery ${event} provider=${record.provider} session=${record.session.currentProviderId.slice(0, 12)}${suffix}`);
  },
});
import { WorkspaceFileTransferStore } from "./file-transfer.js";

const workspaceTerminals = new WorkspaceTerminalManager(SCAN_HOME);
const fileTransfers = new WorkspaceFileTransferStore();
const sessionOperations = new RunnerSessionOperations(SCAN_HOME, (sessionId, turnId) => managedRecovery.capacityReceipt(sessionId, turnId));
const sessionObservation = {
  ordinary: new SessionObservationIndex({ home: SCAN_HOME, roots: () => SESSION_ROOT_DISCOVERY.refresh(),
    onChanged: () => { for (const projector of activeSessionProjectors) projector.notifyChanged(); },
    // Claude Code fires no hook when Esc interrupts a turn; its transcript does
    // record the end. Newer transcript evidence retires a stale working state.
    onSummary: (summary) => {
      if (summary.source !== "claude" || summary.activity?.state !== "idle" || !summary.activity.since) return;
      void agentRuntime.observeTurnEnded("claude", summary.id, { after: summary.activity.since }).catch(() => {});
    },
    onError: (error) => log(`session observation failed: ${String(error)}`) }),
  split: new SessionObservationIndex({ home: SCAN_HOME, roots: async () => codexSplitHosts.scanRoot, selectedOnly: true,
    onChanged: () => { for (const projector of activeSessionProjectors) projector.notifyChanged(); },
    onError: (error) => log(`split session observation failed: ${String(error)}`) }),
};
const liveSessionObserver = new LiveSessionObserver({ home: SCAN_HOME, processes: sessionProcesses,
  runtime: agentRuntime, control: agentControlPlane, ...sessionObservation,
  onError: (error) => log(`live session observation failed: ${String(error)}`) });
function dispatcherFor(site: RunnerSite, token: string): RunnerRpcDispatcher {
const origin = new globalThis.URL(site.runnerUrl); origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
const workspaceDevelopment = workspaceDevelopmentEnabled ? new WorkspaceDevelopmentManager(SCAN_HOME, {
  inputOrigins: [origin.origin, process.env.RUNNER_WORKSPACE_INPUT_ORIGIN ?? ""].filter(Boolean),
}) : null;
return new RunnerRpcDispatcher(SCAN_HOME, {
  sessionOperations,
  sessionObservation,
  developmentMcp,
  ...(site.id !== "primary" ? { gatewaySite: site.id } : {}),
  allowMachineOps: ALLOW_MACHINE_OPS,
  executionOnly: EXECUTION_ONLY,
  agentRuntime,
  agentInteractions,
  agentControlPlane,
  workspaceTerminals,
  fileTransfers,
  codexExecServers,
  codexExecRelay: new CodexExecRelayCoordinator(peerFor(site.id)),
  codexAgentRelay,
  sessionScanRoot: SESSION_SCAN_ROOT,
  refreshSessionScanRoot: () => SESSION_ROOT_DISCOVERY.refresh(),
  codexAgentSessionScanRoot: codexSplitHosts.scanRoot,
  sessionPlusSessionScanRoot: codexSplitHosts.scanRoot,
  ...(CODEX_ACCOUNT_ROUTER ? { codexAccountRouter: CODEX_ACCOUNT_ROUTER, requireCodexAccountSelection: !CODEX_ACCOUNT_DISCOVERY } : {}),
  claudeTranslations,
  ...(capabilities && site.controlsMachine ? { capabilities: { call: (args: Record<string, unknown>) => capabilities.call(args, createHash("sha256").update(site.id).update(token).digest("hex")) } } : {}),
  ...(knowledgeIndex && site.controlsMachine ? { knowledgeIndex } : {}),
  ...(meetingTranscription && site.controlsMachine ? { meetingTranscription } : {}),
  ...(workspaceJobs && site.controlsMachine ? { workspaceJobs } : {}),
  ...(workspaceDevelopment ? { workspaceDevelopment } : {}),
  ...(macGuiAutomation && site.controlsMachine ? { guiAutomation: macGuiAutomation } : {}),
  // Machine ops touch this machine for real: Linux keeps a local trail the
  // owner can audit without the bot host; Windows/macOS keep no resident log.
  ...(DISCARD_RESIDENT_LOGS ? {} : { onMachineOp: (method: string, summary: string) => log(`site=${site.id} machine-op ${method} ${summary}`) }),
});
}
// Codex remains optional. A missing/old CLI must not take the whole Runner
// down; managed calls will report the same setup failure and use the legacy
// adapter when it is still safe to do so.
if (!EXECUTION_ONLY) void codexHost.ensure().then(() => {
  console.log(`[runner ${new Date().toISOString()}] local Codex app-server ready at ${codexHost.endpoint}`);
}).catch((error) => {
  console.warn(`[runner ${new Date().toISOString()}] local Codex app-server unavailable: ${error instanceof Error ? error.message : String(error)}`);
});
/**
 * Everything this process holds on the machine that a successor would need
 * (the hook socket, Codex app-servers, relay servers, tunnels). Idempotent:
 * runs at exit and, earlier, when handing over to an updated bundle.
 */
let hookServer: Awaited<ReturnType<typeof startHookServer>> | null = null;
const activeSessionProjectors = new Set<RunnerSessionProjector>();
const siteConnections = new Map<string, { key: string; stop(): void }>();
let sitesTimer: NodeJS.Timeout | null = null;
/** Guest clients' agents run here as this user, with this user's own Claude login (opt-in via config). */
const guestSessions = new GuestSessionHost({
  config: cachedInstalledConfig((config) => config.guest_sessions),
  logins: cachedInstalledConfig((config) => config.model_egress),
  stateDir: runnerInstallPaths(SCAN_HOME).root,
  log,
});
let guestSessionsStarting = false;
let localResourcesReleased = false;
let localResourcesRelease: Promise<void> | null = null;
const serviceMigrationAbort = new AbortController();
let serviceMigration: Promise<void> | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let reconciling: Promise<void> | null = null;
function releaseLocalResources(): Promise<void> {
  if (localResourcesRelease) return localResourcesRelease;
  localResourcesReleased = true;
  localResourcesRelease = closeLocalResources();
  return localResourcesRelease;
}
async function closeLocalResources(): Promise<void> {
  await liveSessionObserver.close();
  await Promise.all([sessionObservation.ordinary.close(), sessionObservation.split.close()]);
  if (sitesTimer) clearInterval(sitesTimer);
  for (const connection of siteConnections.values()) connection.stop();
  siteConnections.clear();
  guestSessions.close();
  serviceMigrationAbort.abort();
  await serviceMigration;
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  await reconciling;
  // Arm recovery before terminating shared provider hosts: their close events
  // can settle turn promises synchronously enough to otherwise clear the
  // durable active marker during a self-update.
  agentControlPlane.prepareForRestart();
  knowledgeIndex?.close();
  meetingTranscription?.close();
  macGuiAutomation?.close();
  agentInteractions.close();
  const providerHostsClosing = Promise.all([codexHost.close(), codexSplitHosts.close()]);
  for (const peer of sitePeers.values()) peer.close();
  await localIntegrationPolicy?.close();
  const closing = [
    providerHostsClosing,
    capabilities?.close(),
    fileTransfers.close(),
    developmentMcp.close(),
    codexExecServers.close(),
    codexAgentRelay.close(),
    agentControlPlane.close({ preserveRecoveries: true }),
    hookServer?.close(),
    localAgentBridge?.close(),
  ];
  const results = await Promise.allSettled(closing.map((operation) => Promise.resolve(operation)));
  await residentInstance.close();
  for (const result of results) {
    if (result.status === "rejected") {
      log(`resource cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  }
}

if (EXECUTION_ONLY) {
  log("execution-only mode: session and agent integrations are disabled");
} else if (process.platform === "win32") {
  // Preserve the pre-hook Runner on Windows. Exact process takeover is a
  // Linux capability; a future named-pipe adapter can add observation without
  // making the existing outbound Runner connection contingent on it.
  console.warn("agent-hook observation is unavailable on Windows; continuing without the private hook socket");
} else {
  try {
    hookServer = await startHookServer(
      agentRuntime,
      defaultHookSocketPath(),
      agentInteractions,
      async (provider, payload) => {
        // A lifecycle hook is trusted local evidence that this provider may
        // have just created or appended its transcript. Do this before the
        // coalesced projector read so a scan cached immediately before launch
        // cannot hide the new live session until the next hook/reconcile.
        const hook = payload as { session_id?: string; hook_event_name?: string; transcript_path?: string };
        if (hook.session_id) await sessionObservation.ordinary.notify(
          { source: provider, id: hook.session_id }, hook.transcript_path).catch(() => {});
        if (provider === "claude") await claudeTranslations.observeClaudeHook(payload);
        if (hook.session_id) for (const projector of activeSessionProjectors) {
          projector.notifySessionChanged(provider, hook.session_id);
        }
      },
      {
        reachable: (sessionId) => agentControlPlane.claudeQuestionReachable(sessionId),
        answer: (sessionId, question, prompt) => agentControlPlane.answerClaudeQuestion(sessionId, question, prompt),
      },
    );
    // A stale record becomes honest even when no new hook fires.
    reconcileTimer = setInterval(() => {
      if (localResourcesReleased || reconciling) return;
      reconciling = agentRuntime.reconcile().catch(() => {}).finally(() => { reconciling = null; });
    }, 5_000);
    reconcileTimer.unref?.();
    process.once("exit", () => { void releaseLocalResources(); });
  } catch (error) {
    console.error(`cannot start private agent-hook socket: ${error instanceof Error ? error.message : String(error)}`);
    codexHost.terminate();
    process.exit(1);
  }
}

// Managed/native-file observation is independent of Linux hook IPC support.
if (!EXECUTION_ONLY) liveSessionObserver.start();

function log(msg: string): void {
  console.log(`[runner ${new Date().toISOString()}] ${msg}`);
}

// Fatal/synchronous exits cannot await the ordinary drain. Keep the exact
// owned provider groups from outliving this resident, including hooks-off mode.
process.once("exit", () => {
  agentControlPlane.prepareForRestart();
  codexHost.terminate();
  codexSplitHosts.terminate();
});

let managedRecoveryTimer: NodeJS.Timeout | null = null;
function startManagedRecovery(delayMs = 0): void {
  if (EXECUTION_ONLY) return;
  if (managedRecoveryTimer) {
    if (delayMs > 0) return;
    clearTimeout(managedRecoveryTimer);
    managedRecoveryTimer = null;
  }
  managedRecoveryTimer = setTimeout(() => {
    managedRecoveryTimer = null;
    if (localResourcesReleased) return;
    void agentControlPlane.recoverInterrupted(delayMs === 0).then(({ recovered, unknown }) => {
      if (recovered || unknown) log(`managed recovery settled recovered=${recovered} unknown=${unknown}`);
    }).catch((error) => {
      log(`managed recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (!localResourcesReleased && agentControlPlane.hasPendingRecovery()) startManagedRecovery(5_000);
    });
  }, delayMs);
  managedRecoveryTimer.unref?.();
}

/**
 * The staged bundle is in place; this process must now get out of its way.
 * An internal shim child exits with the update code. Other processes retain
 * the known running code as the shim, including under an OS service manager.
 */
let supervisedRun: Promise<number> | null = null;
async function handOverTo(staged: { path: string; sha: string; fallback?: string }): Promise<never> {
  await releaseLocalResources();
  if (shutdownStarted) process.exit(0);
  // systemd/launchd can restart a crashed process but cannot prove a new build
  // healthy. Keep this old process as the update shim even under an OS service.
  // Only a child already supervised by our shim exits directly for replacement.
  if (SELF_UPDATE.supervised && process.env.OCTOPUS_RUNNER_UPDATE_SHIM === "1") {
    log(`bundle ${staged.sha.slice(0, 12)} staged at ${staged.path}; exiting ${UPDATE_EXIT_CODE} for the supervisor to restart from it`);
    process.exit(UPDATE_EXIT_CODE);
  }
  log(`bundle ${staged.sha.slice(0, 12)} staged at ${staged.path}; this process becomes its supervisor`);
  supervisedRun = superviseManagedRunner({
    managed: staged.path,
    fallback: staged.fallback ?? ENTRY_FILE,
    argv: process.argv.slice(2),
    env: process.env,
    log,
  });
  const code = await supervisedRun;
  process.exit(code);
}

let shutdownStarted = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  handingOver = true;
  log(`received ${signal}; stopping managed resources`);
  for (const socket of activeGatewaySockets) socket.close(1000, "runner stopping");
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    timer.unref?.();
  });
  await Promise.race([Promise.all([releaseLocalResources(), supervisedRun]), timeout]);
  process.exit(0);
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

function isHookEvent(value: unknown, event: string): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).hook_event_name === event);
}

function isBlockingClaudeHook(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.hook_event_name === "PermissionRequest"
    || (row.hook_event_name === "PreToolUse" && row.tool_name === "AskUserQuestion");
}

/** Each gateway owns its transport state; provider/session/workspace owners above are shared. */
function openSite(site: RunnerSite, token: string): () => void {
  const peerRpc = peerFor(site.id);
  const rpcDispatcher = dispatcherFor(site, token);
  const dshTunnels = new RunnerDshTunnelRuntime(site.runnerUrl, DSH_TUNNEL_SETTINGS, log);
  const modelTunnels = new RunnerGuestTunnelRuntime(site.runnerUrl, guestSessions, log);
  let backoff = RUNNER_RECONNECT_MIN_MS;
  let fastRedialUntil = 0;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let currentSocket: WebSocket | null = null;
  let cleanupCurrent = (): void => {};
  const updateEnabled = SELF_UPDATE.enabled && site.providesUpdates;
  const inventoryForSite = (inventory: Awaited<ReturnType<typeof discoverRunnerInventory>>) => {
    if (site.controlsMachine) {
      return {
        ...inventory,
        ...(capabilities ? { capabilities: capabilities.advertisement() } : {}),
        ...(!EXECUTION_ONLY ? guestSessions.advertisement() : {}),
      };
    }
    const { capabilities: _capabilities, gui_automation: _gui, knowledge_index_jobs: _knowledge, meeting_transcription_jobs: _transcription, workspace_jobs: _workspaceJobs, local_mcp: _mcp, ...shared } = inventory;
    return shared;
  };
function connect(): void {
  if (stopped || handingOver) return;
  log(
    `site=${site.id} connecting to ${site.runnerUrl} as device "${DEVICE}" (scan home: ${SCAN_HOME}, ` +
      `machine ops: ${ALLOW_MACHINE_OPS ? "enabled" : "disabled"}, ` +
      `mode: ${EXECUTION_ONLY ? "execution-only" : "full"})`,
  );
  const ws = new WebSocket(site.runnerUrl, {
    handshakeTimeout: RUNNER_GATEWAY_HANDSHAKE_TIMEOUT_MS,
  });
  currentSocket = ws;
  activeGatewaySockets.add(ws);
  let pingTimer: NodeJS.Timeout | null = null;
  let inventoryTimer: NodeJS.Timeout | undefined;
  let registerTimer: NodeJS.Timeout | null = null;
  let detachSessionChanges: (() => void) | null = null;
  let sessionProjector: RunnerSessionProjector | null = null;
  let lastInboundAt = Date.now();
  let bundleRequested = false;
  let authenticated = false;
  const publishCapabilities = (current?: Awaited<ReturnType<typeof discoverRunnerInventory>>): void => {
    if (!authenticated || tornDown) return;
    void (current ? Promise.resolve(current) : runnerInventory.latest()).then(inventory => {
      if (authenticated && !tornDown && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "inventory_changed", inventory: inventoryForSite(inventory) }));
    }).catch(() => undefined);
  };
  capabilityInventoryListeners.add(publishCapabilities);
  ws.once("close", () => capabilityInventoryListeners.delete(publishCapabilities));
  let tornDown = false;
  const detachManagedCompletions = agentControlPlane.onManagedCompletion((completion) => {
    if (authenticated && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "managed_session_completion", completion }));
    }
  });

  // Server keepalive pings arrive as protocol frames (ws auto-pongs); count
  // them — and every other inbound frame — as proof the link is alive.
  ws.on("ping", () => {
    lastInboundAt = Date.now();
  });
  ws.on("pong", () => {
    lastInboundAt = Date.now();
  });

  ws.on("open", async () => {
    lastInboundAt = Date.now();
    // Never waits on a refresh in flight once one inventory has completed: on
    // 2026-10-26 a hung probe kept a Runner from registering for 17 hours.
    const inventory = await runnerInventory.forRegistration();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "register",
        protocol: RUNNER_GATEWAY_PROTOCOL,
        token,
        device: DEVICE,
        inventory: inventoryForSite(inventory),
        ...(SELF_SHA ? { bundle_sha: SELF_SHA } : {}),
        self_update_enabled: updateEnabled,
        ...(process.env.RUNNER_SELF_UPDATE_REJECTED_SHA
          ? { rejected_bundle_sha: process.env.RUNNER_SELF_UPDATE_REJECTED_SHA } : {}),
      }));
      // A register that never gets its answer (frame lost on a stalled path,
      // gateway mid-restart) used to wait forever: nothing ran until
      // `registered`. Now it is one more bounded phase.
      registerTimer = setTimeout(() => {
        registerTimer = null;
        log(`no registered reply within ${REGISTER_TIMEOUT_MS / 1000}s; redialing`);
        ws.terminate();
      }, REGISTER_TIMEOUT_MS);
    }
  });

  ws.on("message", (data) => {
    lastInboundAt = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === "registered") {
      if (authenticated || tornDown || stopped) return;
      authenticated = true;
      // Receipts this site's Head already acknowledged are not replayed.
      void managedCompletions.recent(site.id).then(events => {
        for (const completion of events) {
          if (ws.readyState !== WebSocket.OPEN || tornDown) break;
          ws.send(JSON.stringify({type: 'managed_session_completion', completion}));
        }
      }).catch(error => log(`managed completion replay failed: ${String(error)}`));
      backoff = RUNNER_RECONNECT_MIN_MS;
      if (registerTimer) clearTimeout(registerTimer);
      registerTimer = null;
      log(`site=${site.id} registered as ${String(msg.username)}/${String(msg.device)}`);
      if (site.controlsMachine) macGuiAutomation?.setExposed(msg.gui_automation_enabled === true);
      if (site.controlsMachine && localIntegrationPolicy) {
        void localIntegrationPolicy.setDefaultInjection(msg.default_agent_injection === true).catch((error) => {
          log(`cannot apply registered Agent injection policy: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      const updatePending = typeof msg.bundle_sha === "string"
        && msg.update_available === true
        && updateEnabled
        && msg.bundle_sha !== process.env.RUNNER_SELF_UPDATE_REJECTED_SHA;
      if (typeof msg.bundle_sha === "string" && msg.update_available === true && !bundleRequested) {
        if (msg.bundle_sha === process.env.RUNNER_SELF_UPDATE_REJECTED_SHA) {
          log(`runner build ${msg.bundle_sha.slice(0, 12)} failed startup; waiting for a different active build`);
        } else if (updateEnabled) {
          bundleRequested = true;
          log(`gateway serves runner build ${msg.bundle_sha.slice(0, 12)}; this is ${SELF_SHA?.slice(0, 12) ?? "unknown"} — requesting it`);
          ws.send(JSON.stringify({ type: "bundle_request" }));
          // Do not wake interrupted turns on a build that is about to hand
          // over. If the bundle reply is lost/refused, bounded fallback below
          // still recovers them on this process.
          startManagedRecovery(30_000);
        } else {
          log(`site=${site.id} has no update authority; staying on ${SELF_SHA?.slice(0, 12) ?? "unknown"}`);
        }
      }
      if (!EXECUTION_ONLY) {
        peerRpc.attach(ws);
        if (site.controlsMachine) localAgentBridge?.attach(ws);
        if (!updatePending) startManagedRecovery();
        sessionProjector?.close();
        const projector = new RunnerSessionProjector({
          dispatcher: rpcDispatcher,
          watchTranscriptSource: (source, sessionId, onChanged, onChecked) => {
            const releases = [sessionObservation.ordinary.retain({ source, id: sessionId }),
              sessionObservation.split.retain({ source, id: sessionId })];
            const close = watchTranscriptSource({
            resolvePath: async () => {
              const placement = source === "codex"
                ? await new LaunchJournal(SCAN_HOME).sessionPlacement(sessionId) : null;
              const root = placement?.source === source ? codexSplitHosts.scanRoot : await SESSION_ROOT_DISCOVERY.refresh();
              const observation = placement?.source === source ? sessionObservation.split : sessionObservation.ordinary;
              const indexed = await observation.resolve({ source, id: sessionId });
              if (indexed) return indexed.path;
              return (await resolveSessionPath(root, source, sessionId, undefined)).path;
            },
            onChanged, onChecked,
            });
            return () => { close(); for (const release of releases) release(); };
          },
          send: (projection) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "session_projection", projection }));
            }
          },
          onError: (operation, error) => log(`session projection ${operation} failed: ${error.message}`),
        });
        sessionProjector = projector;
        activeSessionProjectors.add(projector);
        detachSessionChanges = (() => {
          const runtime = agentRuntime.onChanged((change) => {
            if (!change) { projector.notifyChanged(); return; }
            if (sessionObservation.ordinary.isLive(change.provider, change.sessionId)
              || sessionObservation.split.isLive(change.provider, change.sessionId)) {
              projector.notifySessionChanged(change.provider, change.sessionId);
            }
          });
          const interactions = agentInteractions.onChanged((change) => change
            ? projector.notifySessionChanged(change.provider, change.sessionId)
            : projector.notifyChanged());
          const managedTranscript = agentControlPlane.onManagedTranscriptActivity(
            (provider, sessionId) => projector.notifyTranscriptChanged(provider, sessionId),
          );
          return () => { runtime(); interactions(); managedTranscript(); };
        })();
        projector.start();
      }
      inventoryTimer = setInterval(() => {
        void runnerInventory.refresh().then((inventory) => {
          if (inventory && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "inventory_changed", inventory: inventoryForSite(inventory) }));
          }
        });
      }, INVENTORY_REFRESH_INTERVAL_MS);
      const sendPing = (): void => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Keep liveness independent of the short initial CPU sample. Resource
        // telemetry follows on the same authenticated socket and old gateways
        // safely ignore the additive frame.
        ws.send(JSON.stringify({ type: "ping" }));
        void systemStatusProbe.snapshot().then((status) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "system_status",
              status: { schema: RUNNER_SYSTEM_STATUS_SCHEMA, ...status },
            }));
          }
        }).catch(() => {
          // Telemetry is advisory. A local OS probe failure must never take the
          // Runner offline or disturb the keepalive that was already sent.
        });
      };
      sendPing(); // immediately — don't let the middlebox idle clock run
      pingTimer = setInterval(() => {
        // A middlebox that silently dropped us leaves the socket half-open:
        // sends succeed into a black hole and no close event ever fires.
        // Detect it by inbound silence and force a reconnect.
        if (Date.now() - lastInboundAt > STALE_AFTER_MS) {
          log("no traffic from gateway; assuming half-open connection, redialing");
          ws.terminate();
          return;
        }
        sendPing();
      }, PING_INTERVAL_MS);
      return;
    }
    if (msg.type === RUNNER_RECOVERY_WAKE) {
      if (authenticated && !tornDown && !stopped && !handingOver && !EXECUTION_ONLY
        && !(updateEnabled && bundleRequested) && agentControlPlane.hasPendingRecovery()) startManagedRecovery();
      return;
    }
    if (msg.type === "agent_integration_policy" && typeof msg.default_injection === "boolean") {
      if (site.controlsMachine && localIntegrationPolicy) {
        void localIntegrationPolicy.setDefaultInjection(msg.default_injection).catch((error) => {
          log(`cannot apply Agent injection policy update: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return;
    }
    if (msg.type === RUNNER_MANAGED_COMPLETION_ACK) {
      const ack = runnerManagedCompletionAckFromWire(msg);
      if (authenticated && !tornDown && ack) {
        void managedCompletions.acknowledge(site.id, ack)
          .catch((error) => log(`managed completion acknowledgement not kept: ${String(error)}`));
      }
      return;
    }
    if (msg.type === "gui_automation_policy" && typeof msg.enabled === "boolean") {
      if (site.controlsMachine) macGuiAutomation?.setExposed(msg.enabled);
      return;
    }
    if (!EXECUTION_ONLY && dshTunnels.handle(ws, msg)) return;
    if (!EXECUTION_ONLY && site.controlsMachine && modelTunnels.handle(msg)) return;
    if (!EXECUTION_ONLY && peerRpc.handle(msg)) return;
    if (!EXECUTION_ONLY && site.controlsMachine && localAgentBridge?.handle(msg)) return;
    if (msg.type === "error") {
      log(`gateway refused: ${String(msg.message)}`);
      return;
    }
    if (msg.type === "restarting") {
      // A deploy, not a revocation: the listener is back within a minute.
      // Redial at a fixed short pace instead of walking up the backoff.
      fastRedialUntil = Date.now() + FAST_REDIAL_WINDOW_MS;
      backoff = RUNNER_RECONNECT_MIN_MS;
      log("gateway is restarting; will redial eagerly");
      return;
    }
    if (msg.type === "bundle") {
      if (!bundleRequested || !updateEnabled) return;
      if (msg.ok !== true) {
        log(`gateway declined the bundle: ${String(msg.error ?? "unknown reason")}`);
        startManagedRecovery();
        return;
      }
      const frame = bundleFrameFrom(msg);
      if (!frame) {
        log("gateway sent a malformed bundle frame; ignoring");
        startManagedRecovery();
        return;
      }
      if (frame.sha === SELF_SHA) {
        log("gateway sent the build already running; ignoring");
        startManagedRecovery();
        return;
      }
      if (frame.sha === process.env.RUNNER_SELF_UPDATE_REJECTED_SHA) {
        log("gateway sent a quarantined build; keeping the running version");
        startManagedRecovery();
        return;
      }
      let staged: { path: string; sha: string; fallback?: string };
      try {
        staged = stageBundle(SCAN_HOME, frame, { file: ENTRY_FILE, sha: SELF_SHA });
      } catch (error) {
        log(`bundle rejected: ${error instanceof Error ? error.message : String(error)}`);
        startManagedRecovery();
        return;
      }
      handingOver = true;
      if (managedRecoveryTimer) clearTimeout(managedRecoveryTimer);
      managedRecoveryTimer = null;
      teardownConnection();
      ws.close(1000, "self-update");
      void handOverTo(staged);
      return;
    }
    if (msg.type === "session_projection_command") {
      const command = runnerSessionProjectionCommandFromWire(msg.command);
      if (command) sessionProjector?.handleCommand(command);
      return;
    }
    if (msg.type === "rpc" && typeof msg.id === "string" && typeof msg.method === "string") {
      const req = { id: msg.id, method: msg.method, args: (msg.args ?? {}) as Record<string, unknown> };
      const t0 = Date.now();
      log(`site=${site.id} rpc ${req.method}`);
      void rpcDispatcher.handle(req).then((resp) => {
        // Completion log — the "started" line alone made it impossible to
        // tell whether a long-running append_session had finished, failed,
        // or was still hanging. Now every rpc has a paired done entry.
        const ms = Date.now() - t0;
        const errSnip = resp.ok ? "" : ` err=${String(resp.error ?? "").slice(0, 200)}`;
        log(`site=${site.id} rpc ${req.method} done in ${ms}ms ok=${resp.ok}${errSnip}`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(resp));
      });
    }
  });

  const teardownConnection = (): void => {
    if (tornDown) return;
    tornDown = true;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    if (registerTimer) clearTimeout(registerTimer);
    registerTimer = null;
    clearInterval(inventoryTimer);
    inventoryTimer = undefined;
    sessionProjector?.close();
    if (sessionProjector) activeSessionProjectors.delete(sessionProjector);
    sessionProjector = null;
    detachManagedCompletions();
    detachSessionChanges?.();
    dshTunnels.disconnect();
    detachSessionChanges = null;
    peerRpc.detach(ws);
    if (site.controlsMachine) localAgentBridge?.detach(ws);
    // The gateway connection is the route holding every remote GUI lease. A
    // broken route must also remove the target-local authority and indicator;
    // reconnect registration may expose the device again, but never revives a
    // lease whose controller disappeared.
    if (site.controlsMachine) macGuiAutomation?.setExposed(false);
  };
  cleanupCurrent = teardownConnection;

  const scheduleReconnect = (): void => {
    teardownConnection();
    if (handingOver || stopped) return;
    if (Date.now() < fastRedialUntil) {
      // The gateway said it is restarting: no jittered backoff, just redial.
      backoff = RUNNER_RECONNECT_MIN_MS;
      log(`disconnected; reconnecting in ${(FAST_REDIAL_DELAY_MS / 1000).toFixed(1)}s (gateway restart window)`);
      reconnectTimer = setTimeout(connect, FAST_REDIAL_DELAY_MS);
      return;
    }
    const reconnect = planRunnerReconnect(backoff);
    backoff = reconnect.nextBackoffMs;
    log(`disconnected; reconnecting in ${(reconnect.delayMs / 1000).toFixed(1)}s`);
    reconnectTimer = setTimeout(connect, reconnect.delayMs);
  };

  ws.on("close", scheduleReconnect);
  ws.on("close", () => { activeGatewaySockets.delete(ws); void fileTransfers.closeSite(site.id); });
  ws.on("error", (err) => {
    log(`socket error: ${(err as Error).message}`);
    ws.close();
  });
}

connect();
return () => {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  cleanupCurrent();
  peerRpc.close();
  dshTunnels.disconnect();
  modelTunnels.disconnect();
  currentSocket?.close(1000, "site configuration changed");
};
}

function reconcileSites(): void {
  const config = existsSync(runnerInstallPaths(SCAN_HOME).config) ? readInstalledConfig(SCAN_HOME) : undefined;
  const sites = resolveRunnerSites({ runnerUrl: URL, token: TOKEN }, config);
  const resolved = sites.map((site) => {
    const token = site.token ?? readTokenFile(site.tokenFile);
    if (!token) throw new Error(`Cannot load Runner token for site ${site.id}`);
    // Contents stay private; comparing them also notices an atomic token-file rotation.
    return { site, token, key: JSON.stringify([site, token]) };
  });
  for (const [id, connection] of siteConnections) {
    if (!resolved.some((row) => row.site.id === id && row.key === connection.key)) {
      connection.stop(); siteConnections.delete(id);
    }
  }
  for (const { site, token, key } of resolved) {
    if (!siteConnections.has(site.id)) siteConnections.set(site.id, { key, stop: openSite(site, token) });
  }
}
startGuestSessions();
reconcileSites();
sitesTimer = setInterval(() => {
  if (localResourcesReleased || handingOver) return;
  startGuestSessions();
  try { reconcileSites(); } catch (error) {
    log(`site configuration rejected; keeping current connections: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 5_000);
sitesTimer.unref?.();
if (process.argv[2] === "daemon" && !localResourcesReleased) {
  serviceMigration = reconcileRunnerService(SCAN_HOME, serviceMigrationAbort.signal).then(() => {}).catch((error) => {
    if (!serviceMigrationAbort.signal.aborted) {
      log(`service migration will retry on next start: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * Guest sessions' loopback HTTPS port. A port still held by a previous
 * process (handover, crash) is retried until it frees; the guests' CLIs
 * retry on their own meanwhile.
 */
function startGuestSessions(): void {
  if (EXECUTION_ONLY || guestSessionsStarting || guestSessions.running || localResourcesReleased) return;
  guestSessionsStarting = true;
  guestSessions.start()
    .catch((error: Error) => log(`guest sessions port unavailable (${error.message}); retrying`))
    .finally(() => { guestSessionsStarting = false; });
}

/** One section of the installed config, re-read at most every 5 seconds. */
function cachedInstalledConfig<T>(pick: (config: RunnerInstallConfig) => T | undefined): () => T | undefined {
  let value: T | undefined;
  let readAt = 0;
  return () => {
    if (Date.now() - readAt < 5_000) return value;
    readAt = Date.now();
    try {
      value = EXECUTION_ONLY || !existsSync(runnerInstallPaths(SCAN_HOME).config)
        ? undefined
        : pick(readInstalledConfig(SCAN_HOME));
    } catch {
      value = undefined;
    }
    return value;
  };
}

function readTokenFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch (error) {
    console.error("cannot read OCTOPUS_RUNNER_TOKEN_FILE: "
      + (error instanceof Error ? error.message : String(error)));
    return undefined;
  }
}

function writableWorkRoot(): boolean {
  try {
    accessSync("/work", fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
