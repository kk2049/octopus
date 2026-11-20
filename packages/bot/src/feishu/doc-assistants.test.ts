import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_OPERATION_PROTOCOL } from '@claude-bot/runner/gateway-protocol';
import { decodeResourceId } from '../sessionhub/core.js';
import { Store } from '../store/store.js';
import type { CardPayload } from './direct-card.js';
import { ASSISTANTS_PER_CARD, assistantInstruction, FeishuDocAssistants, guestName, type AssistantCaller } from './doc-assistants.js';
import { FeishuDocShareService } from './doc-share.js';
import { readDefaults } from './docs-launch.js';
import { DocsNotifier } from './docs-notify.js';
import { FeishuDocsClient } from './docs-openapi.js';
import { APP_TOKEN, FakeFeishuDocs, userToken } from './fake-feishu-docs.helper.js';

const DOC = 'DocxToken1234567890abcdefg';
const OTHER = 'OtherDocx1234567890abcdefg';
const WIDGET = 'blk_widget';
const WS = `ws_${'0'.repeat(24)}`;
const HOME = `ws_${'f'.repeat(24)}`;
const REQUEST = '00000000-0000-4000-8000-000000000000';
const request = (n: number) => REQUEST.replace(/0{4}$/, String(n).padStart(4, '0'));

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

const inventory = (patch: { execution?: Record<string, unknown>; [key: string]: unknown } = {}) => ({
  schema: 'runner-inventory/v1', session_operations: { protocol: SESSION_OPERATION_PROTOCOL },
  agent_backends: [{ kind: 'claude', available: true, split_execution: true }],
  ...patch,
  execution: { platform: 'linux', arch: 'x64', shell: true, workspace_files: true, workspace_count: 2, codex_exec_server: false, read_only_scope: true, ...patch.execution },
});

function setup() {
  const store = new Store(':memory:');
  for (const [i, username] of ['lht', 'bob'].entries()) store.saveUser({ username, uid: 5001 + i, home_dir: `/fixture/${username}`, created_at: '2026-10-30T00:00:00Z' });
  const feishu = new FakeFeishuDocs();
  feishu.addDoc(DOC, '论文初稿', ['引言', '方法']);
  feishu.grant(DOC, 'lht', 'edit');
  feishu.grant(DOC, 'app', 'edit');
  const clock = { now: 1_800_000_000_000 };
  const docs = new FeishuDocsClient(async (owner) => userToken(owner), feishu.fetch, async () => APP_TOKEN);
  let assistants!: FeishuDocAssistants;
  const shares = new FeishuDocShareService({ links: store.feishuDocShareLinks, tokens: store, docs, componentTypeId: WIDGET, publicUrl: 'https://octopus.example',
    notifyOwner: async () => {}, now: () => clock.now, onAssistantEnded: (shareId) => assistants.ended(shareId) });
  const devices = [
    { device: 'laptop', display_name: '实验室工作站', online: true, created_at: '', last_seen_at: null, inventory: inventory() },
    { device: 'old', online: true, created_at: '', last_seen_at: null, inventory: inventory({ execution: { read_only_scope: undefined } }) },
    { device: 'away', online: false, created_at: '', last_seen_at: null, inventory: inventory() },
    { device: 'codex-only', online: true, created_at: '', last_seen_at: null, inventory: inventory({ agent_backends: [{ kind: 'codex', available: true, split_execution: false }] }) },
  ];
  /** What the owner's device was asked, and how it answers: receipts by operation id. */
  const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const answers = new Map<string, Record<string, unknown>>();
  const grant = { request: vi.fn(async (operation: string, args: Record<string, unknown>) => {
    calls.push({ operation, args });
    const id = String(args.operation_id);
    return { status: 'succeeded' as const, result: { protocol: SESSION_OPERATION_PROTOCOL, operation_id: id, state: 'running', ...answers.get(id) } };
  }), destroy: vi.fn() };
  const caps = { listDevices: vi.fn((owner: string) => owner === 'lht' ? devices : []), open: vi.fn(() => grant) };
  const executions = {
    deviceWorkspaces: vi.fn(async () => ({ ok: true as const, workspaces: [{ workspace_id: HOME, label: 'Home', display: '~' }, { workspace_id: WS, label: 'ACC', display: '~/acc' }] })),
    releaseDocShare: vi.fn(),
  };
  const sent: Array<{ owner: string; card: CardPayload }> = [];
  const notifier = new DocsNotifier(async (owner, card) => { sent.push({ owner, card }); }, () => {}, () => clock.now);
  assistants = new FeishuDocAssistants({
    assistants: store.feishuDocAssistants, links: store.feishuDocShareLinks, docShares: shares, cards: store.feishuDocsShares,
    caps: caps as never, executions: executions as never, docs, componentTypeId: WIDGET,
    launchDefaults: () => readDefaults(JSON.stringify({ model: { claude: 'sonnet' }, effort: { claude: 'high' } })),
    displayName: (username) => username === 'lht' ? '林老师' : username,
    notify: (owner, notice) => notifier.notify(owner, notice), transaction: (work) => store.withinTransaction(work), now: () => clock.now,
  });
  closers.push(() => store.close());
  /** The owner's control card in the document, and the capability its Record holds. */
  const card = async () => {
    await shares.create('lht', { document: DOC, label: '张老师' });
    return (feishu.records(DOC)[0].record as { octopusShare: { anchor: string } }).octopusShare.anchor;
  };
  const owner: AssistantCaller = { openId: 'ou_owner', username: 'lht' };
  const guest = (n = 1): AssistantCaller & { name: string } => ({ openId: `ou_guest${n}`, username: null, name: `王同学${n}` });
  const starts = () => calls.filter((call) => call.operation === 'start_session');
  /** What the dispatch preparer does when a receipt names the session. */
  const started = (id: string, session = `session-${id.slice(-6)}`) => { store.feishuDocAssistants.attach(id, 'lht', session); return session; };
  return { store, feishu, shares, assistants, clock, calls, answers, caps, executions, sent, card, owner, guest, starts, started, devices };
}

