import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentViewProvider } from "@claude-bot/agent-view-react";
import { createFixtureAgentViewClient } from "@claude-bot/agent-view-preview";
import { ChessRoom } from "./ChessRoom.js";

function projection(overrides: Record<string, unknown> = {}) {
  return {
    board: {
      rows: 8,
      cols: 8,
      cells: [
        { r: 0, c: 4, glyph: "♚" },
        { r: 1, c: 4, glyph: "♟" },
        { r: 6, c: 4, glyph: "♙" },
        { r: 7, c: 4, glyph: "♔" },
      ],
    },
    turn: "white",
    status: "playing",
    frozen: false,
    viewer_role: "white",
    legal_moves: [{ from: "6,4", to: ["5,4", "4,4"] }],
    resigned_by: "",
    last_move: [],
    moves: [],
    comments: [],
    seats: { white: "alice", black: "bob" },
    ...overrides,
  };
}

function mount(view: Record<string, unknown>, actions: NonNullable<Parameters<typeof createFixtureAgentViewClient>[0]>["actions"] = {}) {
  const fixture = createFixtureAgentViewClient({ projection: view, actions });
  render(<AgentViewProvider client={fixture.client}><ChessRoom /></AgentViewProvider>);
  return fixture;
}

describe("ChessRoom", () => {
  it("offers the computer only before white's opening and waits for the authoritative mode", async () => {
    const fixture = mount(projection({ opponent: "human", can_set_opponent: true }), { set_opponent: { ok: true } });
    fireEvent.click(screen.getByRole("button", { name: "人工智障（电脑）" }));
    await waitFor(() => expect(fixture.proposals).toEqual([{ action: "set_opponent", params: { opponent: "computer" } }]));
    expect(screen.getByRole("button", { name: "玩家对战" })).toHaveAttribute("aria-pressed", "true");
    act(() => fixture.setProjection(projection({ opponent: "computer", can_set_opponent: true })));
    expect(screen.getByRole("button", { name: "人工智障（电脑）" })).toHaveAttribute("aria-pressed", "true");
  });

  it("requests exactly one computer reply after its own confirmed move, never on projection refresh", async () => {
    const next = projection({ opponent: "computer", position_id: "2", turn: "black", legal_moves: [], can_request_computer: true });
    const fixture = mount(projection({ opponent: "computer", position_id: "1" }), {
      move: () => {
        fixture.setProjection(next);
        return { ok: true, result: { san: "e4", computer_position: "2" } };
      },
      request_computer_move: { ok: true, result: { queued: true } },
    });
    fireEvent.click(screen.getByRole("gridcell", { name: /e2 白棋子/ }));
    fireEvent.click(screen.getByRole("gridcell", { name: /e4 空格/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交走子" }));
    await waitFor(() => expect(fixture.proposals).toEqual([
      { action: "move", params: { from: "6,4", to: "4,4" } },
      { action: "request_computer_move", params: { prompt: "请为 position_id=2 的局面走一步棋。" } },
    ]));
    expect(screen.getByRole("button", { name: "等待电脑" })).toBeDisabled();
    act(() => fixture.setProjection({ ...next, comments: [{ text: "hello" }] }));
    expect(fixture.proposals).toHaveLength(2);
    act(() => fixture.setProjection(projection({ opponent: "computer", position_id: "3" })));
    expect(screen.queryByRole("button", { name: "等待电脑" })).not.toBeInTheDocument();
  });

  it("does not request a model when a move is refused or ends the game", async () => {
    const fixture = mount(projection({ opponent: "computer", position_id: "1" }), {
      move: { ok: false, message: "illegal move" },
    });
    fireEvent.click(screen.getByRole("gridcell", { name: /e2 白棋子/ }));
    fireEvent.click(screen.getByRole("gridcell", { name: /e4 空格/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交走子" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("illegal move");
    expect(fixture.proposals.map((row) => row.action)).toEqual(["move"]);
    act(() => fixture.setProjection(projection({ opponent: "computer", frozen: true, status: "checkmate", legal_moves: [], can_request_computer: false })));
    expect(screen.queryByRole("button", { name: /电脑走子/ })).not.toBeInTheDocument();
    expect(fixture.proposals).toHaveLength(1);
  });

  it("shows a model-plane refusal and requires a deliberate retry", async () => {
    const fixture = mount(projection({ opponent: "computer", position_id: "2", turn: "black", legal_moves: [], can_request_computer: true }), {
      request_computer_move: { ok: false, code: "not_supported", message: "此部署没有启用 App agent 平面" },
    });
    expect(fixture.proposals).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "请电脑走子" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("此部署没有启用 App agent 平面");
    expect(fixture.proposals).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "再次请求电脑走子" }));
    await waitFor(() => expect(fixture.proposals).toHaveLength(2));
  });

  it("makes a slow queued reply manually recoverable without automatically retrying", async () => {
    vi.useFakeTimers();
    try {
      const fixture = mount(projection({ opponent: "computer", position_id: "2", turn: "black", legal_moves: [], can_request_computer: true }), {
        request_computer_move: { ok: true },
      });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "请电脑走子" })));
      expect(screen.getByRole("button", { name: "等待电脑" })).toBeDisabled();
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(screen.getByRole("button", { name: "再次请求电脑走子" })).toBeEnabled();
      expect(screen.getByText("尚未收到电脑落子，可手动再次请求。")).toBeInTheDocument();
      expect(fixture.proposals).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards an old move receipt after another game has become current", async () => {
    const fixture = mount(projection({ opponent: "computer", position_id: "1" }));
    let finish!: (reply: { ok: boolean; message: string; result: unknown }) => void;
    vi.spyOn(fixture.client, "propose").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("gridcell", { name: /e2 白棋子/ }));
    fireEvent.click(screen.getByRole("gridcell", { name: /e4 空格/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交走子" }));
    act(() => fixture.setProjection(projection({ opponent: "computer", position_id: "5", turn: "black", can_request_computer: true, legal_moves: [] })));
    await act(async () => finish({ ok: true, message: "", result: { computer_position: "2" } }));
    expect(fixture.proposals).toHaveLength(0);
  });

  it("keeps a human black seat read-only in computer mode", () => {
    mount(projection({ opponent: "computer", viewer_role: "black", turn: "black", can_control: false, legal_moves: [] }));
    expect(screen.queryByRole("button", { name: "提交走子" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /认输|人工智障（电脑）|电脑走子/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发布留言" })).toBeInTheDocument();
  });

  it("keeps all eight board ranks equal-height", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("packages/chess-view/src/styles/chess-v2.css", "utf8");
    document.head.append(style);
    try {
      const boardRule = Array.from(style.sheet?.cssRules ?? []).find(
        (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === ".chess-v2__board",
      );
      expect(boardRule).toBeDefined();
      expect(boardRule?.style.getPropertyValue("grid-template-rows"))
        .toBe(boardRule?.style.getPropertyValue("grid-template-columns"));
    } finally {
      style.remove();
    }
  });

  it("renders a watcher as genuinely read-only while keeping comments available", () => {
    mount(projection({ viewer_role: "watcher", legal_moves: [] }), { comment: { ok: true } });
    expect(screen.getByText("正在观战")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交走子" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /认输/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始新局" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发布留言" })).toBeInTheDocument();
  });

  it("rotates the black presentation without rotating canonical move params", async () => {
    const fixture = mount(projection({
      turn: "black",
      viewer_role: "black",
      legal_moves: [{ from: "1,4", to: ["3,4"] }],
    }), { move: { ok: true } });
    const board = screen.getByRole("grid", { name: "国际象棋棋盘" });
    expect(board).toHaveAttribute("data-orientation", "black");
    expect(within(board).getAllByRole("gridcell")[0]).toHaveAttribute("data-square", "7,7");

    fireEvent.click(screen.getByRole("gridcell", { name: /e7 黑棋子/ }));
    fireEvent.click(screen.getByRole("gridcell", { name: /e5 空格/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交走子" }));

    await waitFor(() => expect(fixture.proposals).toContainEqual({ action: "move", params: { from: "1,4", to: "3,4" } }));
  });

  it("keeps the selected move after a bounded refusal and exposes resubmission", async () => {
    mount(projection(), { move: { ok: false, code: "action_rejected", message: "局面版本已变化" } });
    fireEvent.click(screen.getByRole("gridcell", { name: /e2 白棋子/ }));
    fireEvent.click(screen.getByRole("gridcell", { name: /e4 空格/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交走子" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("局面版本已变化");
    expect(screen.getByRole("button", { name: "重新提交走子" })).toBeEnabled();
    expect(screen.getByRole("gridcell", { name: /e2 白棋子/ })).toHaveClass("is-selected");
    expect(screen.getByRole("gridcell", { name: /e4 空格/ })).toHaveClass("is-target");
  });
});
