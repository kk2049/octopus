/**
 * Deployment policy for the Feishu gateway.
 *
 * A connected Octopus user gets the reviewed, user-OAuth catalog by default:
 * reads are silent and writes still require one owner approval per exact call.
 * That is the product contract requested by #98 — binding a Feishu-backed user
 * and then hiding all of their own Feishu functions behind an absent YAML block
 * was a non-working default.
 *
 * Administrative and tenant-identity operations are a different plane. They
 * can only be named under `privileged_users.<username>`, are never inherited
 * from `chat_agent`, and are never auto-allowed (including reads).
 */

import {
  FEISHU_PRIVILEGED_OPERATIONS,
  FEISHU_PRIVILEGED_OPS,
  FEISHU_SYSTEM_OPERATIONS,
  FEISHU_USER_OPERATIONS,
  FEISHU_USER_OPS,
  FEISHU_USER_READ_OPS,
} from "./catalog.js";

export interface FeishuAgentGrantConfig {
  /** Catalogued ordinary user operations. Absent means none inside an explicit override. */
  operations?: string[];
  /** Read operations that need no per-call approval. */
  auto_allow?: string[];
}

export interface FeishuPrivilegedGrantConfig {
  /** Explicit privileged operations. There is deliberately no auto_allow. */
  operations?: string[];
}

export interface FeishuGatewayYamlConfig {
  /** Optional narrowing/replacement of the platform default for chat agents. */
  chat_agent?: FeishuAgentGrantConfig;
  /** Per-user ordinary override; an entry replaces `chat_agent`. */
  users?: Record<string, FeishuAgentGrantConfig>;
  /** Per-user privileged grant. No wildcard/default form exists. */
  privileged_users?: Record<string, FeishuPrivilegedGrantConfig>;
}

export class FeishuGrantConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuGrantConfigError";
  }
}

export interface ResolvedAgentGrant {
  operations: readonly string[];
  autoAllow: readonly string[];
}

/** Explicit empty override, retained as a useful stable value. */
export const NO_FEISHU_RIGHTS: ResolvedAgentGrant = Object.freeze({
  operations: Object.freeze([]) as readonly string[],
  autoAllow: Object.freeze([]) as readonly string[],
});

/** Safe platform default: own-user catalog, with only read effects silent. */
export const DEFAULT_FEISHU_RIGHTS: ResolvedAgentGrant = Object.freeze({
  operations: Object.freeze([...FEISHU_USER_OPS]),
  autoAllow: Object.freeze([...FEISHU_USER_READ_OPS]),
});

function checkOrdinary(where: string, grant: FeishuAgentGrantConfig): void {
  const operations = grant.operations ?? [];
  for (const operation of operations) {
    if (FEISHU_USER_OPERATIONS[operation]) continue;
    if (FEISHU_PRIVILEGED_OPERATIONS[operation]) {
      throw new FeishuGrantConfigError(
        `${where} names privileged operation "${operation}"; put it under feishu_gateway.privileged_users.<username>.operations`,
      );
    }
    if (FEISHU_SYSTEM_OPERATIONS[operation]) {
      throw new FeishuGrantConfigError(
        `${where} names "${operation}", which is a SYSTEM Feishu operation reserved for the trusted control plane`,
      );
    }
    throw new FeishuGrantConfigError(
      `${where} names unknown Feishu operation "${operation}" (ordinary: ${FEISHU_USER_OPS.join(", ")})`,
    );
  }
  for (const operation of grant.auto_allow ?? []) {
    if (!operations.includes(operation)) {
      throw new FeishuGrantConfigError(
        `${where}.auto_allow names "${operation}", which is not in that grant's operations`,
      );
    }
    if (!FEISHU_USER_READ_OPS.includes(operation)) {
      throw new FeishuGrantConfigError(
        `${where}.auto_allow names "${operation}", which writes, deletes or sends and must be approved by the owner`,
      );
    }
  }
}

function checkPrivileged(where: string, grant: FeishuPrivilegedGrantConfig): void {
  for (const operation of grant.operations ?? []) {
    if (FEISHU_PRIVILEGED_OPERATIONS[operation]) continue;
    throw new FeishuGrantConfigError(
      `${where} names "${operation}", which is not a privileged Feishu operation (known: ${FEISHU_PRIVILEGED_OPS.join(", ")})`,
    );
  }
}

export function validateFeishuGatewayConfig(cfg: FeishuGatewayYamlConfig | undefined): void {
  if (!cfg) return;
  if (cfg.chat_agent) checkOrdinary("feishu_gateway.chat_agent", cfg.chat_agent);
  for (const [user, grant] of Object.entries(cfg.users ?? {})) {
    checkOrdinary(`feishu_gateway.users.${user}`, grant);
  }
  for (const [user, grant] of Object.entries(cfg.privileged_users ?? {})) {
    if (!user.trim()) throw new FeishuGrantConfigError("feishu_gateway.privileged_users contains a blank username");
    checkPrivileged(`feishu_gateway.privileged_users.${user}`, grant);
  }
}

export function resolveChatAgentGrant(
  cfg: FeishuGatewayYamlConfig | undefined,
  username: string,
): ResolvedAgentGrant {
  const raw = cfg?.users?.[username] ?? cfg?.chat_agent;
  if (!raw) return DEFAULT_FEISHU_RIGHTS;
  const operations = (raw.operations ?? []).filter((operation) => Boolean(FEISHU_USER_OPERATIONS[operation]));
  const autoAllow = (raw.auto_allow ?? []).filter(
    (operation) => operations.includes(operation) && FEISHU_USER_READ_OPS.includes(operation),
  );
  return { operations, autoAllow };
}

export function resolvePrivilegedAgentGrant(
  cfg: FeishuGatewayYamlConfig | undefined,
  username: string,
): readonly string[] {
  return (cfg?.privileged_users?.[username]?.operations ?? []).filter(
    (operation) => Boolean(FEISHU_PRIVILEGED_OPERATIONS[operation]),
  );
}
