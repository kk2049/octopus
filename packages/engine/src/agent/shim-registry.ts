/**
 * Per-turn capability tokens for CLI agents (devpipe's DEVPIPE_TOKEN pattern,
 * generalized). A CLI turn cannot hold a closure, so its MCP shim calls back
 * over loopback HTTP with a token that resolves to THIS turn's callTool —
 * validation, predicates and authorship still happen exactly once, in-process,
 * behind the same dispatch door. The token dies with the turn: a stale shim
 * from a killed turn gets "token 无效", never a live tool.
 */

import { randomBytes } from "node:crypto";

export type ShimHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

interface Entry {
  handler: ShimHandler;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

export function mintShimToken(handler: ShimHandler, ttlMs = 30 * 60_000): string {
  const token = "shim_" + randomBytes(24).toString("hex");
  entries.set(token, { handler, expiresAt: Date.now() + ttlMs });
  return token;
}

export function revokeShimToken(token: string): void {
  entries.delete(token);
}

export function resolveShimToken(token: string): ShimHandler | null {
  const e = entries.get(token);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    entries.delete(token);
    return null;
  }
  return e.handler;
}
