import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import {
  isHierarchyRelation,
  type ResearchNode,
  type WorkflowCheckResult,
  type WorkflowFlag,
  type WorkflowRule,
} from "@claude-bot/research-canvas-contract";
import type { ResearchContext, ResearchGraph } from "./graph.js";
import { digest } from "./validation.js";
import { hasTextFile } from "./text-files.js";

export function applicableRules(
  rules: WorkflowRule[],
  nodes: ResearchNode[],
  edges: { source: string; target: string; label: string; archived?: boolean }[],
  agent: string,
  contexts: string[],
  stage: "start" | "continue" | "completion",
): WorkflowRule[] {
  const ids = new Set(contexts);
  for (const node of nodes)
    if (ids.has(node.id) || (node.ref && ids.has(node.ref))) {
      ids.add(node.id);
      if (node.ref) ids.add(node.ref);
    }
  const ancestors = new Set(ids), frontier = [...ids];
  const parents = new Map<string, string[]>();
  for (const edge of edges)
    if (!edge.archived && isHierarchyRelation(edge.label))
      parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source]);
  while (frontier.length) {
    for (const parent of parents.get(frontier.pop()!) ?? [])
      if (!ancestors.has(parent)) {
        ancestors.add(parent); frontier.push(parent);
        const ref = nodes.find(node => node.id === parent)?.ref;
        if (ref) ancestors.add(ref);
      }
  }
  return rules.filter(rule => !rule.archived && rule.enabled && rule.stages.includes(stage) &&
    (rule.scope.kind === "project" ||
      rule.scope.kind === "agents" && rule.scope.ids.some(id => id === agent || id === "agent:" + agent) ||
      rule.scope.kind === "nodes" && rule.scope.ids.some(id => ids.has(id)) ||
      rule.scope.kind === "descendants" && rule.scope.ids.some(id => ancestors.has(id))));
}

export function checkRules(
  rules: WorkflowRule[],
  nodes: ResearchNode[],
  edges: { source: string; target: string; label: string; archived?: boolean }[],
  contexts: string[],
  body: (node: ResearchNode) => string | null,
): WorkflowCheckResult[] {
  const results: WorkflowCheckResult[] = [];
  const active = new Set(rules.map(rule => rule.id));
  const selected = nodes.filter(node => contexts.includes(node.id) || Boolean(node.ref && contexts.includes(node.ref)));
  for (const rule of rules) {
    for (const other of rule.conflicts)
      if (active.has(other))
        results.push({ rule: rule.id, title: rule.title, target: "", status: "conflict", detail: "同时适用的冲突规则：" + other, enforcement: rule.enforcement });
    const targets = rule.scope.kind === "nodes" || rule.scope.kind === "descendants"
      ? selected.filter(node => applicableRules([rule], nodes, edges, "", [node.id], rule.stages[0]).length > 0) : selected;
    for (const check of rule.checks) {
      if (check.kind === "manual") {
        results.push({ rule: rule.id, title: rule.title, target: "", status: "manual", detail: check.value, enforcement: rule.enforcement });
        continue;
      }
      if (!targets.length) {
        results.push({ rule: rule.id, title: rule.title, target: "", status: "manual", detail: "没有可供客观检查的关联对象；请明确任务上下文", enforcement: rule.enforcement });
        continue;
      }
      for (const node of targets) {
        let ok: boolean | null, detail: string;
        if (check.kind === "required_text") {
          const content = body(node);
          ok = content === null ? null : content.includes(check.value);
          detail = content === null ? "正文需经资源授权入口读取，尚未客观验证" : "正文应包含：" + check.value;
        } else if (check.kind === "required_relation") {
          ok = edges.some(edge => !edge.archived && edge.source === node.id && edge.label === check.value);
          detail = "应有出边：" + check.value;
        } else {
          const meta = node.data.meta;
          ok = Boolean(meta && typeof meta === "object" && !Array.isArray(meta) && String(meta[check.key] ?? "") === check.value);
          detail = "元数据应为 " + check.key + "=" + check.value;
        }
        results.push({ rule: rule.id, title: rule.title, target: node.id, status: ok === null ? "manual" : ok ? "passed" : "missing", detail, enforcement: rule.enforcement });
      }
    }
  }
  return results;
}

export function evaluateWorkflowRules(
  graph: ResearchGraph, context: ResearchContext, agent: string, contexts: string[],
  stage: "start" | "continue" | "completion",
) {
  graph.role(context);
  const nodes = [...graph.records<ResearchNode>(context.project, "nodes")].filter(node => !node.archived);
  const edges = [...graph.records<{ id: string; source: string; target: string; label: string; archived: boolean }>(context.project, "edges")];
  const rules = applicableRules([...graph.records<WorkflowRule>(context.project, "workflow-rules")], nodes, edges, agent, contexts, stage);
  return {
    rules,
    checks: checkRules(rules, nodes, edges, contexts, node => {
      const resource = graph.resolveResource(context.project, node.id);
      return hasTextFile(resource) ? graph.texts.read(context.project, resource).text : null;
    }),
  };
}

