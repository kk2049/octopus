import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_OPERATION_PROTOCOL } from '@claude-bot/runner/gateway-protocol';
import {
  readAssistantList, readAssistantPinned, readAssistantSettings, readAssistantStarted, readAssistantStatus, readAssistantTargets, readAssistantView, readDocSharePanel,
} from '@claude-bot/feishu-docs-addon/protocol';
import { FeishuDocAssistants } from '../feishu/doc-assistants.js';
import { FeishuDocShareService } from '../feishu/doc-share.js';
import { FeishuDocsAddonAuth } from '../feishu/docs-addon-auth.js';
import { FeishuDocsAddonService } from '../feishu/docs-addon.js';
import { readDefaults } from '../feishu/docs-launch.js';
import { decodeResourceId } from '../sessionhub/core.js';
import { FeishuDocsClient } from '../feishu/docs-openapi.js';
import { APP_TOKEN, FakeFeishuDocs, userToken } from '../feishu/fake-feishu-docs.helper.js';
import { Store } from '../store/store.js';
import { buildPanelApp, panelHandler } from './http.js';
import { DOCS_ADDON_BODY_LIMIT, DOCS_ADDON_PATH, feishuDocsAddonPreGate, handleFeishuDocsAddon } from './routes/feishu-docs-addon.js';

