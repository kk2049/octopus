/**
 * `@claude-bot/agent-board-view` — the generic grid-board View module.
 *
 * One module: `board.grid/v1`. A composition instance points it at a projection
 * path shaped `{rows, cols, cells}` and names ONE action; clicks (or keys)
 * become proposals carrying coordinates, and everything about meaning — rules,
 * sides, legality — stays behind the two doors on the trusted/sandbox side
 * (ADR 0007). It reuses the `app-data/v1` port and provider from
 * `@claude-bot/agent-data-view`, so one App mounts ONE provider for both
 * families of modules.
 */

import "./board-view.css";

export { BOARD_GRID_MODULE, BOARD_MODULES, CONFIG_KEYS_READ } from "./modules.js";

export { BoardGrid, type BoardGridProps } from "./components/BoardGrid.js";

export {
  BOARD_GRID_CONFIG,
  BOARD_GRID_MANIFEST,
  BOARD_GRID_MODULE_ID,
  BOARD_MANIFESTS,
} from "./manifests.js";

export {
  BOARD_LIMITS,
  cellKey,
  readBoard,
  readHighlightSet,
  type BoardCell,
  type BoardReadout,
  type BoardStatus,
  type BoardTone,
} from "./lib/board.js";
