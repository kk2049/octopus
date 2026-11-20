import { RunnerExtensionCapabilities } from "./runner/extension-capability.js";
import { ownerFileSessionTarget } from "./workspace-files/owner-file-target.js";
import { ManagedExecutionSupervisor } from "./managed-execution/supervisor.js";
import { runnerDisplayName } from "./runner/display-name.js";
import { runnerOnlineNotice, runnerOnlineNotices } from "./runner/online-notice.js";
import { createHash, randomUUID } from "node:crypto";
import { WORKSPACE_DEVELOPMENT_PROTOCOL } from "@claude-bot/runner/workspace-development-protocol";
import { configureDashboardAssetArchive } from "./dashboard/assets.js";
import { ticketResourceOwner } from "./devpipe/ticket-workspaces.js";
import { runChild } from "./devpipe/child-output.js";
import { TicketRunnerAccess, TICKET_RUNNER_SUBJECT, seedTicketRunnerGrants } from "./devpipe/runner-ticket.js";
import { sessionOperationReceiptFromWire } from "@claude-bot/runner/gateway-protocol";
import { receiptTargetOf } from "./sessionhub/operation-receipts.js";
import { SessionSharingService } from "./session-plus/sharing.js";
import { DiscussionService } from './discussions/service.js';
import { DiscussionModelClient } from './discussions/model.js';
import { FeishuDiscussionTransport } from './discussions/feishu.js';
import { DiscussionCapabilities } from './discussions/capability.js';
import { SharedAppManagement } from "./app-registry/shared-management.js";
import { recordStartupFailure, startupFailureDetail } from "./devpipe/startup-failure.js";
import { StartupIngress } from "./devpipe/startup-ingress.js";
/**
 * The bot's composition root — the control plane, and nothing else.
 *
 * ── What this is ────────────────────────────────────────────────────────
 *
 * This file composes what production runs — sessions, permissions, tickets,
 * deploy, runner administration, Apps. It is the package's only entry point:
 * the v2 composition root (`index.ts`: chat channels, agent sessions, the
 * secretary network, the v3 App Host) was retired on 2026-10-15 together with
 * the modules only it reached.
 *
 * It began as a second entry point rather than a flag inside the first one
 * because a flag is a claim you have to re-audit at every branch: "did THIS
 * service check it?". A composition root answers structurally — a service that
 * is never constructed cannot be reached, cannot hold a credential, and cannot
 * start work.
 *
 * ── The rule for what may be constructed ────────────────────────────────
 *
 * Two mechanisms, and they are not redundant:
 *
 *  1. **This file** builds only the services listed in `BOOTSTRAP_SERVICES`.
 *     There is no general chat router or chat channel provider. The reviewed
 *     Feishu OAuth receiver dispatches registered topic groups to the narrow
 *     discussion service and nothing else.
 *  2. **The dashboard surface** (`dashboard/authz.ts`) 404s every route outside
 *     `BOOTSTRAP_ROUTE_IDS`. So even where a handler survives inside the reused
 *     `DashboardServer`, its route does not exist on this composition — and a
 *     route added to the general dashboard later is disabled here by default
 *     rather than quietly inherited.
 *
 * Static imports reaching legacy modules are acceptable when they create no
 * instance and start no work; `DashboardServer` has several, and erasing them
 * would mean splitting a file this task is explicitly told not to split. What
 * would NOT be acceptable is a constructed-but-idle service, because "idle" is
 * a runtime claim rather than a structural one.
 *
 * One more deliberate rule: this entry point does **not** copy
 * `anthropic.api_key` / `openai.api_key` into `process.env` (the retired v2
 * root did, so its agent subprocesses inherited provider credentials). This
 * composition does not spawn credential-inheriting subprocess agents. The dev
 * pipeline authenticates from the host developer's own CLI login, while
 * Knowledge Chat calls its configured provider in-process, so neither needs
 * provider secrets copied into the process environment.
 */

