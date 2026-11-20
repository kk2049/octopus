import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";

const fixture = vi.hoisted(() => ({ epoch: 0, dataEpoch: undefined as number | undefined, layoutReady: true, role: "owner", viewer: "tester", nodes: [] as unknown[], edges: [] as unknown[], subscriptions: [] as unknown[], moves: [] as Record<string, { x: number; y: number }>[], propose: vi.fn() }));
vi.mock("@claude-bot/agent-view-react", () => ({
  useProjection: () => ({ canvas: { project: "test-project", viewer: fixture.viewer, role: fixture.role, epoch: fixture.epoch, dataEpoch: fixture.dataEpoch } }),
  useAgentViewStatus: () => ({ ready: true }),
  usePropose: () => fixture.propose,
}));
vi.mock("./collaboration.js", () => ({ CanvasDocument: class {
  positions = new Map();
  edgePorts = new Map();
  revision = "layout";
  beginMove = () => true;
  arrange = async () => true;
  endMove = async () => {};
  endMoves = async (points: Record<string, { x: number; y: number }>) => { fixture.moves.push(points); return true; };
  routeEdge = async () => true;
  subscribe = () => () => {};
  state = { get ready() { return fixture.layoutReady; }, pending: false, error: "" };
  snapshot = () => this.state;
  sync = async () => {};
  close = () => {};
  text = () => "正文";
  replaceText = () => {};
} }));
vi.mock("./windows/NodeWindow.js", () => ({ NodeWindow: ({ open, openFile }: { open(id: string): void; openFile(path: string): void }) => <><input aria-label="详情草稿" defaultValue="" /><button onClick={() => open("external")}>打开引用资料</button><button onClick={() => openFile("/work/bounded.md")}>打开会话文件</button></> }));
import { App } from "./App.js";
const stamp = { kind: "human", owner: "tester", model: null };
const node = (id: string, title: string, members?: string[]) => ({ id, title, type: members ? "folder" : "task", schema: 1, version: 1, snapshot: "graph-snapshot", archived: false, phase: "future", summary: "工作说明", x: 15000, y: 8000, data: members ? { members } : {}, created: stamp, updated: stamp }) as ResearchNode;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  localStorage.setItem("research-v2:tester:test-project:view-mode", JSON.stringify("canvas"));
  fixture.epoch = 0; fixture.dataEpoch = undefined; fixture.layoutReady = true; fixture.role = "owner"; fixture.viewer = "tester"; fixture.moves = [];
  fixture.subscriptions = [];
  fixture.nodes = [node("A", "A 研究方向", ["A0"]), node("A0", "A0 具体事项", ["analysis", "review"]), node("analysis", "因果分析"), node("review", "验收材料"), node("external", "其他资料")];
  fixture.edges = [{ id: "inside", source: "analysis", target: "review", label: "佐证", version: 7, archived: false, created: stamp }, { id: "outside", source: "analysis", target: "external", label: "关联", version: 3, archived: false, created: stamp }];
  fixture.propose.mockReset();
  fixture.propose.mockImplementation(async (action: string) => ({ ok: true, result: action === "workflow_read" ? { drafts: [], flags: [], rules: [], batches: [], executions: [], agents: [], runs: [], summaries: {}, truncated: false } : action === "source_list" ? { items: [] } : action === "resources_list" ? { resources: [] } : action === "canvas_read" ? { nodes: fixture.nodes, edges: fixture.edges, subscriptions: fixture.subscriptions, proposals: [], runs: [], cursor: 1, next: null } : { changes: [], cursor: 2, hasMore: false } }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1440, height: 940, left: 0, top: 0, right: 1440, bottom: 940, x: 0, y: 0, toJSON() {} });
});
describe("scoped research workspace", () => {
  it("opens source, workflow and asset panels while preserving an unsent review draft", async () => {
    render(<App />);
    await screen.findByRole("article", { name: "A 研究方向" });
    expect(screen.queryByRole("complementary", { name: "Agent 活动与协作" })).not.toBeInTheDocument();
    expect(fixture.propose.mock.calls.filter(([action]) => action === "workflow_read")).toHaveLength(1);
    expect(fixture.propose.mock.calls.some(([action]) => ["source_list", "resources_list", "agent_read", "agent_native_read"].includes(action))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "来源" }));
    expect(await screen.findByRole("complementary", { name: "来源与 Agent 活动" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Agent 与审查" }));
    const panel = screen.getByRole("complementary", { name: "Agent 活动与协作" });
    fireEvent.click(within(panel).getByRole("button", { name: "待处理 0" }));
    fireEvent.click(within(panel).getByText("显式提出待审问题"));
    const title = within(panel).getByLabelText("问题");
    fireEvent.change(title, { target: { value: "尚未发送的复核事项" } });
    fireEvent.click(screen.getByRole("button", { name: "资源材料" }));
    expect(screen.getByRole("region", { name: "项目资源与材料" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Agent 与审查" }));
    expect(within(panel).getByLabelText("问题")).toHaveValue("尚未发送的复核事项");
    expect(fixture.propose.mock.calls.filter(([action]) => action === "workflow_read")).toHaveLength(1);
    expect(fixture.propose.mock.calls.every(([action]) => ["canvas_read", "canvas_changes", "workflow_read", "source_list", "resources_list"].includes(action))).toBe(true);
  });
  it("starts with direct roots and keeps the chosen scope across data frames", async () => {
    const view = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "进入 A 研究方向" }));
    expect(screen.queryByRole("article", { name: "因果分析" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "进入 A0 具体事项" }));
    expect(screen.getByRole("article", { name: "因果分析" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "其他资料" })).toHaveAttribute("data-reference", "true");
    fixture.epoch++;
    view.rerender(<App />);
    await waitFor(() => expect(document.querySelector("[data-scope]")).toHaveAttribute("data-scope", "A0"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("A0 具体事项");
  });
  it("deep links into a scope, defaults to visible arrows, and shows cross-directory nodes as references", async () => {
    window.history.replaceState({}, "", "/?researchScope=A0");
    const view = render(<App />);
    await screen.findByRole("article", { name: "因果分析" });
    expect(view.container.querySelectorAll(".rv-edges > g")).toHaveLength(2);
    expect(view.container.querySelector(".rv-app")).toHaveClass("rv-free");
    fireEvent.change(screen.getByLabelText("关系显示"), { target: { value: "scope" } });
    expect(view.container.querySelectorAll(".rv-edges > g")).toHaveLength(2);
    fireEvent.click(screen.getByRole("article", { name: "因果分析" }));
    fireEvent.click(screen.getByRole("button", { name: "完成编辑" }));
    expect(within(screen.getByLabelText("选中节点的关系")).getByText("其他资料 ↗")).toBeInTheDocument();
  });
  it("keeps an open relationship panel below the measured scope toolbar as it wraps or becomes compact", async () => {
    window.history.replaceState({}, "", "/?researchScope=A0");
    let width = 1440, headerHeight = 78;
    const observers = new Map<Element, () => void>();
    vi.stubGlobal("ResizeObserver", class {
      constructor(private update: () => void) {}
      observe(target: Element) { observers.set(target, this.update); }
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 940, left: 0, top: 0, right: width, bottom: 940, x: 0, y: 0, toJSON() {} }));
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("rv-scope-header") ? (this.parentElement?.classList.contains("rv-compact") ? 78 : 88) : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("rv-scope-header") ? headerHeight : 0;
    });
    const view = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "预览邻居 因果分析" }));
    const app = view.container.querySelector<HTMLElement>(".rv-app")!;
    const header = view.container.querySelector<HTMLElement>(".rv-scope-header")!;
    expect(screen.getByLabelText("选中节点的关系")).toBeVisible();
    expect(app.style.getPropertyValue("--rv-scope-bottom")).toBe("166px");
    headerHeight = 126;
    act(() => observers.get(header)!());
    expect(app.style.getPropertyValue("--rv-scope-bottom")).toBe("214px");
    width = 390;
    act(() => observers.get(app)!());
    expect(app).toHaveClass("rv-compact");
    expect(app.style.getPropertyValue("--rv-scope-bottom")).toBe("204px");
    fireEvent.click(screen.getByRole("button", { name: "↑ 返回上层" }));
    expect(app).toHaveAttribute("data-scope", "A");
  });
  it("keeps a detail draft mounted while navigating away and returning", async () => {
    window.history.replaceState({}, "", "/?researchScope=A0");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "查看详情 因果分析" }));
    fireEvent.change(screen.getByLabelText("详情草稿"), { target: { value: "尚未提交的分析" } });
    fireEvent.click(within(screen.getByLabelText("研究层级")).getByRole("button", { name: "项目总览" }));
    expect(screen.queryByRole("textbox", { name: "详情草稿" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "进入 A 研究方向" }));
    fireEvent.click(screen.getByRole("button", { name: "进入 A0 具体事项" }));
    expect(screen.getByLabelText("详情草稿")).toHaveValue("尚未提交的分析");
  });
  it("opens a referenced item in the current scope without changing its shared membership", async () => {
    window.history.replaceState({}, "", "/?researchScope=A0");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "查看详情 因果分析" }));
    fireEvent.click(screen.getByRole("button", { name: "打开引用资料" }));
    expect(screen.getByRole("region", { name: "其他资料" })).toBeVisible();
    expect(document.querySelector("[data-scope]")).toHaveAttribute("data-scope", "A0");
    expect(fixture.propose.mock.calls.some(([action]) => action === "node_update")).toBe(false);
  });
  it("locates a search result in its original scope without opening a detail or writing graph state", async () => {
    window.history.replaceState({}, "", "/?researchScope=A0");
    const view = render(<App />);
    await screen.findByRole("article", { name: "因果分析" });
    fireEvent.change(screen.getByLabelText("搜索研究内容"), { target: { value: "其他资料" } });
    fireEvent.click(screen.getByRole("button", { name: "在图谱中定位 其他资料" }));
    await waitFor(() => expect(view.container.querySelector(".rv-app")).toHaveAttribute("data-scope", ""));
    expect(new URL(window.location.href).searchParams.get("researchNode")).toBe("external");
    expect(screen.getByRole("article", { name: "其他资料" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("region", { name: "其他资料" })).toBeNull();
    expect(fixture.propose.mock.calls.every(([action]) => ["canvas_read", "canvas_changes", "workflow_read"].includes(action))).toBe(true);
  });
  it("commits the destination camera before opening a search result from a distant scope", async () => {
    fixture.nodes = (fixture.nodes as ResearchNode[]).map((item) => item.id === "A" ? { ...item, x: 0, y: 0 } : item.id === "external" ? { ...item, x: 20000, y: 12000 } : item);
    window.history.replaceState({}, "", "/?researchScope=A0&researchLayout=canvas");
    const view = render(<App />);
    await screen.findByRole("article", { name: "因果分析" });
    fireEvent.keyDown(view.container.querySelector(".rv-app")!, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByLabelText("搜索研究内容"), { target: { value: "其他资料" } });
    fireEvent.click(within(screen.getByRole("region", { name: "搜索结果" })).getByRole("button", { name: /^其他资料/ }));
    await screen.findByRole("region", { name: "其他资料" });
    await waitFor(() => {
      const detail = view.container.querySelector<HTMLElement>('[data-window="external:current"]')!;
      const left = Number.parseFloat(detail.style.left), top = Number.parseFloat(detail.style.top);
      expect(left).toBeGreaterThanOrEqual(24);
      expect(left + Number.parseFloat(detail.style.width)).toBeLessThanOrEqual(1440);
      expect(top).toBeGreaterThanOrEqual(88);
      expect(top + Number.parseFloat(detail.style.height)).toBeLessThanOrEqual(940);
    });
  });
  it.each([{ width: 850, zoom: false }, { width: 900, zoom: true }, { width: 1200, zoom: true }, { width: 390, zoom: false }])("keeps an opened Agent inside the viewport at $width px (large tier: $zoom)", async ({ width, zoom }) => {
    fixture.nodes = [{ ...node("native", "既有研究 Agent"), type: "agent" }];
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width, height: 940, left: 0, top: 0, right: width, bottom: 940, x: 0, y: 0, toJSON() {} });
    const view = render(<App />);
    await screen.findByRole("article", { name: "既有研究 Agent" });
    if (zoom) for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole("button", { name: "放大画布" }));
    if (width < 1120) fireEvent.click(screen.getByRole("button", { name: "打开研究导航" }));
    fireEvent.change(screen.getByLabelText("搜索研究内容"), { target: { value: "既有研究 Agent" } });
    fireEvent.click(within(screen.getByRole("region", { name: "搜索结果" })).getByRole("button", { name: /^既有研究 Agent/ }));
    await screen.findByRole("region", { name: "既有研究 Agent" });
    const detail = view.container.querySelector<HTMLElement>('[data-window="native:current"]')!;
    await waitFor(() => {
      const left = Number.parseFloat(detail.style.left), top = Number.parseFloat(detail.style.top);
      expect(left).toBeGreaterThanOrEqual(width >= 1120 ? 304 : 0);
      expect(left + Number.parseFloat(detail.style.width)).toBeLessThanOrEqual(width);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + Number.parseFloat(detail.style.height)).toBeLessThanOrEqual(940);
    });
    if (zoom) {
      fireEvent.click(within(screen.getByRole("region", { name: "既有研究 Agent" })).getByRole("button", { name: "打开会话文件" }));
      await screen.findByRole("region", { name: "bounded.md" });
      const file = view.container.querySelector<HTMLElement>('[data-window="native:reference:/work/bounded.md"]')!;
      await waitFor(() => {
        expect(Number.parseFloat(file.style.left)).toBeGreaterThanOrEqual(width >= 1120 ? 304 : 0);
        expect(Number.parseFloat(file.style.left) + Number.parseFloat(file.style.width)).toBeLessThanOrEqual(width);
        expect(Number.parseFloat(file.style.top) + Number.parseFloat(file.style.height)).toBeLessThanOrEqual(940);
      });
    }
    expect(localStorage.getItem("research-v2:tester:test-project:navigation:collapsed")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "研究导航" })).toBeNull();
    expect(fixture.propose.mock.calls.every(([action]) => ["canvas_read", "canvas_changes", "workflow_read"].includes(action))).toBe(true);
  });
  it("starts narrow screens with readable cards and keeps overview fit available", async () => {
    fixture.nodes = [ { ...node("goal", "研究目标"), type: "goal", x: 0, y: 280 }, { ...node("evidence", "远处证据"), x: 1500, y: 0 } ];
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 430, height: 932, left: 0, top: 0, right: 430, bottom: 932, x: 0, y: 0, toJSON() {} });
    render(<App />);
    await screen.findByRole("article", { name: "研究目标" });
    await screen.findByText("85%");
    fireEvent.click(screen.getByRole("button", { name: "适应当前层" }));
    await waitFor(() => expect(screen.queryByText("85%")).not.toBeInTheDocument());
  });
  it("preserves unavailable deep-link scope and disables creation for a viewer", async () => {
    fixture.role = "viewer";
    window.history.replaceState({}, "", "/?researchScope=removed-folder");
    render(<App />);
    await screen.findByText("此目录当前不可用");
    expect(document.querySelector("[data-scope]")).toHaveAttribute("data-scope", "removed-folder");
    expect(screen.getByRole("button", { name: "＋ 新建" })).toBeDisabled();
  });
  it("expands a horizontal branch without writing coordinates or membership and keeps the choice across pushes", async () => {
    localStorage.setItem("research-v2:tester:test-project:view-mode", JSON.stringify("tree"));
    const view = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "展开 A 研究方向" }));
    expect(screen.getByRole("article", { name: "A0 具体事项" })).toBeInTheDocument();
    fixture.epoch++; view.rerender(<App />);
    expect(screen.getByRole("button", { name: "收起 A 研究方向" })).toHaveAttribute("aria-expanded", "true");
    expect(fixture.propose.mock.calls.every(([action]) => ["canvas_read", "canvas_changes", "workflow_read"].includes(action))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "收起 A 研究方向" }));
    expect(screen.queryByRole("article", { name: "A0 具体事项" })).not.toBeInTheDocument();
  });

});

