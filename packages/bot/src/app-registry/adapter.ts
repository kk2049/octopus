/**
 * What this platform has to be told about ONE Agentic App to serve it.
 *
 * ── Why this interface exists at all ────────────────────────────────────────
 *
 * The registry answers "which immutable release is active" for any app. The
 * transition machinery (`HostedApp`) answers "in what order does a release
 * become the one being served". Neither of them can answer the questions that
 * are about a specific app: can this build run these bytes, which permission
 * contract does this shape imply, which origin must this release be served
 * from, where does its backend tree live. Those answers used to be reachable
 * only by importing `SessionPlusReleaseAdapter` into the host, which is what
 * made "a second production app" a change to the platform rather than an entry
 * in a table.
 *
 * ── What an adapter may and may not decide ──────────────────────────────────
 *
 * It decides REFUSALS about its own app, and it produces a prepared release.
 * It does not decide when the active pointer moves, it does not touch the
 * registry, and it is not an authorization boundary: every caller of every
 * method here has already been authorized by the panel's route table. An
 * adapter that can be constructed is one a deployer wrote into a composition
 * root — it is not discovered, downloaded, or named by a request.
 *
 * ── Two type parameters, and why they are not `unknown` ─────────────────────
 *
 * `Prepared` is whatever the app's own trusted code needs from a release (for
 * Session Plus: identity, manifest, module plan, materialised directory), and
 * `Settings` is the deployment shape it must be served under. The catalog
 * carries them opaquely — it only ever hands them back to the same adapter or
 * to the composition root that registered it — but the composition root keeps
 * them typed, so `active()?.prepared.identity` stays a compile-time fact rather
 * than a cast.
 */

import type { AppReleaseDescriptor, InstalledRelease } from "@claude-bot/app-registry";
import type { PublishedViewDocument } from "../app-core/view-app.js";
import type { ReleaseBundle } from "./bundle.js";

/** Why this build refuses to run a release. App-specific vocabulary. */
export interface AdapterRefusal {
  code: string;
  message: string;
}

export type AdapterCompatibility = { supported: true } | ({ supported: false } & AdapterRefusal);

export type AdapterPrepareOutcome<Prepared> =
  | { ok: true; prepared: Prepared }
  | ({ ok: false } & AdapterRefusal);

export type AdapterSettingsOutcome<Settings> =
  | { ok: true; settings: Settings }
  | ({ ok: false } & AdapterRefusal);

/** What a runtime swap needs in order to start a candidate child. */
export interface AppRuntimeTarget {
  /** The materialised backend tree this release's sandbox loads from. */
  appDir: string;
  /** The digest the child must report having loaded, or the activation fails. */
  backendCodeDigest: string;
}

/** Whether two prepared releases may keep writing the same durable streams. */
export type AppReleaseCoexistence =
  | { coexist: true }
  | { coexist: false; reason: string };

export interface AppReleaseAdapter<Prepared = unknown, Settings = unknown> {
  /** The app this adapter serves. One entry per id in a catalog. */
  readonly stableAppId: string;
  readonly publisher: string;

  /**
   * Whether this app has a checkout its first release can be seeded from.
   *
   * Absent means yes, which is right for every app compiled into this build.
   * `false` is for an app whose bytes only ever ARRIVE — a declared App
   * (`declared-adapter.ts`) has no source tree here, so "no release installed
   * yet" is its ordinary initial state rather than a build that failed.
   *
   * A flag rather than "call `checkoutBundle()` and see whether it throws",
   * because those two states need different words: one is an operator's next
   * step, the other is something an operator has to fix. Reading the difference
   * out of an exception message would make it a string comparison.
   */
  readonly seedsFromCheckout?: boolean;

  /** Is this release even addressed to the app this adapter serves? */
  supports(descriptor: AppReleaseDescriptor): boolean;

  /**
   * The refusals decidable from the descriptor alone — no filesystem, no child
   * process, no side effect. The management listing asks this about every
   * installed release, so it has to stay cheap.
   */
  compatibility(descriptor: AppReleaseDescriptor): AdapterCompatibility;

  /**
   * Everything that has to be true before an activation may be attempted.
   * Must not touch the active pointer or any live instance: a failure here has
   * to leave a working deployment exactly as it was.
   */
  prepare(
    release: InstalledRelease,
    readAsset: (name: string) => Uint8Array | null,
  ): Promise<AdapterPrepareOutcome<Prepared>>;

  /**
   * Decide whether existing instances may remain writable beside a candidate.
   *
   * Optional by design: an adapter that has not stated and tested its state
   * compatibility rules fails safe to a normal swap in `HostedApp`.
   */
  coexistence?(previous: Prepared, candidate: Prepared): AppReleaseCoexistence;

  /**
   * The deployment settings this particular release must be served under.
   *
   * Separate from `prepare` because it is the one refusal that is about the
   * DEPLOYMENT rather than the bytes: a host pinned to one hostname cannot
   * serve a release addressed to another, however valid that release is.
   */
  settingsFor(prepared: Prepared): AdapterSettingsOutcome<Settings>;

  /** Where the sandbox child loads this release's backend from. */
  runtimeTargetOf(prepared: Prepared): AppRuntimeTarget;

  /** This release's document, composed under one response nonce. */
  documentOf(prepared: Prepared, nonce: string): PublishedViewDocument;

  /** The origin a browser reaches this release at, for display only. */
  viewOriginOf(settings: Settings): string | null;

  /**
   * The bundle this checkout would build for this app.
   *
   * Used to seed an empty registry on first boot and to tell the management
   * page whether the running code's own package is installed. Throwing is a
   * legitimate answer (no built View in this deployment); callers treat it as
   * "cannot describe this checkout" rather than inventing a digest.
   */
  checkoutBundle(): ReleaseBundle;
}
