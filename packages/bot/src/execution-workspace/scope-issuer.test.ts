import { describe, expect, it, vi } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import {
  EXECUTION_SCOPE_OBJECT_PREFIX,
  EXECUTION_SCOPE_SLOT,
  ExecutionScopeCapabilities,
  LIST_EXECUTION_TARGETS,
  OPEN_WORKSPACE_EXECUTION,
  type ExecutionScopeIssuerPort,
} from "./scope-issuer.js";

const WS = "ws_0123456789abcdef01234567";

function harness(options: { hasDevice?: (u: string) => boolean } = {}) {
  const service = new CapabilityService();
  const port: ExecutionScopeIssuerPort = {
    listTargets: vi.fn(async (owner: string) => [{
      device: `${owner}-box`,
      online: true,
      shell: true,
      workspace_files: true,
      workspaces: [{ workspace_id: WS, label: "proj" }],
    }]),
    open: vi.fn(async (input) => ({
      pickup: `pick_${input.owner}_${input.issuer}`,
      operation_id: "scope_abc",
      device: input.device,
      workspace_id: input.workspaceId,
      permission_profile: input.permissionProfile,
      expires_at: 1_000,
    })),
  };
  const caps = new ExecutionScopeCapabilities({
    service,
    port,
    userExists: (u) => u === "alice" || u === "bob",
    hasDevice: options.hasDevice ?? ((u) => u === "alice"),
  });
  return { service, port, caps };
}

describe("ExecutionScopeCapabilities", () => {
  it("is its own Object with an owner-bound root and refuses accounts without a device", () => {
    const { service, caps } = harness();
    expect(caps.accountOperations("alice").sort()).toEqual([LIST_EXECUTION_TARGETS, OPEN_WORKSPACE_EXECUTION]);
    expect(service.hasObject(`${EXECUTION_SCOPE_OBJECT_PREFIX}:alice`)).toBe(true);
    // bob exists but holds no device: nothing to derive, and no Object appears.
    expect(caps.open({ username: "bob", purpose: "t", rights: [OPEN_WORKSPACE_EXECUTION] })).toBeNull();
    expect(caps.accountOperations("bob")).toEqual([]);
    expect(caps.open({ username: "mallory", purpose: "t", rights: [OPEN_WORKSPACE_EXECUTION] })).toBeNull();
  });

  it("lists targets unsupervised, and answers an open with a pickup — never a token", async () => {
    const { port, caps } = harness();
    const grant = caps.open({
      username: "alice",
      purpose: "MCP · 远程执行作用域",
      rights: [LIST_EXECUTION_TARGETS, OPEN_WORKSPACE_EXECUTION],
      autoAllow: [LIST_EXECUTION_TARGETS, OPEN_WORKSPACE_EXECUTION],
    });
    expect(grant).not.toBeNull();
    expect(grant!.slot).toBe(EXECUTION_SCOPE_SLOT);
    const listed = await grant!.request(LIST_EXECUTION_TARGETS, {});
    expect(listed).toMatchObject({ status: "succeeded", result: { targets: [{ device: "alice-box" }] } });
    expect(port.listTargets).toHaveBeenCalledWith("alice");

    const opened = await grant!.request(OPEN_WORKSPACE_EXECUTION, {
      device: "alice-box",
      workspace_id: WS,
      permission_profile: "full_access",
      runtime: "dsh:web",
      ttl_minutes: 30,
      issuer: "mcp:issuer01",
    });
    expect(opened.status).toBe("succeeded");
    const result = (opened as { result: Record<string, unknown> }).result;
    expect(result).toMatchObject({ pickup: "pick_alice_mcp:issuer01", device: "alice-box", workspace_id: WS });
    expect(JSON.stringify(result)).not.toMatch(/mcp_/);
    expect(port.open).toHaveBeenCalledWith({
      owner: "alice",
      issuer: "mcp:issuer01",
      device: "alice-box",
      workspaceId: WS,
      permissionProfile: "full_access",
      runtime: "dsh:web",
      ttlMs: 30 * 60_000,
    });
  });

  it("without auto-allow an open is one approval card whose approval re-runs the same call", async () => {
    const { service, port, caps } = harness();
    const grant = caps.open({
      username: "alice",
      purpose: "MCP · 远程执行作用域",
      rights: [LIST_EXECUTION_TARGETS, OPEN_WORKSPACE_EXECUTION],
      autoAllow: [LIST_EXECUTION_TARGETS],
    })!;
    const args = { device: "alice-box", workspace_id: WS, permission_profile: "manual", issuer: "mcp:issuer01" };
    const first = await grant.request(OPEN_WORKSPACE_EXECUTION, args);
    expect(first.status).toBe("approval_required");
    const pendingCallId = (first as { pendingCallId: string }).pendingCallId;
    expect(port.open).not.toHaveBeenCalled();
    const card = service.getPending(pendingCallId, "alice");
    expect(card?.title).toContain("alice-box");
    expect(card?.details.join("\n")).toContain(WS);
    expect(service.getPending(pendingCallId, "bob")).toBeNull();
    // Another owner cannot approve it.
    await expect(service.approve(pendingCallId, "bob")).resolves.toMatchObject({ status: "denied" });
    const approved = await service.approve(pendingCallId, "alice");
    expect(approved).toMatchObject({ status: "succeeded", result: { pickup: "pick_alice_mcp:issuer01" } });
    expect(port.open).toHaveBeenCalledOnce();
    // The caller collects the outcome through the kernel's own result view.
    expect(grant.capabilities.result(pendingCallId)).toMatchObject({
      state: "finished",
      outcome: "succeeded",
      result: { pickup: "pick_alice_mcp:issuer01" },
    });
  });

  it("rejects an unknown permission profile before the issuer sees it", async () => {
    const { port, caps } = harness();
    const grant = caps.open({
      username: "alice",
      purpose: "t",
      rights: [OPEN_WORKSPACE_EXECUTION],
      autoAllow: [OPEN_WORKSPACE_EXECUTION],
    })!;
    const out = await grant.request(OPEN_WORKSPACE_EXECUTION, {
      device: "alice-box",
      workspace_id: WS,
      permission_profile: "root",
      issuer: "mcp:issuer01",
    });
    expect(out.status).toBe("denied");
    expect(port.open).not.toHaveBeenCalled();
  });

  it("revoking the account kills every derived grant", async () => {
    const { caps } = harness();
    const grant = caps.open({
      username: "alice",
      purpose: "t",
      rights: [LIST_EXECUTION_TARGETS],
      autoAllow: [LIST_EXECUTION_TARGETS],
    })!;
    caps.revokeAccount("alice");
    const out = await grant.request(LIST_EXECUTION_TARGETS, {});
    expect(out.status).toBe("denied");
  });
});
