/**
 * The Node-side handle on this release's browser half: where the build output
 * lives, and exactly which inputs decide it. A packer or loader imports this
 * rather than spelling paths of its own; `vite.config.ts` names the same trees.
 * The full argument for why a missing root is dangerous (a stale-but-
 * self-consistent bundle served under yesterday's digest) is in
 * `showcase-view/src/paths.ts` and applies unchanged.
 *
 * The list is the import closure of `src/main.tsx`: this App's bespoke root,
 * the SDK, its wire vocabulary, and the build recipe (hashed, not bundled).
 * `chess.js` remains a backend dependency inlined at pack time; the browser
 * consumes authoritative `legal_moves` and does not compile a second ruleset.
 */

import { fileURLToPath } from "node:url";
import type { AgentViewSourceInput } from "@claude-bot/agent-view-build/release";

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** Where `pnpm --filter @claude-bot/chess-view build` writes. */
export const CHESS_VIEW_DIST = at("../dist");

/** The command to print when the build is missing or stale. */
export const CHESS_VIEW_BUILD_COMMAND = "pnpm --filter @claude-bot/chess-view build";

export const CHESS_VIEW_SOURCE: AgentViewSourceInput = {
  roots: [
    at("."),
    at("../../agent-view-react/src"),
    at("../../flight-recorder/src"),
    at("../../web-trust/src"),
    at("../../agent-view-build/src"),
  ],
  files: [
    at("../package.json"),
    at("../vite.config.ts"),
    at("../tsconfig.json"),
    at("../../agent-view-react/package.json"),
    at("../../flight-recorder/package.json"),
    at("../../web-trust/package.json"),
    at("../../agent-view-build/package.json"),
    at("../../../pnpm-lock.yaml"),
  ],
};
