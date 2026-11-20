import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityService, SqliteCapabilityStore } from "@claude-bot/capability-kernel";
import { CATALOGUED_TOOLS } from "./catalog.js";
import { FeishuCapabilities, FEISHU_SLOT } from "./gateway.js";
import type { FeishuCall } from "./backend.js";
import { FeishuResearchDocuments } from "../research-canvas/feishu-documents.js";
import { digest } from "../research-canvas/validation.js";

const args = { document_id: "fixture-document", block_id: "reviewed-block", revision: 7, text: "中文：已审阅大纲", client_token: "fixture-stable-request" };
const outlineSlot = "feishu-outline-sync", outlineObject = "feishu-outline-sync-v1:alice";

describe("trusted per-task outline write authority", () => {
  let directory: string, database: string, service: CapabilityService, capabilities: FeishuCapabilities;
  let scopes: readonly string[] | null, calls: FeishuCall[];
  const token = vi.fn<() => Promise<string | null>>(), readScopes = vi.fn<() => Promise<readonly string[] | null>>();
  function boot() {
    return new FeishuCapabilities({ service, isUser: username => username === "alice",
      resolver: { userToken: token, userScopes: readScopes, serviceAccountAvailable: () => true },
      backend: { call: async call => {
        calls.push(call);
        if (call.tool === "docx_v1_document_get") return { code: 0, data: { document: { revision_id: 7 } } };
        if (call.tool === "docx_v1_documentBlock_get") return { code: 0, data: { block: { block_id: args.block_id, block_type: 2, text: { elements: [{ text_run: { content: "中文原稿" } }] } } } };
        return { code: 0, data: { updated: true } };
      }, listTools: async () => [...CATALOGUED_TOOLS], stop() {} },
    });
  }
  beforeEach(async () => {
    calls = []; scopes = ["docx:document"];
    token.mockReset().mockResolvedValue("fixture-user-token"); readScopes.mockReset().mockImplementation(async () => scopes);
    directory = mkdtempSync(join(tmpdir(), "feishu-outline-authority-")); database = join(directory, "capabilities.db");
    service = new CapabilityService({ store: new SqliteCapabilityStore(database) }); capabilities = boot();
    await capabilities.verifyCatalog();
  });
  afterEach(() => { vi.restoreAllMocks(); capabilities.revokeUser("alice"); service.close(); rmSync(directory, { recursive: true, force: true }); });

  it("writes only the reviewed block through a short-lived separate object without widening ordinary grants", async () => {
    const current = vi.fn();
    await expect(capabilities.approvedOutlineWrite("alice", args, current)).resolves.toEqual({ code: 0, data: { updated: true } });
    expect(calls).toEqual([{ tool: "docx_v1_documentBlock_patch", credential: { mode: "user_oauth", token: "fixture-user-token" }, payload: {
      useUAT: true, path: { document_id: args.document_id, block_id: args.block_id }, params: { document_revision_id: args.revision, client_token: args.client_token },
      data: { update_text_elements: { elements: [{ text_run: { content: args.text } }] } },
    } }]);
    expect(current).toHaveBeenCalled(); expect(service.rootsOf(outlineObject)).toEqual([]);
    expect(service.listPending("alice")).toEqual([]);
    const ordinary = capabilities.open({ username: "alice", purpose: "ordinary-agent", kind: "agent-run", rights: ["doc_block_write"], autoAllow: ["doc_block_write"] })!;
    expect(service.objectIdOf(ordinary.contextId, FEISHU_SLOT)).toBe("feishu-user-v3:alice");
    expect((await ordinary.capabilities.request(FEISHU_SLOT, "doc_block_write", args)).status).toBe("approval_required");
    expect(calls).toHaveLength(1); ordinary.destroy();
  });

  it("completes the real document provider's reviewed write without an unhandled ordinary approval", async () => {
    scopes = ["docx:document:readonly", "docx:document"];
    const provider = new FeishuResearchDocuments(capabilities);
    await provider.writeBlock("alice", args.document_id, args.block_id, args.text, { digest: digest("中文原稿"), revision: 7 }, "reviewed-request", () => {});
    expect(calls.map(call => call.tool)).toEqual(["docx_v1_document_get", "docx_v1_documentBlock_get", "docx_v1_documentBlock_patch"]);
    expect(service.listPending("alice")).toEqual([]);
    expect(service.rootsOf(outlineObject)).toEqual([]);
  });

  it("requires an executable trusted guard and denies revoked task authority before credentials", async () => {
    await expect(capabilities.approvedOutlineWrite("alice", args, undefined as unknown as () => void)).rejects.toThrow("可信");
    await expect(capabilities.approvedOutlineWrite("alice", args, () => { throw new Error("task grant revoked"); })).rejects.toThrow("task grant revoked");
    expect(token).not.toHaveBeenCalled(); expect(calls).toEqual([]); expect(service.rootsOf(outlineObject)).toEqual([]);
  });

  it.each(["token", "scope"])("rechecks task authority after the asynchronous %s resolver and before external writes", async stage => {
    let revoked = false;
    const current = () => { if (revoked) throw new Error("sync permission revoked during OAuth"); };
    if (stage === "token") token.mockImplementationOnce(async () => { await Promise.resolve(); revoked = true; return "fixture-user-token"; });
    else readScopes.mockImplementationOnce(async () => { await Promise.resolve(); revoked = true; return ["docx:document"]; });
    await expect(capabilities.approvedOutlineWrite("alice", args, current)).rejects.toThrow("sync permission revoked");
    expect(calls).toEqual([]); expect(service.rootsOf(outlineObject)).toEqual([]);
    if (stage === "token") expect(readScopes).not.toHaveBeenCalled();
  });

  it("revokes an in-flight outline context even when the task closure would still allow it", async () => {
    let release!: (value: string) => void;
    token.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const writing = capabilities.approvedOutlineWrite("alice", args, () => {});
    expect(service.rootsOf(outlineObject)).toHaveLength(1);
    capabilities.revokeUser("alice"); release("fixture-user-token");
    await expect(writing).rejects.toThrow("撤销");
    expect(calls).toEqual([]); expect(service.rootsOf(outlineObject)).toEqual([]);
  });

  it("rejects changed arguments and consumes the trusted context at most once", async () => {
    const bind = service.bind.bind(service);
    vi.spyOn(service, "bind").mockImplementation(context => {
      const bound = bind(context);
      return { ...bound, request: (slot, operation, value) => bound.request(slot, operation, { ...value as Record<string, unknown>, block_id: "unreviewed-block" }) };
    });
    await expect(capabilities.approvedOutlineWrite("alice", args, () => {})).rejects.toThrow("参数匹配");
    expect(token).not.toHaveBeenCalled(); expect(calls).toEqual([]);
    vi.restoreAllMocks();
    let release!: (value: string) => void;
    token.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const writing = capabilities.approvedOutlineWrite("alice", args, () => {});
    const context = service.rootsOf(outlineObject)[0].contextId;
    expect((await service.bind(context).request(outlineSlot, "doc_block_write", args)).status).toBe("denied");
    expect((await service.bind(context).request(outlineSlot, "doc_create", {})).status).toBe("denied");
    release("fixture-user-token"); await writing;
    expect(calls).toHaveLength(1);
    expect((await service.bind(context).request(outlineSlot, "doc_block_write", args)).status).toBe("denied");
  });

  it("keeps concurrent identical writes attached to their own task guards", async () => {
    const release: (() => void)[] = [];
    token.mockImplementation(() => new Promise(resolve => { release.push(() => resolve("fixture-user-token")); }));
    let firstRevoked = false;
    const first = capabilities.approvedOutlineWrite("alice", args, () => { if (firstRevoked) throw new Error("first task revoked"); });
    const second = capabilities.approvedOutlineWrite("alice", args, () => {});
    expect(release).toHaveLength(2); firstRevoked = true; for (const finish of release) finish();
    const results = await Promise.allSettled([first, second]);
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(calls).toHaveLength(1); expect(service.rootsOf(outlineObject)).toEqual([]);
  });

  it.each([{ token: null, scopes: ["docx:document"] }, { token: "fixture", scopes: null }, { token: "fixture", scopes: ["docx:document:readonly"] }])("has no tenant fallback for missing identity or OAuth write scope (%j)", async fixture => {
    token.mockResolvedValue(fixture.token); scopes = fixture.scopes;
    await expect(capabilities.approvedOutlineWrite("alice", args, () => {})).rejects.toThrow(/权限中心|docx:document/);
    expect(calls).toEqual([]); expect(service.rootsOf(outlineObject)).toEqual([]);
  });

  it("refuses durable outline contexts after restart when their in-memory task guard is absent", async () => {
    await capabilities.approvedOutlineWrite("alice", args, () => {});
    const orphan = service.createContext("feishu-outline-sync-call", { owner: "alice" });
    service.mintRoot(orphan, outlineSlot, outlineObject, ["doc_block_write"], { autoAllow: ["doc_block_write"] });
    service.close();
    service = new CapabilityService({ store: new SqliteCapabilityStore(database) }); capabilities = boot(); await capabilities.verifyCatalog();
    await capabilities.approvedOutlineWrite("alice", args, () => {});
    token.mockClear(); calls = [];
    expect((await service.bind(orphan).request(outlineSlot, "doc_block_write", args)).status).toBe("denied");
    expect(token).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  });
});
