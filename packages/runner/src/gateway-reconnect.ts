/** Runner-to-gateway connection policy, kept pure so outages are testable. */

export const RUNNER_GATEWAY_HANDSHAKE_TIMEOUT_MS = 10_000;
export const RUNNER_RECONNECT_MIN_MS = 1_000;
export const RUNNER_RECONNECT_MAX_MS = 10_000;
/** KDP-002: credentials and Runner registration may cross plaintext only on loopback. */
export function validateRunnerGatewayUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("OCTOPUS_URL is invalid"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const octets = host.split(".");
  const ipv4Loopback = octets.length === 4
    && octets.every((value) => /^\d{1,3}$/.test(value) && Number(value) <= 255)
    && Number(octets[0]) === 127;
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "::1" || ipv4Loopback;
  if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) || url.username || url.password || url.hash) {
    throw new Error("OCTOPUS_URL must use WSS except on an explicit loopback host");
  }
  return raw;
}

export interface RunnerReconnectPlan {
  delayMs: number;
  nextBackoffMs: number;
}

/**
 * Exponential backoff with equal jitter.
 *
 * The handshake already consumes up to ten seconds, so another minute of
 * deterministic sleep only hides recovery. Equal jitter keeps retries from a
 * fleet disconnected by one deployment from repeatedly arriving together,
 * while retaining a floor that cannot busy-loop on a broken route.
 */
export function planRunnerReconnect(
  currentBackoffMs: number,
  random: () => number = Math.random,
): RunnerReconnectPlan {
  const bounded = Math.min(
    RUNNER_RECONNECT_MAX_MS,
    Math.max(RUNNER_RECONNECT_MIN_MS, finiteOrMin(currentBackoffMs)),
  );
  const unit = Math.min(1, Math.max(0, finiteOrZero(random())));
  return {
    delayMs: Math.round(bounded / 2 + unit * bounded / 2),
    nextBackoffMs: Math.min(RUNNER_RECONNECT_MAX_MS, Math.ceil(bounded * 1.7)),
  };
}

function finiteOrMin(value: number): number {
  return Number.isFinite(value) ? value : RUNNER_RECONNECT_MIN_MS;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
