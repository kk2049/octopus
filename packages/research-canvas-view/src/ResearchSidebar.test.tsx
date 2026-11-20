import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchNode, ResearchRun } from "@claude-bot/research-canvas-contract";
import { ResearchSidebar } from "./ResearchSidebar.js";

const stamp = { kind: "human" as const, owner: "alice", trigger: "fixture", agent: null, run: null, model: null, at: "2026-09-26T12:00:00Z" };
const node = (id: string, type: ResearchNode["type"], title: string, data: ResearchNode["data"] = {}): ResearchNode => ({ id, ref: `${type}:${id}`, type, title, data, phase: "present", summary: "研究材料", schema: 1, version: 1, archived: false, created: stamp, updated: stamp, x: 0, y: 0 });
const run = (id: string, agent: string, status: ResearchRun["status"], at = stamp.at) => ({ id, node: agent, status, at } as ResearchRun);
const nodes = [node("goal", "goal", "ACC 研究", { members: ["target"] }), node("target", "goal", "验证并发", { members: ["file"] }), node("file", "file", "并发报告.md", { path: "/work/ACC/report.md" }), node("audio", "audio", "九月例会"), node("minutes", "note", "九月例会 · 纪要", { meta: { discussionSource: "meeting", sourceNode: "audio", excerptKind: "model", acceptanceStatus: "pending" } }), node("active", "agent", "验证 Agent"), node("legacy", "agent", "既有原生 Agent"), node("unknown", "agent", "待核对 Agent")];
function props() { return { storageKey: "research-v2:alice:project:navigation", projectTitle: "ACC 研究", nodes, agents: [], runs: [run("a", "active", "running"), run("b", "unknown", "unknown")], scope: "", selected: "", loading: false, collapsed: false, narrow: false, mobileOpen: false, searchRequest: 0, panel: "" as const, pendingFlags: 2, pendingProposals: 1, runnable: true, onCollapse: vi.fn(), onMobileClose: vi.fn(), onSearch: vi.fn(), onNavigate: vi.fn(), onOpen: vi.fn(), onLocate: vi.fn(), onAgent: vi.fn(), onPanel: vi.fn(), onHistory: vi.fn(), onOrganize: vi.fn() }; }
beforeEach(() => localStorage.clear());
describe("research navigation", () => {
  it("separates known active agents from legacy and unknown agents without reading any conversations", () => {
    const p = props(); render(<ResearchSidebar {...p} />);
    const agents = screen.getByRole("region", { name: "活跃 Agent" });
    expect(within(agents).getByRole("button", { name: "活跃 Agent 1" })).toHaveAttribute("aria-expanded", "true");
    expect(within(agents).getByText("运行中")).toBeVisible();
    expect(within(agents).queryByText("既有原生 Agent")).toBeNull();
    fireEvent.click(within(agents).getByRole("button", { name: "其他 Agent 2" }));
    expect(within(agents).getByText("尚未观测到运行状态")).toBeVisible();
    expect(within(agents).getByText("状态待核对")).toBeVisible();
    expect(p.onAgent).not.toHaveBeenCalled();
    fireEvent.click(within(agents).getByRole("button", { name: /^既有原生 Agent/ }));
    expect(p.onAgent).toHaveBeenCalledWith(nodes.find(node => node.id === "legacy"));
  });
  it("keeps collapse and branch choices stable across frames and private to each viewer and project", () => {
    const p = props(), view = render(<ResearchSidebar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "文件与材料 1" }));
    fireEvent.click(screen.getByRole("button", { name: "展开子图 ACC 研究" }));
    expect(screen.getByRole("button", { name: "验证并发 1" })).toBeVisible();
    view.rerender(<ResearchSidebar {...p} nodes={[...nodes]} scope="target" />);
    expect(screen.getByRole("button", { name: "文件与材料 1" })).toHaveAttribute("aria-expanded", "false");
    view.rerender(<ResearchSidebar {...p} storageKey="research-v2:bob:project:navigation" />);
    expect(screen.getByRole("button", { name: "文件与材料 1" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("button", { name: "验证并发 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "会议纪要 2" }));
    view.rerender(<ResearchSidebar {...p} />);
    expect(screen.getByRole("button", { name: "文件与材料 1" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "会议纪要 2" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "验证并发 1" })).toBeVisible();
    view.rerender(<ResearchSidebar {...p} storageKey="research-v2:alice:other-project:navigation" />);
    expect(screen.getByRole("button", { name: "文件与材料 1" })).toHaveAttribute("aria-expanded", "true");
  });
  it("keeps deep targets reachable through bounded pagination without a hierarchy depth limit", () => {
    const deep = Array.from({ length: 15 }, (_, i) => node(`target-${i}`, "goal", `第 ${i} 层目标`, { members: i < 14 ? [`target-${i + 1}`] : [] }));
    render(<ResearchSidebar {...props()} nodes={deep} scope="target-14" />);
    const tree = screen.getByRole("region", { name: "目标与子图" });
    expect(within(tree).queryByRole("button", { name: "第 14 层目标 0" })).toBeNull();
    fireEvent.click(within(tree).getByRole("button", { name: "显示更多子图" }));
    expect(within(tree).getByRole("button", { name: "第 14 层目标 0" })).toHaveAttribute("aria-current", "page");
    expect(tree.querySelectorAll("li")).toHaveLength(15);
  });
  it("searches across collapsed sections and full paths, supports keyboard selection and distinguishes graph location", () => {
    const p = props(); render(<ResearchSidebar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "文件与材料 1" }));
    const search = screen.getByRole("searchbox", { name: "搜索研究内容" });
    fireEvent.change(search, { target: { value: "ACC report.md" } });
    const result = screen.getByRole("region", { name: "搜索结果" });
    expect(within(result).getByText("1 项匹配")).toBeVisible();
    expect(within(result).getByText("文件 · ACC 研究 / 验证并发")).toBeVisible();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(within(result).getByRole("button", { name: /^并发报告.md/ })).toHaveFocus();
    fireEvent.click(within(result).getByRole("button", { name: "在图谱中定位 并发报告.md" }));
    expect(p.onLocate).toHaveBeenCalledWith(nodes[2]); expect(p.onOpen).not.toHaveBeenCalled();
    fireEvent.click(within(result).getByRole("button", { name: /^并发报告.md/ }));
    expect(p.onOpen).toHaveBeenCalledWith(nodes[2]);
    fireEvent.change(search, { target: { value: "未找到的关键词" } });
    expect(within(result).getByText(/没有找到匹配内容/)).toBeVisible();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "搜索结果" })).toBeNull();
    expect(screen.getByRole("button", { name: "文件与材料 1" })).toHaveAttribute("aria-expanded", "false");
  });
  it("shows minutes beside their sources, keeps resource actions reachable, and renders bounded rows", () => {
    const p = props(); render(<ResearchSidebar {...p} nodes={[...nodes, ...Array.from({ length: 30 }, (_, i) => node(`f${i}`, "file", `附件${i}`))]} />);
    const meetings = screen.getByRole("region", { name: "会议纪要" });
    expect(within(meetings).getByText("会议纪要 · 待审阅")).toBeVisible();
    fireEvent.click(within(meetings).getByRole("button", { name: "来源" })); expect(p.onPanel).toHaveBeenLastCalledWith("sources");
    const files = screen.getByRole("region", { name: "文件与材料" });
    expect(files.querySelectorAll(".rv-nav-item")).toHaveLength(8);
    fireEvent.click(within(files).getByRole("button", { name: "再显示 8 项 共 31 项" }));
    expect(files.querySelectorAll(".rv-nav-item")).toHaveLength(16);
    fireEvent.click(within(files).getByRole("button", { name: "资源材料" })); expect(p.onPanel).toHaveBeenLastCalledWith("assets");
    fireEvent.click(screen.getByRole("button", { name: "Agent 与审查" })); expect(p.onPanel).toHaveBeenLastCalledWith("workflow");
  });
  it("makes the narrow drawer dismissible and restores focus through its owner; the compact rail has named actions", () => {
    const p = props(), view = render(<ResearchSidebar {...p} narrow mobileOpen searchRequest={1} />);
    const search = screen.getByRole("searchbox", { name: "搜索研究内容" });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Escape" }); expect(p.onMobileClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /^并发报告.md/ }));
    expect(p.onMobileClose).toHaveBeenCalledTimes(2); expect(p.onOpen).toHaveBeenCalledWith(nodes[2]);
    view.rerender(<ResearchSidebar {...p} collapsed />);
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "搜索研究内容" })); expect(p.onSearch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "文件与材料" })); expect(p.onCollapse).toHaveBeenCalledWith(false);
  });
});
