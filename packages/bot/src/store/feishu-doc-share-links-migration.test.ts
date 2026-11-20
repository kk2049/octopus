import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

const DOC = "DocxToken1234567890abcdefg";
const WIKI = "WikiToken1234567890abcdefgh";
const HASH = "a".repeat(64);

it("upgrades v92 with account and token data intact, and keeps document shares pending until revealed, owner-scoped and final", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-share-links-v92-"));
  const file = join(dir, "db");
  try {
    const before = new Database(file);
    migrateFixtureTo(before, 92);
    before.prepare("INSERT INTO users(username, uid, home_dir, created_at) VALUES (?, ?, ?, ?)").run("lht", 5001, "/fixture/lht", "2026-10-27T00:00:00Z");
    before.prepare("INSERT INTO mcp_tokens(token_hash, username, label, created_at, expires_at, last_used_at, revoked_at, policy_json) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)")
      .run(HASH, "lht", "share token", "2026-10-27T00:00:00Z");
    before.close();

    const store = new Store(file);
    expect(store.getUser("lht")?.uid).toBe(5001);
    expect(store.getActiveMcpTokenByHash(HASH, "2026-10-27T01:00:00Z")?.label).toBe("share token");
    const links = store.feishuDocShareLinks;
    links.createAnchor({ id: "anc_1", owner: "lht", documentId: DOC, wikiToken: WIKI, capabilityHash: "c".repeat(64), createdAt: 1 });
    expect(links.liveAnchor("lht", DOC)).toMatchObject({ id: "anc_1", state: "unknown", leaseUntil: 0, blockId: null, checkedAt: null, wikiToken: WIKI });
    expect(() => links.createAnchor({ id: "anc_2", owner: "lht", documentId: DOC, wikiToken: null, capabilityHash: "c".repeat(64), createdAt: 2 })).toThrow(/UNIQUE/);
    links.markPresent("anc_1", "blk1", 100, 10);
    expect(links.anchorByCapability("c".repeat(64))).toMatchObject({ state: "present", blockId: "blk1", leaseUntil: 100, checkedAt: 10, wikiToken: WIKI });

    // Created pending, with no token.
    links.createShare({ id: "shr_1", anchorId: "anc_1", owner: "lht", documentId: DOC, label: "张老师", rights: "write", createdAt: 20 });
    links.createShare({ id: "shr_2", anchorId: "anc_1", owner: "lht", documentId: DOC, label: "另一位", rights: "read", createdAt: 21 });
    expect(() => links.createShare({ id: "shr_3", anchorId: "anc_9", owner: "lht", documentId: DOC, label: "x", rights: "read", createdAt: 21 })).toThrow(/FOREIGN KEY/);
    expect(links.share("shr_1")).toMatchObject({ status: "pending", mcpTokenHash: null, lastUsedAt: null, statusChangedAt: 20, tokenLive: false });
    // Pending is neither paused nor resumed; it is revealed (once) or terminated.
    expect(links.transition("lht", "shr_1", ["active"], "paused", 22)).toBe(false);
    expect(links.activate("bob", "shr_1", HASH, 23)).toBe(false);
    expect(links.activate("lht", "shr_1", HASH, 23)).toBe(true);
    expect(links.activate("lht", "shr_1", "b".repeat(64), 24)).toBe(false);
    expect(links.share("shr_1")).toMatchObject({ status: "active", mcpTokenHash: HASH, statusChangedAt: 23, tokenLive: true });
    expect(() => links.activate("lht", "shr_2", HASH, 24)).toThrow(/UNIQUE/);
    expect(links.transition("lht", "shr_2", ["pending", "active", "paused"], "terminated", 25)).toBe(true);

    expect(links.transition("bob", "shr_1", ["active"], "paused", 30)).toBe(false);
    expect(links.transition("lht", "shr_1", ["paused"], "active", 30)).toBe(false);
    expect(links.transition("lht", "shr_1", ["active"], "paused", 31)).toBe(true);
    expect(links.share("shr_1")).toMatchObject({ status: "paused", statusChangedAt: 31 });
    expect(links.transition("lht", "shr_1", ["paused"], "active", 32)).toBe(true);
    links.touch("shr_1", 33);
    expect(links.transition("lht", "shr_1", ["active", "paused"], "terminated", 34)).toBe(true);
    expect(links.transition("lht", "shr_1", ["terminated"], "active", 35)).toBe(false);
    expect(links.transition("lht", "shr_1", ["active", "paused"], "paused", 35)).toBe(false);
    store.close();

    // The schema itself holds the lifecycle, whatever writes the row.
    const raw = new Database(file);
    expect(() => raw.prepare("UPDATE feishu_doc_shares SET status = 'active' WHERE id = 'shr_1'").run()).toThrow(/final/);
    raw.prepare("INSERT INTO feishu_doc_shares (id, anchor_id, owner, document_id, label, rights, status, mcp_token_hash, created_at, last_used_at, status_changed_at) VALUES ('shr_4', 'anc_1', 'lht', ?, 'x', 'read', 'pending', NULL, 40, NULL, 40)").run(DOC);
    expect(() => raw.prepare("UPDATE feishu_doc_shares SET status = 'active' WHERE id = 'shr_4'").run()).toThrow(/CHECK/);
    expect(() => raw.prepare("INSERT INTO feishu_doc_shares (id, anchor_id, owner, document_id, label, rights, status, mcp_token_hash, created_at, last_used_at, status_changed_at) VALUES ('shr_5', 'anc_1', 'lht', ?, 'x', 'read', 'pending', ?, 40, NULL, 40)").run(DOC, "d".repeat(64))).toThrow(/CHECK/);
    raw.prepare("UPDATE feishu_doc_shares SET status = 'active', mcp_token_hash = ? WHERE id = 'shr_4'").run("e".repeat(64));
    expect(() => raw.prepare("UPDATE feishu_doc_shares SET status = 'pending', mcp_token_hash = NULL WHERE id = 'shr_4'").run()).toThrow(/revealed only once/);
    raw.close();

    const reopened = new Store(file);
    expect(reopened.feishuDocShareLinks.share("shr_1")).toMatchObject({ status: "terminated", lastUsedAt: 33, statusChangedAt: 34 });
    expect(reopened.feishuDocShareLinks.ownedShares("lht").map((share) => share.id)).toEqual(["shr_4", "shr_2", "shr_1"]);
    expect(reopened.feishuDocShareLinks.ownedShares("lht", "OtherDocx1234567890abcdefg")).toEqual([]);
    expect(reopened.feishuDocShareLinks.anchorShares("anc_1").map((share) => share.id)).toEqual(["shr_4", "shr_2", "shr_1"]);
    // A token revoked or deleted elsewhere reads through as no longer live.
    reopened.revokeMcpToken("lht", HASH, "2026-10-27T02:00:00Z");
    expect(reopened.feishuDocShareLinks.share("shr_1")!.tokenLive).toBe(false);
    reopened.feishuDocShareLinks.markMissing("anc_1", 40);
    expect(reopened.feishuDocShareLinks.liveAnchor("lht", DOC)).toBeNull();
    expect(reopened.feishuDocShareLinks.anchor("anc_1")).toMatchObject({ state: "missing", checkedAt: 40, leaseUntil: 100 });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("upgrades v93 cards to self-serve 'write' with no claim link and their shares to the owner's, and holds readers' keys to their own shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-share-links-v93-"));
  const file = join(dir, "db");
  try {
    const before = new Database(file);
    migrateFixtureTo(before, 93);
    before.prepare("INSERT INTO users(username, uid, home_dir, created_at) VALUES (?, ?, ?, ?)").run("lht", 5001, "/fixture/lht", "2026-10-27T00:00:00Z");
    before.prepare("INSERT INTO feishu_doc_share_anchors (id, owner, document_id, wiki_token, capability_hash, block_id, lease_until, state, created_at, checked_at) VALUES ('anc_1', 'lht', ?, NULL, ?, 'blk1', 100, 'present', 1, 10)")
      .run(DOC, "c".repeat(64));
    before.prepare("INSERT INTO feishu_doc_shares (id, anchor_id, owner, document_id, label, rights, status, mcp_token_hash, created_at, last_used_at, status_changed_at) VALUES ('shr_old', 'anc_1', 'lht', ?, '旧共享', 'write', 'pending', NULL, 5, NULL, 5)")
      .run(DOC);
    before.close();

    const store = new Store(file);
    const links = store.feishuDocShareLinks;
    expect(links.anchor("anc_1")).toMatchObject({ state: "present", selfServe: "write", inviteHash: null, inviteCreatedAt: null });
    expect(links.share("shr_old")).toMatchObject({ status: "pending", via: "owner", mintedBy: null });

    // The ceiling and the claim link.
    links.setSelfServe("anc_1", "read");
    links.setInvite("anc_1", { hash: "1".repeat(64), at: 50 });
    expect(links.anchorByInvite("1".repeat(64))).toMatchObject({ id: "anc_1", selfServe: "read", inviteHash: "1".repeat(64), inviteCreatedAt: 50 });
    links.setInvite("anc_1", { hash: "2".repeat(64), at: 60 });
    expect(links.anchorByInvite("1".repeat(64))).toBeNull();
    links.createAnchor({ id: "anc_2", owner: "lht", documentId: DOC, wikiToken: null, capabilityHash: "d".repeat(64), createdAt: 70 });
    // A hash names one card at most; any number of cards have none.
    expect(() => links.setInvite("anc_2", { hash: "2".repeat(64), at: 70 })).toThrow(/UNIQUE/);
    links.setInvite("anc_1", null);
    expect(links.anchor("anc_1")).toMatchObject({ inviteHash: null, inviteCreatedAt: null });
    expect(links.anchorByInvite("2".repeat(64))).toBeNull();

    // A reader's key is born active with its token; the counts read what the card holds.
    const token = (hash: string, label: string) => store.saveMcpToken({ token_hash: hash, username: "lht", label, created_at: "2026-10-30T00:00:00Z", expires_at: null, last_used_at: null, revoked_at: null, policy_json: null });
    token("e".repeat(64), "a");
    token("f".repeat(64), "b");
    links.createActiveShare({ id: "shr_card", anchorId: "anc_1", owner: "lht", documentId: DOC, label: "张老师", rights: "read", via: "card", mintedBy: "ou_reader", mcpTokenHash: "e".repeat(64), createdAt: 100 });
    links.createActiveShare({ id: "shr_link", anchorId: "anc_1", owner: "lht", documentId: DOC, label: "外校老师", rights: "write", via: "invite", mintedBy: null, mcpTokenHash: "f".repeat(64), createdAt: 200 });
    expect(links.share("shr_card")).toMatchObject({ status: "active", via: "card", mintedBy: "ou_reader", mcpTokenHash: "e".repeat(64), statusChangedAt: 100, tokenLive: true });
    expect(links.share("shr_link")).toMatchObject({ status: "active", via: "invite", mintedBy: null });
    expect(() => links.createActiveShare({ id: "shr_dup", anchorId: "anc_1", owner: "lht", documentId: DOC, label: "x", rights: "read", via: "card", mintedBy: null, mcpTokenHash: "e".repeat(64), createdAt: 300 })).toThrow(/UNIQUE/);
    expect(links.selfServedSince("anc_1", 99)).toBe(2);
    expect(links.selfServedSince("anc_1", 100)).toBe(1);
    expect(links.selfServedSince("anc_2", 0)).toBe(0);
    expect(links.liveShareCount("anc_1")).toBe(3);
    // A token revoked elsewhere, or a terminated key, no longer counts.
    store.revokeMcpToken("lht", "f".repeat(64), "2026-10-30T01:00:00Z");
    expect(links.liveShareCount("anc_1")).toBe(2);
    expect(links.transition("lht", "shr_old", ["pending"], "terminated", 400)).toBe(true);
    expect(links.liveShareCount("anc_1")).toBe(1);
    expect(links.selfServedSince("anc_1", 0)).toBe(2);
    store.close();

    const raw = new Database(file);
    const insert = (id: string, via: string, status: string, hash: string | null) => raw.prepare(`INSERT INTO feishu_doc_shares (id, anchor_id, owner, document_id, label, rights, status, mcp_token_hash, created_at, last_used_at, status_changed_at, via, minted_by)
      VALUES (?, 'anc_1', 'lht', ?, 'x', 'read', ?, ?, 1, NULL, 1, ?, NULL)`).run(id, DOC, status, hash, via);
    expect(() => raw.prepare("UPDATE feishu_doc_share_anchors SET self_serve = 'admin' WHERE id = 'anc_1'").run()).toThrow(/CHECK/);
    expect(() => insert("shr_v1", "agent", "active", "9".repeat(64))).toThrow(/CHECK/);
    // A reader's key never passes through pending; the reserved 'assistant' and the owner's may.
    expect(() => insert("shr_v2", "card", "pending", null)).toThrow(/CHECK/);
    expect(() => insert("shr_v3", "invite", "pending", null)).toThrow(/CHECK/);
    insert("shr_v4", "assistant", "active", "8".repeat(64));
    insert("shr_v5", "owner", "pending", null);
    raw.close();

    const reopened = new Store(file);
    expect(reopened.feishuDocShareLinks.share("shr_v4")).toMatchObject({ via: "assistant", status: "active" });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
