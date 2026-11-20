import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_SPACE_APP, REPORT_SPACE_MANIFESTS, REPORT_SPACE_MODULE_ASSETS, REPORT_SPACE_PUBLISHER } from "./plan.js";
import { REPORT_SPACE_VIEW_BUILD_COMMAND, REPORT_SPACE_VIEW_DIST, REPORT_SPACE_VIEW_SOURCE } from "./paths.js";
export const REPORT_SPACE_TITLE = "汇报空间";
export default {
  app: REPORT_SPACE_APP, publisher: REPORT_SPACE_PUBLISHER, title: REPORT_SPACE_TITLE,
  appDir: resolve(dirname(fileURLToPath(import.meta.url)), "../app"), subdir: "packages/report-space-view",
  view: { distDir: REPORT_SPACE_VIEW_DIST, source: REPORT_SPACE_VIEW_SOURCE, buildCommand: REPORT_SPACE_VIEW_BUILD_COMMAND },
  manifests: REPORT_SPACE_MANIFESTS, moduleAssets: REPORT_SPACE_MODULE_ASSETS,
};