it("waits for public layout, ignores legacy view choice, and expanding preserves the anchor", async () => {
  fixture.layoutReady = false;
  window.history.replaceState({}, "", "/?researchLayout=tree");
  const view = render(<App />);
  await waitFor(() => expect(fixture.propose).toHaveBeenCalled());
  expect(document.querySelector("[data-layout]")).toHaveAttribute("data-layout", "canvas");
  expect(screen.queryByRole("button", { name: "自由画布" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "横向排列" })).toBeDisabled();
  fixture.layoutReady = true; fixture.epoch++; view.rerender(<App />);
  const card = await screen.findByRole("article", { name: "A 研究方向" });
  const before = { left: card.style.left, top: card.style.top, width: card.style.width };
  fireEvent.click(screen.getByRole("button", { name: "展开 A 研究方向" }));
  expect({ left: card.style.left, top: card.style.top, width: card.style.width }).toEqual(before);
  expect(screen.getByRole("button", { name: "调整 A 研究方向 尺寸" })).toBeInTheDocument();
  expect(fixture.propose.mock.calls.some(([action]) => ["layout_move", "layout_auto", "node_update"].includes(action))).toBe(false);
});

it("single click edits in the existing footprint, and rapid expand/collapse never opens details", async () => {
  render(<App />);
  const parent = await screen.findByRole("article", { name: "A 研究方向" });
  for (let i = 0; i < 10; i++) {
    const toggle = within(parent).getByRole("button", { name: "展开 A 研究方向" });
    fireEvent.click(toggle); fireEvent.click(toggle); fireEvent.doubleClick(toggle);
  }
  expect(screen.queryByLabelText("详情草稿")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("卡片标题")).not.toBeInTheDocument();
  const style = parent.getAttribute("style");
  fireEvent.click(parent);
  expect(screen.getByLabelText("卡片标题")).toHaveValue("A 研究方向");
  expect(parent.getAttribute("style")).toBe(style);
  fireEvent.click(screen.getByRole("button", { name: "完成编辑" }));
  expect(screen.queryByRole("textbox", { name: "卡片标题" })).not.toBeInTheDocument();
});

