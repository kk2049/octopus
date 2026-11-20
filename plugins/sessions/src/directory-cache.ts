import fs from "node:fs/promises";
import { watch, type Dirent, type FSWatcher } from "node:fs";
import path from "node:path";

const DIRECTORY_MAX = 4_096;
const CHANGE_MAX = 20_000;
const RECONCILE_MS = 5 * 60_000;
interface Directory {
  entries: Dirent[];
  version: string;
  checked: number;
  listed: number;
  dirty: boolean;
  watcher?: FSWatcher;
}
const directories = new Map<string, Directory>();
const flights = new Map<string, Promise<Dirent[]>>();
let generation = 0;
const changes = new Set<string>();

/** Notifications accelerate observation; periodic listing and file sweeps prove coverage. */
export async function sessionDirectoryEntries(dir: string): Promise<Dirent[]> {
  let flight = flights.get(dir);
  if (!flight) {
    flight = readDirectory(dir, generation).finally(() => {
      if (flights.get(dir) === flight) flights.delete(dir);
    });
    flights.set(dir, flight);
  }
  try { return await flight; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const previous = directories.get(dir);
    if (previous && code !== "ENOENT" && code !== "ENOTDIR") return previous.entries;
    throw error;
  }
}

async function readDirectory(dir: string, startedGeneration: number): Promise<Dirent[]> {
  let cached = directories.get(dir);
  const now = Date.now();
  if (cached && !cached.dirty && now - cached.checked < 3_000) return cached.entries;
  // Match readdir's existing handling of an explicitly trusted directory root
  // that is a symlink. Discovered symlink entries are still not traversed.
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) return [];
  const version = [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs].join(":");
  if (cached && !cached.dirty && cached.version === version && now - cached.listed < RECONCILE_MS) {
    cached.checked = now;
    return cached.entries;
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  // A reset must not let an older async read install an unowned native handle.
  if (generation !== startedGeneration) return entries;
  if (!cached || cached.version.split(":").slice(0, 2).join(":") !== version.split(":").slice(0, 2).join(":")) {
    cached?.watcher?.close();
    cached = { entries, version, checked: now, listed: now, dirty: false };
    try {
      const entry = cached;
      entry.watcher = watch(dir, { persistent: false }, (event, name) => {
        if (event === "rename" || !name) entry.dirty = true;
        if (name && changes.size < CHANGE_MAX) changes.add(path.join(dir, name.toString()));
        // Overflow is covered by the rotating file sweep, never a timestamp stop.
      });
      entry.watcher.on("error", () => { entry.dirty = true; entry.watcher?.close(); });
    } catch { /* Unsupported watchers retain the stat/list/sweep fallback. */ }
  }
  Object.assign(cached, { entries, version, checked: now, listed: now, dirty: false });
  directories.delete(dir);
  while (directories.size >= DIRECTORY_MAX) {
    const oldest = directories.keys().next().value!;
    directories.get(oldest)?.watcher?.close();
    directories.delete(oldest);
  }
  directories.set(dir, cached);
  return entries;
}

export function changedSessionFiles(allowed: ReadonlySet<string>, limit: number): string[] {
  const selected: string[] = [];
  for (const file of changes) {
    if (!allowed.has(file)) continue;
    changes.delete(file);
    selected.push(file);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function invalidateSessionDirectories(): void {
  for (const directory of directories.values()) directory.dirty = true;
}

/** @internal Also closes native watcher handles in filesystem tests. */
export function resetSessionDirectories(): void {
  generation++;
  flights.clear();
  for (const directory of directories.values()) directory.watcher?.close();
  directories.clear();
  changes.clear();
}
