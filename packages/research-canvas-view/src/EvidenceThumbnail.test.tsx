import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvidenceSelection, ResearchEvidence, ResearchNode } from "@claude-bot/research-canvas-contract";
import type { Call } from "./client.js";
import { EvidenceThumbnail } from "./EvidenceThumbnail.js";
import { CardPreview } from "./CardPreview.js";

const stamp = { kind: "human" as const, owner: "tester", trigger: "tester", agent: null, run: null, model: null, at: "2026-09-26T00:00:00Z" };
const imageNode: ResearchNode = { id: "chart", schema: 1, type: "file", title: "关键趋势", summary: "对照组与实验组", data: {}, phase: "present", x: 0, y: 0, version: 1, archived: false, created: stamp, updated: stamp };
const evidence: ResearchEvidence = { id: "r2", node: "report", series: "trial", title: "最新观测", kind: "experiment", claim: "observation", motivation: "", goal: "", design: "", execution: "", results: "", analysis: "", conclusion: "误差下降，但仍需复测。", code: [], frameworks: [], runs: [], artifacts: [], charts: [imageNode.id], sources: [], configuration: "", limitations: "", created: stamp, sequence: 1 };
const file = { id: "chart-v1", mime: "image/png", bytes: 4, sha256: "a".repeat(64) };
const createObjectURL = vi.fn(() => "blob:authorized-chart"), revokeObjectURL = vi.fn();
beforeEach(() => {
  createObjectURL.mockClear(); revokeObjectURL.mockClear();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("previews only chart resources while keeping latest and adopted results separate", async () => {
  const report = evidence;
  const adopted = { ...report, id: "r1", node: "old-report", title: "已采纳基线" };
  const node = { ...imageNode, id: "report", type: "finding" as const, title: report.title, summary: "实验报告", data: { meta: { reportId: report.id } } };
  const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
    if (action === "evidence_read") return { report, latest: report, adopted, adoptedBy: stamp } satisfies EvidenceSelection;
    if (action === "resource_read") return { file, data: params.cursor ? "YmI=" : "YWE=", next: params.cursor ? null : 2 };
    throw new Error("Unexpected action " + action);
  });
  const documentFor = vi.fn(), open = vi.fn();
  render(<CardPreview node={node} children={[]} nodes={[node, imageNode]} call={call as Call} documentFor={documentFor} open={open} />);
  expect(await screen.findByRole("img", { name: imageNode.summary })).toHaveAttribute("src", "blob:authorized-chart");
  expect(screen.getByText(report.conclusion)).toBeInTheDocument();
  expect(screen.getByText("最新")).toBeInTheDocument();
  expect(screen.getByText("已采纳")).toBeInTheDocument();
  screen.getByRole("button", { name: adopted.title }).click();
  expect(open).toHaveBeenLastCalledWith(adopted.node);
  screen.getByRole("button", { name: "打开关键图表：关键趋势" }).click();
  expect(open).toHaveBeenLastCalledWith(imageNode.id);
  expect(documentFor).not.toHaveBeenCalled();
  expect(call).toHaveBeenLastCalledWith("resource_read", { node: imageNode.id, cursor: 2, version: "chart-v1" });
  expect(createObjectURL).toHaveBeenCalledOnce();
  cleanup(); expect(revokeObjectURL).toHaveBeenCalledWith("blob:authorized-chart");
});

