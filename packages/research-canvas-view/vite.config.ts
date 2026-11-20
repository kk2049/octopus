/** Shared ESM App build; source identity is declared once in paths.ts. */
import { agentViewViteConfig } from "@claude-bot/agent-view-build";
import { RESEARCH_CANVAS_VIEW_SOURCE } from "./src/paths";

export default agentViewViteConfig({ appId: "research-v2",
  entry: "src/main.tsx",
  globalName: "ResearchCanvasView",
  source: RESEARCH_CANVAS_VIEW_SOURCE,
});
