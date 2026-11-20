import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CapabilityService } from "@claude-bot/capability-kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentResourceCatalog } from "./agent-resources/catalog.js";
import { AuthorizationService } from "./authorization/service.js";
import { composeDashboardServices } from "./bootstrap-v3.js";
import { McpSurface } from "./mcp/service.js";
import { PermissionService } from "./permissions/service.js";
import { PermissionStudioService } from "./permissions/studio.js";
import type { RunnerCapabilities } from "./runner/capability.js";
import type { SessionPlusAppService } from "./session-plus/app-service.js";
import { sessionPlusIdentity } from "./app-core/identity.js";
import { DEFAULT_MAX_HOSTED_APPS, type SessionPlusSettings } from "./app-core/settings.js";
import { Store } from "./store/store.js";
import type { TentacleBroker } from "./tentacle/broker.js";
import type { TentacleCapabilities } from "./tentacle/capability.js";
import { TentacleService } from "./tentacle/service.js";
import type { UserManager } from "./user/types.js";
import type { WorkspaceFilesCapabilities } from "./workspace-files/capability.js";

afterEach(() => vi.restoreAllMocks());

function sessionPlusSettings(): SessionPlusSettings {
  const identity = sessionPlusIdentity();
  return {
    viewOrigin: `http://${identity.packageHostLabel}.localhost:9821`,
    viewHostHeader: `${identity.packageHostLabel}.localhost:9821`,
    origin: {
      scheme: "http:",
      domain: "localhost",
      publicPort: 9821,
      pinnedLabel: identity.packageHostLabel,
    },
    listenHost: "127.0.0.1",
    listenPort: 9821,
    originAsk: null,
    frameAncestors: ["http://127.0.0.1:9820"],
    identity,
    development: true,
    grants: [],
    maxHostedApps: DEFAULT_MAX_HOSTED_APPS,
  };
}

function fakeTentacle(order: string[]): {
  broker: TentacleBroker;
  capabilities: TentacleCapabilities;
} {
  return {
    broker: {
      onApplication: vi.fn(),
      close: vi.fn(() => order.push("broker")),
    } as unknown as TentacleBroker,
    capabilities: {} as TentacleCapabilities,
  };
}

function recordCloses(order: string[]): void {
  const closeCapability = CapabilityService.prototype.close;
  vi.spyOn(CapabilityService.prototype, "close").mockImplementation(function (this: CapabilityService) {
    order.push("capability");
    closeCapability.call(this);
  });
  const closePermissions = PermissionService.prototype.close;
  vi.spyOn(PermissionService.prototype, "close").mockImplementation(function (this: PermissionService) {
    order.push("permissions");
    closePermissions.call(this);
  });
  const closeAuthorization = AuthorizationService.prototype.close;
  vi.spyOn(AuthorizationService.prototype, "close").mockImplementation(function (this: AuthorizationService) {
    order.push("authorization");
    closeAuthorization.call(this);
  });
  const closeStudio = PermissionStudioService.prototype.close;
  vi.spyOn(PermissionStudioService.prototype, "close").mockImplementation(function (this: PermissionStudioService) {
    order.push("studio");
    closeStudio.call(this);
  });
  const onRevoked = PermissionService.prototype.onRevoked;
  vi.spyOn(PermissionService.prototype, "onRevoked").mockImplementation(function (
    this: PermissionService,
    listener: Parameters<PermissionService["onRevoked"]>[0],
  ) {
    const detach = onRevoked.call(this, listener);
    return () => {
      order.push("permission-listener");
      detach();
    };
  });
  const closeTentacle = TentacleService.prototype.close;
  vi.spyOn(TentacleService.prototype, "close").mockImplementation(function (this: TentacleService) {
    order.push("tentacle");
    closeTentacle.call(this);
  });
  const closeMcp = McpSurface.prototype.close;
  vi.spyOn(McpSurface.prototype, "close").mockImplementation(function (this: McpSurface) {
    order.push("mcp");
    closeMcp.call(this);
  });
  const shutdownCatalog = AgentResourceCatalog.prototype.shutdown;
  vi.spyOn(AgentResourceCatalog.prototype, "shutdown").mockImplementation(function (this: AgentResourceCatalog) {
    order.push("catalog");
    return shutdownCatalog.call(this);
  });
}

