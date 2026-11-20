import { agentViewViteConfig } from "@claude-bot/agent-view-build";
import { RESEARCH_PROGRAM_VIEW_SOURCE } from "./src/paths";

export default agentViewViteConfig({ appId: "research-program",
  entry: "src/main.tsx",
  globalName: "ResearchProgramView",
  source: RESEARCH_PROGRAM_VIEW_SOURCE,
});
