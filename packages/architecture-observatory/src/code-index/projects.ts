import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { discoverWorkspacePackages, normalizeRepoPath } from "../analyzer/paths.js";

const INDEXED_EXTENSIONS: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".mts": true,
  ".cts": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".cjs": true,
};

export interface CodeIndexProject {
  packageName: string;
  root: string;
  tsconfig: string;
  files: readonly string[];
}

export function isDeclarationFile(file: string): boolean {
  return /\.d\.(?:ts|mts|cts)$/.test(normalizeRepoPath(file));
}

function isIndexedSource(file: string): boolean {
  const normalized = normalizeRepoPath(file);
  if (isDeclarationFile(normalized)) return false;
  return INDEXED_EXTENSIONS[path.extname(normalized)] === true;
}

export function parseProjectFiles(root: string, tsconfig: string): string[] {
  const absolute = path.resolve(root, tsconfig);
  const read = ts.readConfigFile(absolute, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(absolute), undefined, absolute);
  const errors = parsed.errors.filter((error) => error.code !== 18003);
  if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, ts.createCompilerHost({})));
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  return parsed.fileNames
    .map((file) => path.resolve(file))
    .filter((file) => file.startsWith(rootPrefix) && isIndexedSource(file))
    .map((file) => normalizeRepoPath(path.relative(root, file)))
    .sort();
}

/**
 * Discover only declared workspace projects. The repository root tsconfig is
 * intentionally never returned: without files/include it means TypeScript's
 * default include glob and would duplicate every workspace document.
 */
export function discoverCodeIndexProjects(root: string): CodeIndexProject[] {
  const repositoryRoot = path.resolve(root);
  const projects: CodeIndexProject[] = discoverWorkspacePackages(repositoryRoot).map((pkg) => {
    const tsconfig = normalizeRepoPath(path.join(pkg.path, "tsconfig.json"));
    if (!fs.existsSync(path.join(repositoryRoot, tsconfig))) {
      throw new Error(`workspace project ${pkg.name} is missing ${tsconfig}`);
    }
    return { packageName: pkg.name, root: pkg.path, tsconfig, files: parseProjectFiles(repositoryRoot, tsconfig) };
  });

  const rootToolsConfig = "tools/code-index/tsconfig.root.json";
  if (!fs.existsSync(path.join(repositoryRoot, rootToolsConfig))) {
    throw new Error(`missing explicit root tools project ${rootToolsConfig}`);
  }
  projects.push({
    packageName: "@claude-bot/root-tools",
    root: "tools/code-index",
    tsconfig: rootToolsConfig,
    files: parseProjectFiles(repositoryRoot, rootToolsConfig),
  });
  projects.sort((a, b) => a.tsconfig.localeCompare(b.tsconfig));

  const owner = new Map<string, string>();
  for (const project of projects) {
    for (const file of project.files) {
      const previous = owner.get(file);
      if (previous) throw new Error(`duplicate project document ${file}: ${previous} and ${project.tsconfig}`);
      owner.set(file, project.tsconfig);
    }
  }
  if (projects.some((project) => path.resolve(repositoryRoot, project.tsconfig) === path.join(repositoryRoot, "tsconfig.json"))) {
    throw new Error("repository root tsconfig must not be indexed");
  }
  return projects;
}
