/**
 * Local preview: a simulated document and Agent, clearly labelled, never a
 * Feishu login or a real Agent. URL parameters pick the scene so every card
 * state can be opened and screenshotted directly:
 *   ?role=owner|viewer|guest|speaker   who is looking (guest = tenant member without an Octopus account; speaker = a member the owner lets talk)
 *   ?scene=live|empty|copied|revoked|readonly|nogrant|home|snapshot|fork|board
 *   ?scene=share-owner|share-viewer|share-anonymous|share-empty|share-many|share-secret|share-copied|share-unknown|share-invalid|share-revealed
 *                               a document-share card: its owner (a pending key to reveal), a signed-in reader (one key is
 *                               theirs), a reader who cannot sign in, no keys, many keys (the body scrolls), a reader who has
 *                               just taken a key (its one-time box open), a copy, an unknown card, a broken Record, and a
 *                               pending key whose command another tab already took
 *   ?self_serve=off|read|write           the most a reader may take for themselves (default write)
 *   ?app_access=edit|view|none|unknown   what the Octopus app may do in the document (default edit; view/none raise the banner)
 *   ?invite=1                            the owner already has a claim link
 *   ?fail=network|action|take            a share card's read, its next owner or key action, or taking a key fails
 *   ?host_matches=true|false|null        override the bridge's match of the host's document token (default: compared, as the bridge does)
 *   ?card_state=present|missing|unknown  the bridge's last check for the card (`missing` turns `present` on the next read, as after a re-check)
 *   ?scene=assistant-off|assistant-on|assistant-setup|assistant-starting|assistant-chat|assistant-failed|assistant-anonymous
 *                               the control card's 文档助手 tab: off (the owner sees the setup, a reader a note), on with its list
 *                               (the owner sees every guest's), the owner's settings open, a start in progress, an open
 *                               conversation, a start that fails, a reader who cannot sign in (`&role=viewer`: a reader)
 *   ?scene=assistant-pinned     an assistant its guest pinned into the document: `&role=guest` is that guest (no Octopus
 *                               account, may talk), `viewer` anyone else (watches), `owner` the owner
 *   ?assistant_rights=read      the card's assistants only read the document
 *   ?mobile=1                   the inline page plays Feishu mobile, where the card's height hint resizes its block
 *   ?observed=1                 the session is on a read-only device (another account's sessions, observed)
 *   ?file=results/table2.csv    open a mentioned file at start (as the large view does)
 *   ?theme=dark                 the host's dark mode
 */
import type {
  AgentApi, AgentOperation, AssistantSettings, AssistantTarget, AssistantView, BoardBinding, CardBinding, CardFrame, DocShareConnect, DocShareInvite, DocShareLink, DocSharePanel,
  DocShareRights, DocShareSelfServe, DocsHost, FileReply, HostSnapshot, LaunchOptions, SessionChoice, TranscriptRow, WorkspaceInfo,
} from './protocol';
import { AgentApiError, parseDocShare } from './protocol';
import type { Surface } from './host';

const SHARE = `ds_${'A'.repeat(43)}`;
/** The card capability of the assistant a scene opens in the panel: its own conversation, apart from the card's. */
const ASSISTANT_SHARE = `ds_${'Z'.repeat(43)}`;
const ANCHOR = `dsa_${'S'.repeat(43)}`;
const SESSIONS: SessionChoice[] = [
  { resourceId: 'r1', title: '论文项目：模型合并实验与图表', preview: '8-shot CoT 下 GSM8K 为 35.6 ± 0.3，与论文一致。', device: 'gpu-box-b', provider: 'codex', project: 'lora-merge', lastActivity: new Date(Date.now() - 4 * 60_000).toISOString(), working: true, canSend: true, shared: 1 },
  { resourceId: 'r2', title: 'Octopus 飞书文档卡片评审', device: 'gpu-box', provider: 'claude', project: 'octopus', lastActivity: new Date(Date.now() - 52 * 60_000).toISOString(), working: false, canSend: true, shared: 0 },
  { resourceId: 'r3', title: '交创论坛讲稿润色', device: 'macbook-lht', provider: 'claude', lastActivity: new Date(Date.now() - 26 * 3_600_000).toISOString(), working: false, canSend: true, shared: 0 },
  { resourceId: 'r4', title: '子任务：基线复现（由主会话派生）', device: 'gpu-box-b', provider: 'codex', project: 'lora-merge', lastActivity: new Date(Date.now() - 3 * 86_400_000).toISOString(), working: false, canSend: false, shared: 0 },
];

/** A member the owner lets talk, as the bridge writes their message: the speaker line, then the document footer. */
const SPEAKER_TURN: Omit<TranscriptRow, 'i'> = { role: 'user', text: '【发言人：李雷，经 lht 授权】\n能不能再补一组 4-bit 量化下的结果？我想放进组会的对比表里。\n\n（这条消息是从飞书云文档《组会周报 · 模型合并复现》里的 Agent 卡片发来的，document_id：PreviewDoc0000000000000000；消息里说的“这个文档”就是它。）' };

const SCRIPT: Array<Omit<TranscriptRow, 'i'>> = [
  { role: 'user', text: '请复现 Table 2 里 LoRA 模型合并在 LLaMA-7B 上的结果，并和论文数字对比，差异超过 0.5 个点的地方要解释原因。' },
  { role: 'assistant', text: '好的。我先确认实验配置，再跑 3 个随机种子取平均。' },
  { role: 'assistant', text: '', tools: ['Read'] },
  { role: 'assistant', text: '', tools: ['Bash'] },
  { role: 'assistant', text: '', tools: ['Bash'] },
  { role: 'assistant', text: '复现结果如下（3 个种子平均），完整数据在 `results/table2.csv`：\n\n| 任务 | 论文 | 复现 | 差异 |\n|---|---|---|---|\n| MMLU | 46.3 | 46.1 | −0.2 |\n| GSM8K | 35.8 | 34.9 | **−0.9** |\n| HumanEval | 15.2 | 15.4 | +0.2 |\n\nGSM8K 偏低 0.9：论文用的是 8-shot CoT，我们默认是 5-shot。改成 8-shot 后重跑一次确认。' },
  { role: 'user', text: '好，改成 8-shot 重跑 GSM8K，顺便把三个种子的方差也列出来。' },
  { role: 'assistant', text: '', tools: ['Edit'] },
  { role: 'assistant', text: '', tools: ['Bash'] },
];
const FINALE: Omit<TranscriptRow, 'i'> = { role: 'assistant', text: '8-shot CoT 下 GSM8K 为 **35.6 ± 0.3**（种子 0/1/2：35.9、35.2、35.7），与论文的 35.8 一致，差异在方差范围内。\n\n结论：Table 2 全部复现，差异均 < 0.5。\n\n- 对比图：`results/fig2_gsm8k.png`\n- 种子明细：`results/seeds.json`\n- 总结：`reports/summary.md`，论文草稿已更新 `paper/draft.pdf`\n- 配置改动：`configs/gsm8k.yaml`，所有产物都在 `results/` 下。' };

