/**
 * The four identities stay four.
 *
 * Every assertion here is about a confusion that would be invisible once made:
 * keying state by a digest silently orphans an app on every deploy, and
 * deriving the permission digest from the package digest silently turns a typo
 * fix into a re-consent (or, worse, a widened contract into a no-op).
 */

import { describe, expect, it } from "vitest";
import {
  PACKAGE_LABEL_HEX,
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PERMISSION_CONTRACT,
  SESSION_PLUS_PUBLISHER,
  assetDigest,
  packageHostLabel,
  sessionPlusDescriptor,
  permissionContractDigest,
  sessionPlusReleasePackage,
  sessionPlusIdentity,
  checkoutLockfileHash,
  sessionPlusStateAppKey,
} from "./identity.js";
import {
  COMPOSITION_ASSET,
  MODULE_LOCK_ASSET,
  PERMISSIONS_ASSET,
  RESOURCE_BINDINGS_ASSET,
} from "@claude-bot/session-plus-view/plan";
import {
  SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
} from "../session-resource/contract.js";
import { viewPackage, type AppPackage } from "./view-app.js";

const pkg = (assets: Array<[string, string]>): AppPackage => ({
  assets: assets.map(([name, source]) => ({ name, source })),
});

/**
 * The package digest, as the registry computes it.
 *
 * Since v4 there is exactly one implementation of "which release is this", in
 * `@claude-bot/app-registry`, and this file goes through the same door the
 * running code does. A second framing here would be a second answer.
 */
const digestOf = (p: AppPackage): string =>
  sessionPlusDescriptor({ pkg: p, lockfileHash: "0".repeat(64) }).packageDigest;

