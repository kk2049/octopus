/**
 * Configuration cannot say a wildcard, and cannot disagree with the code.
 *
 * The interesting cases are the ones that LOOK fine: a hostname from last
 * release (the browser isolates it perfectly and the digest no longer describes
 * what is served), and a second port on the same host (a different origin, but
 * cookies are not port-scoped, so the view would receive the panel's session).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_HOSTED_APPS,
  resolveSessionPlus,
  suggestedViewOrigin,
} from "./settings.js";
import { sessionPlusIdentity } from "./identity.js";

const LABEL = sessionPlusIdentity().packageHostLabel;
const PROD_ORIGIN = `https://${LABEL}.apps.example.org`;
const PANEL = "https://bot.example.org";

const resolve = (config: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
  resolveSessionPlus({ config, publicUrl: PANEL, ...extra });

describe("the flag is closed unless it is opened", () => {
  it("treats an absent block as off", () => {
    expect(resolve(undefined)).toEqual({ enabled: false, errors: [] });
  });

  it("treats enabled:false as off, whatever else is configured", () => {
    expect(resolve({ enabled: false, view_origin: PROD_ORIGIN })).toEqual({ enabled: false, errors: [] });
  });

  it("reports an enabled block with no origin rather than quietly doing nothing", () => {
    const r = resolve({ enabled: true });
    expect(r.enabled).toBe(true);
    expect(r).toMatchObject({ settings: null });
    expect(r.errors.join(" ")).toContain(LABEL);
  });
});

describe("a valid production block", () => {
  const r = resolve({ enabled: true, view_origin: PROD_ORIGIN });

  it("resolves to one exact view origin and one exact frame ancestor", () => {
    expect(r).toMatchObject({ enabled: true, errors: [] });
    const s = r.enabled && r.settings ? r.settings : null;
    expect(s?.viewOrigin).toBe(PROD_ORIGIN);
    expect(s?.viewHostHeader).toBe(`${LABEL}.apps.example.org`);
    expect(s?.frameAncestors).toEqual([PANEL]);
    expect(s?.development).toBe(false);
    // Loopback listener by default: the public origin is the proxy's business.
    expect(s?.listenHost).toBe("127.0.0.1");
    expect(s?.listenPort).toBe(9821);
    expect(s?.maxHostedApps).toBe(DEFAULT_MAX_HOSTED_APPS);
  });

  it("carries the identity, so nothing downstream recomputes a digest", () => {
    const s = r.enabled && r.settings ? r.settings : null;
    expect(s?.identity.packageHostLabel).toBe(LABEL);
    expect(s?.identity.stableAppId).toBe("session-plus");
  });

  it("normalizes deployment grants in the stable contract order", () => {
    const configured = resolve({
      enabled: true,
      view_origin: PROD_ORIGIN,
      grants: {
        alice: {
          operations: ["read_session", "list_recent_sessions", "append_session", "read_session"],
          auto_allow: ["read_session", "list_recent_sessions"],
        },
      },
    });
    const settings = configured.enabled && configured.settings ? configured.settings : null;
    expect(settings?.grants).toEqual([{
      owner: "alice",
      operations: ["list_recent_sessions", "read_session", "append_session"],
      autoAllow: ["list_recent_sessions", "read_session"],
    }]);
  });

  it("accepts an explicit process-wide hosted App ceiling", () => {
    const configured = resolve({
      enabled: true,
      view_origin: PROD_ORIGIN,
      max_hosted_apps: 9,
    });
    const settings = configured.enabled && configured.settings ? configured.settings : null;
    expect(settings?.maxHostedApps).toBe(9);
  });
});

describe("the hot-update app domain", () => {
  it("normalises an explicitly written default port so ordinary Host headers still match", () => {
    const r = resolve({
      enabled: true,
      app_domain: "apps.example.org",
      app_scheme: "https",
      app_public_port: 443,
      view_port: 9821,
    });
    expect(r).toMatchObject({ enabled: true, errors: [] });
    const s = r.enabled && r.settings ? r.settings : null;
    expect(s?.origin.publicPort).toBeNull();
    expect(s?.viewOrigin).toBe(PROD_ORIGIN);
    expect(s?.viewHostHeader).toBe(`${LABEL}.apps.example.org`);
  });

  it("retains a genuinely non-default public port", () => {
    const r = resolve({
      enabled: true,
      app_domain: "apps.example.org",
      app_scheme: "https",
      app_public_port: 8443,
      view_port: 9821,
    });
    expect(r).toMatchObject({ enabled: true, errors: [] });
    const s = r.enabled && r.settings ? r.settings : null;
    expect(s?.origin.publicPort).toBe(8443);
    expect(s?.viewOrigin).toBe(`${PROD_ORIGIN}:8443`);
  });
});

describe("what configuration is refused", () => {
  const errs = (config: Record<string, unknown>, extra: Record<string, unknown> = {}): string => {
    const r = resolveSessionPlus({ config, publicUrl: PANEL, ...extra });
    expect(r).toMatchObject({ enabled: true, settings: null });
    return r.errors.join("\n");
  };

  it("a wildcard origin", () => {
    expect(errs({ enabled: true, view_origin: "https://*.apps.example.org" })).toContain("通配符");
  });

  it("a hosted App ceiling outside the bounded integer range", () => {
    for (const value of [0, 1.5, 65, "9"]) {
      expect(errs({ enabled: true, view_origin: PROD_ORIGIN, max_hosted_apps: value }))
        .toContain("max_hosted_apps");
    }
  });

  it("a hostname whose label is not this build's digest", () => {
    const stale = "https://app-0123456789abcdef0123.apps.example.org";
    const message = errs({ enabled: true, view_origin: stale });
    expect(message).toContain("app-0123456789abcdef0123");
    expect(message).toContain(LABEL);
  });

  it("plain http on a public hostname", () => {
    expect(errs({ enabled: true, view_origin: `http://${LABEL}.apps.example.org` })).toContain("https");
  });

  it("an origin that carries a path, query or credentials", () => {
    expect(errs({ enabled: true, view_origin: `${PROD_ORIGIN}/view` })).toContain("origin");
    expect(errs({ enabled: true, view_origin: `${PROD_ORIGIN}/?x=1` })).toContain("origin");
  });

  it("something that is not a URL at all", () => {
    expect(errs({ enabled: true, view_origin: "app-whatever" })).toContain("合法 URL");
  });

  it("the panel's own hostname, even on another port — cookies are not port-scoped", () => {
    // The failure this catches is the one that looks fine: two different
    // origins, so the DOM boundary holds, while every cookie the panel sets is
    // sent to the View on its first navigation.
    const samehost = `https://bot.example.org:9821`;
    const message = errs({ enabled: true, view_origin: samehost });
    expect(message).toContain("Cookie 不按端口隔离");
    expect(message).toContain("bot.example.org");
  });

  it("the panel's own origin outright", () => {
    const message = errs({ enabled: true, view_origin: PANEL }, {});
    expect(message).toContain("共用主机名");
  });

  it("a loopback dev View paired with an https panel — and the other direction", () => {
    // https panel + http View: an https page cannot frame an http document at
    // all, so this deployment would show an empty box and no error.
    const mixedDown = errs({ enabled: true, view_origin: `http://${LABEL}.localhost:9821` });
    expect(mixedDown).toContain("协议不一致");

    // http panel + https View: the panel would issue the UNPREFIXED cookie pair
    // (no Secure on http) while the deployment looks like production.
    const r = resolveSessionPlus({
      config: { enabled: true, view_origin: PROD_ORIGIN },
      dashboardPort: 9820,
      publicUrl: "http://bot.internal:9820",
    });
    expect(r).toMatchObject({ enabled: true, settings: null });
    expect(r.errors.join("\n")).toContain("协议不一致");
  });

  it("an http main origin that is not this machine — the http path is LOCAL development", () => {
    // The previous version only compared the two schemes to each other, so a
    // routable http panel paired with a loopback View passed: a session id
    // crossing a network in cleartext, configured by accident.
    for (const main of [
      "http://bot.internal:9820",
      "http://192.168.1.10:9820",
      "http://10.0.0.5:9820",
      "http://panel.example.com",
      // Names that merely CONTAIN the word are not local.
      "http://localhost.evil.com:9820",
      "http://evil-localhost:9820",
      "http://notlocalhost:9820",
    ]) {
      const r = resolveSessionPlus({
        config: { enabled: true, view_origin: `http://${LABEL}.localhost:9821` },
        publicUrl: main,
      });
      expect(r, main).toMatchObject({ enabled: true, settings: null });
      expect(r.errors.join("\n"), main).toContain("http 这条路只支持");
    }
  });

  it("a locality mismatch in either direction", () => {
    // A public page framing localhost asks every visitor's OWN machine for the
    // View; a localhost page framing a public View is the same mistake pointing
    // the other way. Both are configuration accidents that would look like they
    // worked for the one operator whose machine runs both halves.
    const publicView = resolveSessionPlus({
      config: { enabled: true, view_origin: `https://${LABEL}.apps.example.org` },
      publicUrl: "https://localhost:9820",
    });
    expect(publicView).toMatchObject({ enabled: true, settings: null });
    expect(publicView.errors.join("\n")).toContain("本机/对外");

    const localView = resolveSessionPlus({
      config: { enabled: true, view_origin: `http://${LABEL}.localhost:9821` },
      publicUrl: "https://bot.example.org",
    });
    expect(localView).toMatchObject({ enabled: true, settings: null });
    // Refused twice over: mixed scheme AND mixed locality.
    expect(localView.errors.join("\n")).toMatch(/协议不一致|本机\/对外/);
  });

  it("a public_url whose scheme cannot express an origin at all", () => {
    // `new URL("data:…").origin` is the string "null" — the same value a browser
    // sends for an opaque document. Configuring that as an allowed origin used
    // to resolve fine and then throw inside the CSP builder on the FIRST
    // request; it must fail here instead.
    for (const bad of ["data:text/html,x", "javascript:alert(1)", "file:///etc/passwd", "about:blank"]) {
      const r = resolveSessionPlus({
        config: { enabled: true, view_origin: PROD_ORIGIN },
        publicUrl: bad,
      });
      expect(r, bad).toMatchObject({ enabled: true, settings: null });
      expect(r.errors.join("\n"), bad).toContain("dashboard.public_url");
    }
  });

  it("a production origin with no configured panel URL to frame it from", () => {
    const r = resolveSessionPlus({ config: { enabled: true, view_origin: PROD_ORIGIN }, dashboardPort: 9820 });
    expect(r).toMatchObject({ enabled: true, settings: null });
    expect(r.errors.join(" ")).toContain("dashboard.public_url");
  });

  it("an impossible port", () => {
    expect(errs({ enabled: true, view_origin: PROD_ORIGIN, view_port: 70000 })).toContain("端口");
  });

  it("unknown grant operations", () => {
    expect(errs({
      enabled: true,
      view_origin: PROD_ORIGIN,
      grants: { alice: { operations: ["read_session", "exec_anything"] } },
    })).toContain("未知权限");
  });

  it("accepts owner-local execute auto-allow and rejects values outside the grant/policy", () => {
    expect(resolve({
      enabled: true,
      view_origin: PROD_ORIGIN,
      grants: { alice: { operations: ["append_session"], auto_allow: ["append_session"] } },
    })).toMatchObject({ enabled: true, errors: [] });
    expect(errs({
      enabled: true,
      view_origin: PROD_ORIGIN,
      grants: { alice: { operations: ["read_session"], auto_allow: ["search_sessions"] } },
    })).toContain("契约允许静默执行");
    expect(errs({
      enabled: true,
      view_origin: PROD_ORIGIN,
      grants: { alice: { operations: ["edit_document"], auto_allow: ["edit_document"] } },
    })).toContain("契约允许静默执行");
  });
});

describe("the documented local-development path", () => {
  it("accepts http on a *.localhost host and frames from the panel's loopback origins", () => {
    const r = resolveSessionPlus({
      config: { enabled: true, view_origin: `http://${LABEL}.localhost:9821` },
      dashboardPort: 9820,
    });
    expect(r).toMatchObject({ enabled: true, errors: [] });
    const s = r.enabled && r.settings ? r.settings : null;
    expect(s?.development).toBe(true);
    expect(s?.listenPort).toBe(9821);
    // A different HOST, not merely a different port: cookies are not
    // port-scoped, so `http://localhost:9821` would have received the panel's
    // session cookie and quietly voided the whole exercise.
    expect(s?.viewHostHeader.endsWith(".localhost:9821")).toBe(true);
    expect(s?.frameAncestors).toEqual([
      "http://127.0.0.1:9820",
      "http://localhost:9820",
      "http://[::1]:9820",
    ]);
    expect(s?.frameAncestors.some((o) => o.includes("*"))).toBe(false);
  });

  it("still refuses a loopback origin whose label is stale", () => {
    const r = resolveSessionPlus({
      config: { enabled: true, view_origin: "http://app-000000000000000000ff.localhost:9821" },
      dashboardPort: 9820,
    });
    expect(r).toMatchObject({ enabled: true, settings: null });
  });
});

describe("exactly two shapes are supported", () => {
  it("production: https main + https digest View, different hostnames, neither local", () => {
    const r = resolveSessionPlus({ config: { enabled: true, view_origin: PROD_ORIGIN }, publicUrl: PANEL });
    expect(r).toMatchObject({ enabled: true, errors: [] });
  });

  it("development: http loopback main + http *.localhost View", () => {
    const r = resolveSessionPlus({
      config: { enabled: true, view_origin: `http://${LABEL}.localhost:9821` },
      dashboardPort: 9820,
    });
    expect(r).toMatchObject({ enabled: true, errors: [] });
  });

  it("keeps the whole loopback family usable, and nothing that only looks like it", () => {
    // 127/8, ::1, localhost and *.localhost are the local names; the View is
    // always `app-<digest>.localhost` in this shape, so the main side is what
    // varies here.
    for (const main of ["http://127.0.0.1:9820", "http://127.5.6.7:9820", "http://[::1]:9820", "http://localhost:9820"]) {
      const r = resolveSessionPlus({
        config: { enabled: true, view_origin: `http://${LABEL}.localhost:9821` },
        publicUrl: main,
      });
      expect(r, main).toMatchObject({ enabled: true, errors: [] });
    }
    // …and an address outside 127/8 is not loopback however much it looks it.
    const r = resolveSessionPlus({
      config: { enabled: true, view_origin: `http://${LABEL}.localhost:9821` },
      publicUrl: "http://128.0.0.1:9820",
    });
    expect(r).toMatchObject({ enabled: true, settings: null });
  });
});

describe("the hostname an operator should paste", () => {
  it("is derived from this build, not typed by hand", () => {
    expect(suggestedViewOrigin("apps.example.org")).toBe(PROD_ORIGIN);
    expect(suggestedViewOrigin(".apps.example.org")).toBe(PROD_ORIGIN);
  });
});
