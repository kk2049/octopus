/**
 * Remote-mode client for the sessions MCP server.
 *
 * When the investigated user's sessions live on their own laptop, the bot
 * exposes a capability loopback that resolves this process's token to ONE
 * bound facade (packages/bot/src/runner/loopback.ts). This module is the thin
 * client side of that hop: same operation names and args as the local scan
 * layer, so the MCP server can dispatch to either transparently.
 *
 * Note what is NOT sent: no username, no device owner, no "approved". Identity
 * is a property of the token's server-side binding, and stating it in the body
 * is rejected by the loopback rather than cross-checked.
 */

export interface RemoteSessionsConfig {
  /** Loopback base URL of the capability service, e.g. http://127.0.0.1:41233 */
  api: string;
  /** Per-grant transport credential; resolves server-side to a bound facade. */
  token: string;
  /** Which slot of the bound Context to use. Defaults to "runner". */
  slot?: string;
}

export function remoteConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteSessionsConfig | null {
  const api = env.SESSIONS_REMOTE_API;
  const token = env.SESSIONS_REMOTE_TOKEN;
  if (!api || !token) return null;
  return { api: api.replace(/\/$/, ""), token, slot: env.SESSIONS_REMOTE_SLOT || "runner" };
}

export async function remoteSessionsCall(
  cfg: RemoteSessionsConfig,
  operation: string,
  args: Record<string, unknown>,
  timeoutMs = 45_000,
): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("runner request timed out")), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${cfg.api}/rpc`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-internal-token": cfg.token,
      },
      body: JSON.stringify({ slot: cfg.slot ?? "runner", operation, args }),
    });
  } finally {
    clearTimeout(timer);
  }
  const body = (await resp.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
  if (!resp.ok || !body.ok) {
    throw new Error(body.error || `capability gateway error (HTTP ${resp.status})`);
  }
  return body.result;
}
