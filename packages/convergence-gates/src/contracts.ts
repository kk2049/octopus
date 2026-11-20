/**
 * Migration-enabling contracts for the convergence gates.
 *
 * These are intentionally provider neutral.  In particular they contain no
 * username, owner, device, path, origin, URL, credential, grant or Context.
 * A trusted adapter binds those facts before it hands one of these ports to a
 * consumer.  Landing the declarations does not select a provider or route any
 * traffic.
 */
import { declareContract, refusalVocabulary } from "@claude-bot/typed-port-kit";

export const CONVERGENCE_CONTRACT_LIMITS = Object.freeze({
  opaqueRef: 200,
  requestId: 96,
  revision: 2_147_483_647,
  query: 240,
  text: 16_384,
  json: 393_216,
  message: 240,
});

const REF = Object.freeze({
  type: "string" as const,
  description: "由可信侧铸造并绑定到当前 scope 的不透明引用；不是用户名、路径、设备或 URL。",
  maxLength: CONVERGENCE_CONTRACT_LIMITS.opaqueRef,
  pattern: /^[A-Za-z][A-Za-z0-9_.:-]{7,199}$/,
});

const RID = Object.freeze({
  type: "string" as const,
  description: "调用方生成的有界 request id，用于关联和幂等；不携带身份。",
  maxLength: CONVERGENCE_CONTRACT_LIMITS.requestId,
  pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/,
});

const REVISION = Object.freeze({
  type: "integer" as const,
  description: "调用方已经观察到的单调 revision。",
  minimum: 0,
  maximum: CONVERGENCE_CONTRACT_LIMITS.revision,
});

const JSON_VALUE = Object.freeze({
  type: "json" as const,
  description: "由本契约自己的 reader 复核的有界结构化值。",
  maxLength: CONVERGENCE_CONTRACT_LIMITS.json,
  schema: Object.freeze({ type: "object", additionalProperties: true }),
});

const COMMON_REFUSALS = [
  "unavailable",
  "offline",
  "unknown_outcome",
  "refused",
  "approval_required",
  "bad_ref",
  "stale_revision",
  "too_large",
  "invalid_request",
  "scope_closed",
] as const;

export const AGENT_SESSION_ENDPOINT_CONTRACT = "agent-session-endpoint/v1";
export const AGENT_SESSION_ENDPOINT_REFUSALS = refusalVocabulary(COMMON_REFUSALS, {
  fallback: "unavailable",
  maxMessageLength: CONVERGENCE_CONTRACT_LIMITS.message,
});

export const AGENT_SESSION_ENDPOINT_DECLARATION = declareContract({
  contract: AGENT_SESSION_ENDPOINT_CONTRACT,
  summary: "Head 面向任意会话 provider 的有界端点；provider 与身份由可信闭包绑定，写操作永不自动 fallback。",
  refusals: AGENT_SESSION_ENDPOINT_REFUSALS,
  actions: {
    list: {
      summary: "列出当前绑定端点的有界会话窗口",
      operation: "list_sessions",
      params: { rid: RID, cursor: { ...REF, optional: true }, limit: { type: "integer", description: "最多返回多少项。", minimum: 1, maximum: 100 } },
    },
    read: {
      summary: "读取一个会话的有界投影窗口",
      operation: "read_session",
      params: { rid: RID, session_ref: REF, after_revision: REVISION, limit: { type: "integer", description: "最多返回多少个投影事件。", minimum: 1, maximum: 500 } },
    },
    start: {
      summary: "在当前绑定 provider 新建会话；accepted 后未知结局不得自动换 provider",
      operation: "start_session",
      params: { rid: RID, op_id: RID, input: JSON_VALUE },
    },
    send: {
      summary: "给现有会话发送一次有界输入；写操作单路由且不自动重试",
      operation: "append_session",
      params: { rid: RID, op_id: RID, session_ref: REF, text: { type: "string", description: "提交给会话的文本。", maxLength: CONVERGENCE_CONTRACT_LIMITS.text }, expected_revision: REVISION },
    },
    stop: {
      summary: "请求停止一个会话；未知结局不得被报告为已停止",
      operation: "stop_session",
      params: { rid: RID, op_id: RID, session_ref: REF, expected_revision: REVISION },
    },
    respond: {
      summary: "回答会话中的一次交互请求",
      operation: "respond_session",
      params: { rid: RID, op_id: RID, session_ref: REF, interaction_ref: REF, response: JSON_VALUE },
    },
    health: {
      summary: "读取当前绑定端点的健康与 generation，不触发会话执行",
      operation: "read_session_health",
      params: { rid: RID },
    },
  },
});

