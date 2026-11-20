/**
 * SEC-03 — every Agent Feishu call goes through the Gateway, and there is no
 * identity to fall back to.
 *
 * The defect: `AgentSession.buildMcpServers()` started the credential-bearing
 * lark-mcp inside the agent's own process tree, adding the user's access token
 * only when one happened to exist. Without one it still started — with the app
 * id and secret — so "Alice has not authorised anything" silently became "act
 * with tenant authority".
 *
 * Every deny case below asserts that the CREDENTIAL RESOLVER was not read and
 * the downstream backend received zero calls. A 403 is not the property.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { argsTooLarge, CapabilityService } from "@claude-bot/capability-kernel";
import { AuthorizationService } from "../authorization/service.js";
import { Store } from "../store/store.js";
import {
  FEISHU_SLOT,
  FEISHU_PRIVILEGED_SLOT,
  FEISHU_SYSTEM_SLOT,
  FeishuCapabilities,
  type FeishuCredentialResolver,
} from "./gateway.js";
import {
  CATALOGUED_TOOLS,
  FEISHU_MCP_CATALOG,
  FEISHU_PRIVILEGED_OPS,
  FEISHU_SYSTEM_OPS,
  FEISHU_USER_OPERATIONS,
  FEISHU_USER_OPS,
  FEISHU_USER_READ_OPS,
  gatewayToolDescriptors,
  SEND_FILE_BASE64_MAX,
} from "./catalog.js";
import type { FeishuCall, FeishuToolBackend } from "./backend.js";
import { FeishuAuthorizationResourceIndex } from "./resource-index.js";

let svc: CapabilityService;
let caps: FeishuCapabilities;
let authorizationStore: Store;
let authorization: AuthorizationService;
let resourceIndex: FeishuAuthorizationResourceIndex;
/** Every call that reached the downstream MCP. */
let backendCalls: FeishuCall[];
/** Every read of a credential, by kind. A deny must not touch either. */
let credentialReads: Array<{ kind: "user" | "service"; username?: string }>;
let userTokens: Record<string, string | null>;
let userScopes: Record<string, readonly string[]> | null;
let offeredTools: string[];
let identityNotices: Array<{ username: string; operation: string; reason: string }>;
/** Files the source reader double serves, keyed `owner|device|workspace|path`. */
let deviceFiles: Map<string, Buffer>;
let sourceReads: string[];

class FakeBackend implements FeishuToolBackend {
  async call(c: FeishuCall): Promise<unknown> {
    backendCalls.push(c);
    return { ok: true, tool: c.tool };
  }
  async listTools(): Promise<string[]> {
    return offeredTools;
  }
  stop(): void {}
}

const resolver: FeishuCredentialResolver = {
  async userToken(username) {
    credentialReads.push({ kind: "user", username });
    return userTokens[username] ?? null;
  },
  async userScopes(username) {
    return userScopes ? (userScopes[username] ?? []) : null;
  },
  serviceAccountAvailable() {
    return true;
  },
};

/** Every scope the user catalog can ask for — the "fully authorised" fixture. */
const ALL_SCOPES: readonly string[] = [
  ...new Set(Object.values(FEISHU_USER_OPERATIONS).flatMap((e) => e.scopes)),
];

async function boot(): Promise<void> {
  backendCalls = [];
  credentialReads = [];
  userTokens = { alice: "uat-alice", bob: "uat-bob" };
  userScopes = { alice: ALL_SCOPES, bob: ALL_SCOPES };
  offeredTools = [...CATALOGUED_TOOLS];
  identityNotices = [];
  deviceFiles = new Map();
  sourceReads = [];
  svc = new CapabilityService();
  caps = new FeishuCapabilities({
    service: svc,
    resolver,
    backend: new FakeBackend(),
    sourceFiles: {
      async read(owner, device, workspaceId, relativePath) {
        const key = `${owner}|${device}|${workspaceId}|${relativePath}`;
        sourceReads.push(key);
        const bytes = deviceFiles.get(key);
        if (!bytes) throw new Error("文件不存在");
        async function* chunks() { for (let at = 0; at < bytes!.length; at += 256 * 1024) yield bytes!.subarray(at, at + 256 * 1024); }
        return { size: bytes.length, chunks: chunks() };
      },
    },
    isUser: (u) => ["alice", "bob"].includes(u),
    onIdentityUnavailable: async (username, operation, reason) => {
      identityNotices.push({ username, operation, reason });
    },
  });
  authorizationStore = new Store(":memory:");
  authorization = new AuthorizationService({ repository: authorizationStore.authorization });
  resourceIndex = new FeishuAuthorizationResourceIndex(authorization);
  caps.installResourceIndex(resourceIndex);
  await caps.verifyCatalog();
}

