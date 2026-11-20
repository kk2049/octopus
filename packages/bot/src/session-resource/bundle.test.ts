import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionService } from "../permissions/service.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "../runner/gateway.js";
import { LocalScanCapabilities } from "../sessionhub/local-scan.js";
import { Store } from "../store/store.js";
import { effectiveOperations } from "../permissions/effective.js";
import { SESSION_PLUS_SUBJECT_ENTRY } from "./catalog.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_AUTO_ALLOW,
  SESSION_PLUS_CHAT_UPLOAD_OPERATIONS,
  SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT,
  SESSION_PLUS_OWNER_AUTO_ALLOW,
  SESSION_PLUS_OPERATIONS,
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW,
  SESSION_PLUS_SELF_SERVICE_OPERATIONS,
  SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT,
  sessionPlusPermissionContractDigest,
} from "./contract.js";
import { AppAuthorityBundles } from "./bundle.js";
import { IntentGrantResolver } from "./intent-resolver.js";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface TransportFrame {
  owner: string;
  operation: string;
  args: Record<string, unknown>;
}

function transport(frames: TransportFrame[]): RunnerTransport {
  return {
    dispatch: async (owner: string, operation: string, args: Record<string, unknown>) => {
      frames.push({ owner, operation, args });
      return { ok: true };
    },
    listDevices: () => [],
    isOnline: () => true,
    ping: async () => 1,
    disconnect: () => true,
  } as unknown as RunnerTransport;
}

function fixture(hasRunner: boolean, hasLocal: boolean, selfService = false) {
  const dir = mkdtempSync(join(tmpdir(), "session-plus-bundle-"));
  dirs.push(dir);
  const store = new Store(join(dir, "state.db"));
  stores.push(store);
  store.saveUser({ username: "alice", uid: 9001, home_dir: "/unused", created_at: new Date(NOW).toISOString() });
  if (hasRunner) store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", new Date(NOW).toISOString());
  const frames: TransportFrame[] = [];
  const runner = new RunnerCapabilities(store, transport(frames), { now: () => NOW });
  const local = new LocalScanCapabilities({
    service: runner.service,
    userExists: (owner) => Boolean(store.getUser(owner)),
    scanHomeFor: () => hasLocal ? "/configured-but-not-read" : undefined,
    now: () => NOW,
  });
  const permissions = new PermissionService({
    store,
    caps: runner,
    local,
    now: () => NOW,
    bootstrapSessionHub: false,
    subjects: [SESSION_PLUS_SUBJECT_ENTRY],
  });
  permissions.grant({
    subjectType: "app",
    subjectId: SESSION_PLUS_APP_ID,
    owner: "alice",
    operations: selfService ? SESSION_PLUS_SELF_SERVICE_OPERATIONS : SESSION_PLUS_OPERATIONS,
    autoAllow: selfService ? SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW : SESSION_PLUS_AUTO_ALLOW,
    source: "config",
    createdBy: "system:config",
    contractDigest: selfService
      ? sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT)
      : sessionPlusPermissionContractDigest(),
    publisher: SESSION_PLUS_PUBLISHER,
  });
  const bundles = new AppAuthorityBundles({ runner, local, grants: new IntentGrantResolver(permissions, () => NOW) });
  return { bundles, frames, permissions, runner };
}

