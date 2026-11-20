import { agentViewViteConfig } from "@claude-bot/agent-view-build";
import { DAILY_BRIEF_VIEW_SOURCE } from "./src/paths";

export default agentViewViteConfig({ appId: "daily-brief",
  entry: "src/main.tsx",
  globalName: "DailyBriefView",
  source: DAILY_BRIEF_VIEW_SOURCE,
});