it("writes scope navigation and restores browser back/forward without replacing the App", async () => {
  window.history.replaceState({}, "", "/apps/research-v2/open?instance=demo&project=test-project&researchScope=");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "进入 A 研究方向" }));
  expect(new URL(window.location.href).searchParams.get("researchScope")).toBe("A");
  fireEvent.click(screen.getByRole("button", { name: "进入 A0 具体事项" }));
  window.history.back();
  await waitFor(() => expect(document.querySelector("[data-scope]")).toHaveAttribute("data-scope", "A"));
  window.history.forward();
  await waitFor(() => expect(document.querySelector("[data-scope]")).toHaveAttribute("data-scope", "A0"));
  expect(new URL(window.location.href).searchParams.get("instance")).toBe("demo");
});
it("restores an addressed node on first load and keeps summary focus distinct from the body", async () => {
  window.history.replaceState({}, "", "/?researchScope=A0&researchNode=analysis");
  render(<App />);
  expect(await screen.findByRole("region", { name: "因果分析" })).toBeVisible();
});
it("supports multiple selected cards and keeps copy-reference distinct from legacy Agent and pin actions", async () => {
  window.history.replaceState({}, "", "/?researchScope=A0");
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<App />);
  const a = await screen.findByRole("article", { name: "因果分析" }), b = screen.getByRole("article", { name: "验收材料" });
  fireEvent.click(screen.getByRole("button", { name: "框选节点" }));
  fireEvent.click(a); fireEvent.click(b, { shiftKey: true });
  expect(a).toHaveAttribute("aria-selected", "true"); expect(b).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText(/已选 2 项/)).toBeVisible();
  fireEvent.click(within(a).getByRole("button", { name: "复制引用 因果分析" }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(new URL(writeText.mock.calls[0][0]).searchParams.get("researchNode")).toBe("analysis");
  expect(screen.queryByRole("button", { name: /联系 Agent/ })).not.toBeInTheDocument();
  fireEvent.click(within(a).getByRole("button", { name: "更多 因果分析" }));
  expect(screen.queryByRole("button", { name: /固定布局|取消固定/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "从图中删除节点…" })).toBeVisible();
});
it("shows clickable inbound and outbound neighbors including external types", async () => {
  window.history.replaceState({}, "", "/?researchScope=A0");
  fixture.edges.push({ id: "incoming", source: "external", target: "analysis", label: "derived_from", created: stamp });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "预览邻居 因果分析" }));
  const panel = screen.getByLabelText("选中节点的关系");
  expect(within(panel).getByText(/入边 ← derived_from · 任务/)).toBeVisible();
  expect(within(panel).getByText(/出边 → 关联 · 任务/)).toBeVisible();
  fireEvent.click(within(panel).getAllByRole("button", { name: /其他资料/ })[0]);
  expect(await screen.findByRole("region", { name: "其他资料" })).toBeVisible();
});

