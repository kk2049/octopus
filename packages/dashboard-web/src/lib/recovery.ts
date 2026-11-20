/**
 * Browser-document recovery for authentication.
 *
 * A deployment may replace the web login session. The browser must acquire it
 * again from a fresh document; these helpers preserve the intended return path
 * without replaying an API operation.
 */

interface DocumentLocation {
  pathname: string;
  search: string;
  hash: string;
}

/** The current same-origin document address, including a client-only hash. */
export function documentReturnPath(where: DocumentLocation = window.location): string {
  const path = `${where.pathname || "/"}${where.search || ""}${where.hash || ""}`;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

/** Login URL which returns to the current document after a successful exchange. */
export function loginUrl(where: DocumentLocation = window.location): string {
  const next = documentReturnPath(where);
  // Never nest a login URL inside another login URL after a refusal on the
  // login screen itself.
  if (where.pathname === "/login") return "/login";
  return `/login?next=${encodeURIComponent(next)}`;
}
