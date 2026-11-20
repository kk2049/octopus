import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { FeishuDocsAddonAuth, type DocsAddonIdentity } from './docs-addon-auth.js';
import { cardMessage, cutAt, FeishuDocsAddonService } from './docs-addon.js';
import { resourceId, decodeResourceId } from '../sessionhub/core.js';
import { MIGRATIONS } from '../store/migrations.js';
import { FeishuDocsSharesRepository, FeishuDocsSpeakersRepository } from '../store/repositories/feishu-docs-shares.js';
import type { DocBlock, FeishuDocsClient } from './docs-openapi.js';
import type { DocsLauncher } from './docs-launch.js';
import type { DocsAddonExtras } from './docs-addon.js';

const origin = 'https://widget.feishu.cn';
const SELF = '11111111-2222-4333-8444-555555555555';
const FORK = '99999999-2222-4333-8444-555555555555';
const ALICE = resourceId({ owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: SELF });
const DOC = 'DocxToken1234567890abcdefg';
const REQUEST = '00000000-0000-4000-8000-000000000001';
const ANCHOR = 'bbbbbbbb-0000-4000-8000-000000000002';

let service: FeishuDocsAddonService;
let auth: FeishuDocsAddonAuth;
let db: Database.Database;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(() => { service?.close(); auth?.close(); db?.close(); vi.useRealTimers(); });

/** Two finished turns and a third still running, as the device's tail reports them. */
const tail = {
  total_messages: 5, offset: 0,
  messages: [
    { role: 'user', timestamp: '2026-10-19T05:00:00.000Z', blocks: [{ type: 'text', text: '列出 A0 的结论' }] },
    { role: 'assistant', timestamp: '2026-10-19T05:01:00.000Z', blocks: [{ type: 'text', text: 'A0 结论：三条' }] },
    { role: 'user', timestamp: '2026-10-19T05:02:00.000Z', blocks: [{ type: 'text', text: '把它放进文档做里程碑' }] },
    { role: 'assistant', timestamp: '2026-10-19T05:02:30.000Z', blocks: [{ type: 'tool', tool: 'mcp__octopus__feishu_doc_place' }] },
  ],
  meta: { activity: { state: 'tool', tool: 'Bash', observed_at: new Date().toISOString() } },
};

function setup(extra: Partial<DocsAddonExtras> = {}) {
  db = new Database(':memory:');
  for (const m of MIGRATIONS) db.exec(m.sql);
  const shares = new FeishuDocsSharesRepository(db);
  const speakers = new FeishuDocsSpeakersRepository(db);
  const people = new Map([['ou_alice', 'alice'], ['ou_bob', 'bob'], ['ou_carol', 'carol']]);
  let next = 'ou_alice';
  auth = new FeishuDocsAddonAuth({ tenantKey: 't', allowedOrigins: [origin], verifyCode: async () => ({ openId: next, tenantKey: 't' }) }, (id) => people.get(id), vi.fn());
  const grant = { call: vi.fn(async () => tail), close: vi.fn() };
  const hub = {
    decodeResourceId,
    roster: vi.fn(async () => ({ sessions: [{ resourceId: ALICE, sessionId: SELF, deviceId: 'laptop', cliKind: 'claude', title: '论文实验' }], permissions: { effective: [] } })),
    liveGrant: vi.fn(() => ({ ok: true as const, grant, local: false })),
  };
  const blocks: DocBlock[] = [];
  const docs = {
    resolve: vi.fn(async () => ({ documentId: DOC, title: '组会周报' })),
    blocks: vi.fn(async () => blocks),
    insertAddOn: vi.fn(async () => 'blk-new'),
  };
  const launcher = {
    anchor: vi.fn(async () => ({ anchor: ANCHOR, at: '2026-10-19T05:01:00.000Z' })),
    fork: vi.fn(async () => ({ sessionId: FORK, anchor: ANCHOR })),
  };
  const operations = { submit: vi.fn(async () => ({ ok: true, operation: { id: 'op-1', status: 'succeeded', message: 'Agent 已接收输入', live: false, submittedAt: 'x' } })), get: vi.fn() };
  const notifier = { notify: vi.fn() };
  service = new FeishuDocsAddonService(auth, hub as never, operations as never, shares, (u) => ({ alice: 'Alice', bob: 'Bob' } as Record<string, string>)[u] ?? u, Date.now, {
    docs: docs as unknown as FeishuDocsClient, componentTypeId: 'blk_widget', notifier: notifier as never, launcher: launcher as unknown as DocsLauncher, speakers,
    members: () => [{ username: 'alice', name: 'Alice' }, { username: 'bob', name: 'Bob' }, { username: 'carol', name: 'carol' }],
    ...extra,
  });
  const as = async (openId: string): Promise<DocsAddonIdentity> => { next = openId; return auth.authenticate((await auth.login(`code-${openId}-${Math.random()}`, origin)).token, origin); };
  /** A card in the document: the source a new card goes below. */
  const card = (share: string) => blocks.splice(0, blocks.length,
    { id: DOC, parent: '', children: ['p1', 'blk-card', 'p2'], text: '' },
    { id: 'p1', parent: DOC, children: [], text: '本周目标' },
    { id: 'blk-card', parent: DOC, children: [], text: '', type: 40, addOn: { component: 'blk_widget', record: JSON.stringify({ octopusAgent: { v: 2, share } }) } },
    { id: 'p2', parent: DOC, children: [], text: '下一节' });
  return { hub, grant, docs, launcher, operations, notifier, shares, speakers, as, card };
}

