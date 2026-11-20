/**
 * The rules door, exercised the way the runtime exercises it: every `ctx.state`
 * below is produced by the REAL `project()` over a log, and every commit stamps
 * `at`/`by` the way the trusted coordinator does — so these cases cover the
 * handler/projection pair, not two halves that happen to agree.
 */

import { describe, expect, it } from "vitest";
import { comment, computer_move, move, new_game, resign, set_opponent } from "./actions.js";
import { project } from "./projection.js";

interface Row { type: string; data: unknown; at: string; by: string }

const AT = "2026-08-11T12:00:00Z";

/** What the coordinator supplies a schema-3 handler: state, now, actor evidence. */
function ctxFor(log: Row[], role?: string, user = "guest"): any {
  return { now: AT, state: project(log), actor: { user, kind: "user", ...(role ? { role } : {}) } };
}

/** What the coordinator does on commit: stamp the evidence fields. */
function commit(log: Row[], out: { events: any[] }, by: string): Row[] {
  return [...log, ...out.events.map((row) => ({ type: row.type, data: row.data, at: AT, by }))];
}

/** Play a sequence of legal moves, alternating seats like the real door would. */
function play(pairs: ReadonlyArray<[string, string]>, users = { white: "alice", black: "bob" }): Row[] {
  let log: Row[] = [];
  pairs.forEach(([from, to], index) => {
    const seat = index % 2 === 0 ? "white" : "black";
    const user = users[seat];
    log = commit(log, move(ctxFor(log, seat, user), { from, to }), `user:${user}`);
  });
  return log;
}

// 1. f3 e5 2. g4 Qh4# — the fastest mate, in "row,col" wire coordinates.
const FOOLS_MATE: ReadonlyArray<[string, string]> = [
  ["6,5", "5,5"],
  ["1,4", "3,4"],
  ["6,6", "4,6"],
  ["0,3", "4,7"],
];

const COMPUTER = { kind: "agent", app: "chess", agent: "luna", role: "black" };

function computerContext(log: Row[]): any {
  return { now: AT, state: project(log), actor: COMPUTER };
}

function computerGame(): Row[] {
  let log = commit([], set_opponent(ctxFor([], "white"), { opponent: "computer" }), "user:alice");
  return commit(log, move(ctxFor(log, "white"), { from: "6,4", to: "4,4" }), "user:alice");
}

