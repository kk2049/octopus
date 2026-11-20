import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { FeishuDocsAddonAuth } from '../feishu/docs-addon-auth.js';
import { FeishuDocsAddonService } from '../feishu/docs-addon.js';
import { MIGRATIONS } from '../store/migrations.js';
import { FeishuDocsSharesRepository } from '../store/repositories/feishu-docs-shares.js';
import { buildPanelApp, panelHandler } from './http.js';
import { DOCS_ADDON_BODY_LIMIT, DOCS_ADDON_PATH, feishuDocsAddonPreGate, handleFeishuDocsAddon } from './routes/feishu-docs-addon.js';
import { PROMPT_MAX_BYTES } from '@claude-bot/feishu-docs-addon/protocol';

const origin = 'https://widget.feishu.cn';
const verifyCode = vi.fn(async () => ({ openId: 'ou_a', tenantKey: 't' }));
const auth = new FeishuDocsAddonAuth({ tenantKey: 't', allowedOrigins: [origin], verifyCode }, () => 'alice', vi.fn());
const db = new Database(':memory:');
for (const m of MIGRATIONS) db.exec(m.sql);
const service = new FeishuDocsAddonService(auth, { roster: vi.fn(), liveGrant: vi.fn(), decodeResourceId: vi.fn() }, { submit: vi.fn(), get: vi.fn() }, new FeishuDocsSharesRepository(db));
const app = buildPanelApp({ buildId: () => '', onInternalError: vi.fn() });
beforeAll(async () => {
  app.addHook('onRequest', (req, reply, done) => { if (feishuDocsAddonPreGate(service, req, reply)) done(); });
  app.route({ method: ['GET', 'POST', 'PUT', 'OPTIONS'], url: `${DOCS_ADDON_PATH}*`, bodyLimit: DOCS_ADDON_BODY_LIMIT, handler: panelHandler((req, reply) => handleFeishuDocsAddon(service, req, reply)) });
  await app.ready();
});
afterAll(async () => { service.close(); auth.close(); db.close(); await app.close(); });
it('rejects missing/foreign origins and methods before parsing malformed JSON', async () => {
  for (const headers of [{}, { origin: 'null' }, { origin: 'https://attacker.example' }]) {
    const response = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}login`, headers: { ...headers, 'content-type': 'application/json' }, payload: '{' });
    expect(response.statusCode).toBe(403); expect(response.headers['access-control-allow-origin']).toBeUndefined();
  }
  expect((await app.inject({ method: 'PUT', url: `${DOCS_ADDON_PATH}login`, headers: { origin }, payload: '{' })).statusCode).toBe(405);
  expect((await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}unknown`, headers: { origin }, payload: '{' })).statusCode).toBe(404);
  expect(verifyCode).not.toHaveBeenCalled();
});
it('answers only exact preflights and never enables ambient cookies', async () => {
  const response = await app.inject({ method: 'OPTIONS', url: `${DOCS_ADDON_PATH}view`, headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
  expect(response.statusCode).toBe(204);
  expect(response.headers['access-control-allow-origin']).toBe(origin);
  expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  expect(response.headers['access-control-max-age']).toBe('7200');
  const bad = await app.inject({ method: 'OPTIONS', url: `${DOCS_ADDON_PATH}send`, headers: { origin, 'access-control-request-method': 'DELETE' } });
  expect(bad.statusCode).toBe(403);
});
it('ignores Dashboard cookies, personal/admin tokens and credentials in query strings', async () => {
  for (const headers of [{ cookie: 'octopus_session=admin' }, { authorization: 'Bearer admin-token' }]) {
    const result = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}send?token=admin-token`, headers: { origin, ...headers }, payload: '{' });
    expect(result.statusCode).toBe(401);
  }
});
it('mints a scoped bearer and revokes it through its own logout endpoint', async () => {
  const response = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}login`, headers: { origin }, payload: { code: 'fresh', username: 'administrator' } });
  expect(response.statusCode).toBe(200);
  expect(response.json().username).toBe('alice');
  expect(response.headers['cache-control']).toBe('no-store');
  const token = response.json().token as string;
  expect(auth.authenticate(token, origin).username).toBe('alice');
  expect((await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}logout`, headers: { origin, authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}send`, headers: { origin, authorization: `Bearer ${token}` }, payload: '{' })).statusCode).toBe(401);
});
it('reads a card only through POST so its capability never lands in a URL', async () => {
  const login = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}login`, headers: { origin }, payload: { code: 'view-code' } });
  const authorization = `Bearer ${login.json().token as string}`;
  const share = `ds_${'a'.repeat(43)}`;
  expect((await app.inject({ method: 'GET', url: `${DOCS_ADDON_PATH}view?share=${share}`, headers: { origin, authorization } })).statusCode).toBe(405);
  const unknown = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}view`, headers: { origin, authorization }, payload: { share, since: '', after: -1 } });
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json().error).toBe('这张卡片的共享凭据无效');
});
it('reads older rows and whole messages through POST too, and takes a body as large as one session prompt', async () => {
  const login = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}login`, headers: { origin }, payload: { code: 'history-code' } });
  const authorization = `Bearer ${login.json().token as string}`;
  const share = `ds_${'a'.repeat(43)}`;
  for (const op of ['older', 'message']) {
    expect((await app.inject({ method: 'GET', url: `${DOCS_ADDON_PATH}${op}?share=${share}`, headers: { origin, authorization } })).statusCode).toBe(405);
    expect((await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}${op}`, headers: { origin, authorization }, payload: { share, before: 10, i: 3 } })).statusCode).toBe(404);
  }
  // A full prompt of newlines doubles under JSON escaping and still reaches the handler (which refuses the unknown share).
  const send = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}send`, headers: { origin, authorization, 'content-type': 'application/json' },
    payload: JSON.stringify({ share, prompt: '\n'.repeat(PROMPT_MAX_BYTES - 1) + 'x', requestId: '00000000-0000-4000-8000-000000000000' }) });
  expect(send.statusCode).not.toBe(413);
});
it('serves a file as an inert download whose description the card can read, and keeps new reads POST-only', async () => {
  const login = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}login`, headers: { origin }, payload: { code: 'file-code' } });
  const authorization = `Bearer ${login.json().token as string}`;
  const file = vi.spyOn(service, 'file').mockResolvedValueOnce({ kind: 'file', workspace: { workspaceId: 'ws', label: 'paper' }, path: 'results/fig.png', name: 'fig.png', size: 3, modifiedAt: '2026-10-18T00:00:00.000Z', chunks: (async function* () { yield Buffer.from('PN'); yield Buffer.from('G'); })() });
  const response = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}file`, headers: { origin, authorization }, payload: { share: `ds_${'a'.repeat(43)}`, path: 'results/fig.png' } });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('application/octet-stream');
  expect(response.headers['content-disposition']).toBe('attachment');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['access-control-expose-headers']).toBe('x-octopus-file');
  expect(JSON.parse(Buffer.from(String(response.headers['x-octopus-file']), 'base64url').toString())).toEqual({ kind: 'file', workspace: 'paper', path: 'results/fig.png', name: 'fig.png', size: 3, modifiedAt: '2026-10-18T00:00:00.000Z', mime: 'image/png' });
  // Streamed window by window under a declared length.
  expect(response.headers['content-length']).toBe('3');
  expect(response.rawPayload.toString()).toBe('PNG');
  expect(file).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }), `ds_${'a'.repeat(43)}`, 'results/fig.png', undefined);
  // A directory page carries the cursor that continues it; the card sends it back as `after`.
  file.mockResolvedValueOnce({ kind: 'dir', workspace: { workspaceId: 'ws', label: 'paper' }, path: 'results', truncated: true, next: 'file/b.txt',
    entries: [{ name: 'b.txt', path: 'results/b.txt', dir: false, size: 1 }] });
  const page = await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}file`, headers: { origin, authorization }, payload: { share: `ds_${'a'.repeat(43)}`, path: 'results/', after: 'file/a.txt' } });
  expect(page.json()).toEqual({ kind: 'dir', workspace: 'paper', path: 'results', truncated: true, next: 'file/b.txt', entries: [{ name: 'b.txt', path: 'results/b.txt', dir: false, size: 1 }] });
  expect(file).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'alice' }), `ds_${'a'.repeat(43)}`, 'results/', 'file/a.txt');
  for (const op of ['file', 'workspace', 'workspace-grant', 'launch']) {
    expect((await app.inject({ method: 'GET', url: `${DOCS_ADDON_PATH}${op}?share=x`, headers: { origin, authorization } })).statusCode).toBe(405);
  }
  expect((await app.inject({ method: 'POST', url: `${DOCS_ADDON_PATH}launch-options`, headers: { origin, authorization }, payload: {} })).statusCode).toBe(405);
});
