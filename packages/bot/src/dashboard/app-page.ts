import { createHash } from "node:crypto";
/**
 * The HTML document every panel page is.
 *
 * ── Why the server still renders a document per page ────────────────────────
 *
 * It would be simpler to serve one `index.html` for everything and let the
 * browser sort it out. That would also throw away the panel's per-page
 * authorization: today a request for `/tickets` from somebody without `dev`
 * gets a 403, and a request for a page this composition does not build gets a
 * 404. A blanket SPA fallback turns both into 200 + a rendered screen, and the
 * refusal only reappears later, as a failed XHR, if it reappears at all.
 *
 * So the shell is composed here, AFTER `authorizeRoute` has answered, and it
 * carries the route id it was authorised for. There is no wildcard fallback:
 * `/ui/*` serves the bundle, `/api/*` serves the API, and every other path is
 * either a page the router matched or a 404.
 *
 * ── What goes in the document, and what may not ─────────────────────────────
 *
 * One `<script type="module" src>` from `/ui/`, one stylesheet, and JSON data
 * blocks. No executable inline script at all, which is why the CSP can be
 * `script-src 'self'` with no nonce for executable code and no `unsafe-inline`.
 * The payload carries trusted identity CONTEXT — who the server decided is
 * asking, which pages it serves them — and no credential: not the bearer, not
 * the session id, not the CSRF value (only the cookie names, which the browser
 * reads back out of its own jar).
 */

import {
  BOOTSTRAP_ELEMENT_ID,
  APP_INSTANCE_ELEMENT_ID,
  type DashboardBootstrap,
} from "@claude-bot/dashboard-web/contract";
import { bundleManifest, type BundleManifest } from "./assets.js";

/**
 * JSON that is safe to inline in a `<script>` element.
 *
 * `<` is escaped so `</script>` cannot appear however the data is shaped, and
 * the two Unicode line separators are escaped because they terminate a
 * JavaScript line while being perfectly legal inside a JSON string.
 */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

export interface AppPageOptions {
  title: string;
  bootstrap: DashboardBootstrap;
  /**
   * This tab's Agent View instance handle, in its own data block.
   *
   * Separate from the bootstrap on purpose: the app reads it exactly once and
   * removes the element, so its only lasting copy in the browser is a
   * module-private binding. It never enters a URL, a body, an attribute or the
   * frame.
   */
  appInstance?: string;
  manifest?: BundleManifest;
}

export function renderAppPage(options: AppPageOptions): string {
  const manifest = options.manifest ?? bundleManifest();
  const styles = manifest.styles
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join("\n");
  const importMap = manifest.imports ? `<script type="importmap">${inlineJson({ imports: manifest.imports })}</script>` : "";
  const instance = options.appInstance
    ? `<script type="application/json" id="${APP_INSTANCE_ELEMENT_ID}">${inlineJson(
        options.appInstance,
      )}</script>`
    : "";
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title>${escapeHtml(options.title)}</title>
${styles}
${importMap}
<script type="application/json" id="${BOOTSTRAP_ELEMENT_ID}">${inlineJson(options.bootstrap)}</script>
${instance}
</head>
<body>
<div id="root"></div>
<script type="module" src="${escapeHtml(manifest.script)}"></script>
<noscript>这个面板需要 JavaScript。</noscript>
</body>
</html>`;
}

/**
 * The inverse of {@link renderAppPage}: pull the payload back out of a document.
 *
 * Exported for tests, and deliberately for tests. Every assertion about what a
 * page offers a viewer — which tabs, which pages, whether an approval control
 * exists — used to be a string match against rendered markup, which meant a
 * cosmetic change to an anchor could quietly delete the coverage. Reading the
 * payload asks the question the server actually answered.
 */
export function readBootstrapPayload(html: string): DashboardBootstrap {
  const match = new RegExp(
    `<script type="application/json" id="${BOOTSTRAP_ELEMENT_ID}">([\\s\\S]*?)</script>`,
  ).exec(html);
  if (!match) throw new Error("document carries no bootstrap payload");
  return JSON.parse(match[1]) as DashboardBootstrap;
}

/** The import map is inert module configuration with exact CSP-authorized bytes. */
export function appPageScriptCsp(manifest: BundleManifest = bundleManifest()): string {
  if (!manifest.imports) return "script-src 'self'";
  const hash = createHash("sha256").update(inlineJson({ imports: manifest.imports })).digest("base64");
  return `script-src 'self' 'sha256-${hash}'`;
}
