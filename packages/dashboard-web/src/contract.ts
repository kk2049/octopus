/**
 * The one handoff between the server that authorises and the app that renders.
 *
 * ── What this may and may not carry ─────────────────────────────────────────
 *
 * It carries **trusted identity context**: who the server decided is asking,
 * which pages this composition actually serves them, and which page it just
 * served. It carries no credential — not the bearer, not the session id, not
 * the CSRF value (only the cookie NAMES, which are a deployment fact and are
 * read back out of `document.cookie` by the browser itself).
 *
 * ── Why it exists at all, given the backend is the sole authority ───────────
 *
 * Because navigation is not authorization. The old shell filtered its tabs
 * server-side through `routeIsAvailable` + audience so a tab could never point
 * at a 404/403; this payload is that same filtering, delivered as data instead
 * of as pre-rendered anchors. Everything in `identity` is a NAVIGATION HINT.
 * Every request the app makes is still authorised from scratch by Cedar, the
 * mutation gate and the capability kernel — and the app is written to render
 * whatever refusal comes back rather than to predict it.
 *
 * Deliberately shared as a type-only contract (a package subpath both sides
 * import) rather than two hand-kept copies: the last time this repository kept
 * "two lists that agree today" the two lists stopped agreeing.
 */

/** Which composition of the panel is being served. Mirrors `PanelSurface`. */
export type DashboardSurface = "full" | "bootstrap-v3";

/** Trusted Sessions+ meeting pane. Never passed into an Agent View frame. */
export interface DiscussionView {
  id: string; topic: string; agenda: string; status: string; members: string[]; convener: string; writable: boolean;
  settings: { filter: { model: string; effort: string; prompt: string }; secretary: { model: string; effort: string; prompt: string }; maxToolTurns: number; maxRepliesPerTurn: number };
  revision: number; memory: string; activity: string; activityText: string; createdAt: string; updatedAt: string;
}
export interface DiscussionDetail extends DiscussionView {
  messages: { seq: number; sender: string; text: string; role: string; triage: string; reason: string; created_at: string }[];
  events: { seq: number; agent: string; kind: string; text: string; created_at: string }[];
  uncertainDeliveries: { id: string; text: string }[];
}
export interface DiscussionSnapshot { enabled: boolean; canConvene: boolean; discussions: DiscussionView[]; selected?: DiscussionDetail }

/**
 * Theme ids understood by this Dashboard build.
 *
 * This closed value list is shared by the browser picker, the bootstrap
 * payload and the server write boundary. The Agent View wire remains a
 * bounded string on purpose; its independently built registry is checked
 * against this list at build/test time rather than widening the runtime trust
 * boundary into an arbitrary token map.
 */
export const DASHBOARD_THEME_IDS = [
  "classic",
  "aurora",
  "ink",
  "feishu",
  "deepseek",
  "apple",
] as const;

export type DashboardThemeId = (typeof DASHBOARD_THEME_IDS)[number];

/**
 * Decoded bytes of one `POST /api/attachments` chunk.
 *
 * This bounds the request window, not the file: a file of any size is sent as
 * `ceil(size / ATTACHMENT_CHUNK_BYTES)` sequential chunks. Its base64 plus the
 * JSON envelope stays below the panel's default 1,000,000-byte body window, so
 * the route needs no raised `bodyLimit`.
 */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;

/**
 * Who is asking, as the SERVER decided — never as the browser claims.
 *
 * `username: null` is the shared `auth_token`: a credential with no account
 * behind it, which is why it may read across accounts but may not author
 * anything. `session` is "this arrived on a real browser login", which is the
 * closest a web app gets to "a person is at the keyboard" and is the only
 * thing that may be offered an approval control.
 */
export interface DashboardViewer {
  username: string | null;
  admin: boolean;
  dev: boolean;
  deploy: boolean;
  /** The tier below `dev`: own tickets via the review lane. `dev` implies it. */
  contribute: boolean;
  session: boolean;
}

