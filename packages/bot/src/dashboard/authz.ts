/**
 * Who may do what on the panel — one policy, one evaluator, one table.
 *
 * ── The failure this exists to prevent ──────────────────────────────────
 *
 * The rules used to live as boolean expressions inline in 45 route handlers:
 * `identity.admin || identity.username === username` here, `identity.dev`
 * there, `Boolean(identity.username) && identity.username === username`
 * somewhere else. Nothing enumerated the routes and nothing named the rules, so
 * the way this goes wrong is a route that checks the *wrong* expression — which
 * is exactly what P1-4 was: `/api/deploy/confirm` accepted a rollback decision
 * from anyone with `dev`, because the `deploy` check lived in a sibling `if`.
 *
 * Two structural answers, and it matters which does what:
 *
 *  1. **The table below.** Every path the panel serves names an ACTION and says
 *     where its target account comes from. A path with no entry is a 404, so
 *     "somebody added a route and forgot the check" is not a state this file can
 *     be in — the route simply does not exist until it is listed.
 *  2. **Cedar for the rules themselves** (`@cedar-policy/cedar-wasm`, AWS; the
 *     evaluator is formally verified and the same one behind Verified
 *     Permissions). The policy is DATA — eight rules, in one place, in a
 *     language for exactly this — instead of an expression per call site.
 *     `validate()` checks the policies against the schema at startup, so a typo
 *     in an attribute name is a boot failure rather than a silent `false`.
 *
 * Cedar is in-process (WASM), which is why it is acceptable here at all: an
 * authorization *service* on the deny path means the panel stops working when
 * it is down. That is the reason SpiceDB/OpenFGA were rejected —
 * `doc/handover-security-migration.md` §2⑤, do not re-litigate it.
 *
 * ── Where the target account comes from, and the seam that creates ──────
 *
 * Account-level authorization lives in the table. Object-level authorization
 * (this ticket, this pending call, this session id) stays with the handler that
 * loaded the object — the gate has not read the database and must not pretend
 * to have.
 *
 * Some routes take the account in the request BODY, which the pre-dispatch gate
 * cannot read without consuming it. Those are marked `deferred`: the gate
 * enforces that the caller is authenticated and the handler then calls the
 * matching action selector (`mayRead`, `mayWriteAs`, `mayManageConnection`),
 * which reaches the SAME policy. The call site count does not go down for
 * those — what goes down to one is the number of places that decide what
 * `admin` means.
 */

import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import {
  featureDisabledMessage,
  featureEnabled,
  PANEL_FEATURE,
  type EnabledPanelFeatures,
  type PanelFeature,
} from "./features.js";

/**
 * Who is asking, as the policy sees them.
 *
 * Deliberately its own type rather than the panel's `DashboardIdentity`: this
 * module must be testable without a server, and the identity carries a session
 * OBJECT (with token and CSRF hashes in it) where the policy needs only the
 * boolean "did this arrive on a browser session". Narrowing here is what keeps
 * a secret from reaching a decision that does not need it.
 */
export interface PanelSubject {
  /** Absent = the shared `auth_token`: a credential with no account behind it. */
  username?: string;
  admin: boolean;
  dev: boolean;
  deploy: boolean;
  /**
   * The tier below `dev` (2026-08-20): may file and follow their OWN tickets
   * and read the architecture atlas, but lands through review rather than a
   * fast-forward. `dev` implies it at resolution time (capability-bits.ts),
   * so the policy only ever has to ask about this one bit.
   */
  contribute: boolean;
  session: boolean;
}

/** Cedar identifiers, kept in one place so the policy text and the table agree. */
const NS = "Panel";
const USER = `${NS}::User`;
const ACCOUNT = `${NS}::Account`;
const SURFACE = `${NS}::Surface`;
const ACTION = `${NS}::Action`;

/** The one surface entity every global action is asked about. */
const PANEL = "panel";

/**
 * `named` is the presence of an account behind the credential — the shared
 * `auth_token` has none, and that absence is what stops it writing anything
 * that carries an author's name. `session` is "this arrived on a browser
 * session", which is the closest a web app gets to "a person is here".
 */
const SCHEMA = `
namespace ${NS} {
  entity Account;
  entity Surface;
  entity User in [Account] = {
    admin: Bool,
    dev: Bool,
    deploy: Bool,
    contribute: Bool,
    named: Bool,
    session: Bool,
  };
  action View, UseDev, Contribute, Deploy, Administer
    appliesTo { principal: User, resource: Surface, context: {} };
  action ReadAccount, WriteAccount, Identify, Approve, ManageConnection
    appliesTo { principal: User, resource: Account, context: {} };
}
`;

/**
 * The whole authorization policy of the panel. Default-deny: anything not
 * permitted here is refused, including a route whose action nobody wrote a rule
 * for.
 *
 * `principal in resource` is "this user IS that account" — the User entity gets
 * the Account of the same name as its parent, and the shared key gets no parent
 * at all, so it is inside nobody.
 */
const POLICIES = `
// Shared read-only surfaces. Getting through the identity gate is the whole
// requirement: the overview page, the health check, the login-adjacent pages.
permit(principal, action == ${ACTION}::"View", resource);

// Reading one account's material: the owner, or an admin looking across. This
// is the cross-user READ predicate and admin does grant it.
permit(principal, action == ${ACTION}::"ReadAccount", resource)
when { principal.admin || principal in resource };

// Acting as an account: the owner, or a NAMED administrator (owner decision,
// 2026-10-15: "admin 用户对其他的用户的权限也可以无限大"). Handlers that write
// on another account's behalf record the acting administrator in that
// account's audit/log. The shared key names nobody and still authors nothing.
permit(principal, action == ${ACTION}::"WriteAccount", resource)
when { principal.named && (principal.admin || principal in resource) };

// The dev pipeline is a shared workspace — one ticket list, one set of agent
// transcripts, visible to everyone in it. So membership is the boundary, and
// it is off by default.
permit(principal, action == ${ACTION}::"UseDev", resource)
when { principal.dev };

// Entering the ticket workspace as a contributor: the routes a contributor
// shares with full members (filing, following and steering one's own tickets,
// the architecture atlas). The handlers narrow the OBJECT — a contributor sees
// their own rows, a dev member sees everyone's — because the gate has not read
// the ticket and must not pretend to have. dev implies contribute at
// resolution time, so this is "member or contributor" without saying it twice.
permit(principal, action == ${ACTION}::"Contribute", resource)
when { principal.contribute };

// Triggering a deploy, landing a branch, deciding the rescue window.
permit(principal, action == ${ACTION}::"Deploy", resource)
when { principal.deploy };

// Handing out capabilities. Admin comes from config, never from this table,
// so this rule cannot be used to make more admins.
permit(principal, action == ${ACTION}::"Administer", resource)
when { principal.admin };

// Queues and pages that belong to a person rather than to the host. The shared
// key is not a person and gets nothing here, admin bit or not.
permit(principal, action == ${ACTION}::"Identify", resource)
when { principal.named && principal in resource };

// Approving a dangerous call. A bearer token proves a credential exists
// somewhere; a session is the closest thing to a human at a keyboard.
permit(principal, action == ${ACTION}::"Approve", resource)
when { principal.named && principal.session && principal in resource };

// Linking or replacing an external identity is stronger than an ordinary
// account write: it requires the owner to be present in a browser session.
permit(principal, action == ${ACTION}::"ManageConnection", resource)
when { principal.named && principal.session && principal in resource };
`;

export const PANEL_ACTIONS = [
  "View",
  "ReadAccount",
  "WriteAccount",
  "UseDev",
  "Contribute",
  "Deploy",
  "Administer",
  "Identify",
  "Approve",
  "ManageConnection",
] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