/** A placeholder Octopus: keys' endpoints and claim links point here, never at a real one. */
const OCTOPUS = 'https://octopus.example';

export function createFixture(surface: Surface): { host: DocsHost; api: AgentApi } {
  const params = new URLSearchParams(location.search);
  const role = params.get('role') ?? 'owner';
  const scene = params.get('scene') ?? 'live';
  const username = role === 'owner' ? 'lht' : role === 'viewer' ? 'zhangsan' : role === 'speaker' ? 'lilei' : null;
  const snapshotScene = scene === 'snapshot';
  const observed = params.get('observed') === '1';
  let speakers: string[] = role === 'speaker' ? ['lilei'] : [];
  // The control card's assistants tab, or an assistant its guest pinned into the document (an Agent card).
  const pinnedScene = scene === 'assistant-pinned';
  const assistantScene = scene.startsWith('assistant-') && !pinnedScene ? scene.slice('assistant-'.length) : '';
  const binding: CardBinding = pinnedScene
    ? { v: 2, share: SHARE, title: '整理第三节的实验数据', owner: 'lht', device: 'gpu-box-b', provider: 'claude', doc: 'preview-doc' }
    : { v: 2, share: SHARE, title: observed ? 'LUCY · 分析最新运行结果' : '论文项目：模型合并实验与图表', owner: 'lht', device: observed ? 'gpu-box-observer' : 'gpu-box-b', provider: 'codex', doc: scene === 'copied' ? 'original-doc' : 'preview-doc' };
  const board: BoardBinding = { v: 1, board: `db_${'P'.repeat(43)}`, title: 'Project Plan · 进度', owner: 'lht', doc: 'preview-doc' };
  // A share card's scene: what its Record holds, and what the bridge answers for it.
  const shareScene = scene.startsWith('share-') ? scene.slice('share-'.length) : assistantScene ? 'assistant' : '';
  const shares = shareBridge(shareScene, params, role, assistantScene);
  const conversation = assistantConversation();
  const assistantShare = (share: string) => share === ASSISTANT_SHARE || (pinnedScene && share === SHARE);
  let snapshot: HostSnapshot = {
    doc: 'preview-doc', editable: scene !== 'readonly',
    binding: scene === 'empty' || scene === 'board' || shareScene ? null : binding, board: scene === 'board' ? board : null,
    docShare: shareScene ? parseDocShare({ v: 1, anchor: shareScene === 'invalid' ? 'ds_not-an-anchor' : ANCHOR }) : null,
    float: surface === 'float', visible: true, dark: params.get('theme') === 'dark',
  };
  let change: (s: HostSnapshot) => void = () => {};
  let revoked = scene === 'revoked';
  let rows: TranscriptRow[] = [...SCRIPT, ...(scene === 'fork' || role === 'speaker' ? [SPEAKER_TURN] : [])].map((row, i) => ({ ...row, i }));
  let working = !snapshotScene;
  let counter = 1;
  let finished = false;
  let finishedAt = 0;
  let readUntil = 0;
  let uncertainUntil = 0;
  const started = Date.now();
  const step = () => {
    // The scripted Agent finishes its last step ~6 s after the page opens.
    // A snapshot never moves on.
    if (!finished && !snapshotScene && Date.now() - started > 6_000) { rows = [...rows, { ...FINALE, i: rows.length }]; working = false; finished = true; finishedAt = Date.now(); counter++; }
  };

  let members = [{ username: 'lilei', name: '李雷' }];
  const host: DocsHost = {
    surface,
    takeExpandedFile: () => params.get('file'),
    documentTitle: async () => '组会周报 · 模型合并复现',
    documentText: async () => '# 组会周报 · 模型合并复现\n\n## 本周目标\n- 复现 Table 2\n- 写出差异分析\n',
    initialize: async (fn) => { change = fn; return snapshot; },
    loginCode: async () => 'preview-code',
    bind: async (next) => {
      snapshot = { ...snapshot, binding: next ? { v: 2, ...next, doc: snapshot.doc } : null };
      change(snapshot); return snapshot;
    },
    clearBoard: async () => { snapshot = { ...snapshot, board: null }; change(snapshot); return snapshot; },
    expand: async () => { window.open(`${location.pathname.replace(/[^/]*$/, '')}modal.html${location.search}`, '_blank', 'width=1040,height=760'); },
    float: async () => { window.open(`${location.pathname.replace(/[^/]*$/, '')}float.html${location.search}`, '_blank', 'width=340,height=720'); },
    open: async (url) => { window.open(url, '_blank', 'noopener'); },
    // Feishu desktop keeps an inline block at the height readers give it, and the card fills it. On mobile (`?mobile=1`)
    // the card's height hint resizes the block: the page stands in for it.
    fitHeight: async (height) => { if (surface === 'inline' && params.get('mobile') === '1') document.getElementById('root')!.style.height = `${height}px`; },
    readerName: shares.readerName,
    close: async () => {},
  };

  const frame = (after: number): CardFrame => {
    const reset = after < 0 || after >= rows.length;
    return {
      rev: `${counter}.${working ? 1 : 0}`, role: username === 'lht' ? 'owner' : 'viewer', title: binding.title, owner: 'lht', device: binding.device, provider: binding.provider,
      status: working ? { working: true, state: 'tool', tool: 'Bash', turnStartedAt: new Date(started - 17 * 60_000).toISOString() }
        : { working: false, state: 'idle', turnStartedAt: new Date(started - 17 * 60_000).toISOString(), lastReplyAt: new Date(finishedAt).toISOString(),
          ...(username === 'lht' && readUntil < finishedAt ? { unread: true } : {}) },
      total: rows.length, reset, messages: reset ? rows : rows.filter((r) => r.i >= after),
      kind: snapshotScene ? 'snapshot' : 'live',
      ...(snapshotScene ? { snapshotAt: new Date(started - 3 * 60_000).toISOString(), origin: { kind: 'snapshot' as const, from: binding.title, by: 'lht', at: new Date(started - 3 * 60_000).toISOString() } } : {}),
      ...(scene === 'fork' ? { origin: { kind: 'fork' as const, from: '论文项目：模型合并实验与图表', by: '李雷', at: new Date(started - 60_000).toISOString() } } : {}),
      canTalk: !observed && (role === 'owner' || speakers.includes(username ?? '')),
      ...(observed ? { readOnly: true } : {}),
    };
  };
  const op = (id: string, live: boolean): AgentOperation => ({ id, status: live ? 'running' : 'succeeded', message: live ? '正在把任务送到 Agent…' : 'Agent 已接收输入', live });
  const api: AgentApi = {
    login: async () => ({ token: 'fda_preview', username, expiresAt: Date.now() + 1_800_000 }),
    sessions: async () => { await delay(500); return { sessions: SESSIONS }; },
    share: async (input) => ({ binding: { share: SHARE, title: 'title' in input ? input.title : binding.title, owner: 'lht', device: binding.device, provider: binding.provider } }),
    unshare: async () => { revoked = true; return { revoked: 1 }; },
    read: async () => { readUntil = Date.now(); counter++; return { ok: true as const }; },
    view: async (share, since, after) => {
      await delay(120);
      if (assistantShare(share)) {
        // An assistant: its guest and the owner talk to it; a pinned one anyone in the document watches.
        const next = conversation.frame(after, pinnedScene
          ? { role: username === 'lht' ? 'owner' : 'viewer', canTalk: role === 'owner' || role === 'guest', pinned: true, title: binding.title }
          : { role: username === 'lht' ? 'owner' : 'viewer', canTalk: true, pinned: false, title: '整理第三节的实验数据' });
        return since === next.rev ? { rev: next.rev, unchanged: true } : next;
      }
      if (revoked) throw new AgentApiError(410, 'lht 已停止共享这个会话');
      step();
      const next = frame(after);
      return since === next.rev ? { rev: next.rev, unchanged: true } : next;
    },
    // The simulated conversation is short: one frame holds it whole.
    older: async () => ({ messages: [], next: 0 }),
    message: async (share, i) => ({ i, text: assistantShare(share) ? conversation.message(i) : rows.find((row) => row.i === i)?.text ?? '' }),
    send: async (share, prompt) => {
      if (assistantShare(share)) { conversation.send(prompt); return op('op-assistant', true); }
      step();
      if (params.get('send') === 'uncertain') {
        // A send the device cannot confirm at first; its record turns up 8 s later.
        uncertainUntil = Date.now() + 8_000;
        setTimeout(() => { rows = [...rows, { role: 'user', text: prompt, i: rows.length }]; counter++; }, 8_000);
        return { id: 'op-preview', status: 'unknown', live: false, at: new Date().toISOString(),
          message: '还不能确认 Agent 收到了这条消息，Octopus 不会自动重发；等它出现在会话里，这条提示会自动消失。也可以到本机 CLI 看一眼。' };
      }
      rows = [...rows, { role: 'user', text: prompt, i: rows.length }]; working = true; counter++;
      setTimeout(() => { rows = [...rows, { role: 'assistant', text: '收到，这是本地预览的模拟回复：真实卡片会把任务交给你的 Agent，并在这里实时显示它的进展。', i: rows.length }]; working = false; counter++; }, 4_000);
      return op('op-preview', true);
    },
    stop: async (share) => {
      if (assistantShare(share)) conversation.stop(); else { working = false; counter++; }
      return op('op-stop', false);
    },
    snapshot: async () => { await delay(900); return { binding: { share: SHARE, title: binding.title, owner: 'lht', device: binding.device, provider: binding.provider } }; },
    fork: async (_share, prompt) => {
      await delay(1200);
      return { binding: { share: SHARE, title: `${binding.title} · ${role === 'speaker' ? '李雷' : 'lht'}的分叉`, owner: 'lht', device: binding.device, provider: binding.provider },
        ...(prompt ? { operation: { id: 'op-fork', status: 'succeeded', message: 'Agent 已接收输入', live: false, at: new Date().toISOString() } } : {}) };
    },
    speakers: async () => { await delay(250); return { members: CANDIDATES.filter((m) => speakers.includes(m.username)), candidates: CANDIDATES }; },
    setSpeakers: async (_share, next) => { await delay(350); speakers = [...next]; counter++; return { members: CANDIDATES.filter((m) => speakers.includes(m.username)), candidates: CANDIDATES }; },
    operation: async (id) => Date.now() < uncertainUntil
      ? { id, status: 'unknown', live: false, message: '还不能确认 Agent 收到了这条消息，Octopus 不会自动重发；等它出现在会话里，这条提示会自动消失。也可以到本机 CLI 看一眼。' }
      : op(id, false),
    launchOptions: async () => { await delay(400); return LAUNCH; },
    launch: async (form) => { await delay(500); launchAt = Date.now(); launchTitle = form.title; return { id: 'fdl-preview' }; },
    launchStatus: async () => Date.now() - launchAt < 2_500
      ? { state: 'starting', message: Date.now() - launchAt < 1_000 ? '正在把任务交给设备…' : '设备正在启动 Agent…' }
      : { state: 'ready', message: '已启动', binding: { share: SHARE, title: launchTitle, owner: 'lht', device: 'gpu-box-b', provider: 'claude' } },
    workspace: async () => { await delay(300); return workspace(scene, members); },
    grantWorkspace: async (_share, _workspace, next) => {
      await delay(400);
      members = CANDIDATES.filter((m) => next.includes(m.username));
      return workspace(scene, members);
    },
    file: async (_share, path) => {
      await delay(350);
      if (role !== 'owner' && scene === 'nogrant') throw new AgentApiError(403, 'lht 还没有把工作区「lora-merge」共享给你');
      if (role === 'guest') throw new AgentApiError(403, '打开文件需要你的飞书账号关联 Octopus 账号');
      return fixtureFile(path);
    },
    board: async () => {
      await delay(200);
      if (revoked) throw new AgentApiError(410, '这块看板已停止共享');
      return { role: username === 'lht' ? 'owner' : 'viewer', title: board.title, owner: 'lht', version: 3, updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(), html: BOARD_HTML };
    },
    unboard: async () => { revoked = true; return { revoked: true }; },
    ...shares.api,
    disconnect: () => {},
  };
  return { host, api };
}

