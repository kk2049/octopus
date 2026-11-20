/**
 * `resolve_path` — one round trip from a base directory ref to a descendant's ref.
 *
 * ── Why this verb exists (ticket #243) ──────────────────────────────────────
 *
 * A chat transcript names files by display path, and opening one used to cost
 * the View one `list_directory` round trip PER PATH SEGMENT: the View may only
 * address files by refs the trusted side minted, so it descended one listed
 * level at a time. Fourteen segments on a phone network is fourteen chances for
 * the click to die half-way — which is exactly what a flapping device link did.
 *
 * This verb moves the SAME walk to the trusted side. It does not change what a
 * View can reach, in either direction:
 *
 *  · The input is a base ref this port minted earlier plus a sequence of child
 *    LABELS — the same strings the View would otherwise have compared against
 *    each listing. It is a question ("does this labelled descendant exist?"),
 *    never an address: the trusted provider still descends one listing at a
 *    time, only follows entries the device itself reported as plain
 *    directories, and mints the answer's ref from the final listing row exactly
 *    as `list_directory` would have.
 *  · Symlinks stay unaddressable. An intermediate that lists as `other` (or as
 *    a file) refuses with `not_a_directory`, exactly as the View-side walk did,
 *    because the descent goes through the listed `relative_path` the device
 *    echoed — never through a path this side assembled.
 *  · Every underlying listing spends the SAME permission token
 *    (`list_workspace_entries`) through the same Gate. No new capability
 *    operation exists; an `approval_required` at any level ends the resolve
 *    with that refusal, so one click produces at most one approval card —
 *    fewer than the per-level walk could.
 *
 * ── Versioning ──────────────────────────────────────────────────────────────
 *
 * v1 is frozen (see `v1-frozen.test.ts`) and does NOT carry this verb: its
 * action vocabulary, proposal-action set and port surface are golden-pinned.
 * The verb is served only for bindings that name `workspace-files/v2`, through
 * the v2 proposal-action set in `remote-v2.ts`. The answer carries no
 * v2-specific field, so this module stays version-neutral data.
 */