/** Actions asked about the panel as a whole rather than about one account. */
const GLOBAL_ACTIONS = new Set<PanelAction>(["View", "UseDev", "Contribute", "Deploy", "Administer"]);

const PSET_ID = "panel";
const SCHEMA_NAME = "panel";

/**
 * Parse, validate and cache the policy set at module load.
 *
 * Deliberately at load rather than on first request: a policy that does not
 * compile, or that references an attribute the schema does not have, must stop
 * the process from starting. A lazily-validated policy is a policy that fails
 * on the first request after a deploy, which is the worst possible moment.
 */
function compilePolicy(): void {
  const schema = cedar.checkParseSchema(SCHEMA);
  if (schema.type !== "success") {
    throw new Error(`panel authz schema does not parse: ${describe(schema.errors)}`);
  }
  const parsed = cedar.checkParsePolicySet({ staticPolicies: POLICIES });
  if (parsed.type !== "success") {
    throw new Error(`panel authz policy does not parse: ${describe(parsed.errors)}`);
  }
  // The check that catches typos: `principal.dveloper` parses fine and is
  // always false at runtime, but fails validation against the schema. This is
  // most of the reason to use a policy language rather than boolean expressions
  // — a misspelled attribute in an `if` is a silent permanent deny.
  const validated = cedar.validate({ schema: SCHEMA, policies: { staticPolicies: POLICIES } });
  if (validated.type !== "success") {
    throw new Error(`panel authz policy does not validate: ${describe(validated.errors)}`);
  }
  if (validated.validationErrors.length > 0) {
    throw new Error(
      `panel authz policy does not validate: ${validated.validationErrors.map((e) => JSON.stringify(e)).join("; ")}`,
    );
  }
  const pset = cedar.preparsePolicySet(PSET_ID, { staticPolicies: POLICIES });
  if (pset.type !== "success") throw new Error(`panel authz policy cache failed: ${describe(pset.errors)}`);
  const cached = cedar.preparseSchema(SCHEMA_NAME, SCHEMA);
  if (cached.type !== "success") throw new Error(`panel authz schema cache failed: ${describe(cached.errors)}`);
}

function describe(errors: readonly { message: string }[]): string {
  return errors.map((e) => e.message).join("; ");
}

compilePolicy();

/**
 * One authorization decision.
 *
 * Errors are denials, not exceptions: an evaluator that cannot answer must not
 * let the request through, and a route that gets a `deny` it did not expect is
 * a bug we want to see as a 403 rather than as a 500 with a stack trace.
 */
export function authorize(viewer: PanelSubject, action: PanelAction, account: string): boolean {
  const global = GLOBAL_ACTIONS.has(action);
  const named = Boolean(viewer.username);
  const principal = { type: USER, id: named ? viewer.username! : "*anonymous*" };
  const resource = global ? { type: SURFACE, id: PANEL } : { type: ACCOUNT, id: account };
  const entities: cedar.Entities = [
    {
      uid: principal,
      attrs: {
        admin: viewer.admin,
        dev: viewer.dev,
        deploy: viewer.deploy,
        contribute: viewer.contribute,
        named,
        session: viewer.session,
      },
      // The parent link IS "this credential belongs to this account". A shared
      // key has no parent, so `principal in resource` is false everywhere.
      parents: named ? [{ type: ACCOUNT, id: viewer.username! }] : [],
    },
    { uid: resource, attrs: {}, parents: [] },
  ];
  if (!global && named && account !== viewer.username) {
    entities.push({ uid: { type: ACCOUNT, id: viewer.username! }, attrs: {}, parents: [] });
  }
  const answer = cedar.statefulIsAuthorized({
    principal,
    action: { type: ACTION, id: action },
    resource,
    context: {},
    preparsedPolicySetId: PSET_ID,
    preparsedSchemaName: SCHEMA_NAME,
    validateRequest: true,
    entities,
  });
  return answer.type === "success" && answer.response.decision === "allow";
}

/**
 * What a viewer must be, to be told about an account at all.
 *
 * These two are the former `canActFor` / `canWriteAs`, now thin: they choose an
 * action, and the meaning of the action is in the policy text above. They exist
 * because some routes only learn their target account after parsing a body, and
 * for those the handler is the only place that can ask.
 */
export function mayRead(viewer: PanelSubject, account: string): boolean {
  return authorize(viewer, "ReadAccount", account);
}

/** May write content SIGNED AS this account. Owner only; admin does not grant it. */
export function mayWriteAs(viewer: PanelSubject, account: string): boolean {
  return authorize(viewer, "WriteAccount", account);
}

/** May link or remove an external identity for this account. Owner session only. */
export function mayManageConnection(viewer: PanelSubject, account: string): boolean {
  return authorize(viewer, "ManageConnection", account);
}

/**
 * Where a route's target account comes from.
 *
 * `self` and `query` can be resolved before dispatch from the URL alone.
 * `body` cannot — the gate would have to consume the request — so those routes
 * are authorized for their action against the caller's own account, and the
 * handler re-asks that same action with the real target once it has parsed one.
 * `none` is for the global actions, which have no account.
 */
export type TargetSource = "none" | "self" | "query" | "body";

export interface RouteRule {
  /** Stable id, so tests and audit logs can name a route without a regex. */
  id: string;
  method: "GET" | "POST" | "ANY";
  /** Exact pathname, or a prefix when it ends in `*`. */
  path: string;
  action: PanelAction;
  target: TargetSource;
  /**
   * Configuration feature that must be enabled for this route to exist.
   *
   * This is deliberately one data field rather than one boolean per optional
   * subsystem. The surface answers "which composition is this process"; this
   * field answers "did that composition construct the named feature". Both are
   * absences and answer 404 before the normal Cedar authorization decision.
   */
  feature?: PanelFeature;
  /**
   * Wording for a refusal, when this route already had its own. Kept next to
   * the rule rather than in the handler: the sentence a person reads is part of
   * the decision, and it went stale every time the check moved.
   */
  refusal?: string;
  /**
   * The handler asks again with a target the gate could not see. Purely
   * documentation for the reader and for the coverage test — the gate behaves
   * the same either way.
   */
  deferred?: boolean;
}

/**
 * Every path the panel serves, in match order (longest/most specific first
 * within a prefix family).
 *
 * Routes handled BEFORE the identity gate are deliberately absent: `/login`,
 * `/logout`, `/download/runner.js` and the devpipe loopback answer for
 * themselves, because each has a credential rule that is not "who is this
 * viewer" — see `PRE_ROUTES` below and `server.ts`. Everything after the gate
 * is here or is a 404.
 */