type ShareBridge = Pick<AgentApi, 'sharePanel' | 'shareAction' | 'shareReveal' | 'shareSelf' | 'shareSettings' | 'shareInvite'
  | 'assistantTargets' | 'assistantConfigure' | 'assistantList' | 'assistantStart' | 'assistantStatus' | 'assistantEnd' | 'assistantPin'>;
/** An assistant as the fixture keeps it: whose it is, and when a starting one is ready (or fails). */
type Helper = Omit<AssistantView, 'mine'> & { by: string | null; readyAt: number; fails: string };
/** A key as the fixture keeps it: who took it on the card decides `mine`. */
type Key = Omit<DocShareLink, 'mine'> & { by: string | null };
const PREVIEW_TOKEN = 'PREVIEW-ONLY-not-a-real-token';
/** The bridge's own words when it cannot place the card in the document it controls. */
const NOT_HERE = '无法确认这张卡片就在它管理的那篇文档里（例如它是从别的文档复制过来的），为安全起见';

/**
 * The bridge's side of a share card, in memory: the same refusals the contract
 * names, keys that change as the card acts on them, and placeholder tokens.
 */
function shareBridge(scene: string, params: URLSearchParams, role: string, assistantScene: string): { api: ShareBridge; readerName(): Promise<string> } {
  const fail = scene ? params.get('fail') ?? '' : '';
  const anonymous = scene === 'anonymous' || assistantScene === 'anonymous';
  const owner = role === 'owner' && !['viewer', 'anonymous', 'secret'].includes(scene) && !anonymous;
  // Who the bridge sees: the owner, a signed-in reader, or nobody (a reader who cannot sign in).
  const reader = anonymous ? null : owner ? 'lht' : 'zhangsan';
  const asked = params.get('self_serve');
  let selfServe: DocShareSelfServe = asked === 'off' || asked === 'read' ? asked : 'write';
  const access = params.get('app_access');
  const appAccess: DocSharePanel['app_access'] = access === 'view' || access === 'none' || access === 'unknown' ? access : 'edit';
  let invite: DocShareInvite = params.get('invite') === '1' ? { active: true, created_at: Date.now() - 3 * 86_400_000 } : { active: false, created_at: null };
  const checked = params.get('card_state');
  let cardState: DocSharePanel['card_state'] = checked === 'missing' || checked === 'unknown' ? checked : 'present';
  let keys: Key[] = scene === 'empty' ? [] : scene === 'many' ? manyKeys() : someKeys();
  let made = 100;
  const documentId = scene === 'copied' ? 'original-doc' : 'preview-doc';
  // `mine`: taken on this card by the signed-in reader who asks; the owner's keys made through an agent are no one's here.
  const link = ({ by, ...key }: Key): DocShareLink => ({ ...key, mine: reader !== null && key.via === 'card' && by === reader });
  const matches = (hostToken?: string) => {
    const override = params.get('host_matches');
    return override === 'null' ? null : override === 'true' || override === 'false' ? override === 'true' : hostToken === documentId;
  };
  const panel = (hostToken?: string): DocSharePanel => {
    // A read of a `missing` card re-checks it: the next read finds it again.
    const state = cardState;
    if (cardState === 'missing') cardState = 'present';
    return {
      // Like the bridge: only the owner learns which document, or which device and workspace, the card controls.
      document_id: owner ? documentId : '', host_matches: matches(hostToken), viewer_is_owner: owner, card_state: state,
      lease_until: state === 'present' ? Date.now() + 20 * 3_600_000 : null, shares: keys.map(link),
      self_serve: selfServe, app_access: appAccess, app_name: 'Octopus', invite: owner ? invite : null, limits: { per_hour: 10, active_max: 50 },
      assistant: owner ? settings() : { ...settings(), project: project && { device: '', workspace_id: '', label: project.label } },
    };
  };
  // Assistants: on unless the scene turns them off; a started one is ready (or fails) a few seconds later.
  let rights: DocShareRights | null = assistantScene && assistantScene !== 'off' ? params.get('assistant_rights') === 'read' ? 'read' : 'write' : null;
  let project: AssistantSettings['project'] = rights ? { device: 'gpu-box-b', workspace_id: 'ws_acc', label: '论文项目' } : null;
  const settings = (): AssistantSettings => ({ rights, project, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } });
  let helpers: Helper[] = assistantScene ? someAssistants(assistantScene === 'failed') : [];
  const viewOf = ({ by, readyAt, fails, ...h }: Helper): AssistantView => {
    const state = h.state === 'starting' && Date.now() >= readyAt ? fails ? 'failed' : 'ready' : h.state;
    const message = state === 'starting' ? '正在启动…' : state === 'ready' ? '可以对话' : state === 'failed' ? fails || h.message : '已结束';
    return { ...h, state, message, mine: reader !== null && by === reader };
  };
  const seen = (id: string) => helpers.find((h) => h.id === id && (owner || h.by === reader));
  const signedOut = () => new Error('飞书登录没有完成');
  const notOwner = () => new AgentApiError(403, '只有这张卡片的所有者可以设置文档助手');
  const offline = () => new AgentApiError(0, '暂时连不上 Octopus，请检查网络');
  const api: ShareBridge = {
    sharePanel: async (_anchor, hostToken) => {
      await delay(300);
      if (fail === 'network') throw offline();
      if (scene === 'unknown') throw new AgentApiError(404, 'unknown_anchor');
      return panel(hostToken);
    },
    // Anyone may end a key, on the card in its own document; pausing and resuming are the owner's.
    shareAction: async (_anchor, id, action, hostToken) => {
      await delay(700);
      if (fail === 'action') throw offline();
      if (action !== 'terminate' && !owner) throw new AgentApiError(403, 'not_owner');
      if (!owner && matches(hostToken) !== true) throw new AgentApiError(403, `${NOT_HERE}不能在这里终止密钥`);
      const key = keys.find((k) => k.id === id);
      if (!key) throw new AgentApiError(404, 'unknown_share');
      if (key.status === 'terminated') throw new AgentApiError(409, 'terminated');
      if (key.status === 'pending' && action !== 'terminate') throw new AgentApiError(409, 'pending');
      const next: Key = { ...key, status: action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'terminated' };
      keys = keys.map((k) => k.id === id ? next : k);
      return { share: link(next) };
    },
    // A pending key's ways in, once: the key turns active as they are made.
    shareReveal: async (_anchor, id) => {
      await delay(900);
      if (fail === 'action') throw offline();
      if (!owner) throw new AgentApiError(403, 'not_owner');
      const key = keys.find((k) => k.id === id);
      if (!key) throw new AgentApiError(404, 'unknown_share');
      const next: Key = { ...key, status: 'active' };
      // share-revealed: another tab took the command after this card read the panel.
      if (scene === 'revealed' && key.status === 'pending') keys = keys.map((k) => k.id === id ? next : k);
      if (scene === 'revealed' || key.status !== 'pending') throw new AgentApiError(409, 'not_pending');
      keys = keys.map((k) => k.id === id ? next : k);
      const connect = connectFor(id);
      return { share: link(next), command: connect.claude, connect };
    },
    shareSelf: async (_anchor, hostToken, label, rights) => {
      await delay(800);
      if (fail === 'take') throw new AgentApiError(429, 'rate_limited');
      if (selfServe === 'off') throw new AgentApiError(403, 'self_serve_off');
      if (rights === 'write' && selfServe === 'read') throw new AgentApiError(403, 'rights_exceed');
      if (matches(hostToken) !== true) throw new AgentApiError(403, `${NOT_HERE}不能在这里领取密钥`);
      const key: Key = { id: `sh_${++made}`, label, rights, status: 'active', created_at: Date.now(), last_used_at: null, via: 'card', by: reader };
      keys = [key, ...keys];
      return { share: link(key), connect: connectFor(key.id) };
    },
    shareSettings: async (_anchor, level, hostToken) => {
      await delay(500);
      if (fail === 'action') throw offline();
      if (!owner) throw new AgentApiError(403, 'not_owner');
      selfServe = level;
      return panel(hostToken);
    },
    shareInvite: async (_anchor, op) => {
      await delay(600);
      if (fail === 'action') throw offline();
      if (!owner) throw new AgentApiError(403, 'not_owner');
      invite = op === 'create' ? { active: true, created_at: Date.now() } : { active: false, created_at: null };
      return op === 'create' ? { invite, link: `${OCTOPUS}/feishu/doc-key#i=dsi_${'PREVIEW-only-not-a-real-claim-link'.padEnd(43, 'x')}` } : { invite };
    },
    assistantTargets: async () => {
      await delay(400);
      if (!owner) throw notOwner();
      return { devices: TARGETS };
    },
    assistantConfigure: async (_anchor, config) => {
      await delay(600);
      if (!owner) throw notOwner();
      if (config.rights === null) {
        // Off ends every live assistant.
        rights = null;
        helpers = helpers.map((h) => { const state = viewOf(h).state; return state === 'starting' || state === 'ready' ? { ...h, state: 'ended', ended_at: Date.now(), readyAt: 0, fails: '' } : h; });
        return settings();
      }
      const device = TARGETS.find((d) => d.device === config.device && d.eligible);
      const workspace = device?.workspaces.find((w) => w.workspace_id === config.workspace_id);
      if (!device || !workspace) throw new AgentApiError(400, '请选择一台设备上的一个项目工作区');
      rights = config.rights;
      project = { device: device.device, workspace_id: workspace.workspace_id, label: workspace.label };
      return settings();
    },
    assistantList: async () => {
      await delay(300);
      if (anonymous) throw signedOut();
      return { assistants: helpers.filter((h) => owner || h.by === reader).map(viewOf).sort((a, b) => b.created_at - a.created_at) };
    },
    assistantStart: async (_anchor, _host, task, requestId, name) => {
      await delay(700);
      if (anonymous) throw signedOut();
      if (!rights) throw new AgentApiError(409, '这篇文档的所有者还没有开启文档助手');
      // The same request joins the first start.
      const id = `as_${requestId.slice(0, 8)}`;
      if (helpers.some((h) => h.id === id)) return { id };
      const running = helpers.filter((h) => h.by === reader).map(viewOf).filter((v) => v.state === 'starting' || v.state === 'ready');
      if (running.length >= 3) throw new AgentApiError(429, '你在这篇文档里同时最多运行 3 个文档助手，请先结束一个');
      helpers = [{ id, title: task.split('\n')[0].slice(0, 30), guest: name || '张三', by: reader, state: 'starting', message: '', rights, created_at: Date.now(), ended_at: null, pinned: false,
        readyAt: Date.now() + 5_000, fails: assistantScene === 'failed' ? '这台设备的 Runner 需要升级后才能运行文档助手' : '' }, ...helpers];
      return { id };
    },
    assistantStatus: async (id) => {
      await delay(250);
      const h = seen(id);
      if (!h) throw new AgentApiError(404, '找不到这个文档助手');
      const view = viewOf(h);
      return view.state === 'ready' ? { ...view, binding: { share: ASSISTANT_SHARE, title: view.title, owner: 'lht', device: 'gpu-box-b', provider: 'claude' } } : view;
    },
    assistantEnd: async (id) => {
      await delay(500);
      if (!seen(id)) throw new AgentApiError(404, '找不到这个文档助手');
      helpers = helpers.map((h) => h.id === id ? { ...h, state: 'ended', ended_at: Date.now(), readyAt: 0, fails: '' } : h);
      return viewOf(seen(id)!);
    },
    assistantPin: async (id) => {
      await delay(900);
      const h = helpers.find((x) => x.id === id && x.by === reader);
      if (!h) throw new AgentApiError(404, '找不到这个文档助手');
      if (h.pinned) throw new AgentApiError(409, '这个文档助手已经固定在文档里了');
      helpers = helpers.map((x) => x.id === id ? { ...x, pinned: true } : x);
      return { block: 'blk_preview' };
    },
  };
  // share-secret: the reader takes a key as the page opens, so its one-time box is on screen.
  if (scene === 'secret') void press(['领取访问密钥', '领取']);
  // Scenes that open on what a reader did in the assistants tab (off, the panel opens on the keys).
  if (assistantScene === 'off' || assistantScene === 'anonymous') void click('#share-tab-assistant');
  if (assistantScene === 'setup') void press(['设置']);
  if (assistantScene === 'chat') void press(['打开']);
  if (assistantScene === 'starting' || assistantScene === 'failed') {
    void press(['新对话']).then(() => fill('textarea', '请把第三节的实验数据整理成一张表，放在第三节末尾')).then(() => press(['启动助手']));
  }
  return { api, readerName: async () => reader === 'lht' ? 'lht' : reader ? '张三' : '' };
}

