import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SharePanel } from './SharePanel';
import {
  AgentApiError, type AgentOperation, type AssistantSettings, type AssistantStatus, type AssistantTarget, type AssistantView, type CardFrame,
  type DocSharePanel, type DocShareRights,
} from './protocol';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const anchor = `dsa_${'K'.repeat(43)}`;
const SHARE = `ds_${'Q'.repeat(43)}`;
const limits = { per_card: 20, per_guest: 3, per_guest_per_day: 10 };
const ON: AssistantSettings = { rights: 'write', project: { device: 'desk', workspace_id: 'ws_acc', label: '论文项目' }, limits };
const OFF: AssistantSettings = { rights: null, project: null, limits };
const TARGETS: AssistantTarget[] = [
  { device: 'desk', label: 'desk', eligible: true, workspaces: [{ workspace_id: 'ws_acc', label: '论文项目' }, { workspace_id: 'ws_lora', label: 'lora-merge' }] },
  { device: 'old', label: 'lab-server', eligible: false, reason: 'Runner 需要升级', workspaces: [] },
];
const assistant = (patch: Partial<AssistantView> = {}): AssistantView => ({
  id: 'as_1', title: '整理第三节的实验数据', guest: '张三', mine: true, state: 'ready', message: '可以对话', rights: 'write', created_at: Date.now() - 25 * 60_000, ended_at: null, pinned: false, ...patch,
});
const panel = (owner: boolean, settings: AssistantSettings): DocSharePanel => ({
  document_id: 'doc', host_matches: true, viewer_is_owner: owner, card_state: 'present', lease_until: null, shares: [], self_serve: 'write', app_access: 'edit', app_name: 'Octopus',
  invite: owner ? { active: false, created_at: null } : null, limits: { per_hour: 10, active_max: 50 }, assistant: settings,
});
const frame = (canTalk = true): CardFrame => ({
  rev: '1', role: 'viewer', title: '整理第三节的实验数据', owner: 'lht', device: 'desk', provider: 'claude', status: { working: false, state: 'idle' }, total: 2, reset: true,
  messages: [{ i: 0, role: 'user', text: '请把第三节的实验数据整理成一张表' }, { i: 1, role: 'assistant', text: '好的，表格已经**写进第三节**。' }],
  canTalk, assistant: { guest: '张三', pinned: false },
});

/** A bridge in memory for the assistants tab: what the panel does changes what the next answer says. */
type PanelApi = Parameters<typeof SharePanel>[0]['api'];
function setup({ owner = false, settings = ON, list = [assistant()], targets = TARGETS, status = 'ready' as 'ready' | 'failed', canTalk = true, access = 'edit' as DocSharePanel['app_access'] } = {}) {
  let current: DocSharePanel = { ...panel(owner, settings), app_access: access };
  let assistants = list;
  let made = 0;
  const ready = (view: AssistantView): AssistantStatus => ({ ...view, binding: { share: SHARE, title: view.title, owner: 'lht', device: 'desk', provider: 'claude' } });
  const host = { surface: 'inline' as const, float: vi.fn(async () => {}), fitHeight: vi.fn(async () => {}), readerName: vi.fn(async () => '张三'), documentTitle: vi.fn(async () => '组会周报') };
  const op = (): AgentOperation => ({ id: 'op', status: 'succeeded', message: 'Agent 已接收输入', live: false });
  const api = {
    sharePanel: vi.fn(async () => current),
    shareAction: vi.fn(), shareReveal: vi.fn(), shareSelf: vi.fn(), shareSettings: vi.fn(), shareInvite: vi.fn(),
    assistantTargets: vi.fn(async () => ({ devices: targets })),
    assistantConfigure: vi.fn(async (_anchor: string, config: { rights: DocShareRights | null; device?: string; workspace_id?: string }): Promise<AssistantSettings> => {
      const project = config.rights === null ? null : { device: config.device!, workspace_id: config.workspace_id!, label: targets.flatMap((d) => d.workspaces).find((w) => w.workspace_id === config.workspace_id)!.label };
      const next = { rights: config.rights, project, limits };
      current = { ...current, assistant: next };
      if (config.rights === null) assistants = assistants.map((a) => a.state === 'ready' || a.state === 'starting' ? { ...a, state: 'ended', ended_at: Date.now() } : a);
      return next;
    }),
    assistantList: vi.fn(async () => ({ assistants })),
    assistantStart: vi.fn(async (_anchor: string, _host: string, task: string, _request: string, name: string) => {
      const view = assistant({ id: `as_n${++made}`, title: task.slice(0, 30), guest: name, state: 'starting', message: '正在启动…', created_at: Date.now() });
      assistants = [view, ...assistants];
      return { id: view.id };
    }),
    assistantStatus: vi.fn(async (id: string): Promise<AssistantStatus> => {
      const view = assistants.find((a) => a.id === id)!;
      if (view.state !== 'starting') return view.state === 'ready' ? ready(view) : view;
      const next = status === 'ready' ? { ...view, state: 'ready' as const, message: '可以对话' } : { ...view, state: 'failed' as const, message: '这台设备的 Runner 需要升级' };
      assistants = assistants.map((a) => a.id === id ? next : a);
      return next.state === 'ready' ? ready(next) : next;
    }),
    assistantEnd: vi.fn(async (id: string): Promise<AssistantView> => {
      assistants = assistants.map((a) => a.id === id ? { ...a, state: 'ended', ended_at: Date.now(), message: '已结束' } : a);
      return assistants.find((a) => a.id === id)!;
    }),
    assistantPin: vi.fn(async (id: string) => {
      assistants = assistants.map((a) => a.id === id ? { ...a, pinned: true } : a);
      return { block: 'blk_1' };
    }),
    view: vi.fn(async () => frame(canTalk)),
    older: vi.fn(async () => ({ messages: [], next: 0 })),
    message: vi.fn(async (_share: string, i: number) => ({ i, text: '' })),
    send: vi.fn(async () => op()), stop: vi.fn(async () => op()), operation: vi.fn(async () => op()),
    fork: vi.fn(async () => { throw new Error('an assistant is never forked'); }),
  };
  const view = render(<SharePanel host={host} api={api as unknown as PanelApi} doc={{ doc: 'doc', dark: false }} card={{ v: 1, anchor }}/>);
  return { api, host, view };
}
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) });
const selected = (name: string) => tab(name).getAttribute('aria-selected') === 'true';