export const ROUTES: readonly RouteRule[] = [
  { id: "api.sessionShares.list", method: "GET", path: "/api/session-shares/list", action: "Identify", target: "self", feature: PANEL_FEATURE.sessionPlus },
  { id: "api.sessionShares.options", method: "GET", path: "/api/session-shares/options", action: "Identify", target: "self", feature: PANEL_FEATURE.sessionPlus },
  { id: "api.sessionShares.create", method: "POST", path: "/api/session-shares/create", action: "Identify", target: "self", feature: PANEL_FEATURE.sessionPlus },
  { id: "api.sessionShares.request", method: "POST", path: "/api/session-shares/request", action: "Identify", target: "self", feature: PANEL_FEATURE.sessionPlus },
  { id: "api.sessionShares.decide", method: "POST", path: "/api/session-shares/decide", action: "Identify", target: "self", feature: PANEL_FEATURE.sessionPlus },
  { id: "api.sessionShares.revoke", method: "POST", path: "/api/session-shares/revoke", action: "Identify", target: "self", feature: PANEL_FEATURE.sessionPlus },
  { id: "api.sessionShares.reset", method: "POST", path: "/api/session-shares/reset", action: "Identify", target: "self", feature: PANEL_FEATURE.sessionPlus },
  // Pages
  { id: "page.overview", method: "GET", path: "/", action: "View", target: "none" },
  { id: "page.sessions", method: "GET", path: "/sessions", action: "View", target: "none" },
  // Session Plus: the Agentic App probe. Its App-owned state is account scoped,
  // so a shared admin key has no instance to open. The handler additionally
  // requires a real browser session; Cedar continues to express account
  // reachability with the existing actions rather than growing an App-specific
  // permission dialect.
  {
    id: "page.sessionsPlus",
    method: "GET",
    path: "/sessions-plus",
    action: "Identify",
    target: "self",
    feature: PANEL_FEATURE.sessionPlus,
  },
  // `Contribute` rather than `UseDev` (2026-08-20): a contributor enters the
  // same page and sees the rows the handler lets them see — their own. What
  // stays `UseDev`/`Deploy` below is everything that acts on the shared
  // watermark: landing, deploying, deciding a merge proposal.
  {
    id: "page.tickets",
    method: "GET",
    path: "/tickets",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.devPipeline,
  },
  // The architecture observatory. `Contribute`, exactly like /tickets: the atlas
  // carries paths, source excerpts and the internal shape of this codebase, so
  // it is the audience that is allowed to change this codebase — never the
  // shared read-only surface.
  {
    id: "page.architecture",
    method: "GET",
    path: "/architecture",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.architecture,
  },
  // The knowledge wiki: the same audience as the atlas for the same reason.
  {
    id: "page.knowledge",
    method: "GET",
    path: "/knowledge",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  { id: "page.admin", method: "GET", path: "/admin", action: "Administer", target: "none" },
  // Local Agentic App management. `Administer`, exactly like `/admin`: which
  // release this host serves is a host-level decision, not an account-level one,
  // and the admin bit comes from configuration rather than from a table this
  // page could write. It is deliberately NOT a store — there is no remote
  // catalogue, no search and no download; installing means handing this host a
  // bounded, pre-built artifact it validates from the bytes up.
  {
    id: "page.apps",
    method: "GET",
    path: "/apps",
    action: "Administer",
    target: "none",
    feature: PANEL_FEATURE.appRegistry,
  },
  // Opening one declared App's Agent View. Deliberately NOT `Administer`, and
  // the distinction is the point of the pair: `/apps` decides WHAT this host
  // serves (an administrator's decision about the machine), while this is a
  // person USING one of the things it serves. A declared App's durable state is
  // account-scoped, so the shared admin key — which names nobody — has no
  // instance to open here; the handler additionally requires a real browser
  // session, exactly as `/sessions-plus` does.
  //
  // A PREFIX rule because the app id is a path segment (`/apps/<id>/open`), and
  // `resolveRoute` matches literals and prefixes rather than parameters. It must
  // stay AFTER `page.apps`, which is an exact `/apps` — first match wins.
  {
    id: "page.appOpen",
    method: "GET",
    path: "/apps/*",
    action: "Identify",
    target: "self",
    feature: PANEL_FEATURE.appRegistry,
  },
  // The ordinary user's App launcher. `/apps` above answers "what does this
  // host PUBLISH" and is the operator's; this answers "what may I OPEN" and is
  // everyone's — before it existed, a non-admin had no way to DISCOVER an
  // activated App at all (the first real test user proved it). A tab is only a
  // navigation hint: opening still crosses `page.appOpen` + the trust door.
  {
    id: "page.launcher",
    method: "GET",
    path: "/launcher",
    action: "Identify",
    target: "self",
    feature: PANEL_FEATURE.appRegistry,
  },
  { id: "page.pending", method: "GET", path: "/pending", action: "Identify", target: "self" },
  // Permissions belong to an account, so the shared key — which names nobody —
  // gets nothing here, admin bit or not. An admin reading ACROSS accounts is
  // `ReadAccount` on the API routes below; the page itself is about self.
  { id: "page.permissions", method: "GET", path: "/permissions", action: "Identify", target: "self" },
  // Authenticated compatibility redirect into /permissions?view=tree.
  {
    id: "page.accessPreview",
    method: "GET",
    path: "/access-preview",
    action: "Identify",
    target: "self",
  },

  // Overview / health
  { id: "api.overview", method: "GET", path: "/api/overview", action: "View", target: "none" },
  { id: "api.check", method: "POST", path: "/api/check", action: "ReadAccount", target: "body", deferred: true },
  { id: "api.checkAll", method: "POST", path: "/api/check-all", action: "View", target: "none" },

  // Account preferences and devices
  {
    id: "api.themePreference",
    method: "POST",
    path: "/api/theme-preference",
    action: "Identify",
    target: "self",
    refusal: "主题偏好仅限具名账号修改",
  },
  {
    id: "api.runnerToken",
    method: "POST",
    path: "/api/runner-token",
    action: "ReadAccount",
    target: "body",
    deferred: true,
  },
  {
    id: "api.runnerDisplayName",
    method: "POST",
    path: "/api/runner-display-name",
    action: "ReadAccount",
    target: "body",
    deferred: true,
  },
  {
    id: "api.runnerOnlineNotice",
    method: "POST",
    path: "/api/runner-online-notice",
    action: "ReadAccount",
    target: "body",
    deferred: true,
  },
  {
    id: "api.runnerDelete",
    method: "POST",
    path: "/api/runner-delete",
    action: "ReadAccount",
    target: "body",
    deferred: true,
  },
  {
    id: "api.runnerLocalAgentBridge",
    method: "POST",
    path: "/api/runner-local-agent-bridge",
    action: "ManageConnection",
    target: "body",
    deferred: true,
    refusal: "Runner 发起权限仅限本人在浏览器中修改",
  },
  {
    id: "api.runnerDefaultAgentInjection",
    method: "POST",
    path: "/api/runner-default-agent-injection",
    action: "ManageConnection",
    target: "body",
    deferred: true,
    refusal: "Runner 默认注入仅限本人在浏览器中修改",
  },
  {
    id: "api.runnerGuiAutomation",
    method: "POST",
    path: "/api/runner-gui-automation",
    action: "ManageConnection",
    target: "body",
    deferred: true,
    refusal: "Runner GUI 自动化仅限本人在浏览器中修改",
  },

  // Session browser. Reads and writes are the owner's, or a named admin's.
  {
    id: "api.sessions.append",
    method: "POST",
    path: "/api/sessions/append",
    action: "WriteAccount",
    // The target is in the body, so the gate can only rule out credentials that
    // may never author anything (the shared key); the handler re-asks with the
    // real username.
    target: "body",
    deferred: true,
    refusal: "append 仅限本人或管理员操作 — 请用自己的 /dashboard 链接登录",
  },
  {
    id: "api.sessions.interaction",
    method: "POST",
    path: "/api/sessions/interaction",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "回答 Agent 请求仅限本人当前的网页登录操作",
  },
  // A submission's own lifecycle: the owner's, or the account a named admin is
  // acting on (`?username=`), exactly like the transcripts it is about.
  {
    id: "api.sessions.operations.stream",
    method: "GET",
    path: "/api/sessions/operations/stream",
    action: "ReadAccount",
    target: "query",
  },
  { id: "api.sessions.operations", method: "GET", path: "/api/sessions/operations", action: "ReadAccount", target: "query" },
  { id: "api.sessions.search", method: "GET", path: "/api/sessions/search", action: "ReadAccount", target: "query" },
  { id: "api.sessions.live", method: "GET", path: "/api/sessions/live", action: "ReadAccount", target: "query" },
  { id: "api.sessions.list", method: "GET", path: "/api/sessions", action: "ReadAccount", target: "query" },
  { id: "api.session", method: "GET", path: "/api/session", action: "ReadAccount", target: "query" },

  // Session Plus Group 1 owns presentation state only. These routes do not
  // reach a Runner or resource Context; their real-browser-session narrowing
  // and opaque per-tab binding live in the transport handler.
  { id: "api.sessionPlus.agentActivity", method: "GET", path: "/api/session-plus/agent-activity", action: "Identify", target: "self", feature: PANEL_FEATURE.sessionPlus },
  { id: "api.sessionPlus.agentStop", method: "POST", path: "/api/session-plus/agent-stop", action: "WriteAccount", target: "self", feature: PANEL_FEATURE.sessionPlus },
  {
    id: "api.sessionPlus.stream",
    method: "GET",
    path: "/api/session-plus/stream",
    action: "Identify",
    target: "self",
    feature: PANEL_FEATURE.sessionPlus,
  },
  {
    id: "api.sessionPlus.act",
    method: "POST",
    path: "/api/session-plus/act",
    action: "WriteAccount",
    target: "self",
    feature: PANEL_FEATURE.sessionPlus,
  },
  {
    id: "api.sessionPlus.performance",
    method: "POST",
    path: "/api/session-plus/performance",
    action: "WriteAccount",
    target: "self",
    feature: PANEL_FEATURE.sessionPlus,
  },
  {
    id: "api.sessionPlus.close",
    method: "POST",
    path: "/api/session-plus/close",
    action: "WriteAccount",
    target: "self",
    feature: PANEL_FEATURE.sessionPlus,
  },
  {
    id: "api.sessionPlus.reconstruct",
    method: "POST",
    path: "/api/session-plus/reconstruct",
    action: "WriteAccount",
    target: "self",
    feature: PANEL_FEATURE.sessionPlus,
  },
  {
    id: "api.sessionPlus.release",
    method: "GET",
    path: "/api/session-plus/release",
    action: "Identify",
    target: "self",
    feature: PANEL_FEATURE.sessionPlus,
  },
  {
    id: "api.sessionPlus.trust",
    method: "POST",
    path: "/api/session-plus/trust",
    action: "WriteAccount",
    target: "self",
    feature: PANEL_FEATURE.sessionPlus,
  },

  // Dev pipeline. Membership is the boundary for everything under it; the
  // deploy-shaped sub-actions need the stronger bit and say so below.
  {
    id: "api.land",
    method: "POST",
    path: "/api/land",
    action: "Deploy",
    target: "none",
    feature: PANEL_FEATURE.devPipeline,
  },
  {
    id: "api.deploy.post",
    method: "POST",
    path: "/api/deploy",
    action: "Deploy",
    target: "none",
    refusal: "不在 deployers 名单,不能触发上线",
  },
  {
    id: "api.deploy.confirm",
    method: "POST",
    path: "/api/deploy/confirm",
    action: "UseDev",
    target: "none",
    // A rollback decision needs `deploy`; a plain confirmation does not, and
    // that width is the point — "a human reached the public entrance" is
    // evidence anyone can supply. The distinction is per-body, so the handler
    // re-asks. This is P1-4's route.
    deferred: true,
  },
  // Reading deploy state is part of the ticket page a contributor already sees
  // (which branch is the base, whether a deploy is in flight); acting on it —
  // confirm, verify, trigger — keeps the stronger bits.
  { id: "api.deploy.active", method: "GET", path: "/api/deploy/active", action: "Contribute", target: "none" },
  { id: "api.deploy.get", method: "GET", path: "/api/deploy", action: "Contribute", target: "none" },
  { id: "api.deploy.check", method: "POST", path: "/api/deploy/check", action: "Deploy", target: "none" },
  { id: "api.verify", method: "ANY", path: "/api/verify*", action: "UseDev", target: "none" },
  {
    id: "api.dev.quota",
    method: "GET",
    path: "/api/dev/quota",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.devPipeline,
  },
  {
    id: "api.dev.systemStatus",
    method: "GET",
    path: "/api/dev/system-status",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.devPipeline,
  },
  // The review lane's maintainer face (2026-08-20). Reading the queue is a
  // member-level view of the shared workspace; deciding a proposal or starting
  // a batch merge changes what reaches the watermark, which is exactly what
  // `Deploy` has always meant ("landing a branch"). Exact paths, longest first.
  {
    id: "api.mergeQueue.decide",
    method: "POST",
    path: "/api/merge-queue/decide",
    action: "Deploy",
    target: "none",
    feature: PANEL_FEATURE.devPipeline,
    refusal: "审批合并提案需要 deploy 权限",
  },
  {
    id: "api.mergeQueue.run",
    method: "POST",
    path: "/api/merge-queue/run",
    action: "Deploy",
    target: "none",
    feature: PANEL_FEATURE.devPipeline,
    refusal: "执行批量合并需要 deploy 权限",
  },
  {
    id: "api.mergeQueue",
    method: "GET",
    path: "/api/merge-queue",
    action: "UseDev",
    target: "none",
    feature: PANEL_FEATURE.devPipeline,
  },
  // Architecture observatory: exact paths, refresh (the longer one) first.
  // All are `Contribute` (the page's own audience) — the projection discloses
  // the codebase's internal structure, and triggering a re-analysis spends this
  // host's CPU on it; both are things a person allowed to change this code may
  // already do.
  // The three evolution reads (commit axis, snapshot manifest, range diff)
  // disclose the same class of information from the same checkout.
  // Knowledge wiki. General reads are local projections (`Contribute`, like
  // the atlas). Conflict annotations and personal knowledge chats are shared
  // development context, so every collaboration read/write needs UseDev.
  {id:"api.knowledge.sources.read",method:"GET",path:"/api/knowledge/sources",action:"ReadAccount",target:"self",feature:PANEL_FEATURE.knowledge},
  {id:"api.knowledge.sources.import",method:"POST",path:"/api/knowledge/sources",action:"WriteAccount",target:"self",feature:PANEL_FEATURE.knowledge},
  {id:"api.knowledge.sources.confirm",method:"POST",path:"/api/knowledge/sources/confirm",action:"WriteAccount",target:"self",feature:PANEL_FEATURE.knowledge},
  {id:"api.knowledge.repairs.read",method:"GET",path:"/api/knowledge/repairs",action:"Contribute",target:"none",feature:PANEL_FEATURE.knowledge},
  {id:"api.knowledge.repairs.write",method:"POST",path:"/api/knowledge/repairs",action:"UseDev",target:"none",feature:PANEL_FEATURE.knowledge},
  {
    id: "api.knowledge.review.decide",
    method: "POST",
    path: "/api/knowledge/review/decide",
    action: "UseDev",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.knowledge.conflict.annotate",
    method: "POST",
    path: "/api/knowledge/conflict/annotate",
    action: "UseDev",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.knowledge.chat.write",
    method: "POST",
    path: "/api/knowledge/chat/send",
    action: "UseDev",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.knowledge.chats.write",
    method: "POST",
    path: "/api/knowledge/chats",
    action: "UseDev",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.knowledge.chat.read",
    method: "GET",
    path: "/api/knowledge/chat",
    action: "UseDev",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.knowledge.chats.read",
    method: "GET",
    path: "/api/knowledge/chats",
    action: "UseDev",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.knowledge.conflict",
    method: "GET",
    path: "/api/knowledge/conflict",
    action: "UseDev",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.knowledge.preview",
    method: "POST",
    path: "/api/knowledge/preview",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.knowledge.health",
    method: "GET",
    path: "/api/knowledge/health",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.knowledge",
    method: "GET",
    path: "/api/knowledge*",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.knowledge,
  },
  {
    id: "api.architecture.refresh",
    method: "POST",
    path: "/api/architecture/refresh",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.architecture,
  },
  {
    id: "api.architecture.commits",
    method: "GET",
    path: "/api/architecture/commits",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.architecture,
  },
  {
    id: "api.architecture.snapshots",
    method: "GET",
    path: "/api/architecture/snapshots",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.architecture,
  },
  {
    id: "api.architecture.diff",
    method: "GET",
    path: "/api/architecture/diff",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.architecture,
  },
  {
    id: "api.architecture",
    method: "GET",
    path: "/api/architecture",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.architecture,
  },
  {
    id: "api.tickets",
    method: "ANY",
    path: "/api/tickets*",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.devPipeline,
  },
  {
    // A screenshot on its way into a ticket body (ticket #201). Same audience,
    // same action and same feature as filing the ticket itself — it is one
    // gesture split across two requests, and a narrower gate here would only
    // mean the picture is refused after the person already pasted it.
    id: "api.attachments",
    method: "POST",
    path: "/api/attachments",
    action: "Contribute",
    target: "none",
    feature: PANEL_FEATURE.devPipeline,
  },

  // Permission centre. Reads are cross-user for an admin (the observation
  // lens); every WRITE is `WriteAccount`, i.e. owner-only — granting or
  // revoking somebody else's permissions is deciding for them, and the admin
  // bit deliberately does not carry that. Longest paths first, because
  // `resolveRoute` returns the first match.
  {
    id: "api.permissions.studio.explain",
    method: "POST",
    path: "/api/permissions/studio/explain",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "权限变更只能由本人预演 — 请用自己的 /dashboard 链接登录",
  },
  {
    id: "api.permissions.studio.apply",
    method: "POST",
    path: "/api/permissions/studio/apply",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "权限变更只能由本人应用 — 请用自己的 /dashboard 链接登录",
  },
  {
    id: "api.permissions.grant",
    method: "POST",
    path: "/api/permissions/grant",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "授权只能由本人决定 — 请用自己的 /dashboard 链接登录",
  },
  {
    id: "api.permissions.revoke",
    method: "POST",
    path: "/api/permissions/revoke",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "撤销只能由本人决定 — 请用自己的 /dashboard 链接登录",
  },
  {
    id: "api.permissions.websessions.revokeOthers",
    method: "POST",
    path: "/api/permissions/web-sessions/revoke-others",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "只能结束自己的登录会话",
  },
  {
    id: "api.permissions.websessions.revokeOne",
    method: "POST",
    path: "/api/permissions/web-sessions/revoke",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "只能结束自己的登录会话",
  },
  {
    id: "api.permissions.websessions",
    method: "GET",
    path: "/api/permissions/web-sessions",
    action: "ReadAccount",
    target: "query",
  },
  { id: "api.permissions.devices", method: "GET", path: "/api/permissions/devices", action: "ReadAccount", target: "query" },
  { id: "api.permissions.audit", method: "GET", path: "/api/permissions/audit", action: "ReadAccount", target: "query" },
  { id: "api.permissions.studio", method: "GET", path: "/api/permissions/studio", action: "ReadAccount", target: "query" },
  { id: "api.permissions.list", method: "GET", path: "/api/permissions", action: "ReadAccount", target: "query" },

  // External identity connections. Start/unbind are browser-session-only via
  // ManageConnection; their body target is re-checked by the handler after the
  // gate has admitted the caller against their own account.
  {
    id: "api.connections.github.start",
    method: "POST",
    path: "/api/connections/github/start",
    action: "ManageConnection",
    target: "body",
    deferred: true,
    refusal: "GitHub 绑定只能由本人发起 — 请用自己的浏览器会话登录",
  },
  {
    id: "api.connections.unbind",
    method: "POST",
    path: "/api/connections/unbind",
    action: "ManageConnection",
    target: "body",
    deferred: true,
    refusal: "身份解绑只能由本人决定 — 请用自己的浏览器会话登录",
  },
  { id: "api.connections.list", method: "GET", path: "/api/connections", action: "ReadAccount", target: "query" },

  // MCP surface. The endpoint itself is `Identify`/self: an mcp_ token maps to
  // a named account and acts only as it; the shared key names nobody and gets
  // nothing. The extra "mcp_ tokens reach ONLY this route" narrowing is
  // enforced in the transport gate — it is a property of the credential, not
  // of the account, and Cedar deliberately reasons about accounts.
  // Longest paths first, because `resolveRoute` returns the first match.
  {
    id: "api.mcp.tokens.create",
    method: "POST",
    path: "/api/mcp/tokens/create",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "MCP 令牌只能由本人签发 — 请用自己的 /dashboard 链接登录",
  },
  {
    id: "api.mcp.tokens.revoke",
    method: "POST",
    path: "/api/mcp/tokens/revoke",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "MCP 令牌只能由本人撤销 — 请用自己的 /dashboard 链接登录",
  },
  { id: "api.mcp.tokens.list", method: "GET", path: "/api/mcp/tokens", action: "ReadAccount", target: "query" },
  { id: 'api.discussions.read', method: 'GET', path: '/api/discussions', action: 'Identify', target: 'self' },
  { id: 'api.discussions.action', method: 'POST', path: '/api/discussions/action', action: 'Approve', target: 'self' },
  {
    id: "api.feishu.oauth.start",
    method: "POST",
    path: "/api/feishu/oauth/start",
    action: "ManageConnection",
    target: "body",
    deferred: true,
    refusal: "飞书授权只能由本人发起 — 请用自己的 /dashboard 链接登录",
  },
  { id: "api.feishu.oauth.status", method: "GET", path: "/api/feishu/oauth/status", action: "ManageConnection", target: "query" },
  {
    id: "api.mcp.rpc",
    method: "ANY",
    path: "/api/mcp",
    action: "Identify",
    target: "self",
    refusal: "MCP 端点需要具名令牌（mcp_ 或个人 dt_/浏览器登录）",
  },

  // dsh tentacle sharing.  The transport itself authenticates rt_ + mcp_ on
  // the Runner Gateway; these routes are the owner's trusted grant face.
  {
    id: "api.tentacle.revoke",
    method: "POST",
    path: "/api/tentacle/shares/revoke",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "dsh 共享只能由资源 owner 撤销",
  },
  {
    id: "api.tentacle.share",
    method: "POST",
    path: "/api/tentacle/shares",
    action: "WriteAccount",
    target: "body",
    deferred: true,
    refusal: "dsh 共享只能由资源 owner 决定",
  },
  { id: "api.tentacle.list", method: "GET", path: "/api/tentacle", action: "ReadAccount", target: "query" },

  // Capability approval face
  {
    id: "api.capabilities.decide",
    method: "POST",
    path: "/api/capabilities/pending/*",
    action: "Approve",
    target: "self",
  },
  {
    id: "api.capabilities.pending",
    method: "GET",
    path: "/api/capabilities/pending",
    action: "Identify",
    target: "self",
  },

  // Administration
  { id: "api.admin", method: "ANY", path: "/api/admin*", action: "Administer", target: "none" },

  // Agentic App releases. One rule per verb rather than one `ANY` prefix: these
  // are the calls that decide which code this host publishes, and an audit that
  // wants to ask "what may move the active pointer" should get one row per
  // answer. Longest paths first, because `resolveRoute` returns the first match.
  {
    id: "api.apps.hotswapDecision",
    method: "POST",
    path: "/api/apps/hotswap/*",
    action: "Administer",
    target: "none",
    feature: PANEL_FEATURE.appRegistry,
  },
  {
    id: "api.apps.publishPending",
    method: "POST",
    path: "/api/apps/publish-pending",
    action: "Administer",
    target: "none",
    feature: PANEL_FEATURE.appRegistry,
  },
  {
    id: "api.apps.install",
    method: "POST",
    path: "/api/apps/install",
    action: "Administer",
    target: "none",
    feature: PANEL_FEATURE.appRegistry,
  },
  {
    id: "api.apps.activate",
    method: "POST",
    path: "/api/apps/activate",
    action: "Administer",
    target: "none",
    feature: PANEL_FEATURE.appRegistry,
  },
  {
    id: "api.apps.deactivate",
    method: "POST",
    path: "/api/apps/deactivate",
    action: "Administer",
    target: "none",
    feature: PANEL_FEATURE.appRegistry,
  },
  {
    id: "api.apps.uninstall",
    method: "POST",
    path: "/api/apps/uninstall",
    action: "Administer",
    target: "none",
    feature: PANEL_FEATURE.appRegistry,
  },
  // Declaring one more App. `Administer` for the same reason as the four verbs
  // above: which Apps this host serves is a host-level decision, not an
  // account-level one. It is a separate rule rather than an extra verb on one of
  // them because an audit asking "what may add an App to this host" should get
  // one row for the answer.
  {
    id: "api.apps.declare",
    method: "POST",
    path: "/api/apps/declare",
    action: "Administer",
    target: "none",
    feature: PANEL_FEATURE.appRegistry,
  },
  {
    id: "api.apps.list",
    method: "GET",
    path: "/api/apps",
    action: "Administer",
    target: "none",
    feature: PANEL_FEATURE.appRegistry,
  },
  // Shared-scope declared Apps (ADR 0007 P1): minting an instance, taking a
  // seat, listing mine, reading one instance's seats. ONE `ANY` prefix rule for
  // the same reason as `api.appView` below — the four verbs are one
  // authorization question ("may this account use shared instances of an App
  // this host serves, as itself?") with the verb carried as data. Sharing is an
  // ACL'd state object, not a room subsystem, so there is no invitation or
  // membership-administration verb to grade separately.
  //
  // `Identify`/`self` matches `page.appOpen`: an ordinary user action, no admin
  // bit, and the shared key — which names nobody — can hold no seat. It must
  // stay AFTER the exact `/api/apps*` literals above, which decide what this
  // host PUBLISHES and keep `Administer`; first match wins.
  {
    id: "api.appShared",
    method: "ANY",
    path: "/api/apps/*",
    action: "Identify",
    target: "self",
    feature: PANEL_FEATURE.appRegistry,
  },
  // Driving a declared App's Agent View: the publisher-trust door, one bounded
  // proposal, the projection stream, and releasing a tab's instance.
  //
  // ONE `ANY` prefix rule rather than four, and by the same judgement the rest
  // of this table already applies (`/api/admin*`): the four
  // sub-actions are not four different authorization questions — they are one
  // ("may this account drive an App this host serves, as itself?") with the verb
  // carried as data. The rules that got one row each above are the ones that
  // decide what this host PUBLISHES, and an audit asking that question should
  // still get one row per answer.
  //
  // `Identify`/`self` matches `page.appOpen`: account-scoped state, no admin bit
  // involved, and a shared key that names nobody gets nothing.
  {
    id: "api.appView",
    method: "ANY",
    path: "/api/app-view/*",
    action: "Identify",
    target: "self",
    feature: PANEL_FEATURE.appRegistry,
  },
  // Handing one shared App instance to an external trusted host
  // (`external-app-host/v1`): minting a launch grant, listing what this account
  // has handed out, taking one back. Its own rule rather than a fold into
  // `api.appShared` because it is a different question about the same objects —
  // "may this account move authority over its own seat OUT of this browser?" —
  // and an audit of who did that deserves its own row. It lives in its own path
  // family for the same reason `api.appView` does: the prefix matcher takes the
  // first rule whose prefix hits, and a nested path under `/api/apps/*` could
  // never be reached.
  //
  // `Identify`/`self`: still an ordinary user acting as themselves. What makes
  // it safe is not an admin bit but the handler's own narrowing (a real browser
  // session, the caller's own account, a seat they actually hold) plus the
  // operator's host allowlist.
  {
    id: "api.appExternal",
    method: "ANY",
    path: "/api/app-external/*",
    action: "Identify",
    target: "self",
    feature: PANEL_FEATURE.appRegistry,
  },
];

/**
 * Paths answered BEFORE the identity gate, each with a credential rule that is
 * not "who is this viewer" (or, for the browser bundle, no credential at all) —
 * and therefore each a place a surface decision could be skipped by accident.
 *
 * They are named here for exactly that reason. `authorizeRoute` never sees
 * them, so if the bootstrap surface were only enforced there, `/logout` and the
 * devpipe loopback would be reachable on every composition regardless of what
 * the allowlist said. Giving them ids makes them subject to the SAME
 * `surfaceAllows` call the table's routes get, and makes "a new pre-route path
 * appeared and nobody classified it" something a test can see.
 */
export interface PreRouteRule {
  id: string;
  /** The literal `server.ts` dispatches on (a prefix for the devpipe family). */
  path: string;
}

export const PRE_ROUTES: readonly PreRouteRule[] = [
  // Native Docs iframe: its own short-lived, tenant-bound bearer; no cookies.
  { id: "pre.feishuDocsAddon", path: "/api/feishu/docs-addon/" },
  { id: "pre.sessionShare", path: "/share" },
  { id: "pre.sessionShare", path: "/api/session-shares/redeem" },
  // A Feishu document's claim page: public like login, its secret in the
  // fragment; it calls only the docs add-on's same-origin claim routes above.
  { id: "pre.docShareKey", path: "/doc-key" },
  { id: "pre.login", path: "/login" },
  { id: "pre.oauthStart", path: "/auth/github" },
  { id: "pre.oauthCallback", path: "/auth/github/callback" },
  { id: "pre.register", path: "/register" },
  { id: "pre.register", path: "/auth/register" },
  { id: "pre.logout", path: "/logout" },
  { id: "pre.runnerBundle", path: "/download/runner.js" },
  { id: "pre.runnerEnrollment", path: "/api/runner-enrollment/redeem" },
  { id: "pre.runnerSelf", path: "/api/runner-self-status" },
  { id: "pre.runnerSelf", path: "/api/runner-self-revoke" },
  { id: "pre.runnerSelf", path: "/api/runner-guest-enrollment" },
  { id: "pre.runnerInstaller", path: "/install/" },
  { id: "pre.devpipeTool", path: "/api/devpipe/" },
  // The review lane's one-shot bundle hand-off (2026-08-20): a contributor's
  // dev container fetches the exact commit a turn is about to work on. Before
  // the identity gate because the caller is a machine holding a single-use
  // token the pipeline minted seconds earlier — not a person, not a device
  // credential — and the token itself names the one file it may read.
  { id: "pre.contribBundle", path: "/api/contrib/bundle/" },
  // `external-app-host/v1`. Before the identity gate for the same reason the
  // devpipe tool endpoint is: its callers hold no cookie, and the capability
  // they present already names one account, one App, one instance and one
  // authority. It is named here so the surface allowlist covers it too.
  { id: "pre.externalApp", path: "/api/external/app/" },
  // The browser bundle. It answers before the identity gate because the LOGIN
  // page is part of it — a panel whose login screen requires being logged in
  // cannot be entered. That is safe because the bundle is not a credential and
  // carries none: it is the same bytes for every viewer, and every decision it
  // appears to make is re-made by the server on the request that follows.
  { id: "pre.uiAsset", path: "/ui/" },
];

/**
 * Which pre-route family a path belongs to, or `null` for an ordinary path.
 *
 * A trailing `/` means the whole family below it — the devpipe loopback is
 * `/api/devpipe/<op>`, so matching only the literal would leave every actual
 * call unclassified.
 */
export function resolvePreRoute(pathname: string): PreRouteRule | null {
  for (const pre of PRE_ROUTES) {
    const hit = pre.path.endsWith("/") ? pathname.startsWith(pre.path) : pathname === pre.path;
    if (hit) return pre;
  }
  return null;
}

/**
 * Which composition of the panel is being served.
 *
 * `full` is the v2 dashboard: every route in the table. `bootstrap-v3` is the
 * v3 control plane — sessions, permissions, tickets, deploy, runner
 * administration — and NOTHING else, because the v3 process does not construct
 * the services the other routes call into.
 *
 * This is a surface decision, not an authorization one, and the two are kept
 * apart deliberately: a route that is off the surface answers 404 (it does not
 * exist in this composition), while a route on the surface still goes through
 * the whole Cedar policy afterwards. Hiding a page from navigation is not a
 * substitute for either.
 */
export type PanelSurface = "full" | "bootstrap-v3";

/**
 * The v3 bootstrap surface, as one explicit list.
 *
 * It is an ALLOWLIST rather than a blocklist, and that direction is the whole
 * design: a route added to the general dashboard later is absent from this set,
 * so it is 404 in bootstrap mode until somebody decides otherwise. The failure
 * mode of a blocklist — a new legacy-service route silently reachable from the
 * v3 process — cannot happen here.
 *
 * Since the v2 composition root, the secretary and the HQ workbench were
 * retired (2026-10-15), every route in the table is on this list; it stays an
 * allowlist so that a route added later is absent until somebody decides.
 */
export const BOOTSTRAP_ROUTE_IDS: ReadonlySet<string> = new Set<string>([
  "pre.feishuDocsAddon",
  "pre.docShareKey",
  // Login, logout, the browser bundle they are served in, and the landing that
  // follows them.
  "pre.sessionShare",
  "api.sessionShares.list",
  "api.sessionShares.options",
  "api.sessionShares.create",
  "api.sessionShares.request",
  "api.sessionShares.decide",
  "api.sessionShares.revoke",
  "api.sessionShares.reset",
  "pre.login",
  "pre.oauthStart",
  "pre.oauthCallback",
  "pre.register",
  "pre.logout",
  "pre.uiAsset",
  "page.overview",

  // Session Hub, and the Session Plus probe beside it (still behind its own
  // feature flag, which is off by default).
  "page.sessions",
  "page.sessionsPlus",
  "api.sessionPlus.agentActivity",
  "api.sessionPlus.agentStop",
  "api.sessionPlus.stream",
  "api.sessionPlus.act",
  "api.sessionPlus.performance",
  "api.sessionPlus.reconstruct",
  "api.sessionPlus.close",
  "api.sessionPlus.release",
  "api.sessionPlus.trust",
  "api.sessions.append",
  "api.sessions.interaction",
  "api.sessions.operations",
  "api.sessions.operations.stream",
  "api.sessions.search",
  "api.sessions.live",
  "api.sessions.list",
  "api.session",

  // Permissions, pending approvals, and capability administration.
  "page.permissions",
  // The access observatory design preview, beside the page it previews a
  // successor to. It constructs no service — the page renders a frontend
  // fixture — so it costs the v3 composition nothing to serve.
  "page.accessPreview",
  "page.pending",
  // The MCP surface: the endpoint and its token lifecycle. On the surface
  // because the v3 control plane is exactly the composition that serves the
  // session hub and permission centre these tools project.
  "api.mcp.rpc",
  "api.mcp.tokens.create",
  "api.mcp.tokens.revoke",
  "api.mcp.tokens.list",
  'api.discussions.read',
  'api.discussions.action',
  "api.tentacle.list",
  "api.tentacle.share",
  "api.tentacle.revoke",
  "api.feishu.oauth.start",
  "api.feishu.oauth.status",
  "api.connections.github.start",
  "api.connections.unbind",
  "api.connections.list",
  "api.permissions.grant",
  "api.permissions.revoke",
  "api.permissions.studio.explain",
  "api.permissions.studio.apply",
  "api.permissions.studio",
  "api.permissions.websessions.revokeOthers",
  "api.permissions.websessions.revokeOne",
  "api.permissions.websessions",
  "api.permissions.devices",
  "api.permissions.audit",
  "api.permissions.list",
  "api.capabilities.decide",
  "api.capabilities.pending",
  "page.admin",
  "api.admin",

  // Local Agentic App release management. On the surface because rolling the
  // App back is the recovery path for a bad activation, and a recovery tool that
  // is absent from the composition that needs it is not one.
  "page.apps",
  "api.apps.list",
  "api.apps.hotswapDecision",
  "api.apps.publishPending",
  "api.apps.install",
  "api.apps.activate",
  "api.apps.deactivate",
  "api.apps.uninstall",
  "api.apps.declare",
  // Opening what was declared. Without these two, an App could be declared,
  // installed and activated on this surface and still have nowhere to be
  // opened — which is the exact state P3 shipped in.
  "page.appOpen",
  "api.appView",
  // Discovering what may be opened: the non-admin launcher tab and its list.
  "page.launcher",
  // Shared-scope instances ride the same surface as opening: a share link on
  // the v3 control plane must land on a joinable page, not a 404.
  "api.appShared",
  // Handing one of those instances to an allow-listed external host, and the
  // transport that host then speaks. Both are inert unless
  // `external_app_hosts.enabled` names at least one origin.
  "api.appExternal",
  "pre.externalApp",

  // Tickets, development, verification, landing, deploy.
  "page.tickets",
  "api.tickets",
  "api.attachments",
  "api.dev.quota",
  "api.dev.systemStatus",
  // The architecture observatory: a dev-audience read of this checkout's own
  // structure, exactly the composition the v3 control plane serves.
  "page.architecture",
  "api.architecture",
  "api.architecture.refresh",
  "api.architecture.commits",
  "api.architecture.snapshots",
  "api.architecture.diff",
  // The knowledge wiki is built beside the architecture observatory in the v3
  // composition. Keep its entire route family on the same explicit surface:
  // the feature gate still makes every route 404 when that service is absent,
  // and Cedar still separates Contribute reads from UseDev review decisions.
  "page.knowledge",
  "api.knowledge",
  "api.knowledge.sources.read",
  "api.knowledge.sources.import",
  "api.knowledge.sources.confirm",
  "api.knowledge.repairs.read",
  "api.knowledge.repairs.write",
  "api.knowledge.health",
  "api.knowledge.preview",
  "api.knowledge.review.decide",
  "api.knowledge.conflict",
  "api.knowledge.conflict.annotate",
  "api.knowledge.chat.read",
  "api.knowledge.chat.write",
  "api.knowledge.chats.read",
  "api.knowledge.chats.write",
  "api.verify",
  "api.land",
  "api.deploy.post",
  "api.deploy.check",
  "api.deploy.confirm",
  "api.deploy.active",
  "api.deploy.get",
  // The review lane: the maintainer's queue and the contributor container's
  // bundle hand-off live with the pipeline that produces them.
  "api.mergeQueue",
  "api.mergeQueue.decide",
  "api.mergeQueue.run",
  "pre.contribBundle",
  // The dev agent's own loopback tool endpoint, with the per-turn-token and
  // loopback-only boundary it already has.
  "pre.devpipeTool",

  // Runner administration: the endpoint roster, device health, minting and
  // revoking device tokens, and the bundle those tokens exist to run.
  "api.overview",
  "api.themePreference",
  "api.check",
  "api.checkAll",
  "api.runnerToken",
  "api.runnerDisplayName",
  "api.runnerOnlineNotice",
  "api.runnerDelete",
  "api.runnerLocalAgentBridge",
  "api.runnerDefaultAgentInjection",
  "api.runnerGuiAutomation",
  "pre.runnerBundle",
  "pre.runnerEnrollment",
  "pre.runnerSelf",
  "pre.runnerInstaller",
]);

/**
 * Routes that exist on the bootstrap surface only in order to redirect.
 *
 * `/sessions` is the retired browser surface. Its id stays admitted so old
 * bookmarks can reach the sole session UI, but it never renders a page.
 *
 * Both the router and the navigation read THIS map: the router to perform the
 * redirect, the shell to leave the tab out. A tab that only bounces is not
 * navigation, and a second list of "pages that aren't really pages" would be
 * one more thing to keep in sync.
 *
 * `/` is deliberately absent from this map. A composition without Session Plus
 * needs an honest landing page, so Overview remains the feature-independent
 * fallback instead of redirecting to a route that the feature gate will 404.
 */
export const BOOTSTRAP_REDIRECTS: ReadonlyMap<string, string> = new Map([
  ["page.sessions", "/sessions-plus"],
]);

/**
 * Is this route part of the composition being served?
 *
 * One function for pages, APIs and pre-route paths alike — and the same one the
 * shell asks when it decides which tabs exist, so navigation cannot advertise a
 * page the surface would 404.
 */
export function surfaceAllows(surface: PanelSurface, id: string): boolean {
  return surface === "full" || BOOTSTRAP_ROUTE_IDS.has(id);
}

/**
 * Whether a configured composition exposes a route at all.
 *
 * The router and the trusted Shell both call this decision: a disabled feature
 * must be a 404 and must not leave behind a navigation link to that 404. Cedar
 * authorization remains a separate step after this function returns true.
 */
export function routeIsAvailable(
  surface: PanelSurface,
  routeId: string,
  enabledFeatures: EnabledPanelFeatures | undefined,
): boolean {
  const rule = ROUTES.find((candidate) => candidate.id === routeId);
  return Boolean(
    rule
      && surfaceAllows(surface, routeId)
      && (!rule.feature || featureEnabled(enabledFeatures, rule.feature)),
  );
}

/**
 * An id in the allowlist that names no route is a typo that silently REMOVES a
 * route from the bootstrap surface — the one failure this file's whole design
 * is meant to make impossible. Same treatment as a policy that does not
 * validate: refuse to load.
 */
function checkBootstrapAllowlist(): void {
  const known = new Set<string>([...ROUTES.map((r) => r.id), ...PRE_ROUTES.map((r) => r.id)]);
  const unknown = [...BOOTSTRAP_ROUTE_IDS].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`BOOTSTRAP_ROUTE_IDS names routes that do not exist: ${unknown.join(", ")}`);
  }
  // A redirect for a route that is off the surface would never run — the gate
  // 404s first — so the pair has to be declared consistently or not at all.
  const dangling = [...BOOTSTRAP_REDIRECTS.keys()].filter((id) => !BOOTSTRAP_ROUTE_IDS.has(id));
  if (dangling.length > 0) {
    throw new Error(`BOOTSTRAP_REDIRECTS names routes that are not on the surface: ${dangling.join(", ")}`);
  }
}

