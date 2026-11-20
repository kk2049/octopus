import type { PortActionSpec, PortField } from "@claude-bot/typed-port-kit";
import type { Provenance, ResearchNode, ResearchRun, Versioned } from "./model.js";

/** A draft prepares a turn; agent/session identities remain in existing resources. */
export interface WorkflowDraft extends Versioned {
  title: string;
  agent: string;
  contexts: string[];
  prompt: string;
  status: "draft" | "started";
  conversation: string;
  firstRun: string | null;
  latestRun: string | null;
}
export interface WorkflowEvidence { source: string; locator?: string; text?: string }
export interface WorkflowCandidate {
  id: string;
  title: string;
  summary: string;
  body: string;
  kind: "task" | "goal" | "finding" | "note";
  state: "pending" | "edited" | "deleted" | "confirmed";
  dependencies: string[];
  evidence: WorkflowEvidence[];
}
export interface WorkflowBatch extends Versioned {
  source: string;
  title: string;
  items: WorkflowCandidate[];
  published: Record<string, { node: string; ref: string }>;
  pendingPublish?: { request: string; fingerprint: string; version: number; data: string };
}
export interface WorkflowFlag extends Versioned {
  kind: "review" | "decision";
  title: string;
  background: string;
  options: string[];
  related: string[];
  sources: WorkflowEvidence[];
  agent: string | null;
  conversation: string | null;
  run: string | null;
  state: "open" | "resolved";
  answer: { text: string; by: string; at: string } | null;
  answerRevision?: number;
  sent: { answerVersion: number; run: string; at: string }[];
  /** Optional explicit links to outcomes that depend on this unresolved question. */
  affected: string[];
}
export type WorkflowRuleScope =
  | { kind: "project"; ids: [] }
  | { kind: "nodes" | "descendants" | "agents"; ids: string[] };
export type WorkflowRuleCheck =
  | { kind: "required_text"; value: string }
  | { kind: "required_relation"; value: string }
  | { kind: "required_metadata"; key: string; value: string }
  | { kind: "manual"; value: string };
export interface WorkflowRule extends Versioned {
  title: string;
  instruction: string;
  motivation: string;
  enabled: boolean;
  scope: WorkflowRuleScope;
  sources: WorkflowEvidence[];
  stages: ("start" | "continue" | "completion")[];
  checks: WorkflowRuleCheck[];
  conflicts: string[];
  /** Only an explicit project rule can block its checked stage. */
  enforcement: "inform" | "block";
}
export interface WorkflowCheckResult {
  rule: string;
  title: string;
  target: string;
  status: "passed" | "missing" | "manual" | "conflict";
  detail: string;
  enforcement: "inform" | "block";
}
export interface WorkflowExecution extends Versioned {
  batch: string;
  owner: string;
  scope: string[];
  parallelism: number;
  prompt: string;
  state: "running" | "completed" | "failed" | "stopped";
  items: Record<string, {
    node: string; agent: string; bindingVersion?: number; dependencies: string[];
    state: "pending" | "running" | "completed" | "failed" | "blocked";
    run: string | null; error: string | null;
  }>;
}
export interface WorkflowTrace {
  id: string;
  at: string;
  actor: Provenance;
  action: string;
  state: "suggested" | "applied" | "observed";
  outcome?: string;
  sources: string[];
  targets: { kind: "node" | "edge" | "resource"; id: string; operation: "created" | "updated" | "removed" | "related" | "checked" }[];
}
export interface WorkflowSummary { review: number; decision: number; ids: string[] }
export interface WorkflowPage {
  drafts: WorkflowDraft[];
  flags: WorkflowFlag[];
  rules: WorkflowRule[];
  batches: WorkflowBatch[];
  executions: WorkflowExecution[];
  agents: ResearchNode[];
  runs: ResearchRun[];
  summaries: Record<string, WorkflowSummary>;
  truncated: boolean;
}
const str = (description: string, maxLength = 160, optional = false): PortField => ({ type: "string", description, maxLength, optional });
const request = str("稳定请求 ID；重试沿用同一 ID", 100);
const version: PortField = { type: "integer", description: "读取到的版本", minimum: 0, maximum: 2_147_483_647 };
const data = (description: string, maxLength = 96_000): PortField => ({ type: "json", description, maxLength, schema: { type: "object" } });
const action = (summary: string, operation: string, params: Record<string, PortField>): PortActionSpec => ({ summary, operation, params });
export const WORKFLOW_ACTIONS = {
  workflow_read: action("读取 Agent 草稿、活动、待审问题、规则与候选；不启动工作", "read_project", { source: str("可选来源 ref", 320, true) }),
  workflow_trace: action("按来源或对象双向查询已经生效的改动和建议", "read_project", { source: str("来源 ref、Agent 或 run", 320, true), node: str("对象 ID/ref", 320, true), after: str("改动游标", 160, true) }),
  agent_run_continue: action("向指定运行对应的原会话发送后续消息", "run_agent", { request, run: str("原运行 ID"), prompt: str("继续指令", 20_000) }),
  agent_draft_save: action("保存尚未运行的 Agent 上下文草稿", "run_agent", { request, draft: str("草稿 ID；新建时省略", 160, true), version, data: data("{title,agent,contexts:[节点ID/ref],prompt}") }),
  agent_draft_start: action("明确启动已保存的 Agent 草稿；重复请求不会重复运行", "run_agent", { request, draft: str("草稿 ID"), version }),
  agent_draft_continue: action("向草稿对应的同一会话发送后续消息", "run_agent", { request, draft: str("草稿 ID"), prompt: str("继续指令", 20_000) }),
  review_flag_open: action("显式提出异步待审或待决策问题；不自动阻塞其他工作", "edit_graph", { request, data: data("{kind:review|decision,title,background,options,related,sources,agent?,run?,affected}") }),
  review_flag_link: action("把受此问题影响的后续成果显式关联到待审标记", "edit_graph", { request, flag: str("待审问题 ID"), version, data: data("{affected:对象ID/ref[]}") }),
  review_flag_save: action("保存审查意见或答案；不唤醒 Agent", "edit_graph", { request, flag: str("待审问题 ID"), version, data: data("{answer,state:open|resolved,affected?:对象ID/ref[]}") }),
  review_flag_continue: action("明确发送已保存结果并继续正确的原会话", "run_agent", { request, flag: str("待审问题 ID"), version }),
  rule_save: action("维护自然语言规则、明确范围、阶段与可客观检查项", "edit_graph", { request, rule: str("规则 ID；新建时省略", 160, true), version, data: data("{title,instruction,motivation,enabled,scope,sources,stages,checks,conflicts,enforcement}") }),
  rule_check: action("检查指定上下文的适用规则并显露缺口/冲突；不运行 Agent", "read_project", { data: data("{agent?,contexts,stage:start|continue|completion}") }),
  candidates_save: action("审阅、编辑、删除和确认候选事项；不会发布或运行", "edit_graph", { request, batch: str("候选批次 ID"), version, data: data("{items:候选完整列表}", 196_608) }),
  candidates_publish: action("明确发布已确认候选；publish_execute 另需明确执行范围与资源映射", "edit_graph", { request, batch: str("候选批次 ID"), version, data: data("{mode:publish|publish_execute,execution?:{scope,agents,parallelism,prompt?}}") }),
  workflow_execution_stop: action("停止此批次继续派发；已运行任务仍由现有运行入口控制", "run_agent", { request, execution: str("执行 ID"), version }),
} as const;
