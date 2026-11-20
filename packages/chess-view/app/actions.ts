/**
 * 国际象棋's action handlers — the RULES door (door 2 of ADR 0007).
 *
 * This file runs in a SES Compartment with no ambient anything. The `chess.js`
 * import below is real and is INLINED AT PACK TIME (ADR 0007 P6): the release
 * asset is a single self-contained module, the runtime still forbids every
 * import, and the backend code digest covers the inlined bytes.
 *
 * `ctx.actor` is EVIDENCE supplied by the trusted coordinator, not a request
 * parameter: door 1 already proved this principal is a seated member whose role
 * the action's allowlist admits. What this file adds is only what no platform
 * can know — whose turn it is and what the rules of chess allow. A throw here
 * is a bounded refusal that becomes `action_rejected`; it is never an
 * authority error, and the worst outcome of a bug here is a bad event in this
 * App's own log, repairable from the archived action history.
 */

import { Chess } from "chess.js";

const SIDE: Record<string, string> = { w: "white", b: "black" };
const RC = /^[0-7],[0-7]$/;

/** One move. Coordinates are `board.grid/v1`'s "row,col" wire form. */
export function move(ctx: any, params: any) {
  if (isComputer(ctx)) throw new Error("the computer must use computer_move with a position id");
  const seat = seatOf(ctx);
  return makeMove(ctx, params, seat);
}

/** A model proposal is bound to one position, never to a later turn or game. */
export function computer_move(ctx: any, params: any) {
  if (!isComputer(ctx) || ctx?.actor?.role !== "black") throw new Error("only the declared computer may do this");
  if (ctx?.state?.opponent !== "computer") throw new Error("computer mode is not enabled");
  if (typeof params?.position !== "string" || params.position !== ctx?.state?.position_id) {
    throw new Error("the computer's position is stale");
  }
  return makeMove(ctx, params, "black");
}

export function set_opponent(ctx: any, params: any) {
  if (ctx?.actor?.kind !== "user" || ctx?.actor?.role !== "white") {
    throw new Error("only the white player may choose an opponent");
  }
  liveGame(ctx);
  if (ctx?.state?.moves?.length) throw new Error("choose an opponent before the first move");
  if (params?.opponent !== "human" && params?.opponent !== "computer") throw new Error("unknown opponent");
  if (params.opponent === ctx?.state?.opponent) return { events: [], result: {} };
  return { events: [event(ctx, "opponent_set", { opponent: params.opponent })], result: {} };
}

function makeMove(ctx: any, params: any, seat: string) {
  const game = liveGame(ctx);
  if (SIDE[game.turn()] !== seat) throw new Error(`it is not ${seat}'s turn to move`);
  const from = square(params?.from);
  const to = square(params?.to);
  let made;
  try {
    // Promotion is auto-queen: the closed param set has no piece picker yet.
    made = game.move({ from, to, promotion: "q" });
  } catch {
    throw new Error(`illegal move ${from}-${to}`);
  }
  return {
    // `from`/`to` are re-emitted in their wire form so the projection can hand
    // them straight back to the board's `highlights` binding.
    events: [event(ctx, "moved", { from: String(params.from), to: String(params.to), san: made.san, fen: game.fen() })],
    result: {
      san: made.san,
      position_id: String(Number(ctx.state.position_id) + 1),
      ...(ctx?.state?.opponent === "computer" && game.turn() === "b" && !game.isGameOver()
        ? { computer_position: String(Number(ctx.state.position_id) + 1) }
        : {}),
    },
  };
}

export function resign(ctx: any, _params: any) {
  const seat = seatOf(ctx);
  liveGame(ctx);
  return { events: [event(ctx, "resigned", { by_color: seat })], result: {} };
}

export function new_game(ctx: any, _params: any) {
  seatOf(ctx);
  if (!["checkmate", "draw", "resigned"].includes(ctx?.state?.status)) {
    throw new Error("the current game is still active");
  }
  return { events: [event(ctx, "game_reset", {})], result: {} };
}

export function comment(ctx: any, params: any) {
  if (isComputer(ctx)) throw new Error("the computer may only propose computer_move");
  const text = params?.text;
  if (typeof text !== "string" || !text.trim() || text.length > 500) {
    throw new Error("a comment is 1..500 characters");
  }
  // Attribution is NOT proposed here: the trusted coordinator stamps `by`/`at`
  // on commit, and the projection reads only those stamps.
  return { events: [event(ctx, "commented", { text })], result: {} };
}

/** The actor's SEAT, from the coordinator's evidence — never from params. */
function seatOf(ctx: any): string {
  const role = ctx?.actor?.role;
  if (role !== "white" && role !== "black") throw new Error("only a seated player may do this");
  if (isComputer(ctx)) throw new Error("the computer may only propose computer_move");
  if (ctx?.state?.opponent === "computer" && role === "black") throw new Error("black is controlled by the computer in this game");
  return role;
}

function isComputer(ctx: any): boolean {
  return ctx?.actor?.kind === "agent" && ctx.actor.app === "chess" && ctx.actor.agent === "luna";
}

/** The game as the log left it, refused when it is already over. */
function liveGame(ctx: any): Chess {
  const status = ctx?.state?.status;
  if (status !== "playing" && status !== "check") throw new Error("the game is over; start a new one");
  const fen = ctx?.state?.fen;
  return typeof fen === "string" && fen ? new Chess(fen) : new Chess();
}

/** "row,col" (0-based, rank 8 at row 0) → algebraic, or a refusal. */
function square(value: any): string {
  if (typeof value !== "string" || !RC.test(value)) throw new Error('a square is "row,col" with 0..7');
  return "abcdefgh"[Number(value[2])] + String(8 - Number(value[0]));
}

/** `at` and `by` are proposals; the trusted coordinator overwrites both. */
function event(ctx: any, type: string, data: any) {
  return { type, data, at: String(ctx?.now ?? ""), by: "chess" };
}
