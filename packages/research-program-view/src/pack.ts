import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESEARCH_PROGRAM_VIEW_BUILD_COMMAND,
  RESEARCH_PROGRAM_VIEW_DIST,
  RESEARCH_PROGRAM_VIEW_SOURCE,
} from "./paths.js";
import {
  RESEARCH_PROGRAM_APP,
  RESEARCH_PROGRAM_MANIFESTS,
  RESEARCH_PROGRAM_MODULE_ASSETS,
} from "./plan.js";

export { RESEARCH_PROGRAM_APP };
export const RESEARCH_PROGRAM_PUBLISHER = "octopus:first-party";
export const RESEARCH_PROGRAM_TITLE = "自动科研项目台";

export default {
  resourceProfile: 'research-sessions/v1',
  app: RESEARCH_PROGRAM_APP,
  publisher: RESEARCH_PROGRAM_PUBLISHER,
  title: RESEARCH_PROGRAM_TITLE,
  appDir: resolve(dirname(fileURLToPath(import.meta.url)), "../app"),
  subdir: "packages/research-program-view",
  view: {
    distDir: RESEARCH_PROGRAM_VIEW_DIST,
    source: RESEARCH_PROGRAM_VIEW_SOURCE,
    buildCommand: RESEARCH_PROGRAM_VIEW_BUILD_COMMAND,
  },
  manifests: RESEARCH_PROGRAM_MANIFESTS,
  moduleAssets: RESEARCH_PROGRAM_MODULE_ASSETS,
};