/**
 * One agent turn is one message, so the Runner's start/append prompt window
 * (384 KiB, inside the 512 KiB request envelope) is the genuine bound for a
 * composed task. Typed fields keep their own input bounds; nothing composed is cut.
 */
export const PROMPT_WINDOW_BYTES = Math.min(MACHINE_LIMITS.startMaxPromptBytes, MACHINE_LIMITS.appendMaxPromptBytes);
export function ensurePromptWindow(prompt: string, what = "任务、上下文与适用规则"): string {
  const bytes = Buffer.byteLength(prompt);
  if (bytes > PROMPT_WINDOW_BYTES)
    throw new Error(`${what}共 ${Math.ceil(bytes / 1024)} KiB，超过 Agent 单条消息的 ${PROMPT_WINDOW_BYTES / 1024} KiB；请缩小上下文或规则范围，完整材料可由 Agent 通过 ref_describe 按需读取`);
  return prompt;
}

/** Rules are context, not proof that a model complied. No default blocking policy. */
export function prepareWorkflowPrompt(
  graph: ResearchGraph, context: ResearchContext, agent: string, conversation: string,
  contexts: string[], stage: "start" | "continue", prompt: string,
): string {
  const { rules, checks } = evaluateWorkflowRules(graph, context, agent, contexts, stage);
  recordRuleFlags(graph, context, agent, conversation, contexts, stage, checks);
  const blocking = checks.filter(check => check.enforcement === "block" && (check.status !== "passed"));
  if (blocking.length) throw new Error("适用规则明确阻止此阶段：" + blocking.map(check => check.title + "：" + check.detail).join("；").slice(0, 450));
  const guidance = "撰写新卡片时，标题采用‘对象 + 操作／核心结论’，加入轮次、配置或论文位置以便区分；摘要用 1–3 句交代结果、依据、限制。已有结论不因格式建议自动改写。发现不可靠结果、风险或需要人的判断时，显式使用 review_flag_open 提问；后续成果受其影响时用 review_flag_link 关联。是否继续及如何继续依本任务说明决定。";
  if (!rules.length) return ensurePromptWindow(prompt + "\n\n" + guidance);
  const injected = [
    prompt,
    guidance,
    "适用的项目约束（自然语言提示不构成遵守保证；只按各规则明确阶段和范围检查）：",
    ...rules.map(rule => "- [" + rule.id + "] " + rule.title + "\n  适用范围：" + JSON.stringify(rule.scope) + "\n  " + rule.instruction + (rule.sources.length ? "\n  来源：" + rule.sources.map(source => source.source + (source.locator ? "#" + source.locator : "")).join("、") : "")),
    "本次客观检查：" + (checks.length ? checks.map(check => check.title + " / " + check.status + " / " + check.detail).join("；") : "没有配置客观检查，不能据此声称已通过。"),
    "发现不可靠结果、规则冲突或需要人的判断时，显式调用 review_flag_open 保留问题和相关对象；是否继续及如何继续由本任务指令决定。",
  ].join("\n\n");
  return ensurePromptWindow(injected);
}

export function recordRuleFlags(
  graph: ResearchGraph, context: ResearchContext, agent: string, conversation: string,
  contexts: string[], stage: string, checks: WorkflowCheckResult[],
): void {
  for (const check of checks.filter(item => item.status === "missing" || item.status === "conflict" || item.status === "manual" && item.enforcement === "block")) {
    const id = "ruleflag_" + digest([agent, conversation, check.rule, check.target, stage, check.status]).slice(0, 40);
    const previous = graph.repo.get<WorkflowFlag>(context.project, "workflow-flags", id);
    if (previous?.state === "open") continue;
    const stamp = graph.provenance(context);
    const flag: WorkflowFlag = {
      id, version: (previous?.version ?? 0) + 1, archived: false, created: previous?.created ?? stamp, updated: stamp,
      kind: check.status === "conflict" ? "decision" : "review",
      title: check.title + " · " + (check.status === "conflict" ? "规则冲突" : "检查缺口"),
      background: stage + " 阶段：" + check.detail,
      options: [], related: check.target ? [check.target] : contexts, affected: [],
      sources: [], agent, conversation, run: context.actor.run ?? null,
      state: "open", answer: null, answerRevision: (previous?.answerRevision ?? 0) + 1, sent: previous?.sent ?? [],
    };
    graph.repo.put(context.project, "workflow-flags", id, flag, previous?.version ?? 0);
  }
}
