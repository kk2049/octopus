/**
 * Four identities that must never be confused with one another.
 *
 * ```text
 * stableAppId              = session-plus            what state and grants are keyed by
 * publisher                = octopus:first-party     who vouches for the package
 * packageDigest            = <registry package digest> which complete release the frame is bound to
 * permissionContractDigest = <sha256 of the ask>     what it is allowed to request
 * ```
 *
 * The distinction is the whole reason this file exists rather than a constant
 * somewhere:
 *
 *  · **State and authorisation are keyed by `stableAppId` + publisher.** A new
 *    build changes the URL the View is served from; it must not orphan the app's
 *    history, and it must not silently create a second app.
 *  · **`packageDigest` is a RUNTIME identity.** It addresses the hostname
 *    (`app-<first-20-hex>.apps.…`), so "which complete release is this iframe
 *    bound to" is answerable from the address bar. Change one byte of the package
 *    and the origin changes, old frames are cross-origin to the new one, and any
 *    cached document belongs to a host nobody serves any more.
 *  · **`permissionContractDigest` is a separate question** — what the app asks
 *    for — and it is separate because the answers differ: a code change with an
 *    unchanged contract may keep a user's grant (`host/versions.ts` in the
 *    engine already draws this line for v3 apps), while a widened contract must
 *    fail closed until somebody agrees to it. Deriving one from the other would
 *    make every typo fix look like a permission change, and every permission
 *    change look like a deploy.
 *
 * ── What v4 changed here, and why it is a deletion rather than an addition ───
 *
 * This module used to own its OWN digest framing. It no longer does: the digest
 * is `@claude-bot/app-registry`'s `computePackageDigest`, taken over the canonical
 * `AppReleaseDescriptor` that the registry stores, validates and re-validates.
 *
 * That matters because a release is now something that can be INSTALLED — bytes
 * that arrived from somewhere and are served without this checkout being
 * consulted. Two implementations of "which release is this" would mean the
 * hostname a running frame is served from could disagree with the row that says
 * which release is active, and the disagreement would be invisible: both halves
 * are self-consistent. So the identity of a Session Plus release is computed in
 * exactly one place, for the checkout and for an installed artifact alike.
 *
 * The registry digest also covers two things the old one did not — the app id,
 * the publisher and the execution profile — which is the correct behaviour for
 * an origin: the same bytes vouched for by a different publisher are a different
 * release and must not share a hostname.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  describeRelease,
  PACKAGE_LABEL_HEX,
  packageHostLabel,
  type AppReleaseDescriptor,
  type ReleaseBuildInput as RegistryBuildInput,
} from "@claude-bot/app-registry";
import { backendRelease } from "@claude-bot/app-runtime";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_CONTRACTS,
  SESSION_PLUS_PERMISSION_CONTRACT,
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
  sessionPlusContractFor,
  sessionPlusPermissionContractDigest as permissionContractDigest,
  type SessionPlusPermissionContract,
} from "../session-resource/contract.js";
import { parseAppPermissions } from "@claude-bot/agent-module-contract";
import {
  COMPOSITION_ASSET,
  MODULE_LOCK_ASSET,
  PERMISSIONS_ASSET,
  RESOURCE_BINDINGS_ASSET,
  SESSION_PLUS_MODULE_ASSETS,
} from "@claude-bot/session-plus-view/plan";
import { bundledAppDir } from "./app-path.js";
import { viewPackage, type AppPackage } from "./view-app.js";

export {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PERMISSION_CONTRACT,
  SESSION_PLUS_PUBLISHER,
} from "../session-resource/contract.js";
export type { SessionPlusPermissionContract as PermissionContract } from "../session-resource/contract.js";
export { PACKAGE_LABEL_HEX, packageHostLabel, permissionContractDigest };

/** The execution profile every Session Plus release runs under. */
export const SESSION_PLUS_EXECUTION_PROFILE = "publisher-js" as const;

/**
 * The named assets, in the order the release inventory declares them.
 *
 * Since the module platform there are more than three: the JSON documents are
 * the static assembly plan (`agent-module-lock/v1`, `agent-composition/v1` and
 * — since the read-only workspace browser — `agent-resource-bindings/v1`), plus
 * — since the write release — the App's own `app-permissions/v1` declaration.
 * They belong in the VIEW group because they describe the browser half. Being
 * release assets is the point: they are covered by `packageDigest`, so changing
 * what the App assembles, what typed ports it depends on, OR what it asks a
 * person to agree to changes the release identity and therefore the hostname,
 * exactly like changing a component does.
 *
 * `sessionPlusDescriptor` intersects this list with what a package actually
 * contains, so a legacy three-asset View still describes itself correctly.
 */
