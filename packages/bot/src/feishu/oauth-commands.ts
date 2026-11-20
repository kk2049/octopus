/**
 * One Feishu WebSocket for private OAuth commands and registered topic groups.
 *
 * This deliberately is not a chat Router: it accepts only exact, private-chat
 * account commands, resolves the owner from the trusted Feishu identity
 * binding. Group events go only to the separately scoped discussion service;
 * ordinary private conversation never reaches an Agent.
 */

import * as lark from "@larksuiteoapi/node-sdk";
import type { UserManager } from "../user/types.js";
import type { FeishuOAuthPortal, FeishuOAuthPortalStatus } from "./oauth-portal.js";
import { createLogger } from "../logger.js";

const log = createLogger("feishu-oauth-commands");
const MAX_SEEN_MESSAGES = 512;

export interface FeishuOAuthCommandMessage {
  chatId: string;
  chatType: string;
  messageId: string;
  openId: string;
  text: string;
  senderType?: string;
  mentionedBot?: boolean;
  /** Stable identities, retained for independently configured event handlers. */
  mentions?: string[];
}

export interface FeishuOAuthCommandTransport {
  start(handler: (message: FeishuOAuthCommandMessage) => void): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  stop(): Promise<void> | void;
}

export class LarkFeishuOAuthCommandTransport implements FeishuOAuthCommandTransport {
  private readonly client: lark.Client;
  private ws: lark.WSClient | null = null;

  constructor(private appId: string, private appSecret: string, private readonly group?: { receive(message: FeishuOAuthCommandMessage): void; botOpenId?: string }) {
    this.client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild });
  }

  async start(handler: (message: FeishuOAuthCommandMessage) => void): Promise<void> {
    const dispatcher = new lark.EventDispatcher({});
    dispatcher.register({
      "im.message.receive_v1": (raw: Record<string, unknown>) => {
        const event = raw as {
          message?: { chat_id?: string; chat_type?: string; message_id?: string; message_type?: string; content?: string; mentions?: { id?: { open_id?: string } }[] };
          sender?: { sender_id?: { open_id?: string }; sender_type?: string };
        };
        const chatId = event.message?.chat_id ?? "";
        const openId = event.sender?.sender_id?.open_id ?? "";
        if (!chatId || !openId) return;
        const messageType = event.message?.message_type ?? 'unknown';
        if (event.message?.chat_type !== 'group' && messageType !== 'text') return;
        const text = inboundText(messageType, event.message?.content);
        const message: FeishuOAuthCommandMessage = {
          chatId,
          chatType: event.message?.chat_type ?? "",
          messageId: event.message?.message_id ?? "",
          openId,
          text,
          senderType: event.sender?.sender_type,
          mentions: event.message?.mentions?.map(mention => mention.id?.open_id).filter((id): id is string => Boolean(id)) ?? [],
          mentionedBot: Boolean(this.group?.botOpenId && event.message?.mentions?.some(mention => mention.id?.open_id === this.group!.botOpenId)),
        };
        try {
          if (message.chatType === 'group') this.group?.receive(message);
          else handler(message);
        } catch (error) { log.warn({ err: error }, 'Feishu inbound event refused'); }
      },
    });
    this.ws = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });
    await this.ws.start({ eventDispatcher: dispatcher });
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
  }

  stop(): void {
    this.ws?.close({ force: true });
    this.ws = null;
  }
}

/**
 * The readable text of one inbound message, whole. Feishu bounds what it
 * delivers — a text message's request body at 150 KB, a post's at 30 KB — so
 * nothing here cuts it; consumers decide what they do with a long message.
 */
export function inboundText(messageType: string, content: string | undefined): string {
  try {
    const parsed = JSON.parse(content ?? "") as Record<string, unknown>;
    if (messageType === 'text') return typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (messageType === 'post') return postText(parsed);
    return `[飞书 ${messageType} 消息；附件内容未解析]`;
  } catch {
    return '[飞书消息内容解析失败]';
  }
}

