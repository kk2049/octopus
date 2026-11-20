/**
 * Where the Session Hub looks for sessions ON THE BOT HOST.
 *
 * Two things live here, both pure, because both are decisions that used to be
 * inline in an entry point and are worth being able to test without booting a
 * process.
 *
 * ── Why the setting moved ──────────────────────────────────────────────
 *
 * `scan_homes` was declared under `secretary`. The Session Hub read it anyway,
 * which was fine while a Secretary existed — but the secretary network is
 * retired (2026-10-15), and a control plane should not depend on a key owned by
 * a service that no longer exists. `session_hub.scan_homes` is the same map
 * under the right owner; the old location keeps working and says so once at
 * startup, because silently honouring a deprecated key is how a config ends up
 * meaning two things.
 *
 * Precedence is per-user rather than per-map: the new location wins for the
 * users it names, the old one still answers for the rest. A whole-map override
 * would turn "I moved one user across" into "I dropped everyone else".
 */

/** The two places the same map may be declared. */
export interface ScanHomeConfig {
  /** `session_hub.scan_homes` — the owner of this setting. */
  sessionHub?: Record<string, string>;
  /** `secretary.scan_homes` — honoured, deprecated. */
  secretary?: Record<string, string>;
}

export interface MergedScanHomes {
  /** username → declared home, new location winning per user. */
  homes: Record<string, string>;
  /**
   * Users whose home is currently coming from the deprecated location. Empty
   * when nobody relies on it, so the caller's warning stays silent for a
   * correctly-configured host rather than nagging on every boot.
   */
  deprecated: string[];
}

export function mergeScanHomes(config: ScanHomeConfig): MergedScanHomes {
  const secretary = config.secretary ?? {};
  const sessionHub = config.sessionHub ?? {};
  const homes: Record<string, string> = { ...secretary, ...sessionHub };
  const deprecated = Object.keys(secretary)
    .filter((u) => !Object.prototype.hasOwnProperty.call(sessionHub, u))
    .sort();
  return { homes, deprecated };
}

/**
 * Which accounts a single `SESSIONS_SCAN_HOME` would collapse onto one root.
 *
 * The env var is one process-wide value sitting in the middle of a per-user
 * precedence chain, so on a multi-user host every account without an explicit
 * entry resolves to the SAME scan root — and the session browser, its search
 * and its live view then answer with somebody else's transcripts while the
 * audit log still shows the caller's own name. It is a dev convenience; the
 * caller logs this loudly rather than letting it be discovered.
 *
 * Returns the affected usernames (more than one is the dangerous case), or an
 * empty list when the variable is unset or only one account would use it.
 */
export function sharedEnvScanUsers(o: {
  envHome?: string;
  declared: Record<string, string>;
  users: readonly string[];
}): string[] {
  if (!o.envHome) return [];
  const named = new Set(Object.keys(o.declared));
  const shared = o.users.filter((u) => !named.has(u));
  return shared.length > 1 ? [...shared].sort() : [];
}
