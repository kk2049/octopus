import { appPageScriptCsp } from "./app-page.js";
/**
 * Web dashboard — one port for operating the control plane:
 *   · "/"          ops view: users, runner endpoints, health checks,
 *                  onboarding tutorial, token minting
 *   · "/sessions-plus"  sole browser session/workspace surface
 *
 * Auth is two-tier:
 *   · admin — the config `dashboard.auth_token` (full view, every user);
 *   · user  — a personal `dt_` key (minted via /dashboard in Feishu or by an
 *     admin), scoped to that user's own data.
 * Either token logs in at /login?token=… which stores it in an HttpOnly
 * SameSite=Lax cookie — after that the browser is "a device with the key
 * installed": no token in URLs, auto-scoped to what the key may see.
 * Bearer/query tokens keep working for scripts. Append is deliberately
 * OWNER-ONLY: even an admin cannot append to someone else's session, because
 * append executes on the target user's machine with their CLI credentials.
 */

import { type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hashRunnerToken } from "../runner/gateway.js";
import { GuestEnrollmentError, issueGuestEnrollment, redeemRunnerEnrollment } from "../runner/enrollment.js";
import { looksLikeBundleToken } from "../devpipe/bundle-handoff.js";
import type { RunnerGrant } from "../runner/capability.js";
import {
  type CookieContract,
  type CredentialChannel,
  allowedOrigins,
  clearCookie,
  clearSessionCookies,
  isLoopbackAddress,
  issueSessionCookies,
  mutationGate,
  originOk,
  readCookie,
  secretEquals,
  serializeCookie,
} from "@claude-bot/web-trust";
import {
  DEFAULT_CSP,
  type PanelApp,
  type PanelReply,
  type PanelRequest,
  bodyOf,
  buildPanelApp,
  panelHandler,
  panelUrl,
  replyBody,
  replyJson,
} from "./http.js";
import { PANEL_BODY_SCHEMAS } from "./schemas.js";
import {
  BOOTSTRAP_REDIRECTS,
  type PanelSurface,
  authorizeRoute,
  mayManageConnection,
  mayRead,
  mayWriteAs,
  routeIsAvailable,
  surfaceAllows,
} from "./authz.js";
import {
  PANEL_FEATURE,
  type EnabledPanelFeatures,
  type PanelFeature,
} from "./features.js";
import { resolveCapabilityBits } from "../permissions/capability-bits.js";
import {
  COOKIE_BASE,
  CSRF_HEADER,
  dashboardCookies,
  type ResolvedSession,
} from "./web-session.js";
import { renderAppPage } from "./app-page.js";
import { bundleManifest, readAsset } from "./assets.js";
import { approvalsAvailable, navTabs, servedPages } from "./navigation.js";
import { unixInstallerScript, windowsInstallerScript } from "./runner-commands.js";
import {
  type DashboardBootstrap,
  type DashboardPageProps,
} from "@claude-bot/dashboard-web/contract";
import { storedDashboardTheme } from "./theme-preference.js";
import { cookieSecure, csrfCookieCandidates } from "@claude-bot/web-trust";
import { BOT_HOST_DEVICE as HUB_BOT_HOST_DEVICE } from "../sessionhub/service.js";
import type { PackageAsset } from "../app-core/view-app.js";
import type { AppReleaseDescriptor } from "@claude-bot/app-registry";
import type { SessionPlusSettings } from "../app-core/settings.js";
import { decodeMcpTokenPolicy, mcpCredentialOf, type McpTokenPolicy } from "../mcp/tokens.js";
import { LiveRegistry, decodeCursor } from "./live.js";
import { createLogger } from "../logger.js";
import { registerAdminRoutes, type AdminRoutesContext } from "./routes/admin.js";
import { feishuDocsAddonPreGate, handleFeishuDocsAddon, DOCS_ADDON_BODY_LIMIT, DOCS_ADDON_PATH } from "./routes/feishu-docs-addon.js";
import { DOC_KEY_PATH } from "../feishu/doc-share.js";
import { pageAppOpen, registerAppViewRoutes, type AppViewRoutesContext } from "./routes/app-view.js";
import {
  externalAppPreGate,
  handleExternalApp,
  registerAppExternalRoutes,
  type AppExternalRoutesContext,
} from "./routes/app-external.js";
import { registerAppReleaseRoutes, type AppReleaseRoutesContext } from "./routes/apps.js";
import { registerArchitectureRoutes, type ArchitectureRoutesContext } from "./routes/architecture.js";
import { registerKnowledgeRoutes, type KnowledgeRoutesContext } from "./routes/knowledge.js";
import { registerConnectionRoutes, type ConnectionRoutesContext } from "./routes/connections.js";
import type { AppPageOptions, GuardedHandler, GuardedRoutes } from "./routes/context.js";
import { registerMcpRoutes, type McpRoutesContext } from "./routes/mcp.js";
import { registerDiscussionRoutes } from './routes/discussions.js';
import { pageOverview, registerOverviewRoutes, type OverviewRoutesContext } from "./routes/overview.js";
import { registerPermissionRoutes, type PermissionRoutesContext } from "./routes/permissions.js";
import { registerTentacleRoutes, type TentacleRoutesContext } from "./routes/tentacle.js";
import {
  pageSessionsPlus,
  registerSessionPlusRoutes,
  type SessionPlusRoutesContext,
} from "./routes/session-plus.js";
import { registerSessionRoutes, type SessionRoutesContext } from "./routes/sessions.js";
import { clampInt, onRawResponseEnd, subjectOf, webCredential } from "./routes/shared.js";
import { handleDevpipeTool, registerTicketRoutes, type TicketRoutesContext } from "./routes/tickets.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchGithubUser,
  type GithubFetcher,
} from "./oauth-github.js";
import type {
  DashboardAppTrustPort,
  DashboardApprovalPort,
  DashboardDevPipelinePort,
  DashboardMcpPort,
  DashboardOptions,
  DashboardOperationPort,
  DashboardOauthStatePort,
  DashboardPendingRegistrationPort,
  DashboardPermissionPort,
  DashboardRouteOptions,
  DashboardRunnerPort,
  DashboardServices,
  DashboardSessionHubPort,
  DashboardStorePort,
  DashboardTentaclePort,
  DashboardTransportLifecycle,
  DashboardWebSessionPort,
} from "./ports.js";

export { PANEL_RESOURCE_CONTRACTS } from "./resource-contracts.js";
export type {
  DashboardCompositionOptions,
  DashboardOptions,
  DashboardRouteOptions,
  DashboardServices,
  DashboardTransportLifecycle,
  DeclaredAppDirectory,
  DeclaredAppSurface,
  SessionPlusReleaseSource,
} from "./ports.js";

// Split out with the 2026-08-11 domain split; the panel's public surface
// stays importable from this module.
export { subjectOf, viewerOf } from "./routes/shared.js";

/**
 * The one server view every domain route module's narrow context interface is
 * a subset of. Modules declare what they read; this intersection is what the
 * server actually provides.
 */
type DashboardRouteContext = AdminRoutesContext &
  AppExternalRoutesContext &
  AppReleaseRoutesContext &
  AppViewRoutesContext &
  ArchitectureRoutesContext &
  KnowledgeRoutesContext &
  ConnectionRoutesContext &
  McpRoutesContext &
  OverviewRoutesContext &
  PermissionRoutesContext &
  TentacleRoutesContext &
  SessionPlusRoutesContext &
  SessionRoutesContext &
  TicketRoutesContext;

const log = createLogger("dashboard");
const GITHUB_STATE_COOKIE = "__Host-octopus_oauth";
const GITHUB_REGISTRATION_COOKIE = "__Host-octopus_registration";
const GITHUB_COOKIE_MAX_AGE_S = 600;


/**
 * Pseudo-device label for sessions scanned on the bot host itself. Re-exported
 * from the hub so there is one constant rather than two that agree today.
 */
export const BOT_HOST_DEVICE = HUB_BOT_HOST_DEVICE;

/** Personal web-login key; plaintext shown once, hash stored, one per user. */
export { mintDashboardToken } from "./dashboard-token.js";

export { CAPABILITIES, type Capability } from "./routes/admin.js";

/**
 * Who is asking, and what they may do (ticket #15).
 *
 * `username` absent = the shared `auth_token`, which has no account behind
 * it. That absence IS the rule that keeps it from writing authored content
 * (a report, a workbench event, a persona): there is nobody to sign as.
 *
 * `admin` is a capability layered ON an account, not a separate identity.
 * A named admin reads and acts across users (owner decision, 2026-10-15);
 * the shared key reads but authors nothing. Cross-user reads and writes are
 * still answered by two predicates (`canActFor` vs `canWriteAs`), and the
 * handlers record the acting admin in the target account's audit/log.
 */
export type DashboardIdentity = {
  guest?: boolean;
  sessionShare?: { id: string; owner: string };
  /**
   * A named administrator opening Sessions+ as another account (`?as=`,
   * 2026-10-15 owner decision). Resolved here, only for admins, only on the
   * Sessions+ page and its API; everyone else's `?as=` is ignored.
   */
  actingAs?: string;
  username?: string;
  admin: boolean;
  /** May see the dev pipeline at all: tab, tickets, conversations, quota. */
  dev: boolean;
  /** May trigger deploys, land branches and decide the rescue window. */
  deploy: boolean;
  /**
   * May file and follow their OWN tickets, landing through the review lane
   * (2026-08-20). `dev` implies it at resolution (capability-bits.ts). Absent
   * reads as false — the one value that fails closed — so older identity
   * fixtures stay valid without saying it.
   */
  contribute?: boolean;
  /**
   * True when the credential is an `mcp_` token. Such an identity reaches
   * exactly one route (`api.mcp.rpc`) and nothing else — the gate refuses the
   * rest, and `/login` refuses to exchange it for a browser session. The
   * restriction is a property of the CREDENTIAL, deliberately not expressed in
   * Cedar: the account behind it is an ordinary account, and widening what the
   * token reaches must be an explicit edit here, not a new route that quietly
   * accepts every named principal.
   */
  mcpOnly?: boolean;
  /** Immutable credential-local attenuation, intersected after live grants. */
  mcpPolicy?: McpTokenPolicy;
  /**
   * True only when this request arrived on a server-side browser session
   * (cookie + live row), not on a raw bearer. Approving a dangerous Runner
   * call requires it: a bearer proves "a credential exists somewhere", a
   * session is the closest a web app gets to "a person is on this device".
   */
  session?: ResolvedSession;
  /**
   * How the credential arrived, which decides whether it is AMBIENT — sent by
   * the browser on any request to this origin, including one a hostile page
   * triggered. `cookie` is ambient (a session, or the no-token loopback mode
   * where there is nothing to attach); `bearer` is not, because a cross-site
   * page cannot set an Authorization header. The mutation gate reads exactly
   * this field, and there are only these two because that is all a CSRF plugin
   * models — the extra channels we used to have were our own complexity.
   */
  via: CredentialChannel;
  /**
   * A one-way handle for the specific CREDENTIAL this request arrived on: one
   * browser login, or one device token. Never rendered, never returned, never
   * compared against anything a caller sends.
   *
   * It exists so that short-lived authority can be scoped to the thing that can
   * be taken away. Contexts, their undecided approval cards, live streams and
   * append leases are all keyed by it, so "结束这处登录" closes exactly what that
   * login opened — and leaves the account's other logins running. Before it,
   * every login of one account shared a Context pool, and ending one was a row
   * update that stopped nothing already in flight.
   */
  credential: string;
};

/**
 * What someone may do, before the question of how they arrived. Separate from
 * `DashboardIdentity` so that `via` cannot be defaulted: a caller that builds
 * an identity has to say which channel it came in on, and there is no value
 * that silently means "not ambient".
 */
export type Capabilities = Omit<DashboardIdentity, "via" | "session" | "credential">;

/**
 * The shared config key: full view, no account, therefore no authorship.
 * `credential: "open"` because this identity only exists in the no-token
 * loopback mode, where there is no credential to scope anything to — and no
 * account either, so it derives nothing that would need scoping.
 */
