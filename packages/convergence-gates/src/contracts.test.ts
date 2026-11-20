import { describe, expect, it } from "vitest";

import {
  AGENT_SESSION_ENDPOINT_DECLARATION,
  APP_AGENT_ACTOR_DECLARATION,
  APP_REGISTRY_ADMIN_DECLARATION,
  CONVERGENCE_DECLARATIONS,
  SESSION_HARNESS_LAUNCH_DECLARATION,
  contractCoordinateProblems,
} from "./contracts.js";

describe("convergence contracts", () => {
  it("are all wire serviceable and provider-coordinate free", () => {
    for (const declaration of CONVERGENCE_DECLARATIONS) {
      expect(Object.values(declaration.wireProblems).flat()).toEqual([]);
      expect(contractCoordinateProblems(declaration)).toEqual([]);
    }
  });

  it("keeps the endpoint and actor verbs closed", () => {
    expect(AGENT_SESSION_ENDPOINT_DECLARATION.actionIds).toEqual([
      "list", "read", "start", "send", "stop", "respond", "health",
    ]);
    expect(APP_AGENT_ACTOR_DECLARATION.actionIds).toEqual([
      "claim_turn", "read_turn", "propose_action", "finish_turn", "health",
    ]);
  });

  it("lets launch express only a trusted-shell intent", () => {
    expect(SESSION_HARNESS_LAUNCH_DECLARATION.actionIds).toEqual(["open_session"]);
    expect(Object.keys(SESSION_HARNESS_LAUNCH_DECLARATION.byAction.open_session.params)).toEqual(["rid", "session_ref"]);
  });

  it("has digest-only registry administration and no destructive delete", () => {
    expect(APP_REGISTRY_ADMIN_DECLARATION.actionIds).toEqual([
      "list", "describe", "declare", "install", "activate", "deactivate", "uninstall", "rollback", "approve_hotswap",
    ]);
    expect(JSON.stringify(APP_REGISTRY_ADMIN_DECLARATION)).not.toMatch(/artifactBytes|contentRoot|delete/i);
  });
});
