import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_CLI_KINDS } from "@claude-bot/agent-sessions-contract";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { AGENT_INTERACTION_OPERATIONS, AgentInteractionCapabilities, RESPOND_AGENT_INTERACTION } from "./capability.js";

describe("AgentInteractionCapabilities", () => {
  let service: CapabilityService;
  const frames: Array<{ owner: string; method: string; args: Record<string, unknown> }> = [];

  beforeEach(() => {
    frames.length = 0;
    service = new CapabilityService();
  });
  afterEach(() => service.close());
  it('restricts a delegated project response to exactly one device, provider and session', async () => {
    const capabilities = new AgentInteractionCapabilities({service, userExists: () => true, hasDevice: () => true,
      transport: {dispatch: async (owner, method, args) => {frames.push({owner, method, args}); return {ok: true};}, listDevices: () => [], isOnline: () => true, ping: async () => 1, disconnect: () => false,
        openDshTunnel: async () => {throw new Error('unexpected');}}});
    const grant = capabilities.openProjectHumanResponse('alice', 'bob', 'project-one', 'laptop', 'codex', 'session-one')!;
    const params = {device: 'laptop', provider: 'codex', session_id: 'session-one', interaction_id: 'ai_1', response_json: '{"decision":"allow"}'};
    expect(await grant.request(RESPOND_AGENT_INTERACTION, {...params, session_id: 'session-two'})).toMatchObject({status: 'denied'});
    expect(await grant.request(RESPOND_AGENT_INTERACTION, {...params, device: 'other'})).toMatchObject({status: 'denied'});
    expect(frames).toHaveLength(0);
    expect(await grant.request(RESPOND_AGENT_INTERACTION, params)).toMatchObject({status: 'succeeded'});
    expect(frames).toHaveLength(1); expect(frames[0].owner).toBe('alice'); grant.close();
  });

  it("lets only the trusted human-response context dispatch within its bound owner", async () => {
    const capabilities = new AgentInteractionCapabilities({
      service,
      transport: {
        dispatch: async (owner, method, args) => {
          frames.push({ owner, method, args });
          return { ok: true };
        },
        listDevices: () => [],
        isOnline: () => true,
        ping: async () => 1,
        disconnect: () => false,
        openDshTunnel: async () => { throw new Error("unexpected DSH tunnel"); },
      },
      userExists: (owner) => owner === "alice",
      hasDevice: (owner) => owner === "alice",
    });
    const grant = capabilities.openHumanResponse("alice", "answer provider prompt")!;
    const out = await grant.request(RESPOND_AGENT_INTERACTION, {
      device: "laptop",
      provider: "codex",
      session_id: "thread-1",
      interaction_id: "ai_1",
      response_json: JSON.stringify({ decision: "allow" }),
    });
    expect(out).toMatchObject({ status: "succeeded" });
    expect(frames).toEqual([expect.objectContaining({ owner: "alice", method: RESPOND_AGENT_INTERACTION })]);
    grant.close();
    expect(capabilities.openHumanResponse("bob", "x")).toBeNull();
  });

  it("accepts an answer for every CLI kind, including omp", async () => {
    const capabilities = new AgentInteractionCapabilities({
      service,
      transport: {
        dispatch: async (owner, method, args) => {
          frames.push({ owner, method, args });
          return { ok: true };
        },
        listDevices: () => [],
        isOnline: () => true,
        ping: async () => 1,
        disconnect: () => false,
        openDshTunnel: async () => { throw new Error("unexpected DSH tunnel"); },
      },
      userExists: () => true,
      hasDevice: () => true,
    });
    const grant = capabilities.openHumanResponse("alice", "answer omp prompt")!;
    // omp raises extension_ui_request dialogs through the same broker; a
    // two-value provider enum here silently strands that session mid-launch.
    const out = await grant.request(RESPOND_AGENT_INTERACTION, {
      device: "laptop",
      provider: "omp",
      session_id: "01a00ed4-db09-7000-b549-ac372c282cfa",
      interaction_id: "ai_2",
      response_json: JSON.stringify({ decision: "allow" }),
    });
    expect(out).toMatchObject({ status: "succeeded" });
    expect(frames).toEqual([expect.objectContaining({ args: expect.objectContaining({ provider: "omp" }) })]);
    grant.close();
  });

  it("takes its provider vocabulary from the one enumerated list", () => {
    // Two of this ticket's startup failures were a hand-copied provider enum
    // drifting behind the CLI kinds the runner already drives.
    const provider = AGENT_INTERACTION_OPERATIONS[RESPOND_AGENT_INTERACTION].args.provider as {
      enum?: readonly string[];
    };
    expect(provider.enum).toEqual([...SESSION_CLI_KINDS]);
  });
});