describe("stable identity vs package digest", () => {
  it("names the app and the publisher without reference to any digest", () => {
    const id = sessionPlusIdentity();
    expect(id.stableAppId).toBe("session-plus");
    expect(id.publisher).toBe("octopus:first-party");
    // The stable id is what state and grants are keyed by, so it must not
    // contain, encode or depend on either digest.
    expect(id.stableAppId).not.toContain(id.packageDigest.slice(0, 8));
    expect(SESSION_PLUS_APP_ID).toBe(id.stableAppId);
    expect(SESSION_PLUS_PUBLISHER).toBe(id.publisher);
  });

  it("frames publisher and stable id together for durable state", () => {
    const id = sessionPlusIdentity();
    expect(sessionPlusStateAppKey(id)).toBe('["octopus:first-party","session-plus"]');
    expect(sessionPlusStateAppKey({ ...id, publisher: "someone:else" }))
      .not.toBe(sessionPlusStateAppKey(id));
    expect(sessionPlusStateAppKey({ ...id, stableAppId: "other" }))
      .not.toBe(sessionPlusStateAppKey(id));
  });

  it("addresses the host with the first 20 hex of the package digest", () => {
    const id = sessionPlusIdentity();
    expect(id.packageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(id.packageHostLabel).toBe(`app-${id.packageDigest.slice(0, PACKAGE_LABEL_HEX)}`);
    expect(id.packageHostLabel).toMatch(/^app-[0-9a-f]{20}$/);
  });

  it("refuses to build a label out of something that is not a digest", () => {
    expect(() => packageHostLabel("not-a-digest")).toThrow();
  });

  it("changes the digest — and therefore the URL — when one byte of the package changes", () => {
    const a = pkg([["view.js", "alert(1)"]]);
    const b = pkg([["view.js", "alert(2)"]]);
    expect(digestOf(a)).not.toBe(digestOf(b));
    expect(sessionPlusIdentity(a).packageHostLabel).not.toBe(sessionPlusIdentity(b).packageHostLabel);
    // …and the stable identity is untouched by that change, which is the whole
    // point of having both.
    expect(sessionPlusIdentity(a).stableAppId).toBe(sessionPlusIdentity(b).stableAppId);
  });

  it("does not let two different packages agree by moving bytes across assets", () => {
    // A bare concatenation would give these the same digest, and then two
    // different packages would be served from one hostname.
    const split = pkg([["a.js", "xy"], ["b.js", "z"]]);
    const moved = pkg([["a.js", "x"], ["b.js", "yz"]]);
    expect(digestOf(split)).not.toBe(digestOf(moved));
  });

  it("is stable across calls for the shipped package", () => {
    const shipped = sessionPlusDescriptor({
      pkg: sessionPlusReleasePackage(),
      lockfileHash: checkoutLockfileHash(),
    });
    expect(sessionPlusIdentity().packageDigest).toBe(shipped.packageDigest);
    // Evidence, not identity: recomputed from inputs the package digest already
    // covers, and compared rather than claimed.
    expect(sessionPlusIdentity().viewAssetDigest).toBe(shipped.evidence.viewDigest);
    expect(sessionPlusIdentity().sourceSnapshotDigest).toBe(assetDigest(sessionPlusReleasePackage()));
    expect(sessionPlusIdentity().backendCodeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionPlusIdentity()).toEqual(sessionPlusIdentity());
  });

  it("moves the View sub-digest when a View byte moves, without touching the app id", () => {
    const one = sessionPlusIdentity(pkg([["view.js", "1"]]));
    const two = sessionPlusIdentity(pkg([["view.js", "2"]]));
    expect(one.viewAssetDigest).not.toBe(two.viewAssetDigest);
    expect(one.stableAppId).toBe(two.stableAppId);
    const viewNames = viewPackage().assets.map((a) => a.name);
    expect(viewNames.slice(0, 3)).toEqual(["view.html", "view.css", "view.js"]);
    expect(viewNames).toContain("view/entry.json");
    expect(viewNames.some((name) => /^view\/assets\/worker-.*\.js$/.test(name))).toBe(true);
  });

  it("covers declarative and backend assets in the release identity", () => {
    const release = sessionPlusReleasePackage();
    expect(release.assets.map((asset) => asset.name)).toEqual(expect.arrayContaining([
      "view.html",
      "view.css",
      "view.js",
      "app/app.yaml",
      "app/actions.ts",
      "app/projection.ts",
      "app/pages/main.yaml",
    ]));
    expect(sessionPlusIdentity().packageDigest).not.toBe(sessionPlusIdentity().viewAssetDigest);
  });

  it("covers the module plan too, so changing what the App assembles changes the URL", () => {
    const release = sessionPlusReleasePackage();
    const names = release.assets.map((asset) => asset.name);
    expect(names).toContain(MODULE_LOCK_ASSET);
    expect(names).toContain(COMPOSITION_ASSET);
    expect(names).toContain(RESOURCE_BINDINGS_ASSET);
    expect(names).toContain(PERMISSIONS_ASSET);
    expect(names).toHaveLength(viewPackage().assets.length + 8);

    // All four plan documents are in the VIEW group: they describe the browser
    // half, and they are covered by the package digest exactly like a component
    // is. That is what makes "what this App assembles", "what it depends on" and
    // "what it asks for" all part of the release identity, and therefore of the
    // hostname.
    const descriptor = sessionPlusDescriptor({ pkg: release, lockfileHash: "0".repeat(64) });
    expect(descriptor.composition.view).toEqual(
      [
        COMPOSITION_ASSET,
        MODULE_LOCK_ASSET,
        PERMISSIONS_ASSET,
        RESOURCE_BINDINGS_ASSET,
        ...viewPackage().assets.map((asset) => asset.name),
      ].sort(),
    );

    for (const asset of [COMPOSITION_ASSET, MODULE_LOCK_ASSET, RESOURCE_BINDINGS_ASSET, PERMISSIONS_ASSET]) {
      const rewired = {
        assets: release.assets.map((row) => (row.name === asset ? { ...row, source: `${row.source} ` } : row)),
      };
      expect(digestOf(rewired), `${asset} must be inside the package digest`).not.toBe(digestOf(release));
    }
  });

  it("reads the ask from the release's own declaration, and infers it only for older shapes", () => {
    // Three eras, and each one's digest has to be the one it always was —
    // because that digest is what a recorded consent points at.
    const release = sessionPlusReleasePackage();

    // Today: the package SAYS what it asks for, and the builder repeats the
    // package rather than inferring from its shape.
    const declared = sessionPlusDescriptor({ pkg: release, lockfileHash: "0".repeat(64) });
    expect(declared.permissionContractDigest).toBe(
      permissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT),
    );

    // The read-only rollback target: no declaration, a binding plan, so the
    // eight-token ask — byte-identical to what it was before this document
    // existed, which is what makes rolling back to it not a re-consent.
    const withPlan = sessionPlusDescriptor({
      pkg: { assets: release.assets.filter((asset) => asset.name !== PERMISSIONS_ASSET) },
      lockfileHash: "0".repeat(64),
    });
    expect(withPlan.permissionContractDigest).toBe(
      permissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT),
    );

    // The oldest: no declaration and no plan, so the six-token ask.
    const withoutPlan = sessionPlusDescriptor({
      pkg: {
        assets: release.assets.filter(
          (asset) => asset.name !== RESOURCE_BINDINGS_ASSET && asset.name !== PERMISSIONS_ASSET,
        ),
      },
      lockfileHash: "0".repeat(64),
    });
    expect(withoutPlan.permissionContractDigest).toBe(
      permissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_PERMISSION_CONTRACT),
    );

    expect(new Set([
      declared.permissionContractDigest,
      withPlan.permissionContractDigest,
      withoutPlan.permissionContractDigest,
    ]).size).toBe(3);
  });

  it("refuses to describe a package whose declaration it cannot honour", () => {
    // The builder half, so this THROWS rather than returning a refusal: a
    // checkout that cannot describe its own package is a programming error, and
    // nothing on the install path reaches here — an installed release arrives
    // with its descriptor already written, and the adapter checks rather than
    // re-derives.
    const release = sessionPlusReleasePackage();
    const withDeclaration = (source: string) => ({
      assets: release.assets.map((asset) => (asset.name === PERMISSIONS_ASSET ? { ...asset, source } : asset)),
    });
    for (const source of [
      "{ not json",
      `${JSON.stringify({ schema: "app-permissions/v1", contract: "everything/v1" }, null, 2)}\n`,
      `${JSON.stringify({ schema: "app-permissions/v9", contract: "sessions/v1" }, null, 2)}\n`,
    ]) {
      expect(() => sessionPlusDescriptor({ pkg: withDeclaration(source), lockfileHash: "0".repeat(64) }), source)
        .toThrow();
    }
  });
});

