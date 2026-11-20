/**
 * `external-app-host/v1` — the wire an EXTERNAL trusted host speaks to drive
 * one Agentic App instance on behalf of one logged-in Octopus account.
 *
 * ── What this contract is, and what it deliberately is not ──────────────────
 *
 * It is a small, App-agnostic transport. There is no DSH in this file, no
 * chess, no iframe relay and no identity exception: a host is a configured
 * origin, an App is a stable id, an instance is a shared instance key, and the
 * only thing that says who is acting is a credential Octopus minted for a
 * person in their own browser session. Everything an external caller could
 * assert about itself — a username, a role, an app, an instance — is IGNORED,
 * because all five are already inside the credential it presented.
 *
 * It is NOT a second App host. Every operation below lands on the existing
 * `AppInstanceService` (membership door, role allowlists, the App's own rules
 * door, the durable event log, the projection stream). No game state, no move
 * legality and no seat arithmetic exists on this path.
 *
 * ── The two authorities, and why they are two credentials ───────────────────
 *
 * `human` is a person at a keyboard on the external host: their moves are
 * dispatched with a USER actor and land in the log as `user:<name>`, exactly as
 * the same person's click inside Octopus does.
 *
 * `agent` is a program proposing a bounded, schema-described action. It is a
 * SEPARATE credential, minted by a separate act on a trusted Octopus page, it
 * dispatches with an AGENT actor (so `human_only` actions refuse it and the
 * event log names it as an agent), and it is refused on the human operation.
 * A host holding one cannot reach the other's operation and cannot promote
 * itself: the authority is a field of the row, never of the request.
 *
 * ── The two secrets, and why they are two ───────────────────────────────────
 *
 *   launch grant   `xlg_…`   one-shot, seconds, travels in a URL FRAGMENT
 *   capability     `xac_…`   standing, revocable, travels in an Authorization
 *                            header and never in a URL
 *
 * A fragment is not sent to any server, is not in an access log and is not in a
 * Referer. Exchanging it once, from the exact bound origin, is what turns a
 * navigable link into a credential the host holds — which is why the link
 * itself is worth little and dies either way.
 */

import { SANDBOX_ALLOW_SCRIPTS_AND_DOWNLOADS } from "@claude-bot/web-trust";
import { SESSION_PLUS_PROTOCOL } from "@claude-bot/web-trust/frame-protocol";
import type { SessionPlusActionSpec } from "../app-core/manifest.js";
import { appActionTool } from "../app-core/manifest.js";

/** The protocol id every reply carries, so a host can refuse a future v2. */
export const EXTERNAL_APP_HOST_PROTOCOL = "external-app-host/v1";

/** Everything under this prefix is answered before the browser identity gate. */
export const EXTERNAL_APP_BASE_PATH = "/api/external/app";

/**
 * The operations, spelled once.
 *
 * `propose` and `agent_propose` are deliberately different PATHS rather than
 * one path with an `actor` field: a field would be something a caller writes,
 * and the whole point is that which one you may call was decided by a person on
 * a trusted page. A credential presented on the wrong one is refused before its
 * body is read.
 */
export const EXTERNAL_APP_OPERATIONS = Object.freeze({
  exchange: "exchange",
  describe: "describe",
  open: "open",
  read: "read",
  stream: "stream",
  propose: "propose",
  agentPropose: "agent_propose",
  close: "close",
  revoke: "revoke",
} as const);

export type ExternalAppOperation = (typeof EXTERNAL_APP_OPERATIONS)[keyof typeof EXTERNAL_APP_OPERATIONS];

/** Path suffix → operation. The router's only table; unknown suffixes 404. */
export const EXTERNAL_APP_PATHS: Readonly<Record<string, ExternalAppOperation>> = Object.freeze({
  "/exchange": "exchange",
  "/describe": "describe",
  "/open": "open",
  "/read": "read",
  "/stream": "stream",
  "/propose": "propose",
  "/agent-propose": "agent_propose",
  "/close": "close",
  "/revoke": "revoke",
});

/** Which authority may call which operation. Fail-closed by construction. */
export const EXTERNAL_APP_OPERATION_AUTHORITY: Readonly<Record<ExternalAppOperation, readonly ExternalAppAuthority[]>> =
  Object.freeze({
    exchange: ["human", "agent"],
    describe: ["human", "agent"],
    open: ["human", "agent"],
    read: ["human", "agent"],
    stream: ["human", "agent"],
    propose: ["human"],
    agent_propose: ["agent"],
    close: ["human", "agent"],
    revoke: ["human", "agent"],
  });

export type ExternalAppAuthority = "human" | "agent";

export const EXTERNAL_APP_AUTHORITIES: readonly ExternalAppAuthority[] = Object.freeze(["human", "agent"]);

export function isExternalAppAuthority(value: unknown): value is ExternalAppAuthority {
  return value === "human" || value === "agent";
}

/**
 * The closed refusal vocabulary, with an explicit fallback (`unavailable`).
 *
 * A host renders these; a person reads the sentence beside them. They are
 * distinct where the distinction is actionable — "your seat was taken away" and
 * "this App moved to a new release" need different human responses — and
 * deliberately identical where telling them apart would help an attacker: an
 * unknown, expired, revoked or wrong-host credential is `invalid_credential`.
 */
