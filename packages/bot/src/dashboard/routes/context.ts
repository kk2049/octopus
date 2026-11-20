/**
 * The seams `DashboardServer` hands its per-domain route modules.
 *
 * Each module under `dashboard/routes/` exports a `register…Routes` function
 * that takes a `GuardedRoutes` binder plus its own narrow context interface.
 * The binder is built inside `registerGuardedRoutes`, so a route registered
 * through it cannot skip the identity/CSRF/Cedar chain — the same structural
 * guarantee the one-file table had. The context interfaces name exactly the
 * server facts and identity/lifecycle seams a domain's handlers read; the
 * server satisfies them all with one object, and authorization stays where it
 * was: in the `onRequest` gate, before any handler here runs.
 */

import type { ServerResponse } from "node:http";
import type { PanelReply, PanelRequest } from "../http.js";
import type { DashboardIdentity } from "../server.js";
import type { DashboardPageProps } from "@claude-bot/dashboard-web/contract";
import type { TailSource } from "../live.js";

/** One guarded handler: the gate has already bound and released `identity`. */
export type GuardedHandler = (
  req: PanelRequest,
  reply: PanelReply,
  identity: DashboardIdentity,
) => void | Promise<void>;

/**
 * The route binder `registerGuardedRoutes` hands each domain module.
 *
 * Every route declares the `authz.ts` rule id it is served under, exactly as
 * the inline table did; `routes.test.ts` still walks the recorded table
 * against the authorization table in both directions.
 */
export interface GuardedRoutes {
  get(url: string, routeId: string, fn: GuardedHandler): void;
  post(
    url: string,
    routeId: string,
    schema: object | undefined,
    fn: GuardedHandler,
    extra?: { bodyLimit?: number },
  ): void;
  /** For the prefix rules whose handler owns its own sub-dispatch. */
  any(url: string, routeId: string, fn: GuardedHandler, extra?: { bodyLimit?: number }): void;
}

/** What `DashboardServer.appPage` renders: one trusted page document. */
export interface AppPageOptions {
  title: string;
  identity: DashboardIdentity | null;
  page: string;
  props?: DashboardPageProps;
  appInstance?: string;
  extraCsp?: readonly string[];
}

/** The trusted page renderer, owned by the server (CSP and bootstrap). */
export interface PageRenderer {
  appPage(res: PanelReply, status: number, options: AppPageOptions): void;
}

/**
 * The identity predicates and teardown seams that stay in `server.ts` —
 * they are policy delegations and credential lifecycle, not route logic.
 */
export interface IdentityGuards {
  /** User exists + caller may see them; writes the refusal itself. */
  requireUser(res: PanelReply, identity: DashboardIdentity, username: string): boolean;
  /** May READ this user's data (`dashboard/authz.ts`). */
  canActFor(identity: DashboardIdentity, username: string): boolean;
  /** May WRITE content signed as this user — strictly owner-only. */
  canWriteAs(identity: DashboardIdentity, username: string): boolean;
  /** The account a `query`-targeted route is about: named, or the caller's own. */
  targetAccount(req: PanelRequest, identity: DashboardIdentity): string;
}

/** Registries every open SSE stream joins, so revocation can END it. */
export interface StreamRegistries {
  liveStreams: Map<ServerResponse, { owner: string; credential: string }>;
  eventStreams: Set<ServerResponse>;
  /** Shared SSE bootstrap (cursor, headers, LiveRegistry subscription). */
  startSse(
    req: PanelRequest,
    res: ServerResponse,
    params: URLSearchParams,
    key: string,
    make: () => Promise<{ src: TailSource; intervalMs: number }>,
  ): Promise<void>;
}
