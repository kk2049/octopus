/**
 * Turning a path someone typed in a chat into a file the workspace can open.
 *
 * ── The trust shape, before the algorithm ───────────────────────────────────
 *
 * This side holds no paths. A file is only ever addressed by an opaque ref the
 * trusted provider minted for a row of ITS OWN listing, so "open `src/foo.ts`"
 * can only mean: start at a registered workspace root and descend one listed
 * directory at a time, matching each path segment against the labels that
 * listing actually carried. Every step is one capability call through the
 * Gate — silently where a read auto-allow exists, and as an approval card
 * where it does not, which is precisely the permission flow a click should
 * take. Nothing here invents a ref, joins a parent to a name, or trusts the
 * link text as a location.
 *
 * ── Candidates, not one join (ticket #61) ───────────────────────────────────
 *
 * The first version answered a single question — "which registered workspace
 * IS this path?" — with `directoryKey` equality, and refused when no key
 * joined. That is the right rule for a JOIN (two rows claiming to be the same
 * directory), and it was the wrong rule for a CLICK: most links a reader
 * follows are inside a workspace whose key never reached this side, and a
 * refusal there reads as "the panel won't open a file it can obviously see".
 *
 * So this module now produces an ORDERED LIST of places the file might be,
 * and the walk tries them until one listing actually contains the path:
 *
 *   1. `key`   — a base whose `directoryKey` equals a files-plane root's. The
 *                precise answer, and still first.
 *   2. `label` — the target path contains a segment equal to a root's label;
 *                descend from that root with what follows it.
 *   3. `root`  — the link was written relative to the session, so try that
 *                relative path under each root as written.
 *
 * A guess costs nothing beyond one listing that says "no such entry", because
 * the descent is STILL by listed labels only: 2 and 3 choose a starting ref
 * the provider minted, never a fabricated one, and every level is checked
 * against what that level actually contains. What a fallback can do wrong is
 * open a file with the same relative path under a different root — so a
 * candidate that was not key-exact reports which workspace answered, instead
 * of pretending it knew.
 *
 * ── One round trip per candidate, when the port can (ticket #243) ───────────
 *
 * The walk used to be one `listDirectory` round trip PER LEVEL from this side,
 * which on a phone network made a deep path a long chain of chances to fail —
 * and a flapping device link made that failure real. A port that offers
 * `resolvePath` moves the SAME descent to the trusted side: one call per
 * candidate, same listings, same Gate, same refusals, and the answer's ref is
 * still minted from a listing row. Ports without it (the harness, a v1 wire)
 * keep the per-level walk below, unchanged.
 */

import type { SessionSummary, WorkspaceGroup, WorkspaceRow } from "@claude-bot/agent-sessions-contract";
import type { WorkspaceFilesDirectory, WorkspaceFilesRoots } from "@claude-bot/workspace-files-contract";

/** Never try more starting points than this for one click. */
const MAX_CANDIDATES = 8;

/**
 * The path a rendered anchor's `href` claims to be (ticket #201).
 *
 * A Markdown renderer percent-encodes a link destination on its way into the
 * DOM, so `~/lht/oh-my-pi-技术报告.md` comes back out of `getAttribute("href")`
 * as `~/lht/oh-my-pi-%E6%8A%80%E6%9C%AF%E6%8A%A5%E5%91%8A.md`. Every step below
 * this line compares a segment against a label a LISTING carried, and a listing
 * carries the real name — so a percent-encoded segment matches nothing and the
 * click dies as "路径不存在", which reads as a broken feature rather than as an
 * encoding.
 *
 * Total by construction: a malformed escape (`%zz`, a lone `%`) is not a
 * decoding failure worth a refusal, it just means this href was never encoded,
 * so the original is the answer.
 */
