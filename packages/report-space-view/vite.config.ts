import { agentViewViteConfig } from "@claude-bot/agent-view-build";
import { REPORT_SPACE_VIEW_SOURCE } from "./src/paths";
export default agentViewViteConfig({ appId: "report-space", entry: "src/main.tsx", globalName: "ReportSpaceView", source: REPORT_SPACE_VIEW_SOURCE });
