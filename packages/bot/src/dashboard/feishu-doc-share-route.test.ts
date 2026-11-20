import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuDocsAddonAuth } from '../feishu/docs-addon-auth.js';
import { FeishuDocsAddonService } from '../feishu/docs-addon.js';
import { FeishuDocsClient } from '../feishu/docs-openapi.js';
import { FeishuDocShareService, PANEL_RECHECK_MS, SELF_SERVE_PER_HOUR, SHARE_ANCHOR_LEASE_MS, SHARES_PER_CARD } from '../feishu/doc-share.js';
import {
  readDocShareActionReply, readDocShareInviteReply, readDocSharePanel, readDocShareRevealReply, readDocShareSelfReply,
} from '@claude-bot/feishu-docs-addon/protocol';
import { APP_TOKEN, FakeFeishuDocs, userToken } from '../feishu/fake-feishu-docs.helper.js';
import type { CardPayload } from '../feishu/direct-card.js';
import { mcpCredentialOf } from '../mcp/tokens.js';
import { hashRunnerToken } from '../runner/gateway.js';
import { Store } from '../store/store.js';
import { buildPanelApp, panelHandler } from './http.js';
import { DOCS_ADDON_BODY_LIMIT, DOCS_ADDON_PATH, feishuDocsAddonPreGate, handleFeishuDocsAddon } from './routes/feishu-docs-addon.js';

