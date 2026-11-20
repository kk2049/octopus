import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SharePanel } from './SharePanel';
import {
  AgentApiError, type AgentApi, type DocShareAction, type DocShareConnect, type DocShareInviteReply, type DocShareLink, type DocSharePanel, type DocShareRecord,
  type DocShareRevealReply, type DocShareRights, type DocShareSelfReply, type DocShareSelfServe,
} from './protocol';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
const anchor = `dsa_${'K'.repeat(43)}`;
/** The claim page the bridge answers: a Dashboard page holding the secret in its fragment. */
const claimLink = (n: number) => `https://octopus.example/feishu/doc-key#i=dsi_${String(n).padStart(43, 'L')}`;
const year = new Date().getFullYear();
const link = (patch: Partial<DocShareLink> = {}): DocShareLink => ({
  id: 'sh_1', label: '论文润色', rights: 'write', status: 'active', created_at: new Date(year, 0, 2, 9, 5).getTime(), last_used_at: Date.now() - 3 * 60_000,
  via: 'owner', mine: false, ...patch,
});
const panel = (patch: Partial<DocSharePanel> = {}): DocSharePanel => ({
  document_id: 'doc', host_matches: true, viewer_is_owner: true, card_state: 'unknown', lease_until: null,
  shares: [link(), link({ id: 'sh_2', label: '评审助手', rights: 'read', status: 'paused', last_used_at: null, via: 'card' }), link({ id: 'sh_3', label: '旧客户端', status: 'terminated' })],
  self_serve: 'write', app_access: 'edit', app_name: 'Octopus 助手', invite: { active: false, created_at: null }, limits: { per_hour: 10, active_max: 50 },
  assistant: { rights: null, project: null, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } },
  ...patch,
});
/** Anyone but the owner: no owner controls, no claim link. */
const reader = (patch: Partial<DocSharePanel> = {}) => panel({ viewer_is_owner: false, invite: null, ...patch });
const AFTER: Record<DocShareAction, DocShareLink['status']> = { pause: 'paused', resume: 'active', terminate: 'terminated' };
/** What a key's ways in hold; `TOKEN` is the part that must never leave the card's memory. */
const TOKEN = 'omt_secret_7f3a9c';
const connect = (id: string): DocShareConnect => ({
  claude: `claude mcp add --transport http --scope user octopus-doc-${id} https://bridge.example/api/mcp --header "Authorization: Bearer ${TOKEN}"`,
  codex: `printf '[mcp_servers.octopus-doc-${id}] http_headers = { Authorization = "Bearer ${TOKEN}" }' >> ~/.codex/config.toml`,
  endpoint: 'https://bridge.example/api/mcp', token: TOKEN,
});
const ONCE = '只显示这一次，关闭或刷新后无法再看到；它等同密码，只发给要用它的人。';

/** A bridge in memory: what the card does changes what the next read reports. */
function setup({ reply = panel(), record = { v: 1, anchor }, surface = 'inline', name = '张三' }: {
  reply?: DocSharePanel | Error; record?: DocShareRecord; surface?: 'inline' | 'modal' | 'float'; name?: string | Promise<string>;
} = {}) {
  let current = reply;
  let made = 0;
  const live = () => { if (current instanceof Error) throw current; return current; };
  const host = { surface, float: vi.fn(async () => {}), fitHeight: vi.fn(async (_height: number) => {}), readerName: vi.fn(async () => name), documentTitle: vi.fn(async () => '组会周报') };
  const api = {
    sharePanel: vi.fn(async (_anchor: string, _host?: string): Promise<DocSharePanel> => live()),
    shareAction: vi.fn(async (_anchor: string, id: string, action: DocShareAction, _host?: string): Promise<{ share: DocShareLink }> => {
      const share = { ...live().shares.find((s) => s.id === id)!, status: AFTER[action] };
      current = { ...live(), shares: live().shares.map((s) => s.id === id ? share : s) };
      return { share };
    }),
    shareReveal: vi.fn(async (_anchor: string, id: string): Promise<DocShareRevealReply> => {
      const found = live().shares.find((s) => s.id === id)!;
      if (found.status !== 'pending') throw new AgentApiError(409, 'not_pending');
      const share: DocShareLink = { ...found, status: 'active' };
      current = { ...live(), shares: live().shares.map((s) => s.id === id ? share : s) };
      return { share, command: connect(id).claude, connect: connect(id) };
    }),
    shareSelf: vi.fn(async (_anchor: string, _host: string, label: string, rights: DocShareRights): Promise<DocShareSelfReply> => {
      const share = link({ id: `sh_n${++made}`, label, rights, created_at: Date.now(), last_used_at: null, via: 'card', mine: true });
      current = { ...live(), shares: [share, ...live().shares] };
      return { share, connect: connect(share.id) };
    }),
    shareSettings: vi.fn(async (_anchor: string, level: DocShareSelfServe, _host?: string): Promise<DocSharePanel> => {
      current = { ...live(), self_serve: level };
      return current;
    }),
    shareInvite: vi.fn(async (_anchor: string, op: 'create' | 'revoke'): Promise<DocShareInviteReply> => {
      const invite = op === 'create' ? { active: true, created_at: new Date(year, 9, 30, 8, 20 + made).getTime() } : { active: false, created_at: null };
      current = { ...live(), invite };
      return op === 'create' ? { invite, link: claimLink(++made) } : { invite };
    }),
    // The assistants tab (off in these scenes) and a conversation's own calls: never reached here.
    ...unused(['assistantTargets', 'assistantConfigure', 'assistantList', 'assistantStart', 'assistantStatus', 'assistantEnd', 'assistantPin', 'view', 'older', 'message', 'send', 'stop', 'fork', 'operation']),
  };
  const ui = (visible?: boolean) => <SharePanel host={host} api={api} doc={{ doc: 'doc', dark: false, ...(visible === undefined ? {} : { visible }) }} card={record}/>;
  const view = render(ui());
  return { api, host, view, set: (next: DocSharePanel | Error) => { current = next; }, visible: (on: boolean) => view.rerender(ui(on)) };
}
const row = (label: string) => screen.getByRole('listitem', { name: label });
/** Calls a scene must not make: each one fails the test that reaches it. */
const unused = <K extends keyof AgentApi>(names: K[]) => Object.fromEntries(names.map((name) => [name, vi.fn(async () => { throw new Error(`unexpected ${name}`); })])) as unknown as Pick<AgentApi, K>;
const ended = () => screen.getByRole('list', { name: '已停用的密钥', hidden: true });
const clipboard = (writeText: () => Promise<void>) => Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(writeText) }, configurable: true });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