export const SESSION_PLUS_VIEW_ASSETS = [
  "view.html",
  "view.css",
  "view.js",
  MODULE_LOCK_ASSET,
  COMPOSITION_ASSET,
  RESOURCE_BINDINGS_ASSET,
  PERMISSIONS_ASSET,
] as const;
export const SESSION_PLUS_BACKEND_ASSETS = [
  "app/app.yaml",
  "app/actions.ts",
  "app/projection.ts",
  "app/pages/main.yaml",
] as const;

/**
 * Digest of the permission ask, publisher included.
 *
 * The publisher is inside because "the same operations, vouched for by someone
 * else" is a different thing to agree to — the engine's `permissionContract`
 * digest makes the same choice (`host/versions.ts`), and the two should not
 * disagree about what a contract is.
 */
/** Re-exported so callers do not have to know which layer owns the recipe shape. */
export type ReleaseBuildInput = RegistryBuildInput;

type RegistryIdentity = Pick<
  AppReleaseDescriptor,
  "stableAppId" | "publisher" | "executionProfile" | "packageDigest" | "buildInput" | "source" | "permissionContractDigest"
>;

export interface SessionPlusIdentity extends RegistryIdentity {
  /** Presentation and executable sub-digests are cache/health evidence, not identities. */
  viewAssetDigest: string;
  backendCodeDigest: string;
  sourceSnapshotDigest: string;
  recipeDigest: string;
  /** `app-<first-20-hex>` — the label, not the whole hostname. */
  packageHostLabel: string;
  /** The exact contract that digest names, from this build's closed catalog. */
  contract: SessionPlusPermissionContract;
}

/**
 * Canonical durable-state namespace for one published app.
 *
 * State survives package releases, so a package digest cannot be part of this
 * key.  A stable id alone is insufficient, though: two publishers may choose
 * the same id and must never share a stream.  JSON array framing makes the pair
 * unambiguous even when either component contains punctuation.
 */
export function sessionPlusStateAppKey(
  identity: Pick<SessionPlusIdentity, "publisher" | "stableAppId">,
): string {
  if (!identity.publisher || !identity.stableAppId) throw new Error("published app identity is incomplete");
  return JSON.stringify([identity.publisher, identity.stableAppId]);
}

const RELEASE_FILES = ["app.yaml", "actions.ts", "projection.ts", "pages/main.yaml"] as const;

/**
 * The complete immutable release: View assets, the module plan, and the
 * declarative/server assets.
 *
 * The module plan is computed rather than read from disk — it is produced by the
 * contract package's canonical encoder from the same objects the browser
 * assembles from, so the file a release ships and the plan the App runs cannot
 * be two different statements.
 */
export function sessionPlusReleasePackage(
  view: AppPackage = viewPackage(),
  appDir: string = bundledAppDir("session-plus"),
): AppPackage {
  return {
    assets: [
      ...view.assets,
      ...SESSION_PLUS_MODULE_ASSETS,
      ...RELEASE_FILES.map((name) => ({
        name: `app/${name}`,
        source: readFileSync(path.join(appDir, name), "utf8"),
      })),
    ],
  };
}

/** Hash a named asset set without attaching release recipe identity. */
export function assetDigest(pkg: AppPackage): string {
  const h = createHash("sha256");
  for (const a of pkg.assets) {
    // `\0` rather than a literal NUL byte: the framing is unchanged (the escape
    // produces exactly the same character at runtime, and the digest test pins
    // it), but a source file containing a real NUL is a file git classifies as
    // BINARY — no diff, no review and no blame.
    h.update(`${a.name}\0${Buffer.byteLength(a.source, "utf8")}\0`);
    h.update(a.source, "utf8");
  }
  return h.digest("hex");
}

