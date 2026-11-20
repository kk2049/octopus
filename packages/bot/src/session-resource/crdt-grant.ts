/**
 * "May this App instance read, or edit, a collaborative document?" — answered
 * once, here.
 *
 * Deliberately the same four steps as `workspace-grant.ts` and
 * `notify-grant.ts`, in the same order, so the test that proves an
 * unauthorised App reaches no document exercises the decision the panel makes:
 *
 *   1. resolve the EXACT permission contract this instance was opened under,
 *      from its own digest — never "whichever is active now";
 *   2. intersect that ask with the owner's recorded grant, through the same
 *      `IntentGrantResolver` every other plane uses;
 *   3. narrow to the operations THIS plane serves (`read_document`,
 *      `edit_document`) and derive a capability Context holding exactly them;
 *   4. hand back the store, the documents this scope may reach, and the Gate.
 *
 * ── What changed on 2026-08-10, and why it could not before ────────────────
 *
 * Until this batch, every scope resolved to `no_authority`: no implemented
 * permission contract declared the two tokens, and the 2026-08-09 attempt to
 * add one was refused by the platform — `defineOperationCatalog` forbids
 * auto-allowing a `modify`, and the provider had no Gate between an App and a
 * merge, so neither honest spelling of an `edit_document` consent row existed.
 * The missing piece was a capability Object for this plane. It now exists
 * (`crdt-doc/capability.ts`): reads pass the kernel per call and may be
 * auto-allowed; edits are per-(instance, document) LEASES that the kernel
 * turns into approval cards. With an enforcer in place,
 * `sessions-workspace-write-crdt/v1` (contract.ts) declares the tokens, and
 * this seam derives real Contexts from the account's `crdt-doc-v1` root.
 *
 * ── Why `read` does not imply `edit` ───────────────────────────────────────
 *
 * An accepted update is merged into a history everybody else receives. On a
 * file, an unauthorised write is one file; in a CRDT it propagates to every
 * replica and cannot be distinguished afterwards from a person's own edit.
 * So the two tokens are intersected separately, and `mayEdit` is a projection
 * of the SAME rights the Context was derived with — the port still opens and
 * follows the same documents either way, because "read-only" must not
 * silently mean "fewer documents".
 */

import type { InvokeResult } from "@claude-bot/capability-kernel";
import { CRDT_EDIT_OPERATION, CRDT_READ_OPERATION } from "@claude-bot/crdt-doc-contract";
import type { ResourceProviderContext } from "../agent-resources/types.js";
import { CRDT_DOC_OPERATION_NAMES, type CrdtDocCapabilities } from "../crdt-doc/capability.js";
import type { CrdtDocPendingOutcome, CrdtDocumentDescriptor, CrdtScopeGrant } from "../crdt-doc/types.js";
import type { CrdtDocumentStore } from "../crdt-doc/store.js";
import { sessionPlusContractFor, sessionPlusEngineContract } from "./contract.js";
import type { IntentGrantResolver } from "./intent-resolver.js";

/**
 * The pool tag for this plane's derived Contexts.
 *
 * Everything that makes two Contexts the same authority is in the key, framed
 * as a JSON array so no component can impersonate a boundary, and the leading
 * tag is what lets `dropPooled(user, "crdt-doc")` end exactly this plane's
 * Contexts.
 */
export function crdtDocPoolKey(context: ResourceProviderContext): string {
  return JSON.stringify([
    "crdt-doc",
    context.publisher,
    context.app,
    context.instance,
    context.binding,
    context.packageDigest,
    context.permissionContractDigest,
  ]);
}

export interface SessionPlusCrdtGrantOptions {
  /**
   * The CRDT capability plane, or undefined when this deployment composed
   * none (no store, or no kernel). Undefined means every scope resolves to
   * `no_authority` — the provider is still installed so a release declaring
   * the contract remains installable and this stays a bounded refusal.
   */
  capabilities: CrdtDocCapabilities | undefined;
  /** Where the documents live. Absent means this deployment has no store. */
  store?: CrdtDocumentStore;
  /** The same resolver every other plane uses. One recorded intent, one answer. */
  grants: IntentGrantResolver;
  /**
   * Which documents this owner may reach.
   *
   * A trusted composition input, not something a proposal can influence: the
   * provider mints one opaque ref per entry at scope open, and a consumer can
   * only ever name refs it was given. An empty list is "no scope", which the
   * catalog renders as `no_authority` — the same observable state as holding
   * no token at all, deliberately.
   */
  documentsFor: (owner: string) => readonly CrdtDocumentDescriptor[];
}

export function sessionPlusCrdtGrant(
  options: SessionPlusCrdtGrantOptions,
): (context: ResourceProviderContext) => CrdtScopeGrant | null {
  return (context) => {
    const store = options.store;
    const capabilities = options.capabilities;
    if (!store || !capabilities) return null;
    const known = sessionPlusContractFor(context.publisher, context.permissionContractDigest);
    if (!known) return null;
    const effective = options.grants.effective(
      sessionPlusEngineContract(context.publisher, known.contract),
      context.owner,
    );
    const rights = CRDT_DOC_OPERATION_NAMES.filter((operation) => effective.operations.includes(operation));
    if (!rights.includes(CRDT_READ_OPERATION)) return null;
    // Auto-allow is intersected separately, and `edit_document` can never be
    // in it: the account root's terms only cover read-effect operations and
    // `derive` attenuates, so a grant row that claimed otherwise would simply
    // not survive the derivation below.
    const autoAllow = rights.filter((operation) => effective.autoAllow.includes(operation));

    const documents = options.documentsFor(context.owner);
    if (!documents.length) return null;

    const grant = capabilities.open({
      username: context.owner,
      purpose: `${context.app} · 协作文档`,
      kind: "app-instance",
      rights,
      autoAllow,
      // What an approval card and an audit row can say about WHICH App asked.
      metadata: {
        app: context.app,
        publisher: context.publisher,
        release: context.packageDigest.slice(0, 20),
        contract: context.permissionContractDigest.slice(0, 16),
      },
      pool: crdtDocPoolKey(context),
    });
    if (!grant) return null;

    return {
      documents,
      mayEdit: rights.includes(CRDT_EDIT_OPERATION),
      store,
      authority: {
        request: (operation: string, args: Record<string, unknown>): Promise<InvokeResult> =>
          grant.request(operation, args),
        result: (pendingCallId: string): CrdtDocPendingOutcome | null => {
          const view = grant.capabilities.result(pendingCallId);
          return view ? { state: view.state, outcome: view.outcome } : null;
        },
        alive: () => grant.alive(),
      },
      // The scope's teardown must not orphan an undecided lease card for a
      // sitting that still exists elsewhere — but this Context is pooled per
      // (instance, binding), so when the scope closes the sitting IS over.
      // `close()` (deferred while pending) rather than `destroy()` because the
      // pool owns borrowed lifetimes; a borrowed grant's close is a no-op and
      // the pool's own pruning applies the defer rule.
      close: () => grant.close(),
    };
  };
}

/**
 * What this deployment's CRDT plane holds for one account, for the permission
 * projection.
 *
 * The first line mirrors the grant seam's first line (`if (!store ||
 * !capabilities) return null`), which is the rule `notify-grant.ts` wrote
 * down: the projection and the provider must read the same fact, or the page
 * says "you cannot" while the provider serves you.
 */
export function crdtDocAccountOperations(
  capabilities: CrdtDocCapabilities | undefined,
  owner: string,
): readonly string[] {
  if (!capabilities) return [];
  return capabilities.accountOperations(owner);
}
