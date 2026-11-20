import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionService } from "../permissions/service.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "../runner/gateway.js";
import { resourceId } from "../sessionhub/core.js";
import { SessionHubOperationExecutor } from "../sessionhub/operation-executor.js";
import { SessionOperationCoordinator, type SessionOperationView } from "../sessionhub/operations.js";
import { SessionHubService, type HubPrincipal } from "../sessionhub/service.js";
import { Store } from "../store/store.js";
import { AppAuthorityBundles } from "./bundle.js";
import { SESSION_PLUS_SUBJECT_ENTRY } from "./catalog.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_AUTO_ALLOW,
  SESSION_PLUS_OPERATIONS,
  SESSION_PLUS_OWNER_AUTO_ALLOW,
  SESSION_PLUS_PUBLISHER,
  sessionPlusPermissionContractDigest,
} from "./contract.js";
import { IntentGrantResolver } from "./intent-resolver.js";
import { SessionResourceOperationExecutor } from "./operation-executor.js";

const NOW = Date.parse("2026-08-04T15:00:00.000Z");
const OLD_SESSION = "aaaa1111-2222-3333-4444-555566667777";
const NEW_SESSION = "bbbb1111-2222-3333-4444-555566667777";
const WORKSPACE = {
  device: "laptop",
  id: "ws_0123456789abcdef01234567",
  label: "Octopus",
  display: "~/lht/octopus",
} as const;
const SECRET_PATH = "/canonical/private/worktree-9f52";

