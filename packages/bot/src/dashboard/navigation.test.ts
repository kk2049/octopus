/**
 * What the panel offers a viewer, and why that is not authorization.
 *
 * This is what remains of `shell.test.ts` after the browser layer moved to a
 * React bundle: the parts of that file that were about a rendered `<a>` are now
 * component tests, and the parts that were about a DECISION are here, asked of
 * the function that makes it.
 *
 * The rule the whole file exists to hold: hiding a tab is a courtesy, not a
 * boundary. Every one of these pages still crosses the full Cedar policy on
 * every request — the tests that prove THAT live in `authz.test.ts` and
 * `server-bootstrap.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { approvalsAvailable, navTabs, servedPages } from "./navigation.js";
import { PANEL_FEATURE } from "./features.js";

const ALL = [PANEL_FEATURE.devPipeline, PANEL_FEATURE.sessionPlus];
const paths = (tabs: ReturnType<typeof navTabs>) => tabs.map((tab) => tab.path);
const labelAt = (tabs: ReturnType<typeof navTabs>, path: string) =>
  tabs.find((tab) => tab.path === path)?.label;

const ALICE = { username: "alice", admin: false, dev: false };
const CONTRIB = { username: "lilei", admin: false, dev: false, contribute: true };
const DEV = { username: "dev", admin: false, dev: true };
const ADMIN = { username: "root", admin: true, dev: true };
/** The shared `auth_token`: a credential with no account behind it. */
const SHARED = { admin: true, dev: true };

describe("navigation on the full panel", () => {
  it("offers 开发 and 架构 to a contributor, and nothing administrative", () => {
    const tabs = paths(navTabs(CONTRIB, "full", [...ALL, PANEL_FEATURE.architecture]));
    expect(tabs).toContain("/tickets");
    expect(tabs).toContain("/architecture");
    expect(tabs).not.toContain("/admin");
    // An ordinary account without the bit still gets neither.
    expect(paths(navTabs(ALICE, "full", [...ALL, PANEL_FEATURE.architecture]))).not.toContain("/tickets");
  });

  it("offers the ordinary pages to an ordinary account", () => {
    expect(paths(navTabs(ALICE, "full", ALL))).toEqual([
      "/",
      "/sessions-plus",
      "/permissions",
    ]);
  });

  it("offers the App launcher to any NAMED account once the registry feature exists", () => {
    const withApps = [...ALL, PANEL_FEATURE.appRegistry];
    // The discoverability fix: an ordinary user gets the launcher tab...
    expect(paths(navTabs(ALICE, "full", withApps))).toContain("/launcher");
    // ...the shared key names nobody and has nothing to open...
    expect(paths(navTabs(SHARED, "full", withApps))).not.toContain("/launcher");
    // ...and without the feature the composition built nothing to list.
    expect(paths(navTabs(ALICE, "full", ALL))).not.toContain("/launcher");
    // The operator registry stays the admin's; the launcher does not replace it.
    expect(paths(navTabs(ALICE, "full", withApps))).not.toContain("/apps");
    expect(paths(navTabs(ADMIN, "full", withApps))).toContain("/apps");
  });

  it("replaces the established research entry with v2 even while the legacy App remains declared", () => {
    const legacy = [...ALL, PANEL_FEATURE.appRegistry, PANEL_FEATURE.researchProgram];
    const withResearch = [...legacy, PANEL_FEATURE.researchCanvas];
    for (const surface of ["full", "bootstrap-v3"] as const) {
      for (const viewer of [ALICE, ADMIN]) {
        const tabs = navTabs(viewer, surface, withResearch);
        expect(tabs.filter(tab => tab.id === "page.appOpen")).toEqual([
          expect.objectContaining({ path: "/apps/research-v2/open", label: "🔬 自动科研" }),
        ]);
        expect(paths(tabs).indexOf("/apps/research-v2/open")).toBeLessThan(paths(tabs).indexOf("/launcher"));
        expect(paths(tabs)).not.toContain("/apps/research-program/open");
      }
      expect(paths(navTabs(SHARED, surface, withResearch))).not.toContain("/apps/research-v2/open");
      expect(paths(navTabs(ALICE, surface, legacy))).not.toContain("/apps/research-v2/open");
    }
  });

  it("distinguishes the user App market from the admin App backend", () => {
    const withApps = [...ALL, PANEL_FEATURE.appRegistry];
    expect(labelAt(navTabs(ALICE, "full", withApps), "/launcher")).toBe("🎲 应用市场");
    expect(labelAt(navTabs(ALICE, "full", withApps), "/apps")).toBeUndefined();
    expect(labelAt(navTabs(ADMIN, "full", withApps), "/launcher")).toBe("🎲 应用市场");
    expect(labelAt(navTabs(ADMIN, "full", withApps), "/apps")).toBe("📦 应用后台");
  });

  it("shows the dev tab only when the feature exists AND the viewer is a dev", () => {
    expect(paths(navTabs(ALICE, "full", ALL))).not.toContain("/tickets");
    expect(paths(navTabs(DEV, "full", ALL))).toContain("/tickets");
    // Feature off: not even for a dev, because the composition built nothing.
    expect(paths(navTabs(DEV, "full", [PANEL_FEATURE.sessionPlus]))).not.toContain("/tickets");
  });

  it("shows the architecture tab only when the feature exists AND the viewer is a dev", () => {
    const withArch = [...ALL, PANEL_FEATURE.architecture];
    expect(paths(navTabs(DEV, "full", withArch))).toContain("/architecture");
    // The dev audience gates it: an ordinary account never sees the tab.
    expect(paths(navTabs(ALICE, "full", withArch))).not.toContain("/architecture");
    // Feature off: not even for a dev, because the composition built nothing.
    expect(paths(navTabs(DEV, "full", ALL))).not.toContain("/architecture");
  });

  it("shows 管理 only to an admin", () => {
    expect(paths(navTabs(ALICE, "full", ALL))).not.toContain("/admin");
    expect(paths(navTabs(ADMIN, "full", ALL))).toContain("/admin");
  });

  it("gives the shared key no 权限中心 — it names nobody, so it owns no grants", () => {
    expect(paths(navTabs(SHARED, "full", ALL))).not.toContain("/permissions");
    expect(paths(navTabs(ALICE, "full", ALL))).toContain("/permissions");
  });

  it("offers Session Plus as the only session destination", () => {
    const withProbe = paths(navTabs(ALICE, "full", ALL));
    expect(withProbe).not.toContain("/sessions");
    expect(withProbe).toContain("/sessions-plus");
    expect(paths(navTabs(ALICE, "full", [PANEL_FEATURE.devPipeline]))).not.toContain("/sessions-plus");
  });
});

