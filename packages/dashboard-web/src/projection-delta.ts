/**
 * Hosted App projection delta: a Dashboard transport contract.
 *
 * A hosted App projection replaces the previous one wholesale, and the
 * coordinator re-emits all of it on every change — for Sessions+ that is the
 * whole roster plus up to eight transcript windows, several MB per frame. A
 * Dashboard host that opts in with `PROJECTION_DELTA_HEADER` receives one full
 * `view` frame and then `view-patch` frames: structural patches against the
 * frame it already holds. The host rebuilds the full projection before
 * anything else sees it, so Apps, the runtime and every revision guard observe
 * exactly the projections they observed before. Hosts that do not opt in
 * (an already-open old tab) keep receiving full frames.
 *
 * Act replies carry the projection too. On a delta stream every full frame
 * names its connection (`stream`); an act request may name the frame its tab
 * holds (`PROJECTION_BASE_HEADER`: `<stream>.<revision>`), and while the server
 * still remembers that frame the reply carries `projection_base` +
 * `projection_patch` instead of `projection`. The host rebuilds `projection`
 * before anything else reads the reply.
 *
 * Both halves import this module so the op vocabulary cannot drift. The server
 * applies every patch to its own base and compares the result with the
 * projection it describes before sending it; the client applies a patch only
 * to the exact base it names and otherwise reopens the stream for a full frame.
 * A patch never mutates its base: rebuilt containers are copies, untouched
 * subtrees are shared, as a wholesale replacement with structural sharing.
 */

/** Stream request header with which a host asks for `view-patch` frames. */
export const PROJECTION_DELTA_HEADER = "x-projection-delta";
/** The only protocol version; any other header value receives full frames. */
export const PROJECTION_DELTA_VERSION = "1";
/** SSE event name of a patch frame; `view` frames stay full projections. */
export const PROJECTION_PATCH_EVENT = "view-patch";
/** Act request header naming the frame the tab holds: `<stream>.<revision>`. */
export const PROJECTION_BASE_HEADER = "x-projection-base";
/** A delta stream's connection id: 16 lowercase hex characters. */
export const PROJECTION_STREAM_PATTERN = /^[0-9a-f]{16}$/;

/** Parse a `PROJECTION_BASE_HEADER` value; null when it is not one. */
export function readProjectionBaseId(value: unknown): { stream: string; revision: number } | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const match = /^([0-9a-f]{16})\.(0|[1-9]\d{0,15})$/.exec(value);
  if (!match) return null;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision) ? { stream: match[1], revision } : null;
}

export type ProjectionPathKey = string | number;
export type ProjectionPath = readonly ProjectionPathKey[];

/**
 * - `["=", path, value]` replaces the value at `path` (an existing array index,
 *   or an object key that is added when missing);
 * - `["-", path]` removes an object key;
 * - `["~", path, start, end, items]` replaces elements `[start, end)` of the
 *   array at `path` with `items`;
 * - `["k", path, keys]` reorders the object at `path` to exactly `keys`.
 *
 * Array positions are numbers and object keys are strings, always. Ops apply
 * in order, each to the result of the previous one.
 */
export type ProjectionPatchOp =
  | readonly ["=", ProjectionPath, unknown]
  | readonly ["-", ProjectionPath]
  | readonly ["~", ProjectionPath, number, number, readonly unknown[]]
  | readonly ["k", ProjectionPath, readonly string[]];

/** A `view-patch` frame: `patch` turns the frame of revision `base` into `revision`. */
export interface ProjectionPatchFrame {
  revision: number;
  base: number;
  patch: ProjectionPatchOp[];
}

const MAX_PATH = 256;
/** Below this depth a changed value is diffed structurally; deeper, it is replaced. */
const MAX_DIFF_DEPTH = 48;
/** Leading insertions/removals looked for before an array range is diffed in place. */
const SHIFT_SEARCH = 4;
const SHIFT_STEPS = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** JSON omits an `undefined` member, so a patch must treat it as absent. */
function present(value: Record<string, unknown>, key: string): boolean {
  return hasOwn(value, key) && value[key] !== undefined;
}

function presentKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/**
 * Whether two values serialize to the same JSON text, key order included.
 * Subtrees shared by reference short-circuit, so comparing two projections the
 * coordinator derived from one another costs a walk of what was rebuilt rather
 * than a serialization. Anything outside plain JSON answers "different", which
 * can only cost a redundant frame or op, never a missed change.
 */
export function sameProjectionJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!sameProjectionJson(a[index] ?? null, b[index] ?? null)) return false;
    }
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = presentKeys(a);
  const others = presentKeys(b);
  if (keys.length !== others.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== others[index] || !sameProjectionJson(a[key], b[key])) return false;
  }
  return true;
}

/** An array-index-like key, which every engine enumerates first and in numeric order. */
function indexKey(key: string): boolean {
  return /^(?:0|[1-9]\d{0,9})$/.test(key) && Number(key) < 4_294_967_295;
}

/** The order in which an engine enumerates keys defined in `inserted` order. */
function enumerationOrder(inserted: readonly string[]): string[] {
  const indices = inserted.filter(indexKey).sort((left, right) => Number(left) - Number(right));
  return indices.length ? [...indices, ...inserted.filter((key) => !indexKey(key))] : [...inserted];
}

/** Structural ops that turn `previous` into a value with `next`'s exact JSON text. */
export function diffProjection(previous: unknown, next: unknown): ProjectionPatchOp[] {
  const ops: ProjectionPatchOp[] = [];
  diffValue(previous, next, [], ops, 0);
  return ops;
}

function diffValue(a: unknown, b: unknown, path: ProjectionPathKey[], ops: ProjectionPatchOp[], depth: number): void {
  if (a === b) return;
  if (depth < MAX_DIFF_DEPTH) {
    if (isPlainObject(a) && isPlainObject(b)) {
      diffObject(a, b, path, ops, depth);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      diffArray(a, b, path, ops, depth);
      return;
    }
  }
  if (sameProjectionJson(a, b)) return;
  ops.push(["=", path.slice(), b === undefined ? null : b]);
}

function diffObject(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  path: ProjectionPathKey[],
  ops: ProjectionPatchOp[],
  depth: number,
): void {
  const before = presentKeys(a);
  const after = presentKeys(b);
  const kept: string[] = [];
  for (const key of before) {
    if (present(b, key)) kept.push(key);
    else ops.push(["-", [...path, key]]);
  }
  const added: string[] = [];
  for (const key of after) {
    if (present(a, key)) {
      path.push(key);
      diffValue(a[key], b[key], path, ops, depth + 1);
      path.pop();
    } else {
      added.push(key);
      ops.push(["=", [...path, key], b[key]]);
    }
  }
  const order = enumerationOrder([...kept, ...added]);
  if (order.some((key, index) => key !== after[index])) ops.push(["k", path.slice(), after]);
}

