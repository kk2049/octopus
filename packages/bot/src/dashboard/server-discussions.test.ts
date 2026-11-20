import { CapabilityService } from '@claude-bot/capability-kernel';
import { expect, it, vi } from 'vitest';
import { Store } from '../store/store.js';
import { DiscussionService } from '../discussions/service.js';
import { DiscussionCapabilities } from '../discussions/capability.js';
import { createDashboardTestServer } from '../e2e/dashboard-test-support.js';
import { mintDashboardToken } from './server.js';

it('binds meeting HTTP actions to a CSRF-protected human login and reads to membership', async () => {
  const store = new Store(':memory:'), kernel = new CapabilityService();
  for (const [index, username] of ['lht', 'lilei', 'other'].entries()) { store.saveUser({ username, uid: index + 1, home_dir: '/x', created_at: 'now' }); store.saveIdentity(username, { provider: 'feishu', externalId: `ou_${username}` }); }
  const create = vi.fn(async () => 'oc_test');
  const meetings = new DiscussionService(store, { create, send: vi.fn(), card: vi.fn(async () => 'card'), history: vi.fn() }, { enabled: true, filter: vi.fn(), run: vi.fn(async () => ({ kind: 'done' as const, text: '', toolCalls: 0 })) });
  const discussions = new DiscussionCapabilities(kernel, meetings, owner => Boolean(store.getUser(owner)));
  const server = createDashboardTestServer(store, undefined, { port: 0, host: '127.0.0.1', authToken: 'admin-test', discussions });
  try {
    await server.start(); const base = `http://127.0.0.1:${server.port}`;
    const login = async (owner: string) => {
      const token = mintDashboardToken(store, owner);
      const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }) });
      const cookies = response.headers.getSetCookie();
      return { token, cookie: cookies.map(value => value.split(';', 1)[0]).join('; '), csrf: /octopus_csrf=([0-9a-f]{64})/.exec(cookies.join(';'))![1] };
    };
    const lht = await login('lht'), lilei = await login('lilei'), other = await login('other');
    const args = { request_id: 'http-1', topic: '科研项目', participants: 'lilei' };
    const action = (auth: typeof lht, params = args, headers = {}) => fetch(`${base}/api/discussions/action`, { method: 'POST', headers: { cookie: auth.cookie, origin: base, 'x-csrf-token': auth.csrf, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action: 'discussion_start', args: params }) });
    expect((await fetch(`${base}/api/discussions`)).status).toBe(401);
    expect((await action(lht, args, { 'x-csrf-token': '' })).status).toBe(403);
    const bearer = await fetch(`${base}/api/discussions/action`, { method: 'POST', headers: { authorization: `Bearer ${lht.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'discussion_start', args }) });
    expect(bearer.status).toBe(403);
    expect((await action(lilei)).status).toBe(403);
    expect((await action(lht, { ...args, owner: 'other' } as typeof args)).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    const created = await action(lht); expect(created.status).toBe(200);
    const body = await created.json() as { result: { id: string } };
    const read = await fetch(`${base}/api/discussions?discussion_id=${body.result.id}`, { headers: { cookie: lilei.cookie } });
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ selected: { members: ['lht', 'lilei'], writable: false } });
    expect((await fetch(`${base}/api/discussions?discussion_id=${body.result.id}`, { headers: { cookie: other.cookie } })).status).toBe(403);
    expect((await action(lht)).status).toBe(200); expect(create).toHaveBeenCalledTimes(1);
  } finally { await server.stop(); await meetings.close(); kernel.close(); store.close(); }
});