/** A key's ways in, each holding the placeholder token. */
function connectFor(id: string): DocShareConnect {
  const name = `octopus-doc-${id.slice(3)}`;
  const endpoint = `${OCTOPUS}/api/mcp`;
  return {
    claude: `claude mcp add --transport http --scope user ${name} ${endpoint} --header "Authorization: Bearer ${PREVIEW_TOKEN}"`,
    codex: `printf '\\n[mcp_servers.${name}]\\nurl = "${endpoint}"\\nhttp_headers = { Authorization = "Bearer ${PREVIEW_TOKEN}" }\\n' >> ~/.codex/config.toml`,
    endpoint, token: PREVIEW_TOKEN,
  };
}

/** Types into the first field matching `selector` once it appears, as a reader would (React hears the input event). */
async function fill(selector: string, text: string): Promise<void> {
  for (let tries = 0; tries <= 100; tries++) {
    const field = document.querySelector<HTMLTextAreaElement>(selector);
    if (field) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    await delay(50);
  }
}

/** Clicks the first element matching `selector` once it appears. */
async function click(selector: string): Promise<void> {
  for (let tries = 0; tries <= 100; tries++) {
    const target = document.querySelector<HTMLElement>(selector);
    if (target) { target.click(); return; }
    await delay(50);
  }
}

