/**
 * The App-layer budget, enforced rather than asserted.
 *
 * ── Why a line count is here at all ─────────────────────────────────────────
 *
 * It is not a quality metric. It is a tripwire for ONE regression: the App
 * quietly re-acquiring resource logic. Modularisation is only real if the next
 * feature lands in a module, and the cheapest way for it not to is for somebody
 * to add "just one more effect" to the composition root. A number that fails
 * makes that a decision rather than a drift.
 *
 * Line count alone would be trivially satisfiable, so it is one of four checks:
 *
 *  1. the composition root stays small;
 *  2. no protocol action string appears outside the one adapter;
 *  3. no resource algorithm is re-implemented here;
 *  4. the dependency direction points from the App to the modules, never back,
 *     and never into another App's package.
 *
 * The reuse half of the claim is checked where it belongs — in
 * `@claude-bot/agent-sessions-view`'s harness suite, which renders the same
 * modules over a different provider.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SESSION_ACTIONS } from "@claude-bot/agent-sessions-contract";
import { SESSIONS_MODULES } from "@claude-bot/agent-sessions-view";
import { WORKSPACE_FILES_MODULES } from "@claude-bot/agent-workspace-files-view";
import { createModuleRegistry } from "@claude-bot/agent-view-react/workspace";
import { linkResourceBindings } from "@claude-bot/agent-module-contract";
import { RESOURCE_ACTIONS, WORKSPACE_FILES_CONTRACT } from "@claude-bot/workspace-files-contract";
import { SESSION_PLUS_COMPOSITION, SESSION_PLUS_RESOURCE_BINDINGS, WORKSPACE_BINDING } from "./plan.js";

/** jsdom has no file-URL `import.meta`; locate the tree from the cwd instead. */
const SRC = [
  path.resolve(process.cwd(), "packages/session-plus-view/src"),
  path.resolve(process.cwd(), "src"),
].find((candidate) => existsSync(candidate))!;

