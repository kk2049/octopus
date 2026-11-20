import { defineCustomPreview } from "@claude-bot/agent-view-preview";
import { project } from "../app/projection.js";
import { ResearchProgram } from "../src/ResearchProgram.js";

// Synthetic, explicitly unaccepted research for visual review. No real project data.
const base = { body: "演示资料：固定 seed=42。当前只有十组样本，尚不能外推。", source_level: "infer", critical: false, source: "demo:seed42", tags: ["demo"], links: [], parents: [] };
const events = [
  { type: "research_recorded", data: { ...base, id: "question", kind: "request", title: "并发能否提高科研效率？" } },
  { type: "research_forked", data: { id: "baseline", title: "固定预算的对照实验", purpose: "来自小林的问题；验证速度收益是否依赖额外预算。", base: "", head: "question", status: "active", delivery: "", review_main: "" } },
  { type: "research_recorded", data: { ...base, id: "data", kind: "dataset", title: "十组对照的原始数据", parents: ["question"] } },
  { type: "research_advanced", data: { branch: "baseline", head: "data", reason: "完成同预算对照" } },
  { type: "research_delivered", data: { branch: "baseline", main: "", record: { ...base, id: "delivery", kind: "delivery", title: "负结果：收益尚未得到证明", parents: ["data"], critical: true, body: "## 结论\n同预算下暂无显著提升。\n\n## 复现\n固定 seed=42，核对十组原始数据。\n\n## 局限\n样本量小，不能外推其他模型。\n\n## 请人判断\n是否接受这一范围内的负结果？", links: [{ relation: "uses", target: "data" }] } } },
  { type: "research_forked", data: { id: "measurement", title: "复核计时与成本", purpose: "从原始数据分叉，检查等待和缓存成本是否遗漏。", base: "", head: "data", status: "active", delivery: "", review_main: "" } },
  { type: "research_confirmation_requested", data: { id: "confirm", target: "delivery", question: "我们是否接受这个限定范围内的负结果？" } },
  { type: "research_recorded", data: { ...base, id: "teaching", kind: "briefing", title: "你离开之后：两条探索与一份待审交付", body: "小林提出了效率问题；实验分支得到了负结果，小周正在复核计时。建议先看原始数据，再检查样本局限。阅读本文还不代表你已经学习或同意。", links: [{ relation: "uses", target: "delivery" }, { relation: "uses", target: "data" }] } },
].map((e, i) => ({ ...e, seq: i + 1, by: i % 2 ? "agent:researcher@demo-zhou" : "agent:secretary@demo-lin", at: "2026-09-05T04:00:00Z" }));
const collaboration = project(events, { viewer: { kind: "user", user: "demo-lin", role: "owner" } });

