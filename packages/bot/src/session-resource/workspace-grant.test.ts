/**
 * The one place "may this App instance read workspace files, and unsupervised?"
 * is answered — and the provider-owned Context that answer produces.
 *
 * ── What is actually at risk here ───────────────────────────────────────────
 *
 * The provider catalog opens this seam once per `(instance, binding)` and then
 * holds the returned grant for that scope's whole lifetime. That lifetime is
 * longer than `AccountAuthority`'s short HTTP-surface pool, so the assertions
 * below pin ownership to the provider scope rather than to a timer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { POOL_TTL_MS } from "../runner/account-authority.js";
import type { RunnerTransport } from "../runner/gateway.js";
import type { ResourceProviderContext } from "../agent-resources/types.js";
import { IntentGrantResolver } from "./intent-resolver.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_OPERATIONS,
  SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
  SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS,
  SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT,
  SESSION_PLUS_OWNER_FILES_OPERATIONS,
  SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS,
  SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
  sessionPlusPermissionContractDigest,
  type SessionPlusPermissionContract,
} from "./contract.js";
import { sessionPlusWorkspaceGrant } from "./workspace-grant.js";

const PACKAGE = "a".repeat(64);
const OTHER_PACKAGE = "b".repeat(64);
const OTHER_PUBLISHER = "someone:else";

/** No call is made in this suite; the transport only has to exist. */
const transport = {} as unknown as RunnerTransport;

/**
 * A grant row, as `IntentGrantResolver` reads one. Only `get` is used, so the
 * real resolver runs against a two-line directory instead of a database.
 */
function permissionsWith(rows: ReadonlyArray<{ publisher: string; contractDigest: string }>) {
  return {
    get(_type: string, _id: string, _owner: string) {
      const row = rows[0];
      if (!row) return undefined;
      return {
        operations: [...SESSION_PLUS_WORKSPACE_OPERATIONS],
        autoAllow: [...SESSION_PLUS_WORKSPACE_OPERATIONS],
        status: "active" as const,
        expiresAt: null,
        contractDigest: row.contractDigest,
        publisher: row.publisher,
      };
    },
  } as unknown as ConstructorParameters<typeof IntentGrantResolver>[0];
}

let service: CapabilityService;
let capabilities: WorkspaceFilesCapabilities;
let now: number;

beforeEach(() => {
  now = 1_000;
  service = new CapabilityService();
  capabilities = new WorkspaceFilesCapabilities({
    service,
    transport,
    userExists: () => true,
    hasDevice: () => true,
    now: () => now,
  });
});

afterEach(() => {
  service.close();
});

function contextFor(overrides: Partial<ResourceProviderContext> = {}): ResourceProviderContext {
  const publisher = overrides.publisher ?? SESSION_PLUS_PUBLISHER;
  return Object.freeze({
    owner: "alice",
    publisher,
    app: SESSION_PLUS_APP_ID,
    packageDigest: PACKAGE,
    permissionContractDigest: sessionPlusPermissionContractDigest(
      publisher,
      SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
    ),
    instance: "tab-1",
    binding: "workspace",
    contract: "workspace-files/v1",
    scope: "scope-1",
    ...overrides,
  });
}

/** A grant seam whose resolver believes THIS publisher consented. */
function openGrantFor(publisher: string) {
  return sessionPlusWorkspaceGrant({
    capabilities,
    grants: new IntentGrantResolver(
      permissionsWith([
        {
          publisher,
          contractDigest: sessionPlusPermissionContractDigest(
            publisher,
            SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
          ),
        },
      ]),
    ),
    devices: () => [{ device: "laptop", label: "laptop" }],
  });
}

describe("two releases of one app", () => {
  it("get two Contexts, and closing one leaves the other live", () => {
    const openGrant = openGrantFor(SESSION_PLUS_PUBLISHER);
    const first = openGrant(contextFor({ packageDigest: PACKAGE }));
    const second = openGrant(contextFor({ packageDigest: OTHER_PACKAGE }));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const firstId = first!.contextId;
    const secondId = second!.contextId;
    expect(firstId).not.toBe(secondId);
    expect(capabilities.pooledContexts).toBe(0);

    first!.close();
    expect(service.contextIsLive(firstId)).toBe(false);
    expect(service.contextIsLive(secondId)).toBe(true);
    expect(service.rightsOf(secondId, "workspace-files").length).toBeGreaterThan(0);
  });

  it("keeps a provider scope live beyond the short surface-pool window", () => {
    const openGrant = openGrantFor(SESSION_PLUS_PUBLISHER);
    const first = openGrant(contextFor({ instance: "long-lived-tab" }));
    expect(first).not.toBeNull();

    now += POOL_TTL_MS + 1;
    const second = openGrant(contextFor({ instance: "later-tab" }));
    expect(second).not.toBeNull();

    // Opening another scope after fifteen minutes used to prune the first
    // Context even though its provider handle was still live.
    expect(service.contextIsLive(first!.contextId)).toBe(true);
    expect(service.rightsOf(first!.contextId, "workspace-files").length).toBeGreaterThan(0);
    expect(capabilities.pooledContexts).toBe(0);

    first!.close();
    second!.close();
    expect(service.contextIsLive(first!.contextId)).toBe(false);
    expect(service.contextIsLive(second!.contextId)).toBe(false);
  });
});

