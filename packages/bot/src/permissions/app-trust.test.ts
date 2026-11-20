import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { AppTrustService, type AppReleaseIdentity } from "./app-trust.js";

const NOW = Date.parse("2026-08-04T18:00:00.000Z");
// The consent door now only stands in front of publishers outside this
// repository, so the door's semantics are exercised with one of those.
const release = (digest: string, publisher = "acme:third-party"): AppReleaseIdentity => ({
  appId: "session-plus",
  publisher,
  profile: "publisher-js",
  packageDigest: digest.repeat(64).slice(0, 64),
});

describe("AppTrustService", () => {
  let dir = "";
  let store: Store;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(): AppTrustService {
    dir = mkdtempSync(join(tmpdir(), "app-trust-"));
    store = new Store(join(dir, "state.db"));
    store.saveUser({ username: "alice", uid: 9301, home_dir: "/unused", created_at: new Date(NOW).toISOString() });
    return new AppTrustService(store, () => NOW);
  }

  it("distinguishes exact-release trust from publisher update trust", () => {
    const trust = fixture();
    expect(trust.status("alice", release("a"))).toMatchObject({ trusted: false, reason: "never_decided" });
    trust.trust("alice", release("a"), false);
    expect(trust.status("alice", release("a"))).toMatchObject({ trusted: true, reason: "exact_release" });
    expect(trust.status("alice", release("b"))).toMatchObject({ trusted: false, reason: "release_changed" });

    trust.trust("alice", release("a"), true);
    expect(trust.status("alice", release("b"))).toMatchObject({ trusted: true, reason: "publisher_updates" });
  });

  it("does not inherit across publishers or a stronger execution profile", () => {
    const trust = fixture();
    trust.trust("alice", release("a"), true);
    expect(trust.status("alice", release("a", "another:publisher")))
      .toMatchObject({ trusted: false, reason: "never_decided" });
    expect(trust.status("alice", { ...release("b"), profile: "declarative" }))
      .toMatchObject({ trusted: false, reason: "profile_changed" });
  });

  it("trusts a release built from this repository without asking, and a revocation does not stop it (O12)", () => {
    const trust = fixture();
    for (const publisher of ["octopus:first-party", "octopus:demo"]) {
      expect(trust.status("alice", release("a", publisher))).toEqual({ trusted: true, reason: "first_party", decision: null });
      expect(trust.status("alice", { ...release("b", publisher), profile: "declarative" }))
        .toMatchObject({ trusted: true, reason: "first_party" });
      trust.revoke("alice", release("a", publisher));
      expect(trust.status("alice", release("c", publisher))).toMatchObject({ trusted: true, reason: "first_party" });
    }
    // Only the prefix counts: a look-alike publisher still meets the door.
    expect(trust.status("alice", release("a", "octopus-first-party"))).toMatchObject({ trusted: false, reason: "never_decided" });
  });

  it("persists revocation and re-consent independently of capability grants", () => {
    const trust = fixture();
    trust.trust("alice", release("a"), true);
    expect(trust.revoke("alice", release("a"))).toBe(true);
    expect(trust.revoke("alice", release("a"))).toBe(false);
    expect(trust.status("alice", release("a"))).toMatchObject({ trusted: false, reason: "revoked" });
    trust.trust("alice", release("a"), false);
    expect(trust.status("alice", release("a"))).toMatchObject({ trusted: true, reason: "exact_release" });
  });
});
