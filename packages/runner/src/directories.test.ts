/**
 * The device's answer to "may I start work here?".
 *
 * Two halves, and the split is load-bearing. `launchDirectoryProblem` is pure
 * syntax and the BOT runs exactly this function, so a request that would be
 * refused here can never become an approval card. `resolveLaunchDirectory` is
 * everything only a filesystem knows, and it runs on the device, after the
 * approval — which is why a card can be approved for a directory that then turns
 * out not to exist, and why that produces a clear refusal rather than a launch
 * somewhere else.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchDirectoryProblem, resolveLaunchDirectory } from "./directories.js";
import { MACHINE_LIMITS } from "./limits.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "runner-dir-"));
  dirs.push(root);
  return root;
}

describe("what a launch directory may look like", () => {
  it("accepts an absolute path, `~`, and `~/…`", () => {
    for (const value of ["/srv/data", "/", "~", "~/work", "~/a/b/c"]) {
      expect({ value, problem: launchDirectoryProblem(value) }).toEqual({ value, problem: null });
    }
  });

  it("refuses Windows absolutes that the current POSIX resolver would reinterpret as relative", () => {
    expect(launchDirectoryProblem("C:\\work")).toContain("POSIX");
    expect(launchDirectoryProblem("\\\\server\\share")).toContain("POSIX");
  });

  it("refuses an ambiguous relative path, and says what the ambiguity is", () => {
    // "Relative to what?" has two plausible answers — the Runner process's cwd
    // (wherever it happened to be launched) and the user's home — so picking one
    // silently means a person approves `src` and gets a directory they did not
    // mean.
    for (const value of ["src", "./src", "../up", "work/project", ""]) {
      expect(launchDirectoryProblem(value)).toBeTruthy();
    }
    expect(launchDirectoryProblem("src")).toContain("绝对路径");
  });

  it("refuses NUL, newlines, stray whitespace, an over-long path and `~name`", () => {
    expect(launchDirectoryProblem("/srv/a\0b")).toContain("NUL");
    expect(launchDirectoryProblem("/srv/a\nb")).toContain("换行");
    expect(launchDirectoryProblem(" /srv/a")).toContain("空白");
    expect(launchDirectoryProblem("/srv/a ")).toContain("空白");
    expect(launchDirectoryProblem("~other/work")).toContain("~ 或 ~/");
    expect(launchDirectoryProblem(`/${"x".repeat(MACHINE_LIMITS.pathMaxBytes)}`)).toContain("过长");
    expect(launchDirectoryProblem(42)).toBeTruthy();
    expect(launchDirectoryProblem(null)).toBeTruthy();
  });
});

describe("resolving one on the device", () => {
  it("starts in a directory nothing registered, because a directory is not a workspace", async () => {
    const root = home();
    const target = join(root, "brand-new");
    mkdirSync(target);
    const resolved = await resolveLaunchDirectory(root, target);
    expect(resolved.path).toBe(target);
    expect(resolved.requested).toBe(target);
  });

  it("roots `~` and `~/…` at this Runner's scan home", async () => {
    const root = home();
    mkdirSync(join(root, "work"));
    expect((await resolveLaunchDirectory(root, "~")).path).toBe(root);
    expect((await resolveLaunchDirectory(root, "~/work")).path).toBe(join(root, "work"));
  });

  it("follows symlinks to the real directory, and reports that one", async () => {
    const root = home();
    const real = join(root, "real");
    mkdirSync(real);
    symlinkSync(real, join(root, "link"));
    const resolved = await resolveLaunchDirectory(root, join(root, "link"));
    // `realpath` is not a containment check here — there is nothing to contain
    // to — it is so the recorded cwd is the directory that will actually be
    // used, rather than a name that may point elsewhere tomorrow.
    expect(resolved.path).toBe(real);
    expect(resolved.requested).toBe(join(root, "link"));
  });

  it("refuses what does not exist, what is not a directory, and what cannot be entered", async () => {
    const root = home();
    writeFileSync(join(root, "file.txt"), "x", "utf8");
    const locked = join(root, "locked");
    mkdirSync(locked);
    mkdirSync(join(locked, "inner"));
    chmodSync(locked, 0o000);

    await expect(resolveLaunchDirectory(root, join(root, "nope"))).rejects.toThrow(/不存在/);
    await expect(resolveLaunchDirectory(root, join(root, "file.txt"))).rejects.toThrow(/不是一个目录/);
    if (process.getuid?.() !== 0) {
      // Root ignores the mode bits, so this assertion is about an ordinary
      // account — which is the only one a Runner should ever run as.
      await expect(resolveLaunchDirectory(root, join(locked, "inner"))).rejects.toThrow(/权限/);
    }
    chmodSync(locked, 0o700);
  });

  it("refuses a malformed request without touching the filesystem", async () => {
    const root = home();
    await expect(resolveLaunchDirectory(root, "src/app")).rejects.toThrow(/绝对路径/);
    await expect(resolveLaunchDirectory(root, "C:\\work")).rejects.toThrow(/POSIX/);
    await expect(resolveLaunchDirectory(root, "/a\0b")).rejects.toThrow(/NUL/);
  });
});
