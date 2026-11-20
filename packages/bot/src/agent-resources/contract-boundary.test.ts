/**
 * The boundary of the View-facing contract, enforced by reading its source.
 *
 * A boundary that only exists in a review comment is not a boundary.
 * `@claude-bot/workspace-files-contract` is imported by module code that runs in
 * an opaque-origin frame, so four things must stay true, and each one is a rule
 * somebody could break with a single convenient import:
 *
 *  1. **Nothing trusted.** No Bot, no Host, no `web-trust`, no provider, no
 *     capability kernel. A contract that could import one would be a contract
 *     that could be given one.
 *  2. **No identity vocabulary.** owner, device, workspace id, canonical path,
 *     Context, grant, pending call. Not filtered — absent, so a hook that
 *     returned one could only invent it.
 *  3. **No channel of its own.** No second `MessagePort`, no `fetch`, no XHR, no
 *     WebSocket, no EventSource, no dynamic `import()`. The one transport is the
 *     App's, and it arrives as a parameter.
 *  4. **No new dependency.** Two workspace contract packages, and that is the
 *     whole list — a package whose point is being importable from a sandboxed
 *     bundle cannot grow a runtime.
 *
 * ── Why it lives here rather than in that package ──────────────────────────
 *
 * Because reading files needs `node:fs`, and that package's tsconfig sets
 * `"types": []` ON PURPOSE: with no ambient Node types, a source file there
 * cannot use `Buffer` or `process` and still typecheck. Adding `@types/node` to
 * run this test would weaken the very boundary the test is about. So the check
 * lives on the trusted side, which reads files for a living, and it is exactly
 * as strong — it reads the same bytes.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = [
  path.resolve(process.cwd(), "packages/workspace-files-contract"),
  path.resolve(process.cwd(), "../workspace-files-contract"),
].find((candidate) => existsSync(path.join(candidate, "src/port.ts")))!;

function sources(): string[] {
  return readdirSync(path.join(ROOT, "src"))
    .filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name))
    .map((name) => path.join(ROOT, "src", name));
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("the View-facing contract's boundary", () => {
  const files = sources();

  it("finds the modules it is supposed to be checking", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("imports nothing from the trusted side", () => {
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        expect(specifier, `${path.basename(file)} imports ${specifier}`).not.toMatch(
          /@claude-bot\/(bot|web-trust|runner|capability-kernel|app-registry|engine)|session-plus|dashboard-web|node:/,
        );
      }
    }
  });

  it("depends on exactly three packages, all of them dependency-free contracts", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // The port kit is the third, and it is the same closure rather than a wider
    // one: it depends on the other two and on nothing else, so adding it did not
    // put React, Node, the Bot or anything that knows what a capability is
    // inside a package an untrusted View loads.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@claude-bot/agent-module-contract",
      "@claude-bot/resource-stream-contract",
      "@claude-bot/typed-port-kit",
    ]);
  });

  it("has no vocabulary for saying who or where", () => {
    // `device`, `path` and `owner` appear in prose all over this package's
    // docstrings — explaining what is absent is most of what they do — so the
    // check is about CODE: a field, a parameter or a property with that name.
    const forbidden = [
      /\bowner\s*[:?]/,
      /\bdevice\s*[:?]/,
      /\bworkspaceId\s*[:?]/,
      /\bworkspace_id\s*[:?]/,
      /\brelativePath\s*[:?]/,
      /\brelative_path\s*[:?]/,
      /\bcontextId\s*[:?]/,
      /\bpendingCallId\s*[:?]/,
      /\bgrant\s*[:?]/,
      /\bcanonicalPath\b/,
      /\binstanceHandle\b/,
      /useIdentity|useOwner|useCapability/,
    ];
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path.basename(file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("opens no channel of its own and imports nothing at runtime", () => {
    const forbidden = [
      /\bMessageChannel\b/,
      /\bnew\s+MessagePort\b/,
      /\bpostMessage\s*\(/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bnew\s+WebSocket\b/,
      /\bnew\s+EventSource\b/,
      /(?<![.\w])import\s*\(/,
      /\brequire\s*\(/,
      /\bBuffer\b/,
      /\bprocess\./,
    ];
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path.basename(file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("keeps the port at three named methods, with no generic invoke", () => {
    const port = stripComments(readFileSync(path.join(ROOT, "src/port.ts"), "utf8"));
    expect(port).toMatch(/refreshRoots\(/);
    expect(port).toMatch(/listDirectory\(/);
    expect(port).toMatch(/openText\(/);
    for (const pattern of [/\binvoke\s*[(:<]/, /\bcall\s*[(:<]/, /\bdispatch\s*[(:<]/, /\brequest\s*[(:<]/]) {
      expect(pattern.test(port), `port.ts matches ${pattern}`).toBe(false);
    }
  });
});

/** Docstrings here exist to say what is absent, so the checks read code only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