/** Clicks the buttons named, in turn, as each appears: a scene that opens on what a reader did. */
async function press(names: string[]): Promise<void> {
  for (const name of names) {
    for (let tries = 0; ; tries++) {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === name);
      if (button) { button.click(); break; }
      if (tries > 100) return;
      await delay(50);
    }
  }
}

/** The owner's devices as assistants see them: two that can run one, one offline, one too old. */
const TARGETS: AssistantTarget[] = [
  { device: 'gpu-box-b', label: 'gpu-box-b', eligible: true, workspaces: [{ workspace_id: 'ws_acc', label: '论文项目' }, { workspace_id: 'ws_reversible', label: 'lora-merge' }] },
  { device: 'macbook-lht', label: 'MacBook（lht）', eligible: true, workspaces: [{ workspace_id: 'ws_paper', label: 'papers/acc' }] },
  { device: 'gpu-box', label: 'gpu-box', eligible: false, reason: '设备离线', workspaces: [] },
  { device: 'lab-server', label: 'lab-server', eligible: false, reason: 'Runner 需要升级后才能运行文档助手', workspaces: [{ workspace_id: 'ws_lab', label: 'lab' }] },
];

/** A card's assistants: the reader's, ready and ended; another reader's, pinned into the document; and (failed scenes) one that did not start. */
function someAssistants(failed: boolean): Helper[] {
  const ago = (minutes: number) => Date.now() - minutes * 60_000;
  const base = { message: '', rights: 'write' as const, ended_at: null, pinned: false, readyAt: 0, fails: '' };
  return [
    ...(failed ? [{ ...base, id: 'as_4', title: '画 Figure 3 的对比图', guest: '张三', by: 'zhangsan', state: 'failed' as const, message: '设备暂时没有响应，结果还不确定', created_at: ago(8), ended_at: ago(7) }] : []),
    { ...base, id: 'as_1', title: '整理第三节的实验数据', guest: '张三', by: 'zhangsan', state: 'ready', created_at: ago(25) },
    { ...base, id: 'as_2', title: '检查参考文献的格式', guest: '韩梅梅', by: 'hanmm', state: 'ready', created_at: ago(130), pinned: true },
    { ...base, id: 'as_3', title: '把摘要改短到 200 字', guest: '张三', by: 'zhangsan', state: 'ended', created_at: ago(26 * 60), ended_at: ago(25 * 60) },
  ];
}

