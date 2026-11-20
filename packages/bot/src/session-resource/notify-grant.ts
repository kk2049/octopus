/**
 * "May this App instance send its owner a notification?" — answered once, here.
 *
 * Deliberately the same four steps as `workspace-grant.ts`, in the same order,
 * for the same reason: the decision has to exist in ONE place so the test that
 * proves an unauthorised App reaches nobody exercises the decision the panel
 * makes.
 *
 *   1. resolve the EXACT permission contract this instance was opened under,
 *      from its own digest — never "whichever is active now";
 *   2. intersect that ask with the owner's recorded grant, through the same
 *      `IntentGrantResolver` every other plane uses;
 *   3. narrow to the operations THIS plane serves (`send_notification`);
 *   4. hand back the delivery path plus the recipients this scope may reach.
 *
 * ── The honest state of this seam today ────────────────────────────────────
 *
 * `sessions-workspace-write-notify/v1` declares `send_notification`, so steps
 * 1–3 now have a path that resolves and this file's positive branch is reachable
 * from a test rather than only from a stand-in resolver. What has NOT happened is
 * the other half of the ceremony: no release shape declares that contract
 * (`SHAPE_CONTRACT` in `session-plus-adapter.ts`), so no running release asks for
 * the token, so no consent screen offers it, so no production scope resolves one.
 * Every scope in production still gets `no_authority`, and that is the correct
 * answer rather than a stub — a notification is an outbound message with the
 * deployment's identity on it, and nobody has agreed to one.
 *
 * Writing the contract first and leaving the declaration to a later change is
 * the ceremony working, not a half-finished migration: a permission expansion is
 * two independent moves, and this file only ever gets to make the first.
 *
 * ── Why the recipient set is "the owner, and only the owner" ───────────────
 *
 * "An App may ping the person using it" and "an App may message people" are
 * different asks by a wide margin, and only the first has an obvious answer.
 * Cross-account delivery would need a trusted directory, a recipient-side
 * policy that defaults to refusing, and a fixed envelope — the whole apparatus
 * SEC-01 needed for cross-scope delivery in the engine. Not built, not implied.
 */

import type { NotifyScopeGrant, NotifyDelivery, NotifyTarget } from "../notify/types.js";
import type { ResourceProviderContext } from "../agent-resources/types.js";
import { sessionPlusContractFor, sessionPlusEngineContract } from "./contract.js";
import type { IntentGrantResolver } from "./intent-resolver.js";

/** The operation this plane serves. One token, two action ids. */
export const NOTIFY_OPERATION = "send_notification";

export interface SessionPlusNotifyGrantOptions {
  /** How a message physically leaves. Absent means this deployment has none. */
  delivery?: NotifyDelivery;
  /** The same resolver every other plane uses. One recorded intent, one answer. */
  grants: IntentGrantResolver;
  /** Display name for the owner, for a trusted-side audit line only. */
  labelFor?: (owner: string) => string;
}

export function sessionPlusNotifyGrant(
  options: SessionPlusNotifyGrantOptions,
): (context: ResourceProviderContext) => NotifyScopeGrant | null {
  return (context) => {
    const delivery = options.delivery;
    if (!delivery) return null;
    const known = sessionPlusContractFor(context.publisher, context.permissionContractDigest);
    if (!known) return null;
    const effective = options.grants.effective(
      sessionPlusEngineContract(context.publisher, known.contract),
      context.owner,
    );
    if (!effective.operations.includes(NOTIFY_OPERATION)) return null;
    const target: NotifyTarget = {
      id: `user:${context.owner}`,
      label: options.labelFor?.(context.owner) ?? context.owner,
    };
    return {
      targets: [target],
      delivery,
      // Nothing durable was taken out to build this scope — no Context, no
      // device, no stream. `close()` exists so the provider's teardown order is
      // the same shape as every other provider's, not because it releases
      // something; a seam that only sometimes has a teardown is a seam somebody
      // eventually forgets to call.
      close: () => {},
    };
  };
}

/**
 * What the ACCOUNT holds for this plane, for the permission projection.
 *
 * `computeEffective` intersects a recorded grant with the operations the
 * account's authority actually holds this instant, read from each composed
 * plane. A token no plane reports reads as `account_lacks_operation` for ever —
 * a screen telling somebody they cannot be notified while the provider notifies
 * them. `workspaceFiles` was added to `PermissionService` for precisely that
 * reason, and this is the same seam for the same reason.
 *
 * The answer is about the DEPLOYMENT, not about a device or about this person's
 * chat account: `notify/v1` is served by a delivery path rather than by a
 * capability root, so "does the account hold this" means "is there any outbound
 * channel here at all". That makes the screen and the grant seam agree in both
 * directions — the seam's first line is the same question (`if (!delivery)
 * return null`) — while whether a PARTICULAR person is reachable stays a
 * delivery-time answer (`unavailable`), which is where it can actually be known.
 */
export function notifyAccountOperations(delivery: NotifyDelivery | undefined): readonly string[] {
  return delivery ? [NOTIFY_OPERATION] : [];
}