describe('the owner sets a card up', () => {
  it('offers the projects of devices that can host an assistant, never the Home workspace, and says why a device cannot', async () => {
    const h = setup();
    expect(await h.assistants.targets('lht')).toEqual([
      { device: 'laptop', label: '实验室工作站', eligible: true, workspaces: [{ workspace_id: WS, label: 'ACC' }] },
      { device: 'old', label: 'old', eligible: false, reason: expect.stringContaining('Runner 需要升级'), workspaces: [] },
      { device: 'away', label: 'away', eligible: false, reason: expect.stringContaining('不在线'), workspaces: [] },
      { device: 'codex-only', label: 'codex-only', eligible: false, reason: expect.stringContaining('没有可用的 Claude Code'), workspaces: [] },
    ]);
    expect(h.executions.deviceWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('is the owner\'s alone, refuses Home and devices that cannot host it, and turning it off ends every live assistant', async () => {
    const h = setup();
    const capability = await h.card();
    await expect(h.assistants.configure('bob', capability, { rights: 'write', device: 'laptop', workspaceId: WS })).rejects.toMatchObject({ status: 403 });
    await expect(h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: HOME })).rejects.toMatchObject({ status: 422 });
    await expect(h.assistants.configure('lht', capability, { rights: 'write', device: 'old', workspaceId: WS })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('升级') });
    await expect(h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: `ws_${'1'.repeat(24)}` })).rejects.toMatchObject({ status: 404 });
    expect(await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS }))
      .toEqual({ rights: 'write', project: { device: 'laptop', workspace_id: WS, label: 'ACC' }, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } });
    const a = await h.assistants.start(h.guest(1), capability, DOC, '检查第二节的推导', request(1));
    const b = await h.assistants.start(h.guest(2), capability, DOC, '润色引言', request(2));
    h.started(b.id);
    // Narrowing to read ends the assistants that could write.
    await h.assistants.configure('lht', capability, { rights: 'read', device: 'laptop', workspaceId: WS });
    expect(h.store.feishuDocAssistants.get(a.id)).toMatchObject({ live: false });
    const c = await h.assistants.start(h.guest(3), capability, DOC, '只读看看', request(3));
    expect(h.store.feishuDocAssistants.get(c.id)).toMatchObject({ live: true, rights: 'read' });
    // The kill switch: every live one ends, its scope goes, a running one is asked to stop; the project stays.
    expect(await h.assistants.configure('lht', capability, { rights: null })).toMatchObject({ rights: null, project: { workspace_id: WS } });
    expect(h.store.feishuDocAssistants.ofAnchor(h.store.feishuDocAssistants.get(c.id)!.anchorId).every((row) => !row.live && row.endedAt !== null)).toBe(true);
    expect(h.executions.releaseDocShare).toHaveBeenCalledWith(h.store.feishuDocAssistants.get(c.id)!.shareId);
    await vi.waitFor(() => expect(h.calls.some((call) => call.operation === 'append_session' && call.args.interrupt === true && call.args.id === `session-${b.id.slice(-6)}`)).toBe(true));
    await expect(h.assistants.start(h.guest(4), capability, DOC, '再来一个', request(4))).rejects.toMatchObject({ status: 409, message: expect.stringContaining('没有开启') });
  });
});

