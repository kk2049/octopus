import { describe, expect, it, vi } from "vitest";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import { resourceId } from "../sessionhub/core.js";
import type { SessionHubService } from "../sessionhub/service.js";
import type { SessionPlusInstanceBinding, SessionPlusPrincipal } from "../app-core/instance.js";
import { SessionPlusInteractionBinding } from "./interaction-binding.js";

/** The id the trusted side mints for a session, which is what a View gets back. */
const RESOURCE = resourceId({
  owner: "alice",
  device: "trusted-laptop",
  cliKind: "claude",
  sessionId: "trusted-session",
});
const INTERACTION = "ai_current";
const principal: SessionPlusPrincipal = { owner: "alice", credential: "ws:one", session: true };

function instance(): SessionPlusInstanceBinding {
  return {
    id: "instance-1",
    owner: "alice",
    credential: "ws:one",
    actorKind: "user",
    actor: { kind: "user" },
    presence: "browser",
    stableAppId: "session-plus",
    packageDigest: "package",
    contractDigest: "contract",
    streamId: "stream",
    viewRevision: 0,
    head: 7,
    projection: {
      sessions: [{
        resourceId: RESOURCE,
        deviceId: "trusted-laptop",
        cliKind: "claude",
        sessionId: "trusted-session",
      }],
      transcript: {
        [RESOURCE]: {
          messages: [],
          runtime: {
            process_state: "alive",
            turn_state: "needs_input",
            capabilities: { respond: true },
            interaction: {
              id: INTERACTION,
              provider: "claude",
              kind: "question",
              title: "Claude Code 需要你的回答",
              questions: [{
                id: "acceptance",
                header: "验收结果",
                prompt: "网页提问闭环是否通过？",
                options: [{ label: "通过" }, { label: "不通过" }],
                multiple: false,
                allow_other: false,
                secret: false,
              }],
              capabilities: { respond: true, allow: true, deny: true },
            },
          },
        },
      },
    },
    createdAt: 1,
    expiresAt: 2,
  };
}

function answer(label = "通过"): string {
  return JSON.stringify({ decision: "allow", answers: { acceptance: [label] } });
}

