/**
 * The end of the P3 sentence: a declared App can now be OPENED.
 *
 * ── What was missing, and what this file pins ───────────────────────────────
 *
 * P3 made a second App a row in a table plus an installed bundle — declare,
 * install, activate, backend children, all of it working. And a browser still
 * could not reach it, because the one Agent View listener was wired to the one
 * compiled-in app's publication. The fix is not new machinery: `labelFromHost` →
 * lookup was always app-agnostic, and what changed is that the publication it
 * resolves through is now the CATALOG's.
 *
 * So this file drives the whole thing over real HTTP with a real declared
 * release (the showcase package this checkout builds), and asserts the four
 * answers that matter:
 *
 *  · a declared App's own digest hostname serves that release's own bytes;
 *  · Session Plus's hostname still serves Session Plus's, from the same
 *    listener — a union that stole one app's names would be found here;
 *  · a well-formed name for a release nobody installed is 404, with no app code
 *    in the body ("this host does not publish that" — a stale DNS record or a
 *    tab open across an uninstall);
 *  · a name that is not the `app-<20 hex>.<domain>` shape is 421 ("this listener
 *    does not serve that name" — a misconfigured proxy). Collapsing those two
 *    would make one of two very different operator problems undiagnosable.
 *
 * Skipped, loudly, when the showcase Agent View has not been built: the point of
 * the file is that a real release is served, and a fixture-only version would
 * pass while proving something weaker.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppReleaseRegistry, FileReleaseContentStore, packageHostLabel } from "@claude-bot/app-registry";
import { SHOWCASE_APP, SHOWCASE_PUBLISHER } from "@claude-bot/showcase-view/plan";
import { Store } from "../store/store.js";
import { resolveSessionPlus, type SessionPlusSettings } from "../app-core/settings.js";
import { PANEL_RESOURCE_CONTRACTS } from "../dashboard/server.js";
import { StoreReleaseCatalog } from "./store-catalog.js";
import { appReleasePaths } from "./paths.js";
import { AppReleaseHost, HostedApp } from "./release-host.js";
import { DeclaredAppComposer } from "./declared-apps.js";
import { declaredAppHostingFrom } from "./declared-adapter.js";
import { SessionPlusReleaseAdapter } from "./session-plus-adapter.js";
import { AppViewServer } from "./view-server.js";
import { AppOriginAskServer } from "./origin-ask.js";
import { loadAgentViewRelease } from "@claude-bot/agent-view-build/release";
import {
  SHOWCASE_VIEW_BUILD_COMMAND,
  SHOWCASE_VIEW_DIST,
  SHOWCASE_VIEW_SOURCE,
} from "@claude-bot/showcase-view";
import { SHOWCASE_TITLE, buildShowcaseBundle } from "./showcase-package.js";
import { buildCheckoutBundle } from "./session-plus-package.js";
import { SESSION_PLUS_VIEW_DIST } from "@claude-bot/session-plus-view";

const DOMAIN = "localhost";
const PANEL = "http://localhost:9820";

function built(): boolean {
  // Missing output is an explicit environment skip. A present but stale or
  // incompatible build must fail this suite instead of pretending it was absent.
  if (!existsSync(SHOWCASE_VIEW_DIST) || !existsSync(SESSION_PLUS_VIEW_DIST)) return false;
  loadAgentViewRelease({
    distDir: SHOWCASE_VIEW_DIST,
    source: SHOWCASE_VIEW_SOURCE,
    buildCommand: SHOWCASE_VIEW_BUILD_COMMAND,
    expectedOutputs: ["agent-view.js", "agent-view.css"],
    allowModuleAssets: true,
  });
  buildCheckoutBundle();
  return true;
}

const ready = built();
if (!ready) {
  process.stdout.write(
    "declared-app-view.test.ts: skipping — run `pnpm -r build` (both Agent View bundles) first\n",
  );
}

/**
 * A short, stable fingerprint of one release's script.
 *
 * The tail rather than the head: two Vite IIFE bundles begin with the same
 * runtime preamble, and the end of the file is the App's own entry. Short
 * enough that a failed assertion is readable.
 */
