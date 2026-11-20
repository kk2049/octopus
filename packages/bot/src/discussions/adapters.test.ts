import { describe, expect, it, vi } from 'vitest';
import { DiscussionModelClient } from './model.js';
import { discussionSettings } from './settings.js';
import type { Discussion, DiscussionMessage } from './types.js';

const sdk = vi.hoisted(() => ({ chat: vi.fn(), create: vi.fn(), patch: vi.fn(), list: vi.fn(), handlers: {} as Record<string, (event: unknown) => void>, start: vi.fn(), close: vi.fn(), http: vi.fn(() => ({ interceptors: { response: { use: vi.fn() } } })) }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 1 }, LoggerLevel: { warn: 1, fatal: 0 }, defaultHttpInstance: { create: sdk.http },
  Client: class { im = { chat: { create: sdk.chat }, message: { create: sdk.create, patch: sdk.patch, list: sdk.list } }; },
  EventDispatcher: class { register(handlers: typeof sdk.handlers) { sdk.handlers = handlers; } },
  WSClient: class { start = sdk.start; close = sdk.close; },
}));
import { FeishuDiscussionTransport } from './feishu.js';
import { LarkFeishuOAuthCommandTransport } from '../feishu/oauth-commands.js';

describe('discussion external adapters', () => {
  it('sends configured fast-filter model/effort with bounded context and rejects malformed decisions without retry', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ wake: false, reason: 'quiet' }) } }] })));
    const client = new DiscussionModelClient({ baseUrl: 'https://model.invalid/v1/', apiKey: 'test-key', fetchImpl });
    const room = { topic: 'research', agenda: 'decide experiment', settings: discussionSettings({ filter: { model: 'custom-fast', effort: 'minimal', prompt: 'Return JSON' } }) } as Discussion;
    const row = { sender: 'lilei', text: 'hello' } as DiscussionMessage;
    expect(await client.filter(room, row, Array.from({ length: 20 }, () => ({ ...row, text: 'a'.repeat(3000) })), new AbortController().signal)).toEqual({ wake: false, reason: 'quiet' });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://model.invalid/v1/chat/completions');
    const body = JSON.parse(String(call[1].body));
    expect(body).toMatchObject({ model: 'custom-fast', reasoning_effort: 'minimal', response_format: { type: 'json_object' } });
    expect(JSON.parse(body.messages[1].content).recent).toHaveLength(8);
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"wake":"false","reason":"bad"}' } }] })));
    await expect(client.filter(room, row, [], new AbortController().signal)).rejects.toThrow('筛选模型没有返回有效决定');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('uses one WebSocket and routes only group messages to meetings, preserving rich text and attachment placeholders', async () => {
    const group = vi.fn(), privateMessage = vi.fn();
    const transport = new LarkFeishuOAuthCommandTransport('app', 'secret', { receive: group, botOpenId: 'ou_bot' });
    await transport.start(privateMessage);
    const receive = (chatType: string, messageType: string, content: unknown) => sdk.handlers['im.message.receive_v1']!({ sender: { sender_id: { open_id: 'ou_lht' }, sender_type: 'user' }, message: { chat_id: 'oc_meeting', chat_type: chatType, message_type: messageType, message_id: 'om_id', content: JSON.stringify(content), mentions: [{ id: { open_id: 'ou_bot' } }] } });
    receive('p2p', 'text', { text: '/auth' });
    expect(privateMessage).toHaveBeenCalledWith(expect.objectContaining({ text: '/auth' })); expect(group).not.toHaveBeenCalled();
    receive('group', 'post', { title: '实验', content: [[{ tag: 'text', text: '下一步' }, { tag: 'at', user_name: '秘书' }]] });
    expect(group).toHaveBeenLastCalledWith(expect.objectContaining({ text: '实验\n下一步@秘书', mentionedBot: true, senderType: 'user' }));
    receive('group', 'image', { image_key: 'must-not-fetch' });
    expect(group).toHaveBeenLastCalledWith(expect.objectContaining({ text: '[飞书 image 消息；附件内容未解析]' }));
    receive('p2p', 'image', {}); expect(privateMessage).toHaveBeenCalledTimes(1);
    group.mockImplementationOnce(() => { throw new Error('refused'); });
    expect(() => receive('group', 'text', { text: 'hello' })).not.toThrow();
    transport.stop(); expect(sdk.close).toHaveBeenCalledWith({ force: true });
  });
  it('checks provider outcomes, keeps group ownership and card identity, and bounds fetched history', async () => {
    const transport = new FeishuDiscussionTransport('app', 'secret');
    expect(sdk.http).toHaveBeenLastCalledWith({ timeout: 15_000 });
    sdk.chat.mockResolvedValueOnce({ code: 0, data: { chat_id: 'oc_meeting' } });
    expect(await transport.create({ requestId: 'intent', topic: 'research', agenda: 'goal', ownerOpenId: 'ou_lht', members: [{ username: 'lht', openId: 'ou_lht' }, { username: 'lilei', openId: 'ou_lilei' }] })).toBe('oc_meeting');
    expect(sdk.chat).toHaveBeenLastCalledWith(expect.objectContaining({ params: { user_id_type: 'open_id', uuid: 'intent', set_bot_manager: true }, data: expect.objectContaining({ owner_id: 'ou_lht', user_id_list: ['ou_lht', 'ou_lilei'], chat_type: 'private' }) }));
    sdk.create.mockResolvedValueOnce({ code: 999 }); await expect(transport.send('oc_meeting', 'hi', 'out')).rejects.toThrow('999');
    sdk.create.mockResolvedValueOnce({ code: 0, data: { message_id: 'card' } });
    expect(await transport.card('oc_meeting', {}, 'intent', null)).toBe('card');
    sdk.patch.mockResolvedValueOnce({ code: 0 }); expect(await transport.card('oc_meeting', {}, 'intent', 'card')).toBe('card');
    expect(sdk.patch).toHaveBeenLastCalledWith({ path: { message_id: 'card' }, data: { content: '{}' } });
    sdk.list.mockResolvedValueOnce({ code: 0, data: { has_more: true, page_token: 'next', items: [{ body: { content: 'a'.repeat(3000) } }] } });
    expect(await transport.history('oc_meeting', 'cursor')).toMatchObject({ has_more: true, page_token: 'next', items: [{ body: 'a'.repeat(1000), truncated: true }] });
    expect(sdk.list).toHaveBeenCalledWith({ params: { container_id_type: 'chat', container_id: 'oc_meeting', page_size: 10, page_token: 'cursor', sort_type: 'ByCreateTimeDesc' } });
  });
});