describe('the panel\'s two tabs', () => {
  it('opens on 文档助手 when assistants are on, on 访问密钥 when off, and remembers the viewer\'s choice', async () => {
    setup();
    await screen.findByRole('listitem', { name: '整理第三节的实验数据' });
    expect(selected('文档助手')).toBe(true);
    fireEvent.click(tab('访问密钥'));
    expect(selected('访问密钥')).toBe(true);
    expect(screen.getByRole('heading', { name: '访问密钥' })).toBeTruthy();
    expect(localStorage.getItem('octopus-docs:share-tab')).toBe('keys');
    cleanup();

    // The choice stands across cards and reloads, even where assistants are on.
    const again = setup();
    await waitFor(() => expect(again.api.sharePanel).toHaveBeenCalled());
    await waitFor(() => expect(selected('访问密钥')).toBe(true));
    cleanup();
    localStorage.clear();

    setup({ settings: OFF });
    await waitFor(() => expect(selected('访问密钥')).toBe(true));
    expect(within(tab('文档助手')).getByText('未开启')).toBeTruthy();
  });

  it('still works where the browser keeps no storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    setup();
    await screen.findByRole('listitem', { name: '整理第三节的实验数据' });
    fireEvent.click(tab('访问密钥'));
    expect(selected('访问密钥')).toBe(true);
  });

  it('never asks for assistants while the reader stays on the keys, so a reader who cannot sign in is not asked to', async () => {
    localStorage.setItem('octopus-docs:share-tab', 'keys');
    const { api } = setup();
    await waitFor(() => expect(selected('访问密钥')).toBe(true));
    expect(api.assistantList).not.toHaveBeenCalled();
    fireEvent.keyDown(tab('访问密钥'), { key: 'ArrowRight' });
    expect(selected('文档助手')).toBe(true);
    await waitFor(() => expect(api.assistantList).toHaveBeenCalledWith(anchor));
  });
});