export const SESSION_HARNESS_LAUNCH_CONTRACT = "session-harness-launch/v1";
export const SESSION_HARNESS_LAUNCH_REFUSALS = refusalVocabulary(
  ["unavailable", "offline", "refused", "bad_ref", "invalid_request", "scope_closed"],
  { fallback: "unavailable", maxMessageLength: CONVERGENCE_CONTRACT_LIMITS.message },
);

export const SESSION_HARNESS_LAUNCH_DECLARATION = declareContract({
  contract: SESSION_HARNESS_LAUNCH_CONTRACT,
  summary: "请求可信外壳打开一个会话引用；View 永远看不到 raw origin、URL、cookie 或 token。",
  refusals: SESSION_HARNESS_LAUNCH_REFUSALS,
  actions: {
    open_session: {
      summary: "让可信外壳按登录态和 endpoint directory 解析并打开会话",
      operation: "launch_session_harness",
      params: { rid: RID, session_ref: REF },
    },
  },
});

export const APP_AGENT_ACTOR_CONTRACT = "app-agent-actor/v1";
export const APP_AGENT_ACTOR_REFUSALS = refusalVocabulary(COMMON_REFUSALS, {
  fallback: "unavailable",
  maxMessageLength: CONVERGENCE_CONTRACT_LIMITS.message,
});

export const APP_AGENT_ACTOR_DECLARATION = declareContract({
  contract: APP_AGENT_ACTOR_CONTRACT,
  summary: "把一个 release-bound App agent turn 租给当前绑定端点；共享 fold、Gate 和 action 署名仍在 Octopus。",
  refusals: APP_AGENT_ACTOR_REFUSALS,
  actions: {
    claim_turn: {
      summary: "领取一个已绑定 release、actor、预算和 inbox cursor 的 turn",
      operation: "claim_app_agent_turn",
      params: { rid: RID, turn_ref: REF, expected_revision: REVISION },
    },
    read_turn: {
      summary: "读取 turn 的有界 inbox、viewer-safe projection、动作 schema 和剩余预算",
      operation: "read_app_agent_turn",
      params: { rid: RID, turn_ref: REF, after_revision: REVISION },
    },
    propose_action: {
      summary: "通过 bound turn 向 Octopus 提出一个声明动作；每次仍重进 Gate",
      operation: "propose_app_action",
      params: { rid: RID, op_id: RID, turn_ref: REF, action: { type: "string", description: "release 声明过的动作 id。", maxLength: 96, pattern: /^[a-z][a-z0-9_.-]{0,95}$/ }, params: JSON_VALUE, expected_revision: REVISION },
    },
    finish_turn: {
      summary: "用明确 succeeded、failed 或 unknown 终态结束 turn；unknown 不会重投",
      operation: "finish_app_agent_turn",
      params: { rid: RID, op_id: RID, turn_ref: REF, outcome: { type: "string", description: "turn 的明确终态。", maxLength: 9, enum: ["succeeded", "failed", "unknown"] }, expected_revision: REVISION },
    },
    health: {
      summary: "读取 actor provider 健康与 generation，不领取 turn",
      operation: "read_app_agent_health",
      params: { rid: RID },
    },
  },
});

export const APP_REGISTRY_ADMIN_CONTRACT = "app-registry-admin/v1";
export const APP_REGISTRY_ADMIN_REFUSALS = refusalVocabulary(
  ["unavailable", "refused", "approval_required", "bad_ref", "identity_mismatch", "incompatible", "invalid_request", "scope_closed"],
  { fallback: "unavailable", maxMessageLength: CONVERGENCE_CONTRACT_LIMITS.message },
);

