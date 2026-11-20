/**
 * One-shot hand-off of a git bundle to a contributor's dev container.
 *
 * The bot host cannot ssh into an intern's laptop, and the container must not
 * hold a long-lived credential for this repository (the CI container's rule:
 * a bundle is a file, a clone is a credential). So the pipeline writes the
 * exact commits a turn needs into a bundle file, registers it here, and runs
 * ONE `curl` inside the container through the Runner. The URL carries a
 * random token that is good for one download within a short TTL and names
 * exactly one file — there is nothing else it can ask for.
 *
 * In-memory on purpose: a token that survived a restart would point at a file
 * the restart may have cleaned up, and a hand-off that did not complete within
 * its TTL is retried by the next sync, not recovered.
 */

import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

export const BUNDLE_TOKEN_PREFIX = "bt_";
export const DEFAULT_BUNDLE_TTL_MS = 120_000;

interface Offer {
  path: string;
  purpose?: string;
  identity?: string;
  expiresAt: number;
  /** Removed from disk after the single download or on expiry. */
  cleanup: boolean;
}

export interface BundleTake {
  path: string;
  purpose?: string;
  identity?: string;
  /** Call once the bytes have been sent (or sending failed) to drop the file. */
  done(): Promise<void>;
}

export class BundleHandoff {
  private readonly offers = new Map<string, Offer>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Register a bundle file; returns the one-shot token to put in the URL. */
  offer(path: string, opts: { ttlMs?: number; cleanup?: boolean; purpose?: string; identity?: string } = {}): string {
    this.sweep();
    const token = BUNDLE_TOKEN_PREFIX + randomBytes(24).toString("hex");
    this.offers.set(token, {
      path,
      purpose: opts.purpose?.slice(0, 80),
      identity: opts.identity?.slice(0, 100),
      expiresAt: this.now() + (opts.ttlMs ?? DEFAULT_BUNDLE_TTL_MS),
      cleanup: opts.cleanup ?? true,
    });
    return token;
  }

  /**
   * Redeem a token. Single use: the second caller gets null whatever the first
   * one did with the bytes. Expired tokens are null as well.
   */
  take(token: string): BundleTake | null {
    this.sweep();
    const offer = this.offers.get(token);
    if (!offer) return null;
    this.offers.delete(token);
    return {
      path: offer.path,
      purpose: offer.purpose,
      identity: offer.identity,
      done: async () => {
        if (offer.cleanup) await rm(offer.path, { force: true }).catch(() => {});
      },
    };
  }

  /** Forget an offer that will never be downloaded (the sync gave up early). */
  revoke(token: string): void {
    const offer = this.offers.get(token);
    this.offers.delete(token);
    if (offer?.cleanup) void rm(offer.path, { force: true }).catch(() => {});
  }

  /** Test/diagnostics: how many offers are outstanding. */
  get size(): number {
    this.sweep();
    return this.offers.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, offer] of this.offers) {
      if (offer.expiresAt <= now) {
        this.offers.delete(token);
        if (offer.cleanup) void rm(offer.path, { force: true }).catch(() => {});
      }
    }
  }
}

/** Shape check for a token taken out of a URL, before any map lookup. */
export function looksLikeBundleToken(token: string): boolean {
  return /^bt_[0-9a-f]{48}$/.test(token);
}
