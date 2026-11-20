/**
 * "May this App instance send its owner a notification?" — and what has to be
 * true, in what order, before the answer is yes.
 *
 * ── Why this suite exists at all ───────────────────────────────────────────
 *
 * The seam refused everything before this batch, and "it refuses because nobody
 * consented" is indistinguishable from "it refuses because somebody forgot to
 * wire it" from the outside. Only the first is a design. Now that a contract
 * declares `send_notification`, the positive path is reachable through the REAL
 * contract and the REAL resolver — no stand-in — so the two can finally be told
 * apart by looking at which input has to change to flip the answer.
 *
 * Every negative case below names the ONE thing that was missing, because a
 * refusal that could have four causes is a refusal nobody can act on.
 *
 * ── What is still not true, and is asserted here rather than assumed ───────
 *
 * No release SHAPE declares the notify contract, so nothing in production opens
 * an instance under it. The last case pins that: the contracts the three
 * shipping shapes declare do not contain the token, so today's deployments get
 * `no_authority` for a structural reason and not because somebody remembered to
 * check.
 */

import { describe, expect, it } from "vitest";
import type { ResourceProviderContext } from "../agent-resources/types.js";
import type { NotifyDelivery } from "../notify/types.js";
import { IntentGrantResolver } from "./intent-resolver.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_OPERATIONS,
  SESSION_PLUS_PERMISSION_CONTRACT,
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS,
  SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS,
  SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
  sessionPlusContractById,
  sessionPlusPermissionContractDigest,
  type SessionPlusContractId,
  type SessionPlusPermissionContract,
} from "./contract.js";
import { NOTIFY_OPERATION, notifyAccountOperations, sessionPlusNotifyGrant } from "./notify-grant.js";

const NOTIFY_DIGEST = sessionPlusPermissionContractDigest(
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT,
);

/** A channel that is never used: no case here gets as far as sending. */
const delivery: NotifyDelivery = { deliver: async () => ({ ok: true }) };

/**
 * A recorded grant, as `IntentGrantResolver` reads one.
 *
 * A test double for the STORE, not for the decision: the real resolver runs over
 * it, so the contract intersection, the publisher check and the status check are
 * all the production ones.
 */
function permissionsWith(o: {
  operations: readonly string[];
  publisher?: string;
  contractDigest?: string;
  status?: "active" | "revoked";
}) {
  return {
    get() {
      return {
        operations: [...o.operations],
        autoAllow: [...o.operations],
        status: o.status ?? ("active" as const),
        expiresAt: null,
        contractDigest: o.contractDigest ?? NOTIFY_DIGEST,
        publisher: o.publisher ?? SESSION_PLUS_PUBLISHER,
      };
    },
  } as unknown as ConstructorParameters<typeof IntentGrantResolver>[0];
}

function contextFor(overrides: Partial<ResourceProviderContext> = {}): ResourceProviderContext {
  return Object.freeze({
    owner: "alice",
    publisher: SESSION_PLUS_PUBLISHER,
    app: SESSION_PLUS_APP_ID,
    packageDigest: "a".repeat(64),
    permissionContractDigest: NOTIFY_DIGEST,
    instance: "tab-1",
    binding: "notify",
    contract: "notify/v1",
    scope: "scope-1",
    ...overrides,
  });
}

function seamFor(o: {
  operations: readonly string[];
  delivery?: NotifyDelivery;
  publisher?: string;
  contractDigest?: string;
  status?: "active" | "revoked";
  labelFor?: (owner: string) => string;
}) {
  return sessionPlusNotifyGrant({
    delivery: "delivery" in o ? o.delivery : delivery,
    grants: new IntentGrantResolver(permissionsWith(o)),
    labelFor: o.labelFor,
  });
}

