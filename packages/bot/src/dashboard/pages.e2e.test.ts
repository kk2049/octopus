/**
 * Every page mounts, in a real browser, without throwing.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The retired pages were checked by parsing their inline scripts: a test read
 * the source and asserted a substring. That could not tell you whether the page
 * WORKED — the defect that shipped the approval drawer dead was a script that
 * parsed fine as a string and then never ran, and `/hq` and `/secretary` spent
 * their whole lives being blocked by their own CSP without a single failing
 * test.
 *
 * So the replacement is not a better string check. It is: load each page as a
 * person does, with the real bundle, the real CSP and the real API behind it,
 * and require that the app mounted, that nothing threw, and that the browser
 * refused nothing. A page that renders a server-side refusal is fine; a page
 * whose JavaScript died is not, and that is the difference this file can see and
 * the old one could not.
 *
 * Deliberately shallow per page: interaction is covered by component tests in
 * `packages/dashboard-web` and by the Session Plus browser suite. What is only
 * observable here is "the composed document, its CSP and its bundle agree".
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { AuthorizationService } from "../authorization/service.js";
import { Store } from "../store/store.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import { readTicketFiles } from "../devpipe/ticket-files.js";
import { gitOrThrow } from "../devpipe/worktree.js";
import type { DevPipeline } from "../devpipe/pipeline.js";
import { normalizeDevTicketInput } from "../devpipe/ticket-models.js";
import { GraphDb, type GraphSnapshot } from "../knowledge/graph-db.js";
import type { KnowledgeEdge, KnowledgeNode } from "../knowledge/model.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { DASHBOARD_THEME_SETTING } from "./theme-preference.js";
import { discoverPresentationGroups, measurePresentation, presentationFailures } from "@claude-bot/agent-view-build/presentation-audit";
import { createDashboardTestServer, runnerBundleSourceFromFile } from "../e2e/dashboard-test-support.js";
import { ArchitectureService } from "./architecture.js";
import { KnowledgeWikiService } from "./knowledge.js";

/** Chromium present? A missing binary is a skip with a reason, never a rewrite. */
function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const HAVE_BROWSER = chromiumAvailable();
if (!HAVE_BROWSER) {
  console.warn(
    "[dashboard] Chromium is not installed, so the page smoke suite is skipped.\n"
      + "  Install it with:  npx playwright install chromium\n"
      + "  Skipped here: every page actually mounting under the real CSP, and the\n"
      + "  assertion that no page throws or is refused a resource by the browser.",
  );
}

const NOW = "2026-08-06T10:00:00.000Z";
const APPLE_SCREENSHOT_DIR = process.env.APPLE_THEME_SCREENSHOT_DIR?.trim() || null;

function appleScreenshotPath(name: string): string | null {
  if (!APPLE_SCREENSHOT_DIR) return null;
  mkdirSync(APPLE_SCREENSHOT_DIR, { recursive: true });
  return join(APPLE_SCREENSHOT_DIR, `${name}.jpg`);
}

// Real-browser work with a real bundle to fetch; the 5 s default is not a
// statement about this code.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

function stubCaps(): RunnerCapabilities {
  return {
    listDevices: () => [],
    isOnline: () => false,
    open: () => null,
    dropPooled: () => 0,
    listPending: () => [],
    deviceRevoked: () => {},
    accountAuthority: () => null,
    mintDeviceToken: () => "rt_stub",
    revokeDeviceToken: () => {},
    checkDevice: async () => ({ online: false }),
  } as unknown as RunnerCapabilities;
}

function stubPipeline(repo: string): DevPipeline {
  return {
    readTicketFiles: (ticket: Parameters<DevPipeline["readTicketFiles"]>[0], filePath: string) => readTicketFiles(repo, "v4", ticket, filePath),
    listTickets: () => [],
    counts: () => ({}),
    baseBranch: "v3",
    stableBranch: "v3-stable",
    lockWaiterIds: () => [],
    mergeLockHolder: () => null,
    listDeployIntents: () => [],
    activeDeploy: () => null,
    openVerification: () => null,
    ticketExecutionChoices: () => null,
    readTicketExecution: async () => undefined,
    usesRunnerTickets: () => false,
  } as unknown as DevPipeline;
}

