import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeMcpTokenPolicy, mcpCredentialOf } from '../mcp/tokens.js';
import { FEISHU_DOC_SHARE_TOOLS, type McpFieldSpec } from '../mcp/tools.js';
import { hashRunnerToken } from '../runner/gateway.js';
import { Store } from '../store/store.js';
import type { CardPayload } from './direct-card.js';
import { FeishuDocsAddonAuth } from './docs-addon-auth.js';
import { FeishuDocsAddonService } from './docs-addon.js';
import { FeishuDocsClient, type DocBlock } from './docs-openapi.js';
import {
  anchorBlock, APP_ACCESS_MS, FeishuDocShareService, HOST_MATCH_MS, KEY_NOTICE_MS, markdownPage, PANEL_RECHECK_MS, SELF_SERVE_PER_HOUR, SHARE_ANCHOR_LEASE_MS, SHARES_PER_CARD,
  type DocShareViewer,
} from './doc-share.js';
import { APP_TOKEN, FakeFeishuDocs, userToken } from './fake-feishu-docs.helper.js';

const DOC = 'DocxToken1234567890abcdefg';
const WIKI = 'WikiToken1234567890abcdefgh';
const WIDGET = 'blk_widget';
const PUBLIC = 'https://octopus.example/';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const SECRET = /mcp_|claude mcp add|Bearer|dsa_|dsi_/;
const LHT: DocShareViewer = { openId: 'ou_lht', username: 'lht' };
const BOB: DocShareViewer = { openId: 'ou_bob', username: 'bob' };
/** A tenant member signed in on the card, with no Octopus account. */
const GUEST: DocShareViewer = { openId: 'ou_guest_123456', username: null };

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

