/**
 * The panel's authorization policy, tested three ways.
 *
 *  1. **Differentially** against the boolean expressions it replaced. The
 *     migration to Cedar is only safe if it decides the same thing, so the old
 *     `canActFor` / `canWriteAs` bodies are reproduced here verbatim and the
 *     policy is required to agree with them on every subject.
 *  2. **Structurally**: no rule is shadowed by an earlier prefix, and every rule
 *     is named once. The other half of that check — that the ROUTER and this
 *     table describe the same panel, in both directions — lives in
 *     `routes.test.ts`, because Fastify owns the route table now and walking it
 *     is stronger than the regular expression over `server.ts` that used to
 *     stand in for it.
 *  3. **By case**, for the asymmetries a reader would not guess: admin reads
 *     across but never writes across; the shared key reads everything and
 *     writes nothing; approving takes a session.
 */

import { describe, expect, it } from "vitest";
import {
  PANEL_ACTIONS,
  ROUTES,
  type PanelSubject,
  authorize,
  authorizeRoute,
  mayManageConnection,
  mayRead,
  mayWriteAs,
  resolveRoute,
} from "./authz.js";
import { PANEL_FEATURE } from "./features.js";

const DEV_FEATURES = [PANEL_FEATURE.devPipeline] as const;

const subject = (over: Partial<PanelSubject> = {}): PanelSubject => ({
  admin: false,
  dev: false,
  deploy: false,
  contribute: false,
  session: true,
  ...over,
});

/** The five credentials that actually exist on this panel. */
const SUBJECTS: Record<string, PanelSubject> = {
  plain: subject({ username: "alice" }),
  // `contribute` is set wherever `dev` is, because that is what resolution
  // produces (capability-bits.ts); the policy itself never infers it.
  contributor: subject({ username: "lilei", contribute: true }),
  devMember: subject({ username: "dana", dev: true, contribute: true }),
  deployer: subject({ username: "dora", dev: true, deploy: true, contribute: true }),
  admin: subject({ username: "lht", admin: true, dev: true, deploy: true, contribute: true }),
  sharedKey: subject({ admin: true, dev: true, deploy: true, contribute: true }), // auth_token: admin bit, no account
  bearer: subject({ username: "alice", session: false }), // script with a dt_ token
};

const ACCOUNTS = ["alice", "dana", "dora", "lht", "nobody"];

describe("it decides exactly what the inline expressions decided", () => {
  // Verbatim from the pre-migration server.ts, so the diff is auditable.
  const oldCanActFor = (s: PanelSubject, u: string): boolean => s.admin || s.username === u;
  // 2026-10-15: a NAMED administrator may also act as any account.
  const oldCanWriteAs = (s: PanelSubject, u: string): boolean => Boolean(s.username) && (s.username === u || s.admin);

  it("mayRead matches canActFor for every subject and account", () => {
    for (const [name, s] of Object.entries(SUBJECTS)) {
      for (const account of ACCOUNTS) {
        expect(mayRead(s, account), `${name} -> ${account}`).toBe(oldCanActFor(s, account));
      }
    }
  });

  it("mayWriteAs matches canWriteAs for every subject and account", () => {
    for (const [name, s] of Object.entries(SUBJECTS)) {
      for (const account of ACCOUNTS) {
        expect(mayWriteAs(s, account), `${name} -> ${account}`).toBe(oldCanWriteAs(s, account));
      }
    }
  });

  it("UseDev, Deploy and Administer match the bits they replaced", () => {
    for (const s of Object.values(SUBJECTS)) {
      expect(authorize(s, "UseDev", "")).toBe(s.dev);
      expect(authorize(s, "Deploy", "")).toBe(s.deploy);
      expect(authorize(s, "Administer", "")).toBe(s.admin);
    }
  });
});

