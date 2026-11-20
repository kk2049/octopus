import ts from "typescript";

import type { ArchitectureAtlas, ArchitectureWaiver, AtlasConfig } from "../shared/model.js";
import { ATLAS_SCHEMA_VERSION } from "../shared/model.js";
import { aggregateModules, aggregatePackages, buildFindings } from "./aggregate.js";
import { evaluateConstraints } from "./constraints.js";
import { analyzeDependencies } from "./dependencies.js";
import { buildFlows } from "./flows.js";
import { gitFileHistory, repositoryMeta } from "./git.js";
import { buildModuleEcosystem } from "./module-ecosystem.js";
import {
  discoverWorkspacePackages,
  relativeRepoPath,
  withWorkspacePackageFallbacks,
} from "./paths.js";
import { analyzeTypeScript, discoverSourceFiles } from "./typescript.js";
import { applyWaivers } from "./waivers.js";

export async function analyzeRepository(
  root: string,
  config: AtlasConfig,
  inputFingerprint = "unspecified",
  waivers: ArchitectureWaiver[] = [],
  now = new Date(),
): Promise<ArchitectureAtlas> {
  const repo = repositoryMeta(root);
  const sourceRoots = config.analysis?.sourceRoots ?? ["packages", "plugins", "scripts", "ctl"];
  const excludes = config.analysis?.exclude ?? [];
  const git = gitFileHistory(root, config.analysis?.gitHistoryCommits ?? 200);
  const packages = discoverWorkspacePackages(root);
  const moduleDefinitions = withWorkspacePackageFallbacks({
    definitions: config.modules,
    packages,
    sourceFiles: discoverSourceFiles(root, sourceRoots, excludes).map((file) => relativeRepoPath(root, file)),
  });
  const source = analyzeTypeScript({
    root,
    sourceRoots,
    repoSha: repo.commit,
    excludes,
    modules: moduleDefinitions,
    packages,
    git,
  });
  const dependencies = await analyzeDependencies({
    root,
    sourceRoots,
    excludes,
    files: source.files,
    imports: source.imports,
    modules: moduleDefinitions,
    packages,
  });
  const flowBuild = buildFlows({ definitions: config.flows, annotations: source.annotations, modules: moduleDefinitions });
  const evaluated = evaluateConstraints({
    root,
    definitions: config.constraints,
    dependencies: dependencies.moduleDependencies,
    externalFileEdges: dependencies.externalFileEdges,
    fileEdges: dependencies.fileEdges,
    files: source.files,
    flows: flowBuild.flows,
    annotations: source.annotations,
  });
  const waiverResult = applyWaivers({ constraints: evaluated.constraints, waivers, now });
  const modules = aggregateModules({
    definitions: moduleDefinitions,
    files: source.files,
    symbols: source.symbols,
    dependencies: dependencies.moduleDependencies,
  });
  const packageFacts = aggregatePackages(packages, source.files);
  const moduleEcosystem = buildModuleEcosystem({
    frontend: { modules: source.frontendModules, issues: source.moduleDiscoveryIssues },
    contracts: { contracts: source.contractModules, issues: [] },
    backend: { modules: source.backendModules, issues: [] },
  });
  const findings = buildFindings({
    files: source.files,
    modules,
    constraints: waiverResult.constraints,
    annotationErrors: source.annotationErrors,
    flowIssues: flowBuild.issues,
    unresolved: dependencies.unresolved,
    environmentIssues: dependencies.environmentIssues,
    moduleDiscoveryIssues: source.moduleDiscoveryIssues,
  });
  return {
    schemaVersion: ATLAS_SCHEMA_VERSION,
    meta: {
      systemId: config.system.id,
      title: config.system.title,
      description: config.system.description,
      generatedAt: new Date().toISOString(),
      inputFingerprint,
      ...repo,
      root,
      sourceUrlTemplate: config.system.sourceUrlTemplate,
      analyzer: {
        dependencyCruiser: dependencies.toolVersion,
        typescript: ts.version,
      },
      limitations: [
        "导入关系由静态解析得到；反射、运行时注册、依赖注入与字符串协议不会自动变成调用边。",
        "函数调用邻域是 TypeScript 符号解析的 best-effort 结果，不能单独证明 complete mediation 或数据不泄露。",
        "declared 表示实现者主张，executable 表示存在可执行测试；只有实际运行测试后才能说该提交通过。",
        "Git 触达次数和复杂度只用于分配 review 注意力，不是质量评分。",
        "当前快照没有接入生产运行时 trace；动态路径应由后续 OpenTelemetry/审计日志适配器补充。",
      ],
    },
    zones: config.zones,
    modules,
    packages: packageFacts,
    moduleEcosystem,
    files: source.files,
    dependencies: dependencies.moduleDependencies,
    externalDependencies: dependencies.externalDependencies,
    symbols: source.symbols,
    calls: source.calls,
    annotations: source.annotations,
    flows: flowBuild.flows,
    constraints: waiverResult.constraints,
    tcbs: evaluated.tcbs,
    findings: [...findings, ...waiverResult.findings],
  };
}
