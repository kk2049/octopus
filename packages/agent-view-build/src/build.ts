/**
 * Deterministic App packaging. Internal Apps emit ESM components and an explicit
 * immutable asset inventory; Dashboard supplies the shared React/UI runtime.
 * Legacy fixtures without appId retain the two-file inline IIFE format.
 * Both formats verify source and output digests before publication.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import react from "@vitejs/plugin-react";
import postcss from "postcss";
import { scopeAppCss } from "@claude-bot/agent-view-build/scope-css";
import { APP_RUNTIME_IMPORTS, APP_RUNTIME_ABI, APP_MODULE_SCHEMA } from "@claude-bot/agent-view-build/runtime";
import type { Plugin, UserConfig } from "vite";
// A package self-reference rather than `./release.js`. This module is loaded by
// Vite while it reads a config file, and Vite externalises anything under
// `node_modules` — including a workspace link — so Node itself resolves this
// import. Node has no `.js` → `.ts` rewriting; the subpath in this package's
// own `exports` map is the one form that resolves identically under Node, Vite,
// Vitest and tsc.
import {
  AGENT_VIEW_BUILDER,
  APP_MODULE_BUILDER,
  AGENT_VIEW_MANIFEST_FILE,
  agentViewSourceDigest,
  sha256Hex,
  type AgentViewBuildManifest,
  type AgentViewSourceInput,
} from "@claude-bot/agent-view-build/release";
import { renderAgentViewThemeCss } from "@claude-bot/agent-view-build/theme-tokens";

export interface AgentViewBuildOptions {
  /** Internal App ESM release; omitted only for legacy preview fixtures. */
  appId?: string;
  /** The App's browser entry, relative to the package root. */
  entry: string;
  /** Where the two outputs and the manifest are written. Default `dist`. */
  outDir?: string;
  /** Global name for the IIFE wrapper; never referenced by the document. */
  globalName?: string;
  /** Output file names. Fixed, not hashed — content addressing happens upstream. */
  jsFileName?: string;
  cssFileName?: string;
  /**
   * Everything whose bytes decide the output: this package's sources, the SDK's
   * sources, and any manifest that pins a dependency. Hashed into the build
   * manifest so a stale build is detectable rather than merely unlikely.
   */
  source: AgentViewSourceInput;
}

interface Resolved {
  outDir: string;
  js: string;
  css: string;
}

/**
 * The whole Vite config for an Agent View.
 *
 * A factory rather than a document to copy: the properties above are the
 * boundary, and a second App that copied a config would inherit the shape
 * without the checks.
 */
export function agentViewViteConfig(options: AgentViewBuildOptions): UserConfig {
  const resolved: Resolved = {
    outDir: options.outDir ?? "dist",
    js: options.jsFileName ?? "agent-view.js",
    css: options.cssFileName ?? "agent-view.css",
  };
  if (!resolved.css.endsWith(".css")) throw new Error("agent view cssFileName must end with .css");
  if (options.appId && !/^[a-z][a-z0-9-]{0,63}$/.test(options.appId)) throw new Error("invalid App id");
  return {
    base: "./",
    worker: { format: "es", rollupOptions: { output: { entryFileNames: "worker-[name]-[hash].js", chunkFileNames: "worker-chunk-[name]-[hash].js", assetFileNames: "worker-asset-[name]-[hash][extname]" } } },
    plugins: [agentViewThemeTokensPlugin(), react(), agentViewReleasePlugin(options, resolved)],
    // No downstream bundler exists; see the header.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      target: "es2022",
      outDir: resolved.outDir,
      emptyOutDir: true,
      // A sourcemap would be a second file the publication origin cannot serve,
      // and a data-URL one would inline the App's whole source into the digest.
      sourcemap: false,
      // Zero, so nothing quietly becomes a `data:` blob inside the CSS. Any
      // real asset should fail the "exactly two outputs" check instead.
      assetsInlineLimit: 0,
      cssCodeSplit: false,
      reportCompressedSize: false,
      rollupOptions: options.appId ? {
        external: [...APP_RUNTIME_IMPORTS],
        output: { chunkFileNames: "chunk-[name]-[hash].js", assetFileNames: (asset) => asset.names.some((name) => name.endsWith(".css")) ? resolved.css : "asset-[name]-[hash][extname]" },
      } : undefined,
      lib: {
        entry: options.entry,
        // Current Apps export a component. Only legacy fixtures execute an IIFE.
        formats: [options.appId ? "es" : "iife"],
        name: options.globalName ?? "AgentView",
        fileName: () => resolved.js,
        cssFileName: resolved.css.replace(/\.css$/, ""),
      },
    },
  };
}

/** Inject generated tokens at the SDK stylesheet entry Vite actually loads. */
function agentViewThemeTokensPlugin(): Plugin {
  const marker = "/* @claude-bot/agent-view-build:theme-tokens */";
  return {
    name: "agent-view-theme-tokens",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      const clean = id.split("?", 1)[0].replaceAll("\\", "/");
      if (!clean.endsWith("/agent-view-react/src/styles-index.css")) return null;
      if (!code.includes(marker)) {
        throw new Error("Agent View stylesheet no longer contains the theme-token build marker");
      }
      const generated = `@layer agent-view-base {\n${renderAgentViewThemeCss()}\n}`;
      return { code: code.replace(marker, generated), map: null };
    },
  };
}