beforeEach(boot);

afterEach(() => {
  caps.revokeUser("alice");
  caps.revokeUser("bob");
  svc.close();
  authorization.close();
  authorizationStore.close();
});

/** What an agent turn holds: read ops auto-allowed, everything else not. */
function agentGrant(username: string) {
  return caps.open({
    username,
    purpose: `chat-feishu/${username}`,
    kind: "agent-run",
    rights: FEISHU_USER_OPS,
    autoAllow: FEISHU_USER_READ_OPS,
  });
}

describe("SEC-03 · a user-identity call runs as the user, or not at all", () => {
  it("a read runs unsupervised and carries the caller's own token", async () => {
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "doc_read", { document_id: "doc-1" });
    expect(out.status).toBe("succeeded");
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0].tool).toBe("docx_v1_document_rawContent");
    expect(backendCalls[0].credential).toEqual({ mode: "user_oauth", token: "uat-alice" });
    // `useUAT` is set by the adapter, not by a middleman rewriting messages.
    expect(backendCalls[0].payload).toMatchObject({ useUAT: true, path: { document_id: "doc-1" } });
  });

  it("no UAT: the downstream backend is never called, and nothing falls back", async () => {
    userTokens.alice = null;
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "doc_read", { document_id: "doc-1" });
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.reason).toContain("权限中心");
    expect(backendCalls).toHaveLength(0);
    // The resolver WAS asked for the user's token — and answered null. What
    // must not happen is a second read of a different credential.
    expect(credentialReads).toEqual([{ kind: "user", username: "alice" }]);
    expect(identityNotices).toEqual([expect.objectContaining({ username: "alice", operation: "doc_read" })]);
  });

  it("under-scoped UAT fails closed rather than trying the app identity", async () => {
    userScopes = { alice: ["docx:document:readonly"] };
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "calendar_primary", {});
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.reason).toContain("calendar:calendar:read");
    expect(backendCalls).toHaveLength(0);
  });

  it("scopes the deployment cannot PROVE are a refusal, not a skipped check", async () => {
    // The production resolver used to have no `userScopes` at all, so this
    // returned null and the check was silently bypassed while the tests — which
    // supplied scopes — went on passing.
    userScopes = null;
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "doc_read", { document_id: "d" });
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.reason).toContain("权限中心");
    expect(backendCalls).toHaveLength(0);
  });

  it("an unverified catalog grants nothing at all", async () => {
    const fresh = new FeishuCapabilities({
      service: new CapabilityService(),
      resolver,
      backend: new FakeBackend(),
      isUser: () => true,
    });
    expect(fresh.catalogVerified).toBe(false);
    expect(fresh.runnable().size).toBe(0);
    expect(fresh.open({ username: "alice", purpose: "p", kind: "agent-run", rights: FEISHU_USER_OPS })).toBeNull();
    expect(fresh.openSystem("p")).toBeNull();
    expect(backendCalls).toHaveLength(0);
  });

  it("hasIdentity is the question the Router asks before handing out any tool", async () => {
    expect(await caps.hasIdentity("alice")).toBe(true);
    userTokens.alice = null;
    expect(await caps.hasIdentity("alice")).toBe(false);
    expect(await caps.hasIdentity("mallory")).toBe(false);
    expect(await caps.hasIdentity("")).toBe(false);
  });

  it("a revoked Feishu authority denies the next call with no credential read", async () => {
    const grant = agentGrant("alice")!;
    expect((await grant.capabilities.request(FEISHU_SLOT, "doc_read", { document_id: "d" })).status).toBe("succeeded");
    credentialReads = [];
    backendCalls = [];
    caps.revokeUser("alice");
    const out = await grant.capabilities.request(FEISHU_SLOT, "doc_read", { document_id: "d" });
    expect(out.status).toBe("denied");
    expect(backendCalls).toHaveLength(0);
    expect(credentialReads).toHaveLength(0);
  });

  it("revoking the OAuth identity kills live grants AND undecided approvals", async () => {
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "doc_create", { file_name: "x", markdown: "y" });
    expect(out.status).toBe("approval_required");
    const pending = svc.listPending("alice");
    expect(pending).toHaveLength(1);

    // What `/auth-revoke` does.
    caps.revokeUser("alice");

    // The card cannot be approved into an execution any more…
    expect((await svc.approve(pending[0].id, "alice")).status).not.toBe("succeeded");
    // …and the token minted for the running turn addresses nothing.
    expect((await grant.capabilities.request(FEISHU_SLOT, "doc_read", { document_id: "d" })).status).toBe("denied");
    expect(backendCalls).toHaveLength(0);
  });

  it("bob cannot use alice's grant, and a grant is bound to one account", async () => {
    const alice = agentGrant("alice")!;
    await alice.capabilities.request(FEISHU_SLOT, "doc_read", { document_id: "d" });
    expect(backendCalls[0].credential).toEqual({ mode: "user_oauth", token: "uat-alice" });
    // There is no argument that changes whose token is used: the Object's
    // binding fixes the owner, and Bob has a different Object.
    const bob = agentGrant("bob")!;
    await bob.capabilities.request(FEISHU_SLOT, "doc_read", { document_id: "d" });
    expect(backendCalls[1].credential).toEqual({ mode: "user_oauth", token: "uat-bob" });
    expect(svc.objectIdOf(alice.contextId, FEISHU_SLOT)).toBe("feishu-user-v3:alice");
    expect(svc.objectIdOf(bob.contextId, FEISHU_SLOT)).toBe("feishu-user-v3:bob");
  });

  it("an unknown user gets no grant at all", () => {
    expect(agentGrant("mallory")).toBeNull();
  });
});

