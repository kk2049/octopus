import fs from "node:fs";
import path from "node:path";

import type {
  ArchitectureAnnotation,
  ArchitectureConstraintDefinition,
  ConstraintViolation,
  ConstraintResult,
  DependencyFact,
  EvidenceReference,
  FileFact,
  FlowFact,
  TcbFact,
} from "../shared/model.js";
import type { ExternalFileDependencyEdge, FileDependencyEdge } from "./dependencies.js";
import { adjacency, shortestPath, stronglyConnectedComponents } from "./graph.js";
import { normalizeRepoPath } from "./paths.js";

function list(value?: string): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function violation(witness: string, message: string, extra: Omit<ConstraintViolation, "witness" | "message"> = {}): ConstraintViolation {
  return { witness, message, ...extra };
}

function pathWitness(path: string[]): string {
  return `path:${path.join(" -> ")}`;
}

function annotationEvidence(constraintId: string, annotations: ArchitectureAnnotation[]): EvidenceReference[] {
  const output: EvidenceReference[] = [];
  for (const annotation of annotations) {
    if (list(annotation.attributes.enforces).includes(constraintId)) {
      output.push({
        grade: "declared",
        label: annotation.attributes.label ? `实现标注：${annotation.attributes.label}` : "源码中的实现标注",
        source: annotation.source,
      });
    }
    if (list(annotation.attributes.verifies).includes(constraintId)) {
      output.push({
        grade: "executable",
        label: annotation.attributes.label ? `可执行证据：${annotation.attributes.label}` : "源码中的可执行证据",
        source: annotation.source,
      });
    }
  }
  return output;
}

function dependencyEdges(dependencies: DependencyFact[], includeTypeOnly: boolean): Array<{ from: string; to: string }> {
  return dependencies
    .filter((edge) => edge.runtimeCount > 0 || (includeTypeOnly && edge.typeOnlyCount > 0))
    .map((edge) => ({ from: edge.from, to: edge.to }));
}

function shortestCycleWitness(
  component: string[],
  edges: Array<{ from: string; to: string }>,
): string[] {
  const members = new Set(component);
  const internal = edges.filter((edge) => members.has(edge.from) && members.has(edge.to));
  const graph = adjacency(internal);
  let best: string[] | undefined;
  for (const edge of internal) {
    const returnPath = shortestPath(graph, edge.to, edge.from);
    if (!returnPath) continue;
    const candidate = [edge.from, ...returnPath];
    if (!best || candidate.length < best.length) best = candidate;
  }
  return best ?? component;
}

interface TcbBudget {
  entries: string[];
  tolerance: number;
  baseline: Record<string, number>;
  critical: string[];
  justifications?: Array<{ file: string; lines: number; why: string }>;
}

function evaluateTcb(args: {
  root: string;
  constraintId: string;
  budgetFile: string;
  fileEdges: FileDependencyEdge[];
  files: FileFact[];
}): { fact: TcbFact; status: ConstraintResult["status"]; summary: string } {
  const budgetPath = path.resolve(args.root, args.budgetFile);
  const budget = JSON.parse(fs.readFileSync(budgetPath, "utf8")) as TcbBudget;
  const sourceDir = normalizeRepoPath(path.relative(args.root, path.join(path.dirname(budgetPath), "src")));
  const entries = budget.entries.map((entry) => normalizeRepoPath(path.join(sourceDir, entry)));
  const graph = adjacency(args.fileEdges.filter((edge) => !edge.typeOnly));
  const closure = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (closure.has(current)) continue;
    closure.add(current);
    for (const target of graph.get(current) ?? []) queue.push(target);
  }
  const filesByPath = new Map(args.files.map((file) => [file.path, file]));
  const facts = [...closure].sort().map((file) => {
    const relative = normalizeRepoPath(path.posix.relative(sourceDir, file));
    const baseline = budget.baseline[relative];
    const codeLoc = filesByPath.get(file)?.codeLoc ?? 0;
    return {
      path: file,
      codeLoc,
      baseline,
      critical: budget.critical.includes(relative),
      delta: baseline === undefined ? undefined : codeLoc - baseline,
    };
  });
  const closureNames = new Set(facts.map((fact) => normalizeRepoPath(path.posix.relative(sourceDir, fact.path))));
  const unregistered = facts
    .filter((fact) => fact.baseline === undefined)
    .map((fact) => normalizeRepoPath(path.posix.relative(sourceDir, fact.path)));
  const stale = Object.keys(budget.baseline).filter((file) => !closureNames.has(file));
  const total = facts.reduce((sum, fact) => sum + fact.codeLoc, 0);
  const baseline = Object.values(budget.baseline).reduce((sum, value) => sum + value, 0);
  const delta = total - baseline;
  const covered = (budget.justifications ?? []).reduce((sum, item) => sum + item.lines, 0);
  const needsReview = unregistered.length > 0 || stale.length > 0 || delta < -20 || (delta > budget.tolerance && covered < delta);
  const fact: TcbFact = {
    constraintId: args.constraintId,
    budgetFile: args.budgetFile,
    entries,
    files: facts,
    total,
    baseline,
    tolerance: budget.tolerance,
    delta,
    unregistered,
    stale,
  };
  const summary = needsReview
    ? `可信闭包 ${total} 行（baseline ${baseline}，${delta >= 0 ? "+" : ""}${delta}）；需要人工重新准入`
    : `可信闭包 ${total} 行（baseline ${baseline}，容差 ${budget.tolerance}）`;
  return { fact, status: needsReview ? "review" : "pass", summary };
}