const DIGEST = Object.freeze({
  type: "string" as const,
  description: "完整 sha256 package digest；不是路径或 artifact bytes。",
  maxLength: 64,
  pattern: /^[a-f0-9]{64}$/,
});

const APP_ID = Object.freeze({
  type: "string" as const,
  description: "稳定 App id。",
  maxLength: 96,
  pattern: /^[a-z][a-z0-9-]{0,95}$/,
});

export const APP_REGISTRY_ADMIN_DECLARATION = declareContract({
  contract: APP_REGISTRY_ADMIN_CONTRACT,
  summary: "App registry 的 digest-only 管理闭集；不投影本机路径、artifact bytes、凭据或 capability。",
  refusals: APP_REGISTRY_ADMIN_REFUSALS,
  actions: {
    list: { summary: "读取 registry directory 的有界管理投影", operation: "read_app_registry", params: { rid: RID, cursor: { ...REF, optional: true }, limit: { type: "integer", description: "最多返回多少个 App。", minimum: 1, maximum: 100 } } },
    describe: { summary: "读取一个 App 的 release、兼容性、runtime health 和 reconcile 摘要", operation: "read_app_registry", params: { rid: RID, app_id: APP_ID } },
    declare: { summary: "声明一个已经由可信 source/build 链识别的 release", operation: "administer_app_registry", params: { rid: RID, op_id: RID, app_id: APP_ID, package_digest: DIGEST } },
    install: { summary: "安装可信 catalog 已知 digest；调用方不能传路径或字节", operation: "administer_app_registry", params: { rid: RID, op_id: RID, app_id: APP_ID, package_digest: DIGEST } },
    activate: { summary: "把 active pointer 原子切到一个已安装且兼容的 digest", operation: "administer_app_registry", params: { rid: RID, op_id: RID, app_id: APP_ID, package_digest: DIGEST } },
    deactivate: { summary: "停用 active pointer，不删除 release、artifact、App State 或 grants", operation: "administer_app_registry", params: { rid: RID, op_id: RID, app_id: APP_ID } },
    uninstall: { summary: "把 release 标为 removed；不删除 artifact 或 App State", operation: "administer_app_registry", params: { rid: RID, op_id: RID, app_id: APP_ID, package_digest: DIGEST } },
    rollback: { summary: "把 active pointer 切回明确 digest；不是猜测上一版", operation: "administer_app_registry", params: { rid: RID, op_id: RID, app_id: APP_ID, package_digest: DIGEST } },
    approve_hotswap: { summary: "批准请求中绑定的确切 digest；摘要值不能替换目标", operation: "administer_app_registry", params: { rid: RID, op_id: RID, app_id: APP_ID, package_digest: DIGEST, approval_ref: REF } },
  },
});

export const CONVERGENCE_DECLARATIONS = Object.freeze([
  AGENT_SESSION_ENDPOINT_DECLARATION,
  SESSION_HARNESS_LAUNCH_DECLARATION,
  APP_AGENT_ACTOR_DECLARATION,
  APP_REGISTRY_ADMIN_DECLARATION,
]);

/** Fields that are forbidden in a provider-neutral declaration at any depth. */
export const FORBIDDEN_CONTRACT_COORDINATES = Object.freeze([
  "owner", "username", "user", "device", "path", "url", "origin", "credential",
  "token", "cookie", "grant", "capability", "context", "instancehandle",
]);

export function contractCoordinateProblems(value: unknown, at = "contract"): string[] {
  const problems: string[] = [];
  const visit = (current: unknown, where: string): void => {
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const folded = key.toLowerCase().replace(/[^a-z]/g, "");
      if (FORBIDDEN_CONTRACT_COORDINATES.some((word) => folded.includes(word))) {
        problems.push(`${where}.${key}`);
      }
      visit(child, `${where}.${key}`);
    }
  };
  visit(value, at);
  return problems;
}
