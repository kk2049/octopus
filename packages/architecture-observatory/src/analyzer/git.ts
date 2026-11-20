import { execFileSync } from "node:child_process";

import type { GitFileFact } from "../shared/model.js";
import { normalizeRepoPath } from "./paths.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function repositoryMeta(root: string): { commit: string; branch: string; dirty: boolean } {
  const commit = git(root, ["rev-parse", "HEAD"]);
  const branch = git(root, ["branch", "--show-current"]) || "(detached)";
  const dirty = git(root, ["status", "--short"]).length > 0;
  return { commit, branch, dirty };
}

export function gitFileHistory(root: string, maxCommits: number): Map<string, GitFileFact> {
  const facts = new Map<string, GitFileFact>();
  let output = "";
  try {
    output = git(root, [
      "log",
      `-${Math.max(1, maxCommits)}`,
      "--format=@@%aI",
      "--numstat",
      "--no-renames",
      "--",
    ]);
  } catch {
    return facts;
  }
  let date: string | undefined;
  const touchedInCommit = new Set<string>();
  const flush = (): void => touchedInCommit.clear();
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      flush();
      date = line.slice(2).trim();
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const file = normalizeRepoPath(match[3]);
    const fact = facts.get(file) ?? { touches: 0, additions: 0, deletions: 0 };
    if (!touchedInCommit.has(file)) {
      fact.touches += 1;
      touchedInCommit.add(file);
    }
    fact.additions += match[1] === "-" ? 0 : Number(match[1]);
    fact.deletions += match[2] === "-" ? 0 : Number(match[2]);
    if (!fact.lastChangedAt && date) fact.lastChangedAt = date;
    facts.set(file, fact);
  }
  return facts;
}