/**
 * Canonical, deterministic build recipe.
 *
 * The `_v7` suffix is not cosmetic: this object is inside `packageDigest`, so
 * changing the recipe is by construction a new release identity and a new
 * hostname. `_v2` → `_v3` when the digest framing became the registry's;
 * `_v3` → `_v4` when the release started carrying a module lock and a
 * composition, because that is a different kind of artifact even where the
 * bytes of the other assets happen to be unchanged; `_v4` → `_v5` when it
 * started carrying a resource-binding plan, which is the point at which a
 * release can depend on a typed port the deployment has to provide.
 *
 * `_v5` → `_v6` when the release started carrying its OWN permission
 * declaration — again a different kind of artifact, and this one changes what a
 * release IS rather than only what it contains.
 *
 * `_v6` → `_v7` adds the explicit ESM component entry and independently
 * addressed chunk/worker inventory, bound to a shared frontend runtime ABI.
 *
 * Be precise about what the bump does and does not buy, because the neighbouring
 * axis makes it easy to overclaim. Two packages that ask for different things
 * already differ in `view/permissions.json`, which is a covered asset, so they
 * already have different package digests — the recipe is not what separates
 * them. What the recipe separates is BUILD FORMATS: a `…-v6` builder and a
 * `…-v5` builder emit different inventories from one source tree, and without
 * the bump the two would be describable as the same build of the same thing.
 * (The recipe version and the release SHAPE are different vocabularies that
 * happen to have moved together three times; do not read one as the other.)
 * Note also that `permissionContractDigest` is NOT inside the package
 * digest (the registry treats it as a second axis and refuses a package digest
 * that arrives claiming two different asks), which is exactly why the ask has to
 * be legible in a covered asset as well.
 */
export function sessionPlusReleaseBuildInput(lockfileHash: string): ReleaseBuildInput {
  return {
    entry: "packages/bot/src/session-plus/app/app.yaml",
    toolchain: {
      builder: "octopus:session-plus-release-v7",
      format: "named-utf8-assets",
      lockfile: "pnpm-lock.yaml",
    },
    lockfileHash,
  };
}

/** The lockfile hash of THIS checkout — a build input, never a release fact. */
export function checkoutLockfileHash(): string {
  const lockfile = path.resolve(bundledAppDir("session-plus"), "../../../../../pnpm-lock.yaml");
  return createHash("sha256").update(readFileSync(lockfile)).digest("hex");
}

/**
 * Which permission contract a package declares, read from the package.
 *
 * ── Two eras, and why the older one is kept verbatim ────────────────────────
 *
 * A package carrying `view/permissions.json` NAMES its contract, and this build
 * resolves that name in its closed catalog. That is the honest answer for every
 * release from the write shape onwards: the artifact says what it asks for, so
 * the description of it repeats the artifact rather than inferring it.
 *
 * A package without that document is described exactly as it was before —
 * bindings present means the eight-token workspace ask, absent means the
 * six-token one. That branch must stay byte-identical, because it decides the
 * `permissionContractDigest` of the two rollback targets: re-describing an old
 * package under a new rule would move its digest, which would move its package
 * digest, which would make the release somebody rolls back to a release that
 * has never existed.
 *
 * ── Why an unreadable declaration throws ────────────────────────────────────
 *
 * This is the BUILDER half; a checkout that cannot describe its own package is a
 * programming error, not untrusted input, and the same posture already governs
 * `buildCheckoutBundle` (which throws on `checkoutPlanProblem`) and
 * `sessionPlusIdentityOf` (which throws on a contract digest this build does not
 * implement). Nothing on the install path reaches here: an installed release
 * arrives with its descriptor already written, and the adapter re-derives
 * nothing — it CHECKS, and refuses without throwing.
 */
function declaredContract(pkg: AppPackage): SessionPlusPermissionContract {
  const declaration = pkg.assets.find((asset) => asset.name === PERMISSIONS_ASSET);
  if (!declaration) {
    return pkg.assets.some((asset) => asset.name === RESOURCE_BINDINGS_ASSET)
      ? SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT
      : SESSION_PLUS_PERMISSION_CONTRACT;
  }
  const read = parseAppPermissions(declaration.source);
  if (!read.ok) {
    throw new Error(
      `session-plus package carries an unreadable ${PERMISSIONS_ASSET}: `
        + `${read.issues[0]?.at ?? "permissions"}: ${read.issues[0]?.message ?? "invalid"}`,
    );
  }
  const known = SESSION_PLUS_CONTRACTS.find((row) => row.id === read.value.contract);
  if (!known) {
    throw new Error(
      `session-plus package declares a permission contract this build does not implement: ${read.value.contract}`,
    );
  }
  return known.contract;
}

/**
 * The canonical registry descriptor for one Session Plus package.
 *
 * Side-effect free: it takes bytes and returns the description of them.
 * `install()` will recompute all of this from the artifact rather than believing
 * the result, which is exactly why the builder half is allowed to be this small.
 *
 * It THROWS on a package it cannot describe — today, one whose permission
 * declaration is unreadable or names an unimplemented contract (see
 * `declaredContract`). That is the builder posture, not a refusal API: deciding
 * whether an ARRIVING release is acceptable is the adapter's job, where the
 * answer has a code and a message and leaves a working deployment untouched.
 */
