import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { CATALOGUED_TOOLS, FEISHU_USER_OPERATIONS } from "./catalog.js";
import { FeishuCapabilities, FEISHU_SLOT, type FeishuGrant } from "./gateway.js";
import type { FeishuCall } from "./backend.js";

const write = { document_id: "fixture-document", block_id: "fixture-block", revision: 7, text: "已核对的中文大纲", client_token: "fixture-idempotency" };
const newOperations = ["doc_metadata_read", "doc_blocks_list", "doc_block_read", "doc_block_write"];

describe("document block authority migration and OAuth boundary", () => {
  let service: CapabilityService, capabilities: FeishuCapabilities;
  let scopes: readonly string[] | null, calls: FeishuCall[];
  const token = vi.fn(async () => "fixture-user-token");
  beforeEach(async () => {
    calls = []; token.mockClear(); scopes = ["docx:document:readonly", "docx:document"];
    service = new CapabilityService();
    capabilities = new FeishuCapabilities({ service, isUser: username => username === "alice",
      resolver: { userToken: token, userScopes: async () => scopes, serviceAccountAvailable: () => true },
      backend: { call: async call => { calls.push(call); return { ok: true }; }, listTools: async () => [...CATALOGUED_TOOLS], stop() {} },
    });
    await capabilities.verifyCatalog();
  });
  afterEach(() => { capabilities.revokeUser("alice"); service.close(); });
  function grant(rights: string[], autoAllow = rights) {
    return capabilities.open({ username: "alice", purpose: "document-authority-fixture", kind: "agent-run", rights, autoAllow })!;
  }

  async function approveWrite(writer: FeishuGrant) {
    const pending = await writer.capabilities.request(FEISHU_SLOT, "doc_block_write", write);
    expect(pending.status).toBe("approval_required");
    expect(token).not.toHaveBeenCalled(); expect(calls).toHaveLength(0);
    const rows = service.listPending("alice");
    expect(rows).toHaveLength(1);
    return service.approve(rows[0].id, "alice");
  }

  it("keeps old user-object grants separate from the current version and cannot derive the new rights from them", async () => {
    const legacyOperations = Object.fromEntries(Object.entries(FEISHU_USER_OPERATIONS).filter(([operation]) => !newOperations.includes(operation)).map(([operation, entry]) => [operation, entry.spec]));
    const legacyAdapter = vi.fn(async () => ({ legacy: true }));
    service.registerObject({ id: "feishu-user:alice", kind: "feishu-user", binding: { owner: "alice" }, metadata: { owner: "alice" },
      operations: legacyOperations, policy: () => ({ kind: "allow" }), adapter: legacyAdapter });
    const legacyRoot = service.createContext("feishu-authority", { owner: "alice" });
    service.mintRoot(legacyRoot, FEISHU_SLOT, "feishu-user:alice", Object.keys(legacyOperations), { autoAllow: Object.keys(legacyOperations) });
    const legacyRun = service.createContext("agent-run", { owner: "alice" }, legacyRoot);
    service.derive(legacyRoot, FEISHU_SLOT, legacyRun, FEISHU_SLOT, Object.keys(legacyOperations));
    const current = grant(["doc_block_write"]);
    expect(service.objectIdOf(current.contextId, FEISHU_SLOT)).toBe("feishu-user-v3:alice");
    expect(service.objectIdOf(legacyRun, FEISHU_SLOT)).toBe("feishu-user:alice");
    for (const operation of newOperations)
      expect((await service.bind(legacyRun).request(FEISHU_SLOT, operation, write)).status).toBe("denied");
    const child = service.createContext("agent-run", { owner: "alice" }, legacyRoot);
    expect(() => service.derive(legacyRoot, FEISHU_SLOT, child, FEISHU_SLOT, ["doc_block_write"])).toThrow();
    expect(legacyAdapter).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled(); expect(calls).toHaveLength(0);
    expect((await approveWrite(current)).status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    capabilities.revokeUser("alice");
    expect((await service.bind(legacyRun).request(FEISHU_SLOT, "doc_read", { document_id: write.document_id })).status).toBe("denied");
    expect((await current.capabilities.request(FEISHU_SLOT, "doc_block_write", write)).status).toBe("denied");
    expect(calls).toHaveLength(1);
  });

  it("requires the new write right and approval before reading credentials", async () => {
    const reader = grant(["doc_read", "doc_block_read"]);
    expect((await reader.capabilities.request(FEISHU_SLOT, "doc_block_write", write)).status).toBe("denied");
    const pending = grant(["doc_block_write"], []);
    expect((await pending.capabilities.request(FEISHU_SLOT, "doc_block_write", write)).status).toBe("approval_required");
    expect(token).not.toHaveBeenCalled(); expect(calls).toHaveLength(0);
    pending.destroy();
  });

  it.each([{ scopes: null }, { scopes: ["docx:document:readonly"] }])("refuses approved document modification when OAuth write scope cannot be proved ($scopes)", async ({ scopes: allowed }) => {
    scopes = allowed;
    const writer = grant(["doc_block_write"]);
    const result = await approveWrite(writer);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toMatch(/docx:document|权限中心/);
    expect(calls).toHaveLength(0);
  });

  it("requires reviewed revision and idempotency token and sends an exact block update only with user OAuth", async () => {
    const writer = grant(["doc_block_write"]);
    const { revision: _revision, ...withoutRevision } = write;
    const { client_token: _request, ...withoutRequest } = write;
    expect((await writer.capabilities.request(FEISHU_SLOT, "doc_block_write", withoutRevision)).status).toBe("denied");
    expect((await writer.capabilities.request(FEISHU_SLOT, "doc_block_write", withoutRequest)).status).toBe("denied");
    expect(token).not.toHaveBeenCalled();
    expect((await approveWrite(writer)).status).toBe("succeeded");
    expect(calls).toEqual([{ tool: "docx_v1_documentBlock_patch", credential: { mode: "user_oauth", token: "fixture-user-token" },
      payload: { useUAT: true, path: { document_id: write.document_id, block_id: write.block_id }, params: { document_revision_id: 7, client_token: write.client_token },
        data: { update_text_elements: { elements: [{ text_run: { content: write.text } }] } } } }]);
  });
});
