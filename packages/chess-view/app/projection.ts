/**
 * 国际象棋's projection: the shared event log folded into what every member's
 * generic modules read. Same Compartment rules as `actions.ts`; the `chess.js`
 * import is inlined at pack time.
 *
 * Attribution comes ONLY from each event's coordinator-stamped `by` (ADR 0007
 * P2): the seat map, the move list and the comments all repeat that stamp, so
 * nothing an App handler proposes can claim another author. The static form
 * declarations ride in the projection because a generic module is told a PATH,
 * and everything it renders has to be somewhere on the other end of one.
 */

import { Chess } from "chess.js";

const GLYPHS: Record<string, Record<string, string>> = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

const STATUS_TEXT: Record<string, string> = {
  playing: "对局进行中", check: "将军！", checkmate: "将死，对局结束", draw: "和棋", resigned: "认输，对局结束",
};

export function project(events: any[], context?: any) {
  return projectIncremental({}, events, context);
}

export function projectIncremental(snapshot: any, events: any[], context?: any) {
  const prior = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  let opponent = prior.opponent === "computer" ? "computer" : "human";
  let position = Number(prior.position_id ?? 0);
  if (!Number.isSafeInteger(position) || position < 0) position = 0;
  let fen = typeof prior.fen === "string" ? prior.fen : "";
  let resigned = typeof prior.resigned_by === "string" ? prior.resigned_by : "";
  let last: string[] = Array.isArray(prior.last_move) ? prior.last_move.map(String).slice(0, 2) : [];
  let moves: any[] = Array.isArray(prior.moves)
    ? prior.moves.map((move: any) => move && typeof move === "object" ? { ...move } : move)
    : [];
  const comments: any[] = Array.isArray(prior.comments)
    ? prior.comments.map((comment: any) => comment && typeof comment === "object" ? { ...comment } : comment)
    : [];
  let commentCount = Number(prior?.status_panel?.评论数);
  if (!Number.isSafeInteger(commentCount) || commentCount < comments.length) commentCount = comments.length;
  const seats: Record<string, string> = prior.seats && typeof prior.seats === "object" && !Array.isArray(prior.seats)
    ? Object.fromEntries(Object.entries(prior.seats).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  for (const row of Array.isArray(events) ? events : []) {
    const by = String(row?.by ?? "").replace(/^user:/, "");
    if (row?.type === "moved") {
      position += 1;
      fen = String(row?.data?.fen ?? "");
      last = [String(row?.data?.from ?? ""), String(row?.data?.to ?? "")];
      moves.push({ n: String(moves.length + 1), san: String(row?.data?.san ?? ""), by });
      // Who plays a colour is DERIVED from who moved it first — there is no
      // other seat record inside the log, and the stamp cannot be forged.
      seats[moves.length % 2 ? "white" : "black"] ||= by;
    } else if (row?.type === "resigned") {
      const color = String(row?.data?.by_color ?? "");
      if (color === "white" || color === "black") {
        resigned = color;
        position += 1;
        seats[color] ||= by;
      }
    } else if (row?.type === "game_reset") {
      position += 1;
      fen = "";
      resigned = "";
      last = [];
      moves = [];
      delete seats.white;
      delete seats.black;
    } else if (row?.type === "opponent_set") {
      if (row?.data?.opponent === "human" || row?.data?.opponent === "computer") {
        opponent = row.data.opponent;
        position += 1;
      }
    } else if (row?.type === "commented") {
      comments.push({ text: String(row?.data?.text ?? ""), by });
      commentCount += 1;
    }
  }
  // The last FEN was written by our own `move` handler; a malformed one (a
  // hand-repaired log, say) falls back to the opening position instead of
  // taking the whole projection down.
  let game: Chess;
  try {
    game = fen ? new Chess(fen) : new Chess();
  } catch {
    game = new Chess();
  }
  const status = resigned ? "resigned"
    : game.isCheckmate() ? "checkmate"
    : game.isDraw() ? "draw"
    : game.inCheck() ? "check"
    : "playing";
  const turn = game.turn() === "w" ? "white" : "black";
  const viewerRole = viewerRoleOf(context);
  const computerViewer = context?.viewer?.kind === "agent"
    && context.viewer.app === "chess" && context.viewer.agent === "luna";
  const playing = status === "playing" || status === "check";
  const canControl = (viewerRole === "white" || viewerRole === "black")
    && !computerViewer && !(opponent === "computer" && viewerRole === "black");
  const canMove = viewerRole === turn && playing
    && (computerViewer ? opponent === "computer" && viewerRole === "black" : canControl);
  const cells: any[] = [];
  game.board().forEach((rank, r) => {
    rank.forEach((piece, c) => {
      if (piece) cells.push({ r, c, glyph: GLYPHS[piece.color]?.[piece.type] ?? "?" });
    });
  });
  return {
    board: { rows: 8, cols: 8, cells },
    fen: game.fen(),
    turn,
    status,
    frozen: !playing,
    opponent,
    position_id: String(position),
    computer: { name: "人工智障", model: "gpt-5.6-luna", effort: "max" },
    can_control: canControl,
    can_set_opponent: context?.viewer?.kind === "user" && viewerRole === "white" && playing && moves.length === 0,
    can_request_computer: context?.viewer?.kind === "user" && viewerRole === "white"
      && opponent === "computer" && turn === "black" && playing,
    viewer_role: viewerRole,
    legal_moves: canMove ? legalMoves(game) : [],
    resigned_by: resigned,
    last_move: last,
    moves,
    comments: comments.slice(-100),
    seats,
    status_panel: {
      title: "对局",
      状态: STATUS_TEXT[status] ?? status,
      轮到: turn === "white" ? "白方" : "黑方",
      白方: seats.white ?? "虚位以待",
      黑方: opponent === "computer" ? "人工智障" : seats.black ?? "虚位以待",
      评论数: String(commentCount),
    },
    /** What `data.form/v1` generates the comment box from — same statement `app.yaml` validates. */
    comment_params: { text: { type: "text", label: "评论", required: true, description: "对局面说一句话" } },
    /** One shared declaration for the two confirm-only buttons (认输 / 重新开局). */
    confirm_params: { confirm: { type: "string", label: "确认操作", enum: ["确认"], required: true } },
  };
}

function viewerRoleOf(context: any): "white" | "black" | "watcher" | "" {
  const role = context?.viewer?.role;
  return role === "white" || role === "black" || role === "watcher" ? role : "";
}

function legalMoves(game: Chess): Array<{ from: string; to: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const move of game.moves({ verbose: true }) as Array<{ from: string; to: string }>) {
    const from = coordinates(move.from);
    const targets = grouped.get(from) ?? [];
    const to = coordinates(move.to);
    if (!targets.includes(to)) targets.push(to);
    grouped.set(from, targets);
  }
  return [...grouped].map(([from, to]) => ({ from, to }));
}

function coordinates(square: string): string {
  const column = "abcdefgh".indexOf(square[0] ?? "");
  const rank = Number(square[1]);
  return `${8 - rank},${column}`;
}
