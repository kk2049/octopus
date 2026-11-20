import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DocsAddonError, FeishuDocsAddonAuth, type DocsAddonIdentity } from './docs-addon-auth.js';
import { FeishuDocsAddonService, firstInstruction, statusOf, type DocsAddonExtras } from './docs-addon.js';
import { FeishuDocsBoardsRepository } from '../store/repositories/feishu-docs-boards.js';
import { FEISHU_DOC_TOOLS, SESSION_START_TOOL, type McpFieldSpec } from '../mcp/tools.js';
import { resourceId, decodeResourceId } from '../sessionhub/core.js';
import { MIGRATIONS } from '../store/migrations.js';
import { FeishuDocsSharesRepository } from '../store/repositories/feishu-docs-shares.js';
import { WorkspaceGrantsRepository } from '../store/repositories/workspace-grants.js';
import { FeishuRefusal, type DocBlock, type FeishuDocsClient } from './docs-openapi.js';
import type { DocsLauncher } from './docs-launch.js';
import type { DocsWorkspaceFiles } from './docs-files.js';

const origin = 'https://widget.feishu.cn';
const SELF = '11111111-2222-4333-8444-555555555555';
const ALICE = resourceId({ owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: SELF });
const OTHER = resourceId({ owner: 'alice', device: 'desk', cliKind: 'codex', sessionId: 'other-session' });
const WS = 'ws_' + '1'.repeat(24);

let service: FeishuDocsAddonService;
let auth: FeishuDocsAddonAuth;
let db: Database.Database;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(() => { service?.close(); auth?.close(); db?.close(); vi.useRealTimers(); });

function setup(extra: Partial<DocsAddonExtras> = {}) {
  db = new Database(':memory:');
  for (const m of MIGRATIONS) db.exec(m.sql);
  const shares = new FeishuDocsSharesRepository(db);
  const grants = new WorkspaceGrantsRepository(db);
  const people = new Map([['ou_alice', 'alice'], ['ou_bob', 'bob'], ['ou_carol', 'carol']]);
  let next = 'ou_alice';
  auth = new FeishuDocsAddonAuth({ tenantKey: 't', allowedOrigins: [origin], verifyCode: async () => ({ openId: next, tenantKey: 't' }) }, (id) => people.get(id), vi.fn());
  const hub = {
    decodeResourceId,
    roster: vi.fn(async () => ({ sessions: [
      { resourceId: ALICE, sessionId: SELF, deviceId: 'laptop', cliKind: 'claude', title: '论文实验', cwd: '/home/a/paper', sortActivity: '2026-10-18T01:00:00Z' },
      { resourceId: OTHER, sessionId: 'other-session', deviceId: 'desk', cliKind: 'codex', first_user_text: '复现基线' },
    ], permissions: { effective: ['list_sessions'] } })),
    liveGrant: vi.fn(),
  };
  const docs = {
    resolve: vi.fn(async () => ({ documentId: 'DocxToken1234567890abcdefg', wikiToken: 'WikiToken1234567890abcdefgh', title: '组会周报', url: 'https://t.feishu.cn/wiki/WikiToken1234567890abcdefgh' })),
    insertAddOn: vi.fn(async () => 'blk-new'),
    blocks: vi.fn(async (): Promise<DocBlock[]> => []),
    block: vi.fn(async (_owner: string, _doc: string, _id: string): Promise<Record<string, unknown> | null> => null),
    deleteBlock: vi.fn(async () => {}),
    convert: vi.fn(async () => ({ children: ['t1', 't2'], blocks: [{ block_id: 't1', block_type: 3 }, { block_id: 't2', block_type: 2 }], droppedImages: 0 })),
    insertBlocks: vi.fn(async () => ['n1', 'n2']),
    insertImage: vi.fn(async () => 'img-new'),
    search: vi.fn(async (_owner: string, query: string) => query === '周报' ? [
      { title: '组会周报', ref: { kind: 'wiki', token: 'WikiToken1234567890abcdefgh' }, url: 'https://t.feishu.cn/wiki/WikiToken1234567890abcdefgh' },
      { title: '组会周报（旧）', ref: { kind: 'docx', token: 'OtherDocx1234567890abcdefg' } },
    ] : query === '组会周报' ? [{ title: '组会周报', ref: { kind: 'wiki', token: 'WikiToken1234567890abcdefgh' } }] : []),
  };
  const notifier = { notify: vi.fn() };
  const launcher = {
    options: vi.fn(() => ({ devices: [], directories: [], models: { claude: [], codex: [] }, efforts: { claude: [], codex: [] }, defaults: {} })),
    start: vi.fn(async (owner: string, request: { requestId: string }) => `fdl-${owner}-${request.requestId}`),
    status: vi.fn(async () => ({ state: 'succeeded', sessionId: 'new-session' })),
    waitForSession: vi.fn(async () => ({ state: 'succeeded', sessionId: 'new-session' })),
  };
  const files = {
    resolve: vi.fn(async (_s: unknown, mention: string) => ({ workspace: { workspaceId: WS, label: 'paper', display: '~/paper' }, relativePath: mention.replace(/\/$/, '') })),
    read: vi.fn(async (_o: string, _d: string, target: { relativePath: string }) => ({ kind: 'file', workspace: { workspaceId: WS, label: 'paper' }, path: target.relativePath, name: 'fig.png', size: 3, modifiedAt: 'x', chunks: (async function* () { yield Buffer.from('PNG'); })() })),
    sessionWorkspace: vi.fn(async () => ({ workspace: { workspaceId: WS, label: 'paper', display: '~/paper' }, relativePath: '' })),
  };
  const settings = new Map<string, string>();
  service = new FeishuDocsAddonService(auth, hub as never, { submit: vi.fn(), get: vi.fn() } as never, shares, (u) => ({ alice: 'Alice', bob: 'Bob' } as Record<string, string>)[u] ?? u, Date.now, {
    docs: docs as unknown as FeishuDocsClient, componentTypeId: 'blk_widget', notifier: notifier as never,
    launcher: launcher as unknown as DocsLauncher, files: files as unknown as DocsWorkspaceFiles, grants, boards: new FeishuDocsBoardsRepository(db),
    members: () => [{ username: 'alice', name: 'Alice' }, { username: 'bob', name: 'Bob' }, { username: 'carol', name: 'carol' }],
    settings: { get: (o, k) => settings.get(`${o}/${k}`), set: (o, k, v) => { settings.set(`${o}/${k}`, v); } },
    ...extra,
  });
  const as = async (openId: string): Promise<DocsAddonIdentity> => { next = openId; return auth.authenticate((await auth.login(`code-${openId}-${Math.random()}`, origin)).token, origin); };
  return { hub, docs, notifier, launcher, files, grants, shares, settings, as };
}

