import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentCard } from './Card';
import { AgentApiError, type AgentApi, type AssistantSettings, type AssistantStatus, type AssistantTarget, type AssistantView, type AgentOperation, type PlacedCard, type SpeakersInfo, type BoardBinding, type BoardReply, type CardBinding, type CardFrame, type DocShareAction, type DocShareConnect, type DocShareInvite, type DocShareInviteReply, type DocShareLink, type DocSharePanel, type DocShareRevealReply, type DocShareRights, type DocShareSelfReply, type DocShareSelfServe, type DocsHost, type FileReply, type HostSnapshot, type LaunchOptions, type LaunchStatus, type OlderRows, type WorkspaceInfo } from './protocol';

afterEach(cleanup);
const share = `ds_${'C'.repeat(43)}`;
const binding = (doc = 'doc'): CardBinding => ({ v: 2, share, title: '论文实验', owner: 'lht', device: 'laptop', provider: 'codex', doc });
const frame = (patch: Partial<CardFrame> = {}): CardFrame => ({
  rev: '1.0', role: 'owner', title: '论文实验', owner: 'lht', device: 'laptop', provider: 'codex',
  status: { working: false, state: 'idle' }, total: 2, reset: true,
  messages: [{ i: 0, role: 'user', text: '跑一下实验' }, { i: 1, role: 'assistant', text: '**完成**，结果见表。' }], ...patch,
});

const shareKey = (id: string, status: DocShareLink['status']): DocShareLink => ({ id, label: '论文润色', rights: 'write', status, created_at: Date.now() - 3_600_000, last_used_at: null, via: 'owner', mine: false });
const sharePanel = (owner: boolean, invite: DocShareInvite = { active: false, created_at: null }): DocSharePanel => ({ document_id: 'doc', host_matches: true, viewer_is_owner: owner, card_state: 'present',
  lease_until: null, shares: [shareKey('sh_1', 'active')], self_serve: 'write', app_access: 'edit', app_name: 'Octopus', invite: owner ? invite : null, limits: { per_hour: 10, active_max: 50 },
  assistant: { rights: null, project: null, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } } });
const shareConnect: DocShareConnect = { claude: 'claude mcp add --transport http --scope user octopus-doc-test https://bridge.example/api/mcp --header "Authorization: Bearer test"',
  codex: 'printf x >> ~/.codex/config.toml', endpoint: 'https://bridge.example/api/mcp', token: 'test' };

