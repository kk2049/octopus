/**
 * Where the built browser bundle lands, resolved the way the rest of the
 * repository resolves paths.
 *
 * The bot serves these files, so it needs the directory at runtime. It is a
 * package export rather than a relative guess in `dashboard/server.ts` because
 * the bot runs from two layouts (`tsx src/…` and a tsup bundle) and a `../../..`
 * that is right for one is silently wrong for the other — and "silently wrong"
 * here means the panel serves 404s for its own JavaScript.
 *
 * `OCTOPUS_DASHBOARD_WEB_DIST` exists for the same reason every other path in
 * this repo has an override: a test needs to point at a fixture without
 * building the real thing.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the directory `vite build` writes. */
export const DASHBOARD_WEB_DIST: string =
  process.env.OCTOPUS_DASHBOARD_WEB_DIST || path.resolve(here, "..", "dist");

/** URL prefix the bundle is published under. Must match `vite.config.ts` `base`. */
export const DASHBOARD_WEB_BASE = "/ui/";
