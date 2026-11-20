/**
 * How many characters one arriving resource proposal parameter may carry.
 *
 * ── Why this table exists at all ────────────────────────────────────────────
 *
 * A resource proposal is a flat map of bounded strings, and the trusted
 * coordinator bounds it WITHOUT knowing what any parameter means — eight keys of
 * 512 characters. That default is what made P6a's write verb unsendable from an
 * Agent View: a whole file body does not fit in 512 characters, and the honest
 * answer at the time was to record the incompatibility (`wireProblems`) rather
 * than declare a bound that would have truncated an edit.
 *
 * The editor batch resolves it in the one direction that keeps the decision on
 * the trusted side: a CONTRACT may declare a larger bound for one parameter of
 * one action, and the coordinator honours the declaration it compiled in.
 *
 * ── Why this is trusted data and not a view-chosen limit ────────────────────
 *
 * Three steps, and the order is the whole argument:
 *
 *  1. the *binding name* in the proposal selects among the App's own
 *     `agent-resource-bindings/v1` plan — a document the trusted side holds and
 *     the View cannot edit;
 *  2. the plan says which CONTRACT that binding is for;
 *  3. this table maps that contract id to a declaration compiled into this
 *     build, and the declaration says how long that parameter may be.
 *
 * Nothing a View sends is read as a size. A binding name it invents resolves to
 * nothing and gets the 512-character default; an action name it invents is not
 * in the declaration and gets the default; a contract this build does not
 * implement gets the default. Every unknown is the narrow answer.
 *
 * The catalog remains the authority on what may be CALLED — it resolves the
 * binding against its own snapshot and checks the provider's closed action set.
 * This module only decides how much of a value survives the copy, which is why
 * a disagreement between the two can only ever be more restrictive here.
 */

import { CRDT_DOC_DECLARATION, CRDT_DOC_DECLARATION_V2 } from "@claude-bot/crdt-doc-contract";
import { NOTIFY_DECLARATION } from "@claude-bot/notify-contract";
import {
  RESOURCE_ACTION_PREFIX,
  WIRE_PARAM_LIMITS,
  actionOf,
  wireValueLimit,
  type ContractDeclaration,
} from "@claude-bot/typed-port-kit";
import {
  WORKSPACE_FILES_DECLARATION,
  WORKSPACE_FILES_DECLARATION_V2,
  WORKSPACE_FILES_DECLARATION_V3,
  WORKSPACE_FILES_DECLARATION_V4,
} from "@claude-bot/workspace-files-contract";

/**
 * Every contract declaration this build compiled in, by contract id.
 *
 * A contract with a provider but no declaration is not an error: its parameters
 * are then bounded by the default, which is what they were before this existed.
 * What must not happen is a declaration appearing here that no provider serves —
 * that would raise a bound for something nothing can be proposed to — so the
 * list is kept next to the providers rather than in a shared "all contracts"
 * module somewhere else.
 */
const DECLARATIONS: readonly ContractDeclaration[] = Object.freeze([
  WORKSPACE_FILES_DECLARATION,
  // The SAME declaration under the v2 id (derived in the contract package, not
  // copied): a release binding v2 must keep the declared file-body bound, and
  // both providers are registered by the same composition.
  WORKSPACE_FILES_DECLARATION_V2,
  WORKSPACE_FILES_DECLARATION_V3,
  WORKSPACE_FILES_DECLARATION_V4,
  NOTIFY_DECLARATION,
  // Both CRDT versions are registered by the same composition. Without these
  // rows a View's `update` and `since` fell back to the 512-character default,
  // so any push past a few hundred bytes of typing was refused at the door.
  CRDT_DOC_DECLARATION,
  CRDT_DOC_DECLARATION_V2,
]);

const BY_CONTRACT = new Map<string, ContractDeclaration>(
  DECLARATIONS.map((declaration) => [declaration.contract, declaration]),
);

/** The bound for a parameter nobody declared anything about. */
export const RESOURCE_PARAM_DEFAULT_MAX = WIRE_PARAM_LIMITS.maxValueLength;

/** Distinct parameter names one proposal may carry. */
export const RESOURCE_PARAM_COUNT = WIRE_PARAM_LIMITS.maxKeys;

/**
 * The per-parameter character bounds for one wire action of one contract.
 *
 * Returns null when this build knows nothing about the pair, which the caller
 * reads as "the default applies to everything". A returned map covers only the
 * parameters the action declares; anything else is still the default, including
 * the kit's own reserved `binding`, `handle` and `seq`.
 */
export function resourceParamLimits(
  contract: string | undefined,
  wireAction: string,
): ReadonlyMap<string, number> | null {
  if (!contract) return null;
  const declaration = BY_CONTRACT.get(contract);
  if (!declaration) return null;
  if (!wireAction.startsWith(RESOURCE_ACTION_PREFIX)) return null;
  const declared = actionOf(declaration, wireAction.slice(RESOURCE_ACTION_PREFIX.length));
  if (!declared) return null;

  const limits = new Map<string, number>();
  for (const [name, field] of Object.entries(declared.params)) {
    const limit = wireValueLimit(field);
    // `null` means the declaration cannot travel this wire at all (unbounded, or
    // over the ceiling). The default is the fail-closed answer: an action like
    // that is one `createRemoteCall` refuses to build, so nothing legitimate is
    // sending it.
    limits.set(name, limit ?? RESOURCE_PARAM_DEFAULT_MAX);
  }
  return limits;
}
