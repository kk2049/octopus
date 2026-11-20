import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_FORMAT } from "./fingerprint.mjs";
import {
  defaultCacheDir,
  entryDir,
  packageCacheDir,
  pruneEntries,
  removeEntry,
  resolveOutputs,
  restoreEntry,
  safeName,
  saveEntry,
} from "./store.mjs";

/** @type {string[]} */
const made = [];

function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A package directory with a built `dist`. */
function builtPackage(files = { "index.js": "export const x = 1;\n" }) {
  const pkgDir = scratch("octo-pkg-");
  mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(pkgDir, "dist", name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return pkgDir;
}

afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});

describe("defaultCacheDir", () => {
  it("prefers the explicit directory, then XDG, then HOME", () => {
    expect(defaultCacheDir({ OCTO_BUILD_CACHE_DIR: "/tmp/explicit" })).toBe("/tmp/explicit");
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/x", HOME: "/h" })).toBe("/x/octopus-build-cache");
    expect(defaultCacheDir({ HOME: "/h" })).toBe("/h/.cache/octopus-build-cache");
  });

  it("returns null when there is nowhere to put a cache", () => {
    expect(defaultCacheDir({})).toBe(null);
  });
});

describe("safeName", () => {
  it("flattens a scoped package name into one directory name", () => {
    expect(safeName("@claude-bot/bot")).toBe("claude-bot__bot");
    expect(safeName("runner")).toBe("runner");
  });
});

describe("resolveOutputs", () => {
  it("refuses outputs that escape the package directory", () => {
    expect(() => resolveOutputs("/pkg", ["../elsewhere"])).toThrow(/包目录内/);
    expect(() => resolveOutputs("/pkg", ["/etc"])).toThrow(/包目录内/);
    expect(() => resolveOutputs("/pkg", ["."])).toThrow(/包目录内/);
    expect(resolveOutputs("/pkg", ["dist", "lib/esm"])).toEqual([
      { rel: "dist", abs: "/pkg/dist" },
      { rel: "lib/esm", abs: "/pkg/lib/esm" },
    ]);
  });
});

