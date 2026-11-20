/**
 * Moving a setting is a compatibility problem, not a rename.
 *
 * `scan_homes` lived under `secretary`; the Session Hub needs it, and the v3
 * composition builds no secretary. The rule that keeps that from breaking a
 * running host: the new location wins PER USER, the old one still answers for
 * everyone it already named, and the deprecation is reported rather than
 * assumed — a warning that fires on a correctly-configured host is a warning
 * people learn to scroll past.
 */

import { describe, it, expect } from "vitest";
import { mergeScanHomes, sharedEnvScanUsers } from "./scan-homes.js";

describe("mergeScanHomes", () => {
  it("honours the deprecated location and says who is relying on it", () => {
    const r = mergeScanHomes({ secretary: { alice: "/home/alice", bob: "/home/bob" } });
    expect(r.homes).toEqual({ alice: "/home/alice", bob: "/home/bob" });
    expect(r.deprecated).toEqual(["alice", "bob"]);
  });

  it("stays silent when only the new location is used", () => {
    const r = mergeScanHomes({ sessionHub: { alice: "/home/alice" } });
    expect(r.homes).toEqual({ alice: "/home/alice" });
    expect(r.deprecated).toEqual([]);
  });

  it("merges per user, so moving one across does not drop the others", () => {
    // The failure a whole-map override would cause: migrate alice, and bob —
    // untouched in the old map — silently loses his scan root and starts
    // resolving to his bot-managed home instead of his real one.
    const r = mergeScanHomes({
      sessionHub: { alice: "/new/alice" },
      secretary: { alice: "/old/alice", bob: "/old/bob" },
    });
    expect(r.homes).toEqual({ alice: "/new/alice", bob: "/old/bob" });
    expect(r.deprecated).toEqual(["bob"]);
  });

  it("is empty for an empty config rather than undefined", () => {
    expect(mergeScanHomes({})).toEqual({ homes: {}, deprecated: [] });
  });
});

describe("sharedEnvScanUsers", () => {
  const users = ["alice", "bob", "carol"];

  it("reports the accounts one env override would collapse together", () => {
    // This is the dangerous case: three users, no declared homes, one env var —
    // so all three resolve to the same scan root and read each other's
    // transcripts while the audit log still shows the caller's own name.
    expect(sharedEnvScanUsers({ envHome: "/home/dev", declared: {}, users })).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("says nothing when the variable is unset", () => {
    expect(sharedEnvScanUsers({ declared: {}, users })).toEqual([]);
  });

  it("says nothing when only one account would land on it", () => {
    // One user sharing the box with the bot is the single-user dev setup the
    // variable exists for. There is nobody to leak to.
    const declared = { alice: "/home/alice", bob: "/home/bob" };
    expect(sharedEnvScanUsers({ envHome: "/home/dev", declared, users })).toEqual([]);
  });

  it("counts only the accounts the declared map does not name", () => {
    expect(
      sharedEnvScanUsers({ envHome: "/home/dev", declared: { alice: "/home/alice" }, users }),
    ).toEqual(["bob", "carol"]);
  });
});