function diffArray(a: readonly unknown[], b: readonly unknown[], path: ProjectionPathKey[], ops: ProjectionPatchOp[], depth: number): void {
  let start = 0;
  const shorter = Math.min(a.length, b.length);
  while (start < shorter && sameProjectionJson(a[start] ?? null, b[start] ?? null)) start += 1;
  if (start === a.length && start === b.length) return;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && sameProjectionJson(a[endA - 1] ?? null, b[endB - 1] ?? null)) {
    endA -= 1;
    endB -= 1;
  }
  // `at` is where a[fromA] sits in the array being patched: ops are written in
  // the coordinates the receiver sees after every earlier op.
  let fromA = start;
  let fromB = start;
  let at = start;
  for (let step = 0; step < SHIFT_STEPS; step += 1) {
    while (fromA < endA && fromB < endB && sameProjectionJson(a[fromA] ?? null, b[fromB] ?? null)) {
      fromA += 1;
      fromB += 1;
      at += 1;
    }
    const removed = endA - fromA;
    const inserted = endB - fromB;
    if (removed === 0 || inserted === 0) break;
    // A few elements inserted or removed ahead of an otherwise aligned range
    // (a prepended row that pushed the oldest off a capped list, a new
    // session at the top) would otherwise turn every later position into a
    // replacement.
    let shifted = false;
    for (let count = 1; count <= SHIFT_SEARCH && count < inserted && !shifted; count += 1) {
      if (sameProjectionJson(a[fromA] ?? null, b[fromB + count] ?? null)) {
        ops.push(["~", path.slice(), at, at, b.slice(fromB, fromB + count)]);
        fromB += count;
        at += count;
        shifted = true;
      }
    }
    for (let count = 1; count <= SHIFT_SEARCH && count < removed && !shifted; count += 1) {
      if (sameProjectionJson(a[fromA + count] ?? null, b[fromB] ?? null)) {
        ops.push(["~", path.slice(), at, at + count, []]);
        fromA += count;
        shifted = true;
      }
    }
    if (!shifted) break;
  }
  const removed = endA - fromA;
  const inserted = endB - fromB;
  const aligned = Math.min(removed, inserted);
  for (let offset = 0; offset < aligned; offset += 1) {
    path.push(at + offset);
    diffElement(a[fromA + offset] ?? null, b[fromB + offset] ?? null, path, ops, depth + 1);
    path.pop();
  }
  if (removed > inserted) {
    ops.push(["~", path.slice(), at + aligned, at + removed, []]);
  } else if (inserted > removed) {
    ops.push(["~", path.slice(), at + aligned, at + aligned, b.slice(fromB + aligned, endB)]);
  }
}

/**
 * One array position diffed in place. When most of an object's members
 * changed, the position holds a different entity (a reordered roster row), and
 * replacing it whole is both smaller and clearer than a member-by-member edit.
 */
function diffElement(a: unknown, b: unknown, path: ProjectionPathKey[], ops: ProjectionPatchOp[], depth: number): void {
  if (!isPlainObject(a) || !isPlainObject(b)) {
    diffValue(a, b, path, ops, depth);
    return;
  }
  const nested: ProjectionPatchOp[] = [];
  diffObject(a, b, path, nested, depth);
  const keys = presentKeys(b).length;
  let changed = 0;
  for (const op of nested) {
    if (op[1].length === path.length + 1) changed += 1;
  }
  if (keys >= 4 && changed * 2 > keys) ops.push(["=", path.slice(), b]);
  else for (const op of nested) ops.push(op);
}

export type ProjectionPatchResult = { ok: true; value: unknown } | { ok: false; reason: string };

class PatchRefused extends Error {}

/**
 * Apply a patch to `base` without mutating it. Every op must address exactly
 * what exists: a missing key, an out-of-range index, a container of the wrong
 * kind or an inexact key list refuses the whole patch, and the caller falls
 * back to a full frame rather than display a guess.
 */