const projection = {
  research: collaboration.research,
  secretary_messages: collaboration.secretary_messages,
  session_archives: [],
  workspace_navigation: { current_ref: "asi_demo_science", projects: [
    { ref: "asi_demo_science", title: "可验证自动科研", archived: false },
    { ref: "asi_demo_causal", title: "因果证据与复现", archived: false },
    { ref: "asi_demo_cost", title: "算力成本研究", archived: false },
  ] },
  available: true,
  viewer_role: "owner",
  project: {
    title: "可验证自动科研",
    funding_label: "Research Grant · RG-27",
    summary: "围绕可复现的多 Agent 研究管线，持续汇总实验、证据与下一步。",
    archived: false,
  },
  controls: {
    can_configure: true, can_publish: true, can_bind: true, can_archive: true, can_reopen: false,
    membership_surface: "trusted_outer",
  },
  workspaces: [
    { key: "ws-evals", label: "evals/autonomous-science", updated_at: "2026-08-27T13:48:00Z" },
    { key: "ws-papers", label: "papers/evidence-map", updated_at: "2026-08-27T12:30:00Z" },
  ],
  agents: [
    { key: "lead", label: "Lead Synthesizer", provider: "codex", workspace_key: "ws-evals", session_key: "session-lead", status: "active", updated_at: "2026-08-27T13:48:00Z" },
    { key: "reviewer", label: "Evidence Reviewer", provider: "claude", workspace_key: "ws-evals", session_key: "session-review", status: "waiting", updated_at: "2026-08-27T13:41:00Z" },
    { key: "mapper", label: "Paper Mapper", provider: "omp", workspace_key: "ws-papers", session_key: "session-map", status: "idle", updated_at: "2026-08-27T12:30:00Z" },
  ],
  sessions: [
    { session_key: "session-lead", resourceId: "session-lead", agent_key: "lead", workspace_key: "ws-evals", cliKind: "codex", title: "Synthesis run · evidence convergence", preview: "The latest evaluation closes two open hypotheses.", status: "active", lastActivity: "2026-08-27T13:48:00Z", messageCount: 3 },
    { session_key: "session-review", resourceId: "session-review", agent_key: "reviewer", workspace_key: "ws-evals", cliKind: "claude", title: "Adversarial evidence review", preview: "Waiting for the new ablation table.", status: "waiting", lastActivity: "2026-08-27T13:41:00Z", messageCount: 2 },
    { session_key: "session-map", resourceId: "session-map", agent_key: "mapper", workspace_key: "ws-papers", cliKind: "omp", title: "Literature topology", preview: "Mapped 18 sources into four claims.", status: "idle", lastActivity: "2026-08-27T12:30:00Z", messageCount: 1 },
  ],
  transcripts: {
    "session-lead": {
      sessionId: "session-lead", cliKind: "codex", rich: true, offset: 0, totalMessages: 3, hasMore: false,
      messages: [
        { role: "user", timestamp: "2026-08-27T13:31:00Z", blocks: [{ type: "text", text: "Compare the latest ablation with our registered hypothesis." }] },
        { role: "assistant", timestamp: "2026-08-27T13:42:00Z", blocks: [{ type: "text", text: "The primary effect survives the control. I updated `reports/current-status.md` and kept the negative result explicit." }] },
        { role: "assistant", timestamp: "2026-08-27T13:48:00Z", blocks: [{ type: "text", text: "Next: have the reviewer challenge the causal claim before the next run." }] },
      ],
    },
    "session-review": { sessionId: "session-review", cliKind: "claude", rich: true, offset: 0, totalMessages: 1, hasMore: false, messages: [{ role: "assistant", timestamp: "2026-08-27T13:41:00Z", blocks: [{ type: "text", text: "I need the new ablation table before closing the review." }] }] },
    "session-map": { sessionId: "session-map", cliKind: "omp", rich: true, offset: 0, totalMessages: 1, hasMore: false, messages: [{ role: "assistant", timestamp: "2026-08-27T12:30:00Z", blocks: [{ type: "text", text: "Four claim clusters now cover all 18 sources." }] }] },
  },
  documents: [
    { key: "current", path: "reports/current-status.md", title: "Current research status", summary: "The registered effect survives the control; causal interpretation remains under review.", body: "# Current research status\n\n## What changed\n\n- Primary evaluation reproduced.\n- Negative control stayed below the threshold.\n- Causal wording remains **provisional**.\n\n## Next gate\n\nEvidence Reviewer must challenge the causal claim before the next run.", workspace_key: "ws-evals", workspace_label: "evals/autonomous-science", updated_at: "2026-08-27T13:46:00Z", updated_by: "agent:research-program/mcp@lht" },
    { key: "map", path: "papers/evidence-map.md", title: "Evidence map", summary: "18 sources grouped into four claims.", body: "# Evidence map\n\nThe map records supporting, conflicting and missing evidence separately.", workspace_key: "ws-papers", workspace_label: "papers/evidence-map", updated_at: "2026-08-27T12:30:00Z", updated_by: "agent:research-program/mcp@lht" },
  ],
  lead_agent: { agent_key: "lead", agent_label: "Lead Synthesizer", session_key: "session-lead", session_title: "Synthesis run · evidence convergence", reason: "Newest cross-workspace synthesis", at: "2026-08-27T13:49:00Z", by: "lht" },
  lead_document: { document_key: "current", document_title: "Current research status", document_path: "reports/current-status.md", reason: "Canonical status report", at: "2026-08-27T13:49:00Z", by: "lht" },
  lead_agent_history: [{ agent_key: "lead", agent_label: "Lead Synthesizer", session_key: "session-lead", session_title: "Synthesis run · evidence convergence", reason: "Newest cross-workspace synthesis", at: "2026-08-27T13:49:00Z", by: "lht" }],
  lead_document_history: [{ document_key: "current", document_title: "Current research status", document_path: "reports/current-status.md", reason: "Canonical status report", at: "2026-08-27T13:49:00Z", by: "lht" }],
  activity: collaboration.activity,
};

export default defineCustomPreview({
  kind: "custom",
  app: "research-program",
  title: "自动科研项目台",
  projection,
  actions: {
    research_record: { ok: false, code: "fixture_only", message: "这里是演示资料；正式记录需要项目通道。" },
    research_fork: { ok: false, code: "fixture_only", message: "这里是演示资料；正式分支需要项目通道。" },
    research_attest: { ok: false, code: "fixture_only", message: "演示不保存本人确认。" },
    ask_secretary: { ok: false, code: "fixture_only", message: "演示不唤醒真实秘书。" },
    configure_project: { ok: true },
    set_lead_agent: { ok: true },
    set_lead_document: { ok: true },
    archive_project: { ok: true },
    reopen_project: { ok: true },
  },
  render: () => <ResearchProgram />,
});