/** An assistant's first turn: the bridge's context paragraph, the guest's task, and its first answer. */
const ASSISTANT_SCRIPT: Array<Omit<TranscriptRow, 'i'>> = [
  { role: 'user', text: '你是 lht 在 Octopus 上运行的文档助手，这次为张三工作。文档《组会周报 · 模型合并复现》（document_id：PreviewDoc0000000000000000）你可以读写；项目「论文项目」只能读取。你的工具：feishu_shared_doc_outline、feishu_shared_doc_read、feishu_shared_doc_write、list_workspace_files、read_workspace_file。\n\n请把第三节的实验数据整理成一张表，放在第三节末尾。' },
  { role: 'assistant', text: '好的。我先看第三节现在的内容，再读项目里的结果文件。' },
  { role: 'assistant', text: '', tools: ['feishu_shared_doc_outline', 'feishu_shared_doc_read'] },
  { role: 'assistant', text: '', tools: ['read_workspace_file', 'read_workspace_file'] },
  { role: 'assistant', text: '第三节现在有两段文字和一张旧表。项目里 `results/seeds.json` 有三个种子的结果：\n\n| 任务 | 种子 0 | 种子 1 | 种子 2 | 平均 |\n|---|---|---|---|---|\n| GSM8K（8-shot CoT） | 35.9 | 35.2 | 35.7 | **35.6** |\n\n要我把它写到第三节末尾，替换那张旧表吗？' },
];

/** The conversation behind an assistant: the one a scene opens in the panel, or the pinned card's. */
function assistantConversation() {
  let rows: TranscriptRow[] = ASSISTANT_SCRIPT.map((row, i) => ({ ...row, i }));
  let working = false;
  let counter = 1;
  let turnAt = Date.now() - 4 * 60_000;
  let replyAt = Date.now() - 60_000;
  return {
    frame(after: number, as: { role: 'owner' | 'viewer'; canTalk: boolean; pinned: boolean; title: string }): CardFrame {
      const reset = after < 0 || after >= rows.length;
      return {
        rev: `a${counter}.${working ? 1 : 0}`, role: as.role, title: as.title, owner: 'lht', device: 'gpu-box-b', provider: 'claude',
        status: working ? { working: true, state: 'thinking', turnStartedAt: new Date(turnAt).toISOString() }
          : { working: false, state: 'idle', turnStartedAt: new Date(turnAt).toISOString(), lastReplyAt: new Date(replyAt).toISOString() },
        total: rows.length, reset, messages: reset ? rows : rows.filter((r) => r.i >= after), kind: 'live', canTalk: as.canTalk,
        assistant: { guest: '张三', pinned: as.pinned },
      };
    },
    send(prompt: string) {
      rows = [...rows, { role: 'user', text: prompt, i: rows.length }]; working = true; turnAt = Date.now(); counter++;
      setTimeout(() => {
        rows = [...rows, { role: 'assistant', text: '好的，已经写进第三节末尾，旧表删掉了。（本地预览的模拟回复：真实助手会以 Octopus 应用身份改写文档。）', i: rows.length }];
        working = false; replyAt = Date.now(); counter++;
      }, 3_000);
    },
    stop() { working = false; counter++; },
    message: (i: number) => rows.find((row) => row.i === i)?.text ?? '',
  };
}

