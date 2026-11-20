/**
 * `workspace-files/v2` — v1's projection plus one optional field.
 *
 * ── Why a version rather than an optional field on v1 ──────────────────────
 *
 * Because v1's readers refuse unknown fields, and that refusal is load-bearing:
 * a field this build does not understand is either a newer schema or a typo that
 * quietly turned something off. A producer that started emitting `directoryKey`
 * into a v1 binding would make every v1 consumer refuse the whole listing —
 * which is the correct behaviour of a contract being violated, not a migration.
 *
 * So v2 is a second contract id, and a release binds exactly one of them.
 *
 * ── Why the readers below DELEGATE ─────────────────────────────────────────
 *
 * Every v2 reader strips the one new field, hands the rest to v1's reader, and
 * re-attaches. Written that way rather than copied, "v2 is v1 plus a key" is
 * something the code says rather than something a comment claims — and a change
 * to what v1 accepts cannot leave v2 accepting the old thing.
 *
 * ── Where the key may appear ───────────────────────────────────────────────
 *
 * On a root, on a `directory` entry, and on the listing's own envelope. NOT on a
 * `file` and NOT on an `other`: a key names a directory, and minting one for a
 * file would invite a consumer to join a file row against a directory row. The
 * reader refuses it there for the same reason it refuses a ref on an `other` —
 * a producer that emitted one is wrong, and finding out here is cheaper than
 * finding out in a tree that reparented itself.
 */

import {
  IssueBag,
  objectAt,
  type ContractResult,
} from "@claude-bot/resource-stream-contract";
import { isWorkspaceDirectoryKey } from "./directory-key.js";
import { WORKSPACE_FILES_LIMITS } from "./limits.js";
import {
  readWorkspaceFilesDirectory,
  readWorkspaceFilesEntry,
  readWorkspaceFilesRoot,
  readWorkspaceFilesRoots,
  type WorkspaceFilesDirectory,
  type WorkspaceFilesEntry,
  type WorkspaceFilesRoot,
  type WorkspaceFilesRoots,
} from "./projection.js";

/** The contract id. Compared, never parsed, and never a path. */
export const WORKSPACE_FILES_CONTRACT_V2 = "workspace-files/v2";

/**
 * One registered workspace, and — when the trusted side could establish it —
 * which real directory it is.
 */
export interface WorkspaceFilesRootV2 extends WorkspaceFilesRoot {
  /** Absent means "not promised". Never a reason to compare labels instead. */
  readonly directoryKey?: string;
}

export interface WorkspaceFilesRootsV2 extends WorkspaceFilesRoots {
  readonly roots: readonly WorkspaceFilesRootV2[];
}

export interface WorkspaceFilesEntryV2 extends WorkspaceFilesEntry {
  /** Only ever present on a `directory`. */
  readonly directoryKey?: string;
}

export interface WorkspaceFilesDirectoryV2 extends WorkspaceFilesDirectory {
  readonly entries: readonly WorkspaceFilesEntryV2[];
  /** The listed directory's own key. */
  readonly directoryKey?: string;
}

/**
 * Read the optional key and remove it from the row handed to v1.
 *
 * Returns the key, or null when there was none. Adds an issue — and returns
 * null — when there was one and it was not a key.
 */
function splitDirectoryKey(
  bag: IssueBag,
  row: Record<string, unknown>,
  at: string,
): { key: string | null; rest: Record<string, unknown> } {
  const { directoryKey, ...rest } = row;
  if (directoryKey === undefined) return { key: null, rest };
  if (!isWorkspaceDirectoryKey(directoryKey)) {
    bag.add("identifier", "directoryKey must be a bounded opaque directory key", `${at}.directoryKey`);
    return { key: null, rest };
  }
  return { key: directoryKey, rest };
}

export function readWorkspaceFilesRootV2(value: unknown, at = "root"): ContractResult<WorkspaceFilesRootV2> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  const { key, rest } = splitDirectoryKey(bag, row, at);
  if (!bag.empty) return bag.fail();
  const base = readWorkspaceFilesRoot(rest, at);
  if (!base.ok) return base;
  return { ok: true, value: key === null ? base.value : { ...base.value, directoryKey: key } };
}

export function readWorkspaceFilesRootsV2(value: unknown, at = "roots"): ContractResult<WorkspaceFilesRootsV2> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  const list = row.roots;
  if (!Array.isArray(list)) {
    bag.add("field_type", "roots must be an array", `${at}.roots`);
    return bag.fail();
  }
  // The envelope's own fields, checked by v1 against an empty list — so
  // `truncated`, the field set and the array's type all have one implementation.
  const envelope = readWorkspaceFilesRoots({ ...row, roots: [] }, at);
  if (!envelope.ok) return envelope;
  if (list.length > WORKSPACE_FILES_LIMITS.maxRoots) {
    bag.add("limit", `roots has more than ${WORKSPACE_FILES_LIMITS.maxRoots} entries`, `${at}.roots`);
    return bag.fail();
  }
  const roots: WorkspaceFilesRootV2[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const read = readWorkspaceFilesRootV2(list[i], `${at}.roots[${i}]`);
    if (!read.ok) return { ok: false, issues: [...bag.drain(), ...read.issues] };
    roots.push(read.value);
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { roots, truncated: envelope.value.truncated } };
}

export function readWorkspaceFilesEntryV2(value: unknown, at = "entry"): ContractResult<WorkspaceFilesEntryV2> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  const { key, rest } = splitDirectoryKey(bag, row, at);
  if (key !== null && rest.kind !== "directory") {
    bag.add("schema", "only a `directory` entry may carry a directoryKey", `${at}.directoryKey`);
  }
  if (!bag.empty) return bag.fail();
  const base = readWorkspaceFilesEntry(rest, at);
  if (!base.ok) return base;
  return { ok: true, value: key === null ? base.value : { ...base.value, directoryKey: key } };
}

export function readWorkspaceFilesDirectoryV2(
  value: unknown,
  at = "directory",
): ContractResult<WorkspaceFilesDirectoryV2> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  const { key, rest } = splitDirectoryKey(bag, row, at);
  if (!bag.empty) return bag.fail();
  const list = rest.entries;
  if (!Array.isArray(list)) {
    bag.add("field_type", "entries must be an array", `${at}.entries`);
    return bag.fail();
  }
  const envelope = readWorkspaceFilesDirectory({ ...rest, entries: [] }, at);
  if (!envelope.ok) return envelope;
  if (list.length > WORKSPACE_FILES_LIMITS.maxEntries) {
    bag.add("limit", `entries has more than ${WORKSPACE_FILES_LIMITS.maxEntries} rows`, `${at}.entries`);
    return bag.fail();
  }
  const entries: WorkspaceFilesEntryV2[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const read = readWorkspaceFilesEntryV2(list[i], `${at}.entries[${i}]`);
    if (!read.ok) return { ok: false, issues: [...bag.drain(), ...read.issues] };
    entries.push(read.value);
  }
  if (!bag.empty) return bag.fail();
  const directory: WorkspaceFilesDirectoryV2 = {
    ref: envelope.value.ref,
    label: envelope.value.label,
    entries,
    truncated: envelope.value.truncated,
  };
  return { ok: true, value: key === null ? directory : { ...directory, directoryKey: key } };
}
