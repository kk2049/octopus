/**
 * Which destinations the panel offers this viewer, decided server-side.
 *
 * ── Why the server still decides the navigation ─────────────────────────────
 *
 * The browser app could filter its own tabs, and that would be a second opinion
 * about what this composition serves. This is the first one: it reads the SAME
 * `routeIsAvailable` the router reads, so a tab can never advertise a page the
 * request would 404 — and adding a page to a surface does not require
 * remembering to add it here too.
 *
 * Everything here is a NAVIGATION HINT. Hiding a tab is not authorization: the
 * page behind it still crosses the whole Cedar policy on every request, and the
 * app is written to render the server's refusal rather than to predict it.
 * `audience` exists only so the panel does not show a person a door that is
 * theirs to see refused.
 */

import {
  BOOTSTRAP_REDIRECTS,
  routeIsAvailable,
  surfaceAllows,
  type PanelSurface,
} from "./authz.js";
import { PANEL_FEATURE, type EnabledPanelFeatures, type PanelFeature } from "./features.js";

/** Structural subset of `DashboardIdentity` the navigation needs. */
export interface NavIdentity {
  username?: string;
  admin: boolean;
  dev?: boolean;
  /** The tier below `dev`; `dev` implies it (capability-bits.ts). */
  contribute?: boolean;
  /** Present only for a real server-side browser login, never a raw bearer. */
  session?: unknown;
}

type TabAudience = "named" | "dev" | "contribute" | "admin";

export interface NavTab {
  /** Route id from the table, so nav and router consult one list. */
  id: string;
  path: string;
  label: string;
  audience?: TabAudience;
  /** Optional composition fact beyond the route's own feature. */
  feature?: PanelFeature;
}

const TABS: readonly NavTab[] = [
  { id: "page.overview", path: "/", label: "🐙 总览" },
  // The one session surface. `/sessions` remains only as a guarded redirect
  // for old bookmarks; it has no tab and no browser implementation.
  { id: "page.sessionsPlus", path: "/sessions-plus", label: "📜 会话" },
  // Keep the established product entry and position; v2 replaces its target.
  // Availability follows the declared v2 App, never the legacy App's presence.
  {
    id: "page.appOpen",
    path: "/apps/research-v2/open",
    label: "🔬 自动科研",
    audience: "named",
    feature: PANEL_FEATURE.researchCanvas,
  },
  // The ordinary user's launcher for declared Apps. `audience: "named"` — the
  // shared key names nobody and so has nothing to open; visibility otherwise
  // follows the route's feature via the same `routeIsAvailable` every tab uses.
  { id: "page.launcher", path: "/launcher", label: "🎲 应用市场", audience: "named" },
  // Two different pages, and the labels have to say which is which:
  // /permissions is "what may act on MY behalf, over MY devices" (every account
  // has one); /admin is "who may use the dev pipeline" (admins only).
  { id: "page.permissions", path: "/permissions", label: "🛡 权限中心", audience: "named" },
  // `contribute` is the page's real audience since 2026-08-20: a contributor
  // gets the same tab and the server shows them their own rows.
  { id: "page.tickets", path: "/tickets", label: "🛠 开发", audience: "contribute" },
  // The architecture observatory sits beside 开发: same audience, same
  // disclosure level (the atlas names paths and internal structure).
  { id: "page.architecture", path: "/architecture", label: "🏛 架构", audience: "contribute" },
  // The knowledge wiki: same audience and disclosure level as 架构 — statements
  // name paths, modules, ticket titles and internal decisions.
  { id: "page.knowledge", path: "/knowledge", label: "📚 知识库", audience: "contribute" },
  { id: "page.admin", path: "/admin", label: "👑 管理", audience: "admin" },
  // Which release of an Agentic App this host serves. Admin-only, and off
  // unless the composition constructed a registry.
  { id: "page.apps", path: "/apps", label: "📦 应用后台", audience: "admin" },
];

/**
 * Pages that exist for a viewer but are not offered as a tab.
 *
 * `/pending` is a guarded compatibility landing for old links — approval itself
 * lives in the trusted shell's pill so a person need not abandon the task they
 * are on — so it is reachable and must be in `pages`, but it is not navigation.
 */
const UNLISTED_PAGES: readonly { id: string; path: string }[] = [
  { id: "page.pending", path: "/pending" },
  // One declared App's Agent View. Never a tab: how many there are and what
  // they are called is a fact about this host's registry, not about this
  // build, so the links live on `/apps` where that registry is already listed.
  // It is still in `pages` because the browser's router must know it is served
  // — otherwise a link from `/apps` lands on "this composition does not serve
  // that page", which would be a false sentence.
  { id: "page.appOpen", path: "/apps/:app/open" },
];

function audienceAllows(audience: TabAudience | undefined, identity: NavIdentity | null): boolean {
  if (!audience) return true;
  if (audience === "named") return Boolean(identity?.username);
  if (audience === "dev") return Boolean(identity?.dev);
  if (audience === "contribute") return Boolean(identity?.contribute || identity?.dev);
  return Boolean(identity?.admin);
}

function servesPage(
  id: string,
  surface: PanelSurface,
  features: EnabledPanelFeatures | undefined,
): boolean {
  return (
    routeIsAvailable(surface, id, features)
    // A route that only redirects is on the surface but is not a page, so a tab
    // for it would be a link that bounces. Same map the router reads.
    && !(surface === "bootstrap-v3" && BOOTSTRAP_REDIRECTS.has(id))
  );
}

/** Tabs this viewer is offered, in display order. */
export function navTabs(
  identity: NavIdentity | null,
  surface: PanelSurface,
  features: EnabledPanelFeatures | undefined,
): NavTab[] {
  // Feature availability is a composition fact. 管理 and 权限中心 remain identity
  // facts: the former needs admin, while the shared key names no person and
  // therefore owns no grants to show in the latter.
  const devFeature = features?.includes(PANEL_FEATURE.devPipeline) ?? false;
  return TABS.filter(
    (tab) =>
      servesPage(tab.id, surface, features)
      && (!tab.feature || features?.includes(tab.feature))
      && (tab.id !== "page.tickets" || devFeature)
      && audienceAllows(tab.audience, identity),
  );
}

/** Every page route id this composition serves this viewer (a superset of tabs). */
export function servedPages(
  identity: NavIdentity | null,
  surface: PanelSurface,
  features: EnabledPanelFeatures | undefined,
): string[] {
  const ids = navTabs(identity, surface, features).map((tab) => tab.id);
  for (const page of UNLISTED_PAGES) {
    if (servesPage(page.id, surface, features) && Boolean(identity?.username) && !ids.includes(page.id)) ids.push(page.id);
  }
  return ids;
}

/**
 * May the trusted approval pill be rendered at all.
 *
 * A bearer credential proves a credential exists somewhere; a browser session is
 * the closest thing to a human at a keyboard, and only the latter may approve.
 */
export function approvalsAvailable(
  identity: NavIdentity | null,
  surface: PanelSurface,
): boolean {
  return Boolean(identity?.username && identity.session && surfaceAllows(surface, "page.pending"));
}