import { promises as fs, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { storeAttachment } from "./attachments/store.js";
import { HEALTH_FILE, gitlabCiToken, loadConfig, type BotConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { AUDIT_RETENTION_MS, paceRetention } from "./retention.js";
import { PROJECT_ROOT } from "./project-root.js";
import {
  DEV_TICKET_EFFORT_DEFAULT,
  DEV_TICKET_MODEL_DEFAULT,
} from "./devpipe/ticket-models.js";
import { Store, type SessionPlusSplitSessionRow } from "./store/store.js";
import { UserManagerImpl } from "./user/manager.js";
import { RunnerGateway, type RunnerTransport } from "./runner/gateway.js";
import { WorkspaceProvider } from "./devpipe/workspace-provider.js";
import { DeployArtifactService, RELEASE_SCRATCH } from "./devpipe/deploy-artifact.js";
import { ReleaseStager } from "./devpipe/release-stage.js";
import { GitLabMainline } from "./devpipe/gitlab-mainline.js";
import { GitLabReleaseCatalog } from "./devpipe/gitlab-release.js";
import { KNOWLEDGE_SCRATCH, knowledgeScratchInUse, runnerKnowledgeGraphBuilder, runnerKnowledgeDeployProjection } from "./devpipe/knowledge-graph-runner.js";
import { bindKnowledgeDeployProjection } from "./devpipe/knowledge-deploy.js";
import { runnerAppPacker } from "./devpipe/app-pack-runner.js";
import { git as releaseGit, sweepScratchWorktrees } from "./devpipe/worktree.js";
import { WorkspaceDevelopmentCapabilities } from "./devpipe/workspace-development-capability.js";
import { dispatchDevpipeTool } from "./devpipe/tool-dispatch.js";
import { WorkspaceJobCapabilities } from "./devpipe/workspace-job-capability.js";
import { workspaceProviderGate } from "./devpipe/workspace-gate.js";
import { RunnerProviderCatalog } from "./runner/providers.js";
import { RunnerBundleRegistry } from "./runner/bundle-registry.js";
import { RunnerBundleDelivery } from "./devpipe/runner-bundle-delivery.js";
import { MACHINE_AUTO_ALLOW, MACHINE_OPS, RunnerCapabilities, type PreparedRunnerDispatch } from "./runner/capability.js";
import { RunnerSessionProjectionService } from "./runner/session-projection.js";
import {
  preparedSessionCatalogEntry,
  sessionPlusCatalogId,
  type PreparedSessionCatalogEntry,
} from "./runner/session-catalog.js";
import { WorkspaceFilesCapabilities } from "./workspace-files/capability.js";
import { ExecutionWorkspaceCapabilities } from "./execution-workspace/capability.js";
import { SessionBranchCapabilities } from "./session-branch/capability.js";
import { MeetingTranscriptionCapabilities } from "./meeting-transcription/capability.js";
import { RunnerFileTransfers } from "./runner-file-transfer/service.js";
import { FILE_TRANSFER_MCP_NAMES, FILE_TRANSFER_MCP_TOOLS } from "./runner-file-transfer/protocol.js";
import { ExecutionScopeCapabilities } from "./execution-workspace/scope-issuer.js";
import { AgentInteractionCapabilities } from "./agent-interactions/capability.js";
import { CrdtDocCapabilities } from "./crdt-doc/capability.js";
import { CrdtDocumentStore } from "./crdt-doc/store.js";
import { CrdtWakeHub } from "./crdt-doc/wake.js";
import { SEED_DESCRIPTORS, seedCrdtDocuments } from "./crdt-doc/seed.js";
import { CapabilityLoopback } from "./runner/loopback.js";
import { ResourceRecoveryService, ResourceUnavailableError, parseUnavailable, runnerResource, ticketScope, unavailableMessage } from "./resources/recovery.js";
import { CapabilityService, SqliteCapabilityStore, type Operation } from "@claude-bot/capability-kernel";
import { configureConvergenceUsage } from "@claude-bot/convergence-gates";
import { DevPipeline, type CiMachineOpener, type CiMachineSync, type RemoteCodexOpener } from "./devpipe/pipeline.js";
import { RemoteCodexCapabilities } from "./devpipe/remote-codex-capability.js";
import { FableTicketApprovalService } from "./devpipe/ticket-agent-approval.js";
import { CodexAccountRouter } from "./devpipe/codex-account-router.js";
import { ContribReviewService, NO_FORGE_PUBLISHER, type ProposalPublisher } from "./devpipe/contrib-review.js";
import { GitLabContribPublisher } from "./devpipe/gitlab-contrib.js";
import { BundleHandoff } from "./devpipe/bundle-handoff.js";
import { syncTicketWorkspaceViaRunner, syncWorkspaceViaRunner, TEST_READY_BUILD_FILTERS, type MachineExecResult } from "./devpipe/runner-machine-sync.js";
import { KnowledgeIndexCapabilities } from "./knowledge-artifact/capability.js";
import { knowledgeIndexRunnerTarget } from "./knowledge-artifact/placement.js";
import { KnowledgeArtifactService, type RemoteKnowledgeRead, type RemoteKnowledgeStatus } from "./devpipe/knowledge-artifact-service.js";
import type { KnowledgeGraphService } from "./devpipe/knowledge-graph-service.js";
import { runnerGateSession, type RemoteGateOpener } from "./devpipe/remote-gate.js";
import { resolveCapabilityBits } from "./permissions/capability-bits.js";
import { DeployService } from "./devpipe/deploy.js";
import {
  classifyCiRepairFailure,
  ciRepairBusyForScheduling,
  findCiRepairRouteTarget,
  GitLabCiMonitor,
} from "./devpipe/gitlab-ci.js";
import { ciRepairFollowUpPreface } from "./devpipe/prompts.js";
import { encodeCiRoster } from "./devpipe/ci-roster.js";
import { DashboardServer, PANEL_RESOURCE_CONTRACTS } from "./dashboard/server.js";
import {
  type DashboardCompositionOptions,
  type DashboardOptions,
  type DashboardServices,
  type DashboardTransportLifecycle,
} from "./dashboard/ports.js";
import { ArchitectureService, type ArchitectureServiceOptions } from "./dashboard/architecture.js";
import { runnerArchitectureAnalyzer } from "./dashboard/architecture-runner.js";
import { workspaceSourceState } from "./devpipe/workspace-source.js";
import { KnowledgeWikiService } from "./dashboard/knowledge.js";
import { KnowledgeChatService } from "./dashboard/knowledge-chat.js";
import { detectPublicHost } from "./dashboard/host.js";
import { resolveSessionPlus, type SessionPlusSettings } from "./app-core/settings.js";
import { AppViewServer } from "./app-registry/view-server.js";
import { sessionPlusIdentity, sessionPlusIdentityOf } from "./app-core/identity.js";
import { bundledAppDir } from "./app-core/app-path.js";
import { SessionPlusAppService } from "./session-plus/app-service.js";
import { backendRelease } from "@claude-bot/app-runtime";
import { AppReleaseRegistry, FileReleaseContentStore } from "@claude-bot/app-registry";
import { StoreReleaseCatalog } from "./app-registry/store-catalog.js";
import { appReleasePaths } from "./app-registry/paths.js";
import { SessionPlusReleaseAdapter } from "./app-registry/session-plus-adapter.js";
import { AppReleaseHost, HostedApp } from "./app-registry/release-host.js";
import type { ReleaseBundle } from "./app-registry/bundle.js";
import { AppBackendRegistry, type AppBackendSupervisor } from "./app-registry/backend-supervisor.js";
import { DeclaredAppComposer } from "./app-registry/declared-apps.js";
import { ResearchSessionPlane } from './app-registry/research-sessions.js';
import { RESEARCH_SESSION_PROFILE, RESEARCH_SESSION_SUBJECT } from './session-resource/research-contract.js';
import {DOCS_SUBJECT} from './research-docs/contract.js';
import {ResearchDocsPlane} from './research-docs/plane.js';
import { RESEARCH_CANVAS_SUBJECT } from './research-canvas/contract.js';
import { CANVAS_OPERATIONS } from '@claude-bot/research-canvas-contract';
import { createResearchCanvasHost } from './research-canvas/host.js';
import { ResearchCanvasPlane } from './research-canvas/plane.js';
import { ResearchNative } from './research-canvas/native.js';
import type { FeishuOAuthCommandMessage } from './feishu/oauth-commands.js';
import { createAppTicketReleaseTools } from "./devpipe/app-ticket-refresh.js";
import { declaredAppHostingFrom } from "./app-registry/declared-adapter.js";
import type { PreparedSessionPlusRelease } from "./app-registry/session-plus-adapter.js";
import { AppOriginAskServer } from "./app-registry/origin-ask.js";
import { mergeScanHomes, sharedEnvScanUsers } from "./sessionhub/scan-homes.js";
import { DEV_FACTORY_INVENTORY_NOTE, TRUSTED_SERVICE_PRINCIPALS } from "./permissions/catalog.js";
import { deploymentProfile, deploymentProfileDeclared, executionInventory, profileDisclosure, setDeploymentProfile } from "@claude-bot/engine";
import { AgentLoop } from "./app-agents/loop.js";
import { AppAgentPlane } from "./app-agents/plane.js";
import { SessionPlusAgentBackend } from "./session-plus/agent-backend.js";
import { FeishuAuthManager } from "./channel/feishu-oauth.js";
import { FeishuDirectory } from "./channel/feishu-directory.js";
import { FeishuOAuthPortal } from "./feishu/oauth-portal.js";
import { FeishuDocsAddonAuth, feishuDocsAddonOptions } from "./feishu/docs-addon-auth.js";
import { FeishuDocsAddonService } from "./feishu/docs-addon.js";
import { FeishuDocsClient, tenantTokenSource } from "./feishu/docs-openapi.js";
import { FeishuDocShareService } from "./feishu/doc-share.js";
import { DOC_ASSISTANT_OPERATION_PREFIX, FeishuDocAssistants } from "./feishu/doc-assistants.js";
import { DocsNotifier, type DocsNotice } from "./feishu/docs-notify.js";
import { DocsLauncher, LAUNCH_DEFAULTS_KEY, readDefaults } from "./feishu/docs-launch.js";
import { DocsWorkspaceFiles } from "./feishu/docs-files.js";
import { FeishuOAuthCommands, LarkFeishuOAuthCommandTransport } from "./feishu/oauth-commands.js";
import { externalAppHostSettings } from "./app-external/settings.js";
import { ExternalAppHostService } from "./app-external/service.js";
import { LarkMcpBackend } from "./feishu/backend.js";
import { LarkCliExecutor } from "./feishu/lark-cli.js";
import { FeishuCapabilities } from "./feishu/gateway.js";
import { FeishuResearchDocuments } from "./research-canvas/feishu-documents.js";
import {
  resolvePrivilegedAgentGrant,
  validateFeishuGatewayConfig,
} from "./feishu/grants.js";
import { FeishuAuthorizationResourceIndex } from "./feishu/resource-index.js";
import {
  mcpTokenPolicy,
  resolveTentacleMcpCredential,
  tentacleMcpCredentialIsActive,
} from "./mcp/tokens.js";
import { TentacleBroker } from "./tentacle/broker.js";
import { TentacleCapabilities } from "./tentacle/capability.js";
import { TENTACLE_SUBJECT_ENTRY } from "./tentacle/catalog.js";
import { TentacleService } from "./tentacle/service.js";
import { PermissionService } from "./permissions/service.js";
import { PermissionStudioService } from "./permissions/studio.js";
import { AppTrustService } from "./permissions/app-trust.js";
import { AuthorizationService } from "./authorization/service.js";
import { AgentRuntimeCreditService } from "./agent-credits/service.js";
import { SESSION_HUB_SUBJECT } from "./permissions/catalog.js";
import { sessionPlusSubjectEntry } from "./session-resource/catalog.js";
import { IntentGrantResolver } from "./session-resource/intent-resolver.js";
import { AppAuthorityBundles } from "./session-resource/bundle.js";
import { SessionResourceService } from "./session-resource/service.js";
import { SessionResourceOperationExecutor } from "./session-resource/operation-executor.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PUBLISHER,
  sessionPlusContractCovering,
} from "./session-resource/contract.js";
import {
  AgentResourceCatalog,
  notifyProvider,
  type ResourceProviderContext,
  workspaceFilesProvider,
  workspaceFilesProviderV2,
  workspaceFilesProviderV3,
  workspaceFilesProviderV4,
} from "./agent-resources/index.js";
import { notifyAccountOperations, sessionPlusNotifyGrant } from "./session-resource/notify-grant.js";
import { sessionPlusWorkspaceGrant } from "./session-resource/workspace-grant.js";
import { crdtDocAccountOperations, sessionPlusCrdtGrant } from "./session-resource/crdt-grant.js";
import { crdtDocProvider, crdtDocProviderV2, type CrdtDocProviderOptions } from "./agent-resources/crdt-doc-provider.js";
import { WorkspaceDirectoryKeys } from "./workspace-files/directory-key.js";
import { WorkspaceDirectorySnapshotIndex } from "./workspace-files/directory-index.js";
import { WorkspaceFilesService } from "./workspace-files/service.js";
import { GrantWorkspaceFilesAuthority } from "./workspace-files/authority.js";
import { WORKSPACE_FILES_WRITE_OPERATION } from "./workspace-files/capability.js";
import { UserMemoryCapabilities } from "./user-memory/capability.js";
import { UserSkillsCapabilities } from "./user-skills/capability.js";
import {
  MCP_APPS_OPERATION_IDS,
  MCP_CRDT_OPERATION_IDS,
  MCP_FEISHU_USER_OPERATION_IDS,
  mcpSubjectEntry,
  MCP_KNOWLEDGE_OPERATION_IDS,
} from "./mcp/catalog.js";
import { McpSurface } from "./mcp/service.js";
import { MCP_AGENT_ACCOUNT_TOOL_GROUPS } from "./mcp/policy-contract.js";
import { TicketDevelopmentRegistry } from "./mcp/ticket-development.js";
import { SessionExecutionRegistry, type SessionExecutionDispatch } from "./mcp/session-execution.js";
import { SessionHubService } from "./sessionhub/service.js";
import { SessionOperationCoordinator } from "./sessionhub/operations.js";
import { SessionHubOperationExecutor } from "./sessionhub/operation-executor.js";
import { LocalScanCapabilities } from "./sessionhub/local-scan.js";
import { SessionPlusOperationBinding } from "./session-plus/operation-binding.js";
import { SessionPlusInteractionBinding } from "./session-plus/interaction-binding.js";
import { SessionPlusSessionChangeBinding } from "./session-plus/session-change-binding.js";
import { QuotaProbe } from "./devpipe/quota.js";
import { CodexQuotaProbe } from "./devpipe/codex-quota.js";
import { WebSessionManager } from "./dashboard/web-session.js";
import { SystemStatusProbe } from "./dashboard/system-status.js";
import { PendingRegistrationStore, StateStore } from "./dashboard/oauth-github.js";
import { AgentCompletionRelay, directAgentCompletionSink, managedCompletionNotice } from "./agent-completion/relay.js";
import { devAgentCompletionStatus } from "./agent-completion/dev-pipeline.js";
import { feishuOpenIdOf, sendFeishuCardDirect, type CardPayload } from "./feishu/direct-card.js";

const log = createLogger("bootstrap-v3");

/**
 * The deployment branch model, as defaults rather than as something to remember.
 *
 * `staging` and `stable` are the v2 watermarks; this entry point must never
 * fall back to them, because "the deploy tool defaulted to the other branch" is
 * a mistake that only becomes visible after it has shipped something. Both
 * remain overridable in `selfhosting.*` — they are defaults, not constants.
 *
 * 2026-08-07: the watermark line is renamed v3 → v4 to match what the platform
 * actually is (the v4 module platform has been landing into it for a while).
 * The exported names keep their V3_ prefix — they are imported in a dozen
 * places and the prefix marks the CONTROL-PLANE generation (bootstrap-v3),
 * not the branch it deploys. `v3`/`v3-stable` remain as historical anchors
 * that stop advancing; configuring them now draws the same class of warning
 * as the v2 names, one generation later.
 */
export const V3_BASE_BRANCH = "v4";
export const V3_STABLE_BRANCH = "v4-stable";

/** Branch names that mean "you are pointing the pipeline at v2's line". */
const V2_WATERMARKS = new Set(["staging", "stable", "trunk"]);

/** Branch names of the previous (v3) line — valid history, stale watermarks. */
const V3_WATERMARKS = new Set(["v3", "v3-stable"]);

/** Artifact build imports release metadata and launches the compiled embedding worker. */
const KNOWLEDGE_ARTIFACT_BUILD_FILTERS = [
  ...TEST_READY_BUILD_FILTERS,
  "@claude-bot/session-plus-view",
  "@claude-bot/bot",
] as const;

/**
 * Everything this composition may build. Also the inventory's vocabulary, so
 * the list a test asserts against is the list the process logs.
 */
export const BOOTSTRAP_SERVICES = [
  "store",
  "user-manager",
  "runner-gateway",
  "runner-capabilities",
  "knowledge-index-capability",
  "tentacle-gate",
  /**
   * The workspace-files capability plane: its own Object over the same laptops,
   * with its own version line. Listed separately because "this host can serve
   * file reads at all" is a fact an operator reading the startup log needs, and
   * it is not implied by having a Runner in some future composition.
   */
  "workspace-files-capabilities",
  "execution-workspace-capabilities",
  "session-branch-capabilities",
  "runner-file-transfers",
  "agent-interactions-capabilities",
  "meeting-transcription-capabilities",
  "runner-extension-capabilities",
  "feishu-oauth",
  "feishu-gateway",
  "feishu-oauth-commands",
  "discussions",
  /**
   * The /admin onboarding console's tenant reader (lookup by phone/email, the
   * chats the app is in). Built from the same app credentials as Feishu OAuth;
   * cache-first, so it costs nothing until an administrator opens the page.
   */
  "feishu-directory",
  "capability-loopback",
  "dev-pipeline",
  "gitlab-ci-monitor",
  "deploy-service",
  /**
   * The Agentic App release registry: which immutable release this host serves
   * and the local page that changes it. Constructed with Session Plus, because
   * the App it manages is the one that exists — but it is a separate service on
   * purpose: an App with no usable release still leaves the management page up,
   * which is the page an operator rolls back from.
   */
  "app-releases",
  "session-plus-state",
  "session-plus-runtime",
  "session-plus-app",
  /**
   * The App agent plane: one inbox pump, in this trusted process, for the
   * agents an active release declares. Separate from `session-plus-app`
   * because it is separately switchable (`app_agents.enabled`, default off) and
   * because "does this host spend money on inference for an App" is a fact an
   * operator reading the startup log has to be able to find.
   */
  "app-agents",
  /**
   * The collaborative-document plane: the durable Yjs store, its capability
   * Object, the seeded demonstration documents, and the wake fan-out. Listed
   * because it is a durable user-data store this host now holds — a reader of
   * the startup log should know a new class of data lives under `dataDir`.
   */
  "crdt-docs",
  /**
   * Apps this host serves because a row in `app_declarations` says so, rather
   * than because their adapter is compiled in. Listed only when at least one was
   * composed, so the startup log answers "is this host running anything I cannot
   * find in the source tree" without a reader diffing a table against a build.
   */
  "declared-apps",
  /**
   * The seam that lets a landed `app` ticket republish its App (pack → install →
   * activate, in the ticket's own worktree). Listed because it changes what a
   * merge MEANS on this host: with it, an app ticket moves the active pointer;
   * without it, the same ticket lands code and says so in its conversation. A
   * reader of the startup log should not have to infer which deployment they are
   * looking at.
   */
  "app-ticket-release-refresh",
  "knowledge-chat",
  "dashboard",
  /**
   * The Agent View listener — a second ORIGIN, deliberately still a static
   * publisher in this trusted process. M2 moves only dynamic App compute and
   * durable state into separate processes; letting either one rewrite
   * digest-addressed View bytes would weaken release identity. Present only when
   * the feature is on, so inventory answers whether it is served.
   *
   * Renamed from `session-plus-view` when it stopped being one app's listener:
   * it resolves a digest label through the CATALOG, so every installed release
   * of every app in this composition is served from its own hostname. The name
   * is part of the inventory vocabulary, which is why changing it is a visible
   * edit rather than a comment.
   */
  "app-view",
  /**
   * The loopback endpoint the reverse proxy asks before issuing a certificate
   * for one release's hostname. Only built when configured, so the inventory
   * answers whether on-demand TLS is actually gated.
   */
  "app-origin-ask",
] as const;
export type BootstrapService = (typeof BOOTSTRAP_SERVICES)[number];

export interface BootstrapInventory {
  entry: "bootstrap-v3";
  surface: "bootstrap-v3";
  /** Constructed, in the declared order. A subset of `BOOTSTRAP_SERVICES`. */
  services: BootstrapService[];
  baseBranch: string | null;
  stableBranch: string | null;
  dashboardPort: number | null;
  runnerPort: number | null;
  /**
   * The Session Plus probe, as the process actually resolved it: null when the
   * flag is off, otherwise the origin being served, the package digest that
   * origin's hostname encodes, and who may frame it. Reported because "which
   * code is in that iframe" and "who may embed it" are exactly the two facts a
   * reader of the log needs to check against the proxy configuration.
   */
  sessionPlus: {
    viewOrigin: string;
    packageDigest: string;
    permissionContractDigest: string;
    frameAncestors: readonly string[];
    development: boolean;
    listenPort: number | null;
    statePid: number | null;
    runtimePid: number | null;
    backends: { state: string; runtime: string };
    /**
     * Which release the registry says is active, how it got there, and whether
     * this checkout's own package is even installed.
     *
     * Reported because a v4 deployment can be serving a release that is NOT the
     * one this checkout would build — that is the whole point of the active
     * pointer — and an operator reading the startup log needs to see which of
     * the two they are looking at before they compare a hostname to a site block.
     */
    release: {
      activatedBy: string;
      activatedAt: string;
      checkoutPackageDigest: string | null;
      checkoutInstalled: boolean;
      originAskPort: number | null;
    };
  } | null;
  /** The App agent plane, and the deployment classification it runs under. */
  appAgents: {
    enabled: boolean;
    adapters: string[];
    /** The active release declares an agent, and this host will not run it. */
    declaredButDisabled: boolean;
    deploymentProfile: string;
    deploymentProfileDeclared: boolean;
    disclosure: string;
  };
  /** SEC-06 execution inventory. */
  execution: ReturnType<typeof executionInventory>;
}

export interface BootstrapV3 {
  readonly inventory: BootstrapInventory;
  readonly store: Store;
  readonly dashboard: DashboardServer | null;
  readonly devPipeline: DevPipeline | null;
  /** Idempotent; safe to call from a signal handler and from a test's cleanup. */
  stop(): Promise<void>;
}

export interface BootstrapOptions {
  config: BotConfig;
  dataDir: string;
  /** Heartbeat file the supervisor's health gate reads. */
  healthFile?: string;
  /** 0 disables the heartbeat (tests); default 30s. */
  healthIntervalMs?: number;
  /**
   * Skip the outbound public-IP probe. Startup does it once for the onboarding
   * tutorial; a test should not reach the network to assert an inventory.
   */
  detectPublicHost?: boolean;
  /** Test seam; production automatically reconciles the architecture atlas. */
  architectureAutoRefresh?: boolean;
  /** Test seam: the immutable checkout release a fresh Session Plus registry seeds. */
  sessionPlusCheckoutBundle?: () => ReleaseBundle;
}

const DASHBOARD_WORKSPACE_ACCESS_OPERATIONS: readonly string[] = Object.freeze([
  "list_workspace_entries",
  "read_workspace_text",
  "download_workspace_file",
  "read_workspace_binary",
  "replace_workspace_text",
]);

export interface DashboardComposition {
  options: DashboardOptions;
  services: DashboardServices;
  attachTransport(transport: DashboardTransportLifecycle): () => void;
  close(): Promise<void>;
}

interface DashboardStartupUndo {
  what: string;
  close: () => Promise<void> | void;
}

function rollbackDashboardStartup(opened: DashboardStartupUndo[], cause: unknown): never {
  for (const step of opened.splice(0).reverse()) {
    try {
      const closing = step.close();
      // Composition is synchronous, so nothing can open a catalog instance
      // before the factory publishes its return value. `shutdown()` marks the
      // catalog stopped before returning its already-settled teardown Promise;
      // observe a future implementation's rejection without replacing the
      // original startup error.
      if (closing) {
        void closing.catch((err: unknown) =>
          log.warn({ err, step: step.what }, "dashboard startup rollback rejected"));
      }
    } catch (err) {
      log.warn({ err, step: step.what }, "dashboard startup rollback failed");
    }
  }
  throw cause;
}

/**
 * Build the dashboard's business/service graph at the process composition
 * boundary. `DashboardServer` receives only the completed ports below; it
 * cannot create a fallback kernel, permission plane, session hub or MCP face.
 *
 * Exported only so the legacy composition root and tests can follow the same
 * explicit path while that rollback entry point still exists.
 */
export function composeDashboardServices(
  store: Store,
  caps: RunnerCapabilities | undefined,
  input: DashboardCompositionOptions,
): DashboardComposition {
  const startupUndo: DashboardStartupUndo[] = [];
  try {
    return composeDashboardServicesOwned(store, caps, input, startupUndo);
  } catch (error) {
    return rollbackDashboardStartup(startupUndo, error);
  }
}

function composeDashboardServicesOwned(
  store: Store,
  caps: RunnerCapabilities | undefined,
  input: DashboardCompositionOptions,
  startupUndo: DashboardStartupUndo[],
): DashboardComposition {
  const owns = (what: string, close: DashboardStartupUndo["close"]): void => {
    startupUndo.push({ what, close });
  };

  const sessionPlusSettings = (): SessionPlusSettings | null => {
    const source = input.sessionPlus;
    if (!source) return null;
    return typeof source === "function" ? source() : source;
  };

  const sharedCapabilityService = caps?.service;
  const ownedCapabilityService = sharedCapabilityService ? null : new CapabilityService();
  if (ownedCapabilityService) owns("capability-service", () => ownedCapabilityService.close());
  const capabilityService = sharedCapabilityService ?? ownedCapabilityService!;
  const fableTicketApprovals = input.devPipeline
    ? new FableTicketApprovalService({
        service: capabilityService,
        pipeline: input.devPipeline,
        userExists: (username) => Boolean(store.getUser(username)),
        knownUsers: store.loadUsers().map((user) => user.username),
        isAdmin: (username) => (input.adminUsers ?? []).includes(username),
      })
    : null;
  const localScan = new LocalScanCapabilities({
    service: capabilityService,
    userExists: (username) => Boolean(store.getUser(username)),
    scanHomeFor: input.scanHomeFor,
  });
  const userMemory = input.memorySkills
    ? new UserMemoryCapabilities({
        service: capabilityService,
        userExists: (username) => Boolean(store.getUser(username)),
        memoryDirFor: input.memorySkills.memoryDirFor,
      })
    : null;
  const userSkills = input.memorySkills
    ? new UserSkillsCapabilities({
        service: capabilityService,
        userExists: (username) => Boolean(store.getUser(username)),
        skillsDirFor: input.memorySkills.skillsDirFor,
      })
    : null;

  const authorization = new AuthorizationService({
    repository: store.authorization,
    rules: input.authorizationRules,
  });
  owns("authorization", () => authorization.close());
  const agentRuntimeCredits = caps
    ? new AgentRuntimeCreditService({
        store,
        authorization,
        devices: (owner) => caps.listDevices(owner),
        hostOwners: input.adminUsers ?? [],
      })
    : null;
  if (agentRuntimeCredits && input.subscribeManagedSessionCompletions) {
    owns(
      "agent-runtime-credit-meter",
      input.subscribeManagedSessionCompletions((owner, device, completion) => {
        agentRuntimeCredits.spendCompletion(owner, device, completion);
      }),
    );
  }
  if (input.mcpFeishu) {
    const feishuResourceIndex = new FeishuAuthorizationResourceIndex(authorization);
    const detachFeishuResourceIndex = input.mcpFeishu.installResourceIndex(feishuResourceIndex);
    owns("feishu-resource-index", detachFeishuResourceIndex);
  }
  const knowledgeRights = (owner: string): readonly string[] => {
    const bits = resolveCapabilityBits({ username: owner, admins: input.adminUsers, granted: store.listUserGrants(owner).map((grant) => grant.capability) });
    return input.knowledge && (bits.dev || bits.contribute || bits.admin) ? MCP_KNOWLEDGE_OPERATION_IDS : [];
  };
  let executionScopes: ExecutionScopeCapabilities | null = null;
  const permissions = new PermissionService({
    store,
    caps,
    local: localScan,
    workspaceFiles: input.workspaceFiles,
    userMemory: userMemory ?? undefined,
    userSkills: userSkills ?? undefined,
    extraAccountOperations: [
      () => input.researchCanvas && input.attachDeclaredResources && input.managedSupervisor ? CANVAS_OPERATIONS : [],
      (owner) => input.discussions?.accountOperations(owner) ?? [],
      (owner) => input.meetingTranscription?.capabilities.accountOperations(owner) ?? [],
      (owner) => input.runnerCapabilities?.accountOperations(owner) ?? [],
      knowledgeRights,
      () => notifyAccountOperations(input.notifyDelivery),
      // Assigned once the session-execution registry exists below; read lazily.
      (owner) => executionScopes?.accountOperations(owner) ?? [],
      (owner) => input.mcpCrdtDocs && input.mcpCrdtDocs.documentsFor(owner).length
        ? MCP_CRDT_OPERATION_IDS
        : [],
      () => input.mcpApps && input.mcpApps.list().length ? MCP_APPS_OPERATION_IDS : [],
      (owner) => input.mcpFeishu
        ? [
            ...MCP_FEISHU_USER_OPERATION_IDS,
            ...(input.mcpFeishuPrivilegedOperations?.(owner) ?? []),
          ].filter((operation) => input.mcpFeishu!.runnable().has(operation))
        : [],
      (owner) => crdtDocAccountOperations(input.crdtDocs?.capabilities, owner),
      (owner) => input.tentacle?.capabilities.accountOperations(owner) ?? [],
    ],
    directSubmitAutoAllowUsers: input.sessionHubDirectSubmitAutoAllowUsers,
    subjects: [
      ...(input.runnerTickets ? [TICKET_RUNNER_SUBJECT] : []),
      ...(input.attachDeclaredResources ? [RESEARCH_SESSION_SUBJECT, RESEARCH_CANVAS_SUBJECT, DOCS_SUBJECT] : []),
      ...(input.sessionPlus
        ? [sessionPlusSubjectEntry(() => sessionPlusSettings()?.identity.contract ?? null)]
        : []),
      ...(input.knowledge || input.workspaceFiles || input.mcpCrdtDocs || input.memorySkills || input.mcpApps || input.mcpFeishu || input.discussions || input.meetingTranscription || input.runnerCapabilities
        ? [
            mcpSubjectEntry({
              discussionsComposed: () => Boolean(input.discussions),
              runnerCapabilitiesComposed: () => Boolean(input.runnerCapabilities),
              transcriptionComposed: () => Boolean(input.meetingTranscription),
              knowledgeComposed: () => Boolean(input.knowledge),
              workspaceComposed: () => Boolean(input.workspaceFiles),
              crdtComposed: () => Boolean(input.mcpCrdtDocs),
              memoryComposed: () => Boolean(userMemory),
              skillsComposed: () => Boolean(userSkills),
              appsComposed: () => Boolean(input.mcpApps),
              feishuComposed: () => Boolean(input.mcpFeishu),
              feishuPrivilegedOperations: input.mcpFeishuPrivilegedOperations,
              executionComposed: () => Boolean(executionScopes),
            }),
          ]
        : []),
      ...(input.tentacle ? [TENTACLE_SUBJECT_ENTRY] : []),
    ],
  });
  if (input.runnerTickets && caps && input.devPipeline) {
    seedTicketRunnerGrants(input.runnerTickets, permissions);
    input.devPipeline.setRunnerTickets(new TicketRunnerAccess(input.runnerTickets, caps, permissions, input.devScanHome,
      (requester) => Boolean(store.getUser(requester) && resolveCapabilityBits({ username: requester, admins: input.adminUsers,
        deployers: input.deployers, granted: store.listUserGrants(requester).map((grant) => grant.capability) }).contribute)));
  }
  owns("permissions", () => permissions.close());
  const appTrust = new AppTrustService(store);
  const tentacle = input.tentacle
    ? new TentacleService(store, permissions, authorization, input.tentacle.capabilities, input.tentacle.broker)
    : null;
  if (tentacle) owns("tentacle", () => tentacle.close());
  const permissionStudio = new PermissionStudioService({
    store,
    permissions,
    authorization,
    agentRuntimes: agentRuntimeCredits,
    tentacle,
    devFactoryEnabled: () => Boolean(input.devPipeline),
    activeSessionPlusContractDigest: () => sessionPlusSettings()?.identity.permissionContractDigest ?? null,
  });
  owns("permission-studio", () => permissionStudio.close());

  const initialSessionPlus = sessionPlusSettings();
  if (initialSessionPlus) syncSessionPlusConfigGrants(store, permissions, initialSessionPlus);

  const hub = new SessionHubService({
    store,
    permissions,
    caps,
    local: localScan,
    agentInteractions: input.agentInteractions,
  });

  const sessionSharing = new SessionSharingService(store.sessionShares);
  input.sessionPlusApp?.attachSharing(sessionSharing);
  if (input.subscribeManagedSessionCompletions) owns("shared-session-usage", input.subscribeManagedSessionCompletions((owner, device, completion) => sessionSharing.spendCompletion(owner, device, completion)));
  let sessionPlusAuthority: AppAuthorityBundles | null = null;
  let resourceCatalog: AgentResourceCatalog | null = null;
  let workspaceFilesService: WorkspaceFilesService | null = null;
  let sessionPlusResources: SessionResourceService | undefined;
  let sessionPlusExecutor: SessionResourceOperationExecutor | undefined;
  let grantResolver: IntentGrantResolver | null = null;
  let detachRunnerLifecycle: (() => void) | null = null;

  if (input.sessionPlus && input.sessionPlusApp) {
    grantResolver = new IntentGrantResolver(permissions);
    sessionPlusAuthority = new AppAuthorityBundles({ runner: caps, local: localScan, grants: grantResolver });
    const directoryKeys = new WorkspaceDirectoryKeys();
    const directorySnapshots = new WorkspaceDirectorySnapshotIndex();
    sessionPlusResources = new SessionResourceService(
      sessionPlusAuthority,
      permissions,
      undefined,
      undefined,
      directoryKeys,
      (owner) => {
        const requested = DASHBOARD_WORKSPACE_ACCESS_OPERATIONS.filter((operation) =>
          permissions.declaredOperations("app", SESSION_PLUS_APP_ID, owner).includes(operation));
        if (!requested.length) return null;
        const effective = permissions.effectiveFor({
          subjectType: "app",
          subjectId: SESSION_PLUS_APP_ID,
          owner,
          requested,
          contractDigest: sessionPlusSettings()?.identity.permissionContractDigest ?? null,
        });
        return effective.entries.map((entry) => ({
          operation: entry.operation.slice(0, 64),
          title: entry.title.slice(0, 120),
          effective: entry.effective,
          autoAllow: entry.autoAllow,
          alwaysApprove: entry.alwaysApprove,
          explanation: entry.explanation.slice(0, 300),
        }));
      },
      Date.now,
      directorySnapshots,
      input.sessionProjection ?? null,
      agentRuntimeCredits ? (owner) => agentRuntimeCredits.projectFor(owner) : null,
      (owner, device, source, id) => Boolean(
        store.getSessionPlusSplitSession(owner, device, source, id),
      ),
      (owner, device, source, id) => {
        const row = store.getSessionPlusSplitSession(owner, device, source, id);
        return row ? { device: row.execution_device, workspaceId: row.workspace_id } : null;
      },
      (owner, device) => runnerDisplayName(store, owner, device),
    );
    sessionPlusExecutor = new SessionResourceOperationExecutor(
      sessionPlusAuthority,
      permissions,
      hub.leases,
    );

    resourceCatalog = new AgentResourceCatalog();
    const catalog = resourceCatalog;
    owns("resource-catalog", () => catalog.shutdown());
    workspaceFilesService = new WorkspaceFilesService();
    const openWorkspaceFilesGrant = (context: ResourceProviderContext) => sessionSharing.narrowWorkspaceGrant(context.instance, sessionPlusWorkspaceGrant({
      capabilities: input.workspaceFiles,
      grants: grantResolver!,
      devices: (owner) => (caps?.listDevices(owner) ?? []).map((row) => ({
        device: row.device,
        label: row.device,
      })),
    })(context));
    resourceCatalog.register(workspaceFilesProvider({
      service: workspaceFilesService,
      openGrant: openWorkspaceFilesGrant,
    }));
    resourceCatalog.register(workspaceFilesProviderV2({
      service: workspaceFilesService,
      openGrant: openWorkspaceFilesGrant,
      directoryKeys,
    }));
    resourceCatalog.register(workspaceFilesProviderV3({
      service: workspaceFilesService,
      openGrant: openWorkspaceFilesGrant,
      directoryKeys,
    }));
    resourceCatalog.register(workspaceFilesProviderV4({
      service: workspaceFilesService,
      openGrant: openWorkspaceFilesGrant,
      directoryKeys,
      ownerFileTarget: (owner, ref) => ownerFileSessionTarget(owner, ref, (account, device, source, id) => {
        const row = store.getSessionPlusSplitSession(account, device, source, id);
        return row ? { device: row.execution_device, workspaceId: row.workspace_id } : null;
      }),
    }));
    resourceCatalog.register(notifyProvider({
      openGrant: (context) => sessionPlusNotifyGrant({
        delivery: input.notifyDelivery,
        grants: grantResolver!,
      })(context),
    }));
    // Both versions over one authority and one store: a release binds exactly
    // one of them, and v2 differs only in moving documents of any size.
    const crdtOptions: CrdtDocProviderOptions = {
      openGrant: (context) => sessionPlusCrdtGrant({
        capabilities: input.crdtDocs?.capabilities,
        store: input.crdtDocs?.store,
        grants: grantResolver!,
        documentsFor: (owner) => input.crdtDocs?.documentsFor(owner) ?? [],
      })(context),
      onScopeOpened: (context, refs) => input.crdtDocs?.wake?.scopeOpened(context, refs),
      onScopeClosed: (context) => input.crdtDocs?.wake?.scopeClosed(context),
    };
    resourceCatalog.register(crdtDocProvider(crdtOptions));
    resourceCatalog.register(crdtDocProviderV2(crdtOptions));
    resourceCatalog.seal();
    if (input.workspaceFiles && caps) {
      const catalog = resourceCatalog;
      detachRunnerLifecycle = input.workspaceFiles.attachToRunnerLifecycle(caps, (owner) => {
        void catalog.closeOwner(owner);
      });
      owns("runner-lifecycle", () => detachRunnerLifecycle?.());
    }
  }

  const researchAuthority = input.attachDeclaredResources ? new AppAuthorityBundles({
    runner: caps,
    grants: new IntentGrantResolver(permissions, Date.now, new Map([[RESEARCH_SESSION_PROFILE.app, RESEARCH_SESSION_PROFILE.publisher]])),
    profile: RESEARCH_SESSION_PROFILE,
  }) : null;
  const researchResources = researchAuthority ? new SessionResourceService(researchAuthority, permissions, undefined, undefined, null, null, Date.now, undefined, input.sessionProjection ?? null, null, null, null, (owner, device) => runnerDisplayName(store, owner, device)) : null;
  const researchExecutor = researchAuthority ? new SessionResourceOperationExecutor(researchAuthority, permissions, hub.leases) : null;
  const researchNative: ResearchNative | undefined = input.researchCanvas && caps ? new ResearchNative({store, permissions, runner: caps, leases: hub.leases,
    operations: (): SessionOperationCoordinator => operations, projection: input.sessionProjection, interactions: input.agentInteractions, workspaceFiles: input.workspaceFiles}) : undefined;
  const operations = new SessionOperationCoordinator({
    store,
    executors: {
      hub: new SessionHubOperationExecutor(hub),
      "mcp:sessions": new SessionHubOperationExecutor(hub),
      ...(sessionPlusExecutor ? { "app:session-plus": sessionPlusExecutor } : {}),
      ...(researchExecutor ? { 'app:research-program': researchExecutor } : {}),
      ...(researchNative ? {'app:research-v2': researchNative.executor} : {}),
    },
    caps,
    supervisor: input.managedSupervisor,
  });
  // A shared prompt whose operation ended without a turn (failed, rejected,
  // unknown) can never be settled by a completion; sharing releases its lock.
  sessionSharing.attachOperationStatus((owner, id) => operations.get(owner, id)?.status ?? null);
  const researchCanvas = input.researchCanvas && input.managedSupervisor && input.attachDeclaredResources
    ? createResearchCanvasHost(store, capabilityService, permissions, input.managedSupervisor, {...input.researchCanvas, native: researchNative, runner: caps, cloudDocuments: input.mcpFeishu ? new FeishuResearchDocuments(input.mcpFeishu) : undefined}) : null;
  const researchDocs = input.researchCanvas && input.attachDeclaredResources ? new ResearchDocsPlane(store, capabilityService, permissions, path.join(input.researchCanvas.root, '..', 'research-docs'), researchCanvas?.plane) : null;
  if (researchDocs) owns('research-docs', () => researchDocs.shutdown());
  if (researchCanvas) owns('research-canvas', () => researchCanvas.close());
  else researchNative?.close();
  if (researchCanvas && input.subscribeManagedSessionCompletions) owns('research-native-completion', input.subscribeManagedSessionCompletions((owner, device, completion) => researchNative?.completed(owner, device, completion)));
  if (input.attachDeclaredResources && researchAuthority && researchResources) {
    owns('declared-session-resources', input.attachDeclaredResources((app, publisher) =>
      app === RESEARCH_SESSION_PROFILE.app && publisher === RESEARCH_SESSION_PROFILE.publisher
        ? new ResearchSessionPlane({ authority: researchAuthority, resources: researchResources,
            operations: new SessionPlusOperationBinding(operations, null, 'app:research-program'),
            interactions: new SessionPlusInteractionBinding(hub), devices: owner => (caps?.listDevices(owner) ?? []).map(row => row.device) })
        : researchCanvas && ResearchCanvasPlane.matches(app, publisher) ? researchCanvas.plane
        : researchDocs && app === 'research-docs' && publisher === 'octopus:first-party' ? researchDocs : null));
    if (caps) owns('research-runner-lifecycle', caps.onTargetSetChanged(event => input.declaredApps?.get(RESEARCH_SESSION_PROFILE.app)?.service?.releaseOwner(event.username, 'runner_authority_changed')));
  }
  if (sessionPlusAuthority && sessionPlusResources && input.sessionPlusApp) {
    const catalog = resourceCatalog;
    const detachAuthority = input.sessionPlusApp.attachAuthority(
      sessionPlusAuthority,
      sessionPlusResources,
      new SessionPlusOperationBinding(operations, agentRuntimeCredits),
      catalog
        ? {
            planFor: (packageDigest: string) => {
              const active = input.sessionPlusRelease?.active()?.prepared ?? null;
              return active?.identity.packageDigest === packageDigest ? active.resourceBindings : null;
            },
            openInstance: (identity: Parameters<AgentResourceCatalog["openInstance"]>[0]) =>
              catalog.openInstance(identity),
          }
        : undefined,
      new SessionPlusInteractionBinding(hub),
      caps ? new SessionPlusSessionChangeBinding(caps) : undefined,
    );
    owns("session-plus-authority", detachAuthority);
  }
  const pendingBindings = new Set<() => void>();
  owns("pending-session-launch-bindings", () => { for (const stop of [...pendingBindings]) stop(); });
  owns("session-operation-receipts", () => operations.close());
  operations.recover();

  if (input.workspaceFiles && !workspaceFilesService) workspaceFilesService = new WorkspaceFilesService();
  // Feishu document assistants, composed with the docs add-on below; the
  // registry and the dispatch preparer ask them only at call time.
  let docAssistants: FeishuDocAssistants | null = null;
  const sessionExecution = input.workspaceFiles && input.executionWorkspace && workspaceFilesService && caps
    ? new SessionExecutionRegistry({
        store,
        workspaceCapabilities: input.workspaceFiles,
        executionCapabilities: input.executionWorkspace,
        workspaceFilesService,
        devices: (owner) => caps.listDevices(owner),
        assistantOf: (owner, runtimeDevice, source, sessionId) => docAssistants?.bySession(owner, runtimeDevice, source, sessionId) ?? null,
        publicUrl: input.publicUrl,
        dashboardPort: input.port,
      })
    : null;
  const ticketDevelopment = input.devPipeline && input.developmentWorkspaces && sessionExecution
    ? new TicketDevelopmentRegistry({
        store, publicUrl: input.publicUrl, dashboardPort: input.port,
        isCurrent: (binding) => {
          const development = store.devTickets.development.binding(binding.ticketId);
          const requester = store.devTickets.getDevTicket(binding.ticketId)?.requester ?? "";
          const rights = resolveCapabilityBits({ username: requester, admins: input.adminUsers, deployers: input.deployers,
            granted: store.listUserGrants(requester).map((grant) => grant.capability) });
          return Boolean(development && store.getUser(requester) && rights.contribute
            && input.devPipeline!.isCurrentDevelopmentTurn(binding));
        },
        hasKnowledgeConflict: (binding) => Boolean(store.devTickets.getDevTicket(binding.ticketId)?.knowledge_subject_id),
        dispatch: async (binding, operation, args) => {
          const token = input.devPipeline!.developmentTurnToken(binding);
          if (!token) throw new Error("工单开发轮次已失效");
          return (await dispatchDevpipeTool(input.devPipeline!, token, operation, args)).body;
        },
      })
    : null;
  if (ticketDevelopment) {
    owns("ticket-development-mcp", () => ticketDevelopment.close());
    input.devPipeline!.setDevelopmentWorkspaces(input.developmentWorkspaces!, (binding) => ticketDevelopment.renew(binding));
  }
  if (sessionExecution) {
    const restored = sessionExecution.restore();
    if (restored) log.info({ restored }, "session execution scopes restored");
  }
  if (sessionExecution && input.workspaceFiles && caps) {
    // The on-demand issuer Object: its root, grants and revocation line are
    // independent of both the Runner account and the launch-scoped domains.
    executionScopes = new ExecutionScopeCapabilities({
      service: input.workspaceFiles.service,
      port: sessionExecution,
      userExists: (username) => Boolean(store.getUser(username)),
      hasDevice: (username) => store.listRunnerTokens(username).length > 0,
    });
    if (typeof caps.onTargetSetChanged === "function") {
      owns(
        "execution-scope-capabilities",
        caps.onTargetSetChanged((event) => executionScopes?.revokeAccount(event.username)),
      );
    }
  }
  if (sessionExecution && input.installExecutionRelayVerifier) {
    owns(
      "session-execution-relay",
      input.installExecutionRelayVerifier({
        authorize: (request) => sessionExecution.authorizeRelay(request),
      }),
    );
  }
  let detachSessionRecoveryIssuer: (() => void) | undefined;
  if (sessionExecution && input.installSessionRecoveryIssuer) {
    detachSessionRecoveryIssuer = input.installSessionRecoveryIssuer({
      issue: (request) => {
        const binding = store.getSessionExecutionBindingByRuntime(
          request.owner,
          request.runtimeDevice,
          request.source,
          request.sessionId,
          new Date().toISOString(),
        );
        if (!binding) return null;
        if (binding.runtime_resource_id) {
          const allowed = agentRuntimeCredits?.authorizeResource(
            binding.owner,
            binding.runtime_resource_id,
            binding.runtime_owner,
            binding.runtime_device,
          );
          if (!allowed?.ok) return null;
        }
        const development = ticketDevelopment
          ? input.devPipeline!.developmentRecoveryScope(binding.owner, binding.runtime_device, binding.source, binding.session_id)
          : undefined;
        if (!development && input.devPipeline?.developmentSessionRequired(
          binding.owner, binding.runtime_device, binding.source, binding.session_id,
        )) return null;
        const scope = sessionExecution.issueRecovery({
          owner: binding.owner,
          runtimeDevice: binding.runtime_device,
          source: binding.source,
          sessionId: binding.session_id,
        });
        if (!scope) return null;
        return { ...scope, ...(development ? { development } : {}) };
      },
    });
    owns("session-recovery-issuer", detachSessionRecoveryIssuer);
  }
  let detachDispatchPreparer: (() => void) | undefined;
  if (sessionExecution && caps) {
    const prepareSessionDispatch = async (
      _owner: string, operation: string, args: Readonly<Record<string, unknown>>, development: boolean,
    ): Promise<PreparedRunnerDispatch> => {
      if (operation === "get_session_operation") {
        const row = store.getSessionOperation(String(args.operation_id ?? ""), _owner);
        if (!row) {
          // A document assistant's launch, dispatched on a direct grant: the
          // first receipt naming its session records it, then binds the
          // read-only scope issued for the launch.
          const assistant = docAssistants?.placementForOperation(_owner, String(args.operation_id ?? ""));
          if (assistant) {
            if (assistant.device !== args.device) throw new Error("文档助手回执不属于这台设备");
            return { args, afterResult: (result: unknown) => {
              const receipt = sessionOperationReceiptFromWire(result, assistant.id);
              const sessionId = receipt?.input?.session_id ?? receipt?.session_id;
              if (!sessionId) return;
              docAssistants!.attach(assistant.id, _owner, sessionId);
              sessionExecution.bindObservedLaunch({ owner: _owner, runtimeDevice: assistant.device, operationId: assistant.id, source: "claude", sessionId });
            } };
          }
          const turn = store.devTickets.runner.get(String(args.operation_id ?? ""));
          if (!turn) return { args };
          const binding = store.devTickets.runner.binding(turn.ticketId);
          if (!binding || binding.owner !== _owner || binding.device !== args.device) {
            throw new Error("工单回执不属于这个 owner/operation/device 绑定");
          }
          const executionDevice = binding.executionDevice ?? (development ? binding.device : undefined);
          if (turn.method !== "start_session" || !executionDevice || (!development && executionDevice === binding.device)) return { args };
          if (turn.args.source !== binding.source || turn.args.workspace_id !== binding.workspaceId
            || (turn.args.execution_device ?? (development ? binding.device : undefined)) !== executionDevice) {
            throw new Error("工单启动回执与原执行放置不一致");
          }
          return { args, afterResult: (result: unknown) => {
            const receipt = sessionOperationReceiptFromWire(result, turn.id);
            const sessionId = receipt?.input?.session_id ?? receipt?.session_id;
            if (!sessionId) return;
            const operationId = String(turn.args.client_request_id ?? "");
            if (!store.getSessionPlusSplitSession(_owner, binding.device, binding.source, sessionId)
              && sessionExecution.bindObservedLaunch({ owner: _owner, runtimeDevice: binding.device,
                operationId, source: binding.source, sessionId })) {
              const at = new Date().toISOString();
              store.saveSessionPlusSplitSession({ owner: _owner, runtime_owner: _owner, runtime_resource_id: null,
                runtime_device: binding.device, source: binding.source, session_id: sessionId,
                catalog_id: sessionPlusCatalogId(_owner, operationId), execution_device: executionDevice,
                workspace_id: binding.workspaceId, workspace_label: "", workspace_display: "", created_at: at, updated_at: at });
            }
          } };
        }
        if (row.runner_operation_id !== args.operation_id || row.device !== args.device) {
          throw new Error("会话回执不属于这个 owner/operation/device 绑定");
        }
        const target = receiptTargetOf(row);
        if (!target) throw new Error("会话回执缺少精确运行设备绑定");
        if (target.owner === _owner) return { args };
        const allowed = agentRuntimeCredits?.authorizeResource(_owner, target.resourceId!, target.owner, row.device, false);
        if (!allowed?.ok) throw new Error(allowed?.error ?? "共享 Agent 运行读取授权不可用");
        return { args, dispatchOwner: allowed.runtime.owner };
      }
      const includeSessionPlus = args._octopus_include_session_plus === true;
      const {
        _octopus_include_session_plus: _includeSessionPlus,
        ...ordinaryArgs
      } = args;
      void _includeSessionPlus;
      const catalogEntry = (row: SessionPlusSplitSessionRow): PreparedSessionCatalogEntry | null => {
        if (!row.runtime_resource_id) {
          return row.runtime_owner === _owner ? preparedSessionCatalogEntry(row) : null;
        }
        const allowed = agentRuntimeCredits?.authorizeResource(
          _owner,
          row.runtime_resource_id,
          row.runtime_owner,
          row.runtime_device,
          false,
        );
        if (!allowed?.ok) return null;
        return {
          ...preparedSessionCatalogEntry(row),
          runtimeOwner: allowed.runtime.owner,
        };
      };
      if (includeSessionPlus && (operation === "list_recent_sessions" || operation === "search_sessions")) {
        return {
          args: ordinaryArgs,
          sessionCatalog: store.listSessionPlusSplitSessions(_owner).flatMap((row) => {
            const entry = catalogEntry(row);
            return entry ? [entry] : [];
          }),
        };
      }
      if (operation === "append_session" || operation === "resume_session") {
        const identity = { owner: _owner, runtimeDevice: String(args.device ?? ""),
          source: String(args.source ?? ""), sessionId: String(args.id ?? "") };
        let dispatch: SessionExecutionDispatch | null = null;
        // A document assistant's session takes input only while it lives,
        // and renews only as its own read-only scope (the registry takes the
        // flavour from its record, whatever these args ask for). A stop
        // carries no authority and always passes.
        const assistant = docAssistants?.bySession(_owner, identity.runtimeDevice, identity.source, identity.sessionId) ?? null;
        const control = args.interrupt === true || args.release_control === true;
        if (assistant && !assistant.live && !control) throw new Error("这个文档助手已经结束，不能再发消息");
        const turn = assistant ? undefined : store.devTickets.runner.get(String(args.operation_id ?? ""));
        if (turn && args.interrupt !== true && args.release_control !== true) {
          const binding = store.devTickets.runner.binding(turn.ticketId);
          const ticket = store.devTickets.getDevTicket(turn.ticketId);
          if (!binding || binding.owner !== _owner || binding.device !== args.device
            || turn.method !== "append_session" || turn.state !== "dispatched"
            || binding.source !== args.source || turn.args.source !== args.source
            || ticket?.requester !== (binding.requester ?? binding.owner)
            || ticket.session_id !== args.id || turn.args.id !== args.id) {
            throw new Error("工单续轮缺少一致的持久操作与原会话绑定");
          }
          const executionDevice = binding.executionDevice ?? (development ? binding.device : undefined);
          if (executionDevice && (development || executionDevice !== binding.device)) {
            const launch = store.devTickets.runner.latestStart(turn.ticketId);
            const launchId = String(launch?.args.client_request_id ?? "");
            if (!launchId || launch?.args.source !== binding.source
              || launch.args.workspace_id !== binding.workspaceId
              || (launch.args.execution_device ?? (development ? binding.device : undefined)) !== executionDevice) {
              throw new Error("工单续轮缺少原始 split 启动记录");
            }
            dispatch = sessionExecution.renewSession({ ...identity, operationId: turn.id,
              executionDevice, workspaceId: binding.workspaceId,
              permissionProfile: turn.args.permission_profile === "manual" ? "manual" : "full_access" });
            if (!store.getSessionPlusSplitSession(_owner, binding.device, binding.source, identity.sessionId)) {
              const at = new Date().toISOString();
              store.saveSessionPlusSplitSession({ owner: _owner, runtime_owner: _owner, runtime_resource_id: null,
                runtime_device: binding.device, source: binding.source, session_id: identity.sessionId,
                catalog_id: sessionPlusCatalogId(_owner, launchId), execution_device: executionDevice,
                workspace_id: binding.workspaceId, workspace_label: "", workspace_display: "",
                created_at: at, updated_at: at });
            }
          }
        }
        dispatch ??= sessionExecution.dispatchForSession(identity);
        if (assistant && !dispatch && !control) {
          dispatch = sessionExecution.renewSession({ ...identity,
            operationId: typeof args.operation_id === "string" && args.operation_id ? args.operation_id : `renew_${randomUUID()}`,
            executionDevice: assistant.executionDevice, workspaceId: assistant.workspaceId, permissionProfile: "read_only" });
        }
        const researchPlacement = assistant ? undefined : researchNative?.placementForOperation(_owner, String(args.operation_id ?? ''));
        if (researchPlacement && args.interrupt !== true && args.release_control !== true) {
          if (researchPlacement.device !== identity.runtimeDevice) throw new Error('科研运行设备不匹配');
          if (dispatch && (dispatch.workspaceId !== researchPlacement.workspace || dispatch.executionDevice !== researchPlacement.device)) throw new Error('已有会话工作区与科研绑定不一致');
          // Binding an existing native session shares that session; it does not
          // convert its original local placement into a split launch. Only an
          // established execution scope may supply split credentials here.
          // A genuine launch catalog permits renewal after scope expiry. A
          // native binding alone is not evidence that such a launch occurred.
          if (!dispatch) {
            const catalog = store.getSessionPlusSplitSession(_owner, identity.runtimeDevice, identity.source, identity.sessionId);
            if (catalog) {
              if (catalog.runtime_owner !== _owner || catalog.runtime_resource_id
                || catalog.execution_device !== researchPlacement.device || catalog.workspace_id !== researchPlacement.workspace)
                throw new Error('已有会话工作区与科研绑定不一致');
              const issued = sessionExecution.issue({owner: _owner, operationId: String(args.operation_id), runtimeDevice: researchPlacement.device,
                executionDevice: researchPlacement.device, workspaceId: researchPlacement.workspace, permissionProfile: 'full_access'});
              try {issued.bindSession(identity.source, identity.sessionId);} catch (error) {issued.release(); throw error;}
              dispatch = sessionExecution.dispatchForSession(identity);
            }
          }
        }
        // An ordinary Sessions+ split session renews from its persisted launch
        // placement exactly as a ticket does, instead of forcing a new session
        // (and losing its context) once the 24 h credential has ended. Only
        // owner-local placements renew; a shared runtime keeps its own scope.
        if (!dispatch && !turn && !researchPlacement && !assistant && args.interrupt !== true && args.release_control !== true) {
          const catalog = store.getSessionPlusSplitSession(_owner, identity.runtimeDevice, identity.source, identity.sessionId);
          if (catalog && catalog.runtime_owner === _owner && !catalog.runtime_resource_id) {
            dispatch = sessionExecution.renewSession({ ...identity,
              operationId: typeof args.operation_id === "string" && args.operation_id ? args.operation_id : `renew_${randomUUID()}`,
              executionDevice: catalog.execution_device, workspaceId: catalog.workspace_id,
              permissionProfile: args.permission_profile === "manual" ? "manual" : "full_access" });
          }
        }
        if (!dispatch) return { args };
        let dispatchOwner = _owner;
        if (dispatch.runtimeResourceId) {
          // Stop/release is not a new use of the subscription. Keep the exact
          // session's safety control reachable even after credit exhaustion or
          // permit revocation; every prompt-bearing append rechecks both.
          if (args.interrupt === true || args.release_control === true) {
            dispatchOwner = dispatch.runtimeOwner;
          } else {
            const allowed = agentRuntimeCredits?.authorizeResource(
              _owner,
              dispatch.runtimeResourceId,
              dispatch.runtimeOwner,
              String(args.device ?? ""),
            );
            if (!allowed?.ok) throw new Error(allowed?.error ?? "共享 Agent 运行授权不可用");
            dispatchOwner = allowed.runtime.owner;
          }
        }
        if (args.interrupt === true || args.release_control === true) {
          return { args, ...(dispatchOwner !== _owner ? { dispatchOwner } : {}) };
        }
        return {
          args: {
            ...args,
            execution_device: dispatch.executionDevice,
            workspace_id: dispatch.workspaceId,
            _octopus_execution_operation_id: dispatch.operationId,
            _octopus_execution_expires_at: dispatch.expiresAt,
            _octopus_execution_mcp_url: dispatch.endpoint,
            _octopus_execution_mcp_token: dispatch.token,
          },
          ...(dispatchOwner !== _owner ? { dispatchOwner } : {}),
        };
      }
      if (operation === "read_session") {
        if (includeSessionPlus) {
          const catalog = store.getSessionPlusSplitSession(
            _owner,
            String(args.device ?? ""),
            String(args.source ?? ""),
            String(args.id ?? ""),
          );
          if (catalog) {
            const entry = catalogEntry(catalog);
            if (!entry) throw new Error("共享 Agent 运行授权不可用");
            return { args: ordinaryArgs, sessionCatalog: [entry] };
          }
        }
        const binding = store.getSessionExecutionBinding(
          _owner,
          String(args.device ?? ""),
          String(args.source ?? ""),
          String(args.id ?? ""),
          "0000-01-01T00:00:00.000Z",
        );
        // Ticket launches have a durable Runner placement but no Sessions+
        // catalog row. Keep this post-Gate opt-in for the exact native-id read;
        // Runner validates its own placement before selecting the split root.
        if (!binding?.runtime_resource_id) return { args: includeSessionPlus ? args : ordinaryArgs };
        const allowed = agentRuntimeCredits?.authorizeResource(
          _owner,
          binding.runtime_resource_id,
          binding.runtime_owner,
          binding.runtime_device,
          false,
        );
        if (!allowed?.ok) throw new Error(allowed?.error ?? "共享 Agent 运行授权不可用");
        return { args: ordinaryArgs, dispatchOwner: allowed.runtime.owner };
      }
      if (operation !== "start_session") return { args: ordinaryArgs };
      const runtimeDevice = String(args.device ?? "");
      const executionDevice = String(args.execution_device ?? (development ? runtimeDevice : ""));
      const runtimeOwner = String(args._octopus_runtime_owner ?? "").trim();
      const runtimeResourceId = String(args._octopus_runtime_resource_id ?? "").trim();
      if (Boolean(runtimeOwner) !== Boolean(runtimeResourceId)) {
        throw new Error("共享 Agent 运行放置缺少精确资源或资源 owner");
      }
      const {
        _octopus_runtime_owner: _runtimeOwner,
        _octopus_runtime_resource_id: _runtimeResource,
        ...wireArgs
      } = args;
      void _runtimeOwner;
      void _runtimeResource;
      // The `op_fda_` namespace is the document assistants': such a launch is
      // one registered by the bot (live, not yet started) on its placement,
      // or it does not happen — never an ordinary launch with local tools.
      const clientRequestId = String(args.client_request_id ?? "");
      const assistant = docAssistants?.placementForOperation(_owner, clientRequestId) ?? null;
      if (clientRequestId.startsWith(DOC_ASSISTANT_OPERATION_PREFIX) && !assistant) throw new Error("文档助手启动没有登记，或者已经结束");
      if (assistant && (assistant.device !== runtimeDevice || executionDevice !== runtimeDevice || args.workspace_id !== assistant.workspaceId
        || args.directory !== undefined || args.source !== "claude" || runtimeOwner || development || args._octopus_launch_mode !== undefined)) {
        throw new Error("文档助手启动与登记的放置不一致");
      }
      const researchPlacement = assistant ? undefined : researchNative?.placementForOperation(_owner, String(args.client_request_id ?? ''));
      if (researchPlacement && (researchPlacement.device !== runtimeDevice || researchPlacement.device !== executionDevice || researchPlacement.workspace !== args.workspace_id)) throw new Error('科研启动与已授权的工作区不一致');
      if (!runtimeDevice || !executionDevice || (!development && !runtimeOwner && !researchPlacement && !assistant && runtimeDevice === executionDevice)) {
        return { args: wireArgs };
      }
      let dispatchOwner = _owner;
      if (runtimeOwner) {
        const allowed = agentRuntimeCredits?.authorizeResource(
          _owner,
          runtimeResourceId,
          runtimeOwner,
          runtimeDevice,
        );
        if (!allowed?.ok) throw new Error(allowed?.error ?? "共享 Agent 运行授权不可用");
        dispatchOwner = allowed.runtime.owner;
      }
      const workspaceId = String(args.workspace_id ?? "");
      const operationId = String(args.client_request_id ?? "");
      if (!workspaceId || !operationId) {
        throw new Error("跨机器启动缺少已登记工作区或操作标识");
      }
      const credential = sessionExecution.issue({
        owner: _owner,
        runtimeOwner: dispatchOwner,
        runtimeResourceId: runtimeResourceId || null,
        operationId,
        runtimeDevice,
        executionDevice,
        workspaceId,
        ...(assistant
          ? { permissionProfile: "read_only" as const, docShare: assistant.shareId }
          : { permissionProfile: args.permission_profile === "manual" ? "manual" as const : "full_access" as const }),
      });
      const catalogId = sessionPlusCatalogId(_owner, operationId);
      let stopWatching = (): void => {};
      const bindStarted = (result: unknown): void => {
        stopWatching();
        const row = result && typeof result === "object"
          ? result as Record<string, unknown>
          : null;
        if (!row || row.ok === false) {
          credential.release();
          return;
        }
        const sessionId = typeof row.session_id === "string" ? row.session_id.trim() : "";
        if (!sessionId) {
          credential.release();
          return;
        }
        try {
          if (assistant) {
            // Never in the Sessions+ catalog: its record names the session
            // first, so the read-only scope binds only to a registered one.
            docAssistants!.attach(assistant.id, _owner, sessionId);
            if (row.replayed === true) credential.release();
            else credential.bindSession("claude", sessionId);
            return;
          }
          const at = new Date().toISOString();
          const catalogRow: SessionPlusSplitSessionRow = {
            owner: _owner,
            runtime_owner: dispatchOwner,
            runtime_device: runtimeDevice,
            runtime_resource_id: runtimeResourceId || null,
            source: String(args.source ?? "") as "claude" | "codex" | "omp",
            session_id: sessionId,
            catalog_id: catalogId,
            execution_device: executionDevice,
            workspace_id: workspaceId,
            workspace_label: String(args.workspace_label ?? ""),
            workspace_display: String(args.workspace_display ?? ""),
            created_at: at,
            updated_at: at,
          };
          if (row.replayed === true) {
            store.saveSessionPlusSplitSession(catalogRow);
            credential.release();
          } else {
            // Bind execution authority first. If either durable write fails,
            // release rolls the short-lived credential/binding back and an
            // idempotent launch replay can repair both records.
            credential.bindSession(String(args.source ?? ""), sessionId);
            store.saveSessionPlusSplitSession(catalogRow);
          }
        } catch (error) {
          credential.release();
          throw error;
        }
      };
      if (args.input_receipt === true) {
        // Keep the already-issued scope alive until this same durable operation
        // reports its provider identity. A quick running receipt owns no expiry.
        let unsubscribe: () => void = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = (): void => {
          unsubscribe();
          if (timer) clearTimeout(timer);
          pendingBindings.delete(stop);
        };
        pendingBindings.add(stop);
        stopWatching = stop;
        unsubscribe = operations.subscribe(_owner, (view) => {
          if (view.id !== operationId) return;
          if (view.sessionId && view.status === "succeeded") {
            stop();
            bindStarted({ ok: true, session_id: view.sessionId });
          } else if (view.status === "failed" || view.status === "rejected") {
            stop(); credential.release();
          }
        });
        timer = setTimeout(() => { stop(); credential.release(); }, Math.max(1, credential.expiresAt - Date.now()));
        timer.unref?.();
      }
      return {
        args: {
          ...wireArgs,
          execution_device: executionDevice,
          ...(assistant ? {} : { _octopus_session_catalog_id: catalogId }),
          _octopus_execution_operation_id: operationId,
          _octopus_execution_expires_at: credential.expiresAt,
          _octopus_execution_mcp_url: credential.endpoint,
          _octopus_execution_mcp_token: credential.token,
        },
        ...(dispatchOwner !== _owner ? { dispatchOwner } : {}),
        afterResult: (result: unknown) => {
          const receipt = sessionOperationReceiptFromWire(result, String(args.operation_id ?? ""));
          if (!receipt) {
            if (args.input_receipt === true && result && typeof result === "object" && "protocol" in result) return;
            bindStarted(result); return;
          }
          const sessionId = receipt.input?.session_id ?? receipt.session_id;
          if (sessionId) { bindStarted({ ok: true, session_id: sessionId }); return; }
          if (receipt.state === "failed") { stopWatching(); credential.release(); return; }
        },
      };
    };
    detachDispatchPreparer = caps.installDispatchPreparer(async (owner, operation, args) => {
      const developmentArgs: Record<string, string> = ticketDevelopment && args.interrupt !== true && args.release_control !== true
        ? input.devPipeline!.developmentDispatchArgs(owner, operation, args)
        : {};
      const prepared = await prepareSessionDispatch(owner, operation, args, Boolean(developmentArgs._octopus_development_id));
      return { ...prepared, args: { ...prepared.args, ...developmentArgs } };
    });
    owns("session-execution-dispatch", detachDispatchPreparer);
  }
  // One reader of files on an owner's device, for the Feishu Docs image path
  // and the MCP surface's by-reference file sends: the device places a path
  // in a registered workspace; reads use the owner's read-only authority.
  const ownerPrincipal = (owner: string) => ({ username: owner, admin: false, session: false, credential: 'feishu-docs-agent' });
  const callerFiles = input.workspaceFiles ? new DocsWorkspaceFiles(input.workspaceFiles, async (owner, device) => {
    const roster = await hub.roster(ownerPrincipal(owner), owner, { limit: 300, source: 'all' });
    return new Map(roster.sessions.filter((row) => row.deviceId === device && row.cwd).map((row) => [`${row.cliKind}\u0000${row.sessionId}`, row.cwd!]));
  }) : null;
  const mcp = new McpSurface({
    sessionOperations: operations,
    callerFiles: () => callerFiles,
    // Built below with the docs add-on; the MCP surface only ever calls it later.
    feishuDocs: () => feishuDocsAddon ? { call: (tool, owner, args, caller) => feishuDocsAddon!.agentTool(tool, owner, args, caller) } : null,
    feishuDocShares: () => docShares,
    ...(researchCanvas && sessionExecution ? {research: {
      list: (principal: import('./mcp/service.js').McpPrincipal) => {
        const scope = sessionExecution.resolve(principal);
        return scope && researchNative?.contextForExecution(scope) ? researchCanvas.tools : [];
      },
      call: async (principal: import('./mcp/service.js').McpPrincipal, name: string, args: unknown): Promise<import('./mcp/service.js').McpToolOutcome> => {
        const scope = sessionExecution.resolve(principal), context = scope ? researchNative?.contextForExecution(scope) : null;
        if (!context || !researchCanvas.tools.some(tool => tool.name === name)) return {ok: false, code: 'no_authority', message: '这个执行会话没有当前科研项目授权'};
        if (!args || typeof args !== 'object' || Array.isArray(args)) return {ok: false, code: 'invalid_params', message: '工具参数需要对象'};
        try {return {ok: true, result: await researchCanvas.plane.invokeTool(context, name.slice('research_'.length), args as Record<string, unknown>)};}
        catch (error) {return {ok: false, code: 'refused', message: error instanceof Error ? error.message : '项目工具失败'};}
      },
    }} : {}),
    ...(input.knowledge ? { knowledge: {
      sources: (owner: string, action: string, args: Record<string,unknown>) => {
        if (!knowledgeRights(owner).includes("manage_knowledge_sources")) throw new Error("来源管理需要开发或贡献权限");
        return input.knowledge!.sources(owner,action,args);
      },
      repair: (owner: string, action: string, args: Record<string,unknown>) => {
        if (!knowledgeRights(owner).includes("maintain_development_knowledge")) throw new Error("内容纠错需要开发或贡献权限");
        return input.knowledge!.repair(action,args);
      },
      context: async (owner: string, query: string, subject?: string) => {
        if (!knowledgeRights(owner).includes("read_development_knowledge")) throw new Error("开发知识需要开发或贡献权限");
        return subject ? input.knowledge!.chatContext(subject, query) : input.knowledge!.preview("外部开发 Agent", query);
      },
      investigate: (owner: string, subject: string, investigation: unknown) => {
        if (!knowledgeRights(owner).includes("annotate_development_knowledge")) throw new Error("知识调查需要开发或贡献权限");
        const result = input.knowledge!.investigate({ subject_id: subject, investigation, actor: `agent:${owner}` });
        if (!result.ok) throw new Error(result.error);
        return result;
      },
      annotate: (owner: string, subject: string, body: string) => {
        if (!knowledgeRights(owner).includes("annotate_development_knowledge")) throw new Error("知识调查需要开发或贡献权限");
        const result = input.knowledge!.annotate({ subject_id: subject, body, actor: `agent:${owner}` });
        if (!result.ok) throw new Error(result.error);
        return result;
      },
    } } : {}),
    hub,
    permissions,
    workspaceFilesService: workspaceFilesService ?? undefined,
    openWorkspaceAuthority: input.workspaceFiles
      ? (request) => {
          const grant = input.workspaceFiles!.open({
            username: request.owner,
            purpose: "MCP · 工作区文件",
            kind: "session",
            rights: request.rights as Operation[],
            autoAllow: request.autoAllow as Operation[],
            metadata: { surface: "mcp" },
          });
          if (!grant) return null;
          return {
            authority: new GrantWorkspaceFilesAuthority({
              grant,
              devices: () => (caps?.listDevices(request.owner) ?? []).map((row) => ({
                device: row.device,
                label: row.device,
              })),
            }),
            writable: request.rights.includes(WORKSPACE_FILES_WRITE_OPERATION),
            close: () => grant.destroy(),
          };
        }
      : undefined,
    crdt: input.mcpCrdtDocs,
    apps: input.mcpApps ? {
      ...input.mcpApps,
      ...(input.declaredApps ? { management: new SharedAppManagement({ store, trust: appTrust, get: (id) => input.declaredApps!.get(id) }) } : {}),
    } : undefined,
    feishu: input.mcpFeishu,
    discussions: input.discussions,
    meetingTranscription: input.meetingTranscription,
    runnerCapabilities: input.runnerCapabilities,
    feishuPrivilegedRights: input.mcpFeishuPrivilegedOperations,
    memory: userMemory ?? undefined,
    skills: userSkills ?? undefined,
    publicUrl: input.publicUrl,
    sessionExecution: sessionExecution ?? undefined,
    ticketDevelopment: ticketDevelopment ?? undefined,
    executionScopes: executionScopes ?? undefined,
  });
  owns("mcp", () => mcp.close());
  if (caps && input.installLocalAgentBridgeHandler) {
    owns("runner-local-agent-bridge", input.installLocalAgentBridgeHandler({
      registerDevelopment: async (subject, proof, stillAuthorized) => {
        const authorized = () => stillAuthorized() && Boolean(store.getUser(subject.owner)) && resolveCapabilityBits({
          username: subject.owner, admins: input.adminUsers, granted: store.listUserGrants(subject.owner).map(grant => grant.capability),
        }).dev;
        if (!authorized() || !input.devPipeline) throw new Error("native development registration requires the Runner owner's developer permission");
        return input.devPipeline.registerNativeDevelopment(subject, proof, authorized);
      },
      // Owner-only is the default policy. Cross-owner delegation belongs in
      // this controller and must be derived from server-side grants, while the
      // gateway continues to supply only its authenticated socket subject.
      listTargets: async (subject) => {
        const executionTargets = sessionExecution
          ? await sessionExecution.listTargets(subject.owner)
          : [];
        const guiTargets = caps.listGuiAutomationTargets(subject.owner);
        const targets = new Map<string, Record<string, unknown>>(
          executionTargets
            .filter((target) => target.device !== subject.device)
            .map((target) => [target.device, { ...target }] as const),
        );
        for (const target of guiTargets) {
          if (target.device === subject.device) continue;
          const existing = targets.get(target.device);
          targets.set(target.device, {
            ...(existing ?? {
              device: target.device,
              online: true,
              shell: false,
              workspace_files: false,
              workspaces: [],
            }),
            gui_automation: target.gui_automation,
          });
        }
        const project = (target: Record<string, unknown>) => ({
          ...target,
          file_transfer: input.runnerFileTransfers?.supports(subject.owner, String(target.device)) === true,
        });
        const local = executionTargets.find((target) => target.device === subject.device);
        return { targets: [...targets.values()].map(project), ...(local ? { local_target: project({ ...local }) } : {}) };
      },
      listAccountTools: async (subject) => ({
        tools: [...(input.runnerFileTransfers ? FILE_TRANSFER_MCP_TOOLS : []), ...mcp.listTools({
          owner: subject.owner,
          credential: `runner-local:${subject.device}`,
          policy: mcpTokenPolicy({ groups: MCP_AGENT_ACCOUNT_TOOL_GROUPS }),
        })],
      }),
      callAccount: async ({ subject, tool, args, mode, isActive, caller }) => FILE_TRANSFER_MCP_NAMES.has(tool)
        ? input.runnerFileTransfers
          ? input.runnerFileTransfers.call({ subject, mode, isActive }, tool, args)
          : { ok: false, code: "unavailable", message: "file transfer is unavailable" }
        : mcp.callTool({
        owner: subject.owner,
        credential: `runner-local:${subject.device}`,
        policy: mcpTokenPolicy({ groups: MCP_AGENT_ACCOUNT_TOOL_GROUPS }),
        ...(caller ? { caller: { device: subject.device, source: caller.source, sessionId: caller.sessionId } } : {}),
      }, tool, args),
      open: async ({ subject, selection, mode }) => {
        if (!sessionExecution) throw new Error("remote workspace execution is unavailable");
        const scope = await sessionExecution.openLocalAgent({
          owner: subject.owner,
          runtimeDevice: subject.device,
          executionDevice: selection.device,
          ...(selection.workspaceId ? { workspaceId: selection.workspaceId } : {}),
          permissionProfile: mode,
        });
        return {
          call: (tool, args) => mcp.callTool(scope.principal, tool, args),
          isActive: scope.isActive,
          workspaceId: scope.workspaceId,
          close: scope.close,
        };
      },
      openGui: async ({ subject, device }) => caps.openGuiAutomation({
        username: subject.owner,
        controllerDevice: subject.device,
        targetDevice: device,
      }),
    }));
  }

  let detachMcpLifecycle: (() => void) | null = null;
  let detachTentacleLifecycle: (() => void) | null = null;
  if (caps && typeof caps.onTargetSetChanged === "function") {
    detachMcpLifecycle = caps.onTargetSetChanged((event) => mcp.releaseRunnerDevice(event.username, event.device));
    owns("mcp-runner-lifecycle", () => detachMcpLifecycle?.());
    if (tentacle) {
      detachTentacleLifecycle = caps.onTargetSetChanged((event) => {
        if (event.device.startsWith("dsh:")) tentacle.deviceChanged(event.username, event.device);
      });
      owns("tentacle-runner-lifecycle", () => detachTentacleLifecycle?.());
    }
  }

  let transport: DashboardTransportLifecycle | null = null;
  const detachDashboardRevocation = permissions.onRevoked((event) => {
    if (event.subjectType === "service" && event.subjectId === SESSION_HUB_SUBJECT.id) {
      transport?.closeLive(event.owner);
    }
    if (event.subjectType === "app" && event.subjectId === SESSION_PLUS_APP_ID) {
      input.sessionPlusApp?.releaseOwner(event.owner, "capability_grant_revoked");
    }
    if (event.subjectType === 'app' && event.subjectId === RESEARCH_SESSION_PROFILE.app) input.declaredApps?.get(RESEARCH_SESSION_PROFILE.app)?.service?.releaseOwner(event.owner, 'capability_grant_revoked');
    if (event.subjectType === 'app' && event.subjectId === 'research-docs') { researchDocs?.revoke(event.owner); input.declaredApps?.get('research-docs')?.service?.releaseOwner(event.owner, 'capability_grant_revoked'); }
    if (event.subjectType === 'app' && event.subjectId === 'research-v2') {
      researchCanvas?.capabilities.revoke(event.owner);
      researchCanvas?.native?.revoke(event.owner);
      input.declaredApps?.get('research-v2')?.service?.releaseOwner(event.owner, 'capability_grant_revoked');
    }
  });
  owns("dashboard-revocation-listener", detachDashboardRevocation);

  const tearDown = (owner: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log.warn({ err, owner }, "credential teardown failed after the row was already revoked");
    }
  };
  const endCredential = (owner: string, credential: string): void => {
    tearDown(owner, () => hub.releaseCredential(owner, credential));
    tearDown(owner, () => operations.endCredential(owner, credential));
    tearDown(owner, () => input.sessionPlusApp?.releaseCredential(owner, credential));
    tearDown(owner, () => input.declaredApps?.get(RESEARCH_SESSION_PROFILE.app)?.service?.releaseCredential(owner, credential));
    transport?.closeLive(owner, credential);
  };
  let docsAddonAuth: FeishuDocsAddonAuth | null = null;
  let feishuDocsAddon: FeishuDocsAddonService | null = null;
  let docShares: FeishuDocShareService | null = null;
  const endOwner = (owner: string): void => {
    docsAddonAuth?.revokeOwner(owner);
    feishuDocsAddon?.revokeOwner(owner);
    tearDown(owner, () => ticketDevelopment?.releaseOwner(owner));
    tearDown(owner, () => hub.releaseOwner(owner));
    tearDown(owner, () => input.sessionPlusApp?.releaseOwner(owner));
    tearDown(owner, () => input.declaredApps?.get(RESEARCH_SESSION_PROFILE.app)?.service?.releaseOwner(owner));
    transport?.closeLive(owner);
  };

  // `external-app-host/v1`. Built here, from the ports this composition already
  // holds, so an external host reaches the SAME App-trust door, the SAME
  // membership rows and the SAME AppInstanceService the browser page does —
  // there is no second copy of any of the three to drift.
  const externalAppHost = input.externalAppHosts && input.declaredApps
    ? new ExternalAppHostService({
        settings: input.externalAppHosts,
        store,
        app: (stableAppId) => {
          const surface = input.declaredApps!.get(stableAppId);
          if (!surface) return null;
          return {
            stableAppId: surface.stableAppId,
            publisher: surface.publisher,
            title: surface.title,
            packageDigest: surface.packageDigest,
            viewOrigin: surface.viewOrigin,
            ...(surface.viewUrl ? { viewUrl: surface.viewUrl } : {}),
            service: surface.service,
            unavailable: surface.unavailable,
          };
        },
        trust: (owner, release) => appTrust.status(owner, release),
        audit: (entry) => permissions.audit(entry),
      })
    : null;

  if (input.feishuDocsAddon) {
    if (!input.userManager) throw new Error('Docs add-on needs the existing user identity registry');
    docsAddonAuth = new FeishuDocsAddonAuth(input.feishuDocsAddon, (id) => input.userManager!.resolve('feishu', id)?.username, endCredential);
    owns('feishu-docs-addon', () => docsAddonAuth?.close());
    const agent = input.feishuDocsAgent;
    const docs = agent ? new FeishuDocsClient(agent.userToken, fetch, agent.appToken) : null;
    // Document share links run as the app: only with the app's own credentials. A share's
    // command reaches its owner as a private message from the same app the notices use.
    docShares = docs && agent?.appToken ? new FeishuDocShareService({
      links: store.feishuDocShareLinks, tokens: store, docs, componentTypeId: agent.componentTypeId,
      publicUrl: input.publicUrl, notifyOwner: agent.notify,
      // An assistant's share answers only to the live read-only scope made for it; ending the share ends the assistant.
      assistantScope: (caller) => sessionExecution?.docShareScope(caller.owner, caller.credential) ?? null,
      onAssistantEnded: (shareId) => docAssistants?.ended(shareId),
      assistantSettings: (anchorId) => docAssistants?.settingsOf(anchorId),
    }) : null;
    const displayName = (username: string) => store.getSetting(username, 'display_name') || username;
    const notifier = agent ? new DocsNotifier(agent.notify, (owner, kind, error) => log.warn({ err: error, owner, kind }, 'Feishu Docs notice could not be delivered')) : null;
    docAssistants = docShares && docs && caps && sessionExecution ? new FeishuDocAssistants({
      assistants: store.feishuDocAssistants, links: store.feishuDocShareLinks, docShares, cards: store.feishuDocsShares,
      caps, executions: sessionExecution, docs, ...(agent?.componentTypeId ? { componentTypeId: agent.componentTypeId } : {}),
      launchDefaults: (owner) => readDefaults(store.getSetting(owner, LAUNCH_DEFAULTS_KEY)), displayName,
      ...(notifier ? { notify: (owner: string, notice: DocsNotice) => notifier.notify(owner, notice) } : {}),
      transaction: (work) => store.withinTransaction(work),
    }) : null;
    feishuDocsAddon = new FeishuDocsAddonService(docsAddonAuth, hub, operations, store.feishuDocsShares,
      displayName, Date.now, {
        ...(agent && docs ? {
          docs,
          ...(notifier ? { notifier } : {}),
          ...(agent.componentTypeId ? { componentTypeId: agent.componentTypeId } : {}),
        } : {}),
        ...(docShares ? { docShares } : {}),
        ...(docAssistants ? { assistants: docAssistants } : {}),
        ...(caps ? { launcher: new DocsLauncher(caps, input.sessionBranches) } : {}),
        ...(callerFiles ? { files: callerFiles } : {}),
        grants: store.workspaceGrants,
        boards: store.feishuDocsBoards,
        speakers: store.feishuDocsSpeakers,
        ...(caps ? { readOnly: (owner: string, device: string) => caps.isReadOnly(owner, device) } : {}),
        members: () => store.loadUsers()
          .filter((user) => store.getIdentitiesByUser(user.username).some((identity) => identity.provider === 'feishu'))
          .map((user) => ({ username: user.username, name: store.getSetting(user.username, 'display_name') || user.username })),
        settings: { get: (owner, key) => store.getSetting(owner, key), set: (owner, key, value) => store.setSetting(owner, key, value) },
      });
    owns('feishu-docs-addon-shares', () => feishuDocsAddon?.close());
  }
  let lazyQuota = input.quotaProbe ?? null;
  let lazyCodexQuota = input.codexQuotaProbe ?? null;
  let lazySystemStatus = input.systemStatusProbe ?? null;
  const services: DashboardServices = {
    store,
    caps: caps ?? null,
    approvals: capabilityService,
    sessions: new WebSessionManager(store),
    oauthStates: new StateStore(),
    pendingRegistrations: new PendingRegistrationStore(),
    permissions,
    permissionStudio,
    tentacle,
    appTrust,
    hub,
    operations,
    mcp,
    userManager: input.userManager ?? null,
    feishuOAuth: input.feishuOAuth ?? null,
    feishuDocsAddon,
    discussions: input.discussions,
    sessionPlusEnabled: Boolean(input.sessionPlus),
    sessionPlusSettings,
    sessionPlusApp: input.sessionPlusApp ?? null,
    sessionPlusRelease: input.sessionPlusRelease ?? null,
    workspaceFiles: input.workspaceFiles ?? null,
    appReleases: input.appReleases ?? null,
    declaredApps: input.declaredApps ?? null,
    externalAppHost,
    devPipeline: input.devPipeline ?? null,
    fableTicketApprovals,
    architecture: input.architecture ?? null,
    knowledge: input.knowledge ?? null,
    knowledgeChat: input.knowledgeChat ?? null,
    deployService: input.deployService ?? null,
    feishuDirectory: input.feishuDirectory ?? null,
    registerUser: input.registerUser ?? null,
    declareApp: input.declareApp ?? null,
    publishPendingAppReleases: input.publishPendingAppReleases ?? null,
    appHotswapApprovals: input.appHotswapApprovals ?? null,
    contribReview: input.contribReview ?? null,
    contribBundles: input.contribBundles ?? null,
    quotaProbe: () => lazyQuota ??= new QuotaProbe(),
    codexQuotaProbe: () => lazyCodexQuota ??= new CodexQuotaProbe(),
    systemStatusProbe: () => lazySystemStatus ??= new SystemStatusProbe(),
    endCredential,
    endOwner,
  };
  const options: DashboardOptions = {
    port: input.port,
    host: input.host,
    authToken: input.authToken,
    surface: input.surface,
    adminUsers: input.adminUsers,
    deployers: input.deployers,
    runnerWsPort: input.runnerWsPort,
    runnerBundle: input.runnerBundle,
    runnerPublicUrl: input.runnerPublicUrl,
    publicHost: input.publicHost,
    publicUrl: input.publicUrl,
    oauthGithub: input.oauthGithub,
    registration: input.registration,
    githubFetcher: input.githubFetcher,
    sessionHubUi: input.sessionHubUi,
    devScanHome: input.devScanHome,
  };

  let closed = false;
  startupUndo.splice(0);
  return {
    options,
    services,
    attachTransport(next) {
      transport = next;
      return () => {
        if (transport === next) transport = null;
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      transport = null;
      detachDispatchPreparer?.();
      detachSessionRecoveryIssuer?.();
      detachRunnerLifecycle?.();
      detachRunnerLifecycle = null;
      detachMcpLifecycle?.();
      detachMcpLifecycle = null;
      detachTentacleLifecycle?.();
      detachTentacleLifecycle = null;
      detachDashboardRevocation();
      docsAddonAuth?.close();
      permissionStudio.close();
      for (const stop of [...pendingBindings]) stop();
      operations.close();
      mcp.close();
      tentacle?.close();
      await resourceCatalog?.shutdown().catch(() => undefined);
      permissions.close();
      authorization.close();
      ownedCapabilityService?.close();
    },
  };
}

function syncSessionPlusConfigGrants(
  store: Store,
  permissions: PermissionService,
  settings: SessionPlusSettings,
): void {
  const configured = new Set(settings.grants.map((grant) => grant.owner));
  for (const row of store.listAllGrantIntents()) {
    if (row.subject_type !== "app" || row.subject_id !== SESSION_PLUS_APP_ID || row.source !== "config") continue;
    if (configured.has(row.owner)) continue;
    permissions.revoke({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: row.owner,
      by: "system:config",
    });
  }
  for (const grant of settings.grants) {
    if (!store.getUser(grant.owner)) {
      throw new Error(`session_plus.grants references unknown user: ${grant.owner}`);
    }
    const covering = sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, grant.operations);
    if (!covering) {
      throw new Error(`session_plus.grants.${grant.owner} 申请了本构建任何权限契约都不包含的 operation`);
    }
    const existing = permissions.get("app", SESSION_PLUS_APP_ID, grant.owner);
    if (
      existing?.status === "active"
      && existing.source === "config"
      && existing.publisher === SESSION_PLUS_PUBLISHER
      && existing.contractDigest === covering.digest
      && sameStringSet(existing.operations, grant.operations)
      && sameStringSet(existing.autoAllow, grant.autoAllow)
    ) continue;
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: grant.owner,
      operations: grant.operations,
      autoAllow: grant.autoAllow,
      source: "config",
      createdBy: "system:config",
      contractDigest: covering.digest,
      publisher: SESSION_PLUS_PUBLISHER,
    });
  }
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * Compose and start the bootstrap. Returns once every service is listening.
 *
 * Ordering matters in one place: the runner gateway hands
 * its raw transport to the Runner Object adapter before anything else can ask
 * for a device, and known accounts are registered up front so a capability
 * whose Object was never re-registered denies rather than dangles.
 */