const origin = 'https://widget.feishu.cn';
const DOC = 'DocxToken1234567890abcdefg';
const OTHER = 'OtherDocx1234567890abcdefg';
const WIKI = 'WikiToken1234567890abcdefgh';
const BRIDGE = 'bridge.example:444';
const LIMITS = { per_hour: SELF_SERVE_PER_HOUR, active_max: SHARES_PER_CARD };
/** The secret a claim link carries after `#i=`. */
const secretOf = (link: string) => new URL(link).hash.slice('#i='.length);

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function harness() {
  const store = new Store(':memory:');
  for (const [i, username] of ['lht', 'bob'].entries()) store.saveUser({ username, uid: 5001 + i, home_dir: `/fixture/${username}`, created_at: '2026-10-27T00:00:00Z' });
  const feishu = new FakeFeishuDocs();
  for (const doc of [DOC, OTHER]) { feishu.addDoc(doc, doc === DOC ? '论文初稿' : '另一篇', ['正文']); feishu.grant(doc, 'lht', 'edit'); feishu.grant(doc, 'app', 'edit'); }
  feishu.wiki.set(WIKI, { obj_type: 'docx', obj_token: DOC, title: '论文初稿' });
  const clock = { now: 1_800_000_000_000 };
  const dms: CardPayload[] = [];
  const shares = new FeishuDocShareService({
    links: store.feishuDocShareLinks, tokens: store, docs: new FeishuDocsClient(async (owner) => userToken(owner), feishu.fetch, async () => APP_TOKEN),
    componentTypeId: 'blk_widget', publicUrl: 'https://octopus.example', notifyOwner: async (_owner, card) => { dms.push(card); }, now: () => clock.now,
  });
  const people = new Map([['ou_lht', 'lht'], ['ou_bob', 'bob']]);
  let next = 'ou_lht';
  const auth = new FeishuDocsAddonAuth({ tenantKey: 't', allowedOrigins: [origin], verifyCode: async () => ({ openId: next, tenantKey: 't' }) }, (id) => people.get(id), vi.fn());
  const service = new FeishuDocsAddonService(auth, { roster: vi.fn(), liveGrant: vi.fn(), decodeResourceId: vi.fn() } as never, { submit: vi.fn(), get: vi.fn() } as never,
    store.feishuDocsShares, undefined, Date.now, { docShares: shares });
  const app = buildPanelApp({ buildId: () => '', onInternalError: vi.fn() });
  app.addHook('onRequest', (req, reply, done) => { if (feishuDocsAddonPreGate(service, req, reply)) done(); });
  app.route({ method: ['GET', 'POST', 'OPTIONS'], url: `${DOCS_ADDON_PATH}*`, bodyLimit: DOCS_ADDON_BODY_LIMIT, handler: panelHandler((req, reply) => handleFeishuDocsAddon(service, req, reply)) });
  await app.ready();
  closers.push(() => store.close(), () => auth.close(), () => service.close(), () => app.close());

  const bearer = async (openId: string) => { next = openId; return `Bearer ${(await auth.login(`code-${openId}-${Math.random()}`, origin)).token}`; };
  const post = (op: string, authorization: string | null, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}${op}`, headers: { origin, ...(authorization === null ? {} : { authorization }) }, payload });
  /** A call from the claim page itself, served at `host`. */
  const claim = (op: string, payload: Record<string, unknown>, headers: Record<string, string> = { host: BRIDGE, origin: `https://${BRIDGE}` }) =>
    app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}${op}`, headers, payload });
  /** A new share; unless `pending`, its owner has revealed it on the card already. */
  const create = async (document = DOC, label = '张老师', pending = false) => {
    const created = await shares.create('lht', { document, label }) as { share_id: string; document: { id: string } };
    const card = store.feishuDocShareLinks.anchor(store.feishuDocShareLinks.share(created.share_id)!.anchorId)!.blockId!;
    const record = feishu.records(created.document.id).find((each) => each.id === card)!.record as { octopusShare: { anchor: string } };
    const anchor = record.octopusShare.anchor;
    const token = pending ? '' : /Bearer (mcp_[0-9a-f]+)"$/.exec((await shares.reveal({ openId: 'ou_lht', username: 'lht' }, anchor, created.share_id)).command)![1];
    return { id: created.share_id, anchor, card, token,
      caller: { shareId: created.share_id, owner: 'lht', credential: mcpCredentialOf(hashRunnerToken(token)) } };
  };
  return { app, store, feishu, shares, clock, bearer, post, claim, create, dms };
}

describe('the share control card routes', () => {
  it('take their capability only in a POST body, and answer an unknown or malformed anchor alike', async () => {
    const { app, bearer, post } = await harness();
    const owner = await bearer('ou_lht');
    for (const op of ['share-panel', 'share-action', 'share-reveal', 'share-self', 'share-settings', 'share-invite']) {
      expect((await app.inject({ method: 'GET', url: `${DOCS_ADDON_PATH}${op}?anchor=dsa_x`, headers: { origin, authorization: owner } })).statusCode, op).toBe(405);
    }
    // The owner's own acts need the owner signed in; a reader's need no login at all.
    for (const op of ['share-reveal', 'share-settings', 'share-invite']) expect((await post(op, null, {})).statusCode, op).toBe(401);
    for (const op of ['share-panel', 'share-action', 'share-self']) expect((await post(op, null, {})).json(), op).toEqual({ error: 'unknown_anchor' });
    for (const anchor of [`dsa_${'A'.repeat(43)}`, 'dsa_short', '', 'ds_x']) {
      const answer = await post('share-panel', owner, { anchor });
      expect(answer.statusCode, anchor).toBe(404);
      expect(answer.json()).toEqual({ error: 'unknown_anchor' });
      expect((await post('share-action', owner, { anchor, share_id: 'shr_x', action: 'pause' })).json()).toEqual({ error: 'unknown_anchor' });
      expect((await post('share-reveal', owner, { anchor, share_id: 'shr_x' })).json()).toEqual({ error: 'unknown_anchor' });
      expect((await post('share-self', null, { anchor, host_token: DOC, label: 'x', rights: 'read' })).json()).toEqual({ error: 'unknown_anchor' });
      expect((await post('share-settings', owner, { anchor, self_serve: 'off' })).json()).toEqual({ error: 'unknown_anchor' });
      expect((await post('share-invite', owner, { anchor, op: 'create' })).json()).toEqual({ error: 'unknown_anchor' });
    }
  });

  it('show anyone holding the card the links, signed in or not, and only the owner as able to act', async () => {
    const { bearer, post, create, clock } = await harness();
    const { id, anchor } = await create();
    const shown = { document_id: DOC, card_state: 'present', lease_until: clock.now + SHARE_ANCHOR_LEASE_MS, host_matches: null,
      shares: [{ id, label: '张老师', rights: 'write', status: 'active', created_at: clock.now, last_used_at: null, via: 'owner', mine: false }],
      self_serve: 'write', app_access: 'edit', app_name: 'Octopus 助手', limits: LIMITS,
      assistant: { rights: null, project: null, limits: { per_card: 0, per_guest: 0, per_guest_per_day: 0 } } };
    const owner = await post('share-panel', await bearer('ou_lht'), { anchor });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({ ...shown, viewer_is_owner: true, invite: { active: false, created_at: null } });
    for (const member of ['ou_bob', 'ou_guest', null]) {
      const answer = await post('share-panel', member === null ? null : await bearer(member), { anchor });
      expect(answer.statusCode, String(member)).toBe(200);
      // The document the card manages is the owner's to see, not a reader's (who may hold a copy of the card).
      expect(answer.json(), String(member)).toEqual({ ...shown, document_id: '', viewer_is_owner: false, invite: null });
    }
  });

  it('let the owner pause, resume and terminate a link the card lists, and anyone else on the card in its document only terminate one; terminated is final', async () => {
    const { bearer, post, create, store } = await harness();
    const { id, anchor, token } = await create();
    const elsewhere = await create(OTHER, '另一篇的协作者');
    const owner = await bearer('ou_lht');
    for (const member of ['ou_bob', 'ou_guest', null]) {
      const reader = member === null ? null : await bearer(member);
      for (const action of ['pause', 'resume']) {
        const answer = await post('share-action', reader, { anchor, share_id: id, action, host_token: DOC });
        expect(answer.statusCode, `${member} ${action}`).toBe(403);
        expect(answer.json()).toEqual({ error: 'not_owner' });
      }
      // A card that does not say it sits in its document ends nothing.
      const answer = await post('share-action', reader, { anchor, share_id: id, action: 'terminate' });
      expect(answer.statusCode, String(member)).toBe(403);
      expect(answer.json().error).toContain('不能在这里终止');
    }
    for (const share_id of ['shr_000000000000000000000000', elsewhere.id, '']) {
      const answer = await post('share-action', owner, { anchor, share_id, action: 'pause' });
      expect(answer.statusCode, share_id).toBe(404);
      expect(answer.json()).toEqual({ error: 'unknown_share' });
    }
    expect((await post('share-action', owner, { anchor, share_id: id, action: 'delete' })).statusCode).toBe(400);
    const paused = await post('share-action', owner, { anchor, share_id: id, action: 'pause' });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toEqual({ share: expect.objectContaining({ id, status: 'paused', label: '张老师', rights: 'write' }) });
    expect((await post('share-action', owner, { anchor, share_id: id, action: 'resume' })).json().share.status).toBe('active');
    expect((await post('share-action', owner, { anchor, share_id: id, action: 'terminate' })).json().share.status).toBe('terminated');
    expect(store.getActiveMcpTokenByHash(hashRunnerToken(token), new Date().toISOString())).toBeUndefined();
    for (const action of ['pause', 'resume', 'terminate']) {
      const answer = await post('share-action', owner, { anchor, share_id: id, action });
      expect(answer.statusCode, action).toBe(409);
      expect(answer.json()).toEqual({ error: 'terminated' });
    }
    expect((await post('share-panel', owner, { anchor })).json().shares).toEqual([expect.objectContaining({ id, status: 'terminated' })]);
    // A pending link is revealed or terminated: never paused or resumed.
    const pending = await create(DOC, '待领取', true);
    for (const action of ['pause', 'resume']) {
      const answer = await post('share-action', owner, { anchor, share_id: pending.id, action });
      expect(answer.statusCode, action).toBe(409);
      expect(answer.json()).toEqual({ error: 'pending' });
    }
    expect((await post('share-action', owner, { anchor, share_id: pending.id, action: 'terminate' })).json().share.status).toBe('terminated');
    // Anyone holding the card ends a link there, signed in or not.
    const another = await create(DOC, '另一位', true);
    const ended = await post('share-action', null, { anchor, share_id: another.id, action: 'terminate', host_token: DOC });
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toEqual({ share: expect.objectContaining({ id: another.id, status: 'terminated', via: 'owner', mine: false }) });
  });

  it('reveal a pending link\'s command to its owner signed in on the card, once, and to no one else', async () => {
    const { bearer, post, create, store, dms } = await harness();
    const { id, anchor } = await create(DOC, '张老师', true);
    const elsewhere = await create(OTHER, '另一篇的协作者', true);
    expect(store.listMcpTokens('lht')).toEqual([]);
    for (const member of ['ou_bob', 'ou_guest']) {
      const answer = await post('share-reveal', await bearer(member), { anchor, share_id: id });
      expect(answer.statusCode, member).toBe(403);
      expect(answer.json()).toEqual({ error: 'not_owner' });
    }
    const owner = await bearer('ou_lht');
    for (const share_id of ['shr_000000000000000000000000', elsewhere.id, '']) {
      const answer = await post('share-reveal', owner, { anchor, share_id });
      expect(answer.statusCode, share_id).toBe(404);
      expect(answer.json()).toEqual({ error: 'unknown_share' });
    }
    expect(store.listMcpTokens('lht')).toEqual([]);
    const revealed = await post('share-reveal', owner, { anchor, share_id: id });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.headers['cache-control']).toBe('no-store');
    const command = expect.stringMatching(/^claude mcp add --transport http --scope user octopus-doc-[0-9a-f]{6} https:\/\/octopus\.example\/api\/mcp --header "Authorization: Bearer mcp_[0-9a-f]{32}"$/);
    expect(revealed.json()).toEqual({ share: expect.objectContaining({ id, status: 'active', label: '张老师', via: 'owner' }), command,
      connect: { claude: command, codex: expect.stringMatching(/^printf '.*' >> ~\/\.codex\/config\.toml$/), endpoint: 'https://octopus.example/api/mcp', token: expect.stringMatching(/^mcp_[0-9a-f]{32}$/) } });
    expect(revealed.json().connect.claude).toBe(revealed.json().command);
    const token = /Bearer (mcp_[0-9a-f]+)"$/.exec(revealed.json().command as string)![1];
    expect(revealed.json().connect.token).toBe(token);
    expect(store.getActiveMcpTokenByHash(hashRunnerToken(token), new Date().toISOString())).toMatchObject({ username: 'lht', expires_at: null });
    const again = await post('share-reveal', owner, { anchor, share_id: id });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'not_pending' });
    expect(store.listMcpTokens('lht')).toHaveLength(1);
    expect((await post('share-panel', owner, { anchor })).json().shares).toEqual([expect.objectContaining({ id, status: 'active' })]);
    // The notices carried no secret.
    expect(JSON.stringify(dms)).not.toMatch(/mcp_|claude mcp add|Bearer/);
  });

  it('tell every reader whether the host document is the share\'s document, asking Feishu as the app once per token while the card polls', async () => {
    const { bearer, post, create, feishu } = await harness();
    const { anchor } = await create(`https://t.feishu.cn/wiki/${WIKI}`);
    const alias = 'AliasNode1234567890abcdefgh';
    const elsewhere = 'OtherNode1234567890abcdefgh';
    const unknown = 'UnknownNode1234567890abcdef';
    feishu.wiki.set(alias, { obj_type: 'docx', obj_token: DOC, title: '论文初稿' });
    feishu.wiki.set(elsewhere, { obj_type: 'docx', obj_token: OTHER, title: '另一篇' });
    const readers = [await bearer('ou_lht'), await bearer('ou_bob'), await bearer('ou_guest'), null];
    for (let poll = 0; poll < 2; poll++) {
      for (const reader of readers) {
        const matches = async (host_token?: string) => (await post('share-panel', reader, { anchor, ...(host_token === undefined ? {} : { host_token }) })).json().host_matches;
        expect(await matches(DOC)).toBe(true);
        expect(await matches(WIKI)).toBe(true);
        expect(await matches(alias)).toBe(true);
        expect(await matches(elsewhere)).toBe(false);
        expect(await matches(unknown)).toBeNull();
        expect(await matches('../x')).toBeNull();
        expect(await matches()).toBeNull();
      }
    }
    // The document's own names cost nothing; every other token was asked once, as the app, whoever polled.
    expect(feishu.requests.filter((request) => request.path === 'wiki/v2/spaces/get_node' && request.as === 'app').map((request) => request.query.get('token')))
      .toEqual([alias, elsewhere, unknown]);
  });

  it('look for a missing card again when it is shown, and bring its links back once it is found', async () => {
    const { bearer, post, create, feishu, shares, clock } = await harness();
    const { anchor, card, caller } = await create();
    feishu.delete(DOC, card);
    clock.now += SHARE_ANCHOR_LEASE_MS + 1;
    await expect(shares.authorize(caller, 'read')).rejects.toMatchObject({ status: 403 });
    const owner = await bearer('ou_lht');
    // Still gone: shown missing. Unreadable: still missing, nothing changed.
    expect((await post('share-panel', owner, { anchor })).json()).toMatchObject({ card_state: 'missing', lease_until: null });
    feishu.append(DOC, { block_type: 40, add_ons: { component_type_id: 'blk_widget', record: JSON.stringify({ octopusShare: { v: 1, anchor } }) } });
    // Within a minute of the last look, a shown card is not looked for again.
    const listings = () => feishu.requests.filter((request) => request.path.endsWith('/blocks')).length;
    const quiet = listings();
    expect((await post('share-panel', owner, { anchor })).json()).toMatchObject({ card_state: 'missing' });
    expect(listings()).toBe(quiet);
    clock.now += PANEL_RECHECK_MS;
    feishu.intercept = (request) => request.path.endsWith('/blocks') ? 'network' : undefined;
    const failed = await post('share-panel', owner, { anchor });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ card_state: 'missing', lease_until: null });
    feishu.intercept = null;
    expect((await post('share-panel', owner, { anchor })).json()).toMatchObject({ card_state: 'missing' });
    clock.now += PANEL_RECHECK_MS;
    expect((await post('share-panel', owner, { anchor })).json()).toMatchObject({ card_state: 'present', lease_until: clock.now + SHARE_ANCHOR_LEASE_MS });
    await expect(shares.authorize(caller, 'write')).resolves.toMatchObject({ id: caller.shareId });
  });
});

