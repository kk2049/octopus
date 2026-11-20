/**
 * What the trusted side does with a View's `start_session` proposal.
 *
 * This is the seam where an untrusted proposal becomes a request the capability
 * Gate will see, so the questions are: which of the two target forms is this,
 * what does the trusted side take from the View, and what does it refuse. The
 * older form has to keep working with no change at all — an old release may
 * still be the active one, and a rollback puts one back.
 */

import { describe, expect, it } from "vitest";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import { resourceId } from "../sessionhub/core.js";
import { publicOperation, SessionPlusOperationBinding } from "./operation-binding.js";
import type { SessionPlusInstanceBinding, SessionPlusPrincipal } from "../app-core/instance.js";
import type { SessionResourceOperationInput } from "../session-resource/operation-executor.js";
import type { SessionOperationCoordinator } from "../sessionhub/operations.js";

const PRINCIPAL: SessionPlusPrincipal = { owner: "alice", credential: "ws:alice", session: true };

const PROJECTION = {
  workspacesByDevice: {
    laptop: {
      device: "laptop",
      workspaces: [{ id: "ws_0123456789abcdef01234567", label: "Octopus", display: "~/lht/octopus" }],
    },
  },
} as unknown as RuntimeJson;

function binding(): SessionPlusInstanceBinding {
  return {
    id: "spi_1",
    owner: "alice",
    credential: "ws:alice",
    actorKind: "user",
    actor: { kind: "user" },
    presence: "browser",
    stableAppId: "session-plus",
    packageDigest: "a".repeat(64),
    contractDigest: "b".repeat(32),
    streamId: "stream-1",
    viewRevision: 0,
    head: 0,
    projection: PROJECTION,
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  };
}

/** Records what the coordinator was asked to submit, and answers nothing else. */
function recorder(
  sharedRuntimes: ConstructorParameters<typeof SessionPlusOperationBinding>[1] = null,
): { calls: SessionResourceOperationInput[]; bind: SessionPlusOperationBinding } {
  const calls: SessionResourceOperationInput[] = [];
  const coordinator = {
    submit: async (_surface: string, _principal: unknown, input: SessionResourceOperationInput) => {
      calls.push(input);
      return {
        ok: true as const,
        operation: {
          id: "op_1",
          resourceId: "r",
          device: "laptop",
          cliKind: "claude",
          sessionId: "",
          operation: "start_session",
          status: "submitted" as const,
          submittedAt: "t",
          updatedAt: "t",
          live: true,
          message: "",
          surface: "app:session-plus",
        },
        settled: Promise.resolve({ view: {} }),
      };
    },
  } as unknown as SessionOperationCoordinator;
  return { calls, bind: new SessionPlusOperationBinding(coordinator, sharedRuntimes) };
}

const start = (params: Record<string, string>) => ({
  device: "laptop",
  source: "claude",
  prompt: "开始",
  ...params,
});

