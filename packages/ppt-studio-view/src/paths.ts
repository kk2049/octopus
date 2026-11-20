import { fileURLToPath } from "node:url";
import type { AgentViewSourceInput } from "@claude-bot/agent-view-build/release";

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export const PPT_STUDIO_VIEW_DIST = at("../dist");
export const PPT_STUDIO_VIEW_BUILD_COMMAND = "pnpm --filter @claude-bot/ppt-studio-view build";

export const PPT_STUDIO_VIEW_SOURCE: AgentViewSourceInput = {
  roots: [
    at("."),
    at("../../agent-data-view/src"),
    at("../../agent-deck-view/src"),
    at("../../deck-model-contract/src"),
    at("../../resource-stream-contract/src"),
    at("../../agent-module-contract/src"),
    at("../../agent-view-react/src"),
    at("../../flight-recorder/src"),
    at("../../web-trust/src"),
    at("../../agent-view-build/src")
  ],
  files: [
    at("../package.json"),
    at("../vite.config.ts"),
    at("../tsconfig.json"),
    at("../../agent-data-view/package.json"),
    at("../../agent-deck-view/package.json"),
    at("../../deck-model-contract/package.json"),
    at("../../resource-stream-contract/package.json"),
    at("../../agent-module-contract/package.json"),
    at("../../agent-view-react/package.json"),
    at("../../flight-recorder/package.json"),
    at("../../web-trust/package.json"),
    at("../../agent-view-build/package.json"),
    at("../../../pnpm-lock.yaml")
  ]
};