describe("an instance opened under the contract that declares the send", () => {
  it("gets a scope, and its only recipient is the owner", () => {
    // The whole positive path, through the real contract and the real resolver.
    // The recipient list is the trusted side's answer to "whom", and it is one
    // person: "an App may ping the person using it" and "an App may message
    // people" are different asks and only the first has an obvious answer.
    const open = seamFor({ operations: [...SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS] });
    const scope = open(contextFor());
    expect(scope).not.toBeNull();
    expect(scope!.targets).toEqual([{ id: "user:alice", label: "alice" }]);
    expect(scope!.delivery).toBe(delivery);
  });

  it("needs only the one token, not the other nine", () => {
    // The plane narrows to the operations IT serves. A grant covering nothing
    // but the send still opens a notify scope — the workspace tokens belong to
    // another plane and this one must not require them by accident.
    const open = seamFor({ operations: [NOTIFY_OPERATION] });
    expect(open(contextFor())).not.toBeNull();
  });

  it("uses the display name the trusted side supplied, never one a proposal chose", () => {
    const open = seamFor({ operations: [NOTIFY_OPERATION], labelFor: (owner) => `${owner} (lht)` });
    expect(open(contextFor())!.targets[0]).toEqual({ id: "user:alice", label: "alice (lht)" });
  });

  it("names the owner from the trusted context, not from anything the App said", () => {
    const open = seamFor({ operations: [NOTIFY_OPERATION] });
    expect(open(contextFor({ owner: "bob" }))!.targets[0]!.id).toBe("user:bob");
  });
});

describe("the four things that each, alone, make it no", () => {
  it("no outbound channel in this deployment — refused before anything is consulted", () => {
    const open = seamFor({ operations: [...SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS], delivery: undefined });
    expect(open(contextFor())).toBeNull();
  });

  it("a permission contract digest this build does not implement", () => {
    const open = seamFor({ operations: [...SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS] });
    expect(open(contextFor({ permissionContractDigest: "0".repeat(64) }))).toBeNull();
  });

  it("an instance opened under a NARROWER contract, however wide the recorded grant", () => {
    // The instance keeps the ask it was opened under. Resolving against
    // "whatever is newest" would let an activation re-interpret a tab somebody
    // consented to under a contract that could not message them.
    const open = seamFor({
      operations: [...SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS],
      contractDigest: NOTIFY_DIGEST,
    });
    const narrower = sessionPlusPermissionContractDigest(
      SESSION_PLUS_PUBLISHER,
      SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
    );
    expect(open(contextFor({ permissionContractDigest: narrower }))).toBeNull();
  });

  it("a recorded grant that stops short of the send", () => {
    // The ask and the consent are two documents. This is the case where the
    // release asks to notify and the person said no to that one line.
    const open = seamFor({ operations: [...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS] });
    expect(open(contextFor())).toBeNull();
  });
});

describe("the checks the plane inherits rather than re-implements", () => {
  it("does not let another publisher's ask be answered by this one's consent", () => {
    const open = seamFor({ operations: [NOTIFY_OPERATION] });
    expect(open(contextFor({ publisher: "someone:else" }))).toBeNull();
  });

  it("holds nothing once the grant is revoked", () => {
    const open = seamFor({ operations: [NOTIFY_OPERATION], status: "revoked" });
    expect(open(contextFor())).toBeNull();
  });
});

describe("what the permission screen is told the account holds", () => {
  it("agrees with the seam in both directions", () => {
    // The screen and the execution path have to give the same answer, and for
    // this plane the fact both read is the same one: is there any outbound
    // channel here. Without this seam the row would read
    // `account_lacks_operation` for ever while the provider notified people.
    expect(notifyAccountOperations(delivery)).toEqual([NOTIFY_OPERATION]);
    expect(notifyAccountOperations(undefined)).toEqual([]);
    expect(seamFor({ operations: [NOTIFY_OPERATION] })(contextFor())).not.toBeNull();
    expect(seamFor({ operations: [NOTIFY_OPERATION], delivery: undefined })(contextFor())).toBeNull();
  });
});

describe("what production still resolves to", () => {
  it("no shipping shape's contract contains the token, so every live scope is no_authority", () => {
    // The second half of the ceremony, unstarted on purpose. A contract being
    // IMPLEMENTED means a digest resolves to it; a contract being DECLARED means
    // a release ships with it. Only the first happened here, so the seam's
    // positive path is exercised above and unreachable in production.
    const shipping: SessionPlusContractId[] = ["sessions/v1", "sessions-workspace/v1"];
    for (const id of shipping) {
      const contract: SessionPlusPermissionContract = sessionPlusContractById(id);
      expect(contract.operations).not.toContain(NOTIFY_OPERATION);
      const open = seamFor({ operations: [NOTIFY_OPERATION] });
      const digest = sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, contract);
      expect(open(contextFor({ permissionContractDigest: digest })), id).toBeNull();
    }
    // And the oldest ask — the rollback target every deployment can fall back
    // to — has not acquired the token either.
    expect(SESSION_PLUS_PERMISSION_CONTRACT.operations).toEqual([...SESSION_PLUS_OPERATIONS]);
  });
});
