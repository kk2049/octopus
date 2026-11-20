import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../authorization/service.js";
import { AgentRuntimeCreditService } from "../agent-credits/service.js";
import type { PolicyRule } from "../authorization/types.js";
import type { RunnerDeviceStatus } from "../runner/gateway.js";
import { sessionPlusSubjectEntry } from "../session-resource/catalog.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT,
  sessionPlusPermissionContractDigest,
  type SessionPlusPermissionContract,
} from "../session-resource/contract.js";
import { Store } from "../store/store.js";
import { PermissionService } from "./service.js";
import { PermissionStudioService } from "./studio.js";

const AT = "2026-08-15T00:00:00.000Z";

describe("PermissionStudioService", () => {
  let store: Store;
  let permissions: PermissionService;
  let authorization: AuthorizationService;
  let studio: PermissionStudioService;

  beforeEach(() => {
    store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/home/alice", created_at: AT });
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/home/bob", created_at: AT });
    permissions = new PermissionService({ store, bootstrapSessionHub: false });
    authorization = new AuthorizationService({ repository: store.authorization });
    studio = new PermissionStudioService({ store, permissions, authorization });
  });

  afterEach(() => {
    studio.close();
    authorization.close();
    permissions.close();
    store.close();
  });

  it("projects configured mode separately from current kernel effectiveness", () => {
    permissions.grant({
      subjectType: "service",
      subjectId: "session-hub",
      owner: "alice",
      operations: ["read_session", "append_session"],
      autoAllow: ["read_session", "append_session"],
      source: "user",
      createdBy: "alice",
    });

    const view = studio.projection("alice", true);
    const read = view.permits.find((permit) => permit.id === "generic:service:session-hub:read_session")!;
    const append = view.permits.find((permit) => permit.id === "generic:service:session-hub:append_session")!;
    expect(read.mode).toBe("allow");
    // No Runner exists, but that must not turn a configured ALLOW into ASK.
    expect(read.verdict).toContain("不可用");
    // The owner's own append is a grantable silent term (O1): the configured
    // mode follows the stored term rather than a catalog-wide per-call rule.
    expect(append.mode).toBe("allow");
    expect(append.explanation.steps.map((step) => step.stage)).toEqual([
      "authority",
      "domain_audience",
      "permit_ceiling",
      "enforcement",
    ]);

    const preview = studio.explain({
      owner: "alice",
      actor: "alice",
      resourceId: "studio:runner-account:alice",
      holderId: "service:session-hub",
      operation: "read_session",
      proposedMode: "allow",
    });
    expect(preview.steps.at(-1)).toMatchObject({ stage: "enforcement", verdict: "当前不可用" });
  });

  it("applies only the frozen opaque proposal and refuses a stale replay", () => {
    const explained = studio.explain({
      owner: "alice",
      actor: "alice",
      resourceId: "studio:runner-account:alice",
      holderId: "service:session-hub",
      operation: "read_session",
      proposedMode: "allow",
    });
    expect(explained.proposal_id).toBeTruthy();
    expect(JSON.stringify(explained)).not.toContain("/home/alice");

    permissions.grant({
      subjectType: "service",
      subjectId: "session-hub",
      owner: "alice",
      operations: ["list_sessions"],
      autoAllow: [],
      source: "user",
      createdBy: "other-tab",
    });
    expect(studio.apply("alice", "alice", explained.proposal_id!)).toEqual({
      status: "refused",
      message: expect.stringContaining("预演后已经变化"),
    });
    // One-shot means a rejected stale proposal cannot become valid again.
    expect(studio.apply("alice", "alice", explained.proposal_id!).status).toBe("refused");

    const fresh = studio.explain({
      owner: "alice",
      actor: "alice",
      resourceId: "studio:runner-account:alice",
      holderId: "service:session-hub",
      operation: "read_session",
      proposedMode: "allow",
    });
    expect(studio.apply("alice", "bob", fresh.proposal_id!).status).toBe("refused");
    // Wrong actor does not consume the proposal belonging to Alice.
    expect(studio.apply("alice", "alice", fresh.proposal_id!).status).toBe("applied");
    expect(permissions.get("service", "session-hub", "alice")?.autoAllow).toContain("read_session");
  });

  it("shows the legacy missing-ACL behavior explicitly instead of treating the cell as deny", () => {
    const view = studio.projection("alice", true);
    const history = view.permits.find((permit) => permit.id === "cross-user:alice:bob:history")!;
    expect(history).toMatchObject({ mode: "ask", compatibility: true, editable: false });
    expect(history.verdict).toContain("没有 ACL 行");
    expect(view.emptyCell.explanation).toContain("旧兼容默认");
  });

  it("uses a frozen dedicated command path to grant and revoke shared Agent runtimes", () => {
    const device: RunnerDeviceStatus = {
      device: "provider-box",
      online: true,
      created_at: AT,
      last_seen_at: AT,
      inventory: {
        schema: "runner-inventory/v1",
        agent_backends: [{ kind: "codex", available: true, split_execution: true }],
        execution: {
          platform: "linux",
          arch: "x64",
          shell: true,
          workspace_files: true,
          workspace_count: 1,
          codex_exec_server: true,
        },
      },
    };
    const runtimes = new AgentRuntimeCreditService({
      store,
      authorization,
      devices: (owner) => owner === "alice" ? [device] : [],
      hostOwners: ["alice"],
    });
    studio.close();
    studio = new PermissionStudioService({ store, permissions, authorization, agentRuntimes: runtimes });

    const before = studio.projection("alice", true);
    const resource = before.resources.find((row) => row.kind === "agent-runtime")!;
    expect(resource).toMatchObject({ enforcement: "enforced" });
    const permitId = `agent-runtime:${resource.id}:bob`;
    expect(before.permits.find((row) => row.id === permitId)).toMatchObject({
      mode: "deny",
      editable: true,
      holderId: "user:bob",
      operation: "run_agent",
    });

    const grant = studio.explain({
      owner: "alice",
      actor: "alice",
      resourceId: resource.id,
      holderId: "user:bob",
      operation: "run_agent",
      proposedMode: "allow",
    });
    expect(grant.proposal_id).toBeTruthy();
    expect(studio.apply("alice", "alice", grant.proposal_id!)).toMatchObject({ status: "applied" });
    expect(studio.projection("alice", true).permits.find((row) => row.id === permitId))
      .toMatchObject({ mode: "allow" });

    const revoke = studio.explain({
      owner: "alice",
      actor: "alice",
      resourceId: resource.id,
      holderId: "user:bob",
      operation: "run_agent",
      proposedMode: "deny",
    });
    expect(studio.apply("alice", "alice", revoke.proposal_id!)).toMatchObject({ status: "applied" });
    expect(runtimes.permitState("alice", resource.id, "bob")).toMatchObject({ configured: false });
  });

  it("updates future App draft defaults without granting an App", () => {
    const before = studio.projection("alice", true).appDefaults.permits;
    expect(before.find((permit) => permit.operation === "read")).toMatchObject({ mode: "allow", editable: false });
    expect(before.find((permit) => permit.operation === "modify")).toMatchObject({ mode: "ask", editable: true });

    const explained = studio.explain({
      owner: "alice",
      actor: "alice",
      resourceId: "studio:app-defaults:alice",
      holderId: "studio:app-default",
      operation: "modify",
      proposedMode: "deny",
    });
    expect(studio.apply("alice", "alice", explained.proposal_id!).status).toBe("applied");
    expect(authorization.getAppInstallDefaults("alice").profile.writeMode).toBe("deny");
    expect(store.listGrantIntents("alice")).toEqual([]);
    expect(authorization.listPermits()).toEqual([]);
  });

  it("never projects an MCP token hash or plaintext-shaped credential", () => {
    const tokenHash = "a".repeat(64);
    store.saveMcpToken({
      token_hash: tokenHash,
      username: "alice",
      label: "desktop agent",
      created_at: AT,
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
      policy_json: null,
    });
    const encoded = JSON.stringify(studio.projection("alice", true));
    expect(encoded).not.toContain(tokenHash);
    expect(encoded).not.toContain("mcp_");
    expect(encoded).toContain("desktop agent");
  });

  it("projects shared App workspaces from the catalog repository boundary", () => {
    store.appCatalog.insertAppDeclaration({
      app_id: "team-reports",
      publisher: "octopus:first-party",
      title: "Team reports",
      enabled: 1,
      declared_by: "system:test",
      declared_at: AT,
    });
    store.createSharedAppInstance({
      app_id: "team-reports",
      instance_key: "asi_test",
      creator: "alice",
      created_at: AT,
      status: "open",
    }, "editor");
    expect(store.addSharedAppMember("team-reports", "asi_test", "bob", "viewer", 8, AT)).toBe(true);
    expect(store.addSharedAppMember("team-reports", "asi_test", "carol", "reviewer", 8, AT)).toBe(true);

    const view = studio.projection("alice", true);
    const resource = view.resources.find((item) => item.kind === "app-shared-state")!;
    expect(resource).toMatchObject({
      title: "Team reports 的共享状态",
      enforcement: "compatibility",
      sourceSystem: "app_shared_instances/members",
    });
    const creatorMemberships = view.permits.filter((permit) => permit.resourceId === resource.id);
    expect(creatorMemberships).toHaveLength(3);
    expect(creatorMemberships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        holderId: "user:alice",
        operation: "role:editor",
        mode: "allow",
        compatibility: true,
      }),
      expect.objectContaining({
        holderId: "user:bob",
        operation: "role:viewer",
        mode: "allow",
        compatibility: true,
      }),
      expect.objectContaining({
        holderId: "user:carol",
        operation: "role:reviewer",
        mode: "allow",
        compatibility: true,
      }),
    ]));

    const memberView = studio.projection("bob", true);
    const memberResource = memberView.resources.find((item) => item.kind === "app-shared-state")!;
    expect(memberView.permits.filter((permit) => permit.resourceId === memberResource.id)).toEqual([
      expect.objectContaining({
        holderId: "user:bob",
        operation: "role:viewer",
        mode: "allow",
      }),
    ]);
    expect(memberView.holders.find((holder) => holder.id === "user:carol")).toBeUndefined();
  });

  it("marks only the exact Tentacle user relation as wired", () => {
    authorization.upsertDomain({
      id: "personal:alice",
      kind: "personal",
      title: "Alice personal",
      authority: { kind: "owner", id: "alice" },
      historyPolicy: "all",
    });
    authorization.upsertResource({
      id: "resource:tentacle:shared",
      uri: "tool://dsh/alice/laptop/tools/bash",
      owner: "alice",
      domainId: "personal:alice",
      kind: "tentacle-tool",
      title: "Shared tool",
      sensitivity: "sensitive",
      externalRef: { system: "tentacle", id: "object:shared" },
    });
    authorization.putPermit({
      subject: { type: "user", id: "bob" },
      resourceId: "resource:tentacle:shared",
      operation: "invoke",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    authorization.putPermit({
      subject: { type: "app", id: "report-agent" },
      resourceId: "resource:tentacle:shared",
      operation: "invoke",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    studio.close();
    studio = new PermissionStudioService({
      store,
      permissions,
      authorization,
      tentacle: {
        shares: () => [{
          owner: "alice",
          viewer: "bob",
          objectId: "object:shared",
          kind: "tool",
          device: "dsh:test",
          resourceKey: "report",
          schemaDigest: "digest",
          status: "active",
          mode: "allow",
          effective: true,
          explanation: "canonical exact permit is active",
        }],
      },
    });

    const view = studio.projection("alice", true);
    const bob = view.permits.find((permit) =>
      permit.resourceId === "resource:tentacle:shared" && permit.holderId === "user:bob")!;
    const app = view.permits.find((permit) =>
      permit.resourceId === "resource:tentacle:shared" && permit.holderId === "app:report-agent")!;
    expect(bob.verdict).toContain("当前有效");
    expect(app.verdict).toContain("尚未接入执行 adapter");
    expect(app.readonlyReason).toContain("尚未接入执行路径");
  });

  it("refuses a Session Plus proposal when the active contract digest changes", () => {
    let active: SessionPlusPermissionContract = SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT;
    permissions.close();
    permissions = new PermissionService({
      store,
      bootstrapSessionHub: false,
      subjects: [sessionPlusSubjectEntry(() => active)],
    });
    studio.close();
    studio = new PermissionStudioService({
      store,
      permissions,
      authorization,
      activeSessionPlusContractDigest: () => sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, active),
    });
    const explained = studio.explain({
      owner: "alice",
      actor: "alice",
      resourceId: "studio:runner-account:alice",
      holderId: `app:${SESSION_PLUS_APP_ID}`,
      operation: "read_document",
      proposedMode: "allow",
    });
    expect(SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT.operations).toEqual(
      SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT.operations,
    );
    active = SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT;

    expect(studio.apply("alice", "alice", explained.proposal_id!)).toMatchObject({
      status: "refused",
      message: expect.stringContaining("预演后已经变化"),
    });
    expect(permissions.get("app", SESSION_PLUS_APP_ID, "alice")).toBeNull();
  });

  it("keeps dormant stored operations visible instead of silently preserving hidden authority", () => {
    permissions.close();
    permissions = new PermissionService({
      store,
      bootstrapSessionHub: false,
      subjects: [sessionPlusSubjectEntry(() => SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT)],
    });
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      operations: ["read_session", "send_notification"],
      autoAllow: ["read_session"],
      source: "user",
      createdBy: "alice",
    });
    studio.close();
    studio = new PermissionStudioService({ store, permissions, authorization });

    const view = studio.projection("alice", true);
    const dormant = view.permits.find((permit) =>
      permit.id === `generic:app:${SESSION_PLUS_APP_ID}:send_notification`)!;
    expect(dormant).toMatchObject({ mode: "ask", editable: false });
    expect(dormant.verdict).toContain("当前 release 未声明");
  });

  it("does not claim a persisted Tentacle-looking row is enforced without a live consumer", () => {
    authorization.upsertDomain({
      id: "personal:alice",
      kind: "personal",
      title: "Alice personal",
      authority: { kind: "owner", id: "alice" },
      historyPolicy: "all",
    });
    authorization.upsertResource({
      id: "resource:tentacle:orphan",
      uri: "tool://dsh/alice/laptop/tools/orphan",
      owner: "alice",
      domainId: "personal:alice",
      kind: "tentacle-tool",
      title: "Orphan tool",
      sensitivity: "sensitive",
      externalRef: { system: "tentacle", id: "object:orphan" },
    });
    authorization.putPermit({
      subject: { type: "user", id: "bob" },
      resourceId: "resource:tentacle:orphan",
      operation: "invoke",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });

    const view = studio.projection("alice", true);
    expect(view.resources.find((resource) => resource.id === "resource:tentacle:orphan")).toMatchObject({
      enforcement: "intent-only",
      description: expect.stringContaining("Object 不存在"),
    });
    expect(view.permits.find((permit) => permit.resourceId === "resource:tentacle:orphan")?.verdict)
      .toContain("尚未接入执行 adapter");
  });

  it("projects organization rules even when no exact permit exists", () => {
    const policy: PolicyRule = {
      id: "acme:report-read",
      title: "Reporting chain",
      authority: { kind: "organization", id: "acme" },
      effect: "allow",
      match: { domainKinds: ["organization"], resourceKinds: ["report"], operations: ["read"] },
      when: { op: "eq", left: { fact: "manager" }, right: { value: true } },
      explanation: "manager facts may allow report reads",
    };
    authorization.close();
    authorization = new AuthorizationService({ repository: store.authorization, rules: [policy] });
    authorization.upsertDomain({
      id: "domain:acme",
      kind: "organization",
      title: "Acme",
      authority: { kind: "organization", id: "acme" },
      historyPolicy: "all",
    });
    authorization.upsertResource({
      id: "resource:report:1",
      uri: "object://reports/alice/report-1",
      owner: "alice",
      domainId: "domain:acme",
      kind: "report",
      title: "Report 1",
      sensitivity: "sensitive",
      externalRef: { system: "reports", id: "report:1" },
    });
    studio.close();
    studio = new PermissionStudioService({ store, permissions, authorization });

    const view = studio.projection("alice", true);
    const relation = view.policies.find((item) => item.resourceId === "resource:report:1")!;
    expect(relation).toMatchObject({ effect: "allow", mandatory: false, enforcement: "intent-only" });
    expect(relation.verdict).toContain("尚未求值");
    expect(relation.subjectSelector).toContain("所有主体");
    expect(view.permits.filter((permit) => permit.resourceId === "resource:report:1")).toEqual([]);
    expect(view.emptyCell.label).toBe("无直接许可");
  });

  it("always includes explicit legacy ACLs and reports bounded default-ASK coverage", () => {
    for (let index = 0; index < 205; index++) {
      store.saveUser({
        username: `u${String(index).padStart(3, "0")}`,
        uid: 6_000 + index,
        home_dir: `/home/u${index}`,
        created_at: AT,
      });
    }
    store.upsertCrossUserAcl({
      asker_username: "u204",
      target_username: "alice",
      allowed_tools: JSON.stringify(["history", "files"]),
      require_approval: 0,
      created_at: AT,
    });

    const view = studio.projection("alice", true);
    expect(view.permits.find((permit) => permit.id === "cross-user:alice:u204:history"))
      .toMatchObject({ mode: "allow" });
    expect(view.coverage.complete).toBe(false);
    expect(view.coverage.notices.join(" ")).toContain("所有显式 ACL 均已显示");
  });

  it("partitions bounded proposal eviction by owner and clears proposals on close", () => {
    const alice = studio.explain({
      owner: "alice",
      actor: "alice",
      resourceId: "studio:runner-account:alice",
      holderId: "service:session-hub",
      operation: "read_session",
      proposedMode: "ask",
    });
    for (let index = 0; index < 70; index++) {
      studio.explain({
        owner: "bob",
        actor: "bob",
        resourceId: "studio:runner-account:bob",
        holderId: "service:session-hub",
        operation: "read_session",
        proposedMode: index % 2 ? "ask" : "deny",
      });
    }
    expect(studio.apply("alice", "alice", alice.proposal_id!).status).toBe("applied");

    const doomed = studio.explain({
      owner: "alice",
      actor: "alice",
      resourceId: "studio:runner-account:alice",
      holderId: "service:session-hub",
      operation: "read_session",
      proposedMode: "deny",
    });
    studio.close();
    expect(studio.apply("alice", "alice", doomed.proposal_id!)).toMatchObject({ status: "refused" });
  });
});