export function decodeLinkPath(href: string): string {
  if (!href.includes("%")) return href;
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** Recover a path expanded against a View URL, including a previous release. */
export function chatFileLinkPath(href: string, documentUrl: string): string | null {
  const value = href.trim();
  if (/^(?:https?:)?\/\//i.test(value)) {
    try {
      const base = new URL(documentUrl);
      const url = new URL(value, base);
      // Published Views use content-addressed host labels. A saved link may
      // carry yesterday's label after today's release; only the deployment
      // suffix, scheme and port must agree. This classifies a path claim, never
      // a resource or permission: the usual opaque-root resolver still decides.
      const viewDomain = (hostname: string): string | null =>
        /^app-[0-9a-f]{20}\.(.+)$/.exec(hostname)?.[1] ?? null;
      const domain = viewDomain(base.hostname);
      const sameDeployment = domain !== null && domain === viewDomain(url.hostname)
        && url.protocol === base.protocol && url.port === base.port;
      if (!/^https?:$/.test(url.protocol) || (url.origin !== base.origin && !sameDeployment)
        || url.username || url.password) return null;
      return decodeLinkPath(url.pathname);
    } catch {
      return null;
    }
  }
  return isFileishLink(value) ? decodeLinkPath(value) : null;
}

/** A link a chat surface should offer to open, rather than navigate to. */
export function isFileishLink(href: string): boolean {
  const value = href.trim();
  if (!value) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false; // any scheme: not ours
  if (value.startsWith("#") || value.startsWith("?")) return false;
  return true;
}

/**
 * Normalise a display path into segments. Returns null when it cannot be a
 * path this side may hand around: empty, elided (`…`), or climbing above its
 * root. The first segment is the ROOT marker: "~" or "" (for absolute `/…`).
 */
export function pathSegments(path: string): string[] | null {
  const cleaned = path.trim().replace(/\\/g, "/");
  if (!cleaned || cleaned.includes("…")) return null;
  let rootMarker: string;
  let rest: string;
  if (cleaned === "~" || cleaned.startsWith("~/")) {
    rootMarker = "~";
    rest = cleaned.slice(1);
  } else if (cleaned.startsWith("/")) {
    rootMarker = "";
    rest = cleaned;
  } else {
    return null;
  }
  const out: string[] = [rootMarker];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length <= 1) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/**
 * The link's OWN segments, when it was written relative to the session.
 *
 * Rootless on purpose: this is the form a fallback candidate descends from a
 * workspace root, so a leading `~`/`/` (which names a place, not an offset)
 * and any `..` that would climb out of the root are both refused.
 */
export function relativeLinkSegments(link: string): string[] | null {
  const value = link.trim().replace(/\\/g, "/");
  if (!value || !isFileishLink(value)) return null;
  if (value.includes("…")) return null;
  if (value.startsWith("/") || value === "~" || value.startsWith("~/")) return null;
  const out: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length ? out : null;
}

/** Resolve a link against a session's cwd display path. Null: not resolvable. */
export function resolveLinkPath(cwdDisplay: string, link: string): string[] | null {
  const value = link.trim().replace(/\\/g, "/");
  if (!value || !isFileishLink(value)) return null;
  if (value.startsWith("/") || value === "~" || value.startsWith("~/")) return pathSegments(value);
  const base = pathSegments(cwdDisplay);
  if (!base) return null;
  return pathSegments(`${base.join("/") || "/"}/${value}`);
}

/** How a starting point was chosen. Reported when it was not key-exact. */
export type WalkVia = "owner" | "key" | "label" | "root";

export interface WalkCandidate {
  /** The files-plane ref of the workspace root the walk starts from. */
  readonly rootRef: string;
  /** That root's display label, for a notice when a fallback answered. */
  readonly rootLabel: string;
  /** Path segments still to descend, ending at the file itself. */
  readonly segments: readonly string[];
  readonly via: WalkVia;
}

export interface WalkPlan {
  ok: true;
  /** Ordered: the precise join first, then the bounded guesses. */
  candidates: readonly WalkCandidate[];
}

export interface WalkRefusal {
  ok: false;
  message: string;
}

function isPrefix(prefix: readonly string[], target: readonly string[]): boolean {
  if (prefix.length > target.length) return false;
  return prefix.every((part, index) => part === target[index]);
}

/**
 * The part of `target` below a key-exact base.
 *
 * A session cwd is normally disclosed in the compact home coordinate
 * (`~/lht/project`), while an Agent quite reasonably writes the canonical
 * absolute spelling (`/home/ubuntu/lht/project/file.md`) into Markdown. The
 * two strings name the same key-exact directory, but a prefix comparison can
 * never prove that because their root markers differ.
 *
 * The directory key remains the anchor. This helper only reconciles the two
 * display coordinates by finding the ENTIRE disclosed home-relative base in
 * the absolute target; the remainder is still resolved through provider
 * listings. It never falls back to a basename or fabricates a ref.
 */
function remainderBelowBase(
  base: readonly string[],
  target: readonly string[],
): readonly string[] | null {
  if (isPrefix(base, target)) return target.slice(base.length);
  if (base[0] !== "~" || target[0] !== "" || base.length <= 1) return null;

  const disclosed = base.slice(1);
  // Work backwards so a repeated directory name chooses the deepest complete
  // occurrence, while always leaving at least the file endpoint below it.
  for (let start = target.length - disclosed.length - 1; start >= 1; start -= 1) {
    if (!disclosed.every((part, index) => target[start + index] === part)) continue;
    return target.slice(start + disclosed.length);
  }
  return null;
}

interface RootLike {
  ref: string;
  label: string;
  sourceLabel?: string;
  directoryKey?: string;
}

export interface PlanWalkInput {
  /** The link as an absolute display path, when the cwd could anchor it. */
  target: readonly string[] | null;
  /** The link's own relative segments, when it was written relative. */
  relative?: readonly string[] | null;
  session: Pick<SessionSummary, "cwdDisplay" | "directoryKey" | "deviceId" | "directoryDeviceId">;
  workspacesByDevice: Readonly<Record<string, WorkspaceGroup>>;
  roots: WorkspaceFilesRoots | null;
}

/**
 * Every place this link might be, best first.
 *
 * Key-joined bases come first and deepest-first, exactly as before. The
 * fallbacks exist so that a workspace whose key never reached this side is
 * still openable; they are bounded, deterministic and ordered, and each one
 * still starts at a ref the provider minted.
 */
export function planWalk(input: PlanWalkInput): WalkPlan | WalkRefusal {
  const roots: RootLike[] = [...((input.roots?.roots ?? []) as RootLike[])];
  if (!roots.length) {
    return { ok: false, message: "现在没有任何可浏览的工作区根，无法定位这个文件。" };
  }
  const target = input.target ?? null;
  if (target && target.length <= 1) {
    return { ok: false, message: "这个链接指向一个目录；请在左侧目录索引中展开它。" };
  }

  const candidates: WalkCandidate[] = [];
  const directoryDevice = input.session.directoryDeviceId ?? input.session.deviceId;
  const seen = new Set<string>();
  const add = (root: RootLike, segments: readonly string[], via: WalkVia): void => {
    if (!segments.length || candidates.length >= MAX_CANDIDATES) return;
    const key = `${root.ref} ${segments.join("/")}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ rootRef: root.ref, rootLabel: root.label, segments, via });
  };

  // ── 0. the authenticated owner's Runner root ─────────────────────────────
  // `/` is a provider-minted opaque root that exists only when the trusted
  // scope carries the owner-local read operation. It is an exact coordinate,
  // not a workspace label guess, so an absolute link can descend from it with
  // no directoryKey or workspace-registry comparison.
  if (target?.[0] === "") {
    const ownerRoots = roots
      .filter((root) => root.label === "/")
      .sort((left, right) => Number(right.sourceLabel === directoryDevice)
        - Number(left.sourceLabel === directoryDevice));
    for (const root of ownerRoots) {
      if (root.label === "/") add(root, target.slice(1), "owner");
    }
  }

  // ── 1. the key-exact join, deepest containing base first ──────────────────
  if (target) {
    const rootByKey = new Map<string, RootLike>();
    for (const root of roots) {
      if (typeof root.directoryKey === "string" && root.directoryKey) rootByKey.set(root.directoryKey, root);
    }
    const device = directoryDevice ?? "";
    const group = input.workspacesByDevice[device];
    const rows: WorkspaceRow[] = group && Array.isArray(group.workspaces) ? group.workspaces : [];
    const bases: Array<{ segments: string[]; key: string }> = [];
    for (const row of rows) {
      if (!row.directoryKey) continue;
      const segments = pathSegments(String(row.display ?? ""));
      if (segments) bases.push({ segments, key: row.directoryKey });
    }
    if (input.session.directoryKey && input.session.cwdDisplay) {
      const segments = pathSegments(input.session.cwdDisplay);
      if (segments) bases.push({ segments, key: input.session.directoryKey });
    }
    bases
      .map((base) => ({ ...base, remainder: remainderBelowBase(base.segments, target) }))
      .filter((base): base is typeof base & { remainder: readonly string[] } =>
        rootByKey.has(base.key) && base.remainder !== null)
      .sort((a, b) => b.segments.length - a.segments.length)
      .forEach((base) => add(rootByKey.get(base.key)!, base.remainder, "key"));
  }

  // ── 2. a root whose LABEL appears in the path, deepest occurrence first ───
  if (target) {
    for (const root of roots) {
      if (!root.label) continue;
      for (let index = target.length - 2; index >= 1; index -= 1) {
        if (target[index] !== root.label) continue;
        add(root, target.slice(index + 1), "label");
        break;
      }
    }
  }

  // ── 3. the relative link, as written, under each root ────────────────────
  const relative = input.relative ?? null;
  if (relative && relative.length) {
    for (const root of roots) add(root, relative, "root");
  }

  if (!candidates.length) {
    return {
      ok: false,
      message: target
        ? "在已登记的工作区根里找不到这个路径的起点；请在左侧目录索引中打开它所在的工作区后再试。"
        : "无法把这个链接解析为工作区里的路径。",
    };
  }
  return { ok: true, candidates };
}

export interface WalkResolved {
  ok: true;
  ref: string;
  label: string;
  /** Which starting point answered — the caller says so when it was a guess. */
  candidate: WalkCandidate;
}

export type ListDirectory = (
  ref: string,
) => Promise<{ ok: true; value: WorkspaceFilesDirectory } | { ok: false; code: string; message: string }>;

/**
 * The one-round-trip form of the same walk (ticket #243): the trusted provider
 * descends the listings itself and answers with the final entry's ref. Optional
 * because a composition may hold a port without it (a v1 wire, the read-only
 * harness) — those keep the per-level `ListDirectory` descent below.
 */
export type ResolveEntry = (
  rootRef: string,
  labels: readonly string[],
) => Promise<
  | { ok: true; value: { ref: string; label: string; kind: "file" | "directory" } }
  | { ok: false; code: string; message: string }
>;

export interface WalkOps {
  list: ListDirectory;
  resolve?: ResolveEntry | null;
}

type OneWalk = WalkResolved | (WalkRefusal & { missing?: boolean });

/**
 * One candidate, one call. The refusal-code split mirrors `walkOne`'s two
 * outcomes: "no such entry on this starting point" moves on to the next
 * candidate, anything else — an `approval_required` above all — is the answer
 * and stops the whole click, for exactly the reasons `walkToFile` documents.
 */
async function resolveOne(resolve: ResolveEntry, candidate: WalkCandidate): Promise<OneWalk> {
  const answer = await resolve(candidate.rootRef, candidate.segments);
  if (answer.ok) {
    if (answer.value.kind === "directory") {
      return { ok: false, message: "这个链接指向一个目录；请在左侧目录索引中展开它。" };
    }
    return { ok: true, ref: answer.value.ref, label: answer.value.label, candidate };
  }
  if (answer.code === "not_found" || answer.code === "not_a_directory") {
    return { ok: false, missing: true, message: answer.message || "路径不存在或不可见。" };
  }
  if (answer.code === "not_a_file") {
    return { ok: false, message: answer.message || "该路径不是可打开的文本文件。" };
  }
  return { ok: false, message: answer.message || "目录解析被拒绝。" };
}

/**
 * Descend one listed directory at a time. Each level is one capability call
 * (the caller may cache); a refusal at any level is the answer, verbatim.
 */
async function walkOne(list: ListDirectory, candidate: WalkCandidate): Promise<OneWalk> {
  let at = candidate.rootRef;
  for (let index = 0; index < candidate.segments.length; index += 1) {
    const segment = candidate.segments[index];
    const listing = await list(at);
    if (!listing.ok) {
      return { ok: false, message: listing.message || "目录列举被拒绝。" };
    }
    const entry = listing.value.entries.find((row) => row.label === segment);
    if (!entry) {
      return { ok: false, missing: true, message: `路径不存在或不可见：${segment}` };
    }
    const last = index === candidate.segments.length - 1;
    if (!last) {
      if (entry.kind !== "directory" || !entry.ref) {
        return { ok: false, missing: true, message: `${segment} 不是可进入的目录。` };
      }
      at = entry.ref;
      continue;
    }
    if (entry.kind === "file" && entry.ref) return { ok: true, ref: entry.ref, label: entry.label, candidate };
    if (entry.kind === "directory") {
      return { ok: false, message: "这个链接指向一个目录；请在左侧目录索引中展开它。" };
    }
    return { ok: false, message: "该路径不是可打开的文本文件。" };
  }
  return { ok: false, message: "这个链接指向一个目录；请在左侧目录索引中展开它。" };
}

/**
 * Try the candidates in order and answer with the first one that resolves.
 *
 * "This listing has no such entry" moves on to the next starting point — that
 * is what makes a guess cheap. Anything else (a refused listing, a directory
 * endpoint, a file this contract will not open) is the ANSWER and stops the
 * whole walk: retrying past an `approval_required` would turn one click into a
 * stack of approval cards, which is the failure mode the single-flight rules
 * in this package exist to prevent.
 */
export async function walkToFile(ops: WalkOps, plan: WalkPlan): Promise<WalkResolved | WalkRefusal> {
  let first: WalkRefusal | null = null;
  for (const candidate of plan.candidates) {
    const result = ops.resolve
      ? await resolveOne(ops.resolve, candidate)
      : await walkOne(ops.list, candidate);
    if (result.ok) return result;
    if (!result.missing) return { ok: false, message: result.message };
    if (!first) first = { ok: false, message: result.message };
  }
  const tried = plan.candidates.length;
  return {
    ok: false,
    message:
      tried > 1
        ? `${first?.message ?? "路径不存在或不可见。"}（已在 ${tried} 个工作区起点里找过）`
        : (first?.message ?? "路径不存在或不可见。"),
  };
}