export function evaluateConstraints(args: {
  root: string;
  definitions: ArchitectureConstraintDefinition[];
  dependencies: DependencyFact[];
  externalFileEdges: ExternalFileDependencyEdge[];
  fileEdges: FileDependencyEdge[];
  files: FileFact[];
  flows: FlowFact[];
  annotations: ArchitectureAnnotation[];
}): { constraints: ConstraintResult[]; tcbs: TcbFact[] } {
  const output: ConstraintResult[] = [];
  const tcbs: TcbFact[] = [];
  const flowById = new Map(args.flows.map((flow) => [flow.id, flow]));

  for (const definition of args.definitions) {
    const evidence = [...(definition.evidence ?? []), ...annotationEvidence(definition.id, args.annotations)];
    const base = { ...definition, evidence, violations: [], waivedViolations: [] };
    const mechanism = definition.mechanism;
    if (!mechanism) {
      output.push({ ...base, status: "review", summary: `声明性约束；${evidence.length} 条证据可供审阅` });
      continue;
    }
    if (mechanism.kind === "forbid-dependency") {
      const edges = dependencyEdges(args.dependencies, mechanism.includeTypeOnly ?? false);
      const graph = adjacency(edges);
      const violations: ConstraintResult["violations"] = [];
      for (const from of mechanism.from) {
        for (const to of mechanism.to) {
          const pathFound = mechanism.transitive
            ? shortestPath(graph, from, to)
            : (edges.some((edge) => edge.from === from && edge.to === to) ? [from, to] : null);
          if (!pathFound) continue;
          const direct = args.dependencies.find((edge) => edge.from === pathFound[0] && edge.to === pathFound[1]);
          violations.push({
            witness: pathWitness(pathFound),
            message: `${from} ${mechanism.transitive ? "可达" : "直接依赖"} ${to}`,
            path: pathFound,
            source: direct?.samples[0]?.source,
          });
        }
      }
      output.push({
        ...base,
        status: violations.length ? "fail" : "pass",
        summary: violations.length ? `发现 ${violations.length} 条禁止依赖路径` : "未发现禁止依赖路径",
        violations,
      });
      continue;
    }
    if (mechanism.kind === "forbid-external") {
      const patterns = mechanism.patterns.map((pattern) => new RegExp(pattern));
      let reachable: Set<string> | undefined;
      if (mechanism.entrypoints) {
        const knownFiles = new Set(args.files.map((file) => file.path));
        const missing = mechanism.entrypoints.filter((entrypoint) => !knownFiles.has(entrypoint));
        if (missing.length > 0) {
          output.push({
            ...base,
            status: "fail",
            summary: `入口文件不存在：${missing.join("、")}`,
            violations: missing.map((entrypoint) => violation(
              `entrypoint:${entrypoint}`,
              `缺少入口文件 ${entrypoint}`,
              { source: { path: entrypoint, line: 1 } },
            )),
          });
          continue;
        }
        const testFiles = new Set(args.files.filter((file) => file.isTest).map((file) => file.path));
        const graph = new Map<string, Set<string>>();
        for (const edge of args.fileEdges) {
          if (edge.typeOnly || testFiles.has(edge.from)) continue;
          const targets = graph.get(edge.from) ?? new Set<string>();
          targets.add(edge.to);
          graph.set(edge.from, targets);
        }
        reachable = new Set(mechanism.entrypoints);
        const queue = [...mechanism.entrypoints];
        for (let index = 0; index < queue.length; index += 1) {
          for (const target of graph.get(queue[index]) ?? []) {
            if (reachable.has(target)) continue;
            reachable.add(target);
            queue.push(target);
          }
        }
      }
      const matchedByPackage = new Map<string, ExternalFileDependencyEdge>();
      for (const edge of args.externalFileEdges) {
        if (edge.test || (!mechanism.includeTypeOnly && edge.typeOnly)) continue;
        if (!mechanism.from.includes(edge.fromModule)) continue;
        if (reachable && !reachable.has(edge.source)) continue;
        if (!patterns.some((pattern) => pattern.test(edge.package))) continue;
        matchedByPackage.set(`${edge.fromModule}->${edge.package}`, edge);
      }
      const matches = [...matchedByPackage.values()];
      output.push({
        ...base,
        status: matches.length ? "fail" : "pass",
        summary: matches.length ? `发现 ${matches.length} 条禁止的外部依赖` : "未发现禁止的外部依赖",
        violations: matches.map((edge) => violation(
          `external:${edge.fromModule} -> ${edge.package}`,
          `${edge.fromModule} imports ${edge.package}`,
          { source: edge.sample.source },
        )),
      });
      continue;
    }
    if (mechanism.kind === "no-cycles") {
      const selected = mechanism.modules ? new Set(mechanism.modules) : null;
      const edges = dependencyEdges(args.dependencies, false).filter((edge) => !selected || (selected.has(edge.from) && selected.has(edge.to)));
      const graph = adjacency(edges, selected ?? undefined);
      const cycles = stronglyConnectedComponents(graph).filter((component) => component.length > 1);
      const witnesses = cycles.map((component) => shortestCycleWitness(component, edges));
      output.push({
        ...base,
        status: cycles.length ? "fail" : "pass",
        summary: cycles.length ? `发现 ${cycles.length} 个跨模块强连通分量` : "模块非测试值依赖无环",
        violations: witnesses.map((cycle) => {
          const first = args.dependencies.find((edge) => edge.from === cycle[0] && edge.to === cycle[1]);
          return {
            witness: pathWitness(cycle),
            message: `最短循环见证：${cycle.join(" → ")}`,
            path: cycle,
            source: first?.samples.find((sample) => !sample.test && !sample.typeOnly)?.source,
          };
        }),
      });
      continue;
    }
    if (mechanism.kind === "flow-complete") {
      const flow = flowById.get(mechanism.flow);
      const present = new Set(flow?.steps.map((step) => step.id) ?? []);
      const missing = mechanism.requiredSteps.filter((step) => !present.has(step));
      const duplicate = flow?.duplicateAnchors ?? [];
      const missingAnchors = flow?.missingAnchors ?? [];
      const missingPredecessors = flow?.missingPredecessors ?? [];
      const cycles = flow?.cycles ?? [];
      const byStep = new Map(flow?.steps.map((step) => [step.id, step]) ?? []);
      const requiredEdges = mechanism.requiredEdges ?? [];
      const missingEdges = requiredEdges.filter(({ from, to }) => !byStep.get(to)?.after?.includes(from));
      const missingTerminals = (mechanism.requiredTerminals ?? []).filter((step) => !byStep.get(step)?.terminal);
      const successors = new Set(flow?.steps.flatMap((step) => step.after ?? []) ?? []);
      const unterminatedLeaves = (flow?.steps ?? []).filter((step) => !successors.has(step.id) && !step.terminal);
      const witnessPrefix = `flow:${mechanism.flow}`;
      const violations = [
        ...(flow ? [] : [violation(`${witnessPrefix}:missing-flow`, `找不到流程 ${mechanism.flow}`)]),
        ...(flow && !flow.coverage ? [violation(`${witnessPrefix}:missing-coverage`, "流程未声明 coverage.scope 与完整性边界")] : []),
        ...missing.map((step) => violation(`${witnessPrefix}:missing-step:${step}`, `缺少步骤 ${step}`)),
        ...missingAnchors.map((step) => violation(`${witnessPrefix}:missing-anchor:${step}`, `步骤 ${step} 没有源码锚点`)),
        ...duplicate.map((step) => violation(`${witnessPrefix}:duplicate-anchor:${step}`, `步骤 ${step} 有多个源码锚点`)),
        ...missingPredecessors.map(({ stepId, predecessorId }) => violation(
          `${witnessPrefix}:missing-predecessor:${stepId}<-${predecessorId}`,
          `步骤 ${stepId} 引用了不存在的前驱 ${predecessorId}`,
        )),
        ...cycles.map((cycle) => violation(`${witnessPrefix}:${pathWitness(cycle)}`, `流程存在循环：${cycle.join(" → ")}`, { path: cycle })),
        ...(flow?.invalidAttributes ?? []).map((message) => violation(`${witnessPrefix}:invalid-attribute:${message}`, `标注属性无效：${message}`)),
        ...missingEdges.map(({ from, to }) => violation(`${witnessPrefix}:missing-edge:${from}->${to}`, `缺少契约边 ${from} → ${to}`)),
        ...missingTerminals.map((step) => violation(`${witnessPrefix}:missing-terminal:${step}`, `步骤 ${step} 必须声明为契约终点`)),
        ...unterminatedLeaves.map((step) => violation(`${witnessPrefix}:unterminated-leaf:${step.id}`, `叶子步骤 ${step.id} 没有声明契约结果`)),
      ];
      output.push({
        ...base,
        status: flow && violations.length === 0 ? "pass" : "fail",
        summary: flow && violations.length === 0 ? `关键分支契约 ${flow.title} 的步骤、边与终点均已锚定` : `控制流证据不完整（${violations.length} 项）`,
        violations,
      });
      continue;
    }
    if (mechanism.kind === "tcb-budget") {
      try {
        const evaluated = evaluateTcb({
          root: args.root,
          constraintId: definition.id,
          budgetFile: mechanism.budgetFile,
          fileEdges: args.fileEdges,
          files: args.files,
        });
        tcbs.push(evaluated.fact);
        output.push({ ...base, status: evaluated.status, summary: evaluated.summary });
      } catch (error) {
        output.push({
          ...base,
          status: "unknown",
          summary: "无法计算可信闭包",
          violations: [violation("tcb-budget:analysis-error", String((error as Error).message ?? error))],
        });
      }
    }
  }
  return { constraints: output, tcbs };
}