it.each(["button", "shift"])("box-selects via %s and submits one group move preserving the relative displacement", async mode => {
  window.history.replaceState({}, "", "/?researchScope=A0");
  fixture.nodes = (fixture.nodes as ResearchNode[]).map(item => ({ ...item, x: item.id === "analysis" || item.id === "review" ? 500 : 0, y: item.id === "review" ? 350 : 0 }));
  const capture = HTMLElement.prototype.setPointerCapture;
  HTMLElement.prototype.setPointerCapture = () => {};
  try {
    const view = render(<App />);
    const a = await screen.findByRole("article", { name: "因果分析" }), b = screen.getByRole("article", { name: "验收材料" });
    if (mode === "button") fireEvent.click(screen.getByRole("button", { name: "框选节点" }));
    const surface = view.container.querySelector(".rv-canvas")!;
    const send = (target: Element, name: string, x: number, y: number) => fireEvent(target, new MouseEvent(name, { bubbles: true, clientX: x, clientY: y, button: 0, shiftKey: target === surface && mode === "shift" }));
    const x = parseFloat(a.style.left), y = parseFloat(a.style.top);
    send(surface, "pointerdown", x - 2, y - 2);
    send(surface, "pointermove", x + parseFloat(a.style.width) + 2, parseFloat(b.style.top) + parseFloat(b.style.height) + 2);
    send(surface, "pointerup", x + parseFloat(a.style.width) + 2, parseFloat(b.style.top) + parseFloat(b.style.height) + 2);
    expect(a).toHaveAttribute("aria-selected", "true"); expect(b).toHaveAttribute("aria-selected", "true");
    send(a.querySelector(".rv-card-drag")!, "pointerdown", x + 30, y + 20);
    send(a, "pointermove", x + 130, y + 120);
    send(a, "pointerup", x + 130, y + 120);
    expect(fixture.moves).toHaveLength(1);
    expect(Object.keys(fixture.moves[0]).sort()).toEqual(["analysis", "review"]);
    expect(fixture.moves[0].analysis.x).toBeGreaterThan(500);
    expect(fixture.moves[0].review.x - fixture.moves[0].analysis.x).toBe(0);
    expect(fixture.moves[0].review.y - fixture.moves[0].analysis.y).toBe(350);
  } finally { HTMLElement.prototype.setPointerCapture = capture; }
});


