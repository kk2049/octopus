/**
 * What a consumer of `workspace-files/v1` is allowed to see.
 *
 * ── The field list IS the boundary ──────────────────────────────────────────
 *
 * A projected entry may carry an opaque ref, a display label, what kind of thing
 * it is, a size, an mtime, a digest, and whether it is too big to open. It may
 * NOT carry:
 *
 *   owner · username · credential · app · scope · instance handle
 *   device routing id · Runner workspace_id
 *   relative path · canonical path · home · URL
 *   grant · capability · context id · pending-call id
 *
 * Not filtered — absent. The trusted provider rebinds a ref to (device,
 * workspace, relative path) on its own side of this boundary, so a consumer has
 * nothing to name a file with except something the provider minted for it. That
 * is the whole design: the alternative, "the View submits a path and the server
 * checks it", makes every checker the security boundary.
 *
 * `sourceLabel` is display text chosen by the trusted composition. It is
 * deliberately NOT the device selector the gateway routes on: a label is a thing
 * to read, and nothing on this contract accepts one back as input.
 *
 * ── Why readers exist for shapes we also construct ──────────────────────────
 *
 * Because the constructing side and the reading side are different processes,
 * usually different origins, and — for a file browser — eventually different
 * release versions. Unknown fields are refused rather than ignored for the same
 * reason they are everywhere else in this repository: a field this build does
 * not understand is either a newer schema or a typo that quietly turned
 * something off.
 */

import { isResourceRef } from "@claude-bot/agent-module-contract";
import {
  IssueBag,
  booleanAt,
  boundedIntAt,
  boundedStringAt,
  isResourceDigest,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "@claude-bot/resource-stream-contract";
import {
  WORKSPACE_FILES_LIMITS,
  isWorkspaceEntryKind,
  type WorkspaceEntryKind,
} from "./limits.js";

/** `2026-08-06T12:34:56.000Z`. A timestamp, never a locale-formatted string. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** One registered workspace, as something a consumer may open. */
export interface WorkspaceFilesRoot {
  /** Opaque, minted by the trusted provider, meaningful only to it. */
  readonly ref: string;
  /** The workspace's own label. */
  readonly label: string;
  /** Display text for where it lives. Never a routing id. */
  readonly sourceLabel: string;
}

export interface WorkspaceFilesRoots {
  readonly roots: readonly WorkspaceFilesRoot[];
  /**
   * More roots follow the last one in this answer. Not a loss: ask again with
   * `after` = the last root's ref (see `paging.ts`).
   */
  readonly truncated: boolean;
}

export interface WorkspaceFilesEntry {
  /**
   * Absent for `other`.
   *
   * A symlink, a socket or a device gets no ref, and that absence is the
   * enforcement: there is nothing for a consumer to submit, so "refuse to
   * traverse a symlink" is not a check anybody has to remember to write.
   */
  readonly ref?: string;
  readonly label: string;
  readonly kind: WorkspaceEntryKind;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
  /** Larger than `wholeTextBytes`: a whole-document view loads a leading part and asks before the rest. */
  readonly exceedsTextLimit?: boolean;
}

export interface WorkspaceFilesDirectory {
  /** The directory that was listed, echoed back. */
  readonly ref: string;
  readonly label: string;
  readonly entries: readonly WorkspaceFilesEntry[];
  /**
   * More children follow the last entry of this page. Not a loss: ask again
   * with `after` = `workspaceListCursor(last entry)` (see `paging.ts`).
   */
  readonly truncated: boolean;
}

/** The header of an opened text file. The bytes arrive over the stream. */
export interface WorkspaceTextDocument {
  readonly ref: string;
  readonly label: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  /** `sha256:<64 hex>` of the whole file as it was when it was opened. */
  readonly digest: string;
  readonly modifiedAt?: string;
}

/** One chunk of an opened text file. Nothing but text. */
export interface WorkspaceTextChunk {
  readonly text: string;
}

const ROOT_FIELDS = ["ref", "label", "sourceLabel"] as const;
const ROOTS_FIELDS = ["roots", "truncated"] as const;
const ENTRY_FIELDS = ["ref", "label", "kind", "sizeBytes", "modifiedAt", "exceedsTextLimit"] as const;
const DIRECTORY_FIELDS = ["ref", "label", "entries", "truncated"] as const;
const DOCUMENT_FIELDS = ["ref", "label", "mediaType", "sizeBytes", "digest", "modifiedAt"] as const;
const CHUNK_FIELDS = ["text"] as const;

function refAt(bag: IssueBag, row: Record<string, unknown>, at: string, optional = false): string | null {
  const ref = boundedStringAt(bag, row, "ref", at, WORKSPACE_FILES_LIMITS.maxRefLength, { optional });
  if (ref !== null && !isResourceRef(ref)) {
    bag.add("identifier", "ref must be a bounded printable reference", `${at}.ref`);
    return null;
  }
  return ref;
}

function instantAt(bag: IssueBag, row: Record<string, unknown>, at: string): string | null {
  if (row.modifiedAt === undefined) return null;
  if (typeof row.modifiedAt !== "string" || !ISO_INSTANT.test(row.modifiedAt)) {
    bag.add("field_type", "modifiedAt must be an ISO-8601 instant in UTC", `${at}.modifiedAt`);
    return null;
  }
  return row.modifiedAt;
}

export function readWorkspaceFilesRoot(value: unknown, at = "root"): ContractResult<WorkspaceFilesRoot> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ROOT_FIELDS, at);
  const ref = refAt(bag, row, at);
  const label = boundedStringAt(bag, row, "label", at, WORKSPACE_FILES_LIMITS.maxLabelLength);
  const sourceLabel = boundedStringAt(bag, row, "sourceLabel", at, WORKSPACE_FILES_LIMITS.maxLabelLength);
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { ref: ref!, label: label!, sourceLabel: sourceLabel! } };
}

