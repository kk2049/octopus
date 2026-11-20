/**
 * The bootstrap surface: default-deny, and the same allowlist everywhere.
 *
 * `authz.test.ts` proves the panel's authorization rules. This file proves the
 * layer above them — WHICH ROUTES EXIST on the v3 composition — and the
 * property that makes it worth having: a route nobody has thought about is
 * absent, not present. A blocklist would have the opposite default and would be
 * wrong the first time somebody adds a route.
 */

import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_REDIRECTS,
  BOOTSTRAP_ROUTE_IDS,
  PRE_ROUTES,
  ROUTES,
  type PanelSubject,
  type RouteRule,
  authorizeRoute,
  resolvePreRoute,
  surfaceAllows,
} from "./authz.js";
import { PANEL_FEATURE, type EnabledPanelFeatures } from "./features.js";

const admin: PanelSubject = { username: "lht", admin: true, dev: true, deploy: true, contribute: true, session: true };
const devOnly: PanelSubject = { username: "dana", admin: false, dev: true, deploy: false, contribute: true, session: true };

function ask(
  pathname: string,
  o: {
    surface?: "full" | "bootstrap-v3";
    method?: string;
    viewer?: PanelSubject;
    routes?: readonly RouteRule[];
    enabledFeatures?: EnabledPanelFeatures;
  } = {},
) {
  return authorizeRoute({
    method: o.method ?? "GET",
    pathname,
    searchParams: new URLSearchParams(),
    viewer: o.viewer ?? admin,
    enabledFeatures: o.enabledFeatures ?? [PANEL_FEATURE.devPipeline],
    surface: o.surface,
    routes: o.routes,
  });
}

describe("the bootstrap surface is an allowlist, so new routes are off by default", () => {
  it("denies a route the table has never seen before, and admits it once listed", () => {
    // The requirement, stated as one test: a route-table entry that nobody put
    // in BOOTSTRAP_ROUTE_IDS does not exist on the v3 composition — even for an
    // admin, even with the pipeline on, even though the handler would work.
    const fixture: RouteRule[] = [
      { id: "page.fixture", method: "GET", path: "/fixture", action: "View", target: "none" },
      ...ROUTES,
    ];

    expect(ask("/fixture", { surface: "full", routes: fixture })).toMatchObject({ ok: true });
    expect(ask("/fixture", { surface: "bootstrap-v3", routes: fixture })).toMatchObject({
      ok: false,
      status: 404,
    });

    // And the contrast: an id that IS on the allowlist reaches its handler
    // through the very same call. Without this half, the test above would also
    // pass if bootstrap mode refused everything.
    expect(ask("/sessions", { surface: "bootstrap-v3", routes: fixture })).toMatchObject({ ok: true });
    expect(surfaceAllows("bootstrap-v3", "page.fixture")).toBe(false);
    expect(surfaceAllows("full", "page.fixture")).toBe(true);
  });

  it("answers 404 rather than 403 for an excluded route", () => {
    // Absent and forbidden are different sentences. A route that is not part of
    // this composition must not answer "you may not" about a service that does
    // not exist here — even to a caller the full table would refuse.
    const fixture: RouteRule[] = [
      { id: "api.fixture", method: "GET", path: "/api/fixture", action: "Administer", target: "none" },
      ...ROUTES,
    ];
    expect(ask("/api/fixture", { surface: "bootstrap-v3", viewer: devOnly, routes: fixture }))
      .toMatchObject({ ok: false, status: 404 });
    // Same path, full surface: the rule exists, so a non-admin is refused with
    // 403 and an admin is admitted. Proves the 404 comes from the surface and
    // not from the path being wrong.
    expect(ask("/api/fixture", { surface: "full", viewer: devOnly, routes: fixture }))
      .toMatchObject({ ok: false, status: 403 });
    expect(ask("/api/fixture", { surface: "full", routes: fixture }).ok).toBe(true);
  });

  it("keeps the whole v3 control plane reachable", () => {
    const wanted = [
      ["GET", "/sessions"],
      ["GET", "/api/sessions"],
      ["GET", "/api/session"],
      ["GET", "/api/sessions/search"],
      ["GET", "/api/sessions/live"],
      ["POST", "/api/sessions/append"],
      ["POST", "/api/sessions/interaction"],
      ["GET", "/api/sessions/operations"],
      ["GET", "/api/sessions/operations/stream"],
      ["GET", "/permissions"],
      ["GET", "/api/permissions"],
      ["POST", "/api/permissions/grant"],
      ["GET", "/api/permissions/studio"],
      ["POST", "/api/permissions/studio/explain"],
      ["POST", "/api/permissions/studio/apply"],
      ["GET", "/api/connections"],
      ["POST", "/api/connections/github/start"],
      ["POST", "/api/connections/unbind"],
      ["GET", "/pending"],
      ["GET", "/api/capabilities/pending"],
      ["POST", "/api/capabilities/pending/abc"],
      ["GET", "/tickets"],
      ["GET", "/api/tickets"],
      ["GET", "/api/dev/quota"],
      ["GET", "/api/dev/system-status"],
      ["POST", "/api/land"],
      ["POST", "/api/deploy"],
      ["POST", "/api/deploy/check"],
      ["GET", "/api/deploy/active"],
      ["GET", "/api/verify/1"],
      ["GET", "/admin"],
      ["GET", "/api/admin/users"],
      ["GET", "/api/overview"],
      ["POST", "/api/check"],
      ["POST", "/api/runner-token"],
      ["POST", "/api/runner-delete"],
      ["POST", "/api/runner-local-agent-bridge"],
      ["POST", "/api/runner-default-agent-injection"],
      ["POST", "/api/runner-gui-automation"],
    ] as const;
    for (const [method, p] of wanted) {
      expect(ask(p, { surface: "bootstrap-v3", method }), `${method} ${p}`).toMatchObject({ ok: true });
    }
  });

  it("keeps the composed knowledge wiki reachable without weakening its feature gate", () => {
    const wanted = [
      ["GET", "/knowledge"],
      ["GET", "/api/knowledge"],
      ["GET", "/api/knowledge/health"],
      ["POST", "/api/knowledge/preview"],
      ["POST", "/api/knowledge/review/decide"],
      ["GET", "/api/knowledge/conflict"],
      ["POST", "/api/knowledge/conflict/annotate"],
      ["GET", "/api/knowledge/chats"],
      ["GET", "/api/knowledge/chat"],
      ["POST", "/api/knowledge/chats"],
      ["POST", "/api/knowledge/chat/send"],
      // The sources and repairs views (B2): registered, called by the page,
      // and once absent from this list — so production answered 404.
      ["GET", "/api/knowledge/sources"],
      ["POST", "/api/knowledge/sources"],
      ["POST", "/api/knowledge/sources/confirm"],
      ["GET", "/api/knowledge/repairs"],
      ["POST", "/api/knowledge/repairs"],
    ] as const;
    for (const [method, p] of wanted) {
      expect(ask(p, {
        surface: "bootstrap-v3",
        method,
        enabledFeatures: [PANEL_FEATURE.devPipeline, PANEL_FEATURE.knowledge],
      }), `${method} ${p}`).toMatchObject({ ok: true });
      expect(ask(p, { surface: "bootstrap-v3", method }), `${method} ${p} without service`)
        .toMatchObject({ ok: false, status: 404 });
    }
  });

  it("names only routes that exist — a typo would silently remove one", () => {
    // `checkBootstrapAllowlist()` throws at module load, so reaching this line
    // already proves it. Asserted anyway, because the failure it guards against
    // (a disabled route that looks like a config choice) is invisible.
    const known = new Set([...ROUTES.map((r) => r.id), ...PRE_ROUTES.map((r) => r.id)]);
    expect([...BOOTSTRAP_ROUTE_IDS].filter((id) => !known.has(id))).toEqual([]);
  });

  it("requires Deploy for release checks on the bootstrap surface", () => {
    expect(ask("/api/deploy/check", { surface: "bootstrap-v3", method: "POST", viewer: devOnly }))
      .toMatchObject({ ok: false, status: 403 });
  });
});