function setup(options: { componentTypeId?: string; publicUrl?: string } = {}) {
  const store = new Store(':memory:');
  for (const [i, username] of ['lht', 'bob'].entries()) store.saveUser({ username, uid: 5001 + i, home_dir: `/fixture/${username}`, created_at: '2026-10-27T00:00:00Z' });
  const feishu = new FakeFeishuDocs();
  feishu.addDoc(DOC, '论文初稿', ['引言', '方法']);
  feishu.grant(DOC, 'lht', 'edit');
  feishu.grant(DOC, 'app', 'edit');
  const clock = { now: 1_800_000_000_000 };
  const dms: Array<{ owner: string; card: CardPayload }> = [];
  const notifyOwner = vi.fn(async (owner: string, card: CardPayload) => { dms.push({ owner, card }); });
  const docs = new FeishuDocsClient(async (owner) => userToken(owner), feishu.fetch, async () => APP_TOKEN);
  const service = new FeishuDocShareService({
    links: store.feishuDocShareLinks, tokens: store, docs, componentTypeId: WIDGET, publicUrl: PUBLIC, notifyOwner, now: () => clock.now, ...options,
  });
  closers.push(() => store.close());
  const links = store.feishuDocShareLinks;
  /** The capability in the control card's Record: what the card itself holds. */
  const capabilityOf = (shareId: string) => {
    const anchor = links.anchor(links.share(shareId)!.anchorId)!;
    const card = feishu.records(anchor.documentId).find((record) => record.id === anchor.blockId)!;
    return (card.record as { octopusShare: { anchor: string } }).octopusShare.anchor;
  };
  const create = async (owner: string, input: { document: string; label: string; rights?: string }) => {
    const answer = await service.create(owner, input) as { share_id: string; label: string; rights: string; status: string; document: { id: string }; owner_notified: boolean };
    const share = links.share(answer.share_id)!;
    return { answer, share, anchor: links.anchor(share.anchorId)! };
  };
  /** The owner, signed in on the card, takes the command. */
  const reveal = async (shareId: string, viewer: DocShareViewer | null = LHT) => {
    const revealed = await service.reveal(viewer, capabilityOf(shareId), shareId);
    return { ...revealed, token: /Bearer (mcp_[0-9a-f]+)"$/.exec(revealed.command)![1] };
  };
  /** The owner's control card in DOC, placed by a first (pending) share of theirs: its capability and anchor. */
  const card = async () => {
    const made = await create('lht', { document: DOC, label: '所有者的共享' });
    return { capability: capabilityOf(made.share.id), anchor: made.anchor, owners: made.share.id };
  };
  /** A reader takes a key on the card, which sits in DOC unless `hostToken` says otherwise. */
  const take = (capability: string, viewer: DocShareViewer | null, rights = 'write', label = '张老师', hostToken = DOC) =>
    service.selfServe({ capability, hostToken, label, rights, viewer });
  const tokens = () => store.listMcpTokens('lht').length;
  return { store, feishu, service, clock, links, dms, notifyOwner, create, reveal, capabilityOf, card, take, tokens };
}

const refusal = (run: () => unknown): unknown => { try { run(); } catch (error) { return error; } throw new Error('did not refuse'); };

describe('anchor detection', () => {
  const cap = `dsa_${'A'.repeat(43)}`;
  const card = (id: string, component: string, record: string): DocBlock => ({ id, parent: DOC, children: [], text: '', type: 40, addOn: { component, record } });
  it('finds only our widget whose Record names a capability hashing to the anchor', () => {
    const blocks: DocBlock[] = [
      { id: DOC, parent: '', children: ['p', 'a', 'b', 'c', 'd', 'e'], text: '' },
      { id: 'p', parent: DOC, children: [], text: `{"octopusShare":{"v":1,"anchor":"${cap}"}}`, type: 2 },
      card('a', 'blk_other', JSON.stringify({ octopusShare: { v: 1, anchor: cap } })),
      card('b', WIDGET, '{not json'),
      card('c', WIDGET, JSON.stringify({ octopusAgent: { v: 2, share: cap } })),
      card('d', WIDGET, JSON.stringify({ octopusShare: { v: 1, anchor: `dsa_${'B'.repeat(43)}` } })),
      card('e', WIDGET, JSON.stringify({ octopusShare: { v: 1, anchor: cap } })),
    ];
    expect(anchorBlock(blocks, WIDGET, digest(cap))?.id).toBe('e');
    expect(anchorBlock(blocks.slice(0, 6), WIDGET, digest(cap))).toBeUndefined();
    expect(anchorBlock([card('x', WIDGET, 'null'), card('y', WIDGET, JSON.stringify({ octopusShare: { anchor: 'dsa_short' } }))], WIDGET, digest('dsa_short'))).toBeUndefined();
  });
});

describe('reading a shared document as Markdown', () => {
  it('marks every block with its id and kind, and pages by characters without losing a block', () => {
    const blocks: DocBlock[] = [
      { id: DOC, parent: '', children: ['h', 'l', 'c', 'q'], text: '' },
      { id: 'h', parent: DOC, children: [], text: '引言', type: 4 },
      { id: 'l', parent: DOC, children: ['l2'], text: '要点', type: 12 },
      { id: 'l2', parent: 'l', children: [], text: '细节', type: 12 },
      { id: 'c', parent: DOC, children: [], text: 'a ``` b', type: 14 },
      { id: 'q', parent: DOC, children: [], text: '一\n二', type: 15 },
    ];
    expect(markdownPage(blocks, DOC).markdown).toBe([
      '<!-- h · h2 -->', '## 引言', '<!-- l · bullet -->', '- 要点', '<!-- l2 · bullet -->', '  - 细节',
      '<!-- c · code -->', '````', 'a ``` b', '````', '<!-- q · quote -->', '> 一', '> 二',
    ].join('\n'));
    const first = markdownPage(blocks, DOC, 0, 50);
    expect(first).toMatchObject({ total: 5, from: 0, next: 2 });
    const rest = markdownPage(blocks, DOC, first.next, 1);
    expect(rest).toMatchObject({ from: 2, next: 3, markdown: '<!-- l2 · bullet -->\n  - 细节' });
    const long = markdownPage([{ id: DOC, parent: '', children: ['t'], text: '' }, { id: 't', parent: DOC, children: [], text: 'x'.repeat(25_000), type: 2 }], DOC);
    expect(long.markdown).toContain('本块共 25000 字');
    expect(long.markdown.length).toBeLessThan(21_000);
  });
});

describe('creating a share', () => {
  it('tells the owner to add the Octopus app when the app cannot read the document, and creates nothing', async () => {
    const { feishu, service, store, links, notifyOwner } = setup();
    feishu.revoke(DOC, 'app');
    await expect(service.create('lht', { document: `https://t.feishu.cn/docx/${DOC}`, label: '张老师' }))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining('「…」→「添加文档应用」') });
    expect(feishu.records(DOC)).toEqual([]);
    expect(store.listMcpTokens('lht')).toEqual([]);
    expect(links.ownedShares('lht')).toEqual([]);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('makes a pending share with no token, and tells the owner where to take it without any secret', async () => {
    const { feishu, store, create, dms, clock } = setup();
    const made = await create('lht', { document: `https://t.feishu.cn/docx/${DOC}`, label: '  张老师 ', rights: 'write' });
    expect(made.answer).toEqual({ share_id: expect.stringMatching(/^shr_[0-9a-f]{24}$/), label: '张老师', rights: 'write', status: 'pending',
      document: { id: DOC, title: '论文初稿', url: `https://t.feishu.cn/docx/${DOC}` }, next: '在文档的 Octopus 控制卡片上点「显示接入命令」领取（只显示一次）',
      owner_notified: true, notice: expect.any(String), app_access: 'edit' });
    expect(JSON.stringify(made.answer)).not.toMatch(SECRET);
    expect(made.share).toMatchObject({ status: 'pending', mcpTokenHash: null });
    expect(store.listMcpTokens('lht')).toEqual([]);
    expect(dms).toHaveLength(1);
    const notice = JSON.stringify(dms[0].card);
    expect(notice).not.toMatch(SECRET);
    for (const part of ['论文初稿', '张老师', '读写', '显示接入命令', '只显示一次', '终止']) expect(notice, part).toContain(part);

    // The control card: at the end of the body, put in as the owner, with exactly the Record; only its hash is kept.
    const [card] = feishu.records(DOC);
    const anchor = (card.record as { octopusShare: { v: number; anchor: string } }).octopusShare.anchor;
    expect(card).toEqual({ id: made.anchor.blockId, component: WIDGET, record: { octopusShare: { v: 1, anchor } } });
    expect(anchor).toMatch(/^dsa_[A-Za-z0-9_-]{43}$/);
    expect(feishu.blocksOf(DOC)[0].children!.at(-1)).toBe(card.id);
    expect(feishu.requests.find((request) => request.method === 'POST' && request.path.endsWith('/children'))!.as).toBe('lht');
    expect(made.anchor).toMatchObject({ capabilityHash: digest(anchor), state: 'present', leaseUntil: clock.now + SHARE_ANCHOR_LEASE_MS, wikiToken: null });
    expect(JSON.stringify([store.feishuDocShareLinks.ownedShares('lht'), made.anchor])).not.toContain(anchor);
    // Feishu was asked, as the owner, about the document's own identity; the app read the document.
    expect(feishu.requests.some((request) => request.as === 'lht' && request.path === `drive/v1/permissions/${DOC}/members/auth` && request.query.get('action') === 'share' && request.query.get('type') === 'docx')).toBe(true);
    expect(feishu.requests.some((request) => request.as === 'app' && request.method === 'GET' && request.path === `docx/v1/documents/${DOC}`)).toBe(true);
  });

  it('keeps the share pending and answers normally when the notice cannot be delivered', async () => {
    const { service, notifyOwner, links } = setup();
    notifyOwner.mockRejectedValueOnce(new Error('Bot has NO availability to this user'));
    const answer = await service.create('lht', { document: DOC, label: '张老师' }) as { share_id: string; owner_notified: boolean; notice: string };
    expect(answer).toMatchObject({ owner_notified: false, notice: expect.stringContaining('控制卡片') });
    expect(links.share(answer.share_id)!.status).toBe('pending');
  });

  it('asks Feishu, as the owner, at every create — a card already there or not — whether the owner may share', async () => {
    const { feishu, service, create, store, notifyOwner } = setup();
    await create('lht', { document: DOC, label: 'A' });
    feishu.noShare.add(`${DOC}:lht`);
    const before = feishu.records(DOC).length;
    await expect(service.create('lht', { document: DOC, label: 'B' })).rejects.toMatchObject({ status: 403, message: expect.stringContaining('不能分享这篇文档') });
    expect(feishu.records(DOC)).toHaveLength(before);
    expect(store.feishuDocShareLinks.ownedShares('lht')).toHaveLength(1);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    feishu.grant(DOC, 'bob', 'read');
    await expect(service.create('bob', { document: DOC, label: 'x' })).rejects.toMatchObject({ status: 403 });
    expect(feishu.records(DOC)).toHaveLength(before);
    await expect(service.create('lht', { document: DOC, label: ' ' })).rejects.toMatchObject({ status: 400 });
    await expect(service.create('lht', { document: DOC, label: 'x', rights: 'admin' })).rejects.toMatchObject({ status: 400 });
  });

  it('reuses the owner\'s card once it finds it there, and puts in a new one when it is gone — even within the lease', async () => {
    const { feishu, create, links, clock } = setup();
    const listings = () => feishu.requests.filter((request) => request.as === 'app' && request.path === `docx/v1/documents/${DOC}/blocks`).length;
    const first = await create('lht', { document: DOC, label: 'A' });
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    const before = listings();
    const second = await create('lht', { document: DOC, label: 'B', rights: 'read' });
    expect(second.anchor.id).toBe(first.anchor.id);
    expect(listings()).toBe(before + 1);
    expect(feishu.records(DOC)).toHaveLength(1);
    expect(links.anchor(first.anchor.id)).toMatchObject({ state: 'present', leaseUntil: clock.now + SHARE_ANCHOR_LEASE_MS });
    feishu.delete(DOC, first.anchor.blockId!);
    clock.now += 60 * 60_000;
    const third = await create('lht', { document: DOC, label: 'C' });
    expect(third.anchor.id).not.toBe(first.anchor.id);
    expect(links.anchor(first.anchor.id)!.state).toBe('missing');
    expect(feishu.records(DOC).map((record) => record.id)).toEqual([third.anchor.blockId]);
  });

  it('pins the document to its canonical identity: the wiki node holding it, looked up from the docx id, whatever was named', async () => {
    const { feishu, service, create, links } = setup();
    feishu.wiki.set(WIKI, { obj_type: 'docx', obj_token: DOC, title: '论文初稿' });
    feishu.wiki.set('Shortcut1234567890abcdefgh', { obj_type: 'docx', obj_token: DOC, title: '论文初稿', node_type: 'shortcut' });
    await expect(service.create('lht', { document: 'https://t.feishu.cn/wiki/Shortcut1234567890abcdefgh', label: 'x' }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('快捷方式') });
    expect(feishu.records(DOC)).toEqual([]);
    // Named by its docx link, a wiki document still gets its node: Feishu is asked about the node.
    const made = await create('lht', { document: `https://t.feishu.cn/docx/${DOC}`, label: 'A' });
    expect(made.anchor.wikiToken).toBe(WIKI);
    expect(feishu.requests.some((request) => request.path === 'wiki/v2/spaces/get_node' && request.query.get('token') === DOC && request.query.get('obj_type') === 'docx')).toBe(true);
    const asked = () => feishu.requests.filter((request) => request.as === 'lht' && request.path.endsWith('/members/auth')).map((request) => `${request.query.get('type')}:${request.path.split('/')[3]}`);
    expect(asked().at(-1)).toBe(`wiki:${WIKI}`);
    // Parallel creates share one card.
    const [a, b] = await Promise.all([
      service.create('lht', { document: `https://t.feishu.cn/wiki/${WIKI}`, label: 'B' }) as Promise<{ share_id: string }>,
      service.create('lht', { document: DOC, label: 'C' }) as Promise<{ share_id: string }>,
    ]);
    expect(new Set([made.anchor.id, links.share(a.share_id)!.anchorId, links.share(b.share_id)!.anchorId]).size).toBe(1);
    expect(feishu.records(DOC)).toHaveLength(1);
  });

  it('refuses a wiki answer that does not name this very docx as an origin node', async () => {
    const { feishu, service } = setup();
    for (const node of [
      { node_token: 'Other1234567890abcdefghij', node_type: 'origin', title: '别的文档' },
      { node_token: 'Other1234567890abcdefghij', node_type: 'origin', obj_type: 'docx', obj_token: 'OtherDoc1234567890abcdefg', title: '别的文档' },
      { node_token: 'Other1234567890abcdefghij', obj_type: 'docx', obj_token: DOC, title: '论文初稿' },
    ]) {
      feishu.wikiAnswers.set(DOC, node);
      await expect(service.create('lht', { document: DOC, label: 'x' })).rejects.toMatchObject({ status: 502 });
    }
    expect(feishu.records(DOC)).toEqual([]);
    expect(feishu.requests.some((request) => request.path.endsWith('/members/auth'))).toBe(false);
  });

  it('never rewrites a card\'s identity, and asks Feishu about the stored one at create and at renewal', async () => {
    const { feishu, service, create, reveal, clock, links } = setup();
    const made = await create('lht', { document: DOC, label: 'A' });
    expect(made.anchor.wikiToken).toBeNull();
    // The document moves into a wiki afterwards; the card keeps the identity it was made with.
    feishu.wiki.set(WIKI, { obj_type: 'docx', obj_token: DOC, title: '论文初稿' });
    const auths = () => feishu.requests.filter((request) => request.as === 'lht' && request.path.endsWith('/members/auth')).map((request) => `${request.query.get('type')}:${request.path.split('/')[3]}`);
    const before = auths().length;
    await create('lht', { document: `https://t.feishu.cn/wiki/${WIKI}`, label: 'B' });
    expect(links.anchor(made.anchor.id)!.wikiToken).toBeNull();
    expect(auths().slice(before).every((asked) => asked === `docx:${DOC}`)).toBe(true);
    const { token } = await reveal(made.share.id);
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    const renewal = auths().length;
    await service.authorize({ shareId: made.share.id, owner: 'lht', credential: mcpCredentialOf(hashRunnerToken(token)) }, 'read');
    expect(auths().slice(renewal)).toEqual([`docx:${DOC}`]);
  });

  it('is made only for an https public URL that a collaborator outside can reach', async () => {
    for (const publicUrl of [undefined, 'http://octopus.example', 'https://localhost:9820', 'https://127.0.0.1', 'not a url', "https://octopus.example/it's", 'https://octopus.example/%41', 'https://octopus.example/a b']) {
      const { service, feishu, store } = setup({ publicUrl });
      await expect(service.create('lht', { document: DOC, label: 'x' }), String(publicUrl)).rejects.toMatchObject({ status: 503, message: expect.stringContaining('https') });
      expect(feishu.requests).toEqual([]);
      expect(store.feishuDocShareLinks.ownedShares('lht')).toEqual([]);
    }
  });

  it('is disabled with a clear error while the widget\'s block type id is not configured', async () => {
    const { service } = setup({ componentTypeId: undefined });
    for (const run of [() => service.create('lht', { document: DOC, label: 'x' }), () => service.list('lht'), async () => service.update('lht', 'shr_0', 'pause')]) {
      await expect(run()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('block_type_id') });
    }
    await expect(service.authorize({ shareId: `shr_${'0'.repeat(24)}`, owner: 'lht', credential: 'mcp:x' }, 'read')).rejects.toMatchObject({ status: 503 });
  });
});