describe("SEC-03 · writes and sends need the account owner, per call", () => {
  it("creating a document queues an approval and reaches nothing until approved", async () => {
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "doc_create", {
      file_name: "计划",
      markdown: "# 计划",
    });
    expect(out.status).toBe("approval_required");
    expect(backendCalls).toHaveLength(0);
    expect(credentialReads).toHaveLength(0);

    const pending = svc.listPending("alice");
    expect(pending).toHaveLength(1);
    // The card says whose identity is used and what class of action it is.
    expect(pending[0].details.join("\n")).toContain("以你自己的飞书账号（alice）");
    expect(pending[0].details.join("\n")).toContain("写入");
    // Bob cannot approve a call on Alice's account.
    expect((await svc.approve(pending[0].id, "bob")).status).toBe("denied");
    expect(backendCalls).toHaveLength(0);

    expect((await svc.approve(pending[0].id, "alice")).status).toBe("succeeded");
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0].tool).toBe("docx_builtin_import");
  });

  it("canonicalizes a Feishu person alias before approval and labels the external send", async () => {
    const canonical = resourceIndex.canonicalize("feishu://people/ou_1", "people");
    authorization.putResourceAlias({
      owner: resourceIndex.owner,
      uri: "feishu://people/team-lead",
      targetUri: canonical,
      createdBy: "system:test",
    });
    const grant = caps.openPrivileged({
      username: "alice", purpose: "privileged-test", kind: "agent-run", rights: ["message_send_as_bot"],
    })!;
    await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_as_bot", {
      target_ref: "feishu://people/team-lead",
      text: "hi",
    });
    const pending = svc.listPending("alice")[0];
    expect(pending.details.join("\n")).toContain("向外发送");
    expect(pending.details.join("\n")).toContain("feishu://people/ou_1");
    expect(pending.details.join("\n")).not.toContain("feishu://people/team-lead");
    expect(backendCalls).toHaveLength(0);
    expect((await svc.approve(pending.id, "alice")).status).toBe("succeeded");
    expect(backendCalls[0].payload).toMatchObject({
      params: { receive_id_type: "open_id" },
      data: { receive_id: "ou_1" },
    });
  });

  it("does not render file bytes into the owner approval summary", async () => {
    const grant = caps.openPrivileged({
      username: "alice", purpose: "file-test", kind: "agent-run", rights: ["message_send_file_as_bot"],
    })!;
    const encoded = Buffer.from("private material").toString("base64");
    await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_file_as_bot", {
      target_ref: "feishu://chats/oc_1",
      file_name: "material.txt",
      file_type: "stream",
      file_base64: encoded,
    });
    const details = svc.listPending("alice")[0].details.join("\n");
    expect(details).toContain(`file_base64：[base64 ${encoded.length} 字符]`);
    expect(details).not.toContain(encoded);
  });

  it("declares exactly as much inline file as one capability call can carry", async () => {
    const grant = caps.openPrivileged({
      username: "alice", purpose: "file-window", kind: "agent-run", rights: ["message_send_file_as_bot"],
    })!;
    const largest = {
      target_ref: "feishu://chats/oc_1",
      file_name: "\u0001".repeat(240),
      file_type: "stream",
      file_base64: "A".repeat(SEND_FILE_BASE64_MAX),
    };
    // Fully escaped neighbours included, the declared maximum stays inside the kernel's argument window.
    expect(argsTooLarge({ ...largest, target_ref: "\u0001".repeat(512) })).toBe(false);
    const fits = await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_file_as_bot", largest);
    expect(fits.status).toBe("approval_required");
    const over = await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_file_as_bot", { ...largest, file_base64: "A".repeat(SEND_FILE_BASE64_MAX + 4) });
    expect(over.status).toBe("denied");
  });

  it("sends a 5 MiB file by reference: the card names it, execution reads and checks the approved bytes", async () => {
    const grant = caps.openPrivileged({
      username: "alice", purpose: "file-ref", kind: "agent-run", rights: ["message_send_file_as_bot"],
    })!;
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
    deviceFiles.set("alice|laptop|ws_1|out/report.bin", bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const args = {
      target_ref: "feishu://chats/oc_1", file_name: "report.bin", file_type: "stream",
      source_device: "laptop", source_workspace: "ws_1", source_path: "out/report.bin", file_size: bytes.length, file_sha256: sha,
    };
    const asked = await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_file_as_bot", args);
    expect(asked.status).toBe("approval_required");
    const pending = svc.listPending("alice")[0];
    const card = pending.details.join("\n");
    expect(card).toContain("文件：laptop · 工作区 ws_1 · out/report.bin");
    expect(card).toContain(`${bytes.length} 字节，SHA-256 ${sha.slice(0, 16)}`);
    expect(sourceReads).toEqual([]); // nothing is read before the owner decides
    expect((await svc.approve(pending.id, "alice")).status).toBe("succeeded");
    expect(sourceReads).toEqual(["alice|laptop|ws_1|out/report.bin"]);
    expect(backendCalls).toHaveLength(1);
    const payload = backendCalls[0]!.payload;
    expect(payload).toMatchObject({ target_kind: "chats", target_id: "oc_1", file_name: "report.bin" });
    expect(Buffer.isBuffer(payload.file_bytes) && (payload.file_bytes as Buffer).equals(bytes)).toBe(true);
    expect(payload).not.toHaveProperty("source");
  });

  it("refuses to send a by-reference file that changed after approval", async () => {
    const grant = caps.openPrivileged({
      username: "alice", purpose: "file-ref-changed", kind: "agent-run", rights: ["message_send_file_as_bot"],
    })!;
    const original = Buffer.from("approved content");
    const sha = createHash("sha256").update(original).digest("hex");
    deviceFiles.set("alice|laptop|ws_1|a.txt", Buffer.from("APPROVED content"));
    await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_file_as_bot", {
      target_ref: "feishu://chats/oc_1", file_name: "a.txt", file_type: "stream",
      source_device: "laptop", source_workspace: "ws_1", source_path: "a.txt", file_size: original.length, file_sha256: sha,
    });
    const out = await svc.approve(svc.listPending("alice")[0].id, "alice");
    expect(out.status).toBe("failed");
    expect(backendCalls).toHaveLength(0);
  });

  it("takes the file inline or by reference, never both or a partial reference", async () => {
    const grant = caps.openPrivileged({
      username: "alice", purpose: "file-modes", kind: "agent-run", rights: ["message_send_file_as_bot"],
    })!;
    const base = { target_ref: "feishu://chats/oc_1", file_name: "a.txt", file_type: "stream" };
    const ref = { source_device: "laptop", source_workspace: "ws_1", source_path: "a.txt", file_size: 3, file_sha256: "a".repeat(64) };
    for (const args of [base, { ...base, ...ref, file_base64: "YWJj" }, { ...base, source_path: "a.txt" }]) {
      expect((await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_file_as_bot", args)).status).toBe("denied");
    }
  });

  it("changing the arguments after approval does not ride the old approval", async () => {
    const grant = caps.openPrivileged({
      username: "alice", purpose: "privileged-test", kind: "agent-run", rights: ["message_send_as_bot"],
    })!;
    await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_as_bot", {
      target_ref: "feishu://chats/oc_1", text: "原文",
    });
    const first = svc.listPending("alice")[0];
    await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_as_bot", {
      target_ref: "feishu://chats/oc_1", text: "改过的",
    });
    await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_send_as_bot", {
      target_ref: "feishu://chats/oc_2", text: "原文",
    });
    expect(svc.listPending("alice")).toHaveLength(3);
    expect(backendCalls).toHaveLength(0);

    expect((await svc.approve(first.id, "alice")).status).toBe("succeeded");
    expect(backendCalls).toHaveLength(1);
    const data = (backendCalls[0].payload as { data: { receive_id: string; content: string } }).data;
    expect(data.receive_id).toBe("oc_1");
    expect(JSON.parse(data.content)).toEqual({ text: "原文" });
  });
});