describe('a guest starts one', () => {
  it('launches on the project\'s device as the owner, with one paragraph saying whom it works for and exactly what it has', async () => {
    const h = setup();
    const capability = await h.card();
    await expect(h.assistants.start(h.guest(), capability, DOC, '看看', request(1))).rejects.toMatchObject({ status: 409 });
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    // A copy of the card in another document starts nothing.
    await expect(h.assistants.start(h.guest(), capability, OTHER, '看看', request(1))).rejects.toMatchObject({ status: 403, message: expect.stringContaining('复制') });
    const { id } = await h.assistants.start(h.guest(), capability, DOC, '  检查第二节的推导  ', request(1));
    expect(id).toMatch(/^op_fda_[0-9a-f]{40}$/);
    expect(h.caps.open).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'lht', device: 'laptop', rights: ['start_session'], autoAllow: ['start_session'] }));
    const [start] = h.starts();
    expect(start.args).toEqual({ device: 'laptop', execution_device: 'laptop', workspace_id: WS, source: 'claude', permission_profile: 'full_access',
      model: 'sonnet', effort: 'high', client_request_id: id, operation_id: id, input_receipt: true, prompt: expect.any(String) });
    expect(start.args.prompt).toBe(assistantInstruction({ guest: '王同学1', owner: '林老师', doc: { title: '论文初稿', id: DOC }, project: 'ACC', rights: 'write', task: '检查第二节的推导' }));
    expect(String(start.args.prompt)).toMatch(/^【文档助手】你是 王同学1 在飞书文档《论文初稿》（document_id：DocxToken1234567890abcdefg）里启动的文档助手.*list_session_workspaces、list_workspace_entries、read_workspace_text.*feishu_shared_doc_remove.*\n\n检查第二节的推导$/s);
    // Its own share of the document: active at once, via 'assistant', with the rights the owner set; the token's plaintext is nowhere.
    const row = h.store.feishuDocAssistants.get(id)!;
    expect(h.store.feishuDocShareLinks.share(row.shareId)).toMatchObject({ via: 'assistant', status: 'active', rights: 'write', tokenLive: true });
    expect(row).toMatchObject({ owner: 'lht', guestOpenId: 'ou_guest1', guestName: '王同学1', device: 'laptop', workspaceId: WS, sessionId: null, live: true });
    // The same request joins it.
    expect(await h.assistants.start(h.guest(), capability, DOC, '检查第二节的推导', request(1))).toEqual({ id });
    expect(h.starts()).toHaveLength(1);
  });

  it('caps live assistants per guest and per card, and starts per guest per day, in Chinese 429s', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'read', device: 'laptop', workspaceId: WS });
    const mine = [];
    for (let n = 1; n <= 3; n++) mine.push((await h.assistants.start(h.guest(1), capability, DOC, `任务 ${n}`, request(n))).id);
    await expect(h.assistants.start(h.guest(1), capability, DOC, '第四个', request(4))).rejects.toMatchObject({ status: 429, message: expect.stringContaining('同时最多运行 3 个') });
    // Ending one frees a place; 24 hours bound the starts however many end.
    for (let n = 4; n <= 10; n++) {
      h.assistants.end(h.guest(1), mine.shift()!);
      mine.push((await h.assistants.start(h.guest(1), capability, DOC, `任务 ${n}`, request(n))).id);
    }
    h.assistants.end(h.guest(1), mine.shift()!);
    await expect(h.assistants.start(h.guest(1), capability, DOC, '第十一个', request(11))).rejects.toMatchObject({ status: 429, message: expect.stringContaining('24 小时内最多启动 10 个') });
    h.clock.now += 24 * 60 * 60_000;
    await h.assistants.start(h.guest(1), capability, DOC, '新的一天', request(12));
    // Per card: twenty live at once, whoever started them.
    for (let n = 2; h.store.feishuDocAssistants.liveCount(h.store.feishuDocAssistants.get(mine[0])!.anchorId) < ASSISTANTS_PER_CARD; n++) {
      await h.assistants.start(h.guest(n), capability, DOC, '占一个位置', request(100 + n));
    }
    await expect(h.assistants.start(h.guest(99), capability, DOC, '满了', request(999))).rejects.toMatchObject({ status: 429, message: expect.stringContaining('20 个') });
  });

  it('tells the owner once per guest per card in ten minutes, and always when one is pinned', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const first = await h.assistants.start(h.guest(1), capability, DOC, '一', request(1));
    await h.assistants.start(h.guest(1), capability, DOC, '二', request(2));
    await h.assistants.start(h.guest(2), capability, DOC, '三', request(3));
    const titles = () => h.sent.map((each) => { const title = each.card.header?.title; return typeof title === 'string' ? title : title?.content; });
    expect(titles()).toEqual(['有人启动了文档助手', '有人启动了文档助手']);
    expect(JSON.stringify(h.sent[0].card)).toContain('王同学1');
    h.clock.now += 10 * 60_000 + 1;
    await h.assistants.start(h.guest(1), capability, DOC, '四', request(4));
    expect(titles()).toHaveLength(3);
    h.started(first.id);
    await h.assistants.pin(h.guest(1), first.id);
    expect(titles().at(-1)).toBe('文档助手被固定进了文档');
  });
});

