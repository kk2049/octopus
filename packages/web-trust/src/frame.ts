/**
 * The Agent View frame contract: the sandbox token set, and the headers the
 * view document must answer with.
 *
 * ── Why this is here and not next to one of its two callers ─────────────────
 *
 * Two surfaces embed untrusted, model-authored UI in an iframe: the v3 Host
 * (`packages/engine/src/host/view-frame.ts`, same-origin path, `frame-ancestors
 * 'self'`) and Session Plus (`packages/bot/src/session-plus`, a separate
 * digest-addressed origin whose ancestors are named explicitly). They are two
 * deployments of ONE decision — scripts and nothing else: no active connection
 * API, no cookie jar and no parent DOM for the document's script, no forms, and
 * framed only by us. (Not "no network" and not "no navigation": see the
 * `connect-src` and `sandbox` notes below for what those words would overclaim.)
 * The failure mode of two copies is the one this package was created for: a
 * rule fixed on one side only.
 *
 * ── What the tokens buy, one line each ──────────────────────────────────────
 *
 *   sandbox="allow-scripts"   an opaque origin, so the DOCUMENT'S SCRIPT gets
 *                             no cookie jar (`document.cookie` throws), no
 *                             same-origin DOM access and no storage; plus no
 *                             navigation of the TOP window, no popups, no
 *                             forms, no downloads. Two things it does not
 *                             cover, and both matter: the initial navigation is
 *                             an ordinary request that carries the HOST's
 *                             cookies (the sandbox constrains the document, not
 *                             the request — which is why an untrusted package
 *                             belongs on its own hostname), and the frame may
 *                             navigate ITSELF. Adding `allow-same-origin` back
 *                             would undo the first group at once, which is why
 *                             the token set is a constant.
 *   default-src 'none'        nothing loads unless a directive below says so.
 *   script/style nonce/hash   only the exact inline blocks the host approved
 *                             may run. Dynamic documents use a fresh nonce;
 *                             immutable digest-addressed documents use hashes
 *                             of their exact script/style bytes so the response
 *                             itself can be cached without weakening CSP.
 *   connect-src 'none'        no fetch, no XHR, no WebSocket, no EventSource.
 *                             This blocks the ACTIVE connection APIs. It does
 *                             not stop a framed document from navigating its
 *                             own browsing context, which is a browser
 *                             primitive no CSP directive available in Chrome
 *                             1.62 removes (`navigate-to` is not recognised).
 *                             So the enforceable claim is: MessagePort is the
 *                             only supported application protocol, external
 *                             destinations are refused by the embedder's exact
 *                             `frame-src`, and self-navigation stays inside the
 *                             first-party static publication origin — which
 *                             must therefore serve nothing but its bare
 *                             document. See
 *                             `doc/adr/0001-session-plus-trust-boundaries.md`
 *                             §3.5.
 *   frame-ancestors <exact>   nobody else may frame it, so a page elsewhere
 *                             cannot host the view and drive it.
 *
 * `frame-ancestors` is the one input, and it is a LIST of exact origins: a
 * wildcard is refused rather than accepted, because "https://*.apps.example"
 * would let any sibling package frame this one.
 */

/** The complete sandbox token set. Deliberately not composable — see above. */
export const SANDBOX_ALLOW_SCRIPTS = "allow-scripts";

/**
 * Session Plus additionally permits browser downloads initiated by its file
 * viewer. The frame remains opaque and still has no forms, popups, top
 * navigation, storage, cookies or active network APIs.
 */
export const SANDBOX_ALLOW_SCRIPTS_AND_DOWNLOADS = "allow-scripts allow-downloads";

interface ViewFrameCommonOptions {
  /**
   * Exactly who may frame this document: full origins, or the CSP keyword
   * `'self'` for a same-origin view. Empty or wildcarded is refused.
   */
  frameAncestors: readonly string[];
}

