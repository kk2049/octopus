import { contractDigestOf } from "@claude-bot/engine";
import {
  CANVAS_OPERATIONS,
  RESEARCH_APP,
  RESEARCH_PUBLISHER,
} from "@claude-bot/research-canvas-contract";
import {
  defineOperationCatalog,
  type OperationInfo,
  type SubjectCatalogEntry,
} from "../permissions/catalog.js";
import { SESSION_RESOURCE_OPERATIONS } from "../session-resource/catalog.js";
import { MEETING_TRANSCRIPTION_CONTRACT } from "../meeting-transcription/contract.js";

export const RESEARCH_CANVAS_PROFILE_ID = "research-canvas/v2";
export const RESEARCH_NATIVE_OPERATIONS = [
  "list_recent_sessions",
  "list_session_workspaces",
  "read_session",
  "start_session",
  "append_session",
  "upload_session_file",
] as const;
export const RESEARCH_FILE_OPERATIONS = [
  "read_workspace_text",
  "download_workspace_file",
  "replace_workspace_text",
] as const;
// The recording provider owns this vocabulary; the App only declares which
// reviewed operations require its owner's explicit, digest-bound permission.
export const RESEARCH_MEETING_OPERATIONS = Object.values(MEETING_TRANSCRIPTION_CONTRACT.byAction)
  .map((declaration) => declaration.operation!);
const operations = [
  ...CANVAS_OPERATIONS,
  ...RESEARCH_NATIVE_OPERATIONS,
  ...RESEARCH_FILE_OPERATIONS,
  ...RESEARCH_MEETING_OPERATIONS,
];
export const RESEARCH_CANVAS_CONTRACT = {
  app: RESEARCH_APP,
  publisher: RESEARCH_PUBLISHER,
  operations,
  autoAllow: operations,
  actions: {},
  agents: {},
  delivery: [],
};
export const RESEARCH_CANVAS_DIGEST = contractDigestOf(
  RESEARCH_CANVAS_CONTRACT,
);
export function isResearchCanvasContract(
  app: string,
  publisher: string,
  digest: string,
): boolean {
  return (
    app === RESEARCH_APP &&
    publisher === RESEARCH_PUBLISHER &&
    digest === RESEARCH_CANVAS_DIGEST
  );
}
const descriptions: Record<
  string,
  Pick<OperationInfo, "title" | "description" | "effect" | "risk">
> = {
  read_project: {
    title: "读取项目",
    description: "读取本人获准加入的项目及其中明确绑定的资料。",
    effect: "read",
    risk: "读取私密内容",
  },
  edit_graph: {
    title: "编辑研究图",
    description:
      "按项目角色直接编辑图 YAML、节点、关系、坐标和真实文件。人和 Agent 使用同一图 CRDT；文件覆盖保存。",
    effect: "modify",
    risk: "修改",
  },
  run_agent: {
    title: "运行与监听",
    description: "使用 Agent 明确绑定的共享资源运行任务或配置持续监听。",
    effect: "execute",
    risk: "执行命令",
  },
  manage_resources: {
    title: "绑定共享资源",
    description:
      "项目管理者将本人有权共享的资源绑定到项目，项目成员和 Agent 可按角色访问。",
    effect: "modify",
    risk: "跨用户披露",
  },
  transcribe_audio: { title: "转写会议录音", description: "将项目录音传到站点明确配置的 MOSS Runner，识别讲话人并检查完整性、生成纪要候选。", effect: "execute", risk: "执行命令" },
  create_discussion_group: { title: "创建讨论群", description: "按项目管理者的明确动作创建飞书群并绑定；群成员和消息仍使用独立入口。", effect: "execute", risk: "对外发送" },
  read_cloud_document: { title: "读取绑定云文档", description: "按文档归属人的飞书权限将明确绑定的论文材料共享给项目成员和 Agent。", effect: "read", risk: "读取私密内容" },
  sync_cloud_document: { title: "同步中文论文大纲", description: "按本任务明确设置的范围和策略同步本地 Markdown 与选定飞书文本块；发生冲突时保留两边原文。", effect: "modify", risk: "修改" },
  send_message: {
    title: "在绑定群发言",
    description: "向项目明确绑定的飞书群发送消息，保留触发者和发送回执。",
    effect: "execute",
    risk: "对外发送",
  },
};
const meetingDescriptions: Record<
  keyof typeof MEETING_TRANSCRIPTION_CONTRACT.byAction,
  Pick<OperationInfo, "title" | "description" | "effect" | "risk" | "disclosure">
> = {
  begin: { title: "准备会议转写", description: "在录音归属人授权的设备上创建或恢复这一份录音的转写作业。", effect: "modify", risk: "修改" },
  upload: { title: "上传会议录音", description: "将这份项目录音分段发送到录音归属人授权的设备。", effect: "modify", risk: "对外发送", disclosure: "项目会议录音" },
  start: { title: "运行会议转写", description: "使用设备管理员预设的转写程序处理已完整上传的录音。", effect: "execute", risk: "执行命令" },
  status: { title: "查看转写进度", description: "查看原转写作业的进度与完成状态。", effect: "read", risk: "枚举与状态" },
  read: { title: "读取转写结果", description: "读取原转写作业发布的文字、讲话人和质量检查结果。", effect: "read", risk: "读取私密内容" },
  cancel: { title: "取消会议转写", description: "取消这一份录音尚未完成的转写作业。", effect: "modify", risk: "修改" },
};
export const RESEARCH_CANVAS_CATALOG = defineOperationCatalog(
  "research-canvas",
  [
    ...CANVAS_OPERATIONS.map((operation) => ({
      id: operation,
      runner: operation,
      ...descriptions[operation],
      alwaysApprove: false,
      mayAutoAllow: true,
    })),
    ...Object.entries(MEETING_TRANSCRIPTION_CONTRACT.byAction).map(([action, declaration]) => ({
      id: declaration.operation!,
      runner: declaration.operation!,
      ...meetingDescriptions[action as keyof typeof meetingDescriptions],
      alwaysApprove: false,
      mayAutoAllow: true,
    })),
    ...SESSION_RESOURCE_OPERATIONS.filter((item) =>
      (
        [
          ...RESEARCH_NATIVE_OPERATIONS,
          ...RESEARCH_FILE_OPERATIONS,
        ] as readonly string[]
      ).includes(item.id),
    ).map((item) => ({
      ...item,
      description: `${item.description} 绑定到项目后，获准进入项目的成员和 Agent 可以按读写授权访问所绑定工作区；运行权限另行控制。`,
    })),
  ],
);
export const RESEARCH_CANVAS_SUBJECT: SubjectCatalogEntry = {
  info: {
    type: "app",
    id: RESEARCH_APP,
    publisher: RESEARCH_PUBLISHER,
    title: "自动科研 v2",
    description: "多人协作研究图和明确绑定的项目资源",
    enforced: true,
  },
  catalog: RESEARCH_CANVAS_CATALOG,
  declared: () => operations,
  userManaged: true,
  grantIdentity: {
    publisher: RESEARCH_PUBLISHER,
    contractDigest: RESEARCH_CANVAS_DIGEST,
  },
};