describe('following, ending and pinning one', () => {
  it('starts, turns ready once its session is known with a card for the conversation, and fails telling the device\'s reason to the owner only', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const { id } = await h.assistants.start(h.guest(1), capability, DOC, '检查推导', request(1));
    expect(await h.assistants.status(h.guest(1), id)).toMatchObject({ state: 'starting', mine: true, guest: '王同学1' });
    expect(h.calls.at(-1)).toMatchObject({ operation: 'get_session_operation', args: { device: 'laptop', operation_id: id } });
    const session = h.started(id);
    const ready = await h.assistants.status(h.guest(1), id);
    expect(ready).toMatchObject({ state: 'ready', binding: { title: expect.stringContaining('王同学1的文档助手'), owner: '林老师', device: 'laptop', provider: 'claude' } });
    expect(ready.binding!.share).toMatch(/^ds_[A-Za-z0-9_-]{43}$/);
    // The card shows exactly this session, as the owner's.
    const card = h.store.feishuDocsShares.get(createHash('sha256').update(ready.binding!.share).digest('hex'))!;
    expect(decodeResourceId(card.resource)).toMatchObject({ owner: 'lht', device: 'laptop', cliKind: 'claude', sessionId: session });
    expect((await h.assistants.status(h.owner, id)).binding!.share).toBe(ready.binding!.share);
    await expect(h.assistants.status(h.guest(2), id)).rejects.toMatchObject({ status: 404 });

    const failing = await h.assistants.start(h.guest(2), capability, DOC, '会失败', request(2));
    h.answers.set(failing.id, { state: 'failed', result: { ok: false, error: 'claude 未登录' } });
    expect(await h.assistants.status(h.guest(2), failing.id)).toMatchObject({ state: 'failed', message: '设备暂时无法启动助手，请稍后再试' });
    expect(await h.assistants.status(h.owner, failing.id)).toMatchObject({ state: 'failed', message: 'claude 未登录' });
    expect(h.store.feishuDocShareLinks.share(h.store.feishuDocAssistants.get(failing.id)!.shareId)!.status).toBe('terminated');
    // A launch the device never heard of fails after a while, so its place frees.
    const lost = await h.assistants.start(h.guest(3), capability, DOC, '丢了', request(3));
    h.answers.set(lost.id, { state: 'missing' });
    expect((await h.assistants.status(h.guest(3), lost.id)).state).toBe('starting');
    h.clock.now += 5 * 60_000 + 1;
    expect((await h.assistants.status(h.guest(3), lost.id)).state).toBe('failed');
  });

  it('is listed to its guest, every one to the owner, and ended by its guest or the owner only', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const a = await h.assistants.start(h.guest(1), capability, DOC, '一', request(1));
    h.clock.now += 1_000;
    const b = await h.assistants.start(h.guest(2), capability, DOC, '二', request(2));
    expect(h.assistants.list(h.guest(1), capability).map((row) => [row.id, row.mine])).toEqual([[a.id, true]]);
    expect(h.assistants.list(h.owner, capability).map((row) => row.id)).toEqual([b.id, a.id]);
    expect(() => h.assistants.end(h.guest(2), a.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(h.assistants.end(h.guest(1), a.id)).toMatchObject({ state: 'ended' });
    h.started(b.id);
    expect(h.assistants.end(h.owner, b.id)).toMatchObject({ state: 'ended' });
    expect(h.store.feishuDocShareLinks.share(h.store.feishuDocAssistants.get(b.id)!.shareId)!.status).toBe('terminated');
  });

  it('is pinned by its guest only, as the app, right after the control card; without the app\'s edit access it says how to add it', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const { id } = await h.assistants.start(h.guest(1), capability, DOC, '检查推导', request(1));
    await expect(h.assistants.pin(h.guest(1), id)).rejects.toMatchObject({ status: 409 });
    h.started(id);
    await expect(h.assistants.pin({ openId: 'ou_owner' }, id)).rejects.toMatchObject({ status: 404 });
    const after = h.feishu.append(DOC, { block_type: 2, text: { elements: [{ text_run: { content: '卡片后面的段落' } }] } });
    h.feishu.grant(DOC, 'app', 'read');
    await expect(h.assistants.pin(h.guest(1), id)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('添加文档应用') });
    expect(h.store.feishuDocAssistants.get(id)!.pinnedAt).toBeNull();
    h.feishu.grant(DOC, 'app', 'edit');
    const before = h.feishu.requests.length;
    const { block } = await h.assistants.pin(h.guest(1), id);
    expect(h.feishu.requests.slice(before).filter((each) => each.method === 'POST').map((each) => each.as)).toEqual(['app']);
    const body = h.feishu.blocksOf(DOC)[0].children!;
    const control = h.feishu.records(DOC).find((record) => (record.record as Record<string, unknown>).octopusShare)!.id;
    expect(body.indexOf(block)).toBe(body.indexOf(control) + 1);
    expect(body.indexOf(after)).toBe(body.indexOf(block) + 1);
    const pinned = h.feishu.records(DOC).find((record) => record.id === block)!.record as { octopusAgent: Record<string, unknown> };
    expect(pinned.octopusAgent).toMatchObject({ v: 2, share: (await h.assistants.status(h.guest(1), id)).binding!.share, doc: DOC, provider: 'claude' });
    expect(h.store.feishuDocAssistants.get(id)!.pinnedAt).toBe(h.clock.now);
    await expect(h.assistants.pin(h.guest(1), id)).rejects.toMatchObject({ status: 409 });
  });

  it('is not one of the card\'s keys: the keys table, the key limits and a reader\'s terminate leave it alone; the owner may still end it there', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const { id } = await h.assistants.start(h.guest(1), capability, DOC, '检查推导', request(1));
    const shareId = h.store.feishuDocAssistants.get(id)!.shareId;
    const anchorId = h.store.feishuDocAssistants.get(id)!.anchorId;
    const reader = { openId: 'ou_reader', username: null };
    const taken = await h.shares.selfServe({ capability, hostToken: DOC, label: '读者的密钥', rights: 'read', viewer: reader });
    // The keys table lists the owner's pending share and the reader's key; the assistant has its own list.
    const panel = await h.shares.panel(reader, capability, DOC);
    expect(panel.shares).toHaveLength(2);
    expect(panel.shares.map((share) => share.id)).toContain(taken.share.id);
    expect(panel.shares.map((share) => share.id)).not.toContain(shareId);
    expect(h.store.feishuDocShareLinks.liveShareCount(anchorId)).toBe(2);
    expect(h.store.feishuDocShareLinks.selfServedSince(anchorId, 0)).toBe(1);
    // A reader may end any key the card lists, but not an assistant's share.
    await expect(h.shares.act(reader, capability, shareId, 'terminate', DOC)).rejects.toMatchObject({ status: 403 });
    expect(h.store.feishuDocAssistants.get(id)).toMatchObject({ live: true, endedAt: null });
    await h.shares.act(reader, capability, taken.share.id, 'terminate', DOC);
    // The card's owner may, and the assistant ends with its share.
    await h.shares.act({ openId: 'ou_owner', username: 'lht' }, capability, shareId, 'terminate');
    expect(h.store.feishuDocAssistants.get(id)).toMatchObject({ live: false, endedAt: expect.any(Number) });
  });

  it('labels a guest by a printable name of at most 40 characters', () => {
    expect(guestName('  王\n同学\u0000‮ ')).toBe('王 同学');
    expect([...guestName('名'.repeat(80))]).toHaveLength(40);
    expect(guestName(undefined)).toBe('飞书用户');
  });
});

