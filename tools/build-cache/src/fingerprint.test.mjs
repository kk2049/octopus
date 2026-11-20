import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_GROUPS,
  buildKey,
  findRepoRoot,
  globalInputHash,
  hashDirectory,
  loadWorkspace,
  packageFingerprint,
} from "./fingerprint.mjs";

/** @type {string[]} */
const made = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "octo-fp-"));
  made.push(root);
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "root" }));
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const pkg = (name, extra = {}) => {
    const dir = path.join(root, "packages", name);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: `@t/${name}`, scripts: { build: "tsup" }, ...extra }),
    );
    writeFileSync(path.join(dir, "src", "index.ts"), `export const ${name} = 1;\n`);
    return dir;
  };
  const a = pkg("a");
  const b = pkg("b", { dependencies: { "@t/a": "workspace:*", lodash: "^4" } });
  return { root, a, b };
}

afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});

/** @param {string} root */
function fingerprints(root) {
  const ws = loadWorkspace(root);
  const globalHash = globalInputHash(root, { nodeVersion: "v22.0.0" });
  return {
    a: packageFingerprint(ws, "@t/a", { globalHash }),
    b: packageFingerprint(ws, "@t/b", { globalHash }),
  };
}

describe("workspace graph", () => {
  it("finds packages and keeps only workspace dependencies", () => {
    const { root } = fixture();
    const ws = loadWorkspace(root);
    expect([...ws.keys()].sort()).toEqual(["@t/a", "@t/b"]);
    expect(ws.get("@t/b").deps).toEqual(["@t/a"]);
    expect(ws.get("@t/b").build).toBe("tsup");
  });

  it("matches the real pnpm-workspace.yaml groups", () => {
    const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
    const declared = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith("- "))
      .map((line) => line.trim().replace(/^- +"?/, "").replace(/\/\*"?$/, ""));
    expect(declared.sort()).toEqual([...WORKSPACE_GROUPS].sort());
  });

  it("locates the repository root from a nested directory", () => {
    const { root, b } = fixture();
    expect(findRepoRoot(path.join(b, "src"))).toBe(root);
    expect(findRepoRoot(tmpdir())).toBe(null);
  });
});

describe("packageFingerprint", () => {
  it("is stable for unchanged content", () => {
    const { root } = fixture();
    expect(fingerprints(root)).toEqual(fingerprints(root));
  });

  it("changes when the package's own source changes", () => {
    const { root, b } = fixture();
    const before = fingerprints(root);
    writeFileSync(path.join(b, "src", "index.ts"), "export const b = 2;\n");
    const after = fingerprints(root);
    expect(after.b).not.toBe(before.b);
    expect(after.a).toBe(before.a);
  });

  it("invalidates a dependent when its workspace dependency changes", () => {
    const { root, a } = fixture();
    const before = fingerprints(root);
    writeFileSync(path.join(a, "src", "index.ts"), "export const a = 99;\n");
    const after = fingerprints(root);
    expect(after.a).not.toBe(before.a);
    expect(after.b).not.toBe(before.b);
  });

  it("invalidates a dependent when its dependency's build command changes", () => {
    const { root, a } = fixture();
    const before = fingerprints(root);
    writeFileSync(path.join(a, "package.json"), JSON.stringify({ name: "@t/a", scripts: { build: "tsup --dts" } }));
    expect(fingerprints(root).b).not.toBe(before.b);
  });

  it("invalidates everything when the lockfile or root tsconfig changes", () => {
    const { root } = fixture();
    const before = fingerprints(root);
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# bumped\n");
    const afterLock = fingerprints(root);
    expect(afterLock.a).not.toBe(before.a);
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2023" } }));
    expect(fingerprints(root).a).not.toBe(afterLock.a);
  });

  it("follows the Node version", () => {
    const { root } = fixture();
    const ws = loadWorkspace(root);
    const one = packageFingerprint(ws, "@t/a", { globalHash: globalInputHash(root, { nodeVersion: "v22.0.0" }) });
    const two = packageFingerprint(ws, "@t/a", { globalHash: globalInputHash(root, { nodeVersion: "v24.0.0" }) });
    expect(one).not.toBe(two);
  });

  it("ignores build output and tool caches", () => {
    const { root, b } = fixture();
    const before = fingerprints(root);
    mkdirSync(path.join(b, "dist"), { recursive: true });
    writeFileSync(path.join(b, "dist", "index.js"), "whatever\n");
    writeFileSync(path.join(b, "tsconfig.tsbuildinfo"), "{}\n");
    mkdirSync(path.join(b, "node_modules"), { recursive: true });
    writeFileSync(path.join(b, "node_modules", "junk.js"), "x\n");
    expect(fingerprints(root)).toEqual(before);
  });

  it("terminates on a dependency cycle", () => {
    const { root, a } = fixture();
    writeFileSync(
      path.join(a, "package.json"),
      JSON.stringify({ name: "@t/a", scripts: { build: "tsup" }, devDependencies: { "@t/b": "workspace:*" } }),
    );
    const ws = loadWorkspace(root);
    const globalHash = globalInputHash(root, { nodeVersion: "v22.0.0" });
    expect(packageFingerprint(ws, "@t/a", { globalHash })).toMatch(/^[0-9a-f]{64}$/);
    expect(packageFingerprint(ws, "@t/b", { globalHash })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports an unknown package as external instead of throwing", () => {
    const { root } = fixture();
    const ws = loadWorkspace(root);
    expect(packageFingerprint(ws, "vite", { globalHash: "g" })).toBe("external:vite");
  });
});

describe("hashDirectory", () => {
  it("does not depend on the order files were created in", () => {
    const one = mkdtempSync(path.join(tmpdir(), "octo-tree-"));
    const two = mkdtempSync(path.join(tmpdir(), "octo-tree-"));
    made.push(one, two);
    for (const name of ["b.txt", "a.txt", "c.txt"]) writeFileSync(path.join(one, name), name);
    for (const name of ["c.txt", "a.txt", "b.txt"]) writeFileSync(path.join(two, name), name);
    expect(hashDirectory(one).hash).toBe(hashDirectory(two).hash);
    expect(hashDirectory(one).files).toBe(3);
  });

  it("records the executable bit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octo-tree-"));
    made.push(dir);
    writeFileSync(path.join(dir, "a.sh"), "#!/bin/sh\n");
    const before = hashDirectory(dir).hash;
    chmodSync(path.join(dir, "a.sh"), 0o755);
    expect(hashDirectory(dir).hash).not.toBe(before);
  });
});

describe("buildKey", () => {
  it("separates identical sources built with different commands or outputs", () => {
    const base = { packageHash: "abc", command: "tsup", outputs: ["dist"] };
    expect(buildKey(base)).toBe(buildKey({ ...base, outputs: ["dist"] }));
    expect(buildKey(base)).not.toBe(buildKey({ ...base, command: "tsup --dts" }));
    expect(buildKey(base)).not.toBe(buildKey({ ...base, outputs: ["dist", "lib"] }));
    expect(buildKey(base)).not.toBe(buildKey({ ...base, packageHash: "abd" }));
  });
});