function setup(snapshot: Partial<HostSnapshot> = {}, username: string | null = 'lht') {
  let change!: (next: HostSnapshot) => void;
  const state: HostSnapshot = { doc: 'doc', editable: true, binding: binding(), board: null, docShare: null, float: false, visible: true, dark: false, ...snapshot };
  /** The share card's claim link, as the mock bridge keeps it. */
  let invite: DocShareInvite = { active: false, created_at: null };
  const host = {
    surface: 'inline' as const,
    initialize: vi.fn(async (fn: (s: HostSnapshot) => void) => { change = fn; return state; }),
    loginCode: vi.fn(async () => 'code'),
    bind: vi.fn(async (next: Omit<CardBinding, 'v' | 'doc'> | null) => ({ ...state, binding: next ? { v: 2 as const, ...next, doc: state.doc } : null })),
    clearBoard: vi.fn(async () => ({ ...state, board: null })),
    expand: vi.fn(async () => {}), float: vi.fn(async () => {}), open: vi.fn(async () => {}), close: vi.fn(async () => {}),
    takeExpandedFile: vi.fn((): string | null => null),
    documentTitle: vi.fn(async () => '组会周报'),
    documentText: vi.fn(async () => '# 组会周报\n\n本周目标：复现 Table 2'),
    fitHeight: vi.fn(async (_height: number) => {}),
    readerName: vi.fn(async () => '张三'),
  } satisfies DocsHost;
  const api = {
    login: vi.fn(async () => ({ token: 'fda_x', username, expiresAt: Date.now() + 60_000 })),
    sessions: vi.fn(async () => ({ sessions: [{ resourceId: 'r2', title: '另一个会话', device: 'desk', provider: 'claude', working: false, canSend: true, shared: 0 }] })),
    share: vi.fn(async () => ({ binding: { share: `ds_${'D'.repeat(43)}`, title: '另一个会话', owner: 'lht', device: 'desk', provider: 'claude' } })),
    unshare: vi.fn(async () => ({ revoked: 1 })),
    view: vi.fn(async (): Promise<CardFrame | { rev: string; unchanged: true }> => frame(username === 'lht' ? {} : { role: 'viewer' })),
    read: vi.fn(async () => ({ ok: true as const })),
    older: vi.fn(async (): Promise<OlderRows> => ({ messages: [], next: 0 })),
    message: vi.fn(async (_s: string, i: number) => ({ i, text: '' })),
    send: vi.fn(async (): Promise<AgentOperation> => ({ id: 'op', status: 'succeeded', message: 'Agent 已接收输入', live: false })),
    stop: vi.fn(async () => ({ id: 'op2', status: 'succeeded', message: '已停止', live: false })),
    snapshot: vi.fn(async (): Promise<PlacedCard> => ({ binding: { share: `ds_${'F'.repeat(43)}`, title: '论文实验', owner: 'lht', device: 'laptop', provider: 'codex' } })),
    fork: vi.fn(async (): Promise<PlacedCard> => ({ binding: { share: `ds_${'G'.repeat(43)}`, title: '论文实验 · 李雷的分叉', owner: 'lht', device: 'laptop', provider: 'codex' },
      operation: { id: 'op3', status: 'succeeded', message: 'Agent 已接收输入', live: false } })),
    speakers: vi.fn(async (): Promise<SpeakersInfo> => ({ members: [], candidates: [{ username: 'lilei', name: '李雷' }, { username: 'hanmm', name: '韩梅梅' }] })),
    setSpeakers: vi.fn(async (_s: string, members: string[]): Promise<SpeakersInfo> => ({ members: members.map((m) => ({ username: m, name: m === 'lilei' ? '李雷' : m })),
      candidates: [{ username: 'lilei', name: '李雷' }, { username: 'hanmm', name: '韩梅梅' }] })),
    operation: vi.fn(async (): Promise<AgentOperation> => ({ id: 'op', status: 'succeeded', message: 'Agent 已接收输入', live: false })),
    launchOptions: vi.fn(async (): Promise<LaunchOptions> => ({
      devices: [{ device: 'laptop', label: 'laptop', online: true, providers: ['claude', 'codex'] }, { device: 'old', label: 'old', online: false, providers: [], reason: '设备离线' }],
      directories: [{ device: 'laptop', path: '/home/u/paper' }],
      models: { claude: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }], codex: [{ value: 'gpt-6-astra', label: 'GPT-6 Astra' }] },
      efforts: { claude: [{ value: 'high', label: '高' }, { value: 'max', label: '最高' }], codex: [{ value: 'xhigh', label: '很高' }] },
      defaults: { provider: 'claude', model: { claude: 'opus', codex: 'gpt-6-astra' }, effort: { claude: 'max', codex: 'xhigh' } },
    })),
    launch: vi.fn(async () => ({ id: 'fdl-1' })),
    launchStatus: vi.fn(async (): Promise<LaunchStatus> => ({ state: 'ready', message: '已启动', binding: { share: `ds_${'E'.repeat(43)}`, title: '复现基线', owner: 'lht', device: 'laptop', provider: 'claude' } })),
    workspace: vi.fn(async (): Promise<WorkspaceInfo> => ({ device: 'laptop', workspace: { id: 'ws_a', label: 'paper', display: '~/paper', shareable: true }, path: '', members: [],
      candidates: [{ username: 'lilei', name: '李雷' }, { username: 'hanmm', name: '韩梅梅' }] })),
    grantWorkspace: vi.fn(async (_s: string, _w: string, members: string[]): Promise<WorkspaceInfo> => ({ device: 'laptop', workspace: { id: 'ws_a', label: 'paper', display: '~/paper', shareable: true }, path: '',
      members: members.map((m) => ({ username: m, name: m === 'lilei' ? '李雷' : m })), candidates: [{ username: 'lilei', name: '李雷' }, { username: 'hanmm', name: '韩梅梅' }] })),
    file: vi.fn(async (_s: string, path: string): Promise<FileReply> => path.endsWith('/')
      ? { kind: 'dir', workspace: 'paper', path: 'results', truncated: false, entries: [{ name: 'table.csv', path: 'results/table.csv', dir: false, size: 20 }] }
      : { kind: 'file', workspace: 'paper', path, name: path.split('/').pop()!, size: 20, modifiedAt: '2026-10-18T00:00:00Z', mime: 'text/csv', data: new Blob(['task,score\nMMLU,46.1\n'], { type: 'text/csv' }) }),
    board: vi.fn(async (_b: string, since: string): Promise<BoardReply> => since === '2' ? { version: 2, unchanged: true }
      : { role: username === 'lht' ? 'owner' : 'viewer', title: '进度看板', owner: 'lht', version: 2, updatedAt: new Date().toISOString(),
        html: '<style>.ok{color:var(--board-good)}</style><h2>ProjectX 进度</h2><p class="ok">A0 进行中</p><a href="https://example.com/plan">计划</a><script>bad()</script>' }),
    unboard: vi.fn(async () => ({ revoked: true })),
    sharePanel: vi.fn(async (_a: string, _host?: string): Promise<DocSharePanel> => sharePanel(username === 'lht', invite)),
    shareAction: vi.fn(async (_a: string, id: string, action: DocShareAction, _host?: string): Promise<{ share: DocShareLink }> => ({
      share: shareKey(id, action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'terminated') })),
    shareReveal: vi.fn(async (_a: string, id: string): Promise<DocShareRevealReply> => ({ share: shareKey(id, 'active'), command: shareConnect.claude, connect: shareConnect })),
    shareSelf: vi.fn(async (_a: string, _host: string, label: string, rights: DocShareRights): Promise<DocShareSelfReply> => ({ share: { ...shareKey('sh_2', 'active'), label, rights, via: 'card', mine: true }, connect: shareConnect })),
    shareSettings: vi.fn(async (_a: string, selfServe: DocShareSelfServe, _host?: string): Promise<DocSharePanel> => ({ ...sharePanel(true), self_serve: selfServe })),
    shareInvite: vi.fn(async (_a: string, op: 'create' | 'revoke'): Promise<DocShareInviteReply> => {
      invite = op === 'create' ? { active: true, created_at: Date.now() } : { active: false, created_at: null };
      return op === 'create' ? { invite, link: `https://octopus.example/feishu/doc-key#i=dsi_${'I'.repeat(43)}` } : { invite };
    }),
    assistantTargets: vi.fn(async () => ({ devices: [] as AssistantTarget[] })),
    assistantConfigure: vi.fn(async (): Promise<AssistantSettings> => ({ rights: null, project: null, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } })),
    assistantList: vi.fn(async () => ({ assistants: [] as AssistantView[] })),
    assistantStart: vi.fn(async () => ({ id: 'as_1' })),
    assistantStatus: vi.fn(async (): Promise<AssistantStatus> => { throw new AgentApiError(404, '找不到这个文档助手'); }),
    assistantEnd: vi.fn(async (): Promise<AssistantView> => { throw new AgentApiError(404, '找不到这个文档助手'); }),
    assistantPin: vi.fn(async () => ({ block: 'blk_1' })),
    disconnect: vi.fn(),
  } satisfies AgentApi;
  const view = render(<AgentCard host={host} api={api}/>);
  return { host, api, view, change: (next: Partial<HostSnapshot>) => act(() => change({ ...state, ...next })) };
}

