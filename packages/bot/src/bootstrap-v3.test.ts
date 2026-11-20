/**
 * What the v3 bootstrap composes — and, more to the point, what it does not.
 *
 * The interesting assertion here is a negative one, and negatives are hard to
 * test honestly: "no legacy service was started" is not something you can
 * observe by looking at the result. So it is tested two ways that fail for
 * different reasons:
 *
 *  1. **Constructing a forbidden service throws.** Each one is mocked so that
 *     `new` blows up while every other export of the module is left alone —
 *     because a static import that creates nothing is allowed, and a test that
 *     failed on import would be testing the wrong rule.
 *  2. **The startup inventory is asserted exactly.** Not `toContain`: the whole
 *     list, so a service that appears later has to be acknowledged here.
 *
 * Plus the one that is easy to forget: the retired v2 entry point copied
 * provider API keys into `process.env` for agent subprocesses. This
 * composition has no such agent, so it must leave the environment alone.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readBootstrapPayload } from "./dashboard/app-page.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A constructor that reports which forbidden service somebody tried to build. */
function forbid(name: string): new (...args: unknown[]) => never {
  return class {
    constructor() {
      throw new Error(`bootstrap-v3 must not construct ${name}`);
    }
  } as unknown as new (...args: unknown[]) => never;
}

// Feishu: the OAuth receiver is stubbed; the tenant directory must stay unbuilt.
vi.mock("./channel/feishu-oauth.js", async (orig) => ({
  ...(await orig<typeof import("./channel/feishu-oauth.js")>()),
  FeishuAuthManager: class {
    getUserToken = async () => null;
    getUserScopes = () => null;
  },
}));
// The /admin onboarding console's tenant reader IS composed (B2): it reads
// the same app credentials as Feishu OAuth. Recorded rather than forbidden, so
// the test can prove which credentials it was handed without any network.
const feishuDirectoryCredentials = vi.hoisted(() => [] as unknown[]);
vi.mock("./channel/feishu-directory.js", async (orig) => ({
  ...(await orig<typeof import("./channel/feishu-directory.js")>()),
  FeishuDirectory: class {
    constructor(cfg: unknown) {
      feishuDirectoryCredentials.push(cfg);
    }
    invalidate() {}
    async get() {
      return { chats: [], built_at: new Date(0).toISOString() };
    }
    async lookup() {
      return { hits: [], missing: [] };
    }
  },
}));
vi.mock("./feishu/gateway.js", async (orig) => ({
  ...(await orig<typeof import("./feishu/gateway.js")>()),
  FeishuCapabilities: class {
    verifyCatalog = async () => ({ unclassified: [], missing: [] });
    installResourceIndex = () => () => {};
  },
}));
vi.mock("./feishu/backend.js", async (orig) => ({
  ...(await orig<typeof import("./feishu/backend.js")>()),
  LarkMcpBackend: class { stop() {} },
}));
vi.mock("./feishu/oauth-commands.js", async (orig) => ({
  ...(await orig<typeof import("./feishu/oauth-commands.js")>()),
  LarkFeishuOAuthCommandTransport: class {},
  FeishuOAuthCommands: class {
    async start() {}
    async stop() {}
  },
}));


const { V3_BASE_BRANCH, V3_STABLE_BRANCH, startBootstrapV3 } = await import(
  "./bootstrap-v3.js"
);
const { loadConfig } = await import("./config.js");

const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;

let dir: string;
let saved: Record<string, string | undefined>;

function configFile(extra = "", dashboardPort = 0): string {
  const p = join(dir, "config.yaml");
  writeFileSync(
    p,
    `instance:\n`
      + `  name: v3-bootstrap-test\n`
      + `  data_dir: ${dir}\n`
      + `agent:\n`
      + `  provider: openai\n`
      + `  model: gpt-4.1-mini\n`
      + `anthropic:\n`
      + `  api_key: sk-ant-should-not-be-exported\n`
      + `  base_url: https://api.anthropic.example\n`
      + `openai:\n`
      + `  api_key: sk-oai-should-not-be-exported\n`
      + `  base_url: https://api.openai.example/v1\n`
      + `channels:\n`
      + `  feishu:\n`
      + `    enabled: true\n`
      + `    app_id: cli_should_not_be_used\n`
      + `    app_secret: secret_should_not_be_used\n`
      + `  websocket:\n`
      + `    enabled: true\n`
      + `    port: 9931\n`
      + `    auth_tokens: {}\n`
      + `runner:\n`
      + `  enabled: true\n`
      + `  port: 0\n`
      + `  host: 127.0.0.1\n`
      + `dashboard:\n`
      + `  enabled: true\n`
      + `  port: ${dashboardPort}\n`
      + `  host: 127.0.0.1\n`
      + `  auth_token: test-admin-token\n`
      + extra,
    "utf8",
  );
  return p;
}

