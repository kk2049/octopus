import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../store.js";
import { KNOWLEDGE_CHAT_LIST_PAGE, KNOWLEDGE_CHAT_PAGE, type KnowledgeChatListCursor } from "./knowledge-chats.js";

const AT = "2026-08-27T03:04:00.000Z";

describe("knowledge chats repository", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x/alice", created_at: AT });
    store.saveUser({ username: "bob", uid: 2, home_dir: "/x/bob", created_at: AT });
  });

  afterEach(() => store.close());

  it("creates a chat and its required first message atomically without a ticket row", () => {
    const beforeTickets = store.devTickets.listDevTickets().length;
    const created = store.knowledgeChats.create({
      id: "kc_first",
      username: "alice",
      subjectId: "conflict:one",
      title: "为什么冲突",
      message: "为什么这两条知识冲突？",
      requestId: "request-first",
    });

    expect(created.created).toBe(true);
    expect(created.chat).toMatchObject({ username: "alice", subject_id: "conflict:one", running_since: expect.any(String) });
    expect(store.knowledgeChats.messages("alice", created.chat.id)).toMatchObject([
      { role: "user", content: "为什么这两条知识冲突？", request_id: "request-first" },
    ]);
    expect(store.devTickets.listDevTickets()).toHaveLength(beforeTickets);
  });

  it("pages the whole roster by keyset, and a chat active between windows moves up instead of repeating", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Half the rows share a timestamp with a neighbour: the id breaks the tie.
      for (let i = 0; i < 250; i += 1) {
        vi.setSystemTime(Date.parse(AT) + Math.floor(i / 2) * 1_000);
        const id = `kc_${String(i).padStart(3, "0")}`;
        store.knowledgeChats.create({ id, username: "alice", title: id, message: id, requestId: `request-${id}` });
        store.knowledgeChats.finishTurn(id);
      }
      store.knowledgeChats.create({ id: "kc_bob", username: "bob", title: "b", message: "b", requestId: "request-bob" });
      const seen: string[] = [];
      let before: KnowledgeChatListCursor | undefined;
      for (let window = 0; ; window += 1) {
        const page = store.knowledgeChats.list("alice", before ? { before } : {});
        expect(page.chats.length).toBeLessThanOrEqual(KNOWLEDGE_CHAT_LIST_PAGE);
        seen.push(...page.chats.map((chat) => chat.id));
        if (window === 0) {
          // An old conversation becomes active while the reader pages.
          vi.setSystemTime(Date.parse(AT) + 10_000_000);
          expect(store.knowledgeChats.beginTurn({ username: "alice", chatId: "kc_010", message: "再问", requestId: "request-again" }).ok).toBe(true);
        }
        if (!page.next) break;
        before = page.next;
      }
      const expected = Array.from({ length: 250 }, (_, i) => `kc_${String(249 - i).padStart(3, "0")}`);
      expect(seen).toEqual(expected.filter((id) => id !== "kc_010"));
      expect(store.knowledgeChats.list("alice").chats[0]!.id).toBe("kc_010");
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes list, history, and turn claims to the owning user", () => {
    const created = store.knowledgeChats.create({
      id: "kc_private",
      username: "alice",
      title: "私有会话",
      message: "只属于 Alice",
      requestId: "request-private",
    });
    store.knowledgeChats.finishTurn(created.chat.id);

    expect(store.knowledgeChats.list("alice").chats).toHaveLength(1);
    expect(store.knowledgeChats.list("bob")).toEqual({ chats: [], next: null });
    expect(store.knowledgeChats.get("bob", created.chat.id)).toBeUndefined();
    expect(store.knowledgeChats.messages("bob", created.chat.id)).toEqual([]);
    expect(store.knowledgeChats.beginTurn({
      username: "bob",
      chatId: created.chat.id,
      message: "越权",
      requestId: "request-cross-owner",
    })).toEqual({ ok: false, code: "not_found" });
  });

  it("deduplicates creation and sends while keeping one turn in flight", () => {
    const first = store.knowledgeChats.create({
      id: "kc_dedupe",
      username: "alice",
      title: "幂等会话",
      message: "第一条",
      requestId: "request-create",
    });
    const duplicate = store.knowledgeChats.create({
      id: "kc_unused",
      username: "alice",
      title: "不会写入",
      message: "不会写入",
      requestId: "request-create",
    });
    expect(duplicate).toMatchObject({ created: false, chat: { id: first.chat.id } });
    expect(store.knowledgeChats.getByCreateRequest("alice", "request-create")?.id).toBe(first.chat.id);
    expect(store.knowledgeChats.messages("alice", first.chat.id)).toHaveLength(1);

    expect(store.knowledgeChats.beginTurn({
      username: "alice",
      chatId: first.chat.id,
      message: "新消息",
      requestId: "request-send-one",
    })).toEqual({ ok: false, code: "busy" });
    store.knowledgeChats.finishTurn(first.chat.id);
    expect(store.knowledgeChats.beginTurn({
      username: "alice",
      chatId: first.chat.id,
      message: "新消息",
      requestId: "request-send-one",
    })).toMatchObject({ ok: true, duplicate: false });
    expect(store.knowledgeChats.beginTurn({
      username: "alice",
      chatId: first.chat.id,
      message: "同一次重试",
      requestId: "request-send-one",
    })).toMatchObject({ ok: true, duplicate: true });
    expect(store.knowledgeChats.getByTurnRequest("alice", first.chat.id, "request-send-one")?.id).toBe(first.chat.id);
    expect(store.knowledgeChats.getByTurnRequest("bob", first.chat.id, "request-send-one")).toBeUndefined();
    expect(store.knowledgeChats.messages("alice", first.chat.id).filter((row) => row.role === "user")).toHaveLength(2);
  });

  it("turns interrupted work into an inspectable error and clears liveness", () => {
    const created = store.knowledgeChats.create({
      id: "kc_interrupted",
      username: "alice",
      title: "中断会话",
      message: "开始",
      requestId: "request-interrupted",
    });

    expect(store.knowledgeChats.recoverInterruptedTurns()).toEqual([created.chat.id]);
    expect(store.knowledgeChats.get("alice", created.chat.id)?.running_since).toBeNull();
    expect(store.knowledgeChats.messages("alice", created.chat.id).at(-1)).toMatchObject({
      role: "error",
      content: expect.stringContaining("结果无法确认"),
    });
  });

  it("stores an answer longer than the old 8,000-character column bound whole", () => {
    const created = store.knowledgeChats.create({
      id: "kc_long", username: "alice", title: "长回答", message: "请详细解释", requestId: "request-long",
    });
    const answer = `${"甲".repeat(9_000)}尾`;
    store.knowledgeChats.append(created.chat.id, "assistant", answer);
    store.knowledgeChats.appendOnce(created.chat.id, "assistant", "turn-long:answer", `${answer}二`);

    const stored = store.knowledgeChats.messages("alice", created.chat.id).filter((row) => row.role === "assistant");
    expect(stored.map((row) => row.content)).toEqual([answer, `${answer}二`]);
    expect(stored[0]!.content).toHaveLength(9_001);
    expect(() => store.knowledgeChats.append(created.chat.id, "assistant", "")).toThrow();
  });

  it("replays every message and pages history newest-first without dropping the latest", () => {
    const created = store.knowledgeChats.create({
      id: "kc_many", username: "alice", title: "多轮", message: "m0", requestId: "request-many",
    });
    for (let index = 1; index < 450; index += 1) store.knowledgeChats.append(created.chat.id, "assistant", `m${index}`);

    const all = store.knowledgeChats.messages("alice", created.chat.id);
    expect(all).toHaveLength(450);
    expect(all.at(-1)?.content).toBe("m449");

    const newest = store.knowledgeChats.messagePage("alice", created.chat.id);
    expect(newest.messages).toHaveLength(KNOWLEDGE_CHAT_PAGE);
    expect(newest.messages[0]?.content).toBe("m50");
    expect(newest.messages.at(-1)?.content).toBe("m449");
    expect(newest.hasEarlier).toBe(true);

    const older = store.knowledgeChats.messagePage("alice", created.chat.id, { before: newest.messages[0]!.id });
    expect(older.messages.map((row) => row.content)).toEqual(Array.from({ length: 50 }, (_, index) => `m${index}`));
    expect(older.hasEarlier).toBe(false);
    expect(store.knowledgeChats.messagePage("bob", created.chat.id)).toEqual({ messages: [], hasEarlier: false });
  });
});