checkBootstrapAllowlist();

export interface RouteMatch {
  rule: RouteRule;
  /** The account the gate authorized, or "" for a global action. */
  account: string;
}

/**
 * Find the rule for a request. `null` means the panel has no such route.
 *
 * `routes` is injectable only so a test can prove the surface gate's behaviour
 * on a route that does not exist yet — production always passes the real table.
 */
export function resolveRoute(
  method: string,
  pathname: string,
  routes: readonly RouteRule[] = ROUTES,
): RouteRule | null {
  for (const rule of routes) {
    if (rule.method !== "ANY" && rule.method !== method) continue;
    if (rule.path.endsWith("*")) {
      if (pathname.startsWith(rule.path.slice(0, -1))) return rule;
    } else if (pathname === rule.path) {
      return rule;
    }
  }
  return null;
}

export type RouteVerdict =
  | { ok: true; match: RouteMatch }
  | { ok: false; status: number; error: string };

/**
 * The panel's single pre-dispatch authorization decision.
 *
 * An unlisted path is a 404 with the same wording the old fall-through used, so
 * adding a handler without adding a rule looks exactly like a typo in the URL —
 * which is the correct thing for it to look like.
 */
export function authorizeRoute(args: {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  viewer: PanelSubject;
  /** Constructed configuration features. Absent means none. */
  enabledFeatures?: EnabledPanelFeatures;
  /** Which composition is being served. Default: the full v2 dashboard. */
  surface?: PanelSurface;
  /** Test seam — see `resolveRoute`. */
  routes?: readonly RouteRule[];
}): RouteVerdict {
  const rule = resolveRoute(args.method, args.pathname, args.routes);
  if (!rule) return { ok: false, status: 404, error: "not found" };
  // Before authorization, and 404 rather than 403: on this composition the
  // route is not forbidden, it is absent. Answering 403 would tell a caller
  // that a service this process never built is merely out of their reach.
  if (!surfaceAllows(args.surface ?? "full", rule.id)) {
    return { ok: false, status: 404, error: "not found" };
  }
  if (rule.feature && !featureEnabled(args.enabledFeatures, rule.feature)) {
    return { ok: false, status: 404, error: featureDisabledMessage(rule.feature) };
  }
  const account = accountFor(rule, args.searchParams, args.viewer);
  if (!authorize(args.viewer, rule.action, account)) {
    return { ok: false, status: refusalStatus(rule), error: refusalMessage(rule) };
  }
  return { ok: true, match: { rule, account } };
}