const sendPointer = (target: Element, name: string, x: number, y: number) => fireEvent(target, new MouseEvent(name, { bubbles: true, clientX: x, clientY: y, button: 0 }));
function moveCard(card: HTMLElement, cancel = false) {
  const x = parseFloat(card.style.left) + 20, y = parseFloat(card.style.top) + 12;
  sendPointer(card.querySelector(".rv-card-drag")!, "pointerdown", x, y);
  sendPointer(card, "pointermove", x + 70, y + 40);
  sendPointer(card, cancel ? "pointercancel" : "pointerup", x + 70, y + 40);
}
describe("creation and explicit canvas gestures", () => {
  beforeEach(() => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    fixture.nodes = (fixture.nodes as ResearchNode[]).map((item, i) => ({ ...item, x: i * 400, y: i % 2 * 320, snapshot: "before-creation" }));
  });
  it.each(["overview", "focus", "target"])("attaches a new %s card using a snapshot read after creation", async mode => {
    fixture.nodes = [ { ...node("goal", "GOAL"), type: "goal", snapshot: "before-creation", data: {} }, ...fixture.nodes ];
    if (mode !== "overview") window.history.replaceState({}, "", `/?researchScope=${mode === "target" ? "goal" : "A0"}`);
    const original = fixture.propose.getMockImplementation()!;
    fixture.propose.mockImplementation(async (action: string, params: Record<string, string>) => {
      if (action === "node_add") return { ok: true, result: { node: node("created", "新节点") } };
      if (action === "graph_read") return { ok: true, result: { snapshot: "after-creation" } };
      if (action === "edge_add") return params.snapshot === "after-creation" ? { ok: true, result: { edge: {} } } : { ok: false, message: "关系端点不在读取范围或新增节点中" };
      return original(action, params);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ 新建" }));
    if (mode === "target") fireEvent.click(screen.getByRole("button", { name: /TARGET · 具体目标/ }));
    fireEvent.change(screen.getByLabelText("节点标题"), { target: { value: "新节点" } });
    fireEvent.click(screen.getByRole("button", { name: "放到画布" }));
    await waitFor(() => expect(fixture.propose.mock.calls.some(([action]) => action === "edge_add")).toBe(true));
    const actions = fixture.propose.mock.calls.map(([action]) => action);
    expect(actions.indexOf("node_add")).toBeLessThan(actions.indexOf("graph_read"));
    expect(actions.indexOf("graph_read")).toBeLessThan(actions.indexOf("edge_add"));
    expect(fixture.propose.mock.calls.find(([action]) => action === "edge_add")?.[1]).toMatchObject({ snapshot: "after-creation", source: mode === "focus" ? "A0" : "goal", target: "created", label: mode === "target" ? "decomposes" : "contains" });
    expect(screen.queryByText(/连接到当前目标失败/)).not.toBeInTheDocument();
  });
  it.each(["ordinary", "leave selection", "collapse"])("moves only the parent after %s", async mode => {
    render(<App />);
    const parent = await screen.findByRole("article", { name: "A 研究方向" });
    fireEvent.click(within(parent).getByRole("button", { name: "展开 A 研究方向" }));
    const child = screen.getByRole("article", { name: "A0 具体事项" });
    if (mode !== "ordinary") {
      fireEvent.click(screen.getByRole("button", { name: "框选节点" }));
      fireEvent.click(parent); fireEvent.click(child, { shiftKey: true });
      expect(child).toHaveAttribute("aria-selected", "true");
      if (mode === "leave selection") fireEvent.click(screen.getByRole("button", { name: "拖动画布" }));
      else fireEvent.click(within(parent).getByRole("button", { name: "收起 A 研究方向" }));
    }
    moveCard(parent);
    expect(fixture.moves).toHaveLength(1);
    expect(Object.keys(fixture.moves[0])).toEqual(["A"]);
  });
  it("moves a viewer's reference privately, cancels cleanly, and restores only that viewer and scope", async () => {
    fixture.role = "viewer";
    window.history.replaceState({}, "", "/?researchScope=A0");
    const view = render(<App />), external = await screen.findByRole("article", { name: "其他资料" });
    const key = "research-v2:tester:test-project:reference-layouts";
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key) || "{}").A0?.external).toBeDefined());
    const initial = JSON.parse(localStorage.getItem(key)!);
    moveCard(external, true);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(initial);
    moveCard(external);
    const moved = JSON.parse(localStorage.getItem(key)!);
    expect(moved.A0.external.x).toBeGreaterThan(initial.A0.external.x);
    expect(moved.A0.external.y).toBeGreaterThan(initial.A0.external.y);
    expect(fixture.moves).toHaveLength(0);
    expect(fixture.propose.mock.calls.every(([action]) => ["canvas_read", "canvas_changes", "workflow_read"].includes(action))).toBe(true);
    view.unmount();
    const restored = render(<App />);
    await screen.findByRole("article", { name: "其他资料" });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(moved);
    restored.unmount(); fixture.viewer = "another-viewer";
    const other = render(<App />);
    await screen.findByRole("article", { name: "其他资料" });
    const otherKey = "research-v2:another-viewer:test-project:reference-layouts";
    await waitFor(() => expect(JSON.parse(localStorage.getItem(otherKey) || "{}").A0?.external).toEqual(initial.A0.external));
    other.unmount(); fixture.viewer = "tester";
    window.history.replaceState({}, "", "/?researchScope=A");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "展开 A0 具体事项" }));
    fireEvent.click(screen.getByRole("button", { name: "适应当前层" }));
    await screen.findByRole("article", { name: "其他资料" });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key) || "{}").A?.external).toBeDefined());
    expect(JSON.parse(localStorage.getItem(key)!).A0).toEqual(moved.A0);
  });
  it("keeps shared and private writes separate for an explicitly mixed selection", async () => {
    window.history.replaceState({}, "", "/?researchScope=A0");
    render(<App />);
    const owned = await screen.findByRole("article", { name: "因果分析" }), reference = screen.getByRole("article", { name: "其他资料" });
    fireEvent.click(screen.getByRole("button", { name: "框选节点" }));
    fireEvent.click(owned); fireEvent.click(reference, { shiftKey: true });
    const key = "research-v2:tester:test-project:reference-layouts", before = JSON.parse(localStorage.getItem(key)!);
    moveCard(owned);
    expect(Object.keys(fixture.moves[0])).toEqual(["analysis"]);
    const after = JSON.parse(localStorage.getItem(key)!);
    expect(after.A0.external.x - before.A0.external.x).toBeCloseTo(fixture.moves[0].analysis.x - 800, 4);
    expect(after.A0.external.y - before.A0.external.y).toBeCloseTo(fixture.moves[0].analysis.y, 4);
  });
});


it("retries only attachment after a created node is checkpointed, including reopening the App", async () => {
  fixture.nodes = [{ ...node("goal", "GOAL"), type: "goal", data: {} }];
  const original = fixture.propose.getMockImplementation()!;
  let refused = true;
  fixture.propose.mockImplementation(async (action: string, params: Record<string, string>) => {
    if (action === "node_add") return { ok: true, result: { node: node("created", "已创建待连接") } };
    if (action === "graph_read") return { ok: true, result: { snapshot: "fresh" } };
    if (action === "edge_add") return refused ? { ok: false, message: "连接回执中断" } : { ok: true, result: { edge: {} } };
    return original(action, params);
  });
  const view = render(<App />);
  await screen.findByRole("article", { name: "GOAL" });
  fireEvent.click(screen.getByRole("button", { name: "＋ 新建" }));
  fireEvent.change(screen.getByLabelText("节点标题"), { target: { value: "已创建待连接" } });
  fireEvent.click(screen.getByRole("button", { name: "放到画布" }));
  await screen.findByRole("button", { name: "重试连接" });
  expect(screen.getByLabelText("节点标题")).toBeDisabled();
  const first = fixture.propose.mock.calls.find(([action]) => action === "edge_add")!;
  fireEvent.click(screen.getByRole("button", { name: "关闭菜单" }));
  view.unmount();
  refused = false; render(<App />);
  await screen.findByRole("article", { name: "GOAL" });
  fireEvent.click(screen.getByRole("button", { name: "＋ 新建" }));
  expect(screen.getByLabelText("节点标题")).toHaveValue("已创建待连接");
  fireEvent.click(screen.getByRole("button", { name: "重试连接" }));
  await waitFor(() => expect(screen.queryByLabelText("节点标题")).not.toBeInTheDocument());
  expect(fixture.propose.mock.calls.filter(([action]) => action === "node_add")).toHaveLength(1);
  expect(fixture.propose.mock.calls.filter(([action]) => action === "graph_read")).toHaveLength(1);
  const attaches = fixture.propose.mock.calls.filter(([action]) => action === "edge_add");
  expect(attaches).toHaveLength(2); expect(attaches[1]).toEqual(first);
});
it("does not repeat a successful creation when its subsequent display refresh fails", async () => {
  fixture.nodes = [{ ...node("goal", "GOAL"), type: "goal", data: {} }];
  const original = fixture.propose.getMockImplementation()!;
  let completed = false;
  fixture.propose.mockImplementation(async (action: string, params: Record<string, string>) => {
    if (action === "node_add") return { ok: true, result: { node: node("created", "刷新失败也只创建一次") } };
    if (action === "graph_read") return { ok: true, result: { snapshot: "fresh" } };
    if (action === "edge_add") { completed = true; return { ok: true, result: { edge: {} } }; }
    if (action === "canvas_changes" && completed) throw new Error("显示刷新失败");
    return original(action, params);
  });
  render(<App />);
  await screen.findByRole("article", { name: "GOAL" });
  fireEvent.click(screen.getByRole("button", { name: "＋ 新建" }));
  fireEvent.click(screen.getByRole("button", { name: "放到画布" }));
  await screen.findByText("Error: 显示刷新失败");
  expect(screen.queryByLabelText("节点标题")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(fixture.propose.mock.calls.filter(([action]) => action === "canvas_changes").length).toBeGreaterThan(1));
  expect(fixture.propose.mock.calls.filter(([action]) => action === "node_add")).toHaveLength(1);
  expect(fixture.propose.mock.calls.filter(([action]) => action === "edge_add")).toHaveLength(1);
  expect(localStorage.getItem("research-v2:tester:test-project:creation")).toBe("null");
});