/** This harness starts Dashboard without Caddy's public deployment observer. */
async function idleDeploymentObserver(page: Page): Promise<void> {
  await page.route((url) => url.pathname === "/__octopus/deploy", (route) => route.fulfill({
    json: { id: null, status: "idle", http_ready: true, observed_at: Date.now() },
  }));
}

/** Only the Suspense status directly inside Shell's page container. */
async function routeLoaded(page: Page): Promise<void> {
  await page.locator('#root > div > [role="status"]')
    .filter({ hasText: /^加载中…$/ }).waitFor({ state: "hidden", timeout: 30_000 });
}

const WIKI_SHA = "f".repeat(40);

function wikiSnapshot(): GraphSnapshot {
  const node = (
    partial: Partial<KnowledgeNode> & Pick<KnowledgeNode, "id" | "kind" | "statement">,
  ): KnowledgeNode => ({
    status: "active",
    authority: "declared",
    source_ref: "packages/dashboard-web/src/pages/KnowledgePage.module.css",
    source_sha: WIKI_SHA,
    method: "declared",
    certainty: "exact",
    ...partial,
  });
  const edge = (
    from_id: string,
    relation: KnowledgeEdge["relation"],
    to_id: string,
  ): KnowledgeEdge => ({
    from_id,
    relation,
    to_id,
    method: "declared",
    certainty: "exact",
    source_ref: "browser fixture",
    source_sha: WIKI_SHA,
    observed_at: NOW,
  });
  const nodes: KnowledgeNode[] = [
    node({
      id: "module:dashboard-web",
      kind: "module",
      statement: "Dashboard Web（dashboard-web）：可信浏览器界面",
      metadata: { zone: "trusted-browser", pathPrefixes: ["packages/dashboard-web/"] },
    }),
    node({
      id: "capability:dashboard.knowledge",
      kind: "capability",
      statement: "知识库：手机布局",
      metadata: { kind: "product", modules: ["dashboard-web"], docs: [], paths: [], constraints: [] },
    }),
    node({
      id: "principle:mobile-wiki-layout",
      kind: "principle",
      statement: "手机知识库详情应在窄屏保持单列且不横向溢出。",
      authority: "path_rule",
    }),
    node({
      id: "non_goal:desktop-wiki-columns",
      kind: "non_goal",
      statement: "手机知识库不保留桌面的多栏宽度。",
      authority: "user",
    }),
    node({
      id: "requirement:mobile-wiki-columns",
      kind: "requirement",
      statement: "手机知识库可保持桌面双栏。",
      authority: "curated",
      certainty: "ambiguous",
      metadata: { conflict_note: "与窄屏单列要求冲突" },
    }),
  ];
  const edges: KnowledgeEdge[] = [
    edge("capability:dashboard.knowledge", "spans", "module:dashboard-web"),
    edge("principle:mobile-wiki-layout", "governs", "module:dashboard-web"),
    edge("non_goal:desktop-wiki-columns", "bounds", "module:dashboard-web"),
    edge("requirement:mobile-wiki-columns", "about", "capability:dashboard.knowledge"),
  ];
  return {
    nodes,
    edges,
    cells: [],
    observations: [],
    observationArtifacts: [],
    coverage: [],
    conflicts: [{
      id: "non_goal_vs_requirement:mobile-wiki-columns",
      rule: "non_goal_vs_requirement",
      a_id: "non_goal:desktop-wiki-columns",
      b_id: "requirement:mobile-wiki-columns",
      why: "窄屏单列与桌面双栏冲突",
      severity: "review",
    }],
    meta: {
      schema_version: 2,
      commit: WIKI_SHA,
      built_at: NOW,
      evaluation_as_of: "2026-08-23",
      tool_version: "2",
      input_fingerprint: "mobile-wiki",
      projection_digest: "browser-fixture",
      node_count: nodes.length,
      edge_count: edges.length,
    },
  };
}

