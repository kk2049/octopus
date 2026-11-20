import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const watchers = vi.hoisted(() => ({ created: [] as Array<{ close: ReturnType<typeof vi.fn> }> }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(),
  watch: () => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    watchers.created.push(watcher); return watcher;
  },
}));
import { sessionDirectoryEntries, resetSessionDirectories } from "./directory-cache.js";

const roots: string[] = [];
afterEach(async () => {
  resetSessionDirectories(); vi.restoreAllMocks(); watchers.created.length = 0;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("owns exactly one watcher after concurrent cold reads and closes it on reset", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "directory-owner-")); roots.push(dir);
  await Promise.all(Array.from({ length: 16 }, () => sessionDirectoryEntries(dir)));
  expect(watchers.created).toHaveLength(1);
  resetSessionDirectories();
  expect(watchers.created[0].close).toHaveBeenCalledOnce();
});

it("does not install a late watcher when reset races a directory read", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "directory-reset-")); roots.push(dir);
  let unblock!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const original = fs.readdir.bind(fs);
  vi.spyOn(fs, "readdir").mockImplementationOnce(async (...args: Parameters<typeof fs.readdir>) => {
    reached(); await new Promise<void>((resolve) => { unblock = resolve; });
    return original(...args);
  });
  const read = sessionDirectoryEntries(dir); await entered;
  resetSessionDirectories(); unblock(); await read;
  expect(watchers.created).toHaveLength(0);
  await sessionDirectoryEntries(dir);
  expect(watchers.created).toHaveLength(1);
});

it("balances watcher ownership through concurrent traversals beyond the cache capacity", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "directory-capacity-")); roots.push(dir);
  const stat = await fs.stat(dir);
  vi.spyOn(fs, "stat").mockResolvedValue(stat);
  vi.spyOn(fs, "readdir").mockResolvedValue([]);
  for (let round = 0; round < 2; round++) {
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let n = 0; n < 4_200; n++) await sessionDirectoryEntries(path.join(dir, String(n)));
    }));
    expect(watchers.created.filter((watcher) => !watcher.close.mock.calls.length)).toHaveLength(4_096);
  }
  resetSessionDirectories();
  for (const watcher of watchers.created) expect(watcher.close).toHaveBeenCalledOnce();
});