describe("paths answered before the route table are classified, not exempt", () => {
  // "declares every pre-route path server.ts dispatches on" used to be a regular
  // expression over the source above the identity gate, because "before the
  // gate" was a position in an if-chain rather than a thing. It is a Fastify
  // SCOPE now — one with no gate hook — so the check moved to `routes.test.ts`,
  // where it walks the registered routes: every route in that scope declares a
  // `PRE_ROUTES` id, every `PRE_ROUTES` id has a route, and nothing is
  // registered outside the two scopes.

  it("matches the devpipe family, not just the literal prefix", () => {
    expect(resolvePreRoute("/api/devpipe/submit")?.id).toBe("pre.devpipeTool");
    expect(resolvePreRoute("/login")?.id).toBe("pre.login");
    expect(resolvePreRoute("/auth/github")?.id).toBe("pre.oauthStart");
    expect(resolvePreRoute("/auth/github/callback")?.id).toBe("pre.oauthCallback");
    expect(resolvePreRoute("/register")?.id).toBe("pre.register");
    expect(resolvePreRoute("/auth/register")?.id).toBe("pre.register");
    expect(resolvePreRoute("/logout")?.id).toBe("pre.logout");
    expect(resolvePreRoute("/download/runner.js")?.id).toBe("pre.runnerBundle");
    expect(resolvePreRoute("/sessions")).toBeNull();
    // Not a prefix match on a non-family rule: `/loginX` is somebody else's URL.
    expect(resolvePreRoute("/login-page")).toBeNull();
  });

  it("keeps every bootstrap entry route, including GitHub login and registration", () => {
    for (const pre of PRE_ROUTES) {
      expect(surfaceAllows("bootstrap-v3", pre.id), pre.id).toBe(true);
    }
  });
});

