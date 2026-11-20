/**
 * MCP token lifecycle helpers — mint, resolve, and the credential handle.
 *
 * The plaintext exists exactly twice: in the mint response the person copies,
 * and in the `Authorization` header their agent sends back. Storage holds the
 * sha256 (the same `hashRunnerToken` every other credential table uses), so a
 * database leak leaks nothing connectable.
 *
 * The CREDENTIAL handle is derived from the stored hash rather than from the
 * plaintext, deliberately: revocation only has the row, and it must be able to
 * compute exactly which pooled Contexts, leases and scopes that token opened.
 */

import { randomUUID } from "node:crypto";
import { hashRunnerToken } from "../runner/gateway.js";
import type { McpTokenRow, Store } from "../store/store.js";
import {
  decodeMcpTokenPolicy,
  mcpTokenPolicy,
  type McpTokenPolicy,
} from "./policy-contract.js";

export {
  FEISHU_DOC_SHARE_ID,
  MCP_TOKEN_POLICY_SCHEMA,
  MCP_TOOL_GROUPS,
  decodeMcpTokenPolicy,
  mcpDocAssistantPolicy,
  mcpFeishuDocSharePolicy,
  mcpSessionExecutionPolicy,
  mcpTicketDevelopmentPolicy,
  mcpTokenPolicy,
  type McpTokenPolicy,
  type McpToolGroup,
} from "./policy-contract.js";

export const MCP_TOKEN_PREFIX = "mcp_";

/** Label shown in the token list; bounded because it renders in a table. */
export const MCP_TOKEN_LABEL_MAX = 64;

/** Optional TTL bounds, in days. */
export const MCP_TOKEN_TTL_DAYS_MAX = 365;

export interface MintedMcpToken {
  /** Shown once. Never stored, never logged. */
  token: string;
  row: McpTokenRow;
}

/** The credential facts the Runner Gateway may retain for a tentacle link. */
export interface TentacleMcpCredential {
  username: string;
  tokenHash: string;
}

/**
 * Resolve the user half of a dsh tentacle registration.
 *
 * Unlike the ordinary MCP endpoint, this is a NEW surface.  Pre-v38 NULL
 * policies therefore fail closed instead of inheriting the new authority: the
 * token must explicitly carry the `tentacle` attenuation group.
 */
export function resolveTentacleMcpCredential(
  store: Store,
  presented: string,
  now: () => number = Date.now,
): TentacleMcpCredential | null {
  if (!presented.startsWith(MCP_TOKEN_PREFIX)) return null;
  const tokenHash = hashRunnerToken(presented);
  const row = store.getActiveMcpTokenByHash(tokenHash, new Date(now()).toISOString());
  if (!row) return null;
  let policy: McpTokenPolicy | undefined;
  try {
    policy = decodeMcpTokenPolicy(row.policy_json);
  } catch {
    return null;
  }
  if (!policy?.groups.includes("tentacle")) return null;
  store.touchMcpToken(tokenHash, new Date(now()).toISOString());
  return { username: row.username, tokenHash };
}

/** Re-check a connected tentacle without retaining its plaintext mcp_ token. */
export function tentacleMcpCredentialIsActive(
  store: Store,
  credential: TentacleMcpCredential,
  now: () => number = Date.now,
): boolean {
  const row = store.getActiveMcpTokenByHash(credential.tokenHash, new Date(now()).toISOString());
  if (!row || row.username !== credential.username) return false;
  try {
    return decodeMcpTokenPolicy(row.policy_json)?.groups.includes("tentacle") === true;
  } catch {
    return false;
  }
}

export function mintMcpToken(
  store: Pick<Store, "saveMcpToken">,
  o: {
    username: string;
    label: string;
    ttlDays?: number;
    /** Internal short-lived credentials use milliseconds; public routes use days. */
    ttlMs?: number;
    policy?: McpTokenPolicy;
    now?: () => number;
  },
): MintedMcpToken {
  const now = o.now ?? Date.now;
  const token = MCP_TOKEN_PREFIX + randomUUID().replace(/-/g, "");
  const createdAt = new Date(now()).toISOString();
  const ttlMs = o.ttlMs !== undefined && Number.isFinite(o.ttlMs) && o.ttlMs > 0
    ? Math.min(Math.floor(o.ttlMs), MCP_TOKEN_TTL_DAYS_MAX * 24 * 60 * 60 * 1000)
    : o.ttlDays !== undefined && Number.isFinite(o.ttlDays) && o.ttlDays > 0
      ? Math.min(Math.floor(o.ttlDays), MCP_TOKEN_TTL_DAYS_MAX) * 24 * 60 * 60 * 1000
      : null;
  const row: McpTokenRow = {
    token_hash: hashRunnerToken(token),
    username: o.username,
    label: o.label.trim().slice(0, MCP_TOKEN_LABEL_MAX),
    created_at: createdAt,
    expires_at: ttlMs ? new Date(now() + ttlMs).toISOString() : null,
    last_used_at: null,
    revoked_at: null,
    policy_json: JSON.stringify(o.policy ?? mcpTokenPolicy({})),
  };
  store.saveMcpToken(row);
  return { token, row };
}

/**
 * The one-way pool/lease handle for one MCP token. `mcp:` keeps this
 * credential namespace disjoint from browser logins (`ws:`) and dashboard
 * bearers (`bt:`), so revoking a token can name exactly its own derivations.
 */
export function mcpCredentialOf(tokenHash: string): string {
  return `mcp:${tokenHash.slice(0, 16)}`;
}

/**
 * The one-click registration block for one deployment. Pure data the UI and
 * the token APIs both return, so the two cannot describe different endpoints.
 * `server` names the MCP server entry and fills in a token minted for exactly
 * this answer (a document share's key); without it the block is a template.
 * `scope: "user"` registers it for every project of that Claude Code user.
 */
export function mcpRegistration(publicUrl: string | undefined, boundPort: number, server: { name?: string; token?: string; scope?: "user" } = {}): {
  endpoint: string;
  command: string;
  config: Record<string, unknown>;
} {
  const base = (publicUrl ?? "").replace(/\/+$/, "") || `http://127.0.0.1:${boundPort}`;
  const endpoint = `${base}/api/mcp`;
  const name = server.name ?? "octopus";
  const bearer = server.token ?? "<mcp_token>";
  return {
    endpoint,
    command: `claude mcp add --transport http${server.scope ? ` --scope ${server.scope}` : ""} ${name} ${endpoint} --header "Authorization: Bearer ${bearer}"`,
    config: {
      mcpServers: {
        [name]: {
          type: "http",
          url: endpoint,
          headers: { Authorization: `Bearer ${bearer}` },
        },
      },
    },
  };
}