/** One top-level destination the server will actually serve to this viewer. */
export interface DashboardNavItem {
  /** Route id from the server's route table (`page.sessionsPlus`, …). */
  id: string;
  path: string;
  label: string;
}

/** Server-rendered onboarding facts for the overview page. */
export interface OverviewPageProps {
  /** Outside-reachable host used in the tutorial commands. */
  tutorialHost: string;
  /** True when the host above is a guess and the reader should be warned. */
  hostIsGuess: boolean;
  tokenPlaceholder: string;
  commands: {
    download: string;
    run: string;
    runOneline: string;
    daemon: string;
    windowsInstall: string;
  };
}

/** `/permissions` is about one account; an admin may be looking across. */
export interface PermissionsPageProps {
  owner: string;
  canEdit: boolean;
  /** Stable server-authored result when an OAuth callback renders this page. */
  connectionMessage?: { kind: "ok" | "err"; text: string };
}

/** The three user-selectable policy modes. `block` is display-only. */
export type PermissionStudioEditableMode = "deny" | "ask" | "allow";
export type PermissionStudioMode = PermissionStudioEditableMode | "block";

export type PermissionStudioExplainStage =
  | "authority"
  | "domain_audience"
  | "permit_ceiling"
  | "enforcement";

/** One server-authored link in an ordered EXPLAIN chain. */
export interface PermissionStudioExplainStep {
  stage: PermissionStudioExplainStage;
  title: string;
  detail: string;
  verdict?: string;
}

/**
 * A complete decision explanation. Every word is authored by the server; the
 * browser must not recreate policy evaluation from the surrounding fields.
 */
export interface PermissionStudioExplanation {
  verdict: string;
  summary?: string;
  steps: PermissionStudioExplainStep[];
}

export interface PermissionStudioDomain {
  id: string;
  title: string;
  kind: "personal" | "organization" | "workspace" | "shared";
  authorityLabel: string;
  historyPolicy: "all" | "since_join" | "not_applicable";
  description?: string;
}

export type PermissionStudioEnforcement =
  | "enforced"
  | "intent-only"
  | "compatibility"
  | "unenforced";

export interface PermissionStudioResource {
  id: string;
  /** Canonical hierarchical address; stable ids remain the enforcement key. */
  uri: string;
  title: string;
  kind: string;
  domainId: string;
  authorityLabel: string;
  sensitivity: "normal" | "sensitive" | "credential";
  sourceSystem: string;
  enforcement: PermissionStudioEnforcement;
  description?: string;
}
export interface PermissionStudioResourceAlias {
  uri: string;
  targetUri: string;
}


export interface PermissionStudioHolder {
  id: string;
  title: string;
  kind:
    | "user"
    | "app"
    | "agent"
    | "organization"
    | "workspace"
    | "service"
    | "credential";
  description?: string;
}

/** One projected resource × holder × operation decision. */
export interface PermissionStudioPermit {
  id: string;
  resourceId: string;
  holderId: string;
  operation: string;
  operationLabel: string;
  mode: PermissionStudioMode;
  /** Final, server-authored verdict. It is rendered verbatim. */
  verdict: string;
  /** The sole signal that permits the browser to offer mutation controls. */
  editable: boolean;
  readonlyReason?: string;
  /** A compatibility projection may be inspected but is normally read-only. */
  compatibility?: boolean;
  explanation: PermissionStudioExplanation;
}

export interface PermissionStudioAppDefaults {
  title: string;
  description: string;
  /** observe/read/modify/execute reuse the permit shape and its per-item `editable`. */
  permits: PermissionStudioPermit[];
}

/** A trusted policy-program rule, kept separate from concrete permit holders. */
export interface PermissionStudioPolicy {
  id: string;
  title: string;
  resourceId: string;
  authorityLabel: string;
  effect: PermissionStudioMode;
  mandatory: boolean;
  /** Server-authored summaries of the rule selectors. */
  subjectSelector: string;
  operationSelector: string;
  /** Null means the selector is static; otherwise the rule needs runtime facts. */
  condition: string | null;
  verdict: string;
  enforcement: PermissionStudioEnforcement;
  explanation: PermissionStudioExplanation;
}