describe("computer opponent", () => {
  it("requires an explicit white-player choice before the first move", () => {
    expect(project([]).opponent).toBe("human");
    for (const role of ["black", "watcher", undefined]) {
      expect(() => set_opponent(ctxFor([], role), { opponent: "computer" })).toThrow(/white player/);
    }
    expect(() => set_opponent({ ...ctxFor([], "white"), actor: { kind: "agent", role: "white" } }, { opponent: "computer" })).toThrow(/white player/);
    expect(() => set_opponent(ctxFor([], "white"), { opponent: "unknown" })).toThrow(/unknown opponent/);
    expect(() => set_opponent(ctxFor(computerGame(), "white"), { opponent: "human" })).toThrow(/before the first move/);
  });

  it("announces one computer reply only for a live black turn", () => {
    const enabled = commit([], set_opponent(ctxFor([], "white"), { opponent: "computer" }), "user:alice");
    const out = move(ctxFor(enabled, "white"), { from: "6,4", to: "4,4" });
    expect(out.result.computer_position).toBe(project(commit(enabled, out, "user:alice")).position_id);
    expect(move(ctxFor([], "white"), { from: "6,4", to: "4,4" }).result).not.toHaveProperty("computer_position");
  });

  it("validates the declared actor, mode, position, side and chess legality", () => {
    const log = computerGame();
    const ctx = computerContext(log);
    const params = { position: ctx.state.position_id, from: "1,4", to: "3,4" };
    expect(computer_move(ctx, params).result).toMatchObject({ san: "e5", position_id: "3" });
    for (const actor of [{ kind: "user", role: "black" }, { ...COMPUTER, app: "other" }, { ...COMPUTER, agent: "other" }, { ...COMPUTER, role: "white" }]) {
      expect(() => computer_move({ ...ctx, actor }, params)).toThrow(/declared computer/);
    }
    expect(() => computer_move(computerContext([]), { ...params, position: "0" })).toThrow(/not enabled/);
    expect(() => computer_move(ctx, { ...params, position: "0" })).toThrow(/stale/);
    expect(() => computer_move(ctx, { ...params, position: undefined })).toThrow(/stale/);
    expect(() => computer_move(ctx, { ...params, to: "4,4" })).toThrow(/illegal move/);
    expect(() => computer_move(ctx, { ...params, from: "e7" })).toThrow(/row,col/);
    const after = commit(log, computer_move(ctx, params), "agent:chess/luna#black");
    expect(() => computer_move(computerContext(after), params)).toThrow(/stale/);
    expect(() => computer_move(computerContext(after), { ...params, position: project(after).position_id })).toThrow(/not black's turn/);
  });

  it("prevents a human or external agent from moving the computer side and prevents bypasses", () => {
    const log = computerGame();
    expect(() => move(ctxFor(log, "black"), { from: "1,4", to: "3,4" })).toThrow(/controlled by the computer/);
    expect(() => move({ ...ctxFor(log, "black"), actor: { kind: "agent", role: "black" } }, { from: "1,4", to: "3,4" })).toThrow(/controlled by the computer/);
    expect(() => move(computerContext(log), { from: "1,4", to: "3,4" })).toThrow(/must use computer_move/);
    expect(() => resign(computerContext(log), {})).toThrow(/only propose computer_move/);
    expect(() => new_game(computerContext(log), {})).toThrow(/only propose computer_move/);
    expect(() => comment(computerContext(log), { text: "hello" })).toThrow(/only propose computer_move/);
    expect(() => resign(ctxFor(log, "black"), {})).toThrow(/controlled by the computer/);
  });

  it("rejects old results after resignation, reset and an identical opening in the next game", () => {
    let log = computerGame();
    const oldPosition = project(log).position_id;
    log = commit(log, resign(ctxFor(log, "white"), {}), "user:alice");
    expect(() => computer_move(computerContext(log), { position: project(log).position_id, from: "1,4", to: "3,4" })).toThrow(/game is over/);
    log = commit(log, new_game(ctxFor(log, "white"), {}), "user:alice");
    expect(project(log).opponent).toBe("computer");
    log = commit(log, move(ctxFor(log, "white"), { from: "6,4", to: "4,4" }), "user:alice");
    expect(project(log).fen).toBe(project(computerGame()).fen);
    expect(() => computer_move(computerContext(log), { position: oldPosition, from: "1,4", to: "3,4" })).toThrow(/stale/);
  });

  it("does not ask the computer to reply to white's checkmate", () => {
    let log = commit([], set_opponent(ctxFor([], "white"), { opponent: "computer" }), "user:alice");
    const pairs = [["6,4", "4,4"], ["1,4", "3,4"], ["7,5", "4,2"], ["0,1", "2,2"], ["7,3", "3,7"], ["0,6", "2,5"], ["3,7", "1,5"]];
    pairs.forEach(([from, to], index) => {
      const out = index % 2
        ? computer_move(computerContext(log), { position: project(log).position_id, from, to })
        : move(ctxFor(log, "white"), { from, to });
      if (index === pairs.length - 1) expect(out.result).not.toHaveProperty("computer_position");
      log = commit(log, out, index % 2 ? "agent:chess/luna#black" : "user:alice");
    });
    expect(project(log).status).toBe("checkmate");
  });
});

describe("move", () => {
  it("accepts a legal move and emits SAN plus the position after it", () => {
    const out = move(ctxFor([], "white", "alice"), { from: "6,4", to: "4,4" });
    expect(out.events).toHaveLength(1);
    expect(out.events[0].type).toBe("moved");
    expect(out.events[0].data).toMatchObject({ from: "6,4", to: "4,4", san: "e4" });
    expect(out.events[0].data.fen).toContain(" b ");
  });

  it("refuses an illegal move as a rules refusal, not a crash", () => {
    expect(() => move(ctxFor([], "white"), { from: "6,4", to: "3,4" })).toThrow(/illegal move e2-e5/);
  });

  it("refuses the actor whose seat is not the side to move", () => {
    expect(() => move(ctxFor([], "black", "bob"), { from: "1,4", to: "3,4" })).toThrow(/not black's turn/);
    const after = play(FOOLS_MATE.slice(0, 1));
    expect(() => move(ctxFor(after, "white"), { from: "6,4", to: "4,4" })).toThrow(/not white's turn/);
  });

  it("refuses a watcher or an unseated actor before reading the board at all", () => {
    expect(() => move(ctxFor([], "watcher"), { from: "6,4", to: "4,4" })).toThrow(/seated player/);
    expect(() => move(ctxFor([]), { from: "6,4", to: "4,4" })).toThrow(/seated player/);
  });

  it("refuses malformed coordinates", () => {
    for (const bad of ["e2", "8,0", "1", "1,2,3", 42, undefined]) {
      expect(() => move(ctxFor([], "white"), { from: bad, to: "4,4" })).toThrow(/row,col/);
    }
  });

  it("refuses every move after checkmate", () => {
    const log = play(FOOLS_MATE);
    expect(project(log).status).toBe("checkmate");
    expect(() => move(ctxFor(log, "white", "alice"), { from: "4,6", to: "3,6" })).toThrow(/game is over/);
  });
});

describe("resign and new_game", () => {
  it("ends the game for the resigning seat, then freezes it", () => {
    const log = commit([], resign(ctxFor([], "black", "bob"), { confirm: "确认" }), "user:bob");
    expect(log[0]!).toMatchObject({ type: "resigned", data: { by_color: "black" } });
    expect(project(log).status).toBe("resigned");
    expect(() => move(ctxFor(log, "white"), { from: "6,4", to: "4,4" })).toThrow(/game is over/);
    expect(() => resign(ctxFor(log, "white"), {})).toThrow(/game is over/);
  });

  it("new_game resets the position and the seats, for players only", () => {
    let log = play(FOOLS_MATE);
    log = commit(log, new_game(ctxFor(log, "white", "alice"), { confirm: "确认" }), "user:alice");
    const fresh = project(log);
    expect(fresh.status).toBe("playing");
    expect(fresh.moves).toEqual([]);
    expect(fresh.seats).toEqual({});
    expect(fresh.board.cells).toHaveLength(32);
    expect(() => new_game(ctxFor(log, "watcher"), {})).toThrow(/seated player/);
  });

  it("refuses to erase a game that is still in progress", () => {
    expect(() => new_game(ctxFor([], "white", "alice"), { confirm: "确认" })).toThrow(/still active/);
  });
});

describe("comment", () => {
  it("lets any seat — including a watcher — say a bounded line", () => {
    const out = comment(ctxFor([], "watcher", "carol"), { text: "白方开局稳健" });
    expect(out.events[0]).toMatchObject({ type: "commented", data: { text: "白方开局稳健" } });
  });

  it("still works after the game is over", () => {
    const log = play(FOOLS_MATE);
    expect(comment(ctxFor(log, "watcher"), { text: "精彩" }).events).toHaveLength(1);
  });

  it("refuses empty, blank and oversized text", () => {
    for (const bad of ["", "   ", "x".repeat(501), 42, undefined]) {
      expect(() => comment(ctxFor([], "white"), { text: bad })).toThrow(/1\.\.500/);
    }
  });
});

describe("attribution flows from the coordinator's stamps only", () => {
  it("seats, move list and comments all repeat the trusted `by`", () => {
    let log = play(FOOLS_MATE.slice(0, 2));
    log = commit(log, comment(ctxFor(log, "watcher", "carol"), { text: "有意思" }), "user:carol");
    const view = project(log);
    expect(view.seats).toEqual({ white: "alice", black: "bob" });
    expect(view.moves.map((row: any) => row.by)).toEqual(["alice", "bob"]);
    expect(view.comments[0]).toEqual({ text: "有意思", by: "carol" });
    // Whatever a handler proposes as `by` never survives the commit path above.
    expect(move(ctxFor(log, "white"), { from: "6,6", to: "4,6" }).events[0].by).toBe("chess");
  });
});