it('connects by itself and shows the owner the live conversation with a composer', async () => {
  const { api } = setup();
  await screen.findByText('完成');
  expect(api.login).toHaveBeenCalledOnce();
  expect(api.view).toHaveBeenCalledWith(share, '', -1);
  expect(screen.getByText('可操作')).toBeTruthy();
  expect(screen.getByLabelText('给 Agent 的任务')).toBeTruthy();
  expect(screen.getByText('lht 的 Agent · laptop · Codex')).toBeTruthy();
});

it('shows everyone else the same conversation read-only, with no way to send', async () => {
  setup({}, 'zhangsan');
  await screen.findByText('完成');
  expect(screen.getByText('只读')).toBeTruthy();
  expect(screen.queryByLabelText('给 Agent 的任务')).toBeNull();
  expect(screen.getByText(/你可以实时观看，对话需要 lht 本人或 lht 授权的人/)).toBeTruthy();
});

it('keeps a failed task in the box and retries it with the same request id', async () => {
  const { api } = setup();
  await screen.findByText('完成');
  api.send.mockRejectedValueOnce(new AgentApiError(0, '暂时连不上 Octopus'));
  const box = screen.getByLabelText('给 Agent 的任务') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: '再跑一个种子' } });
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  await screen.findByText('暂时连不上 Octopus');
  expect(box.value).toBe('再跑一个种子');
  fireEvent.click(screen.getByLabelText('发送'));
  await waitFor(() => expect(box.value).toBe(''));
  expect(api.send).toHaveBeenCalledTimes(2);
  expect(api.send.mock.calls[0]).toEqual(api.send.mock.calls[1]);
});

it('renders Agent Markdown without raw HTML or script links', async () => {
  const { api, view } = setup();
  api.view.mockResolvedValueOnce(frame({ messages: [{ i: 0, role: 'assistant', text: '<img src=x onerror=alert(1)> [link](javascript:alert(1)) [ok](https://example.com)' }] }));
  await screen.findByText(/<img src=x onerror=alert\(1\)>/);
  expect(view.container.querySelector('img')).toBeNull();
  expect(view.container.querySelector('a[href^="javascript"]')).toBeNull();
  expect(view.container.querySelector('a[href="https://example.com"]')).toBeTruthy();
});

it('does not read a copied card; its owner can carry it over to a fresh share', async () => {
  const { api, host } = setup({ binding: binding('original-doc') });
  await screen.findByText('这张卡片是从另一篇文档复制来的。');
  expect(api.view).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByText('我是 lht，在这篇文档中继续共享'));
  await waitFor(() => expect(host.bind).toHaveBeenCalled());
  expect(api.share).toHaveBeenCalledWith({ from: share, docTitle: '组会周报' });
  // The original document still uses its own share.
  expect(api.unshare).not.toHaveBeenCalled();
});

it('tells readers when the owner stopped sharing', async () => {
  const { api } = setup({}, 'zhangsan');
  api.view.mockRejectedValueOnce(new AgentApiError(410, 'lht 已停止共享这个会话'));
  await screen.findByText('lht 已停止共享这个会话');
  expect(screen.queryByText('重新共享')).toBeNull();
});

