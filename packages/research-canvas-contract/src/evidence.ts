import type { PortActionSpec, PortField } from "@claude-bot/typed-port-kit";
import type { Provenance } from "./model.js";

export interface ResearchEvidence {
  id: string;
  node: string;
  series: string;
  title: string;
  kind: "experiment" | "literature" | "theory";
  claim: "observation" | "inference" | "hypothesis";
  motivation: string;
  goal: string;
  design: string;
  execution: string;
  results: string;
  analysis: string;
  conclusion: string;
  code: string[];
  frameworks: string[];
  runs: string[];
  artifacts: string[];
  charts: string[];
  sources: string[];
  configuration: string;
  limitations: string;
  created: Provenance;
  sequence: number;
}
export interface EvidenceSelection {
  report: ResearchEvidence;
  latest: ResearchEvidence;
  adopted: ResearchEvidence | null;
  adoptedBy: Provenance | null;
}
const s = (description: string, maxLength = 160, optional = false): PortField => ({ type: "string", description, maxLength, optional });
const request = s("本次唯一请求；重试沿用同一请求", 100);
export const EVIDENCE_ACTIONS = {
  evidence_publish: { summary: "归档实验/调研/理论报告及证据关系；不会自动采纳", operation: "edit_graph", params: { request, data: { type: "json", description: "报告六部分、结论、研究类型、系列和已有证据节点引用", maxLength: 96000, schema: { type: "object" } } } },
  evidence_read: { summary: "同时读取当前报告、同系列最新报告和被采纳报告", operation: "read_project", params: { node: s("报告节点或报告 ID") } },
  evidence_list: { summary: "列出已归档报告；保留最新和采纳两个状态", operation: "read_project", params: { after: s("报告分页游标", 160, true) } },
  evidence_adopt: { summary: "明确采纳指定报告；不会改变最新结果", operation: "edit_graph", params: { request, node: s("报告节点或报告 ID"), expected: s("当前采纳报告 ID；尚未采纳传空字符串", 160, true) } },
} satisfies Record<string, PortActionSpec>;
