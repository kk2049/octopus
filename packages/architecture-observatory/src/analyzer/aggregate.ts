import type {
  ArchitectureConstraintDefinition,
  ArchitectureModuleDefinition,
  ConstraintResult,
  DependencyFact,
  FileFact,
  ModuleFact,
  PackageFact,
  ReviewFinding,
  SymbolFact,
} from "../shared/model.js";
import type { WorkspacePackage } from "./paths.js";
import { AUTO_WORKSPACE_MODULE_TAG } from "./paths.js";

export function aggregateModules(args: {
  definitions: ArchitectureModuleDefinition[];
  files: FileFact[];
  symbols: SymbolFact[];
  dependencies: DependencyFact[];
}): ModuleFact[] {
  const definitions = [...args.definitions];
  if (args.files.some((file) => file.moduleId === "unmapped")) {
    definitions.push({
      id: "unmapped",
      label: "Unmapped source",
      description: "尚未纳入架构清单的源文件；它们需要被归属或明确排除。",
      zone: "unmapped",
      criticality: "supporting",
      pathPrefixes: ["(fallback)"],
      tags: ["coverage-gap"],
    });
  }
  const output = new Map<string, ModuleFact>();
  for (const definition of definitions) {
    output.set(definition.id, {
      ...definition,
      files: 0,
      loc: 0,
      codeLoc: 0,
      testFiles: 0,
      symbols: 0,
      complexity: 0,
      gitTouches: 0,
      runtimeFanIn: 0,
      runtimeFanOut: 0,
      typeOnlyFanIn: 0,
      typeOnlyFanOut: 0,
      fanIn: 0,
      fanOut: 0,
      unmapped: definition.id === "unmapped" || definition.tags?.includes(AUTO_WORKSPACE_MODULE_TAG),
    });
  }
  for (const file of args.files) {
    const module = output.get(file.moduleId);
    if (!module) continue;
    module.files += 1;
    module.loc += file.loc;
    module.codeLoc += file.codeLoc;
    module.testFiles += file.isTest ? 1 : 0;
    module.complexity += file.complexity;
    module.gitTouches += file.git.touches;
  }
  for (const symbol of args.symbols) {
    const module = output.get(symbol.moduleId);
    if (module) module.symbols += 1;
  }
  const runtimeIncoming = new Map<string, Set<string>>();
  const runtimeOutgoing = new Map<string, Set<string>>();
  const typeOnlyIncoming = new Map<string, Set<string>>();
  const typeOnlyOutgoing = new Map<string, Set<string>>();
  for (const edge of args.dependencies) {
    if (edge.runtimeCount + edge.dynamicCount > 0) {
      const outs = runtimeOutgoing.get(edge.from) ?? new Set<string>();
      outs.add(edge.to);
      runtimeOutgoing.set(edge.from, outs);
      const ins = runtimeIncoming.get(edge.to) ?? new Set<string>();
      ins.add(edge.from);
      runtimeIncoming.set(edge.to, ins);
    }
    if (edge.typeOnlyCount > 0) {
      const outs = typeOnlyOutgoing.get(edge.from) ?? new Set<string>();
      outs.add(edge.to);
      typeOnlyOutgoing.set(edge.from, outs);
      const ins = typeOnlyIncoming.get(edge.to) ?? new Set<string>();
      ins.add(edge.from);
      typeOnlyIncoming.set(edge.to, ins);
    }
  }
  for (const module of output.values()) {
    module.runtimeFanIn = runtimeIncoming.get(module.id)?.size ?? 0;
    module.runtimeFanOut = runtimeOutgoing.get(module.id)?.size ?? 0;
    module.typeOnlyFanIn = typeOnlyIncoming.get(module.id)?.size ?? 0;
    module.typeOnlyFanOut = typeOnlyOutgoing.get(module.id)?.size ?? 0;
    module.fanIn = module.runtimeFanIn;
    module.fanOut = module.runtimeFanOut;
  }
  return [...output.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function aggregatePackages(packages: WorkspacePackage[], files: FileFact[]): PackageFact[] {
  const output = packages.map((pkg): PackageFact => ({ ...pkg, files: 0, loc: 0 }));
  const byId = new Map(output.map((pkg) => [pkg.id, pkg]));
  for (const file of files) {
    if (!file.packageId) continue;
    const pkg = byId.get(file.packageId);
    if (!pkg) continue;
    pkg.files += 1;
    pkg.loc += file.loc;
  }
  return output;
}

function findingSeverity(constraint: ArchitectureConstraintDefinition): ReviewFinding["severity"] {
  return constraint.severity === "critical" ? "critical"
    : constraint.severity === "high" ? "high"
      : constraint.severity === "medium" ? "medium"
        : "info";
}

export function buildFindings(args: {
  files: FileFact[];
  modules: ModuleFact[];
  constraints: ConstraintResult[];
  annotationErrors: Array<{ source: { path: string; line: number; excerpt?: string[] }; message: string }>;
  flowIssues: Array<{ message: string; annotation?: { source: { path: string; line: number; excerpt?: string[] } } }>;
  unresolved: Array<{ source: string; specifier: string }>;
  environmentIssues: Array<{ severity: string; name: string; description: string }>;
  moduleDiscoveryIssues: Array<{ message: string; source?: { path: string; line: number; excerpt?: string[] } }>;
}): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const constraint of args.constraints) {
    if (constraint.status === "fail") {
      for (const [index, violation] of constraint.violations.entries()) {
        findings.push({
          id: `constraint:${constraint.id}:${index}`,
          severity: findingSeverity(constraint),
          title: constraint.title,
          description: violation.message,
          moduleIds: violation.path ?? [],
          source: violation.source,
          constraintId: constraint.id,
          signal: "violation",
        });
      }
    } else if (constraint.status === "review" && constraint.evidence.length === 0) {
      findings.push({
        id: `coverage:${constraint.id}`,
        severity: "medium",
        title: `${constraint.title} 缺少锚定证据`,
        description: "这条系统级主张目前只有清单文本，尚未绑定实现、测试或运行时证据。",
        moduleIds: [],
        constraintId: constraint.id,
        signal: "coverage",
      });
    }
  }
  for (const [index, error] of args.annotationErrors.entries()) {
    findings.push({
      id: `annotation:${index}`,
      severity: "medium",
      title: "架构标注无法解析",
      description: error.message,
      moduleIds: [],
      source: error.source,
      signal: "tooling",
    });
  }
  for (const [index, issue] of args.flowIssues.entries()) {
    findings.push({
      id: `flow:${index}`,
      severity: "medium",
      title: "控制流锚点不完整",
      description: issue.message,
      moduleIds: [],
      source: issue.annotation?.source,
      signal: "coverage",
    });
  }
  for (const [index, unresolved] of args.unresolved.slice(0, 20).entries()) {
    findings.push({
      id: `unresolved:${index}`,
      severity: "info",
      title: "依赖解析不完整",
      description: `${unresolved.source} 无法解析 ${unresolved.specifier}`,
      moduleIds: [],
      source: { path: unresolved.source, line: 1 },
      signal: "tooling",
    });
  }
  for (const [index, issue] of args.environmentIssues.entries()) {
    findings.push({
      id: `environment:${index}`,
      severity: issue.severity === "error" ? "high" : "info",
      title: `分析器环境：${issue.name}`,
      description: issue.description,
      moduleIds: [],
      signal: "tooling",
    });
  }
  for (const [index, issue] of args.moduleDiscoveryIssues.entries()) {
    findings.push({
      id: `module-discovery:${index}`,
      severity: "medium",
      title: "模组自动发现不完整",
      description: issue.message,
      moduleIds: [],
      source: issue.source,
      signal: "tooling",
    });
  }
  const unmapped = args.files.filter((file) => file.moduleId === "unmapped");
  if (unmapped.length) {
    findings.push({
      id: "coverage:unmapped",
      severity: "medium",
      title: `${unmapped.length} 个源文件没有模块归属`,
      description: "未归属文件不会消失，但其依赖会被聚合到 Unmapped source；请在 architecture/atlas.json 中归属。",
      moduleIds: ["unmapped"],
      source: { path: unmapped[0].path, line: 1 },
      signal: "coverage",
    });
  }

  const autoDiscovered = args.modules.filter((module) => module.tags?.includes(AUTO_WORKSPACE_MODULE_TAG));
  if (autoDiscovered.length) {
    findings.push({
      id: "coverage:auto-workspace-packages",
      severity: "medium",
      title: `${autoDiscovered.length} 个 workspace package 已自动显示、尚未归类`,
      description: "这些包已在模块地图中各自计数，不再挤进同一个 Unmapped source 圆；职责、信任域与关键级别仍需在 architecture/atlas.json 中明确声明。",
      moduleIds: autoDiscovered.map((module) => module.id),
      source: { path: `${autoDiscovered[0]!.pathPrefixes[0]!.replace(/\/$/, "")}/package.json`, line: 1 },
      signal: "coverage",
    });
  }

  const moduleById = new Map(args.modules.map((module) => [module.id, module]));
  const largeChanged = args.files
    .filter((file) => !file.isTest && file.codeLoc >= 500 && file.git.touches > 0)
    .sort((a, b) => (b.codeLoc * Math.log2(b.git.touches + 1)) - (a.codeLoc * Math.log2(a.git.touches + 1)))
    .slice(0, 8);
  for (const file of largeChanged) {
    const module = moduleById.get(file.moduleId);
    findings.push({
      id: `hotspot:${file.path}`,
      severity: file.codeLoc >= 1500 || module?.criticality === "critical" ? "medium" : "info",
      title: `审阅热点：${file.path.split("/").at(-1)}`,
      description: `${file.codeLoc} 代码行、最近窗口 ${file.git.touches} 次提交触达、静态分支复杂度 ${file.complexity}。这是注意力信号，不是质量评分。`,
      moduleIds: [file.moduleId],
      source: { path: file.path, line: 1 },
      signal: "hotspot",
    });
  }
  return findings;
}
