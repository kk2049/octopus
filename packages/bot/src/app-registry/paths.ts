/**
 * Where installed Agentic App releases live on this host.
 *
 * Two roots, and they are separate because they answer to different rules:
 *
 *  · `contentRoot` is the registry's own content-addressed store. Every file in
 *    it is named by its own digest, so an asset name never becomes a path there.
 *  · `preparedRoot` is where a release is MATERIALISED for a process that needs
 *    real files — the App Runtime loads `actions.ts`/`projection.ts` from a
 *    directory. That mapping is from a closed list of known asset names to known
 *    relative paths (`session-plus-adapter.ts`), never from the descriptor's
 *    inventory, so the property survives the transition to a filesystem.
 *
 * Both sit under the data directory rather than beside the checkout: a release
 * is durable state, and a deploy replaces the checkout.
 */

import * as path from "node:path";

export const APP_RELEASES_DIR = "app-releases";

export interface AppReleasePaths {
  /** Content-addressed artifact store. Passed to `FileReleaseContentStore`. */
  contentRoot: string;
  /** Per-release materialised trees, one directory per package digest. */
  preparedRoot: string;
}

export function appReleasePaths(dataDir: string): AppReleasePaths {
  const root = path.resolve(dataDir, APP_RELEASES_DIR);
  return {
    contentRoot: path.join(root, "content"),
    preparedRoot: path.join(root, "prepared"),
  };
}