beforeEach(() => {
  feishuDirectoryCredentials.length = 0;
  dir = mkdtempSync(join(tmpdir(), "v3-bootstrap-"));
  saved = Object.fromEntries(PROVIDER_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROVIDER_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("the v3 bootstrap composition", () => {
  it("builds the control plane with a narrow OAuth receiver and topic discussion service", async () => {
    const config = loadConfig(configFile());
    // Feishu and WebSocket are ENABLED in this config on purpose: the retired
    // v2 chat providers must stay gone whatever the config says. The narrow
    // OAuth receiver has its own mock and explicit inventory entry below.
    const health = join(dir, "health");
    const boot = await startBootstrapV3({
      config,
      dataDir: dir,
      healthFile: health,
      healthIntervalMs: 0,
      detectPublicHost: false,
      architectureAutoRefresh: false,
    });

    try {
      expect(boot.inventory.services).toEqual([
        "store",
        "user-manager",
        "runner-gateway",
        "tentacle-gate",
        "runner-capabilities",
        // Independent Objects over the same authenticated Runner transport:
        // general machine actions, workspace file reads/writes, transfers,
        // and the launch-scoped command plane. Listing each keeps the startup log honest
        // about which authority domains this composition actually built.
        "workspace-files-capabilities",
        "execution-workspace-capabilities",
        "session-branch-capabilities",
        "runner-file-transfers",
        "agent-interactions-capabilities",
        "runner-extension-capabilities",
        "meeting-transcription-capabilities",
        "capability-loopback",
        "feishu-oauth",
        "feishu-gateway",
        "discussions",
        "feishu-oauth-commands",
        "feishu-directory",
        "knowledge-chat",
        "dashboard",
      ]);
      expect(boot.inventory.entry).toBe("bootstrap-v3");
      expect(boot.inventory.surface).toBe("bootstrap-v3");
      // The directory reads the credentials the OAuth plane resolved, and is
      // handed to /admin rather than reported there as "未配置".
      expect(feishuDirectoryCredentials).toEqual([
        { appId: "cli_should_not_be_used", appSecret: "secret_should_not_be_used" },
      ]);
      // No pipeline configured here, so no branch line and no deploy service.
      expect(boot.inventory.baseBranch).toBeNull();
      expect(boot.inventory.stableBranch).toBeNull();
      expect(boot.inventory.dashboardPort).toBeGreaterThan(0);
      expect(boot.inventory.runnerPort).toBeGreaterThan(0);
      // SEC-06: no AgentPlane at all in this composition, so the number an
      // auditor checks is zero structurally rather than by filtering.
      expect(boot.inventory.execution.appReachableCodingCli).toBe(0);
      expect(existsSync(health)).toBe(true);
      expect(readFileSync(health, "utf8")).toMatch(/^\d{4}-/);
      // The v3 control plane picks the unified Session Hub. Asserted on the
      // composition rather than on the option, because the option is only worth
      // anything if it reaches the renderer — and this composition, per the
      // list above, still builds no App Host.
      expect(boot.dashboard?.sessionHubUi).toBe("unified-v3");
    } finally {
      await boot.stop();
      const ready = vi.spyOn(boot.store.managedExecutions, "ready");
      // The store is closed now. A leaked supervisor timer used to access it
      // after stop returned, emitting unhandled SQLite failures in later tests.
      await new Promise(resolve => setTimeout(resolve, 1_100));
      expect(ready).not.toHaveBeenCalled();
    }
  });

  it("does not export provider credentials into the environment", async () => {
    // The retired v2 root did this so agent subprocesses inherited them. There
    // is no such agent here, so the keys must stay in the config object.
    const config = loadConfig(configFile());
    const boot = await startBootstrapV3({
      config,
      dataDir: dir,
      healthFile: join(dir, "health"),
      healthIntervalMs: 0,
      detectPublicHost: false,
      architectureAutoRefresh: false,
    });
    try {
      for (const k of PROVIDER_KEYS) expect(process.env[k], k).toBeUndefined();
    } finally {
      await boot.stop();
    }
  });

  it("shuts down cleanly, releases the kernel's single-writer lease, and is idempotent", async () => {
    const health = join(dir, "health");
    const first = await startBootstrapV3({
      config: loadConfig(configFile()),
      dataDir: dir,
      healthFile: health,
      healthIntervalMs: 0,
      detectPublicHost: false,
      architectureAutoRefresh: false,
    });
    await first.stop();
    await first.stop(); // a signal handler and a test cleanup may both call it
    expect(existsSync(health)).toBe(false);

    // The proof that teardown actually released things: the capability store
    // takes a single-writer lease on capabilities.db, so a second boot against
    // the same data dir only works if the first one let go.
    const second = await startBootstrapV3({
      config: loadConfig(configFile()),
      dataDir: dir,
      healthFile: health,
      healthIntervalMs: 0,
      detectPublicHost: false,
      architectureAutoRefresh: false,
    });
    expect(second.inventory.services).toContain("runner-capabilities");
    await second.stop();
  });

  it("runs without a runner gateway, and says the hub then sees only this host", async () => {
    const p = join(dir, "config-norunner.yaml");
    writeFileSync(
      p,
      `instance:\n  name: t\n  data_dir: ${dir}\n`
        + `anthropic:\n  api_key: ""\n`
        + `openai:\n  api_key: ""\n`
        + `dashboard:\n  enabled: true\n  port: 0\n  host: 127.0.0.1\n  auth_token: t\n`,
      "utf8",
    );
    const boot = await startBootstrapV3({
      config: loadConfig(p),
      dataDir: dir,
      healthFile: join(dir, "health"),
      healthIntervalMs: 0,
      detectPublicHost: false,
      architectureAutoRefresh: false,
    });
    try {
      expect(boot.inventory.services).toEqual(["store", "user-manager", "knowledge-chat", "dashboard"]);
      expect(boot.inventory.runnerPort).toBeNull();
      // No Runner Object means no owner-CLI surface to report either.
      expect(
        boot.inventory.execution.executors.filter((e) => e.reachableBy === "owner-session"),
      ).toEqual([]);
    } finally {
      await boot.stop();
    }
  });
});

describe("the v3 branch line", () => {
  it("defaults to v3 / v3-stable rather than to v2's watermarks", async () => {
    // The failure this prevents only shows up after something has shipped: a
    // deploy tool that quietly pointed at `staging` would land v3 work on the
    // v2 line. Asserted through the composed services, not the constants.
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "v4");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "v4\n");
    mkdirSync(join(repo, "architecture"));
    writeFileSync(join(repo, "architecture", "atlas.json"), "{\"modules\":[],\"constraints\":[]}\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    git("branch", "v4-stable");

    const boot = await startBootstrapV3({
      config: loadConfig(
        configFile(
          `selfhosting:\n`
            + `  enabled: true\n`
            + `  repo_dir: ${repo}\n`
            + `  worktrees_dir: ${join(dir, "wt")}\n`
            + `  run_dir: ${join(dir, "run")}\n`,
        ),
      ),
      dataDir: dir,
      healthFile: join(dir, "health"),
      healthIntervalMs: 0,
      detectPublicHost: false,
      architectureAutoRefresh: false,
    });
    try {
      expect(boot.inventory.baseBranch).toBe(V3_BASE_BRANCH);
      expect(boot.inventory.baseBranch).toBe("v4");
      expect(boot.inventory.stableBranch).toBe(V3_STABLE_BRANCH);
      expect(boot.inventory.stableBranch).toBe("v4-stable");
      expect(boot.inventory.services).toContain("dev-pipeline");
      expect(boot.inventory.services).toContain("deploy-service");
      // The trusted-service line an operator reads must describe real power.
      const trusted = boot.inventory.execution.executors.filter(
        (e) => e.reachableBy === "trusted-service",
      );
      expect(trusted.map((t) => t.id)).toEqual(["system:dev-factory"]);
      expect(trusted.some((t) => /dangerously-skip-permissions/.test(t.note ?? ""))).toBe(true);
      // The old note claimed the worktree was a boundary. It is not one.
      expect(trusted.some((t) => /固定 repo\/worktree/.test(t.note ?? ""))).toBe(false);
    } finally {
      await boot.stop();
    }
  });
});


describe("Session Plus is off until an operator turns it on", () => {
  it("production composition cannot import either in-process test double", () => {
    const source = readFileSync(join(import.meta.dirname, "bootstrap-v3.ts"), "utf8");
    expect(source).not.toContain("InProcessStateClient");
    expect(source).not.toContain("InProcessRuntimeClient");
  });

  it("builds no view listener and reports nothing when the block is absent", async () => {
    // The M0 acceptance criterion, stated as one test: with the flag off the
    // composition is byte-for-byte the one that shipped before it existed.
    const boot = await startBootstrapV3({
      config: loadConfig(configFile()),
      dataDir: dir,
      healthFile: join(dir, "health"),
      healthIntervalMs: 0,
      detectPublicHost: false,
      architectureAutoRefresh: false,
    });
    try {
      expect(boot.inventory.services).not.toContain("app-view");
      expect(boot.inventory.sessionPlus).toBeNull();
      const res = await fetch(`http://127.0.0.1:${boot.inventory.dashboardPort}/sessions-plus`, {
        headers: { authorization: "Bearer test-admin-token" },
        redirect: "manual",
      });
      expect(res.status).toBe(404);
    } finally {
      await boot.stop();
    }
  });

  it("serves the Agent View from its own origin once enabled and trusted, and says so in the inventory", async () => {
    // This case owns the bootstrap/release/origin boundary, not the production
    // View build. Keep the real module plan and App backend while pinning the
    // three browser assets to immutable fixture bytes: another file in the same
    // long-lived full-suite process may already have populated release-builder
    // modules as well as view-app's build cache. Neither process-global
    // observation may decide whether this fresh registry gets a Runtime.
    // Top-level imports cannot be reset, but these fixture-only dynamic imports
    // can: load them from a fresh Vitest module graph, then build the bytes only
    // when bootstrap asks for its checkout snapshot, after bootstrap has
    // established its own process-wide composition settings.
    vi.resetModules();
    const { buildCheckoutBundle } = await import("./app-registry/session-plus-package.js");
    const { VIEW_APP_HTML } = await import("./app-core/view-app.js");
    let checkout: ReturnType<typeof buildCheckoutBundle> | null = null;
    const checkoutBundle = vi.fn(() => {
      checkout ??= buildCheckoutBundle({
        view: {
          assets: [
            { name: "view.html", source: VIEW_APP_HTML },
            { name: "view.css", source: "body { margin: 0; }\n" },
            { name: "view.js", source: "globalThis.__sessionPlusFixture = true;\n" },
          ],
        },
      });
      return checkout;
    });
    const panelPort = await freePort();
    const viewPort = await freePort();
    const boot = await startBootstrapV3({
      config: loadConfig(
        configFile(
          `session_plus:\n`
            + `  enabled: true\n`
            + `  app_domain: localhost\n`
            + `  app_scheme: http\n`
            + `  app_public_port: ${viewPort}\n`
            + `  view_port: ${viewPort}\n`,
          panelPort,
        ),
      ),
      dataDir: dir,
      healthFile: join(dir, "health"),
      healthIntervalMs: 0,
      detectPublicHost: false,
      architectureAutoRefresh: false,
      sessionPlusCheckoutBundle: checkoutBundle,
    });
    try {
      // Preflight and seed share this exact immutable release; a second call
      // would reintroduce the full-suite race this fixture is guarding.
      expect(checkoutBundle).toHaveBeenCalledTimes(1);
      expect(checkout).not.toBeNull();
      expect(boot.inventory.services).toEqual([
        "store",
        "user-manager",
        "runner-gateway",
        "tentacle-gate",
        "runner-capabilities",
        // Both planes are built from ONE `claimTransport()` call — the raw
        // dispatch leaves the gateway exactly once, and a second claim throws.
        "workspace-files-capabilities",
        "execution-workspace-capabilities",
        "session-branch-capabilities",
        "runner-file-transfers",
        "agent-interactions-capabilities",
        "runner-extension-capabilities",
        "meeting-transcription-capabilities",
        "capability-loopback",
        "feishu-oauth",
        "feishu-gateway",
        "discussions",
        "feishu-oauth-commands",
        "feishu-directory",
        // The release registry resolves BEFORE the two child processes, because
        // the Runtime is started from the ACTIVE release's materialised tree
        // rather than from the source tree.
        "app-releases",
        "session-plus-state",
        "session-plus-runtime",
        "session-plus-app",
        // The collaborative-document plane: durable store, capability Object,
        // seeded documents and the wake fan-out. Composed here because this
        // boot has a kernel (the Runner planes above).
        "crdt-docs",
        "knowledge-chat",
        "dashboard",
        // One listener for every app in the catalog; see `AppViewServer`.
        "app-view",
      ]);
      // A fresh data directory has an empty registry, so the first boot seeds
      // and activates this checkout's package — and says who did it.
      expect(boot.inventory.sessionPlus?.release).toMatchObject({
        activatedBy: "system:bootstrap",
        checkoutInstalled: true,
        originAskPort: null,
      });
      const packageDigest = boot.inventory.sessionPlus?.packageDigest;
      expect(packageDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(packageDigest).toBe(checkout!.descriptor.packageDigest);
      expect(boot.inventory.sessionPlus?.release.checkoutPackageDigest).toBe(packageDigest);
      const packageHostLabel = await import("./app-core/identity.js")
        .then((m) => m.packageHostLabel(packageDigest!));
      expect(boot.inventory.sessionPlus).toMatchObject({
        viewOrigin: `http://${packageHostLabel}.localhost:${viewPort}`,
        development: true,
        listenPort: viewPort,
        backends: { state: "ready", runtime: "ready" },
      });
      expect(boot.inventory.sessionPlus?.statePid).toBeGreaterThan(0);
      expect(boot.inventory.sessionPlus?.runtimePid).toBeGreaterThan(0);
      expect(boot.inventory.sessionPlus?.statePid).not.toBe(boot.inventory.sessionPlus?.runtimePid);
      // The two facts an operator has to check against the reverse proxy.
      expect(boot.inventory.sessionPlus?.frameAncestors).toEqual([
        `http://127.0.0.1:${panelPort}`,
        `http://localhost:${panelPort}`,
        `http://[::1]:${panelPort}`,
      ]);

      boot.store.saveUser({ username: "alice", uid: 5001, home_dir: join(dir, "alice"), created_at: new Date().toISOString() });
      const { mintDashboardToken } = await import("./dashboard/server.js");
      const token = mintDashboardToken(boot.store, "alice");
      const panelOrigin = `http://127.0.0.1:${panelPort}`;
      const login = await fetch(`${panelOrigin}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", origin: panelOrigin },
        body: JSON.stringify({ token }),
      });
      const cookies = login.headers.getSetCookie();
      const cookie = cookies.find((value) => value.startsWith("octopus_sess="))?.split(";", 1)[0] ?? "";
      const csrf = /octopus_csrf=([0-9a-f]{64})/.exec(cookies.join(";"))?.[1] ?? "";

      // Session Plus is a first-party release built from this repository, so
      // enabling the deployment is enough: there is no per-release consent
      // page (O12). The trust verb still answers, as a no-op.
      const trusted = await fetch(`${panelOrigin}/api/session-plus/trust`, {
        method: "POST",
        headers: {
          cookie,
          origin: panelOrigin,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "trust", follow_updates: false }),
      });
      expect(trusted.status).toBe(200);

      const page = await fetch(`${panelOrigin}/sessions-plus`, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain(
        `frame-src http://${packageHostLabel}.localhost:${viewPort}`,
      );

      // And the second origin really is listening, on its own port.
      const view = await fetch(`http://127.0.0.1:${viewPort}/`, {
        headers: { connection: "close" },
      });
      // Wrong Host (127.0.0.1 rather than the digest name), so the listener
      // refuses — which is itself the proof that it validates the name.
      expect(view.status).toBe(421);
    } finally {
      await boot.stop();
    }
  }, 20_000);

  it("refuses to start at all when the block is enabled but unusable", async () => {
    // Silence would be the worse answer: an operator who wrote `enabled: true`
    // believes the feature is on, and a stale hostname means the URL no longer
    // names the code inside the frame.
    await expect(
      startBootstrapV3({
        config: loadConfig(
          configFile(
            `session_plus:\n`
              + `  enabled: true\n`
              + `  view_origin: https://app-0123456789abcdef0123.apps.example.org\n`,
            await freePort(),
          ),
        ),
        dataDir: dir,
        healthFile: join(dir, "health"),
        healthIntervalMs: 0,
        detectPublicHost: false,
        architectureAutoRefresh: false,
      }),
    ).rejects.toThrow(/session_plus/);
    // Nothing was left half-started: the refusal happens before the store, the
    // runner gateway or the panel are constructed, so the data dir has no
    // database and no lease to release.
    expect(existsSync(join(dir, "bot.db"))).toBe(false);
  });
});

describe("a failed composition leaves nothing running", () => {
  it("refuses session_plus when the dashboard is disabled, before binding anything", async () => {
    // The View is only reachable through a page the panel serves, and its
    // frame-ancestors names that panel. With no dashboard the feature would
    // resolve, bind a second listener and serve a document nothing may frame:
    // "on" and unable to work.
    const { packageHostLabel } = await import("./app-core/identity.js").then((m) => m.sessionPlusIdentity());
    const viewPort = await freePort();
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(
      cfgPath,
      readFileSync(
        configFile(
          `session_plus:\n`
            + `  enabled: true\n`
            + `  view_origin: http://${packageHostLabel}.localhost:${viewPort}\n`
            + `  view_port: ${viewPort}\n`,
          await freePort(),
        ),
        "utf8",
      ).replace("dashboard:\n  enabled: true", "dashboard:\n  enabled: false"),
      "utf8",
    );
    await expect(
      startBootstrapV3({
        config: loadConfig(cfgPath),
        dataDir: dir,
        healthFile: join(dir, "health"),
        healthIntervalMs: 0,
        detectPublicHost: false,
        architectureAutoRefresh: false,
      }),
    ).rejects.toThrow(/dashboard 未启用/);
    // Refused before construction: no database, no lease to release.
    expect(existsSync(join(dir, "bot.db"))).toBe(false);
    // And nothing is listening on the port the View would have taken.
    const probe = createServer();
    await new Promise<void>((r, j) => {
      probe.once("error", j);
      probe.listen(viewPort, "127.0.0.1", () => r());
    });
    await new Promise<void>((r) => probe.close(() => r()));
  });

  it("unwinds every listener it opened when a later one cannot bind", async () => {
    // The failure this prevents: the dashboard is up and reachable, the runner
    // gateway is accepting laptops, and the kernel is holding the single-writer
    // lease on capabilities.db — while the caller has been told startup failed.
    const { packageHostLabel } = await import("./app-core/identity.js").then((m) => m.sessionPlusIdentity());
    const panelPort = await freePort();
    const viewPort = await freePort();

    // Occupy the View's port so the LAST step of the composition fails.
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(viewPort, "127.0.0.1", () => r()));

    try {
      await expect(
        startBootstrapV3({
          config: loadConfig(
            configFile(
              `session_plus:\n`
                + `  enabled: true\n`
                + `  view_origin: http://${packageHostLabel}.localhost:${viewPort}\n`
                + `  view_port: ${viewPort}\n`,
              panelPort,
            ),
          ),
          dataDir: dir,
          healthFile: join(dir, "health"),
          healthIntervalMs: 0,
          detectPublicHost: false,
          architectureAutoRefresh: false,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      // The dashboard port is free again: nothing half-started is reachable.
      const probe = createServer();
      await new Promise<void>((r, j) => {
        probe.once("error", j);
        probe.listen(panelPort, "127.0.0.1", () => r());
      });
      await new Promise<void>((r) => probe.close(() => r()));

      // And the capability lease was released, so a second attempt can start.
      const ok = await startBootstrapV3({
        config: loadConfig(configFile("", await freePort())),
        dataDir: dir,
        healthFile: join(dir, "health"),
        healthIntervalMs: 0,
        detectPublicHost: false,
        architectureAutoRefresh: false,
      });
      await ok.stop();
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });
});

/** A port nothing is listening on yet. Enough for a local composition test. */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:http");
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