describe('what the owner set holds at every use', () => {
  it('ends every assistant of the card when the owner turns them off or narrows them, however many there are', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const anchor = h.store.feishuDocShareLinks.liveAnchor('lht', DOC)!;
    // More rows than any list answers (200), straight in the store; the oldest come first.
    const many = (rights: 'read' | 'write', from: number) => Array.from({ length: 205 }, (_, n) => {
      const id = `op_fda_${String(from + n).padStart(40, '0')}`;
      const shareId = h.shares.openAssistantShare(anchor, `读者${n}的文档助手`, rights);
      h.store.feishuDocAssistants.create({ id, owner: 'lht', anchorId: anchor.id, shareId, guestOpenId: `ou_many${from + n}`, guestName: `读者${n}`,
        title: '旧的', device: 'laptop', workspaceId: WS, createdAt: h.clock.now - 1_000_000 + from + n });
      return id;
    });
    const unended = (ids: string[]) => ids.filter((id) => h.store.feishuDocAssistants.get(id)!.endedAt === null);
    const writers = many('write', 1);
    await h.assistants.configure('lht', capability, { rights: 'read', device: 'laptop', workspaceId: WS });
    expect(unended(writers)).toEqual([]);
    const readers = many('read', 1001);
    await h.assistants.configure('lht', capability, { rights: null });
    expect(unended(readers)).toEqual([]);
  });

  it('is usable only while the card\'s settings admit it, even when nothing ended it', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const { id } = await h.assistants.start(h.guest(1), capability, DOC, '检查推导', request(1));
    h.started(id);
    const anchorId = h.store.feishuDocAssistants.get(id)!.anchorId;
    const usable = () => h.store.feishuDocAssistants.get(id)!.usable;
    expect(usable()).toBe(true);
    // Straight in the store, as if no end had reached it: off, narrowed below its rights, moved to another project.
    for (const [rights, workspaceId] of [[null, WS], ['read', WS], ['write', HOME]] as const) {
      h.store.feishuDocAssistants.configure(anchorId, rights, { device: 'laptop', workspaceId, label: 'x' });
      expect(usable(), `${rights} ${workspaceId}`).toBe(false);
      expect(await h.assistants.status(h.guest(1), id), `${rights} ${workspaceId}`).not.toHaveProperty('binding');
    }
    h.store.feishuDocAssistants.configure(anchorId, 'write', { device: 'laptop', workspaceId: WS, label: 'ACC' });
    expect(usable()).toBe(true);
  });

  it('takes back every card over its conversation when it ends, however it ends, and mints no new one', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const cardOf = (share: string) => h.store.feishuDocsShares.get(createHash('sha256').update(share).digest('hex'))!;
    const ready = async (n: number) => {
      const { id } = await h.assistants.start(h.guest(n), capability, DOC, `任务${n}`, request(n));
      h.started(id);
      return { id, share: (await h.assistants.status(h.guest(n), id)).binding!.share };
    };
    // Its guest ends one, the owner one, terminating its share one, and the owner's switch the last.
    const byGuest = await ready(1);
    h.assistants.end(h.guest(1), byGuest.id);
    const byOwner = await ready(2);
    h.assistants.end(h.owner, byOwner.id);
    const byTerminate = await ready(3);
    h.shares.update('lht', h.store.feishuDocAssistants.get(byTerminate.id)!.shareId, 'terminate');
    const bySwitch = await ready(4);
    await h.assistants.configure('lht', capability, { rights: null });
    for (const [n, { id, share }] of [byGuest, byOwner, byTerminate, bySwitch].entries()) {
      expect(cardOf(share).revokedAt, id).not.toBeNull();
      expect(await h.assistants.status(h.guest(n + 1), id), id).not.toHaveProperty('binding');
    }
  });

  it('pins only an assistant that may still be used and may write the document', async () => {
    const h = setup();
    const capability = await h.card();
    const blocks = () => h.feishu.records(DOC).length;
    await h.assistants.configure('lht', capability, { rights: 'read', device: 'laptop', workspaceId: WS });
    const reader = await h.assistants.start(h.guest(1), capability, DOC, '只读', request(1));
    h.started(reader.id);
    const before = blocks();
    // Pinning writes the document: an assistant that may only read it does not.
    await expect(h.assistants.pin(h.guest(1), reader.id)).rejects.toMatchObject({ status: 403 });
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const writer = await h.assistants.start(h.guest(2), capability, DOC, '可写', request(2));
    h.started(writer.id);
    // Off in the store, as if no end had reached it; then ended.
    const anchorId = h.store.feishuDocAssistants.get(writer.id)!.anchorId;
    h.store.feishuDocAssistants.configure(anchorId, null);
    await expect(h.assistants.pin(h.guest(2), writer.id)).rejects.toMatchObject({ status: 409 });
    h.store.feishuDocAssistants.configure(anchorId, 'write');
    h.assistants.end(h.guest(2), writer.id);
    await expect(h.assistants.pin(h.guest(2), writer.id)).rejects.toMatchObject({ status: 409 });
    expect(blocks()).toBe(before);
    expect(h.store.feishuDocAssistants.get(writer.id)!.pinnedAt).toBeNull();
  });

  it('shows everyone but its guest the guest\'s name with the end of their verified open_id', async () => {
    const h = setup();
    const capability = await h.card();
    await h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: WS });
    const { id } = await h.assistants.start(h.guest(1), capability, DOC, '检查推导', request(1));
    expect(h.assistants.list(h.guest(1), capability)).toEqual([expect.objectContaining({ id, guest: '王同学1', mine: true })]);
    expect(h.assistants.list(h.owner, capability)).toEqual([expect.objectContaining({ id, guest: '王同学1（…guest1）', mine: false })]);
    await vi.waitFor(() => expect(JSON.stringify(h.sent.map((each) => each.card))).toContain('王同学1（…guest1）'));
  });

  it('never offers or takes a whole home directory or a system root as the project', async () => {
    const h = setup();
    const roots = ['/', '/home', '/Users', '/root', '/home/'].map((display, n) => ({ workspace_id: `ws_${String(n + 1).repeat(24)}`, label: display, display }));
    h.executions.deviceWorkspaces.mockResolvedValue({ ok: true, workspaces: [...roots, { workspace_id: WS, label: 'ACC', display: '~/acc' }] });
    expect((await h.assistants.targets('lht'))[0]).toEqual({ device: 'laptop', label: '实验室工作站', eligible: true, workspaces: [{ workspace_id: WS, label: 'ACC' }] });
    const capability = await h.card();
    for (const root of roots) {
      await expect(h.assistants.configure('lht', capability, { rights: 'write', device: 'laptop', workspaceId: root.workspace_id }), root.display)
        .rejects.toMatchObject({ status: 422 });
    }
  });
});
