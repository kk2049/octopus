import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuDocsClient } from "../feishu/docs-openapi.js";
import { FeishuDocShareService, SHARE_ANCHOR_LEASE_MS } from "../feishu/doc-share.js";
import { APP_TOKEN, FakeFeishuDocs, userToken } from "../feishu/fake-feishu-docs.helper.js";
import { PermissionService } from "../permissions/service.js";
import { hashRunnerToken } from "../runner/gateway.js";
import { SessionHubService } from "../sessionhub/service.js";
import { Store } from "../store/store.js";
import { mcpSubjectEntry } from "./catalog.js";
import { MCP_AGENT_ACCOUNT_TOOL_GROUPS } from "./policy-contract.js";
import { handleMcpRpc } from "./http.js";
import { McpSurface, type McpPrincipal } from "./service.js";
import type { CardPayload } from "../feishu/direct-card.js";
import { decodeMcpTokenPolicy, mcpCredentialOf, mcpTokenPolicy } from "./tokens.js";

const DOC = "DocxToken1234567890abcdefg";
const OTHER = "OtherDocx1234567890abcdefg";
const SHARED_TOOLS = ["feishu_shared_doc_read", "feishu_shared_doc_outline", "feishu_shared_doc_block_read",
  "feishu_shared_doc_write", "feishu_shared_doc_block_update", "feishu_shared_doc_remove"];
const LHT = { openId: "ou_lht", username: "lht" };

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

function harness() {
  const store = new Store(":memory:");
  store.saveUser({ username: "lht", uid: 5001, home_dir: "/fixture/lht", created_at: "2026-10-27T00:00:00Z" });
  const permissions = new PermissionService({ store, subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false, feishuComposed: () => false, feishuPrivilegedOperations: () => [] })] });
  const hub = new SessionHubService({ store, permissions });
  const feishu = new FakeFeishuDocs();
  feishu.addDoc(DOC, "论文初稿", ["引言", "方法"]);
  feishu.addDoc(OTHER, "另一篇", ["别的段落"]);
  for (const doc of [DOC, OTHER]) { feishu.grant(doc, "lht", "edit"); feishu.grant(doc, "app", "edit"); }
  const clock = { now: 1_800_000_000_000 };
  /** Whether the owner's Feishu authorization is usable. */
  const oauth = { live: true };
  const dms: CardPayload[] = [];
  const shares = new FeishuDocShareService({
    links: store.feishuDocShareLinks, tokens: store,
    docs: new FeishuDocsClient(async (owner) => oauth.live ? userToken(owner) : null, feishu.fetch, async () => APP_TOKEN),
    componentTypeId: "blk_widget", publicUrl: "https://octopus.example", notifyOwner: async (_owner, card) => { dms.push(card); }, now: () => clock.now,
  });
  const docsPlane = { call: vi.fn(async () => ({})) };
  const surface = new McpSurface({ hub, permissions, feishuDocs: () => docsPlane, feishuDocShares: () => shares });
  closers.push(() => { surface.close(); permissions.close(); store.close(); });

  /** A share's bearer, resolved exactly as the Dashboard identity gate resolves an `mcp_` token. */
  const principalOf = (token: string): McpPrincipal | null => {
    const row = store.getActiveMcpTokenByHash(hashRunnerToken(token), new Date(clock.now).toISOString());
    if (!row) return null;
    return { owner: row.username, credential: mcpCredentialOf(row.token_hash), policy: decodeMcpTokenPolicy(row.policy_json) };
  };
  /** The control card's capability: what the card itself holds in its Record. */
  const capability = () => (feishu.records(DOC)[0].record as { octopusShare: { anchor: string } }).octopusShare.anchor;
  /** A new share, revealed by its owner on the card, and its bearer. */
  const share = async (rights: "read" | "write" = "write", label = "张老师") => {
    const created = await shares.create("lht", { document: DOC, label, rights }) as { share_id: string };
    const { command } = await shares.reveal(LHT, capability(), created.share_id);
    const token = /Bearer (mcp_[0-9a-f]+)"$/.exec(command)![1];
    const link = store.feishuDocShareLinks.share(created.share_id)!;
    return { id: created.share_id, token, card: store.feishuDocShareLinks.anchor(link.anchorId)!.blockId!, principal: principalOf(token)! };
  };
  const anchorOf = (shareId: string) => store.feishuDocShareLinks.anchor(store.feishuDocShareLinks.share(shareId)!.anchorId)!;
  const listings = () => feishu.requests.filter((request) => request.as === "app" && request.path === `docx/v1/documents/${DOC}/blocks`).length;
  return { store, feishu, shares, surface, clock, share, principalOf, anchorOf, listings, docsPlane, oauth, capability, dms };
}

