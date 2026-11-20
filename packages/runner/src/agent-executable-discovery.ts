/** Bounded, non-executing discovery. No profiles, package-manager commands or workspace scans. */
import { closeSync, openSync, opendirSync, readSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { absoluteCommandPath, executablePath, trustedExecutablePath, trustedDirectoryPath, type ExecutablePolicy } from "./agent-executable-policy.js";
import { AgentExecutableError } from "./agent-executable-errors.js";
export { absoluteCommandPath, trustedExecutablePath, trustedDirectoryPath } from "./agent-executable-policy.js";

export const AGENT_EXECUTABLE_PROVIDERS = ["claude", "codex", "omp"] as const;
export type ExecutableProvider = typeof AGENT_EXECUTABLE_PROVIDERS[number];
export interface AgentCandidate {
  entry: string;
  source: string;
  /** Only an explicit existing PATH order or a package-manager default chooses among copies. */
  preferred?: boolean;
}
export interface AgentExecutablePlan extends AgentCandidate {
  provider: ExecutableProvider;
  target: string;
  interpreter?: string;
  fingerprint: string;
  policy?: ExecutablePolicy;
}

function fileIdentity(file: string): unknown[] {
  const stat = statSync(file);
  return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
}

export function executablePlan(
  provider: ExecutableProvider,
  candidate: AgentCandidate,
  runtimeDirectories: readonly string[],
  explicitInterpreter?: string,
  policy: ExecutablePolicy = {},
): AgentExecutablePlan {
  const target = executablePath(candidate.entry, "entry", policy);
  const fd = openSync(target, "r");
  const buffer = Buffer.alloc(512);
  let length: number;
  try { length = readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
  const header = buffer.subarray(0, length);
  let interpreter: string | undefined;
  if (header.subarray(0, 2).toString() === "#!") {
    const line = header.toString("utf8").split("\n", 1)[0].slice(2).trim();
    // Arbitrary shebang arguments and version-manager shims need a local wrapper/binding.
    const match = /^(?:\/usr\/bin\/env\s+(node|nodejs|bun)|([^\s]+))$/.exec(line);
    if (!match && !explicitInterpreter) throw new Error("unsupported_interpreter");
    if (explicitInterpreter) interpreter = executablePath(explicitInterpreter, "interpreter", policy);
    else if (match?.[2]) interpreter = executablePath(match[2], "interpreter", policy);
    else {
      const name = match![1];
      const directories = /\/\.nvm\/versions\/node\/[^/]+\/bin\//.test(candidate.entry)
        ? [path.dirname(candidate.entry)] : [path.dirname(candidate.entry), ...runtimeDirectories];
      let failure: unknown;
      for (const directory of [...new Set(directories)]) {
        const captured = policy.capture?.length ?? 0;
        try { interpreter = executablePath(path.join(directory, name), "interpreter", policy); break; }
        catch (error) {
          if (policy.capture) policy.capture.length = captured;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT"
            && !(error instanceof AgentExecutableError && error.diagnosticCode === "interpreter_unavailable")) failure ??= error;
        }
      }
      if (!interpreter) throw failure ?? new AgentExecutableError("interpreter_unavailable", {
        stage: "interpreter", path: path.join(directories[0], name), rule: "matching_interpreter_missing",
      });
    }
  } else if (explicitInterpreter) {
    throw new Error("interpreter_requires_script");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([
    provider, candidate.entry, fileIdentity(target), interpreter ? fileIdentity(interpreter) : null,
  ])).digest("hex");
  return { ...candidate, provider, target, ...(interpreter ? { interpreter } : {}), fingerprint, policy: { platform: policy.platform, ...(policy.trust ? { trust: policy.trust } : {}) } };
}

/** Metadata reads are bounded and subject to the same ownership checks as executables. */
function metadata(file: string): string {
  try {
    const target = trustedExecutablePath(file, false);
    if (statSync(target).size > 4096) return "";
    return readFileSync(target, "utf8").trim();
  } catch { return ""; }
}

function nodeVersions(root: string): string[] {
  try {
    const directory = opendirSync(trustedDirectoryPath(path.join(root, "versions", "node")));
    const versions: string[] = [];
    try {
      for (let count = 0; count < 256; count++) {
        const entry = directory.readSync();
        if (!entry) return versions.sort();
        if (/^v\d+\.\d+\.\d+$/.test(entry.name)) versions.push(entry.name);
        if (versions.length > 64) return []; // An incomplete roster cannot establish a default.
      }
      return [];
    } finally { directory.closeSync(); }
  } catch { return []; }
}

function nvmDefault(root: string, versions: string[]): string | undefined {
  let selector = "default";
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(selector)) return undefined;
    seen.add(selector);
    if (/^v?\d+(?:\.\d+){0,2}$/.test(selector) || selector === "node" || selector === "stable") {
      const prefix = selector.replace(/^v/, "");
      return versions.filter((version) => selector === "node" || selector === "stable"
        || version.slice(1) === prefix || version.slice(1).startsWith(prefix + "."))
        .sort((a, b) => {
          const aa = a.slice(1).split(".").map(Number), bb = b.slice(1).split(".").map(Number);
          return bb[0] - aa[0] || bb[1] - aa[1] || bb[2] - aa[2];
        })[0];
    }
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/.test(selector)) return undefined;
    selector = metadata(path.join(root, "alias", selector));
    if (!selector) return undefined;
  }
  return undefined;
}

export function discoverAgentCandidates(
  home: string,
  provider: ExecutableProvider,
  directories: readonly string[],
  platform: NodeJS.Platform,
  systemDirectories?: readonly string[],
): AgentCandidate[] {
  const candidates: AgentCandidate[] = [];
  const add = (directory: string, source: string, preferred = false) => {
    if (absoluteCommandPath(directory)) candidates.push({ entry: path.join(directory, provider), source, preferred });
  };
  // PATH order (service PATH plus any explicitly captured agent_path) decides among
  // copies on every resolution. The daemon never recaptures a later terminal's PATH.
  for (const directory of directories.slice(0, 128)) add(directory, "configured_path", true);
  for (const directory of [path.join(home, ".local", "bin"), path.join(home, "bin"),
    ...(systemDirectories ?? ["/usr/local/bin", "/usr/bin", ...(platform === "darwin" ? ["/opt/homebrew/bin"] : [])])]) {
    add(directory, "standard");
  }
  const nvmRoot = path.join(home, ".nvm");
  const versions = nodeVersions(nvmRoot);
  const selected = nvmDefault(nvmRoot, versions);
  // A logical default entry can follow nvm's declared alias without guessing from mtimes.
  if (selected) add(path.join(nvmRoot, "versions", "node", selected, "bin"), "nvm_default");
  for (const version of versions) add(path.join(nvmRoot, "versions", "node", version, "bin"), "nvm");
  return candidates.filter((candidate, index) => candidates.findIndex((other) => other.entry === candidate.entry) === index);
}