describe("the asymmetries, stated so they cannot drift", () => {
  it("a named admin reads and acts across users; nobody else gains anything", () => {
    const lht = SUBJECTS.admin;
    expect(mayRead(lht, "alice")).toBe(true);
    expect(mayWriteAs(lht, "alice")).toBe(true);
    expect(mayWriteAs(lht, "lht")).toBe(true);
    // Non-admins stay inside their own account, whatever other bits they hold.
    for (const name of ["plain", "contributor", "devMember", "deployer", "bearer"]) {
      expect(mayWriteAs(SUBJECTS[name]!, "lht"), name).toBe(false);
      expect(mayRead(SUBJECTS[name]!, "lht"), name).toBe(false);
    }
  });

  it("the shared auth_token reads everything and authors nothing", () => {
    const shared = SUBJECTS.sharedKey;
    expect(mayRead(shared, "alice")).toBe(true);
    expect(mayWriteAs(shared, "alice")).toBe(false);
    // No account behind it, so nothing that belongs to a person either.
    expect(authorize(shared, "Identify", "alice")).toBe(false);
    expect(authorize(shared, "Approve", "alice")).toBe(false);
  });

  it("approving needs a session, not just a credential", () => {
    expect(authorize(SUBJECTS.plain, "Approve", "alice")).toBe(true);
    expect(authorize(SUBJECTS.bearer, "Approve", "alice")).toBe(false);
    // A bearer can still read its own queue — it just cannot decide.
    expect(authorize(SUBJECTS.bearer, "Identify", "alice")).toBe(true);
  });

  it("managing an external connection is owner-and-browser-session only", () => {
    expect(mayManageConnection(SUBJECTS.plain, "alice")).toBe(true);
    expect(mayManageConnection(SUBJECTS.bearer, "alice")).toBe(false);
    expect(mayManageConnection(SUBJECTS.admin, "alice")).toBe(false);
  });

  it("nobody approves or claims a queue that is not theirs", () => {
    expect(authorize(SUBJECTS.admin, "Approve", "alice")).toBe(false);
    expect(authorize(SUBJECTS.admin, "Identify", "alice")).toBe(false);
    expect(authorize(SUBJECTS.plain, "Approve", "alice")).toBe(true);
  });

  it("a contributor enters the ticket workspace but neither the member view nor the watermark", () => {
    const lilei = SUBJECTS.contributor;
    const q = new URLSearchParams();
    const route = (method: "GET" | "POST", pathname: string, viewer = lilei) =>
      authorizeRoute({ method, pathname, searchParams: q, viewer, enabledFeatures: [...DEV_FEATURES, PANEL_FEATURE.architecture] });
    // The shared pages and the architecture atlas: yes.
    expect(route("GET", "/tickets").ok).toBe(true);
    expect(route("GET", "/api/tickets").ok).toBe(true);
    expect(route("POST", "/api/tickets").ok).toBe(true);
    expect(route("GET", "/architecture").ok).toBe(true);
    expect(route("GET", "/api/architecture").ok).toBe(true);
    expect(route("GET", "/api/deploy").ok).toBe(true);
    // The member-level queue, the maintainer verbs and the watermark: no.
    expect(route("GET", "/api/merge-queue")).toMatchObject({ ok: false, status: 403 });
    expect(route("POST", "/api/merge-queue/decide")).toMatchObject({ ok: false, status: 403 });
    expect(route("POST", "/api/merge-queue/run")).toMatchObject({ ok: false, status: 403 });
    expect(route("POST", "/api/land")).toMatchObject({ ok: false, status: 403 });
    expect(route("POST", "/api/deploy")).toMatchObject({ ok: false, status: 403 });
    expect(route("POST", "/api/verify/1")).toMatchObject({ ok: false, status: 403 });
    expect(authorize(lilei, "UseDev", "")).toBe(false);
    expect(authorize(lilei, "Contribute", "")).toBe(true);
    // A full member reads the queue; deciding still needs `deploy`.
    expect(route("GET", "/api/merge-queue", SUBJECTS.devMember).ok).toBe(true);
    expect(route("POST", "/api/merge-queue/decide", SUBJECTS.devMember)).toMatchObject({ ok: false, status: 403 });
    expect(route("POST", "/api/merge-queue/decide", SUBJECTS.deployer).ok).toBe(true);
    expect(route("POST", "/api/merge-queue/run", SUBJECTS.deployer).ok).toBe(true);
    // Cross-account reads stay where they were: nowhere, for a contributor.
    expect(mayRead(lilei, "alice")).toBe(false);
    expect(mayRead(lilei, "lilei")).toBe(true);
  });

  it("deploy is not implied by dev — this is P1-4", () => {
    const dana = SUBJECTS.devMember;
    const q = new URLSearchParams();
    expect(authorizeRoute({ method: "POST", pathname: "/api/deploy", searchParams: q, viewer: dana, enabledFeatures: DEV_FEATURES }))
      .toMatchObject({ ok: false, status: 403 });
    expect(authorizeRoute({ method: "POST", pathname: "/api/land", searchParams: q, viewer: dana, enabledFeatures: DEV_FEATURES }))
      .toMatchObject({ ok: false, status: 403 });
    // Reading the deploy state is a dev-level thing and stays allowed.
    expect(authorizeRoute({ method: "GET", pathname: "/api/deploy", searchParams: q, viewer: dana, enabledFeatures: DEV_FEATURES }).ok)
      .toBe(true);
  });

  it("every action has at least one subject it permits and one it refuses", () => {
    // A policy rule that permits nobody is dead, and one that permits everybody
    // is not a rule. Both are silent failures, so make them loud. The refusal
    // half asks about someone ELSE's account, because "may I touch my own
    // things" is true for every credential and would make this vacuous.
    for (const action of PANEL_ACTIONS) {
      const permits = Object.values(SUBJECTS).map((s) => authorize(s, action, s.username ?? "alice"));
      const refuses = Object.values(SUBJECTS).map((s) => authorize(s, action, "stranger"));
      expect(permits.some(Boolean), `${action} permits nobody`).toBe(true);
      if (action !== "View") expect(refuses.some((a) => !a), `${action} permits everybody`).toBe(true);
    }
  });
});

