/**
 * This app's packer, as data — the "~7 constants" a declared App's release
 * build actually consists of. This v2 View owns its interaction DOM, so the
 * config intentionally omits module manifests and module-plan assets; the
 * generic packer emits the platform's existing seven-asset custom-root shape.
 *
 * The generic pack CLI (`pnpm run app:pack:chess`) loads this module BY PATH
 * and hands the default export to `packApp` in
 * `packages/bot/src/app-registry/app-package.ts`. The type lives over there
 * (`AppPackConfig`); this file deliberately imports nothing from the trusted
 * tree — dependencies point from the platform to the app's data, never back —
 * so the shape is enforced at load time by `readAppPackConfig` and end to end
 * by this package's pack test. Adding this App changed NOTHING under
 * `packages/bot`, which is ADR 0007 §6's acceptance criterion made literal.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHESS_VIEW_BUILD_COMMAND, CHESS_VIEW_DIST, CHESS_VIEW_SOURCE } from "./paths.js";

export const CHESS_APP = "chess";
export const CHESS_PUBLISHER = "octopus:demo";
/** Human title for the declaration (`--declare`). */
export const CHESS_TITLE = "国际象棋";

export default {
  app: CHESS_APP,
  publisher: CHESS_PUBLISHER,
  title: CHESS_TITLE,
  appDir: resolve(dirname(fileURLToPath(import.meta.url)), "../app"),
  subdir: "packages/chess-view",
  view: {
    distDir: CHESS_VIEW_DIST,
    source: CHESS_VIEW_SOURCE,
    buildCommand: CHESS_VIEW_BUILD_COMMAND,
  },
};