/** Lines that are neither blank nor purely a comment. */
function codeLines(file: string): number {
  let inBlock = false;
  let count = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (!line) continue;
    if (line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    count += 1;
  }
  return count;
}

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("Session Plus App architecture", () => {
  it("keeps App.tsx a composition root: at most 160 lines of code", () => {
    expect(codeLines(path.join(SRC, "App.tsx"))).toBeLessThanOrEqual(160);
  });

  it("gives the desktop navigator the whole navigation flow height", () => {
    const css = readFileSync(path.join(SRC, "styles/app.css"), "utf8");
    const desktop = css.slice(css.indexOf("@media (min-width: 721px)"));
    const panel = desktop.match(/\[data-av-dock-flow="navigation"\] > \.av-panel\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(panel).toMatch(/flex:\s*1 1 auto/);
    expect(panel).toMatch(/min-height:\s*0/);
    const navigator = desktop.match(/\[data-av-dock-flow="navigation"\] \.navigator\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(navigator).toMatch(/height:\s*100%/);
    expect(navigator).toMatch(/overflow:\s*hidden/);
  });

  it("keeps the App-owned material theme adaptive and self-contained", () => {
    const css = readFileSync(path.join(SRC, "styles/app.css"), "utf8");
    expect(css).toContain("--sp-material:");
    // Actual material policy and shared-SDK cascade are covered by
    // styles/material.browser.test.ts using the two production bundles.
    expect(css).toContain("@media (prefers-contrast: more)");
    expect(css).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*min-height:\s*44px/);
    expect(css).not.toMatch(/url\(\s*["']?https?:/);
  });

  it("names a protocol action in exactly one file", () => {
    const literals = Object.values(SESSION_ACTIONS);
    const offenders: string[] = [];
    for (const file of sources()) {
      if (path.basename(file) === "adapter.ts") continue;
      const source = readFileSync(file, "utf8");
      for (const action of literals) {
        if (source.includes(`"${action}"`) || source.includes(`'${action}'`)) {
          offenders.push(`${path.relative(SRC, file)} contains "${action}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("re-implements no resource algorithm", () => {
    // The names of the four rules that used to live here. Their presence in this
    // package would mean a second copy of something the modules own.
    const forbidden = [
      /countUnits/,
      /tailNeedsMore/,
      /buildDirTree/,
      /sortRecentSessions/,
      /entriesOf/,
      /groupEntries/,
      /clientFrontier/,
      /workspaceQueue/,
      /handledOperations/,
    ];
    for (const file of sources()) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("depends on the module packages, and nothing depends on it", () => {
    const allowed = [
      /^react(-dom)?(\/.*)?$/,
      /^@claude-bot\/agent-view-react(\/(ui|workspace))?$/,
      // The build recipe's loader half only — `paths.ts` names the digest
      // input type. The `.` entry (the Vite config factory) belongs to
      // `vite.config.ts`, which lives outside `src/`.
      /^@claude-bot\/agent-view-build\/release$/,
      /^@claude-bot\/agent-sessions-view(\/manifests)?$/,
      /^@claude-bot\/agent-workspace-files-view(\/manifests)?$/,
      /^@claude-bot\/agent-editor-view(\/manifests)?$/,
      /^@claude-bot\/agent-crdt-view(\/manifests)?$/,
      /^@claude-bot\/agent-feishu-view(\/(manifests|links))?$/,
      /^@claude-bot\/agent-file-preview$/,
      /^@claude-bot\/agent-sessions-contract$/,
      /^@claude-bot\/agent-module-contract$/,
      /^@claude-bot\/workspace-files-contract$/,
      /^@claude-bot\/crdt-doc-contract$/,
      /^node:/,
      /^\.{1,2}\//,
    ];
    for (const file of sources()) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        if (specifier.endsWith(".css")) continue;
        expect(
          allowed.some((pattern) => pattern.test(specifier)),
          `${path.relative(SRC, file)} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the module plan free of React, so a Node release builder can read it", () => {
    const plan = readFileSync(path.join(SRC, "plan.ts"), "utf8");
    for (const specifier of importsOf(plan)) {
      expect(specifier).not.toMatch(/^react/);
      expect(specifier).not.toMatch(/agent-view-react/);
      // The manifests subpath, not the package root: the root installs a
      // stylesheet, and a Node process cannot import CSS.
      expect(specifier).not.toBe("@claude-bot/agent-sessions-view");
      expect(specifier).not.toBe("@claude-bot/agent-workspace-files-view");
      expect(specifier).not.toBe("@claude-bot/agent-editor-view");
      expect(specifier).not.toBe("@claude-bot/agent-crdt-view");
      expect(specifier).not.toBe("@claude-bot/agent-feishu-view");
    }
  });

  it("re-implements no directory walk or stream loop of its own", () => {
    // The tree and the viewer own these. Their reappearance here is the same
    // regression the four sessions rules above guard against, one layer over.
    for (const file of sources()) {
      const source = readFileSync(file, "utf8");
      for (const pattern of [/visibleRows/, /listDirectory/, /openText\(/, /stream\.next\(/]) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("names no resource action string either", () => {
    // The workspace wire vocabulary belongs to the contract's own remote client.
    // If one of these appears here, the App has started speaking a protocol it
    // is supposed to be handed a typed port for.
    for (const file of sources()) {
      const source = readFileSync(file, "utf8");
      for (const action of Object.values(RESOURCE_ACTIONS)) {
        expect(source.includes(`"${action}"`), `${path.relative(SRC, file)} contains "${action}"`).toBe(false);
      }
    }
  });

  it("refuses a connection to a module that never declared that port", () => {
    // The positive direction — this release's own plan links — is pinned in
    // `plan.test.ts`, next to the documents themselves. What belongs HERE is the
    // negative: supplying the manifests must make a mis-wired connection a
    // refusal rather than a check that silently did not run, because that is the
    // only reason `port` is written out beside `contract` at all.
    const registry = createModuleRegistry([...SESSIONS_MODULES, ...WORKSPACE_FILES_MODULES]);
    const wrong = linkResourceBindings(
      {
        ...SESSION_PLUS_RESOURCE_BINDINGS,
        connections: [{ instance: "chat", port: WORKSPACE_FILES_CONTRACT, binding: WORKSPACE_BINDING }],
      },
      SESSION_PLUS_COMPOSITION,
      registry.manifests(),
    );
    expect(wrong.ok).toBe(false);
  });
});