describe("a Feishu document share link over MCP", () => {
  it("lists only the shared-document tools its rights allow, and nothing of the owner's account", async () => {
    const { surface, share } = harness();
    const write = await share("write");
    const read = await share("read", "只读的人");
    expect(surface.listTools(write.principal).map((tool) => tool.name)).toEqual(SHARED_TOOLS);
    expect(surface.listTools(read.principal).map((tool) => tool.name)).toEqual(SHARED_TOOLS.slice(0, 3));
    // The owner's own account tools are there for an account token, and hidden from the share.
    const account: McpPrincipal = { owner: "lht", credential: "runner-local:laptop", policy: mcpTokenPolicy({ groups: MCP_AGENT_ACCOUNT_TOOL_GROUPS }) };
    const accountTools = surface.listTools(account).map((tool) => tool.name);
    expect(accountTools).toEqual(expect.arrayContaining(["feishu_doc_place", "feishu_doc_share_create", "feishu_doc_share_list", "feishu_doc_share_update"]));
    expect(accountTools.filter((name) => name.startsWith("feishu_shared_doc_"))).toEqual([]);
    for (const name of ["list_recent_sessions", "feishu_doc_place", "feishu_doc_share_create", "app_list", "runner_capability_list"]) {
      expect(await surface.callTool(write.principal, name, {}), name).toMatchObject({ ok: false, code: "unknown_tool" });
    }
    expect(await surface.callTool(account, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "unknown_tool" });
  });

  it("reads and edits the shared document as the app, and only that document", async () => {
    const { surface, share, feishu } = harness();
    const { principal } = await share();
    const before = feishu.requests.length;
    const read = await surface.callTool(principal, "feishu_shared_doc_read", {});
    expect(read).toMatchObject({ ok: true, result: { document: { id: DOC, title: "论文初稿", revision: expect.any(Number) }, total: 3 } });
    const markdown = (read as { result: { markdown: string } }).result.markdown;
    expect(markdown).toContain("引言");
    expect(markdown).toContain("· add_on -->");
    const [intro] = feishu.blocksOf(DOC).filter((block) => JSON.stringify(block).includes("引言"));
    expect(await surface.callTool(principal, "feishu_shared_doc_write", { markdown: "## 审稿意见\n第一条", after: intro.block_id })).toMatchObject({ ok: true, result: { blocks: [expect.any(String), expect.any(String)] } });
    expect(feishu.blocksOf(DOC)[0].children!.indexOf(intro.block_id)).toBe(0);
    expect(JSON.stringify(feishu.blocksOf(DOC)[0].children)).toContain(feishu.blocksOf(DOC).find((block) => JSON.stringify(block).includes("审稿意见"))!.block_id);
    expect(await surface.callTool(principal, "feishu_shared_doc_block_update", { block_id: intro.block_id, text: "引言（修订）" }))
      .toMatchObject({ ok: true, result: { block_id: intro.block_id, kind: "text", previous_text: "引言" } });
    expect(await surface.callTool(principal, "feishu_shared_doc_block_read", { block_id: intro.block_id })).toMatchObject({ ok: true, result: { text: "引言（修订）" } });
    const shared = feishu.requests.slice(before);
    expect(new Set(shared.map((request) => request.as))).toEqual(new Set(["app"]));
    expect(feishu.documentsTouched()).toEqual(new Set([DOC]));
  });

  it("tells the collaborator's client what the connection is, over the JSON-RPC endpoint itself", async () => {
    const { surface, share } = harness();
    const { principal } = await share("read");
    const init = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, surface, principal);
    expect((init.body as { result: { instructions: string } }).result.instructions).toContain("共享给你的那一篇飞书文档");
    const list = await handleMcpRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, surface, principal);
    expect((list.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual(SHARED_TOOLS.slice(0, 3));
    const call = await handleMcpRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "feishu_shared_doc_outline", arguments: {} } }, surface, principal);
    expect((call.body as { result: { structuredContent: { document: { id: string } } } }).result.structuredContent.document.id).toBe(DOC);
  });

  it("answers a share only to that share's own token and owner", async () => {
    const { surface, share, feishu } = harness();
    const first = await share();
    const second = await share("write", "另一位");
    const borrowed: McpPrincipal = { ...second.principal, policy: first.principal.policy };
    const foreignOwner: McpPrincipal = { ...first.principal, owner: "bob" };
    const before = feishu.requests.length;
    for (const principal of [borrowed, foreignOwner]) {
      expect(surface.listTools(principal)).toEqual([]);
      expect(await surface.callTool(principal, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "unknown_tool" });
    }
    expect(feishu.requests.length).toBe(before);
  });

  it("cannot be pointed at another document by its arguments", async () => {
    const { surface, share, feishu } = harness();
    const { principal } = await share();
    expect(await surface.callTool(principal, "feishu_shared_doc_read", { document: OTHER })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await surface.callTool(principal, "feishu_shared_doc_write", { markdown: "x", document: OTHER })).toMatchObject({ ok: false, code: "invalid_params" });
    // A real block id, of the other document.
    const foreign = feishu.blocksOf(OTHER)[1].block_id;
    expect(await surface.callTool(principal, "feishu_shared_doc_block_read", { block_id: foreign })).toMatchObject({ ok: false, code: "not_found" });
    expect(await surface.callTool(principal, "feishu_shared_doc_block_update", { block_id: foreign, text: "x" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await surface.callTool(principal, "feishu_shared_doc_remove", { blocks: foreign })).toMatchObject({ ok: false, code: "not_found" });
    expect(await surface.callTool(principal, "feishu_shared_doc_write", { markdown: "x", after: foreign })).toMatchObject({ ok: false, code: "not_found" });
    for (const id of [`../${OTHER}/blocks/${foreign}`, `${OTHER}%2Fblocks`, "a/b"]) {
      expect(await surface.callTool(principal, "feishu_shared_doc_block_read", { block_id: id }), id).toMatchObject({ ok: false, code: "invalid_params" });
    }
    expect(feishu.blocksOf(OTHER).map((block) => JSON.stringify(block)).join()).toContain("别的段落");
    expect(feishu.documentsTouched()).toEqual(new Set([DOC]));
  });

  it("refuses a paused share without touching Feishu, works again once resumed, and dies with termination", async () => {
    const { surface, share, shares, feishu, principalOf, capability } = harness();
    const link = await share();
    shares.update("lht", link.id, "pause");
    const before = feishu.requests.length;
    expect(await surface.callTool(link.principal, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining("暂停") });
    expect(feishu.requests.length).toBe(before);
    // An agent cannot resume a share; the owner, signed in on the control card, can.
    expect(() => shares.update("lht", link.id, "resume")).toThrow(/控制卡片/);
    await shares.act(LHT, capability(), link.id, "resume");
    expect(await surface.callTool(link.principal, "feishu_shared_doc_read", {})).toMatchObject({ ok: true });
    shares.update("lht", link.id, "terminate");
    // The bearer no longer resolves at the identity gate; a principal still held is refused too.
    expect(principalOf(link.token)).toBeNull();
    expect(await surface.callTool(link.principal, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining("终止") });
  });

  it("never lets a read-only share write", async () => {
    const { surface, share, shares, feishu } = harness();
    const { id, principal } = await share("read");
    const before = feishu.requests.length;
    for (const [tool, args] of [["feishu_shared_doc_write", { markdown: "x" }], ["feishu_shared_doc_block_update", { block_id: "blk0001", text: "x" }], ["feishu_shared_doc_remove", { blocks: "blk0001" }]] as const) {
      expect(await surface.callTool(principal, tool, args), tool).toMatchObject({ ok: false, code: "unknown_tool" });
    }
    await expect(shares.call({ shareId: id, owner: "lht", credential: principal.credential }, "feishu_shared_doc_write", { markdown: "x" }))
      .rejects.toMatchObject({ status: 403, message: "这个文档共享只允许读取" });
    expect(feishu.requests.length).toBe(before);
  });

  it("past the lease, finds the card and vouches for it another day — once for calls arriving together", async () => {
    const { surface, share, clock, anchorOf, listings } = harness();
    const { id, principal } = await share();
    expect(anchorOf(id).leaseUntil).toBe(clock.now + SHARE_ANCHOR_LEASE_MS);
    const quiet = listings();
    await surface.callTool(principal, "feishu_shared_doc_outline", {});
    expect(listings()).toBe(quiet + 1);
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    const before = listings();
    const answers = await Promise.all([1, 2, 3].map(() => surface.callTool(principal, "feishu_shared_doc_block_read", { block_id: anchorOf(id).blockId! })));
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect(listings()).toBe(before + 1);
    expect(anchorOf(id)).toMatchObject({ state: "present", leaseUntil: clock.now + SHARE_ANCHOR_LEASE_MS, checkedAt: clock.now });
  });

  it("stops once the card is gone from the document: denied, and the anchor reads missing", async () => {
    const { surface, share, clock, anchorOf, feishu, store } = harness();
    const { id, principal, card } = await share();
    feishu.delete(DOC, card);
    // Within the lease the card still vouches; the next check after it ends the share.
    expect(await surface.callTool(principal, "feishu_shared_doc_outline", {})).toMatchObject({ ok: true });
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    const before = feishu.requests.length;
    expect(await surface.callTool(principal, "feishu_shared_doc_write", { markdown: "x" })).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining("控制卡片已被删除") });
    // The renewal asks Feishu as the owner, then looks for the card as the app.
    expect(feishu.requests.slice(before).map((request) => `${request.as} ${request.method} ${request.path}`))
      .toEqual([`lht GET drive/v1/permissions/${DOC}/members/auth`, `app GET docx/v1/documents/${DOC}/blocks`]);
    expect(anchorOf(id).state).toBe("missing");
    expect(store.feishuDocShareLinks.share(id)!.lastUsedAt).toBe(clock.now - SHARE_ANCHOR_LEASE_MS - 1);
  });

  it("refuses when the card cannot be looked for, and vouches for nothing", async () => {
    const { surface, share, clock, anchorOf, feishu } = harness();
    const { id, principal } = await share();
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    const lease = anchorOf(id).leaseUntil;
    for (const failure of ["network", new Response(JSON.stringify({ code: 1771001, msg: "internal" }), { status: 500 })] as const) {
      feishu.intercept = (request) => request.path.endsWith("/blocks") ? failure : undefined;
      expect(await surface.callTool(principal, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "unavailable", message: expect.stringContaining("请稍后重试") });
      expect(anchorOf(id)).toMatchObject({ state: "present", leaseUntil: lease });
    }
    feishu.intercept = null;
    feishu.revoke(DOC, "app");
    expect(await surface.callTool(principal, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining("添加文档应用") });
    expect(anchorOf(id)).toMatchObject({ state: "present", leaseUntil: lease });
    feishu.grant(DOC, "app", "edit");
    expect(await surface.callTool(principal, "feishu_shared_doc_read", {})).toMatchObject({ ok: true });
  });

  it("never deletes the control card or any add-on block, and replaces only text blocks", async () => {
    const { surface, share, feishu } = harness();
    const { principal, card } = await share();
    const [intro, method] = feishu.blocksOf(DOC).slice(1, 3).map((block) => block.block_id);
    expect(await surface.callTool(principal, "feishu_shared_doc_remove", { blocks: `${intro}, ${card}` })).toMatchObject({ ok: false, code: "conflict" });
    expect(await surface.callTool(principal, "feishu_shared_doc_block_update", { block_id: card, text: "x" })).toMatchObject({ ok: false, code: "conflict" });
    expect(await surface.callTool(principal, "feishu_shared_doc_remove", { blocks: DOC })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(feishu.records(DOC).map((record) => record.id)).toEqual([card]);
    expect(feishu.blocksOf(DOC)[0].children).toContain(intro);
    expect(await surface.callTool(principal, "feishu_shared_doc_remove", { blocks: `${intro} ${method}` })).toMatchObject({ ok: true, result: { deleted: 2 } });
    expect(feishu.blocksOf(DOC)[0].children).toEqual([card]);
  });
});

