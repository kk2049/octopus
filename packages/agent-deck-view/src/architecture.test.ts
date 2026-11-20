/**
 * The dependency boundary, enforced by reading this package's own source.
 *
 * A boundary that only exists in a review comment is not a boundary. Seven
 * things must stay true here; six are the same rules every reusable View module
 * package in this repository keeps, and the seventh is this package's own.
 *
 *  1. **No trusted side.** Importing the bot, the Runner, the capability kernel
 *     or `node:*` would put this untrusted bundle downstream of code that holds
 *     credentials — and a transitive dependency is enough to do it.
 *  2. **No transport.** These modules hold a PORT. What is on the other end is
 *     the App's business, and a module that knew could be told an identity.
 *  3. **No SDK root entry.** `@claude-bot/agent-view-react` re-exports the
 *     client and the wire constants; `/ui` and `/workspace` do not.
 *  4. **No literal action id.** The one action that exists is
 *     `config.command_action`, written by an App author in a composition. What
 *     crosses is a `deck-model/v1` command the CONTRACT encodes.
 *  5. **No identity field names.** owner, device, credential, grant, context id,
 *     instance handle. `app-data/v1` does not carry them.
 *  6. **No channel of its own.** `connect-src 'none'` means a fetch here could
 *     only be a bug or an exfiltration attempt.
 *  7. **No way back from Typst.** §15.5 settles that the deck JSON is the
 *     editable truth. A parser, a merge, or an editable Typst control would make
 *     the derived file a second source, which is the shape that decision names
 *     as forbidden. The way to keep it out is to not have the function.
 *
 * ── The dependency that is deliberately allowed ─────────────────────────────
 *
 * `@claude-bot/agent-data-view`. Not for its components — the analysis for that
 * is in `components/SlideEditor.tsx` — but for the PORT and the PROVIDER. Two
 * providers over one projection would be two subscriptions and two chances to
 * tear under concurrent rendering, which is the exact property that package's
 * context header exists to protect. One App, one provider, however many modules.
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
  path.resolve(process.cwd(), "packages/agent-deck-view/src"),
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

describe("agent-deck-view dependency boundary", () => {
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
      // Pure data: the model, the commands, the one-way Typst generator.
      /^@claude-bot\/deck-model-contract$/,
      // The `app-data/v1` port and the ONE provider over it. See the header.
      /^@claude-bot\/agent-data-view(\/(port|harness))?$/,
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

  it("has no way back from Typst, and no control that would need one", () => {
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      for (const pattern of [/typstToDeck/i, /parseTypst/i, /fromTypst/i, /typstSource\s*=/]) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
    // The Typst panel renders text. A textarea, an input or a contenteditable in
    // it would be an editable second representation; `modules.test.tsx` asserts
    // the same thing against the rendered DOM.
    const view = code(readFileSync(path.join(SRC, "components/TypstExport.tsx"), "utf8"));
    for (const pattern of [/<textarea/, /<input/, /contentEditable/]) {
      expect(pattern.test(view), `TypstExport matches ${pattern}`).toBe(false);
    }
  });

  /**
   * The contract's half of §15.5, scanned from here.
   *
   * `deck-model-contract` compiles with `types: []` and no `@types/node` — the
   * same as every contract package in this repository, and the thing that makes
   * "it cannot name a Node built-in" a compiler error. So it cannot read its own
   * source, and this package, which depends on the rule holding, does it.
   */
  it("keeps the contract it derives from one-way, and free of a compiler", () => {
    const contract = [
      path.resolve(process.cwd(), "packages/deck-model-contract/src"),
      path.resolve(SRC, "../../deck-model-contract/src"),
    ].find((candidate) => existsSync(candidate))!;
    const contractFiles = readdirSync(contract)
      .filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name))
      .map((name) => path.join(contract, name));
    expect(contractFiles.length).toBeGreaterThan(3);
    for (const file of contractFiles) {
      const source = code(readFileSync(file, "utf8"));
      // 1. No arrow back. Its existence is enough: the first caller makes the
      //    derived file editable and the fork is silent.
      for (const pattern of [/typstToDeck/i, /parseTypst/i, /fromTypst/i, /readTypst/i]) {
        expect(pattern.test(source), `${path.basename(file)} matches ${pattern}`).toBe(false);
      }
      // 2. No compiler, no process, no filesystem, no network — it has to be
      //    importable by this untrusted browser bundle.
      for (const pattern of [/require\(/, /["']node:/, /child_process/, /\bspawn\(/, /\bfetch\(/, /readFileSync/, /\bprocess\./]) {
        expect(pattern.test(source), `${path.basename(file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("keeps the manifests importable without React or a stylesheet", () => {
    // A Node release builder reads them to emit the module lock; it cannot
    // import JSX or CSS.
    for (const specifier of importsOf(readFileSync(path.join(SRC, "manifests.ts"), "utf8"))) {
      expect(specifier).not.toMatch(/^react/);
      expect(specifier).not.toMatch(/agent-view-react/);
      expect(specifier).not.toMatch(/\.css$/);
      // …including transitively: the data package's ROOT installs a stylesheet,
      // so the contract id comes from its `/port` entry.
      expect(specifier).not.toBe("@claude-bot/agent-data-view");
    }
  });
});