describe("SEC-03 · a normal Agent cannot reach privileged or system identity", () => {
  it("naming a privileged operation on the ordinary user Object is denied", async () => {
    const grant = agentGrant("alice")!;
    for (const operation of FEISHU_PRIVILEGED_OPS) {
      expect((await grant.capabilities.request(FEISHU_SLOT, operation, {})).status).toBe("denied");
    }
    expect(backendCalls).toHaveLength(0);
  });

  it("a privileged read still requires one exact owner approval", async () => {
    const grant = caps.openPrivileged({
      username: "alice", purpose: "audit-chat", kind: "agent-run", rights: ["message_list_as_bot"],
    })!;
    const out = await grant.capabilities.request(FEISHU_PRIVILEGED_SLOT, "message_list_as_bot", {
      chat_ref: "feishu://chats/oc_1",
    });
    expect(out.status).toBe("approval_required");
    expect(backendCalls).toHaveLength(0);
  });
  it("naming a system operation on the user slot is denied and reads no credential", async () => {
    const grant = agentGrant("alice")!;
    for (const op of FEISHU_SYSTEM_OPS) {
      const out = await grant.capabilities.request(FEISHU_SLOT, op, { chat_id: "oc_1", text: "x" });
      expect(out.status).toBe("denied");
    }
    expect(backendCalls).toHaveLength(0);
    expect(credentialReads).toHaveLength(0);
  });

  it("naming the system slot is denied: an agent Context has no such slot", async () => {
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SYSTEM_SLOT, "system_reply_in_chat", {
      chat_id: "oc_1",
      text: "x",
    });
    expect(out.status).toBe("denied");
    expect(backendCalls).toHaveLength(0);
    expect(credentialReads).toHaveLength(0);
  });

  it("an agent grant asking for system operations gets a grant that does not contain them", () => {
    const grant = caps.open({
      username: "alice",
      purpose: "greedy",
      kind: "agent-run",
      rights: [...FEISHU_USER_OPS, ...FEISHU_SYSTEM_OPS],
      autoAllow: FEISHU_SYSTEM_OPS,
    })!;
    const rights = svc.rightsOf(grant.contextId, FEISHU_SLOT);
    for (const op of FEISHU_SYSTEM_OPS) expect(rights).not.toContain(op);
    expect(svc.termsOf(grant.contextId, FEISHU_SLOT).autoAllow).toEqual([]);
  });

  it("the trusted control plane CAN use the system identity, on its own Object", async () => {
    const sys = caps.openSystem("approval card")!;
    const out = await sys.capabilities.request(FEISHU_SYSTEM_SLOT, "system_reply_in_chat", {
      chat_id: "oc_1",
      text: "已收到",
    });
    expect(out.status).toBe("succeeded");
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0].credential).toEqual({ mode: "service_account" });
    // And it is a different Object with a different principal, so audit can
    // always answer "whose identity was this".
    expect(svc.objectIdOf(sys.contextId, FEISHU_SYSTEM_SLOT)).toBe("feishu-system:bot");
  });

  it("a Context that merely claims the system principal is still refused", async () => {
    // Forge the metadata the system policy reads, under the user's own root.
    const grant = agentGrant("alice")!;
    const forged = svc.createContext("agent-run", { principal: "system:feishu-bot" }, grant.contextId);
    svc.derive(grant.contextId, FEISHU_SLOT, forged, FEISHU_SLOT, ["doc_read"]);
    const out = await svc.bind(forged).request(FEISHU_SLOT, "system_reply_in_chat", { chat_id: "c", text: "x" });
    // The slot points at the USER Object, which has no such operation. Metadata
    // was never the thing granting anything.
    expect(out.status).toBe("denied");
    expect(backendCalls).toHaveLength(0);
  });
});