/**
 * Budget for one isolated CI-workspace sync. A new ticket may pay one pnpm
 * relink after its bundle arrives; a wedged ssh must not hold the development
 * turn hostage — the prompt can fall back to scoped checks on this node.
 */
const CI_MACHINE_SYNC_TIMEOUT_MS = 4 * 60_000;
const execFileAsync = promisify(execFile);

export async function startBootstrapV3(o: BootstrapOptions): Promise<BootstrapV3> {
  const { config, dataDir } = o;
  configureDashboardAssetArchive(path.join(dataDir, "dashboard-assets"));
  const convergenceUsage = configureConvergenceUsage(path.join(dataDir, "convergence-usage"));
  const services: BootstrapService[] = [];
  const directSubmitAutoAllowUsers = [...new Set(
    (config.session_hub?.direct_submit_auto_allow_users ?? [])
      .map((u) => String(u).trim())
      .filter(Boolean),
  )];
  const directSubmitSet = new Set(directSubmitAutoAllowUsers);

  config.instance.data_dir = dataDir;

  // 0a. SEC-06 execution profile, DECLARED rather than defaulted.
  //
  //     The engine's default is already the strict one, so omitting this was
  //     never a hole — but a profile nobody declared cannot print the
  //     `local-owner` disclosure ("this deployment makes no multi-user file
  //     isolation promise"), and an operator who believes they configured one
  //     had no way to discover they had not. `deploymentProfileDeclared()` is
  //     in the startup inventory for exactly that reason.
  //
  //     Two config keys can name it, so the conflict is refused rather than
  //     resolved by precedence: a host where two settings disagree about what
  //     kind of host it is should not start and guess.
  const appAgentsConfig = config.app_agents ?? {};
  const declaredProfile = appAgentsConfig.deployment_profile;
  const legacyProfile = config.v3_host?.deployment_profile;
  if (declaredProfile && legacyProfile && declaredProfile !== legacyProfile) {
    throw new Error(
      `部署执行分类被声明了两次且不一致：app_agents.deployment_profile=${declaredProfile}，`
      + `v3_host.deployment_profile=${legacyProfile}。请只保留一处。`,
    );
  }
  setDeploymentProfile(declaredProfile ?? legacyProfile);

  // 0. Session Plus (M0/M1), resolved BEFORE anything is constructed or bound.
  //
  //    Two reasons for the position. It has to be validated before the panel is
  //    built, because the panel's only uses of it — admitting `/sessions-plus`
  //    and naming one exact origin in that page's `frame-src` — must never run
  //    on an unchecked value. And it has to be validated before any listener
  //    opens, so a refusal leaves nothing half-started behind it.
  //
  //    `enabled: true` with an unusable block is fatal rather than skipped: an
  //    operator who wrote it believes the feature is running, and a control
  //    plane that looks configured while serving nothing is the worse outcome.
  // A test may replace the checkout bundle that seeds a fresh registry. Capture
  // that immutable object once: configuration preflight and first-boot seeding
  // must describe the same bytes even when the checkout changes between those
  // two phases in a long-lived full-suite process. Production has no injection
  // and keeps the ordinary checkout-derived path.
  const sessionPlusCheckout = config.session_plus?.enabled
    ? o.sessionPlusCheckoutBundle?.()
    : undefined;
  const sessionPlusCheckoutIdentity = sessionPlusCheckout
    ? sessionPlusIdentityOf(sessionPlusCheckout.descriptor, {
        backendCodeDigest: backendRelease(bundledAppDir("session-plus")).backendCodeDigest,
      })
    : undefined;
  const sessionPlusResolution = resolveSessionPlus({
    config: config.session_plus,
    publicUrl: config.dashboard?.public_url,
    dashboardPort: config.dashboard?.port ?? 9820,
    ...(sessionPlusCheckoutIdentity ? { identity: sessionPlusCheckoutIdentity } : {}),
  });
  if (sessionPlusResolution.enabled && !sessionPlusResolution.settings) {
    throw new Error(
      `session_plus 配置不可用,拒绝启动:\n  - ${sessionPlusResolution.errors.join("\n  - ")}\n`
        + `  (本次构建的 Agent View 主机名前缀应当是 ${sessionPlusIdentity().packageHostLabel})`,
    );
  }
  const sessionPlus: SessionPlusSettings | null = sessionPlusResolution.enabled
    ? sessionPlusResolution.settings
    : null;
  // `external-app-host/v1`. Parsed here with the other feature settings so a
  // malformed allowlist is a boot failure, not a surface that silently serves
  // nobody. `null` = no external host may hold a binding.
  const externalAppHosts = externalAppHostSettings(config.external_app_hosts);
  if (sessionPlus && !config.dashboard?.enabled) {
    // The View is only reachable through a page the panel serves, and its
    // `frame-ancestors` names that panel's origin. With no dashboard the whole
    // feature resolves, binds a second listener, and serves a document nothing
    // may frame — an experiment that is "on" and cannot work. Same rule as an
    // unusable block: an operator who wrote `enabled: true` believes it runs.
    throw new Error(
      "session_plus.enabled 为 true,但 dashboard 未启用:Agent View 只能被主站页面框住,"
        + "没有主站就没有 frame-ancestors,也没有 /sessions-plus 这个入口。请一并启用 dashboard",
    );
  }

  // ── Transactional composition ────────────────────────────────────────────
  //
  // Every step below may fail — a port is taken, a repo is missing, a database
  // is locked — and until this existed, a failure left whatever earlier steps
  // had already opened: a reachable dashboard, a runner gateway accepting
  // laptops, and the kernel's single-writer lease on `capabilities.db`, which
  // then stops the NEXT process from starting. `opened` is the undo stack; a
  // throw runs it in reverse and rethrows the original error.
  // @architecture flow=v3-lifecycle step=compose after=process-start role=composition label="Construct only the explicit v3 service inventory" condition="configuration preflight succeeds" outcome=resources-opened authority="explicit v3 composition root" enforces=LIFE-001
  const opened: Array<{ what: string; close: () => Promise<void> | void }> = [];
  const unwind = async (cause: unknown): Promise<never> => {
    for (const step of [...opened].reverse()) {
      try {
        await step.close();
      } catch (err) {
        log.warn({ err, step: step.what }, "failed to close a resource while unwinding a failed startup");
      }
    }
    log.error({ err: cause, opened: opened.map((s) => s.what) }, "bootstrap-v3 startup failed; everything it opened is closed");
    throw cause;
  };

  try {
  // 1. Storage and identity.
  const dbPath = path.join(dataDir, "bot.db");
  const store = new Store(dbPath);
  opened.push({ what: "store", close: () => store.close() });
  services.push("store");
  log.info({ db: dbPath }, "store opened");

  const userManager = new UserManagerImpl(store, dataDir, false);
  await userManager.restore();
  services.push("user-manager");

  // The one Feishu app this process speaks as: user OAuth, MCP, Docs and the
  // owner's identity binding all use it. The legacy `channels.feishu` block is
  // only a fallback and is absent in production, so direct owner notices
  // (Agent completion, Runner online) are sent as this app too.
  const feishuCredentials = config.feishu_oauth?.app_id && config.feishu_oauth.app_secret
    ? { appId: config.feishu_oauth.app_id, appSecret: config.feishu_oauth.app_secret }
    : config.channels.feishu?.enabled && config.channels.feishu.app_id && config.channels.feishu.app_secret
      ? { appId: config.channels.feishu.app_id, appSecret: config.channels.feishu.app_secret }
      : null;
  const feishuDirectApp = feishuCredentials
    ? { enabled: true, app_id: feishuCredentials.appId, app_secret: feishuCredentials.appSecret }
    : undefined;

  // This composition deliberately has no legacy chat Router, but its agents
  // still owe their owner a completion signal. Use the same stored bot identity
  // and direct-card fallback Router uses when no live private channel exists.
  const agentCompletion = new AgentCompletionRelay();
  const detachAgentCompletion = agentCompletion.subscribe(directAgentCompletionSink({
    recipientFor: (owner) => feishuOpenIdOf(store, owner),
    send: (openId, card) => sendFeishuCardDirect({
      feishu: feishuDirectApp,
      receiveIdType: "open_id",
      receiveId: openId,
      card,
      disabledError: "飞书应用未配置，无法发送 Agent 完成通知",
      sendErrorLabel: "发送 Agent 完成通知失败",
      availabilityHint: true,
    }),
    failed: (event, err) => log.warn(
      { err, owner: event.owner, surface: event.surface, runId: event.runId.slice(0, 16) },
      "Agent completion notice could not be delivered",
    ),
  }));
  opened.push({ what: "agent-completion", close: detachAgentCompletion });

  const runnerBundles = config.runner?.enabled || config.dashboard?.enabled
    ? new RunnerBundleRegistry(path.join(dataDir, "runner-bundles"))
    : null;
  if (runnerBundles) {
    const health = runnerBundles.initialize(
      path.join(PROJECT_ROOT, "packages/runner/dist/standalone.js"),
    );
    const details = {
      activeSha: health.activeSha,
      previousSha: health.previousSha,
      protocol: health.gatewayProtocol,
      ...(health.error ? { error: health.error } : {}),
    };
    if (health.ok) log.info(details, "runner bundle registry ready");
    else log.error(details, "runner bundle registry has no healthy active artifact");
  }

  // 2. Runner gateway, its capability registry, and the loopback the granted
  //    Contexts are handed out through. The gateway is transport only: the raw
  //    dispatch is claimed once, here, so from this line on nothing reaches a
  //    device without deriving a Context first.
  let runnerGateway: RunnerGateway | null = null;
  let runnerTransport: RunnerTransport | null = null;
  let runnerCaps: RunnerCapabilities | null = null;
  let sessionProjection: RunnerSessionProjectionService | null = null;
  let workspaceFilesCaps: WorkspaceFilesCapabilities | null = null;
  let executionWorkspaceCaps: ExecutionWorkspaceCapabilities | null = null;
  let sessionBranchCaps: SessionBranchCapabilities | null = null;
  let runnerExtensionCaps: RunnerExtensionCapabilities | null = null;
  let meetingTranscriptionCaps: MeetingTranscriptionCapabilities | null = null;
  let runnerFileTransfers: RunnerFileTransfers | null = null;
  let agentInteractionCaps: AgentInteractionCapabilities | null = null;
  let tentacleBroker: TentacleBroker | null = null;
  let tentacleCaps: TentacleCapabilities | null = null;
  let feishuBackend: LarkMcpBackend | null = null;
  let feishuCaps: FeishuCapabilities | null = null;
  let feishuOAuth: FeishuOAuthPortal | null = null;
  let feishuAuth: FeishuAuthManager | null = null;
  let discussions: DiscussionCapabilities | undefined;
  const researchGroupReceivers = new Set<(message: FeishuOAuthCommandMessage) => void>();
  let loopback: CapabilityLoopback | null = null;
  const resourceRecovery = new ResourceRecoveryService(store.resourceWaiters);
  const managedSupervisor = new ManagedExecutionSupervisor(store.managedExecutions, resourceRecovery);
  opened.push({ what: "managed-execution", close: () => managedSupervisor.close() });
  if (config.runner?.enabled) {
    runnerGateway = new RunnerGateway(store, {
      port: config.runner.port ?? 9910,
      host: config.runner.host,
      ...(runnerBundles ? { bundleSource: runnerBundles } : {}),
    });
    const detachManagedSessionCompletions = runnerGateway.subscribeManagedSessionCompletions(
      (owner, device, completion) => {
        // Reconnects replay receipts; each one notifies its owner at most once.
        const notice = managedCompletionNotice(owner, device, completion,
          (row, notBefore) => store.claimManagedCompletionNotice(row, notBefore));
        if (notice) agentCompletion.publish(notice);
      },
    );
    opened.push({ what: "managed-session-completions", close: detachManagedSessionCompletions });
    // Inventory follows the dependency graph; the actual listener opens only
    // after DashboardServer has installed TentacleService below.
    services.push("runner-gateway");
    const tentacleTransport = runnerGateway.claimTentacleTransport({
      authenticate: (token) => resolveTentacleMcpCredential(store, token),
      active: (credential) => tentacleMcpCredentialIsActive(store, credential),
    });
    // ONE claim, two planes. `claimTransport()` throws on a second call, which
    // is the point: the raw dispatch leaves the gateway exactly once, here, and
    // both capability Objects hold the same trusted transport rather than a
    // second WebSocket or a second gateway.
    const transport = runnerGateway.claimTransport();
    const projectionTransport = runnerGateway.claimSessionProjectionTransport();
    sessionProjection = new RunnerSessionProjectionService(
      path.join(dataDir, "session-projections.db"),
      projectionTransport,
    );
    opened.push({ what: "runner-session-projection", close: () => sessionProjection!.close() });
    runnerTransport = transport;
    // "Resource X is back" → every scope that was told to wait for it hears
    // so (resources/recovery.ts). Registered here, on the gateway itself,
    // because presence is a transport fact and the transport is claimed once.
    const recovery = resourceRecovery;
    opened.push({
      what: "resource-recovery-presence",
      close: runnerGateway.subscribePresence((owner, device, online) => {
        if (online) void recovery.recovered(runnerResource(owner, device));
      }),
    });
    runnerCaps = new RunnerCapabilities(store, transport, {
      store: new SqliteCapabilityStore(path.join(dataDir, "capabilities.db")),
      extraRootAutoAllow: (username) => directSubmitSet.has(username) ? ["append_session"] : [],
      projectionReadCache: sessionProjection,
    });
    for (const u of store.loadUsers()) runnerCaps.ensureAccount(u.username);
    const detachSessionProjectionTargets = runnerCaps.onTargetSetChanged((event) => {
      sessionProjection?.purgeDevice(event.username, event.device);
    });
    opened.push({ what: "runner-session-projection-targets", close: detachSessionProjectionTargets });
    tentacleBroker = new TentacleBroker(tentacleTransport);
    tentacleCaps = new TentacleCapabilities(store, runnerCaps.service, tentacleBroker);
    opened.push({ what: "tentacle-gate", close: () => tentacleBroker!.close() });
    services.push("tentacle-gate");
    // The kernel takes a single-writer lease on capabilities.db; leaking it
    // means the NEXT process cannot start at all. Registered against the RUNNER
    // plane because that is what owns the shared service — the workspace plane
    // below borrows it and must not close it a second time.
    opened.push({ what: "runner-capabilities", close: () => runnerCaps!.service.close() });
    services.push("runner-capabilities");

    // A SECOND capability Object over the same laptops, versioned on its own so
    // that adding a backend module never invalidates an account's Runner
    // capabilities or its undecided approval cards. It shares the process's one
    // kernel — a Context minted by another service means nothing here, and the
    // SQLite store takes a single-writer lease.
    workspaceFilesCaps = new WorkspaceFilesCapabilities({
      service: runnerCaps.service,
      transport,
      userExists: (username) => Boolean(store.getUser(username)),
      hasDevice: (username) => store.listRunnerTokens(username).length > 0,
    });
    services.push("workspace-files-capabilities");
    executionWorkspaceCaps = new ExecutionWorkspaceCapabilities({
      service: runnerCaps.service,
      transport,
      userExists: (username) => Boolean(store.getUser(username)),
      hasDevice: (username) => store.listRunnerTokens(username).length > 0,
    });
    const detachExecutionWorkspace = runnerCaps.onTargetSetChanged((event) => {
      executionWorkspaceCaps?.revokeDevice(event.username, event.device);
    });
    opened.push({ what: "execution-workspace-capabilities", close: detachExecutionWorkspace });
    services.push("execution-workspace-capabilities");
    sessionBranchCaps = new SessionBranchCapabilities({
      service: runnerCaps.service,
      transport,
      userExists: (username) => Boolean(store.getUser(username)),
      hasDevice: (username) => store.listRunnerTokens(username).length > 0,
    });
    const detachSessionBranches = runnerCaps.onTargetSetChanged((event) => sessionBranchCaps?.revokeDevice(event.username, event.device));
    opened.push({ what: "session-branch-capabilities", close: detachSessionBranches });
    services.push("session-branch-capabilities");
    runnerFileTransfers = new RunnerFileTransfers({
      service: runnerCaps.service, transport,
      userExists: (owner) => Boolean(store.getUser(owner)),
      devices: (owner) => runnerCaps!.listDevices(owner),
    });
    const detachFileTransfers = runnerCaps.onTargetSetChanged((event) => runnerFileTransfers?.revokeDevice(event.username, event.device));
    opened.push({ what: "runner-file-transfers", close: async () => { detachFileTransfers(); await runnerFileTransfers?.close(); } });
    services.push("runner-file-transfers");


    agentInteractionCaps = new AgentInteractionCapabilities({
      service: runnerCaps.service,
      transport,
      userExists: (username) => Boolean(store.getUser(username)),
      hasDevice: (username) => store.listRunnerTokens(username).length > 0,
    });
    const detachAgentInteractions = agentInteractionCaps.attachToRunnerLifecycle(runnerCaps);
    opened.push({ what: "agent-interactions-capabilities", close: detachAgentInteractions });
    services.push("agent-interactions-capabilities");

    runnerExtensionCaps = new RunnerExtensionCapabilities({
      service: runnerCaps.service, transport,
      userExists: owner => Boolean(store.getUser(owner)),
      hasDevice: owner => store.listRunnerTokens(owner).length > 0,
    });
    const detachRunnerExtensions = runnerCaps.onTargetSetChanged(event => runnerExtensionCaps?.revokeAccount(event.username));
    opened.push({ what: "runner-extension-capabilities", close: detachRunnerExtensions });
    services.push("runner-extension-capabilities");

    // Recording jobs use their own closed capability Object and device scope;
    // they do not acquire the account's general command-execution rights.
    meetingTranscriptionCaps = new MeetingTranscriptionCapabilities({
      service: runnerCaps.service,
      transport,
      userExists: (username) => Boolean(store.getUser(username)),
      hasDevice: (username) => store.listRunnerTokens(username).length > 0,
    });
    const detachMeetingTranscription = meetingTranscriptionCaps.attachToRunnerLifecycle(runnerCaps);
    opened.push({ what: "meeting-transcription-capabilities", close: detachMeetingTranscription });
    services.push("meeting-transcription-capabilities");

    loopback = new CapabilityLoopback({ ...(resourceRecovery ? { recovery: resourceRecovery } : {}) });
    await loopback.start();
    opened.push({ what: "capability-loopback", close: () => loopback!.stop() });
    services.push("capability-loopback");
  } else {
    log.warn("runner.enabled is false — no laptop endpoints, so the session hub sees only this host");
  }

  // 2b. Feishu reconnects as a generic user-OAuth capability plane, not as
  // the legacy chat Router. Credentials remain in this trusted process; MCP
  // callers see only reviewed catalog operations. No user token means deny —
  // never a fallback to the tenant bot identity.
  validateFeishuGatewayConfig(config.feishu_gateway);
  // "Tell me when this device is back" (runner/online-notice.ts): one card to
  // the owner's own private chat, sent like Agent completion notices.
  if (runnerGateway) {
    opened.push({
      what: "runner-online-notices",
      close: runnerGateway.subscribePresence(runnerOnlineNotices({
        channel: (owner, device) => runnerOnlineNotice(store, owner, device),
        displayName: (owner, device) => runnerDisplayName(store, owner, device),
        sendFeishu: async (owner, card) => {
          const openId = feishuOpenIdOf(store, owner);
          if (!openId) throw new Error("owner has no Feishu identity");
          await sendFeishuCardDirect({
            feishu: feishuDirectApp,
            receiveIdType: "open_id",
            receiveId: openId,
            card,
            disabledError: "飞书应用未配置，无法发送设备上线通知",
            sendErrorLabel: "发送设备上线通知失败",
            availabilityHint: true,
          });
        },
        sent: (owner, device) => log.info({ owner, device }, "Runner online notice sent"),
        failed: (owner, device, err) => log.warn({ err, owner, device }, "Runner online notice could not be delivered"),
      })),
    });
  }
  if (runnerCaps && feishuCredentials) {
    const auth = feishuAuth = new FeishuAuthManager(feishuCredentials, userManager);
    feishuOAuth = new FeishuOAuthPortal(auth, userManager);
    services.push("feishu-oauth");
    // lark-cli runs here too, beside lark-mcp and never on a Runner: the user's
    // token stays on this host. Its per-call sandboxes live under the data dir,
    // not /tmp, which each call replaces with a private tmpfs.
    feishuBackend = new LarkMcpBackend({
      ...feishuCredentials,
      larkCli: new LarkCliExecutor({ appId: feishuCredentials.appId, sandboxRoot: path.join(dataDir, "lark-cli-runs") }),
    });
    // By-reference bot file sends read the approved file at execution time,
    // under the owner's own read-only Workspace Files authority (the Docs
    // image path's). Only reads: path placement happened at the MCP surface.
    const sourceReader = workspaceFilesCaps ? new DocsWorkspaceFiles(workspaceFilesCaps, async () => new Map()) : null;
    feishuCaps = new FeishuCapabilities({
      service: runnerCaps.service,
      backend: feishuBackend,
      ...(sourceReader ? { sourceFiles: {
        read: async (owner: string, device: string, workspaceId: string, relativePath: string) => {
          const content = await sourceReader.read(owner, device, { workspace: { workspaceId, label: workspaceId }, relativePath });
          if (content.kind !== "file") throw new Error("按路径发送的目标已不是文件");
          return { size: content.size, chunks: content.chunks };
        },
      } } : {}),
      resolver: {
        userToken: (username) => auth.getUserToken(username),
        userScopes: async (username) => auth.getUserScopes(username),
        serviceAccountAvailable: () => true,
      },
      isUser: (username) => Boolean(userManager.get(username)),
      onIdentityUnavailable: (username, operation, reason) =>
        feishuOAuth!.requireReconnect(username, operation, reason),
    });
    const verified = await feishuCaps.verifyCatalog();
    log.info(
      { unclassified: verified.unclassified.length, disabled: verified.missing.length },
      "Feishu user-OAuth catalog verified for the MCP capability plane",
    );
    opened.push({ what: "feishu-gateway", close: () => feishuBackend!.stop() });
    services.push("feishu-gateway");
    if (config.channels.feishu?.enabled) {
      if (config.discussions?.enabled !== false) {
        const meetings = new DiscussionService(store, new FeishuDiscussionTransport(feishuCredentials.appId, feishuCredentials.appSecret), new DiscussionModelClient({ baseUrl: config.openai?.base_url ?? '', apiKey: config.openai?.api_key ?? '' }), config.discussions, managedSupervisor);
        discussions = new DiscussionCapabilities(runnerCaps.service, meetings, owner => Boolean(store.getUser(owner)));
        meetings.restore();
        opened.push({ what: 'discussions', close: () => meetings.close() });
        services.push('discussions');
      }
      const oauthCommands = new FeishuOAuthCommands(
        new LarkFeishuOAuthCommandTransport(feishuCredentials.appId, feishuCredentials.appSecret, { receive: message => {
          discussions?.discussions.receive(message);
          for (const receive of researchGroupReceivers) receive(message);
        }, botOpenId: config.channels.feishu.bot_open_id }),
        feishuOAuth,
        userManager,
        (username) => feishuCaps!.revokeUser(username),
        config.dashboard?.public_url,
      );
      await oauthCommands.start();
      opened.push({ what: "feishu-oauth-commands", close: () => oauthCommands.stop() });
      services.push("feishu-oauth-commands");
    }
  } else if (feishuCredentials) {
    log.warn("Feishu credentials are configured but runner.enabled is false; no capability kernel, so Feishu MCP is not composed");
  }
  // /admin's onboarding console reads the tenant with the SAME app credentials
  // (feishu_oauth first, then a legacy channel). Without this the page said
  // "未配置飞书 app_id/app_secret" on a host whose credentials were configured;
  // a Feishu API refusal is now reported by the page as the real error.
  const feishuDirectory = feishuCredentials ? new FeishuDirectory(feishuCredentials) : null;
  if (feishuDirectory) services.push("feishu-directory");

  // 3. Dev pipeline and deploy, on the v3 branch line.
  let devPipeline: DevPipeline | null = null;
  let deployService: DeployService | null = null;
  let gitlabCiMonitor: GitLabCiMonitor | null = null;
  let contribReview: ContribReviewService | null = null;
  let contribBundles: BundleHandoff | null = null;
  let developmentWorkspaces: DashboardCompositionOptions["developmentWorkspaces"];
  let architectureRunner: ArchitectureServiceOptions["runAnalyzer"];
  let appPackRunner: ReturnType<typeof runnerAppPacker> | undefined;
  if (config.selfhosting?.enabled) {
    // Both artifact sources leave the application as a control node. GitLab
    // replaces release building, not the configured knowledge/App providers.
    const externalCompute = Boolean(config.selfhosting.deployment_build);
    const repoDir = config.selfhosting.repo_dir ?? PROJECT_ROOT;
    const baseBranch = config.selfhosting.base_branch ?? V3_BASE_BRANCH;
    const stableBranch = config.selfhosting.stable_branch ?? V3_STABLE_BRANCH;
    const gitlabMainline = config.selfhosting.mainline?.authority === "gitlab"
      ? new GitLabMainline({ repoDir, branch: baseBranch, remote: config.selfhosting.mainline.remote,
        controlBranch: config.selfhosting.mainline.control_branch }) : undefined;

    // ── isolated CI workspaces for development turns ────────────────────
    //
    // An eligible ticket agent gets read/write/exec inside the lht-val15 CI container,
    // WITHOUT a per-call approval card. Three facts make that the same
    // authority the owner already has rather than a new hole:
    //
    //   · the grant is derived for `repair_requester` — a real registered user
    //     — over that user's OWN registered device, which is the exact shape
    //     `MACHINE_AUTO_ALLOW` was introduced for (a person's chat agent over
    //     their own laptop, see runner/capability.ts);
    //   · the credential is minted per turn and revoked when the turn ends, so
    //     no authority outlives the conversation that needed it;
    //   · it reaches one device. The Object is owner-bound; nothing here can
    //     address anybody else's machine, whatever it asks for.
    //
    // Approval cards are the right answer when a human is in the loop to click
    // them. This lane runs unattended by construction: an approval card here
    // does not add oversight, it just stops the repair until someone notices.
    const ciMachine = config.selfhosting.ci_machine;
    // Contributor dev machines (2026-08-20): same lane, different transport.
    // A requester with their own entry gets THEIR container; everybody else
    // keeps the historical CI-box behaviour. Either way the device must be one
    // the requester registered, or there is no machine lane — the old code
    // handed every requester the CI box and let the kernel refuse at call time,
    // which produced prompts describing tools the turn could not use.
    const devMachines = config.selfhosting.dev_machines ?? {};
    const machineFor = (username: string): { device: string; checkout_dir: string; viaRunner: boolean } | null => {
      const own = devMachines[username];
      if (own) return { ...own, viaRunner: true };
      return ciMachine ? { ...ciMachine, viaRunner: false } : null;
    };
    const isTicketDeveloper = (username: string): boolean => Boolean(store.getUser(username) && resolveCapabilityBits({
      username, admins: config.dashboard?.admins, deployers: config.selfhosting?.deployers,
      granted: store.listUserGrants(username).map((grant) => grant.capability),
    }).contribute);
    const ownsDevice = (username: string, device: string): boolean =>
      store.listRunnerTokens(username).some((row) => row.device === device);
    const deviceOnline = (username: string, device: string): boolean =>
      Boolean(runnerGateway?.listDevices(username).some((row) => row.device === device && row.online));
    contribBundles = new BundleHandoff();
    const bundles = contribBundles;
    const publicUrl = config.dashboard?.public_url;
    if (config.selfhosting.runner_tickets && runnerCaps && runnerGateway && runnerTransport && publicUrl) {
      const transport = runnerTransport;
      const capabilityService = runnerCaps.service;
      type DevelopmentBinding = Parameters<NonNullable<DashboardCompositionOptions["developmentWorkspaces"]>["available"]>[0];
      const authorities = new Map<string, { owner: string; capability: WorkspaceDevelopmentCapabilities }>();
      const assertAvailable = (binding: DevelopmentBinding): void => {
        const requester = binding.requester ?? binding.owner;
        const rights = resolveCapabilityBits({ username: requester, admins: config.dashboard?.admins,
          deployers: config.selfhosting?.deployers, granted: store.listUserGrants(requester).map((grant) => grant.capability) });
        if (requester !== binding.owner) {
          const policy = config.selfhosting?.runner_tickets;
          const ticket = store.devTickets.getDevTicket(binding.ticketId);
          if (ticket?.requester !== requester || ticketResourceOwner(policy, requester, isTicketDeveloper) !== binding.owner
            || !policy?.targets[binding.owner]?.workspaces?.some((row) => row.device === binding.device && row.workspace_id === binding.parentWorkspaceId)) throw new Error("工单开发工作区授权已撤销或放置已变化");
          const grant = dashboardComposition?.services.permissions.effectiveFor({ subjectType: "service", subjectId: "ticket-runner",
            owner: binding.owner, requested: ["start_session"] }).entries.find((row) => row.operation === "start_session");
          if (!grant?.effective || !grant.autoAllow) throw new Error("工单开发工作区授权已撤销或放置已变化");
        }
        if (!store.getUser(requester) || !rights.contribute || !ownsDevice(binding.owner, binding.device)) {
          throw new Error("工单开发者或原设备授权已撤销");
        }
        const device = runnerGateway?.listDevices(binding.owner).find((row) => row.device === binding.device);
        if (!device?.online) throw new ResourceUnavailableError(runnerResource(binding.owner, binding.device), "开发设备暂时离线");
        if (device.inventory?.workspace_development?.protocol !== WORKSPACE_DEVELOPMENT_PROTOCOL
          || !device.inventory.workspace_development.available) throw new Error("原开发 Runner 不支持 workspace-development/v1，请升级原设备");
        if (!device.inventory.ticket_options?.workspaces.some((workspace) => workspace.id === binding.parentWorkspaceId)) {
          throw new Error("原开发工作区已不在设备登记中；保留原会话，请恢复原工作区登记");
        }
      };
      const available = (binding: DevelopmentBinding): boolean => {
        try { assertAvailable(binding); return true; } catch { return false; }
      };
      const off = runnerCaps.onTargetSetChanged((event) => {
        for (const held of authorities.values()) if (held.owner === event.username) held.capability.revoke();
      });
      opened.push({ what: "ticket-development-workspaces", close: () => {
        off(); for (const held of authorities.values()) held.capability.revoke(); authorities.clear();
      } });
      developmentWorkspaces = {
        stateDir: path.join(dataDir, "dev-source-candidates"),
        repositoryId: "repository_" + createHash("sha256").update(path.resolve(repoDir)).digest("hex").slice(0, 32),
        publicUrl, bundles, available, assertAvailable,
        call: (binding, method, args) => {
          assertAvailable(binding);
          const key = JSON.stringify([binding.owner, binding.requester, binding.device, binding.parentWorkspaceId]);
          let held = authorities.get(key);
          if (!held) {
            const capability = new WorkspaceDevelopmentCapabilities({ service: capabilityService, transport,
              owner: binding.owner, device: binding.device, workspaceId: binding.parentWorkspaceId,
              authorized: () => available(binding) });
            capability.revoke();
            held = { owner: binding.owner, capability };
            authorities.set(key, held);
          }
          return held.capability.call(method, args);
        },
      };
    }
    // Keeping that container's code current is ops, not policy, so it lives in
    // a script beside the container it maintains (`ops/ci-container/`) and the
    // bot only decides WHEN. Every ticket receives a separate worktree while
    // sharing immutable git objects and the pnpm content store.
    // The CI device is a configured owner/device pair. Runner device labels
    // are only owner-scoped; global label inference would let another user
    // register the same label and receive pipeline authority.
    const ciDeviceOwner = (): string | null => {
      if (!ciMachine) return null;
      return ownsDevice(ciMachine.owner, ciMachine.device) ? ciMachine.owner : null;
    };
    if (ciMachine && !ciDeviceOwner()) {
      throw new Error(`CI Runner ${ciMachine.owner}/${ciMachine.device} is not registered to its configured owner`);
    }
    let ciWorkspaceProvider: WorkspaceProvider | null = null;
    const graphBuildAbort = new AbortController();
    opened.push({ what: "knowledge-graph-build-observer", close: () => graphBuildAbort.abort() });
    if (ciMachine?.workspace_id && (!runnerCaps || !runnerGateway || !runnerTransport || !publicUrl)) {
      throw new Error("registered CI workspace requires the Runner gateway, capabilities and public HTTPS bundle origin");
    }
    if (ciMachine?.workspace_id && runnerCaps && runnerGateway && runnerTransport && publicUrl) {
      const jobs = new WorkspaceJobCapabilities({ service: runnerCaps.service, transport: runnerTransport,
        owner: ciMachine.owner, device: ciMachine.device, workspaceId: ciMachine.workspace_id,
        userExists: (owner) => Boolean(store.getUser(owner)), hasDevice: ownsDevice });
      jobs.resetAuthority();
      const providers = new RunnerProviderCatalog(runnerGateway);
      const off = runnerCaps.onTargetSetChanged((event) => { if (event.username === ciMachine.owner) jobs.revoke(); });
      opened.push({ what: "workspace-provider", close: () => { ciWorkspaceProvider?.close(); off(); jobs.revoke(); } });
      const ciExec = async (args: { command: string; cwd?: string; timeout_ms?: number }): Promise<MachineExecResult> => {
        if (!deviceOnline(ciMachine.owner, ciMachine.device)) throw new Error(`CI Runner ${ciMachine.owner}/${ciMachine.device} offline`);
        const grant = runnerCaps.open({ username: ciMachine.owner, purpose: "ci-provider-source-and-artifact", kind: "job",
          rights: ["exec"], autoAllow: ["exec"], metadata: { surface: "ci-provider-source-and-artifact", runner_device_scope: ciMachine.device } });
        if (!grant) throw new Error("CI provider execution authorization unavailable");
        try { return await grant.call("exec", { device: ciMachine.device, ...args }) as MachineExecResult; }
        finally { grant.close(); }
      };
      ciWorkspaceProvider = new WorkspaceProvider({ owner: ciMachine.owner, device: ciMachine.device, workspaceId: ciMachine.workspace_id }, {
        stateDir: path.join(dataDir, "dev-workspace-jobs"), publicUrl, bundles, open: () => jobs.open(),
        sourceState: (task) => workspaceSourceState(ciExec, ciMachine.checkout_dir, task.workspaceKey),
        status: () => {
          const status = providers.status({ owner: ciMachine.owner, device: ciMachine.device }, "workspace");
          if (status !== "available") return status;
          return providers.list(ciMachine.owner).some((row) => row.device === ciMachine.device && row.kind === "workspace" && row.protocol === "workspace-jobs/v1")
            ? "available" : "protocol_unavailable";
        },
      });
      ciWorkspaceProvider.startCancellationRecovery();
      architectureRunner = runnerArchitectureAnalyzer({ provider: ciWorkspaceProvider, exec: ciExec, checkoutDir: ciMachine.checkout_dir });
      if (externalCompute) {
        appPackRunner = runnerAppPacker(ciWorkspaceProvider, graphBuildAbort.signal);
        const unbind = bindKnowledgeDeployProjection(store, runnerKnowledgeDeployProjection({ provider: ciWorkspaceProvider,
          worktreesDir: config.selfhosting.worktrees_dir ?? path.join(repoDir, "..", "octopus-worktrees"), signal: graphBuildAbort.signal }));
        opened.push({ what: "knowledge-deploy-projection", close: unbind });
      }
    }
    let knowledgeArtifactService: KnowledgeArtifactService | null = null;
    let knowledgeArtifactFactory: ((graph: KnowledgeGraphService) => KnowledgeArtifactService | null) | undefined;
    const knowledgeCfg = config.selfhosting.knowledge_index;
    const knowledgeRunner = knowledgeIndexRunnerTarget(config.selfhosting);
    const knowledgeEnabled = knowledgeCfg?.enabled ?? Boolean(knowledgeRunner);
    const knowledgeDevice = knowledgeRunner?.device;
    const knowledgeOwner = knowledgeRunner?.owner;
    if (knowledgeEnabled && runnerCaps && runnerGateway && runnerTransport && publicUrl && knowledgeRunner && knowledgeDevice && knowledgeOwner) {
      if (!ownsDevice(knowledgeOwner, knowledgeDevice)) {
        throw new Error(`knowledge index Runner ${knowledgeOwner}/${knowledgeDevice} is not registered to its configured owner`);
      }
      const providers = new RunnerProviderCatalog(runnerGateway);
      const knowledgeCaps = new KnowledgeIndexCapabilities({
        service: runnerCaps.service,
        transport: runnerTransport,
        owner: knowledgeOwner,
        device: knowledgeDevice,
        userExists: (username) => Boolean(store.getUser(username)),
        hasDevice: ownsDevice,
      });
      knowledgeCaps.resetAuthority();
      const detachKnowledgeTarget = knowledgeCaps.attachToRunnerLifecycle(runnerCaps, () => {
        void knowledgeArtifactService?.kick();
      });
      const detachKnowledgePresence = runnerGateway.subscribePresence((owner, device, online) => {
        if (online && owner === knowledgeOwner && device === knowledgeDevice) void knowledgeArtifactService?.kick();
      });
      opened.push({ what: "knowledge-index-capability", close: () => {
        detachKnowledgePresence();
        detachKnowledgeTarget();
        knowledgeCaps.revoke();
      } });
      services.push("knowledge-index-capability");

      const protocolAvailable = (): boolean => {
        return providers.status({ owner: knowledgeOwner, device: knowledgeDevice }, "knowledge-index") === "available";
      };
      const callKnowledge = async <T>(operation: string, args: Record<string, unknown>): Promise<T> => {
        const grant = knowledgeCaps.open();
        if (!grant) throw new Error("knowledge index capability target is unavailable");
        try { return await grant.call(operation, args) as T; }
        finally { grant.close(); }
      };
      knowledgeArtifactFactory = (graph) => {
        const remote = {
          protocolAvailable,
          availability: () => providers.status({ owner: knowledgeOwner, device: knowledgeDevice }, "knowledge-index"),
          syncSource: async (repoSha: string) => {
            const grant = runnerCaps.open({
              username: knowledgeOwner,
              purpose: "knowledge-index-source-sync",
              kind: "job",
              rights: ["exec"],
              autoAllow: ["exec"],
              metadata: { surface: "knowledge-index-source-sync", runner_device_scope: knowledgeDevice },
            });
            if (!grant) throw new Error("knowledge source sync capability is unavailable");
            try {
              const synced = await syncWorkspaceViaRunner({
                sourceDir: repoDir,
                ref: repoSha,
                key: "knowledge-index-source",
                workspace: "/work/knowledge-index-source",
                checkoutDir: knowledgeRunner.checkout_dir,
                publicUrl,
                bundles,
                install: true,
                buildFilters: KNOWLEDGE_ARTIFACT_BUILD_FILTERS,
                cleanIgnored: true,
                exec: async (args) => await grant.call("exec", { device: knowledgeDevice, ...args }) as MachineExecResult,
              });
              if (!synced.ok || synced.sha !== repoSha) throw new Error(synced.detail);
            } finally { grant.close(); }
          },
          start: async (input: { jobKey: string; repoSha: string; inputUrl: string; inputSha256: string; inputBytes: number }) =>
            await callKnowledge<RemoteKnowledgeStatus>("knowledge_index_start", {
              job_key: input.jobKey,
              repo_sha: input.repoSha,
              input_url: input.inputUrl,
              input_sha256: input.inputSha256,
              input_bytes: input.inputBytes,
            }),
          status: async (jobKey: string) =>
            await callKnowledge<RemoteKnowledgeStatus>("knowledge_index_status", { job_key: jobKey }),
          cancel: async (jobKey: string) =>
            await callKnowledge<RemoteKnowledgeStatus>("knowledge_index_cancel", { job_key: jobKey }),
          read: async (jobKey: string, file: string, offset: number, length: number) =>
            await callKnowledge<RemoteKnowledgeRead>("knowledge_index_read", { job_key: jobKey, file, offset, length }),
        };
        knowledgeArtifactService = new KnowledgeArtifactService({
          provider: { owner: knowledgeOwner, device: knowledgeDevice, checkoutDir: knowledgeRunner.checkout_dir },
          graph,
          remote,
          bundles,
          publicUrl,
          dir: path.join(dataDir, "knowledge", "artifacts"),
          repoRoot: repoDir,
          baselineStatus: async (activeRepoSha) => {
            const { stdout: baselineOut } = await execFileAsync(
              "git",
              ["-C", repoDir, "rev-parse", "--verify", `${baseBranch}^{commit}`],
              { timeout: 30_000, maxBuffer: 64 * 1024 },
            );
            const baselineSha = baselineOut.trim();
            if (!/^[0-9a-f]{40}$/.test(baselineSha)) return null;
            const { stdout: behindOut } = await execFileAsync(
              "git",
              ["-C", repoDir, "rev-list", "--count", `${activeRepoSha}..${baselineSha}`],
              { timeout: 30_000, maxBuffer: 64 * 1024 },
            );
            const commitsBehind = Number(behindOut.trim());
            return Number.isSafeInteger(commitsBehind) && commitsBehind >= 0
              ? { baselineRef: baseBranch, baselineSha, commitsBehind }
              : null;
          },
          desiredShas: async () => {
            const desired = new Set<string>();
            const graphSha = graph.commit();
            if (graphSha && /^[0-9a-f]{40}$/.test(graphSha)) desired.add(graphSha);
            for (const [directory, ref] of [[repoDir, baseBranch], ...(config.selfhosting?.run_dir ? [[config.selfhosting.run_dir, "HEAD"]] : [])] as Array<[string, string]>) {
              try {
                const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "--verify", `${ref}^{commit}`], {
                  timeout: 30_000,
                  maxBuffer: 64 * 1024,
                });
                const sha = stdout.trim();
                if (/^[0-9a-f]{40}$/.test(sha)) desired.add(sha);
              } catch {
                // A missing deployed tree/ref is unavailable, never guessed.
              }
            }
            return [...desired].sort();
          },
        });
        return knowledgeArtifactService;
      };
    } else if (knowledgeEnabled) {
      log.warn("knowledge index configured but trusted Runner/device/public URL/checkout is unavailable; remote methods remain uncomposed");
    }
    // The same five steps as ssh'ing into the CI box, run as exec calls
    // through the device's Runner under a per-sync grant that dies with the
    // sync. Used for a contributor's laptop (no ssh from here) and, since
    // 2026-08-21, for the CI box as well: the bastion-hopped ssh path stalled
    // intermittently and cost four minutes per failure (ticket #285).
    const syncViaRunner = async (
      input: { sourceDir: string; ref: string; ticketId: number; target: { checkoutDir: string } },
      owner: string,
      device: string,
      checkoutDir: string,
      surface: "devpipe-dev-machine-sync" | "devpipe-ci-workspace-sync",
    ) => {
      if (!publicUrl) {
        return { ok: false, checkoutDir: input.target.checkoutDir, detail: "dashboard.public_url 未配置,容器无法下载 bundle" };
      }
      const grant = runnerCaps?.open({
        username: owner,
        purpose: `${surface}/${input.ticketId}`,
        kind: "job",
        rights: ["exec"],
        autoAllow: ["exec"],
        metadata: { surface, runner_device_scope: device },
      });
      if (!grant) return { ok: false, checkoutDir: input.target.checkoutDir, detail: "机器授权不可用(Runner 未装配或设备未登记)" };
      try {
        return await syncTicketWorkspaceViaRunner({
          sourceDir: input.sourceDir,
          ref: input.ref,
          ticketId: input.ticketId,
          checkoutDir,
          publicUrl,
          bundles,
          exec: async (args) => (await grant.call("exec", { device, ...args })) as MachineExecResult,
        });
      } catch (err) {
        return { ok: false, checkoutDir: input.target.checkoutDir, detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
      } finally {
        grant.close();
      }
    };
    const ciMachineSync: CiMachineSync | null = ciMachine || Object.keys(devMachines).length > 0
      ? async ({ sourceDir, ref, ticketId, requester, target }) => {
          const own = devMachines[requester];
          if (own && own.device === target.device) {
            return await syncViaRunner({ sourceDir, ref, ticketId, target }, requester, own.device, own.checkout_dir, "devpipe-dev-machine-sync");
          }
          if (!ciMachine || ciMachine.workspace_id) return { ok: false, checkoutDir: target.checkoutDir, detail: "no legacy CI machine configured for this requester" };
          const ciOwner = ciDeviceOwner();
          const ciOnline = Boolean(ciOwner && deviceOnline(ciOwner, ciMachine.device));
          if (ciOwner && publicUrl && runnerCaps && ciOnline) {
            const viaRunner = await syncViaRunner({ sourceDir, ref, ticketId, target }, ciOwner, ciMachine.device, ciMachine.checkout_dir, "devpipe-ci-workspace-sync");
            // A failure AFTER the code arrived (install/build) is the
            // workspace's state and is reported as such; a failure before it
            // (grant, download, worktree) is the transport's, so try the box
            // the old way before giving the turn a stale checkout.
            if (viaRunner.ok || viaRunner.sha) return viaRunner;
            // The Runner answered "device away" mid-sync: that is the ticket's
            // promise too, whatever happens below.
            const away = parseUnavailable(viaRunner.detail);
            if (away) resourceRecovery?.note(ticketScope(ticketId), away.resource, away.detail);
            if (ciMachine.ssh_fallback !== true) return viaRunner;
            log.warn({ ticket: ticketId, detail: viaRunner.detail }, "CI workspace sync via Runner failed before the code arrived; trying ssh");
          } else if (ciOwner) {
            // Not even attempted over the Runner: the device is away right
            // now. Say so once here so the turn is told when it is back. The
            // bastion-hopped ssh path is opt-in since 2026-08-22: it fired its
            // serial round trips exactly when the box was struggling, and a
            // turn that waits now hears the moment the Runner is back.
            const resource = runnerResource(ciOwner, ciMachine.device);
            const detail = `设备 ${ciMachine.device} 不在线,工作区同步未经 Runner 执行`;
            resourceRecovery?.note(ticketScope(ticketId), resource, detail);
            if (ciMachine.ssh_fallback !== true) {
              return { ok: false, checkoutDir: target.checkoutDir, detail: unavailableMessage(resource, detail) };
            }
          }
          // ssh fallback (`ci_machine.ssh_fallback: true`): the Runner is not
          // reachable through the gateway, but the box may be.
          const script = path.join(repoDir, "ops", "ci-container", "sync-workspace.sh");
          const checkoutDir = path.posix.join(path.posix.dirname(ciMachine.checkout_dir), "tickets", `ticket-${ticketId}`);
          try {
            // Whole output, no maxBuffer: a verbose sync is not a failed sync.
            const synced = await runChild("bash", [script, ref, `ticket-${ticketId}`], {
              cwd: sourceDir,
              timeoutMs: CI_MACHINE_SYNC_TIMEOUT_MS,
              env: {
                ...process.env,
                OCTOPUS_REPO_DIR: sourceDir,
                ...(ciMachine.device ? { RUNNER_DEVICE: ciMachine.device } : {}),
              },
            });
            if (synced.error) throw synced.error;
            const stdout = synced.stdout.text();
            const sha = /now at ([0-9a-f]{7,40})/.exec(stdout)?.[1]
              ?? /already has ([0-9a-f]{7,40})/.exec(stdout)?.[1];
            const reportedDir = /workspace (\S+) now at/.exec(stdout)?.[1];
            return {
              ok: true,
              ...(sha ? { sha } : {}),
              checkoutDir: reportedDir ?? checkoutDir,
              detail: stdout.trim().split("\n").pop() ?? "",
            };
          } catch (err) {
            return {
              ok: false,
              checkoutDir,
              detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
            };
          }
        }
      : null;
    // The landing gate on the CI box (remote-gate.ts). Opened per check by the
    // pipeline for the device owner; null = that check runs on this node.
    const landGateRemote: RemoteGateOpener | null = ciWorkspaceProvider
      ? () => workspaceProviderGate(ciWorkspaceProvider!, path.join(dataDir, "dev-workspace-gates"))
      : ciMachine && !ciMachine.workspace_id && ciMachine.gate !== false && runnerCaps && publicUrl
        ? () => {
            const owner = ciDeviceOwner();
            if (!owner || !deviceOnline(owner, ciMachine.device)) return null;
            const grant = runnerCaps!.open({
              username: owner,
              purpose: "devpipe-land-gate",
              kind: "job",
              rights: ["exec"],
              autoAllow: ["exec"],
              metadata: { surface: "devpipe-land-gate", runner_device_scope: ciMachine.device },
            });
            if (!grant) return null;
            return runnerGateSession({
              device: ciMachine.device,
              checkoutDir: ciMachine.checkout_dir,
              publicUrl,
              bundles,
              exec: async (args) => (await grant.call("exec", { device: ciMachine.device, ...args })) as MachineExecResult,
              close: () => grant.close(),
            });
          }
        : null;
    const ciMachineOpener: CiMachineOpener | null =
      (ciMachine || Object.keys(devMachines).length > 0) && runnerCaps && loopback
        ? (username, purpose) => {
            if (ciMachine?.workspace_id && username === ciMachine.owner) return null;
            const machine = machineFor(username);
            if (!machine) return null;
            // Entitlement, not liveness (2026-08-22): a requester who owns the
            // device gets the lane whether or not its Runner is connected this
            // second. Three tickets spent a night without tools because their
            // turns happened to start inside a link outage. The prompt says the
            // machine is away; each call answers 「资源暂不可达」 and records a
            // waiter; the pipeline posts the recovery (resources/recovery.ts).
            if (!ownsDevice(username, machine.device)) return null;
            const online = deviceOnline(username, machine.device);
            const ciMachineOps = MACHINE_OPS.filter((operation) => operation !== "__list_devices");
            const grant = runnerCaps!.open({
              username,
              purpose,
              kind: "agent-run",
              rights: ciMachineOps,
              autoAllow: MACHINE_AUTO_ALLOW.filter((operation) => operation !== "__list_devices"),
              metadata: {
                surface: machine.viaRunner ? "devpipe-dev-machine" : "devpipe-ci-workspace",
                runner_device_scope: machine.device,
              },
            });
            if (!grant) return null;
            const token = loopback!.mint(grant.capabilities, purpose, undefined, () => grant.close());
            // A dev turn is progress-bounded, not wall-clock-bounded. Keep the
            // short-lived transport credential leased while this exact turn
            // owns it; close() below still revokes it immediately, and a lost
            // owner stops renewing so the normal two-hour backstop applies.
            const keepalive = loopback!.keepAlive(token);
            let closed = false;
            return {
              apiUrl: loopback!.url,
              apiToken: token,
              target: { device: machine.device, checkoutDir: machine.checkout_dir, online },
              close: () => {
                if (closed) return;
                closed = true;
                keepalive.stop();
                loopback!.revoke(token);
              },
            };
          }
        : null;

    // codex-runner ticket lane (#358): a separate trusted-service capability
    // Object (not four more names in runner-account-v9) through which the
    // pipeline drives the requester's OWN device's Codex app-server. Device
    // resolution is trusted-side only: an explicit config entry wins, else the
    // user's online device whose inventory reports an authenticated Codex.
    const remoteCodexCaps = runnerCaps && runnerTransport
      ? new RemoteCodexCapabilities({
          service: runnerCaps.service,
          transport: runnerTransport,
          userExists: (username) => Boolean(store.getUser(username)),
          hasDevice: (username) => store.listRunnerTokens(username).length > 0,
        })
      : null;
    if (remoteCodexCaps && runnerCaps) {
      opened.push({
        what: "devpipe-remote-codex-capability",
        close: remoteCodexCaps.attachToRunnerLifecycle(runnerCaps),
      });
    }
    const remoteCodexOpener: RemoteCodexOpener | null = remoteCodexCaps
      ? (username, purpose, preferredDevice) => {
          const resolveDevice = (): string | null => {
            // A session pinned to a device stays there; substituting another
            // box would resume the thread against the wrong Codex home.
            if (preferredDevice) return ownsDevice(username, preferredDevice) ? preferredDevice : null;
            const configured = config.selfhosting?.dev_codex_runners?.[username];
            if (configured) return ownsDevice(username, configured) ? configured : null;
            const candidates = (runnerGateway?.listDevices(username) ?? [])
              .filter((row) => row.online
                && row.inventory?.agent_backends?.some((backend) => backend.kind === "codex" && backend.available))
              .map((row) => row.device)
              .sort();
            return candidates[0] ?? null;
          };
          const device = resolveDevice();
          if (!device) return null;
          const grant = remoteCodexCaps.open(username, purpose, device);
          if (!grant) return null;
          return {
            device,
            online: deviceOnline(username, device),
            call: (op: string, args: Record<string, unknown>) => grant.call(op, { ...args, device }),
            close: () => grant.close(),
          };
        }
      : null;

    // The review lane (2026-08-20). Which lane a requester lands through is the
    // SAME capability resolution the panel uses, asked again at submit time.
    const gitlabCiCfg = config.selfhosting.gitlab_ci;
    const proposalPublisher: ProposalPublisher = gitlabCiCfg && gitlabCiCfg.enabled !== false
      ? new GitLabContribPublisher({
          repoDir,
          apiUrl: gitlabCiCfg.api_url,
          project: gitlabCiCfg.project,
          token: gitlabCiToken(gitlabCiCfg),
        })
      : NO_FORGE_PUBLISHER;
    const resolveLane = (requester: string): "direct" | "review" =>
      resolveCapabilityBits({
        username: requester,
        admins: config.dashboard?.admins,
        deployers: config.selfhosting?.deployers,
        granted: store.listUserGrants(requester).map((g) => g.capability),
      }).dev
        ? "direct"
        : "review";

    warnAboutV2Watermarks(baseBranch, stableBranch);

    devPipeline = new DevPipeline({
      store,
      repoDir,
      worktreesDir: config.selfhosting.worktrees_dir ?? path.join(repoDir, "..", "octopus-worktrees"),
      baseBranch,
      creditExcludedUsers: config.dashboard?.admins,
      ...(gitlabMainline ? { mainline: gitlabMainline } : {}),
      // Derived knowledge graph next to the Architecture Observatory snapshot;
      // rebuilt from Git + ticket_landings, deletable at any time.
      ...(knowledgeArtifactFactory ? { knowledgeArtifactFactory } : {}),
      knowledgeGraphDir: path.join(dataDir, "knowledge"),
      ...(externalCompute && ciWorkspaceProvider ? {
        knowledgeGraphRemoteBuild: runnerKnowledgeGraphBuilder({ provider: ciWorkspaceProvider,
          worktreesDir: config.selfhosting.worktrees_dir ?? path.join(repoDir, "..", "octopus-worktrees"), signal: graphBuildAbort.signal }),
      } : {}),
      specConcurrency: config.selfhosting.spec_concurrency,
      ...(config.selfhosting.codex_accounts
        ? {
            codexAccountRouter: new CodexAccountRouter({
              accounts: config.selfhosting.codex_accounts,
              minimumRemainingPercent: config.selfhosting.codex_min_remaining_percent,
            }),
          }
        : {}),
      maxGateAttempts: config.selfhosting.max_gate_attempts,
      turnTimeoutMs: config.selfhosting.turn_timeout_minutes
        ? config.selfhosting.turn_timeout_minutes * 60_000
        : undefined,
      turnStallMs:
        config.selfhosting.turn_stall_minutes != null
          ? config.selfhosting.turn_stall_minutes * 60_000
          : undefined,
      // Read-only, and only as a SOURCE to pack an App release from: it is the
      // one tree that is always built and always equals the running code.
      ...(config.selfhosting.run_dir ? { runTreeDir: config.selfhosting.run_dir } : {}),
      ...(config.selfhosting.land_gate != null ? { landGateEnabled: config.selfhosting.land_gate } : {}),
      ...(config.selfhosting.ci_roster_gate != null
        ? { ciRosterGateEnabled: config.selfhosting.ci_roster_gate }
        : {}),
      ...(config.selfhosting.changed_tests_gate != null
        ? { changedTestsGateEnabled: config.selfhosting.changed_tests_gate }
        : {}),
      ...(ciMachineOpener ? { ciMachine: ciMachineOpener } : {}),
      ...(remoteCodexOpener ? { remoteCodex: remoteCodexOpener } : {}),
      ...(resourceRecovery ? { resourceRecovery } : {}),
      managedSupervisor,
      ...(ciMachine?.sync_concurrency ? { ciSyncConcurrency: ciMachine.sync_concurrency } : {}),
      ...(ciMachineSync ? { ciMachineSync } : {}),
      ...(landGateRemote ? { landGateRemote } : {}),
      landGateRemoteRequired: Boolean(ciMachine?.workspace_id || ciMachine?.remote_required),
      ...(ciWorkspaceProvider ? { ciWorkspaceProvider: (owner: string) => ticketResourceOwner(config.selfhosting?.runner_tickets, owner, isTicketDeveloper) === ciMachine?.owner ? ciWorkspaceProvider : null } : {}),
      ...(externalCompute ? { buildWarmEnabled: false }
        : config.selfhosting.build_warm != null ? { buildWarmEnabled: config.selfhosting.build_warm } : {}),
      resolveLane,
      proposalPublisher,
    });
    contribReview = new ContribReviewService({ store, pipeline: devPipeline, publisher: proposalPublisher });
    contribReview.start();
    opened.push({ what: "contrib-review", close: () => contribReview!.stop() });
    devPipeline.setNotify((event) => {
      const status = devAgentCompletionStatus(
        event,
        event.kind === "reply" && devPipeline!.lockWaiterIds().includes(event.ticket.id),
      );
      agentCompletion.publish({
        runId: `dev-${event.ticket.id}-${event.kind}-${event.ticket.commit_sha ?? event.ticket.turn_started_at ?? "turn"}`,
        owner: event.ticket.requester,
        surface: "dev",
        label: `开发工单 #${event.ticket.id}「${event.ticket.slug || event.ticket.title}」`,
        status,
      });
    });
    opened.push({ what: "dev-pipeline", close: () => devPipeline!.stop() });
    services.push("dev-pipeline");
    log.info({ repoDir, base: devPipeline.baseBranch }, "dev pipeline enabled");

    // A human CLI landing can be performed by the previous running version.
    // Rebuild its durable Git report into SQLite before the deploy watcher can
    // finalize the restart that brought this version up.
    await devPipeline.synchronizeMainline().catch(error => log.warn({ error: String(error) }, "GitLab unavailable at startup; retained cache is read-only until authority returns"));
    await devPipeline.reconcileCliDeliveryReports();

    const gitlabCi = config.selfhosting.gitlab_ci;
    if (gitlabCi && gitlabCi.enabled !== false) {
      if (!store.getUser(gitlabCi.repair_requester)) {
        throw new Error(`selfhosting.gitlab_ci.repair_requester 不是已注册用户: ${gitlabCi.repair_requester}`);
      }
      // Two separate questions, kept apart on purpose:
      //   ciRepairBusyForScheduling  → a fix agent is actively working (blocks new batches)
      //   findCiRepairRouteTarget    → busy OR landed-but-not-yet-verified (routes onRed to
      //                                the same ticket so the same agent iterates instead
      //                                of a fresh spawn rediscovering context)
      // A red run's ticket_id may point at the current active repair OR at a stale one
      // whose fix has already landed. The awaiting-verification lookup names a candidate;
      // commit ancestry + roster fingerprint decide whether to archive it as stale,
      // continue that conversation, or open a new repair episode.
      gitlabCiMonitor = new GitLabCiMonitor({
        store,
        apiUrl: gitlabCi.api_url,
        project: gitlabCi.project,
        token: gitlabCiToken(gitlabCi),
        ref: gitlabCi.ref ?? baseBranch,
        pollMs: gitlabCi.poll_seconds ? gitlabCi.poll_seconds * 1_000 : undefined,
        settleMs: gitlabCi.debounce_seconds != null ? gitlabCi.debounce_seconds * 1_000 : undefined,
        onGreen: async (sha) => {
          // A green descendant settles the same repair conversation whether
          // the agent landed the fix itself or a neighbouring landing already
          // removed the failure. In the latter case, close the parked ticket
          // instead of leaving a permanently-red row on an actually-green tip.
          const routeBefore = findCiRepairRouteTarget(store);
          let provesRepair = false;
          if (routeBefore) {
            const ticket = store.devTickets.getDevTicket(routeBefore.ticketId);
            const latestRepairRed = store.devTickets.listTestRuns(100)
              .find((run) => run.provider === "gitlab" && run.status === "red"
                && run.ticket_id === routeBefore.ticketId);
            const proofBase = routeBefore.awaiting ? ticket?.commit_sha : latestRepairRed?.sha;
            if (proofBase) {
              try {
                const relation = await devPipeline!.ciCommitRelation(sha, proofBase);
                provesRepair = relation === "same" || relation === "failure_after_fix";
              } catch (err) {
                log.warn({ err, ticket: routeBefore.ticketId, sha }, "could not prove green CI repair ancestry");
              }
            }
          }
          await devPipeline!.recordCiGreen(stableBranch, sha);
          if (routeBefore && provesRepair) {
            if (routeBefore.awaiting) {
              devPipeline!.postPipelineNote(
                routeBefore.ticketId,
                `✅ GitLab CI 全量验证已通过 (${sha.slice(0, 10)});本修复对话已经达到收尾门禁。`,
              );
            } else {
              devPipeline!.postPipelineNote(
                routeBefore.ticketId,
                `✅ GitLab CI 已在 ${sha.slice(0, 10)} 全绿;主线中的其它增量已消除本票故障,无需再制造修复提交,自动关闭。`,
              );
              devPipeline!.cancel(routeBefore.ticketId);
            }
          }
        },
        onRed: async (failure) => {
          try {
            const disposition = await classifyCiRepairFailure(
              store,
              failure,
              async (failureSha, fixSha) => {
                try {
                  return await devPipeline!.ciCommitRelation(failureSha, fixSha);
                } catch (err) {
                  // Missing/corrupt local objects must not leave the red row
                  // unattached forever. Treat uncertain ancestry as a fresh
                  // episode, which is conservative and remains visible.
                  log.warn({ err, failureSha, fixSha }, "could not compare CI repair ancestry; opening a fresh repair");
                  return "unrelated";
                }
              },
            );
            if (disposition.action === "stale") {
              // A batch pinned before the fix says nothing about whether that
              // fix works. Keep one concise audit note, but do not fetch/embed
              // change history, widen the roster, wake an agent, or spend a
              // retry attempt on evidence that predates the candidate.
              devPipeline!.postPipelineNote(
                disposition.ticketId,
                `ℹ GitLab pipeline ${failure.pipelineUrl} 在旧 SHA ${failure.sha.slice(0, 10)} 上失败;`
                  + `该 SHA 早于本票已合入的修复,已按 stale batch 归档,不触发重试。`,
              );
              return disposition.ticketId;
            }
            // Resolve history BEFORE creating/waking the repair ticket. The
            // old fire-and-forget append raced the turn pump: #235 finished
            // and landed from the failure digest, then received the 11.8KB
            // history as a pointless second turn. ciChangeHistory is already
            // best-effort, so its short error note belongs in the same atomic
            // repair context rather than reopening a completed conversation.
            const history = await devPipeline!.ciChangeHistory(failure.fromSha, failure.sha);
            const evidence =
              `Pipeline: ${failure.pipelineUrl}\n`
              + `失败 SHA: ${failure.sha}\n`
              + `上一个全绿 SHA: ${failure.fromSha ?? "(无)"}\n\n`
              + `全部错误:\n\`\`\`text\n${failure.summary}\n\`\`\``;
            const context = `${evidence}\n\n${history}`;
            if (disposition.action === "continue") {
              // Widen BEFORE the message is posted: the preface quotes the
              // roster now in force, and the land gate reads the same column.
              // Doing it the other way round would let a turn woken by this
              // message land against the pre-widening list.
              const owed = devPipeline!.widenCiRoster(disposition.ticketId, failure.roster);
              devPipeline!.postMessage(
                disposition.ticketId,
                "pipeline",
                disposition.awaiting ? "gitlab-ci-retry" : "gitlab-ci-context",
                `${ciRepairFollowUpPreface(owed, disposition.awaiting)}\n\n${context}`,
              );
              return disposition.ticketId;
            }
            const created = devPipeline!.createTicket({
              title: `修复 GitLab CI 红灯 ${failure.sha.slice(0, 10)}`,
              body:
                `独立 Runner 上的合入后全量测试失败。不要找原开发 agent 等待;本票负责 fix-forward,一次修到全绿。\n\n`
                + context,
              requester: gitlabCi.repair_requester,
              kind: "simple",
              // Non-null (even when empty) is what puts this ticket in the
              // repair lane: its own prompt contract, and a land gate that
              // reruns the roster before the watermark can move (#219).
              ci_roster: encodeCiRoster(failure.roster),
              // Keep the automated repair lane explicit: it should not drift
              // back to a costly provider if the interactive form changes.
              model: DEV_TICKET_MODEL_DEFAULT,
              effort: DEV_TICKET_EFFORT_DEFAULT,
              via: "gitlab-ci",
              // Filed under repair_requester's name, but the Head wrote it.
              actor_kind: "system",
            });
            return created.id;
          } catch (err) {
            log.error({ err, pipeline: failure.pipelineId }, "could not open GitLab CI repair ticket");
            return null;
          }
        },
        repairBlocksScheduling: () => ciRepairBusyForScheduling(store),
        mainlineSha: async () => await devPipeline!.watermarkSha(),
      });
      gitlabCiMonitor.start();
      opened.push({ what: "gitlab-ci-monitor", close: () => gitlabCiMonitor!.stop() });
      services.push("gitlab-ci-monitor");
      log.info({ project: gitlabCi.project, ref: gitlabCi.ref ?? baseBranch }, "GitLab CI result adapter enabled");
    }

    if (config.selfhosting.run_dir) {
      const devHome = path.dirname(dataDir);
      const runnerDelivery = runnerBundles
        ? new RunnerBundleDelivery(store, repoDir, config.selfhosting.run_dir, runnerBundles)
        : null;
      let deployArtifacts: DeployArtifactService | undefined;
      const releaseBuild = config.selfhosting.deployment_build;
      let releaseCatalog: GitLabReleaseCatalog | undefined;
      if (releaseBuild?.mode === "gitlab") {
        if (!releaseBuild.gitlab || !gitlabMainline || !config.selfhosting.mainline) throw new Error("GitLab deployment requires an explicit mainline and release configuration");
        releaseCatalog = new GitLabReleaseCatalog({ apiUrl: releaseBuild.gitlab.api_url,
          project: releaseBuild.gitlab.project, tokenFile: releaseBuild.gitlab.token_file, repoDir, branch: baseBranch,
          remote: config.selfhosting.mainline.remote, stateFile: path.join(dataDir, "gitlab-release-check.json") });
      }
      if (releaseBuild?.mode === "remote" || releaseCatalog) {
        if (!releaseCatalog && (!ciWorkspaceProvider || !ciMachine?.workspace_id)) throw new Error("remote deployment requires a registered CI workspace provider");
        const configuredBuilder = ciWorkspaceProvider;
        const releasesDir = path.join(devHome, "releases", "trees");
        const releaseJob = path.join(PROJECT_ROOT, "scripts", "ops", "release-job.sh");
        const releaseStager = new ReleaseStager({ job: releaseJob, repository: repoDir, releases: releasesDir,
          artifacts: path.join(dataDir, "deploy-artifacts"), database: path.join(dataDir, "bot.db"),
          foregroundBusy: () => Boolean(store.devTickets.getActiveDeployIntent()),
          pointers: async () => {
            const current = await fs.realpath(config.selfhosting!.run_dir!);
            const previousFile = path.join(dataDir, "deploy-artifacts", "intents", `${store.devTickets.listDeployIntents(1)[0]?.id}.previous`);
            const previous = await fs.readFile(previousFile, "utf8").then(s => s.trim()).catch(() => current);
            return { current, previous };
          } });
        opened.push({ what: "release-maintenance", close: () => releaseStager.close() });
        deployArtifacts = new DeployArtifactService({ dir: path.join(dataDir, "deploy-artifacts"), repoDir,
          releasesDir,
          stage: (manifest, sha, signal) => releaseStager.stage(manifest, sha, signal),
          isActive: (intent) => store.devTickets.getActiveDeployIntent()?.id === intent.id,
          worktreesDir: config.selfhosting.worktrees_dir ?? path.join(repoDir, "..", "octopus-worktrees"),
          provider: async (intent) => {
            if (releaseCatalog) return releaseCatalog.provider(intent.target_sha, intent.release_manifest_sha256 ?? undefined);
            if (!ciMachine || !configuredBuilder) throw new Error("release provider unavailable");
            // A ticket's saved execution placement is authoritative. Only an explicit build-capability
            // mapping may use a separate isolated container on that execution device.
            for (const ticket of store.devTickets.listTicketsByDeployStatus(["pending", "deploying"])) {
              if (!ticket.commit_sha) continue;
              if (!(await releaseGit(repoDir, ["merge-base", "--is-ancestor", ticket.commit_sha, intent.target_sha])).ok) continue;
              const binding = store.devTickets.runner.binding(ticket.id);
              if (binding?.executionDevice && binding.executionDevice !== ciMachine.device
                && !releaseBuild?.execution_devices?.includes(binding.executionDevice)) {
                throw new Error(`工单 #${ticket.id} 的执行环境 ${binding.executionDevice} 未绑定远端发布构建能力；不会回退阿里构建`);
              }
              if (binding && binding.owner !== ciMachine.owner) throw new Error(`工单 #${ticket.id} 未授权使用此发布构建 provider`);
            }
            return configuredBuilder;
          },
        });
        opened.push({ what: "deploy-artifacts", close: () => deployArtifacts!.close() });
        // Complete staged releases carry CI-built App artifacts. Automatic App
        // publication may pack from one whose changes over the deployed commit
        // are App/View-only, without restarting trusted code (#61).
        const artifacts = deployArtifacts;
        devPipeline.setAppReleaseTrees(async () => {
          const trees: Array<{ sha: string; dir: string }> = [];
          for (const sha of await artifacts.stagedShas()) {
            const status = await artifacts.status(sha).catch(() => null);
            if (status?.state === "ready") trees.push({ sha, dir: path.join(releasesDir, sha) });
          }
          return trees;
        });
      }
      deployService = new DeployService({
        store,
        repoDir,
        baseBranch: devPipeline.baseBranch,
        stableBranch,
        deployers: config.selfhosting.deployers,
        runTreeDir: config.selfhosting.run_dir,
        supervisorLog: path.join(devHome, "supervisor.log"),
        backupsDir: path.join(devHome, "backups"),
        ...(releaseCatalog ? { releaseCatalog } : {}),
        prepareTarget: (sha) => devPipeline!.joinBuildWarm(sha),
        ...(deployArtifacts ? {
          prepareRelease: (intent) => deployArtifacts!.prepare(intent),
          prewarmRelease: (sha) => deployArtifacts!.prewarm(sha),
          releaseStatus: (sha) => deployArtifacts!.status(sha),
          stagedReleaseShas: () => deployArtifacts!.stagedShas(),
        } : {}),
        startupFailure: (id) => startupFailureDetail(dataDir, id),
        ...(config.dashboard?.public_url ? { ingress: new StartupIngress(repoDir, config.dashboard.public_url) } : {}),
        ...(runnerDelivery ? {
          settleRunnerBundle: (intent) => runnerDelivery.activateDeployedPending(
            `automatic:deploy-D${intent.id}`,
            intent.target_sha,
          ),
        } : {}),
        // Called only while no deployment is in flight (B9). A no-op until the
        // App catalog below binds the release refresher.
        publishApps: () => devPipeline!.autoPublishPendingAppReleases(),
      });
      await deployService.reconcilePendingTicketsForActiveDeploy();
      deployService.start();
      opened.push({ what: "deploy-service", close: () => deployService!.stop() });
      services.push("deploy-service");
      log.info(
        { runTree: config.selfhosting.run_dir, stable: deployService.stableBranch },
        "deploy service enabled",
      );
    }
  }

  // 4. Agentic App releases, then the two Session Plus process domains.
  //
  //    Order matters and is the safety property, not a preference:
  //
  //     a. the registry resolves the ACTIVE release — which on a fresh host is
  //        seeded from this checkout, and on an existing one is whatever an
  //        operator last activated. A deploy of new trusted code deliberately
  //        does not move that pointer;
  //     b. the App Runtime child is started from THAT release's materialised
  //        tree, not from the source tree, so "which code is in the sandbox" and
  //        "which code the hostname names" cannot disagree;
  //     c. both come up before the dashboard, so no reachable page can mint an
  //        instance against a half-built backend.
  //
  //    The child RPC channel is inherited IPC; neither service opens a port or
  //    receives the panel environment beyond PATH and NODE_ENV.
  let releaseHost: AppReleaseHost | null = null;
  let appBackends: AppBackendRegistry | null = null;
  let sessionPlusRelease: HostedApp<PreparedSessionPlusRelease, SessionPlusSettings> | null = null;
  let sessionPlusSupervisor: AppBackendSupervisor | null = null;
  let sessionPlusApp: SessionPlusAppService | null = null;
  let crdtDocStore: CrdtDocumentStore | null = null;
  let crdtDocCaps: CrdtDocCapabilities | null = null;
  let crdtWakeHub: CrdtWakeHub | null = null;
  let appAgents: AppAgentPlane | null = null;
  let originAsk: AppOriginAskServer | null = null;
  let declaredApps: DeclaredAppComposer | null = null;
  if (sessionPlus) {
    const paths = appReleasePaths(dataDir);
    const registry = new AppReleaseRegistry({
      catalog: new StoreReleaseCatalog(store),
      content: new FileReleaseContentStore(paths.contentRoot),
    });
    // One app per catalog entry. Session Plus is the first; a second is another
    // adapter, another `HostedApp` and one more element in this array — the
    // registry already keys pointers by (stableAppId, publisher), and each
    // hosted app owns its own pointer, queue, runtime swap and subscribers.
    sessionPlusRelease = new HostedApp({
      registry,
      adapter: new SessionPlusReleaseAdapter({
        preparedRoot: paths.preparedRoot,
        // What the panel this composition is about to build will install. The
        // panel is always built when Session Plus is on — step 0 refuses to
        // start otherwise — so this is a fact about the composition rather than
        // a guess about a service that may not exist.
        resourceContracts: () => new Set(PANEL_RESOURCE_CONTRACTS),
        baseSettings: sessionPlus,
        // A fact about THIS composition, asked at prepare so a release naming
        // a model nobody agreed to pay for is refused before the pointer moves.
        agentModels: () => appAgentsConfig.models ?? [],
      }),
      ...(sessionPlusCheckout ? { checkoutBundle: () => sessionPlusCheckout } : {}),
      // Read late: the supervisor is built below, from the release this resolves.
      runtimeStatus: () => {
        const status = sessionPlusSupervisor?.status;
        if (!status) return null;
        return {
          state: status.state,
          runtime: status.runtime,
          statePid: status.statePid ?? null,
          runtimePid: status.runtimePid ?? null,
        };
      },
    });
    releaseHost = new AppReleaseHost({ registry, apps: [sessionPlusRelease] });
    // Never throws, and logs per app: a deployment whose active release cannot
    // be prepared must still serve the panel, because `/apps` is where an
    // operator rolls back — a recovery tool that dies with the thing it
    // recovers from is not one.
    await releaseHost.start();
    services.push("app-releases");
    const active = sessionPlusRelease.active();

    // One pair of children per app, each with its own state directory under a
    // shared root. Session Plus keeps exactly the directory it had.
    appBackends = new AppBackendRegistry({
      stateRoot: path.join(dataDir, "app-state"),
      stateModulePath: path.join(PROJECT_ROOT, "packages/app-state/dist/main.js"),
      stateExecArgv: [],
      runtimeModulePath: path.join(PROJECT_ROOT, "packages/app-runtime/src/main.ts"),
      execArgv: ["--import", "tsx"],
      env: process.env,
      maxHostedApps: sessionPlus.maxHostedApps,
      onDiagnostic: (app, service, stream, line) =>
        log.warn({ app, service, stream, line }, "App backend child diagnostic"),
      onStatus: (app, status) => log.info({ app, status }, "App backend status"),
      onStartupFailure: (app, failure) => {
        const intent = store.devTickets.getActiveDeployIntent();
        if (!intent) return;
        try { recordStartupFailure(dataDir, intent.id, app, failure); }
        catch (err) { log.warn({ err }, "could not retain startup failure diagnostic"); }
      },
    });
    sessionPlusSupervisor = appBackends.register(sessionPlusRelease.appId, {
      // The materialised tree of the active release. Durable App state is keyed
      // by (publisher, stableAppId, scope) and therefore survives the switch;
      // only the Runtime follows the release digest.
      appDir: active?.prepared.appDir ?? path.join(paths.preparedRoot, "__none__"),
    });
    // State always; Runtime only when there is a release for it to load. An
    // activation later brings the Runtime up through the same candidate/commit
    // path a hot update uses.
    await sessionPlusSupervisor.start({ runtime: Boolean(active) });
    opened.push({ what: "app-backends", close: () => appBackends!.stopAll() });
    services.push("session-plus-state");
    if (active) services.push("session-plus-runtime");
    else {
      // A first boot that cannot activate its own checkout composes WITHOUT the
      // Runtime, and until this line the only trace was one release-host log
      // line: the inventory just had one fewer service. That is how the same
      // failure cost three consecutive repair tickets — the evidence a repair
      // agent gets is `expected […(14)] to deeply equal […(15)]`, which names
      // neither the missing service nor a reason. `unavailable()` already knows
      // the code; say it here, and put it in the inventory below.
      log.warn(
        { app: sessionPlusRelease.appId, failure: sessionPlusRelease.unavailable() },
        "Session Plus has no active release; composing without its Runtime",
      );
    }
    sessionPlusRelease.attachRuntime(sessionPlusSupervisor);

    // Legacy installed Session Plus releases still send `attach_image`; their
    // rollback semantics remain bot-host scratch. The current `attach_file`
    // action never calls this seam and goes through the session host capability path.
    const attachmentHome = os.homedir();
    sessionPlusApp = new SessionPlusAppService({
      agentActivity: {
        readActivity: scope => appAgents?.readActivity(scope) ?? [],
        stopActivity: (scope, id) => appAgents?.stopActivity(scope, id) ?? false,
      },
      state: sessionPlusSupervisor.state,
      runtime: sessionPlusSupervisor.runtime,
      // Both read through the hosted app, so an activation changes what the
      // coordinator invokes and makes every open tab's instance stale on its
      // next call — rather than leaving it driving the previous release.
      identity: () => sessionPlusRelease!.active()?.prepared.identity ?? null,
      manifest: () => sessionPlusRelease!.active()?.prepared.manifest ?? null,
      ...(attachmentHome
        ? {
            attachments: async (input) => {
              const stored = await storeAttachment(attachmentHome, input);
              return stored.ok
                ? { ok: true as const, attachment: stored.attachment }
                : { ok: false as const, message: stored.message };
            },
          }
        : {}),
    });
    opened.push({ what: "session-plus-app", close: () => sessionPlusApp!.stop() });
    services.push("session-plus-app");

    // 4a'. The collaborative-document plane (2026-08-10).
    //
    //      Only with a kernel to answer to: the plane's whole point is that
    //      every read and every edit lease is a kernel decision, so a
    //      composition without `runnerCaps` (the process's one capability
    //      service) composes no store — and the provider the dashboard
    //      installs then refuses every scope, which the doc panel says out
    //      loud. The wake hub is constructed FIRST so the store's change seam
    //      has somewhere to point from its first merge.
    if (runnerCaps) {
      crdtWakeHub = new CrdtWakeHub({
        deliver: (instanceKey, binding, ref) => {
          sessionPlusApp?.wakeResource(instanceKey, binding, ref);
        },
      });
      opened.push({ what: "crdt-wake-hub", close: () => crdtWakeHub!.stop() });
      const store_ = store;
      crdtDocStore = new CrdtDocumentStore({
        root: path.join(dataDir, "crdt-docs"),
        onChanged: (docId, origin) => crdtWakeHub?.changed(docId, origin),
      });
      opened.push({ what: "crdt-doc-store", close: () => crdtDocStore!.close() });
      crdtDocCaps = new CrdtDocCapabilities({
        service: runnerCaps.service,
        store: crdtDocStore,
        userExists: (username) => Boolean(store_.getUser(username)),
      });
      const seeded = seedCrdtDocuments(crdtDocStore);
      if (seeded.length > 0) log.info({ documents: seeded }, "seeded collaborative documents");
      services.push("crdt-docs");
    } else {
      log.warn("runner.enabled is false — no capability kernel, so collaborative documents are not composed");
    }

    // 4b. The App agent plane.
    //
    //     Default OFF, and constructed only when an operator turned it on: an
    //     agent plane that appeared by accident is inference this deployment
    //     pays for and nobody chose. It is built AFTER the coordinator because
    //     every turn goes through that coordinator's dispatch — the same door a
    //     person's button uses — and BEFORE the dashboard, so a page cannot
    //     reach a half-built pump.
    if (appAgentsConfig.enabled) {
      appAgents = new AppAgentPlane({
        store,
        supervisor: managedSupervisor,
        backends: [new SessionPlusAgentBackend({
          app: sessionPlusApp,
          manifest: () => sessionPlusRelease!.active()?.prepared.manifest ?? null,
        })],
        loop: new AgentLoop({
          // The credential never leaves this process: not into a release, not
          // into the App Runtime child, not into the View. An App names a model
          // and an effort, and both are closed sets.
          baseUrl: config.openai.base_url,
          apiKey: config.openai.api_key,
          requestTimeoutMs: appAgentsConfig.request_timeout_ms,
          maxToolTurns: appAgentsConfig.max_tool_turns,
        }),
        defaultModel: appAgentsConfig.default_model,
        defaultEffort: appAgentsConfig.default_effort,
        maxToolTurns: appAgentsConfig.max_tool_turns,
        turnTimeoutMs: appAgentsConfig.turn_timeout_ms,
        maxConcurrentTurns: appAgentsConfig.max_concurrent_turns,
        turnsPerAccountPerDay: appAgentsConfig.turns_per_account_per_day,
        onCompletion: (event) => agentCompletion.publish(event),
      });
      // Whatever a previous process left `running` is settled HERE, before any
      // turn can start. Nothing is re-dispatched; see the plane's docstring.
      appAgents.recover();
      opened.push({ what: "app-agents", close: () => appAgents!.stop() });
      services.push("app-agents");
      // Pick up anything queued while this process was down. `pump` is
      // idempotent and consumes at start, so a crash here cannot double-run.
      void appAgents.pump();
    }

    // 4c. Apps that exist because somebody declared them.
    //
    //     Session Plus above is compiled in — its adapter, its identity and its
    //     permission contract are this build's own source. Everything below is
    //     the same machinery driven by DATA: one row in `app_declarations` plus
    //     an installed release is a whole App, which is what makes adding one a
    //     call rather than a deploy (convergence plan, decision 2).
    //
    //     They borrow this deployment's App origin policy rather than getting a
    //     second set of knobs that could disagree with the first — and a
    //     deployment that PINNED one exact origin can serve exactly one App, so
    //     the declarations are reported and skipped instead of being published
    //     at a hostname the proxy does not route.
    const hosting = declaredAppHostingFrom(sessionPlus);
    if (!hosting.ok) {
      const declared = store.appCatalog.listAppDeclarations().filter((row) => row.enabled);
      if (declared.length > 0) {
        log.error(
          { apps: declared.map((row) => row.app_id), reason: hosting.error },
          "declared Apps cannot be served under a pinned session_plus.view_origin; they are not composed",
        );
      }
    } else {
      declaredApps = new DeclaredAppComposer({
        store,
        registry,
        host: releaseHost,
        preparedRoot: paths.preparedRoot,
        hosting: hosting.hosting,
        backends: appBackends,
        agentPlane: appAgents,
      });
      const composed = await declaredApps.loadAll();
      if (composed.length > 0) services.push("declared-apps");
    }

    appAgents?.completeBackendRegistration();

    // 4d. App tickets republish their App after they land.
    //
    //     Bound late rather than passed at construction because the pipeline is
    //     built in step 3 and this catalog in step 4 — and the direction of that
    //     dependency is deliberate: `devpipe/` must not import App hosting, or
    //     every composition (v2's `index.ts`, any deployment with Session Plus
    //     off) would drag the App catalog along. Unbound stays an honest state:
    //     a landed app ticket then says "this process hosts no Apps, so nothing
    //     was republished" in the ticket conversation.
    if (devPipeline && releaseHost) {
      const releaseTools = createAppTicketReleaseTools({
        ...(appPackRunner ? { remotePack: appPackRunner } : {}),
        host: releaseHost,
        ...(declaredApps ? { declareApp: (input) => declaredApps!.declare(input) } : {}),
      });
      devPipeline.setAppReleaseRefresher(releaseTools.publish);
      devPipeline.setAppHotswapExecutor(releaseTools);
      services.push("app-ticket-release-refresh");
      // No startup sweep (B9): a process that starts inside a deployment has
      // not passed its health gate yet. The deploy service publishes owed App
      // releases once no deployment is in flight (#61).
    }
  }

  // 5. The dashboard, restricted to the bootstrap surface.
  let dashboard: DashboardServer | null = null;
  let dashboardComposition: DashboardComposition | null = null;
  let architecture: ArchitectureService | null = null;
  let knowledge: KnowledgeWikiService | null = null;
  let knowledgeChat: KnowledgeChatService | null = null;
  let sessionPlusView: AppViewServer | null = null;
  if (config.dashboard?.enabled) {
    const publicHost =
      config.dashboard.public_host
      || (o.detectPublicHost === false ? undefined : (await detectPublicHost()) || undefined);

    // Where the session hub scans on THIS host. `session_hub.scan_homes` owns
    // the setting now; the secretary's copy still answers for whoever it
    // already named, and says so — the secretary itself is not built here and
    // must not have to be, just to read a map.
    const { homes, deprecated } = mergeScanHomes({
      sessionHub: config.session_hub?.scan_homes,
      secretary: config.secretary?.scan_homes,
    });
    if (deprecated.length > 0) {
      log.warn(
        { users: deprecated },
        "secretary.scan_homes 已弃用:会话中心的扫描目录请改配 session_hub.scan_homes(本次仍按旧键生效)",
      );
    }
    const collapsed = sharedEnvScanUsers({
      envHome: process.env.SESSIONS_SCAN_HOME,
      declared: homes,
      users: store.loadUsers().map((u) => u.username),
    });
    if (collapsed.length > 0) {
      log.error(
        { scanHome: process.env.SESSIONS_SCAN_HOME, users: collapsed },
        "SESSIONS_SCAN_HOME 覆盖了多个用户的会话扫描根:这些用户会互相看到对方的会话。"
          + "生产环境请改用 session_hub.scan_homes 逐人配置,或移除该环境变量",
      );
    }

    // The architecture observatory reads THIS process's own checkout: the
    // atlas describes the code that is running, not whatever branch a request
    // might name — so the root is PROJECT_ROOT rather than configuration.
    architecture = new ArchitectureService({ repoDir: PROJECT_ROOT, dataDir,
      ...(architectureRunner ? { runAnalyzer: architectureRunner } : {}) });
    // The knowledge wiki reads the graph the dev pipeline builds under the same
    // data dir; it opens lazily, so a composition whose pipeline has not built
    // one yet simply answers {generated:false}.
    knowledge = new KnowledgeWikiService({
      dataDir,
      store,
      ...(devPipeline ? { artifactHealth: () => devPipeline!.knowledgeArtifactHealth(), replayRepairs: () => devPipeline!.replayKnowledgeRepairs() } : {}),
    });
    knowledgeChat = new KnowledgeChatService(
      {
        baseUrl: config.openai.base_url,
        apiKey: config.openai.api_key,
        model: config.hq?.chat_model ?? "gpt-6-astra",
        effort: config.hq?.chat_reasoning_effort ?? "high",
      },
      store,
      knowledge,
      managedSupervisor,
    );
    opened.push({ what: "knowledge-chat", close: () => knowledgeChat!.close() });
    const interruptedKnowledgeChats = knowledgeChat.recoverInterruptedTurns();
    if (interruptedKnowledgeChats.length) {
      log.warn({ chats: interruptedKnowledgeChats.length }, "recovered interrupted knowledge chat turns");
    }
    services.push("knowledge-chat");

    dashboardComposition = composeDashboardServices(store, runnerCaps ?? undefined, {
      managedSupervisor,
      runnerTickets: config.selfhosting?.runner_tickets,
      developmentWorkspaces,
      surface: "bootstrap-v3",
      port: config.dashboard.port ?? 9820,
      host: config.dashboard.host,
      authToken: config.dashboard.auth_token || undefined,
      adminUsers: config.dashboard.admins,
      deployers: config.selfhosting?.deployers,
      publicHost,
      runnerWsPort: config.runner?.port ?? 9910,
      ...(runnerBundles ? { runnerBundle: runnerBundles } : {}),
      runnerPublicUrl: config.dashboard.runner_public_url,
      publicUrl: config.dashboard.public_url,
      oauthGithub: config.dashboard.oauth_github
        ? {
            clientId: config.dashboard.oauth_github.client_id,
            clientSecret: config.dashboard.oauth_github.client_secret,
          }
        : undefined,
      registration: config.dashboard.registration,
      userManager,
      scanHomeFor: (username) =>
        homes[username] ?? process.env.SESSIONS_SCAN_HOME ?? userManager.get(username)?.homeDir,
      sessionHubDirectSubmitAutoAllowUsers: directSubmitAutoAllowUsers,
      // The v3 control plane serves the unified chat surface: one ViewEntry
      // renderer, and a submit that returns an operation id instead of holding
      // the request open. v2's `index.ts` keeps `legacy`, which is what makes
      // this entry point rollable-back rather than a migration.
      sessionHubUi: "unified-v3",
      // The settings of whichever release is ACTIVE. `null` while none is, which
      // makes `/sessions-plus` a 503 that names the reason rather than a page
      // framing an origin nobody serves.
      sessionPlus: sessionPlus ? () => sessionPlusRelease?.active()?.settings ?? null : undefined,
      sessionPlusApp: sessionPlusApp ?? undefined,
      workspaceFiles: workspaceFilesCaps ?? undefined,
      sessionProjection: sessionProjection ?? undefined,
      executionWorkspace: executionWorkspaceCaps ?? undefined,
      sessionBranches: sessionBranchCaps ?? undefined,
      runnerFileTransfers: runnerFileTransfers ?? undefined,
      installExecutionRelayVerifier: runnerGateway
        ? (verifier) => runnerGateway!.installExecutionRelayVerifier(verifier)
        : undefined,
      installLocalAgentBridgeHandler: runnerGateway
        ? (handler) => runnerGateway!.installLocalAgentBridgeHandler(handler)
        : undefined,
      installSessionRecoveryIssuer: runnerGateway
        ? (issuer) => runnerGateway!.installSessionRecoveryIssuer(issuer)
        : undefined,
      subscribeManagedSessionCompletions: runnerGateway
        ? (listener) => runnerGateway!.subscribeManagedSessionCompletions(listener)
        : undefined,
      agentInteractions: agentInteractionCaps ?? undefined,
      // The per-user memory and skill directories on THIS host, resolved from
      // the live user registry — the dashboard builds the two capability
      // planes (`user-memory-v1`, `user-skills-v1`) and the MCP tool groups
      // over them. Deleting the account makes the resolver answer undefined,
      // which revokes the standing root on next use.
      memorySkills: {
        memoryDirFor: (username) => userManager.get(username)?.memoryDir,
        skillsDirFor: (username) => userManager.get(username)?.skillsDir,
      },
      tentacle: tentacleBroker && tentacleCaps
        ? { broker: tentacleBroker, capabilities: tentacleCaps }
        : undefined,
      // The document plane travels as a set: store, Gate, the deployment's
      // document policy, and the wake fan-out. Absent (no kernel) means the
      // provider refuses every scope.
      crdtDocs: crdtDocStore && crdtDocCaps
        ? {
            store: crdtDocStore,
            capabilities: crdtDocCaps,
            documentsFor: () => SEED_DESCRIPTORS,
            wake: crdtWakeHub ?? undefined,
          }
        : undefined,
      // The MCP surface's document tools read and merge through the SAME store
      // and the same document policy, so the two surfaces can never disagree
      // about which documents exist. (Its own honesty note about the missing
      // per-call gate is in `mcp/catalog.ts`.)
      mcpCrdtDocs: crdtDocStore
        ? { store: crdtDocStore, documentsFor: () => SEED_DESCRIPTORS }
        : undefined,
      // Every app this host serves. Backend health travels with each app rather
      // than as a separate panel option, so the panel never holds one
      // particular app's supervisor.
      appReleases: releaseHost ?? undefined,
      // Declaring an App is the runtime half of "App = pure data": the row, the
      // adapter, the catalog entry and the backend children all happen inside
      // this closure, and the process is not restarted. Absent when this
      // deployment cannot host declared Apps at all (no Session Plus block, or a
      // pinned `view_origin`), which makes the route a 404 rather than an
      // acceptance that quietly does nothing.
      declareApp: declaredApps
        ? (input) => declaredApps!.declare(input)
        : undefined,
      // App-only production debt does not need to rebuild or restart trusted
      // code. This narrow seam packs the already deployed tree and is exposed
      // only through the App registry's Administer route.
      publishPendingAppReleases: devPipeline && releaseHost
        ? (actor) => devPipeline!.publishPendingAppReleases(actor)
        : undefined,
      appHotswapApprovals: devPipeline && releaseHost
        ? {
            list: () => devPipeline!.listAppHotswapApprovals(),
            decide: (id, decision, actor) => devPipeline!.decideAppHotswapApproval(id, decision, actor),
          }
        : undefined,
      // Looking one up and driving ONE tab of it. Absent when this deployment
      // hosts no declared Apps at all, which makes `/apps/<id>/open` a 404
      // rather than a page framing an origin nobody serves.
      declaredApps: declaredApps
        ? {
            list: () => declaredApps!.list(),
            get: (stableAppId: string) => declaredApps!.get(stableAppId),
          }
        : undefined,
      attachDeclaredResources: declaredApps ? factory => declaredApps!.attachResources(factory) : undefined,
      researchCanvas: declaredApps ? {
        root: path.join(dataDir, 'research-v2'),
        ...(meetingTranscriptionCaps ? { meetingTranscription: meetingTranscriptionCaps } : {}),
        ...(config.research_v2?.moss ? {
          moss: { device: config.research_v2.moss.device, timeoutMs: config.research_v2.moss.timeout_ms },
        } : {}),
        model: {baseUrl: config.openai?.base_url ?? '', apiKey: appAgentsConfig.enabled ? config.openai?.api_key ?? '' : '',
          models: appAgentsConfig.models ?? [], defaultModel: appAgentsConfig.default_model ?? config.agent.model,
          filterModel: config.research_v2?.filter_model ?? config.discussions?.filter?.model ?? '', transcriptionModel: config.research_v2?.transcription_model},
        ...(feishuCredentials ? {feishu: new FeishuDiscussionTransport(feishuCredentials.appId, feishuCredentials.appSecret)} : {}),
        subscribeGroups: receive => {researchGroupReceivers.add(receive); return () => {researchGroupReceivers.delete(receive);};},
      } : undefined,
      // Which external shells may hold a binding to one of those Apps. Absent
      // (the default) makes the grant face and the external transport 404.
      externalAppHosts: externalAppHosts ?? undefined,
      // The MCP surface's apps tool group drives the SAME directory (and so
      // the same AppInstanceService door) the panel serves pages from, so the
      // two faces can never disagree about which Apps exist or which release
      // answers. Same seam shape as `mcpCrdtDocs`.
      mcpApps: declaredApps
        ? {
            list: () => declaredApps!.list(),
            get: (stableAppId: string) => declaredApps!.get(stableAppId),
            instancesFor: (stableAppId: string, owner: string) =>
              store.listSharedAppInstancesFor(stableAppId, owner).map((row) => ({
                instance: row.instance_key,
                role: store.getSharedAppMember(stableAppId, row.instance_key, owner)!.role,
                creator: row.creator,
                status: row.status,
                members: store.listSharedAppMembers(stableAppId, row.instance_key).length,
              })),
          }
        : undefined,
      mcpFeishu: feishuCaps ?? undefined,
      discussions,
      runnerCapabilities: runnerExtensionCaps ?? undefined,
      meetingTranscription: meetingTranscriptionCaps && config.research_v2?.moss
        ? { capabilities: meetingTranscriptionCaps, device: config.research_v2.moss.device }
        : undefined,
      mcpFeishuPrivilegedOperations: feishuCaps
        ? (owner) => resolvePrivilegedAgentGrant(config.feishu_gateway, owner)
        : undefined,
      feishuOAuth: feishuOAuth ?? undefined,
      feishuDirectory: feishuDirectory ?? undefined,
      feishuDocsAddon: feishuDocsAddonOptions(config.feishu_docs_addon, feishuCredentials),
      ...(config.feishu_docs_addon?.enabled && feishuCredentials ? { feishuDocsAgent: {
        userToken: (username: string) => feishuAuth?.getUserToken(username) ?? Promise.resolve(null),
        // Markdown conversion reads no user data, so it runs as the app itself.
        appToken: tenantTokenSource(feishuCredentials.appId, feishuCredentials.appSecret),
        // Notices come from the same Feishu app the card and the owner's identity binding use.
        notify: async (owner: string, card: CardPayload) => {
          const openId = feishuOpenIdOf(store, owner);
          if (!openId) throw new Error("owner has no Feishu identity");
          await sendFeishuCardDirect({ feishu: { enabled: true, app_id: feishuCredentials.appId, app_secret: feishuCredentials.appSecret },
            receiveIdType: "open_id", receiveId: openId, card, disabledError: "飞书应用未配置", sendErrorLabel: "发送飞书文档通知失败", availabilityHint: true });
        },
        ...(/^blk_[A-Za-z0-9]+$/.test(config.feishu_docs_addon.block_type_id ?? "") ? { componentTypeId: config.feishu_docs_addon.block_type_id } : {}),
      } } : {}),
      // The Session Plus surface asks about ONE app's prepared release; `/apps`
      // manages every app and stays app-agnostic.
      sessionPlusRelease: sessionPlusRelease ?? undefined,
      devPipeline: devPipeline ?? undefined,
      devScanHome: devPipeline ? os.homedir() : undefined,
      architecture,
      ...(knowledge ? { knowledge } : {}),
      ...(knowledgeChat ? { knowledgeChat } : {}),
      deployService: deployService ?? undefined,
      contribReview: contribReview ?? undefined,
      contribBundles: contribBundles ?? undefined,
      registerUser: (username, identity) =>
        userManager.register(username, identity).then((u) => ({ username: u.username })),
    });
    opened.push({ what: "dashboard-services", close: () => dashboardComposition!.close() });
    dashboard = new DashboardServer(dashboardComposition.options, dashboardComposition.services);
    dashboardComposition.attachTransport(dashboard.transportLifecycle);
    // Composing Dashboard services installs TentacleService's application
    // handler. Only now may the shared WS listener accept a dsh reconnect:
    // reliable clients flush their outbox immediately after registration, so
    // listening earlier creates a startup window in which valid replay is
    // rejected merely because the Gate consumer is not composed yet.
    if (runnerGateway) {
      await runnerGateway.start();
      opened.push({ what: "runner-gateway", close: () => runnerGateway!.stop() });
      log.info({ port: runnerGateway.port }, "runner gateway listening; capability service armed");
    }
    // @architecture flow=v3-lifecycle step=listen after=compose role=boundary label="Expose the guarded bootstrap surface" condition="required resources are composed" outcome=running authority="configured listener bindings"
    await dashboard.start();
    opened.push({ what: "dashboard", close: () => dashboard!.stop() });
    services.push("dashboard");
    log.info({ port: dashboard.port, surface: "bootstrap-v3" }, "dashboard listening");

    // The dev agent's submit/status tools call back through the dashboard's
    // loopback routes. Bind them before opening scheduling: restart wake-ups
    // must never launch a conversation-only agent that cannot submit its fix.
    devPipeline?.setToolApi(`http://127.0.0.1:${dashboard.port}`);
    devPipeline?.start();

    // The Agent View's own origin. It needs nothing from the panel, so the
    // order is arbitrary; what matters is that an unusable configuration was
    // already refused in step 0, and that a failure to BIND propagates out of
    // the composition root rather than leaving a panel that serves
    // `/sessions-plus` with nothing behind the frame for the rest of the
    // process's life.
    if (sessionPlus && sessionPlusRelease && releaseHost) {
      // ONE listener, every app in the catalog.
      //
      // The listener resolves each request's release from the digest label in
      // `Host`, through the registry — and the publication it asks is the
      // CATALOG's, not one app's. That is the difference between "a declared App
      // can be declared, installed and activated" and "a declared App can be
      // opened in a browser": before this, the one origin was wired to the one
      // compiled-in app, so every other app's hostname 404'd forever.
      //
      // A union is correct because a label is `app-<first 20 hex of
      // packageDigest>` and the digest covers the app id and the publisher — see
      // `AppReleaseHost.publishedLabels`. It follows Session Plus's ACTIVE
      // settings for the origin policy and the frame-ancestors policy (one
      // deployment, one app domain, one panel), but it will serve any installed
      // release's own bytes under that release's own name — which is what lets a
      // tab opened on the previous release finish draining.
      const catalog = releaseHost;
      const view = new AppViewServer(
        sessionPlusRelease.active()?.settings ?? sessionPlus,
        {
          publishedLabels: () => catalog.publishedLabels(),
          documentFor: (label, nonce) => catalog.documentFor(label, nonce),
        },
        // `external-app-host/v1`: an allow-listed external shell may FRAME the
        // App's own immutable View rather than reimplement its UI, and drive it
        // over the existing MessagePort protocol. Exact origins from the same
        // operator allowlist the transport checks; empty unless one is
        // configured, so this is `frame-ancestors <panel origins>` verbatim on
        // every deployment that has not asked for it.
        externalAppHosts ? [...externalAppHosts.origins] : [],
      );
      sessionPlusView = view;
      sessionPlusRelease.subscribe((release) => {
        if (release) view.useSettings(release.settings);
      });
      await sessionPlusView.start();
      opened.push({ what: "app-view", close: () => sessionPlusView!.stop() });
      services.push("app-view");

    }
    const ask = sessionPlus?.originAsk ?? null;
    if (ask) {
      // One exact, loopback-only certificate admission door for release
      // origins. The predicate calls no DNS or other service on the TLS
      // handshake path.
      originAsk = new AppOriginAskServer({
        host: ask.host,
        port: ask.port,
        ...(sessionPlus && releaseHost
          ? { policy: sessionPlus.origin, publishedLabels: () => releaseHost!.publishedLabels() }
          : {}),
      });
      await originAsk.start();
      opened.push({ what: "origin-ask", close: () => originAsk!.stop() });
      services.push("app-origin-ask");
    }
  }

  // 6. SEC-06 execution inventory.
  //
  //    `appAdapters` is no longer structurally empty — this composition can now
  //    attach an agent plane. What must still be 0 is `appReachableCodingCli`,
  //    and that is a DIFFERENT sentence: "no agents" and "no dangerous agents"
  //    are not the same claim, and the assertion that used to read "the array is
  //    empty" was quietly making the weaker one. The adapters listed here are
  //    the ones the active release actually declares, so a release naming a
  //    coding CLI would show up here — except that it cannot be activated,
  //    because the same imported predicate refuses it at manifest load.
  const execution = executionInventory({
    appAdapters: appAgents?.adapters() ?? [],
    ownerCliSurfaces: runnerCaps
      ? [
          {
            id: "session-hub:owner-cli",
            note: "用户自己设备上已有的 Claude/Codex 会话;只授权 list/read/live/append/resume,逐个 owner 绑定",
          },
        ]
      : [],
    trustedServices: devPipeline
      ? [{ id: TRUSTED_SERVICE_PRINCIPALS["dev-factory"], note: DEV_FACTORY_INVENTORY_NOTE }]
      : [],
  });

  const inventory: BootstrapInventory = {
    entry: "bootstrap-v3",
    surface: "bootstrap-v3",
    services,
    baseBranch: devPipeline?.baseBranch ?? null,
    stableBranch: deployService?.stableBranch ?? null,
    dashboardPort: dashboard?.port ?? null,
    runnerPort: runnerGateway?.port ?? null,
    sessionPlus: sessionPlus
      ? (() => {
          const serving = sessionPlusRelease?.active() ?? null;
          const settings = serving?.settings ?? sessionPlus;
          const registry = sessionPlusRelease?.describe() ?? null;
          return {
            viewOrigin: settings.viewOrigin,
            packageDigest: settings.identity.packageDigest,
            permissionContractDigest: settings.identity.permissionContractDigest,
            frameAncestors: settings.frameAncestors,
            development: settings.development,
            listenPort: sessionPlusView?.port ?? null,
            statePid: sessionPlusSupervisor?.status.statePid ?? null,
            runtimePid: sessionPlusSupervisor?.status.runtimePid ?? null,
            backends: {
              state: sessionPlusSupervisor?.status.state ?? "stopped",
              runtime: sessionPlusSupervisor?.status.runtime ?? "stopped",
            },
            release: {
              activatedBy: serving?.activatedBy ?? "(none)",
              activatedAt: serving?.activatedAt ?? "",
              checkoutPackageDigest: registry?.checkout?.packageDigest ?? null,
              checkoutInstalled: registry?.checkout?.installed ?? false,
              originAskPort: originAsk?.port ?? null,
              // Null when a release is serving. Non-null is the ONLY place a
              // reader can learn why `session-plus-runtime` is absent from the
              // service list — see the warn at composition time.
              unavailable: sessionPlusRelease?.unavailable() ?? null,
            },
          };
        })()
      : null,
    appAgents: {
      enabled: Boolean(appAgents),
      adapters: appAgents?.adapters() ?? [],
      /**
       * The active release declares an agent this host will not run.
       *
       * Reported rather than refused. A release needing a typed port nobody
       * installed ships a permanently broken panel, so that one is refused; an
       * App whose agent never runs behaves exactly as it did before agents
       * existed, and refusing it would mean an operator who declines to spend
       * on inference cannot run the App at all.
       */
      declaredButDisabled: Boolean(
        !appAgents && Object.keys(sessionPlusRelease?.active()?.prepared.manifest.agents ?? {}).length,
      ),
      // The two facts SEC-06 wants an operator to be able to read without
      // diffing two entry points: whether anybody DECLARED what kind of host
      // this is, and — when the answer traded the multi-user guarantee away —
      // the sentence that says so.
      deploymentProfile: deploymentProfile(),
      deploymentProfileDeclared: deploymentProfileDeclared(),
      disclosure: profileDisclosure(),
    },
    execution,
  };
  log.info(inventory, "bootstrap-v3 startup inventory");
  if (inventory.appAgents.declaredButDisabled) {
    log.warn(
      "当前 active release 声明了 App agent，但本部署没有构造 agent 平面（app_agents.enabled 为关）;"
      + "App 其余部分照常工作，agent 不会被触发",
    );
  }
  if (execution.appReachableCodingCli > 0) {
    log.error(
      { count: execution.appReachableCodingCli },
      "普通 App Agent 可达的 coding CLI 数量不为 0 — 这不是 cloud-multi-user 部署应有的状态",
    );
  }

  // 7. Heartbeat. Same file and cadence the supervisor's health gate expects.
  const healthFile = o.healthFile ?? HEALTH_FILE;
  const heartbeatMs = o.healthIntervalMs ?? 30_000;
  const beat = () => {
    try {
      writeFileSync(healthFile, new Date().toISOString());
    } catch (err) {
      log.warn({ err, healthFile }, "could not write the health file");
    }
  };
  beat();
  const heartbeat = heartbeatMs > 0 ? setInterval(beat, heartbeatMs) : null;
  heartbeat?.unref?.();

  // 8. Retention for the two append-only audit trails. Both run as paced
  // background steps after startup; the first capability pass also removes the
  // routine reads earlier versions recorded.
  const caps = runnerCaps;
  const stopRetention: Array<() => void> = [
    ...(caps ? [paceRetention("capability-audit", () => caps.service.pruneAudit(Date.now() - AUDIT_RETENTION_MS))] : []),
    paceRetention("permission-audit",
      () => store.prunePermissionAudit(new Date(Date.now() - AUDIT_RETENTION_MS).toISOString(), 500) === 500),
  ];
  // Scratch worktrees an earlier process left behind (knowledge-graph sources,
  // deploy reviews, per-SHA release sources), one directory at a time.
  if (config.selfhosting?.enabled) {
    const repoDir = config.selfhosting.repo_dir ?? PROJECT_ROOT;
    const worktreesDir = config.selfhosting.worktrees_dir ?? path.join(repoDir, "..", "octopus-worktrees");
    const sweep = new AbortController();
    const timer = setTimeout(() => void (async () => {
      const common = { repoDir, worktreesDir, pauseMs: 3000, signal: sweep.signal };
      const removed = await sweepScratchWorktrees({ ...common, pattern: KNOWLEDGE_SCRATCH, minAgeMs: 3600_000, inUse: knowledgeScratchInUse })
        + await sweepScratchWorktrees({ ...common, pattern: RELEASE_SCRATCH, minAgeMs: 24 * 3600_000 });
      if (removed) log.info({ removed, worktreesDir }, "removed leftover scratch worktrees");
    })().catch((err: unknown) => log.warn({ err }, "scratch worktree sweep failed")), 10 * 60_000);
    timer.unref?.();
    stopRetention.push(() => { clearTimeout(timer); sweep.abort(); });
  }

  // A snapshot is an attribute of the running checkout, so process startup is
  // the reliable commit boundary: every deployed commit reaches this point.
  // Start only after every listener and the health heartbeat are ready; the
  // analyzer is deliberately background work and cannot delay readiness.
  if (architecture && o.architectureAutoRefresh !== false) {
    architecture.startAutoRefresh();
    opened.push({ what: "architecture-auto-refresh", close: () => architecture!.stop() });
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    // @architecture flow=v3-lifecycle step=drain after=listen role=lifecycle label="Stop accepting and wait for in-flight work" condition="returned stop closure is called" outcome=draining authority="composition-root lifecycle owner"
    // @architecture flow=v3-lifecycle step=already-stopped after=drain role=lifecycle label="Ignore a repeated stop" condition="stop already completed or started" outcome=idempotent authority="local stopped flag" terminal=true
    if (stopped) return;
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    for (const halt of stopRetention) halt();
    try {
      unlinkSync(healthFile);
    } catch {
      /* already gone */
    }
    // Order mirrors construction, reversed: stop accepting first, then let
    // in-flight work finish, then close what it was working through. The dev
    // pipeline's `stop()` waits for a running CLI turn rather than killing it —
    // that turn holds the merge lock and may be mid-gate.
    // @architecture flow=v3-lifecycle step=reverse-close after=drain role=lifecycle label="Close resources in reverse construction order" condition="first stop call owns teardown" outcome=stopped authority="composition-root resource inventory" terminal=true
    await originAsk?.stop().catch((err: unknown) => log.warn({ err }, "app origin ask stop failed"));
    await sessionPlusView?.stop().catch((err: unknown) => log.warn({ err }, "session-plus view stop failed"));
    await dashboard?.stop().catch((err: unknown) => log.warn({ err }, "dashboard stop failed"));
    await dashboardComposition?.close().catch((err: unknown) => log.warn({ err }, "dashboard services stop failed"));
    await architecture?.stop().catch((err: unknown) => log.warn({ err }, "architecture analyzer stop failed"));
    // Quiesce every producer and drain shared recovery while its database,
    // capability authority, and App backends are still available. The startup
    // undo stack alone is not the normal stop path.
    appAgents?.stop();
    knowledgeChat?.close();
    await opened.find(step => step.what === "discussions")?.close();
    await devPipeline?.stop().catch((err: unknown) => log.warn({ err }, "dev pipeline stop failed"));
    await managedSupervisor.close();
    await sessionPlusApp?.stop();
    // Every declared App's coordinator, before the child processes it talks to.
    declaredApps?.stop();
    await sessionPlusSupervisor?.stop().catch((err: unknown) => log.warn({ err }, "session-plus backends stop failed"));
    deployService?.stop();
    await loopback?.stop().catch((err: unknown) => log.warn({ err }, "capability loopback stop failed"));
    await runnerGateway?.stop().catch((err: unknown) => log.warn({ err }, "runner gateway stop failed"));
    await opened.find(step => step.what === "meeting-transcription-capabilities")?.close();
    await convergenceUsage.flush();
    // The kernel holds a single-writer lease on capabilities.db; a process that
    // exits without releasing it makes the NEXT one fail to start.
    runnerCaps?.service.close();
    store.close();
    log.info("bootstrap-v3 stopped");
  };

  return { inventory, store, dashboard, devPipeline, stop };
  } catch (err) {
    // A half-started control plane is worse than none: the dashboard would be
    // reachable, the runner gateway would accept laptops, and the capability
    // lease would block the next attempt. Undo, then report the real cause.
    // @architecture flow=v3-lifecycle step=startup-unwind after=compose,listen role=rollback label="Undo every resource opened by failed startup" condition="any composition or listener step throws" outcome=rollback authority="composition-root undo stack" terminal=true
    return await unwind(err);
  }
}