/** GET `/api/permissions/studio?username=...` */
export interface PermissionStudioProjection {
  version: 2;
  username: string;
  /** Opaque projection revision for display/debug correlation only. */
  revision: string;
  /** Whether bounded compatibility inventories were fully expanded. */
  coverage: { complete: boolean; notices: string[] };
  domains: PermissionStudioDomain[];
  resources: PermissionStudioResource[];
  /** Active URL-flavoured subtree redirects. They organize resources, not existing permits. */
  aliases: PermissionStudioResourceAlias[];
  holders: PermissionStudioHolder[];
  permits: PermissionStudioPermit[];
  /** Dynamic/static trusted rules are not concrete holder × resource permits. */
  policies: PermissionStudioPolicy[];
  /** Server-authored meaning of an absent matrix cell. */
  emptyCell: { label: string; explanation: string };
  /** Defaults for the next App authorization draft, never an existing grant. */
  appDefaults: PermissionStudioAppDefaults;
}

/** POST `/api/permissions/studio/explain` */
export interface PermissionStudioExplainRequest {
  username: string;
  resource_id: string;
  holder_id: string;
  operation: string;
  /** Absent for a read-only explanation of the current decision. */
  proposed_mode?: PermissionStudioEditableMode;
}

export interface PermissionStudioExplainResponse {
  /** Opaque, server-bound proposal; no policy particulars are echoed on APPLY. */
  proposal_id?: string;
  verdict: string;
  summary?: string;
  steps: PermissionStudioExplainStep[];
}

/** POST `/api/permissions/studio/apply` */
export interface PermissionStudioApplyRequest {
  username: string;
  proposal_id: string;
}

export interface PermissionStudioApplyResponse {
  status: "applied" | "pending" | "refused";
  message: string;
}

/** `/pending` is a compatibility landing for the shell's approval drawer. */
export interface PendingPageProps {
  username: string;
  hasSession: boolean;
}

/** Public identity of the Session Plus release this process serves. */
export interface SessionPlusIdentityProps {
  stableAppId: string;
  publisher: string;
  packageDigest: string;
  permissionContractDigest: string;
  viewOrigin: string;
  viewUrl?: string;
  frameAncestors: string[];
  development: boolean;
  contractOperations: string[];
}

export interface SessionPlusAuthorizationEntry {
  operation: string;
  title: string;
  description: string;
  granted: boolean;
  effective: boolean;
  alwaysApprove: boolean;
  explanation: string;
}

export interface SessionPlusAuthorizationProps {
  source: string | null;
  editable: boolean;
  needsAuthorization: boolean;
  contractChanged: boolean;
  publisherChanged: boolean;
  entries: SessionPlusAuthorizationEntry[];
}

/** Publisher-trust gate, shown before any frame exists. */
export interface SessionPlusConsentProps {
  mode: "consent";
  identity: SessionPlusIdentityProps;
  reason: string;
  decision: {
    publisher: string;
    packageDigest: string;
    scope: string;
    decidedAt: string;
  } | null;
  release: unknown;
}

/** The trusted chrome around a live Agent View. */
export interface SessionPlusAppProps {
  shareId?: string;
  /** A named administrator viewing and acting as this account (`?as=`). */
  actingAs?: string;
  mode: "app";
  identity: SessionPlusIdentityProps;
  /** `first_party`: a release built from this repository, trusted without a consent row. */
  trustReason: "exact_release" | "publisher_updates" | "first_party";
  authorization: SessionPlusAuthorizationProps;
  /** Parent-only typed-resource epoch. It is never copied into the Agent View boot payload. */
  resourceGeneration: number;
  /** First projection handed to the view. Declassified data only. */
  projection: unknown;
}

export type SessionPlusPageProps = SessionPlusConsentProps | SessionPlusAppProps;

/**
 * One content-free browser performance window reported by trusted Sessions+
 * chrome. These are observations, never authority: no resource identity,
 * transcript text, URL, proposal payload or instance handle belongs here.
 */
