/** Durable publisher-code trust. This is not a capability grant. */

import type { AppTrustRow, Store } from "../store/store.js";

export type AppExecutionProfile = "declarative" | "publisher-js";

export interface AppReleaseIdentity {
  appId: string;
  publisher: string;
  profile: AppExecutionProfile;
  packageDigest: string;
}

export interface AppTrustDecision {
  owner: string;
  appId: string;
  publisher: string;
  profile: AppExecutionProfile;
  packageDigestAtConsent: string;
  followUpdates: boolean;
  decidedAt: string;
  revokedAt: string | null;
}

export type AppTrustStatus =
  | { trusted: true; reason: "exact_release" | "publisher_updates"; decision: AppTrustDecision }
  | { trusted: true; reason: "first_party"; decision: null }
  | {
      trusted: false;
      reason: "never_decided" | "revoked" | "profile_changed" | "release_changed";
      decision: AppTrustDecision | null;
    };

/**
 * Releases built from this repository: Session Plus and the `packages/*-view`
 * packs publish as `octopus:first-party` (or `octopus:demo`). Their code is
 * reviewed and landed like the rest of the host, and only the administrator or
 * deployment path installs and activates a release, so asking every account to
 * consent to every release of them guarded nothing (O12/D4). They are trusted
 * without a row; any other publisher keeps the consent door unchanged.
 */
export const FIRST_PARTY_PUBLISHER_PREFIX = "octopus:";

export function isFirstPartyPublisher(publisher: string): boolean {
  return publisher.startsWith(FIRST_PARTY_PUBLISHER_PREFIX);
}

/**
 * A tiny control for the first of the two App gates:
 *
 * - this service answers only whether publisher code may be loaded;
 * - PermissionService records what operations the App may request;
 * - the capability Gate still decides every actual operation.
 */
export class AppTrustService {
  private readonly now: () => number;

  constructor(private readonly store: Store, now: () => number = Date.now) {
    this.now = now;
  }

  status(owner: string, release: AppReleaseIdentity): AppTrustStatus {
    if (isFirstPartyPublisher(release.publisher)) return { trusted: true, reason: "first_party", decision: null };
    const row = this.store.getAppTrust(owner, release.appId, release.publisher);
    if (!row) return { trusted: false, reason: "never_decided", decision: null };
    const decision = fromRow(row);
    if (row.revoked_at) return { trusted: false, reason: "revoked", decision };
    if (row.profile !== release.profile) {
      return { trusted: false, reason: "profile_changed", decision };
    }
    if (row.package_digest_at_consent === release.packageDigest) {
      return { trusted: true, reason: "exact_release", decision };
    }
    return row.follow_updates
      ? { trusted: true, reason: "publisher_updates", decision }
      : { trusted: false, reason: "release_changed", decision };
  }

  trust(owner: string, release: AppReleaseIdentity, followUpdates: boolean): AppTrustDecision {
    if (
      !owner
      || !release.appId
      || !release.publisher
      || (release.profile !== "declarative" && release.profile !== "publisher-js")
      || !/^[0-9a-f]{64}$/.test(release.packageDigest)
    ) {
      throw new Error("app trust identity is incomplete");
    }
    const row: AppTrustRow = {
      owner,
      app_id: release.appId,
      publisher: release.publisher,
      profile: release.profile,
      package_digest_at_consent: release.packageDigest,
      follow_updates: followUpdates ? 1 : 0,
      decided_at: new Date(this.now()).toISOString(),
      revoked_at: null,
    };
    this.store.saveAppTrust(row);
    return fromRow(row);
  }

  revoke(owner: string, release: Pick<AppReleaseIdentity, "appId" | "publisher">): boolean {
    return this.store.revokeAppTrust(
      owner,
      release.appId,
      release.publisher,
      new Date(this.now()).toISOString(),
    );
  }
}

function fromRow(row: AppTrustRow): AppTrustDecision {
  return {
    owner: row.owner,
    appId: row.app_id,
    publisher: row.publisher,
    profile: row.profile === "declarative" ? "declarative" : "publisher-js",
    packageDigestAtConsent: row.package_digest_at_consent,
    followUpdates: row.follow_updates === 1,
    decidedAt: row.decided_at,
    revokedAt: row.revoked_at,
  };
}