describe("SEC-03 · only catalogued tools are reachable", () => {
  it("an operation outside the catalog is denied before any adapter", async () => {
    const grant = agentGrant("alice")!;
    for (const op of ["bitable_v1_app_create", "drive_v1_permissionMember_create", "__proto__", "doc_read_all"]) {
      const out = await grant.capabilities.request(FEISHU_SLOT, op, {});
      expect(out.status).toBe("denied");
    }
    expect(backendCalls).toHaveLength(0);
    expect(credentialReads).toHaveLength(0);
  });

  it("a downstream tool the catalog does not list is reported and stays unreachable", async () => {
    offeredTools = [...CATALOGUED_TOOLS, "admin_v1_password_reset"];
    const report = await caps.verifyCatalog();
    expect(report.unclassified).toEqual(["admin_v1_password_reset"]);
    // Nothing about it becomes callable: the operation table is the catalog's.
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "admin_v1_password_reset", {});
    expect(out.status).toBe("denied");
    expect(backendCalls).toHaveLength(0);
  });

  it("a catalogued operation whose downstream tool vanished is disabled, not attempted", async () => {
    offeredTools = CATALOGUED_TOOLS.filter((t) => t !== "docx_v1_document_rawContent");
    const report = await caps.verifyCatalog();
    expect(report.missing).toContain("doc_read");
    const grant = agentGrant("alice")!;
    expect(svc.rightsOf(grant.contextId, FEISHU_SLOT)).not.toContain("doc_read");
    const out = await grant.capabilities.request(FEISHU_SLOT, "doc_read", { document_id: "d" });
    expect(out.status).toBe("denied");
    expect(backendCalls).toHaveLength(0);
  });

  it("a backend that cannot be listed disables everything", async () => {
    const broken = new FeishuCapabilities({
      service: new CapabilityService(),
      resolver,
      backend: {
        call: async (c) => {
          backendCalls.push(c);
          return null;
        },
        listTools: async () => {
          throw new Error("downstream is down");
        },
        stop: () => {},
      },
      isUser: () => true,
    });
    await broken.verifyCatalog();
    expect(broken.runnable().size).toBe(0);
    expect(broken.open({ username: "alice", purpose: "p", kind: "agent-run", rights: FEISHU_USER_OPS })).toBeNull();
    expect(backendCalls).toHaveLength(0);
  });

  it("an unknown argument is refused by the schema before the adapter", async () => {
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "doc_read", {
      document_id: "d",
      useUAT: false,
      path: "../../etc/passwd",
    });
    expect(out.status).toBe("denied");
    expect(backendCalls).toHaveLength(0);
  });
});

