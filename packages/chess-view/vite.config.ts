/**
 * The 国际象棋 Agent View build. `agentViewViteConfig()` owns everything that
 * makes an Agent View publishable; this file only names the entry and the
 * source list (imported from `src/paths.ts` so the loader hashes what the
 * build hashed — one definition, not two).
 */

import { agentViewViteConfig } from "@claude-bot/agent-view-build";
import { CHESS_VIEW_SOURCE } from "./src/paths";

export default agentViewViteConfig({ appId: "chess",
  entry: "src/main.tsx",
  globalName: "ChessView",
  source: CHESS_VIEW_SOURCE,
});
