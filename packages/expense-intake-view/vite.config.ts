import { agentViewViteConfig } from "@claude-bot/agent-view-build";
import { EXPENSE_INTAKE_VIEW_SOURCE } from "./src/paths";
export default agentViewViteConfig({ appId: "expense-intake", entry: "src/main.tsx", globalName: "ExpenseIntakeView", source: EXPENSE_INTAKE_VIEW_SOURCE });