describe('revealing a share on its card', () => {
  it('is for the owner signed in on the card, once: the token is minted and the share activated together', async () => {
    const { service, create, reveal, capabilityOf, store, links, feishu } = setup();
    const made = await create('lht', { document: DOC, label: '张老师' });
    const capability = capabilityOf(made.share.id);
    for (const viewer of [BOB, GUEST, null]) await expect(service.reveal(viewer, capability, made.share.id)).rejects.toMatchObject({ status: 403, message: 'not_owner' });
    await expect(service.reveal(LHT, capability, 'shr_000000000000000000000000')).rejects.toMatchObject({ status: 404, message: 'unknown_share' });
    await expect(service.reveal(LHT, `dsa_${'A'.repeat(43)}`, made.share.id)).rejects.toMatchObject({ status: 404, message: 'unknown_anchor' });
    expect(store.listMcpTokens('lht')).toEqual([]);

    const revealed = await reveal(made.share.id);
    expect(revealed.share).toEqual({ id: made.share.id, status: 'active', label: '张老师', rights: 'write', created_at: made.share.createdAt, last_used_at: null, via: 'owner', mine: false });
    expect(revealed.command).toMatch(/^claude mcp add --transport http --scope user octopus-doc-[0-9a-f]{6} https:\/\/octopus\.example\/api\/mcp --header "Authorization: Bearer mcp_[0-9a-f]{32}"$/);
    // The command is the Claude Code way in; the others hold the same token.
    expect(revealed.connect).toEqual({ claude: revealed.command, codex: expect.stringContaining(`Bearer ${revealed.token}`), endpoint: 'https://octopus.example/api/mcp', token: revealed.token });
    const [row] = store.listMcpTokens('lht');
    expect(row).toMatchObject({ token_hash: hashRunnerToken(revealed.token), expires_at: null, revoked_at: null, label: '飞书文档共享 · 张老师' });
    expect(decodeMcpTokenPolicy(row.policy_json)).toEqual({ schema: 'mcp-token-policy/v1', groups: [], feishuDocShare: { shareId: made.share.id } });
    expect(links.share(made.share.id)).toMatchObject({ status: 'active', mcpTokenHash: row.token_hash });
    expect(JSON.stringify(links.ownedShares('lht'))).not.toContain(revealed.token);
    await expect(service.reveal(LHT, capability, made.share.id)).rejects.toMatchObject({ status: 409, message: 'not_pending' });
    expect(store.listMcpTokens('lht')).toHaveLength(1);
    // Feishu was asked again, as the owner, before the token was minted.
    expect(feishu.requests.filter((request) => request.path.endsWith('/members/auth') && request.as === 'lht').length).toBeGreaterThanOrEqual(2);
  });

  it('reveals once even when two reveals race past the first look', async () => {
    const { service, create, capabilityOf, store, links } = setup();
    const made = await create('lht', { document: DOC, label: 'A' });
    const capability = capabilityOf(made.share.id);
    const outcomes = await Promise.allSettled([service.reveal(LHT, capability, made.share.id), service.reveal(LHT, capability, made.share.id)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: { status: 409, message: 'not_pending' } });
    const [row] = store.listMcpTokens('lht');
    expect(store.listMcpTokens('lht')).toHaveLength(1);
    expect(links.share(made.share.id)).toMatchObject({ status: 'active', mcpTokenHash: row.token_hash });
  });

  it('mints nothing when activation fails, and refuses a share no longer pending or whose owner may no longer share', async () => {
    const { service, create, capabilityOf, store, links, feishu } = setup();
    const first = await create('lht', { document: DOC, label: 'A' });
    const second = await create('lht', { document: DOC, label: 'B' });
    const capability = capabilityOf(first.share.id);
    const activate = vi.spyOn(links, 'activate').mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(service.reveal(LHT, capability, first.share.id)).rejects.toThrow('disk full');
    activate.mockRestore();
    expect(store.listMcpTokens('lht')).toEqual([]);
    expect(links.share(first.share.id)).toMatchObject({ status: 'pending', mcpTokenHash: null });
    service.update('lht', second.share.id, 'terminate');
    await expect(service.reveal(LHT, capability, second.share.id)).rejects.toMatchObject({ status: 409, message: 'not_pending' });
    feishu.noShare.add(`${DOC}:lht`);
    await expect(service.reveal(LHT, capability, first.share.id)).rejects.toMatchObject({ status: 403 });
    expect(store.listMcpTokens('lht')).toEqual([]);
    expect(links.share(first.share.id)!.status).toBe('pending');
  });

  it('leaves a pending share uncallable: no tools, and every call refused', async () => {
    const { service, create } = setup();
    const made = await create('lht', { document: DOC, label: 'A' });
    const caller = { shareId: made.share.id, owner: 'lht', credential: mcpCredentialOf('0'.repeat(64)) };
    expect(service.toolNames(caller)).toEqual([]);
    await expect(service.authorize(caller, 'read')).rejects.toMatchObject({ status: 403 });
    await expect(service.call(caller, 'feishu_shared_doc_read', {})).rejects.toMatchObject({ status: 403 });
  });
});

