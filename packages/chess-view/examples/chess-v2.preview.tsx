import { defineCustomPreview } from "@claude-bot/agent-view-preview";
import { ChessRoom } from "../src/ChessRoom.js";

export default defineCustomPreview({
  kind: "custom",
  app: "chess",
  title: "檀木棋室 · 白方回合",
  projection: {
    board: {
      rows: 8,
      cols: 8,
      cells: [
        { r: 0, c: 0, glyph: "♜" }, { r: 0, c: 4, glyph: "♚" },
        { r: 1, c: 3, glyph: "♟" }, { r: 1, c: 4, glyph: "♟" },
        { r: 4, c: 4, glyph: "♙" }, { r: 6, c: 3, glyph: "♙" },
        { r: 7, c: 0, glyph: "♖" }, { r: 7, c: 4, glyph: "♔" },
      ],
    },
    turn: "white",
    status: "playing",
    frozen: false,
    viewer_role: "white",
    legal_moves: [{ from: "6,3", to: ["5,3", "4,3"] }, { from: "7,4", to: ["6,4"] }],
    resigned_by: "",
    last_move: ["1,4", "3,4"],
    moves: [{ n: "1", san: "e4", by: "lht" }, { n: "2", san: "e5", by: "guest" }],
    comments: [{ by: "watcher", text: "中心已经打开。" }],
    seats: { white: "lht", black: "guest" },
  },
  actions: {
    move: { ok: true }, comment: { ok: true }, resign: { ok: true }, new_game: { ok: true },
  },
  render: () => <ChessRoom />,
});