describe('what a reader is told about the project', () => {
  it('names it by its label alone: the bridge keeps the device and workspace to the owner', async () => {
    const { api } = setup({ settings: { ...ON, project: { device: '', workspace_id: '', label: '论文项目' } }, list: [] });
    // The summary arrives before the assistant list; it does not mean the empty-list guidance is ready.
    let resolveList!: (reply: { assistants: AssistantView[] }) => void;
    api.assistantList.mockReturnValueOnce(new Promise((resolve) => { resolveList = resolve; }));
    expect(await screen.findByText('可读项目「论文项目」（只读）· 可读写本文档 · 使用 Claude')).toBeTruthy();
    expect(screen.queryByText(/它会读这篇文档和项目「论文项目」/)).toBeNull();
    resolveList({ assistants: [] });
    expect(await screen.findByText(/它会读这篇文档和项目「论文项目」/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull();
  });

  it('tells the owner of a card on a bridge without assistants that there is nothing to turn on yet', async () => {
    const { api } = setup({ owner: true, settings: { rights: null, project: null, limits: { per_card: 0, per_guest: 0, per_guest_per_day: 0 } } });
    await waitFor(() => expect(selected('访问密钥')).toBe(true));
    fireEvent.click(tab('文档助手'));
    expect(screen.getByText('文档助手还不能在这里使用')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '开启文档助手' })).toBeNull();
    expect(api.assistantTargets).not.toHaveBeenCalled();
  });
});

describe('turning assistants on and off (the owner)', () => {
  it('shows a reader a note while assistants are off, pointing to the keys', async () => {
    const { api } = setup({ settings: OFF });
    await waitFor(() => expect(selected('访问密钥')).toBe(true));
    fireEvent.click(tab('文档助手'));
    expect(screen.getByText('卡片所有者还没有开启文档助手')).toBeTruthy();
    expect(api.assistantTargets).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /访问密钥.*Agent/ }));
    expect(selected('访问密钥')).toBe(true);
  });

  it('sets them up: the owner\'s devices and projects, the rights, a plain warning, then on', async () => {
    const { api } = setup({ owner: true, settings: OFF, list: [] });
    await waitFor(() => expect(selected('访问密钥')).toBe(true));
    fireEvent.click(tab('文档助手'));
    const setupBox = screen.getByRole('region', { name: '开启文档助手' });
    const project = await within(setupBox).findByRole('combobox', { name: /项目/ }) as HTMLSelectElement;
    // The first workspace an eligible device offers; a device that cannot run them is listed, disabled, with why.
    expect(project.value).toBe('desk\nws_acc');
    const groups = [...project.querySelectorAll('optgroup')];
    expect(groups.map((g) => [g.label, g.disabled])).toEqual([['desk', false], ['lab-server（Runner 需要升级）', true]]);
    expect(within(setupBox).getByRole('radio', { name: '读写' }).getAttribute('aria-checked')).toBe('true');
    expect(within(setupBox).getByText('开启后，能打开这篇文档的组织成员都能启动自己的助手：它能读取所选项目里的全部文件（包括配置和日志），并以 Octopus 应用身份读写这篇文档；助手使用你的 Claude 额度。')).toBeTruthy();
    fireEvent.change(project, { target: { value: 'desk\nws_lora' } });
    fireEvent.click(within(setupBox).getByRole('radio', { name: '只读' }));
    expect(within(setupBox).getByText(/并以 Octopus 应用身份读取这篇文档/)).toBeTruthy();
    fireEvent.click(within(setupBox).getByRole('button', { name: '开启' }));
    await waitFor(() => expect(api.assistantConfigure).toHaveBeenCalledWith(anchor, { rights: 'read', device: 'desk', workspace_id: 'ws_lora' }));
    expect(await screen.findByText('可读项目「lora-merge」（只读）· 只读本文档 · 使用 Claude')).toBeTruthy();
    expect(within(tab('文档助手')).queryByText('未开启')).toBeNull();
  });

  it('changes them, or turns them off after saying every live assistant ends', async () => {
    const { api } = setup({ owner: true });
    await screen.findByText('可读项目「论文项目」（只读）· 可读写本文档 · 使用 Claude');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const box = screen.getByRole('region', { name: '文档助手设置' });
    await within(box).findByRole('combobox', { name: /项目/ });
    fireEvent.click(within(box).getByRole('radio', { name: '只读' }));
    fireEvent.click(within(box).getByRole('button', { name: '保存' }));
    expect(await screen.findByText('可读项目「论文项目」（只读）· 只读本文档 · 使用 Claude')).toBeTruthy();
    expect(api.assistantConfigure).toHaveBeenLastCalledWith(anchor, { rights: 'read', device: 'desk', workspace_id: 'ws_acc' });

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const again = screen.getByRole('region', { name: '文档助手设置' });
    fireEvent.click(within(again).getByRole('button', { name: '关闭文档助手' }));
    expect(within(again).getByText('关闭后，所有正在运行的助手都会结束；成员不能再启动新的助手。')).toBeTruthy();
    fireEvent.click(within(again).getByRole('button', { name: '确认关闭' }));
    expect(await screen.findByRole('region', { name: '开启文档助手' })).toBeTruthy();
    expect(api.assistantConfigure).toHaveBeenLastCalledWith(anchor, { rights: null });
  });
});