describe('the owner manages shares', () => {
  it('lets an agent only pause and terminate; resuming a paused share takes the card; terminating revokes the token and is final', async () => {
    const { service, store, clock, create, reveal, capabilityOf } = setup();
    const made = await create('lht', { document: DOC, label: 'A' });
    const id = made.share.id;
    // Pending: nothing to pause or resume, but it can be terminated.
    expect(refusal(() => service.update('lht', id, 'pause'))).toMatchObject({ status: 409, message: expect.stringContaining('还没有领取') });
    await expect(service.act(LHT, capabilityOf(id), id, 'resume')).rejects.toMatchObject({ status: 409, message: 'pending' });
    const { token } = await reveal(id);
    expect(refusal(() => service.update('bob', id, 'pause'))).toMatchObject({ status: 404 });
    expect(service.update('lht', id, 'pause')).toMatchObject({ share: { status: 'paused' } });
    expect(refusal(() => service.update('lht', id, 'resume'))).toMatchObject({ status: 400, message: expect.stringContaining('控制卡片') });
    await expect(service.act(LHT, capabilityOf(id), id, 'resume')).resolves.toMatchObject({ share: { status: 'active' } });
    expect(refusal(() => service.update('lht', id, 'delete'))).toMatchObject({ status: 400 });
    expect(service.update('lht', id, 'terminate')).toMatchObject({ share: { status: 'terminated' } });
    expect(store.getActiveMcpTokenByHash(hashRunnerToken(token), new Date(clock.now).toISOString())).toBeUndefined();
    for (const action of ['pause', 'terminate']) expect(refusal(() => service.update('lht', id, action))).toMatchObject({ status: 409 });
    const pending = await create('lht', { document: DOC, label: 'B' });
    expect(service.update('lht', pending.share.id, 'terminate')).toMatchObject({ share: { status: 'terminated' } });
    const listed = (await service.list('lht')).shares as Array<{ share_id: string; status: string }>;
    expect(listed.map((each) => [each.share_id, each.status]).sort()).toEqual([[id, 'terminated'], [pending.share.id, 'terminated']].sort());
  });

  it('reads a revealed share whose token was revoked from the token list as terminated, and keeps it so', async () => {
    const { service, store, links, create, reveal } = setup();
    const made = await create('lht', { document: DOC, label: 'A' });
    const { token } = await reveal(made.share.id);
    store.revokeMcpToken('lht', hashRunnerToken(token), new Date().toISOString());
    expect((await service.list('lht', DOC)).shares).toEqual([expect.objectContaining({ status: 'terminated' })]);
    expect(refusal(() => service.update('lht', made.share.id, 'pause'))).toMatchObject({ status: 409 });
    expect(links.share(made.share.id)!.status).toBe('terminated');
    expect((await service.list('bob')).shares).toEqual([]);
  });

  it('hands every argument an owner share tool declares to the share service', async () => {
    const auth = new FeishuDocsAddonAuth({ tenantKey: 't', allowedOrigins: ['https://widget.feishu.cn'], verifyCode: async () => ({ openId: 'ou', tenantKey: 't' }) }, () => undefined, vi.fn());
    const docShares = { create: vi.fn(async () => ({})), list: vi.fn(async () => ({})), update: vi.fn(() => ({})) };
    const store = new Store(':memory:');
    const addon = new FeishuDocsAddonService(auth, { roster: vi.fn(), liveGrant: vi.fn(), decodeResourceId: vi.fn() } as never, { submit: vi.fn(), get: vi.fn() } as never,
      store.feishuDocsShares, undefined, Date.now, { docShares: docShares as never });
    closers.push(() => { addon.close(); auth.close(); store.close(); });
    const sample = (name: string, field: McpFieldSpec) => field.enum ? field.enum[0] : `v-${name}`;
    for (const spec of FEISHU_DOC_SHARE_TOOLS) {
      const args = Object.fromEntries(Object.entries(spec.fields).map(([name, field]) => [name, sample(name, field)]));
      await addon.agentTool(spec.name, 'lht', args);
    }
    expect(docShares.create).toHaveBeenCalledWith('lht', { document: 'v-document', label: 'v-label', rights: 'write' });
    expect(docShares.list).toHaveBeenCalledWith('lht', 'v-document');
    expect(docShares.update).toHaveBeenCalledWith('lht', 'v-share_id', 'pause');
    expect(FEISHU_DOC_SHARE_TOOLS.find((spec) => spec.name === 'feishu_doc_share_update')!.fields.action.enum).toEqual(['pause', 'terminate']);
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
/** The secret a claim link carries after `#i=`. */
const secretOf = (link: string | undefined) => new URL(link!).hash.slice('#i='.length);
const CONTROL = /[\u0000-\u001f\u007f]/;
const ELSEWHERE = 'ElsewhereNode1234567890abc';
const OTHER_DOC = 'OtherDocx1234567890abcdefg';

describe('readers take their own keys on the card', () => {
  it('mints an active key at once for anyone holding the card, signed in or not, and shows its ways in this once', async () => {
    const { service, store, links, clock, card, take } = setup();
    const { capability, owners } = await card();
    clock.now += 1000;
    const mine = await take(capability, BOB, 'write', '  张  老师 ');
    expect(mine.share).toEqual({ id: expect.stringMatching(/^shr_[0-9a-f]{24}$/), label: '张 老师', rights: 'write', status: 'active', created_at: clock.now, last_used_at: null, via: 'card', mine: true });
    const { connect } = mine;
    const name = `octopus-doc-${mine.share.id.slice(4, 10)}`;
    expect(connect.token).toMatch(/^mcp_[0-9a-f]{32}$/);
    expect(connect.endpoint).toBe('https://octopus.example/api/mcp');
    expect(connect.claude).toBe(`claude mcp add --transport http --scope user ${name} https://octopus.example/api/mcp --header "Authorization: Bearer ${connect.token}"`);
    expect(connect.codex).toBe(`printf '\\n[mcp_servers.${name}]\\nurl = "https://octopus.example/api/mcp"\\nhttp_headers = { Authorization = "Bearer ${connect.token}" }\\n' >> ~/.codex/config.toml`);
    // Each way in is one printable line; the Codex one is one single-quoted printf format with nothing for printf to expand but its `\n`s.
    for (const line of Object.values(connect)) expect(line).not.toMatch(CONTROL);
    const parts = connect.codex.split("'");
    expect(parts).toHaveLength(3);
    expect(parts[1]).not.toMatch(/%|\\[^n]/);
    expect(parts[1].replaceAll('\\n', '\n')).toBe(`\n[mcp_servers.${name}]\nurl = "https://octopus.example/api/mcp"\nhttp_headers = { Authorization = "Bearer ${connect.token}" }\n`);
    // The token is the card owner's, names this one share, and exists in the answer only.
    const row = store.listMcpTokens('lht').find((each) => each.token_hash === hashRunnerToken(connect.token))!;
    expect(row).toMatchObject({ username: 'lht', label: '飞书文档共享 · 张 老师', expires_at: null, revoked_at: null });
    expect(decodeMcpTokenPolicy(row.policy_json)).toEqual({ schema: 'mcp-token-policy/v1', groups: [], feishuDocShare: { shareId: mine.share.id } });
    expect(links.share(mine.share.id)).toMatchObject({ owner: 'lht', documentId: DOC, status: 'active', via: 'card', mintedBy: 'ou_bob', mcpTokenHash: row.token_hash });
    expect(JSON.stringify(links.ownedShares('lht'))).not.toContain(connect.token);
    const caller = { shareId: mine.share.id, owner: 'lht', credential: mcpCredentialOf(row.token_hash) };
    expect(service.toolNames(caller)).toHaveLength(6);
    await expect(service.authorize(caller, 'write')).resolves.toMatchObject({ id: mine.share.id });

    // Not signed in: the card alone is enough.
    clock.now += 1000;
    const theirs = await take(capability, null, 'read', '路过的人');
    expect(theirs.share).toMatchObject({ via: 'card', mine: false, rights: 'read', status: 'active' });
    expect(links.share(theirs.share.id)!.mintedBy).toBeNull();
    expect(service.toolNames({ shareId: theirs.share.id, owner: 'lht', credential: mcpCredentialOf(hashRunnerToken(theirs.connect.token)) })).toHaveLength(3);
    // Each signed-in reader finds their own keys marked as theirs.
    const listed = async (viewer: DocShareViewer | null) => (await service.panel(viewer, capability, DOC)).shares.map((share) => [share.id, share.via, share.mine]);
    expect(await listed(BOB)).toEqual([[theirs.share.id, 'card', false], [mine.share.id, 'card', true], [owners, 'owner', false]]);
    for (const viewer of [GUEST, LHT, null]) expect(await listed(viewer)).toEqual([[theirs.share.id, 'card', false], [mine.share.id, 'card', false], [owners, 'owner', false]]);
  });

  it('keeps within the most the owner allows, which only the owner sets', async () => {
    const { service, card, take, tokens } = setup();
    const { capability } = await card();
    for (const viewer of [BOB, GUEST, null]) await expect(service.settings(viewer, capability, 'off')).rejects.toMatchObject({ status: 403, message: 'not_owner' });
    await expect(service.settings(LHT, capability, 'admin')).rejects.toMatchObject({ status: 400 });
    expect(await service.settings(LHT, capability, 'read', DOC)).toMatchObject({ self_serve: 'read', viewer_is_owner: true, host_matches: true });
    await expect(take(capability, BOB, 'write')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('只读') });
    await expect(take(capability, BOB, 'read')).resolves.toMatchObject({ share: { rights: 'read' } });
    await service.settings(LHT, capability, 'off');
    for (const rights of ['read', 'write']) await expect(take(capability, BOB, rights)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('没有开放') });
    expect(tokens()).toBe(1);
    await service.settings(LHT, capability, 'write');
    for (const [rights, label] of [['admin', 'x'], ['write', '  '], ['write', 'x'.repeat(61)]]) await expect(take(capability, BOB, rights, label), `${rights} ${label}`).rejects.toMatchObject({ status: 400 });
    await expect(take(capability, BOB, 'write', 'x'.repeat(60))).resolves.toMatchObject({ share: { rights: 'write' } });
    await expect(take(`dsa_${'A'.repeat(43)}`, BOB)).rejects.toMatchObject({ status: 404, message: 'unknown_anchor' });
    expect(tokens()).toBe(2);
  });

  it('refuses a card copied into another document, or one whose document cannot be matched, and mints nothing', async () => {
    const { feishu, card, take, tokens } = setup();
    const { capability } = await card();
    feishu.wiki.set(ELSEWHERE, { obj_type: 'docx', obj_token: OTHER_DOC, title: '另一篇' });
    for (const host of ['', '../x', OTHER_DOC, ELSEWHERE, 'UnknownNode1234567890abcdef']) {
      await expect(take(capability, BOB, 'write', 'x', host), host).rejects.toMatchObject({ status: 403, message: expect.stringContaining('不能在这里领取') });
    }
    expect(tokens()).toBe(0);
    // The document's own wiki node is the document.
    feishu.wiki.set(WIKI, { obj_type: 'docx', obj_token: DOC, title: '论文初稿' });
    await expect(take(capability, null, 'write', 'x', WIKI)).resolves.toMatchObject({ share: { status: 'active' } });
  });

  it('takes a key only from a card vouched for now: one gone, or that cannot be looked for, refuses', async () => {
    const { feishu, links, clock, card, take, tokens } = setup();
    const { capability, anchor } = await card();
    feishu.delete(DOC, anchor.blockId!);
    // Within its lease the last sighting still vouches for the card.
    await expect(take(capability, BOB)).resolves.toMatchObject({ share: { status: 'active' } });
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    await expect(take(capability, BOB)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('控制卡片') });
    expect(links.anchor(anchor.id)!.state).toBe('missing');
    // A card read missing is looked for again at most once a minute.
    await expect(take(capability, BOB)).rejects.toMatchObject({ status: 403 });
    const listings = () => feishu.requests.filter((request) => request.path === `docx/v1/documents/${DOC}/blocks`).length;
    const quiet = listings();
    feishu.append(DOC, { block_type: 40, add_ons: { component_type_id: WIDGET, record: JSON.stringify({ octopusShare: { v: 1, anchor: capability } }) } });
    await expect(take(capability, BOB)).rejects.toMatchObject({ status: 403 });
    expect(listings()).toBe(quiet);
    clock.now += PANEL_RECHECK_MS;
    await expect(take(capability, BOB)).resolves.toMatchObject({ share: { status: 'active' } });
    expect(links.anchor(anchor.id)).toMatchObject({ state: 'present', leaseUntil: clock.now + SHARE_ANCHOR_LEASE_MS });
    // Past the lease, a check that cannot finish refuses and changes nothing.
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    feishu.intercept = (request) => request.path.endsWith('/blocks') ? 'network' : undefined;
    const before = tokens();
    await expect(take(capability, BOB)).rejects.toMatchObject({ status: 503, message: expect.stringContaining('请稍后重试') });
    expect(tokens()).toBe(before);
    expect(links.anchor(anchor.id)!.state).toBe('present');
    // Feishu saying the owner may no longer share it refuses too, with the reason.
    feishu.intercept = null;
    feishu.noShare.add(`${DOC}:lht`);
    await expect(take(capability, BOB)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('所有者') });
    expect(tokens()).toBe(before);
  });

  it('lets readers take ten keys a card in a rolling hour, on the card and through its claim link together', async () => {
    const { service, clock, card, take, tokens } = setup();
    const { capability } = await card();
    const secret = secretOf(service.invite(LHT, capability, 'create').link);
    for (let i = 0; i < SELF_SERVE_PER_HOUR; i++) {
      if (i % 2) await service.inviteClaim(secret, `链接 ${i}`, 'read');
      else await take(capability, null, 'read', `卡片 ${i}`);
      clock.now += 60_000;
    }
    for (const run of [() => take(capability, BOB, 'read', '多一个'), () => service.inviteClaim(secret, '多一个', 'read')]) {
      await expect(run()).rejects.toMatchObject({ status: 429, message: expect.stringContaining(`${SELF_SERVE_PER_HOUR} 个`) });
    }
    expect(tokens()).toBe(SELF_SERVE_PER_HOUR);
    // The owner's own shares are not readers' keys: they are not counted here.
    await expect(service.create('lht', { document: DOC, label: '所有者再建一个' })).resolves.toMatchObject({ status: 'pending' });
    // An hour after the first, one more fits; then the window is full again.
    clock.now += 60 * 60_000 - SELF_SERVE_PER_HOUR * 60_000;
    await expect(take(capability, BOB, 'read', '一小时后')).resolves.toMatchObject({ share: { status: 'active' } });
    await expect(take(capability, BOB, 'read', '再多一个')).rejects.toMatchObject({ status: 429 });
  });

  it('refuses a reader\'s key once fifty keys of the card are not terminated, whoever made them', async () => {
    const { service, links, clock, card, take, tokens } = setup();
    const { capability, anchor, owners } = await card();
    // The owner's pending share is one; their agent made the rest.
    for (let i = 1; i < SHARES_PER_CARD; i++) {
      links.createShare({ id: `shr_${String(i).padStart(24, '0')}`, anchorId: anchor.id, owner: 'lht', documentId: DOC, label: `共享 ${i}`, rights: 'read', createdAt: clock.now });
    }
    await expect(take(capability, BOB, 'read')).rejects.toMatchObject({ status: 429, message: expect.stringContaining(`${SHARES_PER_CARD} 个`) });
    expect(tokens()).toBe(0);
    await service.act(BOB, capability, owners, 'terminate', DOC);
    await expect(take(capability, BOB, 'read')).resolves.toMatchObject({ share: { status: 'active' } });
    await expect(take(capability, BOB, 'read')).rejects.toMatchObject({ status: 429 });
  });

  it('mints the token and the key together, or neither', async () => {
    const { links, card, take, tokens } = setup();
    const { capability, anchor } = await card();
    const insert = vi.spyOn(links, 'createActiveShare').mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(take(capability, BOB)).rejects.toThrow('disk full');
    insert.mockRestore();
    expect(tokens()).toBe(0);
    expect(links.anchorShares(anchor.id).filter((share) => share.via !== 'owner')).toEqual([]);
    await expect(take(capability, BOB)).resolves.toMatchObject({ share: { status: 'active' } });
    expect(tokens()).toBe(1);
  });

  it('lets a ceiling lowered, or a claim link replaced, while the checks ran win', async () => {
    const { service, feishu, links, clock, card, take, tokens } = setup();
    const { capability, anchor } = await card();
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    // The owner turns self-serve off while the card is being looked for.
    feishu.intercept = (request) => {
      if (request.path.endsWith('/blocks')) { feishu.intercept = null; links.setSelfServe(anchor.id, 'off'); }
      return undefined;
    };
    await expect(take(capability, BOB)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('没有开放') });
    expect(tokens()).toBe(0);
    links.setSelfServe(anchor.id, 'write');
    const secret = secretOf(service.invite(LHT, capability, 'create').link);
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    feishu.intercept = (request) => {
      if (request.path.endsWith('/blocks')) { feishu.intercept = null; service.invite(LHT, capability, 'create'); }
      return undefined;
    };
    await expect(service.inviteClaim(secret, '外校老师', 'read')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('领取链接') });
    expect(tokens()).toBe(0);
  });
});

