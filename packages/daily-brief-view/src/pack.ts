import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAILY_BRIEF_APP, DAILY_BRIEF_MANIFESTS, DAILY_BRIEF_MODULE_ASSETS, DAILY_BRIEF_PUBLISHER } from "./plan.js";
import { DAILY_BRIEF_VIEW_BUILD_COMMAND, DAILY_BRIEF_VIEW_DIST, DAILY_BRIEF_VIEW_SOURCE } from "./paths.js";
export const DAILY_BRIEF_TITLE = "日程总结";
export default {
  app: DAILY_BRIEF_APP, publisher: DAILY_BRIEF_PUBLISHER, title: DAILY_BRIEF_TITLE,
  appDir: resolve(dirname(fileURLToPath(import.meta.url)), "../app"), subdir: "packages/daily-brief-view",
  view: { distDir: DAILY_BRIEF_VIEW_DIST, source: DAILY_BRIEF_VIEW_SOURCE, buildCommand: DAILY_BRIEF_VIEW_BUILD_COMMAND },
  manifests: DAILY_BRIEF_MANIFESTS, moduleAssets: DAILY_BRIEF_MODULE_ASSETS,
};
