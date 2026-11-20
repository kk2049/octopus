import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_DIST, DOCS_SOURCE } from "./paths.js";
export default {
  app: "research-docs",
  publisher: "octopus:first-party",
  title: "研究文档",
  resourceProfile: "research-docs/v1",
  appDir: resolve(dirname(fileURLToPath(import.meta.url)), "../app"),
  subdir: "packages/research-docs-view",
  view: {
    distDir: DOCS_DIST,
    source: DOCS_SOURCE,
    buildCommand: "pnpm --filter @claude-bot/research-docs-view build",
  },
};
