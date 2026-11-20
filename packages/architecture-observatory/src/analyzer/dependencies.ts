import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cruise, type ICruiseResult } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";

import type {
  ArchitectureModuleDefinition,
  DependencyFact,
  DependencySample,
  ExternalDependencyFact,
  FileFact,
} from "../shared/model.js";
import { moduleForPath, normalizeRepoPath, relativeRepoPath, type WorkspacePackage } from "./paths.js";
import type { ImportSite } from "./typescript.js";

export interface FileDependencyEdge {
  from: string;
  to: string;
  typeOnly: boolean;
  dynamic: boolean;
  circular: boolean;
}

export interface ExternalFileDependencyEdge {
  fromModule: string;
  source: string;
  package: string;
  typeOnly: boolean;
  test: boolean;
  builtin: boolean;
  sample: DependencySample;
}

export interface DependencyAnalysis {
  moduleDependencies: DependencyFact[];
  externalDependencies: ExternalDependencyFact[];
  fileEdges: FileDependencyEdge[];
  externalFileEdges: ExternalFileDependencyEdge[];
  unresolved: Array<{ source: string; specifier: string }>;
  environmentIssues: Array<{ severity: string; name: string; description: string }>;
  toolVersion: string;
}

function packageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function isStaticAssetSpecifier(specifier: string): boolean {
  const clean = specifier.split(/[?#]/, 1)[0].toLowerCase();
  return /\.(?:avif|bmp|css|gif|ico|jpe?g|less|md|mdx|png|sass|scss|svg|webp|woff2?)$/.test(clean);
}

function workspaceSourceTarget(resolved: string, workspaceTarget: WorkspacePackage, files: FileFact[]): string | undefined {
  // Built workspace exports usually preserve the source-relative basename
  // (`dist/limits.d.ts` -> `src/limits.ts`). Prefer that exact source so file
  // reachability constraints do not jump to an arbitrary package file merely
  // because the package happened to be built locally.
  const generated = resolved.match(/(?:^|\/)dist\/(.+)$/)?.[1];
  if (generated) {
    const stem = generated
      .replace(/\.d\.[cm]?ts$/, "")
      .replace(/\.(?:[cm]?[jt]sx?)$/, "")
      .replace(/^src\//, "");
    for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      const candidate = `${workspaceTarget.path}/src/${stem}${extension}`;
      if (files.some((file) => file.path === candidate)) return candidate;
    }
  }
  return files.find((file) => file.packageId === workspaceTarget.id && !file.isTest)?.path;
}

function sourceExcerpt(root: string, file: string, line: number): string[] | undefined {
  try {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
    const start = Math.max(0, line - 2);
    return lines.slice(start, Math.min(lines.length, line + 1)).map((text, index) => `${start + index + 1}: ${text}`);
  } catch {
    return undefined;
  }
}

function dependencySample(root: string, site: ImportSite | undefined, source: string, specifier: string, typeOnly: boolean, dynamic: boolean, test: boolean): DependencySample {
  const line = site?.line ?? 1;
  return {
    source: { path: source, line, excerpt: sourceExcerpt(root, source, line) },
    specifier,
    typeOnly: site?.typeOnly ?? typeOnly,
    dynamic: site?.dynamic ?? dynamic,
    test,
  };
}

function dependencyCruiserVersion(): string {
  let current = path.dirname(fileURLToPath(import.meta.resolve("dependency-cruiser")));
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "dependency-cruiser") return parsed.version ?? "unknown";
    }
    current = path.dirname(current);
  }
  return "unknown";
}

