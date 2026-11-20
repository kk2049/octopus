/**
 * The projection, and the one test that makes it trustworthy.
 *
 * `computeEffective` is a pure function over intent + reality, and it would be
 * easy to write a version that renders beautifully and disagrees with the Gate.
 * So the last describe block is a DIFFERENTIAL test over a table of situations,
 * checking both directions the projection can be wrong in — and they need
 * different questions:
 *
 *   "effective" must be real       asked of the KERNEL, which is the only thing
 *                                  that knows removing a laptop revoked the
 *                                  account root.
 *   "not effective" must be real   asked of the SERVICE, by counting frames at
 *                                  a fake transport. Zero, not "an error was
 *                                  returned" — a service that dispatches and
 *                                  then reports a failure has already done it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { RunnerCapabilities, RUNNER_OPERATIONS } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { PermissionService } from "./service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { computeEffective, permissionDiff, effectiveOperations, autoAllowedOperations } from "./effective.js";
import {
  SESSION_HUB_CATALOG,
  SESSION_HUB_OPERATION_IDS,
  runnerOperationsFor,
  sessionHubOperation,
} from "./catalog.js";
import { sessionPlusSubjectEntry } from "../session-resource/catalog.js";
import {
  SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT,
  SESSION_PLUS_OWNER_LOCAL_OPERATIONS,
  SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW,
  SESSION_PLUS_SELF_SERVICE_OPERATIONS,
  SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT,
  sessionPlusPermissionContractDigest,
} from "../session-resource/contract.js";

const NOW = Date.parse("2026-07-31T10:00:00.000Z");
const ALL_RUNNER_OPS = Object.keys(RUNNER_OPERATIONS);

/**
 * A transport that RECORDS every frame instead of sending one. "Zero frames
 * reached the Runner" is the only honest way to state a denial: a service that
 * returns an error after dispatching has already done the thing.
 */
function countingTransport(frames: Array<{ operation: string; args: Record<string, unknown> }>): RunnerTransport {
  return {
    dispatch: async (_owner: string, operation: string, args: Record<string, unknown>) => {
      frames.push({ operation, args });
      return { ok: true, sessions: [], results: [], devices: ["laptop"] };
    },
    listDevices: () => [{ device: "laptop", online: true, created_at: "", last_seen_at: "" }],
    isOnline: () => true,
    ping: async () => 1,
    disconnect: () => true,
  } as unknown as RunnerTransport;
}

describe("catalog", () => {
  it("every hub operation maps onto a real Runner operation", () => {
    for (const id of SESSION_HUB_OPERATION_IDS) {
      const info = sessionHubOperation(id)!;
      expect(ALL_RUNNER_OPS).toContain(info.runner);
    }
  });

  it("live_session and read_session share one underlying read; resume shares append", () => {
    // Stated as a test rather than only in prose: if somebody ever splits these
    // at the kernel, this is where they find out the UI names have to move too.
    expect(sessionHubOperation("live_session")!.runner).toBe("read_session");
    expect(sessionHubOperation("resume_session")!.runner).toBe("append_session");
    expect(runnerOperationsFor(["read_session", "live_session"])).toEqual(["read_session"]);
  });

  it("lets the owner's own session operations, writes included, be grantable silent terms (O1)", () => {
    for (const id of SESSION_HUB_OPERATION_IDS) {
      const info = sessionHubOperation(id)!;
      expect(info.alwaysApprove).toBe(false);
      expect(info.mayAutoAllow).toBe(true);
    }
  });
});