describe("what keeps a share inside its document and its owner's rights", () => {
  it("renews only while Feishu, asked as the owner, still lets the owner share the document", async () => {
    const { surface, share, clock, anchorOf, feishu, oauth } = harness();
    const { id, principal } = await share();
    const lease = anchorOf(id).leaseUntil;
    // Within the lease nothing is asked; past it, the owner's right is asked again.
    feishu.noShare.add(`${DOC}:lht`);
    expect(await surface.callTool(principal, "feishu_shared_doc_outline", {})).toMatchObject({ ok: true });
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    for (const outcome of ["revoked", "unauthorized"] as const) {
      if (outcome === "unauthorized") { feishu.noShare.clear(); oauth.live = false; }
      expect(await surface.callTool(principal, "feishu_shared_doc_read", {}), outcome).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining("所有者") });
      expect(anchorOf(id), outcome).toMatchObject({ state: "present", leaseUntil: lease });
    }
    oauth.live = true;
    expect(await surface.callTool(principal, "feishu_shared_doc_read", {})).toMatchObject({ ok: true });
    expect(anchorOf(id).leaseUntil).toBe(clock.now + SHARE_ANCHOR_LEASE_MS);
  });

  it("reports a delete Feishu placed on a neighbour (it ignores the revision pin), and stops the share at once when that was the card", async () => {
    const { surface, share, feishu } = harness();
    const { principal, card } = await share();
    const [intro, method] = feishu.blocksOf(DOC)[0].children!;
    // Someone drags the control card into the paragraph's place just as the delete goes out.
    feishu.intercept = (request) => {
      if (request.method === "DELETE") { feishu.intercept = null; feishu.move(DOC, card, DOC, 0); }
      return undefined;
    };
    // Live Feishu deletes whatever is at the index when the delete arrives: here, the card.
    const answer = await surface.callTool(principal, "feishu_shared_doc_remove", { blocks: intro });
    expect(answer).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("相邻的块") });
    expect(feishu.records(DOC)).toEqual([]);
    expect(feishu.blocksOf(DOC)[0].children).toEqual([intro, method]);
    // The card is gone, so the share stops now rather than a lease later.
    expect(await surface.callTool(principal, "feishu_shared_doc_outline", {})).toMatchObject({ ok: false });
  });

  it("calls an edit Feishu refuses for a stale revision a changed document, not a missing app", async () => {
    const { surface, share, feishu } = harness();
    const { principal } = await share();
    const [intro] = feishu.blocksOf(DOC)[0].children!;
    const read = await surface.callTool(principal, "feishu_shared_doc_outline", {}) as { ok: true; result: { document: { revision: number } } };
    expect(await surface.callTool(principal, "feishu_shared_doc_write", { markdown: "后来写入的一段" })).toMatchObject({ ok: true });
    const answer = await surface.callTool(principal, "feishu_shared_doc_block_update", { block_id: intro, text: "基于旧版本的修改", revision: read.result.document.revision });
    expect(answer).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("已被修改") });
    expect(JSON.stringify(answer)).not.toContain("添加文档应用");
  });

  it("runs the writes to one document one at a time", async () => {
    const { surface, share, feishu } = harness();
    const first = await share();
    const second = await share("write", "另一位");
    const [intro, method] = feishu.blocksOf(DOC)[0].children!;
    const before = feishu.requests.length;
    const answers = await Promise.all([
      surface.callTool(first.principal, "feishu_shared_doc_remove", { blocks: intro }),
      surface.callTool(second.principal, "feishu_shared_doc_remove", { blocks: method }),
    ]);
    expect(answers.every((answer) => answer.ok)).toBe(true);
    const steps = feishu.requests.slice(before).map((request) => request.method === "DELETE" ? "delete" : request.path.endsWith("/blocks") ? "list" : "doc");
    // Each delete is followed by a read of the block, to see that it is gone.
    expect(steps).toEqual(["doc", "list", "doc", "list", "delete", "doc", "doc", "list", "doc", "list", "delete", "doc"]);
  });

  it("stops a long write between pieces once its share is terminated", async () => {
    const { surface, share, shares, feishu } = harness();
    const { id, principal } = await share();
    const markdown = ["a", "b", "c"].map((letter) => letter.repeat(30_000)).join("\n\n");
    feishu.intercept = (request) => {
      if (request.path.endsWith("/descendant")) { feishu.intercept = null; shares.update("lht", id, "terminate"); }
      return undefined;
    };
    const answer = await surface.callTool(principal, "feishu_shared_doc_write", { markdown });
    expect(answer).toMatchObject({ ok: false, code: "no_authority", message: expect.stringMatching(/终止.*已写入前 1\/3 段/) });
    expect(feishu.requests.filter((request) => request.path.endsWith("/descendant"))).toHaveLength(1);
  });

  it("caps one write at 1 MB, and each share at 60 calls a minute", async () => {
    const { surface, share, clock, feishu } = harness();
    const { principal } = await share();
    const before = feishu.requests.length;
    expect(await surface.callTool(principal, "feishu_shared_doc_write", { markdown: "中".repeat(400_000) })).toMatchObject({ ok: false, code: "too_large" });
    expect(await surface.callTool(principal, "feishu_shared_doc_write", { markdown: "a".repeat(1024 * 1024 + 1) })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(feishu.requests.length).toBe(before);
    // The refused write above counted as one call of this minute.
    for (let i = 1; i < 60; i++) expect((await surface.callTool(principal, "feishu_shared_doc_block_read", { block_id: DOC })).ok, String(i)).toBe(true);
    expect(await surface.callTool(principal, "feishu_shared_doc_block_read", { block_id: DOC })).toMatchObject({ ok: false, code: "busy", message: expect.stringContaining("每分钟最多 60 次") });
    clock.now += 60_000;
    expect(await surface.callTool(principal, "feishu_shared_doc_block_read", { block_id: DOC })).toMatchObject({ ok: true });
  });

  it("reads synced blocks but never changes them, removes them, or writes into them", async () => {
    const { surface, share, feishu } = harness();
    const { principal } = await share();
    const synced = feishu.append(DOC, { block_type: 49, synced_source: {} }, DOC, 0);
    const inside = feishu.append(DOC, { block_type: 2, text: { elements: [{ text_run: { content: "同步的内容" } }] } }, synced);
    const holder = feishu.append(DOC, { block_type: 34, quote_container: {} });
    feishu.append(DOC, { block_type: 50, reference_synced: {} }, holder);
    expect((await surface.callTool(principal, "feishu_shared_doc_read", {}) as { result: { markdown: string } }).result.markdown).toContain("同步的内容");
    const before = JSON.stringify(feishu.blocksOf(DOC));
    for (const [tool, args] of [
      ["feishu_shared_doc_block_update", { block_id: inside, text: "改掉" }],
      ["feishu_shared_doc_remove", { blocks: synced }],
      ["feishu_shared_doc_remove", { blocks: inside }],
      ["feishu_shared_doc_remove", { blocks: holder }],
      ["feishu_shared_doc_write", { markdown: "写进去", after: inside }],
    ] as const) {
      expect(await surface.callTool(principal, tool, args), `${tool} ${JSON.stringify(args)}`).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("同步块") });
    }
    expect(JSON.stringify(feishu.blocksOf(DOC))).toBe(before);
    // Right after the synced block, outside it, is fine.
    expect(await surface.callTool(principal, "feishu_shared_doc_write", { markdown: "写在外面", after: synced })).toMatchObject({ ok: true });
  });

  it("refuses to delete what it cannot see whole: a missing child, or nesting past the limit", async () => {
    const { surface, share, feishu } = harness();
    const { principal } = await share();
    const holder = feishu.append(DOC, { block_type: 34, quote_container: {} });
    feishu.append(DOC, { block_type: 2, text: { elements: [] } }, holder);
    const doc = feishu.docs.get(DOC)!;
    doc.blocks.get(holder)!.children!.push("blk_ghost");
    expect(await surface.callTool(principal, "feishu_shared_doc_remove", { blocks: holder })).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("完整结构") });
    doc.blocks.get(holder)!.children!.pop();
    let parent = holder;
    for (let depth = 0; depth < 70; depth++) parent = feishu.append(DOC, { block_type: 34, quote_container: {} }, parent);
    expect(await surface.callTool(principal, "feishu_shared_doc_remove", { blocks: holder })).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("嵌套超过") });
    expect(doc.blocks.has(holder)).toBe(true);
  });
});

