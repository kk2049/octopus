import * as lark from '@larksuiteoapi/node-sdk';
export interface ChatCreateInput { requestId: string; topic: string; agenda: string; ownerOpenId: string; members: readonly {openId: string; username?: string}[] }

/** Bot credentials never leave this trusted adapter; chat selection is service-bound. */
export class FeishuChatTransport {
  private readonly client: lark.Client;
  constructor(appId: string, appSecret: string) {
    // The SDK's shared Axios instance has no deadline. Keep a private instance
    // with no retries; sanitize transport failures before SDK logging can
    // include token request bodies or message contents.
    const http = lark.defaultHttpInstance.create({ timeout: 15_000 });
    http.interceptors.response.use(response => response.data, () => Promise.reject(new Error('飞书请求失败或超时，结果未确认')));
    this.client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild, httpInstance: http, loggerLevel: lark.LoggerLevel.fatal });
  }
  async create(input: ChatCreateInput): Promise<string> {
    const result = await this.client.im.chat.create({ params: { user_id_type: 'open_id', uuid: input.requestId, set_bot_manager: true }, data: { name: input.topic, description: input.agenda.slice(0, 4000), owner_id: input.ownerOpenId, chat_mode: 'group', chat_type: 'private', user_id_list: input.members.map(member => member.openId) } });
    if (result.code !== 0 || !result.data?.chat_id) throw new Error(`飞书建群失败 (${result.code ?? 'transport'})`);
    // The application creates and joins its own private group. No tenant/user
    // token fallback, arbitrary destination or participant OAuth is exposed.
    return result.data.chat_id;
  }
  async send(chatId: string, text: string, requestId: string): Promise<string> {
    const result = await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid: requestId } });
    if (result.code !== 0 || !result.data?.message_id) throw new Error(`飞书发送失败 (${result.code ?? 'transport'})`);
    return result.data.message_id;
  }
  async card(chatId: string, card: Record<string, unknown>, requestId: string, messageId: string | null): Promise<string> {
    if (messageId) {
      const result = await this.client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
      if (result.code !== 0) throw new Error(`飞书卡片更新失败 (${result.code ?? 'transport'})`);
      return messageId;
    }
    const result = await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid: requestId } });
    if (result.code !== 0 || !result.data?.message_id) throw new Error(`飞书卡片发送失败 (${result.code ?? 'transport'})`);
    return result.data.message_id;
  }
  async assertMember(chatId: string, openId: string): Promise<void> {
    if (!/^oc_[A-Za-z0-9]+$/.test(chatId) || !/^ou_[A-Za-z0-9]+$/.test(openId)) throw new Error('飞书群或成员身份无效');
    let token: string | undefined;
    do {
      const response = await this.client.im.chatMembers.get({path: {chat_id: chatId}, params: {member_id_type: 'open_id', page_size: 100, page_token: token}});
      if (response.code !== 0) throw new Error('无法确认群成员权限，请检查机器人是否已加入此群');
      if (response.data?.items?.some(member => member.member_id === openId)) return;
      token = response.data?.has_more ? response.data.page_token : undefined;
    } while (token);
    throw new Error('资源归属人不是此群成员');
  }
  async history(chatId: string, pageToken?: string, maxChars = 1000): Promise<unknown> {
    const result = await this.client.im.message.list({ params: { container_id_type: 'chat', container_id: chatId, page_size: 10, page_token: pageToken, sort_type: 'ByCreateTimeDesc' } });
    if (result.code !== 0) throw new Error(`飞书群历史读取失败 (${result.code ?? 'transport'})`);
    return { has_more: result.data?.has_more ?? false, page_token: result.data?.page_token, items: result.data?.items?.map(item => ({ message_id: item.message_id, sender: item.sender?.id, message_type: item.msg_type, body: item.body?.content?.slice(0, maxChars), truncated: (item.body?.content?.length ?? 0) > maxChars, create_time: item.create_time })) ?? [] };
  }
}
