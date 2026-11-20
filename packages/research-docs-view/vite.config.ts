import {agentViewViteConfig} from "@claude-bot/agent-view-build";
import {DOCS_SOURCE} from "./src/paths";
export default agentViewViteConfig({appId:"research-docs",entry:"src/main.tsx",globalName:"ResearchDocsView",source:DOCS_SOURCE});
