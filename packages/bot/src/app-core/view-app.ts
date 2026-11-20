import { moduleAssetName } from "@claude-bot/agent-view-build/module-assets";
/**
 * The Agent View package — the UNTRUSTED half, served from its own origin.
 *
 * ── What this file is now ───────────────────────────────────────────────────
 *
 * A loader and a document template. The View itself is React, and it lives in
 * `packages/session-plus-view` (built on the reusable
 * `@claude-bot/agent-view-react` runtime). This module reads the compiled
 * bundle, presents it as the named assets the release identity is taken over,
 * and inlines it into one document.
 *
 * It used to BE the View: two template literals holding hand-written CSS and
 * ES5-flavoured browser JS that built HTML with string concatenation and
 * `innerHTML`, whose XSS safety rested on every call site remembering `esc()`
 * first. That is gone. What has not changed is anything the boundary depends
 * on — same named assets, same digest, same one-document publication, same
 * CSP confinement. New digest-addressed releases use content hashes so their
 * one immutable document is cacheable; the renderer still accepts the previous
 * nonce template so already-installed releases remain servable while draining.
 *
 * ── What the code in that frame is allowed to be ────────────────────────────
 *
 * It runs where its script cannot read a cookie (opaque origin —
 * `document.cookie` throws — and the panel's cookies are host-only next door
 * anyway), cannot reach the parent DOM (cross-origin), cannot open an active
 * connection (`connect-src 'none'` blocks fetch, XHR, WebSocket and
 * EventSource), cannot submit a form, cannot open a popup, cannot navigate the
 * TOP window, and does not know who is logged in. The only SUPPORTED channel is
 * the `MessagePort` the trusted shell transfers in after the frame announces
 * itself.
 *
 * Two things it can still do:
 *
 *   · **navigate ITSELF.** No sandbox token and no CSP directive available in
 *     Chrome 1.62 removes that. Where it may go is bounded by the embedder's
 *     exact `frame-src` (external origins are refused), and its own origin
 *     publishes one document and refuses every other target without recording
 *     it — see `view-server.ts`.
 *   · **be observed making that request.** We remove the record, not the
 *     packet.
 *
 * So the honest way to read it is: assume it is hostile and check what it could
 * do. It can render nonsense, propose actions with any fields it likes and
 * wedge itself. Frame geometry is Host-owned. Boundary tests inject forged
 * identity fields and prove that none of them reaches the same-origin
 * coordinator.
 *
 * ── Why the package is still a set of named assets ──────────────────────────
 *
 * `viewAssetDigest` is taken over exactly these strings. `packageDigest` then
 * combines them with the App declaration/backend assets and the canonical
 * release recipe, and that complete digest decides the hostname
 * (`app-<first-20-hex>.apps.…`). Editing a React component still changes the
 * URL — which is the property that makes "which code is in that frame"
 * answerable from the address bar rather than from a deployment log. The
 * rendered document is deterministic and covered indirectly by the digested
 * template plus the two compiled assets.
 *
 * ── Why loading is lazy, and what happens when the build is missing ─────────
 *
 * Before React the bytes were module constants, so "the code and its name
 * agree" was true by construction. Now they are build output, which can be
 * absent or — worse — STALE, because a stale build is internally consistent:
 * the digest matches those bytes, the hostname matches that digest, the frame
 * loads, and the only thing wrong is that it is not the code in the tree.
 * `loadAgentViewRelease` refuses both, naming the command that fixes it.
 *
 * That refusal is deliberately raised at FIRST USE rather than at import.
 * Importing this module must not require a built View: `identity.ts` imports it
 * for a type, several tests pass their own package, and a bootstrap that never
 * enables Session Plus never needs the bytes at all. Anything that actually
 * publishes or digests the real package calls `viewPackage()` and gets the loud
 * answer there.
 */

import { createHash } from "node:crypto";
import { loadAgentViewRelease } from "@claude-bot/agent-view-build/release";
import {
  SESSION_PLUS_VIEW_BUILD_COMMAND,
  SESSION_PLUS_VIEW_DIST,
  SESSION_PLUS_VIEW_SOURCE,
} from "@claude-bot/session-plus-view";

/**
 * The canonical document template is digested as a named release asset. The
 * renderer below does NOT perform sentinel replacement: arbitrary CSS or JS is
 * allowed to contain `%CSS%`/`%JS%` as ordinary bytes, so each static segment is
 * concatenated exactly once around the two assets.
 *
 * The script is a classic inline script, not a module: the compiled bundle is
 * an IIFE for exactly this reason. One document, one script element, one style
 * element. Their exact UTF-8 contents are named in CSP by SHA-256; unlike a
 * nonce, those sources and the document bytes are stable for this release.
 */