export function sessionPlusDescriptor(input: {
  pkg: AppPackage;
  lockfileHash: string;
  publisher?: string;
  contract?: SessionPlusPermissionContract;
}): AppReleaseDescriptor {
  const publisher = input.publisher ?? SESSION_PLUS_PUBLISHER;
  const contract = input.contract ?? declaredContract(input.pkg);
  const snapshot = assetDigest(input.pkg);
  return describeRelease({
    stableAppId: SESSION_PLUS_APP_ID,
    publisher,
    executionProfile: SESSION_PLUS_EXECUTION_PROFILE,
    permissionContractDigest: permissionContractDigest(publisher, contract),
    assets: input.pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    // Which of the assets present go to the browser and which the sandbox
    // loads. Intersected with what is actually in the package rather than
    // asserted, because `composition` may only name assets the inventory has —
    // and because deciding a package is INCOMPLETE is the adapter's job, where
    // the refusal can say which release it is refusing and why. Describing and
    // accepting are two questions.
    composition: {
      view: input.pkg.assets.filter((asset) => (SESSION_PLUS_VIEW_ASSETS as readonly string[]).includes(asset.name) || asset.name === "view/entry.json" || asset.name.startsWith("view/assets/")).map((asset) => asset.name),
      backend: SESSION_PLUS_BACKEND_ASSETS.filter((name) => input.pkg.assets.some((asset) => asset.name === name)),
    },
    source: {
      kind: "platform-hosted",
      digest: snapshot,
      repository: "platform://octopus/source",
      commit: `sha256:${snapshot}`,
      subdir: "packages/bot/src/session-plus",
    },
    buildInput: sessionPlusReleaseBuildInput(input.lockfileHash),
  });
}

/**
 * The running identity of one described release.
 *
 * `backendCodeDigest` is supplied rather than derived here: it is the digest the
 * App Runtime computes from the two executable files it is about to load, and
 * there must be exactly one implementation of that framing. The caller has
 * already materialised those files (or, for the checkout, has them on disk), so
 * it is the one that can answer.
 */
export function sessionPlusIdentityOf(
  descriptor: AppReleaseDescriptor,
  parts: { backendCodeDigest: string },
): SessionPlusIdentity {
  // The contract is looked up by the descriptor's OWN digest, from the closed
  // catalog this build implements. Defaulting to the current constant is the
  // failure this lookup exists to prevent: it would describe an old release as
  // asking for whatever the newest one asks for, which is the same sentence as
  // "an expansion happened and nobody was asked". An unknown digest throws —
  // the adapter's `compatibility()` refuses it long before this point, so
  // reaching here with one is a bug in trusted composition, not input.
  const known = sessionPlusContractFor(descriptor.publisher, descriptor.permissionContractDigest);
  if (!known) {
    throw new Error(
      `session-plus release declares a permission contract this build does not implement: `
        + `${descriptor.permissionContractDigest.slice(0, 16)}…`,
    );
  }
  const contract = known.contract;
  return {
    stableAppId: descriptor.stableAppId,
    publisher: descriptor.publisher,
    executionProfile: SESSION_PLUS_EXECUTION_PROFILE,
    packageDigest: descriptor.packageDigest,
    viewAssetDigest: descriptor.evidence.viewDigest,
    backendCodeDigest: parts.backendCodeDigest,
    sourceSnapshotDigest: descriptor.source.digest,
    recipeDigest: descriptor.evidence.recipeDigest,
    buildInput: descriptor.buildInput,
    source: descriptor.source,
    permissionContractDigest: descriptor.permissionContractDigest,
    packageHostLabel: packageHostLabel(descriptor.packageDigest),
    contract,
  };
}

/**
 * The identity of the package THIS CHECKOUT would publish.
 *
 * Not necessarily the one being served: since v4 the running release comes from
 * the registry's active pointer, and a deploy of new trusted code deliberately
 * does not move it. This is what the packer publishes and what the first-run
 * seed installs.
 *
 * Recomputed for the default package because checkout assets can be rebuilt in
 * a long-lived development or test process. Caching their identity would leave
 * pinned-origin validation describing bytes that are no longer in the tree.
 */
export function sessionPlusIdentity(pkg?: AppPackage): SessionPlusIdentity {
  const view = pkg ?? viewPackage();
  const target = sessionPlusReleasePackage(view);
  const descriptor = sessionPlusDescriptor({ pkg: target, lockfileHash: checkoutLockfileHash() });
  const backend = backendRelease(bundledAppDir("session-plus"));
  return sessionPlusIdentityOf(descriptor, { backendCodeDigest: backend.backendCodeDigest });
}
