import { fileURLToPath } from "node:url";
import type { AgentViewSourceInput } from "@claude-bot/agent-view-build/release";
import { RESEARCH_CANVAS_VIEW_SOURCE } from "../../research-canvas-view/src/paths.js";
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const DOCS_DIST = at("../dist");
export const DOCS_SOURCE: AgentViewSourceInput = {
  roots: [
    at("."),
    at("../../research-docs-contract/src"),
    ...RESEARCH_CANVAS_VIEW_SOURCE.roots,
  ],
  files: [
    at("../package.json"),
    at("../../research-docs-contract/package.json"),
    at("../vite.config.ts"),
    at("../tsconfig.json"),
    ...(RESEARCH_CANVAS_VIEW_SOURCE.files ?? []),
  ],
};