describe("business edge selection and archive", () => {
  const writes = () => fixture.propose.mock.calls.filter(([action]) => action === "edge_archive");
  async function workspace() {
    window.history.replaceState({}, "", "/?researchScope=A0");
    const view = render(<App />);
    await screen.findByRole("article", { name: "因果分析" });
    const canvas = view.container.querySelector<HTMLElement>(".rv-canvas")!;
    const choose = () => fireEvent.click(view.container.querySelector('[data-edge="inside"] .rv-edge-hit')!);
    return { ...view, canvas, choose };
  }
  it("selects only real edges from their path or label and clears on blank, Escape, node selection and scope navigation", async () => {
    const view = await workspace();
    view.choose();
    expect(view.container.querySelector('[data-edge="inside"]')).toHaveClass("rv-edge-selected");
    expect(screen.getByRole("button", { name: "选择关系 因果分析 → 验收材料：佐证" })).toHaveAttribute("aria-pressed", "true");
    expect(view.canvas).toHaveFocus();
    fireEvent.keyDown(view.canvas, { key: "Escape" });
    expect(screen.queryByLabelText("选中关系")).toBeNull();
    view.choose(); fireEvent.pointerDown(view.canvas, { button: 0, pointerId: 1 });
    expect(screen.queryByLabelText("选中关系")).toBeNull();
    fireEvent.pointerUp(view.canvas, { pointerId: 1 });
    view.choose(); fireEvent.click(screen.getByRole("article", { name: "因果分析" }));
    expect(screen.queryByLabelText("选中关系")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "完成编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "选择关系 因果分析 → 验收材料：佐证" }));
    fireEvent.click(screen.getByRole("button", { name: "↑ 返回上层" }));
    expect(screen.queryByLabelText("选中关系")).toBeNull();
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    expect(writes()).toHaveLength(0);
  });
  it.each(["Delete", "Backspace", "button"])("archives exactly the selected edge with its snapshot via %s", async trigger => {
    const original = fixture.propose.getMockImplementation()!;
    fixture.propose.mockImplementation(async (action, params) => action === "edge_archive"
      ? { ok: true, result: { edge: { ...(fixture.edges[0] as object), archived: true } } }
      : action === "canvas_changes" && writes().length
        ? { ok: true, result: { changes: [{ bucket: "edges", id: "inside", record: { ...(fixture.edges[0] as object), archived: true } }], cursor: 3, hasMore: false } }
        : original(action, params));
    const view = await workspace(); view.choose();
    if (trigger === "button") fireEvent.click(screen.getByRole("button", { name: "删除关系" }));
    else fireEvent.keyDown(view.canvas, { key: trigger });
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1]).toEqual({ edge: "inside", version: "7", snapshot: "graph-snapshot", request: expect.any(String) });
    await waitFor(() => expect(view.container.querySelector('[data-edge="inside"]')).toBeNull());
    expect(view.container.querySelector('[data-edge="outside"]')).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "因果分析" })).toBeInTheDocument();
    expect(fixture.propose.mock.calls.some(([action]) => action === "node_archive")).toBe(false);
  });
  it("keeps pending feedback within the first frame and ignores repeated keys and clicks", async () => {
    const original = fixture.propose.getMockImplementation()!;
    let reply!: (value: unknown) => void;
    fixture.propose.mockImplementation((action, params) => action === "edge_archive" ? new Promise(resolve => { reply = resolve; }) : original(action, params));
    const view = await workspace(); view.choose();
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    expect(screen.getByText("正在删除关系…")).toBeVisible();
    expect(screen.getByRole("button", { name: "删除关系" })).toBeDisabled();
    fireEvent.keyDown(view.canvas, { key: "Delete", repeat: true });
    fireEvent.keyDown(view.canvas, { key: "Backspace" });
    fireEvent.click(screen.getByRole("button", { name: "删除关系" }));
    expect(writes()).toHaveLength(1);
    await act(async () => reply({ ok: false, code: "denied", message: "当前成员无权编辑此图" }));
    expect(screen.getByRole("alert")).toHaveTextContent("当前成员无权编辑此图");
    expect(view.container.querySelector('[data-edge="inside"]')).toHaveClass("rv-edge-selected");
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "选择关系 因果分析 → 其他资料：关联" }));
    fireEvent.keyDown(view.canvas, { key: "Backspace" });
    expect(writes()).toHaveLength(2);
    expect(writes()[1][1]).toMatchObject({ edge: "outside", version: "3" });
    await act(async () => reply({ ok: false, code: "denied", message: "当前成员无权编辑此图" }));
  });
  it("does not delete while any input, textarea, editable ancestor, editor, dialog or external focus owns the key", async () => {
    const view = await workspace();
    const cases = ['<input>', '<textarea></textarea>', '<select><option>x</option></select>', '<div contenteditable=""><span tabindex="0">edit</span></div>', '<div contenteditable="plaintext-only"><span tabindex="0">edit</span></div>', '<div class="cm-editor"><div tabindex="0">edit</div></div>', '<div class="monaco-editor"><div tabindex="0">edit</div></div>', '<div role="textbox" tabindex="0">edit</div>', '<div role="dialog" aria-modal="true"><button>dialog</button></div>'];
    for (const html of cases) {
      view.choose();
      const wrapper = document.createElement("div"); wrapper.innerHTML = html; view.canvas.append(wrapper);
      const target = (wrapper.querySelector("input,textarea,select,[tabindex],button") ?? wrapper.firstElementChild) as HTMLElement;
      target.focus();
      fireEvent.keyDown(target, { key: "Backspace" }); fireEvent.keyDown(target, { key: "Delete" });
      fireEvent.keyDown(view.canvas, { key: "Delete" });
      expect(writes()).toHaveLength(0); wrapper.remove();
    }
    view.choose();
    const external = document.createElement("input"); document.body.append(external); external.focus();
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    expect(writes()).toHaveLength(0); external.remove();
  });
  it("ignores IME composition, legacy composing codes, modifiers and key repeat", async () => {
    const view = await workspace(); view.choose();
    fireEvent.compositionStart(view.canvas);
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    fireEvent.compositionEnd(view.canvas);
    for (const extras of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) fireEvent.keyDown(view.canvas, { key: "Backspace", ...extras });
    expect(writes()).toHaveLength(0);
  });
  it("lets viewers inspect but never archive an edge", async () => {
    fixture.role = "viewer";
    const view = await workspace(); view.choose();
    expect(screen.getByRole("button", { name: "删除关系" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "删除关系" }));
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    expect(writes()).toHaveLength(0);
  });
  it.each(["backend_unavailable", "action_rejected", "instance_stale"])("retains %s requests across refresh and remount and only explicitly replays the identical selected operation", async code => {
    const original = fixture.propose.getMockImplementation()!;
    fixture.propose.mockImplementation(async (action, params) => action === "edge_archive" ? { ok: false, code, message: "原操作结果未确认" } : original(action, params));
    let view = await workspace(); view.choose();
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    await screen.findByText("原操作结果未确认");
    const request = writes()[0][1];
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    fixture.epoch++; view.rerender(<App />);
    expect(writes()).toHaveLength(1);
    view.unmount(); view = await workspace();
    expect(screen.getByText("上次删除结果未确认，请先核对原操作。")).toBeVisible();
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "选择关系 因果分析 → 其他资料：关联" }));
    expect(screen.getByRole("button", { name: "删除关系" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "核对原删除请求" })).toBeDisabled();
    view.choose(); fireEvent.click(screen.getByRole("button", { name: "核对原删除请求" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1][1]).toEqual(request);
  });
  it("keeps confirmed deletion separate from a failed display refresh", async () => {
    const original = fixture.propose.getMockImplementation()!;
    fixture.propose.mockImplementation(async (action, params) => {
      if (action === "edge_archive") return { ok: true, result: { edge: { ...(fixture.edges[0] as object), archived: true } } };
      if (action === "canvas_changes" && writes().length) throw new Error("刷新暂不可用");
      return original(action, params);
    });
    const view = await workspace(); view.choose();
    fireEvent.click(screen.getByRole("button", { name: "删除关系" }));
    await screen.findByText("关系已删除，等待图谱刷新。");
    await screen.findByText("Error: 刷新暂不可用");
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    fireEvent.click(screen.getByRole("button", { name: "刷新关系" }));
    expect(writes()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "核对原删除请求" })).toBeNull();
    expect(view.container.querySelector('[data-edge="inside"]')).toBeNull();
  });
  it("drops late deletion replies after the project unmounts and preserves the recovery request", async () => {
    const original = fixture.propose.getMockImplementation()!;
    let reply!: (value: unknown) => void;
    fixture.propose.mockImplementation((action, params) => action === "edge_archive" ? new Promise(resolve => { reply = resolve; }) : original(action, params));
    let view = await workspace(); view.choose();
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    const request = writes()[0][1];
    view.unmount();
    await act(async () => reply({ ok: true, result: { edge: { ...(fixture.edges[0] as object), archived: true } } }));
    view = await workspace();
    expect(screen.getByText("上次删除结果未确认，请先核对原操作。")).toBeVisible();
    expect(JSON.parse(localStorage.getItem("research-v2:tester:test-project:edge-archive")!).params.request).toBe(request.request);
    expect(writes()).toHaveLength(1);
    expect(view.container.querySelector('[data-edge="inside"]')).toBeInTheDocument();
  });
  it("does not treat automation lines as selected business edges", async () => {
    fixture.subscriptions = [{ id: "automation", source: "analysis", target: "review", enabled: true, archived: false, version: 1, created: stamp }];
    const view = await workspace();
    expect(view.container.querySelectorAll(".rv-automation .rv-edge-hit")).toHaveLength(0);
    fireEvent.click(view.container.querySelector(".rv-automation > path")!);
    fireEvent.keyDown(view.canvas, { key: "Delete" });
    expect(writes()).toHaveLength(0);
    expect(screen.queryByLabelText("选中关系")).toBeNull();
  });
  it("preserves missing selections without allowing an invisible edge to be deleted", async () => {
    const original = fixture.propose.getMockImplementation()!;
    const view = await workspace(); view.choose();
    fixture.propose.mockImplementation(async (action, params) => action === "canvas_changes" ? { ok: true, result: { changes: [{ bucket: "nodes", id: "analysis", record: { ...(fixture.nodes[2] as object), archived: true } }], cursor: 3, hasMore: false } } : original(action, params));
    fixture.epoch++; view.rerender(<App />);
    await waitFor(() => expect(view.container.querySelector('[data-edge="inside"]')).toBeNull());
    fireEvent.keyDown(view.canvas, { key: "Delete" }); expect(writes()).toHaveLength(0);
  });
  it("simplifies only valid mainline folders and exposes every membership line with all relationships", async () => {
    window.history.replaceState({}, "", "/?researchScope=A");
    fixture.nodes = (fixture.nodes as ResearchNode[]).map(n => n.id === "A0" ? { ...n, data: { ...n.data, meta: { mainline: JSON.stringify(["analysis", "review"]) } } } : n);
    fixture.edges.push({ id: "first", source: "A0", target: "analysis", label: "contains", version: 1, archived: false, created: stamp }, { id: "later", source: "A0", target: "review", label: "contains", version: 1, archived: false, created: stamp }, { id: "next", source: "analysis", target: "review", label: "下一步", version: 1, archived: false, created: stamp });
    localStorage.setItem("research-v2:tester:test-project:tree-expanded", JSON.stringify({ A0: true }));
    const view = render(<App />);
    await screen.findByRole("article", { name: "因果分析" });
    expect(view.container.querySelector('[data-edge="first"]')).toBeInTheDocument();
    expect(view.container.querySelector('[data-edge="later"]')).toBeNull();
    expect(view.container.querySelector('[data-edge="next"]')).toHaveClass("rv-mainline-edge");
    fireEvent.change(screen.getByLabelText("关系显示"), { target: { value: "all" } });
    expect(view.container.querySelector('[data-edge="later"]')).toBeInTheDocument();
    fireEvent.click(view.container.querySelector('[data-edge="later"] .rv-edge-hit')!);
    expect(screen.getByRole("button", { name: "删除关系" })).toBeEnabled();
    expect(writes()).toHaveLength(0);
  });
});

