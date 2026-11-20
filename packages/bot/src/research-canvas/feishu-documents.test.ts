import { describe, expect, it, vi } from "vitest";
import type { FeishuCapabilities } from "../feishu/gateway.js";
import { FeishuResearchDocuments, plainCloudBlock } from "./feishu-documents.js";
import { digest } from "./validation.js";
const plain = { block_id: "block", block_type: 2, text: { elements: [{ text_run: { content: "中文大纲" } }] } };
function setup(request: (operation: string) => Promise<unknown>) {
  const operations: string[] = [], close = vi.fn();
  const open = vi.fn(() => ({ close, capabilities: { request: vi.fn(async (_slot: string, operation: string) => {
    operations.push(operation); return { status: "succeeded", result: { code: 0, data: await request(operation) } };
  }) } }));
  const approvedOutlineWrite = vi.fn(async (_owner, _args, current) => {
    current(); operations.push("doc_block_write"); const result = await request("doc_block_write"); current();
    return { code: 0, data: result };
  });
  return { provider: new FeishuResearchDocuments({ open, approvedOutlineWrite } as unknown as FeishuCapabilities), operations, close, open, approvedOutlineWrite };
}
describe("Feishu cloud provider authorization and plain blocks", () => {
  it("rejects rich text, mentions and non-paragraph blocks", () => {
    expect(plainCloudBlock(plain).supported).toBe(true);
    expect(plainCloudBlock({ ...plain, text: { elements: [{ text_run: { content: "中文", text_element_style: { bold: true } } }] } }).supported).toBe(false);
    expect(plainCloudBlock({ ...plain, text: { elements: [{ mention_user: { user_id: "ou_user" } }] } }).supported).toBe(false);
    expect(plainCloudBlock({ ...plain, block_type: 3 }).supported).toBe(false);
  });
  it("accepts explicit false defaults from the official text style model through read and write", async () => {
    const block = { ...plain, text: { elements: [{ text_run: { content: "中文大纲", text_element_style: {
      bold: false, italic: false, underline: false, strikethrough: false, inline_code: false,
    } } }] } };
    expect(plainCloudBlock(block).supported).toBe(true);
    const state = setup(async operation => operation === "doc_metadata_read" ? { document: { revision_id: 4 } } : { block });
    await expect(state.provider.readBlock("alice", "doc", "block", () => {})).resolves.toEqual({ text: "中文大纲", digest: digest("中文大纲"), revision: 4 });
    await state.provider.writeBlock("alice", "doc", "block", "中文新稿", { digest: digest("中文大纲"), revision: 4 }, "request", () => {});
    expect(state.approvedOutlineWrite).toHaveBeenCalledTimes(1);
  });
  it("keeps active styling, colors, links, comments and unknown or malformed styles unsupported", () => {
    for (const style of [
      { bold: true }, { italic: true }, { underline: true }, { strikethrough: true }, { inline_code: true },
      { text_color: 0 }, { background_color: 0 }, { link: {} }, { comment_ids: [] }, { future_style: false },
      { bold: "false" }, { bold: 0 }, { bold: null }, null, false, [],
    ]) expect(plainCloudBlock({ ...plain, text: { elements: [{ text_run: { content: "中文大纲", text_element_style: style } }] } }).supported).toBe(false);
  });
  it("does no external request when the trusted current guard already refuses", async () => {
    const { provider, open } = setup(async () => ({}));
    await expect(provider.read("alice", "doc", () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
    expect(open).not.toHaveBeenCalled();
  });
  it("stops the document's multi-call read immediately after revocation", async () => {
    let revoked = false;
    const { provider, operations, close } = setup(async operation => { if (operation === "doc_read") revoked = true; return { content: "中文" }; });
    await expect(provider.read("alice", "doc", () => { if (revoked) throw new Error("revoked"); })).rejects.toThrow("revoked");
    expect(operations).toEqual(["doc_read"]); expect(close).toHaveBeenCalledTimes(1);
  });
  it("stops before reading the managed block when metadata completion revokes the binding", async () => {
    let revoked = false;
    const { provider, operations } = setup(async () => { revoked = true; return { document: { revision_id: 4 } }; });
    await expect(provider.readBlock("alice", "doc", "block", () => { if (revoked) throw new Error("binding changed"); })).rejects.toThrow("binding changed");
    expect(operations).toEqual(["doc_metadata_read"]);
  });
  it("refuses changed preimages and unsupported blocks before a write", async () => {
    const state = setup(async operation => operation === "doc_metadata_read" ? { document: { revision_id: 4 } } : { block: plain });
    await expect(state.provider.writeBlock("alice", "doc", "block", "中文新稿", { digest: digest("旧稿"), revision: 4 }, "request", () => {})).rejects.toThrow("云端文档已变化");
    expect(state.operations).toEqual(["doc_metadata_read", "doc_block_read"]);
    const rich = setup(async operation => operation === "doc_metadata_read" ? { document: { revision_id: 4 } } : { block: { ...plain, text: { elements: [{ equation: { content: "x" } }] } } });
    await expect(rich.provider.writeBlock("alice", "doc", "block", "中文新稿", { digest: digest("中文大纲"), revision: 4 }, "request", () => {})).rejects.toThrow("纯文本大纲块");
    expect(rich.operations).not.toContain("doc_block_write");
  });
  it("uses a guarded fixed write operation only after both preconditions match", async () => {
    const { provider, operations, close, approvedOutlineWrite } = setup(async operation => operation === "doc_metadata_read" ? { document: { revision_id: 4 } } : operation === "doc_block_read" ? { block: plain } : {});
    const current = () => {};
    await provider.writeBlock("alice", "doc", "block", "中文新稿", { digest: digest("中文大纲"), revision: 4 }, "request", current);
    expect(operations).toEqual(["doc_metadata_read", "doc_block_read", "doc_block_write"]); expect(close).toHaveBeenCalledTimes(2);
    expect(approvedOutlineWrite).toHaveBeenCalledWith("alice", { document_id: "doc", block_id: "block", revision: 4, text: "中文新稿", client_token: digest(["alice", "request"]).slice(0, 32) }, current);
  });
});
