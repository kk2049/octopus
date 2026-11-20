import { afterEach, describe, expect, it, vi } from 'vitest';
import { docsAddonCodeVerifier, FeishuDocsAddonAuth, feishuDocsAddonOptions } from './docs-addon-auth.js';

const origin = 'https://widget.feishu.cn';
const otherOrigin = 'https://another.feishu.cn';
const instances: FeishuDocsAddonAuth[] = [];
afterEach(() => { for (const auth of instances.splice(0)) auth.close(); });
function setup() {
  let now = 1000;
  const owners = new Map([['ou_alice', 'alice']]);
  const verify = vi.fn(async () => ({ openId: 'ou_alice', tenantKey: 'tenant-key' }));
  const end = vi.fn();
  const auth = new FeishuDocsAddonAuth({ tenantKey: 'tenant-key', allowedOrigins: [origin, otherOrigin], verifyCode: verify }, id => owners.get(id), end, () => now);
  instances.push(auth);
  return { auth, verify, end, owners, advance: (ms: number) => { now += ms; } };
}
describe('native Feishu Docs identity boundary', () => {
  it('is off by default and requires explicit application, tenant and HTTPS origins', () => {
    expect(feishuDocsAddonOptions(undefined, null)).toBeUndefined();
    expect(() => feishuDocsAddonOptions({ enabled: true, tenant_key: 't', allowed_origins: [origin] }, null)).toThrow();
    for (const value of ['null', '*', 'https://widget.feishu.cn/path', 'http://widget.feishu.cn']) {
      expect(() => new FeishuDocsAddonAuth({ tenantKey: 't', allowedOrigins: [value], verifyCode: vi.fn() }, () => 'alice', vi.fn())).toThrow();
    }
  });
  it('derives the owner only from verified identity and binds a scoped token to its origin', async () => {
    const { auth } = setup();
    const login = await auth.login('one-use-code', origin);
    expect(login).toMatchObject({ username: 'alice', expiresAt: 1_801_000 });
    const identity = auth.authenticate(login.token, origin);
    expect(identity).toMatchObject({ username: 'alice', openId: 'ou_alice' });
    expect(identity.credential).not.toContain(login.token);
    expect(() => auth.authenticate(login.token, otherOrigin)).toThrow();
    expect(auth.authenticate(login.token, origin).username).toBe('alice');
    for (const key of ['admin-token', login.token.slice(4), 'fda_bad']) expect(() => auth.authenticate(key, origin)).toThrow();
  });
  it('rejects foreign tenants; a tenant member without an account becomes an observer, never a registered user', async () => {
    const { auth, verify, owners, end } = setup();
    verify.mockResolvedValueOnce({ openId: 'ou_alice', tenantKey: 'stranger' });
    await expect(auth.login('foreign', origin)).rejects.toMatchObject({ status: 403 });
    verify.mockResolvedValueOnce({ openId: 'ou_guest', tenantKey: 'tenant-key' });
    const guest = await auth.login('member', origin);
    expect(guest.username).toBeNull();
    expect(auth.authenticate(guest.token, origin)).toMatchObject({ username: null, openId: 'ou_guest' });
    expect(owners.has('ou_guest')).toBe(false);
    // Gaining an account later ends the observer login instead of silently upgrading it.
    owners.set('ou_guest', 'guest');
    expect(() => auth.authenticate(guest.token, origin)).toThrow();
    expect(end).not.toHaveBeenCalled();
  });
  it('blocks replay even while the first code exchange is pending', async () => {
    const { auth, verify } = setup();
    let finish!: (value: { openId: string; tenantKey: string }) => void;
    verify.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = auth.login('code', origin);
    await expect(auth.login('code', origin)).rejects.toMatchObject({ status: 401 });
    finish({ openId: 'ou_alice', tenantKey: 'tenant-key' });
    await first;
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it('ends only that login on expiry, logout and account identity rebinding', async () => {
    const { auth, owners, end, advance } = setup();
    const a = await auth.login('a', origin);
    const b = await auth.login('b', origin);
    const identity = auth.authenticate(a.token, origin);
    auth.logout(identity);
    expect(() => auth.authenticate(a.token, origin)).toThrow();
    expect(auth.authenticate(b.token, origin).username).toBe('alice');
    owners.set('ou_alice', 'mallory');
    expect(() => auth.authenticate(b.token, origin)).toThrow();
    expect(end).toHaveBeenCalledTimes(2);
    owners.set('ou_alice', 'alice');
    const c = await auth.login('c', origin);
    advance(15 * 60_000 + 1);
    expect(() => auth.authenticate(c.token, origin)).toThrow();
    expect(end).toHaveBeenCalledTimes(3);
  });
  it('does not issue a token when the service closes during upstream login', async () => {
    const { auth, verify } = setup();
    let finish!: (value: { openId: string; tenantKey: string }) => void;
    verify.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = auth.login('code', origin);
    auth.close(); finish({ openId: 'ou_alice', tenantKey: 'tenant-key' });
    await expect(first).rejects.toMatchObject({ status: 503 });
  });
  it('exchanges with the fixed official API and discards all returned Feishu credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ code: 0, app_access_token: 'app-secret-token', expire: 7200 }))
      .mockResolvedValueOnce(Response.json({ code: 0, data: { open_id: 'ou_a', tenant_key: 't', access_token: 'never-forward', refresh_token: 'never-save' } }));
    const verify = docsAddonCodeVerifier({ appId: 'app', appSecret: 'secret' }, fetcher);
    expect(await verify('one-time')).toEqual({ openId: 'ou_a', tenantKey: 't' });
    expect(fetcher.mock.calls[1]).toMatchObject(['https://open.feishu.cn/open-apis/mina/v2/tokenLoginValidate', { body: '{"code":"one-time"}', redirect: 'error', headers: { Authorization: 'Bearer app-secret-token' } }]);
    fetcher.mockResolvedValueOnce(Response.json({ code: 9001, msg: 'secret-in-upstream-error' }));
    await expect(verify('bad')).rejects.toThrow('飞书身份验证未完成');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
