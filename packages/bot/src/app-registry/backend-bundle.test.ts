/**
 * The pack-time backend bundler: what it inlines, what it refuses, and the one
 * property everything else hangs on — the bytes it emits are the bytes the
 * digest covers AND the bytes the SES Compartment executes.
 *
 * The end-to-end case therefore does not stop at "the output parses": it packs
 * the fixture app (which imports a real pure npm package, `eventemitter3`, and
 * its own second file), computes `backendRelease()` over the packed bytes the
 * way the adapter does, and dispatches through the real `AppRuntimeService` —
 * the same SES child production uses. The refusal cases each pin one row of the
 * closed `BackendBundleRefusal` matrix.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AppRuntimeService, backendRelease } from "@claude-bot/app-runtime";
import {
  BackendBundleError,
  MAX_BACKEND_BUNDLE_BYTES,
  bundleAppBackend,
} from "./backend-bundle.js";
import { SHOWCASE_APP_DIR } from "./showcase-package.js";

const FIXTURE_DIR = fileURLToPath(new URL("./__fixtures__/pure-dep-backend/", import.meta.url));

const dirs: string[] = [];
const services: AppRuntimeService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway app dir with the given files ("node_modules/…" paths included). */
function appDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "backend-bundle-"));
  dirs.push(dir);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return dir;
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BackendBundleError) return error.refusal;
    throw error;
  }
  throw new Error("expected a BackendBundleError refusal, got success");
}

describe("bundleAppBackend: pass-through and byte identity", () => {
  it("returns an import-free entry VERBATIM — existing apps pack byte-identically", async () => {
    // The real showcase backend, not a fixture: this is the sentence "no
    // pre-existing release changes shape" made checkable.
    for (const file of ["actions.ts", "projection.ts"]) {
      const raw = readFileSync(path.join(SHOWCASE_APP_DIR, file), "utf8");
      const packed = await bundleAppBackend(path.join(SHOWCASE_APP_DIR, file), SHOWCASE_APP_DIR);
      expect(packed.bundled).toBe(false);
      expect(packed.source).toBe(raw);
      expect(packed.npmPackages).toEqual([]);
    }
  });

  it("is deterministic: bundling the same tree twice is the same bytes", async () => {
    const entry = path.join(FIXTURE_DIR, "actions.ts");
    const first = await bundleAppBackend(entry, FIXTURE_DIR);
    const second = await bundleAppBackend(entry, FIXTURE_DIR);
    expect(first.bundled).toBe(true);
    expect(first.source).toBe(second.source);
  });

  it("refuses an entry outside the app directory", async () => {
    const outside = appDir({ "actions.ts": "export function a() { return {}; }" });
    const elsewhere = appDir({});
    expect(await refusalOf(bundleAppBackend(path.join(outside, "actions.ts"), elsewhere)))
      .toBe("entry_outside_app");
  });

  it("refuses an entry the runtime grammar cannot parse, at pack time", async () => {
    const dir = appDir({ "actions.ts": "export function broken( { return; }" });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir)))
      .toBe("entry_unparseable");
  });
});

