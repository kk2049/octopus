/**
 * The dependency boundary, enforced by reading this package's own source.
 *
 * The same five rules `agent-workspace-files-view` is held to, because this
 * package sits in exactly the same place — an untrusted bundle holding a typed
 * port — plus one that is specific to it: the third-party editor belongs to the
 * shared presentation package and must not leak back into this stateful module.
 *
 *  1. **No trusted side.** Importing the bot, the Runner, the capability kernel
 *     or `node:*` would put this untrusted bundle downstream of code that holds
 *     credentials, and a transitive dependency is enough to do it.
 *  2. **No transport.** This module holds a PORT. What is on the other end is
 *     the App's business, and a module that knew could be told an identity.
 *  3. **No SDK root entry.** `/ui` and `/workspace` are presentation and layout;
 *     the root re-exports the client and the wire constants.
 *  4. **No resource action vocabulary.** `resource.replace_text` is the wire
 *     spelling of a proposal and the Gate token it costs. Naming one would be
 *     this module choosing what to ask a Host for.
 *  5. **No identity field names.** owner, device, workspace id, relative path,
 *     canonical path, grant, token — `workspace-files/v1` does not carry them.
 *  6. **CodeMirror is behind agent-text-view.** This module owns draft/save/CAS;
 *     the reusable presentation package owns the editor integration. The local
 *     `CodeSurface` export stays only as compatibility chrome.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RESOURCE_ACTIONS } from "@claude-bot/workspace-files-contract";

const SRC = [
  path.resolve(process.cwd(), "packages/agent-editor-view/src"),
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
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

/** Strip block and line comments, so prose about a rule does not break it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

describe("agent-editor-view dependency boundary", () => {
  const files = sources();

  it("finds the modules it is supposed to be checking", () => {
    expect(files.length).toBeGreaterThan(4);
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

  it("depends only on the SDK's narrow entries, the contracts, and shared text presentation", () => {
    const allowed = [
      /^react(-dom)?(\/.*)?$/,
      // Presentation and layout only. The root entry re-exports the transport.
      /^@claude-bot\/agent-view-react\/(ui|workspace)$/,
      /^@claude-bot\/agent-module-contract$/,
      /^@claude-bot\/workspace-files-contract$/,
      /^@claude-bot\/resource-stream-contract$/,
      /^@claude-bot\/agent-workspace-files-view(\/harness)?$/,
      /^@claude-bot\/agent-text-view$/,
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

  it("uses CodeMirror only through the shared text surface", () => {
    for (const file of files) {
      const uses = importsOf(readFileSync(file, "utf8")).filter((specifier) => specifier.startsWith("@codemirror/"));
      const relative = path.relative(SRC, file).split(path.sep).join("/");
      expect(uses, `${relative} imports ${uses.join(", ")}`).toEqual([]);
    }
    const wrapper = readFileSync(path.join(SRC, "components/CodeSurface.tsx"), "utf8");
    expect(importsOf(wrapper)).toContain("@claude-bot/agent-text-view");
  });

  it("names no resource action string", () => {
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      for (const action of Object.values(RESOURCE_ACTIONS)) {
        expect(source.includes(action), `${path.relative(SRC, file)} contains ${action}`).toBe(false);
      }
      expect(/\bstream_pull\b|\bstream_close\b/.test(source)).toBe(false);
    }
  });

  it("mentions no identity or path field the contract does not carry", () => {
    const forbidden = [
      /\bownerName\b/,
      /\busername\b/,
      /\bcredential\b/,
      /\bdeviceId\b/,
      /\bworkspaceId\b/,
      /\bworkspace_id\b/,
      /\brelativePath\b/,
      /\brelative_path\b/,
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

  it("keeps the manifest importable without React, the text surface or a stylesheet", () => {
    // A Node release builder reads it to emit the module lock and the binding
    // plan; it cannot import JSX, a CSS file or an editor.
    for (const specifier of importsOf(readFileSync(path.join(SRC, "manifests.ts"), "utf8"))) {
      expect(specifier).not.toMatch(/^react/);
      expect(specifier).not.toMatch(/agent-view-react/);
      expect(specifier).not.toMatch(/agent-text-view/);
      expect(specifier).not.toMatch(/^@codemirror/);
      expect(specifier).not.toMatch(/\.css$/);
    }
  });

  it("never re-issues a call by itself", () => {
    // Every call here crosses a capability Gate, and one the Gate refuses MAKES
    // AN APPROVAL CARD. A timer, an interval or a retry in this package would be
    // a stream of cards in front of somebody who already has one.
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      for (const pattern of [/setInterval\(/, /setTimeout\(/, /requestIdleCallback\(/, /\bretry\b/i]) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });
});
