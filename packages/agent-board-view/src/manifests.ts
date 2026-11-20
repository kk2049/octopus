/**
 * The board manifest, as pure data — a Node release builder reads it to emit
 * the module lock, so no React and no stylesheet may be reachable from here.
 * The contract id therefore comes from the data package's `/port` entry, whose
 * root would install one (the same move `agent-deck-view` makes).
 *
 * ADR 0007 principle 5 is the reason this module exists and the reason its
 * vocabulary stops where it does: `board.grid` is generic, a game-specific
 * board is not. The config below can say WHERE a grid lives and WHAT one
 * interaction proposes; it cannot say what the grid means.
 */

import type { AgentModuleManifest, ModuleConfigDeclaration } from "@claude-bot/agent-module-contract";
import { APP_DATA_CONTRACT } from "@claude-bot/agent-data-view/port";

export const BOARD_GRID_MODULE_ID = "board.grid/v1";

/**
 * The whole vocabulary an instance can be told. A closed set: `config.test.ts`
 * proves the declared keys and the keys the module reads are the same list.
 */
export const BOARD_GRID_CONFIG: ModuleConfigDeclaration = Object.freeze({
  source: { type: "string", required: true, description: "投影里盘面对象的路径（{rows, cols, cells} 形状）" },
  action: { type: "string", required: true, description: "交互时提议的 App 动作 id" },
  mode: {
    type: "string",
    description: "交互模式：cell（一次点击提 {r, c}）或 move（先选起点再选终点，提 {from, to}）；默认 move",
  },
  highlights: { type: "string", description: "可选：投影里高亮格子数组的路径（元素为 {r, c} 或 \"r,c\"）" },
  disabled: { type: "string", description: "可选：投影里布尔值的路径；为 true 时盘面只读" },
});

export const BOARD_GRID_MANIFEST: AgentModuleManifest = {
  id: BOARD_GRID_MODULE_ID,
  version: "1.0.0",
  implementation: "@claude-bot/agent-board-view#BoardGrid",
  title: "网格盘面",
  slots: ["primary", "secondary", "bottom"],
  ports: [APP_DATA_CONTRACT],
  // It opens nothing and answers for no resource kind: a click is a PROPOSAL,
  // and what it changes is the App backend's decision, not a layout intent.
  opens: [],
  config: BOARD_GRID_CONFIG,
};

export const BOARD_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([BOARD_GRID_MANIFEST]);
