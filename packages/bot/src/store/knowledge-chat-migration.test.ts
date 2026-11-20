import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("migration v61 (independent knowledge chats)", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it("adds owner-scoped chat tables without altering existing ticket data", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-knowledge-chat-v60-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 60);
    oldDb.close();

    const store = new Store(dbPath);
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x/alice", created_at: "2026-08-27T03:04:00.000Z" });
    const ticketCount = store.devTickets.listDevTickets().length;
    store.knowledgeChats.create({
      id: "kc_migrated",
      username: "alice",
      title: "迁移后的知识 Chat",
      message: "这是首条消息",
      requestId: "request-migrated",
    });
    expect(store.devTickets.listDevTickets()).toHaveLength(ticketCount);
    store.close();

    const upgraded = new Database(dbPath, { readonly: true });
    expect(upgraded.prepare("SELECT 1 AS present FROM schema_version WHERE version = 61").get()).toEqual({ present: 1 });
    expect(upgraded.prepare("SELECT username, title FROM knowledge_chats").get()).toEqual({
      username: "alice",
      title: "迁移后的知识 Chat",
    });
    expect(upgraded.prepare("SELECT role, content FROM knowledge_chat_messages").get()).toEqual({
      role: "user",
      content: "这是首条消息",
    });
    upgraded.close();
  });
});

describe("migration v92 (Knowledge Chat answers stored whole)", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it("drops the 8,000-character bound and preserves rows, ids, the cascade and the id high-water mark", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-knowledge-chat-v91-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 91);
    oldDb.exec(`
      INSERT INTO users (username, uid, home_dir, created_at) VALUES ('alice', 1, '/x/alice', '2026-10-01T00:00:00.000Z');
      INSERT INTO knowledge_chats (id, username, title, preview, request_id, created_at, updated_at)
        VALUES ('kc_old', 'alice', '旧对话', '问题', 'request-old-chat', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      INSERT INTO knowledge_chat_messages (chat_id, role, content, request_id, at)
        VALUES ('kc_old', 'user', '问题', 'request-old-turn', '2026-10-01T00:00:00.000Z');
      INSERT INTO knowledge_chat_messages (chat_id, role, content, request_id, at)
        VALUES ('kc_old', 'assistant', '旧回答', NULL, '2026-10-01T00:00:01.000Z');
      INSERT INTO knowledge_chat_messages (chat_id, role, content, request_id, at)
        VALUES ('kc_old', 'error', '已删除的最高 id', NULL, '2026-10-01T00:00:02.000Z');
    `);
    expect(() => oldDb.prepare("INSERT INTO knowledge_chat_messages (chat_id, role, content, at) VALUES ('kc_old', 'assistant', ?, 'x')")
      .run("x".repeat(8_001))).toThrow(/CHECK/);
    oldDb.exec("DELETE FROM knowledge_chat_messages WHERE id = 3");
    oldDb.close();

    const store = new Store(dbPath);
    const before = store.knowledgeChats.messages("alice", "kc_old");
    expect(before.map((row) => [row.id, row.role, row.content, row.request_id])).toEqual([
      [1, "user", "问题", "request-old-turn"],
      [2, "assistant", "旧回答", null],
    ]);
    const long = store.knowledgeChats.append("kc_old", "assistant", "长".repeat(20_000));
    // AUTOINCREMENT never reuses the deleted id 3.
    expect(long.id).toBe(4);
    expect(store.knowledgeChats.messages("alice", "kc_old").at(-1)?.content).toHaveLength(20_000);
    store.close();

    const upgraded = new Database(dbPath);
    upgraded.pragma("foreign_keys = ON");
    expect(upgraded.prepare("SELECT 1 AS present FROM schema_version WHERE version = 92").get()).toEqual({ present: 1 });
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_knowledge_chat_messages'").get())
      .toEqual({ name: "idx_knowledge_chat_messages" });
    expect(() => upgraded.prepare("INSERT INTO knowledge_chat_messages (chat_id, role, content, request_id, at) VALUES ('kc_old', 'user', 'dup', 'request-old-turn', 'x')").run())
      .toThrow(/UNIQUE/);
    expect(() => upgraded.prepare("INSERT INTO knowledge_chat_messages (chat_id, role, content, at) VALUES ('kc_old', 'user', '', 'x')").run())
      .toThrow(/CHECK/);
    upgraded.exec("DELETE FROM knowledge_chats WHERE id = 'kc_old'");
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM knowledge_chat_messages").get()).toEqual({ n: 0 });
    upgraded.close();
  });
});
