#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { callLiveMcpTool, MCP_FALLBACK_TIMEOUT_MS, renderMcpToolResult } from "./mcp-fallback.js";

function timeoutFromEnv(value: string | undefined): number {
  if (value === undefined) return MCP_FALLBACK_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 60 * 60_000) {
    throw new Error("OMP_MCP_TIMEOUT_MS must be an integer between 1000 and 3600000");
  }
  return parsed;
}

function objectArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("tool arguments must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function runMcpFallbackCli(
  argv: readonly string[],
  opts: { cwd?: string; timeoutEnv?: string; write?: (text: string) => void } = {},
): Promise<number> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length !== 3 || args.some((arg) => !arg.trim())) {
    throw new Error("usage: pnpm devpipe:call -- <server> <tool> '<json-object>'");
  }
  const result = await callLiveMcpTool({
    cwd: opts.cwd ?? process.cwd(),
    server: args[0],
    tool: args[1],
    arguments: objectArguments(args[2]),
    timeoutMs: timeoutFromEnv(opts.timeoutEnv ?? process.env.OMP_MCP_TIMEOUT_MS),
  });
  opts.write?.(renderMcpToolResult(result));
  return result.isError === true ? 1 : 0;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runMcpFallbackCli(process.argv.slice(2), {
      write: (text) => process.stdout.write(`${text}\n`),
    });
  } catch (err) {
    process.stderr.write(`devpipe recovery call failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