describe("AppAuthorityBundles", () => {
  const cases = [
    { name: "runner only", runner: true, local: false, count: 1, runnerRights: 6, localRights: 0 },
    { name: "local only", runner: false, local: true, count: 1, runnerRights: 0, localRights: 3 },
    { name: "both roots", runner: true, local: true, count: 2, runnerRights: 6, localRights: 3 },
    { name: "zero roots", runner: false, local: false, count: 0, runnerRights: 0, localRights: 0 },
  ];

  for (const c of cases) {
    it(`keeps ${c.name} as independent ordinary planes`, () => {
      const { bundles, permissions, runner } = fixture(c.runner, c.local);
      const opened = bundles.open("alice", `instance-${c.name}`, "package-digest");
      const contextIds = bundles.contextIds(opened.instanceId);
      expect(contextIds).toHaveLength(c.count);
      expect(bundles.rights(opened.instanceId, "runner")).toHaveLength(c.runnerRights);
      expect(bundles.rights(opened.instanceId, "local")).toHaveLength(c.localRights);

      const projected = effectiveOperations(permissions.effectiveFor({
        subjectType: "app",
        subjectId: SESSION_PLUS_APP_ID,
        owner: "alice",
      }));
      const derived = new Set([
        ...bundles.rights(opened.instanceId, "runner"),
        ...bundles.rights(opened.instanceId, "local"),
      ]);
      expect(projected).toEqual(SESSION_PLUS_OPERATIONS.filter((operation) => derived.has(operation)));

      expect(bundles.destroy(opened.instanceId)).toBe(true);
      for (const contextId of contextIds) expect(runner.service.contextIsLive(contextId)).toBe(false);
    });
  }

  it("keeps historical grants behind approval under the current user ceiling", () => {
    const { bundles, runner } = fixture(true, true);
    const opened = bundles.open("alice", "instance-terms", "package-digest");
    for (const contextId of bundles.contextIds(opened.instanceId)) {
      const terms = runner.service.termsOf(contextId, "resources");
      expect(terms.autoAllow).not.toContain("start_session");
      expect(terms.autoAllow).not.toContain("append_session");
    }
  });

  it("derives the existing upload grant onto the bot-host plane", () => {
    const { bundles, permissions } = fixture(false, true);
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      operations: [...SESSION_PLUS_CHAT_UPLOAD_OPERATIONS],
      autoAllow: [...SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT.autoAllow],
      source: "config",
      createdBy: "system:config",
      contractDigest: sessionPlusPermissionContractDigest(
        SESSION_PLUS_PUBLISHER,
        SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT,
      ),
      publisher: SESSION_PLUS_PUBLISHER,
    });
    const opened = bundles.open("alice", "instance-local-upload", "package-digest");
    expect(bundles.rights(opened.instanceId, "local")).toEqual(expect.arrayContaining([
      "list_recent_sessions",
      "search_sessions",
      "read_session",
      "upload_session_file",
    ]));
  });

  it("runs current owner-local start and append silently, for the owner's page and the owner's App agent (O1)", async () => {
    const { bundles, frames, runner } = fixture(true, false, true);
    const opened = bundles.open("alice", "instance-self-service", "package-digest");
    const contextId = bundles.contextIds(opened.instanceId)[0];
    expect(contextId).toBeDefined();
    expect(runner.service.termsOf(contextId!, "resources").autoAllow)
      .toEqual(expect.arrayContaining([...SESSION_PLUS_OWNER_AUTO_ALLOW]));

    const start = bundles.openController(opened.instanceId, "runner", "start_session");
    expect(start).not.toBeNull();
    const started = await start!.caps.request("resources", "start_session", {
      device: "laptop",
      directory: "~/project",
      source: "claude",
      prompt: "start here",
      client_request_id: "op_selfservice01",
    });
    start!.close();
    expect(started.status).toBe("succeeded");

    const append = bundles.openController(opened.instanceId, "runner", "append_session");
    expect(append).not.toBeNull();
    const appended = await append!.caps.request("resources", "append_session", {
      device: "laptop",
      id: "session-1",
      source: "claude",
      prompt: "continue",
    });
    append!.close();
    expect(appended.status).toBe("succeeded");
    expect(runner.listPending("alice")).toHaveLength(0);
    expect(frames.map((frame) => frame.operation)).toEqual(["start_session", "append_session"]);

    const agent = bundles.open("alice", "instance-agent", "package-digest", "agent");
    const agentAppend = bundles.openController(agent.instanceId, "runner", "append_session");
    expect(agentAppend).not.toBeNull();
    const agentResult = await agentAppend!.caps.request("resources", "append_session", {
      device: "laptop",
      id: "session-2",
      source: "claude",
      prompt: "agent-selected follow-up",
    });
    agentAppend!.close();
    // The agent acts for the same owner on the owner's own session: it is
    // silent within exactly the same grant, not a card the owner must press.
    expect(agentResult.status).toBe("succeeded");
    expect(frames).toHaveLength(3);
    expect(runner.listPending("alice")).toHaveLength(0);
  });

  it("opens the owner's own terminal without a card, while a share guest still asks the owner (O1)", async () => {
    const { bundles, frames, permissions, runner } = fixture(true, false, true);
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      operations: [...SESSION_PLUS_SELF_SERVICE_OPERATIONS, "open_workspace_terminal", "workspace_terminal"],
      autoAllow: [...SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW, "open_workspace_terminal", "workspace_terminal"],
      source: "config",
      createdBy: "system:config",
      contractDigest: sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT),
      publisher: SESSION_PLUS_PUBLISHER,
    });
    const open = async (instance: string, actor: "user" | "guest") => {
      const opened = bundles.open("alice", instance, "package-digest", actor);
      const run = bundles.openController(opened.instanceId, "runner", "open_workspace_terminal");
      expect(run).not.toBeNull();
      try {
        return await run!.caps.request("resources", "open_workspace_terminal", {
          device: "laptop",
          lease_id: `lease-${instance}`,
          workspace_id: "ws_0123456789abcdef01234567",
        });
      } finally {
        run!.close();
      }
    };
    expect((await open("instance-owner", "user")).status).toBe("succeeded");
    expect(frames).toHaveLength(1); // the device frame for the opened terminal
    expect((await open("instance-guest", "guest")).status).toBe("approval_required");
    expect(frames).toHaveLength(1);
    expect(runner.listPending("alice")).toHaveLength(1);
  });
});