it('folds a long prompt to its opening lines until the reader expands it', async () => {
  const { api } = setup();
  const prompt = ['根据这篇文档复现基线', '', '---', '你是在飞书文档里新建的 Agent。', '以下是新建时文档的正文：', '<<<', '第一段', '文末的结论 XYZ', '>>>'].join('\n');
  api.view.mockResolvedValue(frame({ messages: [{ i: 0, role: 'user', text: prompt }, { i: 1, role: 'user', text: '再跑一次' }] }));
  await screen.findByText(/根据这篇文档复现基线/);
  expect(screen.queryByText(/文末的结论 XYZ/)).toBeNull();
  expect(screen.getByText('再跑一次')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
  expect(screen.getByText(/文末的结论 XYZ/)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: /展开全文|收起/ })).toHaveLength(1);
});

it('loads earlier messages above the conversation, back to its start, and keeps them as it goes on', async () => {
  const { api } = setup();
  const row = (i: number) => ({ i, role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `第 ${i} 条` });
  api.view.mockResolvedValue(frame({ messages: [row(5), row(6)] }));
  api.older.mockResolvedValueOnce({ messages: [row(3), row(4)], next: 3 }).mockResolvedValueOnce({ messages: [row(0), row(1), row(2)], next: 0 });
  await screen.findByText('第 6 条');
  fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
  await screen.findByText('第 3 条');
  expect(api.older).toHaveBeenLastCalledWith(share, 5);
  fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
  await screen.findByText('第 0 条');
  expect(api.older).toHaveBeenLastCalledWith(share, 3);
  expect(screen.queryByRole('button', { name: '加载更早的消息' })).toBeNull();
  expect(screen.getByText('第 5 条')).toBeTruthy();
});

it('reads the whole of a message the frame carried only the beginning of', async () => {
  const { api } = setup();
  api.view.mockResolvedValue(frame({ messages: [{ i: 0, role: 'user', text: '写报告' }, { i: 1, role: 'assistant', text: '报告开头', cut: 20_000 }] }));
  api.message.mockResolvedValueOnce({ i: 1, text: '报告开头……报告结尾 QED' });
  fireEvent.click(await screen.findByRole('button', { name: /这条消息共 20000 字/ }));
  await screen.findByText(/报告结尾 QED/);
  expect(api.message).toHaveBeenCalledWith(share, 1);
  expect(screen.queryByRole('button', { name: /这条消息共/ })).toBeNull();
});

it('places a chosen session: share, write the Record, then retire the card old share', async () => {
  const { api, host } = setup();
  await screen.findByText('完成');
  fireEvent.click(screen.getByLabelText('更多操作'));
  fireEvent.click(screen.getByText('更换会话'));
  fireEvent.click(await screen.findByText('另一个会话'));
  // The owner names the card for the document's readers.
  fireEvent.change(screen.getByLabelText(/卡片标题/), { target: { value: '组会助理 · 学习率实验' } });
  fireEvent.click(screen.getByText('放进文档'));
  await waitFor(() => expect(api.unshare).toHaveBeenCalledWith({ share }));
  expect(api.share).toHaveBeenCalledWith({ resourceId: 'r2', title: '组会助理 · 学习率实验', docTitle: '组会周报' });
  expect(api.share.mock.invocationCallOrder[0]).toBeLessThan(host.bind.mock.invocationCallOrder[0]);
  expect(host.bind.mock.invocationCallOrder[0]).toBeLessThan(api.unshare.mock.invocationCallOrder[0]);
});

it('withdraws a new share when the document refuses the Record write', async () => {
  const { api, host } = setup({ binding: null });
  host.bind.mockRejectedValueOnce(new Error('文档未保存这次更改，请确认处于编辑模式'));
  fireEvent.click(await screen.findByText('另一个会话'));
  fireEvent.click(screen.getByText('放进文档'));
  await screen.findByText('文档未保存这次更改，请确认处于编辑模式');
  expect(api.unshare).toHaveBeenCalledWith({ share: `ds_${'D'.repeat(43)}` });
});

it('pauses syncing while the card is off screen and cleans up on close', async () => {
  const { api, change, view, host } = setup({ visible: false });
  await waitFor(() => expect(api.login).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.view).not.toHaveBeenCalled();
  change({ visible: true });
  await screen.findByText('完成');
  view.unmount();
  expect(api.disconnect).toHaveBeenCalledOnce();
  expect(host.close).toHaveBeenCalledOnce();
});

it('opens a file the agent mentioned in place of the conversation, then goes back', async () => {
  const { api } = setup();
  api.view.mockResolvedValue(frame({ messages: [{ i: 0, role: 'assistant', text: '结果在 `results/table.csv`，全部产物在 `results/` 下。' }] }));
  fireEvent.click(await screen.findByRole('button', { name: /results\/table\.csv/ }));
  await screen.findByText('MMLU');
  expect(api.file).toHaveBeenCalledWith(share, 'results/table.csv');
  expect(screen.getByRole('columnheader', { name: 'score' })).toBeTruthy();
  fireEvent.click(screen.getByLabelText('返回对话'));
  fireEvent.click(await screen.findByRole('button', { name: /^results\/$/ }));
  fireEvent.click(await screen.findByText('table.csv'));
  await screen.findByText('MMLU');
  expect(api.file).toHaveBeenLastCalledWith(share, 'results/table.csv');
});