const BEFORE_STYLE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title>session-plus · agent view</title>
<style>`;
const BETWEEN_STYLE_AND_SCRIPT = `</style>
</head>
<body>
<div id="root"><div class="banner">⏳ 等待可信外层转交通道…</div></div>
<script>`;
const AFTER_SCRIPT = `</script>
</body>
</html>
`;

export const VIEW_APP_HTML =
  BEFORE_STYLE + "%CSS%" + BETWEEN_STYLE_AND_SCRIPT + "%JS%" + AFTER_SCRIPT;

/** The response facts the static View listener needs to build CSP and caching. */
export type PublishedViewDocument =
  | { body: string; policy: { kind: "hash"; scriptHash: string; styleHash: string }; immutable: true }
  | { body: string; policy: { kind: "nonce"; nonce: string }; immutable: false };

export type ParsedViewTemplate =
  | { kind: "hash"; segments: [string, string, string] }
  | { kind: "nonce"; segments: [string, string, string, string, string] };

/** One named asset of the served package. Order is part of the digest. */
export interface PackageAsset {
  name: string;
  source: string;
}

export interface AppPackage {
  assets: readonly PackageAsset[];
}

interface BuiltView {
  css: string;
  js: string;
  pkg: AppPackage;
}

let built: BuiltView | null = null;

/**
 * The compiled View, loaded once.
 *
 * Memoised because the bytes cannot change while the process runs: the loader
 * has already proved they match both the build manifest and the source tree, so
 * re-reading them would only add a way for the answer to change mid-process.
 */
function load(): BuiltView {
  if (built) return built;
  const release = loadAgentViewRelease({
    distDir: SESSION_PLUS_VIEW_DIST,
    source: SESSION_PLUS_VIEW_SOURCE,
    buildCommand: SESSION_PLUS_VIEW_BUILD_COMMAND,
    expectedOutputs: ["agent-view.js", "agent-view.css"],
    allowModuleAssets: true,
  });
  const asset = (name: string): string => {
    const found = release.assets.find((entry) => entry.name === name);
    if (!found) {
      throw new Error(
        `Agent View 产物缺少 ${name}；构建清单里没有它。请重新构建：${SESSION_PLUS_VIEW_BUILD_COMMAND}`,
      );
    }
    return found.source;
  };
  const css = asset("agent-view.css");
  const js = asset("agent-view.js");
  built = {
    css,
    js,
    // The asset NAMES are part of the digest, and they stay `view.*` across the
    // React migration on purpose: they name the role in the published package
    // ("the document, its style, its script"), not the file the build tool
    // happened to write. Their CONTENT changed, which is what moves the digest
    // and therefore the hostname — exactly the signal a release change should
    // produce.
    pkg: {
      assets: [
        { name: "view.html", source: VIEW_APP_HTML },
        { name: "view.css", source: css },
        { name: "view.js", source: js },
        ...release.assets.filter((row) => !["agent-view.js", "agent-view.css"].includes(row.name)).map((row) => ({ name: moduleAssetName(row.name), source: row.source })),
      ],
    },
  };
  return built;
}

/** Exactly what is served, and exactly what `packageDigest()` is taken over. */
export function viewPackage(): AppPackage {
  return load().pkg;
}

/** Pure composer used by the server and by collision regression tests. */
export function composeViewDocument(css: string, js: string): PublishedViewDocument {
  return composeViewDocumentFrom(VIEW_APP_HTML, "unused-for-hash-template", css, js);
}

/**
 * The one place the `%NONCE%`/`%CSS%`/`%JS%` grammar is interpreted.
 *
 * The template is a RELEASE ASSET — an installed release carries its own — so
 * the server cannot keep using this build's constant and call the result that
 * release's document. What it must not do either is a substitution pass over the
 * finished string: arbitrary CSS or JS may contain those tokens as ordinary
 * bytes, and a `replace()` would then rewrite publisher code.
 *
 * So the TEMPLATE is split, exactly once, on a fixed grammar that must appear
 * exactly once in exactly this order, and the four values are concatenated
 * between the resulting static segments. No value is ever scanned.
 */
export function composeViewDocumentFrom(
  template: string,
  nonce: string,
  css: string,
  js: string,
): PublishedViewDocument {
  const parsed = splitViewTemplate(template);
  if (parsed.kind === "hash") {
    const parts = parsed.segments;
    return {
      body: parts[0] + css + parts[1] + js + parts[2],
      policy: { kind: "hash", scriptHash: sha256(js), styleHash: sha256(css) },
      immutable: true,
    };
  }
  if (!/^[A-Za-z0-9+/=_-]{8,}$/.test(nonce)) throw new Error("session-plus view: refusing a suspicious nonce");
  const parts = parsed.segments;
  return {
    body: parts[0] + nonce + parts[1] + css + parts[2] + nonce + parts[3] + js + parts[4],
    policy: { kind: "nonce", nonce },
    immutable: false,
  };
}

/**
 * Five static segments, or a refusal.
 *
 * A template with the wrong number of placeholders, or with them in the wrong
 * order, is refused rather than rendered partially: a document that carries a
 * nonce where the style should go loads with no styles and no error, and a
 * document missing the second nonce loads with a script the CSP silently
 * refuses. Both look like "the App is broken", which is the wrong diagnosis.
 */
export function splitViewTemplate(template: string): ParsedViewTemplate {
  const nonceCount = (template.match(/%NONCE%/g) ?? []).length;
  const order = nonceCount === 0
    ? (["%CSS%", "%JS%"] as const)
    : (["%NONCE%", "%CSS%", "%NONCE%", "%JS%"] as const);
  if (nonceCount !== 0 && nonceCount !== 2) {
    throw new Error("session-plus view: template must use either content hashes or exactly two nonces");
  }
  const segments: string[] = [];
  let rest = template;
  for (const token of order) {
    const at = rest.indexOf(token);
    if (at < 0) throw new Error(`session-plus view: template is missing ${token}`);
    segments.push(rest.slice(0, at));
    rest = rest.slice(at + token.length);
  }
  segments.push(rest);
  const total = nonceCount + (template.match(/%CSS%/g) ?? []).length
    + (template.match(/%JS%/g) ?? []).length;
  if (total !== order.length) throw new Error("session-plus view: template has extra placeholders");
  return nonceCount === 0
    ? { kind: "hash", segments: segments as [string, string, string] }
    : { kind: "nonce", segments: segments as [string, string, string, string, string] };
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("base64");
}

/** Render this checkout's immutable, digest-addressed document. */
export function renderViewDocument(nonce: string): PublishedViewDocument {
  const view = load();
  return composeViewDocumentFrom(VIEW_APP_HTML, nonce, view.css, view.js);
}
