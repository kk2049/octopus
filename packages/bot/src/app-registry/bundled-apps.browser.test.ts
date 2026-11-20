/**
 * All current App releases must really mount against the Dashboard's shared ESM
 * runtime. Component tests cannot catch a missing named export, duplicate SDK
 * context, blocked import map, or unreachable release chunk.
 *
 * The fixture installs actual checkout packs and serves immutable assets through
 * AppReleaseHost. Only projection ingress is simulated: business interactions
 * and authenticated Host HTTP/SSE stay in their existing suites.
 * Run after workspace builds; this test never rebuilds a frontend.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { AppReleaseRegistry, FileReleaseContentStore, MemoryReleaseCatalog } from "@claude-bot/app-registry";
import { MODULE_ENTRY_ASSET, MODULE_ENTRY_FILE, readAppModuleEntry } from "@claude-bot/agent-view-build/module-assets";
import { APP_RUNTIME_IMPORTS, type AppModuleEntry } from "@claude-bot/agent-view-build/runtime";
import type { DashboardBootstrap } from "@claude-bot/dashboard-web/contract";
import { bundleManifest, readAsset, resetBundleManifest, type BundleManifest } from "../dashboard/assets.js";
import { appPageScriptCsp, renderAppPage } from "../dashboard/app-page.js";
import { DEFAULT_CSP } from "../dashboard/http.js";
import { AppReleaseHost } from "./release-host.js";
import { discoverPresentationGroups, measurePresentation, presentationFailures } from "@claude-bot/agent-view-build/presentation-audit";
import type { ManagedApp } from "./hosted-app.js";
import { buildAppBundle, readAppPackConfig } from "./app-package.js";
import { buildCheckoutBundle } from "./session-plus-package.js";
import { buildShowcaseBundle } from "./showcase-package.js";
import type { ReleaseBundle } from "./bundle.js";

const APPS = [
  { id: "session-plus", root: "[data-session-plus-app]", text: "最近会话" },
  { id: "showcase", root: ".showcase", text: "收件箱是空的。" },
  { id: "chess", root: ".chess-v2", text: "尚无走子" },
  { id: "daily-brief", root: ".daily-brief", text: "还没有总结。请求一条，然后让你本机的 Agent 发布。" },
  { id: "expense-intake", root: ".expense-v2", text: "还没有费用申报" },
  { id: "meeting-room", root: ".meeting-room", text: "会议室" },
  { id: "ppt-studio", root: ".ppt-studio", text: "从目标到可编辑初稿" },
  { id: "report-space", root: ".report-space", text: "这个空间还没有汇报" },
  { id: "research-program", root: ".research-program", text: "未命名科研项目" },
  { id: "research-v2", root: ".rv-app", text: "请从项目列表打开自动科研 v2。" },
  { id: "research-docs", root: ".rd-app", text: "请从共享空间列表打开文档。" },
] as const;

type AppId = typeof APPS[number]["id"];
const sourcePackage = (app: AppId) => app === "research-v2" ? "research-canvas" : app;
interface InstalledFixture {
  digest: string;
  entry: AppModuleEntry;
  projection: unknown;
}

async function checkoutBundle(app: AppId): Promise<ReleaseBundle> {
  if (app === "session-plus") return buildCheckoutBundle();
  if (app === "showcase") return buildShowcaseBundle();
  const config: { default: unknown } = await import(new URL(`../../../${sourcePackage(app)}-view/src/pack.ts`, import.meta.url).href);
  return buildAppBundle(readAppPackConfig(config.default));
}

async function emptyProjection(app: AppId): Promise<unknown> {
  if (app === "session-plus") return { sessions: [], sources: [], pinned: [], workspaces: {}, transcript: {} };
  const module: { project(events: unknown[], context?: unknown): unknown } =
    await import(new URL(`../../../${sourcePackage(app)}-view/app/projection.ts`, import.meta.url).href);
  const role = app === "expense-intake" ? "submitter" : app === "chess" ? "watcher" : "viewer";
  return module.project([], { viewer: { kind: "user", user: "smoke-viewer", role } });
}

/** Asset routing needs registered identity, never a running backend in this suite. */
function assetOwner(bundle: ReleaseBundle): ManagedApp {
  const unused = (): never => { throw new Error("this mount smoke must not activate or execute a backend"); };
  return {
    appId: bundle.descriptor.stableAppId,
    publisher: bundle.descriptor.publisher,
    start: unused, unavailable: unused, install: unused, activate: unused,
    deactivate: unused, uninstall: unused, describe: unused,
    publishedLabels: unused, documentFor: unused,
  };
}