it('tells a reader without a grant whom to ask, without opening anything', async () => {
  const { api } = setup({}, 'lilei');
  api.view.mockResolvedValue(frame({ role: 'viewer', messages: [{ i: 0, role: 'assistant', text: '见 `results/table.csv`' }] }));
  api.file.mockRejectedValueOnce(new AgentApiError(403, 'lht 还没有把工作区「paper」共享给你'));
  fireEvent.click(await screen.findByRole('button', { name: /results\/table\.csv/ }));
  await screen.findByText('lht 还没有把工作区「paper」共享给你');
  expect(screen.getByText(/共享工作区文件/)).toBeTruthy();
});

it('lets the owner grant the session workspace to named members', async () => {
  const { api } = setup();
  await screen.findByText('完成');
  fireEvent.click(screen.getByLabelText('更多操作'));
  fireEvent.click(screen.getByRole('menuitem', { name: /共享工作区文件/ }));
  fireEvent.click(await screen.findByLabelText(/李雷/));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByText('已共享给 李雷');
  expect(api.grantWorkspace).toHaveBeenCalledWith(share, 'ws_a', ['lilei']);
});

it('has the agent register a Home directory as its own workspace; a refresh then offers it without the old status', async () => {
  const { api } = setup();
  await screen.findByText('完成');
  api.workspace.mockResolvedValueOnce({ device: 'laptop', workspace: { id: 'ws_home', label: 'Home', display: '~', shareable: false, reason: '这是整个主目录（Home 工作区），不能共享' },
    path: 'paper', members: [], candidates: [] });
  fireEvent.click(screen.getByLabelText('更多操作'));
  fireEvent.click(screen.getByRole('menuitem', { name: /共享工作区文件/ }));
  fireEvent.click(await screen.findByRole('button', { name: '让 Agent 登记当前目录' }));
  await screen.findByText(/已把登记任务交给 Agent/);
  expect(api.send).toHaveBeenCalledWith(share, expect.stringContaining('octopus-runner workspace add "$(pwd)"'), expect.any(String), { doc: 'doc', title: '组会周报' });
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByLabelText(/李雷/);
  expect(screen.queryByText(/已把登记任务交给 Agent/)).toBeNull();
});

it('starts a new agent with first-level model and effort, then places it', async () => {
  const { api, host } = setup({ binding: null });
  fireEvent.click(await screen.findByRole('button', { name: /新建 Agent/ }));
  await screen.findByLabelText('工作目录');
  expect((screen.getByLabelText('工作目录') as HTMLInputElement).value).toBe('/home/u/paper');
  expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('opus');
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'sonnet' } });
  fireEvent.click(screen.getByRole('radio', { name: '高' }));
  fireEvent.change(screen.getByLabelText(/^任务/), { target: { value: '根据这篇文档《组会周报》，复现基线' } });
  fireEvent.click(screen.getByRole('button', { name: /创建并放进文档/ }));
  await waitFor(() => expect(host.bind).toHaveBeenCalledWith(expect.objectContaining({ title: '复现基线', provider: 'claude' })));
  expect(api.launch).toHaveBeenCalledWith(expect.objectContaining({ device: 'laptop', directory: '/home/u/paper', provider: 'claude', model: 'sonnet', effort: 'high',
    task: '根据这篇文档《组会周报》，复现基线', title: '复现基线', doc: 'doc', docTitle: '组会周报', docText: expect.stringContaining('复现 Table 2') }));
});