describe("binding a start proposal", () => {
  it("turns a permitted shared alias into trusted runtime coordinates and preserves caller execution", async () => {
    const trusted = binding();
    trusted.projection = {
      placement: { devices: [
        {
          device: "laptop",
          online: true,
          agentBackends: [],
          execution: { shell: true, workspaceFiles: true, codexExecServer: true },
        },
        {
          device: "agent-deadbeef",
          online: true,
          sharedAgentRuntime: true,
          agentBackends: [{ kind: "claude", available: true, splitExecution: true }],
          execution: { shell: false, workspaceFiles: false },
        },
      ] },
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [{ id: "ws_0123456789abcdef01234567", label: "Octopus", display: "~/lht/octopus" }],
        },
      },
    } as unknown as RuntimeJson;
    const { calls, bind } = recorder({
      resolveAlias: () => ({
        ok: true,
        runtime: {
          alias: "agent-deadbeef",
          holder: "alice",
          owner: "lht",
          device: "provider-box",
          resourceId: "agent-runtime:0123456789abcdef0123456789abcdef",
          balance: 500,
        },
      }),
    });
    await expect(bind.submit(trusted, PRINCIPAL, "start_session", start({
      runtime_device: "agent-deadbeef",
      workspace_id: "ws_0123456789abcdef01234567",
    }))).resolves.toMatchObject({ ok: true });
    expect(calls[0]).toMatchObject({
      runtimeDevice: "provider-box",
      borrowedRuntime: {
        owner: "lht",
        resourceId: "agent-runtime:0123456789abcdef0123456789abcdef",
      },
      target: { kind: "workspace", workspace: { device: "laptop" } },
    });

    const zero = recorder({
      resolveAlias: () => ({
        ok: false,
        status: 409,
        error: "Agent 积分余额为 0；提交开发工单后会按实际 token 消耗获得等量积分",
      }),
    });
    await expect(zero.bind.submit(trusted, PRINCIPAL, "start_session", start({
      runtime_device: "agent-deadbeef",
      workspace_id: "ws_0123456789abcdef01234567",
    }))).resolves.toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/余额为 0/) });
    expect(zero.calls).toEqual([]);
  });

  it("carries the bilingual lane through, and refuses it on a provider without one", async () => {
    const { calls, bind } = recorder();
    const plain = await bind.submit(binding(), PRINCIPAL, "start_session", start({
      directory: "~/plain",
    }));
    expect(plain.ok).toBe(true);
    expect(calls[0]).not.toHaveProperty("translatePrompt");

    const bilingual = await bind.submit(binding(), PRINCIPAL, "start_session", start({
      directory: "~/bilingual",
      translate_prompt: "true",
    }));
    expect(bilingual.ok).toBe(true);
    expect(calls[1]).toMatchObject({ source: "claude", translatePrompt: true });

    // Only Claude has the lane. A View asking for it on omp does not match this
    // trusted side, and starting plain omp instead would be answering a
    // different question than the one on the approval card.
    const wrong = await bind.submit(binding(), PRINCIPAL, "start_session", start({
      source: "omp",
      directory: "~/wrong",
      translate_prompt: "true",
    }));
    expect(wrong).toMatchObject({ ok: false, status: 400 });
    expect(calls).toHaveLength(2);
  });

  it("defaults an older View with no profile to full access for either provider", async () => {
    const { calls, bind } = recorder();
    const codex = await bind.submit(binding(), PRINCIPAL, "start_session", start({
      source: "codex",
      directory: "~/brand/new",
    }));
    expect(codex.ok).toBe(true);
    expect(calls[0]).toMatchObject({ source: "codex", permissionProfile: "full_access" });
    const claude = await bind.submit(binding(), PRINCIPAL, "start_session", start({
      directory: "~/another",
    }));
    expect(claude.ok).toBe(true);
    expect(calls[1]).toMatchObject({ source: "claude", permissionProfile: "full_access" });
  });

  it("accepts the shared profiles and rejects values outside the closed vocabulary", async () => {
    const first = recorder();
    await expect(first.bind.submit(binding(), PRINCIPAL, "start_session", start({
      source: "codex",
      directory: "~/a",
      permission_profile: "anything",
    }))).resolves.toMatchObject({ ok: false, status: 400, error: "Agent 权限档位无效" });
    const second = recorder();
    await expect(second.bind.submit(binding(), PRINCIPAL, "start_session", start({
      directory: "~/a",
      permission_profile: "manual",
    }))).resolves.toMatchObject({ ok: true });
    expect(second.calls[0]).toMatchObject({ source: "claude", permissionProfile: "manual" });
  });

  it("passes a typed directory through untouched", async () => {
    const { calls, bind } = recorder();
    const result = await bind.submit(binding(), PRINCIPAL, "start_session", start({ directory: "~/brand/new" }));
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      action: "start_session",
      instanceId: "spi_1",
      target: { kind: "directory", device: "laptop", directory: "~/brand/new" },
    });
    expect(calls[0]).not.toHaveProperty("launchMode");
  });

  it("treats a normalized empty runtime device as colocated placement", async () => {
    const { calls, bind } = recorder();
    const result = await bind.submit(binding(), PRINCIPAL, "start_session", start({
      runtime_device: "",
      directory: "~/brand/new",
    }));
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      runtimeDevice: "laptop",
      target: { kind: "directory", device: "laptop", directory: "~/brand/new" },
    });
  });

  it("still binds a registered workspace from the projection, exactly as before", async () => {
    // An older release's `app.yaml` does not declare `directory` at all, so its
    // View's proposal simply has no such key — which is why the parameter is
    // read with `?? ""` and never required.
    const { calls, bind } = recorder();
    const result = await bind.submit(binding(), PRINCIPAL, "start_session", start({
      workspace_id: "ws_0123456789abcdef01234567",
    }));
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      target: {
        kind: "workspace",
        workspace: { device: "laptop", id: "ws_0123456789abcdef01234567", label: "Octopus", display: "~/lht/octopus" },
      },
    });
  });

  it("binds split placement only when both live inventories support the exact topology", async () => {
    const trusted = binding();
    trusted.projection = {
      workspacesByDevice: {
        val15: {
          device: "val15",
          workspaces: [{
            id: "ws_89abcdef0123456701234567",
            label: "执行沙箱",
            display: "~/sandbox",
          }],
        },
      },
      placement: {
        devices: [
          {
            device: "runner1",
            online: true,
            agentBackends: [
              { kind: "claude", available: true, splitExecution: true },
              {
                kind: "codex",
                available: true,
                splitExecution: true,
              },
            ],
            execution: { shell: true, workspaceFiles: true },
          },
          {
            device: "val15",
            online: true,
            agentBackends: [],
            execution: { shell: true, workspaceFiles: true, codexExecServer: true },
          },
        ],
      },
    } as unknown as RuntimeJson;
    const accepted = recorder();
    await expect(accepted.bind.submit(trusted, PRINCIPAL, "start_session", {
      device: "val15",
      runtime_device: "runner1",
      workspace_id: "ws_89abcdef0123456701234567",
      source: "claude",
      prompt: "开始",
    })).resolves.toMatchObject({ ok: true });
    expect(accepted.calls[0]).toMatchObject({
      runtimeDevice: "runner1",
      target: { kind: "workspace", workspace: { device: "val15", label: "执行沙箱" } },
    });
    expect(accepted.calls[0]).not.toHaveProperty("launchMode");

    const codex = recorder();
    const result = await codex.bind.submit(trusted, PRINCIPAL, "start_session", {
      device: "val15",
      runtime_device: "runner1",
      workspace_id: "ws_89abcdef0123456701234567",
      source: "codex",
      prompt: "开始",
    });
    expect(result).toMatchObject({ ok: true });
    expect(codex.calls[0]).toMatchObject({
      runtimeDevice: "runner1",
      target: { kind: "workspace", workspace: { device: "val15", id: "ws_89abcdef0123456701234567" } },
    });
    expect(codex.calls[0]).not.toHaveProperty("launchMode");
  });

  it("takes the label and display from the PROJECTION, never from the proposal", async () => {
    const { calls, bind } = recorder();
    await bind.submit(binding(), PRINCIPAL, "start_session", start({
      workspace_id: "ws_0123456789abcdef01234567",
      workspace_label: "彻底不同的名字",
      workspace_display: "/etc",
    }));
    expect(calls[0]).toMatchObject({
      target: { kind: "workspace", workspace: { label: "Octopus", display: "~/lht/octopus" } },
    });
  });

  it("refuses both forms at once rather than picking a winner", async () => {
    const { calls, bind } = recorder();
    const result = await bind.submit(binding(), PRINCIPAL, "start_session", start({
      directory: "~/one",
      workspace_id: "ws_0123456789abcdef01234567",
    }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("refuses a workspace the projection does not have, and points at the other form", async () => {
    const { calls, bind } = recorder();
    const result = await bind.submit(binding(), PRINCIPAL, "start_session", start({ workspace_id: "ws_missing" }));
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toContain("目录");
    expect(calls).toHaveLength(0);
  });

  it("refuses a proposal with no device, no CLI or no instruction", async () => {
    const { calls, bind } = recorder();
    for (const params of [
      { device: "", source: "claude", prompt: "x", directory: "~/a" },
      { device: "laptop", source: "python", prompt: "x", directory: "~/a" },
      { device: "laptop", source: "claude", prompt: "   ", directory: "~/a" },
    ]) {
      expect((await bind.submit(binding(), PRINCIPAL, "start_session", params)).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("never lets the proposal name an owner, an app or an instance", async () => {
    const { calls, bind } = recorder();
    await bind.submit(binding(), PRINCIPAL, "start_session", start({
      directory: "~/a",
      owner: "bob",
      instanceId: "spi_other",
      app: "something",
      approved: "true",
    }));
    // The instance comes from the trusted binding, and nothing else crossed.
    expect(calls[0].instanceId).toBe("spi_1");
    expect(JSON.stringify(calls[0])).not.toContain("bob");
    expect(JSON.stringify(calls[0])).not.toContain("spi_other");
  });
});

/** What the trusted side minted for one of alice's sessions on `laptop`. */
const LIVE_RESOURCE = resourceId({
  owner: "alice",
  device: "laptop",
  cliKind: "codex",
  sessionId: "session-live",
});

function listing(extra: Record<string, RuntimeJson> = {}): RuntimeJson {
  return {
    sessions: [{
      resourceId: LIVE_RESOURCE,
      deviceId: "laptop",
      cliKind: "codex",
      sessionId: "session-live",
      ...extra,
    }],
  } as unknown as RuntimeJson;
}

describe("binding an explicit takeover proposal", () => {
  it("rebinds the resource on the trusted side and keeps the action explicit", async () => {
    const { calls, bind } = recorder();
    const trusted = binding();
    trusted.projection = listing();
    const result = await bind.submit(trusted, PRINCIPAL, "takeover_session", {
      resource: LIVE_RESOURCE,
      prompt: "从浏览器继续",
      device: "forged-device",
      sessionId: "forged-session",
    });
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual({
      instanceId: "spi_1",
      action: "takeover_session",
      permissionProfile: "full_access",
      prompt: "从浏览器继续",
      session: {
        resourceId: LIVE_RESOURCE,
        deviceId: "laptop",
        cliKind: "codex",
        sessionId: "session-live",
      },
    });
  });

  it("keeps a live append profile only as the race-safe managed fallback", async () => {
    const { calls, bind } = recorder();
    const trusted = binding();
    trusted.projection = listing({ runtime: { capabilities: { protocol_append: true } } });
    await expect(bind.submit(trusted, PRINCIPAL, "append_session", {
      resource: LIVE_RESOURCE,
      prompt: "继续",
      permission_profile: "full_access",
    })).resolves.toMatchObject({ ok: true });
    expect(calls[0]).toMatchObject({ permissionProfile: "full_access" });
  });

  it("binds Codex max effort and refuses a value outside that provider's ladder", async () => {
    const first = recorder();
    await expect(first.bind.submit(binding(), PRINCIPAL, "append_session", {
      resource: LIVE_RESOURCE,
      prompt: "下一轮更仔细",
      effort: "max",
    })).resolves.toMatchObject({ ok: true });
    expect(first.calls[0]).toMatchObject({ action: "append_session", effort: "max" });

    const second = recorder();
    await expect(second.bind.submit(binding(), PRINCIPAL, "append_session", {
      resource: LIVE_RESOURCE,
      prompt: "无效档位",
      effort: "ultra",
    })).resolves.toMatchObject({ ok: false, status: 400, error: "codex effort 无效" });
    expect(second.calls).toHaveLength(0);
  });

  it("binds a well-formed next-turn model and refuses malformed model syntax", async () => {
    const first = recorder();
    await expect(first.bind.submit(binding(), PRINCIPAL, "append_session", {
      resource: LIVE_RESOURCE,
      prompt: "下一轮换模型",
      model: "gpt-5.6-terra",
    })).resolves.toMatchObject({ ok: true });
    expect(first.calls[0]).toMatchObject({ action: "append_session", model: "gpt-5.6-terra" });

    const second = recorder();
    await expect(second.bind.submit(binding(), PRINCIPAL, "append_session", {
      resource: LIVE_RESOURCE,
      prompt: "非法模型",
      model: "not a model",
    })).resolves.toMatchObject({ ok: false, status: 400, error: "model 无效" });
    expect(second.calls).toHaveLength(0);
  });

  it("refuses direct control of a provider-declared parent-owned child", async () => {
    for (const action of [
      "append_session",
      "resume_session",
      "takeover_session",
      "fallback_session",
      "interrupt_session",
    ] as const) {
      const { calls, bind } = recorder();
      const trusted = binding();
      trusted.projection = listing({
        inputMode: "parent_owned",
        parentResourceId: "trusted-parent-resource",
      });
      await expect(bind.submit(trusted, PRINCIPAL, action, {
        resource: LIVE_RESOURCE,
        prompt: "继续子 Agent",
      })).resolves.toMatchObject({
        ok: false,
        status: 409,
        error: expect.stringContaining("父 Agent"),
      });
      expect(calls).toHaveLength(0);
    }
  });
});

describe("binding a write to a session the newest roster frame dropped", () => {
  // The roster is the ~200 most recently active sessions. A page open long
  // enough for that window to rotate keeps showing the conversation (absence is
  // not deletion) and can still read its transcript, so refusing every write
  // with "the list changed; refresh and pick again" named a remedy that could
  // never work.
  it("continues, takes over, falls back, interrupts and releases a session no longer listed", async () => {
    for (const action of [
      "append_session",
      "resume_session",
      "takeover_session",
      "fallback_session",
      "interrupt_session",
      "release_session_control",
    ] as const) {
      const { calls, bind } = recorder();
      const trusted = binding();
      trusted.projection = { sessions: [] } as unknown as RuntimeJson;
      const result = await bind.submit(trusted, PRINCIPAL, action, {
        resource: LIVE_RESOURCE,
        prompt: "继续这个会话",
      });
      expect(result.ok).toBe(true);
      expect(calls[0]).toMatchObject({
        action,
        session: {
          resourceId: LIVE_RESOURCE,
          deviceId: "laptop",
          cliKind: "codex",
          sessionId: "session-live",
        },
      });
    }
  });

  it("refuses an id minted for another owner even when the projection lists it", async () => {
    const { calls, bind } = recorder();
    const trusted = binding();
    const foreign = resourceId({
      owner: "bob",
      device: "laptop",
      cliKind: "codex",
      sessionId: "session-live",
    });
    trusted.projection = {
      sessions: [{ resourceId: foreign, deviceId: "laptop", cliKind: "codex", sessionId: "session-live" }],
    } as unknown as RuntimeJson;
    await expect(bind.submit(trusted, PRINCIPAL, "append_session", {
      resource: foreign,
      prompt: "继续",
    })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("refuses a resource that is not a session id at all", async () => {
    const { calls, bind } = recorder();
    for (const resource of ["", "res-live", Buffer.from("[\"alice\"]", "utf8").toString("base64url")]) {
      await expect(bind.submit(binding(), PRINCIPAL, "append_session", {
        resource,
        prompt: "继续",
      })).resolves.toMatchObject({ ok: false, status: 400 });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("projecting owner operations", () => {
  it("mints the new session resource only after a start succeeds", () => {
    const operation = {
      id: "op_start",
      owner: "alice",
      surface: "app:session-plus",
      resourceId: "launch-target",
      device: "laptop",
      cliKind: "codex",
      sessionId: "session-new",
      operation: "start_session",
      status: "succeeded",
      submittedAt: "2026-08-21T18:00:00Z",
      updatedAt: "2026-08-21T18:00:01Z",
      live: false,
      message: "已启动",
    } as const;

    expect(publicOperation(operation)).toMatchObject({
      resourceId: "launch-target",
      newResourceId: resourceId({
        owner: "alice",
        device: "laptop",
        cliKind: "codex",
        sessionId: "session-new",
      }),
    });
    expect(publicOperation({ ...operation, status: "running" })).not.toHaveProperty("newResourceId");
  });

  it("mints a new resource for a successful cross-account fallback fork", () => {
    const operation = {
      id: "op_fallback",
      owner: "alice",
      surface: "app:session-plus",
      resourceId: LIVE_RESOURCE,
      device: "laptop",
      cliKind: "codex",
      sessionId: "session-live",
      newSessionId: "session-fallback",
      operation: "fallback_session",
      status: "succeeded",
      submittedAt: "2026-08-23T06:00:00Z",
      updatedAt: "2026-08-23T06:00:01Z",
      live: false,
      message: "已切换账号",
    } as const;

    expect(publicOperation(operation).newResourceId).toBe(resourceId({
      owner: "alice",
      device: "laptop",
      cliKind: "codex",
      sessionId: "session-fallback",
    }));
    expect(publicOperation({ ...operation, status: "running" })).not.toHaveProperty("newResourceId");
  });

  it("mints the trusted replacement resource when one exact Codex TUI rebounds to another thread", () => {
    const operation = {
      id: "op_append",
      owner: "alice",
      surface: "app:session-plus",
      resourceId: LIVE_RESOURCE,
      device: "laptop",
      cliKind: "codex",
      sessionId: "session-live",
      newSessionId: "session-fork",
      operation: "append_session",
      status: "succeeded",
      submittedAt: "2026-08-29T14:00:00Z",
      updatedAt: "2026-08-29T14:00:01Z",
      live: false,
      message: "已续跑",
    } as const;

    expect(publicOperation(operation).newResourceId).toBe(resourceId({
      owner: "alice",
      device: "laptop",
      cliKind: "codex",
      sessionId: "session-fork",
    }));
    expect(publicOperation({ ...operation, status: "running" })).not.toHaveProperty("newResourceId");
  });

  it("includes hub operations so backend-triggered Agent pauses wake Session Plus", () => {
    const calls: unknown[] = [];
    const operation = {
      id: "op_hub",
      owner: "alice",
      surface: "hub",
      resourceId: "res-1",
      device: "laptop",
      cliKind: "claude",
      sessionId: "session-1",
      operation: "takeover_session",
      status: "running",
      submittedAt: "2026-08-12T04:00:00Z",
      updatedAt: "2026-08-12T04:00:01Z",
      live: true,
      message: "Claude 正在续跑",
    } as const;
    const coordinator = {
      list(owner: string, filter: unknown) {
        calls.push(["list", owner, filter]);
        return [operation];
      },
      subscribe(owner: string, _listener: unknown, surface?: string) {
        calls.push(["subscribe", owner, surface]);
        return () => {};
      },
    } as unknown as SessionOperationCoordinator;
    const projected = new SessionPlusOperationBinding(coordinator);

    expect(projected.list("alice")).toEqual([expect.objectContaining({ id: "op_hub", status: "running" })]);
    projected.subscribe("alice", () => {});
    expect(calls).toEqual([
      ["list", "alice", { limit: 100 }],
      ["subscribe", "alice", undefined],
    ]);
  });
});

it("binds only a registered Codex account on the selected runtime", async () => {
  const trusted = binding();
  trusted.projection = { placement: { devices: [{ device: "laptop", online: true,
    agentBackends: [{ kind: "codex", available: true }], codexAccounts: [{ id: "account_b", label: "codexb" }],
  }] } } as unknown as RuntimeJson;
  const { calls, bind } = recorder();
  const accepted = await bind.submit(trusted, PRINCIPAL, "start_session", start({ source: "codex", directory: "~/project", codex_account: "account_b" }));
  expect(accepted.ok).toBe(true);
  expect(calls[0]).toMatchObject({ source: "codex", codexAccount: "account_b", runtimeDevice: "laptop" });
  for (const account of ["missing", "/private/home"]) {
    expect((await bind.submit(trusted, PRINCIPAL, "start_session", start({ source: "codex", directory: "~/project", codex_account: account }))).ok).toBe(false);
  }
  expect(calls).toHaveLength(1);
});
