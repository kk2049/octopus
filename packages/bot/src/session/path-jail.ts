/**
 * PathJail — the one place that answers "is this path inside that root?".
 *
 * The codebase had three copies of a purely lexical check (path.resolve +
 * path.relative). Lexical checks stop `../` and absolute paths but NOT
 * symlinks: a link inside the jail pointing at another user's home resolved
 * to an in-jail string and was accepted. The sessions plugin already got
 * this right by resolving with realpath on both sides; this module makes
 * that the shared implementation.
 *
 * Rules:
 *  - Reads resolve the target itself; the real path must be inside the real
 *    root.
 *  - Writes resolve the nearest EXISTING ancestor (the file may not exist
 *    yet) and require that to be inside, so you cannot create a file through
 *    a symlinked directory that points outside.
 *  - An existing write target is itself resolved too, so overwriting through
 *    a symlink is caught.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export class PathJailError extends Error {}

function within(realRoot: string, realTarget: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/** Resolve `input` against `root` lexically (no filesystem access yet). */
function joinCandidate(root: string, input: string): string {
  const raw = input.trim();
  if (!raw) throw new PathJailError("path cannot be empty");
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
}

/**
 * Path of an existing file that must live inside the jail.
 * Throws PathJailError when it escapes or does not exist.
 */
export async function resolveForRead(root: string, input: string): Promise<string> {
  const candidate = joinCandidate(root, input);
  const realRoot = await fs.realpath(root);
  let realTarget: string;
  try {
    realTarget = await fs.realpath(candidate);
  } catch {
    throw new PathJailError(`路径不存在: ${input}`);
  }
  if (!within(realRoot, realTarget)) {
    throw new PathJailError(`路径越界(不在 ${root} 内): ${input}`);
  }
  return realTarget;
}

/**
 * Path to write to: the file itself may not exist, but every existing
 * component of its path must stay inside the jail after symlink resolution.
 */
export async function resolveForWrite(root: string, input: string): Promise<string> {
  const candidate = joinCandidate(root, input);
  const realRoot = await fs.realpath(root);

  // If the target already exists, its own real path decides.
  try {
    const realTarget = await fs.realpath(candidate);
    if (!within(realRoot, realTarget)) {
      throw new PathJailError(`路径越界(不在 ${root} 内): ${input}`);
    }
    return realTarget;
  } catch (err) {
    if (err instanceof PathJailError) throw err;
    // Does not exist yet — fall through to the ancestor check.
  }

  // Walk up to the nearest existing ancestor and resolve THAT; this catches
  // "write into a symlinked directory that leaves the jail".
  let dir = path.dirname(candidate);
  const tail: string[] = [path.basename(candidate)];
  for (;;) {
    try {
      const realDir = await fs.realpath(dir);
      if (!within(realRoot, realDir)) {
        throw new PathJailError(`路径越界(不在 ${root} 内): ${input}`);
      }
      return path.join(realDir, ...tail.reverse());
    } catch (err) {
      if (err instanceof PathJailError) throw err;
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new PathJailError(`路径越界(不在 ${root} 内): ${input}`);
      }
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}