describe('readers\' own keys and the claim link', () => {
  it('answer exactly what the card\'s own contract reads, for the owner and for a reader who is not signed in', async () => {
    const { bearer, post, claim, create } = await harness();
    const { anchor } = await create();
    const pending = await create(DOC, '待领取', true);
    const owner = await bearer('ou_lht');
    // Each answer passes the card's reader unchanged: nothing missing, nothing it would drop.
    const same = (read: (value: unknown) => unknown, value: unknown) => expect(read(value)).toEqual(value);
    for (const reader of [owner, await bearer('ou_bob'), null]) same(readDocSharePanel, (await post('share-panel', reader, { anchor, host_token: DOC })).json());
    same(readDocSharePanel, (await post('share-settings', owner, { anchor, self_serve: 'write', host_token: DOC })).json());
    same(readDocShareSelfReply, (await post('share-self', null, { anchor, host_token: DOC, label: '读者', rights: 'read' })).json());
    same(readDocShareRevealReply, (await post('share-reveal', owner, { anchor, share_id: pending.id })).json());
    same(readDocShareActionReply, (await post('share-action', null, { anchor, share_id: pending.id, action: 'terminate', host_token: DOC })).json());
    const made = (await post('share-invite', owner, { anchor, op: 'create' })).json();
    same(readDocShareInviteReply, made);
    same(readDocShareSelfReply, (await claim('invite-claim', { invite: secretOf(made.link), label: '外校老师', rights: 'write' })).json());
    same(readDocShareInviteReply, (await post('share-invite', owner, { anchor, op: 'revoke' })).json());
  });

  it('let a reader take a key without signing in, still only from the widget origin; a bearer that is there must be valid', async () => {
    const { app, bearer, post, create, store } = await harness();
    const { anchor } = await create();
    const ask = { anchor, host_token: DOC, label: '路过的读者', rights: 'read' };
    const taken = await post('share-self', null, ask);
    expect(taken.statusCode).toBe(200);
    expect(taken.headers['cache-control']).toBe('no-store');
    expect(taken.headers['access-control-allow-origin']).toBe(origin);
    expect(taken.json()).toEqual({
      share: { id: expect.stringMatching(/^shr_/), label: '路过的读者', rights: 'read', status: 'active', created_at: expect.any(Number), last_used_at: null, via: 'card', mine: false },
      connect: { claude: expect.stringContaining(' --scope user '), codex: expect.stringMatching(/^printf '/), endpoint: 'https://octopus.example/api/mcp', token: expect.stringMatching(/^mcp_[0-9a-f]{32}$/) },
    });
    expect(store.getActiveMcpTokenByHash(hashRunnerToken(taken.json().connect.token as string), new Date().toISOString())).toMatchObject({ username: 'lht' });
    // A signed-in reader's key is marked as theirs.
    const bob = await bearer('ou_bob');
    expect((await post('share-self', bob, { ...ask, label: '鲍勃' })).json().share).toMatchObject({ via: 'card', mine: true });
    expect((await post('share-panel', bob, { anchor })).json().shares.map((share: { label: string; mine: boolean }) => [share.label, share.mine]).sort())
      .toEqual([['张老师', false], ['路过的读者', false], ['鲍勃', true]].sort());
    // A present but unusable bearer is refused, not read as anonymous; foreign origins are refused as before.
    for (const authorization of ['Bearer fda_' + '0'.repeat(64), 'Bearer ', '', 'Basic bG9nOmlu']) {
      for (const op of ['share-panel', 'share-self', 'share-action']) {
        expect((await post(op, authorization, { ...ask, share_id: 'shr_x', action: 'terminate' })).statusCode, `${op} ${authorization}`).toBe(401);
      }
    }
    for (const headers of [{}, { origin: 'https://attacker.example' }]) {
      const answer = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}share-self`, headers, payload: ask });
      expect(answer.statusCode).toBe(403);
      expect(answer.headers['access-control-allow-origin']).toBeUndefined();
    }
    // A copied card takes nothing.
    expect((await post('share-self', null, { ...ask, host_token: OTHER })).statusCode).toBe(403);
    const preflight = await app.inject({ method: 'OPTIONS', url: `${DOCS_ADDON_PATH}share-self`, headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toBe('POST');
  });

  it('let only the owner set the ceiling and make or stop the claim link', async () => {
    const { bearer, post, create } = await harness();
    const { anchor } = await create();
    const owner = await bearer('ou_lht');
    for (const member of ['ou_bob', 'ou_guest']) {
      const reader = await bearer(member);
      expect((await post('share-settings', reader, { anchor, self_serve: 'off' })).json()).toEqual({ error: 'not_owner' });
      expect((await post('share-invite', reader, { anchor, op: 'create' })).json()).toEqual({ error: 'not_owner' });
    }
    expect((await post('share-settings', owner, { anchor, self_serve: 'admin' })).statusCode).toBe(400);
    const panel = await post('share-settings', owner, { anchor, self_serve: 'read', host_token: DOC });
    expect(panel.statusCode).toBe(200);
    expect(panel.json()).toMatchObject({ self_serve: 'read', viewer_is_owner: true, host_matches: true, limits: LIMITS });
    expect((await post('share-self', null, { anchor, host_token: DOC, label: 'x', rights: 'write' })).statusCode).toBe(403);
    const made = await post('share-invite', owner, { anchor, op: 'create' });
    expect(made.statusCode).toBe(200);
    expect(made.headers['cache-control']).toBe('no-store');
    expect(made.json()).toEqual({ invite: { active: true, created_at: expect.any(Number) }, link: expect.stringMatching(/^https:\/\/octopus\.example\/doc-key#i=dsi_[A-Za-z0-9_-]{43}$/) });
    expect((await post('share-panel', owner, { anchor })).json().invite).toEqual({ active: true, created_at: made.json().invite.created_at });
    expect((await post('share-invite', owner, { anchor, op: 'revoke' })).json()).toEqual({ invite: { active: false, created_at: null } });
    expect((await post('share-invite', owner, { anchor, op: 'rotate' })).statusCode).toBe(400);
  });

  it('give the claim surface its own method table and no CORS', async () => {
    const { app } = await harness();
    for (const [method, op] of [['GET', 'invite-info'], ['GET', 'invite-claim'], ['OPTIONS', 'invite-info'], ['OPTIONS', 'invite-claim']] as const) {
      const answer = await app.inject({ method, url: `${DOCS_ADDON_PATH}${op}`, headers: { host: BRIDGE, origin: `https://${BRIDGE}`, 'access-control-request-method': 'POST' } });
      expect(answer.statusCode, `${method} ${op}`).toBe(405);
      expect(answer.headers['access-control-allow-origin'], `${method} ${op}`).toBeUndefined();
    }
    // The widget's origin is not this page: it gets no claim answer, and the claim ops are not card ops.
    for (const op of ['invite-info', 'invite-claim']) {
      const answer = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}${op}`, headers: { host: BRIDGE, origin }, payload: {} });
      expect(answer.statusCode, op).toBe(403);
      expect(answer.headers['access-control-allow-origin']).toBeUndefined();
    }
    // The claim page is the Dashboard's (`/doc-key`): the bridge serves no page of its own.
    for (const op of ['key', 'keys']) {
      for (const method of ['GET', 'POST'] as const) expect((await app.inject({ method, url: `${DOCS_ADDON_PATH}${op}`, headers: { host: BRIDGE, origin: `https://${BRIDGE}` } })).statusCode).toBe(404);
    }
  });

  it('take a key through the claim link only from the claim page itself, with the secret in the body alone', async () => {
    const { bearer, post, claim, create, store, dms } = await harness();
    const { anchor } = await create();
    const secret = secretOf((await post('share-invite', await bearer('ou_lht'), { anchor, op: 'create' })).json().link);
    const info = await claim('invite-info', { invite: secret });
    expect(info.statusCode).toBe(200);
    expect(info.headers['cache-control']).toBe('no-store');
    expect(info.headers['access-control-allow-origin']).toBeUndefined();
    expect(info.json()).toEqual({ doc_title: '论文初稿', self_serve: 'write' });
    // Any other origin, or none, is refused before anything is read.
    for (const headers of [
      { host: BRIDGE } as Record<string, string>, { host: BRIDGE, origin: 'null' }, { host: BRIDGE, origin: `http://${BRIDGE}` }, { host: BRIDGE, origin: 'https://bridge.example' },
      { host: BRIDGE, origin: `https://${BRIDGE}.attacker.example` }, { host: 'attacker.example', origin: `https://${BRIDGE}` },
    ]) {
      for (const op of ['invite-info', 'invite-claim']) {
        const answer = await claim(op, { invite: secret, label: 'x', rights: 'read' }, headers);
        expect(answer.statusCode, `${op} ${JSON.stringify(headers)}`).toBe(403);
        expect(answer.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
    expect(store.listMcpTokens('lht')).toHaveLength(1);
    const taken = await claim('invite-claim', { invite: secret, label: '外校老师', rights: 'write' });
    expect(taken.statusCode).toBe(200);
    expect(taken.headers['cache-control']).toBe('no-store');
    expect(taken.json()).toEqual({
      share: expect.objectContaining({ label: '外校老师', rights: 'write', status: 'active', via: 'invite', mine: false }),
      connect: expect.objectContaining({ token: expect.stringMatching(/^mcp_/), endpoint: 'https://octopus.example/api/mcp' }),
    });
    expect(store.listMcpTokens('lht')).toHaveLength(2);
    // Only the body counts: a secret in the query string names nothing.
    const queried = await claim(`invite-info?invite=${secret}`, {});
    expect(queried.statusCode).toBe(404);
    expect(queried.json().error).toContain('领取链接');
    expect((await claim('invite-claim', { invite: `dsi_${'A'.repeat(43)}`, label: 'x', rights: 'read' })).statusCode).toBe(404);
    expect(JSON.stringify(dms)).not.toMatch(/mcp_|dsi_|dsa_|Bearer/);
  });
});