export interface SessionPlusPerformanceReport {
  version: 2;
  windowMs: number;
  projectionCount: number;
  sessionRowsMax: number;
  sourceRowsMax: number;
  transcriptWindowsMax: number;
  transcriptMessagesMax: number;
  projectionDispatchMaxMs: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  timerLagCount: number;
  timerLagMaxMs: number;
  viewReportCount: number;
  viewInputEventCount: number;
  viewInputFrameCount: number;
  viewInputFrameTotalMs: number;
  viewInputFrameMaxMs: number;
  viewInputFrameOver50Count: number;
  viewProjectionCommitCount: number;
  viewProjectionCommitTotalMs: number;
  viewProjectionCommitMaxMs: number;
  viewProjectionFrameCount: number;
  viewProjectionFrameTotalMs: number;
  viewProjectionFrameMaxMs: number;
  viewLongTaskCount: number;
  viewLongTaskTotalMs: number;
  viewLongTaskMaxMs: number;
  viewTimerLagCount: number;
  viewTimerLagMaxMs: number;
  viewDomNodesMax: number;
}

export interface LoginPageProps {
  rejected: boolean;
  reason: string | null;
  next: string;
  githubEnabled: boolean;
}

export interface RegisterPageProps {
  /** Mutable GitHub login, display-only; never the identity anchor. */
  label: string;
  error: string | null;
}

/**
 * `/apps` takes no server-rendered props.
 *
 * Everything on it comes from `GET /api/apps`, which is re-authorised on every
 * poll. A page that had been handed a snapshot at render time would keep showing
 * an active release after an admin bit was withdrawn in another tab.
 */
export type AppsPageProps = Record<string, never>;

/**
 * The identity of one declared App, as the trusted shell is told it.
 *
 * Everything here is already visible to a person looking at the page: the App's
 * own name, who published it, the digest that names the frame's hostname, and
 * that hostname itself. There is no owner, credential or instance handle.
 * Reviewed resource Apps also receive the server's
 * permission counts, using the same authority as the permission centre.
 */
export interface DeclaredAppIdentityProps {
  stableAppId: string;
  publisher: string;
  title: string;
  packageDigest: string;
  viewOrigin: string;
  viewUrl?: string;
  resourcePermissions?: {
    requestedCount: number;
    grantedCount: number;
    effectiveCount: number;
  };
}

/** Publisher-trust gate for a declared App. No frame exists until it is answered. */
export interface AppOpenConsentProps {
  mode: "consent";
  app: DeclaredAppIdentityProps;
  reason: string;
}

/** The trusted chrome around a live declared-App Agent View. */
export interface AppOpenAppProps {
  mode: "app";
  app: DeclaredAppIdentityProps;
  /** First projection handed to the view. This account's own App state. */
  projection: unknown;
  /**
   * Shared-scope Apps only: the server-minted instance key this tab opened
   * (`asi_…`). Shown so a member can copy the share link — knowing the key,
   * while logged in, IS the invitation (ADR 0007 P1). Absent for
   * account-scoped Apps, whose state has no instance to name.
   */
  instanceKey?: string;
  /**
   * Trusted same-window navigation for a product whose shared instances are
   * projects. Never forwarded to the App iframe; it contains membership and
   * instance lookup data that belong to the Dashboard Host.
   */
  workspace?: SharedWorkspaceProps;
  /** Why the publisher door is open; `first_party` has no consent to revoke. */
  trustReason?: "exact_release" | "publisher_updates" | "first_party";
}

/** One declared role of a shared-scope App, as `app.yaml` declares it. */
export interface SharedRoleSpecProps {
  role: string;
  /** How many members may hold this role at once. */
  max: number;
  /** Watch-only: barred from every action that does not name the role. */
  observer: boolean;
}

/** One role's seat availability on one shared instance. */
export interface SharedRoleSeatProps extends SharedRoleSpecProps {
  taken: number;
  /**
   * Whether a share-link visitor may take this seat themselves. A privileged
   * role (an approver, a first player, a project owner) is assigned only by
   * the instance creator. Absent from older servers, where every seat was.
   */
  joinable?: boolean;
}

