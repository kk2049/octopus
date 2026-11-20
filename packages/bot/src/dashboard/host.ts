/**
 * Public-host detection for onboarding tutorials. A runner on someone's
 * laptop must dial the bot's outside address — which the bot itself only
 * knows by asking: EC2 instance metadata first (authoritative when present),
 * then an outbound IP echo. Result is cached for the process lifetime;
 * config `dashboard.public_host` bypasses detection entirely (see bootstrap-v3.ts).
 */

import { createLogger } from "../logger.js";

const log = createLogger("public-host");

const IMDS_BASE = "http://169.254.169.254/latest";
const ECHO_URL = "https://checkip.amazonaws.com";

function isLikelyIp(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^[0-9a-f:]+$/i.test(s);
}

async function probe(fetchFn: typeof fetch): Promise<string | null> {
  // 1) EC2 IMDSv2: token handshake, then the public IPv4 document.
  try {
    const tok = await fetchFn(`${IMDS_BASE}/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(1500),
    });
    if (tok.ok) {
      const res = await fetchFn(`${IMDS_BASE}/meta-data/public-ipv4`, {
        headers: { "X-aws-ec2-metadata-token": await tok.text() },
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const ip = (await res.text()).trim();
        if (isLikelyIp(ip)) {
          log.info(`Public host via EC2 metadata: ${ip}`);
          return ip;
        }
      }
    }
  } catch {
    // Not on EC2 (or IMDS disabled) — fall through.
  }

  // 2) Outbound echo — sees the NAT'd source address.
  try {
    const res = await fetchFn(ECHO_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const ip = (await res.text()).trim();
      if (isLikelyIp(ip)) {
        log.info(`Public host via IP echo: ${ip}`);
        return ip;
      }
    }
  } catch {
    // Offline / egress blocked.
  }

  log.warn("Public host detection failed; tutorials will fall back to the request Host header");
  return null;
}

let cache: Promise<string | null> | undefined;

/** Detect this machine's public address. Cached after the first call (null included). */
export function detectPublicHost(fetchFn: typeof fetch = fetch): Promise<string | null> {
  cache ??= probe(fetchFn);
  return cache;
}

export function resetPublicHostCacheForTest(): void {
  cache = undefined;
}