describe('the claim link', () => {
  it('is the owner\'s to make, replace and stop; only its hash is kept, and a replaced or stopped link stops at once', async () => {
    const { service, links, clock, card } = setup();
    const { capability, anchor } = await card();
    for (const viewer of [BOB, GUEST, null]) expect(refusal(() => service.invite(viewer, capability, 'create'))).toMatchObject({ status: 403, message: 'not_owner' });
    expect(refusal(() => service.invite(LHT, capability, 'rotate'))).toMatchObject({ status: 400 });
    expect(links.anchor(anchor.id)!.inviteHash).toBeNull();
    const first = service.invite(LHT, capability, 'create');
    // The Dashboard's claim page on the public URL, the secret in its fragment.
    expect(first).toEqual({ invite: { active: true, created_at: clock.now }, link: expect.stringMatching(/^https:\/\/octopus\.example\/doc-key#i=dsi_[A-Za-z0-9_-]{43}$/) });
    const one = secretOf(first.link);
    expect(links.anchor(anchor.id)).toMatchObject({ inviteHash: digest(one), inviteCreatedAt: clock.now });
    expect(JSON.stringify(links.anchor(anchor.id))).not.toContain(one);
    await expect(service.inviteInfo(one)).resolves.toEqual({ doc_title: '论文初稿', self_serve: 'write' });
    expect((await service.panel(LHT, capability)).invite).toEqual({ active: true, created_at: clock.now });
    for (const viewer of [BOB, GUEST, null]) expect((await service.panel(viewer, capability)).invite).toBeNull();
    clock.now += 1000;
    const two = secretOf(service.invite(LHT, capability, 'create').link);
    expect(two).not.toBe(one);
    await expect(service.inviteInfo(one)).rejects.toMatchObject({ status: 404, message: expect.stringContaining('领取链接') });
    await expect(service.inviteClaim(one, 'x', 'read')).rejects.toMatchObject({ status: 404 });
    await expect(service.inviteInfo(two)).resolves.toMatchObject({ self_serve: 'write' });
    expect(service.invite(LHT, capability, 'revoke')).toEqual({ invite: { active: false, created_at: null } });
    await expect(service.inviteInfo(two)).rejects.toMatchObject({ status: 404 });
    await expect(service.inviteClaim(two, 'x', 'read')).rejects.toMatchObject({ status: 404 });
    expect((await service.panel(LHT, capability)).invite).toEqual({ active: false, created_at: null });
    for (const secret of ['', 'dsi_short', capability, `dsi_${'A'.repeat(43)}`]) await expect(service.inviteInfo(secret), secret).rejects.toMatchObject({ status: 404 });
  });

  it('takes a key with no host to match, within the card\'s own ceiling and presence', async () => {
    const { service, feishu, links, clock, card } = setup();
    const { capability, anchor } = await card();
    const secret = secretOf(service.invite(LHT, capability, 'create').link);
    const before = feishu.requests.length;
    const taken = await service.inviteClaim(secret, ' 外校  老师 ', 'write');
    expect(taken.share).toEqual({ id: expect.stringMatching(/^shr_/), label: '外校 老师', rights: 'write', status: 'active', created_at: clock.now, last_used_at: null, via: 'invite', mine: false });
    expect(taken.connect.claude).toContain(' --scope user ');
    expect(links.share(taken.share.id)).toMatchObject({ via: 'invite', mintedBy: null, owner: 'lht' });
    // Within the card's lease it costs no Feishu call at all.
    expect(feishu.requests.slice(before).filter((request) => request.path !== `docx/v1/documents/${DOC}`)).toEqual([]);
    await service.settings(LHT, capability, 'read');
    await expect(service.inviteClaim(secret, 'x', 'write')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('只读') });
    await expect(service.inviteInfo(secret)).resolves.toMatchObject({ self_serve: 'read' });
    await expect(service.inviteClaim(secret, '', 'read')).rejects.toMatchObject({ status: 400 });
    feishu.delete(DOC, anchor.blockId!);
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    await expect(service.inviteClaim(secret, 'x', 'read')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('控制卡片') });
    // The page still opens when the app cannot read the title.
    feishu.revoke(DOC, 'app');
    await expect(service.inviteInfo(secret)).resolves.toEqual({ doc_title: '', self_serve: 'read' });
  });
});

describe('ending keys from the card', () => {
  it('lets anyone holding the card end a key, on the card in its own document only; pausing and resuming stay the owner\'s', async () => {
    const { service, store, links, feishu, clock, card, take, create, reveal } = setup();
    const { capability, owners } = await card();
    const revealed = await create('lht', { document: DOC, label: '所有者领取的' });
    const { token } = await reveal(revealed.share.id);
    const reader = await take(capability, BOB, 'read', '读者的');
    for (const viewer of [BOB, GUEST, null]) {
      for (const action of ['pause', 'resume'] as const) {
        await expect(service.act(viewer, capability, revealed.share.id, action, DOC)).rejects.toMatchObject({ status: 403, message: 'not_owner' });
      }
    }
    feishu.wiki.set(ELSEWHERE, { obj_type: 'docx', obj_token: OTHER_DOC, title: '另一篇' });
    for (const host of [undefined, '', ELSEWHERE, 'UnknownNode1234567890abcdef']) {
      await expect(service.act(BOB, capability, revealed.share.id, 'terminate', host), String(host)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('不能在这里终止') });
    }
    expect(links.share(revealed.share.id)!.status).toBe('active');
    await expect(service.act(BOB, capability, 'shr_000000000000000000000000', 'terminate', DOC)).rejects.toMatchObject({ status: 404, message: 'unknown_share' });
    await expect(service.act(BOB, capability, revealed.share.id, 'delete' as never, DOC)).rejects.toMatchObject({ status: 400, message: 'invalid_action' });
    // The owner's key, ended by a reader who did not sign in: its token goes with it.
    expect(await service.act(null, capability, revealed.share.id, 'terminate', DOC))
      .toEqual({ share: expect.objectContaining({ id: revealed.share.id, status: 'terminated', via: 'owner', mine: false }) });
    expect(store.getActiveMcpTokenByHash(hashRunnerToken(token), new Date(clock.now).toISOString())).toBeUndefined();
    // A pending share may be ended too; ended is final.
    await expect(service.act(GUEST, capability, owners, 'terminate', DOC)).resolves.toMatchObject({ share: { status: 'terminated' } });
    await expect(service.act(BOB, capability, owners, 'terminate', DOC)).rejects.toMatchObject({ status: 409, message: 'terminated' });
    // The owner needs no host: it is their card.
    await expect(service.act(LHT, capability, reader.share.id, 'pause')).resolves.toMatchObject({ share: { status: 'paused', mine: false } });
    await expect(service.act(BOB, capability, reader.share.id, 'terminate', DOC)).resolves.toMatchObject({ share: { status: 'terminated', mine: true } });
  });
});