describe("a key a reader took for themselves on the card", () => {
  it("serves the same shared-document tools by its own rights, runs as the app on that document only, and ends when anyone holding the card ends it", async () => {
    const { surface, shares, feishu, principalOf, capability } = harness();
    await shares.create("lht", { document: DOC, label: "所有者的" });
    const reader = await shares.selfServe({ capability: capability(), hostToken: DOC, label: "读者", rights: "read", viewer: null });
    const writer = await shares.selfServe({ capability: capability(), hostToken: DOC, label: "改稿的老师", rights: "write", viewer: { openId: "ou_teacher", username: null } });
    const read = principalOf(reader.connect.token)!;
    const write = principalOf(writer.connect.token)!;
    expect(read.owner).toBe("lht");
    expect(surface.listTools(read).map((tool) => tool.name)).toEqual(SHARED_TOOLS.slice(0, 3));
    expect(surface.listTools(write).map((tool) => tool.name)).toEqual(SHARED_TOOLS);
    const before = feishu.requests.length;
    expect(await surface.callTool(read, "feishu_shared_doc_read", {})).toMatchObject({ ok: true, result: { document: { id: DOC } } });
    expect(await surface.callTool(read, "feishu_shared_doc_write", { markdown: "x" })).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(await surface.callTool(write, "feishu_shared_doc_write", { markdown: "读者的批注" })).toMatchObject({ ok: true });
    expect(new Set(feishu.requests.slice(before).map((request) => request.as))).toEqual(new Set(["app"]));
    expect(feishu.documentsTouched()).toEqual(new Set([DOC]));
    // A read key reads the card as an add-on block, never its Record: it cannot learn the anchor and take a write key.
    const markdown = (await surface.callTool(read, "feishu_shared_doc_read", {}) as { result: { markdown: string } }).result.markdown;
    expect(markdown).toContain("[add_on]");
    expect(markdown).not.toContain("dsa_");
    await shares.act(null, capability(), writer.share.id, "terminate", DOC);
    expect(principalOf(writer.connect.token)).toBeNull();
    expect(await surface.callTool(write, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "no_authority" });
    expect(await surface.callTool(read, "feishu_shared_doc_read", {})).toMatchObject({ ok: true });
  });
});