describe("the landing redirect", () => {
  it("keeps Overview as the feature-off landing and redirects only the retired session page", () => {
    expect(BOOTSTRAP_REDIRECTS.has("page.overview")).toBe(false);
    expect(BOOTSTRAP_REDIRECTS.get("page.sessions")).toBe("/sessions-plus");
    // Both have to be on the surface: Overview renders, while the compatibility
    // route reaches the redirect instead of being rejected by the gate first.
    expect(surfaceAllows("bootstrap-v3", "page.overview")).toBe(true);
    expect(surfaceAllows("bootstrap-v3", "page.sessions")).toBe(true);
  });
});

describe("admission to the surface is not authorization", () => {
  it("keeps user administration operator-only", () => {
    for (const p of ["/api/admin/grant", "/api/admin/rename"]) {
      expect(ask(p, { surface: "bootstrap-v3", method: "POST", viewer: admin })).toMatchObject({ ok: true });
      expect(ask(p, { surface: "bootstrap-v3", method: "POST", viewer: devOnly })).toMatchObject({
        ok: false,
        status: 403,
      });
    }
  });

  it("still refuses a deploy to someone who only has dev — P1-4 under the new gate", () => {
    // The regression this guards: a surface check that returned `ok` for an
    // allowlisted route and skipped the policy would re-open exactly the hole
    // `/api/deploy/confirm` had.
    expect(ask("/api/deploy", { surface: "bootstrap-v3", method: "POST", viewer: devOnly })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(ask("/api/land", { surface: "bootstrap-v3", method: "POST", viewer: devOnly })).toMatchObject({
      ok: false,
      status: 403,
    });
    // …while the same person may use the dev pipeline itself.
    expect(ask("/tickets", { surface: "bootstrap-v3", viewer: devOnly })).toMatchObject({ ok: true });
  });

  it("still refuses the admin pages to a non-admin, and the pipeline to a non-dev", () => {
    const plain: PanelSubject = { username: "bob", admin: false, dev: false, deploy: false, contribute: false, session: true };
    expect(ask("/admin", { surface: "bootstrap-v3", viewer: plain })).toMatchObject({ ok: false, status: 403 });
    expect(ask("/tickets", { surface: "bootstrap-v3", viewer: plain })).toMatchObject({ ok: false, status: 403 });
    // The shared key names nobody, so a personal queue is not its to claim.
    const shared: PanelSubject = { admin: true, dev: true, deploy: true, contribute: true, session: false };
    expect(ask("/pending", { surface: "bootstrap-v3", viewer: shared })).toMatchObject({ ok: false, status: 403 });
  });

  it("keeps the pipeline-disabled 404, which is a different absence", () => {
    const v = authorizeRoute({
      method: "GET",
      pathname: "/tickets",
      searchParams: new URLSearchParams(),
      viewer: admin,
      enabledFeatures: [],
      surface: "bootstrap-v3",
    });
    expect(v).toMatchObject({ ok: false, status: 404 });
  });
});


describe("the Session Plus feature flag is a second, independent absence", () => {
  it("does not exist until the flag is on — on either surface", () => {
    // Two different questions, and both have to be yes. The surface asks "is
    // this composition serving that route at all"; the flag asks "did an
    // operator turn the experiment on". Off is 404 rather than 403, because a
    // feature nobody enabled is not a permission the caller lacks.
    for (const surface of ["full", "bootstrap-v3"] as const) {
      expect(ask("/sessions-plus", { surface }), surface).toMatchObject({ ok: false, status: 404 });
      expect(ask("/sessions-plus", { surface, enabledFeatures: [PANEL_FEATURE.devPipeline] }), surface).toMatchObject({
        ok: false,
        status: 404,
      });
      expect(ask("/sessions-plus", {
        surface,
        enabledFeatures: [PANEL_FEATURE.devPipeline, PANEL_FEATURE.sessionPlus],
      }), surface).toMatchObject({ ok: true });
      expect(ask("/api/session-plus/release", {
        surface,
        enabledFeatures: [PANEL_FEATURE.devPipeline, PANEL_FEATURE.sessionPlus],
      }), surface).toMatchObject({ ok: true });
      expect(ask("/api/session-plus/trust", {
        surface,
        method: "POST",
        enabledFeatures: [PANEL_FEATURE.devPipeline, PANEL_FEATURE.sessionPlus],
      }), surface).toMatchObject({ ok: true });
    }
  });

  it("is on the bootstrap allowlist, so the flag is the only thing gating it", () => {
    expect(surfaceAllows("bootstrap-v3", "page.sessionsPlus")).toBe(true);
  });

  it("keeps /sessions admitted only as the guarded compatibility redirect", () => {
    for (const surface of ["full", "bootstrap-v3"] as const) {
      for (const enabledFeatures of [
        undefined,
        [PANEL_FEATURE.devPipeline],
        [PANEL_FEATURE.devPipeline, PANEL_FEATURE.sessionPlus],
      ] as const) {
        expect(ask("/sessions", { surface, enabledFeatures }), `${surface}/${String(enabledFeatures)}`)
          .toMatchObject({ ok: true });
      }
    }
  });
});
