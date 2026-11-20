import { RUNNER_EXTENSION_OPERATIONS } from "../runner/extension-capability.js";
import { MEETING_TRANSCRIPTION_OPERATIONS } from "../meeting-transcription/capability.js";
/**
 * The MCP surface's permission vocabulary — the `service:mcp` subject.
 *
 * ── What this subject governs, and what it deliberately does not ────────────
 *
 * The MCP endpoint exposes several tool groups. All except sessions are
 * governed here:
 *
 *   · session tools (including `send_session_message`) ride the EXISTING `service:session-hub` subject. An mcp_
 *     token is an owner-scoped credential and its session calls go through
 *     `SessionHubService`, which already intersects with the session-hub grant
 *     and the account's real authority. A second row saying the same thing
 *     would be a second permission model — revoking one and not the other
 *     would leave a screen that lies in one direction or the other.
 *   · workspace-file tools and collaborative-document tools have no existing
 *     owner-facing subject (they were reachable only through the Session Plus
 *     App grant), so THIS subject is where an owner consents to their own MCP
 *     clients touching them.
 *
 * Per the permission centre's rule, this subject exists only when the
 * composition wires an execution path that consumes its rows — the dashboard
 * injects it together with the `McpSurface`, and `declared()` names only the
 * operations whose backing plane was actually composed. A checkbox for an
 * operation nothing can execute is the decorative control the permission
 * centre forbids.
 *
 * ── The honest sentence about `edit_document` ───────────────────────────────
 *
 * The workspace write goes through a capability Object whose Gate can queue a
 * per-call card, but the workspaces are the token owner's own, so a granted
 * `replace_workspace_text` is silent like the owner's own memory writes (O1).
 * `crdt-doc/v1` has NO Gate between a caller and a merge (see
 * `session-resource/crdt-grant.ts`'s wall record), so an `edit_document`
 * grant takes effect immediately and per-call approval cannot be promised.
 * The description says exactly that, because the description is what the
 * person granting it reads. `mayAutoAllow` stays false — the projection must
 * not offer an "unsupervised" term as if a supervised mode existed.
 */

import { CRDT_EDIT_OPERATION, CRDT_READ_OPERATION } from "@claude-bot/crdt-doc-contract";
import { DISCUSSION_OPERATIONS, DISCUSSION_OPERATION_IDS } from '../discussions/capability.js';
import {
  WORKSPACE_FILES_OPERATIONS,
  WORKSPACE_FILES_WRITE_OPERATION,
} from "../workspace-files/capability.js";
import { USER_MEMORY_OPERATIONS } from "../user-memory/capability.js";
import { USER_SKILLS_OPERATIONS } from "../user-skills/capability.js";
import {
  FEISHU_MCP_CATALOG,
  FEISHU_PRIVILEGED_OPERATIONS,
  FEISHU_USER_OPERATIONS,
} from "../feishu/catalog.js";
import {
  EXECUTION_SCOPE_OPERATIONS,
  LIST_EXECUTION_TARGETS,
  OPEN_WORKSPACE_EXECUTION,
} from "../execution-workspace/scope-issuer.js";
import {
  defineOperationCatalog,
  type OperationInfo,
  type SubjectCatalogEntry,
  type SubjectInfo,
} from "../permissions/catalog.js";

export const MCP_SUBJECT_ID = "mcp";
export const MCP_MEETING_TRANSCRIPTION_OPERATION_IDS: readonly string[] = Object.keys(MEETING_TRANSCRIPTION_OPERATIONS);
const TRANSCRIPTION_OPERATION_INFO: readonly OperationInfo[] = Object.entries(MEETING_TRANSCRIPTION_OPERATIONS).map(([id, spec]) => ({
  id, runner: id, title: spec.title ?? id, effect: spec.effect, risk: spec.effect === "read" ? "读取私密内容" : "修改",
  description: "在已绑定本人设备的固定 MOSS 管线上上传录音、管理持久转写及读取有界产物。不能指定设备、脚本、模型或 shell；MCP 需单独授权，未勾选自动允许时逐次审批。",
  alwaysApprove: false, mayAutoAllow: true,
}));