describe("SEC-03 · what the agent's MCP server is given", () => {
  it("classifies every one of the pinned lark-mcp tools", () => {
    expect(FEISHU_MCP_CATALOG).toHaveLength(46);
    expect(new Set(FEISHU_MCP_CATALOG.map((entry) => entry.tool))).toEqual(new Set(CATALOGUED_TOOLS));
  });

  it("the tool descriptors come from the catalog and name no credential", () => {
    const tools = gatewayToolDescriptors(FEISHU_USER_OPS);
    expect(tools.length).toBe(FEISHU_USER_OPS.length);
    const blob = JSON.stringify(tools);
    for (const secret of ["uat-", "app_secret", "appSecret", "user_access_token", "tenant"]) {
      expect(blob).not.toContain(secret);
    }
    // Write-class tools carry the "you must be approved" instruction.
    const create = tools.find((t) => t.name === "feishu_doc_create")!;
    expect(create.description).toContain("批准");
  });

  it("hiding a tool is UX: an operation not in the descriptor list is still gated", async () => {
    const tools = gatewayToolDescriptors(["doc_read"]);
    expect(tools.map((t) => t.name)).toEqual(["feishu_doc_read"]);
    // The grant, not the descriptor list, is what decides.
    const grant = caps.open({ username: "alice", purpose: "narrow", kind: "agent-run", rights: ["doc_read"] })!;
    expect((await grant.capabilities.request(FEISHU_SLOT, "doc_create", { file_name: "x", markdown: "y" })).status)
      .toBe("denied");
    expect(backendCalls).toHaveLength(0);
  });
});