import {
  IssueBag,
  booleanAt,
  boundedIntAt,
  boundedStringAt,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "@claude-bot/resource-stream-contract";
import { isResourceRef } from "@claude-bot/agent-module-contract";
import { WORKSPACE_FILES_LIMITS } from "./limits.js";

/** The wire action id. Only in the v2 proposal-action set. */
export const RESOURCE_RESOLVE_PATH_ACTION = "resource.resolve_path";

/** The one parameter beyond `binding` and `ref`: labels joined by `/`. */
export const RESOLVE_PATH_PARAM = "path";

/**
 * The permission token every underlying listing spends. Stated so a reader can
 * verify this verb adds NOTHING to the capability Object's closed set.
 */
export const WORKSPACE_FILES_RESOLVE_OPERATION = "list_workspace_entries";

export const WORKSPACE_RESOLVE_LIMITS = Object.freeze({
  /** Path segments one resolve may descend. Deeper is two resolves. */
  maxDepth: 32,
  /**
   * Characters of the joined path. Below the wire's 512-character default
   * parameter bound on purpose: the verb needs no enlarged declaration.
   */
  maxPathChars: 400,
});

/** A character no child label may carry: separators, NUL, line breaks. */
// eslint-disable-next-line no-control-regex -- NUL is exactly what is refused
const LABEL_FORBIDDEN = new RegExp("[/\\\\\\u0000\\n\\r]");

/**
 * Why this label sequence cannot be resolved, or null when it can.
 *
 * ONE implementation, used by the remote client (refuse before a proposal
 * exists) and by the trusted provider (refuse before a backend call exists).
 * A label is a child NAME as a listing would carry it: no separator, no NUL,
 * no dot-navigation, no leading/trailing whitespace the device would refuse in
 * the joined path anyway. Inner spaces are ordinary file-name characters.
 */
export function workspaceResolveLabelsProblem(labels: readonly unknown[]): string | null {
  if (!Array.isArray(labels) || labels.length === 0) return "这次解析没有给出要查找的路径。";
  if (labels.length > WORKSPACE_RESOLVE_LIMITS.maxDepth) {
    return `这次解析的路径超过了 ${WORKSPACE_RESOLVE_LIMITS.maxDepth} 层。`;
  }
  let joined = labels.length - 1;
  for (const label of labels) {
    if (typeof label !== "string" || label.length === 0) return "这次解析的路径里有空的名字。";
    if (label.length > WORKSPACE_FILES_LIMITS.maxLabelLength) return "这次解析的路径里有超长的名字。";
    if (label === "." || label === "..") return "这次解析的路径不接受目录导航符。";
    if (LABEL_FORBIDDEN.test(label)) return "这次解析的路径里有非法字符。";
    if (label !== label.trim()) return "这次解析的路径里有首尾空白的名字。";
    joined += label.length;
  }
  if (joined > WORKSPACE_RESOLVE_LIMITS.maxPathChars) {
    return `这次解析的路径超过了 ${WORKSPACE_RESOLVE_LIMITS.maxPathChars} 个字符。`;
  }
  return null;
}

/**
 * The answer: the resolved entry's ref, plus the question echoed back.
 *
 * `base` and `path` exist so the client can check the answer is an answer to
 * THIS request — the resolved `ref` is newly minted and cannot serve as the
 * echo. `kind` excludes `other` by construction: something unopenable refuses
 * (`not_a_file`), it never resolves.
 */
export interface WorkspaceResolvedEntry {
  /** The base directory ref the resolve started from, echoed back. */
  readonly base: string;
  /** The labels as submitted, joined by `/`, echoed back. */
  readonly path: string;
  /** Opaque ref of the resolved entry, minted from the final listing row. */
  readonly ref: string;
  /** The resolved entry's own label — always the last segment of `path`. */
  readonly label: string;
  readonly kind: "file" | "directory";
  readonly sizeBytes?: number;
  /** Larger than `wholeTextBytes`: a whole-document view loads a leading part and asks before the rest. */
  readonly exceedsTextLimit?: boolean;
}

const RESOLVED_FIELDS = ["base", "path", "ref", "label", "kind", "sizeBytes", "exceedsTextLimit"] as const;

export function readWorkspaceResolvedEntry(
  value: unknown,
  at = "resolved",
): ContractResult<WorkspaceResolvedEntry> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, RESOLVED_FIELDS, at);
  const base = boundedStringAt(bag, row, "base", at, WORKSPACE_FILES_LIMITS.maxRefLength);
  if (base !== null && !isResourceRef(base)) {
    bag.add("identifier", "base must be a bounded printable reference", `${at}.base`);
  }
  const ref = boundedStringAt(bag, row, "ref", at, WORKSPACE_FILES_LIMITS.maxRefLength);
  if (ref !== null && !isResourceRef(ref)) {
    bag.add("identifier", "ref must be a bounded printable reference", `${at}.ref`);
  }
  const path = boundedStringAt(bag, row, "path", at, WORKSPACE_RESOLVE_LIMITS.maxPathChars);
  const labels = path === null ? null : path.split("/");
  if (labels !== null && workspaceResolveLabelsProblem(labels) !== null) {
    bag.add("schema", "path must be a valid label sequence joined by /", `${at}.path`);
  }
  const label = boundedStringAt(bag, row, "label", at, WORKSPACE_FILES_LIMITS.maxLabelLength);
  if (label !== null && labels !== null && labels[labels.length - 1] !== label) {
    bag.add("schema", "label must equal the last segment of path", `${at}.label`);
  }
  if (row.kind !== "file" && row.kind !== "directory") {
    bag.add("schema", "kind must be file or directory", `${at}.kind`);
  }
  const sizeBytes = boundedIntAt(bag, row, "sizeBytes", at, Number.MAX_SAFE_INTEGER, { optional: true });
  const exceedsTextLimit = booleanAt(bag, row, "exceedsTextLimit", at, { optional: true });
  if (!bag.empty) return bag.fail();
  const entry: {
    base: string;
    path: string;
    ref: string;
    label: string;
    kind: "file" | "directory";
    sizeBytes?: number;
    exceedsTextLimit?: boolean;
  } = {
    base: base!,
    path: path!,
    ref: ref!,
    label: label!,
    kind: row.kind as "file" | "directory",
  };
  if (sizeBytes !== null) entry.sizeBytes = sizeBytes;
  if (exceedsTextLimit !== null) entry.exceedsTextLimit = exceedsTextLimit;
  return { ok: true, value: entry };
}
