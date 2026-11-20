/** The old preview URL stays authenticated and moves into the permission centre. */

import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ROUTE_IDS, ROUTES, resolveRoute } from "./authz.js";
import { navTabs, servedPages } from "./navigation.js";
import { PANEL_FEATURE } from "./features.js";

const FEATURES = [PANEL_FEATURE.devPipeline, PANEL_FEATURE.sessionPlus];
const ALICE = { username: "alice", admin: false, dev: false };
/** The shared `auth_token`: a credential that names no account. */
const SHARED = { admin: true, dev: true };

describe("the access observatory preview page", () => {
  it("declares a rule that puts it behind the identity gate", () => {
    const rule = ROUTES.find((route) => route.id === "page.accessPreview");
    expect(rule).toMatchObject({
      method: "GET",
      path: "/access-preview",
      action: "Identify",
      target: "self",
    });
    // And the router's own classification of the path agrees with the table.
    expect(resolveRoute("GET", "/access-preview")?.id).toBe("page.accessPreview");
  });

  it("is on the v3 bootstrap surface, which is the composition production serves", () => {
    expect(BOOTSTRAP_ROUTE_IDS.has("page.accessPreview")).toBe(true);
  });

  it("is offered to a named account and withheld from the shared key", () => {
    const tabs = navTabs(ALICE, "bootstrap-v3", FEATURES);
    expect(tabs.some((tab) => tab.path === "/access-preview")).toBe(false);
    expect(servedPages(ALICE, "bootstrap-v3", FEATURES)).toContain("page.permissions");
    expect(navTabs(SHARED, "bootstrap-v3", FEATURES).map((tab) => tab.path)).not.toContain(
      "/access-preview",
    );
  });

  it("has only 权限中心 as a navigation entry", () => {
    const paths = navTabs(ALICE, "bootstrap-v3", FEATURES).map((tab) => tab.path);
    expect(paths).toContain("/permissions");
    expect(paths).not.toContain("/access-preview");
  });
});
