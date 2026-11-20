import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  useAgentViewStatus,
  useProjection,
  useProposals,
  usePropose,
} from "@claude-bot/agent-view-react";
import "./styles/chess-v2.css";

type Side = "white" | "black";
type ViewerRole = Side | "watcher" | "";
type GameStatus = "playing" | "check" | "checkmate" | "draw" | "resigned";

interface BoardCell {
  r: number;
  c: number;
  glyph: string;
}

interface ChessProjection {
  board?: { rows?: number; cols?: number; cells?: BoardCell[] };
  turn?: Side;
  status?: GameStatus;
  frozen?: boolean;
  viewer_role?: ViewerRole;
  legal_moves?: Array<{ from?: string; to?: string[] }>;
  resigned_by?: Side | "";
  last_move?: string[];
  moves?: Array<{ n?: string; san?: string; by?: string }>;
  comments?: Array<{ text?: string; by?: string }>;
  seats?: Partial<Record<Side, string>>;
  opponent?: "human" | "computer";
  position_id?: string;
  computer?: { name?: string; model?: string; effort?: string };
  can_control?: boolean;
  can_set_opponent?: boolean;
  can_request_computer?: boolean;
}

const FILES = "abcdefgh";
const WHITE_GLYPHS = new Set(["♔", "♕", "♖", "♗", "♘", "♙"]);

function sideLabel(side: Side): string {
  return side === "white" ? "白方" : "黑方";
}

function opposite(side: Side): Side {
  return side === "white" ? "black" : "white";
}

function coordinate(r: number, c: number): string {
  return `${r},${c}`;
}

function algebraic(wire: string): string {
  const match = /^([0-7]),([0-7])$/.exec(wire);
  if (!match) return wire;
  const r = Number(match[1]);
  const c = Number(match[2]);
  return `${FILES[c]}${8 - r}`;
}

function safeCells(projection: ChessProjection): BoardCell[] {
  return Array.isArray(projection.board?.cells)
    ? projection.board.cells.filter((cell) => Number.isInteger(cell?.r) && Number.isInteger(cell?.c) && typeof cell?.glyph === "string")
    : [];
}

function statusCopy(projection: ChessProjection): { title: string; detail: string; mark: string } {
  const role = projection.viewer_role ?? "";
  const turn = projection.turn ?? "white";
  const status = projection.status ?? "playing";
  if (status === "checkmate") {
    return { title: "将死，本局结束", detail: `${sideLabel(opposite(turn))}获胜。棋盘与棋谱已封存。`, mark: "×" };
  }
  if (status === "draw") {
    return { title: "和棋，本局结束", detail: "棋盘与棋谱已封存。", mark: "=" };
  }
  if (status === "resigned") {
    const resigned = projection.resigned_by;
    return resigned === "white" || resigned === "black"
      ? { title: `${sideLabel(resigned)}认输`, detail: `${sideLabel(opposite(resigned))}获胜。`, mark: "·" }
      : { title: "有棋手认输", detail: "本局已经结束。", mark: "·" };
  }
  if (projection.opponent === "computer" && turn === "black") {
    return { title: "等待人工智障落子", detail: "电脑执黑。落子确认后棋盘会自动更新。", mark: "◇" };
  }
  if (role === "watcher" || (projection.opponent === "computer" && role === "black")) {
    return status === "check"
      ? { title: `${sideLabel(turn)}被将军`, detail: "正在等待在座棋手应对；观战席不能代替棋手行动。", mark: "!" }
      : { title: "正在观战", detail: `轮到${sideLabel(turn)}。你可以查看棋谱或参与桌边讨论。`, mark: "○" };
  }
  if (role === turn) {
    return status === "check"
      ? { title: `${sideLabel(turn)}被将军`, detail: "必须先解除王的威胁。选择一个投影允许的走法。", mark: "!" }
      : { title: `轮到你，${sideLabel(turn)}`, detail: "先选棋子，再选高亮目标格；提交后等待可信外层确认。", mark: "◆" };
  }
  if (role === "white" || role === "black") {
    return { title: `等待${sideLabel(turn)}`, detail: `你执${sideLabel(role)}。对手行动确认后棋盘会更新。`, mark: "◇" };
  }
  return { title: "只读棋局", detail: `轮到${sideLabel(turn)}。当前视图没有可用席位证据。`, mark: "○" };
}