function agentViewReleasePlugin(options: AgentViewBuildOptions, resolved: Resolved): Plugin {
  return {
    name: "agent-view-release",
    apply: "build",
    renderChunk: {
      order: "post",
      handler(code) {
        return { code: escapeInlineScriptMarkup(code), map: null };
      },
    },
    // `writeBundle` rather than `generateBundle`: the manifest must describe the
    // bytes that are ON DISK, because those are the bytes the loader reads and
    // the digest covers.
    writeBundle: {
      sequential: true,
      order: "post",
      handler(outputOptions) {
        const outDir = outputOptions.dir ?? path.resolve(resolved.outDir);
        const expected = [resolved.js, resolved.css];
        if (options.appId) {
          const cssPath = path.join(outDir, resolved.css);
          const cssSource = readFileSync(cssPath, "utf8");
          // Different styles may coexist, while test-only source changes must
          // not manufacture a different CSS release from identical output.
          const scope = `${options.appId}--${sha256Hex(cssSource).slice(0, 16)}`;
          const css = postcss.parse(cssSource);
          scopeAppCss(css, scope);
          writeFileSync(cssPath, css.toString());
          const assets = readdirSync(outDir).filter((name) => name !== AGENT_VIEW_MANIFEST_FILE).sort();
          for (const name of assets) {
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:js|mjs|css|json|svg)$/.test(name)) {
              throw new Error(`App release requires a named UTF-8 asset: ${name}`);
            }
          }
          writeFileSync(path.join(outDir, "agent-view.entry.json"), JSON.stringify({
            schema: APP_MODULE_SCHEMA, runtime: APP_RUNTIME_ABI, appId: options.appId, scope,
            entry: resolved.js, styles: [resolved.css], assets,
          }) + "\n");
          expected.push(...assets.filter((name) => !expected.includes(name)), "agent-view.entry.json");
        }
        const emitted = readdirSync(outDir).filter((name) => name !== AGENT_VIEW_MANIFEST_FILE).sort();
        const unexpected = emitted.filter((name) => !expected.includes(name));
        if (unexpected.length) {
          throw new Error(
            `agent view build emitted files the publication origin cannot serve: ${unexpected.join(", ")}. `
              + "The View is one inlined document; a chunk, a sourcemap or a referenced asset has to be "
              + "removed or inlined at the source.",
          );
        }
        const outputs = expected.map((name) => {
          const bytes = readFileSync(path.join(outDir, name));
          const text = bytes.toString("utf8");
          if (!options.appId) checkEmbeddable(name, text);
          if (name.endsWith(".js") && text.includes("process.env.NODE_ENV")) {
            throw new Error(
              "agent view build left `process.env.NODE_ENV` in the bundle; the frame has no `process`, "
                + "so the first render would throw. Check the `define` in agentViewViteConfig().",
            );
          }
          if (!options.appId && name.endsWith(".css") && !text.includes("--av-fg:")) {
            throw new Error(
              "agent view build did not include the generated theme registry; "
                + "keep the theme-token build marker in the Agent View SDK stylesheet entry",
            );
          }
          return { name, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
        });
        const manifest: AgentViewBuildManifest = {
          schema: 1,
          builder: options.appId ? APP_MODULE_BUILDER : AGENT_VIEW_BUILDER,
          sourceDigest: agentViewSourceDigest(options.source),
          outputs,
        };
        writeFileSync(
          path.join(outDir, AGENT_VIEW_MANIFEST_FILE),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );
      },
    },
  };
}

/**
 * Preserve JavaScript semantics while making a classic inline script safe to
 * place verbatim inside HTML. Language parsers legitimately carry HTML comment
 * tokens in strings and regular expressions; hexadecimal `<` works in both.
 */
export function escapeInlineScriptMarkup(code: string): string {
  return code
    .replaceAll("<!--", "\\x3c!--")
    // `</style>` cannot close a script, but escaping it keeps the complete
    // release document's raw closing-tag count exact when a renderer carries
    // SVG style markup as a JavaScript string.
    .replace(/<\/(?:script|style)/gi, (closing) => `<\\/${closing.slice(2)}`);
}

/**
 * Refuse output that cannot be inlined with one auditable script/style pair.
 *
 * `</script` inside the JS, or `</style` inside the CSS, ends the element early
 * — the browser then parses the remainder as markup and the frame comes up
 * blank. A `</style` string inside JS does not close the script, but obscures
 * the exact raw closing-tag count that audits this single-document shape.
 * `<!--` starts an HTML comment inside a classic script.
 */
function checkEmbeddable(name: string, text: string): void {
  const closing = name.endsWith(".css") ? /<\/style/i : /<\/(?:script|style)/i;
  if (closing.test(text) || text.includes("<!--")) {
    throw new Error(
      `agent view build produced ${name} containing a raw inline-markup sentinel `
        + "(</script, </style or <!--). It cannot be published as one auditable document until that is escaped at "
        + "the source.",
    );
  }
}
