import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_FORMAT } from "./fingerprint.mjs";
import { cacheMode, parseArgs, planFor, runCachedBuild } from "./run.mjs";

/** @type {string[]} */
const made = [];

/**
 * A miniature workspace: `@t/b` depends on `@t/a`, both "build" by writing a
 * file into `dist`. The fake builder stands in for tsup/vite — what matters is
 * that it is observably called, or observably not.
 */
function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "octo-run-"));
  const cacheDir = mkdtempSync(path.join(tmpdir(), "octo-cache-"));
  made.push(root, cacheDir);
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "root" }));
  writeFileSync(path.join(root, "tsconfig.json"), "{}");
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const mk = (name, extra = {}) => {
    const dir = path.join(root, "packages", name);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@t/${name}`, scripts: { build: "fake" }, ...extra }));
    writeFileSync(path.join(dir, "src", "index.ts"), `export const ${name} = 1;\n`);
    return dir;
  };
  const a = mk("a");
  const b = mk("b", { dependencies: { "@t/a": "workspace:*" } });
  return { root, a, b, env: { OCTO_BUILD_CACHE_DIR: cacheDir }, cacheDir };
}

/** A builder that records its calls and emits a deterministic `dist`. */
function builder(output = "built\n") {
  const calls = [];
  return {
    calls,
    fn: async (command, cwd) => {
      calls.push({ command, cwd });
      mkdirSync(path.join(cwd, "dist"), { recursive: true });
      writeFileSync(path.join(cwd, "dist", "index.js"), output);
      return 0;
    },
  };
}

afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});

describe("cacheMode", () => {
  it("reads the escape hatches", () => {
    expect(cacheMode({})).toBe("on");
    expect(cacheMode({ OCTO_BUILD_CACHE: "1" })).toBe("on");
    expect(cacheMode({ OCTO_BUILD_CACHE: "0" })).toBe("off");
    expect(cacheMode({ OCTO_BUILD_CACHE: "OFF" })).toBe("off");
    expect(cacheMode({ OCTO_BUILD_CACHE: "refresh" })).toBe("refresh");
  });
});

describe("planFor", () => {
  it("keys a package inside the workspace", () => {
    const ws = workspace();
    const plan = planFor({ cwd: ws.b, command: "fake", outputs: ["dist"], env: ws.env });
    expect(plan.packageName).toBe("@t/b");
    expect(plan.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("declines outside a workspace, without a cache dir, or for an unlisted package", () => {
    const ws = workspace();
    expect(planFor({ cwd: tmpdir(), command: "fake", outputs: ["dist"], env: ws.env })).toBe(null);
    expect(planFor({ cwd: ws.b, command: "fake", outputs: ["dist"], env: {} })).toBe(null);
    const stray = path.join(ws.root, "tools", "thing");
    mkdirSync(stray, { recursive: true });
    writeFileSync(path.join(stray, "package.json"), JSON.stringify({ name: "@t/stray" }));
    expect(planFor({ cwd: stray, command: "fake", outputs: ["dist"], env: ws.env })).toBe(null);
  });
});

describe("runCachedBuild", () => {
  const opts = (ws, dir, build, extra = {}) => ({
    cwd: dir,
    command: "fake",
    outputs: ["dist"],
    env: ws.env,
    spawn: build.fn,
    log: () => {},
    ...extra,
  });

  it("builds on a miss and reuses the stored output on the next run", async () => {
    const ws = workspace();
    const build = builder();
    const first = await runCachedBuild(opts(ws, ws.b, build));
    expect(first).toMatchObject({ status: "built", exitCode: 0, stored: true });
    expect(build.calls).toHaveLength(1);

    rmSync(path.join(ws.b, "dist"), { recursive: true, force: true });
    const second = await runCachedBuild(opts(ws, ws.b, build));
    expect(second).toMatchObject({ status: "hit", exitCode: 0 });
    expect(build.calls).toHaveLength(1);
    expect(readFileSync(path.join(ws.b, "dist", "index.js"), "utf8")).toBe("built\n");
  });

  it("rebuilds after the package's own source changes", async () => {
    const ws = workspace();
    const build = builder();
    await runCachedBuild(opts(ws, ws.b, build));
    writeFileSync(path.join(ws.b, "src", "index.ts"), "export const b = 2;\n");
    expect(await runCachedBuild(opts(ws, ws.b, build))).toMatchObject({ status: "built" });
    expect(build.calls).toHaveLength(2);
  });

  it("rebuilds a dependent after its workspace dependency changes", async () => {
    const ws = workspace();
    const build = builder();
    await runCachedBuild(opts(ws, ws.b, build));
    writeFileSync(path.join(ws.a, "src", "index.ts"), "export const a = 2;\n");
    expect(await runCachedBuild(opts(ws, ws.b, build))).toMatchObject({ status: "built" });
    expect(build.calls).toHaveLength(2);
  });

  it("does not store a failed build", async () => {
    const ws = workspace();
    const failing = { calls: [], fn: async (command, cwd) => (failing.calls.push(cwd), 2) };
    const result = await runCachedBuild(opts(ws, ws.b, failing));
    expect(result).toMatchObject({ status: "failed", exitCode: 2, stored: false });

    const ok = builder();
    expect(await runCachedBuild(opts(ws, ws.b, ok))).toMatchObject({ status: "built" });
    expect(ok.calls).toHaveLength(1);
  });

  it("always builds when the cache is switched off", async () => {
    const ws = workspace();
    const build = builder();
    const off = { ...ws.env, OCTO_BUILD_CACHE: "0" };
    await runCachedBuild(opts(ws, ws.b, build, { env: off }));
    await runCachedBuild(opts(ws, ws.b, build, { env: off }));
    expect(build.calls).toHaveLength(2);
  });

  it("refresh replaces an existing entry with the newly built bytes", async () => {
    const ws = workspace();
    const oldBuild = builder("old\n");
    const newBuild = builder("new\n");
    await runCachedBuild(opts(ws, ws.b, oldBuild));
    expect(await runCachedBuild(opts(ws, ws.b, newBuild, { env: { ...ws.env, OCTO_BUILD_CACHE: "refresh" } })))
      .toMatchObject({ status: "built", stored: true });
    expect(oldBuild.calls).toHaveLength(1);
    expect(newBuild.calls).toHaveLength(1);

    rmSync(path.join(ws.b, "dist"), { recursive: true, force: true });
    expect(await runCachedBuild(opts(ws, ws.b, oldBuild))).toMatchObject({ status: "hit" });
    expect(oldBuild.calls).toHaveLength(1);
    expect(readFileSync(path.join(ws.b, "dist", "index.js"), "utf8")).toBe("new\n");
  });

  it("builds normally when the tree cannot be keyed at all", async () => {
    const ws = workspace();
    const build = builder();
    const outside = mkdtempSync(path.join(tmpdir(), "octo-outside-"));
    made.push(outside);
    writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "@t/outside" }));
    const result = await runCachedBuild(opts(ws, outside, build));
    expect(result).toMatchObject({ status: "built", key: null, stored: false });
    expect(build.calls).toHaveLength(1);
  });

  it("caches a check-only verification with no artifacts", async () => {
    const ws = workspace();
    const check = { calls: [], fn: async (command, cwd) => (check.calls.push(cwd), 0) };
    const checkOpts = opts(ws, ws.a, check, { outputs: [], command: "tsc --noEmit" });
    expect(await runCachedBuild(checkOpts)).toMatchObject({ status: "built", stored: true });
    expect(await runCachedBuild(checkOpts)).toMatchObject({ status: "hit" });
    expect(check.calls).toHaveLength(1);
  });

  it("keeps a bounded number of entries per package", async () => {
    const ws = workspace();
    const build = builder();
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(path.join(ws.b, "src", "index.ts"), `export const b = ${i};\n`);
      await runCachedBuild(opts(ws, ws.b, build, { keep: 2 }));
    }
    const dir = path.join(ws.cacheDir, CACHE_FORMAT, "t__b");
    expect(readdirSync(dir).filter((name) => !name.startsWith(".tmp-"))).toHaveLength(2);
  });
});

describe("parseArgs", () => {
  it("passes the command through untouched", () => {
    expect(parseArgs(["--", "tsup", "src/index.ts", "--format", "esm"])).toEqual({
      outputs: ["dist"],
      command: "tsup src/index.ts --format esm",
    });
  });

  it("keeps a shell chain as one command", () => {
    expect(parseArgs(["--", "tsup src/index.ts && node scripts/prepare-package.mjs"]).command).toBe(
      "tsup src/index.ts && node scripts/prepare-package.mjs",
    );
  });

  it("accepts explicit outputs and check-only builds", () => {
    expect(parseArgs(["--out", "lib", "--out=dist", "--", "x"]).outputs).toEqual(["lib", "dist"]);
    expect(parseArgs(["--check-only", "--", "tsc --noEmit"]).outputs).toEqual([]);
  });

  it("refuses misuse instead of guessing", () => {
    expect(() => parseArgs(["--out"])).toThrow(/--out/);
    expect(() => parseArgs(["--"])).toThrow(/构建命令/);
    expect(() => parseArgs(["--nope", "--", "x"])).toThrow(/未知参数/);
    expect(() => parseArgs(["--check-only", "--out", "dist", "--", "x"])).toThrow(/互斥/);
  });
});
