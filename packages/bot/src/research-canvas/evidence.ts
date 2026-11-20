import type { EvidenceSelection, ResearchEvidence, ResearchNode, Provenance } from "@claude-bot/research-canvas-contract";
import type { ResearchContext, ResearchGraph } from "./graph.js";
import { digest, parse, text } from "./validation.js";

interface Adoption { id: string; report: string; by: Provenance }
const lists = ["code", "frameworks", "runs", "artifacts", "charts", "sources"] as const;
const sections = ["motivation", "goal", "design", "execution", "results", "analysis"] as const;
const labels = { motivation: "动机", goal: "目标", design: "设计与方法", execution: "执行方式", results: "结果", analysis: "分析" };
export function evidenceMarkdown(report: Omit<ResearchEvidence, "id" | "node" | "created" | "sequence">): string {
  return [`# ${report.title}`, `结论类别：${{ observation: "观测结果", inference: "推导结论", hypothesis: "尚待验证的设想" }[report.claim]}`, `## 关键结论\n\n${report.conclusion}`,
    ...sections.map(key => `## ${labels[key]}\n\n${report[key]}`),
    `## 配置\n\n${report.configuration || "无额外配置"}`, `## 局限与异常\n\n${report.limitations || "作者未补充局限；不代表没有局限"}`,
    ...lists.filter(key => report[key].length).map(key => `## ${key}\n\n${report[key].map(ref => `- ${ref}`).join("\n")}`)].join("\n\n");
}

