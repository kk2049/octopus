import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PPT_STUDIO_APP,
  PPT_STUDIO_MANIFESTS,
  PPT_STUDIO_MODULE_ASSETS,
  PPT_STUDIO_PUBLISHER,
} from "./plan.js";
import { PPT_STUDIO_VIEW_BUILD_COMMAND, PPT_STUDIO_VIEW_DIST, PPT_STUDIO_VIEW_SOURCE } from "./paths.js";

export default {
  app: PPT_STUDIO_APP,
  publisher: PPT_STUDIO_PUBLISHER,
  title: "PPT Studio",
  appDir: resolve(dirname(fileURLToPath(import.meta.url)), "../app"),
  subdir: "packages/ppt-studio-view",
  view: {
    distDir: PPT_STUDIO_VIEW_DIST,
    source: PPT_STUDIO_VIEW_SOURCE,
    buildCommand: PPT_STUDIO_VIEW_BUILD_COMMAND
  },
  manifests: PPT_STUDIO_MANIFESTS,
  moduleAssets: PPT_STUDIO_MODULE_ASSETS
};