describe("the permission contract is a separate question", () => {
  it("is byte-for-byte the contract the production legacy release declares", () => {
    // The whole modularisation ships under the SAME six-token ask. A literal is
    // the right assertion here: recomputing it from the same constant would
    // only prove the function is deterministic, while this fails the moment the
    // contract itself is widened — which is exactly the change that must not
    // ride along with a refactor.
    expect(permissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_PERMISSION_CONTRACT)).toBe(
      "55f86907f326880b8b687705b0595939",
    );
    expect(SESSION_PLUS_PERMISSION_CONTRACT.operations).toEqual([
      "list_recent_sessions",
      "search_sessions",
      "read_session",
      "list_session_workspaces",
      "start_session",
      "append_session",
    ]);
  });

  it("has its own digest, unequal to the package digest", () => {
    const id = sessionPlusIdentity();
    expect(id.permissionContractDigest).toMatch(/^[0-9a-f]{32}$/);
    expect(id.permissionContractDigest).not.toBe(id.packageDigest);
  });

  it("uses the six Gate operation ids and the four read-class auto-allow requests", () => {
    expect(SESSION_PLUS_PERMISSION_CONTRACT).toEqual({
      operations: [
        "list_recent_sessions",
        "search_sessions",
        "read_session",
        "list_session_workspaces",
        "start_session",
        "append_session",
      ],
      autoAllow: [
        "list_recent_sessions",
        "search_sessions",
        "read_session",
        "list_session_workspaces",
      ],
      deliveries: [],
    });
    const current = permissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_PERMISSION_CONTRACT);
    const asks = permissionContractDigest(SESSION_PLUS_PUBLISHER, {
      operations: ["list_sessions"],
      autoAllow: [],
      deliveries: [],
    });
    expect(current).not.toBe(asks);
  });

  it("does not move when the package does, and vice versa", () => {
    const one = sessionPlusIdentity(pkg([["view.js", "1"]]));
    const two = sessionPlusIdentity(pkg([["view.js", "2"]]));
    expect(one.packageDigest).not.toBe(two.packageDigest);
    // A code change must not look like a permission change: that is what would
    // make a routine deploy demand re-consent.
    expect(one.permissionContractDigest).toBe(two.permissionContractDigest);
  });

  it("treats the same operations from a different publisher as a different contract", () => {
    const mine = permissionContractDigest("octopus:first-party", SESSION_PLUS_PERMISSION_CONTRACT);
    const theirs = permissionContractDigest("someone:else", SESSION_PLUS_PERMISSION_CONTRACT);
    expect(mine).not.toBe(theirs);
  });

  it("ignores the order operations happen to be written in", () => {
    const a = permissionContractDigest("p", { operations: ["b", "a"], autoAllow: [], deliveries: [] });
    const b = permissionContractDigest("p", { operations: ["a", "b"], autoAllow: [], deliveries: [] });
    expect(a).toBe(b);
  });
});
