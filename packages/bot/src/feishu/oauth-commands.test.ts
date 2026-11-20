import { describe, expect, it, vi } from "vitest";
import type { User } from "../user/types.js";
import {
  FeishuOAuthCommands,
  inboundText,
  type FeishuOAuthCommandMessage,
  type FeishuOAuthCommandTransport,
} from "./oauth-commands.js";

class FakeTransport implements FeishuOAuthCommandTransport {
  handler: ((message: FeishuOAuthCommandMessage) => void) | null = null;
  sent: Array<{ chatId: string; text: string }> = [];
  async start(handler: (message: FeishuOAuthCommandMessage) => void): Promise<void> { this.handler = handler; }
  async send(chatId: string, text: string): Promise<void> { this.sent.push({ chatId, text }); }
  stop(): void {}
  receive(text: string, extra: Partial<FeishuOAuthCommandMessage> = {}): void {
    this.handler?.({ chatId: "chat", chatType: "p2p", messageId: `m-${this.sent.length}`, openId: "ou_alice", text, ...extra });
  }
}

const alice = { username: "alice" } as User;

describe("FeishuOAuthCommands", () => {
  it("starts device auth for an exact private /auth command and ignores chat text", async () => {
    const transport = new FakeTransport();
    const portal = {
      start: vi.fn(async () => ({
        state: "pending", verificationUri: "https://accounts.example/device?code=ABCD",
        userCode: "ABCD", expiresAt: "2026-09-01T08:00:00.000Z",
      })),
      status: vi.fn(() => ({ state: "disconnected" })),
      clear: vi.fn(),
    };
    const service = new FeishuOAuthCommands(transport, portal as never, {
      resolve: () => alice,
      getFeishuToken: () => undefined,
      saveFeishuToken: vi.fn(async () => undefined),
    }, vi.fn(), "https://bot.example/dashboard");
    await service.start();
    transport.receive("普通聊天");
    transport.receive("/auth");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(portal.start).toHaveBeenCalledWith("alice", true);
    expect(transport.sent[0].text).toContain("https://accounts.example/device?code=ABCD");

    transport.receive("/auth", { chatType: "group", messageId: "group" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(portal.start).toHaveBeenCalledTimes(1);
  });

  it("revokes stored OAuth and capability roots without accepting a claimed username", async () => {
    const transport = new FakeTransport();
    const saveFeishuToken = vi.fn(async () => undefined);
    const revoke = vi.fn();
    const portal = { start: vi.fn(), status: vi.fn(), clear: vi.fn() };
    await new FeishuOAuthCommands(transport, portal as never, {
      resolve: (_provider, openId) => openId === "ou_alice" ? alice : undefined,
      getFeishuToken: () => ({ access_token: "uat", refresh_token: "r", expires_at: 1, token_type: "Bearer" }),
      saveFeishuToken,
    }, revoke).start();
    transport.receive("/auth-revoke");
    await vi.waitFor(() => expect(saveFeishuToken).toHaveBeenCalled());
    expect(saveFeishuToken).toHaveBeenCalledWith("alice", expect.objectContaining({ access_token: "", refresh_token: "" }));
    expect(portal.clear).toHaveBeenCalledWith("alice");
    expect(revoke).toHaveBeenCalledWith("alice");
  });

  it("guides an unbound Feishu identity to the trusted dashboard", async () => {
    const transport = new FakeTransport();
    await new FeishuOAuthCommands(transport, {} as never, {
      resolve: () => undefined,
      getFeishuToken: () => undefined,
      saveFeishuToken: vi.fn(),
    }, vi.fn(), "https://bot.example/dashboard").start();
    transport.receive("help");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(transport.sent[0].text).toContain("https://bot.example/dashboard");
  });
});

describe("inbound message text", () => {
  it("passes a long text message and every line of a long post on whole; Feishu bounds them itself", () => {
    const long = "长消息".repeat(10_000);
    expect(inboundText("text", JSON.stringify({ text: ` ${long} ` }))).toBe(long);
    const lines = Array.from({ length: 300 }, (_, n) => [{ tag: "text", text: `第 ${n} 行` }, ...Array.from({ length: 250 }, () => ({ tag: "text", text: "·" }))]);
    const post = inboundText("post", JSON.stringify({ zh_cn: { title: "周报", content: lines } }));
    expect(post.split("\n")).toHaveLength(301);
    expect(post).toContain(`第 299 行${"·".repeat(250)}`);
    expect(inboundText("image", "{}")).toBe("[飞书 image 消息；附件内容未解析]");
    expect(inboundText("text", "{")).toBe("[飞书消息内容解析失败]");
  });
});
