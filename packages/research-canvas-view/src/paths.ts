import { fileURLToPath } from "node:url";
import type { AgentViewSourceInput } from "@claude-bot/agent-view-build/release";

const at = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export const RESEARCH_CANVAS_VIEW_DIST = at("../dist");
export const RESEARCH_CANVAS_VIEW_BUILD_COMMAND =
  "pnpm --filter @claude-bot/research-canvas-view build";
export const RESEARCH_CANVAS_VIEW_SOURCE: AgentViewSourceInput = {
  roots: [
    at("."),
    at("../../research-canvas-contract/src"),
    at("../../agent-sessions-view/src"),
    at("../../agent-sessions-contract/src"),
    at("../../chat-ui-commons/src"),
    at("../../agent-feishu-view/src"),
    at("../../agent-workspace-files-view/src"),
    at("../../agent-file-preview/src"),
    at("../../agent-text-view/src"),
    at("../../agent-module-contract/src"),
    at("../../workspace-files-contract/src"),
    at("../../resource-stream-contract/src"),
    at("../../typed-port-kit/src"),
    at("../../agent-view-react/src"),
    at("../../flight-recorder/src"),
    at("../../web-trust/src"),
    at("../../agent-view-build/src"),
  ],
  files: [
    at("../package.json"),
    at("../../research-canvas-contract/package.json"),
    at("../vite.config.ts"),
    at("../tsconfig.json"),
    at("../../agent-sessions-view/package.json"),
    at("../../agent-sessions-contract/package.json"),
    at("../../chat-ui-commons/package.json"),
    at("../../agent-feishu-view/package.json"),
    at("../../agent-workspace-files-view/package.json"),
    at("../../agent-file-preview/package.json"),
    at("../../agent-text-view/package.json"),
    at("../../agent-module-contract/package.json"),
    at("../../workspace-files-contract/package.json"),
    at("../../resource-stream-contract/package.json"),
    at("../../typed-port-kit/package.json"),
    at("../../agent-view-react/package.json"),
    at("../../flight-recorder/package.json"),
    at("../../web-trust/package.json"),
    at("../../agent-view-build/package.json"),
    at("../../../pnpm-lock.yaml"),
  ],
};