describe('snapshots', () => {
  it('freezes a card at its last finished turn into a card right below it, which then reads without the device', async () => {
    const { as, docs, launcher, grant, card, shares } = setup();
    const alice = await as('ou_alice');
    const { binding } = service.share(alice, { resourceId: ALICE, title: '论文实验' });
    card(binding.share);
    const placed = await service.snapshot(alice, binding.share, DOC);
    expect(launcher.anchor).toHaveBeenCalledWith('alice', 'laptop', 'claude', SELF);
    // Inserted as the next sibling of the source card, in the document the card named.
    const [, documentId, , record, slot] = docs.insertAddOn.mock.calls[0]! as unknown as [string, string, string, { octopusAgent: Record<string, unknown> }, unknown];
    expect([documentId, slot]).toEqual([DOC, { parent: DOC, index: 2 }]);
    expect(record.octopusAgent).toMatchObject({ v: 2, share: placed.binding.share, title: '论文实验', doc: DOC });
    const reads = grant.call.mock.calls.length;
    const frame = await service.view(alice, placed.binding.share, '', -1);
    // The running turn (the request for the snapshot) is not part of it.
    expect(frame).toMatchObject({ kind: 'snapshot', snapshotAt: '2026-10-19T05:01:00.000Z', canTalk: true, status: { working: false },
      origin: { kind: 'snapshot', from: '论文实验', by: 'Alice' }, messages: [{ text: '列出 A0 的结论' }, { text: 'A0 结论：三条' }] });
    expect('messages' in frame && frame.messages).toHaveLength(2);
    expect(grant.call.mock.calls.length).toBe(reads);
    // Stopping every live card of the session leaves the snapshot, a record of a past moment.
    service.unshare(alice, { resourceId: ALICE });
    expect(shares.get(service['capabilityId'](placed.binding.share))?.revokedAt).toBeNull();
    expect(shares.liveCounts('alice').get(ALICE)).toBeUndefined();
  });

  it('is placed by an agent for itself through feishu_doc_place, at the turn before the one asking', async () => {
    setup();
    const result = await service.place('alice', { document: DOC, snapshot: true }, { device: 'laptop', source: 'claude', sessionId: SELF });
    expect(result.card).toMatchObject({ snapshot_at: '2026-10-19T05:01:00.000Z' });
    const row = db.prepare("SELECT snapshot FROM feishu_docs_shares WHERE kind = 'snapshot'").get() as { snapshot: string };
    expect(JSON.parse(row.snapshot)).toMatchObject({ anchor: ANCHOR, rows: [{ text: '列出 A0 的结论' }, { text: 'A0 结论：三条' }] });
  });

  it('reaches back past a long running turn to the last finished one, cutting before the frame budget', async () => {
    const { as, grant, launcher, card } = setup();
    // 150 messages up to the finished turn, then an agent 150 messages (one window and more) into the next.
    const at = (i: number) => new Date(Date.parse('2026-10-19T05:00:00.000Z') + i * 1000).toISOString();
    const all = Array.from({ length: 300 }, (_, i) => i < 150
      ? { role: i % 2 ? 'assistant' : 'user', timestamp: at(i), blocks: [{ type: 'text', text: `第 ${i} 条` }] }
      : { role: 'assistant', timestamp: at(i), blocks: [{ type: 'text', text: 'x'.repeat(4000) }, { type: 'tool', tool: 'exec' }] });
    grant.call.mockImplementation((async (_method: string, args: { offset?: number; max_messages: number }) => {
      const offset = args.offset ?? Math.max(0, all.length - args.max_messages);
      return { total_messages: all.length, offset, messages: all.slice(offset, offset + args.max_messages) };
    }) as never);
    launcher.anchor.mockResolvedValue({ anchor: ANCHOR, at: at(149) });
    const alice = await as('ou_alice');
    const { binding } = service.share(alice, { resourceId: ALICE, title: '论文实验' });
    card(binding.share);
    const placed = await service.snapshot(alice, binding.share, DOC);
    const frame = await service.view(alice, placed.binding.share, '', -1);
    const rows = 'messages' in frame ? frame.messages : [];
    expect(rows).toHaveLength(90);
    expect([rows[0]!.i, rows.at(-1)!.i, rows.at(-1)!.text]).toEqual([60, 149, '第 149 条']);
    expect((grant.call.mock.calls as unknown as Array<[string, { offset?: number }]>).map(([, args]) => args.offset)).toEqual([undefined, 60]);
  });

  it('cuts rows at the anchor time, keeping all when no time is known', () => {
    const rows = [{ i: 0, role: 'user' as const, text: 'a', at: '2026-10-19T05:00:00Z' }, { i: 1, role: 'assistant' as const, text: 'b' }, { i: 2, role: 'assistant' as const, text: 'c', at: '2026-10-19T05:01:00Z' }, { i: 3, role: 'user' as const, text: 'd', at: '2026-10-19T05:02:00Z' }];
    expect(cutAt(rows, '2026-10-19T05:01:00.000Z').map((r) => r.text)).toEqual(['a', 'b', 'c']);
    expect(cutAt(rows).map((r) => r.text)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('read-only devices', () => {
  it('shows a session on a read-only device to everyone, its owner included, and lets nobody send, stop or fork it', async () => {
    const readOnly = vi.fn((owner: string, device: string) => owner === 'alice' && device === 'laptop');
    const { as, card, launcher, operations } = setup({ readOnly });
    const alice = await as('ou_alice');
    const { binding } = service.share(alice, { resourceId: ALICE, title: 'LUCY · 论文实验' });
    card(binding.share);
    const live = await service.view(alice, binding.share, '', -1);
    expect(live).toMatchObject({ kind: 'live', role: 'owner', canTalk: false, readOnly: true });
    expect(live.rev).toMatch(/\.r$/);
    const refused = { status: 409, message: '这个会话在只读设备上：可以查看，不能发消息、停止或分叉' };
    await expect(service.send(alice, binding.share, '补一组', REQUEST)).rejects.toMatchObject(refused);
    await expect(service.stop(alice, binding.share, REQUEST)).rejects.toMatchObject(refused);
    await expect(service.fork(alice, binding.share, '接着做', REQUEST, undefined)).rejects.toMatchObject(refused);
    // Reading is all a snapshot needs, so the owner can still keep one.
    const placed = await service.snapshot(alice, binding.share, DOC);
    expect(await service.view(alice, placed.binding.share, '', -1)).toMatchObject({ kind: 'snapshot', canTalk: false, readOnly: true });
    expect(operations.submit).not.toHaveBeenCalled();
    expect(launcher.fork).not.toHaveBeenCalled();
    // The device came back as a normal one: the owner talks again.
    readOnly.mockReturnValue(false);
    expect(await service.view(alice, binding.share, '', -1)).toMatchObject({ canTalk: true });
  });
});

describe('speakers', () => {
  it('lets a member the owner chose talk to the agent, as the owner\'s agent, with their name on the message', async () => {
    const { as, operations, notifier } = setup();
    const alice = await as('ou_alice');
    const { binding } = service.share(alice, { resourceId: ALICE, title: '论文实验' });
    const bob = await as('ou_bob');
    await expect(service.send(bob, binding.share, '补一组', REQUEST)).rejects.toMatchObject({ status: 403, message: '只有 Alice 和 Alice 授权的人可以和这个 Agent 对话' });
    expect(service.setSpeakers(alice, binding.share, ['bob']).members).toEqual([{ username: 'bob', name: 'Bob' }]);
    expect(() => service.setSpeakers(bob, binding.share, ['bob'])).toThrow(expect.objectContaining({ status: 403 }));
    const bobFrame = await service.view(bob, binding.share, '', -1);
    expect(bobFrame).toMatchObject({ role: 'viewer', canTalk: true });
    await service.send(bob, binding.share, '补一组 4-bit 的结果', REQUEST, { doc: DOC, title: '组会周报' });
    expect(operations.submit).toHaveBeenLastCalledWith('hub', expect.objectContaining({ username: 'alice', credential: bob.credential }), expect.objectContaining({
      owner: 'alice', sessionId: SELF, operation: 'append_session',
      prompt: cardMessage('补一组 4-bit 的结果', { doc: DOC, title: '组会周报' }, { name: 'Bob', owner: 'Alice' }),
    }), expect.anything());
    expect(cardMessage('x', undefined, { name: 'Bob', owner: 'Alice' })).toBe('【发言人：Bob，经 Alice 授权】\nx');
    expect(notifier.notify).toHaveBeenCalledWith('alice', expect.objectContaining({ kind: 'spoke', actor: 'Bob', session: '论文实验' }));
    // The speaker follows the operation they started.
    operations.get.mockImplementation((owner: string, id: string) => owner === 'alice' && id === 'op-1' ? { id, status: 'succeeded', message: 'ok', live: false, submittedAt: 'x', operation: 'append_session' } : null);
    expect(service.operation(bob, 'op-1')).toMatchObject({ status: 'succeeded' });
    const carol = await as('ou_carol');
    expect(() => service.operation(carol, 'op-1')).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('forks', () => {
  it('branches a snapshot at its moment into a speaker\'s own agent, in a card below, with their first message', async () => {
    const { as, card, launcher, docs, operations, notifier, speakers } = setup();
    const alice = await as('ou_alice');
    const { binding } = service.share(alice, { resourceId: ALICE, title: '论文实验' });
    card(binding.share);
    const snapshot = await service.snapshot(alice, binding.share, DOC);
    card(snapshot.binding.share);
    service.setSpeakers(alice, snapshot.binding.share, ['bob']);
    const bob = await as('ou_bob');
    const placed = await service.fork(bob, snapshot.binding.share, '换个思路改 A1', REQUEST, { doc: DOC, title: '组会周报' });
    expect(launcher.fork).toHaveBeenCalledWith('alice', 'laptop', 'claude', SELF, ANCHOR, '论文实验 · Bob的分叉');
    expect(placed.binding).toMatchObject({ title: '论文实验 · Bob的分叉', owner: 'Alice' });
    expect(placed.notice).toBeUndefined();
    expect((docs.insertAddOn.mock.calls.at(-1) as unknown[] | undefined)?.[4]).toEqual({ parent: DOC, index: 2 });
    const branch = resourceId({ owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: FORK });
    expect(speakers.has('alice', branch, 'bob')).toBe(true);
    expect(operations.submit).toHaveBeenLastCalledWith('hub', expect.objectContaining({ username: 'alice' }),
      expect.objectContaining({ sessionId: FORK, prompt: expect.stringMatching(/^【发言人：Bob，经 Alice 授权】\n换个思路改 A1/) }), expect.anything());
    expect(notifier.notify).toHaveBeenCalledWith('alice', expect.objectContaining({ kind: 'forked', actor: 'Bob', fork: '论文实验 · Bob的分叉', from: 'snapshot' }));
    expect(await service.view(bob, placed.binding.share, '', -1)).toMatchObject({ kind: 'live', canTalk: true, origin: { kind: 'fork', from: '论文实验', by: 'Bob' } });
    // The same request joins the first fork rather than branching twice.
    await service.fork(bob, snapshot.binding.share, '换个思路改 A1', REQUEST, { doc: DOC, title: '组会周报' });
    expect(launcher.fork).toHaveBeenCalledTimes(1);
    // A snapshot only forks.
    await expect(service.send(bob, snapshot.binding.share, '直接发', '00000000-0000-4000-8000-000000000002')).rejects.toMatchObject({ status: 409 });
  });

  it('forks a live card at its last finished turn, and still makes the branch when the document refuses the card', async () => {
    const { as, launcher, docs } = setup();
    const alice = await as('ou_alice');
    const { binding } = service.share(alice, { resourceId: ALICE, title: '论文实验' });
    docs.insertAddOn.mockRejectedValueOnce(Object.assign(new Error('你没有这篇文档的编辑权限'), { status: 403 }));
    const placed = await service.fork(alice, binding.share, '', REQUEST, { doc: DOC });
    expect(launcher.fork).toHaveBeenCalledWith('alice', 'laptop', 'claude', SELF, undefined, '论文实验 · Alice的分叉');
    expect(placed.notice).toContain('没能把新卡片放进文档');
    expect(placed.operation).toBeUndefined();
  });
});