it('sends a new agent the whole document, or only its size when it is longer than one task can carry', async () => {
  const { api, host } = setup({ binding: null });
  const long = `# 周报\n${'实验记录。'.repeat(20_000)}文末结论`;
  host.documentText.mockResolvedValueOnce(long);
  fireEvent.click(await screen.findByRole('button', { name: /新建 Agent/ }));
  await screen.findByLabelText('工作目录');
  fireEvent.change(screen.getByLabelText(/^任务/), { target: { value: '复现基线' } });
  fireEvent.click(screen.getByRole('button', { name: /创建并放进文档/ }));
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect((api.launch.mock.calls[0] as unknown[])[0]).toMatchObject({ docText: long });
  cleanup();
  const again = setup({ binding: null });
  const huge = '论'.repeat(200_000);
  again.host.documentText.mockResolvedValueOnce(huge);
  fireEvent.click(await screen.findByRole('button', { name: /新建 Agent/ }));
  await screen.findByLabelText('工作目录');
  fireEvent.change(screen.getByLabelText(/^任务/), { target: { value: '复现基线' } });
  fireEvent.click(screen.getByRole('button', { name: /创建并放进文档/ }));
  await waitFor(() => expect(again.api.launch).toHaveBeenCalledTimes(1));
  const form = (again.api.launch.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
  expect(form.docText).toBeUndefined();
  expect(form.docBytes).toBe(600_000);
});

const boardBinding = (doc = 'doc'): BoardBinding => ({ v: 1, board: `db_${'B'.repeat(43)}`, title: '进度看板', owner: 'lht', doc });
const shadowText = (root: HTMLElement) => root.querySelector('.board-view')?.shadowRoot?.textContent ?? '';

it('shows a board as its agent wrote it, without its script, and opens its links through the host', async () => {
  const { api, host, view } = setup({ binding: null, board: boardBinding() });
  await waitFor(() => expect(shadowText(view.container)).toContain('A0 进行中'));
  expect(api.board).toHaveBeenCalledWith(`db_${'B'.repeat(43)}`, '');
  expect(api.view).not.toHaveBeenCalled();
  const shadow = view.container.querySelector('.board-view')!.shadowRoot!;
  expect(shadow.querySelector('script')).toBeNull();
  expect(screen.getByText(/lht 的看板/)).toBeTruthy();
  fireEvent.click(shadow.querySelector('a')!);
  expect(host.open).toHaveBeenCalledWith('https://example.com/plan');
});

it('lets only the board\'s owner stop sharing it, which clears the card', async () => {
  const { api, host } = setup({ binding: null, board: boardBinding() });
  await waitFor(() => expect(api.board).toHaveBeenCalled());
  fireEvent.click(await screen.findByLabelText('更多操作'));
  fireEvent.click(screen.getByText('停止共享并清空卡片'));
  await waitFor(() => expect(host.clearBoard).toHaveBeenCalled());
  expect(api.unboard).toHaveBeenCalledWith(`db_${'B'.repeat(43)}`);
});

it('shows a viewer the board without owner controls, and an ended or copied board as such', async () => {
  const viewer = setup({ binding: null, board: boardBinding() }, 'zhangsan');
  await waitFor(() => expect(shadowText(viewer.view.container)).toContain('ProjectX 进度'));
  expect(screen.queryByLabelText('更多操作')).toBeNull();
  viewer.view.unmount();

  const ended = setup({ binding: null, board: boardBinding() });
  ended.api.board.mockRejectedValueOnce(new AgentApiError(410, '这块看板已停止共享'));
  expect(await screen.findByText('这块看板已停止共享')).toBeTruthy();
  ended.view.unmount();

  const copied = setup({ binding: null, board: boardBinding('another-doc') });
  expect(await screen.findByText('这块看板是从另一篇文档复制来的。')).toBeTruthy();
  expect(copied.api.board).not.toHaveBeenCalled();
});

it('shows a document-share card as its keys, never as an Agent card or the session picker', async () => {
  const anchor = `dsa_${'H'.repeat(43)}`;
  const { api, host } = setup({ binding: null, docShare: { v: 1, anchor } });
  expect(await screen.findByRole('listitem', { name: '论文润色' })).toBeTruthy();
  expect(screen.getByText('Octopus 文档协作')).toBeTruthy();
  expect(api.sharePanel).toHaveBeenCalledWith(anchor, 'doc');
  // Its bridge calls sign in when the reader can and go without otherwise: the Agent card neither signs in for it nor reads a session.
  expect(api.login).not.toHaveBeenCalled();
  expect(api.view).not.toHaveBeenCalled();
  expect(api.sessions).not.toHaveBeenCalled();
  // The same side panel as the Agent card's.
  fireEvent.click(screen.getByRole('button', { name: '在侧边栏打开' }));
  expect(host.float).toHaveBeenCalledOnce();
});

it('shows a share card\'s new claim link as the bridge answers it', async () => {
  const { api } = setup({ binding: null, docShare: { v: 1, anchor: `dsa_${'J'.repeat(43)}` } });
  await screen.findByRole('listitem', { name: '论文润色' });
  fireEvent.click(screen.getByRole('button', { name: /设置/ }));
  fireEvent.click(screen.getByRole('button', { name: '生成链接' }));
  expect(((await screen.findByRole('textbox', { name: '领取链接' })) as HTMLTextAreaElement).value).toBe(`https://octopus.example/feishu/doc-key#i=dsi_${'I'.repeat(43)}`);
  expect(api.shareInvite).toHaveBeenCalledWith(`dsa_${'J'.repeat(43)}`, 'create');
});

it('shows a share card it cannot read as such, even when the Record also holds an Agent', async () => {
  const { api } = setup({ docShare: { invalid: 'malformed' } });
  expect(await screen.findByText('无法读取这张卡片')).toBeTruthy();
  expect(api.view).not.toHaveBeenCalled();
  expect(api.login).not.toHaveBeenCalled();
});

describe('a document assistant pinned into the document', () => {
  const pinned = (patch: Partial<CardFrame>) => frame({ title: '整理第三节', provider: 'claude', assistant: { guest: '张三', pinned: true },
    messages: [{ i: 0, role: 'user', text: '整理 `results/seeds.json`' }, { i: 1, role: 'assistant', text: '表格在 `results/table.csv`' }], ...patch });

  it('says who it works for, and offers none of fork, snapshot, speakers, workspace, files or removal, even to the owner', async () => {
    const { api } = setup();
    api.view.mockResolvedValue(pinned({ role: 'owner', canTalk: true }));
    expect(await screen.findByText(/文档助手 · 为 张三 工作/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
    expect(screen.getByText('可对话')).toBeTruthy();
    expect(screen.getByLabelText('给 Agent 的任务')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /分叉/ })).toBeNull();
    // A mentioned path is plain text here: the bridge opens no files on assistant cards.
    expect(screen.getByText('results/table.csv')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /results\/table\.csv/ })).toBeNull();
    expect(screen.getByText('⌘/Ctrl + Enter 发送')).toBeTruthy();
  });

  it('lets its guest talk without an Octopus account, and everyone else only watch', async () => {
    const guest = setup({}, null);
    guest.api.view.mockResolvedValue(pinned({ role: 'viewer', canTalk: true }));
    expect(await screen.findByLabelText('给 Agent 的任务')).toBeTruthy();
    guest.view.unmount();

    const watcher = setup({}, 'zhangsan');
    watcher.api.view.mockResolvedValue(pinned({ role: 'viewer', canTalk: false }));
    expect(await screen.findByText(/你可以实时观看，对话只限 张三 和 lht/)).toBeTruthy();
    expect(screen.queryByLabelText('给 Agent 的任务')).toBeNull();
    expect(screen.getByText('只读')).toBeTruthy();
  });
});