export function ChessRoom() {
  const projection = useProjection<ChessProjection>();
  const propose = usePropose();
  const { proposals, dismiss } = useProposals();
  const transport = useAgentViewStatus();
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [confirming, setConfirming] = useState<"resign" | "new_game" | null>(null);
  const [autoRequest, setAutoRequest] = useState<{ position: string; previous?: string } | null>(null);
  const [computerRequest, setComputerRequest] = useState<{
    position: string; phase: "sending" | "waiting" | "slow" | "refused";
  } | null>(null);
  const lifetime = useRef(0);
  const requesting = useRef(false);
  const lastRequestedPosition = useRef<string | null>(null);
  const submittingMove = useRef(false);

  const view = projection ?? {};
  const currentView = useRef(view);
  currentView.current = view;
  const role = view.viewer_role ?? "";
  const turn = view.turn ?? "white";
  const frozen = view.frozen === true;
  const cells = safeCells(view);
  const pieces = useMemo(() => new Map(cells.map((cell) => [coordinate(cell.r, cell.c), cell.glyph])), [cells]);
  const legal = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const move of Array.isArray(view.legal_moves) ? view.legal_moves : []) {
      if (typeof move?.from !== "string" || !Array.isArray(move.to)) continue;
      map.set(move.from, move.to.filter((item): item is string => typeof item === "string"));
    }
    return map;
  }, [view.legal_moves]);

  const latestProposal = (action: string) => [...proposals].reverse().find((item) => item.action === action);
  const moveProposal = latestProposal("move");
  const commentProposal = latestProposal("comment");
  const resignProposal = latestProposal("resign");
  const newGameProposal = latestProposal("new_game");
  const opponentProposal = latestProposal("set_opponent");
  const computerProposal = latestProposal("request_computer_move");
  const terminalRefusal = [resignProposal, newGameProposal].find((item) => item?.phase === "refused");
  const movePending = moveProposal?.phase === "inflight";
  const canControl = view.can_control ?? ((role === "white" || role === "black") && !(view.opponent === "computer" && role === "black"));
  const canMove = canControl && role === turn && !frozen;
  const currentRequest = computerRequest?.position === view.position_id ? computerRequest : null;
  const computerBusy = currentRequest?.phase === "sending" || currentRequest?.phase === "waiting";
  const decision = statusCopy(view);

  const rowOrder = role === "black" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const colOrder = role === "black" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const targetOptions = selected ? legal.get(selected) ?? [] : [];

  useEffect(() => {
    lifetime.current += 1;
    return () => { lifetime.current += 1; };
  }, []);

  // Only a confirmed move made in this View requests an automatic reply.
  // Reopening the board or receiving another tab's frame never spends a turn.
  useEffect(() => {
    if (!autoRequest) return;
    if (view.position_id === autoRequest.position && view.can_request_computer) {
      setAutoRequest(null);
      void requestComputer(autoRequest.position, true);
    } else if (view.position_id !== autoRequest.previous || frozen || view.opponent !== "computer") {
      setAutoRequest(null);
    }
  }, [autoRequest, view.position_id, view.can_request_computer, frozen, view.opponent]);

  useEffect(() => {
    if (currentRequest?.phase !== "waiting") return;
    const position = currentRequest.position;
    const timer = setTimeout(() => setComputerRequest((previous) => previous?.position === position
      ? { position, phase: "slow" } : previous), 60_000);
    return () => clearTimeout(timer);
  }, [currentRequest?.position, currentRequest?.phase]);

  useEffect(() => {
    if (selected && !legal.has(selected)) {
      setSelected(null);
      setTarget(null);
      return;
    }
    if (selected && target && !(legal.get(selected) ?? []).includes(target)) setTarget(null);
  }, [legal, selected, target]);

  function chooseSquare(wire: string): void {
    if (!canMove || movePending) return;
    if (moveProposal?.phase === "refused") dismiss(moveProposal.rid);
    if (selected && targetOptions.includes(wire)) {
      setTarget(wire);
      return;
    }
    if (legal.has(wire)) {
      setSelected(wire);
      setTarget(null);
      return;
    }
    setSelected(null);
    setTarget(null);
  }

  async function submitMove(): Promise<void> {
    if (!selected || !target || movePending || submittingMove.current || !canMove) return;
    submittingMove.current = true;
    const generation = lifetime.current;
    const previous = view.position_id;
    if (moveProposal?.phase === "refused") dismiss(moveProposal.rid);
    const reply = await propose("move", { from: selected, to: target });
    submittingMove.current = false;
    if (generation !== lifetime.current) return;
    if (reply.ok) {
      const result = reply.result as { computer_position?: unknown; position_id?: unknown } | undefined;
      const confirmedPosition = result?.position_id ?? result?.computer_position;
      if (previous !== undefined && currentView.current.position_id !== previous
        && currentView.current.position_id !== confirmedPosition) return;
      setSelected(null);
      setTarget(null);
      if (typeof result?.computer_position === "string") {
        setAutoRequest({ position: result.computer_position, previous });
      }
    }
  }

  async function requestComputer(position: string, automatic = false): Promise<void> {
    const latest = currentView.current;
    if (requesting.current || latest.position_id !== position || !latest.can_request_computer) return;
    if (automatic && lastRequestedPosition.current === position) return;
    requesting.current = true;
    lastRequestedPosition.current = position;
    const generation = lifetime.current;
    if (computerProposal?.phase === "refused") dismiss(computerProposal.rid);
    setComputerRequest({ position, phase: "sending" });
    const reply = await propose("request_computer_move", { prompt: `请为 position_id=${position} 的局面走一步棋。` });
    requesting.current = false;
    if (generation !== lifetime.current || currentView.current.position_id !== position) return;
    setComputerRequest({ position, phase: reply.ok ? "waiting" : "refused" });
  }

  async function chooseOpponent(opponent: "human" | "computer"): Promise<void> {
    if (!view.can_set_opponent || opponentProposal?.phase === "inflight" || movePending) return;
    if (opponentProposal?.phase === "refused") dismiss(opponentProposal.rid);
    // The selected mode is rendered from the confirmed projection only.
    await propose("set_opponent", { opponent });
  }

  async function submitComment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = commentDraft.trim();
    if (!text || text.length > 500 || commentProposal?.phase === "inflight") return;
    if (commentProposal?.phase === "refused") dismiss(commentProposal.rid);
    const reply = await propose("comment", { text });
    if (reply.ok) setCommentDraft("");
  }

  async function confirmAction(): Promise<void> {
    if (!confirming) return;
    const action = confirming;
    const previous = action === "resign" ? resignProposal : newGameProposal;
    if (previous?.phase === "refused") dismiss(previous.rid);
    setConfirming(null);
    await propose(action, { confirm: "确认" });
  }

  if (!projection) {
    return <div className="chess-v2__transport" role="status">等待可信棋局投影…</div>;
  }

  return (
    <div className="chess-v2">
      <header className="chess-v2__topbar">
        <div className="chess-v2__brand"><span aria-hidden="true">64</span><strong>檀木棋室</strong></div>
        <div className="chess-v2__transport-state" role="status">
          {transport.phase === "closed" ? "可信通道已关闭" : role === "watcher" ? "观战席" : role ? `${sideLabel(role)}席` : "只读"}
        </div>
      </header>

      <main className="chess-v2__layout">
        <aside className="chess-v2__panel chess-v2__seats" aria-label="座次">
          <div className="chess-v2__eyebrow">At the table</div>
          <h2>座次</h2>
          {(["white", "black"] as const).map((side) => (
            <div className="chess-v2__seat" key={side}>
              <span className={`chess-v2__seat-disc chess-v2__seat-disc--${side}`} aria-hidden="true">{side === "white" ? "白" : "黑"}</span>
              <span><strong>{side === "black" && view.opponent === "computer" ? view.computer?.name || "人工智障" : view.seats?.[side] || "虚位以待"}</strong><small>{sideLabel(side)}{role === side && canControl ? " · 你" : ""}</small></span>
              {turn === side && !frozen ? <i aria-label="当前行棋" /> : null}
            </div>
          ))}
          {role === "watcher" ? <p className="chess-v2__notice">你在观战席。棋盘仅供查看，唯一可提议的动作是评论。</p> : null}
          <section className="chess-v2__opponent" aria-label="对战模式">
            <h3>{view.opponent === "computer" ? "人工智障模式" : "玩家对战"}</h3>
            {view.opponent === "computer" ? <p>白方先手，电脑执黑。<small>{view.computer?.model} · {view.computer?.effort}</small></p> : null}
            {view.can_set_opponent ? <div className="chess-v2__opponent-options">
              <button type="button" aria-pressed={view.opponent !== "computer"} disabled={opponentProposal?.phase === "inflight" || movePending} onClick={() => chooseOpponent("human")}>玩家对战</button>
              <button type="button" aria-pressed={view.opponent === "computer"} disabled={opponentProposal?.phase === "inflight" || movePending} onClick={() => chooseOpponent("computer")}>人工智障（电脑）</button>
              <small>{opponentProposal?.phase === "inflight" ? "正在切换对手…" : "第一步走子后，本局模式锁定。"}</small>
            </div> : null}
            {view.opponent === "computer" && role === "black" ? <p className="chess-v2__notice">本局黑方由电脑执棋，你可以观战和评论。</p> : null}
            {opponentProposal?.phase === "refused" ? <p role="alert">{opponentProposal.message || "切换对手被拒绝。"}</p> : null}
          </section>
        </aside>

        <section className="chess-v2__game" aria-labelledby="chess-decision-title">
          <div className="chess-v2__decision">
            <span className="chess-v2__decision-mark" aria-hidden="true">{decision.mark}</span>
            <div><div className="chess-v2__eyebrow">Current decision</div><h1 id="chess-decision-title">{decision.title}</h1><p>{decision.detail}</p></div>
          </div>

          {moveProposal?.phase === "refused" ? (
            <div className="chess-v2__alert chess-v2__alert--error" role="alert">
              <span>{moveProposal.message || "走子被拒绝。"}</span>
              <button type="button" onClick={() => dismiss(moveProposal.rid)}>关闭</button>
            </div>
          ) : null}

          <div className="chess-v2__board-frame">
            <div className="chess-v2__board" role="grid" aria-label="国际象棋棋盘" data-orientation={role === "black" ? "black" : "white"}>
              {rowOrder.flatMap((r) => colOrder.map((c) => {
                const wire = coordinate(r, c);
                const glyph = pieces.get(wire) ?? "";
                const fileRank = algebraic(wire);
                const selectable = canMove && legal.has(wire);
                const destination = selected !== null && targetOptions.includes(wire);
                const isLast = Array.isArray(view.last_move) && view.last_move.includes(wire);
                const classes = ["chess-v2__square", (r + c) % 2 === 0 ? "is-light" : "is-dark", selectable ? "is-selectable" : "", destination ? "is-destination" : "", selected === wire ? "is-selected" : "", target === wire ? "is-target" : "", isLast ? "is-last" : ""].filter(Boolean).join(" ");
                return (
                  <button
                    key={wire}
                    type="button"
                    role="gridcell"
                    data-square={wire}
                    aria-label={`${fileRank}${glyph ? ` ${WHITE_GLYPHS.has(glyph) ? "白" : "黑"}棋子 ${glyph}` : " 空格"}`}
                    className={classes}
                    disabled={movePending || (!selectable && !destination)}
                    onClick={() => chooseSquare(wire)}
                  >
                    <span className={WHITE_GLYPHS.has(glyph) ? "is-white-piece" : "is-black-piece"}>{glyph}</span>
                    {(role === "black" ? r === 0 : r === 7) ? <small className="chess-v2__file">{FILES[c]}</small> : null}
                    {(role === "black" ? c === 7 : c === 0) ? <small className="chess-v2__rank">{8 - r}</small> : null}
                  </button>
                );
              }))}
            </div>
            <div className="chess-v2__orientation">{role === "black" ? "黑方视角 · canonical 坐标不变" : "白方视角"}</div>
          </div>

          <div className="chess-v2__move-dock" aria-live="polite">
            <div>
              <strong>{movePending ? `正在确认 ${algebraic(selected ?? "")}–${algebraic(target ?? "")}` : target ? `${algebraic(selected ?? "")} → ${algebraic(target)}` : selected ? `已选择 ${algebraic(selected)}` : canMove ? "选择棋子" : role === "watcher" ? "观战席只读" : `等待${sideLabel(turn)}`}</strong>
              <span>{movePending ? "权威投影更新前不会移动棋子，也不能重复提交。" : target ? "目标已选；提交后才会生效。" : selected ? "选择一个绿色目标格。" : "棋盘只高亮投影给出的合法落点。"}</span>
            </div>
            {canMove ? <button type="button" className="chess-v2__primary" disabled={!target || movePending} onClick={submitMove}>{movePending ? "确认中" : moveProposal?.phase === "refused" ? "重新提交走子" : "提交走子"}</button> : null}
          </div>

          {view.can_request_computer && view.position_id ? <div className="chess-v2__computer" aria-live="polite">
            <p>{currentRequest?.phase === "sending" ? "正在请求电脑走子…"
              : currentRequest?.phase === "waiting" ? "请求已提交，等待电脑落子。"
              : currentRequest?.phase === "slow" ? "尚未收到电脑落子，可手动再次请求。"
              : "轮到电脑，可以请求它走一步。"}</p>
            <button type="button" disabled={computerBusy} onClick={() => requestComputer(view.position_id!)}>{computerBusy ? "等待电脑" : currentRequest ? "再次请求电脑走子" : "请电脑走子"}</button>
            {computerProposal?.phase === "refused" ? <p role="alert">{computerProposal.message || "电脑走子请求被拒绝。"}</p> : null}
          </div> : null}

          {canControl ? (
            <div className="chess-v2__game-actions">
              {!frozen ? <button type="button" className="chess-v2__danger" disabled={resignProposal?.phase === "inflight"} onClick={() => setConfirming("resign")}>认输…</button> : <button type="button" className="chess-v2__primary" disabled={newGameProposal?.phase === "inflight"} onClick={() => setConfirming("new_game")}>开始新局</button>}
            </div>
          ) : null}
          {terminalRefusal ? <div className="chess-v2__alert chess-v2__alert--error" role="alert"><span>{terminalRefusal.message || "对局动作被拒绝。"}</span><button type="button" onClick={() => dismiss(terminalRefusal.rid)}>关闭</button></div> : null}
        </section>

        <aside className="chess-v2__panel chess-v2__support">
          <section><div className="chess-v2__eyebrow">Move record</div><h2>棋谱</h2><div className="chess-v2__moves">{Array.isArray(view.moves) && view.moves.length ? view.moves.map((move, index) => <div key={`${move.n ?? index}-${index}`}><span>{index + 1}</span><strong>{move.san || "—"}</strong><small>{move.by || "未知席位"}</small></div>) : <p className="chess-v2__empty">尚无走子</p>}</div></section>
          <section><div className="chess-v2__eyebrow">Table talk</div><h2>桌边讨论</h2><div className="chess-v2__comments">{Array.isArray(view.comments) && view.comments.length ? view.comments.map((comment, index) => <article key={`${comment.by ?? ""}-${index}`}><strong>{comment.by || "未知席位"}</strong><p>{comment.text || ""}</p></article>) : <p className="chess-v2__empty">尚无评论</p>}</div>
            {commentProposal?.phase === "refused" ? <div className="chess-v2__alert chess-v2__alert--error" role="alert">{commentProposal.message || "评论被拒绝。"}</div> : null}
            <form onSubmit={submitComment} className="chess-v2__composer"><label htmlFor="chess-comment">发言</label><textarea id="chess-comment" maxLength={500} value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} placeholder="写下对局相关的留言…" /><div><span>{commentDraft.length} / 500</span><button type="submit" disabled={!commentDraft.trim() || commentProposal?.phase === "inflight"}>{commentProposal?.phase === "inflight" ? "发布中" : "发布留言"}</button></div></form>
          </section>
        </aside>
      </main>

      {confirming ? (
        <div className="chess-v2__modal-backdrop" role="presentation">
          <div className="chess-v2__modal" role="dialog" aria-modal="true" aria-labelledby="chess-confirm-title">
            <div className="chess-v2__eyebrow">不可撤回</div>
            <h2 id="chess-confirm-title">{confirming === "resign" ? "确认认输？" : "确认开始新局？"}</h2>
            <p>{confirming === "resign" ? "确认后本局立即结束。" : "确认后清空当前棋局，评论会保留。"}</p>
            <div><button type="button" onClick={() => setConfirming(null)}>取消</button><button type="button" className={confirming === "resign" ? "chess-v2__danger" : "chess-v2__primary"} onClick={confirmAction}>确认</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
