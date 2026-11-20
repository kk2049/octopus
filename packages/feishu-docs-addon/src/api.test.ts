import { describe, expect, it, vi } from 'vitest';
import { BridgeApi } from './api';

const json = (body: unknown, status = 200) => Response.json(body, { status });
const login = (token: string) => json({ token, username: 'alice', expiresAt: 123 });

it('calls the browser fetch with its Window receiver', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(function (this: unknown, input) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(String(input).endsWith('/login') ? login('fda_browser') : json({ sessions: [] }));
  });
  try {
    const api = new BridgeApi('https://bridge.example', async () => 'code');
    await api.sessions(); api.disconnect();
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { fetcher.mockRestore(); }
});

it('signs in on demand and keeps the token in memory headers, never cookies, storage or URLs', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(login('fda_test')).mockResolvedValue(json({ rev: '1.0', unchanged: true }));
  const api = new BridgeApi('https://bridge.example', async () => 'one-time', fetcher);
  await api.view('ds_share', '1.0', 4);
  expect(fetcher.mock.calls[0]).toMatchObject(['https://bridge.example/api/feishu/docs-addon/login', { method: 'POST', body: '{"code":"one-time"}' }]);
  expect(fetcher.mock.calls[1]).toMatchObject(['https://bridge.example/api/feishu/docs-addon/view', {
    method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer fda_test' }, body: '{"share":"ds_share","since":"1.0","after":4}' }]);
  expect(String(fetcher.mock.calls[1][0])).not.toContain('ds_share');
  expect(localStorage.length + sessionStorage.length).toBe(0);
});

it('repeats a call once with a fresh login when the bridge says the login ended', async () => {
  const codes = ['first', 'second'];
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(login('fda_one'))
    .mockResolvedValueOnce(json({ error: '连接已失效' }, 401))
    .mockResolvedValueOnce(login('fda_two'))
    .mockResolvedValueOnce(json({ id: 'op', status: 'submitted', message: '已提交', live: true }, 202));
  const api = new BridgeApi('https://bridge.example', async () => codes.shift()!, fetcher);
  await expect(api.send('ds_share', 'task', 'request-1')).resolves.toMatchObject({ id: 'op' });
  expect(fetcher.mock.calls[2][1]).toMatchObject({ body: '{"code":"second"}' });
  // The repeat carries the same request id: the bridge joins it rather than starting a second turn.
  expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[3][1]?.body);
  expect(fetcher.mock.calls[3][1]).toMatchObject({ headers: { Authorization: 'Bearer fda_two' } });
});

it('surfaces the bridge refusal text and does not retry anything but 401', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(login('fda_a')).mockResolvedValueOnce(json({ error: 'lht 已停止共享这个会话' }, 410));
  const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
  await expect(api.view('ds_share', '', -1)).rejects.toMatchObject({ status: 410, message: 'lht 已停止共享这个会话' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('logs a late login out again instead of reviving a closed card', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(json({ ok: true }));
  const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
  const pending = api.login();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  api.disconnect();
  finish(login('fda_late'));
  await expect(pending).rejects.toThrow('连接已取消');
  expect(fetcher.mock.calls[1]).toMatchObject(['https://bridge.example/api/feishu/docs-addon/logout', { headers: { Authorization: 'Bearer fda_late' } }]);
});

const share = { id: 's1', label: '论文润色', rights: 'write', status: 'paused', created_at: 1, last_used_at: null, via: 'owner', mine: false };
const assistantOff = { rights: null, project: null, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } };
const panelReply = { document_id: 'doc', host_matches: true, viewer_is_owner: true, card_state: 'present', lease_until: null, shares: [share],
  self_serve: 'write', app_access: 'edit', app_name: 'Octopus', invite: null, limits: { per_hour: 10, active_max: 50 }, assistant: assistantOff };
const connect = { claude: 'claude mcp add --transport http --scope user octopus-doc-s1 https://bridge.example/api/mcp --header "Authorization: Bearer t"',
  codex: 'printf x >> ~/.codex/config.toml', endpoint: 'https://bridge.example/api/mcp', token: 't' };
const sent = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number) => ({
  path: String(fetcher.mock.calls[call][0]).replace('https://bridge.example/api/feishu/docs-addon/', ''),
  auth: (fetcher.mock.calls[call][1]?.headers as Record<string, string> | undefined)?.Authorization,
  body: fetcher.mock.calls[call][1]?.body,
});

it('reads and changes a share card keys by its anchor in the body, and refuses a reply that breaks the contract', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(login('fda_s'))
    .mockResolvedValueOnce(json(panelReply))
    .mockResolvedValueOnce(json({ share }))
    .mockResolvedValueOnce(json({ error: 'not_owner' }, 403))
    .mockResolvedValueOnce(json({ document_id: 'doc', shares: 'none' }));
  const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
  expect((await api.sharePanel('dsa_anchor', 'wikcnHostToken')).shares).toEqual([share]);
  expect(fetcher.mock.calls[1]).toMatchObject(['https://bridge.example/api/feishu/docs-addon/share-panel', {
    method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer fda_s' }, body: '{"anchor":"dsa_anchor","host_token":"wikcnHostToken"}' }]);
  expect(await api.shareAction('dsa_anchor', 's1', 'pause')).toEqual({ share });
  expect(fetcher.mock.calls[2]).toMatchObject(['https://bridge.example/api/feishu/docs-addon/share-action', { body: '{"anchor":"dsa_anchor","share_id":"s1","action":"pause"}' }]);
  // The contract's error codes arrive as the error's message, for the card to word.
  await expect(api.shareAction('dsa_anchor', 's1', 'terminate')).rejects.toMatchObject({ status: 403, message: 'not_owner' });
  await expect(api.sharePanel('dsa_anchor')).rejects.toMatchObject({ status: 502 });
});

it('reveals a pending key by its anchor and id in the body, and surfaces an already-taken command as its code', async () => {
  const active = { ...share, status: 'active' };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(login('fda_r'))
    .mockResolvedValueOnce(json({ share: active, command: connect.claude, connect }))
    .mockResolvedValueOnce(json({ error: 'not_pending' }, 409));
  const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
  expect(await api.shareReveal('dsa_anchor', 's1')).toEqual({ share: active, command: connect.claude, connect });
  expect(fetcher.mock.calls[1]).toMatchObject(['https://bridge.example/api/feishu/docs-addon/share-reveal', {
    method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer fda_r' }, body: '{"anchor":"dsa_anchor","share_id":"s1"}' }]);
  await expect(api.shareReveal('dsa_anchor', 's1')).rejects.toMatchObject({ status: 409, message: 'not_pending' });
});

it('takes a key, sets self-serve and makes a claim link with the contract bodies, checking every reply', async () => {
  const mine = { ...share, id: 's2', status: 'active', via: 'card', mine: true };
  const link = `https://octopus.example/feishu/doc-key#i=dsi_${'Z'.repeat(43)}`;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(login('fda_o'))
    .mockResolvedValueOnce(json({ share: mine, connect }))
    .mockResolvedValueOnce(json({ ...panelReply, self_serve: 'read' }))
    .mockResolvedValueOnce(json({ invite: { active: true, created_at: 7 }, link }))
    .mockResolvedValueOnce(json({ invite: { active: false, created_at: null } }))
    .mockResolvedValueOnce(json({ share: mine, connect: { ...connect, endpoint: 'http://bridge.example/api/mcp' } }));
  const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
  expect(await api.shareSelf('dsa_anchor', 'doxcnHost', '张三的 Codex', 'write')).toEqual({ share: mine, connect });
  expect(sent(fetcher, 1)).toEqual({ path: 'share-self', auth: 'Bearer fda_o', body: '{"anchor":"dsa_anchor","host_token":"doxcnHost","label":"张三的 Codex","rights":"write"}' });
  expect((await api.shareSettings('dsa_anchor', 'read', 'doxcnHost')).self_serve).toBe('read');
  expect(sent(fetcher, 2)).toEqual({ path: 'share-settings', auth: 'Bearer fda_o', body: '{"anchor":"dsa_anchor","self_serve":"read","host_token":"doxcnHost"}' });
  expect(await api.shareInvite('dsa_anchor', 'create')).toEqual({ invite: { active: true, created_at: 7 }, link });
  expect(sent(fetcher, 3)).toEqual({ path: 'share-invite', auth: 'Bearer fda_o', body: '{"anchor":"dsa_anchor","op":"create"}' });
  expect(await api.shareInvite('dsa_anchor', 'revoke')).toEqual({ invite: { active: false, created_at: null } });
  // A key's ways in that break the contract are refused, without quoting them.
  await expect(api.shareSelf('dsa_anchor', 'doxcnHost', 'x', 'read')).rejects.toMatchObject({ status: 502 });
  // Tokens ride in bodies and headers, never in a URL.
  for (const [url] of fetcher.mock.calls) expect(String(url)).not.toMatch(/fda_|dsa_|dsi_/);
});

it('names the host\'s document on a key action when the card knows it', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(login('fda_h')).mockImplementation(async () => json({ share }));
  const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
  await api.shareAction('dsa_anchor', 's1', 'terminate', 'wikcnHost');
  await api.shareAction('dsa_anchor', 's1', 'pause');
  expect(sent(fetcher, 1)).toEqual({ path: 'share-action', auth: 'Bearer fda_h', body: '{"anchor":"dsa_anchor","share_id":"s1","action":"terminate","host_token":"wikcnHost"}' });
  expect(sent(fetcher, 2).body).toBe('{"anchor":"dsa_anchor","share_id":"s1","action":"pause"}');
});

describe('document assistants', () => {
  const view = { id: 'as_1', title: '整理第三节', guest: '张三', mine: true, state: 'ready', message: '可以对话', rights: 'write', created_at: 1, ended_at: null, pinned: false };
  const binding = { share: `ds_${'B'.repeat(43)}`, title: '整理第三节', owner: 'lht', device: 'desk', provider: 'claude' };
  const settings = { rights: 'write', project: { device: 'desk', workspace_id: 'ws_acc', label: 'ACC' }, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } };

  it('makes every assistant call signed in, with the contract bodies, and checks every reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(login('fda_g'))
      .mockResolvedValueOnce(json({ devices: [{ device: 'desk', label: 'desk', eligible: true, workspaces: [{ workspace_id: 'ws_acc', label: 'ACC' }] }] }))
      .mockResolvedValueOnce(json(settings))
      .mockResolvedValueOnce(json({ ...settings, rights: null, project: null }))
      .mockResolvedValueOnce(json({ assistants: [view] }))
      .mockResolvedValueOnce(json({ id: 'as_1' }))
      .mockResolvedValueOnce(json({ ...view, binding }))
      .mockResolvedValueOnce(json({ ...view, state: 'ended', ended_at: 2 }))
      .mockResolvedValueOnce(json({ block: 'blk_1' }));
    const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
    expect((await api.assistantTargets()).devices[0].workspaces).toEqual([{ workspace_id: 'ws_acc', label: 'ACC' }]);
    expect(await api.assistantConfigure('dsa_anchor', { rights: 'write', device: 'desk', workspace_id: 'ws_acc' })).toEqual(settings);
    expect((await api.assistantConfigure('dsa_anchor', { rights: null })).rights).toBeNull();
    expect((await api.assistantList('dsa_anchor')).assistants).toEqual([view]);
    expect(await api.assistantStart('dsa_anchor', 'doxcnHost', '整理第三节', 'req-1', '张三')).toEqual({ id: 'as_1' });
    expect((await api.assistantStatus('as_1')).binding).toEqual(binding);
    expect((await api.assistantEnd('as_1')).state).toBe('ended');
    expect(await api.assistantPin('as_1')).toEqual({ block: 'blk_1' });
    expect(fetcher.mock.calls.slice(1).map((_, k) => sent(fetcher, k + 1))).toEqual([
      { path: 'assistant-targets', auth: 'Bearer fda_g', body: '{}' },
      { path: 'assistant-configure', auth: 'Bearer fda_g', body: '{"anchor":"dsa_anchor","rights":"write","device":"desk","workspace_id":"ws_acc"}' },
      { path: 'assistant-configure', auth: 'Bearer fda_g', body: '{"anchor":"dsa_anchor","rights":null}' },
      { path: 'assistant-list', auth: 'Bearer fda_g', body: '{"anchor":"dsa_anchor"}' },
      { path: 'assistant-start', auth: 'Bearer fda_g', body: '{"anchor":"dsa_anchor","host_token":"doxcnHost","task":"整理第三节","request_id":"req-1","name":"张三"}' },
      { path: 'assistant-status', auth: 'Bearer fda_g', body: '{"id":"as_1"}' },
      { path: 'assistant-end', auth: 'Bearer fda_g', body: '{"id":"as_1"}' },
      { path: 'assistant-pin', auth: 'Bearer fda_g', body: '{"id":"as_1"}' },
    ]);
  });

  it('refuses a reply that breaks the contract, and never goes out without a login', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(login('fda_b'))
      .mockResolvedValueOnce(json({ ...view, binding: { ...binding, share: 'ds_short' } }))
      .mockResolvedValueOnce(json({ assistants: [{ ...view, state: 'running' }] }));
    const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
    await expect(api.assistantStatus('as_1')).rejects.toMatchObject({ status: 502, message: 'Octopus 返回的文档助手数据格式不对' });
    await expect(api.assistantList('dsa_anchor')).rejects.toMatchObject({ status: 502 });

    // A reader who cannot sign in reads the share panel without a bearer, but no assistant call goes out at all.
    const loginCode = vi.fn(async () => { throw new Error('用户未登录飞书'); });
    const anonymous = vi.fn<typeof fetch>().mockImplementation(async () => json(panelReply));
    const reader = new BridgeApi('https://bridge.example', loginCode, anonymous);
    await reader.sharePanel('dsa_anchor', 'doc');
    for (const call of [() => reader.assistantList('dsa_anchor'), () => reader.assistantStart('dsa_anchor', 'doc', 'x', 'r', ''), () => reader.assistantTargets()]) {
      await expect(call()).rejects.toThrow('用户未登录飞书');
    }
    expect(anonymous.mock.calls.map((_, k) => sent(anonymous, k).path)).toEqual(['share-panel']);
  });
});

describe('a share card reader who cannot sign in', () => {
  const codeRejects = async () => { throw new Error('用户未登录飞书'); };

  it('reads and takes keys without a bearer once the host has no login to give, and does not ask again on every read', async () => {
    const loginCode = vi.fn(codeRejects);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ ...panelReply, viewer_is_owner: false }))
      .mockResolvedValueOnce(json({ ...panelReply, viewer_is_owner: false }))
      .mockResolvedValueOnce(json({ share: { ...share, status: 'active', via: 'card' }, connect }))
      .mockResolvedValueOnce(json({ share: { ...share, status: 'terminated' } }));
    const api = new BridgeApi('https://bridge.example', loginCode, fetcher);
    expect((await api.sharePanel('dsa_anchor', 'doc')).viewer_is_owner).toBe(false);
    await api.sharePanel('dsa_anchor', 'doc');
    await api.shareSelf('dsa_anchor', 'doc', '访客', 'read');
    await api.shareAction('dsa_anchor', 's1', 'terminate', 'doc');
    expect(loginCode).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map((_, k) => sent(fetcher, k))).toEqual([
      { path: 'share-panel', auth: undefined, body: '{"anchor":"dsa_anchor","host_token":"doc"}' },
      { path: 'share-panel', auth: undefined, body: '{"anchor":"dsa_anchor","host_token":"doc"}' },
      { path: 'share-self', auth: undefined, body: '{"anchor":"dsa_anchor","host_token":"doc","label":"访客","rights":"read"}' },
      { path: 'share-action', auth: undefined, body: '{"anchor":"dsa_anchor","share_id":"s1","action":"terminate","host_token":"doc"}' },
    ]);
  });

  it('goes without a bearer when the bridge refuses the reader\'s tenant (403) or code (401) at sign-in', async () => {
    for (const status of [403, 401]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: '此飞书组织尚未接入 Octopus' }, status)).mockImplementation(async () => json(panelReply));
      const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
      await api.sharePanel('dsa_anchor', 'doc');
      await api.sharePanel('dsa_anchor', 'doc');
      expect(fetcher.mock.calls.map((_, k) => [sent(fetcher, k).path, sent(fetcher, k).auth])).toEqual([['login', undefined], ['share-panel', undefined], ['share-panel', undefined]]);
    }
  });

  it('does not take a network failure at sign-in for a reader who cannot sign in: the read fails, and the next one signs in', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(login('fda_n')).mockResolvedValueOnce(json(panelReply));
    const api = new BridgeApi('https://bridge.example', async () => 'code', fetcher);
    await expect(api.sharePanel('dsa_anchor', 'doc')).rejects.toMatchObject({ status: 0 });
    await api.sharePanel('dsa_anchor', 'doc');
    expect(sent(fetcher, 2)).toMatchObject({ path: 'share-panel', auth: 'Bearer fda_n' });
  });

  it('still needs the login for the owner\'s controls: they try to sign in and never go out without a bearer', async () => {
    const loginCode = vi.fn(codeRejects);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(panelReply));
    const api = new BridgeApi('https://bridge.example', loginCode, fetcher);
    await api.sharePanel('dsa_anchor', 'doc');
    for (const call of [() => api.shareSettings('dsa_anchor', 'off', 'doc'), () => api.shareInvite('dsa_anchor', 'create'), () => api.shareReveal('dsa_anchor', 's1'),
      () => api.shareAction('dsa_anchor', 's1', 'pause'), () => api.shareAction('dsa_anchor', 's1', 'resume')]) {
      await expect(call()).rejects.toThrow('用户未登录飞书');
    }
    expect(loginCode).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.map((_, k) => sent(fetcher, k).path)).toEqual(['share-panel']);
  });

  it('carries on without a bearer when a login ends and cannot be renewed, but answers an anonymous 401 as it is', async () => {
    const codes = vi.fn<() => Promise<string>>().mockResolvedValueOnce('first').mockImplementation(codeRejects);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(login('fda_old'))
      .mockResolvedValueOnce(json({ error: '连接已失效' }, 401))
      .mockResolvedValueOnce(json(panelReply))
      .mockResolvedValueOnce(json({ error: '需要登录' }, 401));
    const api = new BridgeApi('https://bridge.example', codes, fetcher);
    await api.sharePanel('dsa_anchor', 'doc');
    expect([sent(fetcher, 1).auth, sent(fetcher, 2).auth]).toEqual(['Bearer fda_old', undefined]);
    // Without a login there is none to renew: no sign-in loop, the bridge's answer stands.
    await expect(api.sharePanel('dsa_anchor', 'doc')).rejects.toMatchObject({ status: 401, message: '需要登录' });
    expect(codes).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

it('refuses a non-HTTPS bridge origin at construction', () => {
  expect(() => new BridgeApi('http://bridge.example', async () => 'code')).toThrow();
});