describe("two publishers choosing the same stable app id", () => {
  it("is refused outright today: `IntentGrantResolver` serves one publisher", () => {
    // This resolver only resolves rows whose publisher is Session Plus's own,
    // so a second publisher gets no grant at all.
    const openGrant = openGrantFor(OTHER_PUBLISHER);
    expect(openGrant(contextFor({ publisher: OTHER_PUBLISHER }))).toBeNull();
    expect(capabilities.pooledContexts).toBe(0);
  });

  it("does not let one publisher's recorded consent answer for another's ask", () => {
    // The resolver knows about the first-party row. A context claiming another
    // publisher computes a different contract digest, so this build resolves no
    // contract for it — and a scope with no contract holds nothing.
    const openGrant = openGrantFor(SESSION_PLUS_PUBLISHER);
    expect(openGrant(contextFor({ publisher: OTHER_PUBLISHER }))).toBeNull();
    expect(capabilities.pooledContexts).toBe(0);
  });
});

describe("a contract this build does not implement", () => {
  it("holds nothing at all, and opens no Context", () => {
    const openGrant = openGrantFor(SESSION_PLUS_PUBLISHER);
    expect(openGrant(contextFor({ permissionContractDigest: "0".repeat(32) }))).toBeNull();
    expect(capabilities.pooledContexts).toBe(0);
  });
});

/** A resolver that believes this owner consented to exactly `operations`. */
function seamFor(contract: SessionPlusPermissionContract, operations: readonly string[]) {
  return sessionPlusWorkspaceGrant({
    capabilities,
    grants: new IntentGrantResolver({
      get() {
        return {
          operations: [...operations],
          autoAllow: [...operations],
          status: "active" as const,
          expiresAt: null,
          contractDigest: sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, contract),
          publisher: SESSION_PLUS_PUBLISHER,
        };
      },
    } as unknown as ConstructorParameters<typeof IntentGrantResolver>[0]),
    devices: () => [{ device: "laptop", label: "laptop" }],
  });
}

describe("whether the scope may write", () => {

  const writeDigest = sessionPlusPermissionContractDigest(
    SESSION_PLUS_PUBLISHER,
    SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
  );

  it("is true only when the write survived the intersection with the grant", () => {
    const seam = seamFor(
      SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
      [...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS],
    );
    const grant = seam(contextFor({ permissionContractDigest: writeDigest }));
    expect(grant?.writable).toBe(true);
  });

  it("is false when the release asks for the write but the owner granted only reads", () => {
    // The ask and the consent are two different documents, and this is the case
    // where they differ. A panel that offered a save button here would be
    // offering one the Gate is going to refuse.
    const seam = seamFor(
      SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
      [...SESSION_PLUS_WORKSPACE_OPERATIONS],
    );
    const grant = seam(contextFor({ permissionContractDigest: writeDigest }));
    expect(grant).not.toBeNull();
    expect(grant?.writable).toBe(false);
  });

  it("is false for an instance opened under the read-only contract, whatever was granted", () => {
    // The instance keeps the ask it was opened under. Resolving against
    // "whatever is newest" would let an activation re-interpret a tab somebody
    // consented to under a narrower contract — here, into one that writes.
    const seam = seamFor(
      SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
      [...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS],
    );
    const grant = seam(contextFor());
    expect(grant).not.toBeNull();
    expect(grant?.writable).toBe(false);
  });
});

describe("whether the scope may expose the owner Runner root", () => {
  it("projects owner writes only from the exact new ask and granted operation", () => {
    const contract = SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT;
    const digest = sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, contract);
    const current = contextFor({ permissionContractDigest: digest });
    const seam = seamFor(contract, [...SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS]);
    const grant = seam(current);
    expect(grant).toMatchObject({ writable: true, ownerFiles: true, ownerFilesWritable: true });
    expect(service.rightsOf(grant!.contextId, "workspace-files")).toContain("replace_owner_text");

    const oldRights = seamFor(contract, [...SESSION_PLUS_OWNER_FILES_OPERATIONS]);
    expect(oldRights(current)).toMatchObject({ writable: true, ownerFiles: true, ownerFilesWritable: false });
    const oldAsk = seamFor(SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT, [...SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS]);
    expect(oldAsk(contextFor({ permissionContractDigest: sessionPlusPermissionContractDigest(
      SESSION_PLUS_PUBLISHER, SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT,
    ) }))?.ownerFilesWritable).toBe(false);
  });

  it("is true only for the new owner-local contract and grant intersection", () => {
    const seam = seamFor(
      SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT,
      [...SESSION_PLUS_OWNER_FILES_OPERATIONS],
    );
    const digest = sessionPlusPermissionContractDigest(
      SESSION_PLUS_PUBLISHER,
      SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT,
    );
    expect(seam(contextFor({ permissionContractDigest: digest }))?.ownerFiles).toBe(true);
  });

  it("stays false for every historical workspace contract", () => {
    const seam = seamFor(
      SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
      [...SESSION_PLUS_WORKSPACE_OPERATIONS],
    );
    expect(seam(contextFor())?.ownerFiles).toBe(false);
  });
});