const KNOWLEDGE_OPERATION_INFO: readonly OperationInfo[] = [
  { id:"manage_knowledge_sources", runner:"manage_knowledge_sources", title:"管理本人知识来源", description:"选择性导入或读取本人 CLI 消息；本地导入不证明人类身份，不能代本人确认设计。",effect:"modify",risk:"读取私密内容",alwaysApprove:false,mayAutoAllow:false },
  { id:"maintain_development_knowledge",runner:"maintain_development_knowledge",title:"维护知识纠错队列",description:"报告、调查内容问题并回放 Git 中的有界修正；不能直接改知识或批准设计。",effect:"modify",risk:"修改",alwaysApprove:false,mayAutoAllow:false },
  { id: "read_development_knowledge", runner: "read_development_knowledge", title: "检索开发知识", description: "读取共享的功能规格、来源、冲突和代码/测试映射。须有开发或贡献权限。", effect: "read", risk: "读取私密内容", alwaysApprove: false, mayAutoAllow: false },
  { id: "annotate_development_knowledge", runner: "annotate_development_knowledge", title: "记录知识调查", description: "以 Agent 身份追加冲突调查批注。授权后直接生效，不能批准设计或修改知识。", effect: "modify", risk: "修改", alwaysApprove: false, mayAutoAllow: false },
];
export const MCP_KNOWLEDGE_OPERATION_IDS: readonly string[] = KNOWLEDGE_OPERATION_INFO.map((operation) => operation.id);

export const MCP_SUBJECT: SubjectInfo = {
  type: "service",
  id: MCP_SUBJECT_ID,
  title: "MCP 接入",
  publisher: "first-party",
  enforced: true,
  description:
    "你在 /permissions 页签发的 mcp_ 令牌可以让外部 Agent（如 Claude Code）通过 MCP 协议调用这里勾选的能力。"
    + "会话类工具（列出/搜索/读取/续发会话）跟随上方「会话中心」的授权，不在这里重复勾选；Agent 续发仍逐次审批；"
    + "这里决定的是工作区文件、协作文档、bot 主机上的中心记忆区与技能库、已声明的 Agentic App、本人 OAuth 飞书能力，以及部署策略逐用户开放的飞书特权工具。",
};

