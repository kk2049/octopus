import { describe, expect, it } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { HostCapabilities } from "./capability-plane.js";
import type { GrantResolver, PermissionContract } from "./versions.js";

const EMPTY_VERDICT = {
  ok: true,
  missingOperations: [],
  missingAutoAllow: [],
  missingDelivery: [],
  needsAuthorization: false,
};

describe("owner-aware GrantResolver seam", () => {
  it("passes the authenticated owner at derivation and status lookup", () => {
    const service = new CapabilityService();
    const accounts = new Map<string, string>();
    for (const owner of ["alice", "bob"]) {
      service.registerObject({
        id: `device:${owner}`,
        kind: "device",
        binding: owner,
        metadata: { owner },
        operations: {
          read: { args: {}, effect: "read" },
          execute: { args: {}, effect: "execute" },
        },
        policy: () => ({ kind: "deny", reason: "not exercised in this test" }),
        adapter: async () => null,
      });
      const context = service.createContext("account-authority", { owner });
      service.mintRoot(context, "resources", `device:${owner}`, ["read", "execute"]);
      accounts.set(owner, context);
    }

    const seen: Array<["effective" | "check", string | undefined]> = [];
    const resolver: GrantResolver = {
      effective(_contract: PermissionContract, owner?: string) {
        seen.push(["effective", owner]);
        return {
          operations: owner === "alice" ? ["read"] : ["execute"],
          autoAllow: [],
          delivery: [],
        };
      },
      check(_contract: PermissionContract, owner?: string) {
        seen.push(["check", owner]);
        return EMPTY_VERDICT;
      },
    };
    const plane = new HostCapabilities({
      service,
      authorityFor(owner) {
        const contextId = accounts.get(owner);
        return contextId ? { contextId, slot: "resources" } : null;
      },
      appRequirements: () => ["read", "execute"],
      grants: resolver,
    });

    const alice = plane.openApp({ username: "alice", app: "probe", scope: "one", digest: "d" })!;
    const bob = plane.openApp({ username: "bob", app: "probe", scope: "two", digest: "d" })!;
    expect(service.rightsOf(alice, "resources")).toEqual(["read"]);
    expect(service.rightsOf(bob, "resources")).toEqual(["execute"]);
    expect(plane.contractStatus("probe", "alice")).toEqual(EMPTY_VERDICT);
    expect(seen).toEqual([
      ["effective", "alice"],
      ["effective", "alice"],
      ["effective", "bob"],
      ["effective", "bob"],
      ["check", "alice"],
    ]);
  });

  it("keeps the deployment-wide GrantLedger path owner-agnostic", async () => {
    const { GrantLedger } = await import("./versions.js");
    const contract: PermissionContract = {
      app: "probe",
      publisher: "first-party",
      operations: ["read"],
      autoAllow: ["read"],
      actions: {},
      agents: {},
      delivery: [],
    };
    const ledger = new GrantLedger(() => 1);
    ledger.seed(contract);
    expect(ledger.effective(contract, "alice")).toEqual(ledger.effective(contract, "bob"));
    expect(ledger.check(contract, "alice")).toEqual(ledger.check(contract, "bob"));
  });
});