export type ViewFrameOptions = ViewFrameCommonOptions & (
  | {
      /** Per-response nonce. Both inline blocks must carry it. */
      nonce: string;
      scriptHash?: never;
      styleHash?: never;
    }
  | {
      /** Base64 SHA-256 of the exact UTF-8 inline script/style contents. */
      scriptHash: string;
      styleHash: string;
      nonce?: never;
    }
);

/**
 * A CSP nonce, as the grammar defines it: base64 characters, nothing else.
 *
 * Checked because the nonce is interpolated into a header. A value carrying a
 * space, a quote or a `;` does not merely fail to match the script tag — it
 * ends the directive early and lets whatever follows be read as policy, which
 * is a header-injection primitive rather than a typo.
 */
const NONCE = /^[A-Za-z0-9+/=_-]{8,128}$/;
/** A SHA-256 digest encoded as canonical base64 (32 bytes → 44 chars). */
const SHA256 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Whether a `frame-ancestors` entry is one we will emit.
 *
 * Only two shapes: the keyword `'self'`, and a canonical serialized origin.
 * "Canonical" is what `URL.origin` produces, so a value only passes if it round
 * trips — which rejects a trailing slash, a path, a query, a fragment,
 * credentials, and anything with whitespace or a `;`/`,` that would otherwise
 * smuggle a second directive or a second source into this one.
 *
 * The previous version refused only a literal `*`, which let
 * `https://x; script-src 'unsafe-inline'` through — a policy string that is
 * exactly as bad as the wildcard it was written to prevent.
 */
function ancestorOk(a: string): boolean {
  if (a === "'self'") return true;
  if (a !== a.trim() || /[\s;,'"]/.test(a)) return false;
  // `https://*.apps.example` is a canonical origin as far as `URL` is
  // concerned — it round trips — so the wildcard has to be refused by name.
  if (a.includes("*")) return false;
  let url: URL;
  try {
    url = new URL(a);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  // `origin` drops path/query/fragment, so equality is the round-trip test.
  return url.origin === a;
}

function checkAncestors(frameAncestors: readonly string[]): void {
  if (frameAncestors.length === 0) {
    throw new Error("view frame CSP needs at least one frame-ancestors entry (an empty list frames nowhere)");
  }
  for (const a of frameAncestors) {
    if (!ancestorOk(a)) {
      throw new Error(
        `view frame CSP refuses the frame-ancestors entry ${JSON.stringify(a)}: `
          + "only 'self' or an exact origin such as https://panel.example.com",
      );
    }
  }
}

/** The document policy, in a fixed order so it is diffable across surfaces. */
export function viewFrameCsp(o: ViewFrameOptions): string {
  let scriptSource: string;
  let styleSource: string;
  if (typeof o.nonce === "string") {
    if (!NONCE.test(o.nonce)) {
      throw new Error(`view frame CSP refuses the nonce ${JSON.stringify(o.nonce)}: it is not a nonce token`);
    }
    scriptSource = `'nonce-${o.nonce}'`;
    styleSource = `'nonce-${o.nonce}'`;
  } else {
    if (!SHA256.test(o.scriptHash) || !SHA256.test(o.styleHash)) {
      throw new Error("view frame CSP refuses a non-SHA-256 inline content hash");
    }
    scriptSource = `'sha256-${o.scriptHash}'`;
    styleSource = `'sha256-${o.styleHash}'`;
  }
  checkAncestors(o.frameAncestors);
  return [
    "default-src 'none'",
    `script-src ${scriptSource}`,
    `style-src ${styleSource}`,
    // App-owned Blob URLs are inert data produced from an already-authorized
    // typed-port read. Nested frames still have an empty sandbox at the callsite.
    "img-src data: blob:",
    "frame-src blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${o.frameAncestors.join(" ")}`,
  ].join("; ");
}

/**
 * The full response header set for a view document.
 *
 * Note what is NOT here and must never be added by a caller:
 * `access-control-allow-origin` (there is no API on this origin to share) and
 * `set-cookie` (the view has no session, and a cookie on this host is a cookie
 * a sibling can aim at).
 */
export function viewFrameHeaders(o: ViewFrameOptions): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": viewFrameCsp(o),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
}