it('places the calling agent\'s own session into a document as a card carrying a fresh share', async () => {
  const { docs, notifier, shares } = setup();
  const result = await service.place('alice', { document: 'https://t.feishu.cn/wiki/WikiToken1234567890abcdefgh' }, { device: 'laptop', source: 'claude', sessionId: SELF });
  expect(result).toEqual({ document: { title: '组会周报', id: 'DocxToken1234567890abcdefg', url: 'https://t.feishu.cn/wiki/WikiToken1234567890abcdefgh' }, card: { block: 'blk-new', title: '论文实验' },
    session: { resource_id: ALICE, title: '论文实验', device: 'laptop', provider: 'claude' } });
  const [owner, documentId, type, record, slot] = docs.insertAddOn.mock.calls[0]! as unknown as [string, string, string, { octopusAgent: Record<string, string> }, unknown];
  expect([owner, documentId, type, slot]).toEqual(['alice', 'DocxToken1234567890abcdefg', 'blk_widget', { parent: 'DocxToken1234567890abcdefg', index: -1 }]);
  // The Record is exactly what the card itself would write, naming the document both ways.
  expect(record.octopusAgent).toMatchObject({ v: 2, title: '论文实验', owner: 'Alice', device: 'laptop', provider: 'claude', doc: 'DocxToken1234567890abcdefg', alias: 'WikiToken1234567890abcdefgh' });
  expect(record.octopusAgent.share).toMatch(/^ds_[A-Za-z0-9_-]{43}$/);
  expect(shares.liveCounts('alice').get(ALICE)).toBe(1);
  expect(notifier.notify).toHaveBeenCalledWith('alice', expect.objectContaining({ kind: 'placed', via: 'agent', session: '论文实验', doc: { title: '组会周报', url: 'https://t.feishu.cn/wiki/WikiToken1234567890abcdefgh' } }));
});

