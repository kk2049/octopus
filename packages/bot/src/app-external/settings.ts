/**
 * Which external hosts this deployment is willing to hand an App binding to.
 *
 * ── Why this is configuration and not a page control ────────────────────────
 *
 * The allowlist decides which ORIGINS may hold a credential for this server's
 * users. That is an operator statement about the machine, not a per-user
 * choice: a person clicking "send this to my DSH" must not be able to name an
 * arbitrary origin, or the launch link becomes a general credential exfiltrator
 * with a friendly button. So a person picks from this list by id, and the id
 * resolves to an exact origin here.
 *
 * ── Fail closed, in the two ways that matter ────────────────────────────────
 *
 *  1. **Absent means off.** No `external_app_hosts:` key, or an empty list, and
 *     every route in `external-app-host/v1` is 404. There is no default host and
 *     no implicit localhost.
 *  2. **A malformed or unsafe entry is a BOOT failure, not a skipped row.**
 *     Startup validation is the last moment a person is present; a server that
 *     silently dropped one entry would answer "that host is not allowed" for a
 *     host somebody believed they had configured, and the same shape of typo in
 *     the other direction would widen the allowlist.
 *
 * ── What an entry may say: one exact LOOPBACK origin ───────────────────────
 *
 * An exact origin — scheme, loopback host, optional port — and nothing else.
 * No wildcards, no path, no userinfo, no trailing slash, no explicitly spelled
 * default port.
 *
 * The host must be `127.0.0.1`, `localhost` or `[::1]`, for `https` exactly as
 * for `http`. That is narrower than "encrypt it if it is remote", and
 * deliberately so: this contract's whole safety argument is that the external
 * shell runs on the SAME machine, under Octopus's own supervision (for example
 * a local dsh on loopback). A remote origin would mean a standing App credential leaving this
 * host to a party this server cannot see, revoke locally, or reason about — a
 * different trust question, which a later version may answer with its own
 * evidence. Until then it is refused at boot rather than at review time.
 */

import type { ExternalAppHostsConfig, ExternalAppHostConfig } from "../config.js";

export interface ExternalAppHostSettings {
  /** Stable id a person picks and a launch grant is bound to. */
  id: string;
  /** Human label shown on the trusted page. */
  label: string;
  /** Exact origin. The only value ever compared against an `Origin` header. */
  origin: string;
  /** Absolute path on the host that receives the launch fragment. */
  launchPath: string;
}

export interface ExternalAppHostingSettings {
  hosts: ReadonlyMap<string, ExternalAppHostSettings>;
  /** Every allowed origin, for the transport's preflight answer. */
  origins: ReadonlySet<string>;
  /** Seconds a launch grant stays redeemable. */
  launchTtlSeconds: number;
  /** Seconds an exchanged capability stays usable before it must be re-minted. */
  capabilityTtlSeconds: number;
  /** How many live bindings one account may hold per App. */
  maxBindingsPerUser: number;
}

const HOST_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * The only hostnames an external App host may live on.
 *
 * `URL.hostname` reports an IPv6 literal WITH its brackets, which is also how
 * an operator writes it and how an `Origin` header carries it — so the same
 * string is compared everywhere. No other IPv4 loopback spelling is admitted:
 * `127.0.0.2` is loopback to the kernel and is not what anyone meant to write,
 * and `2130706433` is refused a step earlier by the exact-spelling rule.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `null` = this deployment serves no external App hosts (the default). */
export function externalAppHostSettings(
  config: ExternalAppHostsConfig | undefined,
): ExternalAppHostingSettings | null {
  if (!config?.enabled) return null;
  const entries = config.hosts ?? [];
  if (entries.length === 0) {
    throw new Error("external_app_hosts.enabled requires at least one hosts[] entry");
  }
  if (entries.length > 16) throw new Error("external_app_hosts.hosts is limited to 16 entries");
  const hosts = new Map<string, ExternalAppHostSettings>();
  const origins = new Set<string>();
  for (const entry of entries) {
    const host = readHost(entry);
    if (hosts.has(host.id)) throw new Error(`external_app_hosts.hosts repeats the id ${host.id}`);
    // Two ids sharing one origin would make revocation ambiguous in the only
    // direction that matters: the Origin header cannot say which id it meant.
    if (origins.has(host.origin)) {
      throw new Error(`external_app_hosts.hosts repeats the origin ${host.origin}`);
    }
    hosts.set(host.id, host);
    origins.add(host.origin);
  }
  return {
    hosts,
    origins,
    launchTtlSeconds: integer(config.launch_ttl_seconds ?? 120, 15, 900, "external_app_hosts.launch_ttl_seconds"),
    capabilityTtlSeconds: integer(
      config.capability_ttl_seconds ?? 43_200,
      300,
      2_592_000,
      "external_app_hosts.capability_ttl_seconds",
    ),
    maxBindingsPerUser: integer(
      config.max_bindings_per_user ?? 8,
      1,
      64,
      "external_app_hosts.max_bindings_per_user",
    ),
  };
}

function readHost(entry: ExternalAppHostConfig): ExternalAppHostSettings {
  const id = String(entry?.id ?? "").trim().toLowerCase();
  if (!HOST_ID.test(id)) throw new Error(`external_app_hosts.hosts[].id ${JSON.stringify(entry?.id ?? null)} is invalid`);
  const origin = readOrigin(entry?.origin, id);
  const launchPath = String(entry?.launch_path ?? "/octopus/app-launch");
  if (!launchPath.startsWith("/") || launchPath.includes("#") || launchPath.includes("\\") || launchPath.length > 256) {
    throw new Error(`external_app_hosts.hosts[${id}].launch_path must be an absolute path without a fragment`);
  }
  const label = String(entry?.label ?? id).trim().slice(0, 80) || id;
  return { id, label, origin, launchPath };
}

/**
 * An exact origin, parsed by the URL parser rather than by a regex, and then
 * required to be equal to its own serialisation. That equality is what refuses
 * the near-misses a hand-rolled check misses: a trailing slash, a path, a
 * default port spelled explicitly, uppercase, userinfo, a query.
 */
function readOrigin(raw: unknown, id: string): string {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 253 || value.includes("*")) {
    throw new Error(`external_app_hosts.hosts[${id}].origin must be one exact origin, no wildcard`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`external_app_hosts.hosts[${id}].origin is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`external_app_hosts.hosts[${id}].origin must be http or https`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`external_app_hosts.hosts[${id}].origin must carry no path, query, fragment or userinfo`);
  }
  if (url.origin !== value) {
    // Catches every near miss the parser would otherwise normalise away: a
    // trailing slash, an explicitly written default port, uppercase, an
    // abbreviated IPv6 form.
    throw new Error(`external_app_hosts.hosts[${id}].origin must be written exactly as ${url.origin}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `external_app_hosts.hosts[${id}].origin must be a loopback origin `
        + `(127.0.0.1, localhost or [::1]); ${url.hostname} is not one`,
    );
  }
  return url.origin;
}

function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
  return value;
}

/** The launch URL a person copies. The secret is the FRAGMENT, never the path. */
export function externalLaunchUrl(host: ExternalAppHostSettings, fragmentKey: string, token: string): string {
  return `${host.origin}${host.launchPath}#${fragmentKey}=${encodeURIComponent(token)}`;
}
