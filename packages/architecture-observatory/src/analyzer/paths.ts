import fs from "node:fs";
import path from "node:path";

import type { ArchitectureModuleDefinition, PackageFact } from "../shared/model.js";

export const AUTO_WORKSPACE_MODULE_TAG = "auto-workspace-package";

export function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}
export function relativeRepoPath(root: string, value: string): string {
  return normalizeRepoPath(path.isAbsolute(value) ? path.relative(root, value) : value);
}

function prefixMatches(file: string, rawPrefix: string): boolean {
  const prefix = normalizeRepoPath(rawPrefix).replace(/^\//, "");
  if (prefix.endsWith("/")) return file.startsWith(prefix);
  return file === prefix || file.startsWith(`${prefix}/`);
}

export function moduleForPath(filePath: string, modules: ArchitectureModuleDefinition[]): string {
  const file = normalizeRepoPath(filePath);
  let match: { id: string; length: number } | null = null;
  for (const module of modules) {
    for (const prefix of module.pathPrefixes) {
      if (!prefixMatches(file, prefix)) continue;
      const length = normalizeRepoPath(prefix).length;
      if (!match || length > match.length) match = { id: module.id, length };
    }
  }
  return match?.id ?? "unmapped";
}

export interface WorkspacePackage {
  id: string;
  name: string;
  path: string;
  dependencies: string[];
  devDependencies: string[];
}

function packageLabel(pkg: WorkspacePackage): string {
  return pkg.name.replace(/^@[^/]+\//, "") || pkg.path.split("/").at(-1) || pkg.path;
}

/**
 * Keep newly added workspace packages visible before somebody has classified
 * them in the stable architecture vocabulary.
 *
 * Explicit longest-prefix ownership always wins. Only packages containing at
 * least one source file that would otherwise fall into the single `unmapped`
 * bucket receive a generated fallback. The fallback deliberately stays in the
 * `unmapped` zone: discovery is a fact, but trust and responsibility are human
 * architectural decisions.
 */
export function withWorkspacePackageFallbacks(args: {
  definitions: ArchitectureModuleDefinition[];
  packages: WorkspacePackage[];
  sourceFiles: string[];
}): ArchitectureModuleDefinition[] {
  const definitions = [...args.definitions];
  for (const pkg of args.packages) {
    const packagePrefix = `${normalizeRepoPath(pkg.path).replace(/\/$/, "")}/`;
    const hasUnclaimedSource = args.sourceFiles.some((file) =>
      normalizeRepoPath(file).startsWith(packagePrefix)
      && moduleForPath(file, args.definitions) === "unmapped");
    if (!hasUnclaimedSource) continue;
    const id = `workspace-package:${pkg.path}`;
    if (definitions.some((definition) => definition.id === id)) continue;
    const label = packageLabel(pkg);
    definitions.push({
      id,
      label,
      description: `从 workspace manifest 自动发现的 ${label} 包；尚未在架构清单中声明职责与信任归属。`,
      zone: "unmapped",
      criticality: "supporting",
      pathPrefixes: [packagePrefix],
      tags: [AUTO_WORKSPACE_MODULE_TAG, "coverage-gap"],
      docs: [],
    });
  }
  return definitions;
}

export function discoverWorkspacePackages(root: string): WorkspacePackage[] {
  const output: WorkspacePackage[] = [];
  for (const parent of ["packages", "plugins"]) {
    const absoluteParent = path.join(root, parent);
    if (!fs.existsSync(absoluteParent)) continue;
    for (const entry of fs.readdirSync(absoluteParent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(absoluteParent, entry.name, "package.json");
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const packagePath = normalizeRepoPath(path.relative(root, path.dirname(manifestPath)));
      output.push({
        id: manifest.name ?? `${parent}/${entry.name}`,
        name: manifest.name ?? entry.name,
        path: packagePath,
        dependencies: Object.keys(manifest.dependencies ?? {}).sort(),
        devDependencies: Object.keys(manifest.devDependencies ?? {}).sort(),
      });
    }
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

export function packageForPath(filePath: string, packages: WorkspacePackage[]): WorkspacePackage | undefined {
  const file = normalizeRepoPath(filePath);
  return packages
    .filter((pkg) => file === pkg.path || file.startsWith(`${pkg.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function toPackageFacts(packages: WorkspacePackage[]): PackageFact[] {
  return packages.map((pkg) => ({ ...pkg, files: 0, loc: 0 }));
}