export const ADMIN_KEY_IDENTITY: DashboardIdentity = {
  admin: true,
  dev: true,
  deploy: true,
  contribute: true,
  via: "cookie",
  credential: "open",
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export { isLoopbackAddress };

/**
 * Where to listen (ticket #15). With no `auth_token` there is no way to tell
 * anyone apart, so every request is admin — the old default of binding
 * 0.0.0.0 in that state published a full-access panel to whatever the box is
 * reachable on. Unauthenticated therefore means loopback, full stop.
 *
 * This does not break the documented TLS setup: the reverse proxy runs on
 * this host and dials 127.0.0.1 anyway. Reason is returned (not logged here)
 * so the caller can log it once at startup.
 */
export function resolveBindHost(
  host: string | undefined,
  authToken: string | undefined,
): { host: string; forced?: string } {
  if (authToken) return { host: host ?? "0.0.0.0" };
  if (host && !LOOPBACK.has(host)) {
    return {
      host: "127.0.0.1",
      forced: `dashboard.auth_token 未配置,已忽略 host=${host} 并强制绑定 127.0.0.1:未鉴权的面板一律不对外`,
    };
  }
  return {
    host: host ?? "127.0.0.1",
    forced: host ? undefined : "dashboard.auth_token 未配置,已绑定 127.0.0.1(未鉴权面板不对外)",
  };
}

/**
 * Fold config admin-ness, live grants and the legacy `selfhosting.deployers`
 * list into one identity. Pure so the precedence is unit-testable.
 *
 * `deployers` is honoured as an additional grant source for continuity, but
 * its old "empty list = everyone may deploy" rule is gone: before #15 that
 * fail-open default let any personal key fast-forward the base branch.
 */
export function resolveCapabilities(o: {
  username: string;
  admins?: readonly string[];
  granted?: readonly string[];
  deployers?: readonly string[];
}): Capabilities {
  return { username: o.username, ...resolveCapabilityBits(o) };
}

export { defaultTicketTitle, resolveTicketRequester } from "./routes/tickets.js";


export interface DeviceCheck {
  username: string;
  device: string;
  online: boolean;
  rtt_ms?: number;
  sessions_visible?: number;
  error?: string;
}

export class DashboardServer {
  private app: PanelApp | null = null;
  private boundPort = 0;
  private live = new LiveRegistry();

  private store: DashboardStorePort;
  private caps: DashboardRunnerPort | undefined;
  private approvals: DashboardApprovalPort;
  private sessions: DashboardWebSessionPort;
  private oauthStates: DashboardOauthStatePort;
  private pendingRegistrations: DashboardPendingRegistrationPort;
  /** Salts non-authoritative connection handles exposed to this process's UI. */
  private connectionHandleSalt = randomUUID();
  /**
   * The names this deployment issues and accepts, decided once from the same
   * configuration that decides `Secure`. Read at every cookie site so the
   * `__Host-` contract cannot hold at one of them and not another.
   */
  private cookies: CookieContract;
  /**
   * The identity the `onRequest` gate resolved, for the handler that follows it.
   *
   * Weak, and never a request decoration a route could set: a handler reads what
   * the gate decided or it does not run at all.
   */
  private identities = new WeakMap<PanelRequest, DashboardIdentity>();
  /** Every (method, url) Fastify actually serves, recorded as it builds them. */
  private routeTable: Array<{ method: string; url: string; routeId: string }> = [];

  /** Durable authorisation intent + the activity record. */
  readonly permissions: DashboardPermissionPort;
  /** Cross-user dsh sharing exists only when the runner composition supplied it. */
  readonly tentacle: DashboardTentaclePort | null;
  /** Publisher-code trust is intentionally separate from capability grants. */
  readonly appTrust: DashboardAppTrustPort;
  /**
   * The session surface, extracted out of this file. The routes below are now
   * transport: parse, authenticate, call, serialise. Every decision about
   * whose sessions, which operations and what may be written lives in the
   * service, so a future v3 shell reaches the same answers without copying
   * anything out of an HTTP handler.
   */
  readonly hub: DashboardSessionHubPort;
  /**
   * The durable lifecycle of one chat submission. Sits above the hub because
   * "what happened to the thing I sent" outlives the request that sent it, the
   * tab that was open, and this process.
   */
  readonly operations: DashboardOperationPort;
  /** The trusted body behind `POST /api/mcp`. Always constructed; tool groups follow the composition. */
  readonly mcp: DashboardMcpPort;
  /**
   * Open SSE streams and what they were authorised by, so a revocation can
   * close exactly what it opened: `(owner)` for a grant or a device, and
   * `(owner, credential)` for one browser login.
   */
  private liveStreams = new Map<ServerResponse, { owner: string; credential: string }>();
  /** Every SSE response, including shared dev-ticket streams, for fast drain. */
  private eventStreams = new Set<ServerResponse>();
  /** Session Plus checkout-release memoisation, owned per server. */
  private sessionPlusCheckoutCache: {
    value?: { descriptor: AppReleaseDescriptor; assets: readonly PackageAsset[] } | null;
  } = {};

  constructor(
    private opts: DashboardOptions,
    private services: DashboardServices,
  ) {
    this.store = services.store;
    this.caps = services.caps ?? undefined;
    this.approvals = services.approvals;
    this.sessions = services.sessions;
    this.oauthStates = services.oauthStates;
    this.pendingRegistrations = services.pendingRegistrations;
    this.permissions = services.permissions;
    this.tentacle = services.tentacle;
    this.appTrust = services.appTrust;
    this.hub = services.hub;
    this.operations = services.operations;
    this.mcp = services.mcp;
    this.cookies = dashboardCookies(opts.publicUrl);
  }

  /**
   * The composition root binds service revocation to this transport-only sink
   * after both sides exist. No service is constructed or closed through it.
   */
  readonly transportLifecycle: DashboardTransportLifecycle = {
    closeLive: (owner, credential) => this.closeLive(owner, credential),
  };

  /**
   * The Session Plus settings for whichever release is active RIGHT NOW.
   *
   * A function rather than a stored object because a release activation changes
   * the answer without restarting the process: the origin, the package digest
   * and the identity all move together. Tests that serve one fixed release still
   * pass a plain object, and get exactly the old behaviour.
   *
   * `null` while the App has no usable release — deactivated, or an activation
   * this build refused. That is a state the panel must survive, because the page
   * an operator rolls back from is on it.
   */
  private sessionPlusSettings(): SessionPlusSettings | null {
    return this.services.sessionPlusSettings();
  }


  /**
   * End SSE streams belonging to one account — all of them, or only the ones a
   * particular login opened.
   *
   * Ending the stream matters on top of killing its Context. "The next poll
   * denies" is true but slow: a 4s interval leaves the browser holding a dead
   * stream, and a page that still looks connected is a page that looks
   * authorised.
   */
  private closeLive(owner: string, credential?: string): void {
    for (const [res, meta] of this.liveStreams) {
      // An administrator's Sessions+ streams opened as another account carry
      // `<their credential>:as:<account>`; ending their login ends those too.
      const actedAs = credential !== undefined && meta.credential.startsWith(`${credential}:as:`);
      if (meta.owner !== owner && !actedAs) continue;
      if (credential !== undefined && meta.credential !== credential && !actedAs) continue;
      this.liveStreams.delete(res);
      // Releasing the session hub can synchronously end its tailer before the
      // transport lifecycle reaches this registry. Writing to that response
      // does not throw here: Node emits ERR_STREAM_WRITE_AFTER_END on a later
      // tick, outside this try/catch, and an unhandled response error would
      // terminate the whole service. The stream is already closed, so only
      // live responses need the in-band revocation notice.
      if (res.writableEnded || res.destroyed) continue;
      try {
        res.write(`event: err\ndata: ${JSON.stringify({ error: "权限已变更,实时流已断开" })}\n\n`);
        res.end();
      } catch {
        /* a stream that is already gone needs no closing */
      }
    }
  }

  /**
   * One browser login (or device token) is over: close everything it opened.
   *
   * Order is the security content, and it is the same order `revoke()` uses.
   * The caller has ALREADY marked the row, so no new request can authenticate
   * on this credential by the time we get here; what is left is to close the
   * things that are already running. A teardown that throws therefore cannot
   * resurrect the credential.
   *
   * `hub.releaseCredential` drops the Contexts derived on that credential —
   * which takes their undecided approval cards with them, so a replayed
   * approval from the ended login reaches no adapter — and its append leases.
   */
  private endCredential(owner: string, credential: string): void {
    this.services.endCredential(owner, credential);
  }

  /**
   * The same, for everything the account derived on any login — a device
   * revocation, where the account root itself is gone.
   */
  private endOwner(owner: string): void {
    this.services.endOwner(owner);
  }

  get port(): number {
    return this.boundPort;
  }

  /**
   * Which composition this panel serves. Read in exactly three places — the
   * pre-route gate, `authorizeRoute`, and the page renderers that pass it to
   * the shell — so there is no fourth interpretation of what bootstrap means.
   */
  get surface(): PanelSurface {
    return this.opts.surface ?? "full";
  }

  /** Which response contract the legacy Session Hub submit API serves. */
  get sessionHubUi(): "legacy" | "unified-v3" {
    return this.opts.sessionHubUi ?? "legacy";
  }

  /**
   * The build id of the bundle this process serves, or "" when there is none.
   *
   * Read lazily and never allowed to throw: a composition with no frontend
   * build must still answer its API routes, and the loud failure belongs on the
   * request for a PAGE, where `appPage` produces it.
   */
  private get buildId(): string {
    try {
      return bundleManifest().buildId;
    } catch {
      return "";
    }
  }

  /** Constructed optional subsystems; authorization is still a later gate. */
  private get configuredFeatures(): EnabledPanelFeatures {
    const enabled: PanelFeature[] = [];
    if (this.services.devPipeline) enabled.push(PANEL_FEATURE.devPipeline);
    if (this.services.sessionPlusEnabled) enabled.push(PANEL_FEATURE.sessionPlus);
    if (this.services.appReleases) enabled.push(PANEL_FEATURE.appRegistry);
    if (this.services.declaredApps?.get("research-program")) enabled.push(PANEL_FEATURE.researchProgram);
    if (this.services.declaredApps?.get('research-v2')) enabled.push(PANEL_FEATURE.researchCanvas);
    if (this.services.architecture) enabled.push(PANEL_FEATURE.architecture);
    if (this.services.knowledge) enabled.push(PANEL_FEATURE.knowledge);
    return enabled;
  }

  /**
   * One stable page-to-Shell handoff.
   *
   * Configuration decides whether a route exists. Viewer capabilities decide
   * whether a configured navigation affordance is useful to this person. The
   * route still goes through Cedar; hiding a tab is never authorization.
   */
  /**
   * The trusted context every page document carries.
   *
   * It is IDENTITY CONTEXT, not authorization: `nav` and `pages` are the same
   * `routeIsAvailable` answer the router gives, delivered as data so navigation
   * cannot advertise a page this composition would 404. Every request the app
   * then makes is authorised from scratch. Nothing here is a credential — the
   * CSRF cookie NAMES are a deployment fact the browser reads out of its own
   * jar, and the session lives in an HttpOnly cookie this payload never sees.
   */
  private bootstrapFor(
    identity: DashboardIdentity | null,
    page: string,
    pageProps: DashboardPageProps,
  ): DashboardBootstrap {
    const nav = identity?.guest ? [] : navTabs(identity, this.surface, this.configuredFeatures);
    return {
      buildId: bundleManifest().buildId,
      surface: this.surface,
      features: [...(this.configuredFeatures ?? [])],
      viewer: {
        username: identity?.username ?? null,
        admin: Boolean(identity?.admin),
        dev: Boolean(identity?.dev),
        deploy: Boolean(identity?.deploy),
        contribute: Boolean(identity?.contribute),
        session: Boolean(identity?.session),
      },
      nav: nav.map((tab) => ({ id: tab.id, path: tab.path, label: tab.label })),
      pages: servedPages(identity, this.surface, this.configuredFeatures),
      redirects: Object.fromEntries(
        this.surface === "bootstrap-v3" ? [...BOOTSTRAP_REDIRECTS.entries()] : [],
      ),
      approvals: !identity?.guest && approvalsAvailable(identity, this.surface),
      csrfCookieNames: [...csrfCookieCandidates(COOKIE_BASE, cookieSecure(this.opts.publicUrl))],
      themePreference: storedDashboardTheme(this.store, identity?.username),
      page,
      pageProps,
    };
  }

  /**
   * Serve one page document.
   *
   * The CSP is the strict one this architecture makes possible: `script-src
   * 'self'` with NO nonce for executable code and no `unsafe-inline`, because
   * the document ships no executable inline script at all — only a module from
   * `/ui/` and JSON data blocks, which browsers do not execute.
   *
   * `extraCsp` is for the one page that legitimately needs a directive the
   * deny-all baseline withholds — `/sessions-plus` and its exact `frame-src`.
   * It is a parameter rather than a widened `DEFAULT_CSP` so the extra
   * permission belongs to one page instead of to every page.
   */
  private appPage(res: PanelReply, status: number, options: AppPageOptions): void {
    let body: string;
    try {
      body = renderAppPage({
        title: options.title,
        bootstrap: this.bootstrapFor(options.identity, options.page, options.props ?? {}),
        appInstance: options.appInstance,
      });
    } catch (err) {
      // A missing bundle is an operator error, and it must read as one rather
      // than as a blank page: the panel cannot be served without its assets.
      log.error({ err }, "Dashboard bundle is not built");
      this.send(res, 500, "text/plain; charset=utf-8", "面板前端尚未构建，请在 bot 主机执行 `pnpm -r build`。", {
        "cache-control": "no-store",
      });
      return;
    }
    this.send(res, status, "text/html; charset=utf-8", body, {
      // Overrides the deny-all baseline `@fastify/helmet` put on every reply.
      // `script-src 'self'` with no nonce, because the document ships no
      // executable inline script at all.
      "content-security-policy": [DEFAULT_CSP, appPageScriptCsp(), "worker-src 'self' blob:", ...(options.extraCsp ?? [])].join("; "),
      "cache-control": "no-store",
    });
  }

  private bindHost(): string {
    const { host, forced } = resolveBindHost(this.opts.host, this.opts.authToken);
    if (forced) log.error({ configured: this.opts.host }, forced);
    return host;
  }

  async start(): Promise<void> {
    if (this.services.sessionPlusEnabled && !this.services.sessionPlusApp) {
      throw new Error("Session Plus settings require a constructed App coordinator");
    }
    if (this.opts.oauthGithub && !this.githubOAuthEnabled()) {
      log.info(
        "GitHub OAuth disabled: dashboard.public_url must be https and the user manager must be composed",
      );
    }
    const app = buildPanelApp({
      buildId: () => this.buildId,
      onInternalError: (err) => log.error({ err }, "Dashboard request failed"),
    });
    // Record the table as Fastify builds it, so "what does this panel serve?"
    // has an answer that cannot disagree with what it actually serves — and so a
    // test can walk it against the authorization table.
    this.routeTable = [];
    app.addHook("onRoute", (route) => {
      const routeId = (route.config as { routeId?: string } | undefined)?.routeId ?? "";
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        this.routeTable.push({ method, url: route.url, routeId });
      }
    });
    this.registerRoutes(app);
    await app.ready();
    this.app = app;
    await app.listen({ port: this.opts.port, host: this.bindHost() });
    const addr = app.server.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : this.opts.port;
    log.info({ port: this.boundPort }, "Dashboard listening");
  }

  async stop(): Promise<void> {
    // Closing waits for long-lived SSE sockets. End them first even when their
    // TailSource is still blocked in an initial Runner RPC; in that state
    // LiveRegistry does not yet own a SessionTailer it can destroy.
    for (const res of this.eventStreams) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    this.eventStreams.clear();
    this.live.destroyAll();
    await this.app?.close();
    this.app = null;
  }

  /**
   * Every (method, path) this panel answers, as the router itself holds it.
   *
   * Diagnostics, and the thing a test walks to prove the two tables have not
   * drifted: every registered route declares the `authz.ts` rule it is served
   * under, and every rule in that table has a route. Before Fastify the panel
   * had a route TABLE and a separate if-chain, and a mismatch was silent in both
   * directions — a rule nobody dispatched read as served, and a branch no rule
   * covered was unreachable code that read as live. That is P1-4's shape.
   */
  get routes(): ReadonlyArray<{ method: string; url: string; routeId: string }> {
    return this.routeTable;
  }

  // ── Identity ──

  /**
   * Map one presented credential to what it may do. Returns capabilities, not
   * an identity: the caller knows which channel it read the credential from
   * and is the one that may say so.
   */
  private identityForToken(presented: string): Capabilities | null {
    if (!presented) return null;
    const want = this.opts.authToken;
    if (want) {
      // Constant-time: sha256 both to a fixed length so neither the compare
      // nor the length reveals timing.
      const a = createHash("sha256").update(presented).digest();
      const b = createHash("sha256").update(want).digest();
      if (timingSafeEqual(a, b)) return { admin: true, dev: true, deploy: true, contribute: true };
    }
    if (presented.startsWith("dt_")) {
      const row = this.store.getDashboardTokenByHash(hashRunnerToken(presented));
      if (row) return this.capabilitiesFor(row.username);
    }
    if (presented.startsWith("mcp_")) {
      // Same storage discipline as dt_ (sha256, plaintext never stored), but a
      // NARROWER identity on purpose: no admin/dev/deploy bits even when the
      // account holds them, and `mcpOnly` pins it to the one route. An MCP
      // token pasted into an agent config must never be a full panel key.
      const now = new Date().toISOString();
      const row = this.store.getActiveMcpTokenByHash(hashRunnerToken(presented), now);
      if (row) {
        let policy: McpTokenPolicy | undefined;
        try {
          policy = decodeMcpTokenPolicy(row.policy_json);
        } catch (error) {
          // A malformed stored restriction must fail closed. Treating it as
          // absent would turn database corruption into authority expansion.
          log.error({ token: row.token_hash.slice(0, 16), err: error }, "invalid stored MCP token policy");
          return null;
        }
        this.store.touchMcpToken(row.token_hash, now);
        return {
          username: row.username,
          admin: false,
          dev: false,
          deploy: false,
          contribute: false,
          mcpOnly: true,
          ...(policy ? { mcpPolicy: policy } : {}),
        };
      }
    }
    return null;
  }

  /** Live lookup: a grant revoked at /admin takes effect on the next request. */
  private capabilitiesFor(username: string): Capabilities {
    return resolveCapabilities({
      username,
      admins: this.opts.adminUsers,
      granted: this.store.listUserGrants(username).map((g) => g.capability),
      deployers: this.opts.deployers ?? this.services.deployService?.deployerList,
    });
  }

  /**
   * An explicit `Authorization` header beats the cookie, so an admin can always
   * script against a browser-logged-in box. No admin token configured = open
   * mode: everyone is admin, matching the old behavior — but start() then
   * refuses to bind anywhere but loopback, so "open" can only ever mean "open to
   * this machine".
   */
  private identify(req: PanelRequest): DashboardIdentity | null {
    // Header only, for the same reason the v3 Host is: a long-lived login
    // credential in a query string is written into browser history, into the
    // Referer of the next request, and into every access log on the way. Ops
    // scripts already send `Authorization: Bearer`.
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const byHeader = this.identityForToken(bearer);
    if (byHeader) {
      // The mcp credential handle is derived from the STORED hash so that
      // revoking the row can compute exactly which pooled Contexts, leases and
      // scopes that one token opened — without the plaintext ever existing
      // anywhere but in the client's header.
      const credential = byHeader.mcpOnly ? mcpCredentialOf(hashRunnerToken(bearer)) : tokenCredential(bearer);
      return { ...byHeader, via: "bearer", credential };
    }
    // Browser path: an opaque server-side session, not a stored bearer. Exactly
    // one name is a credential here — `this.cookies.retired` is cleared on
    // sight and never read, because a still-accepted unprefixed name is the
    // sibling-domain bypass the `__Host-` prefix exists to close.
    const sid = readCookie(req.headers.cookie, this.cookies.names.session);
    const session = this.sessions.resolve(sid);
    if (session) {
      const guest = session.username.startsWith("share-guest:");
      const url = panelUrl(req);
      const headerShare = req.headers["x-session-share"];
      const shareId = typeof headerShare === "string" ? headerShare : url.searchParams.get("share");
      let sessionShare: DashboardIdentity["sessionShare"];
      const sessionsPlusPath = url.pathname === "/sessions-plus" || url.pathname.startsWith("/api/session-plus/");
      if (shareId && sessionsPlusPath) {
        try {
          const row = this.services.sessionPlusApp?.sharing?.access(shareId, session.username, false);
          if (row) sessionShare = { id: row.id, owner: row.owner };
        } catch { /* Gate refuses an unresolved selector below. */ }
      }
      const caps = guest ? null : this.capabilitiesFor(session.username);
      const headerAs = req.headers["x-session-as"];
      const asked = typeof headerAs === "string" ? headerAs : url.searchParams.get("as");
      const actingAs = asked && caps?.admin && sessionsPlusPath && !sessionShare
        && asked !== session.username && this.store.getUser(asked) ? asked : undefined;
      return {
        ...(caps ?? { username: session.username, admin: false, dev: false, deploy: false, contribute: false }),
        ...(guest ? { guest: true } : {}), ...(sessionShare ? { sessionShare } : {}), ...(actingAs ? { actingAs } : {}),
        session, via: "cookie", credential: webCredential(session.tokenHash),
      };
    }
    // A cookie holding a raw bearer, from before sessions existed, is NOT a
    // credential: the browser sees the login page and pastes its key once.
    // That is what every framework does when the session format changes, and
    // keeping it alive as a read-only third channel was the single thing that
    // made this gate inexpressible as a CSRF plugin's configuration.
    return this.opts.authToken ? null : ADMIN_KEY_IDENTITY;
  }

  /**
   * The origins a browser may POST from, decided once and then reused.
   *
   * From `public_url` when it is configured, and otherwise from the port we
   * actually bound to — which, with no `auth_token`, `resolveBindHost` has
   * already forced to loopback. Memoised because it cannot change while the
   * server is up.
   *
   * This is the shape `@fastify/cors` takes verbatim, and it is deliberately
   * NOT given to it: the panel has never sent an `Access-Control-Allow-Origin`,
   * so adding CORS would widen the surface rather than describe it. The list is
   * consumed by the mutation gate and by `/login` / `/logout`.
   */
  private originAllowlist: readonly string[] | null = null;

  private allowedOrigins(): readonly string[] {
    const cached = this.originAllowlist;
    if (cached) return cached;
    // `boundPort` is what the OS actually gave us — tests and dev runs ask for
    // port 0, and an allowlist built from 0 accepts nothing. Not memoised until
    // there is something worth remembering.
    const computed = allowedOrigins({ publicUrl: this.opts.publicUrl, loopbackPort: this.boundPort });
    if (this.boundPort > 0 || this.opts.publicUrl) this.originAllowlist = computed;
    return computed;
  }

  /**
   * The mutation gate, run once before route dispatch for every unsafe method.
   *
   * The RULE is shared with the v3 Host (`@claude-bot/web-trust`) — see there for
   * why it is one function rather than a call each route remembers, and for the
   * ambient-vs-presented distinction that decides what each channel needs. What
   * stays here is only the wiring: which of this surface's things count as the
   * session and how a refusal is worded.
   *
   * Returns true to proceed; otherwise it has already answered.
   */
  private mutationGate(req: PanelRequest, res: PanelReply, identity: DashboardIdentity): boolean {
    const verdict = mutationGate({
      method: req.method ?? "GET",
      via: identity.via,
      origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      allowed: this.allowedOrigins(),
      csrf: identity.session
        ? {
            presented: typeof req.headers[CSRF_HEADER] === "string" ? (req.headers[CSRF_HEADER] as string) : undefined,
            ok: (presented) => this.sessions.csrfOk(identity.session!, presented),
          }
        : undefined,
    });
    if (verdict.ok) return true;
    this.json(res, verdict.status, { error: verdict.message });
    return false;
  }

  /**
   * The extra rule for approving a dangerous call: it takes a real browser
   * session, i.e. the closest a web app gets to "a person is on this device".
   * A bearer proves only that a credential exists somewhere.
   *
   * CSRF and Origin are NOT re-checked here — `mutationGate` ran before
   * dispatch and is the single implementation of that rule.
   */
  private requireApprover(res: PanelReply, identity: DashboardIdentity): string | null {
    // The RULE lives in the policy (`Approve`: named + session + own queue) and
    // the gate applied it before dispatch. What is left here is reading the name
    // out — the guard below is a type narrowing and a belt, not a second
    // decision, and it must never disagree with the policy.
    if (!identity.session || !identity.username) {
      this.json(res, 403, { error: "批准只能在浏览器登录会话中完成(脚本用的 Bearer 令牌不算人在场)" });
      return null;
    }
    return identity.username;
  }

  /**
   * Derive a Runner Context for THIS viewer's own devices.
   *
   * Owner-only, deliberately: an admin reading somebody else's panel gets
   * null here and therefore sees only bot-host material. Cross-user Runner
   * access would need an explicit delegation the product does not have yet,
   * and "admin" is not that delegation
   * (entry chains: doc/tcb-reading-guide.md §3).
   *
   * `pool` is what makes this a SURFACE rather than a request (P1-3). A panel
   * route is driven by individual HTTP requests, but the kernel's mechanisms are
   * keyed on the Context because a Context is meant to be a lifecycle:
   *
   *  - `insertPendingUnique` dedupes on (context, slot, operation, argsHash), so
   *    with a Context per POST a double-clicked "续跑" queued TWO cards for one
   *    intent and approving both was two headless turns;
   *  - `maxPendingPerContext` counts undecided calls in the same Context, so it
   *    was always zero and nothing capped the cards;
   *  - and every request wrote three fsynced rows that were never collected.
   *
   * Pooling by (user, surface) restores all three. Two genuinely different
   * appends still get their own card, because the args differ.
   */
  private runnerGrantFor(
    identity: DashboardIdentity,
    username: string,
    rights: readonly string[],
    purpose: string,
    pool?: string,
  ): RunnerGrant | null {
    if (!this.caps) return null;
    if (!identity.username || identity.username !== username) return null;
    return this.caps.open({
      username,
      purpose,
      kind: "session",
      rights,
      pool,
      metadata: { surface: "dashboard" },
    });
  }

  /**
   * May READ this user's data. Delegates to the panel's one policy
   * (`dashboard/authz.ts`) — the rule itself is Cedar text, not an expression
   * repeated at each call site.
   *
   * These predicates survive as methods because some routes only learn their target
   * account after parsing a body, and the pre-dispatch gate cannot read one.
   */
  private canActFor(identity: DashboardIdentity, username: string): boolean {
    return mayRead(subjectOf(identity), username);
  }

  /**
   * May WRITE content signed as this user. Strictly owner-only — the admin
   * bit deliberately does NOT grant it, because a session append, a device
   * policy or a workbench event carries its author's name, and writing one for
   * someone else forges that signature. (Before #15 the shared key was blocked
   * by having no username at all; an admin ACCOUNT would have sailed past that
   * check, which is exactly the hole this closes.)
   */
  private canWriteAs(identity: DashboardIdentity, username: string): boolean {
    return mayWriteAs(subjectOf(identity), username);
  }

  /** May link or remove an external identity. Requires the owner's browser session. */
  private canManageConnection(identity: DashboardIdentity, username: string): boolean {
    return mayManageConnection(subjectOf(identity), username);
  }

  /**
   * Login cookies. The session id is HttpOnly (page JS must never be able to
   * read it); the CSRF secret deliberately is not, because the page has to
   * echo it back in a header — that pairing is what makes a cross-site POST
   * fail even though the cookie rides along.
   */
  private sessionCookies(sessionId: string, csrf: string, expiresAtMs: number): string[] {
    // `secure` comes from configuration, never from `x-forwarded-proto`: that
    // is a header the client sends. Trusting it means a plaintext request can
    // claim https and receive a Secure cookie the browser will then never send
    // back — and, more importantly, that the flag silently disappears whenever
    // a real proxy forgets to set it, leaving the session id to ride cleartext.
    //
    // The same boolean picked the NAME (`dashboardCookies`), which is what
    // keeps `__Host-` and `Secure` from ever being decided apart. Retired names
    // are cleared in the same response, so an upgrade leaves nothing behind for
    // a sibling host to aim at.
    const maxAge = Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000));
    return issueSessionCookies(this.cookies, { sessionId, csrf, maxAgeS: maxAge });
  }

  /** The login screen: the same bundle, told that it has no identity yet. */
  private loginPage(res: PanelReply, status: number, wasRejected: boolean, why?: string, next = ""): void {
    this.appPage(res, status, {
      title: "octopus · 登录",
      identity: null,
      page: "pre.login",
      props: {
        rejected: wasRejected,
        reason: wasRejected ? (why ?? "密钥无效或已被新签发的密钥顶替") : null,
        next,
        githubEnabled: this.githubOAuthEnabled(),
      },
    });
  }

  /** The username-selection page after GitHub has already verified identity. */
  private registrationPage(res: PanelReply, status: number, label: string, error: string | null): void {
    this.appPage(res, status, {
      title: "octopus · 注册",
      identity: null,
      page: "pre.register",
      props: { label, error },
    });
  }

  /** Render a connection refusal on the signed-in account surface when possible. */
  private connectionPage(
    res: PanelReply,
    status: number,
    identity: DashboardIdentity | null,
    message: string,
  ): void {
    if (!identity?.username || !identity.session) {
      this.loginPage(res, status, true, message);
      return;
    }
    this.appPage(res, status, {
      title: "octopus · 身份连接",
      identity,
      page: "page.permissions",
      props: {
        owner: identity.username,
        canEdit: true,
        connectionMessage: { kind: "err", text: message },
      },
    });
  }

  private githubOAuthEnabled(): boolean {
    const credentials = this.opts.oauthGithub;
    return Boolean(
      credentials?.clientId
      && credentials.clientSecret
      && this.services.userManager
      && cookieSecure(this.opts.publicUrl),
    );
  }

  private shortLivedCookie(name: string, value: string): string {
    return serializeCookie(name, value, {
      path: "/",
      sameSite: "Lax",
      maxAgeS: GITHUB_COOKIE_MAX_AGE_S,
      secure: true,
      httpOnly: true,
    });
  }

  private startGithubConnection(username: string): { authorizeUrl: string; stateCookie: string } | null {
    if (!this.githubOAuthEnabled()) return null;
    const state = this.oauthStates.issue({ mode: "connect", username });
    return {
      authorizeUrl: buildAuthorizeUrl({ clientId: this.opts.oauthGithub!.clientId, state }),
      stateCookie: this.shortLivedCookie(GITHUB_STATE_COOKIE, state),
    };
  }

  /** Opaque selector, not authority; process salt prevents numeric-id enumeration. */
  private connectionHandle(provider: string, externalId: string): string {
    return createHash("sha256")
      .update(this.connectionHandleSalt)
      .update("\0")
      .update(provider)
      .update("\0")
      .update(externalId)
      .digest("hex");
  }

  // ── Routing ──
  //
  // Fastify owns the table. Two encapsulated scopes carry the whole of "is this
  // route behind the gate?": a route registered inside `guarded` cannot skip the
  // identity/CSRF/Cedar chain, and a route registered inside `pre` is visibly
  // outside it — which is a structural answer, not one you get by reading an
  // if-chain to its end.
  //
  // Every route declares the `authz.ts` rule id it is served under. That id is
  // recorded in `routes` and walked by a test against the authorization table,
  // so the two cannot drift apart in either direction.

  private registerRoutes(app: PanelApp): void {
    /**
     * A path this panel does not serve.
     *
     * It still answers "who is asking" first, so an unauthenticated prober
     * cannot map the route table by status code, and an ambient credential still
     * passes the mutation gate exactly as it would on a route that does exist.
     * The body is the same `{error:"not found"}` the hand-written fall-through
     * produced — a wrong URL and a route that was never added must be
     * indistinguishable.
     */
    // A not-found handler still runs after body parsing. The root onRequest
    // hook recognizes Fastify's 404 context and answers here instead, before a
    // malformed or oversized body can reveal anything ahead of identity/CSRF.
    app.addHook("onRequest", this.notFoundGate);
    app.setNotFoundHandler(panelHandler((_req, reply) => {
      // Defensive fallback for reply.callNotFound(): a matched route has
      // already crossed its own scope gate, but does not re-enter onRequest.
      this.json(reply, 404, { error: "not found" });
    }));
    void app.register(async (scope) => this.registerPreRoutes(scope));
    void app.register(async (scope) => this.registerGuardedRoutes(scope));
  }

  /**
   * Unknown URLs have no route-local hook, so their information boundary lives
   * at the root. Fastify exposes `request.is404` from the router before
   * onRequest; answering here also prevents its parser from consuming a body.
   */
  private notFoundGate = (req: PanelRequest, reply: PanelReply, done: (err?: Error) => void): void => {
    if (!req.is404) {
      done();
      return;
    }
    const identity = this.identify(req);
    if (!identity) {
      this.refuseAnonymous(req, reply);
      return;
    }
    if (!this.mutationGate(req, reply, identity)) return;
    this.json(reply, 404, { error: "not found" });
  };

  /** Origin is a credential boundary, so it must run before body parsing. */
  private preOriginGate(req: PanelRequest, reply: PanelReply): boolean {
    if (originOk(typeof req.headers.origin === "string" ? req.headers.origin : undefined, this.allowedOrigins())) {
      return true;
    }
    this.json(reply, 403, { error: "Origin 校验失败" });
    return false;
  }

  /** Logout's ambient-cookie checks, performed while the body is still unread. */
  private preLogoutGate(req: PanelRequest, reply: PanelReply): boolean {
    if (!this.preOriginGate(req, reply)) return false;
    const sid = readCookie(req.headers.cookie, this.cookies.names.session);
    const live = this.sessions.resolve(sid);
    if (!live) return true;
    const presented = req.headers[CSRF_HEADER];
    if (this.sessions.csrfOk(live, typeof presented === "string" ? presented : undefined)) return true;
    this.json(reply, 403, { error: "CSRF 校验失败,请刷新页面后重试" });
    return false;
  }

  /**
   * The runner bundle is public bytes, but only to a panel or device identity.
   * A document share's token belongs to someone outside the account: it opens
   * one document and nothing else, this download included.
   */
  private preRunnerBundleGate(req: PanelRequest, reply: PanelReply): boolean {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const deviceOk = presented && Boolean(this.store.getRunnerTokenByHash(hashRunnerToken(presented)));
    const identity = this.identify(req);
    if ((identity && !identity.mcpPolicy?.feishuDocShare) || deviceOk) return true;
    this.json(reply, 401, { error: "unauthorized" });
    return false;
  }

  /** Machine lifecycle endpoints accept only the device credential itself. */
  private preRunnerSelfGate(req: PanelRequest, reply: PanelReply): boolean {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (presented && this.store.getRunnerTokenByHash(hashRunnerToken(presented))) return true;
    this.json(reply, 401, { error: "unauthorized" });
    return false;
  }

  /**
   * Resolve the short-lived devpipe authority. Called once before parsing and
   * again immediately before execution: the latter is intentional freshness,
   * not a second policy, because a turn token can die while a body arrives.
   */
  private preDevpipeGate(req: PanelRequest, reply: PanelReply): DashboardDevPipelinePort | null {
    const from = req.raw.socket.remoteAddress ?? "";
    if (!isLoopbackAddress(from)) {
      log.warn({ from }, "devpipe tool call from a non-loopback address, refused");
      this.json(reply, 403, { message: "devpipe 工具接口只接受本机回环调用" });
      return null;
    }
    const pipe = this.services.devPipeline;
    if (!pipe) {
      this.json(reply, 503, { error: "self-hosting pipeline disabled", message: "self-hosting pipeline disabled" });
      return null;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !pipe.resolveToolToken(token)) {
      this.json(reply, 401, { message: "token 无效或轮次已结束。" });
      return null;
    }
    return pipe;
  }

  /** Security checks for the deliberately pre-identity route scope. */
  private preRouteGate(id: string, req: PanelRequest, reply: PanelReply): boolean {
    switch (id) {
      case "pre.feishuDocsAddon":
        return feishuDocsAddonPreGate(this.services.feishuDocsAddon, req, reply);
      case "pre.uiAsset":
        if (req.method === "GET" || req.method === "HEAD") return true;
        this.json(reply, 405, { error: "method not allowed" });
        return false;
      case "pre.docShareKey":
        // GET is its only route; its two calls are the docs add-on's, gated there.
        return true;
      case "pre.sessionShare": {
        if (!this.services.sessionPlusApp?.sharing) { this.json(reply, 404, { error: "共享功能未接入" }); return false; }
        if (req.method === "GET") return true;
        if (req.method !== "POST" || !this.preOriginGate(req, reply)) return false;
        const identity = this.identify(req);
        return !identity?.session || this.mutationGate(req, reply, identity);
      }
      case "pre.login":
        return req.method !== "POST" || this.preOriginGate(req, reply);
      case "pre.oauthStart":
      case "pre.oauthCallback":
        if (req.method === "GET") return true;
        this.json(reply, 405, { error: "method not allowed" });
        return false;
      case "pre.register":
        if (req.method === "GET") return true;
        if (req.method === "POST") return this.preOriginGate(req, reply);
        this.json(reply, 405, { error: "method not allowed" });
        return false;
      case "pre.logout":
        if (req.method === "POST") return this.preLogoutGate(req, reply);
        this.json(reply, 405, { error: "退出登录是写操作,请用 POST" });
        return false;
      case "pre.runnerBundle":
        return this.preRunnerBundleGate(req, reply);
      case "pre.runnerInstaller":
        if (req.method === "GET" || req.method === "HEAD") return true;
        this.json(reply, 405, { error: "method not allowed" });
        return false;
      case "pre.runnerEnrollment":
        if (req.method === "POST") return true;
        this.json(reply, 405, { error: "method not allowed" });
        return false;
      case "pre.runnerSelf":
        if (req.method !== "GET" && req.method !== "POST") {
          this.json(reply, 405, { error: "method not allowed" });
          return false;
        }
        return this.preRunnerSelfGate(req, reply);
      case "pre.devpipeTool":
        return Boolean(this.preDevpipeGate(req, reply));
      case "pre.contribBundle":
        // The token in the path is the whole credential; the handler redeems
        // it (one shot) and answers 404 for anything else. GET only: there is
        // nothing to write here.
        if (req.method === "GET") return true;
        this.json(reply, 405, { error: "method not allowed" });
        return false;
      case "pre.externalApp":
        // Everything decidable WITHOUT the credential — the surface exists, the
        // path names an operation, the method is that operation's, the Origin is
        // on the operator's allowlist — is decided here, before Fastify parses
        // a body. An unknown origin therefore cannot be answered "your JSON is
        // broken", and cannot spend this process's parser to find that out.
        // Whether the credential is valid, and whether it belongs to the origin
        // that asked, needs the row and stays in the handler.
        return externalAppPreGate(this.services.externalAppHost, req, reply);
      default:
        this.json(reply, 404, { error: "not found" });
        return false;
    }
  }

  /**
   * The paths answered BEFORE the identity gate, each for a reason that is not
   * "who is this viewer".
   *
   * That also makes them ways to walk past a composition decision, so the
   * surface check happens here, once, over the ids declared on the routes — not
   * as a condition remembered inside each handler, and not only inside
   * `authorizeRoute`, which none of them reach.
   */
  private async registerPreRoutes(scope: PanelApp): Promise<void> {
    // Callback style, and it deliberately does not call `done()` after
    // answering: that HALTS the chain, where an async hook would only be
    // skipped if `reply.sent` happened to be true by then — which a compressed
    // reply makes false for a while (see `panelHandler`).
    scope.addHook("onRequest", (req, reply, done) => {
      const id = routeIdOf(req);
      if (!id || !surfaceAllows(this.surface, id)) {
        this.json(reply, 404, { error: "not found" });
        return;
      }
      if (!this.preRouteGate(id, req, reply)) return;
      done();
    });

    scope.get("/share", { config: { routeId: "pre.sessionShare" } }, panelHandler((_req, reply) => {
      this.appPage(reply, 200, { title: "octopus · 共享会话", identity: null, page: "pre.sessionShare" });
    }));
    // A Feishu document's claim link (`feishu/doc-share.ts`): someone outside
    // the panel takes an access key. The document is the same bundle for
    // everyone and carries nothing; the link's secret stays in the fragment,
    // and the page sends it only to the docs add-on's same-origin claim calls.
    scope.get(DOC_KEY_PATH, { config: { routeId: "pre.docShareKey" } }, panelHandler((_req, reply) => {
      this.appPage(reply, 200, { title: "octopus · 领取访问密钥", identity: null, page: "pre.docShareKey" });
    }));
    scope.post("/api/session-shares/redeem", { config: { routeId: "pre.sessionShare" }, schema: { body: { type: "object", required: ["secret"], additionalProperties: false, properties: { secret: { type: "string", minLength: 43, maxLength: 43 } } } } }, panelHandler((req, reply) => {
      try {
        const identity = this.identify(req);
        const viewer = identity?.session?.username ?? `share-guest:${randomBytes(16).toString("hex")}`;
        const row = this.services.sessionPlusApp!.sharing!.redeem(String(bodyOf(req).secret), viewer);
        if (!identity?.session) {
          const issued = this.sessions.issue(viewer);
          void reply.header("set-cookie", this.sessionCookies(issued.sessionId, issued.csrf, issued.expiresAt));
        }
        this.json(reply, 200, { shareId: row.id, expired: row.expiresAt <= Date.now() });
      } catch (error) { this.json(reply, 403, { error: error instanceof Error ? error.message : "共享链接无效" }); }
    }));

    // The browser bundle answers before the identity gate for one reason: the
    // LOGIN page is part of it. The bytes are the same for every viewer, carry
    // no credential, and every decision the app appears to make is re-made by
    // this server on the request that follows.
    //
    // Registered for every method rather than for GET alone, because "you may
    // not write here" (405) is a different and better answer than "there is no
    // such file" (404) for a namespace that plainly exists.
    scope.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: "/ui/*",
      config: { routeId: "pre.uiAsset" },
      handler: panelHandler((req, reply) => this.serveAsset(req, reply)),
    });

    scope.get(
      "/login",
      { config: { routeId: "pre.login" } },
      panelHandler((req, reply) => {
        // A credential in a query string ends up in browser history, the
        // Referer of every subsequent request, the proxy log and the server
        // log. The link people are given still points here; the page turns it
        // into a POST that is never written down.
        if (panelUrl(req).searchParams.has("token")) {
          this.loginPage(reply, 400, true, "令牌不能放在网址里");
          return;
        }
        const next = safeLoginNext(panelUrl(req).searchParams.get("next") ?? "");
        this.loginPage(reply, 200, false, undefined, next);
      }),
    );
    scope.post(
      "/login",
      { config: { routeId: "pre.login" }, schema: PANEL_BODY_SCHEMAS.login },
      panelHandler((req, reply) => this.apiLogin(req, reply)),
    );

    scope.get(
      "/auth/github",
      { config: { routeId: "pre.oauthStart" } },
      panelHandler((req, reply) => this.apiGithubStart(req, reply)),
    );
    scope.get(
      "/auth/github/callback",
      { config: { routeId: "pre.oauthCallback" } },
      panelHandler((req, reply) => this.apiGithubCallback(req, reply)),
    );
    scope.get(
      "/register",
      { config: { routeId: "pre.register" } },
      panelHandler((req, reply) => this.apiRegisterPage(req, reply)),
    );
    scope.post(
      "/auth/register",
      { config: { routeId: "pre.register" }, schema: PANEL_BODY_SCHEMAS.register },
      panelHandler((req, reply) => this.apiRegister(req, reply)),
    );

    // `/logout` is a WRITE: ending a session destroys the Contexts derived from
    // it and expires the approvals they were still waiting on. As a GET it was
    // reachable from `<img src=…>` on any page in the world.
    scope.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: "/logout",
      config: { routeId: "pre.logout" },
      handler: panelHandler((req, reply) => this.apiLogout(req, reply)),
    });

    scope.get(
      "/download/runner.js",
      { config: { routeId: "pre.runnerBundle" } },
      panelHandler((req, reply) => this.downloadRunnerBundle(req, reply)),
    );

    scope.get(
      "/install/octopus-runner.sh",
      { config: { routeId: "pre.runnerInstaller" } },
      panelHandler((_req, reply) => {
        this.send(reply, 200, "text/x-shellscript; charset=utf-8", unixInstallerScript(), {
          "cache-control": "no-store",
          "content-disposition": 'inline; filename="octopus-runner-install.sh"',
        });
      }),
    );
    scope.get(
      "/install/octopus-runner.ps1",
      { config: { routeId: "pre.runnerInstaller" } },
      panelHandler((_req, reply) => {
        this.send(reply, 200, "text/plain; charset=utf-8", windowsInstallerScript(), {
          "cache-control": "no-store",
          "content-disposition": 'inline; filename="octopus-runner-install.ps1"',
        });
      }),
    );
    scope.get(
      "/install/runner.js",
      { config: { routeId: "pre.runnerInstaller" } },
      panelHandler((_req, reply) => this.serveRunnerBundle(reply)),
    );
    scope.get(
      "/install/runner.sha256",
      { config: { routeId: "pre.runnerInstaller" } },
      panelHandler((_req, reply) => this.serveRunnerBundleSha(reply)),
    );
    scope.post(
      "/api/runner-enrollment/redeem",
      { config: { routeId: "pre.runnerEnrollment" }, schema: PANEL_BODY_SCHEMAS.runnerEnrollmentRedeem },
      panelHandler((req, reply) => this.redeemRunnerEnrollment(req, reply)),
    );
    scope.get(
      "/api/runner-self-status",
      { config: { routeId: "pre.runnerSelf" } },
      panelHandler((req, reply) => this.runnerSelfStatus(req, reply)),
    );
    scope.post(
      "/api/runner-self-revoke",
      { config: { routeId: "pre.runnerSelf" } },
      panelHandler((req, reply) => this.runnerSelfRevoke(req, reply)),
    );
    scope.post(
      "/api/runner-guest-enrollment",
      { config: { routeId: "pre.runnerSelf" }, schema: PANEL_BODY_SCHEMAS.runnerGuestEnrollment },
      panelHandler((req, reply) => this.runnerGuestEnrollment(req, reply)),
    );

    // The dev agent's MCP server calls submit/status with a per-turn bearer
    // token minted by the pipeline. Before the identity gate because these
    // callers have no cookie, and the token already binds them to exactly one
    // live turn of one ticket.
    scope.post(
      "/api/devpipe/*",
      { config: { routeId: "pre.devpipeTool" } },
      panelHandler((req, reply) => handleDevpipeTool(this.routeContext(), req, reply)),
    );

    // A contributor's dev container downloading the exact commit its turn
    // works on (2026-08-20). Before the identity gate for the same reason the
    // devpipe loopback is: the caller holds no cookie, and what it presents is
    // a single-use token the pipeline minted seconds ago for exactly one file.
    scope.get(
      "/api/contrib/bundle/:token",
      { config: { routeId: "pre.contribBundle" } },
      panelHandler((req, reply) => this.serveContribBundle(req, reply)),
    );

    // `external-app-host/v1`. Before the identity gate because these callers
    // hold no cookie and must not be able to acquire authority from one; the
    // capability they present binds them to one account, App, instance, host
    // and authority, and every one of those is re-checked per call. OPTIONS is
    // routed here too so the CORS preflight is answered by the same allowlist
    // that answers the request — the panel has no CORS plugin and this surface
    // does not introduce one for anything else.
    scope.route({
      method: ["GET", "POST", "OPTIONS"],
      url: "/api/external/app/*",
      config: { routeId: "pre.externalApp" },
      handler: panelHandler((req, reply) => handleExternalApp(this.routeContext(), req, reply)),
    });
    scope.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: `${DOCS_ADDON_PATH}*`,
      bodyLimit: DOCS_ADDON_BODY_LIMIT,
      config: { routeId: "pre.feishuDocsAddon" },
      handler: panelHandler((req, reply) => handleFeishuDocsAddon(this.services.feishuDocsAddon!, req, reply)),
    });
  }

  /**
   * The gate: one implementation, in `onRequest`, ahead of body parsing.
   *
   * The order is the security content. Identity first, so nothing — not even
   * "your JSON is malformed" or "you are missing a field" — is answered to a
   * caller who should be told 401. Then the mutation gate for every unsafe
   * method. Then the panel's single authorization decision, which is also what
   * makes an unlisted path a 404 rather than a handler nobody wrote a rule for.
   *
   * Routes whose target account is only in the request BODY are authorized here
   * for their action against the caller's own account, and their handler re-asks
   * `mayRead`/`mayWriteAs` once it has parsed the real target. Same policy, two
   * call sites, because the gate must not consume the body.
   */
  private gate = (req: PanelRequest, reply: PanelReply, done: (err?: Error) => void): void => {
    // @architecture flow=dashboard-request step=identify after=http-request role=identity label="Bind server-side identity" condition="request reaches the pre-body gate" outcome=identity-bound authority="server session, API token, or one-turn devpipe binding" enforces=AUTH-001
    const identity = this.identify(req);
    if (!identity) {
      // @architecture flow=dashboard-request step=anonymous-deny after=identify role=refusal label="Refuse an anonymous request" condition="identity is absent" outcome=deny authority=none terminal=true
      this.refuseAnonymous(req, reply);
      return;
    }
    // @architecture flow=dashboard-request step=mutation-gate after=identify role=gate label="Origin and CSRF mutation gate" condition="identity is bound" outcome=mutation-admitted authority="bound identity plus server CSRF state"
    // @architecture flow=dashboard-request step=mutation-deny after=mutation-gate role=refusal label="Refuse an unsafe mutation" condition="Origin or CSRF check fails" outcome=deny authority=none terminal=true
    if (!this.mutationGate(req, reply, identity)) return;
    // Resolved from the PATH, not from the rule id the matched route declared.
    // The two agree — `routes.test.ts` walks every route and proves it — and
    // asking the table directly is what keeps the failure mode closed in both
    // directions: a route registered without a rule is a 404 here, and a rule
    // nobody registered is a 404 at the router. Reading the declared id would
    // make the first of those a route that authorises itself.
    const url = panelUrl(req);
    const shareHeader = req.headers["x-session-share"];
    if ((url.searchParams.has("share") || typeof shareHeader === "string") && !identity.sessionShare) {
      this.json(reply, 403, { error: "共享不存在或未加入" }); return;
    }
    const guestPaths = new Set(["/sessions-plus", "/api/session-plus/act", "/api/session-plus/stream", "/api/session-plus/close", "/api/session-plus/reconstruct", "/api/session-plus/performance", "/api/session-shares/list", "/api/session-shares/request"]);
    if (identity.sessionShare && !new Set(["/sessions-plus", "/api/session-plus/act", "/api/session-plus/stream", "/api/session-plus/close", "/api/session-plus/reconstruct", "/api/session-plus/performance"]).has(url.pathname)) {
      this.json(reply, 403, { error: "共享身份不能管理签发者的账户或授权" }); return;
    }
    if (identity.guest && (!guestPaths.has(url.pathname) || (url.pathname.startsWith("/api/session-plus/") || url.pathname === "/sessions-plus") && !identity.sessionShare)) {
      this.json(reply, 403, { error: "访客只能访问获准共享的会话" }); return;
    }
    if (identity.sessionShare && (url.pathname.startsWith("/api/session-plus/") || url.pathname === "/sessions-plus")) {
      try { this.services.sessionPlusApp!.sharing!.access(identity.sessionShare.id, identity.username!); }
      catch { if (url.pathname === "/sessions-plus") { void reply.code(303).header("location", `/share?id=${identity.sessionShare.id}`).send(); } else this.json(reply, 403, { error: "共享已到期，请申请更多时间" }); return; }
    }
    // @architecture flow=dashboard-request step=route-authorize after=mutation-gate role=gate label="Resolve path against the authorization table" condition="mutation gate admits the request" outcome=route-verdict authority="server route table plus bound subject" enforces=ROUTE-001
    const verdict = authorizeRoute({
      method: req.method ?? "GET",
      pathname: url.pathname,
      searchParams: url.searchParams,
      viewer: subjectOf(identity),
      enabledFeatures: this.configuredFeatures,
      surface: this.surface,
    });
    if (!verdict.ok) {
      // @architecture flow=dashboard-request step=route-deny after=route-authorize role=refusal label="Return the closed route refusal" condition="route verdict is not ok" outcome=deny authority=none terminal=true
      // One page refuses in HTML: /pending is where a person lands from a
      // notification, and a JSON blob is not an answer to "log in first".
      // The login form states the actual refusal (not "invalid key") and
      // returns to the queue after the person signs in as themselves.
      if (verdict.status === 403 && url.pathname === "/pending") {
        this.loginPage(reply, 403, true, verdict.error, safeLoginNext(`${url.pathname}${url.search}`) || "/pending");
        return;
      }
      this.json(reply, verdict.status, { error: verdict.error });
      return;
    }
    // An mcp_ token is a single-purpose credential: the MCP endpoint and
    // nothing else. Enforced AFTER the Cedar verdict so the answer for a route
    // the account could not reach anyway stays identical (404/403 unchanged),
    // and a leaked mcp token cannot even enumerate the panel.
    if (identity.mcpOnly && verdict.match.rule.id !== "api.mcp.rpc") {
      this.json(reply, 403, { error: "MCP 令牌只能访问 /api/mcp" });
      return;
    }
    // On the bootstrap surface some admitted routes exist only to point
    // somewhere else — `/` is the way home, not the v2 ops page.
    const landing = BOOTSTRAP_REDIRECTS.get(verdict.match.rule.id);
    if (landing && this.surface === "bootstrap-v3") {
      // @architecture flow=dashboard-request step=bootstrap-redirect after=route-authorize role=dispatch label="Redirect an admitted bootstrap route" condition="admitted rule is a bootstrap redirect" outcome=redirect authority="authorized route verdict" terminal=true
      void reply.code(303).header("location", landing).send();
      return;
    }
    // @architecture flow=dashboard-request step=handler after=route-authorize role=dispatch label="Release the authorized identity to the handler" condition="route is admitted and is not a redirect" outcome=dispatch authority="server-bound authorized identity" terminal=true
    this.identities.set(req, identity);
    done();
  };

  /** No credential at all. Page navigations enter login; APIs keep a real 401. */
  private refuseAnonymous(req: PanelRequest, reply: PanelReply): void {
    if (req.method === "GET" && routeIdOf(req).startsWith("page.") && requestsHtmlDocument(req)) {
      const url = panelUrl(req);
      const next = safeLoginNext(`${url.pathname}${url.search}`) || "/";
      void reply
        .code(303)
        .header("location", `/login?next=${encodeURIComponent(next)}`)
        .send();
      return;
    }
    this.json(reply, 401, { error: "unauthorized" });
  }

  /**
   * Run a handler only when the gate produced an identity.
   *
   * The hook has already answered (401/403/404/303) in every other case. The
   * handler is passed as a closure rather than as a method reference on purpose:
   * a `this`-less call here would surface as a 500 on a route that reads as
   * wired, which is the failure the v3 Host's route table caught.
   */
  private withIdentity(
    fn: (req: PanelRequest, reply: PanelReply, identity: DashboardIdentity) => void | Promise<void>,
  ): (req: PanelRequest, reply: PanelReply) => Promise<PanelReply> {
    return panelHandler(async (req, reply) => {
      const identity = this.identities.get(req);
      if (!identity) return;
      await fn(req, reply, identity);
    });
  }

  /**
   * The narrow server view the domain route modules read. Built once; the
   * getters keep late-bound facts (the bound port) live.
   */
  private routeContextCache: DashboardRouteContext | null = null;

  private routeContext(): DashboardRouteContext {
    if (this.routeContextCache) return this.routeContextCache;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const opts: DashboardRouteOptions = {
      ...this.opts,
      userManager: this.services.userManager,
      feishuOAuth: this.services.feishuOAuth,
      sessionPlusApp: this.services.sessionPlusApp,
      sessionPlusRelease: this.services.sessionPlusRelease,
      workspaceFiles: this.services.workspaceFiles,
      appReleases: this.services.appReleases,
      declaredApps: this.services.declaredApps,
      devPipeline: this.services.devPipeline,
      fableTicketApprovals: this.services.fableTicketApprovals,
      architecture: this.services.architecture,
      knowledge: this.services.knowledge,
      knowledgeChat: this.services.knowledgeChat,
      deployService: this.services.deployService,
      feishuDirectory: this.services.feishuDirectory,
      registerUser: this.services.registerUser,
      declareApp: this.services.declareApp,
      publishPendingAppReleases: this.services.publishPendingAppReleases,
      appHotswapApprovals: this.services.appHotswapApprovals,
      contribReview: this.services.contribReview,
      contribBundles: this.services.contribBundles,
    };
    this.routeContextCache = {
      store: this.store,
      caps: this.caps,
      approvals: this.approvals,
      opts,
      permissions: this.permissions,
      permissionStudio: this.services.permissionStudio,
      appTrust: this.appTrust,
      hub: this.hub,
      operations: this.operations,
      mcp: this.mcp,
      tentacle: this.tentacle,
      feishuOAuth: this.services.feishuOAuth ?? undefined,
      externalAppHost: this.services.externalAppHost,
      liveStreams: this.liveStreams,
      eventStreams: this.eventStreams,
      sessionPlusCheckoutCache: this.sessionPlusCheckoutCache,
      get boundPort() {
        return self.boundPort;
      },
      get sessionHubUi() {
        return self.sessionHubUi;
      },
      appPage: (res, status, options) => this.appPage(res, status, options),
      requireUser: (res, identity, username) => this.requireUser(res, identity, username),
      canActFor: (identity, username) => this.canActFor(identity, username),
      canWriteAs: (identity, username) => this.canWriteAs(identity, username),
      canManageConnection: (identity, username) => this.canManageConnection(identity, username),
      targetAccount: (req, identity) => this.targetAccount(req, identity),
      githubConnectionAvailable: () => this.githubOAuthEnabled(),
      startGithubConnection: (username) => this.startGithubConnection(username),
      connectionHandle: (provider, externalId) => this.connectionHandle(provider, externalId),
      removeIdentity: (username, provider, externalId) =>
        this.services.userManager?.removeIdentity(username, provider, externalId) ?? null,
      requireApprover: (res, identity) => this.requireApprover(res, identity),
      capabilitiesFor: (username) => this.capabilitiesFor(username),
      endCredential: (owner, credential) => this.endCredential(owner, credential),
      endOwner: (owner) => this.endOwner(owner),
      startSse: (req, res, params, key, make) => this.startSse(req, res, params, key, make),
      sessionPlusSettings: () => this.sessionPlusSettings(),
      devpipeGate: (req, reply) => this.preDevpipeGate(req, reply),
      quotaProbe: () => this.services.quotaProbe(),
      codexQuotaProbe: () => this.services.codexQuotaProbe(),
      systemStatusProbe: () => this.services.systemStatusProbe(),
    };
    return this.routeContextCache!;
  }

  private async registerGuardedRoutes(scope: PanelApp): Promise<void> {
    scope.addHook("onRequest", this.gate);
    const get = (url: string, routeId: string, fn: GuardedHandler): void => {
      scope.get(url, { config: { routeId } }, this.withIdentity(fn));
    };
    const post = (
      url: string,
      routeId: string,
      schema: object | undefined,
      fn: GuardedHandler,
      extra?: { bodyLimit?: number },
    ): void => {
      scope.post(
        url,
        {
          config: { routeId },
          ...(schema ? { schema } : {}),
          ...(extra?.bodyLimit ? { bodyLimit: extra.bodyLimit } : {}),
        },
        this.withIdentity(fn),
      );
    };
    /** For the prefix rules whose handler owns its own sub-dispatch. */
    const any = (url: string, routeId: string, fn: GuardedHandler, extra?: { bodyLimit?: number }): void => {
      scope.route({
        method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        url,
        config: { routeId },
        ...(extra?.bodyLimit ? { bodyLimit: extra.bodyLimit } : {}),
        handler: this.withIdentity(fn),
      });
    };
    const routes: GuardedRoutes = { get, post, any };
    const ctx = this.routeContext();

    // ── Pages ──
    get("/", "page.overview", (req, reply, identity) => pageOverview(ctx, req, reply, identity));
    // Compatibility only: the legacy screen and its browser source are gone.
    get("/sessions", "page.sessions", (_req, reply) => {
      void reply.code(303).header("location", "/sessions-plus").send();
    });
    get("/sessions-plus", "page.sessionsPlus", (_req, reply, identity) =>
      pageSessionsPlus(ctx, reply, identity),
    );
    get("/tickets", "page.tickets", (_req, reply, identity) => {
      this.appPage(reply, 200, { title: "octopus · 开发工单", identity, page: "page.tickets" });
    });
    get("/architecture", "page.architecture", (_req, reply, identity) => {
      this.appPage(reply, 200, { title: "octopus · 架构", identity, page: "page.architecture" });
    });
    get("/knowledge", "page.knowledge", (req, reply, identity) => {
      if (panelUrl(req).searchParams.get("agent") === "sessions-plus" && this.services.sessionPlusEnabled && identity.username && identity.session) {
        return pageSessionsPlus({ ...ctx, appPage: (res, status, options) => ctx.appPage(res, status, {
          ...options,
          page: "page.knowledge",
          title: "octopus · 知识裁决",
          props: { sessionPlus: options.props as import("@claude-bot/dashboard-web/contract").SessionPlusPageProps },
        }) }, reply, identity);
      }
      this.appPage(reply, 200, { title: "octopus · 知识库", identity, page: "page.knowledge" });
    });
    get("/admin", "page.admin", (_req, reply, identity) => {
      this.appPage(reply, 200, { title: "octopus · 管理", identity, page: "page.admin" });
    });
    get("/apps", "page.apps", (_req, reply, identity) => {
      this.appPage(reply, 200, { title: "octopus · 应用发布", identity, page: "page.apps" });
    });
    get("/launcher", "page.launcher", (_req, reply, identity) => {
      this.appPage(reply, 200, { title: "octopus · 应用", identity, page: "page.launcher" });
    });
    // The trusted shell around one declared App's Agent View. A parameterised
    // path so the App is named where a person can read it; the handler is what
    // turns that segment into a lookup key and refuses everything else.
    get("/apps/:app/open", "page.appOpen", (req, reply, identity) =>
      pageAppOpen(ctx, req, reply, identity),
    );
    get("/permissions", "page.permissions", (_req, reply, identity) => {
      // `Identify` on self: the gate already refused the shared key, which names
      // nobody and therefore has no permissions to look at.
      this.appPage(reply, 200, {
        title: "octopus · 权限中心",
        identity,
        page: "page.permissions",
        props: { owner: identity.username!, canEdit: true },
      });
    });
    get("/access-preview", "page.accessPreview", (_req, reply) => {
      reply.redirect("/permissions?view=tree", 303);
    });
    get("/pending", "page.pending", (_req, reply, identity) => {
      // `Identify` on the caller's own account, decided by the gate, which also
      // renders the HTML refusal for this one page.
      //
      // The approval surface is the one place where a script the operator did
      // not ship could turn a real human click into an approval of somebody
      // else's dangerous call. It is covered by the same rule as every other
      // page — `script-src 'self'`, no inline execution anywhere — which is
      // strictly stronger than the per-response nonce it used to carry: a nonce
      // admits whatever the renderer put next to it, `'self'` admits only files
      // this server published.
      this.appPage(reply, 200, {
        title: "octopus · 待批准",
        identity,
        page: "page.pending",
        props: { username: identity.username!, hasSession: Boolean(identity.session) },
      });
    });

    // The API surface: one register call per domain module (2026-08-11 domain
    // split). Registration order does not decide matching — Fastify's router
    // is a radix tree, and `authz.ts` keeps its own first-match order — but
    // the calls follow the old section order so a reader can still walk the
    // surface top to bottom.
    // ── Overview, health, account settings, devices ──
    registerOverviewRoutes(routes, ctx);
    // ── Session browsing (transcript viewer backend) ──
    registerSessionRoutes(routes, ctx);
    // ── Session Plus (the Agentic App probe) ──
    registerSessionPlusRoutes(routes, ctx);
    // ── Permission centre ──
    registerPermissionRoutes(routes, ctx);
    registerTentacleRoutes(routes, ctx);
    // ── External identity connections ──
    registerConnectionRoutes(routes, ctx);
    // ── MCP surface, token lifecycle and the trusted approval face ──
    registerMcpRoutes(routes, ctx);
    registerDiscussionRoutes(routes, this.services.discussions);
    // ── Dev pipeline, deploy choreography and the landing door ──
    registerTicketRoutes(routes, ctx);
    // ── Architecture observatory ──
    registerArchitectureRoutes(routes, ctx);
    // ── Knowledge wiki ──
    registerKnowledgeRoutes(routes, ctx);
    // ── Administration ──
    registerAdminRoutes(routes, ctx);
    // ── Agentic App releases ──
    registerAppReleaseRoutes(routes, ctx);
    // ── Declared Apps: shared instances and the App View verbs ──
    registerAppViewRoutes(routes, ctx);
    // ── Handing one shared instance to an allow-listed external host ──
    registerAppExternalRoutes(routes, ctx);
  }

  // ── Pre-gate handlers ──

  private async serveAsset(req: PanelRequest, reply: PanelReply): Promise<void> {
    // The RAW pathname: `assets.ts` owns the decoding, the traversal check and
    // the canonical-path check, and handing it a router-decoded segment would
    // move that decision to somewhere that does not make it.
    const pathname = panelUrl(req).pathname;
    const moduleAsset = /^\/ui\/apps\/([0-9a-f]{64})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:js|mjs|css|json|svg))$/.exec(pathname);
    if (moduleAsset) {
      const bytes = this.services.appReleases?.viewAssetFor(moduleAsset[1], moduleAsset[2]);
      if (!bytes) { this.json(reply, 404, { error: "not found" }); return; }
      const extension = moduleAsset[2].split(".").pop();
      const contentType = extension === "css" ? "text/css; charset=utf-8" : extension === "json" ? "application/json; charset=utf-8" : extension === "svg" ? "image/svg+xml" : "text/javascript; charset=utf-8";
      this.send(reply, 200, contentType, Buffer.from(bytes), { "cache-control": "public, max-age=31536000, immutable" });
      return;
    }
    const asset = await readAsset(pathname);
    if (!asset) {
      this.json(reply, 404, { error: "not found" });
      return;
    }
    this.send(reply, 200, asset.contentType, asset.body, {
      // Every emitted name carries a content hash, so a year-long cache can
      // never serve stale bytes under a name that means something else. That is
      // also what makes a tab opened before a deploy keep working: it already
      // holds the one file it needs, and there is no second chunk to go missing.
      "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
  }

  private apiGithubStart(req: PanelRequest, reply: PanelReply): void {
    if (!this.githubOAuthEnabled()) {
      this.json(reply, 404, { error: "not found" });
      return;
    }
    const next = safeLoginNext(panelUrl(req).searchParams.get("next") ?? "");
    const state = this.oauthStates.issue({ mode: "login", ...(next ? { next } : {}) });
    const credentials = this.opts.oauthGithub!;
    void reply
      .code(303)
      .header("set-cookie", this.shortLivedCookie(GITHUB_STATE_COOKIE, state))
      .header("location", buildAuthorizeUrl({ clientId: credentials.clientId, state }))
      .send();
  }

  private async apiGithubCallback(req: PanelRequest, reply: PanelReply): Promise<void> {
    if (!this.githubOAuthEnabled()) {
      this.json(reply, 404, { error: "not found" });
      return;
    }
    const url = panelUrl(req);
    const presentedState = url.searchParams.get("state") ?? "";
    // Consume before checking the browser cookie: a stolen state gets one try,
    // and a missing/wrong cookie burns it instead of becoming retryable CSRF.
    const state = this.oauthStates.consume(presentedState);
    const stateCookie = readCookie(req.headers.cookie, GITHUB_STATE_COOKIE);
    const clearState = clearCookie(GITHUB_STATE_COOKIE);
    if (!state) {
      void reply.header("set-cookie", clearState);
      this.loginPage(reply, 400, true, "GitHub 登录状态无效或已过期");
      return;
    }
    if (!stateCookie || !secretEquals(stateCookie, presentedState)) {
      void reply.header("set-cookie", clearState);
      this.loginPage(reply, 400, true, "GitHub 登录状态与当前浏览器不匹配", state.next ?? "");
      return;
    }
    // The state/cookie pair has now served its only purpose. Clear it before
    // any network request, including error paths.
    void reply.header("set-cookie", clearState);

    // A connect state names the account that initiated it. Re-resolve the
    // callback's CURRENT cookie session before exchanging the code: a bearer,
    // a missing/expired session, or a different user's browser cannot finish
    // somebody else's binding even with the state cookie in hand.
    const connectIdentity = state.mode === "connect" ? this.identify(req) : null;
    if (
      state.mode === "connect"
      && (!state.username
        || !connectIdentity?.session
        || connectIdentity.via !== "cookie"
        || connectIdentity.username !== state.username)
    ) {
      this.connectionPage(reply, 403, connectIdentity, "GitHub 绑定发起账号与当前浏览器会话不一致");
      return;
    }

    try {
      const code = url.searchParams.get("code") ?? "";
      if (!code) throw new Error("missing code");
      const credentials = this.opts.oauthGithub!;
      const accessToken = await exchangeCode({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        code,
        fetcher: this.opts.githubFetcher,
      });
      const profile = await fetchGithubUser({ accessToken, fetcher: this.opts.githubFetcher });
      // accessToken is intentionally not returned, persisted or logged. Its one
      // use was revalidating the GitHub identity above.
      const externalId = String(profile.id);
      if (state.mode === "connect") {
        const owner = state.username!;
        const existing = this.services.userManager!.resolve("github", externalId);
        if (existing && existing.username !== owner) {
          this.connectionPage(reply, 409, connectIdentity, "该 GitHub 身份已绑定到其他账号");
          return;
        }
        if (!existing) {
          await this.services.userManager!.addIdentity(owner, {
            provider: "github",
            externalId,
            label: profile.login,
          });
        }
        log.info({ username: owner }, "Dashboard GitHub connection added");
        void reply.code(303).header("location", "/permissions#connections").send();
        return;
      }

      const existing = this.services.userManager!.resolve("github", externalId);
      if (existing) {
        log.info({ username: existing.username }, "Dashboard GitHub login");
        this.finishUserLogin(existing.username, state.next ?? "", reply, [clearState]);
        return;
      }
      if ((this.opts.registration ?? "closed") !== "open") {
        void reply.header("set-cookie", clearState);
        this.loginPage(reply, 403, true, "该 GitHub 身份尚未绑定，当前未开放注册", state.next ?? "");
        return;
      }

      const registrationToken = this.pendingRegistrations.issue({
        provider: "github",
        externalId,
        label: profile.login,
      });
      void reply
        .code(303)
        .header("set-cookie", [
          clearState,
          this.shortLivedCookie(GITHUB_REGISTRATION_COOKIE, registrationToken),
        ])
        .header("location", "/register")
        .send();
    } catch {
      // Never log the callback code, client secret, access token or a response
      // body that might contain one. The browser gets a stable, non-sensitive
      // reason and can restart the one-shot flow.
      log.warn("GitHub OAuth callback failed");
      void reply.header("set-cookie", clearState);
      if (state.mode === "connect") {
        this.connectionPage(reply, 502, connectIdentity, "GitHub 绑定失败，请重试");
      } else {
        this.loginPage(reply, 502, true, "GitHub 登录失败，请重试", state.next ?? "");
      }
    }
  }

  private apiRegisterPage(req: PanelRequest, reply: PanelReply): void {
    if (!this.githubOAuthEnabled() || (this.opts.registration ?? "closed") !== "open") {
      this.json(reply, 404, { error: "not found" });
      return;
    }
    const token = readCookie(req.headers.cookie, GITHUB_REGISTRATION_COOKIE);
    const pending = this.pendingRegistrations.peek(token);
    if (!pending) {
      void reply.header("set-cookie", clearCookie(GITHUB_REGISTRATION_COOKIE));
      this.loginPage(reply, 400, true, "注册链接无效或已过期");
      return;
    }
    this.registrationPage(reply, 200, pending.label, null);
  }

  private async apiRegister(req: PanelRequest, reply: PanelReply): Promise<void> {
    if (!this.githubOAuthEnabled() || (this.opts.registration ?? "closed") !== "open") {
      this.json(reply, 404, { error: "not found" });
      return;
    }
    const token = readCookie(req.headers.cookie, GITHUB_REGISTRATION_COOKIE);
    const pending = this.pendingRegistrations.consume(token);
    const clearRegistration = clearCookie(GITHUB_REGISTRATION_COOKIE);
    void reply.header("set-cookie", clearRegistration);
    if (!pending) {
      this.loginPage(reply, 400, true, "注册链接无效或已过期");
      return;
    }

    const username = String(bodyOf(req).username ?? "").trim();
    try {
      const user = await this.services.userManager!.register(username, {
        provider: pending.provider,
        externalId: pending.externalId,
        label: pending.label,
      });
      log.info({ username: user.username }, "Dashboard GitHub registration");
      this.finishUserLogin(user.username, "", reply, [clearRegistration]);
    } catch (error) {
      // The consumed handoff stays one-shot. Mint a fresh one for this same
      // verified identity so a username correction does not require another
      // trip through GitHub.
      const retryToken = this.pendingRegistrations.issue({
        provider: pending.provider,
        externalId: pending.externalId,
        label: pending.label,
      });
      void reply.header("set-cookie", this.shortLivedCookie(GITHUB_REGISTRATION_COOKIE, retryToken));
      const message = error instanceof Error && (error.message.startsWith("用户名") || error.message === "该用户名已被保留")
        ? error.message
        : "注册失败，请重试";
      this.json(reply, 400, { error: message });
    }
  }

  /** One session-issuance and landing path for dt_ login, OAuth and registration. */
  private finishUserLogin(
    username: string,
    next: string,
    reply: PanelReply,
    extraCookies: readonly string[] = [],
  ): void {
    const session = this.sessions.issue(username);
    const defaultLanding = routeIsAvailable(this.surface, "page.sessionsPlus", this.configuredFeatures)
      ? "/sessions-plus"
      : "/";
    void reply
      .code(303)
      .header("set-cookie", [
        ...this.sessionCookies(session.sessionId, session.csrf, session.expiresAt),
        ...extraCookies,
      ])
      .header("location", safeLoginNext(next) || defaultLanding)
      .send();
  }

  private async apiLogin(req: PanelRequest, reply: PanelReply): Promise<void> {
    const body = bodyOf(req);
    const token = String(body.token ?? "");
    const id = this.identityForToken(token);
    if (!id) {
      this.json(reply, 401, { error: "令牌无效" });
      return;
    }
    // An mcp_ token must never buy a browser session: a session is what the
    // Cedar `Approve` rule reads as "a person is at a keyboard", and the whole
    // point of the MCP surface is that its credential can request dangerous
    // calls but can never approve its own.
    if (id.mcpOnly) {
      this.json(reply, 403, { error: "MCP 令牌不能用于网页登录 — 请用个人 dt_ 密钥" });
      return;
    }
    if (token.startsWith("dt_")) this.store.touchDashboardToken(hashRunnerToken(token), new Date().toISOString());
    log.info({ admin: id.admin, username: id.username }, "Dashboard login");
    // Same-origin return target from the login page. Parse it as a URL instead
    // of trusting a `startsWith("/")` check: browsers treat backslashes as URL
    // separators, so `/\\evil.example` is not the local path it resembles.
    const safeNext = safeLoginNext(String(body.next ?? ""));
    // The bearer buys a session; it does not become the session. Only an
    // account can have one — the shared admin key names no person, so it keeps
    // working as a bearer and can never approve anything.
    //
    // It used to be written into a cookie here, and `identify()` has never read
    // that cookie back (see its docstring): a long-lived bearer was being stored
    // in the browser for nothing. It is now cleared instead, which is the same
    // login outcome minus a credential at rest.
    if (id.username) {
      this.finishUserLogin(id.username, safeNext, reply);
      return;
    }
    // 303: the browser must GET the destination, so the credential does not
    // survive a resubmit.
    void reply
      .code(303)
      .header("set-cookie", clearSessionCookies(this.cookies))
      // Personal keys land on the sole session UI when this composition has
      // one. Feature-off compositions and shared admins fall back to Overview.
      .header("location", safeNext || "/")
      .send();
  }

  /**
   * Ending a session is a state change, and it cannot go through
   * `mutationGate` because it sits before the identity gate — it has to work
   * when the session is already half-dead. So it carries the two checks that
   * make sense for it: a real Origin, and — when there IS a session secret to
   * double-submit — the secret.
   */
  private async apiLogout(req: PanelRequest, reply: PanelReply): Promise<void> {
    const sid = readCookie(req.headers.cookie, this.cookies.names.session);
    const live = this.sessions.resolve(sid);
    this.sessions.revoke(sid);
    // The row first, then what it opened. Logging out has to end this login's
    // Contexts, its undecided approval cards, its live streams and its append
    // leases — otherwise "退出登录" was a cookie change and a queued `append`
    // could still be approved from another tab afterwards.
    if (live) this.endCredential(live.username, webCredential(live.tokenHash));
    void reply
      .code(200)
      // The live pair AND every retired name: logging out of an upgraded
      // deployment must not leave the pre-`__Host-` cookie sitting there.
      .header("set-cookie", clearSessionCookies(this.cookies))
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({ ok: true }));
  }

  /**
   * Redeem a one-shot bundle token (`devpipe/bundle-handoff.ts`). Shape is
   * checked before the map is consulted so an arbitrary path never reaches a
   * lookup; a miss is 404 whether the token never existed, expired or was
   * already used — the three are indistinguishable on purpose.
   */
  private async serveContribBundle(req: PanelRequest, reply: PanelReply): Promise<void> {
    const token = String((req.params as { token?: string }).token ?? "");
    const bundles = this.services.contribBundles;
    if (!bundles || !looksLikeBundleToken(token)) {
      this.json(reply, 404, { error: "not found" });
      return;
    }
    const take = bundles.take(token);
    if (!take) {
      this.json(reply, 404, { error: "not found" });
      return;
    }
    try {
      const buf = await readFile(take.path);
      const started = Date.now();
      const fields = { purpose: take.purpose ?? "unspecified", identity: take.identity,
        direction: "outbound", payloadBytes: buf.length };
      // HTTP completion is not a cloud-billing counter; tokens and paths stay private.
      let finished = false;
      reply.raw.once("finish", () => {
        finished = true;
        log.info({ ...fields, ms: Date.now() - started }, "bundle response finished");
      });
      reply.raw.once("close", () => {
        if (!finished) log.warn({ ...fields, ms: Date.now() - started }, "bundle response closed before finish; sent bytes unknown");
      });
      this.send(reply, 200, "application/x-git-bundle", buf, {
        "content-disposition": 'attachment; filename="sync.bundle"',
        "cache-control": "no-store",
      });
    } catch {
      this.json(reply, 404, { error: "not found" });
    } finally {
      await take.done();
    }
  }

  private async downloadRunnerBundle(req: PanelRequest, reply: PanelReply): Promise<void> {
    // A device token may fetch the very bundle it exists to run: the token a
    // user just minted must be enough to onboard end to end, without the panel
    // token. The bundle contains no secrets.
    //
    // Header only. The onboarding command is pasted into a shell, so a token in
    // the URL would end up in shell history and in the access log of every hop;
    // the same token is the device's whole credential.
    await this.serveRunnerBundle(reply);
  }

  private redeemRunnerEnrollment(req: PanelRequest, reply: PanelReply): void {
    if (!this.caps) {
      this.json(reply, 503, { error: "runner capability service unavailable" });
      return;
    }
    const code = String(bodyOf(req).code ?? "").trim();
    const redeemed = redeemRunnerEnrollment(this.store, this.caps, code);
    if (!redeemed) {
      // Unknown, expired and already-consumed are deliberately indistinguishable.
      this.json(reply, 404, { error: "enrollment code 无效、已使用或已过期" });
      return;
    }
    const dashboardUrl = this.opts.publicUrl?.replace(/\/$/, "") || panelUrl(req).origin;
    const runnerUrl = this.opts.runnerPublicUrl || this.defaultRunnerUrl(req);
    log.info({ username: redeemed.row.username, device: redeemed.row.device }, "Runner enrollment redeemed");
    this.json(reply, 200, {
      ok: true,
      token: redeemed.token,
      device: redeemed.row.device,
      dashboard_url: dashboardUrl,
      runner_url: runnerUrl,
    });
  }

  private runnerSelfStatus(req: PanelRequest, reply: PanelReply): void {
    const row = this.runnerTokenRow(req);
    if (!row) return this.json(reply, 401, { error: "unauthorized" });
    const device = this.caps?.listDevices(row.username).find((candidate) => candidate.device === row.device);
    this.json(reply, 200, {
      ok: true, username: row.username, device: row.device, online: device?.online === true,
      ...(device?.bundle_sha ? { bundle_sha: device.bundle_sha } : {}),
      ...(device?.bundle_current !== undefined ? { bundle_current: device.bundle_current } : {}),
      ...(device?.bundle_target_sha ? { bundle_target_sha: device.bundle_target_sha } : {}),
      ...(device?.bundle_update_status ? { bundle_update_status: device.bundle_update_status } : {}),
    });
  }

  private runnerSelfRevoke(req: PanelRequest, reply: PanelReply): void {
    const row = this.runnerTokenRow(req);
    if (!row) return this.json(reply, 401, { error: "unauthorized" });
    if (!this.caps) return this.json(reply, 503, { error: "runner capability service unavailable" });
    const existed = this.caps.revokeDeviceToken(row.username, row.device);
    this.endOwner(row.username);
    log.info({ username: row.username, device: row.device, existed }, "Runner self-uninstalled");
    this.json(reply, 200, { ok: true, revoked: existed });
  }

  /**
   * A model host packs an installer for a friend's PC (2026-11-12). The
   * bearer is the host's own device credential: the new guest is the host
   * owner's device and may tunnel only to this host. Guests cannot issue.
   */
  private runnerGuestEnrollment(req: PanelRequest, reply: PanelReply): void {
    const row = this.runnerTokenRow(req);
    if (!row) return this.json(reply, 401, { error: "unauthorized" });
    if (row.device.startsWith("dsh:")) return this.json(reply, 403, { error: "该凭据不能签发访客设备" });
    const body = bodyOf(req);
    const providers = Array.isArray(body.providers) ? body.providers.map(String) : [];
    const ttlDays = typeof body.ttl_days === "number" ? body.ttl_days : undefined;
    let issued: ReturnType<typeof issueGuestEnrollment>;
    try {
      issued = issueGuestEnrollment(this.store, {
        username: row.username,
        device: String(body.device ?? ""),
        modelHost: row.device,
        providers: providers as Parameters<typeof issueGuestEnrollment>[1]["providers"],
        ...(ttlDays !== undefined ? { ttlMs: ttlDays * 24 * 60 * 60_000 } : {}),
      });
    } catch (error) {
      if (error instanceof GuestEnrollmentError) return this.json(reply, error.status, { error: error.message });
      throw error;
    }
    const dashboardUrl = this.opts.publicUrl?.replace(/\/$/, "") || panelUrl(req).origin;
    const runnerUrl = this.opts.runnerPublicUrl || this.defaultRunnerUrl(req);
    log.info({ username: issued.username, device: issued.device, modelHost: issued.model_host, providers: issued.providers },
      "Runner guest enrollment issued");
    this.json(reply, 200, {
      ok: true,
      enrollment_code: issued.code,
      username: issued.username,
      device: issued.device,
      model_host: issued.model_host,
      providers: issued.providers,
      expires_at: issued.expires_at,
      dashboard_url: dashboardUrl,
      runner_url: runnerUrl,
    });
  }

  private runnerTokenRow(req: PanelRequest) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return token ? this.store.getRunnerTokenByHash(hashRunnerToken(token)) : undefined;
  }

  private defaultRunnerUrl(req: PanelRequest): string {
    const source = panelUrl(req);
    const protocol = source.protocol === "https:" ? "wss:" : "ws:";
    const host = this.opts.publicHost || source.hostname;
    return `${protocol}//${host}:${this.opts.runnerWsPort ?? 9910}`;
  }

  // ── Session browsing ──

  /** The account a `query`-targeted route is about: named, or the caller's own. */
  private targetAccount(req: PanelRequest, identity: DashboardIdentity): string {
    return panelUrl(req).searchParams.get("username") || identity.username || "";
  }

  /**
   * Shared SSE bootstrap: reconnect cursor (Last-Event-ID) beats the
   * from/frontier the page computed from its loaded history.
   *
   * Takes the RAW response, because the caller has already hijacked its reply —
   * a stream owns its socket, so no serializer, no `onSend` hook and no
   * compression apply from here on.
   */
  private async startSse(
    req: PanelRequest,
    res: ServerResponse,
    params: URLSearchParams,
    key: string,
    make: () => Promise<{ src: import("./live.js").TailSource; intervalMs: number }>,
  ): Promise<void> {
    const cursor = decodeCursor(req.headers["last-event-id"]);
    const sent = cursor ? cursor.total : clampInt(params.get("from"), 0, 1_000_000, 0);
    const frontier = cursor ? cursor.frontier : clampInt(params.get("frontier"), 0, 1_000_000, sent);

    this.eventStreams.add(res);
    const cleanup = onRawResponseEnd(res, () => this.eventStreams.delete(res));
    const write = (chunk: string): boolean => {
      if (res.writableEnded || res.destroyed) {
        cleanup();
        return false;
      }
      try {
        res.write(chunk);
        return true;
      } catch {
        cleanup();
        return false;
      }
    };
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no", // proxies must not buffer the stream
    });
    if (!write(": connected\n\n")) return;
    try {
      await this.live.subscribe(key, make, res, sent, frontier);
    } catch (err) {
      // Headers are already out — report in-band and close.
      if (write(`event: err\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`)) {
        res.end();
      }
    }
  }

  /** Shared guard for the sessions endpoints: user exists + caller may see it. */
  private requireUser(res: PanelReply, identity: DashboardIdentity, username: string): boolean {
    if (!username) {
      this.json(res, 400, { error: "username is required" });
      return false;
    }
    if (!this.canActFor(identity, username)) {
      this.json(res, 403, { error: "forbidden" });
      return false;
    }
    if (!this.store.getUser(username)) {
      this.json(res, 404, { error: `unknown user: ${username}` });
      return false;
    }
    return true;
  }

  private async serveRunnerBundle(res: PanelReply): Promise<void> {
    const bundle = this.opts.runnerBundle?.active() ?? null;
    if (!bundle) {
      this.json(res, 503, { error: "no healthy runner bundle is active" });
      return;
    }
    this.send(res, 200, "text/javascript; charset=utf-8", bundle.bytes, {
      "content-disposition": 'attachment; filename="runner.js"',
      "cache-control": "no-store",
      etag: `\"sha256-${bundle.sha}\"`,
      "x-octopus-runner-bundle-sha": bundle.sha,
    });
  }

  private async serveRunnerBundleSha(res: PanelReply): Promise<void> {
    const bundle = this.opts.runnerBundle?.active() ?? null;
    if (!bundle) {
      this.json(res, 503, { error: "no healthy runner bundle is active" });
      return;
    }
    this.send(res, 200, "text/plain; charset=utf-8", `${bundle.sha}\n`, {
      "cache-control": "no-store",
    });
  }

  /**
   * The two reply helpers every route uses.
   *
   * Once these buffered, gzipped, set the content length and remembered the
   * hardening headers — which is why the headers were only on responses that
   * went through them. All of that is the framework's now: `@fastify/helmet`
   * hardens EVERY reply including the ones nobody remembered, `@fastify/compress`
   * negotiates the encoding, and Fastify writes the length. What is left is the
   * panel's own shape, kept as methods so the ~150 call sites read unchanged.
   */
  private json(res: PanelReply, status: number, payload: unknown): void {
    replyJson(res, status, payload);
  }

  private send(
    res: PanelReply,
    status: number,
    contentType: string,
    body: string | Buffer,
    extraHeaders?: Record<string, string>,
  ): void {
    replyBody(res, status, contentType, body, extraHeaders);
  }

  // ── Session sources: moved wholesale to `sessionhub/service.ts` ──
  //
  // What used to live here — the Runner/bot-host merge, the dedupe, the read
  // fallback and the search fan-out — is now the SessionHubService, because
  // every one of those made a decision (whose sessions, which operations, what
  // may leave the process) that a second entry point would have to make again.
  // The routes above are transport.

}

