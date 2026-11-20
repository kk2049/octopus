/**
 * The tree, as a pure function of what has been listed so far.
 *
 * ── Why a flat row list ─────────────────────────────────────────────────────
 *
 * Because the tree is LAZY. A recursive component would have to decide, at every
 * level, whether a directory's children exist yet, are being fetched, or were
 * refused — and each of those is a different thing to show. Flattening makes all
 * three one row shape, and makes "what does the reader actually see" a value a
 * test can assert without a DOM.
 *
 * ── What a row may carry ────────────────────────────────────────────────────
 *
 * An opaque ref, a display label, a kind, a size, and whether opening it will be
 * refused for being too big. There is no path here, and there is nothing to
 * build one out of: a child is addressed by the ref its own listing carried, so
 * this module never joins a parent and a name. That is the whole reason
 * `entry.ref` is the key rather than a constructed path.
 *
 * An `other` entry — a symlink, a socket, a device node — has NO ref, so it gets
 * a row that cannot be opened or expanded. That is enforcement, not styling:
 * there is nothing for a click to submit.
 */

import type {
  WorkspaceFilesDirectory,
  WorkspaceFilesEntry,
  WorkspaceFilesRoots,
} from "@claude-bot/workspace-files-contract";
import type { ListedFileLocation } from "@claude-bot/agent-file-preview";
import { annotationRootsByRef } from "./annotations.js";

/** What one directory ref has produced so far. Per mounted tree, never shared. */
export interface DirectoryState {
  status: "loading" | "ready" | "refused";
  /**
   * Every page loaded so far, concatenated in listing order. `truncated` says
   * more entries follow the last one (2026-10-20: a page, not a loss).
   */
  value: WorkspaceFilesDirectory | null;
  message: string;
  code: string;
  /** The next page: in flight, or refused. Absent while idle. */
  more?: { status: "loading" } | { status: "refused"; message: string; code: string };
}

/**
 * Opaque refs are valid map keys, including strings such as `__proto__` and
 * `constructor`. A real Map is therefore part of the contract here: a plain
 * object would accidentally treat inherited properties as cached resources.
 */
export type DirectoryCache = ReadonlyMap<string, DirectoryState>;
export type ExpandedDirectories = ReadonlySet<string>;

/**
 * The separator inside a synthetic key, written as an ESCAPE.
 *
 * Two decisions, and they are separate:
 *
 *  · **NUL rather than a space or a slash.** A key only has to be unique, and an
 *    opaque ref is "bounded printable" — which includes a space and a slash. A
 *    printable separator means `"a b"` at index 1 and `"a"` at index `"b1"`
 *    could produce the same key. Nothing in the ref grammar can produce a NUL.
 *  · **The escape, never a literal NUL byte.** The runtime value is identical,
 *    but a source file containing a real NUL is one git classifies as BINARY —
 *    no diff, no review, no blame. This repository has been bitten by that
 *    before; `session-plus/identity.ts` carries the same note.
 */
const KEY_SEPARATOR = "\u0000";

export interface TreeRow {
  /** Stable React key. A ref where there is one; otherwise parent + position. */
  key: string;
  /** Absent for `other` and `more`: there is nothing to submit, so nothing to click. */
  ref: string | null;
  label: string;
  /** Opaque root plus listing-carried labels; used only for relative resources. */
  listedLocation?: ListedFileLocation;
  /**
   * `more` is not an entry: it is the trailing row of a listing that has more
   * pages, carrying the directory it continues (`moreOf`) and that page's
   * request state. It is where "加载更多" lives — after the last loaded child.
   */
  kind: "file" | "directory" | "other" | "more";
  /** `more` rows only: the directory ref whose listing continues. */
  moreOf?: string;
  depth: number;
  /** v2 directories only: equality evidence for joining another projection. */
  directoryKey?: string;
  /** Roots only: display text for where this workspace lives. */
  sourceLabel?: string;
  sizeBytes?: number;
  /** Trusted listing metadata, retained for row details and accessible labels. */
  modifiedAt?: string;
  /** Opening it would be refused; the tree says so before somebody clicks. */
  exceedsTextLimit?: boolean;
  /** Directories only. */
  expanded?: boolean;
  loading?: boolean;
  /**
   * A bounded refusal for THIS directory's own listing — or, on a `more` row,
   * for the page it would have loaded.
   */
  refusal?: string;
  /** More children follow the loaded ones; a trailing `more` row loads them. */
  truncated?: boolean;
}

function rowOf(entry: WorkspaceFilesEntry, parent: TreeRow, index: number): TreeRow {
  const row: TreeRow = {
    key: entry.ref ?? `${parent.key}${KEY_SEPARATOR}${index}`,
    ref: entry.ref ?? null,
    label: entry.label,
    kind: entry.kind,
    depth: parent.depth + 1,
    ...(parent.listedLocation ? {
      listedLocation: {
        rootRef: parent.listedLocation.rootRef,
        labels: [...parent.listedLocation.labels, entry.label],
        ...(parent.listedLocation.annotationRoot
          ? { annotationRoot: parent.listedLocation.annotationRoot }
          : {}),
      },
    } : {}),
  };
  if (entry.sizeBytes !== undefined) row.sizeBytes = entry.sizeBytes;
  if (entry.modifiedAt !== undefined) row.modifiedAt = entry.modifiedAt;
  if (entry.exceedsTextLimit !== undefined) row.exceedsTextLimit = entry.exceedsTextLimit;
  const directoryKey = projectedDirectoryKey(entry);
  if (row.kind === "directory" && directoryKey) row.directoryKey = directoryKey;
  return row;
}