/** Workspace-file operations, described for the person granting them. */
const WORKSPACE_OPERATION_INFO: readonly OperationInfo[] = [
  {
    id: "list_session_workspaces",
    runner: "list_session_workspaces",
    title: "列出工作区",
    description: "看见你设备上已登记的工作区列表。不读文件内容。",
    effect: "observe",
    risk: "枚举与状态",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "list_workspace_entries",
    runner: "list_workspace_entries",
    title: "浏览工作区目录",
    description: "在已登记的工作区里逐级列目录：文件名、大小、修改时间。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "read_workspace_text",
    runner: "read_workspace_text",
    title: "读取工作区文本文件",
    description: "读取工作区里一个文本文件的完整内容。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: WORKSPACE_FILES_WRITE_OPERATION,
    runner: WORKSPACE_FILES_WRITE_OPERATION,
    title: "改写工作区文本文件",
    description:
      "整份替换你自己工作区里一个已存在的文本文件，且必须带上它当前内容的摘要（内容变了就拒绝写入）。"
      + "授权后本人的 agent 写入无需逐次批准。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
];

/** Collaborative-document operations. See the file docstring for `edit`. */
const CRDT_OPERATION_INFO: readonly OperationInfo[] = [
  {
    id: CRDT_READ_OPERATION,
    runner: CRDT_READ_OPERATION,
    title: "读取协作文档",
    description: "列出并读取你的协作文档的当前内容与增量。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: CRDT_EDIT_OPERATION,
    runner: CRDT_EDIT_OPERATION,
    title: "编辑协作文档",
    description:
      "把编辑合并进你的协作文档。注意：这个平面目前没有逐次批准的闸门——授权即直接生效，撤销授权是唯一的刹车。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: false,
    mayAutoAllow: false,
  },
];

/**
 * The user's central memory directory on the bot host, described for consent.
 *
 * Writing one's own memory is the owner acting on their own resource (O1):
 * once granted it is silent, like the reads. The head of MEMORY.md is still
 * injected into every future session, which the description says plainly.
 */
const MEMORY_OPERATION_INFO: readonly OperationInfo[] = [
  {
    id: "list_memory",
    runner: "list_memory",
    title: "列出记忆文件",
    description: "看见你中心记忆区里的文件清单（路径/大小/时间），分页列全。不读内容。",
    effect: "observe",
    risk: "枚举与状态",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "read_memory",
    runner: "read_memory",
    title: "读取记忆文件",
    description: "读取你中心记忆区里一个文件的内容（分段读，任意大小都能读完）。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "search_memory",
    runner: "search_memory",
    title: "搜索记忆",
    description: "在你的全部记忆文件里按关键字检索，返回命中片段。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "write_memory",
    runner: "write_memory",
    title: "写入记忆文件",
    description:
      "整份覆盖你记忆区里的一个文件。MEMORY.md 的开头会自动注入你未来每次会话；授权后本人的 agent 写入无需逐次批准。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "append_memory",
    runner: "append_memory",
    title: "追加记忆文件",
    description: "向记忆文件末尾追加一段内容（原内容保留）。授权后无需逐次批准。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
];

/**
 * The user's skill registry (`<home>/.claude/skills/<name>/`). Writing one's
 * own skill is silent once granted (O1); removing a whole skill directory is
 * irreversible and stays a per-call approval.
 */
const SKILL_OPERATION_INFO: readonly OperationInfo[] = [
  {
    id: "list_skills",
    runner: "list_skills",
    title: "列出技能",
    description: "看见你技能库里有哪些技能、各含哪些文件（分页列全）。不读内容。",
    effect: "observe",
    risk: "枚举与状态",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "read_skill",
    runner: "read_skill",
    title: "读取技能文件",
    description: "读取某个技能目录里一个文件的内容（默认 SKILL.md，分段读，任意大小都能读完）。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "write_skill",
    runner: "write_skill",
    title: "写入技能文件",
    description:
      "整份写入某个技能目录里的一个文件。技能是会被你的 agent 加载执行的指令；授权后本人的 agent 写入无需逐次批准。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "remove_skill",
    runner: "remove_skill",
    title: "删除技能",
    description: "删除整个技能目录（不可恢复）。每次删除都要你在待批准页点头。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: true,
    mayAutoAllow: false,
  },
];

/**
 * The Agentic-App operations (ADR 0007's MCP face), for declared Apps.
 *
 * The dispatch rides the SAME `AppInstanceService` door a page button and an
 * app-agent turn use — manifest normalisation, the App's own SES rules door,
 * one audited commit — with an `agent` actor that `human_only` actions refuse
 * by construction. There is no per-call approval gate on this plane, and the
 * description a granter reads says so out loud (the `edit_document` precedent):
 * granting `dispatch_app_action` takes effect immediately, the brake is
 * revocation, and the safety story is the commit log below, not a card. The
 * commit log is evidence fields only — actor, action, hashes — never raw
 * params or event payloads.
 */
// Shared administration has separate additive grants. Existing dispatch grants
// remain unchanged; every administration call rechecks trust, token scope and creator.
const APPS_OPERATION_INFO: readonly OperationInfo[] = [
  {
    id: "read_app_members", runner: "read_app_members", title: "读取共享项目成员",
    description: "仅创建者可读取指定项目的成员名单和角色；仍受令牌 App 与实例范围限制。",
    effect: "read", risk: "读取私密内容", alwaysApprove: false, mayAutoAllow: true,
  },
  {
    id: "manage_shared_apps", runner: "manage_shared_apps", title: "管理共享项目与成员",
    description: "允许创建共享项目、以创建者身份增删成员或修改角色、关闭实例。必须先信任当前发布者；不继承普通 App 动作授权，不允许代签真人批准。授权即直接生效，无逐次批准；撤销授权立即阻止后续调用。",
    effect: "modify", risk: "修改", alwaysApprove: false, mayAutoAllow: false,
  },
  {
    id: "list_apps",
    runner: "list_apps",
    title: "列出可操作的 App",
    description: "看见你可通过 MCP 操作的 Agentic App 清单，以及每个 App 声明的动作与参数。不读状态。",
    effect: "observe",
    risk: "枚举与状态",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "read_app_projection",
    runner: "read_app_projection",
    title: "读取 App 投影",
    description: "读取一个 App 为你投影的当前状态 — 与页面所见相同的投影路径。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "dispatch_app_action",
    runner: "dispatch_app_action",
    title: "向 App 提交动作",
    description:
      "以 agent 身份向一个 App 提交它声明过的动作。动作要先过 App 自己的规则校验，每次提交都写入带操作者与参数摘要的提交历史；"
      + "标记「仅限本人」的动作对令牌永远拒绝。注意：这个平面没有逐次批准的闸门——授权即直接生效，撤销授权是唯一的刹车。",
    effect: "modify",
    risk: "修改",
    alwaysApprove: false,
    mayAutoAllow: false,
  },
  {
    id: "read_app_log",
    runner: "read_app_log",
    title: "读取 App 提交历史",
    description: "分页读取一个 App 状态流的提交历史：时间、操作者、动作、参数摘要与代码指纹。不含参数原文和事件内容。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
];

/** Feishu user and privileged operations; identity/payload mapping stays in the reviewed catalog. */
const FEISHU_OPERATION_INFO: readonly OperationInfo[] = FEISHU_MCP_CATALOG.map((entry) => {
  const privileged = Boolean(FEISHU_PRIVILEGED_OPERATIONS[entry.operation]);
  const autoAllowable = !privileged && (entry.risk === "read" || Boolean(entry.ownerMayAutoAllow));
  return {
    id: entry.operation,
    runner: entry.operation,
    title: entry.title,
    description: `${entry.description} ${
      entry.credentialMode === "user_oauth"
        ? "使用你自己的飞书 OAuth 身份。"
        : "使用租户应用 / 系统 Bot 身份。"
    }${!autoAllowable ? "每次调用都需要本人批准。" : entry.risk === "read" ? "读取动作可选择自动允许。" : "授予后直接执行，不再逐次批准。"}`,
    effect: entry.spec.effect,
    risk: entry.risk === "read" ? "读取私密内容" : entry.risk === "external-send" ? "对外发送" : "修改",
    alwaysApprove: !autoAllowable,
    mayAutoAllow: autoAllowable,
  };
});

/**
 * On-demand session-execution scopes for the owner's OWN devices (the dsh
 * remote-backend use). Listing targets is observe-only. Opening a scope mints a
 * separate, attenuated, revocable `mcp_` credential over one device + one
 * registered workspace; it is an execute-class decision because that credential
 * can run commands there. The owner may auto-allow it (each scope is still
 * owner-bound, bounded in time, and revocable), otherwise every open is one
 * approval card.
 */
const EXECUTION_OPERATION_INFO: readonly OperationInfo[] = [
  {
    id: LIST_EXECUTION_TARGETS,
    runner: LIST_EXECUTION_TARGETS,
    title: "列出可远程执行的设备与工作区",
    description: "看见你自己哪些在线设备能承接远程执行，以及每台设备上已登记的工作区 id 与标签。不读文件内容。",
    effect: "observe",
    risk: "枚举与状态",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: OPEN_WORKSPACE_EXECUTION,
    runner: OPEN_WORKSPACE_EXECUTION,
    title: "签发设备级远程执行凭证",
    description:
      "为你自己的一台在线设备与一个已登记工作区签发一枚独立的短期会话执行凭证（只含工作区文件与 run_workspace_command 五个工具）。"
      + "勾选自动允许后，每次签发不再弹卡；否则每次签发都要你在待批准页点头。撤销本令牌会连带作废它签发过的全部凭证。",
    effect: "execute",
    risk: "执行命令",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
];

export const MCP_WORKSPACE_OPERATION_IDS: readonly string[] = WORKSPACE_OPERATION_INFO.map((op) => op.id);
export const MCP_EXECUTION_OPERATION_IDS: readonly string[] = EXECUTION_OPERATION_INFO.map((op) => op.id);
export const MCP_CRDT_OPERATION_IDS: readonly string[] = CRDT_OPERATION_INFO.map((op) => op.id);
export const MCP_MEMORY_OPERATION_IDS: readonly string[] = MEMORY_OPERATION_INFO.map((op) => op.id);
export const MCP_SKILL_OPERATION_IDS: readonly string[] = SKILL_OPERATION_INFO.map((op) => op.id);
export const MCP_APPS_OPERATION_IDS: readonly string[] = APPS_OPERATION_INFO.map((op) => op.id);
export const MCP_FEISHU_USER_OPERATION_IDS: readonly string[] = FEISHU_MCP_CATALOG
  .filter((entry) => !FEISHU_PRIVILEGED_OPERATIONS[entry.operation])
  .map((entry) => entry.operation);
export const MCP_FEISHU_PRIVILEGED_OPERATION_IDS: readonly string[] = FEISHU_MCP_CATALOG
  .filter((entry) => Boolean(FEISHU_PRIVILEGED_OPERATIONS[entry.operation]))
  .map((entry) => entry.operation);
export const MCP_FEISHU_OPERATION_IDS: readonly string[] = [
  ...MCP_FEISHU_USER_OPERATION_IDS,
  ...MCP_FEISHU_PRIVILEGED_OPERATION_IDS,
];

/**
 * One catalog covering the non-session MCP planes. Workspace, memory and skill entries
 * are validated against their Objects' closed tables so the projection can
 * never name a kernel operation the Gate does not have; the two document
 * operations have no kernel table (that is the plane's recorded gap) and are
 * named verbatim, as are the four App operations — their door is the
 * `AppInstanceService` dispatch pipeline rather than a capability Object.
 */
export const MCP_CATALOG = defineOperationCatalog(
  "mcp surface",
  [
    ...WORKSPACE_OPERATION_INFO,
    ...CRDT_OPERATION_INFO,
    ...MEMORY_OPERATION_INFO,
    ...SKILL_OPERATION_INFO,
    ...APPS_OPERATION_INFO,
    ...FEISHU_OPERATION_INFO,
    ...EXECUTION_OPERATION_INFO,
    ...KNOWLEDGE_OPERATION_INFO,
    ...TRANSCRIPTION_OPERATION_INFO,
    ...Object.entries(RUNNER_EXTENSION_OPERATIONS).map(([id, spec]): OperationInfo => ({
      id, runner: id, title: spec.title ?? id, effect: spec.effect,
      risk: spec.effect === "execute" ? "执行命令" : "枚举与状态",
      description: "发现、查看或调用本人 Runner 本机登记的 MCP 能力。调用以 Runner 的 OS 用户身份执行；自动允许将覆盖当前及以后登记的能力。默认逐次审批，版本变化后旧引用失效。",
      alwaysApprove: false, mayAutoAllow: true,
    })),
    ...Object.entries(DISCUSSION_OPERATIONS).map(([id, spec]): OperationInfo => ({ id, runner: id, title: spec.title ?? id, description: `${spec.title ?? id}。创建会议会授权秘书持续处理本群消息与按需发言，召集人可暂停或结束。MCP 未勾选自动允许时逐次审批。`, effect: spec.effect, risk: spec.effect === 'read' ? '读取私密内容' : '对外发送', alwaysApprove: false, mayAutoAllow: true })),
  ],
  {
    ...DISCUSSION_OPERATIONS,
    ...RUNNER_EXTENSION_OPERATIONS,
    ...MEETING_TRANSCRIPTION_OPERATIONS,
    ...WORKSPACE_FILES_OPERATIONS,
    ...EXECUTION_SCOPE_OPERATIONS,
    ...USER_MEMORY_OPERATIONS,
    ...USER_SKILLS_OPERATIONS,
    ...Object.fromEntries(KNOWLEDGE_OPERATION_INFO.map((operation) => [operation.runner, true])),
    [CRDT_READ_OPERATION]: true,
    [CRDT_EDIT_OPERATION]: true,
    ...Object.fromEntries(APPS_OPERATION_INFO.map((op) => [op.runner, true])),
    ...Object.fromEntries(
      Object.entries({ ...FEISHU_USER_OPERATIONS, ...FEISHU_PRIVILEGED_OPERATIONS })
        .map(([id, entry]) => [id, entry.spec]),
    ),
  },
);

export interface McpSubjectComposition {
  discussionsComposed?: () => boolean;
  runnerCapabilitiesComposed?: () => boolean;
  transcriptionComposed?: () => boolean;
  knowledgeComposed?: () => boolean;
  /** The workspace-files capability plane was composed. */
  workspaceComposed: () => boolean;
  /** A collaborative-document store was composed and handed to the surface. */
  crdtComposed: () => boolean;
  /** The user-memory capability plane was composed. Absent = false. */
  memoryComposed?: () => boolean;
  /** The user-skills capability plane was composed. Absent = false. */
  skillsComposed?: () => boolean;
  /** A declared-App directory was handed to the surface. Absent = false. */
  appsComposed?: () => boolean;
  /** The reviewed user-OAuth Feishu capability plane was handed to MCP. */
  feishuComposed?: () => boolean;
  /** Privileged operations explicitly named for this owner by deployment policy. */
  feishuPrivilegedOperations?: (owner: string) => readonly string[];
  /** The on-demand execution-scope issuer (session-execution registry) was composed. */
  executionComposed?: () => boolean;
}

/**
 * The entry the dashboard injects into `PermissionService` — together with the
 * `McpSurface` that consumes its rows, never alone.
 */
export function mcpSubjectEntry(composition: McpSubjectComposition): SubjectCatalogEntry {
  return {
    info: MCP_SUBJECT,
    catalog: MCP_CATALOG,
    // The consent screen asks only about operations a composed plane could
    // actually serve; granting the rest would record agreement to nothing.
    declared: (owner) => [
      ...(composition.discussionsComposed?.() ? DISCUSSION_OPERATION_IDS : []),
      ...(composition.runnerCapabilitiesComposed?.() ? Object.keys(RUNNER_EXTENSION_OPERATIONS) : []),
      ...(composition.transcriptionComposed?.() ? MCP_MEETING_TRANSCRIPTION_OPERATION_IDS : []),
      ...(composition.knowledgeComposed?.() ? MCP_KNOWLEDGE_OPERATION_IDS : []),
      ...(composition.workspaceComposed() ? MCP_WORKSPACE_OPERATION_IDS : []),
      ...(composition.crdtComposed() ? MCP_CRDT_OPERATION_IDS : []),
      ...(composition.memoryComposed?.() ? MCP_MEMORY_OPERATION_IDS : []),
      ...(composition.skillsComposed?.() ? MCP_SKILL_OPERATION_IDS : []),
      ...(composition.appsComposed?.() ? MCP_APPS_OPERATION_IDS : []),
      ...(composition.feishuComposed?.() ? MCP_FEISHU_USER_OPERATION_IDS : []),
      ...(composition.feishuComposed?.() && owner
        ? (composition.feishuPrivilegedOperations?.(owner) ?? [])
          .filter((operation) => MCP_FEISHU_PRIVILEGED_OPERATION_IDS.includes(operation))
        : []),
      ...(composition.executionComposed?.() ? MCP_EXECUTION_OPERATION_IDS : []),
    ],
    userManaged: true,
  };
}