function accountFor(rule: RouteRule, searchParams: URLSearchParams, viewer: PanelSubject): string {
  switch (rule.target) {
    case "none":
      return "";
    case "query":
      return searchParams.get("username") || viewer.username || "";
    case "self":
    case "body":
      // `body` authorizes against the caller's own account before dispatch; the
      // handler re-asks with the real target once it has parsed one.
      return viewer.username || "";
  }
}

/** Refusals keep their old wording: these strings are on screens people read. */
function refusalMessage(rule: RouteRule): string {
  if (rule.refusal) return rule.refusal;
  switch (rule.action) {
    case "UseDev":
      return "没有开发系统权限:请让管理员在 /admin 授予 dev";
    case "Contribute":
      return "没有开发系统权限:请让管理员在 /admin 授予 contribute 或 dev";
    case "Deploy":
      return "没有上线权限:请让管理员在 /admin 授予 deploy";
    case "Administer":
      return "仅管理员可访问";
    case "Approve":
      return "批准只能在浏览器登录会话中完成(脚本用的 Bearer 令牌不算人在场)";
    case "Identify":
      // Identify routes belong to one named account; only an unnamed credential (the shared key) is refused.
      return "此功能属于具体账号，共享管理密钥不代表任何人：请退出后用你本人的登录密钥登录";
    case "WriteAccount":
      return "forbidden";
    default:
      return "forbidden";
  }
}

function refusalStatus(_rule: RouteRule): number {
  return 403;
}
