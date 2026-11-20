/**
 * packApp validates the manifest BEFORE any other work — the regression pinned
 * here is the first real production incident of the declared-App line: an
 * unquoted CJK description containing a comma inside a YAML flow mapping
 * parsed as an extra unknown key, which packed/installed/activated cleanly and
 * failed only on the first user's open ("后端暂时不可用").
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packApp, readAppPackConfig } from "./app-package.js";

const dirs: string[] = [];

const customRootConfig = {
  app: "custom-root",
  publisher: "octopus:test",
  title: "Custom root",
  appDir: "/tmp/custom-root",
  subdir: "packages/custom-root-view",
  view: {
    distDir: "/tmp/custom-root/dist",
    buildCommand: "pnpm --filter custom-root build",
    source: { roots: ["/tmp/custom-root/src"], files: [] },
  },
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("declared App pack profiles", () => {
  it("confines the document resource profile to the reviewed first-party App", () => {
    const config={...customRootConfig,app:"research-docs",publisher:"octopus:first-party",resourceProfile:"research-docs/v1"};
    expect(readAppPackConfig(config)).toBe(config);
    for(const change of [{app:"research-v2"},{publisher:"octopus:test"}]) expect(()=>readAppPackConfig({...config,...change})).toThrow(/资源 profile/);
  });
  it("accepts the canvas profile only for the exact first-party research-v2 App", () => {
    const config = {...customRootConfig, app: 'research-v2', publisher: 'octopus:first-party', resourceProfile: 'research-canvas/v2'};
    expect(readAppPackConfig(config)).toBe(config);
    for (const change of [{app:'research-program'}, {publisher:'octopus:test'}]) expect(() => readAppPackConfig({...config,...change})).toThrow(/资源 profile/);
  });
  it("accepts the reviewed Research profile only for its exact first-party App", () => {
    const config = { ...customRootConfig, app: 'research-program', publisher: 'octopus:first-party', resourceProfile: 'research-sessions/v1' };
    expect(readAppPackConfig(config)).toBe(config);
    for (const change of [{ app: 'custom-root' }, { publisher: 'octopus:test' }, { resourceProfile: 'arbitrary-execution/v1' }]) {
      expect(() => readAppPackConfig({ ...config, ...change })).toThrow(/资源 profile/);
    }
  });
  it("accepts a bespoke root without pretending it has a module plan", () => {
    expect(readAppPackConfig(customRootConfig)).toBe(customRootConfig);
  });

  it("requires module manifests and their two release assets as one profile", () => {
    expect(() => readAppPackConfig({ ...customRootConfig, manifests: [{}] })).toThrow(/同时提供或同时省略/);
    expect(() => readAppPackConfig({ ...customRootConfig, moduleAssets: [] })).toThrow(/同时提供或同时省略/);
    expect(() => readAppPackConfig({ ...customRootConfig, manifests: [], moduleAssets: [] })).toThrow(/manifests.*非空/);
  });
});

describe("packApp manifest gate", () => {
  it("refuses at pack time the exact flow-mapping comma bug that reached production", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "pack-gate-"));
    dirs.push(appDir);
    mkdirSync(join(appDir, "pages"), { recursive: true });
    // The broken shape verbatim: the unquoted 「行,列」comma splits the flow map.
    writeFileSync(
      join(appDir, "app.yaml"),
      [
        "id: broken",
        "schema: 3",
        "state: { scope: shared }",
        "roles:",
        "  white: { max: 1 }",
        "actions:",
        "  move:",
        "    binding: runtime",
        "    handler: move",
        "    roles: [white]",
        "    params:",
        "      from: {type: string, max: 8, required: true, description: 起点格「行,列」}",
        "view:",
        "  page: pages/main.yaml",
        "",
      ].join("\n"),
    );
    await expect(
      packApp({
        app: "broken",
        publisher: "octopus:demo",
        title: "broken",
        appDir,
        subdir: "broken",
        manifests: [],
        moduleAssets: [
          { name: "view/module-lock.json", source: "{}" },
          { name: "view/composition.json", source: "{}" },
        ],
        view: { distDir: join(appDir, "no-dist"), buildCommand: "noop", source: { roots: [], files: [] } },
      } as never),
    ).rejects.toThrow(/manifest 校验，拒绝打包.*unknown key/s);
  });
});
