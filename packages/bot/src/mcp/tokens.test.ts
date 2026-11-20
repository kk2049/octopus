import { describe, expect, it } from "vitest";
import {
  MCP_TOKEN_POLICY_SCHEMA,
  decodeMcpTokenPolicy,
  mcpDocAssistantPolicy,
  mcpFeishuDocSharePolicy,
  mcpRegistration,
  mcpTokenPolicy,
  mcpTicketDevelopmentPolicy,
  mintMcpToken,
  resolveTentacleMcpCredential,
  tentacleMcpCredentialIsActive,
} from "./tokens.js";
import {
  MCP_TOKEN_POLICY_SCHEMA as DIRECT_POLICY_SCHEMA,
  decodeMcpTokenPolicy as directDecodeMcpTokenPolicy,
  mcpTokenPolicy as directMcpTokenPolicy,
} from "./policy-contract.js";
import { Store } from "../store/store.js";

describe("MCP token attenuation policy", () => {
  it("keeps the token module compatibility exports on the neutral policy contract", () => {
    expect(MCP_TOKEN_POLICY_SCHEMA).toBe(DIRECT_POLICY_SCHEMA);
    expect(decodeMcpTokenPolicy).toBe(directDecodeMcpTokenPolicy);
    expect(mcpTokenPolicy).toBe(directMcpTokenPolicy);
  });

  it("defaults new credentials to all generic tool groups", () => {
    expect(mcpTokenPolicy({})).toEqual({
      schema: MCP_TOKEN_POLICY_SCHEMA,
      groups: ["sessions", "workspace", "crdt", "memory", "skills", "apps", "feishu", "tentacle", "execution", "knowledge", "discussions", "transcription", "runner_capabilities"],
    });
  });

  it("canonicalises bounded App allowlists and round-trips the stored document", () => {
    const policy = mcpTokenPolicy({
      groups: ["apps", "workspace", "apps"],
      appIds: ["report-space", "daily-brief", "report-space"],
      appInstances: ["asi_team-1"],
      appActions: ["submit_report", "publish_summary"],
    });
    expect(decodeMcpTokenPolicy(JSON.stringify(policy))).toEqual({
      schema: MCP_TOKEN_POLICY_SCHEMA,
      groups: ["apps", "workspace"],
      apps: {
        ids: ["daily-brief", "report-space"],
        instances: ["asi_team-1"],
        actions: ["publish_summary", "submit_report"],
      },
    });
  });

  it("fails closed on unknown groups, malformed selectors and policy versions", () => {
    expect(() => mcpTokenPolicy({ groups: ["admin"] })).toThrow(/未知/);
    expect(() => mcpTokenPolicy({ groups: [] })).toThrow(/至少/);
    expect(() => mcpTokenPolicy({ groups: ["apps"], appIds: ["../secret"] })).toThrow(/名称/);
    expect(() => decodeMcpTokenPolicy(JSON.stringify({ schema: "mcp-token-policy/v2", groups: ["apps"] })))
      .toThrow(/schema/);
  });

  it("keeps ticket development scopes internal, exclusive and strictly bound", () => {
    const ticketDevelopment = { ticketId: 578, turn: 4, developmentId: "development_578" };
    const internal = mcpTicketDevelopmentPolicy(ticketDevelopment);
    expect(decodeMcpTokenPolicy(JSON.stringify(internal))).toEqual({
      schema: MCP_TOKEN_POLICY_SCHEMA, groups: [], ticketDevelopment,
    });
    const publicInput = { groups: ["workspace"], ticketDevelopment };
    expect(mcpTokenPolicy(publicInput).ticketDevelopment).toBeUndefined();
    for (const invalid of [
      { ...internal, groups: ["workspace"] },
      { ...internal, sessionExecution: {} },
      { ...internal, apps: {} },
      { ...internal, ticketDevelopment: { ...ticketDevelopment, turn: 0 } },
      { ...internal, ticketDevelopment: { ...ticketDevelopment, ticketId: 1.5 } },
      { ...internal, ticketDevelopment: { ...ticketDevelopment, developmentId: "../other" } },
      { ...internal, ticketDevelopment: { ...ticketDevelopment, owner: "bob" } },
    ]) expect(() => decodeMcpTokenPolicy(JSON.stringify(invalid))).toThrow(/development policy/);
  });

  it("round-trips a Feishu document share policy and fails closed on every other shape", () => {
    const shareId = `shr_${"a1".repeat(12)}`;
    const policy = mcpFeishuDocSharePolicy(shareId);
    expect(policy).toEqual({ schema: MCP_TOKEN_POLICY_SCHEMA, groups: [], feishuDocShare: { shareId } });
    expect(decodeMcpTokenPolicy(JSON.stringify(policy))).toEqual(policy);
    // The public builder never produces one.
    expect(mcpTokenPolicy({ groups: ["feishu"], feishuDocShare: { shareId } } as Parameters<typeof mcpTokenPolicy>[0]).feishuDocShare).toBeUndefined();
    const base = { schema: MCP_TOKEN_POLICY_SCHEMA, groups: [], feishuDocShare: { shareId } };
    for (const invalid of [
      { ...base, groups: ["feishu"] },
      { ...base, groups: undefined },
      { ...base, apps: {} },
      { ...base, sessionExecution: {} },
      { ...base, ticketDevelopment: { ticketId: 1, turn: 1, developmentId: "d" } },
      { ...base, feishuDocShare: { shareId, document: "OtherDocx1234567890abcdefg" } },
      { ...base, feishuDocShare: {} },
      { ...base, feishuDocShare: { shareId: "shr_1" } },
      { ...base, feishuDocShare: { shareId: `${shareId} ` } },
      { ...base, feishuDocShare: [shareId] },
      { ...base, feishuDocShare: shareId },
      { ...base, feishuDocShare: null },
    ]) expect(() => decodeMcpTokenPolicy(JSON.stringify(invalid)), JSON.stringify(invalid)).toThrow(/Feishu document share policy/);
    expect(() => mcpFeishuDocSharePolicy("../shr")).toThrow();
  });

  it("keeps a document assistant's read-only scope to one device, one share and the workspace group, and fails closed on every other shape", () => {
    const docShare = `shr_${"b2".repeat(12)}`;
    const execution = { operationId: `op_fda_${"c".repeat(40)}`, runtimeDevice: "laptop", executionDevice: "laptop",
      workspaceId: `ws_${"0".repeat(24)}`, permissionProfile: "read_only", docShare };
    const policy = mcpDocAssistantPolicy({ operationId: execution.operationId, device: "laptop", workspaceId: execution.workspaceId, docShare });
    expect(policy).toEqual({ schema: MCP_TOKEN_POLICY_SCHEMA, groups: ["workspace"], sessionExecution: execution });
    expect(decodeMcpTokenPolicy(JSON.stringify(policy))).toEqual(policy);
    // The release before this feature accepted exactly these two profiles
    // (policy-contract.ts at db91ad28) and refused any other: a rollback
    // cannot read an assistant's token as an ordinary session credential.
    expect(["full_access", "manual"]).not.toContain(policy.sessionExecution!.permissionProfile);
    const base = { schema: MCP_TOKEN_POLICY_SCHEMA, groups: ["workspace"], sessionExecution: execution };
    for (const invalid of [
      { ...base, groups: ["workspace", "sessions"] },
      { ...base, groups: ["workspace", "feishu"] },
      { ...base, groups: ["workspace", "knowledge", "discussions"] },
      { ...base, groups: ["sessions"] },
      { ...base, apps: { ids: ["daily-brief"] } },
      { ...base, sessionExecution: { ...execution, executionDevice: "worker" } },
      { ...base, sessionExecution: { ...execution, docShare: undefined } },
      { ...base, sessionExecution: { ...execution, docShare: "shr_1" } },
      { ...base, feishuDocShare: { shareId: docShare } },
    ]) expect(() => decodeMcpTokenPolicy(JSON.stringify(invalid)), JSON.stringify(invalid)).toThrow(/read-only execution policy|Feishu document share policy/);
    // A share named on any other profile, or an unknown restriction inside the scope, is refused rather than dropped.
    expect(() => decodeMcpTokenPolicy(JSON.stringify({ ...base, groups: ["workspace", "knowledge", "discussions"],
      sessionExecution: { ...execution, permissionProfile: "full_access" } }))).toThrow(/docShare requires read_only/);
    expect(() => decodeMcpTokenPolicy(JSON.stringify({ ...base, sessionExecution: { ...execution, devices: ["laptop"] } }))).toThrow(/unknown MCP session execution field/);
    expect(() => decodeMcpTokenPolicy(JSON.stringify({ ...base, sessionExecution: { ...execution, permissionProfile: "admin" } }))).toThrow(/session execution policy/);
    expect(() => mcpDocAssistantPolicy({ operationId: "op_x", device: "laptop", workspaceId: execution.workspaceId, docShare: "../shr" })).toThrow();
  });

  it("refuses a stored policy with a field it does not know instead of dropping the restriction", () => {
    const generic = mcpTokenPolicy({ groups: ["apps"], appIds: ["daily-brief"] });
    expect(() => decodeMcpTokenPolicy(JSON.stringify({ ...generic, devices: ["laptop"] }))).toThrow(/unknown MCP token policy field/);
    expect(() => decodeMcpTokenPolicy(JSON.stringify({ ...generic, apps: { ...generic.apps, devices: ["laptop"] } }))).toThrow(/app policy/);
    for (const encoded of ["null", "[]", "\"mcp-token-policy/v1\""]) expect(() => decodeMcpTokenPolicy(encoded), encoded).toThrow();
    // Every field the current builders write still decodes.
    expect(decodeMcpTokenPolicy(JSON.stringify(generic))).toEqual(generic);
  });

  it("registers a template, or a named server carrying one minted token", () => {
    expect(mcpRegistration("https://octopus.example/", 9820).command)
      .toBe('claude mcp add --transport http octopus https://octopus.example/api/mcp --header "Authorization: Bearer <mcp_token>"');
    const named = mcpRegistration(undefined, 9820, { name: "octopus-doc-a1b2c3", token: `mcp_${"0".repeat(32)}` });
    expect(named.command).toBe(`claude mcp add --transport http octopus-doc-a1b2c3 http://127.0.0.1:9820/api/mcp --header "Authorization: Bearer mcp_${"0".repeat(32)}"`);
    expect(named.config).toEqual({ mcpServers: { "octopus-doc-a1b2c3": { type: "http", url: "http://127.0.0.1:9820/api/mcp", headers: { Authorization: `Bearer mcp_${"0".repeat(32)}` } } } });
    // A user-scoped registration reaches every project of that Claude Code user.
    expect(mcpRegistration("https://octopus.example", 0, { name: "octopus-doc-a1b2c3", token: "mcp_x", scope: "user" }).command)
      .toBe('claude mcp add --transport http --scope user octopus-doc-a1b2c3 https://octopus.example/api/mcp --header "Authorization: Bearer mcp_x"');
  });

  it("keeps NULL as the explicit pre-migration compatibility policy", () => {
    expect(decodeMcpTokenPolicy(null)).toBeUndefined();
  });

  it("admits the tentacle surface only for an active explicitly attenuated token", () => {
    const store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-08-14T00:00:00Z" });
    try {
      const generic = mintMcpToken(store, {
        username: "alice",
        label: "generic",
        policy: mcpTokenPolicy({ groups: ["sessions"] }),
      });
      expect(resolveTentacleMcpCredential(store, generic.token)).toBeNull();

      const tentacle = mintMcpToken(store, {
        username: "alice",
        label: "dsh",
        policy: mcpTokenPolicy({ groups: ["tentacle"] }),
      });
      const credential = resolveTentacleMcpCredential(store, tentacle.token)!;
      expect(credential).toEqual({ username: "alice", tokenHash: tentacle.row.token_hash });
      expect(tentacleMcpCredentialIsActive(store, credential)).toBe(true);
      store.revokeMcpToken("alice", credential.tokenHash, "2026-08-14T01:00:00Z");
      expect(tentacleMcpCredentialIsActive(store, credential)).toBe(false);
    } finally {
      store.close();
    }
  });
});