export function readWorkspaceFilesRoots(value: unknown, at = "roots"): ContractResult<WorkspaceFilesRoots> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ROOTS_FIELDS, at);
  const truncated = booleanAt(bag, row, "truncated", at);
  const list = row.roots;
  if (!Array.isArray(list)) {
    bag.add("field_type", "roots must be an array", `${at}.roots`);
    return bag.fail();
  }
  if (list.length > WORKSPACE_FILES_LIMITS.maxRoots) {
    bag.add("limit", `roots has more than ${WORKSPACE_FILES_LIMITS.maxRoots} entries`, `${at}.roots`);
    return bag.fail();
  }
  const roots: WorkspaceFilesRoot[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const read = readWorkspaceFilesRoot(list[i], `${at}.roots[${i}]`);
    if (!read.ok) return { ok: false, issues: [...bag.drain(), ...read.issues] };
    roots.push(read.value);
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { roots, truncated: truncated! } };
}

export function readWorkspaceFilesEntry(value: unknown, at = "entry"): ContractResult<WorkspaceFilesEntry> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ENTRY_FIELDS, at);
  const label = boundedStringAt(bag, row, "label", at, WORKSPACE_FILES_LIMITS.maxLabelLength);
  const kind = row.kind;
  if (!isWorkspaceEntryKind(kind)) bag.add("schema", "kind must be file, directory or other", `${at}.kind`);
  const ref = refAt(bag, row, at, true);
  if (kind === "other" && ref !== null) {
    // Minting a ref for something this contract will not open is how a
    // "we refuse to follow symlinks" rule turns back into a check somebody has
    // to remember. A reader that saw one is reading a producer that is wrong.
    bag.add("schema", "an `other` entry must not carry a ref", `${at}.ref`);
  }
  if ((kind === "file" || kind === "directory") && ref === null) {
    bag.add("missing_field", "missing ref", at);
  }
  const sizeBytes = boundedIntAt(bag, row, "sizeBytes", at, Number.MAX_SAFE_INTEGER, { optional: true });
  const modifiedAt = instantAt(bag, row, at);
  const exceedsTextLimit = booleanAt(bag, row, "exceedsTextLimit", at, { optional: true });
  if (!bag.empty) return bag.fail();
  const entry: {
    ref?: string;
    label: string;
    kind: WorkspaceEntryKind;
    sizeBytes?: number;
    modifiedAt?: string;
    exceedsTextLimit?: boolean;
  } = { label: label!, kind: kind as WorkspaceEntryKind };
  if (ref !== null) entry.ref = ref;
  if (sizeBytes !== null) entry.sizeBytes = sizeBytes;
  if (modifiedAt !== null) entry.modifiedAt = modifiedAt;
  if (exceedsTextLimit !== null) entry.exceedsTextLimit = exceedsTextLimit;
  return { ok: true, value: entry };
}

