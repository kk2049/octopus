import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../store/store.js';
import type { RunLoopRequest } from '../app-agents/loop.js';
import { DiscussionService } from './service.js';
import { discussionSettings } from './settings.js';
import type { DiscussionTransport } from './types.js';
import type { DiscussionModels } from './model.js';

const DONE = { kind: 'done' as const, text: '', toolCalls: 0 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture() {
  const store = new Store(':memory:');
  for (const [index, username] of ['lht', 'lilei', 'other'].entries()) {
    store.saveUser({ username, uid: index + 1, home_dir: `/x/${username}`, created_at: new Date().toISOString() });
    store.saveIdentity(username, { provider: 'feishu', externalId: `ou_${username}` });
  }
  const transport = { create: vi.fn<DiscussionTransport['create']>(async () => 'oc_meeting'), send: vi.fn(async () => 'om_sent'), card: vi.fn(async () => 'om_card'), history: vi.fn(async () => ({ items: [] })) };
  const models = { enabled: true, filter: vi.fn<DiscussionModels['filter']>(async () => ({ wake: false, reason: '无需介入' })), run: vi.fn(async (_req: RunLoopRequest) => DONE) };
  const service = new DiscussionService(store, transport, models);
  cleanups.push(async () => { await service.close(); store.close(); });
  const start = () => service.start('lht', { topic: 'Octopus 迭代', participants: 'lilei', request_id: 'wish-1' });
  const idle = () => vi.waitFor(() => expect(service.activeCount()).toBe(0));
  const receive = (messageId: string, text: string, rest = {}) => service.receive({ chatId: 'oc_meeting', openId: 'ou_lilei', messageId, text, senderType: 'user', ...rest });
  return { store, service, transport, models, start, idle, receive };
}

describe('persistent topic discussions', () => {
  it('never auto-replays a busy turn when a configuration call asks to run again', async () => {
    const f = fixture(); let complete!: () => void;
    const held = new Promise<void>(resolve => { complete = resolve; });
    f.models.run.mockImplementationOnce(async request => { await request.callTool('send_to_group', { text: '已发出的结论' }); await held; return DONE; });
    const room = await f.start();
    await vi.waitFor(() => expect(f.transport.send).toHaveBeenCalledOnce());
    expect(f.service.configure('lht', room.id, 1, undefined, 'active').status).toBe('paused');
    complete(); await f.idle();
    expect(f.models.run).toHaveBeenCalledOnce(); expect(f.transport.send).toHaveBeenCalledOnce();
    expect(f.service.read('lht', room.id).status).toBe('paused');
  });
  it('deduplicates convener control commands so a late duplicate resume cannot undo a newer pause', async () => {
    const f = fixture(); const room = await f.start(); await f.idle();
    f.receive('resume-old', '/meeting-resume', { openId: 'ou_lht' });
    f.receive('pause-new', '/meeting-pause', { openId: 'ou_lht' });
    f.receive('resume-old', '/meeting-resume', { openId: 'ou_lht' });
    expect(f.service.read('lht', room.id).status).toBe('paused');
    expect(f.service.read('lht', room.id).messages.filter(row => row.text === '/meeting-resume')).toHaveLength(1);
  });
  it('drains an in-flight group creation on shutdown without starting a model turn', async () => {
    const f = fixture(); let created!: (value: string) => void;
    f.transport.create.mockImplementationOnce(() => new Promise(resolve => { created = resolve; }));
    const start = f.start();
    let closed = false; const stopping = f.service.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    created('oc_meeting'); await stopping;
    const result = await start;
    expect(f.store.discussions.get(result.id)?.chatId).toBe('oc_meeting');
    expect(f.models.run).not.toHaveBeenCalled();
  });
  it('bounds the next model batch while retaining older quiet messages in paged history', async () => {
    const f = fixture(); const room = await f.start(); await f.idle();
    f.service.configure('lht', room.id, 1, undefined, 'paused');
    for (let index = 0; index < 20; index++) f.receive(`quiet-${index}`, 'x'.repeat(10000));
    f.service.append('lilei', room.id, '请综合讨论', 'wake');
    f.service.configure('lht', room.id, 2, undefined, 'active'); await f.idle();
    expect(f.models.run.mock.calls.slice(1).every(([request]) => String(request.messages[0]!.content).length < 90000)).toBe(true);
    expect(f.service.read('lilei', room.id, 0).messages.filter(row => row.text.length === 10000)).toHaveLength(20);
    expect(f.models.filter.mock.calls[10]![2]).toHaveLength(8);
    expect(f.models.run.mock.lastCall![0].messages[0]!.content).toContain('请综合讨论');
  });
  it('keeps a long group message whole instead of dropping it', async () => {
    const f = fixture(); const room = await f.start(); await f.idle();
    f.service.configure('lht', room.id, 1, undefined, 'paused');
    f.receive('long', '长'.repeat(40_000));
    expect(f.service.read('lilei', room.id, 0).messages.filter(row => row.text.length === 40_000)).toHaveLength(1);
  });
  it('creates exactly one private-group intent including convener and real participants; defaults remain configurable', async () => {
    const f = fixture(); const room = await f.start(); await f.idle();
    const replay = await f.start();
    expect(replay.id).toBe(room.id); expect(f.transport.create).toHaveBeenCalledTimes(1);
    expect(f.transport.create.mock.calls[0]?.[0]).toMatchObject({ members: [{ username: 'lht', openId: 'ou_lht' }, { username: 'lilei', openId: 'ou_lilei' }] });
    expect(room.settings.filter.model).toBe('gpt-5.6-sol'); expect(room.settings.secretary.model).toBe('gpt-6-astra');
    await expect(f.service.start('lht', { topic: 'different', participants: 'lilei', request_id: 'wish-1' })).rejects.toThrow('request_id');
    expect(f.service.configure('lht', room.id, 1, JSON.stringify({ secretary: { model: 'custom-model', effort: 'medium', prompt: '科研会议' } })).settings.secretary).toEqual({ model: 'custom-model', effort: 'medium', prompt: '科研会议' });
    expect(() => f.service.configure('lht', room.id, 1, '{}')).toThrow('已改变');
  });
  it('refuses missing identities and unauthorized conveners before any external action', async () => {
    const f = fixture();
    await expect(f.service.start('lilei', { topic: 'x', participants: 'lht', request_id: 'x' })).rejects.toThrow();
    await expect(f.service.start('lht', { topic: 'x', participants: 'missing', request_id: 'x' })).rejects.toThrow('未注册');
    f.store.saveUser({ username: 'unbound', uid: 9, home_dir: '/x', created_at: 'now' });
    await expect(f.service.start('lht', { topic: 'x', participants: 'unbound', request_id: 'x' })).rejects.toThrow('飞书账号绑定');
    expect(f.transport.create).not.toHaveBeenCalled();
  });
  it('keeps uncertain creation durable and never retries the external create', async () => {
    const f = fixture(); f.transport.create.mockRejectedValueOnce(new Error('timeout after create'));
    expect((await f.start()).status).toBe('unknown');
    expect((await f.start()).status).toBe('unknown');
    expect(f.transport.create).toHaveBeenCalledTimes(1); expect(f.models.run).not.toHaveBeenCalled();
  });
  it('saves quiet messages and deduplicates delivery; next wake includes them', async () => {
    const f = fixture(); const room = await f.start(); await f.idle();
    f.receive('m1', '先聊聊目标'); f.receive('m1', '先聊聊目标'); await f.idle();
    expect(f.models.filter).toHaveBeenCalledTimes(1); expect(f.models.run).toHaveBeenCalledTimes(1);
    f.receive('m2', '请秘书总结', { mentionedBot: true }); await f.idle();
    expect(f.models.run).toHaveBeenCalledTimes(2);
    expect(f.models.run.mock.calls[1]![0].messages[0]!.content).toContain('先聊聊目标');
    expect(f.service.read('lilei', room.id).messages.filter(row => row.text === '先聊聊目标')).toHaveLength(1);
  });
  it('isolates conversations and ignores bot echoes and uninvited identities', async () => {
    const f = fixture(); const room = await f.start(); await f.idle();
    f.receive('x', 'inject', { openId: 'ou_other' }); f.receive('y', 'echo', { senderType: 'app' }); f.receive('z', 'other room', { chatId: 'oc_other' });
    expect(f.models.filter).not.toHaveBeenCalled();
    expect(f.service.list('other')).toEqual([]);
    expect(() => f.service.read('other', room.id)).toThrow();
    expect(() => f.service.append('other', room.id, 'inject', 'x')).toThrow();
    expect(() => f.service.configure('lilei', room.id, 1, undefined, 'closed')).toThrow('召集人');
  });
  it('only explicit send tools publish; memory, history and consultant stay meeting scoped', async () => {
    const f = fixture();
    f.models.run.mockImplementation(async req => {
      if (!req.tools.length) return { ...DONE, text: '专题分析结果' };
      req.onAssistant?.('内部分析记录');
      expect(req.tools.map(tool => tool.name)).toEqual(['read_history', 'read_feishu_history', 'send_to_group', 'remember', 'consult']);
      expect(await req.callTool('send_to_group', { text: 'wrong destination', chat_id: 'oc_other' })).toMatchObject({ isError: true });
      expect(f.transport.send).not.toHaveBeenCalled();
      await req.callTool('read_feishu_history', {});
      await req.callTool('remember', { text: '决定 A，下一步验证 B' });
      expect((await req.callTool('consult', { task: '比较两个实验方案', model: 'gpt-5.6-sol', effort: 'low' })).text).toBe('专题分析结果');
      await req.callTool('send_to_group', { text: '大家好，先明确目标。' });
      return DONE;
    });
    const room = await f.start(); await f.idle();
    expect(f.transport.history).toHaveBeenCalledWith('oc_meeting', undefined);
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(f.transport.send.mock.calls[0]).toEqual(['oc_meeting', '大家好，先明确目标。', expect.any(String)]);
    expect(f.service.read('lht', room.id).memory).toContain('决定 A');
    expect(f.service.read('lilei', room.id).events.some(row => row.agent === 'consultant-1' && row.kind === 'completed')).toBe(true);
    f.models.run.mockResolvedValue(DONE);
    f.service.append('lilei', room.id, '继续', 'next'); await f.idle();
    expect(f.models.run.mock.lastCall![0].systemPrompt).toContain('决定 A');
  });
  it('queues new messages while a resident secretary is busy without parallel same-room turns', async () => {
    const f = fixture(); let complete!: () => void;
    const held = new Promise<void>(resolve => { complete = resolve; });
    f.models.run.mockImplementationOnce(async () => { await held; return DONE; });
    const room = await f.start();
    f.service.append('lilei', room.id, '新的补充一', 'a'); f.service.append('lht', room.id, '新的补充二', 'b');
    expect(f.models.run).toHaveBeenCalledTimes(1); complete(); await f.idle();
    expect(f.models.run).toHaveBeenCalledTimes(2);
    expect(f.models.run.mock.lastCall![0].messages[0]!.content).toContain('新的补充一');
    expect(f.models.run.mock.lastCall![0].messages[0]!.content).toContain('新的补充二');
  });
  it('pauses after an uncertain send and never replays that send on restart', async () => {
    const f = fixture(); f.transport.send.mockRejectedValueOnce(new Error('network lost'));
    f.models.run.mockImplementationOnce(async req => { const out = await req.callTool('send_to_group', { text: '结果' }); expect(out.closesTurn).toBe(true); return DONE; });
    const room = await f.start(); await f.idle();
    expect(f.service.read('lht', room.id).status).toBe('paused');
    expect(f.service.read('lht', room.id).uncertainDeliveries).toHaveLength(1);
    f.service.restore(); await f.idle(); expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
  it('pauses and resumes without dropping queued messages, and closed rooms do not wake', async () => {
    const f = fixture(); const room = await f.start(); await f.idle();
    f.service.configure('lht', room.id, 1, undefined, 'paused');
    f.receive('m', '需要再议'); expect(f.models.filter).not.toHaveBeenCalled();
    f.models.filter.mockResolvedValue({ wake: true, reason: '需要协助' });
    f.service.configure('lht', room.id, 2, undefined, 'active'); await f.idle();
    expect(f.models.run).toHaveBeenCalledTimes(2);
    f.service.configure('lht', room.id, 3, undefined, 'closed'); f.receive('closed', '请回复'); await f.idle();
    expect(f.models.run).toHaveBeenCalledTimes(2);
  });
  it('recovers interrupted turns as paused, preserving histories and unknown outbox state', async () => {
    const f = fixture(); const room = await f.start(); await f.idle();
    f.store.discussions.patch(room.id, { activity: 'thinking' });
    f.store.discussions.enqueue({ id: 'out', discussion_id: room.id, text: 'maybe sent', status: 'sending', message_id: null });
    f.service.restore();
    expect(f.service.read('lht', room.id)).toMatchObject({ status: 'paused', uncertainDeliveries: [{ id: 'out' }] });
    expect(f.models.run).toHaveBeenCalledTimes(1);
  });
  it('records invalid filter output without automatically launching a more expensive secretary', async () => {
    const f = fixture(); await f.start(); await f.idle();
    f.models.filter.mockRejectedValueOnce(new Error('bad JSON')); f.receive('m', '这件事怎么看？'); await f.idle();
    expect(f.models.run).toHaveBeenCalledTimes(1);
  });
  it('validates custom profiles and refuses invented capabilities in settings', () => {
    expect(() => discussionSettings({ tools: ['shell'] })).toThrow('未知');
    expect(() => discussionSettings({ secretary: { model: 'bad model' } })).toThrow('model');
    expect(() => discussionSettings({ filter: { effort: 'infinite' } })).toThrow('effort');
    expect(() => discussionSettings({ maxRepliesPerTurn: 100 })).toThrow();
    expect(discussionSettings().maxToolTurns).toBe(0); // no tool-loop ceiling by default (#21)
    expect(discussionSettings({ maxToolTurns: 40 }).maxToolTurns).toBe(40);
    expect(() => discussionSettings({ maxToolTurns: -1 })).toThrow('maxToolTurns');
  });
});
