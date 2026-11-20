import { agentViewViteConfig } from "@claude-bot/agent-view-build";
import { PPT_STUDIO_VIEW_SOURCE } from "./src/paths";

export default agentViewViteConfig({ appId: "ppt-studio",
  entry: "src/main.tsx",
  globalName: "PptStudioView",
  source: PPT_STUDIO_VIEW_SOURCE,
});