it("does not create an image for an unsupported type", async () => {
  const call = vi.fn().mockResolvedValue({ file: { ...file, mime: "image/svg+xml" }, data: "YWFhYQ==", next: null });
  render(<EvidenceThumbnail node={imageNode} call={call as Call} open={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("不是支持的图片");
  expect(call).toHaveBeenCalledOnce(); expect(createObjectURL).not.toHaveBeenCalled();
});

it("loads a chart past the thumbnail budget only when asked, and then of any size", async () => {
  const bytes = 3 * 1024 * 1024, window = 24_000, large = { ...file, bytes };
  const call = vi.fn(async (_action: string, params: Record<string, unknown>) => {
    const offset = Number(params.cursor ?? 0), length = Math.min(window, bytes - offset);
    return { file: large, data: btoa("\0".repeat(length)), next: offset + length < bytes ? offset + length : null };
  });
  render(<EvidenceThumbnail node={imageNode} call={call as Call} open={vi.fn()} />);
  const load = await screen.findByRole("button", { name: "载入预览（3.0 MiB）" });
  expect(call).toHaveBeenCalledOnce(); expect(createObjectURL).not.toHaveBeenCalled();
  act(() => load.click());
  expect(await screen.findByRole("img", { name: imageNode.summary }, { timeout: 10_000 })).toHaveAttribute("src", "blob:authorized-chart");
  expect(call).toHaveBeenCalledTimes(1 + Math.ceil(bytes / window));
});

it("refuses a changed version and malformed cursor without reading more data", async () => {
  const call = vi.fn().mockResolvedValueOnce({ file, data: "YWE=", next: 2 }).mockResolvedValueOnce({ file: { ...file, id: "chart-v2" }, data: "YmI=", next: null });
  const view = render(<EvidenceThumbnail node={imageNode} call={call as Call} open={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("版本已变化");
  expect(createObjectURL).not.toHaveBeenCalled();
  call.mockReset().mockResolvedValue({ file, data: "YWE=", next: 0 });
  view.rerender(<EvidenceThumbnail node={{ ...imageNode, resourceVersion: 2 }} call={call as Call} open={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("分片无效");
  expect(call).toHaveBeenCalledOnce();
});

it("drops an old resource response when the displayed node changes", async () => {
  let finish!: (value: unknown) => void;
  const stale = new Promise(resolve => { finish = resolve; });
  const call = vi.fn().mockReturnValueOnce(stale).mockResolvedValueOnce({ file: { ...file, id: "new-file" }, data: "YWFhYQ==", next: null });
  const view = render(<EvidenceThumbnail node={imageNode} call={call as Call} open={vi.fn()} />);
  view.rerender(<EvidenceThumbnail node={{ ...imageNode, id: "new-chart", summary: "新图" }} call={call as Call} open={vi.fn()} />);
  await screen.findByRole("img", { name: "新图" });
  await act(async () => { finish({ file, data: "YWE=", next: 2 }); await stale; });
  expect(call).toHaveBeenCalledTimes(2); expect(createObjectURL).toHaveBeenCalledOnce();
  expect(screen.getByRole("img")).toHaveAccessibleName("新图");
});

it("keeps report Markdown images inert and bounds chart reads to two visible files", async () => {
  const report: ResearchEvidence = { ...evidence, id: "r3", title: "报告", conclusion: "![私人来源](https://private.invalid/image.png)", charts: ["missing", "chart", "extra", "chart"] };
  const node = { ...imageNode, id: "report", type: "finding" as const, data: { meta: { reportId: report.id } } };
  const call = vi.fn(async (action: string) => action === "evidence_read" ? { report, latest: report, adopted: null, adoptedBy: null } : { file, data: "YWFhYQ==", next: null });
  render(<CardPreview node={node} children={[]} nodes={[node, imageNode, { ...imageNode, id: "extra" }]} call={call as Call} documentFor={vi.fn()} open={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "blob:authorized-chart"));
  expect(screen.getByText("私人来源")).toBeInTheDocument();
  expect(screen.getByText("图表来源暂不可用")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看全部 3 张关键图表" })).toBeInTheDocument();
  expect(call.mock.calls.filter(([action]) => action === "resource_read")).toHaveLength(1);
});

it("coalesces project wakes and refreshes latest/adopted without replacing the current report", async () => {
  const first = { ...evidence, charts: [] }, latest = { ...first, id: "next", node: "next-node", title: "更新的结果", conclusion: "新报告正文不应替换当前正文" };
  let resolve!: (value: EvidenceSelection) => void;
  const pending = new Promise<EvidenceSelection>(done => { resolve = done; });
  const call = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ report: first, latest, adopted: first, adoptedBy: stamp });
  const node = { ...imageNode, id: first.node, type: "finding" as const, summary: "当前摘要", data: { meta: { reportId: first.id } } };
  const props = { node, children: [], nodes: [node], call: call as Call, documentFor: vi.fn(), open: vi.fn() };
  const view = render(<CardPreview {...props} epoch={1} />);
  view.rerender(<CardPreview {...props} epoch={2} />);
  view.rerender(<CardPreview {...props} epoch={3} />);
  expect(call).toHaveBeenCalledOnce();
  await act(async () => { resolve({ report: first, latest: first, adopted: null, adoptedBy: null }); await pending; });
  await screen.findByRole("button", { name: latest.title });
  expect(call).toHaveBeenCalledTimes(2);
  expect(screen.getByText(first.conclusion, { exact: true })).toBeInTheDocument();
  expect(screen.queryByText(latest.conclusion, { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: first.title })).toBeInTheDocument();
});

it("does not retry a refused report read on background wakes", async () => {
  const report = { ...evidence, charts: [] }, node = { ...imageNode, id: report.node, type: "finding" as const, data: { meta: { reportId: report.id } } };
  const call = vi.fn().mockRejectedValueOnce(new Error("权限已撤销")).mockResolvedValue({ report, latest: report, adopted: null, adoptedBy: null });
  const props = { node, children: [], nodes: [node], call: call as Call, documentFor: vi.fn(), open: vi.fn() };
  const view = render(<CardPreview {...props} epoch={1} />);
  await screen.findByRole("alert");
  view.rerender(<CardPreview {...props} epoch={2} />);
  expect(call).toHaveBeenCalledOnce();
  screen.getByRole("button", { name: "重试报告状态" }).click();
  await screen.findByRole("button", { name: report.title });
  expect(call).toHaveBeenCalledTimes(2);
});
