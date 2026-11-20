import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveForRead, resolveForWrite, PathJailError } from "./path-jail.js";

let base: string;
let jail: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "jail-"));
  jail = join(base, "jail");
  outside = join(base, "outside");
  mkdirSync(jail, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(jail, "ok.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "SECRET");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("resolveForRead", () => {
  it("accepts a file inside the jail", async () => {
    await expect(resolveForRead(jail, "ok.txt")).resolves.toContain("ok.txt");
  });

  it("rejects ../ traversal", async () => {
    await expect(resolveForRead(jail, "../outside/secret.txt")).rejects.toBeInstanceOf(PathJailError);
  });

  it("rejects an absolute path outside", async () => {
    await expect(resolveForRead(jail, join(outside, "secret.txt"))).rejects.toBeInstanceOf(PathJailError);
  });

  it("rejects a SYMLINK pointing outside (the hole a lexical check misses)", async () => {
    symlinkSync(join(outside, "secret.txt"), join(jail, "link.txt"));
    // Lexically this is "<jail>/link.txt" — clearly inside. Only realpath
    // resolution catches that it lands on someone else's file.
    await expect(resolveForRead(jail, "link.txt")).rejects.toBeInstanceOf(PathJailError);
  });

  it("rejects a path THROUGH a symlinked directory", async () => {
    symlinkSync(outside, join(jail, "escape"));
    await expect(resolveForRead(jail, "escape/secret.txt")).rejects.toBeInstanceOf(PathJailError);
  });
});

describe("resolveForWrite", () => {
  it("allows a new file inside the jail", async () => {
    await expect(resolveForWrite(jail, "new.txt")).resolves.toContain("new.txt");
  });

  it("allows a new file in a not-yet-created subdirectory inside the jail", async () => {
    await expect(resolveForWrite(jail, "a/b/c.txt")).resolves.toContain("c.txt");
  });

  it("rejects overwriting through a symlink that points outside", async () => {
    symlinkSync(join(outside, "secret.txt"), join(jail, "link.txt"));
    await expect(resolveForWrite(jail, "link.txt")).rejects.toBeInstanceOf(PathJailError);
  });

  it("rejects creating a file through a symlinked directory (nearest-ancestor check)", async () => {
    symlinkSync(outside, join(jail, "escape"));
    await expect(resolveForWrite(jail, "escape/planted.txt")).rejects.toBeInstanceOf(PathJailError);
  });

  it("rejects ../ traversal for writes", async () => {
    await expect(resolveForWrite(jail, "../outside/planted.txt")).rejects.toBeInstanceOf(PathJailError);
  });

  it("rejects an empty path", async () => {
    await expect(resolveForWrite(jail, "   ")).rejects.toBeInstanceOf(PathJailError);
  });
});