describe("bundleAppBackend: a pure npm dep, end to end through the SES sandbox", () => {
  it("inlines eventemitter3 + a relative file, and the bundle dispatches for real", async () => {
    const packed = await bundleAppBackend(path.join(FIXTURE_DIR, "actions.ts"), FIXTURE_DIR);
    expect(packed.bundled).toBe(true);
    expect(packed.npmPackages).toEqual(["eventemitter3"]);
    expect(packed.moduleCount).toBeGreaterThanOrEqual(3);

    const projection = await bundleAppBackend(path.join(FIXTURE_DIR, "projection.ts"), FIXTURE_DIR);
    expect(projection.bundled).toBe(false);

    // Lay the packed bytes down exactly the way `materialiseBackendTree` would,
    // and let the REAL runtime — digest check, SES child, fresh Compartment —
    // say whether the bundle is a backend.
    const release = appDir({ "actions.ts": packed.source, "projection.ts": projection.source });
    const digest = backendRelease(release).backendCodeDigest;
    const service = new AppRuntimeService(release);
    services.push(service);

    const out = await service.invoke({
      backendCodeDigest: digest,
      action: "take_seat",
      context: { now: "2026-08-11T00:00:00.000Z" },
      params: { seat: 7 },
    });
    // `note`/`steps` are the SES-censor bait (chess.js incident regression):
    // the raw fixture contains " --> ", "<!--" and `i-->0`; reaching HERE means
    // the evasive transform rewrote them into Compartment-acceptable bytes and
    // the rewritten code still computes the same values.
    expect(out.events).toEqual([
      {
        type: "seat_taken",
        data: { seat: 7, note: "line --> here <!-- note", steps: 7 },
        at: "2026-08-11T00:00:00.000Z",
        by: "pure-dep-backend",
      },
    ]);
    expect(packed.source).not.toMatch(/-->|<!--/);
    expect(await service.project({ backendCodeDigest: digest, events: out.events })).toEqual({ seats: [7] });
  });

  it("inlines a CommonJS-only dependency with no import remnants", async () => {
    const dir = appDir({
      "actions.ts": `
        import { doubled } from "cjs-dep";
        export function act(ctx: unknown, params: { n?: number }) {
          return { events: [{ type: "n", data: { n: doubled(params?.n ?? 0) }, at: "", by: "t" }] };
        }
      `,
      "node_modules/cjs-dep/package.json": `{ "name": "cjs-dep", "version": "1.0.0", "main": "index.js" }`,
      "node_modules/cjs-dep/index.js": `
        const inner = require("./inner.js");
        module.exports = { doubled: (x) => inner.twice(x) };
      `,
      "node_modules/cjs-dep/inner.js": `exports.twice = (x) => x * 2;`,
    });
    const packed = await bundleAppBackend(path.join(dir, "actions.ts"), dir);
    expect(packed.bundled).toBe(true);
    expect(packed.npmPackages).toEqual(["cjs-dep"]);
    // The final gate already asserted zero imports under the runtime grammar;
    // this is the same claim visible in the test output.
    expect(packed.source).not.toMatch(/^\s*import[\s("']/m);
  });
});

describe("bundleAppBackend: the refusal matrix", () => {
  it("refuses a node: builtin anywhere in the graph", async () => {
    const dir = appDir({
      "actions.ts": `import { readFileSync } from "node:fs";\nexport function act() { return readFileSync("/etc/passwd"); }`,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("builtin_import");
  });

  it("refuses a bare-name builtin (fs) too", async () => {
    const dir = appDir({
      "actions.ts": `import * as fs from "fs";\nexport function act() { return fs.readFileSync("/x"); }`,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("builtin_import");
  });

  it("refuses a builtin name even when an npm stub package shadows it", async () => {
    // `fs` EXISTS in node_modules here, so resolution succeeds — the refusal
    // must come from the original-specifier check, not from a resolve failure.
    const dir = appDir({
      "actions.ts": `import stub from "fs";\nexport function act() { return stub; }`,
      "node_modules/fs/package.json": `{ "name": "fs", "version": "0.0.1", "main": "index.js" }`,
      "node_modules/fs/index.js": `module.exports = { innocent: true };`,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("builtin_import");
  });

  it("refuses an unresolvable bare import — nothing may stay external", async () => {
    const dir = appDir({
      "actions.ts": `import { x } from "package-nobody-installed";\nexport function act() { return x; }`,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("unresolved_import");
  });

  it("refuses dynamic import even where esbuild could inline it silently", async () => {
    const dir = appDir({
      "helper.ts": `export const h = 1;`,
      "actions.ts": `
        import { h } from "./helper.js";
        export async function act() { const m = await import("./helper.js"); return { h, m }; }
      `,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("dynamic_import");
  });

  it("refuses a dynamic-import-only entry rather than passing it through", async () => {
    const dir = appDir({
      "helper.ts": `export const h = 1;`,
      "actions.ts": `export async function act() { return await import("./helper.js"); }`,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("dynamic_import");
  });

  it("refuses top-level await anywhere in the graph — SES instantiation is synchronous", async () => {
    const dir = appDir({
      "actions.ts": `import { v } from "tla-dep";\nexport function act() { return v; }`,
      "node_modules/tla-dep/package.json": `{ "name": "tla-dep", "version": "1.0.0", "main": "index.mjs" }`,
      "node_modules/tla-dep/index.mjs": `export const v = await Promise.resolve(42);`,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("top_level_await");
  });

  it("refuses import.meta — the Compartment has no meaningful host to ask", async () => {
    const dir = appDir({
      "helper.ts": `export const h = 1;`,
      "actions.ts": `import { h } from "./helper.js";\nexport function act() { return { h, url: import.meta.url }; }`,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("import_meta");
  });

  it("refuses a relative import that escapes the app directory", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "backend-bundle-escape-"));
    dirs.push(parent);
    const dir = path.join(parent, "app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(parent, "outside.ts"), `export const secret = "not yours";`);
    writeFileSync(
      path.join(dir, "actions.ts"),
      `import { secret } from "../outside.js";\nexport function act() { return secret; }`,
    );
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("escapes_app_dir");
  });

  it("refuses an oversized bundle", async () => {
    const big = `export const blob = ${JSON.stringify("x".repeat(MAX_BACKEND_BUNDLE_BYTES + 1024))};`;
    const dir = appDir({
      "big.ts": big,
      "actions.ts": `import { blob } from "./big.js";\nexport function act() { return blob.length; }`,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("output_too_large");
  });

  it("refuses a require esbuild cannot inline inside a dep — the edge check, since esbuild mutes node_modules warnings", async () => {
    const dir = appDir({
      "actions.ts": `import { load } from "loader-dep";\nexport function act() { return load("x"); }`,
      "node_modules/loader-dep/package.json": `{ "name": "loader-dep", "version": "1.0.0", "main": "index.js" }`,
      "node_modules/loader-dep/index.js": `module.exports = { load: (name) => require(name) };`,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("external_remnant");
  });

  it("treats bundler warnings as refusals — the belt behind the edge checks", async () => {
    // esbuild 0.27 does NOT warn about an uninlinable require (the edge check
    // above owns that); this pins that when esbuild DOES warn about the app's
    // own code, the pack refuses instead of shipping "I emitted something the
    // source didn't quite say".
    const dir = appDir({
      "helper.ts": `export const h = 1;`,
      "actions.ts": `
        import { h } from "./helper.js";
        export function act() { return { a: 1, a: 2, h }; }
      `,
    });
    expect(await refusalOf(bundleAppBackend(path.join(dir, "actions.ts"), dir))).toBe("bundler_warning");
  });
});