/** Reports are immutable observations; adoption is a separate, explicit human choice. */
export class ResearchEvidenceService {
  constructor(private readonly graph: ResearchGraph, private readonly changed: (project: string) => void) {}
  publish(context: ResearchContext, params: Record<string, string>) {
    this.graph.authorize(context, "edit_graph");
    const request = text(params.request, "请求 ID", 100), fingerprint = digest({ action: "evidence_publish", params });
    const actor = `evidence:${context.actor.kind}:${context.actor.owner}:${context.actor.agent ?? ""}`;
    const prior = this.graph.repo.receipt(context.project, actor, request, fingerprint);
    if (prior) return prior;
    const data = parse(params.data);
    if (Object.keys(data).some(key => !["title", "series", "kind", "claim", "conclusion", "configuration", "limitations", ...lists, ...sections].includes(key))) throw new Error("报告包含未知字段");
    const kind = text(data.kind, "研究类型", 20) as ResearchEvidence["kind"], claim = text(data.claim, "结论类别", 20) as ResearchEvidence["claim"];
    if (!["experiment", "literature", "theory"].includes(kind) || !["observation", "inference", "hypothesis"].includes(claim)) throw new Error("研究类型或结论类别无效");
    const checked = Object.fromEntries(lists.map(key => {
      const refs = data[key] ?? [];
      if (!Array.isArray(refs) || refs.length > 40 || refs.some(value => typeof value !== "string")) throw new Error("证据引用须为至多 40 项的节点列表");
      const unique = [...new Set(refs as string[])];
      for (const ref of unique) this.graph.node(context.project, ref);
      return [key, unique];
    })) as Pick<ResearchEvidence, typeof lists[number]>;
    if (kind === "experiment" && (!checked.code.length || !checked.frameworks.length || !checked.runs.length || !checked.artifacts.length)) throw new Error("实验报告须关联代码版本、测试框架、运行轮次和原始产物");
    if (kind !== "experiment" && !checked.sources.length) throw new Error("调研和理论报告须关联原始来源");
    const body = {
      title: text(data.title, "报告标题", 200), series: text(data.series, "报告系列", 160), kind, claim,
      conclusion: text(data.conclusion, "关键结论", 1800),
      configuration: text(data.configuration, "配置", 6000, ""), limitations: text(data.limitations, "局限", 6000, ""),
      ...Object.fromEntries(sections.map(key => [key, text(data[key], labels[key], 10000)])) as Pick<ResearchEvidence, typeof sections[number]>, ...checked,
    };
    const id = "report_" + digest([context.project, actor, request]).slice(0, 40);
    // A retry after a graph/file write resumes with deterministic identities, never duplicates reports.
    const registered = this.graph.mutate(context, "node_add", {
      request: `report-node:${id}`, data: JSON.stringify({ type: "finding", title: body.title, summary: body.conclusion, data: { text: "", meta: { evidenceKind: "report", reportId: id, reportSeries: body.series, claim: body.claim, read_only: true } } }),
    }) as { node: ResearchNode };
    const report: ResearchEvidence = { id, node: registered.node.id, ...body, created: registered.node.created, sequence: this.graph.repo.cursor(context.project) + 1 };
    const resource = this.graph.resolveResource(context.project, report.node);
    const stored = this.graph.repo.get<ResearchEvidence>(context.project, "evidence-reports", id);
    if (!stored) {
      this.graph.texts.write(context.project, resource, evidenceMarkdown(body));
      for (const key of lists) for (const ref of report[key]) {
        this.graph.mutate(context, "edge_add", { request: `evidence-edge:${digest([id, key, ref]).slice(0, 48)}`, source: ref, target: report.node, label: key === "sources" ? "source_of" : `evidence:${key}` });
      }
      this.graph.repo.put(context.project, "evidence-reports", id, report, 0);
    }
    const result = { report: stored ?? report };
    this.graph.repo.remember(context.project, actor, request, fingerprint, result);
    this.changed(context.project);
    return result;
  }
  private find(context: ResearchContext, key: string): ResearchEvidence {
    this.graph.role(context);
    const direct = this.graph.repo.get<ResearchEvidence>(context.project, "evidence-reports", key);
    if (direct) return direct;
    const node = this.graph.node(context.project, key), meta = node.data.meta;
    const report = meta && typeof meta === "object" && !Array.isArray(meta) && typeof meta.reportId === "string"
      ? this.graph.repo.get<ResearchEvidence>(context.project, "evidence-reports", meta.reportId) : null;
    if (!report) throw new Error("该节点没有已归档报告");
    return report;
  }
  read(context: ResearchContext, key: string): EvidenceSelection {
    const report = this.find(context, key);
    const all = [...this.graph.records<ResearchEvidence>(context.project, "evidence-reports")].filter(row => row.series === report.series).sort((a, b) => b.sequence - a.sequence);
    const adoption = this.graph.repo.get<Adoption>(context.project, "evidence-adoptions", report.series);
    return { report, latest: all[0] ?? report, adopted: adoption ? all.find(row => row.id === adoption.report) ?? null : null, adoptedBy: adoption?.by ?? null };
  }
  list(context: ResearchContext, after = "") {
    this.graph.role(context);
    const rows = this.graph.repo.list<ResearchEvidence>(context.project, "evidence-reports", after, 51);
    return { reports: rows.slice(0, 50).map(row => this.read(context, row.id)), next: rows.length > 50 ? rows[49].id : null };
  }
  adopt(context: ResearchContext, params: Record<string, string>) {
    this.graph.authorize(context, "edit_graph");
    if (context.actor.kind !== "human") throw new Error("采纳报告需要人的明确动作");
    const request = text(params.request, "请求 ID", 100), fingerprint = digest({ action: "evidence_adopt", params });
    return this.graph.repo.atomic(() => {
      const prior = this.graph.repo.receipt(context.project, context.actor.owner, request, fingerprint);
      if (prior) return prior;
      const report = this.find(context, params.node), current = this.graph.repo.get<Adoption>(context.project, "evidence-adoptions", report.series);
      if ((current?.report ?? "") !== (params.expected ?? "")) throw new Error("采纳记录已变化，请重新读取");
      this.graph.repo.put(context.project, "evidence-adoptions", report.series, { id: report.series, report: report.id, by: this.graph.provenance(context) });
      const result = this.read(context, report.id);
      this.graph.repo.remember(context.project, context.actor.owner, request, fingerprint, result);
      this.changed(context.project);
      return result;
    });
  }
}
