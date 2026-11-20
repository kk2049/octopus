/**
 * The dependency boundary, enforced by reading this package's own source.
 *
 * A boundary that only exists in a review comment is not a boundary. Six things
 * must stay true here, and each is a rule somebody could break with one
 * convenient import:
 *
 *  1. **No trusted side.** Importing the bot, the Runner, the capability kernel
 *     or `node:*` would put this untrusted bundle downstream of code that holds
 *     credentials — and a transitive dependency is enough to do it.
 *  2. **No transport.** These modules hold a PORT. What is on the other end of
 *     it is the App's business, and a module that knew would be a module that
 *     could be told an identity.
 *  3. **No SDK root entry.** `@claude-bot/agent-view-react` re-exports the
 *     client and the wire constants; `/ui` and `/workspace` do not. Depending on
 *     the narrow entries makes rule 2 a type error rather than a habit. This is
 *     also exactly why `app-data/v1` is a port and not a `useProjection()` call.
 *  4. **No literal action id.** These modules are generic; the ONE action that
 *     exists is `config.action`, written by an App author in a composition. A
 *     string literal reaching `submit()` would be this package choosing what to
 *     ask a Host for, which is the App's decision and the App's audit record.
 *  5. **No identity field names.** owner, device, credential, grant, context id,
 *     instance handle. `app-data/v1` does not carry them, so a component that
 *     mentioned one would either be inventing a field or reading one that must
 *     never have crossed.
 *  6. **No channel of its own.** `connect-src 'none'` means a fetch here could
 *     only be a bug or an exfiltration attempt.
 *
 * The harness is held to the same rules: it is a second consumer, and a second
 * consumer that cheated would prove nothing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This suite runs in the jsdom project, where `import.meta.url` is not a file
 * URL, so the tree is located from the working directory instead — which is the
 * repository root under `npx vitest run` and this package under a filtered run.
 */
const SRC = [
  path.resolve(process.cwd(), "packages/agent-data-view/src"),
  path.resolve(process.cwd(), "src"),
].find((candidate) => existsSync(candidate))!;

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
}

/** Strip block and line comments, so prose about a rule does not break it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

describe("agent-data-view dependency boundary", () => {
  const files = sources();

  it("finds the modules it is supposed to be checking", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("imports no trusted side and no Node built-in", () => {
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        expect(specifier, `${path.relative(SRC, file)} imports ${specifier}`).not.toMatch(
          /^node:|session-plus|@claude-bot\/bot|dashboard-web|web-trust|capability-kernel|@claude-bot\/runner|@claude-bot\/engine/,
        );
      }
    }
  });

  it("depends only on the SDK's narrow entries, never its root", () => {
    const allowed = [
      /^react(-dom)?(\/.*)?$/,
      // Presentation and layout only. The root entry re-exports the transport.
      /^@claude-bot\/agent-view-react\/(ui|workspace)$/,
      /^@claude-bot\/agent-module-contract$/,
      /^\.{1,2}\//,
    ];
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        if (specifier.endsWith(".css")) continue;
        expect(
          allowed.some((pattern) => pattern.test(specifier)),
          `${path.relative(SRC, file)} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("never submits a literal action id", () => {
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      // Any call that hands a string constant straight to the proposal channel.
      for (const pattern of [/\bsubmit\(\s*["'`]/, /\bpropose\(\s*["'`]/]) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("mentions no identity field the contract does not carry", () => {
    const forbidden = [
      /\bownerName\b/,
      /\busername\b/,
      /\bcredential\b/,
      /\bdeviceId\b/,
      /\bworkspaceId\b/,
      /\bcanonicalPath\b/,
      /\bcontextId\b/,
      /\bgrant\b/,
      /\bpendingCallId\b/,
      /\binstanceHandle\b/,
      /\bcsrf\b/,
      /\buseIdentity\b/,
      /\buseOwner\b/,
      /\buseCapability\b/,
    ];
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("opens no channel of its own", () => {
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      for (const pattern of [/\bfetch\(/, /XMLHttpRequest/, /new WebSocket/, /EventSource/, /postMessage/, /import\(/]) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("keeps the manifests importable without React or a stylesheet", () => {
    // A Node release builder reads them to emit the module lock and the binding
    // plan; it cannot import JSX or CSS.
    for (const specifier of importsOf(readFileSync(path.join(SRC, "manifests.ts"), "utf8"))) {
      expect(specifier).not.toMatch(/^react/);
      expect(specifier).not.toMatch(/agent-view-react/);
      expect(specifier).not.toMatch(/\.css$/);
    }
    // …and `port.ts`, which the manifests import for the contract id, is under
    // the same rule for the same reason.
    for (const specifier of importsOf(readFileSync(path.join(SRC, "port.ts"), "utf8"))) {
      expect(specifier).not.toMatch(/^react/);
      expect(specifier).not.toMatch(/agent-view-react/);
    }
  });
});