// This external probe is intentionally not bundled with App code. Every bare
// import resolves through the production import map, including React and Ant
// contexts. Importing source components here would hide ABI regressions.
const PROBE = `
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import ConfigProvider from "antd/es/config-provider";
import AntApp from "antd/es/app";
import { AgentViewProvider, AgentViewErrorBoundary, useProjection } from "@claude-bot/agent-view-react";
import { createAppRuntimeClient } from "@claude-bot/agent-view-react/runtime";

const fail = error => { document.body.dataset.smokeError = String(error?.stack || error); };
try {
  const id = new URL(location.href).searchParams.get("app");
  const fixture = await fetch("/fixture/" + id).then(response => {
    if (!response.ok) throw new Error("fixture unavailable: " + response.status);
    return response.json();
  });
  const base = "/ui/apps/" + fixture.digest + "/";
  const entry = await fetch(base + "${MODULE_ENTRY_FILE}").then(response => response.json());
  const module = await import(base + entry.entry);
  if (typeof module.default !== "function") throw new Error("App release has no default component");
  await Promise.all(entry.styles.map(file => new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = base + file;
    link.onload = resolve;
    link.onerror = () => reject(new Error("App stylesheet failed: " + file));
    document.head.append(link);
  })));
  const container = document.getElementById("root");
  let surface;
  const client = createAppRuntimeClient({
    projection: { ...fixture.projection, smokeRevision: 1 }, revision: 1,
    appearance: { contract: "appearance/v1", theme: "apple" },
    dispatch: async () => ({ ok: false, code: "unavailable", message: "空状态夹具没有已授权资源。" }),
  });
  function MountedApp() {
    const projection = useProjection();
    useEffect(() => {
      surface.dataset.smokeRevision = String(projection.smokeRevision);
    }, [projection]);
    return createElement(module.default);
  }
  const root = createRoot(container, { onUncaughtError: fail, onRecoverableError: fail });
  root.render(createElement(ConfigProvider, {},
    createElement(AntApp, {},
      createElement("div", { id: "smoke-surface", "data-app-surface": entry.scope, "data-av-theme": "apple",
        ref: node => { surface = node; }, style: { height: "100vh", minWidth: 0 } },
        createElement(AgentViewProvider, { client, uiProvider: false, reflectAppearance: false },
          createElement(AgentViewErrorBoundary, { onError: fail }, createElement(MountedApp)))))));
  window.appMountSmoke = {
    update: () => client.update({ ...fixture.projection, smokeRevision: 2 }, 2),
    close: () => { root.unmount(); client.close(); },
  };
} catch (error) { fail(error); }
`;

const HAVE_BROWSER = existsSync(chromium.executablePath());
if (!HAVE_BROWSER) console.warn("[all-App mount] Chromium missing: eleven real ESM mounts are skipped; install Playwright Chromium to run them.");
vi.setConfig({ testTimeout: 45_000, hookTimeout: 180_000 });

