import type { PortActionSpec, PortField } from "@claude-bot/typed-port-kit";

/** Selection contains registered identities, never a command, path or credential. */
export type MeetingSummarySelection =
  | { kind: "none" }
  | { kind: "agent"; agent: string }
  | { kind: "codex"; resource: string; account?: string; model?: string; effort?: string };
export interface MeetingOptions {
  transcription: { available: boolean; status: string; backend: string };
  agents: { id: string; title: string }[];
  sources: { id: string; title: string; accounts: { id: string; label: string }[]; models: string[]; efforts: string[] }[];
  mayBind: boolean;
}
export interface MeetingSummaryExecution {
  attempt: string;
  agent: { id: string; title: string };
  run: string;
  state: "queued" | "running" | "completed" | "failed" | "unknown";
  model?: string | null;
  message?: string;
}
const str = (description: string, maxLength = 160, optional = false): PortField => ({ type: "string", description, maxLength, optional });
const json = (description: string, maxLength = 24_000): PortField => ({ type: "json", description, maxLength, schema: { type: "object" } });
const request = str("稳定请求ID；结果不明时沿用", 100);
const node = str("会议录音节点ID/ref", 320);
const version = str("source_read 返回的固定 sourceVersion", 160);
const action = (summary: string, operation: string, params: Record<string, PortField>): PortActionSpec => ({ summary, operation, params });
export const MEETING_ACTIONS = {
  meeting_options: action("读取录音转写能力与本人已授权的Codex来源；不会上传、启动或绑定", "read_project", { node }),
  source_summarize: action("使用明确选择的Agent或Codex来源整理完整转写，生成待审纪要与任务建议；不会执行候选任务", "run_agent", {
    request, node, version, selection: json("{kind:agent,agent} 或 {kind:codex,resource,account?,model?,effort?}"),
  }),
  source_segments: action("按页读取指定版本的全部来源片段；继续至next为空，不省略末尾", "read_project", {
    node, version, after: str("上页返回的片段游标", 32, true),
  }),
  source_summary_submit: action("由本次被选中的整理Agent提交有来源依据的纪要与待审候选；不得发布或执行任务", "run_agent", {
    request, node, version, attempt: str("本次整理标识"),
    data: json("{minutes:Markdown,candidates:[{title,summary,body,kind:task|goal|finding|note,evidence:[片段ID]}]}", 196_608),
  }),
} as const;
