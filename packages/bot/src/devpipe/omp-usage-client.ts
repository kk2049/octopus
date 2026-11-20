/** One-shot, bounded reader for OMP's multi-account Codex usage projection. */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const STOP_GRACE_MS = 1_000;

export interface OmpUsageClientOptions {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Run `omp usage` for the Codex provider. OMP owns credential discovery,
 * account balancing, and upstream schema adaptation; this boundary only
 * accepts its redacted JSON projection. stdout and stderr share a strict byte
 * budget, the command has a hard deadline, and stderr is never copied into an
 * error returned to callers.
 */
export async function readOmpCodexUsage(opts: OmpUsageClientOptions = {}): Promise<unknown> {
  const command = opts.command ?? "omp";
  const args = opts.args ?? ["usage", "--json", "--provider", "openai-codex", "--redact"];
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1024, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let settled = false;
    let exited = false;
    let outputBytes = 0;
    let requestTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const stopChild = (): void => {
      if (exited) return;
      try {
        child.kill("SIGTERM");
      } catch {
        return;
      }
      forceKillTimer = setTimeout(() => {
        if (!exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already exited.
          }
        }
      }, STOP_GRACE_MS);
      forceKillTimer.unref();
    };

    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      stopChild();
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (reason: string): void => finish(new Error(reason));

    const countOutput = (chunk: Buffer): boolean => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= maxOutputBytes) return true;
      fail("OMP usage exceeded its output limit");
      return false;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (!settled && countOutput(chunk)) stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!settled) countOutput(chunk);
    });
    child.once("error", () => fail("OMP usage could not start"));
    child.once("exit", () => {
      exited = true;
      clearTimeout(forceKillTimer);
    });
    child.once("close", (code) => {
      exited = true;
      clearTimeout(forceKillTimer);
      if (settled) return;
      if (code !== 0) {
        fail("OMP usage exited unsuccessfully");
        return;
      }
      try {
        finish(null, JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")));
      } catch {
        fail("OMP usage returned invalid JSON");
      }
    });

    requestTimer = setTimeout(() => fail("OMP usage request timed out"), timeoutMs);
    requestTimer.unref();
  });
}
