import {
  defineOperationCatalog,
  type OperationInfo,
  type SubjectCatalogEntry,
  type SubjectInfo,
} from "../permissions/catalog.js";
import {
  TENTACLE_INVOKE_OPERATION,
  TENTACLE_READ_EVENT_OPERATION,
  TENTACLE_SUBJECT_ID,
} from "./contract.js";

export {
  TENTACLE_INVOKE_OPERATION,
  TENTACLE_READ_EVENT_OPERATION,
  TENTACLE_SUBJECT_ID,
} from "./contract.js";

const OPERATIONS: readonly OperationInfo[] = [
  {
    id: TENTACLE_INVOKE_OPERATION,
    runner: TENTACLE_INVOKE_OPERATION,
    title: "调用共享 dsh 工具",
    description:
      "让指定的另一个 Octopus 用户调用这个 dsh 实例在授权时固定下来的一个工具 schema。"
      + "Octopus Gate 先校验 standing grant；被叫 dsh 仍可逐次弹出自己的本地批准。",
    effect: "execute",
    risk: "跨用户披露",
    alwaysApprove: false,
    // The second, per-call decision belongs to the target dsh ask door.  An
    // Octopus approval card here would duplicate it and let either layer be
    // mistaken for the other.
    mayAutoAllow: true,
  },
  {
    id: TENTACLE_READ_EVENT_OPERATION,
    runner: TENTACLE_READ_EVENT_OPERATION,
    title: "观看共享 dsh 会话投影",
    description:
      "把一个固定源会话的 viewer-safe transcript 事件转发给指定用户；路径、权限、审批与调试事件不转发。",
    effect: "read",
    risk: "跨用户披露",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
];

export const TENTACLE_CATALOG = defineOperationCatalog("dsh tentacle", OPERATIONS, {
  [TENTACLE_INVOKE_OPERATION]: true,
  [TENTACLE_READ_EVENT_OPERATION]: true,
});

export const TENTACLE_SUBJECT: SubjectInfo = {
  type: "service",
  id: TENTACLE_SUBJECT_ID,
  title: "dsh 跨用户共享",
  publisher: "first-party",
  enforced: true,
  description:
    "这里的每一行都固定一个观看者与一个 capability Object；授权在下方 dsh 共享面管理，"
    + "最终调用逐次通过 capability-kernel Gate。",
};

export const TENTACLE_SUBJECT_ENTRY: SubjectCatalogEntry = Object.freeze({
  info: TENTACLE_SUBJECT,
  catalog: TENTACLE_CATALOG,
  // The generic subject checkbox has no resource/viewer coordinate.  A
  // dedicated section uses the same PermissionService with an explicit
  // resourceId instead of presenting a wildcard control that would lie.
  userManaged: false,
});

export function tentacleShareResourceId(viewer: string, objectId: string): string {
  return `${viewer}|${objectId}`;
}

/** Stable canonical ids; neither contains a device name, path, token, or schema body. */
export function tentacleAuthorizationDomainId(owner: string): string {
  return `personal:${owner}`;
}

export function tentacleAuthorizationResourceId(objectId: string): string {
  return `resource:tentacle:${objectId}`;
}