describe("phone research interactions", () => {
  beforeEach(() => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 390, height: 744, left: 0, top: 0, right: 390, bottom: 744, x: 0, y: 0, toJSON() {} });
    fixture.nodes = [{ ...node("phone", "手机研究笔记"), type: "note", x: 0, y: 0 }, { ...node("external", "补充材料"), type: "file", x: 400, y: 0 }];
    fixture.edges = [];
  });
  it("opens readable details on tap and keeps drafts mounted through minimize and browser back", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("article", { name: "手机研究笔记" }));
    const first = screen.getByRole("region", { name: "手机研究笔记" });
    const draft = within(first).getByLabelText("详情草稿");
    fireEvent.change(draft, { target: { value: "尚未提交的手机草稿" } });
    fireEvent.click(within(first).getByRole("button", { name: "最小化窗口" }));
    expect(draft).toBeInTheDocument(); expect(draft).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "手机研究笔记 ↗" }));
    expect(within(first).getByLabelText("详情草稿")).toBe(draft);
    expect(draft).toHaveValue("尚未提交的手机草稿");
    fireEvent.click(within(first).getByRole("button", { name: "打开引用资料" }));
    expect(draft).not.toBeVisible();
    window.history.replaceState({}, "", "/?researchNode=phone");
    fireEvent.popState(window);
    await waitFor(() => expect(draft).toBeVisible());
    expect(draft).toHaveValue("尚未提交的手机草稿");
  });
  it("closes the covering workbench when opening material and keeps its filter", async () => {
    render(<App />);
    await screen.findByRole("article", { name: "手机研究笔记" });
    fireEvent.click(screen.getByRole("button", { name: "打开研究导航" }));
    expect(screen.getByRole("searchbox", { name: "搜索研究内容" })).not.toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "资源材料" }));
    const assets = screen.getByRole("region", { name: "项目资源与材料" });
    fireEvent.change(within(assets).getByLabelText("查找项目产物"), { target: { value: "补充" } });
    fireEvent.click(within(assets).getByRole("button", { name: "补充材料" }));
    expect(assets).not.toBeVisible();
    fireEvent.click(within(screen.getByRole("region", { name: "补充材料" })).getByRole("button", { name: "关闭窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "打开研究导航" }));
    fireEvent.click(screen.getByRole("button", { name: "资源材料" }));
    expect(within(assets).getByLabelText("查找项目产物")).toHaveValue("补充");
  });
  it("cancels a shared drag when a second finger starts a pinch and ignores unrelated pointer releases", async () => {
    const view = render(<App />);
    const card = await screen.findByRole("article", { name: "手机研究笔记" });
    fireEvent.click(screen.getByRole("button", { name: "框选节点" }));
    const surface = view.container.querySelector<HTMLElement>(".rv-canvas")!;
    const send = (element: Element, type: string, id: number, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" } });
      act(() => { element.dispatchEvent(event); });
    };
    send(card.querySelector(".rv-card-drag")!, "pointerdown", 1, 80, 300);
    send(card, "pointermove", 1, 100, 310);
    send(card, "pointerup", 99, 110, 315);
    expect(fixture.moves).toHaveLength(0);
    send(surface, "pointerdown", 2, 200, 310);
    const before = view.container.querySelector(".rv-zoom span")!.textContent;
    send(surface, "pointermove", 2, 260, 310);
    expect(view.container.querySelector(".rv-zoom span")!.textContent).not.toBe(before);
    send(card, "pointerup", 1, 100, 310);
    send(surface, "pointerup", 2, 260, 310);
    expect(fixture.moves).toHaveLength(0);
    fireEvent.click(card);
    expect(screen.queryByRole("region", { name: "手机研究笔记" })).toBeNull();
  });
});