describe.skipIf(!HAVE_BROWSER)("every dashboard page mounts in a browser", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;
  let token: string;
  let ticketId: number;
  let browser: Browser;
  let page: Page;
  /**
   * What the browser objected to on the page under test.
   *
   * Three kinds, and each is a defect rather than noise: an uncaught exception
   * (the app died), anything the Content Security Policy refused (the `/hq`
   * class of bug this suite exists for), and a server error.
   *
   * A 404 from a service this harness deliberately does not construct is NOT a
   * defect — it is the panel correctly rendering "that is not here" — so those
   * are collected separately and asserted as a closed set, which keeps the
   * exemption from quietly growing.
   */
  let problems: string[] = [];
  let absent: string[] = [];

  /** APIs no service is attached to in this harness. */
  const UNWIRED = [
    "/api/deploy",
    "/api/deploy/active",
    "/api/tentacle",
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-pages-"));
    const sourceRoot = join(dir, "repo");
    await gitOrThrow(dir, ["init", "-b", "v4", sourceRoot]);
    mkdirSync(join(sourceRoot, "src"));
    writeFileSync(join(sourceRoot, "src/CapabilityView.tsx"), Array.from({ length: 80 }, (_, n) => `// source line ${n + 1}`).join("\n"));
    await gitOrThrow(sourceRoot, ["add", "."]);
    await gitOrThrow(sourceRoot, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "source"]);
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: join(dir, "alice"), created_at: NOW });
    store.setSetting("alice", "display_name", "爱丽丝");
    store.setSetting("alice", DASHBOARD_THEME_SETTING, "apple");
    ticketId = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "两行工单列表项",
      body: "列表项的边框必须包住标题和状态行。",
      requester: "alice",
      kind: "simple",
    })).id;
    const authorization = new AuthorizationService({ repository: store.authorization });
    authorization.upsertDomain({ id: "personal:alice", kind: "personal", title: "个人文件",
      authority: { kind: "owner", id: "alice" }, historyPolicy: "all" });
    authorization.upsertResource({ id: "resource:layout-report", owner: "alice", domainId: "personal:alice",
      uri: `file://laptop/alice/reports/${"long-directory-".repeat(12)}/report`,
      kind: "document", title: "权限布局验收文档", sensitivity: "sensitive",
      externalRef: { system: "layout-test", id: "report" } });
    authorization.putPermit({ subject: { type: "user", id: "alice" }, resourceId: "resource:layout-report",
      operation: "read", mode: "allow", authority: { kind: "owner", id: "alice" }, source: "user", createdBy: "alice" });
    authorization.putResourceAlias({ owner: "alice", uri: "file://laptop/alice/current-report",
      targetUri: `file://laptop/alice/reports/${"long-directory-".repeat(12)}/report`, createdBy: "alice" });
    authorization.close();
    token = mintDashboardToken(store, "alice");
    const bundle = join(dir, "standalone.js");
    writeFileSync(bundle, "// fake runner bundle");
    GraphDb.writeSnapshot(join(dir, "knowledge", "graph.db"), wikiSnapshot());
    dash = createDashboardTestServer(store, stubCaps(), {
      port: 0,
      host: "127.0.0.1",
      authToken: "sekrit",
      // An admin so `/admin` is reachable too; the point here is that every
      // page this viewer is served mounts, not who may see what.
      adminUsers: ["alice"],
      runnerWsPort: 9910,
      runnerBundle: runnerBundleSourceFromFile(bundle),
      publicHost: "203.0.113.9",
      devPipeline: stubPipeline(sourceRoot),
      // A representative graph exercises the real index, node details and
      // conflict review layouts instead of stopping at the empty projection.
      architecture: new ArchitectureService({ repoDir: dir, dataDir: dir }),
      knowledge: new KnowledgeWikiService({ dataDir: dir, store }),
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;

    browser = await chromium.launch();
    page = await browser.newPage();
    await idleDeploymentObserver(page);
    page.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() !== "error") return;
      // Chrome logs an error line for every failed subresource, including the
      // deliberate 404s below. What must never appear is a REFUSAL: that is the
      // CSP saying it blocked something the page needed.
      if (/Refused to|Content Security Policy/i.test(text)) problems.push(`csp: ${text}`);
    });
    page.on("requestfailed", (request) => {
      problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
    });
    page.on("response", (r) => {
      const path = new URL(r.url()).pathname;
      if (r.status() >= 500) problems.push(`http ${r.status()}: ${path}`);
      else if (r.status() >= 400) absent.push(path);
    });

    // Log in as a person does, so the browser holds the same cookie a user would
    // and the pages below are the authenticated ones.
    await page.goto(`${base}/login`);
    await page.fill('input[type="password"]', token);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  });

  afterAll(async () => {
    await browser?.close();
    await dash?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The pages this composition serves this viewer, with a landmark for each. */
  const PAGES: Array<[path: string, landmark: string]> = [
    ["/", "用户与端点"],
    ["/tickets", "新建工单"],
    ["/architecture", "架构"],
    ["/knowledge", "产品能力"],
    ["/knowledge?v=review&tab=retrieval", "工单知识查询与引用"],
    ["/admin", "开发权限按用户授予"],
    ["/pending", "待批准"],
    ["/permissions", "权限中心"],
    ["/access-preview", "权限中心"],
  ];

  for (const [path, landmark] of PAGES) {
    it(`mounts ${path} with no error the browser noticed`, async () => {
      problems = [];
      absent = [];
      const response = await page.goto(base + path);
      expect(response?.status(), path).toBe(200);
      // React mounts the shell before the lazy route. Require the page's
      // landmark and the loading fallback to clear before checking its UI.
      await expect.poll(() => page.locator("body").innerText(), { timeout: 30_000 }).toContain(landmark);
      await routeLoaded(page);
      const peers = await page.evaluate(discoverPresentationGroups, "#root");
      expect(presentationFailures(await page.evaluate(measurePresentation, peers)), `${path} repeated text roles`).toEqual([]);
      console.info(`Presentation audit: ${path}, ${peers.length} peer groups`);
      expect(await page.locator("html").getAttribute("data-theme"), `${path} appearance`).toBe("apple");
      // The trusted chrome is present on every page, which is also how a person
      // logs out or approves from wherever they are.
      expect(await page.locator("nav a.tab").count(), `${path} navigation`).toBeGreaterThan(0);
      expect(problems, `${path} browser complaints`).toEqual([]);
      // Every non-2xx the page saw is a service this harness chose not to build.
      // If a new one appears here, either a page started calling something it
      // should not, or the panel grew a dependency nobody declared.
      expect([...new Set(absent)].filter((p) => !UNWIRED.includes(p)), `${path} unexpected 4xx`).toEqual(
        [],
      );
      const screenshotName = new Map([
        ["/", "dashboard-shell-light"],
        ["/tickets", "dashboard-tickets-light"],
        ["/knowledge", "dashboard-knowledge-light"],
      ]).get(path);
      const screenshot = screenshotName ? appleScreenshotPath(screenshotName) : null;
      if (screenshot) await page.screenshot({ path: screenshot, type: "jpeg", quality: 82 });
    });
  }

  it("keeps an open editor usable through deployment outages without navigation", async () => {
    const context = await browser.newContext({ storageState: await page.context().storageState() });
    const tab = await context.newPage();
    let state = { id: 523, status: "idle", http_ready: true };
    await tab.route("**/__octopus/deploy", (route) => route.fulfill({ json: { ...state, observed_at: Date.now(), created_at: new Date().toISOString() } }));
    try {
      await tab.goto(base + "/tickets");
      await tab.getByRole("button", { name: new RegExp(`#${ticketId}.*两行工单列表项`) }).click();
      const editor = tab.locator("textarea").first();
      await editor.fill("half a prompt");
      const documentId = await tab.evaluate(() => performance.timeOrigin);
      for (const status of ["building", "restarting", "health_gate", "succeeded"]) {
        state = { ...state, status, http_ready: false };
        await tab.evaluate(() => dispatchEvent(new CustomEvent("octopus-deploy-request", { detail: 523 })));
        const banner = tab.getByTestId("deployment-progress");
        await banner.waitFor();
        const label = { building: "当前服务仍可使用", restarting: "连接即将恢复", health_gate: "正在检查服务", succeeded: "可在方便时刷新页面" }[status];
        await tab.waitForFunction((text) => document.querySelector('[data-testid="deployment-progress"]')?.textContent?.includes(text!), label);
        // Trial click checks real hit testing: jsdom cannot detect an overlay.
        await editor.click({ trial: true });
        await editor.press("End");
        await editor.press("x");
        expect(await editor.inputValue()).toContain("half a prompt");
        const box = await banner.boundingBox();
        expect(box!.height).toBeLessThan(200);
        expect(await tab.evaluate(() => performance.timeOrigin)).toBe(documentId);
      }
    } finally { await context.close(); }
  });

  it.each(["button", "browser"])("consumes deployment success after a real %s refresh", async (refresh) => {
    const context = await browser.newContext({ storageState: await page.context().storageState() });
    const tab = await context.newPage();
    let state = { id: 401, status: "idle", created_at: "", http_ready: true };
    const errors: string[] = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.route("**/__octopus/deploy", (route) => route.fulfill({
      json: { ...state, observed_at: Date.now() },
    }));
    // Keep the real serving process's build header while simulating only the
    // deployment facts; this fixture deliberately has no deployment service.
    await tab.route("**/api/deploy/active", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, status: 200, json: { intent_id: null, confirm_wait: false } });
    });
    try {
      await tab.goto(base + "/pending");
      await expect.poll(() => tab.locator("#root").innerText(), { timeout: 30_000 }).toContain("待批准");
      state = { ...state, status: "health_gate", created_at: new Date().toISOString() };
      await tab.evaluate(() => dispatchEvent(new CustomEvent("octopus-deploy-request", { detail: 401 })));
      await tab.getByTestId("deployment-progress").waitFor();
      state.status = "succeeded";
      await tab.getByRole("button", { name: "刷新页面", exact: true }).waitFor();
      expect(await tab.getByRole("button", { name: "知道了", exact: true }).count()).toBe(0);
      if (refresh === "button") await tab.getByRole("button", { name: "刷新页面", exact: true }).click();
      else await tab.reload();
      await tab.waitForFunction(() => sessionStorage.getItem("octopus-deploy-dismissed") === "401");
      expect(await tab.getByTestId("deployment-progress").count()).toBe(0);
      await expect.poll(() => tab.locator("#root").innerText(), { timeout: 30_000 }).toContain("待批准");
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it("paints representative Apple surfaces in the dark system scheme", async () => {
    const darkProblems: string[] = [];
    const darkContext = await browser.newContext({ colorScheme: "dark" });
    const dark = await darkContext.newPage();
    await idleDeploymentObserver(dark);
    dark.on("pageerror", (error) => darkProblems.push(`uncaught: ${error.message}`));
    await dark.goto(`${base}/login`);
    await dark.fill('input[type="password"]', token);
    await dark.click('button[type="submit"]');
    await dark.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });

    for (const path of ["/tickets", "/knowledge?v=graph"]) {
      await dark.goto(base + path);
      if (path === "/tickets") {
        await dark.getByRole("button", { name: new RegExp(`#${ticketId}.*两行工单列表项`) }).waitFor({ timeout: 30_000 });
      } else {
        await dark.getByRole("img", { name: /知识关系图，显示/ }).waitFor({ timeout: 30_000 });
      }
      await routeLoaded(dark);
      const appearance = await dark.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return {
          theme: document.documentElement.dataset.theme,
          canvas: style.getPropertyValue("--bg").trim(),
          material: style.getPropertyValue("--chrome-material").trim(),
          graph: style.getPropertyValue("--knowledge-graph-bg").trim(),
        };
      });
      expect(appearance.theme, path).toBe("apple");
      expect(appearance.canvas, path).toBe("#0b0b0d");
      expect(appearance.material, path).toContain("28 28 30 / 78%");
      expect(appearance.graph, path).toBe("#0b0b0d");
      const screenshot = appleScreenshotPath(
        path === "/tickets" ? "dashboard-tickets-dark" : "dashboard-knowledge-graph-dark",
      );
      if (screenshot) await dark.screenshot({ path: screenshot, type: "jpeg", quality: 82 });
    }
    expect(darkProblems).toEqual([]);
    await darkContext.close();
  });

  it("redirects the old preview and fits every permission section at desktop and mobile widths", async () => {
    problems = [];
    const context = await browser.newContext();
    const permissions = await context.newPage();
    await idleDeploymentObserver(permissions);
    permissions.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
    await permissions.goto(`${base}/login`);
    await permissions.fill('input[type="password"]', token);
    await permissions.click('button[type="submit"]');
    await permissions.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
    await permissions.goto(`${base}/access-preview`);
    expect(new URL(permissions.url()).pathname).toBe("/permissions");
    expect(new URL(permissions.url()).searchParams.get("view")).toBe("tree");
    expect(await permissions.locator('nav a[href="/access-preview"]').count()).toBe(0);
    for (const width of [1280, 768, 390, 320]) {
      await permissions.setViewportSize({ width, height: 850 });
      for (const section of ["应用授权", "权限树", "连接与设备", "活动记录"]) {
        await permissions.getByRole("tab", { name: section, exact: true }).click();
        await permissions.getByRole("tabpanel", { name: section, exact: true }).waitFor();
        if (section === "应用授权") {
          for (const summary of await permissions.locator('#permission-panel-grants details > summary').all()) {
            if (!(await summary.evaluate((element) => element.parentElement!.hasAttribute("open")))) await summary.click();
          }
        }
        if (section === "权限树") {
          await permissions.getByRole("textbox", { name: "搜索资源或 URL" }).fill("权限布局验收文档");
          await permissions.getByRole("button", { name: /权限布局验收文档 report/ }).click();
          await permissions.getByRole("heading", { name: "授权对象 · 1" }).waitFor();
          expect(await permissions.getByRole("region", { name: "资源授权详情" }).innerText()).toContain("alice");
        }
        const overflow = await permissions.evaluate(() => {
          const panel = document.querySelector('[role="tabpanel"]:not([hidden])')!;
          return Math.max(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
            panel.scrollWidth - panel.clientWidth,
          );
        });
        expect(overflow, `${section} at ${width}px`).toBeLessThanOrEqual(1);
        const peers = await permissions.evaluate(discoverPresentationGroups, '[role="tabpanel"]:not([hidden])');
        expect(presentationFailures(await permissions.evaluate(measurePresentation, peers)), `${section} at ${width}px repeated text roles`).toEqual([]);
        const screenshot = appleScreenshotPath(`permissions-${section}-${width}`);
        if (screenshot && (width === 1280 || width === 390)) await permissions.screenshot({ path: screenshot, type: "jpeg", quality: 82 });
      }
    }
    expect(problems).toEqual([]);
    await context.close();
  });

  it("exposes representative knowledge views on mobile without horizontal overflow", async () => {
    problems = [];
    const mobileContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
    const mobile = await mobileContext.newPage();
    await idleDeploymentObserver(mobile);
    mobile.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
    await mobile.goto(`${base}/login`);
    await mobile.fill('input[type="password"]', token);
    await mobile.click('button[type="submit"]');
    await mobile.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });

    const views: Array<[path: string, landmark: string]> = [
      ["/knowledge", "产品能力"],
      ["/knowledge?v=node&id=principle%3Amobile-wiki-layout", "手机知识库详情应在窄屏保持单列且不横向溢出。"],
      ["/knowledge?v=review&tab=conflicts", "手机知识库可保持桌面双栏。"],
      ["/knowledge?v=review&tab=retrieval", "工单知识查询与引用"],
    ];
    for (const [path, landmark] of views) {
      await mobile.goto(base + path);
      const visibleContent = mobile.getByText(landmark, { exact: false }).first();
      await visibleContent.waitFor({ state: "visible" });
      const peers = await mobile.evaluate(discoverPresentationGroups, "#root");
      expect(presentationFailures(await mobile.evaluate(measurePresentation, peers)), `${path} at 320px repeated text roles`).toEqual([]);
      expect(
        await mobile.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
        `${path} at 320px`,
      ).toBeLessThanOrEqual(1);
    }

    const table = mobile.getByRole("table", { name: "工单知识查询与引用" });
    const queryButton = table.getByRole("button", { name: `查看工单 #${ticketId} 的追踪` });
    expect(await queryButton.textContent()).toBe("0");
    const scroll = await table.evaluate((element) => {
      const container = element.parentElement!;
      container.scrollLeft = 40;
      return { left: container.scrollLeft, overflow: getComputedStyle(container).overflowX };
    });
    expect(scroll.overflow).toBe("auto");
    expect(scroll.left).toBeGreaterThan(0);
    await queryButton.click();
    await mobile.getByText("当前范围没有保留的追踪记录。", { exact: true }).waitFor({ state: "visible" });
    expect(new URL(mobile.url()).searchParams.get("ticket")).toBe(String(ticketId));
    expect(await mobile.getByRole("button", { name: "清除工单筛选" }).isVisible()).toBe(true);

    await mobile.getByRole("button", { name: "打开主导航" }).click();
    expect(await mobile.getByRole("link", { name: "📚 知识库" }).isVisible()).toBe(true);
    expect(problems, "320px browser complaints").toEqual([]);
    await mobileContext.close();
  });

  it("admits only the exact shared-runtime import map under the script CSP", async () => {
    const response = await page.goto(`${base}/permissions`);
    const csp = response!.headers()["content-security-policy"] ?? "";
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
    const map = await page.locator('script[type="importmap"]').textContent();
    expect(map).toBeTruthy();
    const hash = createHash("sha256").update(map!).digest("base64");
    expect(scriptSrc).toBe(`script-src 'self' 'sha256-${hash}'`);
    const imports = JSON.parse(map!).imports as Record<string, string>;
    expect(imports.react).toMatch(/^\/ui\/a\/.*\.js$/);
    expect(imports["react-dom/client"]).toMatch(/^\/ui\/a\/.*\.js$/);
    const executableInline = await page.locator("script:not([src])").evaluateAll((nodes) => nodes
      .filter((node) => !["application/json", "importmap"].includes(node.getAttribute("type") ?? ""))
      .map((node) => node.textContent));
    expect(executableInline).toEqual([]);
    // Require the lazy page itself, rather than only its shell, under this CSP.
    await page.getByRole("tab", { name: "应用授权", exact: true }).waitFor({ timeout: 30_000 });
  });

  it("sizes a ticket list item around both of its text rows", async () => {
    problems = [];
    await page.goto(`${base}/tickets`);
    const row = page.getByRole("button", { name: new RegExp(`#${ticketId}.*两行工单列表项`) });
    await row.waitFor({ timeout: 30_000 });
    const geometry = await row.evaluate((element) => {
      const outer = element.getBoundingClientRect();
      const body = element.children[1]?.getBoundingClientRect();
      return {
        outerHeight: outer.height,
        bodyBottom: body?.bottom ?? Number.POSITIVE_INFINITY,
        outerBottom: outer.bottom,
      };
    });
    expect(geometry.outerHeight).toBeGreaterThanOrEqual(48);
    expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.outerBottom + 1);
    expect(problems).toEqual([]);
  });

  it("opens ticket chat source at its cited line and browses directories on desktop and phone", async () => {
    problems = [];
    const transcriptRoute = `**/api/tickets/${ticketId}/session*`;
    // Current ticket chat reads a Runner transcript, not legacy ticket_messages.
    // Keep source-file browsing on the real HTTP server below.
    await page.route(transcriptRoute, route => route.fulfill({ json: {
      messages: [{ role: "assistant", text: `[CapabilityView.tsx](${join(dir, "repo/src/CapabilityView.tsx")}:48)` }],
      offset: 0, total_messages: 1,
    } }));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/tickets`);
    await page.getByRole("button", { name: new RegExp(`#${ticketId}.*两行工单列表项`) }).click();
    // Ticket chat is the always-visible detail surface; its old disclosure was removed.
    await page.getByRole("button", { name: "CapabilityView.tsx", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "工单源码" });
    await dialog.locator('[data-source-line="48"]').waitFor();
    expect(await dialog.locator('[data-source-line="48"]').textContent()).toContain("// source line 48");
    expect(await dialog.locator('[data-source-line="48"]').isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "浏览源码", exact: true }).click();
    await dialog.getByRole("button", { name: "📁 src", exact: true }).click();
    await dialog.getByRole("button", { name: "📄 CapabilityView.tsx", exact: true }).click();
    await dialog.locator('[data-source-line="1"]').waitFor();
    const bounds = await dialog.boundingBox();
    expect(bounds?.width).toBeLessThanOrEqual(390);
    expect(problems).toEqual([]);
    await page.keyboard.press("Escape");
    await page.unroute(transcriptRoute);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  it("keeps the login screen usable before there is any session", async () => {
    problems = [];
    const fresh = await browser.newContext();
    const anon = await fresh.newPage();
    await idleDeploymentObserver(anon);
    anon.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
    anon.on("console", (message) => {
      if (message.type() === "error" && /Refused to|Content Security Policy/i.test(message.text())) {
        problems.push(`csp: ${message.text()}`);
      }
    });
    // An unauthenticated browser navigation enters login rather than rendering
    // the API's 401 JSON. The requested page is retained for post-login return.
    const response = await anon.goto(`${base}/sessions`);
    expect(response?.status()).toBe(200);
    expect(new URL(anon.url()).pathname).toBe("/login");
    expect(new URL(anon.url()).searchParams.get("next")).toBe("/sessions");
    await anon.waitForSelector('input[type="password"]', { timeout: 30_000 });
    expect(problems).toEqual([]);
    await fresh.close();
  });

  it("opens a document's claim page with no session, and never puts its secret in a request URL", async () => {
    problems = [];
    const fresh = await browser.newContext();
    const urls: string[] = [];
    const visit = async (path: string) => {
      const anon = await fresh.newPage();
      await idleDeploymentObserver(anon);
      anon.on("request", (request) => urls.push(request.url()));
      anon.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
      anon.on("console", (message) => {
        if (message.type() === "error" && /Refused to|Content Security Policy/i.test(message.text())) {
          problems.push(`csp: ${message.text()}`);
        }
      });
      expect((await anon.goto(`${base}${path}`))?.status(), path).toBe(200);
      return anon;
    };
    // Without its fragment the link is incomplete, and the page says so without asking anything.
    const bare = await visit("/doc-key");
    await expect.poll(() => bare.locator("body").innerText(), { timeout: 30_000 }).toContain("链接不完整");
    // With one, the secret leaves the address bar; this harness composes no docs add-on, so the claim call is refused.
    const secret = `dsi_${"Z".repeat(43)}`;
    const linked = await visit(`/doc-key#i=${secret}`);
    await expect.poll(() => linked.locator("body").innerText(), { timeout: 30_000 }).toContain("not found");
    expect(new URL(linked.url()).hash).toBe("");
    expect(urls.filter((url) => url.includes(secret))).toEqual([]);
    expect(problems).toEqual([]);
    await fresh.close();
  });
});