describe("lark-cli through the gateway", () => {
  const argv = (...values: string[]) => ({ args: JSON.stringify(values) });

  it("runs a read unsupervised, as the user, with the parsed request", async () => {
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "lark_cli_read", argv("slides", "+xml-get", "--presentation", "HYDL"));
    expect(out.status).toBe("succeeded");
    expect(backendCalls).toEqual([{
      tool: "octopus_lark_cli",
      credential: { mode: "user_oauth", token: "uat-alice" },
      payload: { mode: "read", argv: ["slides", "+xml-get", "--presentation", "HYDL"], files: [] },
    }]);
  });

  it("asks the owner for every write, showing the command, and runs it as a write once approved", async () => {
    const grant = agentGrant("alice")!;
    const out = await grant.capabilities.request(FEISHU_SLOT, "lark_cli_write", argv("slides", "+delete-slide", "--presentation", "HYDL", "--slide-id", "s1"));
    expect(out.status).toBe("approval_required");
    expect(backendCalls).toHaveLength(0);
    expect(credentialReads).toHaveLength(0);
    const [pending] = svc.listPending("alice");
    const card = pending.details.join("\n");
    expect(card).toContain("以你自己的飞书账号（alice）");
    expect(card).toContain("命令：lark-cli slides +delete-slide --presentation HYDL --slide-id s1");
    expect(card).toContain("lark_cli_write@1");
    expect((await svc.approve(pending.id, "alice")).status).toBe("succeeded");
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0].payload).toMatchObject({ mode: "write", argv: ["slides", "+delete-slide", "--presentation", "HYDL", "--slide-id", "s1"] });
  });

  it("refuses a command outside the offered domains before anyone is asked or any credential is read", async () => {
    const grant = agentGrant("alice")!;
    for (const operation of ["lark_cli_read", "lark_cli_write"]) {
      for (const first of ["auth", "config", "update", "event", "apps"]) {
        expect((await grant.capabilities.request(FEISHU_SLOT, operation, argv(first, "x"))).status).toBe("denied");
      }
    }
    expect(svc.listPending("alice")).toHaveLength(0);
    expect(backendCalls).toHaveLength(0);
    expect(credentialReads).toHaveLength(0);
  });

  it("retires a version-2 root left in the store when the user's authority is revoked", () => {
    const v2 = Object.fromEntries(Object.entries(FEISHU_USER_OPERATIONS)
      .filter(([operation]) => !operation.startsWith("lark_cli_"))
      .map(([operation, entry]) => [operation, entry.spec]));
    svc.registerObject({ id: "feishu-user-v2:alice", kind: "feishu-user", binding: { owner: "alice" }, metadata: { owner: "alice" },
      operations: v2, policy: () => ({ kind: "allow" }), adapter: async () => ({ legacy: true }) });
    const root = svc.createContext("feishu-authority", { owner: "alice" });
    svc.mintRoot(root, FEISHU_SLOT, "feishu-user-v2:alice", Object.keys(v2));
    expect(svc.rootsOf("feishu-user-v2:alice")).toHaveLength(1);
    caps.revokeUser("alice");
    expect(svc.rootsOf("feishu-user-v2:alice")).toHaveLength(0);
  });

  it("runs a CLI write unattended once its owner grants it, and no other write", async () => {
    const grant = caps.open({ username: "alice", purpose: "owner-granted", kind: "session", rights: FEISHU_USER_OPS,
      autoAllow: [...FEISHU_USER_READ_OPS, "lark_cli_write", "doc_create"] })!;
    expect((await grant.capabilities.request(FEISHU_SLOT, "lark_cli_write", argv("slides", "+delete-slide", "--presentation", "HYDL", "--slide-id", "s1"))).status)
      .toBe("succeeded");
    expect(backendCalls.at(-1)?.payload).toMatchObject({ mode: "write" });
    // The root's ceiling, not the request, decides: other writes still ask.
    expect((await grant.capabilities.request(FEISHU_SLOT, "doc_create", { file_name: "x", markdown: "y" })).status).toBe("approval_required");
  });

  it("replaces a root minted under the older read-only ceiling instead of silently asking", async () => {
    agentGrant("alice");
    const [current] = svc.rootsOf("feishu-user-v3:alice");
    svc.revoke(current!.contextId, FEISHU_SLOT);
    svc.destroyContext(current!.contextId);
    const old = svc.createContext("feishu-authority", { owner: "alice", principal: "user:alice" });
    svc.mintRoot(old, FEISHU_SLOT, "feishu-user-v3:alice", FEISHU_USER_OPS);
    expect(svc.termsOf(old, FEISHU_SLOT).autoAllow).not.toContain("lark_cli_write");
    const grant = caps.open({ username: "alice", purpose: "after-upgrade", kind: "session", rights: ["lark_cli_write"], autoAllow: ["lark_cli_write"] })!;
    expect((await grant.capabilities.request(FEISHU_SLOT, "lark_cli_write", argv("slides", "+add-slide", "--presentation", "HYDL"))).status).toBe("succeeded");
    expect(svc.rootsOf("feishu-user-v3:alice").map((root) => root.contextId)).not.toContain(old);
    expect(svc.rootsOf("feishu-user-v3:alice")).toHaveLength(1);
  });

  it("is not offered when the executor is not available", async () => {
    offeredTools = CATALOGUED_TOOLS.filter((tool) => tool !== "octopus_lark_cli");
    await caps.verifyCatalog();
    expect(caps.runnable().has("lark_cli_read")).toBe(false);
    expect(caps.runnable().has("doc_read")).toBe(true);
  });
});