function warnAboutV2Watermarks(baseBranch: string, stableBranch: string): void {
  const suspicious = [baseBranch, stableBranch].filter((b) => V2_WATERMARKS.has(b));
  if (suspicious.length > 0) {
    log.warn(
      { baseBranch, stableBranch },
      `selfhosting 指向了 v2 的水位线分支(${suspicious.join(", ")});`
        + `当前默认值是 ${V3_BASE_BRANCH} / ${V3_STABLE_BRANCH}`,
    );
  }
  const stale = [baseBranch, stableBranch].filter((b) => V3_WATERMARKS.has(b));
  if (stale.length > 0) {
    log.warn(
      { baseBranch, stableBranch },
      `selfhosting 指向了上一代(v3)的水位线分支(${stale.join(", ")});`
        + `2026-08-07 起水位线改名为 ${V3_BASE_BRANCH} / ${V3_STABLE_BRANCH},v3 分支已停止前移`,
    );
  }
}

async function main(): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? "/app/config.yaml";
  const dataDir = process.env.DATA_DIR ?? "/data";
  // A canary may run beside v2 on the same host. Sharing the default heartbeat
  // would let either process satisfy the other's gate, and stopping the canary
  // would unlink the live bot's file. Production keeps the established default;
  // side-by-side compositions must opt into their own path.
  const healthFile = process.env.HEALTH_FILE ?? HEALTH_FILE;

  log.info({ configPath, dataDir, healthFile }, "v3 bootstrap starting");
  const config = loadConfig(configPath, (message) => log.warn(message));
  if (config.selfhosting?.deployment_build) process.env.OCTOPUS_COMPUTE_ROLE = "control";
  log.info({ instance: config.instance.name }, "config loaded");

  const boot = await startBootstrapV3({ config, dataDir, healthFile });
  // Two ready lines on purpose. The first is the SUPERVISOR'S HEALTH-GATE
  // CONTRACT (SUP_MARKER in scripts/supervisord.sh): the running supervisor
  // loaded its pattern at ITS start, so this string can only change in a
  // coordinated supervisor restart — renaming it casually would make the next
  // deploy fail its health gate and auto-roll back. The second is the honest
  // branding line for humans reading the log.
  log.info("v3 bootstrap ready");
  log.info({ watermark: V3_BASE_BRANCH }, "octopus v4 platform ready");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    // Backstop for a teardown that wedges (a socket that will not close).
    const timer = setTimeout(() => {
      log.error("shutdown timeout exceeded, forcing exit");
      process.exit(1);
    }, 60_000);
    try {
      await boot.stop();
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      log.error({ err }, "error during shutdown");
      clearTimeout(timer);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * Only when run as the program. Importing this module — which the tests do, to
 * compose it against a temp dir — must not start a server.
 */
const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]!).href === import.meta.url;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
