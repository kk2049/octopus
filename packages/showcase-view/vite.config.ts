/**
 * The 模块演示 Agent View build.
 *
 * Almost nothing is decided here: `agentViewViteConfig()` owns the properties
 * that make an Agent View publishable (two fixed outputs, embeddable under a
 * nonce, a manifest that makes a stale build detectable), and this file only
 * says which entry belongs to THIS release.
 *
 * The source list is imported from `src/paths.ts` rather than written twice.
 * It has to name every tree whose bytes end up in the bundle — this App's
 * composition AND the module packages' AND the SDK's, because they are compiled
 * in rather than linked at runtime — and any Node-side loader reads the same
 * constant. Two copies would drift, and the drift would show up as a build that
 * is permanently "stale".
 */

import { agentViewViteConfig } from "@claude-bot/agent-view-build";
import { SHOWCASE_VIEW_SOURCE } from "./src/paths";

export default agentViewViteConfig({ appId: "showcase",
  entry: "src/main.tsx",
  globalName: "ShowcaseView",
  source: SHOWCASE_VIEW_SOURCE,
});