/**
 * A share link landed on a shared instance the viewer has not joined. Picking
 * a free seat is the whole ceremony: there is no invitation object and no
 * approval step — the ACL row this page's one POST creates is the membership.
 */
export interface AppOpenJoinProps {
  mode: "join";
  app: DeclaredAppIdentityProps;
  instanceKey: string;
  seats: SharedRoleSeatProps[];
  /** Present when joining is rendered inside the trusted project workbench. */
  workspace?: SharedWorkspaceProps;
}

/** One shared instance this viewer is a member of, for the picker list. */
export interface SharedInstanceSummaryProps {
  instanceKey: string;
  createdAt: string;
  creator: string;
  /** The viewer's own role on this instance. */
  role: string;
  /** Current member count, all roles together. */
  members: number;
  /** Viewer-scoped display title derived from this instance's App projection. */
  title?: string;
  /** Display-only lifecycle fact derived from the same projection. */
  archived?: boolean;
  /** Most recent projected activity timestamp, when the App supplies one. */
  activityAt?: string;
  /** Creator-only trusted-shell controls; never handed to the App iframe. */
  manageable?: boolean;
  memberRows?: Array<{ username: string; role: string; joinedAt: string }>;
}

/**
 * Trusted membership directory for one shared App View. The same-origin shell
 * keeps this complete shape for management and may declassify only bounded
 * refs, titles and lifecycle display state into an App-specific projection.
 */
export interface SharedWorkspaceProps {
  projects: SharedInstanceSummaryProps[];
  roles: SharedRoleSpecProps[];
  /** Current URL/default selection. It may name a not-yet-joined invitation. */
  currentInstanceKey?: string;
  /**
   * The directory continues past `projects`: pass this to
   * `GET /api/apps/:app/shared-instances?cursor=` for the next window. Each
   * window bounds projection fan-out per request, never the number of projects.
   */
  nextCursor?: string;
  /** Existing allow-listed external hosts; absence keeps Agent binding UI out. */
  externalHosts?: ExternalAppHostProps[];
}

/**
 * One external host this deployment allows (`external-app-host/v1`).
 *
 * Availability metadata, exactly like navigation: the page renders the choice,
 * the server re-decides it. An origin appearing here is an operator statement,
 * never something the page may add to.
 */
export interface ExternalAppHostProps {
  id: string;
  label: string;
  origin: string;
}

/** A shared-scope App opened with no instance named: pick one, or create one. */
export interface AppOpenInstancesProps {
  mode: "instances";
  app: DeclaredAppIdentityProps;
  roles: SharedRoleSpecProps[];
  instances: SharedInstanceSummaryProps[];
  /** Empty = this deployment allows no external host; the section is absent. */
  externalHosts?: ExternalAppHostProps[];
  /** Empty project workbench presentation; generic shared Apps omit it. */
  workspace?: SharedWorkspaceProps;
}

export type AppOpenPageProps =
  | AppOpenConsentProps
  | AppOpenAppProps
  | AppOpenJoinProps
  | AppOpenInstancesProps;

export type DashboardPageProps =
  | OverviewPageProps
  | PermissionsPageProps
  | PendingPageProps
  | SessionPlusPageProps
  | { sessionPlus: SessionPlusPageProps }
  | AppOpenPageProps
  | LoginPageProps
  | RegisterPageProps
  | Record<string, never>;

/**
 * The payload the server inlines into every app document.
 *
 * `page` is the route id the server authorised for THIS document, which is what
 * lets the app mount the right screen without a second round trip and without
 * a client-side guess about what the server would have allowed.
 */