describe("save and restore", () => {
  const base = { packageName: "@t/a", key: "k1", outputs: ["dist"], command: "tsup", buildMs: 1234 };

  it("round-trips content, nested paths and the executable bit", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = builtPackage({ "index.js": "one\n", "a/chunk.js": "two\n", "run.sh": "#!/bin/sh\n" });
    chmodSync(path.join(pkgDir, "dist", "run.sh"), 0o755);
    expect(await saveEntry({ cacheDir, pkgDir, ...base })).toBe(true);

    rmSync(path.join(pkgDir, "dist"), { recursive: true, force: true });
    const restored = await restoreEntry({ cacheDir, pkgDir, ...base });
    expect(restored).toMatchObject({ ok: true, files: 3 });
    expect(readFileSync(path.join(pkgDir, "dist", "a", "chunk.js"), "utf8")).toBe("two\n");
    expect(statSync(path.join(pkgDir, "dist", "run.sh")).mode & 0o111).not.toBe(0);
  });

  it("replaces a stale output instead of merging into it", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = builtPackage({ "index.js": "fresh\n" });
    await saveEntry({ cacheDir, pkgDir, ...base });
    writeFileSync(path.join(pkgDir, "dist", "leftover.js"), "stale\n");

    expect(await restoreEntry({ cacheDir, pkgDir, ...base })).toMatchObject({ ok: true });
    expect(existsSync(path.join(pkgDir, "dist", "leftover.js"))).toBe(false);
    expect(readFileSync(path.join(pkgDir, "dist", "index.js"), "utf8")).toBe("fresh\n");
  });

  it("reports a miss for an unknown key", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = builtPackage();
    expect(await restoreEntry({ cacheDir, pkgDir, ...base, key: "nope" })).toEqual({ ok: false, reason: "miss" });
  });

  it("refuses a tampered entry and leaves the working tree untouched", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = builtPackage({ "index.js": "good\n" });
    await saveEntry({ cacheDir, pkgDir, ...base });
    writeFileSync(path.join(entryDir(cacheDir, base.packageName, base.key), "files", "dist", "index.js"), "evil\n");

    expect(await restoreEntry({ cacheDir, pkgDir, ...base })).toEqual({ ok: false, reason: "corrupt" });
    expect(readFileSync(path.join(pkgDir, "dist", "index.js"), "utf8")).toBe("good\n");
  });

  it("refuses an entry recorded for a different output set", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = builtPackage();
    await saveEntry({ cacheDir, pkgDir, ...base });
    expect(await restoreEntry({ cacheDir, pkgDir, ...base, outputs: ["dist", "lib"] })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("does not store when a declared output is missing", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = scratch("octo-pkg-");
    expect(await saveEntry({ cacheDir, pkgDir, ...base })).toBe(false);
    expect(existsSync(entryDir(cacheDir, base.packageName, base.key))).toBe(false);
  });

  it("does not overwrite an entry another build already stored", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = builtPackage();
    expect(await saveEntry({ cacheDir, pkgDir, ...base })).toBe(true);
    expect(await saveEntry({ cacheDir, pkgDir, ...base })).toBe(false);
  });

  it("removes one exact entry without disturbing the package cache", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = builtPackage();
    await saveEntry({ cacheDir, pkgDir, ...base });
    await saveEntry({ cacheDir, pkgDir, ...base, key: "k2" });

    expect(await removeEntry({ cacheDir, packageName: base.packageName, key: base.key })).toBe(true);
    expect(existsSync(entryDir(cacheDir, base.packageName, base.key))).toBe(false);
    expect(existsSync(entryDir(cacheDir, base.packageName, "k2"))).toBe(true);
  });

  it("supports a check-only entry with no artifacts", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = scratch("octo-pkg-");
    const checkOnly = { ...base, outputs: [], command: "tsc --noEmit" };
    expect(await saveEntry({ cacheDir, pkgDir, ...checkOnly })).toBe(true);
    expect(await restoreEntry({ cacheDir, pkgDir, ...checkOnly })).toMatchObject({ ok: true, files: 0 });
  });

  it("writes the manifest under the format namespace", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = builtPackage();
    await saveEntry({ cacheDir, pkgDir, ...base });
    const manifest = JSON.parse(
      readFileSync(path.join(entryDir(cacheDir, base.packageName, base.key), "manifest.json"), "utf8"),
    );
    expect(manifest.format).toBe(CACHE_FORMAT);
    expect(manifest.command).toBe("tsup");
    expect(packageCacheDir(cacheDir, base.packageName)).toContain(CACHE_FORMAT);
  });
});

describe("pruneEntries", () => {
  it("keeps the most recently used entries and drops the rest", async () => {
    const cacheDir = scratch("octo-cache-");
    const pkgDir = builtPackage();
    for (const key of ["k1", "k2", "k3", "k4"]) {
      await saveEntry({ cacheDir, pkgDir, packageName: "@t/a", key, outputs: ["dist"], command: "tsup", buildMs: 1 });
    }
    // Make the intended survivors the freshest, regardless of write order.
    const now = Date.now() / 1000;
    utimesSync(entryDir(cacheDir, "@t/a", "k3"), now, now);
    utimesSync(entryDir(cacheDir, "@t/a", "k4"), now + 1, now + 1);

    expect(await pruneEntries({ cacheDir, packageName: "@t/a", keep: 2 })).toBe(2);
    expect(existsSync(entryDir(cacheDir, "@t/a", "k4"))).toBe(true);
    expect(existsSync(entryDir(cacheDir, "@t/a", "k3"))).toBe(true);
    expect(existsSync(entryDir(cacheDir, "@t/a", "k1"))).toBe(false);
  });

  it("is a no-op for an unknown package", async () => {
    expect(await pruneEntries({ cacheDir: scratch("octo-cache-"), packageName: "@t/none" })).toBe(0);
  });
});