describe('what a control card shows', () => {
  it('shows anyone holding the card its keys, ceiling, limits, the app and whether it sits in its document; the claim link only to its owner', async () => {
    const { service, clock, card, take } = setup();
    const { capability, anchor, owners } = await card();
    clock.now += 1000;
    const bobs = await take(capability, BOB, 'read', '鲍勃');
    const common = {
      document_id: DOC, card_state: 'present', lease_until: anchor.leaseUntil, self_serve: 'write', app_access: 'edit', app_name: 'Octopus 助手',
      limits: { per_hour: SELF_SERVE_PER_HOUR, active_max: SHARES_PER_CARD },
      // No document assistants are composed here: the panel says they are off.
      assistant: { rights: null, project: null, limits: { per_card: 0, per_guest: 0, per_guest_per_day: 0 } },
    };
    const rows = (mine: boolean) => [
      { id: bobs.share.id, label: '鲍勃', rights: 'read', status: 'active', created_at: clock.now, last_used_at: null, via: 'card', mine },
      { id: owners, label: '所有者的共享', rights: 'write', status: 'pending', created_at: clock.now - 1000, last_used_at: null, via: 'owner', mine: false },
    ];
    // Which document the card manages is the owner's to see: a reader of a copy must not learn it here.
    for (const viewer of [null, GUEST]) expect(await service.panel(viewer, capability, DOC)).toEqual({ ...common, document_id: '', viewer_is_owner: false, host_matches: true, invite: null, shares: rows(false) });
    expect(await service.panel(BOB, capability, DOC)).toEqual({ ...common, document_id: '', viewer_is_owner: false, host_matches: true, invite: null, shares: rows(true) });
    expect(await service.panel(LHT, capability, DOC)).toEqual({ ...common, viewer_is_owner: true, host_matches: true, invite: { active: false, created_at: null }, shares: rows(false) });
  });

  it('tells every reader whether the card sits in its document, asking Feishu at most once per card and host token in ten minutes', async () => {
    const { service, feishu, clock, card, take } = setup();
    const { capability } = await card();
    const UNKNOWN = 'UnknownNode1234567890abcdef';
    const ALIAS = 'AliasNode1234567890abcdefgh';
    feishu.wiki.set(WIKI, { obj_type: 'docx', obj_token: DOC, title: '论文初稿' });
    feishu.wiki.set(ELSEWHERE, { obj_type: 'docx', obj_token: OTHER_DOC, title: '另一篇' });
    const asked = () => feishu.requests.filter((request) => request.as === 'app' && request.path === 'wiki/v2/spaces/get_node').map((request) => request.query.get('token'));
    // The card polls: every reader, every poll, gets the answer of the one question per token.
    for (const viewer of [null, GUEST, BOB, LHT, null]) {
      expect((await service.panel(viewer, capability, DOC)).host_matches).toBe(true);
      expect((await service.panel(viewer, capability, WIKI)).host_matches).toBe(true);
      expect((await service.panel(viewer, capability, ELSEWHERE)).host_matches).toBe(false);
      expect((await service.panel(viewer, capability, UNKNOWN)).host_matches).toBeNull();
      expect((await service.panel(viewer, capability, '../x')).host_matches).toBeNull();
      expect((await service.panel(viewer, capability)).host_matches).toBeNull();
    }
    expect(asked()).toEqual([WIKI, ELSEWHERE, UNKNOWN]);
    // Within the window an answer stands, even one that could not be had; past it, it is asked again.
    feishu.wiki.set(UNKNOWN, { obj_type: 'docx', obj_token: OTHER_DOC, title: '另一篇' });
    clock.now += HOST_MATCH_MS - 1;
    expect((await service.panel(null, capability, UNKNOWN)).host_matches).toBeNull();
    clock.now += 1;
    expect((await service.panel(null, capability, UNKNOWN)).host_matches).toBe(false);
    expect(asked()).toEqual([WIKI, ELSEWHERE, UNKNOWN, UNKNOWN]);
    // A reader's own act does not lean on the panel's answer: it matches afresh.
    expect((await service.panel(null, capability, ALIAS)).host_matches).toBeNull();
    feishu.wiki.set(ALIAS, { obj_type: 'docx', obj_token: DOC, title: '论文初稿' });
    expect((await service.panel(null, capability, ALIAS)).host_matches).toBeNull();
    await expect(take(capability, null, 'read', 'x', ALIAS)).resolves.toMatchObject({ share: { status: 'active' } });
  });

  it('asks Feishu what the app may do at most once a minute per document; a question Feishu does not answer reads unknown', async () => {
    const { service, feishu, clock, card } = setup();
    const { capability } = await card();
    const asked = () => feishu.requests.filter((request) => request.as === 'app' && request.path === `drive/v1/permissions/${DOC}/members/auth`)
      .map((request) => `${request.query.get('type')}:${request.query.get('action')}`);
    // The create asked once already.
    expect(asked()).toEqual(['docx:edit']);
    feishu.grant(DOC, 'app', 'read');
    expect((await service.panel(null, capability)).app_access).toBe('edit');
    clock.now += APP_ACCESS_MS;
    expect((await service.panel(BOB, capability)).app_access).toBe('view');
    expect((await service.panel(LHT, capability)).app_access).toBe('view');
    expect(asked()).toEqual(['docx:edit', 'docx:edit', 'docx:view']);
    feishu.revoke(DOC, 'app');
    clock.now += APP_ACCESS_MS;
    expect((await service.panel(null, capability)).app_access).toBe('none');
    feishu.intercept = (request) => request.as === 'app' && request.path.endsWith('/members/auth') ? 'network' : undefined;
    clock.now += APP_ACCESS_MS;
    expect((await service.panel(null, capability)).app_access).toBe('unknown');
    feishu.intercept = null;
    feishu.grant(DOC, 'app', 'edit');
    expect((await service.panel(null, capability)).app_access).toBe('unknown');
    clock.now += APP_ACCESS_MS;
    expect((await service.panel(null, capability)).app_access).toBe('edit');
  });

  it('names the app once Feishu says its name, and keeps it', async () => {
    const { service, feishu, card } = setup();
    const { capability } = await card();
    feishu.intercept = (request) => request.path === 'bot/v3/info' ? new Response(JSON.stringify({ code: 99991663, msg: 'invalid' }), { status: 400 }) : undefined;
    expect((await service.panel(null, capability)).app_name).toBeNull();
    feishu.intercept = null;
    expect((await service.panel(null, capability)).app_name).toBe('Octopus 助手');
    feishu.appName = '改了名字';
    expect((await service.panel(LHT, capability)).app_name).toBe('Octopus 助手');
    expect(feishu.requests.filter((request) => request.path === 'bot/v3/info').map((request) => request.as)).toEqual(['app', 'app']);
  });

  it('tells the owner creating a read-write share when it could not write, naming the app', async () => {
    const { service, feishu, clock } = setup();
    feishu.grant(DOC, 'app', 'read');
    const write = await service.create('lht', { document: DOC, label: 'A' });
    expect(write).toMatchObject({ app_access: 'view', warning: expect.stringContaining('「…」→「添加文档应用」') });
    for (const part of ['「Octopus 助手」', '只能查看', '可编辑']) expect(write.warning, part).toContain(part);
    const read = await service.create('lht', { document: DOC, label: 'B', rights: 'read' });
    expect(read).toMatchObject({ app_access: 'view' });
    expect(read).not.toHaveProperty('warning');
    feishu.grant(DOC, 'app', 'edit');
    clock.now += APP_ACCESS_MS;
    const able = await service.create('lht', { document: DOC, label: 'C' });
    expect(able).toMatchObject({ app_access: 'edit' });
    expect(able).not.toHaveProperty('warning');
    // Not knowing is said as such; an app whose name is not known is named generically.
    const fresh = setup();
    fresh.feishu.intercept = (request) => request.as === 'app' && (request.path.endsWith('/members/auth') || request.path === 'bot/v3/info') ? 'network' : undefined;
    const unknown = await fresh.service.create('lht', { document: DOC, label: 'D' });
    expect(unknown).toMatchObject({ app_access: 'unknown', warning: expect.stringContaining('Octopus 飞书应用能不能编辑这篇文档暂时无法确认') });
  });
});

