import type { PortActionSpec, PortField } from "@claude-bot/typed-port-kit";
export type PaperSyncStrategy = "manual" | "local_to_cloud" | "cloud_to_local" | "bidirectional";
export interface ResearchCloudDocument {
  id: string;
  node: string;
  owner: string;
  version: number;
  url: string;
  document: string;
  block: string;
  localNode: string;
  strategy: PaperSyncStrategy | null;
  /** Explicit opt-in per task; missing means disabled. */
  watch?: boolean;
  instructions: string;
  baseline: { local: string; cloud: string } | null;
  status: "unconfigured" | "ready" | "synced" | "local_changed" | "cloud_changed" | "conflict" | "unknown" | "failed";
  checkedAt: string | null;
  message: string;
}
export interface CloudDocumentRead {
  binding: ResearchCloudDocument;
  text: string;
  revision: string;
  blocks: { id: string; text: string; supported: boolean }[];
  /** Only a trusted official component provider may populate this, never node metadata. */
  embed: { available: false; reason: string };
}
export interface PaperSyncPreview {
  binding: ResearchCloudDocument;
  local: { text: string; digest: string };
  cloud: { text: string; digest: string; revision: number };
}
const s = (description: string, maxLength = 160, optional = false): PortField => ({ type: "string", description, maxLength, optional });
const request = s("唯一请求 ID；未知结果保留同一请求", 100), node = s("云文档材料节点");
const data: PortField = { type: "json", description: "本任务文档地址、同步范围与策略", maxLength: 12000, schema: { type: "object" } };
export const CLOUD_DOCUMENT_ACTIONS = {
  cloud_document_bind: { summary: "将本人有权访问的真实云文档显式共享到项目材料", operation: "manage_resources", params: { request, node, data } },
  cloud_document_read: { summary: "以文档归属人的授权读取云文档和可同步文本块", operation: "read_cloud_document", params: { node } },
  paper_sync_configure: { summary: "为具体论文任务设置本地Markdown、云端文本块与推进策略；没有全局默认", operation: "manage_resources", params: { request, node, data } },
  paper_sync_check: { summary: "读取两边的当前内容，识别单边变化和冲突；不会写入", operation: "read_cloud_document", params: { node } },
  paper_sync_run: { summary: "按本任务策略同步中文大纲；双边变化或未知结果留待处理", operation: "sync_cloud_document", params: { request, node, direction: { ...s("按配置auto或明确选择local_to_cloud/cloud_to_local", 32), enum: ["auto", "local_to_cloud", "cloud_to_local"] }, local_digest: s("审阅到的本地摘要", 100), cloud_digest: s("审阅到的云端摘要", 100) } },
} satisfies Record<string, PortActionSpec>;
