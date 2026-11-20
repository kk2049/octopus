import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperSyncStrategy, ResearchCloudDocument, ResearchNode } from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchDocuments, parseCloudDocumentUrl, type CloudDocumentProvider, type ResearchDocumentIO } from "./documents.js";
import { digest } from "./validation.js";
import { ResearchDocumentWatch, createResearchDocumentWatch } from "./documents-watch.js";
import type { ResearchWorkflows } from "./workflows.js";
const context: ResearchContext = { project: "p", actor: { kind: "human", owner: "alice" } };
describe("per-task paper synchronization and revocation", () => {
  let root: string, store: Store, graph: ResearchGraph, docs: ResearchDocuments, provider: CloudDocumentProvider, io: ResearchDocumentIO;
  let local: Map<string, string>, cloud: Map<string, { text: string; revision: number }>, revoked: Set<string>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "research-documents-")); store = new Store(join(root, "db")); graph = new ResearchGraph(store, root);
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "p", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    local = new Map(); cloud = new Map(); revoked = new Set();
    io = { read: vi.fn(async (_context, node) => ({ text: local.get(node)!, digest: digest(local.get(node)!) })),
      write: vi.fn(async (_context, node, value, expected) => { if (digest(local.get(node)!) !== expected) throw new Error("local changed"); local.set(node, value); }) };
    provider = { read: vi.fn(async (_owner, document, current) => { current(); const value = cloud.get(document)!; return { text: value.text, revision: String(value.revision), blocks: [{ id: "plain-block", text: value.text, supported: true }] }; }),
      readBlock: vi.fn(async (_owner, document, _block, current) => { current(); const value = cloud.get(document)!; return { ...value, digest: digest(value.text) }; }),
      writeBlock: vi.fn(async (_owner, document, _block, value, expected, _request, current) => { current(); const before = cloud.get(document)!; if (expected.digest !== digest(before.text) || expected.revision !== before.revision) throw new Error("cloud changed"); cloud.set(document, { text: value, revision: before.revision + 1 }); }) };
    docs = new ResearchDocuments(graph, provider, io, (ctx, operation) => !revoked.has(`${ctx.actor.owner}:${operation}`), () => {});
  });
  afterEach(() => { graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  function node(type = "note") { return (graph.mutate(context, "node_add", { request: crypto.randomUUID(), data: JSON.stringify({ type, title: "论文大纲" }) }) as { node: ResearchNode }).node; }
  async function bound(strategy?: PaperSyncStrategy, localText = "中文大纲：方法与实验", cloudText = localText) {
    const material = node("file"), markdown = node(), document = "doc_" + material.id.replace(/[^a-z0-9]/gi, "").slice(-32);
    local.set(markdown.id, localText); cloud.set(document, { text: cloudText, revision: 1 });
    const { binding } = await docs.bind(context, { request: crypto.randomUUID(), node: material.id, data: JSON.stringify({ url: `https://tenant.feishu.cn/docx/${document}` }) }) as { binding: ResearchCloudDocument };
    if (!strategy) return { binding, markdown, material, document };
    const configured = await docs.configure(context, { request: crypto.randomUUID(), node: material.id, data: JSON.stringify({ version: binding.version, block: "plain-block", localNode: markdown.id, strategy }) }) as { binding: ResearchCloudDocument };
    return { binding: configured.binding, markdown, material, document };
  }
  async function request(binding: ResearchCloudDocument, direction = "auto") {
    const preview = await docs.preview(context, binding.node);
    return { request: crypto.randomUUID(), node: binding.node, direction, local_digest: preview.local.digest, cloud_digest: preview.cloud.digest };
  }
  it("never writes a material which has no task policy", async () => {
    const { binding } = await bound();
    await expect(docs.sync(context, { request: "no-policy", node: binding.node, direction: "auto", local_digest: "x", cloud_digest: "y" })).rejects.toThrow("先为本任务选择");
    expect(provider.writeBlock).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled(); expect(provider.readBlock).not.toHaveBeenCalled();
  });
  it("keeps initial unequal content and simultaneous edits as conflicts", async () => {
    const first = await bound("bidirectional", "本地初稿", "云端初稿");
    expect((await docs.preview(context, first.binding.node)).binding.status).toBe("conflict");
    await expect(docs.sync(context, await request(first.binding))).rejects.toThrow("人工选择");
    const second = await bound("bidirectional"); local.set(second.markdown.id, "本地后改"); cloud.set(second.document, { text: "云端后改", revision: 2 });
    await expect(docs.sync(context, await request(second.binding))).rejects.toThrow("人工选择");
    expect(provider.writeBlock).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled();
  });
  it("applies each task policy independently and rejects the other direction", async () => {
    const first = await bound("local_to_cloud"), second = await bound("cloud_to_local");
    local.set(first.markdown.id, "中文：第一项的新大纲"); local.set(second.markdown.id, "中文：第二项的本地修改");
    expect((await docs.sync(context, await request(first.binding))).binding.status).toBe("synced");
    await expect(docs.sync(context, await request(second.binding))).rejects.toThrow("不符合这个任务");
    expect(cloud.get(first.document)?.text).toBe("中文：第一项的新大纲"); expect(cloud.get(second.document)?.text).toBe("中文大纲：方法与实验");
    expect(provider.writeBlock).toHaveBeenCalledTimes(1); expect(io.write).not.toHaveBeenCalled();
  });
  it("rechecks preview digests before writes", async () => {
    const { binding, markdown } = await bound("local_to_cloud"); local.set(markdown.id, "中文第一次修改");
    const params = await request(binding); local.set(markdown.id, "中文第二次修改");
    await expect(docs.sync(context, params)).rejects.toThrow("两边内容已变化"); expect(provider.writeBlock).not.toHaveBeenCalled();
  });
  it("persists unknown writes and does not read or overwrite again on replay", async () => {
    const { binding, markdown } = await bound("local_to_cloud"); local.set(markdown.id, "中文新大纲");
    const params = await request(binding);
    vi.mocked(provider.writeBlock).mockRejectedValue(new Error("lost receipt"));
    await expect(docs.sync(context, params)).rejects.toThrow("lost receipt");
    const reads = vi.mocked(provider.readBlock).mock.calls.length;
    await expect(docs.sync(context, params)).rejects.toThrow("不会重放");
    expect(provider.writeBlock).toHaveBeenCalledTimes(1); expect(provider.readBlock).toHaveBeenCalledTimes(reads);
  });
  it("rechecks document read and manage permission after binding reads", async () => {
    const material = node("file"); cloud.set("document_123", { text: "中文大纲", revision: 1 });
    vi.mocked(provider.read).mockImplementation(async () => { revoked.add("alice:read_cloud_document"); return { text: "正文", revision: "1", blocks: [] }; });
    await expect(docs.bind(context, { request: "bind-revoked", node: material.id, data: JSON.stringify({ url: "https://tenant.feishu.cn/docx/document_123" }) })).rejects.toThrow("授权已撤销");
    expect(graph.repo.get("p", "cloud-documents", material.id)).toBeNull();
  });
  it("stops before cloud reads when manage permission is revoked during configuration", async () => {
    const { binding, markdown } = await bound();
    vi.mocked(io.read).mockImplementation(async () => { revoked.add("alice:manage_resources"); return { text: "中文", digest: digest("中文") }; });
    await expect(docs.configure(context, { request: "config-revoked", node: binding.node, data: JSON.stringify({ version: binding.version, block: "plain-block", localNode: markdown.id, strategy: "manual" }) })).rejects.toThrow("资源管理授权");
    expect(provider.readBlock).not.toHaveBeenCalled();
    expect(graph.repo.get<ResearchCloudDocument>("p", "cloud-documents", binding.node)?.strategy).toBeNull();
  });
  it("stops the sync read chain immediately when sync permission is revoked", async () => {
    const { binding, markdown } = await bound("local_to_cloud"); local.set(markdown.id, "中文更新");
    const params = await request(binding); vi.mocked(provider.readBlock).mockClear();
    vi.mocked(io.read).mockImplementation(async () => { revoked.add("alice:sync_cloud_document"); return { text: "中文更新", digest: digest("中文更新") }; });
    await expect(docs.sync(context, params)).rejects.toThrow("授权已撤销");
    expect(provider.readBlock).not.toHaveBeenCalled(); expect(provider.writeBlock).not.toHaveBeenCalled();
  });
  it("rechecks membership, owner grants and binding version at provider boundaries", async () => {
    const { binding } = await bound("manual");
    store.addSharedAppMember("research-v2", "p", "bob", "editor", 20, new Date().toISOString());
    const bob = { project: "p", actor: { kind: "human" as const, owner: "bob" } };
    revoked.add("alice:read_cloud_document"); await expect(docs.read(bob, binding.node)).rejects.toThrow("授权已撤销"); revoked.clear();
    vi.mocked(provider.read).mockImplementation(async (_owner, _document, current) => { store.removeSharedAppMember("research-v2", "p", "bob"); current(); return { text: "", revision: "1", blocks: [] }; });
    await expect(docs.read(bob, binding.node)).rejects.toThrow("成员权限");
    vi.mocked(provider.read).mockImplementation(async (_owner, _document, current) => { graph.repo.put("p", "cloud-documents", binding.id, { ...binding, version: binding.version + 1 }); current(); return { text: "", revision: "1", blocks: [] }; });
    await expect(docs.read(context, binding.node)).rejects.toThrow("绑定或同步范围");
  });
  it("defaults legacy tasks to no watch and requires separate sync consent to enable one", async () => {
    const { binding, markdown } = await bound("manual");
    expect(binding.watch).toBe(false);
    revoked.add("alice:sync_cloud_document"); vi.mocked(provider.readBlock).mockClear();
    const params = { request: "watch-denied", node: binding.node, data: JSON.stringify({ version: binding.version, block: "plain-block", localNode: markdown.id, strategy: "manual", watch: true }) };
    await expect(docs.configure(context, params)).rejects.toThrow("授权已撤销");
    expect(provider.readBlock).not.toHaveBeenCalled();
    revoked.clear();
    const enabled = await docs.configure(context, { ...params, request: "watch-enabled" }) as { binding: ResearchCloudDocument };
    expect(enabled.binding.watch).toBe(true);
    revoked.add("alice:sync_cloud_document");
    const disabled = await docs.configure(context, { request: "watch-disabled", node: binding.node, data: JSON.stringify({ version: enabled.binding.version, block: "plain-block", localNode: markdown.id, strategy: "manual", watch: false }) }) as { binding: ResearchCloudDocument };
    expect(disabled.binding.watch).toBe(false);
  });
  it("preserves an unknown write across ordinary checks even when both texts agree", async () => {
    const { binding } = await bound("bidirectional");
    graph.repo.put("p", "cloud-documents", binding.id, { ...binding, status: "unknown", message: "外部写入结果不明" });
    const result = await docs.preview(context, binding.node);
    expect(result.binding).toMatchObject({ status: "unknown", message: "外部写入结果不明" });
    expect(graph.repo.get<ResearchCloudDocument>("p", "cloud-documents", binding.id)?.status).toBe("unknown");
    const reads = vi.mocked(provider.readBlock).mock.calls.length;
    await expect(docs.sync(context, { request: "unknown-auto", node: binding.node, direction: "auto", local_digest: result.local.digest, cloud_digest: result.cloud.digest })).rejects.toThrow("不会自动重试");
    expect(provider.readBlock).toHaveBeenCalledTimes(reads); expect(provider.writeBlock).not.toHaveBeenCalled();
  });
  it("preserves unknown if it appears during a read without changing the binding version", async () => {
    const { binding } = await bound("bidirectional");
    vi.mocked(io.read).mockImplementation(async () => {
      graph.repo.put("p", "cloud-documents", binding.id, { ...binding, status: "unknown", message: "并发写入待核对" });
      return { text: "中文大纲：方法与实验", digest: digest("中文大纲：方法与实验") };
    });
    expect((await docs.preview(context, binding.node)).binding).toMatchObject({ status: "unknown", message: "并发写入待核对" });
    expect(graph.repo.get<ResearchCloudDocument>("p", "cloud-documents", binding.id)?.status).toBe("unknown");
  });
  it("settles unknown only after an explicit human direction and a matching post-write read", async () => {
    const { binding, markdown } = await bound("local_to_cloud"); local.set(markdown.id, "人工确认的中文大纲");
    graph.repo.put("p", "cloud-documents", binding.id, { ...binding, status: "unknown", message: "上一请求未确认" });
    const params = await request(binding, "local_to_cloud");
    expect((await docs.sync(context, params)).binding.status).toBe("synced");
    expect(provider.writeBlock).toHaveBeenCalledTimes(1); expect(cloud.get(binding.document)?.text).toBe("人工确认的中文大纲");
    local.set(markdown.id, "人工再次确认的中文大纲");
    const current = graph.repo.get<ResearchCloudDocument>("p", "cloud-documents", binding.id)!;
    graph.repo.put("p", "cloud-documents", binding.id, { ...current, status: "unknown" });
    vi.mocked(provider.writeBlock).mockImplementation(async (_owner, document, _block, _value, _expected, _request, guard) => {
      guard(); cloud.set(document, { text: "另一位协作者的新中文大纲", revision: 3 });
    });
    await expect(docs.sync(context, await request(binding, "local_to_cloud"))).rejects.toThrow("同步后的内容出现新变化");
    expect(graph.repo.get<ResearchCloudDocument>("p", "cloud-documents", binding.id)?.status).toBe("unknown");
  });
  it.each(["revoke", "unknown", "pause"])("stops watch cloud I/O if %s occurs during a local read", async change => {
    const { binding } = await bound("bidirectional");
    const watched = { ...binding, watch: true }; graph.repo.put("p", "cloud-documents", binding.id, watched);
    vi.mocked(provider.readBlock).mockClear();
    vi.mocked(io.read).mockImplementation(async () => {
      if (change === "revoke") revoked.add("alice:sync_cloud_document");
      else if (change === "unknown") graph.repo.put("p", "cloud-documents", binding.id, { ...watched, status: "unknown" });
      else graph.repo.put("p", "cloud-documents", binding.id, { ...watched, watch: false, version: watched.version + 1 });
      return { text: "中文大纲：方法与实验", digest: digest("中文大纲：方法与实验") };
    });
    const problem = vi.fn(), watch = new ResearchDocumentWatch({ tasks: () => [{ context, binding: watched }],
      current: ({ context, binding }) => docs.watchCurrent(context, binding.node, binding.version), documents: docs, problem }, 0);
    try { await watch.tick(); } finally { watch.close(); }
    expect(provider.readBlock).not.toHaveBeenCalled(); expect(provider.writeBlock).not.toHaveBeenCalled(); expect(problem).toHaveBeenCalledTimes(1);
    if (change === "unknown") expect(graph.repo.get<ResearchCloudDocument>("p", "cloud-documents", binding.id)?.status).toBe("unknown");
  });
  it("stops watch reads when its owner loses the editor role despite unchanged scope grants", async () => {
    const { binding } = await bound("bidirectional"), watched = { ...binding, watch: true };
    graph.repo.put("p", "cloud-documents", binding.id, watched);
    vi.mocked(io.read).mockClear(); vi.mocked(provider.readBlock).mockClear();
    expect(store.setSharedAppMember("research-v2", "p", "alice", "viewer", 20, new Date().toISOString())).toBe(true);
    const problem = vi.fn(), watch = new ResearchDocumentWatch({ tasks: () => [{ context, binding: watched }],
      current: ({ context, binding }) => docs.watchCurrent(context, binding.node, binding.version), documents: docs, problem }, 0);
    try {
      await watch.tick(); expect(io.read).not.toHaveBeenCalled(); expect(provider.readBlock).not.toHaveBeenCalled();
      expect(store.setSharedAppMember("research-v2", "p", "alice", "owner", 20, new Date().toISOString())).toBe(true);
      vi.mocked(io.read).mockImplementation(async () => {
        store.setSharedAppMember("research-v2", "p", "alice", "viewer", 20, new Date().toISOString());
        return { text: "中文大纲：方法与实验", digest: digest("中文大纲：方法与实验") };
      });
      await watch.tick(); expect(io.read).toHaveBeenCalledTimes(1); expect(provider.readBlock).not.toHaveBeenCalled();
      expect(provider.writeBlock).not.toHaveBeenCalled(); expect(problem).toHaveBeenCalledTimes(2);
      expect(problem.mock.calls.every(call => String(call[1]).includes("没有项目编辑权限"))).toBe(true);
    } finally { watch.close(); }
  });
  it.each(["caller", "owner"])("stops manual sync when the %s loses its editor role during an await", async actor => {
    const { binding, markdown } = await bound("bidirectional"); local.set(markdown.id, "手工确认的新中文大纲");
    store.addSharedAppMember("research-v2", "p", "bob", "editor", 20, new Date().toISOString());
    const bob: ResearchContext = { project: "p", actor: { kind: "human", owner: "bob" } };
    const preview = await docs.preview(bob, binding.node); vi.mocked(provider.readBlock).mockClear();
    vi.mocked(io.read).mockImplementation(async () => {
      store.setSharedAppMember("research-v2", "p", actor === "caller" ? "bob" : "alice", "viewer", 20, new Date().toISOString());
      return preview.local;
    });
    await expect(docs.sync(bob, { request: "manual-role-revoked", node: binding.node, direction: "local_to_cloud",
      local_digest: preview.local.digest, cloud_digest: preview.cloud.digest })).rejects.toThrow("没有项目编辑权限");
    expect(provider.readBlock).not.toHaveBeenCalled(); expect(provider.writeBlock).not.toHaveBeenCalled();
  });
  it("keeps unresolved status and its review flag while a watch is enabled", async () => {
    const { binding } = await bound("bidirectional");
    graph.repo.put("p", "cloud-documents", binding.id, { ...binding, watch: true, status: "unknown", message: "请核对原文" });
    vi.mocked(provider.readBlock).mockClear();
    const invoke = vi.fn(), watch = createResearchDocumentWatch(graph, docs, { invoke } as unknown as ResearchWorkflows, () => {});
    try { await watch.tick(); await watch.tick(); } finally { watch.close(); }
    expect(provider.readBlock).not.toHaveBeenCalled(); expect(provider.writeBlock).not.toHaveBeenCalled();
    expect(graph.repo.get<ResearchCloudDocument>("p", "cloud-documents", binding.id)?.status).toBe("unknown");
    expect(invoke.mock.calls.map(call => call[1])).toEqual(["review_flag_open", "review_flag_open"]);
    expect(invoke.mock.calls[0][2]).toEqual(invoke.mock.calls[1][2]);
  });
  it("keeps official embedding unavailable until a trusted signature component is configured", async () => {
    const { binding } = await bound(); expect((await docs.read(context, binding.node)).embed).toMatchObject({ available: false, reason: expect.stringContaining("签名配置") });
    expect(parseCloudDocumentUrl("https://tenant.feishu.cn/docx/document_123?from=share#x")).toEqual({ document: "document_123", url: "https://tenant.feishu.cn/docx/document_123" });
    for (const value of ["http://tenant.feishu.cn/docx/document_123", "https://feishu.cn.evil.test/docx/document_123", "https://tenant.feishu.cn/wiki/document_123"]) expect(() => parseCloudDocumentUrl(value)).toThrow();
  });
});