describe("a share before its owner reveals it, and writes waiting their turn", () => {
  it("serves nothing to a pending share: it has no token, and a principal naming it gets no tools", async () => {
    const { surface, shares, store, feishu } = harness();
    const created = await shares.create("lht", { document: DOC, label: "待领取" }) as { share_id: string; status: string };
    expect(created.status).toBe("pending");
    expect(store.listMcpTokens("lht")).toEqual([]);
    const forged: McpPrincipal = { owner: "lht", credential: mcpCredentialOf("0".repeat(64)), policy: decodeMcpTokenPolicy(JSON.stringify({ schema: "mcp-token-policy/v1", groups: [], feishuDocShare: { shareId: created.share_id } })) };
    const before = feishu.requests.length;
    expect(surface.listTools(forged)).toEqual([]);
    expect(await surface.callTool(forged, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(feishu.requests.length).toBe(before);
  });

  it("lets one write run and four wait on a document; one more is turned away to retry", async () => {
    const { surface, share, feishu } = harness();
    const { principal } = await share();
    const [intro] = feishu.blocksOf(DOC)[0].children!;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let held = false;
    feishu.intercept = async (request) => {
      if (!held && request.as === "app" && request.path === `docx/v1/documents/${DOC}`) { held = true; await gate; }
      return undefined;
    };
    const update = (n: number) => surface.callTool(principal, "feishu_shared_doc_block_update", { block_id: intro, text: `第 ${n} 版` });
    const running = [1, 2, 3, 4, 5].map(update);
    // The first write holds its first read; the next four wait behind it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held).toBe(true);
    expect(await update(6)).toMatchObject({ ok: false, code: "busy", message: expect.stringContaining("排队") });
    open();
    const answers = await Promise.all(running);
    expect(answers.map((answer) => answer.ok)).toEqual([true, true, true, true, true]);
    expect(JSON.stringify(feishu.docs.get(DOC)!.blocks.get(intro))).toContain("第 5 版");
    feishu.intercept = null;
    expect(await update(7)).toMatchObject({ ok: true });
  });
});
