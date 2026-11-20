/**
 * Reading the server's handoff, once, at module load.
 *
 * Two blocks, read two different ways, and the difference is the point:
 *
 *  · the bootstrap is ordinary trusted context and stays in the document;
 *  · the Session Plus instance handle is a per-tab capability-like binding, so
 *    it is read once and its block is REMOVED. Afterwards its only copy in the
 *    browser is the module-private binding below — never React state, never a
 *    prop, never an attribute, never a URL, never a body. The one place it
 *    leaves is the `x-session-plus-instance` request header, which the browser
 *    cannot attach cross-site.
 *
 * Honest note on what changed from the hand-built page: that page held the
 * handle in an inline-script closure and it never touched the DOM. Here it is
 * in the document between parse and first paint. The only thing that could read
 * it in that window is same-origin script — and the page ships
 * `script-src 'self'` with no inline and no `eval`, so there is no way to
 * introduce one. Same trust class, bounded lifetime, written down rather than
 * implied.
 */

import {
  BOOTSTRAP_ELEMENT_ID,
  APP_INSTANCE_ELEMENT_ID,
  type DashboardBootstrap,
} from "../contract.js";

function readJsonBlock(id: string): unknown {
  const node = document.getElementById(id);
  if (!node) return null;
  const text = node.textContent ?? "";
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A document with no bootstrap is a bug, not a state to render around: the
 * server composes it for every app page. Failing loudly here beats an app that
 * silently believes it is talking to an anonymous viewer.
 */
function loadBootstrap(): DashboardBootstrap {
  const value = readJsonBlock(BOOTSTRAP_ELEMENT_ID);
  if (!value || typeof value !== "object") {
    throw new Error("dashboard bootstrap payload is missing or malformed");
  }
  return value as DashboardBootstrap;
}

export const bootstrap: DashboardBootstrap = loadBootstrap();

let appInstance: string | null = null;
{
  const node = document.getElementById(APP_INSTANCE_ELEMENT_ID);
  if (node) {
    const value = readJsonBlock(APP_INSTANCE_ELEMENT_ID);
    appInstance = typeof value === "string" && value ? value : null;
    node.remove();
  }
}

/**
 * The per-tab App instance binding, for the same-origin calls that need it.
 *
 * A function rather than an exported constant so every use site is greppable
 * and so nothing can spread it by destructuring a props object.
 */
export function appInstanceHandle(): string | null {
  return appInstance;
}