describe("composeDashboardServices startup transaction", () => {
  it("unwinds every acquired resource in reverse when late option projection throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-compose-rollback-"));
    const store = new Store(join(dir, "bot.db"));
    const kernel = new CapabilityService();
    const order: string[] = [];
    recordCloses(order);

    let subscriptions = 0;
    const caps = {
      service: kernel,
      listDevices: () => [],
      onTargetSetChanged: () => {
        subscriptions += 1;
        const listener = subscriptions === 1 ? "mcp-listener" : "tentacle-listener";
        return () => order.push(listener);
      },
    } as unknown as RunnerCapabilities;
    const workspaceFiles = {
      service: kernel,
      attachToRunnerLifecycle: () => () => order.push("runner-lifecycle"),
      open: () => null,
      accountOperations: () => [],
    } as unknown as WorkspaceFilesCapabilities;
    const detachAuthority = vi.fn(() => order.push("authority"));
    const sessionPlusApp = {
      attachSharing: vi.fn(),
      attachAuthority: vi.fn(() => detachAuthority),
      releaseOwner: vi.fn(),
      releaseCredential: vi.fn(),
    } as unknown as SessionPlusAppService;
    const tentacle = fakeTentacle(order);

    try {
      expect(() => composeDashboardServices(store, caps, {
        port: 0,
        sessionPlus: sessionPlusSettings(),
        sessionPlusApp,
        workspaceFiles,
        tentacle,
        userManager: {} as UserManager,
        get registration(): "open" {
          throw new Error("late option failure");
        },
      })).toThrow("late option failure");

      expect(sessionPlusApp.attachAuthority).toHaveBeenCalledOnce();
      expect(detachAuthority).toHaveBeenCalledOnce();
      expect(tentacle.broker.close).toHaveBeenCalledOnce();
      expect(order).toEqual([
        "permission-listener",
        "tentacle-listener",
        "mcp-listener",
        "mcp",
        "authority",
        "runner-lifecycle",
        "catalog",
        "studio",
        "tentacle",
        "permission-listener",
        "broker",
        "permissions",
        "authorization",
      ]);
      expect(order).not.toContain("capability");
    } finally {
      kernel.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes a factory-owned capability service when validation throws mid-composition", () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-compose-owned-"));
    const store = new Store(join(dir, "bot.db"));
    const order: string[] = [];
    recordCloses(order);
    const tentacle = fakeTentacle(order);

    try {
      expect(() => composeDashboardServices(store, undefined, {
        port: 0,
        tentacle,
        userManager: {} as UserManager,
        // Read right after the permission studio is built: everything acquired
        // so far must be unwound, including the factory-owned kernel.
        get agentInteractions(): never {
          throw new Error("mid-composition failure");
        },
      })).toThrow("mid-composition failure");

      expect(order).toEqual([
        "studio",
        "tentacle",
        "permission-listener",
        "broker",
        "permissions",
        "authorization",
        "capability",
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes a successful composition's listeners and authorization services exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-compose-close-"));
    const store = new Store(join(dir, "bot.db"));
    const order: string[] = [];
    recordCloses(order);

    try {
      const composition = composeDashboardServices(store, undefined, { port: 0 });
      await composition.close();
      await composition.close();

      expect(order).toEqual([
        "permission-listener",
        "studio",
        "mcp",
        "permissions",
        "authorization",
        "capability",
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects a validated trusted authorization program into the Studio inventory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-compose-policy-"));
    const store = new Store(join(dir, "bot.db"));
    store.saveUser({
      username: "alice",
      uid: 5001,
      home_dir: "/home/alice",
      created_at: "2026-08-15T00:00:00.000Z",
    });
    const seed = new AuthorizationService({ repository: store.authorization });
    seed.upsertDomain({
      id: "domain:acme",
      kind: "organization",
      title: "Acme",
      authority: { kind: "organization", id: "acme" },
      historyPolicy: "all",
    });
    seed.upsertResource({
      id: "resource:report:1",
      uri: "object://reports/alice/report-1",
      owner: "alice",
      domainId: "domain:acme",
      kind: "report",
      title: "Report 1",
      sensitivity: "sensitive",
      externalRef: { system: "reports", id: "report:1" },
    });
    seed.close();

    const composition = composeDashboardServices(store, undefined, {
      port: 0,
      authorizationRules: [{
        id: "acme:manager-read",
        title: "Managers read reports",
        authority: { kind: "organization", id: "acme" },
        effect: "allow",
        match: {
          subjectTypes: ["user"],
          subjectIds: ["bob"],
          resourceKinds: ["report"],
          operations: ["read"],
        },
        when: { op: "eq", left: { fact: "is_manager" }, right: { value: true } },
        explanation: "Only a runtime manager fact activates this rule.",
      }],
    });

    try {
      expect(composition.services.permissionStudio.projection("alice", true).policies).toEqual([
        expect.objectContaining({
          title: "Managers read reports",
          subjectSelector: "user；bob",
          operationSelector: "read",
          verdict: expect.stringContaining("尚未求值"),
        }),
      ]);
    } finally {
      await composition.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
