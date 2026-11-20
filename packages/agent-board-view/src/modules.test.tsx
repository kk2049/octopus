/**
 * `board.grid/v1` driven through a real `app-data/v1` port — the fixture-backed
 * one from the data package's harness, a second real implementation of the
 * contract. What is asserted is the module's whole job: geometry rendered from
 * a projection, activations turned into flat-string proposals, and every
 * malformed input turned into a sentence instead of a crash. The final suite
 * mounts TWO instances through a real composition and shell, because "one
 * implementation, N boards" is the property ADR 0007 names this module for.
 */

import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode } from "react";
import type { AgentComposition } from "@claude-bot/agent-module-contract";
import { COMPOSITION_SCHEMA } from "@claude-bot/agent-module-contract";
import {
  WorkspaceShell,
  createModuleRegistry,
  createWorkspacePlan,
  useWorkspaceLayout,
  type LayoutPanel,
  type WorkspaceApi,
  type WorkspacePlan,
} from "@claude-bot/agent-view-react/workspace";
import { AppDataProvider, type AppDataReply } from "@claude-bot/agent-data-view";
import { createMemoryAppDataPort, type MemoryAppDataFixture } from "@claude-bot/agent-data-view/harness";
import { BOARD_GRID_MODULE_ID } from "./manifests.js";
import { BOARD_MODULES } from "./modules.js";

const PROJECTION = {
  board: {
    rows: 3,
    cols: 3,
    cells: [
      { r: 0, c: 0, glyph: "●", label: "甲", tone: "info" },
      { r: 1, c: 1, glyph: "○", label: "乙" },
    ],
  },
  mini: { rows: 2, cols: 2, cells: [] },
  marks: [{ r: 2, c: 2 }, "0,1"],
  locked: true,
};