describe('the owner', () => {
  it('sees every key with its rights, status, origin and last use, and the controls for each', async () => {
    const { api, view } = setup();
    const first = await screen.findByRole('listitem', { name: '论文润色' });
    // The host's own token goes along: whether it names the controlled document is the bridge's call.
    expect(api.sharePanel).toHaveBeenCalledWith(anchor, 'doc');
    expect(screen.getByRole('heading', { name: 'Octopus 文档协作' })).toBeTruthy();
    expect(within(first).getByText('读写')).toBeTruthy();
    expect(within(first).getByText('生效')).toBeTruthy();
    expect(within(first).getByText('创建于 01-02 09:05')).toBeTruthy();
    expect(within(first).getByText('3 分钟前')).toBeTruthy();
    expect(within(first).getAllByRole('button').map((b) => b.textContent)).toEqual(['暂停', '终止']);
    const paused = row('评审助手');
    expect(within(paused).getByText('只读')).toBeTruthy();
    expect(within(paused).getByText('已暂停')).toBeTruthy();
    expect(within(paused).getByText('自助领取于 01-02 09:05')).toBeTruthy();
    expect(within(paused).getByText('从未使用')).toBeTruthy();
    expect(within(paused).getAllByRole('button').map((b) => b.textContent)).toEqual(['恢复', '终止']);
    // Ended keys are folded away below the live ones, with nothing left to do.
    expect(screen.getByText('已停用的密钥（1）')).toBeTruthy();
    expect(within(ended()).getByText('旧客户端')).toBeTruthy();
    expect(within(ended()).queryByRole('button', { hidden: true })).toBeNull();
    expect(screen.getByText('所有者')).toBeTruthy();
    expect(screen.getByText('能看到这张卡片的人都可以领取读写或只读密钥，交给自己的 Agent。')).toBeTruthy();
    expect(screen.getByText('删除这张卡片会停止全部密钥，最迟 1 天；暂停、删除立即生效')).toBeTruthy();
    // No technical lease line.
    expect(view.container.textContent).not.toMatch(/下次确认|租约/);
  });

  it('shows a pause as pending at once, then the paused key, and reads the panel again', async () => {
    const { api } = setup();
    const answer = deferred<void>();
    api.shareAction.mockImplementationOnce(async (...args) => { await answer.promise; return api.shareAction.getMockImplementation()!(...args); });
    fireEvent.click(within(await screen.findByRole('listitem', { name: '论文润色' })).getByRole('button', { name: '暂停' }));
    expect(within(row('论文润色')).getByText('正在暂停…')).toBeTruthy();
    expect(within(row('论文润色')).queryByRole('button')).toBeNull();
    expect(api.shareAction).toHaveBeenCalledWith(anchor, 'sh_1', 'pause', 'doc');
    await act(async () => answer.resolve());
    await waitFor(() => expect(api.sharePanel).toHaveBeenCalledTimes(2));
    expect(within(row('论文润色')).getByText('已暂停')).toBeTruthy();
    fireEvent.click(within(row('论文润色')).getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(within(row('论文润色')).getByText('生效')).toBeTruthy());
    expect(api.shareAction).toHaveBeenLastCalledWith(anchor, 'sh_1', 'resume', 'doc');
  });

  it('asks before terminating, with the focus on cancel, and terminates only once confirmed', async () => {
    const { api } = setup();
    const first = await screen.findByRole('listitem', { name: '论文润色' });
    fireEvent.click(within(first).getByRole('button', { name: '终止' }));
    expect(within(first).getByText('终止后这个密钥永久失效，不能恢复。')).toBeTruthy();
    expect(document.activeElement).toBe(within(first).getByRole('button', { name: '取消' }));
    // Esc steps back, to the button that asked.
    fireEvent.keyDown(within(first).getByRole('group', { name: '确认终止' }), { key: 'Escape' });
    expect(within(first).queryByText(/永久失效/)).toBeNull();
    expect(document.activeElement).toBe(within(first).getByRole('button', { name: '终止' }));
    expect(api.shareAction).not.toHaveBeenCalled();
    fireEvent.click(within(first).getByRole('button', { name: '终止' }));
    fireEvent.click(within(first).getByRole('button', { name: '确认终止' }));
    expect(api.shareAction).toHaveBeenCalledWith(anchor, 'sh_1', 'terminate', 'doc');
    await waitFor(() => expect(within(ended()).getByText('论文润色')).toBeTruthy());
    expect(within(screen.getByRole('list', { name: '访问密钥' })).queryByRole('listitem', { name: '论文润色' })).toBeNull();
  });

  it('shows a refused action on its key, in words, and reads the key again', async () => {
    const { api, set } = setup();
    await screen.findByRole('listitem', { name: '论文润色' });
    // Terminated elsewhere since this panel was read.
    api.shareAction.mockImplementationOnce(async () => { set(panel({ shares: [link({ status: 'terminated' }), link({ id: 'sh_2', label: '评审助手' })] })); throw new AgentApiError(409, 'terminated'); });
    fireEvent.click(within(row('论文润色')).getByRole('button', { name: '暂停' }));
    expect(await within(row('论文润色')).findByText('暂停没有完成：这个密钥已经终止，不能再更改')).toBeTruthy();
    await waitFor(() => expect(api.sharePanel).toHaveBeenCalledTimes(2));
    // The key ended elsewhere: it shows so, and stays in sight with the reason until the card reloads.
    expect(within(row('论文润色')).getByText('已终止')).toBeTruthy();
    expect(within(row('论文润色')).queryByRole('button')).toBeNull();
    expect(within(row('论文润色')).getByText('暂停没有完成：这个密钥已经终止，不能再更改')).toBeTruthy();
  });

  it('chooses how much readers may take, shown at once and reverted when refused', async () => {
    const { api } = setup();
    await screen.findByRole('listitem', { name: '论文润色' });
    const toggle = screen.getByRole('button', { name: /设置/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const level = screen.getByRole('radiogroup', { name: '自助领取' });
    expect(within(level).getByRole('radio', { name: '读写' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/每小时最多领取 10 个，同时最多 50 个未终止的密钥。/)).toBeTruthy();
    const answer = deferred<void>();
    api.shareSettings.mockImplementationOnce(async (...args) => { await answer.promise; return api.shareSettings.getMockImplementation()!(...args); });
    fireEvent.click(within(level).getByRole('radio', { name: '只读' }));
    expect(within(level).getByRole('radio', { name: '只读' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('正在保存…')).toBeTruthy();
    expect(api.shareSettings).toHaveBeenCalledWith(anchor, 'read', 'doc');
    await act(async () => answer.resolve());
    await waitFor(() => expect(screen.queryByText('正在保存…')).toBeNull());
    expect(within(level).getByRole('radio', { name: '只读' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('能看到这张卡片的人都可以领取只读密钥，交给自己的 Agent。')).toBeTruthy();

    api.shareSettings.mockRejectedValueOnce(new AgentApiError(403, 'not_owner'));
    fireEvent.click(within(level).getByRole('radio', { name: '关闭' }));
    expect(await screen.findByText('保存设置没有完成：只有卡片所有者可以这样操作')).toBeTruthy();
    expect(within(level).getByRole('radio', { name: '只读' }).getAttribute('aria-checked')).toBe('true');
  });

  it('makes a claim link shown once, then only when it was made; resets and stops it', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));
    clipboard(async () => {});
    const { api, view } = setup();
    await screen.findByRole('listitem', { name: '论文润色' });
    fireEvent.click(screen.getByRole('button', { name: /设置/ }));
    fireEvent.click(screen.getByRole('button', { name: '生成链接' }));
    expect(api.shareInvite).toHaveBeenCalledWith(anchor, 'create');
    const box = await screen.findByRole('textbox', { name: '领取链接' }) as HTMLTextAreaElement;
    // Shown as the bridge answered it: the card builds no link of its own.
    const first = claimLink(1);
    expect(box.value).toBe(first);
    expect(screen.getByText('领取链接已生成')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '新的领取链接' }));
    expect(screen.getByText(/已生成于 10-30 08:20/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制领取链接' }));
    expect(await screen.findByText('已复制')).toBeTruthy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(first);
    fireEvent.click(screen.getByRole('button', { name: '我已保存，关闭' }));
    expect(screen.queryByRole('textbox', { name: '领取链接' })).toBeNull();
    expect(view.container.innerHTML).not.toContain('dsi_');
    expect(screen.getByText(/已生成于/)).toBeTruthy();

    // A new link replaces the old one, shown once again.
    fireEvent.click(screen.getByRole('button', { name: '重置链接' }));
    expect(((await screen.findByRole('textbox', { name: '领取链接' })) as HTMLTextAreaElement).value).toBe(claimLink(2));
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    expect(await screen.findByRole('button', { name: '生成链接' })).toBeTruthy();
    expect(api.shareInvite).toHaveBeenLastCalledWith(anchor, 'revoke');
    expect(screen.queryByRole('textbox', { name: '领取链接' })).toBeNull();
    expect(screen.queryByText(/已生成于/)).toBeNull();
    // Memory only.
    expect(setItem).not.toHaveBeenCalled();
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain('dsi_');
  });

  it('cannot take a key while self-serve is off, and is told where to turn it on', async () => {
    setup({ reply: panel({ self_serve: 'off' }) });
    await screen.findByRole('listitem', { name: '论文润色' });
    expect(screen.queryByRole('button', { name: '领取访问密钥' })).toBeNull();
    expect(screen.getByText('自助领取已关闭：只有你能创建密钥。可以在下方「设置」里开启。')).toBeTruthy();
  });
});

describe('any other reader', () => {
  it('may delete any key after confirming, and has no owner controls', async () => {
    const { api } = setup({ reply: reader() });
    const first = await screen.findByRole('listitem', { name: '论文润色' });
    expect(within(screen.getByRole('list', { name: '访问密钥' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['删除', '删除']);
    expect(screen.queryByText('所有者')).toBeNull();
    expect(screen.queryByRole('button', { name: /设置/ })).toBeNull();
    expect(screen.getByText('领取一个你自己的密钥交给你的 Agent；不再需要的密钥可以删除。')).toBeTruthy();
    fireEvent.click(within(first).getByRole('button', { name: '删除' }));
    expect(within(first).getByText('删除后，用这个密钥的 Agent 立即失去访问权限，不能恢复。')).toBeTruthy();
    fireEvent.click(within(first).getByRole('button', { name: '取消' }));
    expect(api.shareAction).not.toHaveBeenCalled();
    fireEvent.click(within(first).getByRole('button', { name: '删除' }));
    fireEvent.click(within(first).getByRole('button', { name: '确认删除' }));
    expect(within(row('论文润色')).getByText('正在删除…')).toBeTruthy();
    // A delete is the bridge's terminate, on the card in the document the host reports.
    expect(api.shareAction).toHaveBeenCalledWith(anchor, 'sh_1', 'terminate', 'doc');
    await waitFor(() => expect(within(ended()).getByText('论文润色')).toBeTruthy());
  });

  it('takes a key: the name prefilled, the rights up to the owner\'s level, its ways in shown once', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));
    clipboard(async () => {});
    const { api, view } = setup({ reply: reader() });
    await screen.findByRole('listitem', { name: '论文润色' });
    fireEvent.click(screen.getByRole('button', { name: '领取访问密钥' }));
    const form = screen.getByRole('form', { name: '领取访问密钥' });
    const name = within(form).getByRole('textbox', { name: /名字/ }) as HTMLInputElement;
    expect(name.value).toBe('张三');
    expect(document.activeElement).toBe(name);
    expect(within(form).getByRole('radio', { name: '读写' }).getAttribute('aria-checked')).toBe('true');
    expect(within(form).getByRole('radio', { name: '只读' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.change(name, { target: { value: '张三的 Codex' } });
    const answer = deferred<void>();
    api.shareSelf.mockImplementationOnce(async (...args) => { await answer.promise; return api.shareSelf.getMockImplementation()!(...args); });
    // Enter takes it.
    await userEvent.type(name, '{Enter}');
    expect(api.shareSelf).toHaveBeenCalledWith(anchor, 'doc', '张三的 Codex', 'write');
    expect(within(form).getByRole('button', { name: /正在领取/ })).toBeTruthy();
    await act(async () => answer.resolve());

    const secret = await screen.findByRole('region', { name: '「张三的 Codex」的接入方式' });
    expect(document.activeElement).toBe(secret);
    expect(screen.queryByRole('form', { name: '领取访问密钥' })).toBeNull();
    expect(within(secret).getByText('已领取「张三的 Codex」· 读写')).toBeTruthy();
    expect(within(secret).getByText(ONCE)).toBeTruthy();
    // The new key is listed at once, as the reader's own.
    const mine = row('张三的 Codex');
    expect(within(mine).getByText('我的')).toBeTruthy();
    expect(within(mine).getByText('生效')).toBeTruthy();
    // One tab per client, each with its own way in.
    expect(within(secret).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Claude Code', 'Codex', '其他客户端']);
    expect((within(secret).getByRole('textbox', { name: 'Claude Code 接入命令' }) as HTMLTextAreaElement).value).toBe(connect('sh_n1').claude);
    fireEvent.click(within(secret).getByRole('button', { name: '复制Claude Code 接入命令' }));
    expect(await within(secret).findByText('已复制')).toBeTruthy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(connect('sh_n1').claude);
    fireEvent.click(within(secret).getByRole('tab', { name: 'Codex' }));
    expect(within(secret).getByRole('tab', { name: 'Codex' }).getAttribute('aria-selected')).toBe('true');
    expect((within(secret).getByRole('textbox', { name: 'Codex 接入命令' }) as HTMLTextAreaElement).value).toBe(connect('sh_n1').codex);
    // Arrow keys move along the tabs.
    fireEvent.keyDown(within(secret).getByRole('tab', { name: 'Codex' }), { key: 'ArrowRight' });
    expect(within(secret).getByRole('tab', { name: '其他客户端' }).getAttribute('aria-selected')).toBe('true');
    expect((within(secret).getByRole('textbox', { name: 'MCP 地址' }) as HTMLTextAreaElement).value).toBe('https://bridge.example/api/mcp');
    expect((within(secret).getByRole('textbox', { name: '请求头' }) as HTMLTextAreaElement).value).toBe(`Authorization: Bearer ${TOKEN}`);
    // The read after the answer lists the key; its ways in stay until the reader closes them.
    await waitFor(() => expect(api.sharePanel).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('region', { name: '「张三的 Codex」的接入方式' })).toBeTruthy();
    fireEvent.click(within(secret).getByRole('button', { name: '我已保存，关闭' }));
    expect(screen.queryByRole('region', { name: /接入方式/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '领取访问密钥' }));
    expect(view.container.innerHTML).not.toContain(TOKEN);
    // Memory only: no storage, no cookie, no console.
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain(TOKEN);
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  it('takes only read keys when the owner allows no more', async () => {
    const { api } = setup({ reply: reader({ self_serve: 'read' }) });
    await screen.findByRole('listitem', { name: '论文润色' });
    expect(screen.getByText('领取一个你自己的只读密钥交给你的 Agent；不再需要的密钥可以删除。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '领取访问密钥' }));
    const form = screen.getByRole('form', { name: '领取访问密钥' });
    expect(within(form).queryByRole('radio')).toBeNull();
    expect(within(form).getByText('卡片所有者只允许领取只读密钥')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: '领取' }));
    await screen.findByRole('region', { name: '「张三」的接入方式' });
    expect(api.shareSelf).toHaveBeenCalledWith(anchor, 'doc', '张三', 'read');
    expect(screen.getByText('已领取「张三」· 只读')).toBeTruthy();
  });

  it('asks for a name, steps back on Esc, and says why a take was refused, keeping the form', async () => {
    const { api } = setup({ reply: reader() });
    await screen.findByRole('listitem', { name: '论文润色' });
    fireEvent.click(screen.getByRole('button', { name: '领取访问密钥' }));
    const form = screen.getByRole('form', { name: '领取访问密钥' });
    const name = within(form).getByRole('textbox', { name: /名字/ });
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(within(form).getByRole('button', { name: '领取' }));
    expect(within(form).getByText('请填写名字')).toBeTruthy();
    expect(api.shareSelf).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: '李四' } });
    api.shareSelf.mockRejectedValueOnce(new AgentApiError(429, 'rate_limited'));
    fireEvent.click(within(form).getByRole('button', { name: '领取' }));
    expect(await within(form).findByRole('alert')).toHaveProperty('textContent', '领取没有完成：这张卡片每小时最多领取 10 个密钥，请稍后再试');
    expect(screen.queryByRole('region', { name: /接入方式/ })).toBeNull();
    expect((within(form).getByRole('textbox', { name: /名字/ }) as HTMLInputElement).value).toBe('李四');

    fireEvent.keyDown(name, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: '领取访问密钥' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '领取访问密钥' })));
    // Opened again, the old refusal is gone.
    fireEvent.click(screen.getByRole('button', { name: '领取访问密钥' }));
    expect(within(screen.getByRole('form', { name: '领取访问密钥' })).queryByRole('alert')).toBeNull();
  });

  it('fills a name the host says late, but never over what the reader typed', async () => {
    const late = deferred<string>();
    setup({ reply: reader(), name: late.promise });
    await screen.findByRole('listitem', { name: '论文润色' });
    fireEvent.click(screen.getByRole('button', { name: '领取访问密钥' }));
    const name = screen.getByRole('textbox', { name: /名字/ }) as HTMLInputElement;
    expect(name.value).toBe('');
    await act(async () => late.resolve('王五'));
    expect(name.value).toBe('王五');
    cleanup();

    const typed = deferred<string>();
    setup({ reply: reader(), name: typed.promise });
    await screen.findByRole('listitem', { name: '论文润色' });
    fireEvent.click(screen.getByRole('button', { name: '领取访问密钥' }));
    fireEvent.change(screen.getByRole('textbox', { name: /名字/ }), { target: { value: '我的 Cursor' } });
    await act(async () => typed.resolve('王五'));
    expect((screen.getByRole('textbox', { name: /名字/ }) as HTMLInputElement).value).toBe('我的 Cursor');
  });

  it('cannot take a key while self-serve is off, and may still delete', async () => {
    setup({ reply: reader({ self_serve: 'off' }) });
    await screen.findByRole('listitem', { name: '论文润色' });
    expect(screen.queryByRole('button', { name: '领取访问密钥' })).toBeNull();
    expect(screen.getByText('卡片所有者关闭了自助领取，只有所有者可以创建密钥；不再需要的密钥你仍可以删除。')).toBeTruthy();
    expect(within(row('论文润色')).getByRole('button', { name: '删除' })).toBeTruthy();
  });

  it('takes and deletes keys without signing in: the bridge marks nothing as theirs, and the card never asks for a login', async () => {
    // This api has no login at all: the panel works with whatever the bridge client manages.
    const { api } = setup({ reply: reader({ shares: [link({ via: 'card' })] }), name: '' });
    await screen.findByRole('listitem', { name: '论文润色' });
    expect(screen.queryByText('我的')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '领取访问密钥' }));
    const name = screen.getByRole('textbox', { name: /名字/ }) as HTMLInputElement;
    expect(name.value).toBe('');
    fireEvent.change(name, { target: { value: '访客' } });
    fireEvent.click(screen.getByRole('button', { name: '领取' }));
    expect(await screen.findByText('已领取「访客」· 读写')).toBeTruthy();
    expect(api.shareSelf).toHaveBeenCalledWith(anchor, 'doc', '访客', 'write');
  });
});

describe('a pending key (the owner\'s, made through an agent)', () => {
  const pending = link({ id: 'sh_p', label: '韩梅梅的 Claude Code', status: 'pending', last_used_at: null });
  const NAME = '韩梅梅的 Claude Code';
  afterEach(() => { delete (navigator as { clipboard?: unknown }).clipboard; });
  const reveal = async () => fireEvent.click(within(await screen.findByRole('listitem', { name: NAME })).getByRole('button', { name: '显示接入命令' }));
  const commandBox = async () => await screen.findByRole('textbox', { name: 'Claude Code 接入命令' }) as HTMLTextAreaElement;

  it('shows as 待领取: its owner may take its ways in or terminate it, never pause it; anyone else may delete it', async () => {
    const owner = setup({ reply: panel({ shares: [pending] }) });
    const item = await screen.findByRole('listitem', { name: NAME });
    expect(within(item).getByText('待领取')).toBeTruthy();
    expect(within(item).getAllByRole('button').map((button) => button.textContent)).toEqual(['显示接入命令', '终止']);
    fireEvent.click(within(item).getByRole('button', { name: '终止' }));
    fireEvent.click(within(item).getByRole('button', { name: '确认终止' }));
    expect(owner.api.shareAction).toHaveBeenCalledWith(anchor, 'sh_p', 'terminate', 'doc');
    await waitFor(() => expect(within(ended()).getByText(NAME)).toBeTruthy());
    owner.view.unmount();

    setup({ reply: reader({ shares: [pending] }) });
    const seen = await screen.findByRole('listitem', { name: NAME });
    expect(within(seen).getByText('待领取')).toBeTruthy();
    expect(within(seen).getAllByRole('button').map((button) => button.textContent)).toEqual(['删除']);
  });

  it('reveals its ways in once, at the top, and forgets them when dismissed', async () => {
    clipboard(async () => {});
    const { api, view } = setup({ reply: panel({ self_serve: 'off', shares: [pending] }) });
    await reveal();
    expect(within(row(NAME)).getByText('正在生成接入方式…')).toBeTruthy();
    const box = await commandBox();
    expect(box.value).toBe(connect('sh_p').claude);
    expect(box.readOnly).toBe(true);
    expect(screen.getByText(`已启用「${NAME}」· 读写`)).toBeTruthy();
    expect(screen.getByText(ONCE)).toBeTruthy();
    expect(api.shareReveal).toHaveBeenCalledWith(anchor, 'sh_p');
    // The read after the reveal shows the key active; its ways in stay until the owner dismisses them.
    await waitFor(() => expect(api.sharePanel).toHaveBeenCalledTimes(2));
    expect(within(row(NAME)).getByText('生效')).toBeTruthy();
    expect((await commandBox()).value).toBe(connect('sh_p').claude);
    fireEvent.click(screen.getByRole('button', { name: '我已保存，关闭' }));
    expect(screen.queryByRole('textbox', { name: 'Claude Code 接入命令' })).toBeNull();
    expect(view.container.innerHTML).not.toContain(TOKEN);
    // No take button while self-serve is off: the focus goes to the list's heading.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '访问密钥' }));
  });

  it('selects the command for a copy by hand when the frame blocks the clipboard', async () => {
    clipboard(async () => { throw new DOMException('Write permission denied.', 'NotAllowedError'); });
    setup({ reply: panel({ shares: [pending] }) });
    await reveal();
    const box = await commandBox();
    fireEvent.click(screen.getByRole('button', { name: '复制Claude Code 接入命令' }));
    expect(await screen.findByText('已选中，请按 ⌘/Ctrl + C 复制')).toBeTruthy();
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, connect('sh_p').claude.length]);
    expect(document.activeElement).toBe(box);
  });

  it('says when its command was already taken, and shows none', async () => {
    const { api } = setup({ reply: panel({ shares: [pending] }) });
    api.shareReveal.mockRejectedValueOnce(new AgentApiError(409, 'not_pending'));
    await reveal();
    expect(await within(row(NAME)).findByText('这个密钥的接入命令已经领取过；如果丢失，请终止后重新创建。')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Claude Code 接入命令' })).toBeNull();
    await waitFor(() => expect(api.sharePanel).toHaveBeenCalledTimes(2));
  });

  it('shows no ways in after the card reloads: the bridge gives them once', async () => {
    const first = setup({ reply: panel({ shares: [pending] }) });
    await reveal();
    await commandBox();
    first.view.unmount();
    render(<SharePanel host={first.host} api={first.api} doc={{ doc: 'doc', dark: false }} card={{ v: 1, anchor }}/>);
    expect(await within(await screen.findByRole('listitem', { name: NAME })).findByText('生效')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Claude Code 接入命令' })).toBeNull();
    expect(first.api.shareReveal).toHaveBeenCalledOnce();
  });
});

describe('the app every key acts as', () => {
  const banner = () => screen.queryByText(/读写密钥现在只能读|密钥现在还读不到这篇文档/);

  it('is named, with the way to give it access, when it can only view while keys could write', async () => {
    const { api } = setup({ reply: reader({ app_access: 'view' }) });
    await screen.findByRole('listitem', { name: '论文润色' });
    expect(screen.getByText('读写密钥现在只能读')).toBeTruthy();
    expect(screen.getByText(/每个密钥都以飞书应用「Octopus 助手」的身份访问文档，它现在只能查看。请文档所有者在「…」→「添加文档应用」中添加「Octopus 助手」，并给它「可编辑」权限。/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    await waitFor(() => expect(api.sharePanel).toHaveBeenCalledTimes(2));
  });

  it('is left unsaid while nothing could write, or when it may edit or the bridge cannot tell', async () => {
    const readOnly = [link({ rights: 'read' }), link({ id: 'sh_x', label: '旧的', rights: 'write', status: 'terminated' }), link({ id: 'sh_y', label: '待领取的', rights: 'write', status: 'pending' })];
    for (const patch of [{ app_access: 'view', self_serve: 'read', shares: readOnly }, { app_access: 'edit' }, { app_access: 'unknown' }] as Array<Partial<DocSharePanel>>) {
      const view = setup({ reply: reader(patch) });
      await screen.findByRole('listitem', { name: '论文润色' });
      expect(banner()).toBeNull();
      view.view.unmount();
    }
    // A paused write key could write again once resumed.
    setup({ reply: reader({ app_access: 'view', self_serve: 'off', shares: [link({ status: 'paused' })] }) });
    await screen.findByRole('listitem', { name: '论文润色' });
    expect(screen.getByText('读写密钥现在只能读')).toBeTruthy();
  });

  it('says no key can read the document when the app was never added, and asks for what the keys need', async () => {
    setup({ reply: reader({ app_access: 'none', self_serve: 'read', app_name: null, shares: [] }) });
    expect(await screen.findByText('密钥现在还读不到这篇文档')).toBeTruthy();
    expect(screen.getByText(/飞书应用「Octopus 应用」.*它还没有被添加到这篇文档.*给它「可阅读」权限/)).toBeTruthy();
  });
});

it('says when there are no keys yet, and keeps the rows while a refresh is on its way or fails', async () => {
  const empty = setup({ reply: panel({ shares: [] }) });
  expect(await screen.findByText('还没有访问密钥')).toBeTruthy();
  expect(screen.getByText(/点「领取访问密钥」，把它添加到 Claude Code 或 Codex/)).toBeTruthy();
  empty.view.unmount();

  const { api } = setup();
  await screen.findByRole('listitem', { name: '论文润色' });
  let fail!: (e: Error) => void;
  api.sharePanel.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(row('论文润色')).toBeTruthy();
  await act(async () => fail(new AgentApiError(0, '暂时连不上 Octopus，请检查网络')));
  expect(screen.getByText(/刷新没有完成：暂时连不上 Octopus/)).toBeTruthy();
  expect(row('论文润色')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByText(/刷新没有完成/)).toBeNull());
  expect(api.sharePanel).toHaveBeenCalledTimes(3);
});

it('shows nothing of a card the bridge says is not in this document, to its owner or anyone else: not its keys, not a button', async () => {
  for (const reply of [panel({ host_matches: false }), reader({ host_matches: false })]) {
    const { api } = setup({ reply });
    expect(await screen.findByText('此卡片不属于本文档')).toBeTruthy();
    expect(screen.getByText('它从另一篇文档复制而来，这里不显示也不能更改那篇文档的密钥。')).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('所有者')).toBeNull();
    expect(api.shareSelf).not.toHaveBeenCalled();
    cleanup();
  }
});

it('leaves the document match to the bridge: another id that matches is no copy, and an unknown match only names the document', async () => {
  // A wiki page: the host reports the wiki token, the keys control the docx behind it.
  const wiki = setup({ reply: panel({ document_id: 'doxcnBehindTheWiki', host_matches: true }) });
  expect(await screen.findByRole('listitem', { name: '论文润色' })).toBeTruthy();
  expect(screen.queryByText('此卡片不属于本文档')).toBeNull();
  expect(screen.queryByText(/这些密钥作用于文档/)).toBeNull();
  wiki.view.unmount();

  const unmatched = setup({ reply: panel({ document_id: 'doxcnElsewhere', host_matches: null }) });
  expect(await screen.findByRole('listitem', { name: '论文润色' })).toBeTruthy();
  expect(screen.queryByText('此卡片不属于本文档')).toBeNull();
  expect(screen.getByText('这些密钥作用于文档 doxcnElsewhere')).toBeTruthy();
  expect(within(row('论文润色')).getByRole('button', { name: '暂停' })).toBeTruthy();
  unmatched.view.unmount();

  // The bridge names the document to the owner alone: a reader's empty id shows no line, and no id anywhere.
  const { view } = setup({ reply: reader({ document_id: '', host_matches: null }) });
  expect(await screen.findByRole('listitem', { name: '论文润色' })).toBeTruthy();
  expect(screen.queryByText(/这些密钥作用于文档/)).toBeNull();
  expect(view.container.textContent).not.toMatch(/doxcn/);
  expect(within(row('论文润色')).getByRole('button', { name: '删除' })).toBeTruthy();
});

it('lists an assistant\'s own key, as a bridge from before assistants does, as plainly created', async () => {
  setup({ reply: panel({ shares: [link({ id: 'sh_a', label: '文档助手 · 张三', via: 'assistant' })] }) });
  const key = await screen.findByRole('listitem', { name: '文档助手 · 张三' });
  expect(within(key).getByText('创建于 01-02 09:05')).toBeTruthy();
  expect(within(key).getAllByRole('button').map((b) => b.textContent)).toEqual(['暂停', '终止']);
});

it('says when Octopus does not know the card, and when the card was missing at the last check', async () => {
  const unknown = setup({ reply: new AgentApiError(404, 'unknown_anchor') });
  expect(await screen.findByText('Octopus 不认识这张卡片')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  unknown.view.unmount();

  // Missing: every key already stopped. The bridge re-checks when the panel opens, so a refresh usually finds the card again.
  const { api, set } = setup({ reply: panel({ card_state: 'missing' }) });
  expect(await screen.findByText('上次检查时文档里没有这张卡片，所有密钥已停止。卡片恢复后，打开本卡片或下次有人使用密钥时会重新检查。')).toBeTruthy();
  set(panel({ card_state: 'present', lease_until: Date.now() - 60_000 }));
  const notice = screen.getByText(/所有密钥已停止/).closest('.notice') as HTMLElement;
  fireEvent.click(within(notice).getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(screen.queryByText(/所有密钥已停止/)).toBeNull());
  expect(api.sharePanel).toHaveBeenCalledTimes(2);
  // A lease in the past is the bridge's business, not the reader's.
  expect(screen.queryByText(/下次确认/)).toBeNull();
});

it('words the bridge\'s refusal of the panel itself, and retries a failed read', async () => {
  const signin = setup({ reply: new AgentApiError(401, '需要飞书登录') });
  expect(await screen.findByText('需要登录飞书')).toBeTruthy();
  signin.set(panel());
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('listitem', { name: '论文润色' })).toBeTruthy();
  signin.view.unmount();

  setup({ reply: new AgentApiError(403, '此飞书组织尚未接入 Octopus') });
  expect(await screen.findByText('仅限本组织成员查看')).toBeTruthy();
  expect(screen.getByText('此飞书组织尚未接入 Octopus')).toBeTruthy();
  cleanup();

  const { set } = setup({ reply: new AgentApiError(0, '暂时连不上 Octopus，请检查网络') });
  expect(await screen.findByText('暂时连不上 Octopus')).toBeTruthy();
  set(panel());
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('listitem', { name: '论文润色' })).toBeTruthy();
});

it('shows a Record it cannot read as an error, without asking the bridge', () => {
  const broken = setup({ record: { invalid: 'malformed' } });
  expect(screen.getByText('无法读取这张卡片')).toBeTruthy();
  expect(broken.api.sharePanel).not.toHaveBeenCalled();
  broken.view.unmount();
  setup({ record: { invalid: 'version' } });
  expect(screen.getByText('这张卡片需要更新版本的组件')).toBeTruthy();
});

it('opens beside the document from the inline card only, and says when the host would not', async () => {
  const { host } = setup();
  await screen.findByRole('listitem', { name: '论文润色' });
  fireEvent.click(screen.getByRole('button', { name: '在侧边栏打开' }));
  expect(host.float).toHaveBeenCalledOnce();
  host.float.mockRejectedValueOnce(new Error('当前视图不支持'));
  fireEvent.click(screen.getByRole('button', { name: '在侧边栏打开' }));
  expect(await screen.findByText('没有打开侧边栏：当前视图不支持')).toBeTruthy();
  cleanup();

  for (const surface of ['float', 'modal'] as const) {
    setup({ surface });
    await screen.findByRole('listitem', { name: '论文润色' });
    expect(screen.queryByRole('button', { name: '在侧边栏打开' })).toBeNull();
    cleanup();
  }
});

it('asks the host to fit the inline card to its content, within bounds, and only when it moves', async () => {
  const observers: Array<() => void> = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
  const size = { card: 560, body: 466, content: 300 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.classList.contains('share-card') ? size.card : this.classList.contains('share-body') ? size.body : this.classList.contains('share-content') ? size.content : 0;
    return { height, width: 0, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, toJSON: () => ({}) };
  });
  const { host } = setup();
  await screen.findByRole('listitem', { name: '论文润色' });
  const settle = () => act(async () => { observers.forEach((observe) => observe()); await new Promise((resolve) => setTimeout(resolve, 120)); });
  // Header and footer (560 - 466) plus the content's own 300.
  await settle();
  expect(host.fitHeight).toHaveBeenLastCalledWith(394);
  // The host obliged: nothing moved, nothing asked.
  Object.assign(size, { card: 394, body: 300 });
  await settle();
  expect(host.fitHeight).toHaveBeenCalledOnce();
  // A shift under 4px is not worth a resize.
  size.content = 303;
  await settle();
  expect(host.fitHeight).toHaveBeenCalledOnce();
  // Past the cap the body scrolls; below the floor the card stays readable.
  size.content = 2000;
  await settle();
  expect(host.fitHeight).toHaveBeenLastCalledWith(720);
  Object.assign(size, { card: 720, body: 626, content: 10 });
  await settle();
  expect(host.fitHeight).toHaveBeenLastCalledWith(120);
  cleanup();

  // The side card and the large view fill what the host gives them.
  observers.length = 0;
  const side = setup({ surface: 'float' });
  await screen.findByRole('listitem', { name: '论文润色' });
  expect(observers).toHaveLength(0);
  expect(side.host.fitHeight).not.toHaveBeenCalled();
});

it('follows what others do while on screen, and stops while scrolled away', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { api, visible } = setup({ reply: reader() });
  await screen.findByRole('listitem', { name: '论文润色' });
  expect(api.sharePanel).toHaveBeenCalledOnce();
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(api.sharePanel).toHaveBeenCalledTimes(2);
  visible(false);
  await act(async () => { vi.advanceTimersByTime(90_000); });
  expect(api.sharePanel).toHaveBeenCalledTimes(2);
  visible(true);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(api.sharePanel).toHaveBeenCalledTimes(3);
});