function script(source: string): string {
  return source.trimEnd().slice(-160);
}

interface Answer {
  status: number;
  body: string;
  header(name: string): string | null;
}

/**
 * Raw `node:http`, because `fetch` refuses to let a caller set `Host` — and
 * `Host` is the whole lookup key here.
 */
function ask(port: number, host: string, urlPath = "/"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: urlPath, method: "GET", headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          header: (name) => {
            const value = res.headers[name.toLowerCase()];
            return value === undefined ? null : Array.isArray(value) ? value.join(", ") : String(value);
          },
        }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!ready)("one Agent View origin, every App this host serves", () => {
  let dir: string;
  let store: Store;
  let host: AppReleaseHost;
  let view: AppViewServer;
  let originAsk: AppOriginAskServer;
  let settings: SessionPlusSettings;
  let showcaseDigest: string;
  let sessionPlusDigest: string;
  let showcaseScript: string;
  let sessionPlusScript: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "declared-view-"));
    store = new Store(path.join(dir, "bot.db"));
    const paths = appReleasePaths(dir);
    const registry = new AppReleaseRegistry({
      catalog: new StoreReleaseCatalog(store),
      content: new FileReleaseContentStore(paths.contentRoot),
    });
    const resolved = resolveSessionPlus({
      config: { enabled: true, app_domain: DOMAIN, app_scheme: "http", app_public_port: 9821, view_port: 0 },
      publicUrl: PANEL,
    });
    if (!resolved.enabled || !resolved.settings) {
      throw new Error(`fixture config is invalid: ${resolved.errors.join("; ")}`);
    }
    settings = resolved.settings;

    // The compiled-in app, so "adding an App did not take another App's names"
    // has something to be true about.
    const sessionPlus = new HostedApp({
      registry,
      adapter: new SessionPlusReleaseAdapter({
        preparedRoot: paths.preparedRoot,
        resourceContracts: () => new Set(PANEL_RESOURCE_CONTRACTS),
        baseSettings: settings,
      }),
    });
    host = new AppReleaseHost({ registry, apps: [sessionPlus] });
    await host.start();
    sessionPlusDigest = sessionPlus.active()!.prepared.identity.packageDigest;

    const hosting = declaredAppHostingFrom(settings);
    if (!hosting.ok) throw new Error(hosting.error);
    const composer = new DeclaredAppComposer({
      store,
      registry,
      host,
      preparedRoot: paths.preparedRoot,
      hosting: hosting.hosting,
      // No backend children: this file is about publication, and two child
      // processes would prove nothing extra about which bytes a hostname names.
      backends: null,
    });
    const declared = await composer.declare({
      stableAppId: SHOWCASE_APP,
      publisher: SHOWCASE_PUBLISHER,
      title: SHOWCASE_TITLE,
      by: "user:test",
    });
    expect(declared).toMatchObject({ ok: true });

    const bundle = await buildShowcaseBundle();
    showcaseDigest = bundle.descriptor.packageDigest;
    const scriptOf = (b: { assets: readonly { name: string; content: Uint8Array }[] }): string =>
      Buffer.from(b.assets.find((asset) => asset.name === "view.js")!.content).toString("utf8");
    showcaseScript = scriptOf(bundle);
    sessionPlusScript = scriptOf(buildCheckoutBundle());
    expect(host.install(bundle, "user:test")).toMatchObject({ ok: true, app: SHOWCASE_APP });
    const activated = await host.app(SHOWCASE_APP)!.activate(showcaseDigest, "user:test");
    expect(activated.ok).toBe(true);

    // Exactly the composition root's wiring: settings from one app, publication
    // from the catalog.
    view = new AppViewServer(settings, {
      publishedLabels: () => host.publishedLabels(),
      documentFor: (label, nonce) => host.documentFor(label, nonce),
    });
    await view.start();
    originAsk = new AppOriginAskServer({
      host: "127.0.0.1",
      port: 0,
      policy: settings.origin,
      publishedLabels: () => host.publishedLabels(),
    });
    await originAsk.start();
  }, 120_000);

  afterAll(async () => {
    await originAsk?.stop();
    await view?.stop();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("serves the declared App's document from its own digest hostname", async () => {
    const label = packageHostLabel(showcaseDigest);
    const res = await ask(view.port, `${label}.${DOMAIN}:9821`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("<!doctype html>");
    // Its OWN bytes, compared against the exact script this release carries.
    // Asserted as booleans rather than with `toContain`, because a failure that
    // printed a 400 KB bundle diff would bury the sentence it is trying to say.
    expect(res.body.includes(script(showcaseScript))).toBe(true);
    expect(res.body.includes(script(sessionPlusScript))).toBe(false);
    // The response contract the boundary depends on is unchanged for a second
    // app — it comes from the same `viewFrameHeaders`.
    const csp = res.header("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`frame-ancestors ${PANEL}`);
    expect(res.header("set-cookie")).toBeNull();
  });

  it("still serves the compiled-in App from its own hostname, from the same listener", async () => {
    const res = await ask(view.port, `${packageHostLabel(sessionPlusDigest)}.${DOMAIN}:9821`);
    expect(res.status).toBe(200);
    expect(res.body.includes(script(sessionPlusScript))).toBe(true);
    expect(res.body.includes(script(showcaseScript))).toBe(false);
  });

  it("404s a well-formed name for a release nobody installed, and serves no app code", async () => {
    const before = view.stats.served;
    const res = await ask(view.port, `app-cccccccccccccccccccc.${DOMAIN}:9821`);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("<!doctype html>");
    expect(view.stats.served).toBe(before);
    expect(view.stats.unknownRelease).toBeGreaterThan(0);
  });

  it("421s anything that is not a digest label under the configured domain", async () => {
    for (const name of [
      `app-cccccccccccccccccccc.evil.com:9821`,
      `${packageHostLabel(showcaseDigest)}.${DOMAIN}.attacker.tld:9821`,
      `www.${DOMAIN}:9821`,
      // Right name, wrong public port: the port is part of the configured
      // origin, so a proxy terminating somewhere else fails loudly.
      `${packageHostLabel(showcaseDigest)}.${DOMAIN}`,
    ]) {
      const res = await ask(view.port, name);
      expect({ name, status: res.status }).toEqual({ name, status: 421 });
    }
  });

  it("still serves exactly one request target per release", async () => {
    const label = packageHostLabel(showcaseDigest);
    expect((await ask(view.port, `${label}.${DOMAIN}:9821`, "/?leak=secret")).status).toBe(404);
    expect((await ask(view.port, `${label}.${DOMAIN}:9821`, "/anything")).status).toBe(404);
  });

  it("lets the reverse proxy get a certificate for the declared App's hostname too", async () => {
    // The same union, one layer down. Without it a declared App would be
    // reachable over plaintext loopback and unreachable over TLS — which is the
    // same bug wearing a different hat.
    const allowed = await ask(
      originAsk.port,
      "127.0.0.1",
      `/ask?domain=${encodeURIComponent(`${packageHostLabel(showcaseDigest)}.${DOMAIN}:9821`)}`,
    );
    expect(allowed.status).toBe(200);
    const refused = await ask(
      originAsk.port,
      "127.0.0.1",
      `/ask?domain=${encodeURIComponent(`app-cccccccccccccccccccc.${DOMAIN}:9821`)}`,
    );
    expect(refused.status).toBe(403);
  });

  it("publishes both apps' labels, and nothing else", () => {
    expect([...host.publishedLabels()].sort()).toEqual(
      [packageHostLabel(showcaseDigest), packageHostLabel(sessionPlusDigest)].sort(),
    );
  });
});
