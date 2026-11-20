import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { MIGRATIONS } from "./migrations.js";
import { Store, type SessionExecutionBindingRow } from "./store.js";

const DOC = "DocxToken1234567890abcdefg";
const WS = `ws_${"0".repeat(24)}`;
const HASH = "a".repeat(64);
const ASSISTANT = `op_fda_${"1".repeat(40)}`;

const binding = (patch: Partial<SessionExecutionBindingRow>): SessionExecutionBindingRow => ({
  owner: "lht", runtime_owner: "lht", runtime_device: "laptop", runtime_resource_id: null, source: "claude", session_id: "s-assistant",
  operation_id: ASSISTANT, execution_device: "laptop", workspace_id: WS, permission_profile: "read_only", doc_share_id: "shr_assistant",
  token_hash: "b".repeat(64), expires_at: "2026-11-01T00:00:00.000Z", created_at: "2026-10-30T00:00:00.000Z", updated_at: "2026-10-30T00:00:00.000Z",
  ...patch,
});

it("upgrades v94 with shares, anchors and bindings intact, and keeps read-only bindings and assistants in tables only the new release reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-assistant-v94-"));
  const file = join(dir, "db");
  try {
    const before = new Database(file);
    migrateFixtureTo(before, 94);
    before.prepare("INSERT INTO users(username, uid, home_dir, created_at) VALUES (?, ?, ?, ?)").run("lht", 5001, "/fixture/lht", "2026-10-30T00:00:00Z");
    before.prepare("INSERT INTO mcp_tokens(token_hash, username, label, created_at, expires_at, last_used_at, revoked_at, policy_json) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)")
      .run(HASH, "lht", "share token", "2026-10-30T00:00:00Z");
    before.prepare(`INSERT INTO feishu_doc_share_anchors (id, owner, document_id, wiki_token, capability_hash, block_id, lease_until, state, created_at, checked_at)
      VALUES ('anc_1', 'lht', ?, NULL, ?, 'blk1', 100, 'present', 1, 1)`).run(DOC, "c".repeat(64));
    before.prepare(`INSERT INTO feishu_doc_shares (id, anchor_id, owner, document_id, label, rights, status, mcp_token_hash, created_at, last_used_at, status_changed_at)
      VALUES ('shr_link', 'anc_1', 'lht', ?, '张老师', 'write', 'active', ?, 2, NULL, 2)`).run(DOC, HASH);
    before.prepare(`INSERT INTO session_execution_bindings (owner, runtime_device, source, session_id, operation_id, execution_device, workspace_id,
      permission_profile, token_hash, expires_at, created_at, updated_at, runtime_owner, runtime_resource_id)
      VALUES ('lht', 'runner', 'codex', 's-split', 'op_split', 'worker', ?, 'full_access', ?, '2026-11-01T00:00:00.000Z', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z', 'lht', NULL)`)
      .run(WS, "d".repeat(64));
    before.close();

    const store = new Store(file);
    const raw0 = new Database(file, { readonly: true });
    // Store applies every migration after v94, including those added after the assistants release.
    expect(raw0.prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: MIGRATIONS.at(-1)!.version });
    raw0.close();
    // Existing shares and cards are as they were; assistants are off and no project is linked.
    expect(store.feishuDocShareLinks.share("shr_link")).toMatchObject({ via: "owner", mintedBy: null, status: "active", tokenLive: true, label: "张老师" });
    expect(store.feishuDocShareLinks.anchor("anc_1")).toMatchObject({ selfServe: "write", inviteHash: null });
    expect(store.feishuDocAssistants.settings("anc_1")).toEqual({ project: null, rights: null });
    expect(store.getSessionExecutionBinding("lht", "runner", "codex", "s-split", "2026-10-30T01:00:00.000Z"))
      .toMatchObject({ permission_profile: "full_access", doc_share_id: null, execution_device: "worker" });

    // A read-only binding is written where only this release looks, and read back through the same accessors.
    store.saveSessionExecutionBinding(binding({}));
    expect(store.getSessionExecutionBinding("lht", "laptop", "claude", "s-assistant", "2026-10-30T01:00:00.000Z"))
      .toMatchObject({ permission_profile: "read_only", doc_share_id: "shr_assistant", runtime_resource_id: null });
    expect(store.getSessionExecutionBindingByRuntime("lht", "laptop", "claude", "s-assistant")).toMatchObject({ doc_share_id: "shr_assistant" });
    expect(store.listActiveSessionExecutionBindings("2026-10-30T01:00:00.000Z").map((row) => [row.session_id, row.permission_profile]))
      .toEqual([["s-assistant", "read_only"], ["s-split", "full_access"]]);
    store.saveSessionExecutionBinding(binding({ token_hash: "e".repeat(64), operation_id: `${ASSISTANT}:r:1` }));
    expect(store.getSessionExecutionBinding("lht", "laptop", "claude", "s-assistant", "0000-01-01T00:00:00.000Z")).toMatchObject({ token_hash: "e".repeat(64) });

    // Anchor settings: a project of its own, and assistant rights that may be off while it stays.
    store.feishuDocAssistants.configure("anc_1", "write", { device: "laptop", workspaceId: WS, label: "ACC" });
    expect(store.feishuDocAssistants.settings("anc_1")).toEqual({ project: { device: "laptop", workspaceId: WS, label: "ACC" }, rights: "write" });
    store.feishuDocAssistants.configure("anc_1", null);
    expect(store.feishuDocAssistants.settings("anc_1")).toEqual({ project: { device: "laptop", workspaceId: WS, label: "ACC" }, rights: null });
    store.close();

    const raw = new Database(file);
    // An older release reads only v58's table: the assistant's row is not there for it to rebuild as a full scope.
    expect(raw.prepare("SELECT session_id FROM session_execution_bindings").all()).toEqual([{ session_id: "s-split" }]);
    expect(raw.prepare("SELECT session_id, permission_profile FROM session_execution_read_only_bindings").all())
      .toEqual([{ session_id: "s-assistant", permission_profile: "read_only" }]);
    const insert = (row: SessionExecutionBindingRow) => raw.prepare(`INSERT INTO session_execution_read_only_bindings (owner, runtime_owner, runtime_device,
        runtime_resource_id, source, session_id, operation_id, execution_device, workspace_id, permission_profile, doc_share_id, token_hash, expires_at, created_at, updated_at)
      VALUES (@owner, @runtime_owner, @runtime_device, @runtime_resource_id, @source, @session_id, @operation_id, @execution_device, @workspace_id,
        @permission_profile, @doc_share_id, @token_hash, @expires_at, @created_at, @updated_at)`).run(row);
    // The table itself holds the placement: one device, owner-local, Claude, read-only, with a share.
    for (const invalid of [
      binding({ session_id: "x1", permission_profile: "manual" }),
      binding({ session_id: "x2", execution_device: "worker" }),
      binding({ session_id: "x3", runtime_owner: "bob" }),
      binding({ session_id: "x4", runtime_resource_id: "agent-runtime:0123456789abcdef0123456789abcdef" }),
      binding({ session_id: "x5", source: "codex" }),
      binding({ session_id: "x6", doc_share_id: null }),
    ]) expect(() => insert(invalid), invalid.session_id).toThrow(/constraint/);
    // The old table still refuses the new profile.
    expect(() => raw.prepare(`INSERT INTO session_execution_bindings (owner, runtime_device, source, session_id, operation_id, execution_device, workspace_id,
      permission_profile, token_hash, expires_at, created_at, updated_at) VALUES ('lht', 'laptop', 'claude', 'y', 'op', 'laptop', ?, 'read_only', 'h', 'x', 'x', 'x')`).run(WS)).toThrow(/CHECK/);
    expect(() => raw.prepare("UPDATE feishu_doc_shares SET via = 'agent' WHERE id = 'shr_link'").run()).toThrow(/CHECK/);
    expect(() => raw.prepare("UPDATE feishu_doc_share_anchors SET project_workspace = '../ws' WHERE id = 'anc_1'").run()).toThrow(/CHECK/);
    expect(() => raw.prepare("UPDATE feishu_doc_share_anchors SET assistant_rights = 'admin' WHERE id = 'anc_1'").run()).toThrow(/CHECK/);
    raw.close();

    const reopened = new Store(file);
    const assistants = reopened.feishuDocAssistants;
    reopened.feishuDocShareLinks.createAssistantShare({ id: "shr_assistant", anchorId: "anc_1", owner: "lht", documentId: DOC, label: "王同学的文档助手", rights: "read", mcpTokenHash: HASH.replace(/a/g, "f"), createdAt: 3 });
    expect(reopened.feishuDocShareLinks.share("shr_assistant")).toMatchObject({ via: "assistant", status: "active", rights: "read", tokenLive: false });
    const row = { id: ASSISTANT, owner: "lht", anchorId: "anc_1", shareId: "shr_assistant", guestOpenId: "ou_guest", guestName: "王同学",
      title: "王同学的文档助手：检查推导", device: "laptop", workspaceId: WS, createdAt: 4 };
    expect(() => assistants.create({ ...row, id: "op_fdl_1" })).toThrow(/CHECK/);
    expect(() => assistants.create({ ...row, shareId: "shr_missing" })).toThrow(/FOREIGN KEY/);
    assistants.create(row);
    expect(() => assistants.create({ ...row, id: `op_fda_${"2".repeat(40)}` })).toThrow(/UNIQUE/);
    expect(assistants.attach(ASSISTANT, "bob", "s-assistant")).toBe(false);
    expect(assistants.attach(ASSISTANT, "lht", "s-assistant")).toBe(true);
    expect(assistants.attach(ASSISTANT, "lht", "s-other")).toBe(false);
    expect(assistants.bySession("lht", "laptop", "s-assistant")).toMatchObject({ id: ASSISTANT, rights: "read", endedAt: null });
    expect(assistants.end(ASSISTANT, 5)).toBe(true);
    expect(assistants.end(ASSISTANT, 6)).toBe(false);
    expect(assistants.get(ASSISTANT)).toMatchObject({ endedAt: 5, live: false, usable: false });
    reopened.close();
    const final = new Database(file);
    expect(() => final.prepare("UPDATE feishu_doc_assistants SET ended_at = NULL WHERE id = ?").run(ASSISTANT)).toThrow(/final/);
    final.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
