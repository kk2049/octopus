import { agentCommand, withAgentExecutable } from "./agent-executables.js";
import { executableDiagnostic, type AgentDiagnosticCode } from "./agent-executable-errors.js";
/** Version-scoped contract probe for `codex exec --json`. */

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const MIN_CODEX_JSON_VERSION = "0.20.0";
const PROBE_TIMEOUT_MS = 5_000;
const CACHE_VERSION = 1;

export interface CodexProbeResult {
  supported: boolean;
  version: string;
  reason?: AgentDiagnosticCode | "unparseable_version" | "version_too_old" | "json_flag_missing";
}

export type ProbeCommand = (
  bin: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

interface CachedProbe extends CodexProbeResult {
  checked_at: string;
}

interface ProbeCache {
  version: 1;
  codex: Record<string, CachedProbe>;
}

export async function probeCodex(
  home: string,
  run: ProbeCommand = runCommand,
): Promise<CodexProbeResult> {
  try { return await withAgentExecutable("codex", async () => {
  const command = agentCommand("codex", []);
  let versionText: string;
  try {
    const answer = await run("codex", ["--version"]);
    versionText = `${answer.stdout}\n${answer.stderr}`.trim().slice(0, 200);
  } catch (error) {
    return { supported: false, version: "unavailable", reason: executableDiagnostic(error) };
  }
  const version = parseVersion(versionText);
  if (!version) return { supported: false, version: versionText || "unknown", reason: "unparseable_version" };

  const cache = await readCache(home);
  const cached = cache.codex[`${command.fingerprint}:${version}`];
  if (cached) return publicResult(cached);

  let result: CodexProbeResult;
  if (compareVersions(version, MIN_CODEX_JSON_VERSION) < 0) {
    result = { supported: false, version, reason: "version_too_old" };
  } else {
    try {
      const help = await run("codex", ["exec", "--help"]);
      const text = `${help.stdout}\n${help.stderr}`;
      result = /(^|\s)--json(?:\s|,|$)/m.test(text)
        ? { supported: true, version }
        : { supported: false, version, reason: "json_flag_missing" };
    } catch {
      result = { supported: false, version, reason: "json_flag_missing" };
    }
  }
  cache.codex[`${command.fingerprint}:${version}`] = { ...result, checked_at: new Date().toISOString() };
  await writeCache(home, cache);
  return result;
  }); } catch (error) {
    return { supported: false, version: "unavailable", reason: executableDiagnostic(error) };
  }
}

export function codexProbeCachePath(home: string): string {
  return path.join(path.resolve(home), ".octopus-runner", "codex-probes.json");
}

function parseVersion(text: string): string | null {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/i.exec(text);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

function publicResult(value: CachedProbe): CodexProbeResult {
  return {
    supported: value.supported,
    version: value.version,
    ...(value.reason ? { reason: value.reason } : {}),
  };
}

async function readCache(home: string): Promise<ProbeCache> {
  try {
    const value = JSON.parse(await fs.readFile(codexProbeCachePath(home), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid cache");
    const row = value as { version?: unknown; codex?: unknown };
    if (row.version !== CACHE_VERSION || !row.codex || typeof row.codex !== "object" || Array.isArray(row.codex)) {
      throw new Error("invalid cache");
    }
    return { version: CACHE_VERSION, codex: row.codex as Record<string, CachedProbe> };
  } catch {
    // This cache is an optimisation, never authority. A partial/manual edit is
    // safely repaired by probing the local binary again.
    return { version: CACHE_VERSION, codex: {} };
  }
}

async function writeCache(home: string, value: ProbeCache): Promise<void> {
  const target = codexProbeCachePath(home);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const temp = path.join(dir, `.codex-probes.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
    await fs.chmod(target, 0o600);
    const directory = await fs.open(dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

function runCommand(bin: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const command = agentCommand("codex", args);
  return new Promise((resolve, reject) => {
    execFile(
      command.bin,
      command.args,
      { env: command.env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}
