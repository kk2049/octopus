import { normalizeRepoPath } from "../analyzer/paths.js";

export interface ScipSymbolLocator {
  repoSha: string;
  path: string;
  qualifiedName: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function assertRepoSha(value: string): void {
  if (!SHA_PATTERN.test(value)) throw new Error(`invalid repository SHA: ${value}`);
}

/**
 * Stable generated code-space identity. SCIP package/version symbols remain
 * generated facts in the index; reviewed bridges use this SHA-bound locator so
 * a package-manager encoding change cannot silently retarget human intent.
 */
export function formatScipSymbolLocator(locator: ScipSymbolLocator): string {
  assertRepoSha(locator.repoSha);
  const file = normalizeRepoPath(locator.path).replace(/^\/+/, "");
  if (!file || file.split("/").includes("..")) throw new Error(`invalid repository path: ${locator.path}`);
  if (!locator.qualifiedName.trim()) throw new Error("qualifiedName must not be empty");
  return `scip:${locator.repoSha}:${encodeURIComponent(file)}#${encodeURIComponent(locator.qualifiedName)}`;
}