/** Keys of each kind a share card can hold: the owner's, still pending; taken on the card (one by the reader); through the claim link; read-only; paused; terminated. */
function someKeys(): Key[] {
  const ago = (minutes: number) => Date.now() - minutes * 60_000;
  return [
    { id: 'sh_0', label: '韩梅梅的 Claude Code', rights: 'write', status: 'pending', created_at: ago(2), last_used_at: null, via: 'owner', by: 'lht' },
    { id: 'sh_5', label: '张三', rights: 'write', status: 'active', created_at: ago(40), last_used_at: ago(1), via: 'card', by: 'zhangsan' },
    { id: 'sh_1', label: 'Claude Code · 论文润色（lht 的 MacBook）', rights: 'write', status: 'active', created_at: ago(2 * 1440 + 95), last_used_at: ago(3), via: 'owner', by: 'lht' },
    { id: 'sh_6', label: '陈老师（校外）', rights: 'write', status: 'active', created_at: ago(26 * 60), last_used_at: ago(50), via: 'invite', by: null },
    { id: 'sh_2', label: '评审助手', rights: 'read', status: 'active', created_at: ago(5 * 60), last_used_at: null, via: 'card', by: 'hanmm' },
    { id: 'sh_3', label: 'Codex · 实验记录同步', rights: 'write', status: 'paused', created_at: ago(6 * 1440), last_used_at: ago(26 * 60), via: 'owner', by: 'lht' },
    { id: 'sh_4', label: '外部 MCP 客户端（已停用）', rights: 'write', status: 'terminated', created_at: ago(12 * 1440), last_used_at: ago(9 * 1440), via: 'owner', by: 'lht' },
  ];
}

/** A busy card: enough keys that the inline card reaches its height cap and its body scrolls. */
function manyKeys(): Key[] {
  const people = ['张三', '李四', '王五', '赵六', '陈老师', '刘同学', '孙助教', '周编辑', '吴审稿', '郑同学', '冯老师', '褚同学', '卫同学', '蒋老师', '沈同学', '韩同学', '杨助教', '朱同学'];
  const clients = ['Claude Code', 'Codex', 'Cursor'];
  return people.map((name, k): Key => ({
    id: `sh_m${k}`, label: `${name}的 ${clients[k % clients.length]}`, rights: k % 4 === 3 ? 'read' : 'write',
    status: k % 7 === 5 ? 'paused' : k >= 15 ? 'terminated' : 'active', created_at: Date.now() - (k + 1) * 97 * 60_000,
    last_used_at: k % 5 === 4 ? null : Date.now() - (k * 13 + 2) * 60_000, via: k % 3 === 2 ? 'invite' : 'card', by: k === 0 ? 'zhangsan' : null,
  }));
}

/** What a progress secretary might publish: tiles, a status table and an inline SVG chart, all in theme colours. */
const BOARD_HTML = `<style>
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:8px 0 14px}
.tile{border:1px solid var(--board-border);border-radius:10px;padding:10px 12px;background:var(--board-surface)}
.tile b{display:block;font-size:22px;line-height:1.2}.tile span{color:var(--board-muted);font-size:12px}
.good{color:var(--board-good)}.warn{color:var(--board-warn)}.bad{color:var(--board-bad)}
.bar{height:6px;border-radius:3px;background:var(--board-border);overflow:hidden}.bar i{display:block;height:100%;background:var(--board-accent)}
td.state{white-space:nowrap}
</style>
<div class="tiles">
  <div class="tile"><b>11</b><span>计划条目</span></div>
  <div class="tile"><b class="good">2</b><span>已有数据</span></div>
  <div class="tile"><b class="warn">5</b><span>进行中</span></div>
  <div class="tile"><b class="bad">1</b><span>需要你决定</span></div>
</div>
<table>
  <tr><th>条目</th><th>状态</th><th style="width:30%">进度</th><th>下一步</th></tr>
  <tr><td>A0 依赖图理论</td><td class="state warn">讨论中</td><td><div class="bar"><i style="width:25%"></i></div></td><td>和 与合作者确定节点定义</td></tr>
  <tr><td>A1 原型实现</td><td class="state warn">测试中</td><td><div class="bar"><i style="width:55%"></i></div></td><td>基准测试</td></tr>
  <tr><td>B1 对照实验</td><td class="state warn">对照测试</td><td><div class="bar"><i style="width:60%"></i></div></td><td>补齐剩余结果</td></tr>
  <tr><td>E1 学术 baseline</td><td class="state good">已有数据</td><td><div class="bar"><i style="width:90%"></i></div></td><td>写进论文</td></tr>
  <tr><td>D 工具链</td><td class="state bad">待决定</td><td><div class="bar"><i style="width:5%"></i></div></td><td>是否进入本轮</td></tr>
</table>
<h3>本周推进（条目数）</h3>
<svg viewBox="0 0 320 90" role="img"><title>本周推进</title>
  <g fill="var(--board-accent)"><rect x="10" y="50" width="30" height="30"/><rect x="60" y="35" width="30" height="45"/><rect x="110" y="20" width="30" height="60"/><rect x="160" y="40" width="30" height="40"/><rect x="210" y="10" width="30" height="70"/></g>
  <g fill="var(--board-muted)" font-size="10" text-anchor="middle"><text x="25" y="88">一</text><text x="75" y="88">二</text><text x="125" y="88">三</text><text x="175" y="88">四</text><text x="225" y="88">五</text></g>
</svg>
<details><summary>需要你决定的事</summary><ul><li>D 是否进入本轮：建议推迟到 E 测试稳定后。</li></ul></details>`;

let launchAt = 0;
let launchTitle = '';
const CANDIDATES = [{ username: 'lilei', name: '李雷' }, { username: 'hanmm', name: '韩梅梅' }, { username: 'chenli', name: '陈丽' }];
const workspace = (scene: string, members: WorkspaceInfo['members']): WorkspaceInfo => scene === 'home'
  ? { device: 'gpu-box-b', workspace: { id: 'ws_home', label: 'Home', display: '~', shareable: false, reason: '这是整个主目录（Home 工作区），不能共享；把项目目录登记为单独的工作区后再共享' }, path: 'lht/repos/lora-merge', members: [], candidates: CANDIDATES }
  : { device: 'gpu-box-b', workspace: { id: 'ws_reversible', label: 'lora-merge', display: '~/lht/repos/lora-merge', shareable: true }, path: '', members, candidates: CANDIDATES };