describe("SessionResourceOperationExecutor with the historical sessions/v1 contract", () => {
  let dir: string;
  let store: Store;
  let runner: RunnerCapabilities;
  let permissions: PermissionService;
  let bundles: AppAuthorityBundles;
  let hub: SessionHubService;
  let coordinator: SessionOperationCoordinator;
  let appExecutor: SessionResourceOperationExecutor;
  let frames: Array<{ owner: string; operation: string; args: Record<string, unknown> }>;
  // Queries are a separate, read-only wire action. Keep exact write assertions
  // and independently verify every receipt read retains its owner and operation.
  let receiptQueries: Array<{ owner: string; operation: string; args: Record<string, unknown> }>;
  let holdAppends: boolean;
  let heldAppends: Array<(value: unknown) => void>;
  let id = 0;

  const principal: HubPrincipal = {
    username: "alice",
    admin: false,
    session: true,
    credential: "ws:alice",
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-plus-ops-"));
    store = new Store(join(dir, "state.db"));
    store.saveUser({ username: "alice", uid: 9101, home_dir: "/unused", created_at: new Date(NOW).toISOString() });
    store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", new Date(NOW).toISOString());
    frames = [];
    receiptQueries = [];
    holdAppends = false;
    heldAppends = [];
    const transport: RunnerTransport = {
      dispatch: async (owner, operation, args) => {
        if (operation === "get_session_operation") {
          receiptQueries.push({ owner, operation, args });
          // Model an old Runner with no durable receipt yet; the original
          // completion response below remains authoritative and is not replayed.
          return { ok: false, code: "not_found" };
        }
        frames.push({ owner, operation, args });
        if (operation === "start_session") {
          return { ok: true, agent: args.source, session_id: NEW_SESSION, duration_ms: 12 };
        }
        if (operation === "append_session") {
          if (holdAppends) {
            return await new Promise((resolve) => heldAppends.push(resolve));
          }
          return { ok: true, agent: args.source, duration_ms: 9, result_text: "done" };
        }
        throw new Error(`unexpected ${operation}`);
      },
      listDevices: () => [],
      isOnline: () => true,
      ping: async () => 1,
      disconnect: () => true,
      openDshTunnel: async () => { throw new Error("unexpected DSH tunnel"); },
    };
    runner = new RunnerCapabilities(store, transport, { now: () => NOW });
    permissions = new PermissionService({
      store,
      caps: runner,
      now: () => NOW,
      subjects: [SESSION_PLUS_SUBJECT_ENTRY],
    });
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      operations: SESSION_PLUS_OPERATIONS,
      autoAllow: SESSION_PLUS_AUTO_ALLOW,
      source: "config",
      createdBy: "system:config",
      contractDigest: sessionPlusPermissionContractDigest(),
      publisher: SESSION_PLUS_PUBLISHER,
    });
    permissions.sessionHubEffective("alice");
    bundles = new AppAuthorityBundles({ runner, grants: new IntentGrantResolver(permissions, () => NOW) });
    bundles.open("alice", "instance-a", "package-a");
    hub = new SessionHubService({ store, permissions, caps: runner, now: () => NOW });
    appExecutor = new SessionResourceOperationExecutor(bundles, permissions, hub.leases, () => NOW);
    coordinator = new SessionOperationCoordinator({
      store,
      caps: runner,
      executors: {
        hub: new SessionHubOperationExecutor(hub),
        "app:session-plus": appExecutor,
      },
      now: () => NOW,
      newId: () => `op_test${String(++id).padStart(4, "0")}`,
    });
  });

  afterEach(async () => {
    for (const release of heldAppends.splice(0)) {
      release({ ok: true, agent: "claude", duration_ms: 9, result_text: "done" });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    coordinator.close();
    for (const query of receiptQueries) {
      expect(query.owner).toBe("alice");
      const operation = store.getSessionOperation(String(query.args.operation_id), query.owner);
      expect(operation).not.toBeNull();
      expect(query.args).toEqual({ device: "laptop", operation_id: operation!.id });
    }
    runner.service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("closes the shared Agent profile vocabulary and binds it into the operation fingerprint", () => {
    const base = {
      instanceId: "instance-a",
      action: "start_session" as const,
      source: "codex" as const,
      prompt: "same",
      target: { kind: "workspace" as const, workspace: WORKSPACE },
    };
    const full = appExecutor.describe(principal, { ...base, permissionProfile: "full_access" });
    const manual = appExecutor.describe(principal, { ...base, permissionProfile: "manual" });
    expect(full.ok && manual.ok && full.intent.fingerprint).not.toBe(manual.ok ? manual.intent.fingerprint : "");
    expect(appExecutor.describe(principal, {
      ...base,
      permissionProfile: "invalid" as "manual",
    })).toEqual({ ok: false, status: 400, error: "Agent 权限档位无效" });

    const claude = { ...base, source: "claude" as const };
    const claudeFull = appExecutor.describe(principal, { ...claude, permissionProfile: "full_access" });
    const claudeManual = appExecutor.describe(principal, { ...claude, permissionProfile: "manual" });
    expect(claudeFull.ok && claudeManual.ok && claudeFull.intent.fingerprint)
      .not.toBe(claudeManual.ok ? claudeManual.intent.fingerprint : "");
  });

  it("keeps distinct Codex accounts in distinct launch intents", () => {
    const input = { instanceId: "instance-a", action: "start_session" as const, source: "codex" as const,
      prompt: "same", target: { kind: "workspace" as const, workspace: WORKSPACE } };
    const a = appExecutor.describe(principal, { ...input, codexAccount: "account_a" });
    const b = appExecutor.describe(principal, { ...input, codexAccount: "account_b" });
    expect(a.ok && b.ok && a.intent.fingerprint).not.toBe(b.ok ? b.intent.fingerprint : "");
    expect(appExecutor.describe(principal, { ...input, codexAccount: "/private/home" }).ok).toBe(false);
    expect(appExecutor.describe(principal, { ...input, source: "claude", codexAccount: "account_a" }).ok).toBe(false);
  });

  it("makes the bilingual Claude lane its own intent and refuses it elsewhere", () => {
    const claude = {
      instanceId: "instance-a",
      action: "start_session" as const,
      source: "claude" as const,
      prompt: "same",
      target: { kind: "workspace" as const, workspace: WORKSPACE },
    };
    const plain = appExecutor.describe(principal, claude);
    const bilingual = appExecutor.describe(principal, { ...claude, translatePrompt: true });
    // Same prompt, same placement, different lane. If these shared a
    // fingerprint the second press would join the first card and quietly run
    // in the lane nobody picked the second time.
    expect(plain.ok && bilingual.ok && plain.intent.fingerprint)
      .not.toBe(bilingual.ok ? bilingual.intent.fingerprint : "");

    expect(appExecutor.describe(principal, {
      ...claude,
      source: "omp" as const,
      translatePrompt: true,
    })).toEqual({ ok: false, status: 400, error: "只有 Claude 支持中英双语车道" });
  });

  it("makes an existing-session model selection part of the intent fingerprint", () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: OLD_SESSION });
    const base = {
      instanceId: "instance-a",
      action: "resume_session" as const,
      prompt: "same",
      session: {
        resourceId: rid,
        deviceId: "laptop",
        cliKind: "codex" as const,
        sessionId: OLD_SESSION,
      },
    };
    const inherited = appExecutor.describe(principal, base);
    const selected = appExecutor.describe(principal, { ...base, model: "gpt-5.6-terra" });
    expect(inherited.ok && selected.ok && inherited.intent.fingerprint)
      .not.toBe(selected.ok ? selected.intent.fingerprint : "");
  });

  it("keeps historical start behind approval, freezes public workspace evidence, and persists the returned id", async () => {
    const prompt = "完成这个项目。".repeat(3_000);
    const submitted = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "start_session",
      source: "claude",
      model: "opus",
      effort: "max",
      launchMode: "independent_cli",
      prompt,
      target: { kind: "workspace", workspace: WORKSPACE },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const waiting = await submitted.settled;
    expect(waiting.view).toMatchObject({ surface: "app:session-plus", status: "waiting_approval" });
    expect(frames).toHaveLength(0);

    const card = runner.listPending("alice")[0];
    const disclosure = card.details.join("\n");
    expect(disclosure).toContain(WORKSPACE.label);
    expect(disclosure).toContain(WORKSPACE.display);
    expect(disclosure).toContain("模型：opus");
    expect(disclosure).toContain("Effort：max");
    expect(disclosure).toContain("Claude Code 权限：全通过");
    expect(disclosure).toContain(submitted.operation.id);
    expect(disclosure).not.toContain(SECRET_PATH);

    expect(coordinator.approveAsOperation(card.id, "alice")?.status).toBe("running");
    const done = await waitFor(() => coordinator.get("alice", submitted.operation.id), (view) => !view.live);
    expect(done).toMatchObject({ status: "succeeded", sessionId: NEW_SESSION });
    expect(store.getSessionOperation(submitted.operation.id, "alice")?.session_id).toBe(NEW_SESSION);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      owner: "alice",
      operation: "start_session",
      args: {
        device: "laptop",
        workspace_id: WORKSPACE.id,
        workspace_label: WORKSPACE.label,
        workspace_display: WORKSPACE.display,
        model: "opus",
        effort: "max",
        permission_profile: "full_access",
        _octopus_launch_mode: "independent_cli",
        prompt,
        client_request_id: submitted.operation.id,
      },
    });
    expect(JSON.stringify(frames)).not.toContain(SECRET_PATH);
  });

  it("admits a borrowed Agent runtime through the real Gate and freezes it into the approved call (B13)", async () => {
    // A shared Agent runtime is routed by two trusted keys the executor adds
    // to start_session. The kernel's schema is closed: an undeclared key is a
    // denial before any policy, so this launch used to fail outright with
    // `unknown argument "_octopus_runtime_owner"` and never produce a card.
    const runtime = `agent-runtime:${"a".repeat(32)}`;
    const submitted = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "start_session",
      source: "codex",
      prompt: "在借用的运行环境里开始",
      target: { kind: "workspace", workspace: WORKSPACE },
      borrowedRuntime: { owner: "root", resourceId: runtime },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const waiting = await submitted.settled;
    expect(waiting.view.detail ?? "").not.toContain("unknown argument");
    expect(waiting.view).toMatchObject({ surface: "app:session-plus", status: "waiting_approval" });
    expect(frames).toHaveLength(0);

    const card = runner.listPending("alice")[0];
    expect(coordinator.approveAsOperation(card.id, "alice")?.status).toBe("running");
    const done = await waitFor(() => coordinator.get("alice", submitted.operation.id), (view) => !view.live);
    expect(done).toMatchObject({ status: "succeeded" });
    // The approved, canonical call carries the routing the trusted dispatch
    // preparer reads (and strips) after the Gate. No preparer is installed in
    // this harness, so the frame shows exactly what the Gate admitted.
    expect(frames).toHaveLength(1);
    expect(frames[0]!.args).toMatchObject({
      _octopus_runtime_owner: "root",
      _octopus_runtime_resource_id: runtime,
      client_request_id: submitted.operation.id,
    });
  });

  it("stores resume as the six-word append token and blocks Hub behind the shared lease", async () => {
    const prompt = "继续修复。".repeat(3_000);
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: OLD_SESSION });
    const app = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "resume_session",
      prompt,
      session: {
        resourceId: rid,
        deviceId: "laptop",
        cliKind: "claude",
        sessionId: OLD_SESSION,
      },
    });
    expect(app.ok).toBe(true);
    if (!app.ok) return;
    const waiting = await app.settled;
    expect(waiting.view).toMatchObject({ operation: "append_session", status: "waiting_approval" });
    expect(frames).toHaveLength(0);

    const hubAttempt = await coordinator.submit("hub", principal, {
      owner: "alice",
      device: "laptop",
      sessionId: OLD_SESSION,
      source: "claude",
      prompt: "另一条并发指令",
      operation: "append_session",
    });
    expect(hubAttempt).toMatchObject({ ok: false, status: 409 });
    expect(store.listSessionOperations("alice")).toHaveLength(1);

    const pending = waiting.view.pendingCallId!;
    expect(runner.reject(pending, "alice")).toBe(true);
    expect(coordinator.rejectAsOperation(pending, "alice")?.status).toBe("rejected");
  });

  it("hands a dispatched App append to the Runner so a newer message can steer", async () => {
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      operations: SESSION_PLUS_OPERATIONS,
      autoAllow: SESSION_PLUS_OWNER_AUTO_ALLOW,
      source: "config",
      createdBy: "system:config",
      contractDigest: sessionPlusPermissionContractDigest(),
      publisher: SESSION_PLUS_PUBLISHER,
    });
    bundles.destroy("instance-a");
    bundles.open("alice", "instance-a", "package-a");
    holdAppends = true;
    const session = {
      resourceId: resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: OLD_SESSION }),
      deviceId: "laptop",
      cliKind: "claude" as const,
      sessionId: OLD_SESSION,
    };

    const first = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "append_session",
      prompt: "第一条：继续实现",
      session,
    });
    if (!first.ok) throw new Error("expected first acceptance");
    await waitFor(() => coordinator.get("alice", first.operation.id), (view) => view.status === "running");

    const second = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "append_session",
      prompt: "第二条：同时补上风险分析",
      session,
    });
    if (!second.ok) throw new Error("expected second acceptance");
    await waitFor(() => coordinator.get("alice", second.operation.id), (view) => view.status === "running");
    expect(frames.map((frame) => frame.args.prompt))
      .toEqual(["第一条：继续实现", "第二条：同时补上风险分析"]);

    for (const release of heldAppends.splice(0)) {
      release({ ok: true, agent: "claude", duration_ms: 9, result_text: "done" });
    }
    await waitFor(() => coordinator.get("alice", first.operation.id), (view) => !view.live);
    await waitFor(() => coordinator.get("alice", second.operation.id), (view) => !view.live);
  });

  it("lets native interrupt pass the writer lease held by the turn it stops", async () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: OLD_SESSION });
    const append = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "append_session",
      prompt: "持续工作",
      session: { resourceId: rid, deviceId: "laptop", cliKind: "claude", sessionId: OLD_SESSION },
    });
    expect(append.ok).toBe(true);
    if (!append.ok) return;
    const appendWaiting = await append.settled;

    const interrupted = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "interrupt_session",
      session: { resourceId: rid, deviceId: "laptop", cliKind: "claude", sessionId: OLD_SESSION },
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    const interruptWaiting = await interrupted.settled;
    expect(interruptWaiting.view).toMatchObject({ operation: "interrupt_session", status: "waiting_approval" });
    const interruptCard = runner.listPending("alice").find((card) => card.id === interruptWaiting.view.pendingCallId)!;
    expect(interruptCard.details.join("\n")).toContain("供应商原生 interrupt");

    expect(coordinator.approveAsOperation(interruptCard.id, "alice")?.status).toBe("running");
    await waitFor(() => coordinator.get("alice", interrupted.operation.id), (view) => !view.live);
    expect(frames.at(-1)).toMatchObject({
      operation: "append_session",
      args: { device: "laptop", source: "claude", id: OLD_SESSION, interrupt: true },
    });
    runner.reject(appendWaiting.view.pendingCallId!, "alice");
    coordinator.rejectAsOperation(appendWaiting.view.pendingCallId!, "alice");
  });

  it("releases Codex control without a prompt or writer lease and freezes the exact device intent", async () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: OLD_SESSION });
    const append = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "append_session",
      prompt: "占住写者车道",
      session: { resourceId: rid, deviceId: "laptop", cliKind: "codex", sessionId: OLD_SESSION },
    });
    expect(append.ok).toBe(true);
    if (!append.ok) return;
    const appendWaiting = await append.settled;

    const submitted = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "release_session_control",
      session: { resourceId: rid, deviceId: "laptop", cliKind: "codex", sessionId: OLD_SESSION },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const waiting = await submitted.settled;
    expect(waiting.view).toMatchObject({ operation: "release_session_control", status: "waiting_approval" });
    const card = runner.listPending("alice").find((row) => row.id === waiting.view.pendingCallId)!;
    expect(card).toMatchObject({ operation: "append_session" });
    expect(card.details.join("\n")).toContain("精确子进程");

    expect(coordinator.approveAsOperation(card.id, "alice")?.status).toBe("running");
    await waitFor(() => coordinator.get("alice", submitted.operation.id), (view) => !view.live);
    expect(frames.at(-1)).toEqual({
      owner: "alice",
      operation: "append_session",
      args: { device: "laptop", source: "codex", id: OLD_SESSION, release_control: true,
        operation_id: submitted.operation.id, input_receipt: true },
    });

    const claudeRid = resourceId({
      owner: "alice",
      device: "laptop",
      cliKind: "claude",
      sessionId: "claude-session",
    });
    await expect(coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "release_session_control",
      session: {
        resourceId: claudeRid,
        deviceId: "laptop",
        cliKind: "claude",
        sessionId: "claude-session",
      },
    })).resolves.toMatchObject({ ok: false, status: 400 });

    runner.reject(appendWaiting.view.pendingCallId!, "alice");
    coordinator.rejectAsOperation(appendWaiting.view.pendingCallId!, "alice");
  });

  it("keeps takeover explicit while spending append_session authority and freezes takeover=true", async () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: OLD_SESSION });
    const submitted = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "takeover_session",
      prompt: "切到浏览器继续",
      session: {
        resourceId: rid,
        deviceId: "laptop",
        cliKind: "codex",
        sessionId: OLD_SESSION,
      },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const waiting = await submitted.settled;
    expect(waiting.view).toMatchObject({ operation: "takeover_session", status: "waiting_approval" });
    const card = runner.listPending("alice")[0];
    expect(card).toMatchObject({ operation: "append_session" });
    expect(frames).toHaveLength(0);

    expect(coordinator.approveAsOperation(waiting.view.pendingCallId!, "alice")?.status).toBe("running");
    await waitFor(() => coordinator.get("alice", submitted.operation.id), (view) => !view.live);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      operation: "append_session",
      args: { device: "laptop", source: "codex", id: OLD_SESSION, takeover: true },
    });
  });

  it("keeps cross-account fallback explicit while freezing its turn configuration", async () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: OLD_SESSION });
    const submitted = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "fallback_session",
      prompt: "用备用账号继续",
      model: "gpt-5.6-terra",
      effort: "xhigh",
      session: {
        resourceId: rid,
        deviceId: "laptop",
        cliKind: "codex",
        sessionId: OLD_SESSION,
      },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const waiting = await submitted.settled;
    expect(waiting.view).toMatchObject({ operation: "fallback_session", status: "waiting_approval" });
    expect(runner.listPending("alice")[0]).toMatchObject({ operation: "append_session" });
    expect(runner.listPending("alice")[0].details.join("\n")).toContain("模型：gpt-5.6-terra");
    expect(coordinator.approveAsOperation(waiting.view.pendingCallId!, "alice")?.status).toBe("running");
    await waitFor(() => coordinator.get("alice", submitted.operation.id), (view) => !view.live);
    expect(frames[0]).toMatchObject({
      operation: "append_session",
      args: {
        device: "laptop",
        source: "codex",
        id: OLD_SESSION,
        account_fallback: true,
        model: "gpt-5.6-terra",
        effort: "xhigh",
      },
    });

    const claudeResource = resourceId({
      owner: "alice",
      device: "laptop",
      cliKind: "claude",
      sessionId: "claude-session",
    });
    await expect(coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "fallback_session",
      prompt: "不能切账号",
      session: {
        resourceId: claudeResource,
        deviceId: "laptop",
        cliKind: "claude",
        sessionId: "claude-session",
      },
    })).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it("freezes a typed directory into the card and the frame, verbatim", async () => {
    const submitted = await coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "start_session",
      source: "codex",
      effort: "max",
      prompt: "在这里开始",
      target: { kind: "directory", device: "laptop", directory: "~/brand/new" },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    await submitted.settled;

    const card = runner.listPending("alice")[0];
    const disclosure = card.details.join("\n");
    // The card names the target in the SAME form the caller used, and says the
    // one thing a reader needs to weigh: this is a starting point, not a fence.
    expect(disclosure).toContain("目录：~/brand/new");
    expect(disclosure).toContain("Codex 权限：全通过");
    expect(disclosure).not.toContain("工作区：");
    expect(disclosure).toContain("不是沙箱");
    expect(frames).toHaveLength(0);

    expect(coordinator.approveAsOperation(card.id, "alice")?.status).toBe("running");
    await waitFor(() => coordinator.get("alice", submitted.operation.id), (view) => !view.live);
    expect(frames).toHaveLength(1);
    expect(frames[0].args).toMatchObject({
      device: "laptop",
      directory: "~/brand/new",
      source: "codex",
      effort: "max",
      permission_profile: "full_access",
      client_request_id: submitted.operation.id,
    });
    // Exactly one form reaches the device: a frame carrying both would let the
    // approved card and the executed cwd disagree.
    expect(frames[0].args.workspace_id).toBeUndefined();
  });

  it("refuses a malformed directory before anything is submitted", async () => {
    for (const directory of ["src/app", "C:\\work", "", "~other", "/a\u0000b", " /leading"]) {
      const submitted = await coordinator.submit("app:session-plus", principal, {
        instanceId: "instance-a",
        action: "start_session",
        source: "claude",
        prompt: "go",
        target: { kind: "directory", device: "laptop", directory },
      });
      expect({ directory, ok: submitted.ok }).toEqual({ directory, ok: false });
    }
    expect(store.listSessionOperations("alice")).toHaveLength(0);
    expect(runner.listPending("alice")).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it("treats two directories as two intents and one directory twice as one", async () => {
    // The fingerprint decides whether a second press joins the first card or
    // opens a new one, so it has to cover the target exactly as it will be sent.
    const start = (directory: string) => coordinator.submit("app:session-plus", principal, {
      instanceId: "instance-a",
      action: "start_session",
      source: "claude",
      prompt: "同一句话",
      target: { kind: "directory", device: "laptop", directory },
    });
    const first = await start("~/one");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.settled;
    const again = await start("~/one");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // Same intent: one durable record, one card.
    expect(again.operation.id).toBe(first.operation.id);
    expect(runner.listPending("alice")).toHaveLength(1);

    const other = await start("~/two");
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.operation.id).not.toBe(first.operation.id);
    await other.settled;
    expect(runner.listPending("alice")).toHaveLength(2);
  });
});

async function waitFor(
  read: () => SessionOperationView | null,
  predicate: (view: SessionOperationView) => boolean,
  timeoutMs = 2_000,
): Promise<SessionOperationView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value && predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error(`operation did not settle (${value?.status ?? "missing"})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
