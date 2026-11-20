/**
 * Route ids → paths, one table, shared by the router and anything that needs to
 * ask "is this page reachable here".
 *
 * The ids are the SERVER's route ids (`page.sessionsPlus`, `page.tickets`, …), so
 * "which pages exist in this composition" is answered by comparing against
 * `bootstrap.pages` rather than by a second opinion held in the browser.
 */

export const PAGE_PATHS: Readonly<Record<string, string>> = {
  "page.overview": "/",
  "page.sessionsPlus": "/sessions-plus",
  "page.permissions": "/permissions",
  "page.accessPreview": "/access-preview",
  "page.pending": "/pending",
  "page.tickets": "/tickets",
  "page.admin": "/admin",
  "page.apps": "/apps",
  "page.launcher": "/launcher",
  "page.architecture": "/architecture",
  "page.knowledge": "/knowledge",
  // The only parameterised path in this table. The segment is a stable app id,
  // and it is the SERVER that turns it into a lookup key — this entry exists so
  // the client router knows the document it was handed is a page it serves.
  "page.appOpen": "/apps/:app/open",
};

const BY_PATH: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PAGE_PATHS).map(([id, path]) => [path, id]),
);

export function routeIdOfPath(pathname: string): string | null {
  return BY_PATH[pathname] ?? null;
}