it('places another of the owner\'s sessions by native id or resource id, never someone else\'s', async () => {
  setup();
  expect((await service.place('alice', { document: 'DocxToken1234567890abcdefg', session: 'other-session', title: '基线' })).session.resource_id).toBe(OTHER);
  expect((await service.place('alice', { document: 'DocxToken1234567890abcdefg', session: OTHER })).card.title).toBe('复现基线');
  await expect(service.place('alice', { document: 'DocxToken1234567890abcdefg' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('CLAUDE_CODE_SESSION_ID') });
  const bobs = resourceId({ owner: 'bob', device: 'laptop', cliKind: 'claude', sessionId: 'b' });
  await expect(service.place('alice', { document: 'DocxToken1234567890abcdefg', session: bobs })).rejects.toMatchObject({ status: 403 });
  await expect(service.place('alice', { document: 'DocxToken1234567890abcdefg', session: 'no-such-session' })).rejects.toMatchObject({ status: 404 });
});

const DOC = 'DocxToken1234567890abcdefg';
// A plan document: the section heading and its plan are children of an indented paragraph.
const PLAN: DocBlock[] = [
  { id: DOC, parent: '', children: ['p9'], text: '' },
  { id: 'p9', parent: DOC, children: ['a0', 'a0plan', 'a1'], text: '论述口径' },
  { id: 'a0', parent: 'p9', children: [], text: 'A0｜把隐式依赖纳入统一分析框架' },
  { id: 'a0plan', parent: 'p9', children: [], text: '计划：  定义输入 --- 中间态 --- 输出的task 内依赖图' },
  { id: 'a1', parent: 'p9', children: [], text: 'A1｜原型系统 v2' },
];

it('places a card right after a quoted passage, one level out when Feishu will not nest it there', async () => {
  const { docs, shares } = setup();
  docs.blocks.mockResolvedValue(PLAN);
  docs.insertAddOn.mockRejectedValueOnce(new FeishuRefusal(502, '飞书拒绝了这次操作（1770029）', 1770029));
  const result = await service.place('alice', { document: DOC, session: OTHER, after: 'A0｜把隐式依赖纳入统一分析框架\n 计划：定义输入', position: 'start' });
  expect(docs.insertAddOn.mock.calls.map((call) => (call as unknown[])[4])).toEqual([{ parent: 'p9', index: 2 }, { parent: DOC, index: 1 }]);
  expect(result.card).toEqual({ block: 'blk-new', title: '复现基线', after: '计划： 定义输入 --- 中间态 --- 输出的task 内依赖图' });
  expect(shares.liveCounts('alice').get(OTHER)).toBe(1);
});

it('never moves a card past an access refusal, and mints nothing for a passage that names no single place', async () => {
  const { docs, shares } = setup();
  docs.blocks.mockResolvedValue(PLAN);
  docs.insertAddOn.mockRejectedValueOnce(new FeishuRefusal(403, '你没有这篇文档的编辑权限', 1770032));
  await expect(service.place('alice', { document: DOC, session: OTHER, after: '计划：' })).rejects.toMatchObject({ status: 403 });
  expect(docs.insertAddOn).toHaveBeenCalledOnce();
  expect(shares.liveCounts('alice').size).toBe(0);
  await expect(service.place('alice', { document: DOC, session: OTHER, after: 'A' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('出现在 2 处') });
  await expect(service.place('alice', { document: DOC, session: OTHER, after: '不存在的段落' })).rejects.toMatchObject({ status: 404 });
  expect(docs.insertAddOn).toHaveBeenCalledOnce();
  expect(shares.liveCounts('alice').size).toBe(0);
});

it('finds a session by the title its terminal shows, and lists look-alikes instead of guessing', async () => {
  const { hub } = setup();
  expect((await service.place('alice', { document: DOC, session: '✳ 论文实验' })).session.resource_id).toBe(ALICE);
  expect((await service.place('alice', { document: DOC, session: '论文' })).session.resource_id).toBe(ALICE);
  hub.roster.mockResolvedValueOnce({ sessions: [
    { resourceId: ALICE, sessionId: SELF, deviceId: 'laptop', cliKind: 'claude', title: '论文实验 · 一' },
    { resourceId: OTHER, sessionId: 'other-session', deviceId: 'desk', cliKind: 'codex', title: '论文实验 · 二', cwdDisplay: '~/b' },
  ], permissions: { effective: ['list_sessions'] } } as never);
  await expect(service.place('alice', { document: DOC, session: '论文实验' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(OTHER) });
});

it('hands every argument a docs tool declares to the service, whatever the tool', async () => {
  setup();
  const targets = { feishu_doc_place: 'place', feishu_doc_board: 'board', feishu_doc_remove: 'remove', session_start: 'startForAgent',
    feishu_doc_outline: 'readDoc', feishu_doc_write: 'writeDoc', feishu_doc_image: 'imageDoc', feishu_doc_delete: 'deleteDoc' } as const;
  for (const spec of [...FEISHU_DOC_TOOLS, SESSION_START_TOOL]) {
    const method = targets[spec.name as keyof typeof targets];
    expect(method, spec.name).toBeDefined();
    const sample = (name: string, field: McpFieldSpec) => field.enum ? field.enum[0] : field.type === 'number' ? 3 : field.type === 'boolean' ? true : `v-${name}`;
    const args = Object.fromEntries(Object.entries(spec.fields).map(([name, field]) => [name, sample(name, field)]));
    const spy = vi.spyOn(service, method).mockResolvedValue({} as never);
    await service.agentTool(spec.name, 'alice', args);
    expect(spy.mock.calls[0]![1], spec.name).toEqual(args);
    spy.mockRestore();
  }
  await expect(service.agentTool('feishu_doc_teleport', 'alice', {})).rejects.toMatchObject({ status: 404 });
});

it('publishes a board as a card once, then updates it in place without another notice', async () => {
  const { docs, notifier, as } = setup();
  docs.blocks.mockResolvedValue(PLAN);
  const html = '<style>.k{color:var(--board-good)}</style><h2>进度</h2><p class="k">A0 进行中</p>';
  const first = await service.board('alice', { html, title: '进度看板', document: DOC, after: 'A0｜把隐式' }, { device: 'laptop', source: 'codex', sessionId: 'sec' }) as Record<string, any>;
  expect(first).toMatchObject({ board: expect.stringMatching(/^bd_[0-9a-f]{24}$/), version: 1, card: { block: 'blk-new', title: '进度看板', after: 'A0｜把隐式依赖纳入统一分析框架' } });
  const [, documentId, type, record, slot] = docs.insertAddOn.mock.calls[0]! as unknown as [string, string, string, { octopusBoard: Record<string, unknown> }, unknown];
  expect([documentId, type, slot]).toEqual([DOC, 'blk_widget', { parent: 'p9', index: 1 }]);
  expect(record.octopusBoard).toMatchObject({ v: 1, title: '进度看板', owner: 'Alice', doc: DOC, alias: 'WikiToken1234567890abcdefgh' });
  const capability = record.octopusBoard.board as string;
  expect(capability).toMatch(/^db_[A-Za-z0-9_-]{43}$/);
  expect(notifier.notify).toHaveBeenCalledOnce();
  expect(notifier.notify).toHaveBeenCalledWith('alice', expect.objectContaining({ kind: 'board', title: '进度看板' }));

  const alice = await as('ou_alice');
  const bob = await as('ou_bob');
  expect(service.readBoard(bob, capability, '')).toMatchObject({ role: 'viewer', title: '进度看板', owner: 'Alice', version: 1, html });
  expect(service.readBoard(alice, capability, '')).toMatchObject({ role: 'owner' });
  expect(service.readBoard(bob, capability, '1')).toEqual({ version: 1, unchanged: true });

  expect(await service.board('alice', { html: '<p>A0 完成</p>', board: first.board })).toEqual({ board: first.board, version: 2, updated: true });
  expect(service.readBoard(bob, capability, '1')).toMatchObject({ version: 2, html: '<p>A0 完成</p>', title: '进度看板' });
  expect(notifier.notify).toHaveBeenCalledOnce();
  await expect(service.board('bob', { html: '<p>x</p>', board: first.board })).rejects.toMatchObject({ status: 404 });

  expect(() => service.unboard(bob, capability)).toThrow(/Alice/);
  expect(service.unboard(alice, capability)).toEqual({ revoked: true });
  expect(() => service.readBoard(bob, capability, '')).toThrow('这块看板已停止共享');
  await expect(service.board('alice', { html: '<p>x</p>', board: first.board })).rejects.toMatchObject({ status: 410 });
});

it('refuses a board it could not show as written, and one it would not know where to put', async () => {
  const { docs } = setup();
  await expect(service.board('alice', { html: '<div>x</div><script>alert(1)</script>', document: DOC })).rejects.toThrow('脚本不会执行');
  await expect(service.board('alice', { html: '   ', document: DOC })).rejects.toMatchObject({ status: 400 });
  await expect(service.board('alice', { html: 'x'.repeat(200_001), document: DOC })).rejects.toMatchObject({ status: 413 });
  await expect(service.board('alice', { html: '<p>x</p>' })).rejects.toThrow('document');
  expect(docs.insertAddOn).not.toHaveBeenCalled();
});

it('takes the owner\'s own cards out of a document and leaves everything else alone', async () => {
  const { docs, shares, notifier } = setup();
  const placed = await service.place('alice', { document: DOC, session: OTHER });
  const share = ((docs.insertAddOn.mock.calls[0] as unknown[])[3] as { octopusAgent: { share: string } }).octopusAgent.share;
  const card = (record: unknown) => ({ block_type: 40, parent_id: DOC, add_ons: { component_type_id: 'blk_widget', record: JSON.stringify(record) } });
  docs.block.mockResolvedValueOnce(card({ octopusAgent: { v: 2, share } }));
  expect(await service.remove('alice', { document: DOC, block: placed.card.block })).toMatchObject({ removed: 'session', title: '复现基线' });
  expect(docs.deleteBlock).toHaveBeenCalledWith('alice', DOC, { id: 'blk-new', parent: DOC });
  expect(shares.liveCounts('alice').size).toBe(0);
  expect(notifier.notify).toHaveBeenLastCalledWith('alice', expect.objectContaining({ kind: 'removed', session: '复现基线' }));

  const board = await service.board('alice', { html: '<p>x</p>', title: '看板', document: DOC }) as { card: { block: string } };
  const boardCap = ((docs.insertAddOn.mock.calls[1] as unknown[])[3] as { octopusBoard: { board: string } }).octopusBoard.board;
  docs.block.mockResolvedValueOnce(card({ octopusBoard: { v: 1, board: boardCap } }));
  expect(await service.remove('alice', { document: DOC, block: board.card.block })).toMatchObject({ removed: 'board', title: '看板' });

  docs.block.mockResolvedValueOnce({ block_type: 2, parent_id: DOC, text: {} });
  await expect(service.remove('alice', { document: DOC, block: 'para' })).rejects.toMatchObject({ status: 404 });
  docs.block.mockResolvedValueOnce({ ...card({}), add_ons: { component_type_id: 'blk_other', record: '{}' } });
  await expect(service.remove('alice', { document: DOC, block: 'other-widget' })).rejects.toMatchObject({ status: 404 });
  const bobs = await service.place('alice', { document: DOC, session: OTHER });
  docs.block.mockResolvedValueOnce(card({ octopusAgent: { v: 2, share: ((docs.insertAddOn.mock.calls[2] as unknown[])[3] as { octopusAgent: { share: string } }).octopusAgent.share } }));
  await expect(service.remove('bob', { document: DOC, block: bobs.card.block })).rejects.toMatchObject({ status: 403 });
  expect(docs.deleteBlock).toHaveBeenCalledTimes(2);
});

it('revokes the share it minted when Feishu refuses the block', async () => {
  const { docs, shares, notifier } = setup();
  docs.insertAddOn.mockRejectedValueOnce(Object.assign(new Error('你没有这篇文档的编辑权限'), { status: 403 }));
  await expect(service.place('alice', { document: 'DocxToken1234567890abcdefg' }, { device: 'laptop', source: 'claude', sessionId: SELF })).rejects.toThrow('编辑权限');
  expect(shares.liveCounts('alice').size).toBe(0);
  expect(notifier.notify).not.toHaveBeenCalled();
});

it('starts a new agent from a card and mints its share exactly once', async () => {
  const { as, launcher, notifier, settings } = setup();
  const alice = await as('ou_alice');
  const form = { device: 'laptop', directory: '~/paper', provider: 'claude', model: 'opus', effort: 'max', task: '复现基线', title: '基线', docTitle: '组会周报', docText: '# 周报', requestId: '0123456789abcdef' };
  const { id } = await service.launch(alice, form);
  expect(launcher.start).toHaveBeenCalledWith('alice', expect.objectContaining({ device: 'laptop', provider: 'claude', model: 'opus', effort: 'max', prompt: firstInstruction('复现基线', { title: '组会周报', text: '# 周报' }) }));
  const [first, again] = await Promise.all([service.launchStatus(alice, id), service.launchStatus(alice, id)]);
  expect(first).toMatchObject({ state: 'ready', binding: { title: '基线', device: 'laptop', provider: 'claude' } });
  expect(again.binding?.share).toBe(first.binding?.share);
  expect((await service.launchStatus(alice, id)).binding?.share).toBe(first.binding?.share);
  expect(notifier.notify).toHaveBeenCalledTimes(1);
  expect(notifier.notify).toHaveBeenCalledWith('alice', expect.objectContaining({ kind: 'created', via: 'card', model: 'opus', effort: 'max', directory: '~/paper', doc: { title: '组会周报' } }));
  expect(JSON.parse(settings.get('alice/feishu_docs_launch')!)).toMatchObject({ device: 'laptop', directory: '~/paper', provider: 'claude', model: { claude: 'opus' }, effort: { claude: 'max' } });
  const bob = await as('ou_bob');
  await expect(service.launchStatus(bob, id)).rejects.toMatchObject({ status: 404 });
  expect(firstInstruction('任务')).toBe('任务');
});

it('hands a new agent the whole document, or tells it where to read one too long for a task', async () => {
  const { as, launcher } = setup();
  const alice = await as('ou_alice');
  const base = { device: 'laptop', directory: '~/paper', provider: 'claude', model: '', effort: '', title: '读文档', docTitle: '组会周报', doc: DOC };
  // Far past the old 30 000-character cut, and still within one prompt: it goes along whole.
  const long = Array.from({ length: 2_000 }, (_, n) => `第 ${n} 段：实验记录与结论。`).join('\n');
  expect(long.length).toBeGreaterThan(30_000);
  await service.launch(alice, { ...base, task: '复现基线', docText: long, requestId: '0123456789abcdef' });
  const first = (launcher.start.mock.calls[0] as unknown[])[1] as { prompt: string };
  expect(first.prompt).toContain(long);
  expect(first.prompt).toContain(`document_id：${DOC}`);
  // A text the card could not send: no part of it, and the agent learns how large it is and how to read it.
  await service.launch(alice, { ...base, task: '复现基线', docBytes: 900 * 1024, requestId: '0123456789abcdeg' });
  const second = (launcher.start.mock.calls[1] as unknown[])[1] as { prompt: string };
  expect(second.prompt).toContain('文档正文有 900 KB，连同任务超过了一条任务能携带的 384 KB');
  expect(second.prompt).toContain('feishu_doc_read');
  // Sent, but too large together with the task: same answer, never a cut.
  const huge = '论'.repeat(140_000);
  expect(firstInstruction('任务', { title: 'T', id: DOC, text: huge })).not.toContain('论论论');
  expect(firstInstruction('任务', { title: 'T', id: DOC, text: huge })).toContain('文档正文有 411 KB');
  // A task that alone exceeds a prompt is refused, saying by how much.
  await expect(service.launch(alice, { ...base, task: 'x'.repeat(400 * 1024), requestId: '0123456789abcdeh' })).rejects.toMatchObject({ status: 413, message: expect.stringContaining('超过一条任务能携带的 384 KB') });
});

it('lets an agent start another agent and place it in one call', async () => {
  const { launcher, docs, notifier } = setup();
  const result = await service.startForAgent('alice', { prompt: '整理会议纪要', directory: '~/notes', document: 'DocxToken1234567890abcdefg' }, { device: 'laptop', source: 'claude', sessionId: SELF });
  expect(launcher.start).toHaveBeenCalledWith('alice', expect.objectContaining({ device: 'laptop', directory: '~/notes', provider: 'codex' }));
  expect(result).toMatchObject({ state: 'started', session_id: 'new-session', resource_id: resourceId({ owner: 'alice', device: 'laptop', cliKind: 'codex', sessionId: 'new-session' }), card: { block: 'blk-new' } });
  expect(docs.insertAddOn).toHaveBeenCalledOnce();
  expect(notifier.notify).toHaveBeenCalledWith('alice', expect.objectContaining({ kind: 'created', via: 'agent' }));
});

it('serves a mentioned file to the owner and to granted readers only, and tells the owner who opened what', async () => {
  const { as, notifier, files } = setup();
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: '论文实验', docTitle: '组会周报' });
  expect(notifier.notify).toHaveBeenLastCalledWith('alice', expect.objectContaining({ kind: 'placed', via: 'card', doc: { title: '组会周报' } }));
  expect((await service.file(alice, binding.share, 'results/fig.png')).kind).toBe('file');
  const bob = await as('ou_bob');
  await expect(service.file(bob, binding.share, 'results/fig.png')).rejects.toMatchObject({ status: 403, message: 'Alice 还没有把工作区「paper」共享给你' });
  await service.grantWorkspace(alice, binding.share, WS, ['bob']);
  expect(notifier.notify).toHaveBeenLastCalledWith('alice', expect.objectContaining({ kind: 'workspace', workspace: 'paper', members: ['Bob'] }));
  expect((await service.file(bob, binding.share, 'results/fig.png')).kind).toBe('file');
  expect(notifier.notify).toHaveBeenLastCalledWith('alice', expect.objectContaining({ kind: 'file', actor: 'Bob', path: 'results/fig.png', workspace: 'paper' }));
  expect(files.read).toHaveBeenLastCalledWith('alice', 'laptop', expect.anything(), false, undefined);
  // Continuing a listing passes the cursor through and does not tell the owner again.
  const notices = notifier.notify.mock.calls.length;
  await service.file(bob, binding.share, 'results/', 'file/fig.png');
  expect(files.read).toHaveBeenLastCalledWith('alice', 'laptop', expect.anything(), true, 'file/fig.png');
  expect(notifier.notify.mock.calls).toHaveLength(notices);
  const guest = await as('ou_guest');
  await expect(service.file(guest, binding.share, 'results/fig.png')).rejects.toMatchObject({ status: 403 });
  service.unshare(alice, { share: binding.share });
  await expect(service.file(bob, binding.share, 'x.md')).rejects.toMatchObject({ status: 410 });
  expect(notifier.notify).toHaveBeenLastCalledWith('alice', expect.objectContaining({ kind: 'removed', session: '论文实验', cards: 1 }));
});

it('never shares the whole home folder, and grants only listed accounts', async () => {
  const { as, files, grants } = setup();
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: '论文实验' });
  expect(await service.workspace(alice, binding.share)).toMatchObject({ workspace: { id: WS, label: 'paper', shareable: true }, members: [], candidates: [{ username: 'bob' }, { username: 'carol' }] });
  await expect(service.grantWorkspace(alice, binding.share, WS, ['mallory'])).rejects.toMatchObject({ status: 400 });
  await expect(service.grantWorkspace(alice, binding.share, 'ws_' + '9'.repeat(24), ['bob'])).rejects.toMatchObject({ status: 409 });
  files.sessionWorkspace.mockResolvedValue({ workspace: { workspaceId: 'ws_' + '0'.repeat(24), label: 'Home', display: '~' }, relativePath: 'paper' });
  expect((await service.workspace(alice, binding.share)).workspace).toMatchObject({ shareable: false });
  await expect(service.grantWorkspace(alice, binding.share, 'ws_' + '0'.repeat(24), ['bob'])).rejects.toMatchObject({ status: 422 });
  expect(grants.members('alice', 'laptop', 'ws_' + '0'.repeat(24))).toEqual([]);
  const bob = await as('ou_bob');
  await expect(service.workspace(bob, binding.share)).rejects.toMatchObject({ status: 403 });
});