describe('a reader\'s own assistants', () => {
  it('starts one with a task and the name it will use, follows it while it starts, and opens its conversation when ready', { timeout: 10_000 }, async () => {
    const { api } = setup({ list: [] });
    await screen.findByText('还没有助手');
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    const form = screen.getByRole('form', { name: '新对话' });
    const task = within(form).getByRole('textbox', { name: '让助手做什么？' });
    expect(document.activeElement).toBe(task);
    expect((within(form).getByRole('textbox', { name: /它称呼你/ }) as HTMLInputElement).value).toBe('张三');
    fireEvent.change(within(form).getByRole('textbox', { name: /它称呼你/ }), { target: { value: '张老师' } });
    fireEvent.change(task, { target: { value: '把第三节的数据整理成表' } });
    fireEvent.keyDown(task, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.assistantStart).toHaveBeenCalledOnce());
    const [, host, sentTask, requestId, name] = api.assistantStart.mock.calls[0];
    expect([host, sentTask, name]).toEqual(['doc', '把第三节的数据整理成表', '张老师']);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/正在启动你的助手/)).toBeTruthy();
    expect(within(await screen.findByRole('listitem', { name: '把第三节的数据整理成表' })).getByText('启动中')).toBeTruthy();
    // Followed every 2 s; ready, it opens over the card capability its status carries.
    const chat = await screen.findByRole('region', { name: '助手「整理第三节的实验数据」' }, { timeout: 4000 });
    expect(api.assistantStatus).toHaveBeenCalledWith('as_n1');
    expect(api.view).toHaveBeenCalledWith(SHARE, '', -1);
    expect(await within(chat).findByText('写进第三节')).toBeTruthy();
    expect(document.activeElement).toBe(within(chat).getByRole('button', { name: '返回助手列表' }));
    // Its conversation is an Agent card's, without forking.
    expect(within(chat).getByLabelText('给 Agent 的任务')).toBeTruthy();
    expect(within(chat).queryByRole('button', { name: /分叉/ })).toBeNull();
    fireEvent.change(within(chat).getByLabelText('给 Agent 的任务'), { target: { value: '再加一列方差' } });
    fireEvent.click(within(chat).getByLabelText('发送'));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(SHARE, '再加一列方差', expect.any(String), { doc: 'doc', title: '组会周报' }));
    fireEvent.click(within(chat).getByRole('button', { name: '返回助手列表' }));
    expect(await screen.findByRole('listitem', { name: '把第三节的数据整理成表' })).toBeTruthy();
  });

  it('keeps the task when a start is refused, retrying with the same request id; a start that fails says why', { timeout: 10_000 }, async () => {
    const { api } = setup({ list: [], status: 'failed' });
    await screen.findByText('还没有助手');
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    const form = screen.getByRole('form', { name: '新对话' });
    fireEvent.change(within(form).getByRole('textbox', { name: '让助手做什么？' }), { target: { value: '画 Figure 3' } });
    api.assistantStart.mockRejectedValueOnce(new AgentApiError(429, '你在这篇文档里同时最多运行 3 个文档助手，请先结束一个'));
    fireEvent.click(within(form).getByRole('button', { name: '启动助手' }));
    expect(await within(form).findByRole('alert')).toHaveProperty('textContent', '没有启动：你在这篇文档里同时最多运行 3 个文档助手，请先结束一个');
    expect((within(form).getByRole('textbox', { name: '让助手做什么？' }) as HTMLTextAreaElement).value).toBe('画 Figure 3');
    fireEvent.click(within(form).getByRole('button', { name: '启动助手' }));
    await waitFor(() => expect(api.assistantStart).toHaveBeenCalledTimes(2));
    expect(api.assistantStart.mock.calls[1][3]).toBe(api.assistantStart.mock.calls[0][3]);
    expect(await screen.findByText('助手没有启动：这台设备的 Runner 需要升级', undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /助手「/ })).toBeNull();
  });

  it('opens a ready assistant from the list, pins it into the document, and ends it after confirming', async () => {
    const { api } = setup();
    fireEvent.click(within(await screen.findByRole('listitem', { name: '整理第三节的实验数据' })).getByRole('button', { name: '打开' }));
    const chat = await screen.findByRole('region', { name: '助手「整理第三节的实验数据」' });
    expect(api.assistantStatus).toHaveBeenCalledWith('as_1');
    fireEvent.click(within(chat).getByRole('button', { name: '固定到文档' }));
    expect(await within(chat).findByText('「整理第三节的实验数据」已固定到文档：就在这张卡片下方，读者都能实时观看')).toBeTruthy();
    expect(within(chat).getByText('已固定在文档里')).toBeTruthy();
    expect(api.assistantPin).toHaveBeenCalledWith('as_1');
    fireEvent.click(within(chat).getByRole('button', { name: '结束' }));
    fireEvent.click(within(chat).getByRole('button', { name: '确认结束' }));
    await waitFor(() => expect(api.assistantEnd).toHaveBeenCalledWith('as_1'));
    // Back in the list, the assistant has ended.
    expect(await screen.findByText('已结束的助手（1）')).toBeTruthy();
    expect(screen.getByText('现在没有进行中的助手')).toBeTruthy();
  });

  it('shows the owner every guest\'s assistants with who they work for; only a guest pins their own', async () => {
    setup({ owner: true, list: [assistant({ mine: false }), assistant({ id: 'as_2', title: '检查参考文献', guest: '韩梅梅', mine: false, pinned: true }), assistant({ id: 'as_3', title: 'lht 自己的', guest: 'lht', mine: true })] });
    const theirs = await screen.findByRole('listitem', { name: '整理第三节的实验数据' });
    expect(within(theirs).getByText(/为 张三 工作/)).toBeTruthy();
    expect(within(theirs).getAllByRole('button').map((b) => b.textContent)).toEqual(['打开', '结束']);
    expect(within(screen.getByRole('listitem', { name: '检查参考文献' })).getByText('已固定')).toBeTruthy();
    const own = screen.getByRole('listitem', { name: 'lht 自己的' });
    expect(within(own).queryByText(/为 .* 工作/)).toBeNull();
    expect(within(own).getAllByRole('button').map((b) => b.textContent)).toEqual(['打开', '固定到文档', '结束']);
  });

  it('asks before ending one from the list, and steps back on Esc', async () => {
    const { api } = setup();
    const row = await screen.findByRole('listitem', { name: '整理第三节的实验数据' });
    fireEvent.click(within(row).getByRole('button', { name: '结束' }));
    expect(document.activeElement).toBe(within(row).getByRole('button', { name: '取消' }));
    fireEvent.keyDown(within(row).getByRole('group', { name: '确认结束' }), { key: 'Escape' });
    expect(within(row).queryByRole('group', { name: '确认结束' })).toBeNull();
    expect(api.assistantEnd).not.toHaveBeenCalled();
  });

  it('tells a reader who cannot sign in that assistants need it, sends them to the keys, and does not keep asking', async () => {
    const { api } = setup();
    api.assistantList.mockRejectedValue(new Error('用户未登录飞书'));
    expect(await screen.findByText('文档助手需要用本组织的飞书账号登录')).toBeTruthy();
    expect(screen.getByText('用户未登录飞书')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新对话' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '去访问密钥' }));
    expect(selected('访问密钥')).toBe(true);
    expect(api.assistantList).toHaveBeenCalledOnce();
  });

  it('says why the app cannot write for the assistants, and how to let it', async () => {
    const { api } = setup({ access: 'view' });
    expect(await screen.findByText('助手现在只能读这篇文档')).toBeTruthy();
    expect(within(screen.getByRole('tabpanel', { name: /文档助手/ })).getByText(/助手以飞书应用「Octopus」的身份访问文档，它现在只能查看。.*给它「可编辑」权限/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    await waitFor(() => expect(api.sharePanel).toHaveBeenCalledTimes(2));
  });
});

it('lets a guest watch but not talk when the bridge says the assistant cannot take messages', async () => {
  setup({ canTalk: false });
  fireEvent.click(within(await screen.findByRole('listitem', { name: '整理第三节的实验数据' })).getByRole('button', { name: '打开' }));
  const chat = await screen.findByRole('region', { name: '助手「整理第三节的实验数据」' });
  expect(await within(chat).findByText(/现在不能和它对话/)).toBeTruthy();
  expect(within(chat).queryByLabelText('给 Agent 的任务')).toBeNull();
  await act(async () => {});
});