function port(overrides: Partial<MemoryAppDataFixture> = {}) {
  return createMemoryAppDataPort({
    projection: PROJECTION,
    actions: { step: { ok: true, message: "" }, pick: { ok: true, message: "" } },
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeWorkspace(): WorkspaceApi {
  return {
    state: { panels: [], active: {} as never, focused: null, narrow: false, drilledIn: false, seq: 0 },
    open: () => true,
    openIntent: () => true,
    focus: () => undefined,
    close: () => undefined,
    report: () => undefined,
    back: () => undefined,
  };
}

function panel(config: Record<string, string | number | boolean>, overrides: Partial<LayoutPanel> = {}): LayoutPanel {
  return {
    panelId: "board",
    moduleId: BOARD_GRID_MODULE_ID,
    slot: "primary",
    resourceRef: null,
    resourceKind: null,
    label: "盘面",
    status: "ready",
    reason: "",
    detail: "",
    config,
    context: null,
    ...overrides,
  };
}

const Board = BOARD_MODULES[0]!.component;

function mount(fixture: ReturnType<typeof port>, children: ReactNode) {
  return render(<AppDataProvider port={fixture.port}>{children}</AppDataProvider>);
}

const cell = (key: string): HTMLElement => {
  const found = document.querySelector(`[data-bv-cell="${key}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no cell ${key}`);
  return found;
};

describe("rendering", () => {
  it("renders the grid its instance config points at, with glyphs in place", () => {
    mount(port(), <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("grid", { name: "盘面" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByRole("gridcell")).toHaveLength(9);
    expect(screen.getByRole("gridcell", { name: "甲" })).toHaveTextContent("●");
    // An empty position is still an addressable, interactive cell.
    expect(screen.getByRole("gridcell", { name: "2,1" })).toBeEnabled();
  });

  it("marks the cells a highlight path names, and only those", () => {
    mount(port(), <Board panel={panel({ source: "board", action: "step", highlights: "marks" })} workspace={fakeWorkspace()} />);
    expect(cell("2,2")).toHaveAttribute("data-bv-hi");
    expect(cell("0,1")).toHaveAttribute("data-bv-hi");
    expect(cell("0,0")).not.toHaveAttribute("data-bv-hi");
  });

  it("says which path is missing instead of rendering an empty board", () => {
    mount(port(), <Board panel={panel({ source: "nowhere", action: "step" })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("note")).toHaveTextContent("投影路径不存在");
    expect(screen.getByRole("note")).toHaveTextContent("nowhere");
  });

  it("renders a malformed board as a sentence, never a crash", () => {
    const fixture = createMemoryAppDataPort({ projection: { board: "nope" } });
    mount(fixture, <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("note")).toHaveTextContent("不是一份可读的盘面");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("refuses an oversized board with its own sentence", () => {
    const fixture = createMemoryAppDataPort({ projection: { board: { rows: 99, cols: 99 } } });
    mount(fixture, <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("note")).toHaveTextContent("超出");
  });

  it("says it is waiting before the first projection, then renders it", async () => {
    const fixture = createMemoryAppDataPort({ projection: null });
    mount(fixture, <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("note")).toHaveTextContent("等待第一份投影");
    fixture.setProjection(PROJECTION);
    await waitFor(() => expect(screen.getByRole("grid")).toBeInTheDocument());
  });
});

describe("mode cell", () => {
  it("proposes the configured action with the clicked coordinate as flat strings", async () => {
    const user = userEvent.setup();
    const fixture = port();
    mount(fixture, <Board panel={panel({ source: "board", action: "pick", mode: "cell" })} workspace={fakeWorkspace()} />);
    await user.click(cell("2,1"));
    await waitFor(() => expect(fixture.submissions).toHaveLength(1));
    expect(fixture.submissions[0]).toEqual({ action: "pick", values: { r: "2", c: "1" } });
    expect(cell("2,1")).not.toHaveAttribute("aria-selected");
  });
});

describe("mode move", () => {
  it("selects a source visibly, then proposes {from, to} and clears the selection", async () => {
    const user = userEvent.setup();
    const fixture = port();
    mount(fixture, <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);
    await user.click(cell("0,0"));
    expect(cell("0,0")).toHaveAttribute("aria-selected", "true");
    expect(fixture.submissions).toHaveLength(0);
    await user.click(cell("1,1"));
    await waitFor(() => expect(fixture.submissions).toHaveLength(1));
    expect(fixture.submissions[0]).toEqual({ action: "step", values: { from: "0,0", to: "1,1" } });
    expect(cell("0,0")).not.toHaveAttribute("aria-selected");
  });

  it("deselects when the selected cell is clicked again, proposing nothing", async () => {
    const user = userEvent.setup();
    const fixture = port();
    mount(fixture, <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);
    await user.click(cell("0,0"));
    await user.click(cell("0,0"));
    expect(cell("0,0")).not.toHaveAttribute("aria-selected");
    expect(fixture.submissions).toHaveLength(0);
  });

  it("shows the source glyph at the target while the configured action is inflight", async () => {
    const user = userEvent.setup();
    const answer = deferred<AppDataReply>();
    const fixture = port({ actions: { step: () => answer.promise } });
    mount(fixture, <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);

    await user.click(cell("0,0"));
    await user.click(cell("2,2"));

    await waitFor(() => expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true"));
    expect(cell("2,2")).toHaveClass("bv-pending");
    expect(cell("2,2")).toHaveTextContent("●");
    expect(cell("0,0")).toHaveClass("bv-origin");
    expect(cell("0,1")).toBeDisabled();
  });

  it("reverts a refused overlay, shows the bounded reason, and dismisses it", async () => {
    const user = userEvent.setup();
    const answer = deferred<AppDataReply>();
    const fixture = port({ actions: { step: () => answer.promise } });
    mount(fixture, <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);

    await user.click(cell("0,0"));
    await user.click(cell("2,2"));
    await waitFor(() => expect(cell("2,2")).toHaveClass("bv-pending"));
    answer.resolve({ ok: false, code: "refused", message: "it is not this actor's turn to move" });

    expect(await screen.findByText("it is not this actor's turn to move")).toBeInTheDocument();
    expect(cell("2,2")).not.toHaveClass("bv-pending");
    expect(cell("0,0")).toHaveTextContent("●");
    await user.click(screen.getByRole("button", { name: "清除" }));
    await waitFor(() => expect(screen.queryByText("it is not this actor's turn to move")).not.toBeInTheDocument());
  });

  it("drops the pending overlay after the authoritative projection confirms it", async () => {
    const user = userEvent.setup();
    const answer = deferred<AppDataReply>();
    const fixture = port({ actions: { step: () => answer.promise } });
    mount(fixture, <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);

    await user.click(cell("0,0"));
    await user.click(cell("2,2"));
    await waitFor(() => expect(cell("2,2")).toHaveClass("bv-pending"));
    fixture.setProjection({
      ...PROJECTION,
      board: {
        ...PROJECTION.board,
        cells: [
          { r: 1, c: 1, glyph: "○", label: "乙" },
          { r: 2, c: 2, glyph: "●", label: "甲", tone: "info" },
        ],
      },
    });
    await waitFor(() => expect(cell("2,2")).toHaveClass("bv-pending"));
    expect(cell("2,2")).toHaveTextContent("●");
    answer.resolve({ ok: true, message: "" });

    await waitFor(() => expect(screen.getByRole("grid")).not.toHaveAttribute("aria-busy"));
    expect(cell("2,2")).not.toHaveClass("bv-pending");
    expect(cell("2,2")).toHaveTextContent("●");
    expect(cell("0,0")).toHaveTextContent("");
  });
});

describe("keyboard", () => {
  it("moves focus with arrows and activates with Enter, same path as a click", async () => {
    const user = userEvent.setup();
    const fixture = port();
    mount(fixture, <Board panel={panel({ source: "board", action: "pick", mode: "cell" })} workspace={fakeWorkspace()} />);
    await user.tab();
    expect(cell("0,0")).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowDown}");
    expect(cell("1,1")).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fixture.submissions).toHaveLength(1));
    expect(fixture.submissions[0]).toEqual({ action: "pick", values: { r: "1", c: "1" } });
  });

  it("keeps arrow focus inside the grid at the edges", async () => {
    const user = userEvent.setup();
    mount(port(), <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);
    await user.tab();
    await user.keyboard("{ArrowUp}{ArrowLeft}");
    expect(cell("0,0")).toHaveFocus();
  });
});

describe("disabled and refused", () => {
  it("goes read-only when the disabled path is true", async () => {
    const user = userEvent.setup();
    const fixture = port();
    mount(fixture, <Board panel={panel({ source: "board", action: "step", disabled: "locked" })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("grid")).toHaveAttribute("aria-disabled", "true");
    await user.click(cell("0,0"));
    expect(cell("0,0")).not.toHaveAttribute("aria-selected");
    expect(fixture.submissions).toHaveLength(0);
  });

  it("renders the trusted side's refusal of a proposal, and clears it on the next try", async () => {
    const user = userEvent.setup();
    const fixture = port({ actions: { pick: { ok: false, code: "refused", message: "规则门拒绝了这次提议。" } } });
    mount(fixture, <Board panel={panel({ source: "board", action: "pick", mode: "cell" })} workspace={fakeWorkspace()} />);
    await user.click(cell("0,0"));
    expect(await screen.findByText("规则门拒绝了这次提议。")).toBeInTheDocument();
    await user.click(cell("0,1"));
    await waitFor(() => expect(fixture.submissions).toHaveLength(2));
  });

  it("surfaces the port's refusal snapshot like the data modules do", async () => {
    const fixture = port();
    mount(fixture, <Board panel={panel({ source: "board", action: "step" })} workspace={fakeWorkspace()} />);
    fixture.setRefusal("这个视图是只读的。");
    expect(await screen.findByText("这个视图是只读的。")).toBeInTheDocument();
  });
});

// ── one module, two boards ──────────────────────────────────────────────────

const TWO_BOARDS: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "demo",
  instances: [
    { instance: "main", module: BOARD_GRID_MODULE_ID, slot: "primary", config: { source: "board", action: "step" } },
    // `bottom`, not `secondary`: a standing document slot with no bound
    // resource is deliberately hidden on wide screens; a flow slot always paints.
    { instance: "mini", module: BOARD_GRID_MODULE_ID, slot: "bottom", config: { source: "mini", action: "pick", mode: "cell" } },
  ],
  open: [],
};

function Workspace({ plan }: { plan: WorkspacePlan }) {
  const { state, api } = useWorkspaceLayout(plan);
  return <WorkspaceShell plan={plan} state={state} api={api} />;
}

describe("one module, two instances", () => {
  const plan = (composition = TWO_BOARDS) =>
    createWorkspacePlan({ composition, registry: createModuleRegistry([...BOARD_MODULES]) });

  it("renders two differently-shaped boards from one implementation", () => {
    mount(port(), <Workspace plan={plan()} />);
    expect(screen.getAllByRole("grid")).toHaveLength(2);
    // 3×3 + 2×2: the instances differ only by the data the composition wrote.
    expect(screen.getAllByRole("gridcell")).toHaveLength(13);
  });

  it("refuses a composition whose config key the module never declared", () => {
    expect(() =>
      plan({
        ...TWO_BOARDS,
        instances: [
          { instance: "main", module: BOARD_GRID_MODULE_ID, slot: "primary", config: { source: "board", action: "step", pieces: "x" } },
        ],
      }),
    ).toThrow(/pieces/);
  });

  it("refuses a composition that omits a required config key", () => {
    expect(() =>
      plan({
        ...TWO_BOARDS,
        instances: [{ instance: "main", module: BOARD_GRID_MODULE_ID, slot: "primary", config: { source: "board" } }],
      }),
    ).toThrow(/action/);
  });
});
