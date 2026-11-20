/**
 * `app-permissions/v1` — the release's own statement of which permission
 * contract it asks for.
 *
 * ── Why a release has to say this out loud ─────────────────────────────────
 *
 * Until this document existed, "which ask does this release make" was answered
 * by the SHAPE of its asset inventory: a table inside the platform mapped
 * `modular-v2 → sessions-workspace/v1`, and the descriptor's digest was checked
 * against it. That is a perfectly good CHECK and a poor STATEMENT — the artifact
 * itself said nothing, so a reviewer holding the bytes could not tell what they
 * ask for without also reading the host's source at the version that will
 * eventually serve them. A permission ask is the one thing about a release that
 * a person is asked to agree to; it should be legible in the release.
 *
 * So the release says it, and the shape mapping stays. The two must agree, and
 * a disagreement in either direction is a refusal. That is deliberately a
 * CROSS-CHECK, not a second source of truth: the platform still decides which
 * contracts exist, which shape may declare which, and what any of them mean. All
 * this document adds is a place where a typo becomes loud instead of becoming a
 * different permission set.
 *
 *   {
 *     "schema": "app-permissions/v1",
 *     "contract": "sessions-workspace-write/v1"
 *   }
 *
 * ── Why it is this small, and must stay this small ─────────────────────────
 *
 * It names ONE contract id and nothing else. Not the operation list, not an
 * auto-allow set, not a rationale string, not a version range. A release that
 * could enumerate its own operations would be a release that could invent one,
 * and the enumeration already exists once — in the platform's closed catalog,
 * which is the only place that can map an operation onto a Gate token, a consent
 * screen and an audit row. The id here is COMPARED against that catalog; it is
 * never parsed into permissions, joined onto a path, or resolved.
 *
 * An unknown id is therefore not a smaller ask or a larger one. It is an ask
 * this build cannot project, grant or audit, and the only honest answer to it is
 * a refusal — the same answer the descriptor's digest already gets.
 *
 * ── Why the contract id reuses the port-contract grammar ───────────────────
 *
 * `sessions-workspace-write/v1` is not a typed port, so this could have had its
 * own pattern. It does not, for the reason `bindings.ts` gives for reusing the
 * instance-id grammar for binding names: the two are the same KIND of string —
 * a short, namespaced, versioned identifier that is only ever compared — and a
 * second grammar is a second thing to get wrong in the same way.
 */

import { isContractId } from "./ids.js";
import {
  IssueBag,
  encodeCanonical,
  objectAt,
  parseJsonDocument,
  refuseUnknownFields,
  stringAt,
  type ContractResult,
} from "./validate.js";

export const APP_PERMISSIONS_SCHEMA = "app-permissions/v1";

/** What one release declares it is asking a deployment for. */
export interface AppPermissions {
  schema: typeof APP_PERMISSIONS_SCHEMA;
  /**
   * The permission contract id, e.g. `sessions-workspace-write/v1`.
   *
   * Compared against the serving build's closed catalog, never interpreted.
   */
  contract: string;
}

const PERMISSIONS_FIELDS = ["schema", "contract"] as const;

export function readAppPermissions(value: unknown): ContractResult<AppPermissions> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "permissions");
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, PERMISSIONS_FIELDS, "permissions");
  if (row.schema !== APP_PERMISSIONS_SCHEMA) {
    bag.add("schema", `permissions.schema must be ${APP_PERMISSIONS_SCHEMA}`, "permissions.schema");
  }
  const contract = stringAt(bag, row, "contract", "permissions");
  if (contract !== null && !isContractId(contract)) {
    bag.add("identifier", "contract must look like `sessions-workspace-write/v1`", "permissions.contract");
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { schema: APP_PERMISSIONS_SCHEMA, contract: contract! } };
}

export function parseAppPermissions(text: string): ContractResult<AppPermissions> {
  return parseJsonDocument(text, "permissions", readAppPermissions);
}

export function encodeAppPermissions(declaration: AppPermissions): string {
  return encodeCanonical({ schema: APP_PERMISSIONS_SCHEMA, contract: declaration.contract });
}