describe("computeEffective", () => {
  const base = {
    requested: SESSION_HUB_OPERATION_IDS,
    accountOperations: ALL_RUNNER_OPS,
    now: NOW,
  };

  it("requested alone produces no authority", () => {
    const v = computeEffective({ ...base, grant: null });
    expect(v.requestedCount).toBe(SESSION_HUB_OPERATION_IDS.length);
    expect(v.grantedCount).toBe(0);
    expect(v.effectiveCount).toBe(0);
    expect(v.needsAuthorization).toBe(true);
    for (const e of v.entries) expect(e.reasons).toContain("not_granted");
  });

  it("granting makes it effective, and silence follows exactly the stored term", () => {
    const silent = computeEffective({
      ...base,
      grant: { operations: [...SESSION_HUB_OPERATION_IDS], autoAllow: [...SESSION_HUB_OPERATION_IDS], status: "active" },
    });
    expect(effectiveOperations(silent)).toEqual([...SESSION_HUB_OPERATION_IDS]);
    expect(autoAllowedOperations(silent)).toContain("append_session");
    expect(autoAllowedOperations(silent)).toContain("resume_session");
    // A row that narrows the term keeps the per-call approval for it.
    const narrowed = computeEffective({
      ...base,
      grant: { operations: [...SESSION_HUB_OPERATION_IDS], autoAllow: ["read_session"], status: "active" },
    });
    expect(autoAllowedOperations(narrowed)).toEqual(["read_session"]);
    expect(effectiveOperations(narrowed)).toContain("append_session");
  });

  it("no device registered = device_revoked on every row, whatever the grant says", () => {
    const v = computeEffective({
      ...base,
      accountOperations: [],
      grant: { operations: [...SESSION_HUB_OPERATION_IDS], autoAllow: [], status: "active" },
    });
    expect(v.effectiveCount).toBe(0);
    for (const e of v.entries) {
      expect(e.granted).toBe(true); // the INTENT survives...
      expect(e.reasons).toContain("device_revoked"); // ...the ability does not
    }
  });

  it("a revoked or expired grant is not a grant missing an operation", () => {
    const revoked = computeEffective({
      ...base,
      grant: { operations: [...SESSION_HUB_OPERATION_IDS], autoAllow: [], status: "revoked" },
    });
    expect(revoked.entries[0].reasons).toContain("revoked");
    expect(revoked.entries[0].reasons).not.toContain("not_granted");

    const expired = computeEffective({
      ...base,
      grant: {
        operations: [...SESSION_HUB_OPERATION_IDS],
        autoAllow: [],
        status: "active",
        expiresAt: new Date(NOW - 1000).toISOString(),
      },
    });
    expect(expired.entries[0].reasons).toContain("expired");

    // A timestamp we cannot read is a window we cannot police.
    const corrupt = computeEffective({
      ...base,
      grant: { operations: ["read_session"], autoAllow: [], status: "active", expiresAt: "not-a-date" },
    });
    expect(corrupt.entries.find((e) => e.operation === "read_session")!.reasons).toContain("expired");
  });

  it("a widened contract reports contract_expanded ALONGSIDE not_granted", () => {
    const v = computeEffective({
      ...base,
      requested: ["read_session", "append_session"],
      grant: { operations: ["read_session"], autoAllow: [], status: "active", contractDigest: "old" },
      contractDigest: "new",
    });
    const append = v.entries.find((e) => e.operation === "append_session")!;
    // Both, not one: "you never granted it" and "the new release asks for more"
    // are different things to do about it, and a single primary reason hides one.
    expect(append.reasons).toEqual(["contract_expanded", "not_granted"]);
    expect(v.entries.find((e) => e.operation === "read_session")!.effective).toBe(true);
  });

  it("does not project a previous publisher's grant as current authority", () => {
    const v = computeEffective({
      ...base,
      requested: ["read_session"],
      publisher: "publisher:new",
      grant: {
        operations: ["read_session"],
        autoAllow: ["read_session"],
        status: "active",
        publisher: "publisher:old",
      },
    });
    expect(v.entries[0]).toMatchObject({
      granted: false,
      effective: false,
      reasons: ["publisher_changed"],
    });
    expect(v.needsAuthorization).toBe(true);
  });

  it("an agent can only narrow: parent_revoked and agent_narrowed are separate reasons", () => {
    const v = computeEffective({
      ...base,
      requested: ["read_session", "list_sessions", "search_sessions"],
      grant: { operations: ["read_session", "list_sessions", "search_sessions"], autoAllow: [], status: "active" },
      parentEffective: ["read_session", "list_sessions"],
      agentSubset: ["read_session"],
    });
    expect(v.entries.find((e) => e.operation === "read_session")!.effective).toBe(true);
    expect(v.entries.find((e) => e.operation === "list_sessions")!.reasons).toEqual(["agent_narrowed"]);
    expect(v.entries.find((e) => e.operation === "search_sessions")!.reasons).toEqual([
      "agent_narrowed",
      "parent_revoked",
    ]);
  });

  it("an unknown operation is refused rather than rendered as a permission", () => {
    const v = computeEffective({ ...base, requested: ["delete_everything"], grant: null });
    expect(v.entries[0].reasons).toEqual(["unknown_operation"]);
    expect(v.entries[0].effective).toBe(false);
  });
});

