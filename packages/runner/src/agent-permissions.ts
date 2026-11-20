import { isAgentEffort } from "@claude-bot/agent-sessions-contract/providers";
import type { AgentProvider } from "./agent-runtime.js";
import { MACHINE_LIMITS } from "./limits.js";

/** Closed permission profiles shared by every provider-managed attachment. */
export const AGENT_PERMISSION_PROFILES = Object.freeze({
  fullAccess: "full_access",
  manual: "manual",
} as const);

export type AgentPermissionProfile =
  (typeof AGENT_PERMISSION_PROFILES)[keyof typeof AGENT_PERMISSION_PROFILES];

/**
 * Parse the device boundary. An omitted profile is full access for every
 * provider, so the owner's session behaves the same whichever entry point
 * (Sessions+, MCP, SessionHub, tickets) starts or resumes it. An explicitly
 * chosen `manual` still wins; omp refuses it at its transport because its
 * only managed channel cannot prompt.
 */
export function agentPermissionProfile(
  _provider: AgentProvider,
  value: unknown,
): AgentPermissionProfile {
  if (value === undefined || value === null || value === "") return AGENT_PERMISSION_PROFILES.fullAccess;
  if (value === AGENT_PERMISSION_PROFILES.fullAccess || value === AGENT_PERMISSION_PROFILES.manual) {
    return value;
  }
  throw new Error("Agent 权限档位无效");
}

/**
 * Closed effort vocabulary shared by launch and existing-session turns. The
 * ladder is the sessions contract's, which the Host and View also use.
 */
export function agentEffort(
  provider: AgentProvider,
  value: unknown,
  operation = "Agent",
): string {
  if (value === undefined || value === null || value === "") return "";
  const effort = String(value);
  if (!isAgentEffort(provider, effort)) throw new Error(`${operation} ${provider} effort 无效`);
  return effort;
}

/** Bounded provider model selector shared by launch and existing-session turns. */
export function agentModel(value: unknown, operation = "Agent"): string {
  if (value === undefined || value === null || value === "") return "";
  const model = String(value);
  if (
    Buffer.byteLength(model, "utf8") > MACHINE_LIMITS.modelMaxBytes
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)
  ) throw new Error(`${operation} model 无效`);
  return model;
}

/** Exact Claude Agent SDK options for the selected profile. */
export function claudePermissionOptions(profile: AgentPermissionProfile): Record<string, unknown> {
  return profile === AGENT_PERMISSION_PROFILES.fullAccess
    ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
    : { permissionMode: "default" };
}
