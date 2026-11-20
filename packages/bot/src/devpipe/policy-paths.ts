/**
 * Path policy: what a ticket may not change, and what is worth saying out loud
 * when it does.
 *
 * Extracted from `pipeline.ts` (#192). These two lists are policy, not pipeline
 * mechanics — `toolSubmit` enforces one and annotates with the other, but the
 * prompt builder also has to quote the protected list to the agent, and having
 * both reach back into the pipeline module would have made the dependency
 * circular the moment the prompts moved out.
 */

import { CLI_REPORT_DIR } from "./cli-report.js";

export const PROTECTED_PATHS = ["scripts/", ".claude/rules/", `${CLI_REPORT_DIR}/`];

/**
 * Paths worth making visible because they participate in a trust boundary.
 *
 * This is deliberately an OBSERVABILITY list, not a merge gate. Early-stage
 * development should not stop because one large trusted file also contains a
 * lifecycle or cleanup fix. A successful landing that touches one of these
 * paths gets an explicit ticket note; GitLab CI and the manual deploy boundary
 * remain responsible for feedback and release control.
 *
 * Directory entries end with "/" and match by prefix; the rest match exactly.
 */
export const TCB_PATHS = [
  // §1 可信闭包(core/gate/canonical/objects/types)+ §2 第二层(approval/
  // service/store/sqlite-store)+ §5 反例测试 —— 整包,理由见上。
  "packages/capability-kernel/",
  // §4 浏览器信任层,两个 surface 共用一份实现(origin/sessions/gate)。
  "packages/web-trust/",
  // §3 面板:路由表 + 8 条 Cedar 策略;表外路径 = 404。
  "packages/bot/src/dashboard/authz.ts",
  // §3 面板 + §3 批准:identify / mutationGate / authorizeRoute 钩子 /
  // requireApprover / runnerGrantFor 都在这个文件里。
  "packages/bot/src/dashboard/server.ts",
  // §3 面板 / 资源侧 / 权限来源与撤销:authorityFor、mintDeviceToken、
  // revokeAccount、RUNNER_OPERATIONS、runnerPolicy、runnerAdapter。
  "packages/bot/src/runner/capability.ts",
  // §3 chat agent:回环 wire 与 FORBIDDEN_BODY_KEYS。
  "packages/bot/src/runner/loopback.ts",
  // §3 资源侧:dispatchForOwner / claimTransport。
  "packages/bot/src/runner/gateway.ts",
  // §3 资源侧:一份实现,两个 Object 共用。
  "packages/bot/src/runner/dispatch.ts",
  // §3 资源侧:第二个 Object 的 adapter / 封闭 operation 表 / policy。
  "packages/bot/src/workspace-files/capability.ts",
  // §3 v3 应用:谓词词表。
  "packages/engine/src/dispatch.ts",
  // §3 v3 应用:/api/act 的 Context 来自 instance handle。
  "packages/engine/src/host/server.ts",
  // §3 v3 应用:account ∩ app ∩ action 的 narrow()。
  "packages/engine/src/host/capability-plane.ts",
  // §3 v3 应用:一次调用一个新 Compartment + 可撤销 facade。
  "packages/engine/src/runtime/sandbox.ts",
  // §3 v3 应用 / §6:SES endowment 表就是应用的网络边界。
  "packages/engine/src/runtime/sandbox-child.mjs",
] as const;

/**
 * Which of `files` land inside the trust-sensitive list. Directory entries
 * (trailing "/") match by prefix; file entries must match exactly.
 */
export function tcbPathHits(files: readonly string[]): string[] {
  return files.filter((f) =>
    TCB_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)),
  );
}
