/** Account-aware GrantResolver backed by the existing grant_intents table. */

import type {
  ContractVerdict,
  GrantResolver,
  PermissionContract,
} from "@claude-bot/engine";
import { contractDigestOf } from "@claude-bot/engine";
import type { PermissionService } from "../permissions/service.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PUBLISHER,
} from "./contract.js";

const EMPTY = Object.freeze({ operations: [] as string[], autoAllow: [] as string[], delivery: [] as string[] });

export class IntentGrantResolver implements GrantResolver {
  constructor(
    private readonly permissions: Pick<PermissionService, "get">,
    private readonly now: () => number = Date.now,
    private readonly publishers: ReadonlyMap<string, string> = new Map([[SESSION_PLUS_APP_ID, SESSION_PLUS_PUBLISHER]]),
  ) {}

  effective(c: PermissionContract, owner?: string) {
    const row = this.activeRow(c, owner);
    if (!row) return EMPTY;
    const operations = c.operations.filter((operation) => row.operations.includes(operation));
    return {
      operations,
      autoAllow: c.autoAllow.filter(
        (operation) => operations.includes(operation) && row.autoAllow.includes(operation),
      ),
      // grant_intents has no cross-scope delivery field. Session Plus declares
      // none; a future delivery subject needs its own durable representation.
      delivery: [],
    };
  }

  check(c: PermissionContract, owner?: string): ContractVerdict {
    const row = this.activeRow(c, owner);
    if (!row) {
      const publisherMismatch = this.rowFor(c, owner)?.publisher !== c.publisher;
      return {
        ok: false,
        missingOperations: sorted(c.operations),
        missingAutoAllow: sorted(c.autoAllow),
        missingDelivery: sorted(c.delivery),
        needsAuthorization: c.operations.length > 0 || c.delivery.length > 0,
        reason: publisherMismatch
          ? "the recorded grant belongs to a different publisher"
          : "no active grant recorded for this owner and app",
      };
    }
    const effective = this.effective(c, owner);
    const missingOperations = sorted(c.operations).filter((op) => !effective.operations.includes(op));
    const missingAutoAllow = sorted(c.autoAllow).filter((op) => !effective.autoAllow.includes(op));
    const missingDelivery = sorted(c.delivery);
    const ok = missingOperations.length === 0 && missingAutoAllow.length === 0 && missingDelivery.length === 0;
    return {
      ok,
      missingOperations,
      missingAutoAllow,
      missingDelivery,
      needsAuthorization: !ok,
      reason: ok
        ? undefined
        : row.contractDigest && row.contractDigest !== contractDigestOf(c)
          ? "the permission contract changed; only the previously granted intersection remains"
          : "the declared contract asks for more than was granted",
    };
  }

  private rowFor(c: PermissionContract, owner?: string) {
    if (!owner || this.publishers.get(c.app) !== c.publisher) return null;
    return this.permissions.get("app", c.app, owner);
  }

  private activeRow(c: PermissionContract, owner?: string) {
    const row = this.rowFor(c, owner);
    if (!row || row.status !== "active") return null;
    if (row.publisher !== c.publisher || row.publisher !== this.publishers.get(c.app)) return null;
    if (row.expiresAt) {
      const expires = Date.parse(row.expiresAt);
      if (!Number.isFinite(expires) || expires <= this.now()) return null;
    }
    return row;
  }
}

function sorted(xs: readonly string[]): string[] {
  return [...xs].map(String).sort();
}