describe("permissionDiff", () => {
  it("an unchanged contract must not interrupt anybody", () => {
    const d = permissionDiff(["a", "b"], ["b", "a"]);
    expect(d.unchanged).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("only the new part is asked about", () => {
    const d = permissionDiff(["read_session"], ["read_session", "append_session"]);
    expect(d.added).toEqual(["append_session"]);
    expect(d.kept).toEqual(["read_session"]);
    expect(d.unchanged).toBe(false);
  });

  it("narrowing is reported and needs no consent", () => {
    const d = permissionDiff(["read_session", "append_session"], ["read_session"]);
    expect(d.removed).toEqual(["append_session"]);
    expect(d.added).toEqual([]);
  });
});

/**
 * The differential test the execution plan asks for (§11 "UI/API 一致性").
 *
 * Two directions, because the projection can be wrong in two ways and they are
 * caught by different questions:
 *
 *   no false promise  everything the screen calls "effective" must really be
 *                     derivable — asked of the KERNEL, which is the only thing
 *                     that knows the account root was revoked when a laptop
 *                     was removed.
 *   no silent grant   everything the screen calls "not effective" must produce
 *                     ZERO frames at the Runner — asked of the SERVICE, by
 *                     counting what actually left the process. A grant the
 *                     screen says is gone but the execution path still honours
 *                     is the exact failure a permission UI exists to prevent,
 *                     and "an error was returned" is not evidence against it.
 */
describe("projection vs kernel", () => {
  let dir: string;
  let store: Store;
  let caps: RunnerCapabilities;
  let permissions: PermissionService;
  let hub: SessionHubService;
  /** Every RPC that actually left the process. The number the plan asks about. */
  let frames: Array<{ operation: string; args: Record<string, unknown> }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "perm-diff-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 6001, home_dir: "/x/a", created_at: new Date(NOW).toISOString() });
    frames = [];
    caps = new RunnerCapabilities(store, countingTransport(frames));
    permissions = new PermissionService({ store, caps, now: () => NOW });
    // No `scanHomeFor`: with no bot-host fallback, a read either reaches the
    // Runner or fails — which is what makes "frames === 0" the whole answer.
    hub = new SessionHubService({ store, permissions, caps, now: () => NOW });
  });

  afterEach(() => {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  /** What the kernel would really hand out for this owner and hub op set. */
  function kernelHolds(owner: string, hubOps: string[]): string[] {
    const rights = runnerOperationsFor(hubOps);
    if (rights.length === 0) return [];
    const grant = caps.open({ username: owner, purpose: "diff", kind: "session", rights });
    if (!grant) return [];
    const held = [...caps.service.rightsOf(grant.contextId, "runner")];
    grant.destroy();
    return held.sort();
  }

  /** Drive the real service path for one hub operation. */
  async function exercise(op: string): Promise<void> {
    const principal = { username: "alice", admin: false, session: true, credential: "ws:test" };
    if (op === "list_sessions") await hub.roster(principal, "alice", { limit: 10, source: "all" });
    else if (op === "search_sessions") await hub.search(principal, "alice", "x", { limit: 5 });
    else if (op === "read_session") await hub.read(principal, "alice", "laptop", { id: "s1" }).catch(() => {});
    else if (op === "live_session") {
      const live = hub.liveGrant(principal, "alice", "laptop");
      if (live.ok) live.grant.close();
    } else {
      await hub.append(principal, {
        owner: "alice",
        device: "laptop",
        sessionId: "s1",
        prompt: "继续",
        operation: op as "append_session" | "resume_session",
      });
    }
  }

  const cases: Array<{ name: string; setup: () => void; op: string }> = [
    {
      name: "no device registered → nothing is effective and the kernel derives nothing",
      setup: () => {},
      op: "read_session",
    },
    {
      name: "device registered, bootstrap grant → read is effective and the kernel holds it",
      setup: () => {
        caps.mintDeviceToken("alice", "laptop");
      },
      op: "read_session",
    },
    {
      name: "device registered, grant narrowed to list → read is NOT effective",
      setup: () => {
        caps.mintDeviceToken("alice", "laptop");
        permissions.sessionHubEffective("alice"); // bootstrap first
        permissions.grant({
          subjectType: "service",
          subjectId: "session-hub",
          owner: "alice",
          operations: ["list_sessions"],
          source: "user",
          createdBy: "alice",
        });
      },
      op: "read_session",
    },
    {
      name: "device removed after the grant → read stops being effective",
      setup: () => {
        caps.mintDeviceToken("alice", "laptop");
        permissions.sessionHubEffective("alice");
        caps.revokeDeviceToken("alice", "laptop");
      },
      op: "read_session",
    },
    {
      name: "grant revoked, device still there → read stops being effective",
      setup: () => {
        caps.mintDeviceToken("alice", "laptop");
        permissions.sessionHubEffective("alice");
        permissions.revoke({ subjectType: "service", subjectId: "session-hub", owner: "alice", by: "alice" });
      },
      op: "read_session",
    },
    {
      name: "append is effective when granted — the card is a policy decision, not an absent right",
      setup: () => {
        caps.mintDeviceToken("alice", "laptop");
        permissions.sessionHubEffective("alice");
      },
      op: "append_session",
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      c.setup();
      const view = permissions.sessionHubEffective("alice");
      const projectionSaysEffective = effectiveOperations(view).includes(c.op);
      const runnerOp = sessionHubOperation(c.op)!.runner;

      if (projectionSaysEffective) {
        // No false promise: the kernel must really be able to back it.
        expect(kernelHolds("alice", [c.op])).toContain(runnerOp);
      } else {
        // No silent grant: driving the real service path must put nothing on
        // the wire. Not "returns an error" — zero frames.
        frames.length = 0;
        await exercise(c.op);
        expect(frames.filter((f) => f.operation === runnerOp)).toHaveLength(0);
      }
    });
  }

  it("an owner in the trusted Session Hub submits directly", async () => {
    caps.mintDeviceToken("alice", "laptop");
    permissions.sessionHubEffective("alice");
    frames.length = 0;
    const out = await hub.append({ username: "alice", admin: false, session: true, credential: "ws:test" }, {
      owner: "alice",
      device: "laptop",
      sessionId: "s1",
      prompt: "继续",
    });
    expect(out.ok).toBe(true);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
  });

  it("revoking a grant destroys the pooled Contexts derived from it", () => {
    caps.mintDeviceToken("alice", "laptop");
    permissions.sessionHubEffective("alice");
    const grant = caps.open({
      username: "alice",
      purpose: "surface",
      kind: "session",
      rights: ["read_session"],
      pool: "dashboard-read",
    })!;
    expect(caps.service.contextIsLive(grant.contextId)).toBe(true);
    permissions.revoke({ subjectType: "service", subjectId: "session-hub", owner: "alice", by: "alice" });
    // Not merely "the next open() would refuse" — the Context that was already
    // handed out is gone, so a card it created can no longer be approved.
    expect(caps.service.contextIsLive(grant.contextId)).toBe(false);
    expect(caps.pooledContexts).toBe(0);
  });

  it("revoking an App grant does not tear down Session Hub pools", () => {
    caps.mintDeviceToken("alice", "laptop");
    const appPermissions = new PermissionService({
      store,
      caps,
      now: () => NOW,
      subjects: [{
        info: {
          type: "app",
          id: "reports",
          title: "Reports",
          publisher: "first-party",
          description: "test subject",
          enforced: true,
        },
        catalog: SESSION_HUB_CATALOG,
        userManaged: false,
      }],
    });
    appPermissions.grant({
      subjectType: "app",
      subjectId: "reports",
      owner: "alice",
      operations: ["read_session"],
      source: "config",
      createdBy: "system:config",
    });
    const hubContext = caps.open({
      username: "alice",
      purpose: "surface",
      kind: "session",
      rights: ["read_session"],
      pool: "dashboard-read",
    })!;
    appPermissions.revoke({ subjectType: "app", subjectId: "reports", owner: "alice", by: "system:config" });
    expect(caps.service.contextIsLive(hubContext.contextId)).toBe(true);
    hubContext.destroy();
  });

  it("narrowing a grant tears down just as revocation does", () => {
    caps.mintDeviceToken("alice", "laptop");
    permissions.sessionHubEffective("alice");
    const grant = caps.open({
      username: "alice",
      purpose: "surface",
      kind: "session",
      rights: ["read_session"],
      pool: "dashboard-read",
    })!;
    permissions.grant({
      subjectType: "service",
      subjectId: "session-hub",
      owner: "alice",
      operations: ["list_sessions"], // read_session removed
      source: "user",
      createdBy: "alice",
    });
    expect(caps.service.contextIsLive(grant.contextId)).toBe(false);
  });

  /**
   * The bootstrap checks for a ROW, not for an active one, and that distinction
   * is load-bearing: `get()` returning only active grants would make every
   * `sessionHubEffective()` call after a revocation quietly write a fresh
   * bootstrap and hand the permissions straight back. Pinned here because the
   * mistake is a one-word change in a different file.
   */
  it("revoking is permanent until re-granted — the bootstrap does not resurrect it", () => {
    caps.mintDeviceToken("alice", "laptop");
    permissions.sessionHubEffective("alice");
    permissions.revoke({ subjectType: "service", subjectId: "session-hub", owner: "alice", by: "alice" });
    for (let i = 0; i < 3; i++) {
      const view = permissions.sessionHubEffective("alice");
      expect(effectiveOperations(view)).toEqual([]);
      expect(permissions.get("service", "session-hub", "alice")!.status).toBe("revoked");
    }
    // …and the user can hand it back deliberately.
    permissions.grant({
      subjectType: "service",
      subjectId: "session-hub",
      owner: "alice",
      operations: ["read_session"],
      source: "user",
      createdBy: "alice",
    });
    expect(effectiveOperations(permissions.sessionHubEffective("alice"))).toEqual(["read_session"]);
  });

  it("the bootstrap grant is recorded as a bootstrap, not as the user agreeing", () => {
    caps.mintDeviceToken("alice", "laptop");
    permissions.sessionHubEffective("alice");
    const intent = permissions.get("service", "session-hub", "alice")!;
    expect(intent.source).toBe("bootstrap");
    expect(intent.createdBy).toBe("system:bootstrap");
    // The owner acting on their own sessions is silent by default (O1).
    expect(intent.autoAllow).toContain("append_session");
    expect(intent.autoAllow).toContain("read_session");
  });

  it("upgrades an older bootstrap row to the silent owner terms, but never a user's own narrowing", () => {
    store.saveUser({ username: "bob", uid: 9902, home_dir: "/unused/bob", created_at: new Date(NOW).toISOString() });
    caps.mintDeviceToken("alice", "laptop");
    caps.mintDeviceToken("bob", "laptop");
    for (const [owner, source] of [["alice", "bootstrap"], ["bob", "user"]] as const) {
      permissions.grant({
        subjectType: "service",
        subjectId: "session-hub",
        owner,
        operations: SESSION_HUB_OPERATION_IDS,
        autoAllow: ["list_sessions", "search_sessions", "read_session", "live_session"],
        source,
        createdBy: source === "bootstrap" ? "system:bootstrap" : owner,
      });
    }
    expect(autoAllowedOperations(permissions.sessionHubEffective("alice"))).toContain("append_session");
    expect(permissions.get("service", "session-hub", "alice")!.source).toBe("bootstrap");
    expect(autoAllowedOperations(permissions.sessionHubEffective("bob"))).not.toContain("append_session");
  });

  it("projects owner-local direct submit by default, separately from a grant term", () => {
    caps.mintDeviceToken("alice", "laptop");
    const direct = new PermissionService({
      store,
      caps,
      now: () => NOW,
    });
    const view = direct.sessionHubEffective("alice");
    const append = view.entries.find((e) => e.operation === "append_session")!;
    expect(append.effective).toBe(true);
    expect(append.directSelfAutoAllow).toBe(true);
    expect(append.alwaysApprove).toBe(false);
    // The bootstrap term makes it silent from every credential of the owner.
    expect(append.autoAllow).toBe(true);
    expect(append.explanation).toContain("网页、脚本或 MCP");
    expect(direct.get("service", "session-hub", "alice")!.autoAllow).toContain("append_session");
  });

  it("bootstraps Session Plus only with owner-local session and workspace defaults", () => {
    caps.mintDeviceToken("alice", "laptop");
    const appPermissions = new PermissionService({
      store,
      caps,
      now: () => NOW,
      subjects: [sessionPlusSubjectEntry(() => SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT)],
    });
    const digest = sessionPlusPermissionContractDigest(
      "octopus:first-party",
      SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT,
    );
    appPermissions.sessionPlusEffective("alice", digest);
    const intent = appPermissions.get("app", "session-plus", "alice")!;
    expect(intent.source).toBe("bootstrap");
    expect(intent.createdBy).toBe("system:self-service");
    expect(intent.operations).toEqual([...SESSION_PLUS_SELF_SERVICE_OPERATIONS].sort());
    expect(intent.autoAllow).toEqual([...SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW].sort());
    expect(intent.operations).not.toContain("read_document");
    expect(intent.operations).not.toContain("edit_document");

    appPermissions.revoke({ subjectType: "app", subjectId: "session-plus", owner: "alice", by: "alice" });
    appPermissions.sessionPlusEffective("alice", digest);
    expect(appPermissions.get("app", "session-plus", "alice")!.status).toBe("revoked");
  });

  it("gives the owner's own rows every owner-local operation a release declares, silently, without re-consent (O2)", () => {
    caps.mintDeviceToken("alice", "laptop");
    store.saveUser({ username: "carol", uid: 9903, home_dir: "/unused/carol", created_at: new Date(NOW).toISOString() });
    caps.mintDeviceToken("carol", "laptop");
    const contract = SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT;
    const digest = sessionPlusPermissionContractDigest("octopus:first-party", contract);
    const appPermissions = new PermissionService({
      store,
      caps,
      now: () => NOW,
      subjects: [sessionPlusSubjectEntry(() => contract)],
    });
    // Alice once consented on an older, narrower ask; Carol's row is config.
    for (const [owner, source] of [["alice", "user"], ["carol", "config"]] as const) {
      appPermissions.grant({
        subjectType: "app",
        subjectId: "session-plus",
        owner,
        operations: ["list_recent_sessions", "read_session"],
        autoAllow: ["list_recent_sessions", "read_session"],
        source,
        createdBy: source === "user" ? owner : "system:config",
        contractDigest: digest,
        publisher: "octopus:first-party",
      });
    }
    appPermissions.sessionPlusEffective("alice", digest);
    const alice = appPermissions.get("app", "session-plus", "alice")!;
    expect(alice.source).toBe("user");
    const ownerLocal = SESSION_PLUS_OWNER_LOCAL_OPERATIONS.filter((op) => contract.operations.includes(op));
    expect(alice.operations).toEqual(expect.arrayContaining(ownerLocal));
    expect(alice.autoAllow).toEqual(expect.arrayContaining(["access_owner_files", "replace_owner_text", "open_workspace_terminal"]));
    // Shared documents and outbound notification are not the owner's own.
    expect(alice.operations).not.toContain("edit_document");

    appPermissions.sessionPlusEffective("carol", digest);
    expect(appPermissions.get("app", "session-plus", "carol")!.operations).toEqual(["list_recent_sessions", "read_session"]);
  });

  it("an unknown operation cannot be stored by asking for it", () => {
    caps.mintDeviceToken("alice", "laptop");
    permissions.grant({
      subjectType: "service",
      subjectId: "session-hub",
      owner: "alice",
      operations: ["read_session", "rm_rf_slash"],
      source: "user",
      createdBy: "alice",
    });
    expect(permissions.get("service", "session-hub", "alice")!.operations).toEqual(["read_session"]);
  });

  it("revoking an App revokes its Agents' subsets too", () => {
    caps.mintDeviceToken("alice", "laptop");
    permissions.grant({
      subjectType: "app",
      subjectId: "reports",
      owner: "alice",
      operations: ["read_session", "list_sessions"],
      source: "user",
      createdBy: "alice",
    });
    permissions.grant({
      subjectType: "agent",
      subjectId: "reports/page",
      owner: "alice",
      operations: ["read_session"],
      source: "user",
      createdBy: "alice",
    });
    permissions.grant({
      subjectType: "agent",
      subjectId: "clips/page", // a DIFFERENT app's agent
      owner: "alice",
      operations: ["read_session"],
      source: "user",
      createdBy: "alice",
    });
    permissions.revoke({ subjectType: "app", subjectId: "reports", owner: "alice", by: "alice" });
    expect(permissions.get("agent", "reports/page", "alice")!.status).toBe("revoked");
    // A sibling app's agent is untouched: revoking one App is not a purge.
    expect(permissions.get("agent", "clips/page", "alice")!.status).toBe("active");
  });
});
