/**
 * The router and the authorization table describe the same panel.
 *
 * ── What this replaces, and why it is stronger ──────────────────────────────
 *
 * Before Fastify there was no table to walk, so the structural check was a
 * REGULAR EXPRESSION over `server.ts`: pull every `url.pathname === "…"` out of
 * the dispatcher and require the rule table to know it. That worked, but it
 * measured the source text rather than the server — a route registered any other
 * way was invisible to it, and so was a rule nobody dispatched on.
 *
 * Fastify owns the table now, and every route declares the `authz.ts` rule it is
 * served under, so the check is over the real thing and runs in both directions:
 *
 *   1. every REGISTERED route names a rule that exists (no handler without a
 *      rule — that is P1-4's shape, an endpoint somebody added without a check);
 *   2. every RULE has at least one route (no rule without a handler — a line in
 *      the table that reads as served and 404s);
 *   3. for every registered route, the rule the ROUTER matched and the rule the
 *      TABLE matches for the same concrete path are the same one. Two matchers
 *      that disagree is the failure the single table exists to prevent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DashboardServer } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { PRE_ROUTES, ROUTES, resolvePreRoute, resolveRoute } from "./authz.js";

const NOW = "2026-08-06T00:00:00.000Z";

let dir: string;
let store: Store;
let dash: DashboardServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "routes-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
  dash = createDashboardTestServer(store, undefined, { port: 0, host: "127.0.0.1", authToken: "admin-key" });
  await dash.start();
});

afterAll(async () => {
  await dash.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A concrete path for a route pattern, so the table can be asked the same
 * question the router was. `:id` gets a number because `/api/tickets/:id` and
 * `/api/verify/:id` are numeric; everything else gets an opaque segment.
 */
function probePath(url: string): string {
  return url
    .split("/")
    .map((seg) => (seg === "*" ? "x" : seg.startsWith(":") ? (seg === ":id" ? "1" : "x") : seg))
    .join("/");
}

const PRE_ROUTE_IDS = new Set(PRE_ROUTES.map((r) => r.id));

describe("the router and the authorization table are one surface", () => {
  it("registers a real, non-trivial table", () => {
    expect(dash.routes.length).toBeGreaterThan(40);
  });

  it("every registered route declares a rule that exists", () => {
    const known = new Set<string>([...ROUTES.map((r) => r.id), ...PRE_ROUTES.map((r) => r.id)]);
    const undeclared = dash.routes.filter((r) => !r.routeId || !known.has(r.routeId));
    expect(undeclared).toEqual([]);
  });

  it("every rule in the table has a route that serves it", () => {
    const served = new Set(dash.routes.map((r) => r.routeId));
    expect(ROUTES.filter((rule) => !served.has(rule.id)).map((r) => r.id)).toEqual([]);
    expect(PRE_ROUTES.filter((rule) => !served.has(rule.id)).map((r) => r.id)).toEqual([]);
  });

  it("the router's match and the table's match are the same rule", () => {
    const mismatched: Array<{ method: string; url: string; declared: string; table: string | null }> = [];
    for (const route of dash.routes) {
      if (PRE_ROUTE_IDS.has(route.routeId)) continue;
      // HEAD is never in the table (`exposeHeadRoutes` is off precisely so a
      // routed request the gate would refuse cannot exist), and OPTIONS reaches
      // the two ANY-prefix families whose rules are declared `ANY`.
      const table = resolveRoute(route.method, probePath(route.url));
      if (table?.id !== route.routeId) {
        mismatched.push({ method: route.method, url: route.url, declared: route.routeId, table: table?.id ?? null });
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("every pre-route path classifies to the id its route declared", () => {
    const mismatched = dash.routes
      .filter((r) => PRE_ROUTE_IDS.has(r.routeId))
      .filter((r) => resolvePreRoute(probePath(r.url))?.id !== r.routeId);
    expect(mismatched).toEqual([]);
  });

  it("no route is registered outside the two scopes", () => {
    // Both scopes are total: a route id is either a pre-route (answered before
    // the identity gate, with its own credential rule) or a table rule (behind
    // the gate). There is deliberately no third category — that would be a route
    // exempt from both, which is how an endpoint gets added without a check.
    const tableIds = new Set(ROUTES.map((r) => r.id));
    const stray = dash.routes.filter((r) => !PRE_ROUTE_IDS.has(r.routeId) && !tableIds.has(r.routeId));
    expect(stray).toEqual([]);
  });
});