describe.skipIf(!HAVE_BROWSER)("bundled App releases under the real shared runtime and CSP", () => {
  let browser: Browser | undefined;
  let server: Server | undefined;
  let temporary: string | undefined;
  let origin: string;
  let manifest: BundleManifest;
  let releaseHost: AppReleaseHost;
  const fixtures = new Map<string, InstalledFixture>();

  beforeAll(async () => {
    temporary = mkdtempSync(join(tmpdir(), "octopus-all-app-mount-"));
    const registry = new AppReleaseRegistry({
      catalog: new MemoryReleaseCatalog(),
      content: new FileReleaseContentStore(join(temporary, "content")),
    });
    const owners: ManagedApp[] = [];
    for (const app of APPS) {
      const bundle = await checkoutBundle(app.id);
      const installed = registry.install({ ...bundle, installedBy: "browser-smoke" });
      if (!installed.ok) throw new Error(`${app.id} install failed: ${JSON.stringify(installed)}`);
      owners.push(assetOwner(bundle));
      // Parse the bytes accepted by install, not the source pack configuration.
      const bytes = registry.readAsset(bundle.descriptor.packageDigest, MODULE_ENTRY_ASSET);
      const entry = bytes && readAppModuleEntry(Buffer.from(bytes).toString("utf8"));
      if (!entry || entry.appId !== app.id) throw new Error(`${app.id} current release is not a valid ESM App module`);
      fixtures.set(app.id, { digest: bundle.descriptor.packageDigest, entry, projection: await emptyProjection(app.id) });
    }
    releaseHost = new AppReleaseHost({ registry, apps: owners });
    resetBundleManifest();
    manifest = { ...bundleManifest(), script: "/fixture-probe.js" };
    expect(Object.keys(manifest.imports ?? {}).sort()).toEqual([...APP_RUNTIME_IMPORTS].sort());
    const bootstrap: DashboardBootstrap = {
      buildId: manifest.buildId, surface: "bootstrap-v3", features: [],
      viewer: { username: "smoke-viewer", admin: false, dev: false, deploy: false, contribute: false, session: true },
      nav: [], pages: [], redirects: {}, approvals: false, csrfCookieNames: [],
      themePreference: "apple", page: "page.sessionsPlus", pageProps: {},
    };
    server = createServer((request, response) => {
      void (async () => {
        const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
        const send = (status: number, type: string, body: string | Uint8Array, immutable = false) => {
          response.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff",
            ...(immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {}) });
          response.end(body);
        };
        if (pathname === "/") {
          response.setHeader("content-security-policy", `${DEFAULT_CSP}; ${appPageScriptCsp(manifest)}; worker-src 'self' blob:`);
          send(200, "text/html; charset=utf-8", renderAppPage({ title: "App mount smoke", bootstrap, manifest }));
        } else if (pathname === "/fixture-probe.js") {
          send(200, "text/javascript; charset=utf-8", PROBE);
        } else if (pathname === "/favicon.ico") {
          send(204, "image/x-icon", "");
        } else if (pathname.startsWith("/fixture/")) {
          const fixture = fixtures.get(pathname.slice("/fixture/".length));
          send(fixture ? 200 : 404, "application/json", JSON.stringify(fixture ?? {}));
        } else if (pathname.startsWith("/ui/apps/")) {
          const match = /^\/ui\/apps\/([0-9a-f]{64})\/([^/]+)$/.exec(pathname);
          const bytes = match && releaseHost.viewAssetFor(match[1], match[2]);
          const type = pathname.endsWith(".css") ? "text/css" : pathname.endsWith(".json") ? "application/json"
            : pathname.endsWith(".svg") ? "image/svg+xml" : "text/javascript";
          send(bytes ? 200 : 404, type, bytes || "not found", Boolean(bytes));
        } else {
          const asset = await readAsset(pathname);
          send(asset ? 200 : 404, asset?.contentType ?? "text/plain", asset?.body ?? "not found", asset?.immutable);
        }
      })().catch(error => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  });

  afterAll(async () => {
    await browser?.close();
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    resetBundleManifest();
  });

  for (const app of APPS) for (const width of [390, 1280]) it(`mounts ${app.id} at ${width}px, renders its initial state, and accepts a projection update`, async () => {
    const page = await browser!.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    const refusedResources: string[] = [];
    const loaded = new Set<string>();
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request => refusedResources.push(request.url() + ": " + request.failure()?.errorText));
    page.on("response", response => {
      if (response.status() >= 400) refusedResources.push(response.url() + ": " + response.status());
      else loaded.add(new URL(response.url()).pathname);
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", event => {
        const violation = event as SecurityPolicyViolationEvent;
        document.documentElement.dataset.smokeCsp = violation.violatedDirective + ": " + violation.blockedURI;
      });
    });
    try {
      await page.goto(`${origin}/?app=${app.id}`);
      await page.waitForFunction(() => document.body.dataset.smokeError || document.getElementById("smoke-surface")?.dataset.smokeRevision === "1");
      expect(await page.locator("body").getAttribute("data-smoke-error"), errors.join("\n")).toBeNull();
      const component = page.locator(app.root);
      await component.waitFor({ state: "visible" });
      const assertInitialState = async () => {
        expect(await component.innerText()).toContain(app.text);
        if (app.id === "session-plus") {
          await component.getByRole("button", { name: "全部会话", exact: true }).waitFor({ state: "visible" });
        } else if (app.id === "meeting-room") {
          const schedule = component.getByRole("grid", { name: /预约表/ });
          await schedule.waitFor({ state: "visible" });
          expect(await schedule.getByRole("columnheader").count()).toBe(3);
          await schedule.getByRole("gridcell", { name: /可预约/ }).first().waitFor({ state: "visible" });
        }
      };
      await assertInitialState();
      const peers = await page.evaluate(discoverPresentationGroups, "#smoke-surface");
      expect(presentationFailures(await page.evaluate(measurePresentation, peers)), `${app.id} repeated text roles`).toEqual([]);
      console.info(`Presentation audit: ${app.id} at ${width}px, ${peers.length} peer groups`);
      expect(await page.locator("iframe").count()).toBe(0);
      await component.evaluate(element => { element.setAttribute("data-smoke-node", "retained"); });
      await page.evaluate("window.appMountSmoke.update()");
      await page.waitForFunction(() => document.getElementById("smoke-surface")?.dataset.smokeRevision === "2");
      expect(await component.getAttribute("data-smoke-node")).toBe("retained");
      await assertInitialState();
      for (const host of await component.locator("[data-av-dock-host]").all()) {
        const viewport = await host.evaluate(element => {
          const node = element as HTMLElement;
          const before = node.scrollTop;
          // A grid viewport must not scroll when focus/scrollIntoView reaches
          // a dormant always-rendered overlay. Its document panels may scroll.
          node.scrollTop = node.clientHeight;
          return { before, after: node.scrollTop, height: node.clientHeight, contentHeight: node.scrollHeight };
        });
        expect(viewport.height).toBeGreaterThan(0);
        expect(viewport.before).toBe(0);
        expect(viewport.after).toBe(0);
        expect(viewport.contentHeight).toBeLessThanOrEqual(viewport.height + 2);
      }
      const fixture = fixtures.get(app.id)!;
      const base = `/ui/apps/${fixture.digest}/`;
      expect(loaded.has(base + fixture.entry.entry)).toBe(true);
      for (const style of fixture.entry.styles) expect(loaded.has(base + style), style).toBe(true);
      for (const specifier of ["react", "react-dom/client", "@claude-bot/agent-view-react"]) {
        expect(loaded.has(manifest.imports![specifier]), specifier).toBe(true);
      }
      expect(await page.locator("#smoke-surface").getAttribute("data-app-surface")).toBe(fixture.entry.scope);
      expect(await page.locator("html").getAttribute("data-smoke-csp")).toBeNull();
      expect(await page.locator("body").getAttribute("data-smoke-error")).toBeNull();
      expect(errors).toEqual([]);
      expect(refusedResources).toEqual([]);
      await page.evaluate("window.appMountSmoke.close()");
      expect(await page.locator(app.root).count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