const LAUNCH: LaunchOptions = {
  devices: [
    { device: 'gpu-box-b', label: 'gpu-box-b', online: true, providers: ['claude', 'codex'] },
    { device: 'macbook-lht', label: 'MacBook（lht）', online: true, providers: ['claude'] },
    { device: 'gpu-box', label: 'gpu-box', online: false, providers: [], reason: '设备离线' },
  ],
  directories: [
    { device: 'gpu-box-b', path: '/home/ubuntu/lht/repos/lora-merge' },
    { device: 'gpu-box-b', path: '/home/ubuntu/lht/repos/octopus' },
    { device: 'macbook-lht', path: '/Users/lht/papers/acc' },
  ],
  models: {
    claude: [{ value: 'opus', label: 'Opus — 最强，默认选它' }, { value: 'sonnet', label: 'Sonnet — 更快，够用' }, { value: 'fable', label: 'Fable — 轻量' }],
    codex: [{ value: 'gpt-6-astra', label: 'GPT-6 Astra' }, { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }],
  },
  efforts: Object.fromEntries((['claude', 'codex'] as const).map((p) => [p, [['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '很高'], ['max', '最高']].map(([value, label]) => ({ value, label }))])) as LaunchOptions['efforts'],
  defaults: { device: 'gpu-box-b', directory: '/home/ubuntu/lht/repos/lora-merge', provider: 'claude', model: { claude: 'opus', codex: 'gpt-6-astra' }, effort: { claude: 'max', codex: 'xhigh' } },
};

const text = (path: string, mime: string, body: string): FileReply => ({ kind: 'file', workspace: 'lora-merge', path, name: path.split('/').pop()!, size: new Blob([body]).size, modifiedAt: new Date().toISOString(), mime, data: new Blob([body], { type: mime }) });

async function fixtureFile(path: string): Promise<FileReply> {
  const clean = path.replace(/^\.\//, '').replace(/\/+$/, '');
  if (path.endsWith('/') || clean === 'results') {
    return { kind: 'dir', workspace: 'lora-merge', path: 'results', truncated: false, entries: [
      { name: 'ablations', path: 'results/ablations', dir: true },
      { name: 'fig2_gsm8k.png', path: 'results/fig2_gsm8k.png', dir: false, size: 48_213 },
      { name: 'seeds.json', path: 'results/seeds.json', dir: false, size: 412 },
      { name: 'table2.csv', path: 'results/table2.csv', dir: false, size: 236 },
    ] };
  }
  if (clean.endsWith('.csv')) return text(clean, 'text/csv', 'task,paper,reproduced,delta,seeds\nMMLU,46.3,46.1,-0.2,3\nGSM8K (5-shot),35.8,34.9,-0.9,3\nGSM8K (8-shot CoT),35.8,35.6,-0.2,3\nHumanEval,15.2,15.4,+0.2,3\n');
  if (clean.endsWith('.json')) return text(clean, 'application/json', '{"gsm8k_8shot":{"seed_0":35.9,"seed_1":35.2,"seed_2":35.7,"mean":35.6,"std":0.29},"config":"configs/gsm8k.yaml"}');
  if (clean.endsWith('.md')) return text(clean, 'text/markdown', '# 复现总结\n\nTable 2 的三项结果全部复现，差异均小于 0.5 个点。\n\n| 任务 | 论文 | 复现 |\n|---|---|---|\n| MMLU | 46.3 | 46.1 |\n| GSM8K | 35.8 | 35.6 |\n| HumanEval | 15.2 | 15.4 |\n\n## 关键发现\n\n1. GSM8K 需要 **8-shot CoT**，默认 5-shot 会低 0.9。\n2. 三个种子的标准差约 0.3。\n');
  if (clean.endsWith('.yaml')) return text(clean, 'text/plain', 'task: gsm8k\nshots: 8\nprompt: cot\nseeds: [0, 1, 2]\nmodel: llama-7b\nmerge: lora-merge\n');
  if (clean.endsWith('.png')) {
    const data = await chart();
    return { kind: 'file', workspace: 'lora-merge', path: clean, name: clean.split('/').pop()!, size: data.size, modifiedAt: new Date().toISOString(), mime: 'image/png', data };
  }
  if (clean.endsWith('.pdf')) return { kind: 'file', workspace: 'lora-merge', path: clean, name: 'draft.pdf', size: PDF.length, modifiedAt: new Date().toISOString(), mime: 'application/pdf', data: new Blob([PDF], { type: 'application/pdf' }) };
  throw new AgentApiError(404, '文件不存在，或已被移动');
}

/** A plausible results figure, drawn at runtime so the fixture ships no binary. */
async function chart(): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 880; canvas.height = 480;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 880, 480);
  g.fillStyle = '#1f2329'; g.font = '600 22px sans-serif'; g.fillText('GSM8K accuracy (3 seeds)', 40, 44);
  const bars = [['Paper', 35.8, '#8f959e'], ['5-shot', 34.9, '#f19a37'], ['8-shot CoT', 35.6, '#3370ff']] as const;
  bars.forEach(([name, value, color], k) => {
    const x = 120 + k * 240; const h = (value - 30) * 60;
    g.fillStyle = color; g.fillRect(x, 420 - h, 120, h);
    g.fillStyle = '#1f2329'; g.font = '16px sans-serif'; g.fillText(name, x + 10, 450); g.fillText(String(value), x + 36, 410 - h);
  });
  g.strokeStyle = '#dee0e3'; g.beginPath(); g.moveTo(80, 420); g.lineTo(840, 420); g.stroke();
  return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
}

/** A one-page PDF, written by hand so the fixture needs no binary asset. */
const PDF = (() => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 22 Tf 72 760 Td (Reversible LoRA Merging) Tj 0 -34 Td /F1 13 Tf (Draft v3 - Table 2 reproduced, all deltas < 0.5) Tj 0 -22 Td (GSM8K 8-shot CoT: 35.6 +/- 0.3) Tj ET';
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, k) => { offsets.push(out.length); out += `${k + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
})();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