/**
 * Which `authz.ts` rule a matched route declared it is served under.
 *
 * Read from Fastify's own route config rather than re-derived from the path, so
 * the two tables are compared by a test instead of by two matchers that have to
 * agree.
 */
function routeIdOf(req: PanelRequest): string {
  return (req.routeOptions.config as { routeId?: string } | undefined)?.routeId ?? "";
}

/** Browser navigation, as distinct from a script probing a page-shaped path. */
function requestsHtmlDocument(req: PanelRequest): boolean {
  const mode = String(req.headers["sec-fetch-mode"] ?? "").toLowerCase();
  const destination = String(req.headers["sec-fetch-dest"] ?? "").toLowerCase();
  const accept = String(req.headers.accept ?? "").toLowerCase();
  return mode === "navigate" || destination === "document" || accept.includes("text/html");
}

/** A bounded same-origin location suitable for the post-login Location header. */
function safeLoginNext(raw: string): string {
  if (!raw || raw.length > 4096 || !raw.startsWith("/") || raw.startsWith("//")) return "";
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return "";
  try {
    const base = "http://octopus.invalid";
    const parsed = new URL(raw, base);
    if (parsed.origin !== base) return "";
    // Reject encoded backslashes/control characters too. A redirect target is
    // too small a surface to depend on differences between URL decoders.
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (/[\\\u0000-\u001f\u007f]/.test(decodedPath)) return "";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "";
  }
}

/**
 * The credential handle for one presented bearer token.
 *
 * A `dt_` token is a device credential: revoking the device deletes its row, so
 * this handle names something that can genuinely end. It is a one-way
 * derivation of a secret and stays inside the process — it is pool-key material,
 * never a response field.
 */
function tokenCredential(presented: string): string {
  return `bt:${createHash("sha256").update(`cred:${presented}`).digest("hex").slice(0, 16)}`;
}
