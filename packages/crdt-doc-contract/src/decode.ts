/**
 * Decode one arriving proposal by THIS CONTRACT's declared bounds.
 *
 * ── Why this is not `decodeWireParams` ─────────────────────────────────────
 *
 * The kit's decoder applies two things at once: the action's declared per-field
 * bounds, and the View wire's flat `maxValueLength` of 512 characters for every
 * parameter of every action. For every contract written so far those coincide,
 * because every contract so far declared fields that fit. `crdt-doc/v1` does
 * not: a CRDT update is bytes, base64 costs a third on top, and the smallest
 * useful one is already near 512 characters.
 *
 * So calling `decodeWireParams` here would mean the provider refuses every
 * update a real editor produces — with a diagnostic about a transport the caller
 * may not even be using. This decoder applies the declaration and nothing else,
 * which is exactly the split decision 5 already draws: "the wire's 8 keys × 512
 * characters does not constrain the MCP face, because that bridge runs inside
 * the trusted process and takes bounded structured JSON". An in-process typed
 * port is on the same side of that line as the MCP bridge.
 *
 * ── Why this is not a second opinion about what the contract accepts ───────
 *
 * Because it reads the SAME declaration. Every bound it applies is the one the
 * author wrote in `contract.ts`; there is no number in this file. `decode.test.ts`
 * pins that further, differentially: for every value that fits in 512 characters,
 * this decoder and the kit's must agree exactly — accept the same things and
 * produce the same issue codes. The only permitted divergence is the one this
 * file exists for.
 *
 * ── This file has a scheduled death ────────────────────────────────────────
 *
 * When per-action wire bounds land (convergence plan sideline 6, P6b), the kit's
 * decoder can be told which bound applies and this file becomes a re-export and
 * then a deletion. The dependency is recorded in the worklog rather than worked
 * around by declaring a fake 512-character update field.
 */

import {
  IssueBag,
  actionOf,
  type ContractDeclaration,
  type ContractResult,
  type PortActionDeclaration,
  type PortField,
} from "@claude-bot/typed-port-kit";

import { CRDT_DOC_DECLARATION, type CrdtDocActionId } from "./contract.js";
import { CRDT_DOC_DECLARATION_V2, type CrdtDocActionIdV2 } from "./contract-v2.js";

/**
 * Look up one arriving action id.
 *
 * Returns null rather than throwing: this is the lookup a trusted dispatcher
 * performs on a string that arrived from somewhere else, where the type says
 * nothing.
 */
export function crdtActionOf(action: string): PortActionDeclaration<CrdtDocActionId> | null {
  return actionOf(CRDT_DOC_DECLARATION as ContractDeclaration<string, CrdtDocActionId>, action);
}

/** The same lookup against `crdt-doc/v2`'s declaration. */
export function crdtActionOfV2(action: string): PortActionDeclaration<CrdtDocActionIdV2> | null {
  return actionOf(CRDT_DOC_DECLARATION_V2 as ContractDeclaration<string, CrdtDocActionIdV2>, action);
}

/**
 * Turn one action's flat string parameters back into its declared types.
 *
 * The three rules are the kit's, restated because they are load-bearing:
 * an unknown parameter is a refusal rather than something to drop; an absent
 * required parameter is a refusal rather than a default; and nothing is coerced.
 */
export function decodeCrdtParams(
  action: PortActionDeclaration<CrdtDocActionId | CrdtDocActionIdV2>,
  params: Readonly<Record<string, unknown>>,
): ContractResult<Record<string, unknown>> {
  const bag = new IssueBag();
  const at = action.action;
  const out: Record<string, unknown> = {};

  for (const name of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(action.params, name)) {
      bag.add("unknown_field", `unknown parameter ${name}`, at);
    }
  }

  for (const [name, field] of Object.entries(action.params)) {
    const raw = Object.prototype.hasOwnProperty.call(params, name) ? params[name] : undefined;
    if (raw === undefined) {
      if (!field.optional) bag.add("missing_field", `missing ${name}`, at);
      continue;
    }
    if (typeof raw !== "string") {
      bag.add("field_type", `${name} must arrive as a string`, `${at}.${name}`);
      continue;
    }
    const value = decodeDeclaredField(bag, `${at}.${name}`, name, field, raw);
    if (value !== undefined) out[name] = value;
  }

  if (!bag.empty) return bag.fail();
  return { ok: true, value: out };
}

/**
 * One field, by its declaration.
 *
 * `crdt-doc/v1` declares only strings, so the other three branches are not
 * reimplemented here — a contract that grew an integer parameter would want the
 * kit's decoder back, which is the direction this file is supposed to move in
 * anyway. An unexpected field type is a loud programming error rather than a
 * quietly accepted value.
 */
function decodeDeclaredField(
  bag: IssueBag,
  at: string,
  name: string,
  field: PortField,
  raw: string,
): unknown {
  if (field.type !== "string") {
    throw new Error(`crdt-doc declares no ${field.type} parameter; ${at} needs the kit's decoder`);
  }
  if (field.enum !== undefined && !field.enum.includes(raw)) {
    bag.add("schema", `${name} must be one of ${field.enum.join(", ")}`, at);
    return undefined;
  }
  if (field.maxLength !== undefined && raw.length > field.maxLength) {
    bag.add("limit", `${name} is longer than ${field.maxLength} characters`, at);
    return undefined;
  }
  if (field.pattern !== undefined && !field.pattern.test(raw)) {
    bag.add("identifier", `${name} does not match its declared form`, at);
    return undefined;
  }
  return raw;
}
