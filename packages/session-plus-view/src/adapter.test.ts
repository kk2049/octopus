import { describe, expect, it } from "vitest";
import { APPEARANCE_CONTRACT, type AgentViewClient, type AgentViewSnapshot } from "@claude-bot/agent-view-react";
import { createSessionsAdapter } from "./adapter.js";

describe("Session Plus sessions adapter", () => {
  it("opens a shared category entry using only its opaque share id", async () => {
    const calls: unknown[] = [];
    const client = { snapshot: () => ({ phase: "open", projection: null, operations: [] }), subscribe: () => () => {} } as unknown as AgentViewClient;
    const port = createSessionsAdapter({ client, refusal: { text: "", clear() {} }, propose: async (action, params) => { calls.push({ action, params }); return { ok: true, result: null, message: "" }; } });
    await port.openShare!("sh_example");
    expect(calls).toEqual([{ action: "open_shared_session", params: { share_id: "sh_example" } }]);
  });
  it("copies only the operation fields agent-sessions/v1 declassifies", () => {
    const source: AgentViewSnapshot = {
      phase: "open",
      projection: null,
      operations: [
        {
          id: "op-1",
          status: "running",
          operation: "append_session",
          message: "运行中",
          resourceId: "res-1",
          newResourceId: "res-new",
          owner: "must-not-cross",
          grant: "must-not-cross",
        },
      ],
      inFlight: 0,
      // Required after ticket #45 (appearance is not optional on the
      // snapshot). This adapter does not consume it — the sessions port has
      // no appearance concept — but the type demands a value here.
      appearance: { contract: APPEARANCE_CONTRACT, theme: "classic" },
      // Browser recovery belongs to the App composition, not this port.
      recovery: null,
      // Same shape of requirement for the wake tokens (ADR 0006).
      wakes: {},
      // And for the action-lifecycle ledger — this adapter never reads it.
      proposals: [],
    };
    const client = {
      snapshot: () => source,
      subscribe: () => () => {},
    } as unknown as AgentViewClient;
    const port = createSessionsAdapter({
      client,
      propose: async () => ({ ok: true, result: null, message: "" }),
      refusal: { text: "", clear() {} },
    });

    expect(port.snapshot().operations).toEqual([
      {
        id: "op-1",
        status: "running",
        operation: "append_session",
        message: "运行中",
        resourceId: "res-1",
        newResourceId: "res-new",
      },
    ]);
    expect(port.snapshot().operations[0]).not.toHaveProperty("owner");
    expect(port.snapshot().operations[0]).not.toHaveProperty("grant");
  });

  it.each([
    { state: "reconnecting", since: "2026-09-25T03:00:00Z", retry_at: null },
    { state: "waiting_resource", since: "2026-09-25T03:00:00Z", retry_at: "2026-09-25T03:01:00Z" },
  ])("copies only declared recovery fields for $state", (recovery) => {
    const client = {
      snapshot: () => ({ phase: "open", projection: null, operations: [
        { id: "op-1", recovery: { ...recovery, owner: "must-not-cross", debug: { secret: true } } },
      ] }),
      subscribe: () => () => {},
    } as unknown as AgentViewClient;
    const port = createSessionsAdapter({ client, refusal: { text: "", clear() {} },
      propose: async () => ({ ok: true, result: null, message: "" }) });
    expect(port.snapshot().operations).toEqual([{ id: "op-1", recovery }]);
  });

  it.each([
    "reconnecting",
    null,
    { state: "unknown", since: "now", retry_at: null },
    { state: "reconnecting", since: 1, retry_at: null },
    { state: "reconnecting", since: "now" },
    { state: "reconnecting", since: "now", retry_at: false },
  ])("drops malformed operation recovery %j", (recovery) => {
    const client = {
      snapshot: () => ({ phase: "open", projection: null, operations: [{ id: "op-1", recovery }] }),
      subscribe: () => () => {},
    } as unknown as AgentViewClient;
    const port = createSessionsAdapter({ client, refusal: { text: "", clear() {} },
      propose: async () => ({ ok: true, result: null, message: "" }) });
    expect(port.snapshot().operations).toEqual([{ id: "op-1" }]);
  });

  it("forwards the shared permission profile when starting Claude", async () => {
    const calls: Array<{ action: string; params: Record<string, string> | undefined }> = [];
    const client = {
      snapshot: () => ({ phase: "open", projection: null, operations: [] }),
      subscribe: () => () => {},
    } as unknown as AgentViewClient;
    const port = createSessionsAdapter({
      client,
      propose: async (action, params) => {
        calls.push({ action, params });
        return { ok: true, result: null, message: "" };
      },
      refusal: { text: "", clear() {} },
    });

    await port.start({
      device: "laptop",
      directory: "~/project",
      source: "claude",
      model: "",
      effort: "high",
      permissionProfile: "manual",
      prompt: "continue",
    });
    expect(calls).toEqual([{
      action: "start_session",
      params: expect.objectContaining({ source: "claude", permission_profile: "manual" }),
    }]);
  });

  it("forwards model and effort only as named existing-session parameters", async () => {
    const calls: Array<{ action: string; params: Record<string, string> | undefined }> = [];
    const client = {
      snapshot: () => ({ phase: "open", projection: null, operations: [] }),
      subscribe: () => () => {},
    } as unknown as AgentViewClient;
    const port = createSessionsAdapter({
      client,
      propose: async (action, params) => {
        calls.push({ action, params });
        return { ok: true, result: null, message: "" };
      },
      refusal: { text: "", clear() {} },
    });

    await port.resume("opaque-session", "继续", "full_access", "max", "gpt-5.6-terra");
    expect(calls).toEqual([{
      action: "resume_session",
      params: {
        resource: "opaque-session",
        prompt: "继续",
        permission_profile: "full_access",
        effort: "max",
        model: "gpt-5.6-terra",
      },
    }]);
  });

  it("names the bilingual Claude lane only when it was chosen", async () => {
    const calls: Array<{ action: string; params: Record<string, string> | undefined }> = [];
    const client = {
      snapshot: () => ({ phase: "open", projection: null, operations: [] }),
      subscribe: () => () => {},
    } as unknown as AgentViewClient;
    const port = createSessionsAdapter({
      client,
      propose: async (action, params) => {
        calls.push({ action, params });
        return { ok: true, result: null, message: "" };
      },
      refusal: { text: "", clear() {} },
    });
    const request = {
      device: "laptop",
      directory: "~/project",
      source: "claude",
      model: "",
      effort: "high",
      prompt: "检查构建",
    };

    await port.start(request);
    // The plain lane says nothing, so a trusted side that predates the flag
    // reads exactly what it read before.
    expect(calls[0]?.params).not.toHaveProperty("translate_prompt");

    await port.start({ ...request, translatePrompt: true });
    expect(calls[1]?.params).toMatchObject({ source: "claude", translate_prompt: "true" });
  });
});
