/** Codex protocol/CLI mapping for the shared Agent permission profiles. */

import {
  AGENT_PERMISSION_PROFILES,
  agentPermissionProfile,
  type AgentPermissionProfile,
} from "./agent-permissions.js";

export const CODEX_PERMISSION_PROFILES = AGENT_PERMISSION_PROFILES;
export type CodexPermissionProfile = AgentPermissionProfile;

export function codexPermissionProfile(value: unknown): CodexPermissionProfile {
  return agentPermissionProfile("codex", value);
}

export function codexThreadPermissionParams(profile: CodexPermissionProfile): Record<string, unknown> {
  return profile === CODEX_PERMISSION_PROFILES.fullAccess
    ? {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      }
    : {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "read-only",
      };
}

export function codexTurnPermissionParams(profile: CodexPermissionProfile): Record<string, unknown> {
  return profile === CODEX_PERMISSION_PROFILES.fullAccess
    ? {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      }
    : {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
}

/** Exact argv overrides for compatibility `codex exec` paths. */
export function codexExecPermissionArgs(profile: CodexPermissionProfile): string[] {
  return profile === CODEX_PERMISSION_PROFILES.fullAccess
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : [
        "--strict-config",
        "--config",
        "approval_policy=\"untrusted\"",
        "--config",
        "sandbox_mode=\"read-only\"",
      ];
}
