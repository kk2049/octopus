import { useEffect, useState } from "react";
import type { ResearchNode, WorkflowCheckResult, WorkflowRule } from "@claude-bot/research-canvas-contract";
import { persist, stored, type Call } from "./client.js";
import { useWorkflowActions } from "./workflow-client.js";

type RuleForm = Pick<WorkflowRule, "title" | "instruction" | "motivation" | "enabled" | "scope" | "sources" | "stages" | "checks" | "conflicts" | "enforcement">;
export function WorkflowRules({ rule, rules, nodes, selected, call, editable, storageKey, onSaved }: {
  rule?: WorkflowRule; rules: WorkflowRule[]; nodes: ResearchNode[]; selected: string[];
  call: Call; editable: boolean; storageKey: string; onSaved(rule: WorkflowRule): void;
}) {
  const key = storageKey + ":rule:" + (rule?.id ?? "new");
  const [form, setForm] = useState<RuleForm>(() => stored(key, rule ?? { title: "", instruction: "", motivation: "", enabled: true, scope: { kind: "nodes", ids: selected }, sources: [], stages: ["start", "continue"], checks: [], conflicts: [], enforcement: "inform" }));
  const [baseVersion, setBaseVersion] = useState(() => stored(key + ":base", rule?.version ?? 0));
  const [checkKind, setCheckKind] = useState("required_text"), [checkValue, setCheckValue] = useState(""), [checkKey, setCheckKey] = useState("");
  const [source, setSource] = useState(""), [checks, setChecks] = useState<WorkflowCheckResult[] | null>(null), [stage, setStage] = useState("completion");
  const { run, pending, error, setError } = useWorkflowActions(call, key);
  useEffect(() => { persist(key, form); persist(key + ":base", baseVersion); }, [key, form, baseVersion]);
  return <section className="rv-workflow-editor" aria-label="适用规则维护">
    <label>规则标题<input disabled={!editable} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
    <label>自然语言约束<textarea disabled={!editable} value={form.instruction} onChange={event => setForm({ ...form, instruction: event.target.value })} /></label>
    <label>形成原因<textarea disabled={!editable} value={form.motivation} onChange={event => setForm({ ...form, motivation: event.target.value })} /></label>
    <label>适用范围<select disabled={!editable} value={form.scope.kind} onChange={event => { const kind = event.target.value as WorkflowRule["scope"]["kind"]; setForm({ ...form, scope: kind === "project" ? { kind, ids: [] } : { kind, ids: [] } }); }}><option value="nodes">指定对象</option><option value="descendants">指定目标及后代</option><option value="agents">指定 Agent</option><option value="project">整个项目（显式选择）</option></select></label>
    {form.scope.kind !== "project" && <select aria-label="规则适用对象" multiple disabled={!editable} value={form.scope.ids} onChange={event => setForm({ ...form, scope: { kind: form.scope.kind as "nodes" | "descendants" | "agents", ids: Array.from(event.target.selectedOptions, option => option.value) } })}>{nodes.filter(node => form.scope.kind !== "agents" || node.type === "agent").map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select>}
    <fieldset disabled={!editable}><legend>注入或检查阶段</legend>{(["start", "continue", "completion"] as const).map(value => <label key={value}><input type="checkbox" checked={form.stages.includes(value)} onChange={event => setForm({ ...form, stages: event.target.checked ? [...form.stages, value] : form.stages.filter(stage => stage !== value) })} />{value === "start" ? "启动" : value === "continue" ? "继续" : "完成检查"}</label>)}</fieldset>
    <label>检查缺口处理<select disabled={!editable} value={form.enforcement} onChange={event => setForm({ ...form, enforcement: event.target.value as "inform" | "block" })}><option value="inform">指出缺口，按任务说明决定后续</option><option value="block">本规则明确阻止所选阶段</option></select></label>
    <fieldset disabled={!editable}><legend>可客观检查的要求</legend>
      <select aria-label="规则检查类型" value={checkKind} onChange={event => setCheckKind(event.target.value)}><option value="required_text">正文包含文本</option><option value="required_relation">有指定出边</option><option value="required_metadata">元数据值</option><option value="manual">需要人工核对</option></select>
      {checkKind === "required_metadata" && <input aria-label="元数据键" value={checkKey} onChange={event => setCheckKey(event.target.value)} />}
      <input aria-label="检查依据" value={checkValue} onChange={event => setCheckValue(event.target.value)} />
      <button disabled={!checkValue.trim() || checkKind === "required_metadata" && !checkKey.trim()} onClick={() => { const check: WorkflowRule["checks"][number] = checkKind === "required_metadata" ? { kind: "required_metadata", key: checkKey, value: checkValue } : { kind: checkKind as "required_text" | "required_relation" | "manual", value: checkValue }; setForm({ ...form, checks: [...form.checks, check] }); setCheckValue(""); }}>加入检查</button>
      <ul>{form.checks.map((check, index) => <li key={index}>{check.kind} · {check.value}<button onClick={() => setForm({ ...form, checks: form.checks.filter((_, position) => position !== index) })}>移除检查</button></li>)}</ul>
    </fieldset>
    <label>已知冲突规则<select multiple disabled={!editable} value={form.conflicts} onChange={event => setForm({ ...form, conflicts: Array.from(event.target.selectedOptions, option => option.value) })}>{rules.filter(item => item.id !== rule?.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <label>来源引用<input disabled={!editable} value={source} onChange={event => setSource(event.target.value)} /></label><button disabled={!editable || !source.trim()} onClick={() => { setForm({ ...form, sources: [...form.sources, { source }] }); setSource(""); }}>加入来源</button>
    <ul>{form.sources.map((source, index) => <li key={index}>{source.source}<button disabled={!editable} onClick={() => setForm({ ...form, sources: form.sources.filter((_, position) => position !== index) })}>移除来源</button></li>)}</ul>
    <label><input type="checkbox" disabled={!editable} checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} />启用规则</label>
    <p className="rv-muted">规则按范围和阶段注入当前会话。提示词不能保证遵守；客观检查结果与人工核对分开展示。</p>
    <button disabled={!editable || !!pending || !form.title.trim() || !form.instruction.trim()} onClick={async () => { const result = await run<{ rule: WorkflowRule }>("rule_save", { rule: rule?.id, version: baseVersion, data: form }); if (result) { setBaseVersion(result.rule.version); onSaved(result.rule); } }}>保存规则</button>
    <label>检查阶段<select value={stage} onChange={event => setStage(event.target.value)}><option value="start">启动</option><option value="continue">继续</option><option value="completion">完成</option></select></label>
    <button disabled={!!pending || !selected.length} onClick={async () => { try { const result = await call<{ checks: WorkflowCheckResult[] }>("rule_check", { data: { contexts: selected, stage } }); setChecks(result.checks); setError(""); } catch (reason) { setError(String(reason)); } }}>检查当前选中对象</button>
    {checks && <ul>{checks.map((check, index) => <li key={index}>{check.title} · {check.status} · {check.detail}</li>)}</ul>}
    {rule && rule.version !== baseVersion && <button onClick={() => { setForm(rule); setBaseVersion(rule.version); }}>重新载入当前规则版本</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