describe('notices of readers\' keys', () => {
  it('tells the owner once per card and kind in ten minutes when others take or end keys, never with a secret', async () => {
    const { service, clock, dms, card, take } = setup();
    const { capability, owners } = await card();
    dms.splice(0);
    const taken = await take(capability, BOB, 'write', '张老师');
    await vi.waitFor(() => expect(dms).toHaveLength(1));
    expect(dms[0].owner).toBe('lht');
    const first = JSON.stringify(dms[0].card);
    for (const part of ['有人领取了文档访问密钥', 'bob', '在控制卡片上', '论文初稿', '张老师', '读写']) expect(first, part).toContain(part);
    expect(first).not.toContain(taken.connect.token);
    // Within ten minutes another key, on the card or through its link, is not told again.
    const secret = secretOf(service.invite(LHT, capability, 'create').link);
    await take(capability, null, 'read', '路人');
    await service.inviteClaim(secret, '外校老师', 'read');
    await settle();
    expect(dms).toHaveLength(1);
    // A key ended by someone else is told on its own.
    await service.act(GUEST, capability, owners, 'terminate', DOC);
    await vi.waitFor(() => expect(dms).toHaveLength(2));
    const ended = JSON.stringify(dms[1].card);
    for (const part of ['有人终止了文档访问密钥', '组织成员（…123456）', '所有者的共享', '论文初稿']) expect(ended, part).toContain(part);
    await service.act(BOB, capability, taken.share.id, 'terminate', DOC);
    await settle();
    expect(dms).toHaveLength(2);
    // Ten minutes on the next is told again; what the owner does is never told to them.
    clock.now += KEY_NOTICE_MS;
    await take(capability, LHT, 'read', '自己的');
    await settle();
    expect(dms).toHaveLength(2);
    await service.inviteClaim(secret, '另一位', 'read');
    await vi.waitFor(() => expect(dms).toHaveLength(3));
    for (const part of ['通过领取链接', '持有领取链接的人', '另一位', '只读']) expect(JSON.stringify(dms[2].card), part).toContain(part);
    expect(JSON.stringify(dms)).not.toMatch(SECRET);
  });

  it('takes and ends keys even when the notice cannot be delivered', async () => {
    const { service, notifyOwner, card, take, links } = setup();
    const { capability } = await card();
    notifyOwner.mockRejectedValue(new Error('Bot has NO availability to this user'));
    const taken = await take(capability, BOB);
    expect(links.share(taken.share.id)!.status).toBe('active');
    await expect(service.act(null, capability, taken.share.id, 'terminate', DOC)).resolves.toMatchObject({ share: { status: 'terminated' } });
    // The create's notice, then the two that failed.
    await vi.waitFor(() => expect(notifyOwner).toHaveBeenCalledTimes(3));
  });
});