it('finds the document by title, and hands back candidates instead of guessing', async () => {
  const { docs } = setup();
  const caller = { device: 'laptop', source: 'claude', sessionId: SELF };
  await service.place('alice', { document: '组会周报' }, caller);
  expect(docs.resolve).toHaveBeenCalledWith('alice', { kind: 'wiki', token: 'WikiToken1234567890abcdefgh' });
  await expect(service.place('alice', { document: '周报' }, caller)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('https://t.feishu.cn/wiki/WikiToken1234567890abcdefgh') });
  await expect(service.place('alice', { document: '不存在的文档' }, caller)).rejects.toMatchObject({ status: 404 });
});

describe('the card status bar', () => {
  const NOW = Date.parse('2026-10-18T12:00:00Z');
  const rows = [
    { i: 0, role: 'user' as const, text: '跑实验', at: '2026-10-18T11:00:00Z' },
    { i: 1, role: 'assistant' as const, text: '完成', at: '2026-10-18T11:23:00Z' },
  ];
  const at = (iso: string) => new Date(iso).toISOString();

  it('says how long a working agent has run, from the Runner\'s turn start when it has one', () => {
    const live = { state: 'tool' as const, tool: 'Bash', since: '2026-10-18T11:59:30Z', observed_at: '2026-10-18T11:59:50Z' };
    expect(statusOf({ activity: live, runtime: { turn_state: 'working', turn: { started_at: '2026-10-18T11:48:00Z' } }, rows: rows.slice(0, 1) }, NOW, null))
      .toEqual({ working: true, state: 'tool', tool: 'Bash', since: '2026-10-18T11:59:30Z', turnStartedAt: at('2026-10-18T11:48:00Z') });
    expect(statusOf({ activity: live, rows: rows.slice(0, 1) }, NOW).turnStartedAt).toBe(at('2026-10-18T11:00:00Z'));
  });

  it('says when the agent waits for its owner: a question, or a permission', () => {
    const idle = { state: 'idle' as const };
    expect(statusOf({ activity: idle, runtime: { interaction: { kind: 'question' } }, rows }, NOW).waiting).toBe('question');
    expect(statusOf({ activity: idle, runtime: { interaction: { kind: 'permission' } }, rows }, NOW).waiting).toBe('permission');
    expect(statusOf({ activity: idle, runtime: { turn_state: 'needs_input', event: 'PermissionRequest' }, rows }, NOW).waiting).toBe('permission');
    expect(statusOf({ activity: idle, runtime: { turn_state: 'needs_input' }, rows }, NOW).waiting).toBe('question');
    const asking = { state: 'tool' as const, tool: 'AskUserQuestion', observed_at: '2026-10-18T11:59:00Z' };
    expect(statusOf({ activity: asking, rows }, NOW).waiting).toBe('question');
    expect(statusOf({ activity: idle, runtime: { turn_state: 'needs_input' }, rows }, NOW, null).unread).toBeUndefined();
  });

  it('marks a finished turn unread for the owner until a card has shown it, and never for a viewer', () => {
    const idle = { state: 'idle' as const };
    expect(statusOf({ activity: idle, rows }, NOW, null)).toEqual({ working: false, state: 'idle', turnStartedAt: at('2026-10-18T11:00:00Z'), lastReplyAt: at('2026-10-18T11:23:00Z'), unread: true });
    expect(statusOf({ activity: idle, rows }, NOW, at('2026-10-18T11:23:00Z')).unread).toBeUndefined();
    expect(statusOf({ activity: idle, rows }, NOW, at('2026-10-18T11:10:00Z')).unread).toBe(true);
    expect(statusOf({ activity: idle, rows }, NOW).unread).toBeUndefined();
    // The owner wrote after the last reply: that turn has not finished.
    expect(statusOf({ activity: idle, rows: [...rows, { i: 2, role: 'user' as const, text: '再来', at: '2026-10-18T11:30:00Z' }] }, NOW, null).unread).toBeUndefined();
  });

  it('records the owner\'s read point for every card of that session, never moving it backwards', async () => {
    const { as, shares } = setup();
    const alice = await as('ou_alice');
    const first = service.share(alice, { resourceId: ALICE, title: '论文实验', docTitle: '组会周报' }).binding.share;
    const second = service.share(alice, { resourceId: ALICE, title: '论文实验', docTitle: '另一篇' }).binding.share;
    expect(service.markRead(alice, first, '2026-10-18T11:23:00Z')).toEqual({ ok: true });
    const readAt = (capability: string) => shares.get(createHash('sha256').update(capability).digest('hex'))?.readAt;
    expect([readAt(first), readAt(second)]).toEqual([at('2026-10-18T11:23:00Z'), at('2026-10-18T11:23:00Z')]);
    service.markRead(alice, second, '2026-10-18T11:00:00Z');
    expect(readAt(first)).toBe(at('2026-10-18T11:23:00Z'));
    const bob = await as('ou_bob');
    expect(() => service.markRead(bob, first, '2026-10-18T11:30:00Z')).toThrow(/所有者/);
    expect(() => service.markRead(alice, first, 'not-a-time')).toThrow('已读时间无效');
  });
});