describe("navigation on the v3 bootstrap surface", () => {
  it("offers the control plane and never the retired redirect", () => {
    const bootstrap = paths(navTabs(ADMIN, "bootstrap-v3", ALL));
    expect(bootstrap).toContain("/");
    expect(bootstrap).not.toContain("/sessions");
    expect(bootstrap).toContain("/sessions-plus");
    expect(bootstrap).toContain("/permissions");
  });

  it("keeps Overview when Session Plus is off and never offers the retired redirect", () => {
    const featureOff = paths(navTabs(ADMIN, "bootstrap-v3", [PANEL_FEATURE.devPipeline]));
    expect(featureOff).toContain("/");
    expect(featureOff).not.toContain("/sessions");
    expect(featureOff).not.toContain("/sessions-plus");
  });
});

describe("served pages are a superset of the tabs", () => {
  it("includes /pending, which is reachable but is not a destination", () => {
    const pages = servedPages(ALICE, "full", ALL);
    expect(pages).toContain("page.pending");
    expect(paths(navTabs(ALICE, "full", ALL))).not.toContain("/pending");
  });

  it("does not offer /pending to a credential with no account", () => {
    expect(servedPages(SHARED, "full", ALL)).not.toContain("page.pending");
  });
});

describe("the approval affordance", () => {
  it("exists only for a real browser session", () => {
    expect(approvalsAvailable({ ...ALICE, session: {} }, "full")).toBe(true);
    // A bearer proves a credential exists somewhere, not that a person is here.
    expect(approvalsAvailable(ALICE, "full")).toBe(false);
  });

  it("never exists for the shared key, session or not", () => {
    expect(approvalsAvailable({ ...SHARED, session: {} }, "full")).toBe(false);
  });

  it("exists on both surfaces, because approval is on both", () => {
    expect(approvalsAvailable({ ...ALICE, session: {} }, "bootstrap-v3")).toBe(true);
  });
});
