/**
 * The document's style nonce, for a library that injects a `<style>` at runtime.
 *
 * ── The problem this exists for ────────────────────────────────────────────
 *
 * An Agent View document is served under `style-src 'nonce-<n>'` (see
 * `viewFrameCsp` in `@claude-bot/web-trust`): exactly one stylesheet — the one
 * the release inlined — is allowed, and every other `<style>` the page creates
 * is dropped by the browser. That is deliberate, and it is not going to be
 * relaxed: `'unsafe-inline'` would let injected markup restyle the frame.
 *
 * Most of this SDK's UI is ordinary CSS in the bundle, so the question never
 * came up. It comes up the moment a module uses a library that ships its own
 * base styles as CSS-in-JS — CodeMirror is the first one — because such a
 * library builds a `<style>` element while it initialises. Blocked, it does not
 * throw: the widget renders unstyled, which for an editor means a broken
 * caret, no line numbers and text that overflows its pane. Silent, and only in
 * a real browser.
 *
 * ── Why reading it here is not a new capability ────────────────────────────
 *
 * The nonce belongs to the document this bundle is ALREADY running inside: the
 * script executing this line is the one the release inlined under that nonce.
 * Learning it grants nothing that code cannot already do by simply running. It
 * is captured at module-evaluation time, while `document.currentScript` still
 * refers to that element, and kept in a module-private binding rather than
 * looked up later — the same shape the trusted page uses for its instance
 * handle, and the shape `__webpack_nonce__` has had for years.
 *
 * It is deliberately NOT re-read on demand: a later lookup would be a function
 * that hands the nonce to whoever asks, including code that arrived after
 * startup.
 */

/**
 * Read the nonce off the script element that is currently executing.
 *
 * The content attribute is hidden from script by the CSP spec (`getAttribute`
 * returns ""), while the IDL property still answers — so this reads the
 * property, and returns "" everywhere else (a test, a Node import, a document
 * that was not composed this way).
 */
function readNonce(): string {
  if (typeof document === "undefined") return "";
  const current = document.currentScript as (HTMLScriptElement & { nonce?: string }) | null;
  const value = current?.nonce;
  // Bounded and shaped like a nonce, or nothing. A value from an unexpected
  // document should become "no nonce" rather than an attribute this SDK hands
  // to a third-party library to write into the DOM.
  return typeof value === "string" && /^[A-Za-z0-9+/=_-]{8,128}$/.test(value) ? value : "";
}

const NONCE = readNonce();

/**
 * The nonce this document's inline styles carry, or `""` when there is none.
 *
 * A module passes it to whatever needs it (CodeMirror's `EditorView.cspNonce`,
 * for instance). `""` is the honest answer outside a released frame, and every
 * consumer must treat it as "do not set the attribute" rather than as a value.
 */
export function documentStyleNonce(): string {
  return NONCE;
}

/**
 * The other half: what to do when the document has no nonce to give.
 *
 * ── Why "" is the NORMAL answer in production (ticket #253) ────────────────
 *
 * A PUBLISHED release document is immutable and cached for a year, so it cannot
 * carry a per-response nonce — a cached body would pair with a later response's
 * header. `viewFrameCsp` therefore serves the published shape as
 * `script-src 'sha256-…'; style-src 'sha256-…'`, and the inlined tags carry no
 * nonce attribute at all. Every deployed Agent View is that shape. So
 * `documentStyleNonce()` returns "" not as an edge case but as the rule, and
 * everything a library injects at runtime is refused — silently, because a
 * blocked stylesheet is not an error, it is an element whose `.sheet` is null.
 *
 * Build-time CSS is unaffected (the release's own stylesheet is the hash), and
 * antd's is extracted into it. CodeMirror's is not: `style-mod` builds it while
 * the editor initialises, from class names generated in that same run.
 *
 * ── Why a constructed stylesheet is the right repair ───────────────────────
 *
 * `style-src` governs MARKUP — `<style>`, `<link>`, `style=` attributes. It is
 * what stops content this frame renders (a Markdown transcript, an agent's
 * output) from restyling the frame, and that is still enforced. A
 * `CSSStyleSheet` built by this bundle and adopted through CSSOM is not markup
 * and cannot be reached by rendered content; it is the platform's own path for
 * a library that generates its CSS at runtime, and `style-mod` already takes it
 * when its root is a ShadowRoot. Adopting here changes nothing about what
 * injected content can do, and nothing about which BYTES are trusted: they are
 * the same bytes the release digest already covers.
 *
 * Returns false when the platform has no constructable stylesheets, which is
 * exactly today's behaviour rather than a worse one.
 */
const ADOPTED = new Set<string>();

export function adoptDocumentStyles(css: string): boolean {
  if (!css || typeof document === "undefined") return false;
  if (ADOPTED.has(css)) return true;
  if (typeof CSSStyleSheet !== "function" || !Array.isArray(document.adoptedStyleSheets)) return false;
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    // `replaceSync`, never `replace`: a sheet that could fetch would be a second
    // URL on an origin whose whole point is that it serves one document.
    sheet.replaceSync(css);
  } catch {
    return false;
  }
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  ADOPTED.add(css);
  return true;
}

/** Test isolation only: a real document adopts each distinct sheet once. */
export function resetAdoptedDocumentStylesForTests(): void {
  ADOPTED.clear();
}