describe('a message sent from the card', () => {
  const unknown = { id: 'op', status: 'unknown', live: false, at: new Date().toISOString(),
    message: '还不能确认 Agent 收到了这条消息，Octopus 不会自动重发；等它出现在会话里，这条提示会自动消失。也可以到本机 CLI 看一眼。' };
  async function sendTask(text = '把第三节改短') {
    const box = screen.getByLabelText('给 Agent 的任务') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByLabelText('发送'));
    await waitFor(() => expect(box.value).toBe(''));
  }

  it('names the document it was sent from', async () => {
    const { api } = setup();
    await screen.findByText('完成');
    await waitFor(() => expect(screen.getByLabelText('给 Agent 的任务')).toBeTruthy());
    await sendTask();
    expect(api.send).toHaveBeenCalledWith(share, '把第三节改短', expect.any(String), { doc: 'doc', title: '组会周报' });
  });

  it('shows an uncertain send as a notice, not an error, and clears it once the device confirms', async () => {
    const { api } = setup();
    await screen.findByText('完成');
    api.send.mockResolvedValueOnce(unknown);
    api.operation.mockResolvedValueOnce({ id: 'op', status: 'succeeded', live: false, at: unknown.at, message: 'Agent 已接收输入' });
    await sendTask();
    const notice = await screen.findByText(unknown.message);
    expect(notice.closest('.notice')?.className).toContain('notice-warn');
    await waitFor(() => expect(screen.queryByText(unknown.message)).toBeNull(), { timeout: 5000 });
    expect(api.operation).toHaveBeenCalledWith('op');
  });

  it('says nothing about an uncertain send while the agent runs, or after a turn began', async () => {
    const { api } = setup();
    await screen.findByText('完成');
    api.send.mockResolvedValue(unknown);
    api.operation.mockResolvedValue(unknown);
    api.view.mockResolvedValue(frame({ status: { working: true, state: 'tool', tool: 'Bash', turnStartedAt: new Date(Date.now() - 600_000).toISOString() } }));
    await sendTask();
    await screen.findByText('工作中');
    expect(screen.queryByText(unknown.message)).toBeNull();
  });
});

