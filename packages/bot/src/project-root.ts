/**
 * Where the checkout starts.
 *
 * Extracted out of the (since retired) v2 session runtime so a composition can
 * ask for the repo root without importing the agent SDK and the plugin loader
 * along the way.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walk up until a directory holds `plugins/`. Works for both layouts:
 *   tsx src/…            (source tree, several levels down)
 *   node dist/…          (bundle, fewer levels down)
 */
export function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "plugins"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd(); // fallback
}

export const PROJECT_ROOT = findProjectRoot(__dirname);
