/**
 * @vitest-environment node
 *
 * The loader's whole job is refusing, so this is a list of refusals.
 *
 * The one worth reading twice is "stale": nothing else in the system notices
 * it. An absent build fails at the first request; a truncated file fails when a
 * browser parses it. But a build made from older sources is internally
 * consistent — the digest matches those bytes, the hostname matches that
 * digest, the frame loads — and the only thing wrong is that it is not the code
 * in the tree. That is the one this file exists for.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escapeInlineScriptMarkup } from "./build.js";
import {
  AGENT_VIEW_BUILDER,
  APP_MODULE_BUILDER,
  AGENT_VIEW_MANIFEST_FILE,
  agentViewSourceDigest,
  loadAgentViewRelease,
  sha256Hex,
  type AgentViewBuildManifest,
  type AgentViewSourceInput,
} from "./release.js";

let root = "";
let src = "";
let dist = "";

const BUILD = "pnpm --filter @claude-bot/session-plus-view build";

function writeManifest(
  patch: Partial<AgentViewBuildManifest> = {},
  source: AgentViewSourceInput = { roots: [src] },
): void {
  const outputs = ["agent-view.js", "agent-view.css"].map((name) => {
    const source = name.endsWith(".css") ? ".x{color:red}" : "console.log(1)";
    writeFileSync(path.join(dist, name), source, "utf8");
    return { name, sha256: sha256Hex(source), bytes: Buffer.byteLength(source) };
  });
  const manifest: AgentViewBuildManifest = {
    schema: 1,
    builder: AGENT_VIEW_BUILDER,
    sourceDigest: agentViewSourceDigest(source),
    outputs,
    ...patch,
  };
  writeFileSync(path.join(dist, AGENT_VIEW_MANIFEST_FILE), JSON.stringify(manifest), "utf8");
}

function load(source: AgentViewSourceInput = { roots: [src] }) {
  return loadAgentViewRelease({
    distDir: dist,
    source,
    buildCommand: BUILD,
    expectedOutputs: ["agent-view.js", "agent-view.css"],
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agent-view-release-"));
  src = path.join(root, "src");
  dist = path.join(root, "dist");
  mkdirSync(src, { recursive: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(src, "App.tsx"), "export const App = () => null;\n", "utf8");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadAgentViewRelease", () => {
  it("returns the built assets in manifest order when everything agrees", () => {
    writeManifest();
    const loaded = load();
    expect(loaded.assets.map((a) => a.name)).toEqual(["agent-view.js", "agent-view.css"]);
    expect(loaded.assets[0].source).toBe("console.log(1)");
    expect(loaded.manifest.builder).toBe(AGENT_VIEW_BUILDER);
  });

  it("requires the module builder for an explicitly declared multi-asset release", () => {
    const names = ["agent-view.js", "agent-view.css", "agent-view.entry.json", "worker-pdf.js"];
    const outputs = names.map((name) => {
      const source = name.endsWith("json") ? "{}" : "/* asset */";
      writeFileSync(path.join(dist, name), source);
      return { name, sha256: sha256Hex(source), bytes: Buffer.byteLength(source) };
    });
    writeManifest({ builder: APP_MODULE_BUILDER, outputs });
    // writeManifest creates the two ordinary fixture files as well.
    for (const name of names) writeFileSync(path.join(dist, name), name.endsWith("json") ? "{}" : "/* asset */");
    const options = { distDir: dist, source: { roots: [src] }, buildCommand: BUILD,
      expectedOutputs: ["agent-view.js", "agent-view.css"], allowModuleAssets: true };
    expect(loadAgentViewRelease(options).assets.map((asset) => asset.name)).toEqual(names);
    expect(() => load()).toThrow(/构建器不受信任/);
    writeManifest({ builder: AGENT_VIEW_BUILDER, outputs });
    expect(() => loadAgentViewRelease(options)).toThrow(/构建器不受信任/);
  });

  it("refuses when nobody has built the View, and says what to run", () => {
    expect(() => load()).toThrow(new RegExp(BUILD.replace(/[/\-]/g, "\\$&")));
    expect(() => load()).toThrow(/产物缺失/);
  });

  it("refuses a build made from different sources rather than serving it", () => {
    writeManifest();
    expect(() => load()).not.toThrow();
    // Somebody edits a component and does not rebuild. Everything downstream
    // would still agree with itself; only this comparison notices.
    writeFileSync(path.join(src, "App.tsx"), "export const App = () => 'changed';\n", "utf8");
    expect(() => load()).toThrow(/源码在上次构建之后变过/);
  });

  it("notices a new file, a deleted file and a renamed file — not only edits", () => {
    writeManifest();
    writeFileSync(path.join(src, "New.tsx"), "export const N = 1;\n", "utf8");
    expect(() => load()).toThrow(/源码在上次构建之后变过/);

    rmSync(path.join(src, "New.tsx"));
    expect(() => load()).not.toThrow();

    // A rename moves no bytes, so a content-only digest would miss it.
    rmSync(path.join(src, "App.tsx"));
    writeFileSync(path.join(src, "Renamed.tsx"), "export const App = () => null;\n", "utf8");
    expect(() => load()).toThrow(/源码在上次构建之后变过/);
  });

  it("refuses an output whose bytes do not match the manifest", () => {
    writeManifest();
    writeFileSync(path.join(dist, "agent-view.js"), "console.log(1)  // truncated write", "utf8");
    expect(() => load()).toThrow(/与构建清单不一致/);
  });

  it("refuses an output the manifest promised and the disk does not have", () => {
    writeManifest();
    rmSync(path.join(dist, "agent-view.css"));
    expect(() => load()).toThrow(/产物缺失/);
  });

  it("refuses a manifest it does not understand instead of guessing", () => {
    writeManifest({ schema: 2 as never });
    expect(() => load()).toThrow(/不是本进程认识的格式/);
    writeFileSync(path.join(dist, AGENT_VIEW_MANIFEST_FILE), "{not json", "utf8");
    expect(() => load()).toThrow(/无法解析/);
  });

  it("refuses a manifest from another builder or with a different output inventory", () => {
    writeManifest({ builder: "some-other-builder" });
    expect(() => load()).toThrow(/构建器不受信任/);

    const js = "console.log(1)";
    writeManifest({
      outputs: [{ name: "agent-view.js", sha256: sha256Hex(js), bytes: Buffer.byteLength(js) }],
    });
    expect(() => load()).toThrow(/产物集合不符合发布契约/);
  });

  it("treats config and lockfile bytes as stale-build inputs", () => {
    const config = path.join(root, "vite.config.ts");
    const lockfile = path.join(root, "pnpm-lock.yaml");
    writeFileSync(config, "export default {build:{target:'es2022'}};\n", "utf8");
    writeFileSync(lockfile, "lockfileVersion: '9.0'\n", "utf8");
    const source = { roots: [src], files: [config, lockfile] };
    writeManifest({}, source);
    expect(() => load(source)).not.toThrow();

    writeFileSync(config, "export default {build:{target:'esnext'}};\n", "utf8");
    expect(() => load(source)).toThrow(/源码在上次构建之后变过/);

    writeManifest({}, source);
    writeFileSync(lockfile, "lockfileVersion: '9.1'\n", "utf8");
    expect(() => load(source)).toThrow(/源码在上次构建之后变过/);
  });

  it("fails closed when a declared root or file is missing", () => {
    expect(() => agentViewSourceDigest({ roots: [path.join(root, "missing-root")] })).toThrow(/源码目录不存在/);
    expect(() =>
      agentViewSourceDigest({ roots: [src], files: [path.join(root, "missing-lock.yaml")] }),
    ).toThrow(/构建输入不存在/);
  });

  it("is independent of where the tree is checked out", () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "agent-view-copy-"));
    try {
      const copy = path.join(elsewhere, "src");
      mkdirSync(copy, { recursive: true });
      writeFileSync(path.join(copy, "App.tsx"), "export const App = () => null;\n", "utf8");
      expect(agentViewSourceDigest({ roots: [copy] })).toBe(agentViewSourceDigest({ roots: [src] }));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("skips build output and dependency trees so a rebuild is not self-invalidating", () => {
    const before = agentViewSourceDigest({ roots: [root] });
    mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports=1", "utf8");
    writeFileSync(path.join(dist, "agent-view.js"), "rebuilt", "utf8");
    expect(agentViewSourceDigest({ roots: [root] })).toBe(before);
  });

  it("folds explicitly named files in, so a dependency bump is an input too", () => {
    const manifestFile = path.join(root, "package.json");
    writeFileSync(manifestFile, JSON.stringify({ dependencies: { react: "19.2.0" } }), "utf8");
    const before = agentViewSourceDigest({ roots: [src], files: [manifestFile] });
    writeFileSync(manifestFile, JSON.stringify({ dependencies: { react: "19.3.0" } }), "utf8");
    expect(agentViewSourceDigest({ roots: [src], files: [manifestFile] })).not.toBe(before);
  });

describe("inline script escaping", () => {
  it("preserves string and regular-expression values without raw HTML sentinels", () => {
    const source = String.raw`
      const comment = "<!--";
      const closing = "</ScRiPt>";
      const svgStyle = "</StYlE>";
      return [comment, closing, svgStyle, /<!--/.test(comment)];
    `;
    const escaped = escapeInlineScriptMarkup(source);
    expect(escaped).not.toContain("<!--");
    expect(escaped.toLowerCase()).not.toContain("</script");
    expect(escaped.toLowerCase()).not.toContain("</style");
    expect(Function(escaped)()).toEqual(["<!--", "</ScRiPt>", "</StYlE>", true]);
  });
});
});