it("opens an Agent from its card or explicit chat button without entering metadata editing", async () => {
  fixture.nodes = [{ ...node("chat-agent", "研究助手"), type: "agent", data: {} }];
  render(<App />);
  const card = await screen.findByRole("article", { name: "研究助手" });
  expect(card.querySelector(".rv-agent-avatar svg")).not.toBeNull();
  fireEvent.click(within(card).getByRole("heading", { name: "研究助手" }));
  expect(await screen.findByRole("region", { name: "研究助手" })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "卡片标题" })).not.toBeInTheDocument();
  fireEvent.click(within(card).getByRole("button", { name: "继续聊天" }));
  expect(screen.getAllByRole("region", { name: "研究助手" })).toHaveLength(1);
  expect(fixture.propose.mock.calls.some(([action]) => action === "agent_send")).toBe(false);
});

it("does not reread graph and workflow metadata for a layout-only wake", async () => {
  fixture.dataEpoch = 1;
  const view = render(<App />);
  await screen.findByRole("article", { name: "A 研究方向" });
  const reads = () => fixture.propose.mock.calls.filter(([action]) => ["canvas_read", "canvas_changes", "workflow_read"].includes(action)).length;
  const before = reads(); fixture.epoch++;
  view.rerender(<App />); await act(async () => {});
  expect(reads()).toBe(before);
  fixture.dataEpoch++; fixture.epoch++; view.rerender(<App />);
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
});

it("keeps an acknowledged deletion hidden when the following read fails", async () => {
  fixture.nodes = [node("remove-me", "可删除便签")];
  const original = fixture.propose.getMockImplementation()!;
  fixture.propose.mockImplementation(async (action: string, params: Record<string, string>) => {
    if (action === "node_archive") return { ok: true, result: { node: { ...fixture.nodes[0] as object, archived: true } } };
    if (action === "canvas_changes") throw new Error("read offline");
    return original(action, params);
  });
  render(<App />);
  const card = await screen.findByRole("article", { name: "可删除便签" });
  fireEvent.click(within(card).getByRole("button", { name: "更多 可删除便签" }));
  fireEvent.click(screen.getByRole("button", { name: "从图中删除节点…" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除节点" }));
  await waitFor(() => expect(screen.queryByRole("article", { name: "可删除便签" })).not.toBeInTheDocument());
  expect(screen.getByText(/节点已删除/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "刷新图谱" }));
  expect(fixture.propose.mock.calls.filter(([action]) => action === "node_archive")).toHaveLength(1);
});

it.each(["confirmed", "unknown"])("retires a restored %s archive after an active-only full read without resending", async phase => {
  localStorage.setItem("research-v2:tester:test-project:node-archive", JSON.stringify({ params: { request: "old-delete", node: "removed-before-reload", version: 1 }, phase }));
  render(<App />);
  await screen.findByRole("article", { name: "A 研究方向" });
  await waitFor(() => expect(JSON.parse(localStorage.getItem("research-v2:tester:test-project:node-archive")!)).toBeNull());
  expect(fixture.propose.mock.calls.filter(([action]) => action === "node_archive")).toHaveLength(0);
});