export interface DashboardBootstrap {
  /** Content hash of the served bundle. A change means "reload to update". */
  buildId: string;
  surface: DashboardSurface;
  features: string[];
  viewer: DashboardViewer;
  nav: DashboardNavItem[];
  /** Route ids of every page this composition serves this viewer. */
  pages: string[];
  /** Route ids that exist only to redirect, and where they go. */
  redirects: Record<string, string>;
  /** May the trusted approval pill/drawer be rendered at all. */
  approvals: boolean;
  /** Cookie names this deployment may have issued the CSRF secret under. */
  csrfCookieNames: string[];
  /**
   * This account's server-side theme choice. `null` means this identity has no
   * account preference, so the browser may use its versioned local cache.
   */
  themePreference: DashboardThemeId | null;
  /** Route id of the page this document is. */
  page: string;
  pageProps: DashboardPageProps;
}

/** `<script type="application/json">` id carrying {@link DashboardBootstrap}. */
export const BOOTSTRAP_ELEMENT_ID = "octopus-bootstrap";

/**
 * `<script type="application/json">` id carrying THIS TAB's Agent View instance
 * handle, in its own block so the app can read it once and delete it.
 *
 * It is separate from the bootstrap on purpose: the bootstrap is read whenever
 * something wants it, and this must be read exactly once and then be gone from
 * the document.
 *
 * Renamed from the Session-Plus-specific name when a second trusted host page
 * appeared (`/apps/<id>/open`). The mechanism was never Session Plus's — one
 * page composes one App's frame and hands it one handle — and a second element
 * with the same shape would have been a second thing to keep in step.
 */
export const APP_INSTANCE_ELEMENT_ID = "octopus-app-instance";

/** Response header carrying the running build id, for stale-tab detection. */
export const BUILD_ID_HEADER = "x-octopus-build";
/** Authenticated deployment attribution; never included in the public edge snapshot. */
export interface DeploymentOrigin {
  intent_id: number;
  actor: string;
  kind: "web" | "cli_api" | "ticket_agent" | "cli_agent" | "unknown";
  ticket_id?: number;
  ticket_title?: string;
  agent?: string;
  session?: string;
  device?: string;
}

/**
 * Ticket-authorized, immutable repository source. No host-file authority.
 * A file arrives in byte windows (`offset` → `next_offset`, cut between UTF-8
 * characters) and a directory in pages (`next_cursor`), so any size is readable.
 */
export type TicketFilesResponse = {
  path: string;
  revision: string;
  source: "ticket" | "base";
  /** Git object id of this blob or tree: windows and pages assemble only within one object. */
  object: string;
} & (
  | {
    kind: "directory";
    /** One page, directories first then by name. */
    entries: Array<{ name: string; path: string; kind: "directory" | "file" }>;
    /** Browsable entries in the whole directory. */
    total: number;
    /** Entries whose names this route cannot address (a control character or a backslash). */
    unlisted?: number;
    next_cursor?: string;
  }
  | { kind: "file"; text: string; size: number; offset: number; next_offset?: number }
);

/** Owner-scoped Runner metadata for ticket creation; these choices are not grants. */
export interface TicketExecutionOptions {
  sources: Array<{ id: string; device: string; source: "codex" | "claude"; quota?: import("@claude-bot/agent-sessions-contract").CodexAccountRegistration["quota"]; split_execution: boolean; label: string; available: boolean; reason?: string;
    /** The Runner's own reason an installed Agent is unavailable; `path` reaches only the device owner. */
    diagnostic?: { code: string; path?: string; rule?: string } }>;
  workspaces: Array<{ id: string; device: string; codex_remote: boolean; label: string; available: boolean; reason?: string }>;
  source_default: string;
  workspace_default: string;
}

/** Private agent activity for the current authenticated App scope. */
export interface AppAgentActivity {
  id: string;
  agent: string;
  state: "running" | "reconnecting" | "waiting_resource" | "waiting_approval" | "ended" | "failed" | "unknown" | "stopped";
  updatedAt: string;
  reply: string | null;
  canStop: boolean;
}

/** Public presentation shared by the overview producer and browser. */
export interface RunnerCapabilityView {
  kind: "builtin" | "extension";
  id: string; title: string;
  status: "ready" | "loading" | "disabled" | "error" | "unavailable";
  protocol?: string; version?: string; revision?: string; reason?: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }>;
}