export function applyProjectionPatch(base: unknown, patch: unknown): ProjectionPatchResult {
  if (!Array.isArray(patch)) return { ok: false, reason: "patch is not a list" };
  // Containers created by this application; only these may be written.
  const fresh = new WeakSet<object>();
  const writable = (value: unknown): unknown[] | Record<string, unknown> => {
    if (Array.isArray(value)) {
      if (fresh.has(value)) return value;
      const copy = value.slice();
      fresh.add(copy);
      return copy;
    }
    if (isPlainObject(value)) {
      if (fresh.has(value)) return value;
      // Spread defines own data properties (an own `__proto__` key stays a key).
      const copy = { ...value };
      fresh.add(copy);
      return copy;
    }
    throw new PatchRefused("path crosses a non-container");
  };
  const read = (container: unknown[] | Record<string, unknown>, key: ProjectionPathKey): unknown => {
    if (Array.isArray(container)) {
      if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || key >= container.length) {
        throw new PatchRefused("array position out of range");
      }
      return container[key];
    }
    if (typeof key !== "string" || !hasOwn(container, key)) throw new PatchRefused("object key missing");
    return container[key];
  };
  const write = (container: unknown[] | Record<string, unknown>, key: ProjectionPathKey, value: unknown): void => {
    if (Array.isArray(container)) {
      read(container, key);
      container[key as number] = value;
      return;
    }
    if (typeof key !== "string") throw new PatchRefused("object key is not a string");
    Object.defineProperty(container, key, { value, writable: true, enumerable: true, configurable: true });
  };
  /**
   * Make the root and the first `steps` containers along `path` writable and
   * return the container reached, together with the (possibly copied) root.
   */
  const walk = (root: unknown, path: ProjectionPath, steps: number): { root: unknown; target: unknown[] | Record<string, unknown> } => {
    const top = writable(root);
    let container = top;
    for (let index = 0; index < steps; index += 1) {
      const child = writable(read(container, path[index]));
      write(container, path[index], child);
      container = child;
    }
    return { root: top, target: container };
  };
  /** Swap the container at `path` for `next`, built from `current` by the caller. */
  const replace = (
    root: unknown,
    path: ProjectionPath,
    build: (current: unknown) => unknown[] | Record<string, unknown>,
  ): unknown => {
    if (path.length === 0) {
      const next = build(root);
      fresh.add(next);
      return next;
    }
    const parent = walk(root, path, path.length - 1);
    const key = path[path.length - 1];
    const next = build(read(parent.target, key));
    fresh.add(next);
    write(parent.target, key, next);
    return parent.root;
  };

  let root = base;
  try {
    for (const op of patch as unknown[]) {
      if (!Array.isArray(op) || !Array.isArray(op[1]) || op[1].length > MAX_PATH) throw new PatchRefused("malformed op");
      const path = op[1] as ProjectionPath;
      if (op[0] === "=" && op.length === 3) {
        if (path.length === 0) {
          root = op[2];
          continue;
        }
        const parent = walk(root, path, path.length - 1);
        write(parent.target, path[path.length - 1], op[2]);
        root = parent.root;
      } else if (op[0] === "-" && op.length === 2 && path.length > 0) {
        const parent = walk(root, path, path.length - 1);
        const key = path[path.length - 1];
        if (Array.isArray(parent.target) || typeof key !== "string" || !hasOwn(parent.target, key)) {
          throw new PatchRefused("delete addresses no object key");
        }
        delete parent.target[key];
        root = parent.root;
      } else if (op[0] === "~" && op.length === 5) {
        const [, , start, end, items] = op as unknown[];
        root = replace(root, path, (current) => {
          if (!Array.isArray(current) || !Array.isArray(items)
            || typeof start !== "number" || typeof end !== "number"
            || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
            || start < 0 || start > end || end > current.length) {
            throw new PatchRefused("splice addresses no array range");
          }
          return [...current.slice(0, start), ...items, ...current.slice(end)];
        });
      } else if (op[0] === "k" && op.length === 3) {
        const keys = op[2] as unknown;
        root = replace(root, path, (current) => {
          if (!isPlainObject(current) || !Array.isArray(keys)) throw new PatchRefused("reorder addresses no object");
          const existing = Object.keys(current);
          if (keys.length !== existing.length || new Set(keys).size !== keys.length
            || !keys.every((key) => typeof key === "string" && hasOwn(current, key))) {
            throw new PatchRefused("reorder is not a permutation");
          }
          const reordered: Record<string, unknown> = {};
          for (const key of keys as string[]) {
            Object.defineProperty(reordered, key, { value: current[key], writable: true, enumerable: true, configurable: true });
          }
          return reordered;
        });
      } else {
        throw new PatchRefused("unknown op");
      }
    }
  } catch (error) {
    if (error instanceof PatchRefused) return { ok: false, reason: error.message };
    throw error;
  }
  return { ok: true, value: root };
}

/** Parse a `view-patch` frame body; null when it is not one. */
export function readProjectionPatchFrame(value: unknown): ProjectionPatchFrame | null {
  if (!isPlainObject(value)) return null;
  const { revision, base, patch } = value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return null;
  if (typeof base !== "number" || !Number.isSafeInteger(base) || base < 0) return null;
  if (!Array.isArray(patch)) return null;
  return { revision, base, patch: patch as ProjectionPatchOp[] };
}
