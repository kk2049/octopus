/**
 * The static namespace, tested as the file server it is.
 *
 * A static file server is a path-traversal bug waiting to happen, and this one
 * answers BEFORE the identity gate — which is correct (the login page is part of
 * the bundle) and is exactly why the rules below have to hold without any
 * authorization behind them.
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { bundleManifest, configureDashboardAssetArchive, readAsset, resetBundleManifest } from "./assets.js";

import { DASHBOARD_WEB_DIST } from "@claude-bot/dashboard-web";
import { APP_RUNTIME_IMPORTS, runtimeEntryName } from "@claude-bot/agent-view-build/runtime";

// Exercise the production default-dist fallback, using only files owned by
// this test. Mock the composition constant, never filesystem reads or copies.
vi.mock("@claude-bot/dashboard-web", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return { DASHBOARD_WEB_BASE: "/ui/", DASHBOARD_WEB_DIST: fs.mkdtempSync(path.join(os.tmpdir(), "octopus-deployed-ui-")) };
});

let dist: string;
let outside: string;
let archive: string;
let deployedDist: string | undefined;

beforeAll(() => {
  if (path.dirname(DASHBOARD_WEB_DIST) !== tmpdir()
    || !path.basename(DASHBOARD_WEB_DIST).startsWith("octopus-deployed-ui-")) {
    throw new Error("The asset test must use its mocked, test-owned deployed directory");
  }
  deployedDist = DASHBOARD_WEB_DIST;
  dist = mkdtempSync(path.join(tmpdir(), "octopus-ui-"));
  mkdirSync(path.join(dist, "a"), { recursive: true });
  mkdirSync(path.join(dist, ".vite"), { recursive: true });
  writeFileSync(path.join(dist, "a", "app-abc12345.js"), "console.log(1)");
  writeFileSync(path.join(dist, "a", "style-def67890.css"), "body{}");
  writeFileSync(path.join(dist, "a", "notes.txt"), "nope");
  writeFileSync(path.join(dist, "unhashed.js"), "x");
  // The REAL shape this build produces: `cssCodeSplit: false` puts the single
  // stylesheet in a top-level entry, and the chunk lists no `css` at all.
  writeFileSync(
    path.join(dist, ".vite", "manifest.json"),
    JSON.stringify({
      "src/main.tsx": { file: "a/app-abc12345.js", name: "app", src: "src/main.tsx", isEntry: true },
      "style.css": { file: "a/style-def67890.css", src: "style.css" },
    }),
  );
  // And the other shape, for a build that ever turns splitting back on.
  mkdirSync(path.join(dist, "split", ".vite"), { recursive: true });
  mkdirSync(path.join(dist, "split", "a"), { recursive: true });
  writeFileSync(
    path.join(dist, "split", ".vite", "manifest.json"),
    JSON.stringify({
      "src/main.tsx": { file: "a/app-abc12345.js", css: ["a/style-def67890.css"], isEntry: true },
    }),
  );
  mkdirSync(path.join(dist, "nocss", ".vite"), { recursive: true });
  writeFileSync(
    path.join(dist, "nocss", ".vite", "manifest.json"),
    JSON.stringify({ "src/main.tsx": { file: "a/app-abc12345.js", isEntry: true } }),
  );
  // A file OUTSIDE the root, which is what a traversal would be reaching for.
  outside = mkdtempSync(path.join(tmpdir(), "octopus-ui-outside-"));
  const secret = path.join(outside, "secret.js");
  writeFileSync(secret, "sensitive");
  symlinkSync(secret, path.join(dist, "a", "linked-abc12345.js"));
  archive = mkdtempSync(path.join(tmpdir(), "octopus-ui-archive-"));
  configureDashboardAssetArchive(archive);
});

afterAll(() => {
  resetBundleManifest();
  for (const directory of [dist, outside, archive, deployedDist]) if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("the manifest is the only place filenames live", () => {
  it("resolves the entry chunk and its stylesheet under the /ui/ base", () => {
    resetBundleManifest();
    const manifest = bundleManifest(dist);
    expect(manifest.script).toBe("/ui/a/app-abc12345.js");
    expect(manifest.styles).toEqual(["/ui/a/style-def67890.css"]);
    expect(manifest.buildId).toMatch(/^[0-9a-f]{12}$/);
    expect(manifest.imports).toBeUndefined();
  });

  it("finds the stylesheet in the other manifest shape too", () => {
    resetBundleManifest();
    expect(bundleManifest(path.join(dist, "split")).styles).toEqual(["/ui/a/style-def67890.css"]);
    resetBundleManifest();
  });

  it("refuses a manifest with no stylesheet rather than serving an unstyled panel", () => {
    // The defect this is here for: reading only `entry.css` under
    // `cssCodeSplit: false` produced a page whose JavaScript worked and whose
    // every layout rule was silently absent.
    resetBundleManifest();
    expect(() => bundleManifest(path.join(dist, "nocss"))).toThrow(/no stylesheet/);
    resetBundleManifest();
  });

  it("says which command to run when the bundle is not built", () => {
    resetBundleManifest();
    expect(() => bundleManifest(path.join(dist, "missing"))).toThrow(/pnpm -r build/);
    resetBundleManifest();
  });
});

describe("readAsset", () => {
  it("serves a hashed file as immutable", async () => {
    const hit = await readAsset("/ui/a/app-abc12345.js", dist);
    expect(hit?.contentType).toBe("text/javascript; charset=utf-8");
    expect(hit?.immutable).toBe(true);
    expect(hit?.body.toString()).toBe("console.log(1)");
  });

  it("serves an unhashed file as revalidate-always", async () => {
    const hit = await readAsset("/ui/unhashed.js", dist);
    expect(hit?.immutable).toBe(false);
  });

  it("refuses a traversal, however it is spelled", async () => {
    for (const attempt of [
      "/ui/../secret.js",
      "/ui/a/../../secret.js",
      "/ui/%2e%2e/secret.js",
      "/ui/..%2fsecret.js",
    ]) {
      expect(await readAsset(attempt, dist), attempt).toBeNull();
    }
  });

  it("refuses a symlink that escapes the asset root", async () => {
    expect(await readAsset("/ui/a/linked-abc12345.js", dist)).toBeNull();
  });

  it("refuses an absolute path", async () => {
    expect(await readAsset("/ui//etc/passwd", dist)).toBeNull();
  });

  it("refuses an extension that is not on the allow-list", async () => {
    // The file exists; the type does not. Serving arbitrary types from a
    // namespace fed by a build directory is how a `.html` becomes a same-origin
    // script host.
    expect(await readAsset("/ui/a/notes.txt", dist)).toBeNull();
  });

  it("refuses a directory and a missing file identically — both are 404", async () => {
    expect(await readAsset("/ui/a", dist)).toBeNull();
    expect(await readAsset("/ui/a/", dist)).toBeNull();
    expect(await readAsset("/ui/a/does-not-exist.js", dist)).toBeNull();
  });

  it("answers nothing for a path outside its namespace", async () => {
    expect(await readAsset("/api/overview", dist)).toBeNull();
  });

  it("refuses a NUL byte rather than handing it to the filesystem", async () => {
    expect(await readAsset("/ui/a/app%00.js", dist)).toBeNull();
  });

  it("treats malformed percent encoding as a missing public asset", async () => {
    await expect(readAsset("/ui/a/%E0%A4%A.js", dist)).resolves.toBeNull();
  });
});


function deployBuild(hash: string, runtime: "all" | "partial" | "none" = "none"): void {
  // This is the test's mock deployed directory, not the repository build.
  if (!deployedDist) throw new Error("The test deployed directory was not initialized");
  rmSync(deployedDist, { recursive: true, force: true });
  mkdirSync(path.join(DASHBOARD_WEB_DIST, "a"), { recursive: true });
  mkdirSync(path.join(DASHBOARD_WEB_DIST, ".vite"), { recursive: true });
  const manifest: Record<string, { file: string; name?: string; isEntry?: boolean }> = {};
  // Runtime entries intentionally precede the App entry, like a Vite manifest
  // whose insertion order is not its entrypoint contract.
  const runtimeImports = runtime === "all" ? APP_RUNTIME_IMPORTS : runtime === "partial" ? APP_RUNTIME_IMPORTS.slice(0, 1) : [];
  for (const [index, specifier] of runtimeImports.entries()) {
    const file = "a/shared-" + index + "-" + hash + ".js";
    manifest["runtime:" + specifier] = { file, name: runtimeEntryName(index), isEntry: true };
    writeFileSync(path.join(DASHBOARD_WEB_DIST, file), "export const version = " + JSON.stringify(hash));
  }
  manifest["src/main.tsx"] = { file: "a/app-" + hash + ".js", name: "app", isEntry: true };
  manifest["style.css"] = { file: "a/style-" + hash + ".css" };
  writeFileSync(path.join(DASHBOARD_WEB_DIST, ".vite", "manifest.json"), JSON.stringify(manifest));
  writeFileSync(path.join(DASHBOARD_WEB_DIST, "a", "app-" + hash + ".js"), "app " + hash);
  writeFileSync(path.join(DASHBOARD_WEB_DIST, "a", "style-" + hash + ".css"), ".app{color:black}");
  writeFileSync(path.join(DASHBOARD_WEB_DIST, "a", "lazy-" + hash + ".js"), "lazy " + hash);
  writeFileSync(path.join(DASHBOARD_WEB_DIST, "a", "debug.js"), "unhashed build note");
  resetBundleManifest();
}

describe("published hashed asset retention", () => {
  it("keeps an old page's lazy module readable after the deployed build changes", async () => {
    deployBuild("old12345", "all");
    const old = bundleManifest();
    expect(old.script).toBe("/ui/a/app-old12345.js");
    expect((await readAsset("/ui/a/lazy-old12345.js"))?.body.toString()).toBe("lazy old12345");
    deployBuild("new67890", "all");
    const fresh = bundleManifest();
    expect(fresh.buildId).not.toBe(old.buildId);
    expect(fresh.script).toBe("/ui/a/app-new67890.js");
    expect(existsSync(path.join(DASHBOARD_WEB_DIST, "a", "lazy-old12345.js"))).toBe(false);
    for (const [url, bytes] of [
      ["/ui/a/lazy-old12345.js", "lazy old12345"],
      ["/ui/a/app-old12345.js", "app old12345"],
      ["/ui/a/app-new67890.js", "app new67890"],
    ]) {
      const hit = await readAsset(url!);
      expect(hit?.body.toString()).toBe(bytes);
      expect(hit?.immutable).toBe(true);
      expect(hit?.contentType).toBe("text/javascript; charset=utf-8");
    }
    // Old import-map URLs must still resolve the matching old runtime bytes.
    const oldReact = await readAsset(old.imports!.react!);
    expect(oldReact?.body.toString()).toContain("old12345");
    expect((await readAsset(fresh.imports!.react!))?.body.toString()).toContain("new67890");
    expect(existsSync(path.join(archive, "a", "debug.js"))).toBe(false);
  });

  it("never exposes non-hashed archive files or paths escaping the archive", async () => {
    deployBuild("safe1234");
    bundleManifest();
    writeFileSync(path.join(archive, "metadata.json"), "archive-private-state");
    writeFileSync(path.join(archive, "a", "metadata.json"), "archive-private-state");
    symlinkSync(path.join(outside, "secret.js"), path.join(archive, "a", "escape-12345678.js"));
    for (const attempt of [
      "/ui/metadata.json", "/ui/a/metadata.json",
      "/ui/../secret.js", "/ui/a/../../secret.js", "/ui/%2e%2e/secret.js",
      "/ui/a/%2e%2e/%2e%2e/secret.js", "/ui//etc/passwd",
      "/ui/a/escape-12345678.js", "/ui/a/missing-12345678.js", "/ui/a",
    ]) expect(await readAsset(attempt), attempt).toBeNull();
  });
});

describe("shared runtime manifest", () => {
  it("selects the App entry and supplies every declared bare-import mapping", () => {
    deployBuild("runtime1", "all");
    const manifest = bundleManifest();
    expect(manifest.script).toBe("/ui/a/app-runtime1.js");
    expect(manifest.imports).toEqual(Object.fromEntries(APP_RUNTIME_IMPORTS.map((specifier, index) =>
      [specifier, "/ui/a/shared-" + index + "-runtime1.js"])));
  });

  it("refuses a partially built runtime rather than publishing a broken import map", () => {
    deployBuild("partial1", "partial");
    expect(() => bundleManifest()).toThrow(/runtime manifest is incomplete/);
  });

  it("continues to render a legacy single-bundle manifest without an import map", () => {
    deployBuild("legacy12");
    const manifest = bundleManifest();
    expect(manifest.script).toBe("/ui/a/app-legacy12.js");
    expect(manifest.imports).toBeUndefined();
  });
});