/** Text and links only; never fetch attachment URLs or interpret card actions. */
function postText(post: Record<string, unknown>): string {
  const body = Array.isArray(post.content) ? post : Object.values(post).find(value => value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).content)) as Record<string, unknown> | undefined;
  if (!body) return '[飞书富文本消息；无可读文本]';
  const rows = (body.content as unknown[]).map(row => Array.isArray(row) ? row.map(item => {
    if (!item || typeof item !== 'object') return '';
    const node = item as Record<string, unknown>;
    if (node.tag === 'text' || node.tag === 'a') return String(node.text ?? '');
    if (node.tag === 'at') return `@${String(node.user_name ?? node.user_id ?? '').slice(0, 128)}`;
    return '[附件未解析]';
  }).join('') : '').join('\n');
  return `${typeof body.title === 'string' ? body.title : ''}\n${rows}`.trim();
}

export class FeishuOAuthCommands {
  private readonly seen = new Set<string>();

  constructor(
    private readonly transport: FeishuOAuthCommandTransport,
    private readonly portal: FeishuOAuthPortal,
    private readonly users: Pick<UserManager, "resolve" | "getFeishuToken" | "saveFeishuToken">,
    private readonly revokeAuthority: (username: string) => void,
    private readonly dashboardUrl?: string,
  ) {}

  async start(): Promise<void> {
    await this.transport.start((message) => void this.handle(message));
  }

  async stop(): Promise<void> {
    await this.transport.stop();
  }

  private async handle(message: FeishuOAuthCommandMessage): Promise<void> {
    if (message.chatType !== "p2p") return;
    const command = message.text.trim().toLowerCase();
    if (!["/auth", "/auth-status", "/auth-revoke", "/help", "help"].includes(command)) return;
    if (message.messageId && this.seen.has(message.messageId)) return;
    if (message.messageId) {
      this.seen.add(message.messageId);
      if (this.seen.size > MAX_SEEN_MESSAGES) this.seen.delete(this.seen.values().next().value!);
    }
    const user = this.users.resolve("feishu", message.openId);
    if (!user) {
      await this.reply(message.chatId, `这个飞书账号尚未绑定 Octopus 用户。请先登录 ${this.dashboardUrl ?? "Octopus Dashboard"} 完成绑定。`);
      return;
    }
    try {
      if (command === "/auth") {
        await this.reply(message.chatId, describe(await this.portal.start(user.username, true)));
        return;
      }
      if (command === "/auth-status") {
        await this.reply(message.chatId, describe(this.portal.status(user.username)));
        return;
      }
      if (command === "/auth-revoke") {
        const current = this.users.getFeishuToken(user.username);
        await this.users.saveFeishuToken(user.username, {
          access_token: "",
          refresh_token: "",
          expires_at: 0,
          token_type: current?.token_type ?? "Bearer",
        });
        this.portal.clear(user.username);
        this.revokeAuthority(user.username);
        await this.reply(message.chatId, "已撤销你的飞书用户授权。之后的用户身份调用会拒绝，不会回退为 Bot 身份；发送 /auth 可重新连接。");
        return;
      }
      await this.reply(message.chatId, "飞书授权命令：/auth 重新授权 · /auth-status 查看状态 · /auth-revoke 撤销授权");
    } catch (error) {
      log.warn({ err: error, username: user.username, command }, "Feishu OAuth command failed");
      await this.reply(message.chatId, `飞书授权暂时无法处理：${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.transport.send(chatId, text);
    } catch (error) {
      log.warn({ err: error }, "Feishu OAuth command reply failed");
    }
  }
}

function describe(status: FeishuOAuthPortalStatus): string {
  if (status.state === "connected") return "飞书授权有效。发送 /auth 可主动更新授权。";
  if (status.state === "disconnected") return "飞书尚未授权。发送 /auth 开始连接。";
  if (status.state === "failed") return `飞书授权失败：${status.error}。请发送 /auth 重试。`;
  return `请打开下面的地址完成飞书授权：\n${status.verificationUri}\n验证码：${status.userCode}\n有效期至：${status.expiresAt}`;
}
