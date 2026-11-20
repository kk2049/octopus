import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESEARCH_CANVAS_VIEW_BUILD_COMMAND,
  RESEARCH_CANVAS_VIEW_DIST,
  RESEARCH_CANVAS_VIEW_SOURCE,
} from "./paths.js";
export default {
  app: "research-v2",
  publisher: "octopus:first-party",
  title: "自动科研 v2",
  resourceProfile: "research-canvas/v2",
  appDir: resolve(dirname(fileURLToPath(import.meta.url)), "../app"),
  subdir: "packages/research-canvas-view",
  view: {
    distDir: RESEARCH_CANVAS_VIEW_DIST,
    source: RESEARCH_CANVAS_VIEW_SOURCE,
    buildCommand: RESEARCH_CANVAS_VIEW_BUILD_COMMAND,
  },
};
