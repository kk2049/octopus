/** Executable selection policy is separate from private registry storage protection. */
import { realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { AgentExecutableError, type AgentLocalDiagnostic } from "./agent-executable-errors.js";

export interface AgentTrustPath { path: string; uid: number; gid: number; writable: number }
export interface AgentTrustGrant { version: 1; paths: AgentTrustPath[] }
export interface ExecutablePolicy {
  platform?: NodeJS.Platform;
  trust?: AgentTrustGrant;
  /** Only the explicit local bind --trust-installation command may collect exceptions. */
  capture?: AgentTrustPath[];
}
export function absoluteCommandPath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
}
export function readTrustGrant(value: unknown): AgentTrustGrant | undefined {
  if (value === undefined) return undefined;
  const row = value as AgentTrustGrant;
  if (!row || row.version !== 1 || !Array.isArray(row.paths) || row.paths.length > 64
    || row.paths.some((p) => !p || !absoluteCommandPath(p.path) || path.resolve(p.path) !== p.path
      || !Number.isSafeInteger(p.uid) || p.uid < 0 || !Number.isSafeInteger(p.gid) || p.gid < 0
      || (p.writable !== 0 && p.writable !== 0o020))) throw new AgentExecutableError("invalid_bindings");
  return { version: 1, paths: row.paths.map(({ path, uid, gid, writable }) => ({ path, uid, gid, writable })) };
}

/** macOS's built-in admin group (gid 80), only directories in fixed Homebrew prefixes. */
export function homebrewAdminDirectory(file: string, stat: Pick<Stats, "gid" | "mode" | "isDirectory">, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && stat.isDirectory() && stat.gid === 80 && (stat.mode & 0o002) === 0
    && ["/opt/homebrew", "/usr/local"].some((root) => file === root || file.startsWith(root + "/"));
}

export function checkedPath(file: string, stage: AgentLocalDiagnostic["stage"], policy?: ExecutablePolicy): string {
  if (!absoluteCommandPath(file)) throw new AgentExecutableError("invalid_path", { stage, path: String(file), rule: "absolute_path" });
  const uid = process.getuid?.();
  if (uid === undefined) throw new AgentExecutableError("execution_only");
  const target = realpathSync(file);
  for (const spelling of [path.resolve(file), target]) {
    let current = spelling;
    for (;;) {
      const stat = statSync(current);
      const stickyRoot = current !== spelling && stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      const writable = stat.mode & 0o022;
      const ownerSafe = stat.uid === uid || stat.uid === 0;
      const modeSafe = writable === 0 || stickyRoot || (policy && homebrewAdminDirectory(current, stat, policy.platform ?? process.platform));
      if (!ownerSafe || !modeSafe) {
        // World-writable paths never acquire a local exception. A sticky root ancestor is already handled above.
        const exception = { path: current, uid: stat.uid, gid: stat.gid, writable };
        const permitted = !(writable & 0o002) && policy?.trust?.paths.some((p) =>
          p.path === current && p.uid === stat.uid && p.gid === stat.gid && p.writable === writable);
        if (!permitted) {
          if (!(writable & 0o002) && policy?.capture) {
            if (!policy.capture.some((p) => p.path === current)) policy.capture.push(exception);
            if (policy.capture.length > 64) throw new AgentExecutableError("invalid_bindings");
          } else {
            throw new AgentExecutableError("unsafe_permissions", {
              stage: spelling === target && stage === "entry" ? "target" : stage,
              path: current, uid: stat.uid, gid: stat.gid, mode: (stat.mode & 0o7777).toString(8).padStart(4, "0"),
              rule: !ownerSafe ? "foreign_owner" : writable & 0o002 ? "world_writable" : "group_writable",
            });
          }
        }
      }
      if (path.dirname(current) === current) break;
      current = path.dirname(current);
    }
  }
  return target;
}

/** Storage and discovery metadata never inherit executable trust exceptions. */
export function trustedExecutablePath(file: string, executable = true): string {
  const target = checkedPath(file, "registry");
  const stat = statSync(target);
  if (!stat.isFile() || (executable && (stat.mode & 0o111) === 0)) throw new AgentExecutableError("not_executable");
  return target;
}
export function trustedDirectoryPath(directory: string): string {
  const target = checkedPath(directory, "registry");
  if (!statSync(target).isDirectory()) throw new AgentExecutableError("invalid_path");
  return target;
}
export function executablePath(file: string, stage: AgentLocalDiagnostic["stage"], policy: ExecutablePolicy): string {
  let target: string;
  try { target = checkedPath(file, stage, policy); }
  catch (error) {
    if (stage === "interpreter" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentExecutableError("interpreter_unavailable", { stage, path: file, rule: "interpreter_missing" });
    }
    throw error;
  }
  const stat = statSync(target);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new AgentExecutableError("not_executable", { stage, path: file, rule: "executable_file" });
  return target;
}
