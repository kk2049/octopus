/**
 * The dependency boundary, enforced by reading this package's own source.
 *
 * A boundary that only exists in a review comment is not a boundary. The rules
 * are the ones every reusable View module in this repository is held to, plus
 * one that only applies here — and that one is the reason this file matters more
 * than its siblings.
 *
 *  1. **No trusted side.** Importing the bot, the Runner, the capability kernel
 *     or `node:*` would put this untrusted bundle downstream of code that holds
 *     credentials, and a transitive dependency is enough to do it.
 *  2. **No transport.** This module holds a PORT. What is on the other end is
 *     the App's business, and a module that knew would be a module that could be
 *     told an identity.
 *  3. **No SDK root entry.** `@claude-bot/agent-view-react` re-exports the
 *     client and the wire constants; `/ui` and `/workspace` do not.
 *  4. **No resource action vocabulary.** `resource.apply_update` is the wire
 *     spelling of a proposal and the Gate token it costs. A module naming one
 *     would be choosing what to ask a Host for, which is the App's decision and
 *     the App's audit record.
 *  5. **No identity field names.** owner, device, workspace id, path, context,
 *     grant, token. `crdt-doc/v1` does not carry them.
 *  6. **NO Yjs PROVIDER, and no channel of its own.** This is the rule specific
 *     to this package, and it is the one somebody will break by accident: every
 *     example of collaborative editing on the internet says
 *     `new WebsocketProvider(url, room, doc)`. That opens a socket, which
 *     `connect-src 'none'` forbids, from a bundle whose whole premise is that it
 *     has exactly one channel and cannot address anything on it. The forbidden
 *     list below is the ecosystem's provider packages by name, because the
 *     import is what makes it happen — a grep for `new WebSocket` would not
 *     catch `y-websocket`.
 *
 * The harness is held to the same rules: it is a second consumer, and a second
 * consumer that cheated would prove nothing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CRDT_DOC_DECLARATION } from "@claude-bot/crdt-doc-contract";

/**
 * This suite runs in the jsdom project, where `import.meta.url` is not a file
 * URL, so the tree is located from the working directory instead — which is the
 * repository root under `npx vitest run` and this package under a filtered run.
 */
const SRC = [
  path.resolve(process.cwd(), "packages/agent-crdt-view/src"),
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

describe("agent-crdt-view dependency boundary", () => {
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
      /^@claude-bot\/crdt-doc-contract$/,
      // The CRDT itself. It is a data structure, not a transport: `yjs` has no
      // network code at all — that lives in the separate provider packages rule
      // 6 forbids.
      /^yjs$/,
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

  it("imports no Yjs provider, connector or awareness package", () => {
    // Every one of these opens its own connection. `y-protocols/awareness` is in
    // the list even though it does not: presence must not enter the persistent
    // document (§15.4), and there is no channel it could travel on anyway.
    const forbidden = [
      /^y-websocket/,
      /^y-webrtc/,
      /^y-indexeddb/,
      /^y-protocols/,
      /^@hocuspocus\//,
      /^@syncedstore\//,
      /^y-prosemirror/,
      /^y-codemirror/,
      /^y-quill/,
      /^y-monaco/,
    ];
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        for (const pattern of forbidden) {
          expect(pattern.test(specifier), `${path.relative(SRC, file)} imports ${specifier}`).toBe(false);
        }
      }
    }
  });

  it("names no resource action string", () => {
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      for (const action of CRDT_DOC_DECLARATION.actionIds) {
        expect(source.includes(`resource.${action}`), `${path.relative(SRC, file)} names resource.${action}`).toBe(
          false,
        );
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
      /\bcanonicalPath\b/,
      /\bcontextId\b/,
      /\bgrant\b/,
      /\bpendingCallId\b/,
      /\binstanceHandle\b/,
      /\bcsrf\b/,
      /\buseIdentity\b/,
      /\buseOwner\b/,
      /\buseCapability\b/,
      /\bawareness\b/i,
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

  it("uses no timer that would poll", () => {
    // `setTimeout` is allowed — the push debounce needs one — and `setInterval`
    // is not. A recurring pull on this platform is a recurring capability call,
    // and each refused one can be an approval card somebody has to dismiss.
    for (const file of files) {
      const source = code(readFileSync(file, "utf8"));
      expect(/\bsetInterval\b/.test(source), `${path.relative(SRC, file)} calls setInterval`).toBe(false);
    }
  });

  it("keeps the manifest importable without React or a stylesheet", () => {
    // A Node release builder reads it to emit the module lock and the binding
    // plan; it cannot import JSX or CSS.
    for (const specifier of importsOf(readFileSync(path.join(SRC, "manifests.ts"), "utf8"))) {
      expect(specifier).not.toMatch(/^react/);
      expect(specifier).not.toMatch(/agent-view-react/);
      expect(specifier).not.toMatch(/\.css$/);
      expect(specifier).not.toMatch(/^yjs$/);
    }
  });
});
