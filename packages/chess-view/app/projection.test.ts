/**
 * The pure fold: glyphs land on the right coordinates, the board module's
 * bindings (`board` / `last_move` / `frozen`) always exist, and hostile or
 * hand-repaired logs degrade instead of crashing.
 */

import { describe, expect, it } from "vitest";
import { move } from "./actions.js";
import { project, projectIncremental } from "./projection.js";

const AT = "2026-08-11T12:00:00Z";

function stamped(type: string, data: unknown, by = "user:alice") {
  return { type, data, at: AT, by };
}

/** The real `move` handler drives the log so every FEN in it is genuine. */
function played(pairs: ReadonlyArray<[string, string]>): any[] {
  let log: any[] = [];
  pairs.forEach(([from, to], index) => {
    const seat = index % 2 === 0 ? "white" : "black";
    const ctx = { now: AT, state: project(log), actor: { user: seat, kind: "user", role: seat } };
    log = [...log, ...move(ctx, { from, to }).events.map((row: any) => ({ ...row, by: `user:${seat}` }))];
  });
  return log;
}

function cellAt(view: any, r: number, c: number): any {
  return view.board.cells.find((cell: any) => cell.r === r && cell.c === c);
}

describe("the opening position", () => {
  it("maps 32 pieces onto an 8×8 grid with rank 8 at row 0", () => {
    const view = project([]);
    expect(view.board.rows).toBe(8);
    expect(view.board.cols).toBe(8);
    expect(view.board.cells).toHaveLength(32);
    expect(cellAt(view, 0, 0).glyph).toBe("♜");
    expect(cellAt(view, 0, 4).glyph).toBe("♚");
    expect(cellAt(view, 7, 4).glyph).toBe("♔");
    expect(cellAt(view, 7, 3).glyph).toBe("♕");
    for (let c = 0; c < 8; c += 1) expect(cellAt(view, 6, c).glyph).toBe("♙");
    expect(cellAt(view, 4, 4)).toBeUndefined();
  });

  it("starts playing, unfrozen, white to move, with empty seats", () => {
    const view = project([]);
    expect(view).toMatchObject({ turn: "white", status: "playing", frozen: false, last_move: [] });
    expect(view.moves).toEqual([]);
    expect(view.seats).toEqual({});
    expect(view.status_panel.白方).toBe("虚位以待");
    // The two form declarations the composition binds are always present.
    expect(view.comment_params.text.required).toBe(true);
    expect(view.confirm_params.confirm.enum).toEqual(["确认"]);
  });

  it("projects only the seated side's public legal destinations", () => {
    const white = project([], { viewer: { user: "alice", role: "white" } });
    expect(white.viewer_role).toBe("white");
    expect(white.legal_moves.find((move: any) => move.from === "6,4")?.to).toEqual(["5,4", "4,4"]);
    expect(project([], { viewer: { user: "carol", role: "watcher" } }).legal_moves).toEqual([]);
    expect(project([], { viewer: { user: "bob", role: "black" } }).legal_moves).toEqual([]);
    expect(project([]).viewer_role).toBe("");
  });
});
describe("after real moves", () => {
  it("moves the glyph, records SAN, and echoes wire coordinates as highlights", () => {
    const view = project(played([["6,4", "4,4"]]));
    expect(cellAt(view, 6, 4)).toBeUndefined();
    expect(cellAt(view, 4, 4).glyph).toBe("♙");
    expect(view.moves).toEqual([{ n: "1", san: "e4", by: "white" }]);
    expect(view.last_move).toEqual(["6,4", "4,4"]);
    expect(view.turn).toBe("black");
    expect(view.status_panel.轮到).toBe("黑方");
  });

  it("reports check without freezing the board", () => {
    // 1. e4 f5 2. Qh5+
    const view = project(played([["6,4", "4,4"], ["1,5", "3,5"], ["7,3", "3,7"]]));
    expect(view.status).toBe("check");
    expect(view.frozen).toBe(false);
  });

  it("reports checkmate and freezes the board", () => {
    // 1. f3 e5 2. g4 Qh4#
    const view = project(played([["6,5", "5,5"], ["1,4", "3,4"], ["6,6", "4,6"], ["0,3", "4,7"]]));
    expect(view.status).toBe("checkmate");
    expect(view.frozen).toBe(true);
    expect(view.status_panel.状态).toBe("将死，对局结束");
  });
});