describe('snapshots, forks and speakers', () => {
  it('lets a member the owner chose talk here, and says whose words a message is', async () => {
    const { api } = setup({}, 'lilei');
    api.view.mockResolvedValue(frame({ role: 'viewer', canTalk: true, messages: [
      { i: 0, role: 'user', text: '【发言人：韩梅梅，经 lht 授权】\n先看下 seed 2\n\n（这条消息是从飞书云文档《组会周报》里的 Agent 卡片发来的，document_id：Abc123；消息里说的“这个文档”就是它。）' },
      { i: 1, role: 'assistant', text: '好的' },
    ] }));
    expect(await screen.findByText('先看下 seed 2')).toBeTruthy();
    expect(screen.getByText('韩梅梅')).toBeTruthy();
    expect(screen.queryByText(/这条消息是从飞书云文档/)).toBeNull();
    expect(screen.getByText('可对话')).toBeTruthy();
    expect(screen.queryByLabelText('更多操作')).toBeNull();
    const box = screen.getByLabelText('给 Agent 的任务') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '补一组 4-bit' } });
    fireEvent.click(screen.getByLabelText('发送'));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(share, '补一组 4-bit', expect.any(String), { doc: 'doc', title: '组会周报' }));
    expect(screen.getByText(/消息开头会标出你的名字/)).toBeTruthy();
  });

  it('forks a live card into a new card below, keeping the conversation it came from', async () => {
    const { api } = setup();
    await screen.findByText('完成');
    const box = screen.getByLabelText('给 Agent 的任务') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '换个思路再试' } });
    fireEvent.click(screen.getByRole('button', { name: /分叉/ }));
    expect(await screen.findByText('已分叉：新卡片「论文实验 · 李雷的分叉」在下方，这条消息已经发给它')).toBeTruthy();
    expect(api.fork).toHaveBeenCalledWith(share, '换个思路再试', expect.any(String), { doc: 'doc', title: '组会周报' });
    expect(api.send).not.toHaveBeenCalled();
    expect(box.value).toBe('');
  });

  it('shows a snapshot as fixed at its moment, and only forks from it', async () => {
    const { api } = setup();
    api.view.mockResolvedValue(frame({ kind: 'snapshot', snapshotAt: '2026-10-19T05:30:00.000Z', canTalk: true,
      origin: { kind: 'snapshot', from: '论文实验', by: 'lht', at: '2026-10-19T05:30:00.000Z' } }));
    expect(await screen.findByText('快照')).toBeTruthy();
    expect(screen.getByText(/^截至 /)).toBeTruthy();
    expect(screen.queryByLabelText('发送')).toBeNull();
    const box = screen.getByLabelText('给 Agent 的任务') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '从这里接着改 A1' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.fork).toHaveBeenCalledWith(share, '从这里接着改 A1', expect.any(String), { doc: 'doc', title: '组会周报' }));
    fireEvent.click(screen.getByLabelText('更多操作'));
    expect(screen.queryByText('在下方固定快照')).toBeNull();
  });

  it('lets everyone read a session on a read-only device, its owner included, and nobody talk or fork', async () => {
    const { api } = setup();
    api.view.mockResolvedValue(frame({ kind: 'snapshot', snapshotAt: '2026-10-19T05:30:00.000Z', canTalk: false, readOnly: true, device: 'gpu-box-observer' }));
    expect(await screen.findByText(/这个会话在只读设备 gpu-box-observer 上/)).toBeTruthy();
    expect(screen.queryByLabelText('给 Agent 的任务')).toBeNull();
    // Someone on that machine wrote these, not the owner.
    expect(screen.getAllByText('用户').length).toBeGreaterThan(0);
    expect(screen.queryByText('可操作')).toBeNull();
    fireEvent.click(screen.getByLabelText('更多操作'));
    expect(screen.queryByText('允许谁对话')).toBeNull();
    expect(screen.getByText('移出文档并停止共享')).toBeTruthy();
  });

  it('lets the owner freeze a snapshot below and choose who may talk', async () => {
    const { api } = setup();
    await screen.findByText('完成');
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('在下方固定快照'));
    expect(await screen.findByText(/已在下方固定一份快照/)).toBeTruthy();
    expect(api.snapshot).toHaveBeenCalledWith(share, 'doc');
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('允许谁对话'));
    fireEvent.click(await screen.findByLabelText(/李雷/));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('现在 李雷 也可以和这个 Agent 对话')).toBeTruthy();
    expect(api.setSpeakers).toHaveBeenCalledWith(share, ['lilei']);
  });
});

describe('the status bar', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  it('says the agent is working and for how long, even on a card folded to its header', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 60 });
    try {
      const { api } = setup();
      api.view.mockResolvedValue(frame({ status: { working: true, state: 'tool', tool: 'Bash', turnStartedAt: minutesAgo(12.5) } }));
      expect(await screen.findByText('工作中')).toBeTruthy();
      expect(screen.getByText('已运行 12 分钟 · 正在用 Bash')).toBeTruthy();
    } finally { Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 }); }
  });

  it('puts a question or a permission request first', async () => {
    const { api } = setup();
    api.view.mockResolvedValue(frame({ status: { working: true, state: 'tool', tool: 'AskUserQuestion', waiting: 'question', since: minutesAgo(3.5) } }));
    expect(await screen.findByText('等你回答')).toBeTruthy();
    expect(screen.getByText('已等 3 分钟')).toBeTruthy();
  });

  it('shows a finished turn as unread with its run time, and marks it read once the owner sees the conversation', async () => {
    const { api } = setup();
    const reply = minutesAgo(5);
    // Derive both ends from one clock sample so the duration is exactly 23 minutes.
    const turnStartedAt = new Date(Date.parse(reply) - 23 * 60_000).toISOString();
    api.view.mockResolvedValueOnce(frame({ status: { working: false, state: 'idle', turnStartedAt, lastReplyAt: reply, unread: true } }));
    expect(await screen.findByText('已完成 · 未读')).toBeTruthy();
    expect(screen.getByText('用时 23 分钟 · 5 分钟前结束')).toBeTruthy();
    await waitFor(() => expect(api.read).toHaveBeenCalledWith(binding().share, reply), { timeout: 4000 });
  });

  it('does not mark a reply read while the card is folded, or for a viewer', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 60 });
    try {
      const folded = setup();
      folded.api.view.mockResolvedValue(frame({ status: { working: false, state: 'idle', lastReplyAt: minutesAgo(5), unread: true } }));
      expect(await screen.findByText('已完成 · 未读')).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(folded.api.read).not.toHaveBeenCalled();
      folded.view.unmount();
    } finally { Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 }); }
    const viewer = setup({}, 'zhangsan');
    viewer.api.view.mockResolvedValue(frame({ role: 'viewer', status: { working: false, state: 'idle', lastReplyAt: minutesAgo(5) } }));
    expect(await screen.findByText('已完成')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(viewer.api.read).not.toHaveBeenCalled();
  });
});