export const EXTERNAL_APP_REFUSALS = Object.freeze([
  "invalid_credential",
  "origin_refused",
  "operation_refused",
  "not_member",
  "trust_required",
  "release_changed",
  "instance_closed",
  "invalid_instance",
  "invalid_params",
  "unknown_action",
  "action_rejected",
  "state_conflict",
  "not_supported",
  "unavailable",
] as const);

export type ExternalAppRefusal = (typeof EXTERNAL_APP_REFUSALS)[number];

/** The header a bound handle rides in, exactly as the trusted browser page uses. */
export const EXTERNAL_APP_INSTANCE_HEADER = "x-app-instance";

/** Token grammars. Server-minted; a caller never names one. */
export const EXTERNAL_LAUNCH_TOKEN_PREFIX = "xlg_";
export const EXTERNAL_CAPABILITY_PREFIX = "xac_";
export const EXTERNAL_CREDENTIAL_ID_PREFIX = "xai_";
export const EXTERNAL_GRANT_ID_PREFIX = "xag_";

/** 32 random bytes, base64url. Bounded so a parser never scans an essay. */
export const EXTERNAL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isExternalLaunchToken(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith(EXTERNAL_LAUNCH_TOKEN_PREFIX)
    && EXTERNAL_SECRET_PATTERN.test(value.slice(EXTERNAL_LAUNCH_TOKEN_PREFIX.length));
}

export function isExternalCapabilitySecret(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith(EXTERNAL_CAPABILITY_PREFIX)
    && EXTERNAL_SECRET_PATTERN.test(value.slice(EXTERNAL_CAPABILITY_PREFIX.length));
}

/**
 * The fragment key a launch URL carries.
 *
 * A fragment rather than a query parameter because a fragment is never sent to
 * a server: it stays out of the host's access log, out of every Referer, and
 * out of any proxy in between. The host plugin reads `location.hash`, exchanges
 * it once, and is expected to clear it.
 */
export const EXTERNAL_LAUNCH_FRAGMENT_KEY = "octopus_app_launch";

/**
 * One bound binding, as a host sees it. Contains no secret: the credential it
 * describes was returned exactly once, by the exchange that minted it.
 */
export interface ExternalAppBindingView {
  protocol: string;
  credential_id: string;
  app: string;
  instance: string;
  /** The real Octopus account. Never anything a host asserted. */
  user: string;
  authority: ExternalAppAuthority;
  host: string;
  host_origin: string;
  release_digest: string;
  created_at: string;
  expires_at: string;
}

/**
 * How an external shell REUSES the App's own View instead of rewriting its UI.
 *
 * The address is a display address, not a credential: the origin is derived
 * from the release's package digest, the document it serves is immutable, and
 * it does nothing at all until a parent hands it a `MessagePort`. What makes
 * framing it possible is the operator's allowlist appearing in the View's own
 * `frame-ancestors` — exact origins, never a wildcard, with every other
 * directive (including `connect-src 'none'`) untouched.
 *
 * The rule the host shell must hold, and the reason the relay belongs in a
 * TRUSTED shell rather than inside the frame: the capability secret stays in
 * the host's backend. The frame receives projections and returns proposals over
 * the port, exactly as Octopus's own trusted page does — it never receives a
 * token, a username, a handle or a URL that carries one.
 */
export interface ExternalAppViewDescription {
  /** Immutable document location; absent means `${origin}/` for older hosts. */
  url?: string;
  /** Digest-addressed origin to frame. Never a path; the document is at `/`. */
  origin: string;
  package_digest: string;
  /** The MessagePort protocol the parent shell must speak. */
  frame_protocol: string;
  /** The sandbox token set the parent must apply to the iframe. */
  sandbox: string;
}

/** The protocol id of the trusted-shell ↔ View MessagePort handshake. */
export const EXTERNAL_APP_FRAME_PROTOCOL = SESSION_PLUS_PROTOCOL;

/** The iframe sandbox an external shell must apply, same as the panel's. */
export const EXTERNAL_APP_VIEW_SANDBOX = SANDBOX_ALLOW_SCRIPTS_AND_DOWNLOADS;

/** What `describe` (and the exchange that precedes it) answers. */
export interface ExternalAppDescription {
  protocol: string;
  binding: ExternalAppBindingView;
  app_title: string;
  role: string;
  view: ExternalAppViewDescription | null;
  actions: readonly ExternalAppActionContract[];
}

/**
 * The bounded typed contract an agent-authority host is given.
 *
 * Derived from the App manifest's own action table through `appActionTool` —
 * the SAME derivation the MCP agent face uses — so there is one description of
 * what an agent may propose, not two. It is a description, never a second
 * validator: whatever this schema says, the door still runs
 * `normalizeSessionPlusAction` and the App's own rules handler still decides.
 */
export interface ExternalAppActionContract {
  name: string;
  title: string;
  description: string;
  /** Declared seats that may drive it, or null for "any non-observer member". */
  roles: readonly string[] | null;
  /** JSON Schema (draft-07 compatible subset) for `params`. */
  params: ReturnType<typeof appActionTool>["parameters"];
}

export function externalAppActionContract(
  name: string,
  spec: SessionPlusActionSpec,
): ExternalAppActionContract {
  const tool = appActionTool(name, spec);
  return {
    name,
    title: spec.title ?? name,
    description: tool.description,
    roles: spec.roles ? [...spec.roles] : null,
    params: tool.parameters,
  };
}