describe("SessionPlusInteractionBinding", () => {
  it("answers the newer transcript request even when the roster still carries an old receipt", async () => {
    const respondInteraction = vi.fn(async () => ({ ok: true as const, data: { ok: true } }));
    const value = instance();
    const projection = value.projection as unknown as {
      sessions: Array<{ runtime?: RuntimeJson }>;
      transcript: Record<string, { runtime: Record<string, RuntimeJson> }>;
    };
    projection.transcript[RESOURCE].runtime.observed_at = "2026-09-16T12:46:28Z";
    projection.sessions[0].runtime = {
      observed_at: "2026-09-16T12:46:20Z",
      interaction: { id: "ai_previous", provider: "claude", status: "resolved", capabilities: { respond: false } },
    };
    const binding = new SessionPlusInteractionBinding({ respondInteraction } as unknown as Pick<SessionHubService, "respondInteraction">);
    const result = await binding.submit(value, principal, { resource: RESOURCE, interaction_id: INTERACTION, response_json: answer() });
    expect(result.ok).toBe(true);
    expect(respondInteraction).toHaveBeenCalledOnce();
    expect(result.ok && JSON.stringify(result.projection)).not.toContain(`"id":"${INTERACTION}"`);
  });

  it("does not revive an older transcript request when the newer roster has cleared it", async () => {
    const respondInteraction = vi.fn();
    const value = instance();
    const projection = value.projection as unknown as {
      sessions: Array<{ runtime?: RuntimeJson }>;
      transcript: Record<string, { runtime: Record<string, RuntimeJson> }>;
    };
    projection.transcript[RESOURCE].runtime.observed_at = "2026-09-16T12:46:20Z";
    projection.sessions[0].runtime = { observed_at: "2026-09-16T12:46:28Z" };
    const binding = new SessionPlusInteractionBinding({ respondInteraction } as unknown as Pick<SessionHubService, "respondInteraction">);
    expect(await binding.submit(value, principal, { resource: RESOURCE, interaction_id: INTERACTION, response_json: answer() })).toMatchObject({ ok: false });
    expect(respondInteraction).not.toHaveBeenCalled();
  });

  it("rebinds the target from the trusted projection and clears the single-use card", async () => {
    const respondInteraction = vi.fn(async () => ({
      ok: true as const,
      data: { ok: true, interaction_id: INTERACTION, decision: "allow" },
    }));
    const binding = new SessionPlusInteractionBinding({ respondInteraction } as unknown as Pick<
      SessionHubService,
      "respondInteraction"
    >);
    const result = await binding.submit(instance(), principal, {
      resource: RESOURCE,
      interaction_id: INTERACTION,
      response_json: answer(),
      device: "forged-device",
      provider: "codex",
      session_id: "forged-session",
      owner: "mallory",
    });
    expect(result.ok).toBe(true);
    expect(respondInteraction).toHaveBeenCalledWith({
      username: "alice",
      admin: false,
      session: true,
      credential: "ws:one",
    }, {
      owner: "alice",
      device: "trusted-laptop",
      provider: "claude",
      sessionId: "trusted-session",
      interactionId: INTERACTION,
      responseJson: answer(),
    });
    expect(result.ok && JSON.stringify(result.projection)).not.toContain(`"id":"${INTERACTION}"`);
    expect(result.ok && result.projection).toMatchObject({
      transcript: { [RESOURCE]: { runtime: { process_state: "alive", turn_state: "needs_input" } } },
    });
  });

  it("refuses stale ids, agent principals and invalid answers before touching the Hub", async () => {
    const respondInteraction = vi.fn();
    const binding = new SessionPlusInteractionBinding({ respondInteraction } as unknown as Pick<
      SessionHubService,
      "respondInteraction"
    >);
    expect(await binding.submit(instance(), principal, {
      resource: RESOURCE,
      interaction_id: "ai_stale",
      response_json: answer(),
    })).toMatchObject({ ok: false, error: expect.stringMatching(/结束|刷新/) });
    expect(await binding.submit(instance(), {
      owner: "alice",
      credential: "agent:turn",
      session: false,
      actor: { kind: "agent", app: "session-plus", agent: "keeper", turnId: "turn" },
    }, {
      resource: RESOURCE,
      interaction_id: INTERACTION,
      response_json: answer(),
    })).toMatchObject({ ok: false, error: expect.stringMatching(/网页/) });
    expect(await binding.submit(instance(), principal, {
      resource: RESOURCE,
      interaction_id: INTERACTION,
      response_json: JSON.stringify({ decision: "allow", answers: {} }),
    })).toMatchObject({ ok: false, error: expect.stringMatching(/回答/) });
    expect(respondInteraction).not.toHaveBeenCalled();
  });

  it("passes a denial without requiring question answers", async () => {
    const respondInteraction = vi.fn(async () => ({ ok: true as const, data: { ok: true } }));
    const binding = new SessionPlusInteractionBinding({ respondInteraction } as unknown as Pick<
      SessionHubService,
      "respondInteraction"
    >);
    const responseJson = JSON.stringify({ decision: "deny", answers: {}, message: "这次不继续" });
    const result = await binding.submit(instance(), principal, {
      resource: RESOURCE,
      interaction_id: INTERACTION,
      response_json: responseJson,
    });
    expect(result.ok).toBe(true);
    expect(respondInteraction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ responseJson }));
  });

  it("answers a question on a session the newest roster frame no longer lists", async () => {
    // The roster is a truncated recency window. A page that has been open for a
    // while keeps showing the session and its question from the transcript it
    // already read, so losing the row must not make the card unanswerable —
    // the target comes from the resource id, and the device still decides
    // whether that interaction is pending.
    const respondInteraction = vi.fn(async () => ({ ok: true as const, data: { ok: true } }));
    const value = instance();
    (value.projection as unknown as { sessions: unknown[] }).sessions = [];
    const binding = new SessionPlusInteractionBinding({ respondInteraction } as unknown as Pick<
      SessionHubService,
      "respondInteraction"
    >);

    const result = await binding.submit(value, principal, {
      resource: RESOURCE,
      interaction_id: INTERACTION,
      response_json: answer(),
    });

    expect(result.ok).toBe(true);
    expect(respondInteraction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      device: "trusted-laptop",
      provider: "claude",
      sessionId: "trusted-session",
    }));
  });

  it("refuses a resource id minted for somebody else, before any Hub call", async () => {
    const respondInteraction = vi.fn();
    const binding = new SessionPlusInteractionBinding({ respondInteraction } as unknown as Pick<
      SessionHubService,
      "respondInteraction"
    >);
    const foreign = resourceId({
      owner: "mallory",
      device: "trusted-laptop",
      cliKind: "claude",
      sessionId: "trusted-session",
    });
    const value = instance();
    const projection = value.projection as unknown as {
      sessions: Array<{ resourceId: string }>;
      transcript: Record<string, unknown>;
    };
    // Even a projection that names the foreign id — the shape a compromised
    // provider could produce — does not make it answerable.
    projection.sessions[0].resourceId = foreign;
    projection.transcript[foreign] = projection.transcript[RESOURCE];

    expect(await binding.submit(value, principal, {
      resource: foreign,
      interaction_id: INTERACTION,
      response_json: answer(),
    })).toMatchObject({ ok: false, error: expect.stringMatching(/账户/) });
    expect(await binding.submit(value, principal, {
      resource: "not-a-resource-id",
      interaction_id: INTERACTION,
      response_json: answer(),
    })).toMatchObject({ ok: false });
    expect(respondInteraction).not.toHaveBeenCalled();
  });

  it("answers and clears an interaction projected by the roster before transcript refresh", async () => {
    const respondInteraction = vi.fn(async () => ({ ok: true as const, data: { ok: true } }));
    const value = instance();
    const projection = value.projection as unknown as {
      sessions: Array<{ runtime?: RuntimeJson }>;
      transcript: Record<string, { runtime?: RuntimeJson }>;
    };
    projection.sessions[0].runtime = projection.transcript[RESOURCE].runtime;
    delete projection.transcript[RESOURCE].runtime;
    const binding = new SessionPlusInteractionBinding({ respondInteraction } as unknown as Pick<
      SessionHubService,
      "respondInteraction"
    >);

    const result = await binding.submit(value, principal, {
      resource: RESOURCE,
      interaction_id: INTERACTION,
      response_json: answer(),
    });

    expect(result.ok).toBe(true);
    expect(respondInteraction).toHaveBeenCalledOnce();
    expect(result.ok && JSON.stringify(result.projection)).not.toContain(`"id":"${INTERACTION}"`);
  });
});