const origin = 'https://widget.feishu.cn';
const DOC = 'DocxToken1234567890abcdefg';
const OTHER = 'OtherDocx1234567890abcdefg';
const WS = `ws_${'0'.repeat(24)}`;
const HOME = `ws_${'f'.repeat(24)}`;
const REQUEST = '00000000-0000-4000-8000-000000000000';
const OPS = ['assistant-targets', 'assistant-configure', 'assistant-list', 'assistant-start', 'assistant-status', 'assistant-end', 'assistant-pin'];

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function harness() {
  const store = new Store(':memory:');
  for (const [i, username] of ['lht', 'bob'].entries()) store.saveUser({ username, uid: 5001 + i, home_dir: `/fixture/${username}`, created_at: '2026-10-30T00:00:00Z' });
  const feishu = new FakeFeishuDocs();
  for (const doc of [DOC, OTHER]) { feishu.addDoc(doc, doc === DOC ? '论文初稿' : '另一篇', ['正文']); feishu.grant(doc, 'lht', 'edit'); feishu.grant(doc, 'app', 'edit'); }
  const clock = { now: 1_800_000_000_000 };
  const docs = new FeishuDocsClient(async (owner) => userToken(owner), feishu.fetch, async () => APP_TOKEN);
  let assistants!: FeishuDocAssistants;
  const shares = new FeishuDocShareService({ links: store.feishuDocShareLinks, tokens: store, docs, componentTypeId: 'blk_widget', publicUrl: 'https://octopus.example',
    notifyOwner: async () => {}, now: () => clock.now, onAssistantEnded: (shareId) => assistants.ended(shareId), assistantSettings: (anchorId) => assistants.settingsOf(anchorId) });
  // The owner's one device, which runs assistants; it answers each launch with a durable receipt.
  const inventory = { schema: 'runner-inventory/v1', session_operations: { protocol: SESSION_OPERATION_PROTOCOL }, agent_backends: [{ kind: 'claude', available: true, split_execution: true }],
    execution: { platform: 'linux', arch: 'x64', shell: true, workspace_files: true, workspace_count: 2, codex_exec_server: false, read_only_scope: true } };
  const grant = { request: vi.fn(async (_operation: string, args: Record<string, unknown>) => ({ status: 'succeeded' as const,
    result: { protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id, state: 'running' } })), destroy: vi.fn() };
  const caps = { open: vi.fn(() => grant), listDevices: vi.fn((owner: string) => owner === 'lht' ? [{ device: 'laptop', display_name: '实验室工作站', online: true, created_at: '', last_seen_at: null, inventory }] : []) };
  const executions = { releaseDocShare: vi.fn(), deviceWorkspaces: vi.fn(async () => ({ ok: true as const,
    workspaces: [{ workspace_id: HOME, label: 'Home', display: '~' }, { workspace_id: WS, label: 'ACC', display: '~/acc' }] })) };
  assistants = new FeishuDocAssistants({ assistants: store.feishuDocAssistants, links: store.feishuDocShareLinks, docShares: shares, cards: store.feishuDocsShares,
    caps: caps as never, executions: executions as never, docs, componentTypeId: 'blk_widget', launchDefaults: () => readDefaults(undefined),
    displayName: (username) => username, transaction: (work) => store.withinTransaction(work), now: () => clock.now });
  const people = new Map([['ou_lht', 'lht'], ['ou_bob', 'bob']]);
  let next = 'ou_lht';
  const auth = new FeishuDocsAddonAuth({ tenantKey: 't', allowedOrigins: [origin], verifyCode: async () => ({ openId: next, tenantKey: 't' }) }, (id) => people.get(id), vi.fn());
  const service = new FeishuDocsAddonService(auth, { roster: vi.fn(), liveGrant: vi.fn(), decodeResourceId } as never, { submit: vi.fn(), get: vi.fn() } as never,
    store.feishuDocsShares, undefined, Date.now, { docShares: shares, assistants });
  const app = buildPanelApp({ buildId: () => '', onInternalError: vi.fn() });
  app.addHook('onRequest', (req, reply, done) => { if (feishuDocsAddonPreGate(service, req, reply)) done(); });
  app.route({ method: ['GET', 'POST', 'OPTIONS'], url: `${DOCS_ADDON_PATH}*`, bodyLimit: DOCS_ADDON_BODY_LIMIT, handler: panelHandler((req, reply) => handleFeishuDocsAddon(service, req, reply)) });
  await app.ready();
  closers.push(() => store.close(), () => auth.close(), () => service.close(), () => app.close());

  const bearer = async (openId: string) => { next = openId; return `Bearer ${(await auth.login(`code-${openId}-${Math.random()}`, origin)).token}`; };
  const post = (op: string, authorization: string | null, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}${op}`, headers: { origin, ...(authorization === null ? {} : { authorization }) }, payload });
  /** The owner's control card in the document, and the capability its Record holds. */
  const card = async () => {
    await shares.create('lht', { document: DOC, label: '张老师' });
    return (feishu.records(DOC)[0].record as { octopusShare: { anchor: string } }).octopusShare.anchor;
  };
  return { app, store, post, bearer, card, grant };
}

describe('the document assistant routes', () => {
  it('take a bearer always, and their fields only in a POST body', async () => {
    const { app, post, bearer, card } = await harness();
    const anchor = await card();
    const owner = await bearer('ou_lht');
    for (const op of OPS) {
      expect((await post(op, null, { anchor })).statusCode, op).toBe(401);
      expect((await post(op, 'Bearer fda_nope', { anchor })).statusCode, op).toBe(401);
      expect((await app.inject({ method: 'GET', url: `${DOCS_ADDON_PATH}${op}?anchor=${anchor}`, headers: { origin, authorization: owner } })).statusCode, op).toBe(405);
    }
    // A card named in the query string is no card: the body alone counts.
    expect((await post(`assistant-list?anchor=${anchor}`, owner, {})).json()).toEqual({ error: 'unknown_anchor' });
  });

  it('answer exactly what the card\'s own contract reads, through an assistant\'s whole life', async () => {
    const { post, bearer, card, store, grant } = await harness();
    const anchor = await card();
    const owner = await bearer('ou_lht');
    const guest = await bearer('ou_guest');
    // Each answer passes the card's reader unchanged: nothing missing, nothing it would drop or cut.
    const same = (read: (value: unknown) => unknown, value: unknown) => expect(read(value)).toEqual(value);
    same(readAssistantTargets, (await post('assistant-targets', owner, {})).json());
    for (const reader of [owner, guest, null]) same(readDocSharePanel, (await post('share-panel', reader, { anchor, host_token: DOC })).json());
    same(readAssistantSettings, (await post('assistant-configure', owner, { anchor, rights: 'write', device: 'laptop', workspace_id: WS })).json());
    for (const reader of [owner, guest, null]) same(readDocSharePanel, (await post('share-panel', reader, { anchor, host_token: DOC })).json());
    same(readDocSharePanel, (await post('share-settings', owner, { anchor, self_serve: 'read', host_token: DOC })).json());
    const started = (await post('assistant-start', guest, { anchor, host_token: DOC, task: '检查推导', request_id: REQUEST, name: '王同学' })).json();
    same(readAssistantStarted, started);
    same(readAssistantStatus, (await post('assistant-status', guest, { id: started.id })).json());
    store.feishuDocAssistants.attach(started.id, 'lht', 'assistant-session');
    for (const reader of [guest, owner]) {
      same(readAssistantStatus, (await post('assistant-status', reader, { id: started.id })).json());
      same(readAssistantList, (await post('assistant-list', reader, { anchor })).json());
    }
    same(readAssistantPinned, (await post('assistant-pin', guest, { id: started.id })).json());
    same(readAssistantView, (await post('assistant-end', guest, { id: started.id })).json());
    same(readAssistantStatus, (await post('assistant-status', owner, { id: started.id })).json());
    // A launch the device refuses: its status carries the reason.
    grant.request.mockImplementationOnce(async (_operation, args) => ({ status: 'succeeded',
      result: { protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id, state: 'failed', error: '设备上的 Claude 没有登录' } }));
    const refused = await post('assistant-start', guest, { anchor, host_token: DOC, task: '再看看', request_id: REQUEST.replace(/0$/, '1'), name: '王同学' });
    // The guest gets fixed words; what the device said is the owner's (and the log's).
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: '设备暂时无法启动助手，请稍后再试' });
    const listed = (await post('assistant-list', guest, { anchor })).json();
    same(readAssistantList, listed);
    expect(listed.assistants.map((each: { state: string }) => each.state).sort()).toEqual(['ended', 'failed']);
    same(readAssistantSettings, (await post('assistant-configure', owner, { anchor, rights: null })).json());
  });

  it('let a card\'s owner alone list their devices and turn assistants on or off, and show every reader the settings in the panel', async () => {
    const { post, bearer, card } = await harness();
    const anchor = await card();
    const owner = await bearer('ou_lht');
    const bob = await bearer('ou_bob');
    const guest = await bearer('ou_guest');
    // Targets are the caller's own devices: an account is needed, and bob has none that could host one.
    expect((await post('assistant-targets', guest, {})).statusCode).toBe(403);
    expect((await post('assistant-targets', bob, {})).json()).toEqual({ devices: [] });
    expect((await post('assistant-targets', owner, {})).json())
      .toEqual({ devices: [{ device: 'laptop', label: '实验室工作站', eligible: true, workspaces: [{ workspace_id: WS, label: 'ACC' }] }] });
    for (const reader of [guest, bob]) {
      expect((await post('assistant-configure', reader, { anchor, rights: 'write', device: 'laptop', workspace_id: WS })).statusCode).toBe(403);
    }
    for (const rights of ['admin', undefined, 1]) {
      expect((await post('assistant-configure', owner, { anchor, rights, device: 'laptop', workspace_id: WS })).statusCode, String(rights)).toBe(400);
    }
    expect((await post('assistant-configure', owner, { anchor, rights: 'write', device: 'laptop', workspace_id: HOME })).statusCode).toBe(422);
    const settings = { rights: 'write', project: { device: 'laptop', workspace_id: WS, label: 'ACC' }, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } };
    expect((await post('assistant-configure', owner, { anchor, rights: 'write', device: 'laptop', workspace_id: WS })).json()).toEqual(settings);
    // Every reader of the card, signed in or not, sees them in the panel; where the project lives (and which document
    // this is) only the owner does.
    const seen = { ...settings, project: { device: '', workspace_id: '', label: 'ACC' } };
    expect((await post('share-panel', owner, { anchor, host_token: DOC })).json()).toMatchObject({ document_id: DOC, assistant: settings });
    for (const reader of [bob, guest, null]) {
      expect((await post('share-panel', reader, { anchor, host_token: DOC })).json(), String(reader)).toMatchObject({ document_id: '', assistant: seen });
    }
    expect((await post('share-settings', owner, { anchor, self_serve: 'read', host_token: DOC })).json()).toMatchObject({ document_id: DOC, assistant: settings });
    // JSON null turns them off; the project stays.
    expect((await post('assistant-configure', owner, { anchor, rights: null })).json()).toEqual({ ...settings, rights: null });
    expect((await post('share-panel', null, { anchor, host_token: DOC })).json().assistant).toEqual({ ...seen, rights: null });
  });

  it('keep one guest\'s assistant to that guest and the card\'s owner', async () => {
    const { post, bearer, card, store, grant } = await harness();
    const anchor = await card();
    const owner = await bearer('ou_lht');
    await post('assistant-configure', owner, { anchor, rights: 'write', device: 'laptop', workspace_id: WS });
    const guest = await bearer('ou_guest');
    const other = await bearer('ou_other');
    // A copy of the card in another document starts nothing.
    expect((await post('assistant-start', guest, { anchor, host_token: OTHER, task: '检查推导', request_id: REQUEST, name: '王同学' })).statusCode).toBe(403);
    expect(grant.request).not.toHaveBeenCalled();
    const started = await post('assistant-start', guest, { anchor, host_token: DOC, task: '检查推导', request_id: REQUEST, name: '王同学' });
    expect(started.statusCode).toBe(202);
    const { id } = started.json();
    expect(grant.request).toHaveBeenCalledWith('start_session', expect.objectContaining({ client_request_id: id, source: 'claude', workspace_id: WS }));
    expect((await post('assistant-status', guest, { id })).json()).toMatchObject({ id, state: 'starting', guest: '王同学', mine: true, pinned: false });
    store.feishuDocAssistants.attach(id, 'lht', 'assistant-session');
    const ready = (await post('assistant-status', guest, { id })).json();
    expect(ready).toMatchObject({ state: 'ready', binding: { share: expect.stringMatching(/^ds_/), owner: 'lht', device: 'laptop', provider: 'claude' } });

    // Another reader learns nothing of it, can do nothing to it, and cannot watch or talk to its card before it is pinned.
    for (const op of ['assistant-status', 'assistant-end', 'assistant-pin']) expect((await post(op, other, { id })).statusCode, op).toBe(404);
    expect((await post('assistant-list', other, { anchor })).json()).toEqual({ assistants: [] });
    expect((await post('view', other, { share: ready.binding.share, since: '' })).statusCode).toBe(403);
    expect((await post('send', other, { share: ready.binding.share, prompt: '我也来', requestId: REQUEST })).statusCode).toBe(403);
    expect((await post('view', null, { share: ready.binding.share, since: '' })).statusCode).toBe(401);
    // Its guest sees it in their list; the owner sees every one, as not theirs; only its guest pins it.
    expect((await post('assistant-list', guest, { anchor })).json().assistants.map((each: { id: string }) => each.id)).toEqual([id]);
    expect((await post('assistant-list', owner, { anchor })).json().assistants).toEqual([expect.objectContaining({ id, mine: false })]);
    expect((await post('assistant-status', owner, { id })).statusCode).toBe(200);
    expect((await post('assistant-pin', owner, { id })).statusCode).toBe(404);
    expect((await post('assistant-pin', guest, { id })).statusCode).toBe(200);
    // Either of them may end it; ended is final.
    expect((await post('assistant-end', owner, { id })).json()).toMatchObject({ id, state: 'ended', pinned: true, ended_at: expect.any(Number) });
    expect((await post('assistant-status', guest, { id })).json()).toMatchObject({ state: 'ended' });
  });
});
