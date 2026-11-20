import { describe, expect, it, vi } from "vitest";
import type { PaperSyncPreview, ResearchCloudDocument } from "@claude-bot/research-canvas-contract";
import type { ResearchContext } from "./graph.js";
import { ResearchDocumentWatch } from "./documents-watch.js";

const context = { project: "project", actor: { kind: "human" as const, owner: "owner" } };
function binding(id: string, values: Partial<ResearchCloudDocument> = {}): ResearchCloudDocument {
  return { id, node: id, owner: "owner", version: 1, url: "https://example.feishu.cn/docx/document1", document: "document1", block: "block1", localNode: "outline", strategy: "bidirectional", watch: true, instructions: "", baseline: { local: "a", cloud: "a" }, status: "local_changed", checkedAt: null, message: "", ...values };
}
const state = (row: ResearchCloudDocument): PaperSyncPreview => ({ binding: row, local: { text: "中文新大纲", digest: "new" }, cloud: { text: "中文旧大纲", digest: "old", revision: 4 } });
describe("per-task continuous outline synchronization", () => {
  it("has no default watch or strategy and automatically syncs only the explicitly allowed direction", async () => {
    const rows = [binding("unset", { watch: undefined }), binding("manual", { strategy: "manual" }), binding("conflict", { status: "conflict" }), binding("local"), binding("wrong", { strategy: "cloud_to_local" })];
    const preview = vi.fn(async (_context: ResearchContext, id: string) => state(rows.find(row => row.id === id)!)), sync = vi.fn(async (_context: ResearchContext, _params: Record<string, string>) => state(rows[3])), problem = vi.fn();
    const watch = new ResearchDocumentWatch({ current: () => {}, tasks: () => rows.map(binding => ({ context, binding })), documents: { preview, sync }, problem }, 0);
    await watch.tick(); watch.close();
    expect(preview).toHaveBeenCalledTimes(4);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]?.[1]).toMatchObject({ node: "local", direction: "auto", local_digest: "new", cloud_digest: "old" });
    expect(problem).toHaveBeenCalledTimes(3);
  });
  it("never replays an unknown external write and does not overlap sweeps or continue after close", async () => {
    const row = binding("uncertain", { status: "unknown", message: "核对写入结果" });
    let release!: (value: PaperSyncPreview) => void;
    const preview = vi.fn(() => new Promise<PaperSyncPreview>(resolve => { release = resolve; })), sync = vi.fn(async () => state(row)), problem = vi.fn();
    const watch = new ResearchDocumentWatch({ current: () => {}, tasks: () => [{ context, binding: row }], documents: { preview, sync }, problem }, 0);
    await watch.tick(); expect(preview).not.toHaveBeenCalled(); expect(problem).toHaveBeenCalledTimes(1);
    row.status = "local_changed";
    const first = watch.tick(); await watch.tick(); expect(preview).toHaveBeenCalledTimes(1);
    watch.close(); release(state(row)); await first; expect(sync).not.toHaveBeenCalled();
  });
  it("stops before preview on revoked watch authority and does not sync newly unknown previews", async () => {
    const row = binding("watched"), problem = vi.fn();
    const preview = vi.fn(async () => state({ ...row, status: "unknown" })), sync = vi.fn();
    let permitted = false;
    const watch = new ResearchDocumentWatch({ tasks: () => [{ context, binding: row }], current: () => { if (!permitted) throw new Error("revoked"); }, documents: { preview, sync }, problem }, 0);
    await watch.tick(); expect(preview).not.toHaveBeenCalled(); expect(problem).toHaveBeenCalledTimes(1);
    permitted = true; await watch.tick(); watch.close(); expect(preview).toHaveBeenCalledTimes(1); expect(sync).not.toHaveBeenCalled(); expect(problem).toHaveBeenCalledTimes(2);
  });
  it("bounds each sweep and rotates fairly across enabled tasks", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => binding(String(i), { status: "synced" }));
    const preview = vi.fn(async (_context: ResearchContext, id: string) => state(rows.find(row => row.id === id)!));
    const watch = new ResearchDocumentWatch({ current: () => {}, tasks: () => rows.map(binding => ({ context, binding })), documents: { preview, sync: vi.fn() }, problem: vi.fn() }, 0);
    await watch.tick(); expect(preview).toHaveBeenCalledTimes(20);
    await watch.tick(); watch.close(); expect(new Set(preview.mock.calls.map(call => call[1])).size).toBe(25);
  });
});
