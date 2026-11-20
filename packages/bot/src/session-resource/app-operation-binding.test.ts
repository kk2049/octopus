import { describe, expect, it, vi } from "vitest";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import type { SessionPlusInstanceBinding, SessionPlusPrincipal } from "../app-core/instance.js";
import type { SessionOperationCoordinator } from "../sessionhub/operations.js";
import { SessionPlusOperationBinding } from "./app-operation-binding.js";

const principal: SessionPlusPrincipal = { owner: "alice", credential: "ws:alice", session: true };
const workspace = { id: "ws_0123456789abcdef01234567", label: "Project", display: "~/project" };
const params = { device: "laptop", runtime_device: "", source: "codex", prompt: "hello", directory: "~/project" };

function fixture(backend: Record<string, unknown> | null, online = true) {
  const submit = vi.fn().mockResolvedValue({
    ok: true,
    operation: {
      id: "op_launch", resourceId: "r", owner: "alice", device: "laptop", cliKind: "codex",
      sessionId: "", operation: "start_session", status: "submitted", submittedAt: "t", updatedAt: "t",
      live: true, message: "",
    },
  });
  const runtime = { device: "laptop", online, agentBackends: backend ? [backend] : [],
    codexAccounts: [{ id: "account_b", label: "codexb" }] };
  const binding: SessionPlusInstanceBinding = {
    id: "spi_launch", owner: "alice", credential: "ws:alice", actorKind: "user", actor: { kind: "user" },
    presence: "browser", stableAppId: "session-plus", packageDigest: "a".repeat(64),
    contractDigest: "b".repeat(32), streamId: "stream-1", viewRevision: 0, head: 0,
    projection: { placement: { devices: [runtime] },
      workspacesByDevice: { laptop: { device: "laptop", workspaces: [workspace] } } } as RuntimeJson,
    createdAt: 0, expiresAt: Date.now() + 60_000,
  };
  const coordinator = { submit } as unknown as SessionOperationCoordinator;
  return { submit, binding, coordinator, bind: new SessionPlusOperationBinding(coordinator) };
}

describe("launch inventory refusals", () => {
  it.each([
    ["unsafe_permissions", "probe_failed", "本机安装权限检查拒绝"],
    ["interpreter_unavailable", "probe_failed", "缺少可用解释器"],
    ["", "command_unavailable", "命令未被 Runner 找到"],
    ["command_unavailable", "", "命令未被 Runner 找到"],
    ["", "authentication_unavailable", "没有可用登录态"],
    ["probe_timeout", "probe_failed", "未通过本机程序探测"],
  ])("explains %s / %s without dispatching a launch", async (diagnosticCode, reason, message) => {
    const { bind, binding, submit } = fixture({ kind: "codex", available: false, diagnosticCode, reason });
    const result = await bind.submit(binding, principal, "start_session", params);
    expect(result).toMatchObject({ ok: false, status: 409, error: expect.stringContaining(message) });
    if (reason !== "authentication_unavailable") {
      expect(result).toMatchObject({ error: expect.stringContaining("octopus-runner agents list") });
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows installation guidance in both colocated and split proposals", async () => {
    const { bind, binding, submit } = fixture({ kind: "codex", available: false,
      reason: "probe_failed", diagnosticCode: "unsafe_permissions", splitExecution: true });
    for (const target of [params, { ...params, device: "executor", runtime_device: "laptop",
      directory: "", workspace_id: workspace.id }]) {
      await expect(bind.submit(binding, principal, "start_session", target)).resolves.toMatchObject({
        ok: false, status: 409, error: expect.stringContaining("程序、解释器及上级目录的所有者和写权限"),
      });
      const result = await bind.submit(binding, principal, "start_session", target);
      if (result.ok) throw new Error("unsafe installation unexpectedly admitted");
      expect(result.error).toContain("个人安装只移除不必要的写权限");
      expect(result.error).toContain("--trust-installation");
      expect(result.error).toContain("世界可写路径仍拒绝");
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("names the offending path and rule of the owner's own installation", async () => {
    const { bind, binding, submit } = fixture({ kind: "codex", available: false, reason: "probe_failed",
      diagnosticCode: "unsafe_permissions", diagnosticPath: "/home/alice/.local/bin", diagnosticRule: "group_writable" });
    const result = await bind.submit(binding, principal, "start_session", params);
    expect(result).toMatchObject({ ok: false, status: 409,
      error: expect.stringContaining("本机安装权限检查拒绝（/home/alice/.local/bin，group_writable）") });
    expect(submit).not.toHaveBeenCalled();
  });

  it("never reflects unknown diagnostic codes, paths or raw backend errors", async () => {
    const secret = "/private/install/token=secret";
    const { bind, binding, submit } = fixture({ kind: "codex", available: false,
      reason: secret, diagnosticCode: secret, detail: { path: secret }, error: secret });
    const result = await bind.submit(binding, principal, "start_session", params);
    expect(result).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("agents list") });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps the legacy refresh advice when no backend facts are available", async () => {
    const { bind, binding, submit } = fixture(null);
    await expect(bind.submit(binding, principal, "start_session", params)).resolves.toEqual({
      ok: false, status: 409, error: "laptop 当前没有可用的 codex Agent 后端；请刷新设备资产",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("explains offline status before any cached backend diagnostic", async () => {
    const { bind, binding, submit } = fixture({ kind: "codex", available: false,
      diagnosticCode: "unsafe_permissions" }, false);
    await expect(bind.submit(binding, principal, "start_session", params)).resolves.toMatchObject({
      ok: false, status: 409, error: "laptop 当前离线；请检查 Runner 连接后刷新设备资产",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits exactly once after an updated inventory reports a usable backend", async () => {
    const { bind, binding, submit } = fixture({ kind: "codex", available: true });
    await expect(bind.submit(binding, principal, "start_session", params))
      .resolves.toMatchObject({ ok: true, operation: { status: "submitted", sessionId: "" } });
    expect(submit).toHaveBeenCalledExactlyOnceWith("app:session-plus",
      { username: "alice", admin: false, credential: "ws:alice", session: true },
      { instanceId: "spi_launch", action: "start_session", source: "codex", prompt: "hello", permissionProfile: "full_access",
        runtimeDevice: "laptop", target: { kind: "directory", device: "laptop", directory: "~/project" } });
  });

  it("still requires safe split execution even when the backend is available", async () => {
    const { bind, binding, submit } = fixture({ kind: "codex", available: true, splitExecution: false });
    await expect(bind.submit(binding, principal, "start_session", {
      ...params, runtime_device: "laptop", device: "executor", directory: "", workspace_id: workspace.id,
    })).resolves.toMatchObject({ ok: false, status: 409, error: expect.stringContaining("安全跨机器执行能力") });
    expect(submit).not.toHaveBeenCalled();
  });
});
