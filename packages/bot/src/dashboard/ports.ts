import type { ManagedExecutionSupervisor } from "../managed-execution/supervisor.js";
/**
 * Narrow ports between the dashboard transport and the process composition roots.
 *
 * This module contains no construction: bootstrap-v3 supplies every service
 * explicitly, while DashboardServer owns only HTTP/authentication transport.
 */

import type { RunnerFileTransfers } from "../runner-file-transfer/service.js";
import type { AppInstanceService } from "../app-registry/app-instance.js";
import type { DiscussionCapabilities } from '../discussions/capability.js';
import type { AppReleaseHost } from "../app-registry/release-host.js";
import type { PreparedSessionPlusRelease } from "../app-registry/session-plus-adapter.js";
import type { ArchitectureService } from "./architecture.js";
import type { KnowledgeWikiService } from "./knowledge.js";
import type { KnowledgeChatService } from "./knowledge-chat.js";
import type { SystemStatusProbe } from "./system-status.js";
import type { PanelSurface } from "./authz.js";
import type { GithubFetcher, PendingRegistrationStore, StateStore } from "./oauth-github.js";
import type { WebSessionManager } from "./web-session.js";
import type { CodexQuotaProbe } from "../devpipe/codex-quota.js";
import type { ContribReviewService } from "../devpipe/contrib-review.js";
import type { BundleHandoff } from "../devpipe/bundle-handoff.js";
import type {
  AppHotswapApprovalView,
  AppHotswapDecisionResult,
  DevPipeline,
  PendingAppReleaseDrain,
} from "../devpipe/pipeline.js";
import type { QuotaProbe } from "../devpipe/quota.js";
import type { CrdtDocCapabilities } from "../crdt-doc/capability.js";
import type { CrdtDocumentStore } from "../crdt-doc/store.js";
import type { CrdtDocumentDescriptor } from "../crdt-doc/types.js";
import type { CrdtWakeHub } from "../crdt-doc/wake.js";
import type { FeishuCapabilities } from "../feishu/gateway.js";
import type { FeishuOAuthPortal } from "../feishu/oauth-portal.js";
import type { FeishuDocsAddonOptions } from "../feishu/docs-addon-auth.js";
import type { FeishuDocsAddonService } from "../feishu/docs-addon.js";
import type { McpAppsDirectory, McpSurface, McpSurfaceOptions } from "../mcp/service.js";
import type { NotifyDelivery } from "../notify/types.js";
import type { AppTrustService } from "../permissions/app-trust.js";
import type { PermissionService } from "../permissions/service.js";
import type { PermissionStudioService } from "../permissions/studio.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerBundleSource } from "../runner/bundle-registry.js";
import type {
  RunnerExecutionRelayVerifier,
  RunnerLocalAgentBridgeHandler,
  RunnerSessionRecoveryIssuer,
} from "../runner/gateway.js";
import type { SessionPlusAppService } from "../session-plus/app-service.js";
import type { RunnerSessionProjectionService } from "../runner/session-projection.js";
import type { SessionPlusSettings } from "../app-core/settings.js";
import type { SessionOperationCoordinator } from "../sessionhub/operations.js";
import type { SessionHubService } from "../sessionhub/service.js";
import type { Store } from "../store/store.js";
import type { TentacleBroker } from "../tentacle/broker.js";
import type { TentacleCapabilities } from "../tentacle/capability.js";
import type { TentacleService } from "../tentacle/service.js";
import type { UserManager } from "../user/types.js";
import type { AgentInteractionCapabilities } from "../agent-interactions/capability.js";
import type { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import type { ExecutionWorkspaceCapabilities } from "../execution-workspace/capability.js";
import type { SessionBranchCapabilities } from "../session-branch/capability.js";
import type { PolicyRule } from "../authorization/types.js";
import type { ExternalAppHostService } from "../app-external/service.js";
import type { ExternalAppHostingSettings } from "../app-external/settings.js";
import type { CapabilityService } from "@claude-bot/capability-kernel";
import type { FableTicketApprovalService } from "../devpipe/ticket-agent-approval.js";
import type { RunnerManagedCompletion } from "@claude-bot/runner/gateway-protocol";

/** The generic App operations exercised by the trusted Dashboard transport. */
export type DashboardAppInstancePort = Pick<
  AppInstanceService,
  | "open"
  | "dispatch"
  | "closeInstance"
  | "subscribe"
  | "sharedRoles"
  | "sharedJoinPolicy"
  | "readSharedProjections"
  | "releaseSharedInstance"
  | "releaseOwner"
  // `external-app-host/v1`: the third admission door and the two seams its
  // service needs. `releaseCredential` is what makes a revocation exact — an
  // external binding's instances are the ones opened under its credential id.
  | "openExternal"
  | "releaseCredential"
  | "actionSurface"
  | "agentActivity"
  | "stopAgentActivity"
> & Partial<Pick<AppInstanceService, "sharedInstanceTitle">>;

/**
 * One declared App, as much of it as the panel is allowed to know.
 *
 * `viewOrigin` and `packageDigest` are null while nothing is activated, which is
 * the normal first state of a declared App and must read as "install one" rather
 * than as a defect. `service` is null when this composition built no backend
 * children for it — a catalogued App with no coordinator can be listed and
 * managed, and cannot be opened.
 */
export interface DeclaredAppSurface {
  stableAppId: string;
  publisher: string;
  title: string;
  viewOrigin: string | null;
  viewUrl?: string;
  packageDigest: string | null;
  service: DashboardAppInstancePort | null;
  /** Why nothing is being served, when that is the case. */
  unavailable: string | null;
}

export interface DeclaredAppDirectory {
  list(): readonly DeclaredAppSurface[];
  get(stableAppId: string): DeclaredAppSurface | null;
}

export interface SessionPlusReleaseSource {
  active(): { prepared: PreparedSessionPlusRelease } | null;
  unavailable(): { message: string } | null;
}

/** Inputs the process composition root may use to build the dashboard's services. */
export interface DashboardCompositionOptions {
  managedSupervisor?: ManagedExecutionSupervisor;
  port: number;
  host?: string;
  authToken?: string;
  /**
   * Which composition this panel is serving (`dashboard/authz.ts`). Default
   * `full` — the v2 dashboard, every route in the table.
   *
   * `bootstrap-v3` restricts the whole surface to `BOOTSTRAP_ROUTE_IDS`: every
   * other route id answers 404, including the paths handled before the identity
   * gate, and navigation is filtered by the same allowlist. It is a property of
   * the composition rather than of the viewer, which is why it is an option
   * here and not a capability bit.
   */
  surface?: PanelSurface;
  /** Usernames whose personal key carries admin rights (`dashboard.admins`). */
  adminUsers?: string[];
  /** Legacy deploy allow-list (`selfhosting.deployers`), folded into `deploy`. */
  deployers?: string[];
  /** Public WS port runners dial into (shown in the tutorial). */
  runnerWsPort?: number;
  /** Dynamic active standalone artifact served at /download/runner.js. */
  runnerBundle?: RunnerBundleSource;
  /** Public URL runners dial (TLS endpoint behind a proxy); shown in the tutorial. */
  runnerPublicUrl?: string;
  /** Outside-reachable host/IP of this machine (config or startup detection); shown in the tutorial. */
  publicHost?: string;
  /** Dashboard's own public https URL (config `dashboard.public_url`); tutorial download commands use it. */
  publicUrl?: string;
  /** GitHub OAuth App credentials. The client secret remains config-only. */
  oauthGithub?: { clientId: string; clientSecret: string };
  /** New-account admission. Absent is deliberately closed. */
  registration?: "open" | "closed";
  /**
   * Immutable authorization program supplied by trusted process composition.
   *
   * Rules are validated at startup and are never accepted from Dashboard
   * requests. An omitted program is intentionally empty.
   */
  authorizationRules?: readonly PolicyRule[];
  /** Identity/directory authority used by GitHub login and registration. */
  userManager?: UserManager;
  /** Test seam for the two server-to-GitHub requests. */
  githubFetcher?: GithubFetcher;
  /**
   * Resolve the on-this-host scan home for a user (precedence:
   * `session_hub.scan_homes` > `SESSIONS_SCAN_HOME` > bot-managed home).
   * Undefined = this user has no local session source.
   */
  scanHomeFor?: (username: string) => string | undefined;
  /** Trusted owners whose own browser Session Hub submits skip a second click. */
  sessionHubDirectSubmitAutoAllowUsers?: readonly string[];
  /**
   * Which response contract the legacy Session Hub submit API serves.
   *
   * `legacy` holds its HTTP request open until the CLI answers. `unified-v3`
   * returns an operation id immediately so the caller can follow the stream.
   * There is no corresponding page fork: `/sessions` is always a compatibility
   * redirect and Session Plus is the sole browser session UI.
   *
   * The seam is deliberately narrow — the routes, permission table and
   * `SessionHubService` do not fork.
   */
  sessionHubUi?: "legacy" | "unified-v3";
  /**
   * Session Plus (`packages/bot/src/session-plus`), the Agentic App probe.
   *
   * Absent = the feature does not exist on this panel: `/sessions-plus` is a
   * 404, the 会话+ tab is not rendered, and nothing here frames anything. The
   * settings object is the VALIDATED one — an invalid `session_plus:` block
   * never reaches this far, because the composition root refuses to start
   * rather than serving a page whose frame origin nobody checked.
   */
  sessionPlus?: SessionPlusSettings | (() => SessionPlusSettings | null);
  /** Trusted coordinator; required whenever `sessionPlus` is constructed. */
  sessionPlusApp?: SessionPlusAppService;
  /** Trusted post-Gate session materialization shared by Runner and Session Plus. */
  sessionProjection?: RunnerSessionProjectionService;
  /**
   * The workspace-files capability plane, when this deployment has a Runner.
   *
   * Its own capability Object over the same laptops, constructed by the boot
   * wiring because only that has the raw transport. Absent means this host has
   * no file backend at all — the provider is still installed (so a release that
   * declares the contract stays activatable and rollback-able) and every scope
   * it opens holds nothing, which the file panel says out loud.
   */
  workspaceFiles?: WorkspaceFilesCapabilities;
  /** Post-Gate, launch-scoped command plane for split runtime/execution placement. */
  executionWorkspace?: ExecutionWorkspaceCapabilities;
  /** Session snapshots' anchors and forks: their own Object over the same laptops. */
  sessionBranches?: SessionBranchCapabilities;
  runnerFileTransfers?: RunnerFileTransfers;
  /**
   * One boot-only registration seam for the Runner gateway's peer relay.
   * The installed verifier is backed by the live session-execution registry.
   */
  installExecutionRelayVerifier?: (verifier: RunnerExecutionRelayVerifier) => () => void;
  /** Install the authenticated Runner-local MCP plane after McpSurface exists. */
  installLocalAgentBridgeHandler?: (handler: RunnerLocalAgentBridgeHandler) => () => void;
  /** Authenticated Runner restart can rotate a scope for a durable split binding. */
  installSessionRecoveryIssuer?: (issuer: RunnerSessionRecoveryIssuer) => () => void;
  /** Content-free provider completion facts, authenticated by the Runner socket. */
  subscribeManagedSessionCompletions?: (
    listener: (owner: string, device: string, completion: RunnerManagedCompletion) => void,
  ) => () => void;
  /** Separate single-use plane for provider questions and approval requests. */
  agentInteractions?: AgentInteractionCapabilities;
  /**
   * The collaborative-document plane, for the MCP surface's document tools.
   *
   * A deliberately narrow seam: the store and the trusted "which documents may
   * this owner reach" answer, both owned by whichever composition registers the
   * `CrdtDocumentStore`. Absent — today's default — means the crdt tool group
   * simply does not exist on the MCP endpoint, and the `service:mcp` consent
   * card does not ask about it. Wiring it is one option at the composition
   * root, not an edit to this file.
   */
  mcpCrdtDocs?: {
    store: CrdtDocumentStore;
    documentsFor: (owner: string) => readonly CrdtDocumentDescriptor[];
  };
  /**
   * The declared-App directory for the MCP surface's apps tool group — the
   * same directory `declaredApps` serves pages from, injected as its own seam
   * (mirroring `mcpCrdtDocs`) so a composition can serve the pages without the
   * MCP face or vice versa. Absent — today's default until the composition
   * root passes it — means the group does not exist on the endpoint and the
   * `service:mcp` consent card does not ask about it. Identity never rides an
   * argument: the surface opens every turn for the token's own owner.
   */
  mcpApps?: Pick<McpAppsDirectory, "list" | "get" | "instancesFor">;
  /** User-OAuth Feishu capability plane exposed only through reviewed MCP tools. */
  mcpFeishu?: FeishuCapabilities;
  discussions?: DiscussionCapabilities;
  /** Fixed Runner transcription route; owner comes from the authenticated MCP principal. */
  runnerCapabilities?: McpSurfaceOptions["runnerCapabilities"];
  meetingTranscription?: McpSurfaceOptions["meetingTranscription"];
  /** Deployment-policy ceiling for tenant/admin Feishu operations, per exact owner. */
  mcpFeishuPrivilegedOperations?: (owner: string) => readonly string[];
  /** Browser device-flow coordinator; credentials remain in the user store. */
  feishuOAuth?: FeishuOAuthPortal;
  feishuDocsAddon?: FeishuDocsAddonOptions;
  /**
   * What the docs add-on does beyond its own card: Feishu document calls as the
   * owner (their stored OAuth user token, never leaving this process), owner
   * notices sent by the same Feishu app, and the widget's block type id.
   */
  feishuDocsAgent?: {
    userToken(username: string): Promise<string | null>;
    /** The app's own tenant token, for Feishu calls that read no user data (Markdown conversion). */
    appToken?(): Promise<string>;
    notify(owner: string, card: import("../feishu/direct-card.js").CardPayload): Promise<void>;
    componentTypeId?: string;
  };
  /**
   * The per-user memory and skill directories on the BOT host, as trusted
   * resolvers from the composition root's user registry (`User.memoryDir`,
   * `User.skillsDir`). Present = this server constructs the two capability
   * planes (`user-memory-v1`, `user-skills-v1`) on the process's one kernel —
   * the same pattern as `localScan` — and the MCP surface serves their tool
   * groups. Absent = the groups do not exist and the `service:mcp` consent
   * card does not ask about them. The resolvers are server-side facts and are
   * never taken from, or echoed to, a browser.
   */
  memorySkills?: {
    memoryDirFor: (username: string) => string | undefined;
    skillsDirFor: (username: string) => string | undefined;
  };
  /** Authenticated dsh transport plus its pinned capability Objects. */
  tentacle?: {
    broker: TentacleBroker;
    capabilities: TentacleCapabilities;
  };
  /**
   * How a `notify/v1` message physically leaves this deployment.
   *
   * Absent means this composition has no outbound channel — `bootstrap-v3`
   * builds no Feishu chat provider at all. The
   * provider is installed either way, exactly like `workspaceFiles`: the
   * contract is served, and every scope it opens holds nothing.
   *
   * Note that a delivery alone grants nothing. `sessionPlusNotifyGrant` also
   * requires the release's permission contract to declare `send_notification`,
   * and neither contract this build implements does — so reaching a person
   * needs a contract expansion, which is a new digest and a fresh consent.
   */
  notifyDelivery?: NotifyDelivery;
  /**
   * The collaborative-document plane, when this deployment composed one.
   *
   * Everything arrives together because the pieces only mean something as a
   * set: the store holds the documents, the capability plane is the Gate the
   * provider answers to, `documentsFor` is the deployment's decision about
   * which documents an owner's scope may reach, and the wake hub is the
   * trusted fan-out that turns a merge into content-free `wake` events.
   * Absent means the provider is still installed and every scope it opens
   * holds nothing — the same fail-closed shape as `workspaceFiles`.
   */
  crdtDocs?: {
    store: CrdtDocumentStore;
    capabilities: CrdtDocCapabilities;
    documentsFor: (owner: string) => readonly CrdtDocumentDescriptor[];
    wake?: CrdtWakeHub;
  };
  /**
   * Local Agentic App release management, for every app this host serves.
   *
   * Absent = `/apps` and `/api/apps*` are 404 and the 应用 tab is not rendered.
   * Present = an admin may install a bounded, pre-built artifact, activate it,
   * roll back to an installed older one, or deactivate an App entirely. The
   * panel does no publishing of its own: every one of those verbs is one call
   * into the catalog, which routes by stable App id and owns the ordering that
   * makes a bad candidate unable to replace a working release.
   *
   * Backend process health arrives through the same object (each app reports
   * its own supervisor's status), so the panel never has to be handed one
   * particular app's children.
   */
  appReleases?: AppReleaseHost;
  /**
   * Declare one more Agentic App, without restarting anything.
   *
   * The last step of "App = pure data" (convergence plan, decision 2): a
   * declaration is a row plus a composition, so adding an App stops being an
   * edit to a composition root. The panel does none of that work — it parses
   * three bounded fields, names who asked, and reports what the composition
   * root answered.
   *
   * Absent = `/api/apps/declare` is a 404. A composition may perfectly well
   * manage releases (`appReleases`) without being able to host declared Apps —
   * a deployment that pinned one exact App origin is exactly that case — and a
   * route that accepted a declaration it could not compose would be an
   * acceptance that quietly does nothing.
   */
  declareApp?: (input: {
    stableAppId: string;
    publisher: string;
    title: string;
    by: string;
  }) => Promise<
    | { ok: true; app: string; publisher: string; title: string }
    | { ok: false; code: "invalid" | "app_exists" | "compose_failed"; message: string }
  >;
  /**
   * Drain landing-recorded App debt from the deployed checkout without a
   * trusted-process deployment. The route is `Administer`; absent means the
   * Apps page can manage supplied artifacts but cannot build recorded debt.
   */
  publishPendingAppReleases?: (actor: string) => Promise<PendingAppReleaseDrain>;
  /** Exact-digest activation requests created by agents; Dashboard session only. */
  appHotswapApprovals?: {
    list(): AppHotswapApprovalView[];
    decide(id: string, decision: "approve" | "reject", actor: string): Promise<AppHotswapDecisionResult>;
  };
  /**
   * The Session Plus app's own hosted release, for the `/sessions-plus` surface.
   *
   * Separate from `appReleases` on purpose, and the split is the whole point of
   * the catalog: `/apps` manages EVERY app and must stay app-agnostic, while
   * the consent page, the release record and the resource binder ask about ONE
   * app's prepared release and need its type. Handing the management surface a
   * Session-Plus-shaped object is exactly what made a second app a change to
   * this file.
   */
  sessionPlusRelease?: SessionPlusReleaseSource;
  /**
   * The Apps that exist because somebody declared them, for `/apps/<id>/open`.
   *
   * Absent = this composition serves no declared Apps at all, which makes the
   * two routes a 404 rather than a page that frames nothing. Deliberately a
   * narrow directory rather than the composer: the panel may LOOK UP an App and
   * drive one tab of it; it may not declare, compose or tear one down.
   */
  declaredApps?: DeclaredAppDirectory;
  /** Bootstrap-only installation of reviewed resource providers. */
  attachDeclaredResources?: (factory: import('../app-registry/resource-plane.js').DeclaredResourceFactory) => () => void;
  researchCanvas?: import('../research-canvas/host.js').ResearchCanvasOptions;
  /**
   * External Agentic App hosts (`external-app-host/v1`), already validated.
   *
   * Absent = no external host may hold a binding, which makes both the grant
   * face and the external transport 404. The service itself is built by the
   * composition below, out of the same Store, App-trust door and declared-App
   * directory the panel already holds — a second copy of any of those is
   * exactly the drift this surface must not introduce.
   */
  externalAppHosts?: ExternalAppHostingSettings;
  /** Self-hosting dev pipeline; absent = /tickets is not served. */
  devPipeline?: DevPipeline;
  runnerTickets?: import("../devpipe/runner-ticket.js").TicketRunnerConfig;
  /** Trusted owner/device/parent transport; composition supplies the per-turn MCP issuer. */
  developmentWorkspaces?: Parameters<DevPipeline["setDevelopmentWorkspaces"]>[0];
  /**
   * Architecture observatory: the compact atlas projection plus its
   * single-slot refresh job. Absent = `/architecture` and `/api/architecture*`
   * are 404 and the tab is not rendered — a composition without a checkout to
   * analyze has nothing to serve here.
   */
  architecture?: ArchitectureService;
  /**
   * Knowledge wiki: the human-facing projection of the derived knowledge graph
   * plus the review ledger. Absent = `/knowledge` and `/api/knowledge*` are 404.
   */
  knowledge?: KnowledgeWikiService;
  /** Personal knowledge conversations; separate from dev tickets and their execution pipeline. */
  knowledgeChat?: KnowledgeChatService;
  /** Scan home where dev-ticket sessions land (the bot process's own home). */
  devScanHome?: string;
  /** Phase-2 deploy choreography (trigger/confirm/verify endpoints). */
  deployService?: import("../devpipe/deploy.js").DeployService;
  /** Subscription-quota probe for the dev panel; defaults to a lazy real one. */
  quotaProbe?: QuotaProbe;
  /**
   * Codex subscription-quota probe. Reads OMP's redacted multi-account usage
   * projection, matching the same credential pool the default ticket executor
   * balances across; defaults to a lazy real one. Merged into `/api/dev/quota`
   * alongside Claude cards so the top strip picks up both providers.
   */
  codexQuotaProbe?: CodexQuotaProbe;
  /** Host CPU/memory probe for the dev status strip; defaults to a lazy real one. */
  systemStatusProbe?: SystemStatusProbe;
  /**
   * Feishu tenant directory for the /admin onboarding console (ticket #18).
   * Absent = /admin's Feishu section shows a "未配置飞书" hint instead of
   * a member browser; existing capability rows still work.
   */
  feishuDirectory?: import("../channel/feishu-directory.js").FeishuDirectory;
  /**
   * Register a new user with an initial Feishu identity, chosen by an admin
   * on /admin (ticket #18). Split out of UserManager into the composition input
   * so tests can stub it without wiring the whole manager. Errors bubble as
   * message-strings the page shows verbatim.
   */
  registerUser?: (
    username: string,
    identity: { provider: "feishu" | "cli" | "local"; externalId: string; label?: string },
  ) => Promise<{ username: string }>;
  /**
   * The review lane's maintainer face (2026-08-20): the merge-proposal queue,
   * approve/reject, and filing a batch merge. Absent = the routes answer 404.
   */
  contribReview?: DashboardContribReviewPort;
  /** One-shot bundle hand-off for contributor dev containers; absent = 404. */
  contribBundles?: DashboardBundlePort;
}

/**
 * HTTP listener and identity-gate configuration. There are deliberately no
 * service slots here: constructing a server without a complete service bundle
 * is a type error, rather than a request-time fallback to `new Service()`.
 */
export type DashboardOptions = Pick<
  DashboardCompositionOptions,
  | "port"
  | "host"
  | "authToken"
  | "surface"
  | "adminUsers"
  | "deployers"
  | "runnerWsPort"
  | "runnerBundle"
  | "runnerPublicUrl"
  | "publicHost"
  | "publicUrl"
  | "oauthGithub"
  | "registration"
  | "githubFetcher"
  | "sessionHubUi"
  | "devScanHome"
>;

/** The only transport callback service lifecycle wiring may retain. */
export interface DashboardTransportLifecycle {
  closeLive(owner: string, credential?: string): void;
}

/**
 * Consumer-owned structural ports. Each one is deliberately the exact method
 * set the Dashboard consumer calls; composition may supply the current classes or any
 * compatible implementation without exposing their construction surface.
 */
export type DashboardStorePort = Pick<
  Store,
  | "sessionShares"
  | "appCatalog"
  | "runnerArtifacts"
  | "devTickets"
  | "credits"
  | "mergeProposals"
  | "saveDashboardToken"
  | "saveMcpToken"
  | "getDashboardTokenByHash"
  | "getActiveMcpTokenByHash"
  | "getRunnerTokenByHash"
  | "saveRunnerEnrollment"
  | "consumeRunnerEnrollment"
  | "getRunnerGuestProfile"
  | "saveRunnerGuestProfile"
  | "touchDashboardToken"
  | "touchMcpToken"
  | "getUser"
  | "loadUsers"
  | "getSetting"
  | "setSetting"
  | "listUserGrants"
  | "listAllUserGrants"
  | "grantCapability"
  | "revokeCapability"
  | "listAllRunnerTokens"
  | "listRunnerTokens"
  | "getRunnerDevicePolicy"
  | "setRunnerLocalAgentBridgeMode"
  | "setRunnerDefaultAgentInjection"
  | "listUserActivity"
  | "listWebSessions"
  | "revokeWebSession"
  | "revokeAllWebSessions"
  | "getIdentitiesByUser"
  | "resolveIdentity"
  | "hasDashboardToken"
  | "listMcpTokens"
  | "revokeMcpToken"
  | "researchCanvas"
  | "listSharedAppInstancesFor"
  | "listSharedAppInstancesPageFor"
  | "getSharedAppInstance"
  | "createSharedAppInstance"
  | "recordPermissionAudit"
  | "closeSharedAppInstance"
  | "listSharedAppMembers"
  | "getSharedAppMember"
  | "addSharedAppMember"
  | "setSharedAppMember"
  | "removeSharedAppMember"
  | "isSharedAppMemberRemoved"
>;

export type DashboardRunnerPort = Pick<
  RunnerCapabilities,
  "open" | "listDevices" | "mintDeviceToken" | "revokeDeviceToken" | "isOnline" | "ping" | "listPending" | "reject" | "approve" | "setDefaultAgentInjection" | "setGuiAutomationEnabled"
>;

/** The process-wide approval desk is independent of whether a Runner exists. */
export type DashboardApprovalPort = Pick<CapabilityService, "listPending" | "reject" | "approve">;
export type DashboardFableTicketApprovalPort = Pick<FableTicketApprovalService, "request">;

export type DashboardWebSessionPort = Pick<WebSessionManager, "resolve" | "csrfOk" | "issue" | "revoke">;
export type DashboardOauthStatePort = Pick<StateStore, "issue" | "consume">;
export type DashboardPendingRegistrationPort = Pick<PendingRegistrationStore, "issue" | "peek" | "consume">;
export type DashboardPermissionPort = Pick<
  PermissionService,
  | "subjects"
  | "declaredOperations"
  | "sessionHubEffective"
  | "sessionPlusEffective"
  | "effectiveFor"
  | "get"
  | "subject"
  | "activity"
  | "audit"
  | "grant"
  | "revoke"
>;
export type DashboardPermissionStudioPort = Pick<PermissionStudioService, "projection" | "explain" | "apply">;
export type DashboardTentaclePort = Pick<
  TentacleService,
  "catalog" | "shares" | "share" | "revoke" | "credentialRevoked"
>;
export type DashboardAppTrustPort = Pick<AppTrustService, "status" | "trust" | "revoke">;
export type DashboardSessionHubPort = Pick<
  SessionHubService,
  "roster" | "decodeResourceId" | "read" | "search" | "respondInteraction" | "liveGrant" | "releasePendingLease"
>;
export type DashboardOperationPort = Pick<
  SessionOperationCoordinator,
  "list" | "submit" | "subscribe" | "approveAsOperation" | "rejectAsOperation"
>;
export type DashboardMcpPort = Pick<McpSurface, "listTools" | "callTool" | "releaseCredential">;
export type DashboardUserPort = Pick<UserManager, "resolve" | "addIdentity" | "removeIdentity" | "register">;
export type DashboardFeishuOauthPort = Pick<FeishuOAuthPortal, "status" | "start" | "notice">;
export type DashboardSessionPlusAppPort = Pick<
  SessionPlusAppService,
  "open" | "dispatch" | "closeInstance" | "subscribe" | "releaseOwner" | "resetResourceGeneration" | "sharing" | "shareOptions" | "createShare" | "agentActivity" | "stopAgentActivity"
>;
/** The transport only tests whether this composed capability plane exists. */
export type DashboardWorkspaceFilesPort = object;
export type DashboardAppReleasePort = Pick<AppReleaseHost, "app" | "unknownApp" | "describe" | "install" | "viewAssetFor">;
export type DashboardDevPipelinePort = Pick<
  DevPipeline,
  | "resolveToolToken"
  | "toolCiSync"
  | "toolCiJob"
  | "toolSubmit"
  | "toolStatus"
  | "toolContext"
  | "toolConflictRead"
  | "toolConflictResolve"
  | "toolAppRelease"
  | "toolAppHotswap"
  | "toolRename"
  | "toolAsk"
  | "lockWaiterIds"
  | "specConcurrency"
  | "baseBranch"
  | "mergeLockHolder"
  | "createTicket"
  | "postMessage"
  | "nativeTicketInput"
  | "approveSpec"
  | "requeue"
  | "setKind"
  | "cancel"
  | "completeTicket"
  | "readTicketExecution"
  | "dismissQuestion"
  | "interruptTurn"
  | "resumeTurn"
  | "markDeploy"
  | "land"
  | "codexHomeForTicket"
  | "codexLabelForTicket"
  | "openRemoteTicketTranscript"
  | "usesRunnerTickets"
  | "ticketExecutionChoices"
  | "ticketQuotaHosts"
  | "readTicketFiles"
> & Partial<Pick<DevPipeline, "appReleaseDrainState" | "ticketResourceWait">>;
export type DashboardContribReviewPort = Pick<ContribReviewService, "queue" | "decide" | "runBatch">;
export type DashboardBundlePort = Pick<BundleHandoff, "take">;
export type DashboardArchitecturePort = Pick<
  ArchitectureService,
  "view" | "status" | "refresh" | "commits" | "snapshots" | "evolutionDiff"
>;
export type DashboardKnowledgePort = Pick<
  KnowledgeWikiService,
  | "overview"
  | "artifactHealth"
  | "sources"
  | "confirmSource"
  | "repairs"
  | "repair"
  | "relationGraph"
  | "capability"
  | "module"
  | "node"
  | "search"
  | "preview"
  | "review"
  | "decide"
  | "conflictWorkspace"
  | "chatContext"
  | "annotate"
  | "investigate"
  | "retrievals"
  | "retrievalTickets"
  | "retrievalTrace"
>;
export type DashboardKnowledgeChatPort = Pick<
  KnowledgeChatService,
  "enabled" | "model" | "list" | "history" | "create" | "send"
>;
export type DashboardDeployPort = Pick<
  import("../devpipe/deploy.js").DeployService,
  "deployerList" | "baseBranch" | "stableBranch" | "trigger" | "decide" | "resolveVerify" | "ingressStatus" | "runningSha" | "preparationStatus" | "checkUpdates" | "releaseCatalogStatus"
>;
export type DashboardFeishuDirectoryPort = Pick<
  import("../channel/feishu-directory.js").FeishuDirectory,
  "invalidate" | "get" | "lookup"
>;
export type DashboardQuotaPort = Pick<QuotaProbe, "snapshot">;
export type DashboardCodexQuotaPort = Pick<CodexQuotaProbe, "snapshot">;
export type DashboardSystemStatusPort = Pick<SystemStatusProbe, "snapshot">;

/**
 * Already-constructed ports consumed by the HTTP server. Every key is
 * required; a feature that this composition does not provide is represented
 * explicitly by `null`, never by an omitted slot that the server might fill.
 */
export interface DashboardServices {
  discussions?: DiscussionCapabilities;
  store: DashboardStorePort;
  caps: DashboardRunnerPort | null;
  approvals: DashboardApprovalPort;
  sessions: DashboardWebSessionPort;
  oauthStates: DashboardOauthStatePort;
  pendingRegistrations: DashboardPendingRegistrationPort;
  permissions: DashboardPermissionPort;
  permissionStudio: DashboardPermissionStudioPort;
  tentacle: DashboardTentaclePort | null;
  appTrust: DashboardAppTrustPort;
  hub: DashboardSessionHubPort;
  operations: DashboardOperationPort;
  mcp: DashboardMcpPort;
  userManager: DashboardUserPort | null;
  feishuOAuth: DashboardFeishuOauthPort | null;
  feishuDocsAddon: FeishuDocsAddonService | null;
  sessionPlusEnabled: boolean;
  sessionPlusSettings(): SessionPlusSettings | null;
  sessionPlusApp: DashboardSessionPlusAppPort | null;
  sessionPlusRelease: SessionPlusReleaseSource | null;
  workspaceFiles: DashboardWorkspaceFilesPort | null;
  appReleases: DashboardAppReleasePort | null;
  declaredApps: DeclaredAppDirectory | null;
  /** `external-app-host/v1`; null unless `external_app_hosts` names a host. */
  externalAppHost: ExternalAppHostService | null;
  devPipeline: DashboardDevPipelinePort | null;
  fableTicketApprovals: DashboardFableTicketApprovalPort | null;
  architecture: DashboardArchitecturePort | null;
  knowledge: DashboardKnowledgePort | null;
  knowledgeChat: DashboardKnowledgeChatPort | null;
  deployService: DashboardDeployPort | null;
  feishuDirectory: DashboardFeishuDirectoryPort | null;
  registerUser: DashboardCompositionOptions["registerUser"] | null;
  declareApp: DashboardCompositionOptions["declareApp"] | null;
  publishPendingAppReleases: DashboardCompositionOptions["publishPendingAppReleases"] | null;
  appHotswapApprovals: DashboardCompositionOptions["appHotswapApprovals"] | null;
  contribReview: DashboardContribReviewPort | null;
  contribBundles: DashboardBundlePort | null;
  quotaProbe(): DashboardQuotaPort;
  codexQuotaProbe(): DashboardCodexQuotaPort;
  systemStatusProbe(): DashboardSystemStatusPort;
  endCredential(owner: string, credential: string): void;
  endOwner(owner: string): void;
}

/** Service/config view retained by the already-split route modules. */
export type DashboardRouteOptions = DashboardOptions & Pick<
  DashboardServices,
  | "userManager"
  | "feishuOAuth"
  | "sessionPlusApp"
  | "sessionPlusRelease"
  | "workspaceFiles"
  | "appReleases"
  | "declaredApps"
  | "devPipeline"
  | "fableTicketApprovals"
  | "architecture"
  | "knowledge"
  | "knowledgeChat"
  | "deployService"
  | "feishuDirectory"
  | "registerUser"
  | "declareApp"
  | "publishPendingAppReleases"
  | "appHotswapApprovals"
  | "contribReview"
  | "contribBundles"
>;