export function buildDependencyFacts(args: {
  root: string;
  result: ICruiseResult;
  files: FileFact[];
  imports: ImportSite[];
  modules: ArchitectureModuleDefinition[];
  packages: WorkspacePackage[];
}): Omit<DependencyAnalysis, "toolVersion" | "environmentIssues"> {
  const filePaths = new Set(args.files.map((file) => file.path));
  const fileByPath = new Map(args.files.map((file) => [file.path, file]));
  const packageByName = new Map(args.packages.map((pkg) => [pkg.name, pkg]));
  const sites = new Map<string, ImportSite[]>();
  for (const site of args.imports) {
    const key = `${site.sourcePath}\0${site.specifier}`;
    const values = sites.get(key) ?? [];
    values.push(site);
    sites.set(key, values);
  }
  const moduleEdges = new Map<string, DependencyFact>();
  const externalEdges = new Map<string, ExternalDependencyFact>();
  const fileEdges: FileDependencyEdge[] = [];
  const externalFileEdges: ExternalFileDependencyEdge[] = [];
  const unresolved: Array<{ source: string; specifier: string }> = [];

  for (const cruiseModule of args.result.modules) {
    let source = normalizeRepoPath(cruiseModule.source);
    if (path.isAbsolute(cruiseModule.source)) source = relativeRepoPath(args.root, cruiseModule.source);
    if (!filePaths.has(source)) continue;
    const sourceIsTest = fileByPath.get(source)?.isTest ?? false;
    const fromModule = moduleForPath(source, args.modules);
    for (const dependency of cruiseModule.dependencies) {
      const typeOnly = Boolean(dependency.typeOnly || dependency.preCompilationOnly);
      const dynamic = dependency.dynamic;
      let site = sites.get(`${source}\0${dependency.module}`)?.shift();
      if (!site && dependency.coreModule && !dependency.module.startsWith("node:")) {
        site = sites.get(`${source}\0node:${dependency.module}`)?.shift();
      }
      const sample = dependencySample(args.root, site, source, site?.specifier ?? dependency.module, typeOnly, dynamic, sourceIsTest);
      let resolved = normalizeRepoPath(dependency.resolved);
      if (path.isAbsolute(dependency.resolved)) resolved = relativeRepoPath(args.root, dependency.resolved);

      let targetFile = filePaths.has(resolved) ? resolved : undefined;
      let workspaceTarget: WorkspacePackage | undefined;
      if (!targetFile) {
        const name = packageName(dependency.module);
        workspaceTarget = packageByName.get(name);
        if (workspaceTarget) {
          targetFile = workspaceSourceTarget(resolved, workspaceTarget, args.files);
        }
      }
      if (targetFile) {
        const toModule = moduleForPath(targetFile, args.modules);
        fileEdges.push({ from: source, to: targetFile, typeOnly, dynamic, circular: dependency.circular });
        if (fromModule === toModule) continue;
        const key = `${fromModule}->${toModule}`;
        const edge = moduleEdges.get(key) ?? {
          id: key,
          from: fromModule,
          to: toModule,
          runtimeCount: 0,
          typeOnlyCount: 0,
          testCount: 0,
          dynamicCount: 0,
          circular: false,
          samples: [],
        };
        if (sourceIsTest) edge.testCount += 1;
        else if (typeOnly) edge.typeOnlyCount += 1;
        else edge.runtimeCount += 1;
        if (!sourceIsTest && dynamic) edge.dynamicCount += 1;
        if (!sourceIsTest) edge.circular ||= dependency.circular;
        if (edge.samples.length < 5) edge.samples.push(sample);
        moduleEdges.set(key, edge);
        continue;
      }

      // A relative import that did not resolve to an analyzed source file is not
      // an npm dependency. Static assets are intentionally outside the source
      // graph; unresolved code imports remain review findings.
      if (dependency.module.startsWith(".")) {
        if (dependency.couldNotResolve && !isStaticAssetSpecifier(dependency.module)) {
          unresolved.push({ source, specifier: dependency.module });
        }
        continue;
      }
      const builtin = dependency.coreModule || dependency.dependencyTypes.includes("core");
      const external = builtin
        ? `node:${dependency.module.replace(/^node:/, "")}`
        : packageName(dependency.module);
      externalFileEdges.push({
        fromModule,
        source,
        package: external,
        typeOnly,
        test: sourceIsTest,
        builtin,
        sample,
      });
      const key = `${fromModule}->${external}`;
      const edge = externalEdges.get(key) ?? {
        id: key,
        from: fromModule,
        package: external,
        count: 0,
        typeOnlyCount: 0,
        testCount: 0,
        builtin,
        samples: [],
      };
      if (sourceIsTest) edge.testCount += 1;
      else {
        edge.count += 1;
        if (typeOnly) edge.typeOnlyCount += 1;
      }
      if (edge.samples.length < 5) edge.samples.push(sample);
      externalEdges.set(key, edge);
    }
  }

  return {
    moduleDependencies: [...moduleEdges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    externalDependencies: [...externalEdges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    fileEdges,
    externalFileEdges,
    unresolved,
  };
}

export async function analyzeDependencies(args: {
  root: string;
  sourceRoots: string[];
  excludes?: string[];
  files: FileFact[];
  imports: ImportSite[];
  modules: ArchitectureModuleDefinition[];
  packages: WorkspacePackage[];
}): Promise<DependencyAnalysis> {
  const excludeParts = [".generated", ".test-tmp", ...(args.excludes ?? [])]
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const tsConfig = extractTSConfig(path.join(args.root, "tsconfig.json"));
  const report = await cruise(
    // Starting from the source inventory avoids cruising generated output as
    // roots. Keep dependencies that resolve into dist/ in the report, though:
    // workspace package exports commonly point there once a package has been
    // built, and filtering those edges would make the same commit produce a
    // different architecture graph before and after `pnpm build`.
    args.files
      .map((file) => file.path)
      .filter((file) => fs.existsSync(path.join(args.root, file))),
    {
      baseDir: args.root,
      exclude: `(^|/)(${excludeParts.join("|")})(/|$)`,
      // Keep package and core-module edges in the report, but do not traverse
      // their implementation. Filtering node_modules here would erase the
      // very evidence used by supply-chain and trust-boundary constraints.
      // Workspace package exports may resolve to dist/; retain those direct
      // edges as evidence and stop traversal at the generated target.
      doNotFollow: { path: "(^|/)(node_modules|dist)(/|$)" },
      tsPreCompilationDeps: "specify",
      moduleSystems: ["es6", "cjs", "tsd"],
      metrics: true,
      combinedDependencies: false,
      enhancedResolveOptions: {
        exportsFields: ["exports"],
        conditionNames: ["types", "import", "node", "default"],
        mainFields: ["types", "main"],
      },
    },
    undefined,
    { tsConfig },
  );
  if (typeof report.output === "string") throw new Error("dependency-cruiser returned formatted output instead of facts");
  return {
    ...buildDependencyFacts({ ...args, result: report.output }),
    environmentIssues: report.output.summary.environment.issues ?? [],
    toolVersion: dependencyCruiserVersion(),
  };
}