describe("resignation and reset", () => {
  it("a resigned event freezes the game and names the seat from the stamp", () => {
    const view = project([stamped("resigned", { by_color: "white" }, "user:dave")]);
    expect(view.status).toBe("resigned");
    expect(view.frozen).toBe(true);
    expect(view.resigned_by).toBe("white");
    expect(view.seats.white).toBe("dave");
  });

  it("ignores a resigned event whose colour is not a colour", () => {
    const view = project([stamped("resigned", { by_color: "purple" })]);
    expect(view.status).toBe("playing");
    expect(view.seats).toEqual({});
  });

  it("game_reset restores the opening but keeps the room's comments", () => {
    const log = [
      ...played([["6,4", "4,4"]]),
      stamped("commented", { text: "开局了" }, "user:carol"),
      stamped("game_reset", {}),
    ];
    const view = project(log);
    expect(view.status).toBe("playing");
    expect(view.moves).toEqual([]);
    expect(view.seats).toEqual({});
    expect(view.board.cells).toHaveLength(32);
    expect(view.comments).toEqual([{ text: "开局了", by: "carol" }]);
  });
});

describe("defensive reading", () => {
  it("skips junk without crashing and never trusts a malformed FEN", () => {
    const view = project([
      null,
      42,
      { type: "moved", data: { fen: "not a fen", san: 7 } },
      stamped("unheard_of", { x: 1 }),
    ] as any[]);
    expect(view.board.cells).toHaveLength(32);
    expect(view.status).toBe("playing");
  });

  it("is total on a non-array input", () => {
    expect(project("nope" as any).board.rows).toBe(8);
  });

  it("bounds the rendered comments while counting all of them", () => {
    const log = Array.from({ length: 120 }, (_, index) => stamped("commented", { text: `c${index}` }));
    const view = project(log);
    expect(view.comments).toHaveLength(100);
    expect(view.comments[0].text).toBe("c20");
    expect(view.status_panel.评论数).toBe("120");
  });
});

describe("incremental chess projection", () => {
  it("keeps computer mode and position identity across snapshot, comment and reset boundaries", () => {
    const events = [
      stamped("opponent_set", { opponent: "computer" }),
      ...played([["6,4", "4,4"]]),
      stamped("commented", { text: "hello" }),
      stamped("game_reset", {}),
    ];
    const context = { viewer: { kind: "user", user: "alice", role: "white" } };
    for (let split = 0; split <= events.length; split += 1) {
      expect(projectIncremental(project(events.slice(0, split)), events.slice(split), context)).toEqual(project(events, context));
    }
    expect(project(events)).toMatchObject({ opponent: "computer", position_id: "3" });
  });

  it("projects computer legal moves only to the declared agent and recovery only to white", () => {
    const events = [stamped("opponent_set", { opponent: "computer" }), ...played([["6,4", "4,4"]])];
    const white = project(events, { viewer: { kind: "user", role: "white" } });
    expect(white).toMatchObject({ can_request_computer: true, can_set_opponent: false, legal_moves: [] });
    for (const role of ["black", "watcher"]) {
      expect(project(events, { viewer: { kind: "user", role } })).toMatchObject({ can_control: false, can_request_computer: false, legal_moves: [] });
    }
    const agent = { viewer: { kind: "agent", role: "black", app: "chess", agent: "luna" } };
    expect(project(events, agent).legal_moves).toContainEqual({ from: "1,4", to: ["2,4", "3,4"] });
    expect(project(played([["6,4", "4,4"]]), agent).legal_moves).toEqual([]);
    expect(project([...events, stamped("resigned", { by_color: "white" })], agent).legal_moves).toEqual([]);
    expect(project([...events, stamped("resigned", { by_color: "white" })], { viewer: { kind: "user", role: "white" } }).can_request_computer).toBe(false);
  });

  it("matches a complete viewer fold across a snapshot boundary", () => {
    const events = [stamped("commented", { text: "hello" }), stamped("commented", { text: "world" }, "user:bob")];
    const context = { viewer: { user: "alice", role: "watcher" } };
    expect(projectIncremental(project(events.slice(0, 1)), events.slice(1), context)).toEqual(project(events, context));
  });

  it("retains the historical comment count after the rendered tail is bounded", () => {
    const events = Array.from({ length: 121 }, (_, index) => stamped("commented", { text: `c${index}` }));
    const snapshot = project(events.slice(0, 120));
    expect(projectIncremental(snapshot, events.slice(120))).toEqual(project(events));
    expect(projectIncremental(snapshot, events.slice(120)).status_panel.评论数).toBe("121");
  });
});