/** v1 has no key; v2 is the same structural value with this optional field. */
function projectedDirectoryKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const key = (value as { directoryKey?: unknown }).directoryKey;
  return typeof key === "string" && key ? key : undefined;
}

/**
 * Directories first, then files, then the unaddressable rest.
 *
 * The device already returns a deterministic order; this only groups by kind so
 * a deep tree reads the way a file browser reads. Comparison is by code unit
 * rather than by locale, for the same reason the device's is: a listing that
 * reordered itself with the reader's language would make two screenshots of one
 * directory disagree.
 */
const KIND_ORDER: Record<TreeRow["kind"], number> = { directory: 0, file: 1, other: 2, more: 3 };

function sortRows(rows: TreeRow[]): TreeRow[] {
  return rows.sort((a, b) => {
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

/**
 * A dot-prefixed name, the POSIX convention for "not part of ordinary browsing".
 *
 * Exported because the composing navigation builds display nodes out of
 * workspace display paths rather than out of listings, and it has to answer the
 * same question about a SEGMENT that this module answers about an entry.
 */
export function isHiddenLabel(label: string): boolean {
  return label.startsWith(".");
}

export interface VisibleRowsOptions {
  /**
   * Drop dot-prefixed entries from every listing (ticket #350).
   *
   * A display filter and nothing else: the listing that produced them is
   * unchanged, `truncated` still says what the device said, and a REGISTERED
   * root is never filtered — the person registered that workspace explicitly,
   * so removing it would be this side overruling their decision rather than
   * tidying their browsing.
   */
  hideDotEntries?: boolean;
}

/**
 * Every row the reader can currently see, in order.
 *
 * A collapsed directory contributes one row. An expanded one contributes its
 * own row plus whatever its listing has produced — which may be nothing yet
 * (`loading`) or a refusal, and both are states of THAT row rather than of the
 * tree.
 */
export function visibleRows(
  roots: WorkspaceFilesRoots | null,
  cache: DirectoryCache,
  expanded: ExpandedDirectories,
  options: VisibleRowsOptions = {},
): TreeRow[] {
  const out: TreeRow[] = [];
  const annotationRoots = annotationRootsByRef(roots?.roots ?? []);
  const walk = (row: TreeRow): void => {
    out.push(row);
    if (row.kind !== "directory" || !row.ref || !row.expanded) return;
    const listing = cache.get(row.ref);
    if (!listing || listing.status === "loading") return;
    if (listing.status === "refused" || !listing.value) return;
    // Map BEFORE filtering: an unaddressable entry's key is its position in the
    // listing, and re-indexing a filtered array would move that key whenever the
    // knob flips.
    const children = sortRows(
      listing.value.entries
        .map((entry, index) => rowOf(entry, row, index))
        .filter((child) => !options.hideDotEntries || !isHiddenLabel(child.label)),
    );
    for (const child of children) walk(decorate(child, cache, expanded));
    if (listing.value.truncated) {
      // After the last loaded child, not under the directory's own label: the
      // next page appends below, where the reader already is.
      out.push({
        key: `${row.key}${KEY_SEPARATOR}more`,
        ref: null,
        label: "",
        kind: "more",
        moreOf: row.ref,
        depth: row.depth + 1,
        ...(listing.more?.status === "loading" ? { loading: true } : {}),
        ...(listing.more?.status === "refused" ? { refusal: listing.more.message } : {}),
      });
    }
  };
  for (const root of roots?.roots ?? []) {
    const directoryKey = projectedDirectoryKey(root);
    // Display identity is useful only with uniqueness evidence from the whole
    // bounded root list. A collision disables annotations on both roots rather
    // than attaching one file's reader-authored note to another file.
    const annotationRoot = annotationRoots.get(root.ref) ?? "";
    walk(
      decorate(
        {
          key: root.ref,
          ref: root.ref,
          label: root.label,
          kind: "directory",
          depth: 0,
          listedLocation: {
            rootRef: root.ref,
            labels: [],
            ...(annotationRoot ? { annotationRoot } : {}),
          },
          sourceLabel: root.sourceLabel,
          ...(directoryKey ? { directoryKey } : {}),
        },
        cache,
        expanded,
      ),
    );
  }
  return out;
}

function decorate(
  row: TreeRow,
  cache: DirectoryCache,
  expanded: ExpandedDirectories,
): TreeRow {
  if (row.kind !== "directory" || !row.ref) return row;
  const listing = cache.get(row.ref);
  const out: TreeRow = { ...row, expanded: expanded.has(row.ref) };
  if (out.expanded && listing?.status === "loading") out.loading = true;
  if (out.expanded && listing?.status === "refused") out.refusal = listing.message;
  if (out.expanded && listing?.status === "ready" && listing.value?.truncated) out.truncated = true;
  return out;
}

/** `12.3 KB`. Display only; the exact byte count is on the document header. */
export function displaySize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