export function readWorkspaceFilesDirectory(
  value: unknown,
  at = "directory",
): ContractResult<WorkspaceFilesDirectory> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, DIRECTORY_FIELDS, at);
  const ref = refAt(bag, row, at);
  const label = boundedStringAt(bag, row, "label", at, WORKSPACE_FILES_LIMITS.maxLabelLength);
  const truncated = booleanAt(bag, row, "truncated", at);
  const list = row.entries;
  if (!Array.isArray(list)) {
    bag.add("field_type", "entries must be an array", `${at}.entries`);
    return bag.fail();
  }
  if (list.length > WORKSPACE_FILES_LIMITS.maxEntries) {
    bag.add("limit", `entries has more than ${WORKSPACE_FILES_LIMITS.maxEntries} rows`, `${at}.entries`);
    return bag.fail();
  }
  const entries: WorkspaceFilesEntry[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const read = readWorkspaceFilesEntry(list[i], `${at}.entries[${i}]`);
    if (!read.ok) return { ok: false, issues: [...bag.drain(), ...read.issues] };
    entries.push(read.value);
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { ref: ref!, label: label!, entries, truncated: truncated! } };
}

export function readWorkspaceTextDocument(
  value: unknown,
  at = "document",
): ContractResult<WorkspaceTextDocument> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, DOCUMENT_FIELDS, at);
  const ref = refAt(bag, row, at);
  const label = boundedStringAt(bag, row, "label", at, WORKSPACE_FILES_LIMITS.maxLabelLength);
  const mediaType = boundedStringAt(bag, row, "mediaType", at, WORKSPACE_FILES_LIMITS.maxMediaTypeLength);
  const sizeBytes = boundedIntAt(bag, row, "sizeBytes", at, WORKSPACE_FILES_LIMITS.maxTextBytes);
  if (!isResourceDigest(row.digest)) bag.add("identifier", "digest must be sha256:<64 hex>", `${at}.digest`);
  const modifiedAt = instantAt(bag, row, at);
  if (!bag.empty) return bag.fail();
  const doc: {
    ref: string;
    label: string;
    mediaType: string;
    sizeBytes: number;
    digest: string;
    modifiedAt?: string;
  } = {
    ref: ref!,
    label: label!,
    mediaType: mediaType!,
    sizeBytes: sizeBytes!,
    digest: row.digest as string,
  };
  if (modifiedAt !== null) doc.modifiedAt = modifiedAt;
  return { ok: true, value: doc };
}

export function readWorkspaceTextChunk(value: unknown, at = "chunk"): ContractResult<WorkspaceTextChunk> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, CHUNK_FIELDS, at);
  const text = boundedStringAt(bag, row, "text", at, WORKSPACE_FILES_LIMITS.textChunkBytes);
  if (text !== null && utf8ByteLength(text) > WORKSPACE_FILES_LIMITS.textChunkBytes) {
    bag.add("limit", `text is larger than ${WORKSPACE_FILES_LIMITS.textChunkBytes} UTF-8 bytes`, `${at}.text`);
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { text: text! } };
}

/**
 * Pure UTF-8 accounting: this contract package deliberately has no Node/DOM
 * dependency.
 *
 * Exported because the remote client MEASURES a chunk rather than believing the
 * size a frame claims, and a second implementation of "how many bytes is this
 * string" is exactly the kind of thing that would disagree by one on an
 * astral-plane character.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const point = value.codePointAt(index)!;
    if (point <= 0x7f) bytes += 1;
    else if (point <= 0x7ff) bytes += 2;
    else if (point <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}
