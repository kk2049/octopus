import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardFrame } from '@claude-bot/feishu-docs-addon/protocol';
import { SESSION_OPERATION_PROTOCOL } from '@claude-bot/runner/gateway-protocol';
import { mcpFeishuDocSharePolicy, mintMcpToken } from '../mcp/tokens.js';
import { decodeResourceId, resourceId } from '../sessionhub/core.js';
import type { SessionHubService } from '../sessionhub/service.js';
import type { SessionOperationCoordinator } from '../sessionhub/operations.js';
import { Store } from '../store/store.js';
import { FeishuDocAssistants } from './doc-assistants.js';
import { FeishuDocShareService } from './doc-share.js';
import { FeishuDocsAddonAuth, type DocsAddonIdentity } from './docs-addon-auth.js';
import { FeishuDocsAddonService, REFRESH_MS } from './docs-addon.js';
import { readDefaults } from './docs-launch.js';
import { FeishuDocsClient } from './docs-openapi.js';
import { APP_TOKEN, FakeFeishuDocs, userToken } from './fake-feishu-docs.helper.js';

const origin = 'https://widget.feishu.cn';
const DOC = 'DocxToken1234567890abcdefg';
const WS = `ws_${'0'.repeat(24)}`;
const REQUEST = '00000000-0000-4000-8000-000000000000';
const ASSISTANT = `op_fda_${'1'.repeat(40)}`;
const SESSION = 'assistant-session';
const CAP = `ds_${'A'.repeat(43)}`;
const ORDINARY = `ds_${'B'.repeat(43)}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

let now = 1_800_000_000_000;
let service: FeishuDocsAddonService;
let auth: FeishuDocsAddonAuth;
let store: Store;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); now = 1_800_000_000_000; });
afterEach(() => { service?.close(); auth?.close(); store?.close(); vi.useRealTimers(); });

async function setup() {
  store = new Store(':memory:');
  store.saveUser({ username: 'lht', uid: 5001, home_dir: '/fixture/lht', created_at: '2026-10-30T00:00:00Z' });
  const people = new Map([['ou_owner', 'lht'], ['ou_bob', 'bob']]);
  let next = 'ou_owner';
  auth = new FeishuDocsAddonAuth({ tenantKey: 't', allowedOrigins: [origin], verifyCode: async () => ({ openId: next, tenantKey: 't' }) }, (id) => people.get(id), vi.fn(), () => now);
  const as = async (openId: string): Promise<DocsAddonIdentity> => { next = openId; return auth.authenticate((await auth.login(`code-${openId}-${Math.random()}`, origin)).token, origin); };
  const grant = { call: vi.fn(async () => ({ total_messages: 2, offset: 0, meta: { activity: { state: 'idle' } },
    messages: [{ role: 'user', timestamp: '2026-10-30T00:00:00Z', blocks: [{ type: 'text', text: '检查推导' }] },
      { role: 'assistant', timestamp: '2026-10-30T00:00:01Z', blocks: [{ type: 'text', text: '第二节有个符号错了' }] }] })), close: vi.fn() };
  const hub = { decodeResourceId, roster: vi.fn(), liveGrant: vi.fn(() => ({ ok: true as const, grant, local: false })) };
  const operations = { submit: vi.fn(async () => ({ ok: true, operation: { id: 'op-hub', status: 'submitted', message: '已提交', live: true } })), get: vi.fn() };
  // The owner's device: what it was asked, and the receipts it answers with.
  const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const state: { receipt: string; refuse?: string; error?: string } = { receipt: 'running' };
  const deviceGrant = { request: vi.fn(async (operation: string, args: Record<string, unknown>) => {
    calls.push({ operation, args });
    if (state.refuse) return { status: 'failed' as const, reason: state.refuse };
    return { status: 'succeeded' as const, result: { protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id, state: state.receipt, session_id: SESSION,
      ...(state.error ? { result: { ok: false, error: state.error } } : {}) } };
  }), destroy: vi.fn() };
  const caps = { open: vi.fn(() => deviceGrant), listDevices: () => [] };
  const feishu = new FakeFeishuDocs();
  feishu.addDoc(DOC, '论文初稿', ['引言']);
  const docs = new FeishuDocsClient(async (owner) => userToken(owner), feishu.fetch, async () => APP_TOKEN);
  let assistants!: FeishuDocAssistants;
  const docShares = new FeishuDocShareService({ links: store.feishuDocShareLinks, tokens: store, docs, componentTypeId: 'blk_widget', publicUrl: 'https://octopus.example',
    notifyOwner: async () => {}, now: () => now, onAssistantEnded: (shareId) => assistants.ended(shareId) });
  assistants = new FeishuDocAssistants({ assistants: store.feishuDocAssistants, links: store.feishuDocShareLinks, docShares, cards: store.feishuDocsShares,
    caps: caps as never, executions: { deviceWorkspaces: vi.fn(), releaseDocShare: vi.fn() } as never, docs, launchDefaults: () => readDefaults(undefined),
    displayName: (username) => username, transaction: (work) => store.withinTransaction(work), now: () => now });
  service = new FeishuDocsAddonService(auth, hub as unknown as Pick<SessionHubService, 'roster' | 'liveGrant' | 'decodeResourceId'>,
    operations as unknown as Pick<SessionOperationCoordinator, 'submit' | 'get'>, store.feishuDocsShares, (username) => username, () => now,
    { assistants, speakers: store.feishuDocsSpeakers, grants: store.workspaceGrants });

  // One assistant of guest 1 on lht's device, live, its session known; its card; and an ordinary card of lht's.
  store.feishuDocShareLinks.createAnchor({ id: 'anc_1', owner: 'lht', documentId: DOC, wikiToken: null, capabilityHash: 'c'.repeat(64), createdAt: 1 });
  store.feishuDocShareLinks.markPresent('anc_1', 'blk_card', now + 60 * 60_000, now);
  store.feishuDocAssistants.configure('anc_1', 'write', { device: 'laptop', workspaceId: WS, label: 'ACC' });
  const shareId = `shr_${'a'.repeat(24)}`;
  const token = mintMcpToken(store, { username: 'lht', label: '飞书文档助手', policy: mcpFeishuDocSharePolicy(shareId) });
  store.feishuDocShareLinks.createAssistantShare({ id: shareId, anchorId: 'anc_1', owner: 'lht', documentId: DOC, label: '王同学的文档助手', rights: 'write', mcpTokenHash: token.row.token_hash, createdAt: 2 });
  store.feishuDocAssistants.create({ id: ASSISTANT, owner: 'lht', anchorId: 'anc_1', shareId, guestOpenId: 'ou_guest1', guestName: '王同学', title: '王同学的文档助手：检查推导',
    device: 'laptop', workspaceId: WS, createdAt: 3 });
  store.feishuDocAssistants.attach(ASSISTANT, 'lht', SESSION);
  store.feishuDocsShares.create({ id: digest(CAP), owner: 'lht', resource: resourceId({ owner: 'lht', device: 'laptop', cliKind: 'claude', sessionId: SESSION }),
    title: '王同学的文档助手：检查推导', createdAt: 4, revokedAt: null });
  store.feishuDocsShares.create({ id: digest(ORDINARY), owner: 'lht', resource: resourceId({ owner: 'lht', device: 'laptop', cliKind: 'claude', sessionId: 'ordinary-session' }),
    title: 'Paper', createdAt: 5, revokedAt: null });
  return { as, hub, grant, operations, calls, caps, state, shareId };
}

describe('a document assistant\'s card', () => {
  it('lets only its guest (by open_id) and the owner talk to it, the guest through per-call grants and never the owner\'s Session Hub', async () => {
    const h = await setup();
    const guest = await h.as('ou_guest1');
    const other = await h.as('ou_guest2');
    const bob = await h.as('ou_bob');
    const owner = await h.as('ou_owner');
    for (const stranger of [other, bob]) {
      await expect(service.send(stranger, CAP, '把结论改掉', REQUEST)).rejects.toMatchObject({ status: 403 });
      await expect(service.stop(stranger, CAP, REQUEST)).rejects.toMatchObject({ status: 403 });
    }
    // A guest without an account is still nobody on an ordinary card.
    await expect(service.send(guest, ORDINARY, 'hi', REQUEST)).rejects.toMatchObject({ status: 403 });
    expect(h.calls).toEqual([]);

    const sent = await service.send(guest, CAP, '  再看看第三节  ', REQUEST, { doc: DOC, title: '论文初稿' });
    expect(sent).toMatchObject({ id: expect.stringMatching(/^op_fdam_[0-9a-f]{40}$/), status: 'running', live: true });
    expect(h.caps.open).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'lht', kind: 'job', device: 'laptop', rights: ['append_session'], autoAllow: ['append_session'] }));
    expect(h.calls).toEqual([{ operation: 'append_session', args: { device: 'laptop', id: SESSION, source: 'claude', operation_id: sent.id, input_receipt: true,
      prompt: `再看看第三节\n\n（这条消息是从飞书云文档《论文初稿》里的 Agent 卡片发来的，document_id：${DOC}；消息里说的“这个文档”就是它。）` } }]);
    await service.stop(guest, CAP, REQUEST.replace(/0$/, '1'));
    expect(h.calls.at(-1)).toMatchObject({ operation: 'append_session', args: { interrupt: true, id: SESSION } });
    // A guest login derives nothing in the owner's Session Hub.
    expect(h.operations.submit).not.toHaveBeenCalled();
    expect(h.hub.liveGrant).not.toHaveBeenCalled();

    // The owner may talk to it and stop it, as they would any agent of theirs.
    await service.send(owner, CAP, '别动结论', REQUEST.replace(/0$/, '2'));
    expect(h.operations.submit).toHaveBeenLastCalledWith('hub', expect.objectContaining({ username: 'lht' }),
      expect.objectContaining({ owner: 'lht', device: 'laptop', sessionId: SESSION, operation: 'append_session', prompt: '别动结论' }), expect.anything());
    await service.stop(owner, CAP, REQUEST.replace(/0$/, '3'));
    expect(h.operations.submit).toHaveBeenLastCalledWith('hub', expect.anything(), expect.objectContaining({ operation: 'interrupt_session' }), expect.anything());
  });

  it('lets its guest follow their own message, and nobody else', async () => {
    const h = await setup();
    const guest = await h.as('ou_guest1');
    const other = await h.as('ou_guest2');
    const sent = await service.send(guest, CAP, '再看看', REQUEST);
    expect(service.operation(guest, sent.id)).toMatchObject({ id: sent.id, status: 'running', live: true });
    expect(() => service.operation(other, sent.id)).toThrow(expect.objectContaining({ status: 403 }));
    h.state.receipt = 'succeeded';
    now += REFRESH_MS;
    expect(service.operation(guest, sent.id)).toMatchObject({ status: 'running' });
    await vi.waitFor(() => expect(service.operation(guest, sent.id)).toMatchObject({ status: 'succeeded', live: false }));
    expect(h.calls.at(-1)).toMatchObject({ operation: 'get_session_operation', args: { device: 'laptop', operation_id: sent.id } });
  });

  it('is watched only by its guest and the owner until its guest pins it', async () => {
    const h = await setup();
    const guest = await h.as('ou_guest1');
    const other = await h.as('ou_guest2');
    const bob = await h.as('ou_bob');
    const owner = await h.as('ou_owner');
    for (const stranger of [other, bob]) {
      await expect(service.view(stranger, CAP, '', -1)).rejects.toMatchObject({ status: 403 });
      await expect(service.older(stranger, CAP, 2)).rejects.toMatchObject({ status: 403 });
      await expect(service.message(stranger, CAP, 1)).rejects.toMatchObject({ status: 403 });
    }
    expect(h.grant.call).not.toHaveBeenCalled();
    // Its frames say whom it works for; exactly its guest and the owner may talk to it.
    const first = await service.view(guest, CAP, '', -1) as CardFrame;
    expect(first).toMatchObject({ role: 'viewer', canTalk: true, messages: [{ text: '检查推导' }, { text: '第二节有个符号错了' }] });
    expect(first.assistant).toEqual({ guest: '王同学', pinned: false });
    const owners = await service.view(owner, CAP, '', -1) as CardFrame;
    expect(owners).toMatchObject({ role: 'owner', canTalk: true });
    // The name is whatever the guest's card sent: the owner also sees the end of the guest's verified open_id.
    expect(owners.assistant).toEqual({ guest: '王同学（…guest1）', pinned: false });
    store.feishuDocAssistants.pin(ASSISTANT, now);
    // Pinning changes what it shows with no new message: a poll at the old revision gets the new frame.
    expect((await service.view(guest, CAP, first.rev, -1) as CardFrame).assistant).toEqual({ guest: '王同学', pinned: true });
    const watched = await service.view(other, CAP, '', -1) as CardFrame;
    expect(watched).toMatchObject({ role: 'viewer', canTalk: false });
    expect(watched.assistant).toEqual({ guest: '王同学', pinned: true });
    await expect(service.send(other, CAP, '我也来', REQUEST)).rejects.toMatchObject({ status: 403 });
    // An ordinary card's frame is what it always was.
    const ordinary = await service.view(owner, ORDINARY, '', -1);
    expect(ordinary).toMatchObject({ role: 'owner', canTalk: true });
    expect(ordinary).not.toHaveProperty('assistant');
    expect(await service.view(guest, ORDINARY, '', -1)).toMatchObject({ role: 'viewer', canTalk: false });
  });

  it('is never forked, snapshotted, given speakers or opened into the workspace, by anyone', async () => {
    const h = await setup();
    const guest = await h.as('ou_guest1');
    const owner = await h.as('ou_owner');
    for (const who of [guest, owner]) await expect(service.fork(who, CAP, '分叉出去', REQUEST, { doc: DOC })).rejects.toMatchObject({ status: 409 });
    await expect(service.snapshot(owner, CAP, DOC)).rejects.toMatchObject({ status: 409 });
    expect(() => service.speakers(owner, CAP)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => service.setSpeakers(owner, CAP, ['bob'])).toThrow(expect.objectContaining({ status: 409 }));
    await expect(service.workspace(owner, CAP)).rejects.toMatchObject({ status: 409 });
    await expect(service.grantWorkspace(owner, CAP, WS, ['bob'])).rejects.toMatchObject({ status: 409 });
    for (const who of [guest, owner]) await expect(service.file(who, CAP, 'notes.md')).rejects.toMatchObject({ status: 409 });
    expect(h.calls).toEqual([]);
  });

  it('tells its guest fixed words when the device refuses or fails a turn, never the device\'s own', async () => {
    const h = await setup();
    const guest = await h.as('ou_guest1');
    h.state.refuse = 'ENOSPC: /home/lht/.cache/octopus is full';
    await expect(service.send(guest, CAP, '检查推导', REQUEST)).rejects.toMatchObject({ status: 503, message: '助手这一轮没有完成，请稍后再试' });
    h.state.refuse = undefined;
    h.state.receipt = 'failed';
    h.state.error = 'claude exited: /home/lht/.config/claude token expired';
    const failed = await service.send(guest, CAP, '再试一次', REQUEST.replace(/0$/, '3'));
    expect(failed).toMatchObject({ status: 'failed', message: '助手这一轮没有完成，请稍后再试' });
    expect(JSON.stringify(failed)).not.toContain('/home/lht');
  });

  it('takes no message from its guest or the owner while paused or once ended, though a stop always goes', async () => {
    const h = await setup();
    const guest = await h.as('ou_guest1');
    const owner = await h.as('ou_owner');
    store.feishuDocShareLinks.transition('lht', h.shareId, ['active'], 'paused', now);
    await expect(service.send(guest, CAP, '还在吗', REQUEST)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('暂停') });
    await expect(service.send(owner, CAP, '继续', REQUEST.replace(/0$/, '2'))).rejects.toMatchObject({ status: 409 });
    for (const who of [guest, owner]) expect(await service.view(who, CAP, '', -1)).toMatchObject({ canTalk: false });
    expect(h.operations.submit).not.toHaveBeenCalled();
    await service.stop(guest, CAP, REQUEST);
    expect(h.calls.map((call) => call.args.interrupt)).toEqual([true]);
    store.feishuDocShareLinks.transition('lht', h.shareId, ['paused'], 'active', now);
    service.assistants!.end({ openId: 'ou_guest1', username: null }, ASSISTANT);
    // Ended, every card over its conversation is revoked: it neither talks nor shows the transcript any more.
    await expect(service.send(guest, CAP, '还在吗', REQUEST.replace(/0$/, '1'))).rejects.toMatchObject({ status: 410 });
    await expect(service.view(owner, CAP, '', -1)).rejects.toMatchObject({ status: 410 });
  });
});