describe("the route table is the panel's whole surface", () => {
  it("resolves each rule to itself — nothing is shadowed by an earlier prefix", () => {
    for (const rule of ROUTES) {
      const sample = rule.path.endsWith("*") ? `${rule.path.slice(0, -1)}sub/thing` : rule.path;
      const method = rule.method === "ANY" ? "GET" : rule.method;
      const found = resolveRoute(method, sample);
      expect(found?.id, `${rule.method} ${rule.path}`).toBe(rule.id);
    }
  });

  it("an unlisted path is a 404, not an unguarded handler", () => {
    const v = authorizeRoute({
      method: "GET",
      pathname: "/api/something-new",
      searchParams: new URLSearchParams(),
      viewer: SUBJECTS.admin,
      enabledFeatures: DEV_FEATURES,
    });
    expect(v).toMatchObject({ ok: false, status: 404 });
  });

  it("dev routes are 404 when the pipeline is off, not 403", () => {
    // Absent and forbidden are different answers, and the panel has always
    // said "disabled" rather than "you may not" for this one.
    const v = authorizeRoute({
      method: "GET",
      pathname: "/tickets",
      searchParams: new URLSearchParams(),
      viewer: SUBJECTS.admin,
      enabledFeatures: [],
    });
    expect(v).toMatchObject({ ok: false, status: 404 });
  });

  // "covers every path server.ts dispatches on" used to live here as a regular
  // expression over `server.ts`, because there was no table to walk — the
  // dispatcher was an if-chain. Fastify owns the table now and every route
  // declares its rule id, so the check moved to `routes.test.ts`, where it runs
  // against the REAL router and in both directions (no handler without a rule,
  // no rule without a handler, and the two matchers agreeing on every path).

  it("names every route, uniquely", () => {
    const ids = ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