describe('agents editing a document as its owner', () => {
  const caller = { device: 'laptop', source: 'claude', sessionId: SELF };
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it('reads the body as an addressable outline, page by page', async () => {
    const { docs } = setup();
    docs.blocks.mockResolvedValue(PLAN.map((block, i) => ({ ...block, type: i === 0 ? 1 : 2 })));
    expect(await service.readDoc('alice', { document: DOC, limit: 2 })).toMatchObject({ total: 4, from: 0, next: 2,
      blocks: [{ id: 'p9', kind: 'text', depth: 0, text: '论述口径' }, { id: 'a0', kind: 'text', depth: 1 }] });
    expect(await service.readDoc('alice', { document: DOC, from: 2 })).toMatchObject({ from: 2, blocks: [{ id: 'a0plan' }, { id: 'a1' }] });
  });

  it('writes Markdown right after a passage, and tells the owner once per document per ten minutes', async () => {
    const { docs, notifier } = setup();
    docs.blocks.mockResolvedValue(PLAN);
    const result = await service.writeDoc('alice', { document: DOC, markdown: '## 进展\n- 已完成', after: '计划：定义输入' }, caller);
    expect(docs.convert).toHaveBeenCalledWith('## 进展\n- 已完成');
    expect((docs.insertBlocks.mock.calls[0] as unknown[])[2]).toEqual({ parent: 'p9', index: 2 });
    expect(result).toMatchObject({ blocks: ['n1', 'n2'], document: { id: DOC } });
    expect(notifier.notify).toHaveBeenCalledWith('alice', expect.objectContaining({ kind: 'edited', change: '写入了 2 个内容块' }));
  });

  it('replaces one block in place: the new content lands first, then the old block goes', async () => {
    const { docs } = setup();
    docs.blocks.mockResolvedValue(PLAN.map((block) => ({ ...block, type: block.id === DOC ? 1 : 2 })));
    const order: string[] = [];
    docs.insertBlocks.mockImplementationOnce(async () => { order.push('insert'); return ['n1']; });
    docs.deleteBlock.mockImplementationOnce(async () => { order.push('delete'); });
    expect(await service.writeDoc('alice', { document: DOC, markdown: '计划：已定稿', replace: 'a0plan' }, caller)).toMatchObject({ replaced: 'a0plan' });
    expect((docs.insertBlocks.mock.calls[0] as unknown[])[2]).toEqual({ parent: 'p9', index: 1 });
    expect(docs.deleteBlock).toHaveBeenCalledWith('alice', DOC, { id: 'a0plan', parent: 'p9' });
    expect(order).toEqual(['insert', 'delete']);
    docs.blocks.mockResolvedValue(PLAN.map((block) => ({ ...block, type: block.id === 'a1' ? 40 : 2 })));
    await expect(service.writeDoc('alice', { document: DOC, markdown: 'x', replace: 'a1' }, caller)).rejects.toMatchObject({ status: 409 });
  });

  it('writes Markdown of any length: converted piece by piece, then placed in order at the same spot', async () => {
    const { docs, notifier } = setup();
    docs.blocks.mockResolvedValue(PLAN);
    const paragraph = (n: number) => `第 ${n} 段：${'很长的论述。'.repeat(2_000)}`;
    const markdown = Array.from({ length: 30 }, (_, n) => paragraph(n)).join('\n\n');
    expect(markdown.length).toBeGreaterThan(300_000);
    let next = 0;
    docs.convert.mockImplementation((async (piece: string) => ({ children: [`t${next}`], blocks: [{ block_id: `t${next++}`, block_type: 2, text: piece.length }], droppedImages: 1 })) as never);
    docs.insertBlocks.mockImplementation((async (_o: string, _d: string, _slot: unknown, part: { children: string[] }) => part.children.map((id) => `n-${id}`)) as never);
    const result = await service.writeDoc('alice', { document: DOC, markdown, after: '计划：定义输入' }, caller) as { blocks: string[]; skipped_images: number };
    const pieces = docs.convert.mock.calls.map((call) => (call as unknown[])[0] as string);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.every((piece) => piece.length <= 50_000)).toBe(true);
    expect(pieces.join('\n\n')).toBe(markdown);
    expect(docs.insertBlocks.mock.calls.map((call) => (call as unknown[])[2])).toEqual(pieces.map((_, k) => ({ parent: 'p9', index: 2 + k })));
    expect(result.blocks).toEqual(pieces.map((_, k) => `n-t${k}`));
    expect(result.skipped_images).toBe(pieces.length);
    expect(notifier.notify).toHaveBeenCalledWith('alice', expect.objectContaining({ change: `写入了 ${pieces.length} 个内容块` }));
  });

  it('says how far a long write got when a later piece fails, instead of leaving it to be guessed', async () => {
    const { docs } = setup();
    docs.blocks.mockResolvedValue(PLAN);
    const markdown = Array.from({ length: 3 }, (_, n) => `第 ${n} 段：${'论述。'.repeat(20_000)}`).join('\n\n');
    let next = 0;
    docs.convert.mockImplementation(async () => ({ children: [`t${next}`], blocks: [{ block_id: `t${next++}`, block_type: 2 }], droppedImages: 0 }));
    docs.insertBlocks.mockImplementation((async (_o: string, _d: string, _slot: unknown, part: { children: string[] }) => {
      if (part.children[0] === 't2') throw new DocsAddonError(502, '飞书暂时不可用');
      return part.children.map((id) => `n-${id}`);
    }) as never);
    await expect(service.writeDoc('alice', { document: DOC, markdown, after: '计划：定义输入' }, caller))
      .rejects.toMatchObject({ status: 502, message: expect.stringContaining('已写入前 2/3 段、2 个内容块，后面的没有写入；新写入的块从 n-t0 到 n-t1') });
  });

  it('says which Markdown images it left out instead of dropping them silently', async () => {
    const { docs } = setup();
    docs.convert.mockResolvedValueOnce({ children: ['t1'], blocks: [{ block_id: 't1', block_type: 2 }], droppedImages: 2 });
    expect(await service.writeDoc('alice', { document: DOC, markdown: '![a](a.png)', position: 'end' }, caller)).toMatchObject({ skipped_images: 2 });
  });

  it('inserts an image from the calling agent\'s own device, or inline, and refuses what Feishu cannot show', async () => {
    const { docs, files } = setup();
    files.read.mockResolvedValueOnce({ kind: 'file', workspace: { workspaceId: WS, label: 'paper' }, path: 'results/fig.png', name: 'fig.png', size: PNG.length, modifiedAt: 'x', chunks: (async function* () { yield PNG; })() });
    expect(await service.imageDoc('alice', { document: DOC, path: 'results/fig.png', position: 'start' }, caller)).toMatchObject({ block: 'img-new', name: 'fig.png' });
    expect(files.resolve).toHaveBeenCalledWith({ owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: SELF }, 'results/fig.png');
    expect(docs.insertImage.mock.calls[0]!.slice(2, 4)).toEqual([{ parent: DOC, index: 0 }, { name: 'fig.png', data: PNG }]);
    expect(await service.imageDoc('alice', { document: DOC, data: `data:image/png;base64,${PNG.toString('base64')}`, name: 'chart' })).toMatchObject({ name: 'chart.png' });
    await expect(service.imageDoc('alice', { document: DOC, data: Buffer.from('<svg xmlns="x"></svg>').toString('base64') })).rejects.toThrow('SVG');
    await expect(service.imageDoc('alice', { document: DOC, path: 'fig.png' })).rejects.toThrow('data');
    files.resolve.mockRejectedValueOnce(new DocsAddonError(404, '这个路径不在所有者登记的任何工作区里'));
    await expect(service.imageDoc('alice', { document: DOC, path: '/opt/elsewhere/fig.png' }, caller)).rejects.toThrow('已登记的某个工作区');
    await expect(service.imageDoc('alice', { document: DOC }, caller)).rejects.toMatchObject({ status: 400 });
  });

  it('deletes blocks by id, taking any Octopus card among them out properly', async () => {
    const { docs, shares } = setup();
    await service.place('alice', { document: DOC, session: OTHER });
    const share = ((docs.insertAddOn.mock.calls[0] as unknown[])[3] as { octopusAgent: { share: string } }).octopusAgent.share;
    docs.block.mockImplementation(async (_o: string, _d: string, id: string) => id === 'card'
      ? { block_type: 40, parent_id: DOC, add_ons: { component_type_id: 'blk_widget', record: JSON.stringify({ octopusAgent: { v: 2, share } }) } }
      : { block_type: 2, parent_id: 'p9' });
    expect(await service.deleteDoc('alice', { document: DOC, blocks: 'a0, a0plan card' }, caller)).toMatchObject({ deleted: 3, cards_removed: ['card'] });
    expect(docs.deleteBlock.mock.calls.map((call) => (call as unknown[])[2])).toEqual([{ id: 'a0', parent: 'p9' }, { id: 'a0plan', parent: 'p9' }, { id: 'card', parent: DOC }]);
    expect(shares.liveCounts('alice').size).toBe(0);
    await expect(service.deleteDoc('alice', { document: DOC, blocks: DOC })).rejects.toThrow('整篇文档');
  });
});
