/**
 * The dependency boundary, enforced by reading this package's own source.
 *
 * Six rules are the ones every reusable View module package keeps: no trusted
 * side, no transport, no SDK root entry, no literal action id, no identity
 * field, no channel of its own. The seventh is this module's reason to exist
 * (ADR 0007 principle 5): `board.grid` is GENERIC. No game name, no piece name,
 * no rule vocabulary may appear in the shipped code — a module that could say
 * "chess" would be a module about to learn what a rule gate already knows.
 *
 * The allowed dependency on `@claude-bot/agent-data-view` follows the
 * `agent-deck-view` precedent: the `app-data/v1` PORT and the one provider over
 * it, so one App mounts one subscription for every module family.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/** Located from cwd: repo root under `npx vitest run`, the package when filtered. */
const SRC = [
  path.resolve(process.cwd(), "packages/agent-board-view/src"),
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

describe("agent-board-view dependency boundary", () => {
  const files = sources();

  it("finds the modules it is supposed to be checking", () => {
    expect(files.length).toBeGreaterThan(3);
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
      // The `app-data/v1` port and the ONE provider over it. See the header.
      /^@claude-bot\/agent-data-view(\/port)?$/,
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

  it("knows no game", () => {
    // Geometry words (board, grid, cell, move) are the module's own vocabulary;
    // these are the words that would mean it has learned somebody's rules.
    const forbidden = [
      /\bchess\b/i, /\bcheckers\b/i, /\bgomoku\b/i, /\bothello\b/i, /\breversi\b/i, /\bshogi\b/i,
      /\bxiangqi\b/i, /\bpawn\b/i, /\brook\b/i, /\bbishop\b/i, /\bknight\b/i, /\bqueen\b/i, /\bking\b/i,
      /\bcheckmate\b/i, /\bcastling\b/i, /\bcapture\b/i, /\bplayer\b/i, /\bopponent\b/i, /\bwinner\b/i,
      /\bturn\b/i, /\blegal\b/i, /\billegal\b/i,
      /棋/, /将军/, /吃子/, /回合/, /胜负/, /黑方/, /白方/,
    ];
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("mentions no identity field the contract does not carry", () => {
    const forbidden = [
      /\bownerName\b/, /\busername\b/, /\bcredential\b/, /\bdeviceId\b/, /\bworkspaceId\b/,
      /\bcanonicalPath\b/, /\bcontextId\b/, /\bgrant\b/, /\bpendingCallId\b/, /\binstanceHandle\b/,
      /\bcsrf\b/, /\buseIdentity\b/, /\buseOwner\b/, /\buseCapability\b/,
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
    // A Node release builder reads them for the module lock; it cannot import
    // JSX or CSS — including transitively: the data package's ROOT installs a
    // stylesheet, so the contract id must come from its `/port` entry.
    for (const specifier of importsOf(readFileSync(path.join(SRC, "manifests.ts"), "utf8"))) {
      expect(specifier).not.toMatch(/^react/);
      expect(specifier).not.toMatch(/agent-view-react/);
      expect(specifier).not.toMatch(/\.css$/);
      expect(specifier).not.toBe("@claude-bot/agent-data-view");
    }
  });
});
