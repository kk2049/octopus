import { useEffect, useMemo, useRef, useState } from 'react';
import { BoardCard } from './BoardCard';
import { Composer, useLive } from './Conversation';
import { Feed } from './Feed';
import { FileViewer } from './FileViewer';
import { NewAgent } from './NewAgent';
import { Picker } from './Picker';
import { SharePanel } from './SharePanel';
import { SpeakersPanel } from './SpeakersPanel';
import { WorkspacePanel } from './WorkspacePanel';
import { bindingIsFor, type AgentApi, type DocsHost, type HostSnapshot, type MessageOrigin, type SessionChoice, type ShareResult } from './protocol';
import { Icon, Logo, Notice, providerName, statusDetail, StatusPill, useNow } from './ui';

const message = (e: unknown) => e instanceof Error ? e.message.slice(0, 300) : '操作没有完成，请重试';

type Me = { state: 'idle' | 'connecting' | 'ready'; username: string | null; error: string };
/** Whether the card shows more than its header: folded to one strip, nothing below the header is visible. */
function useTall(min = 180): boolean {
  const [tall, setTall] = useState(() => window.innerHeight >= min);
  useEffect(() => {
    const update = () => setTall(window.innerHeight >= min);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [min]);
  return tall;
}

export function AgentCard({ host, api, preview = false }: { host: DocsHost; api: AgentApi; preview?: boolean }) {
  const [doc, setDoc] = useState<HostSnapshot | null>(null);
  const [hostError, setHostError] = useState('');
  const [me, setMe] = useState<Me>({ state: 'idle', username: null, error: '' });
  /** Choosing what this card shows: one of the owner's sessions, or a new agent. */
  const [picking, setPicking] = useState<false | 'list' | 'new'>(false);
  const [asViewer, setAsViewer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  /** In place of the conversation: a file the agent mentioned, or the workspace sharing panel. */
  const [file, setFile] = useState<string | null>(null);
  const [panel, setPanel] = useState<'workspace' | 'speakers' | null>(null);
  /** What the last menu action did, for a moment above the conversation. */
  const [done, setDone] = useState('');
  const [docTitle, setDocTitle] = useState('');

  useEffect(() => {
    let live = true;
    host.initialize((next) => { if (live) setDoc(next); }).then((next) => {
      if (!live) return;
      setDoc(next);
      const expanded = host.takeExpandedFile();
      if (expanded) setFile(expanded);
      void host.documentTitle().then((title) => { if (live) setDocTitle(title); }, () => {});
    }).catch((e) => { if (live) setHostError(message(e)); });
    return () => { live = false; api.disconnect(); void host.close(); };
  }, [host, api]);

  const binding = doc?.binding ?? null;
  const copied = Boolean(binding && doc && !bindingIsFor(binding, doc.doc));
  const share = binding && !copied && me.state === 'ready' ? binding.share : null;
  const live = useLive(api, share, Boolean(doc?.visible));
  const now = Math.max(useNow(live.status?.working || live.status?.waiting ? 15_000 : 60_000), live.at);
  const tall = useTall();
  const origin = useMemo<MessageOrigin | undefined>(() => doc ? { doc: doc.doc, title: docTitle } : undefined, [doc?.doc, docTitle]);

  // Signing in is a silent one-time code exchange: do it as soon as the card has something to show or set up.
  // A share card does not: its bridge calls sign in when the reader can, and go without a login otherwise.
  const wantLogin = Boolean(doc && !doc.docShare && (binding || doc.editable));
  useEffect(() => {
    if (!wantLogin || me.state !== 'idle' || me.error) return;
    setMe((m) => ({ ...m, state: 'connecting' }));
    api.login().then((login) => setMe({ state: 'ready', username: login.username, error: '' }))
      .catch((e) => setMe({ state: 'idle', username: null, error: message(e) }));
  }, [api, wantLogin, me.state, me.error]);
  const retryLogin = () => setMe({ state: 'idle', username: null, error: '' });

  const owner = Boolean(me.username && live.meta?.role === 'owner');
  const operator = owner && !asViewer;
  /** The session is on a read-only device: everyone reads, nobody sends, stops or forks. */
  const readOnly = Boolean(live.meta?.readOnly);
  /** A document assistant: its guest (who may hold no Octopus account) and the owner talk to it; nothing here forks, freezes or opens it further. */
  const assistant = live.meta?.assistant;
  /** Whoever may talk to this agent here: its owner, or a member the owner made a speaker; an assistant's guest, as the bridge says. */
  const talker = (assistant ? Boolean(live.meta?.canTalk) : Boolean(me.username && (live.meta?.canTalk ?? live.meta?.role === 'owner'))) && !asViewer && !readOnly;
  const isSnapshot = live.meta?.kind === 'snapshot';
  const syncError = live.requestError || live.frameError;

  // A reply is read once its owner has the conversation in front of them: the card open tall enough to show it, on screen.
  const unreadAt = operator && live.status?.unread ? live.status.lastReplyAt : undefined;
  const marked = useRef('');
  useEffect(() => {
    if (!share || !unreadAt || !tall || !doc?.visible || document.hidden || file || panel || marked.current === unreadAt) return;
    const timer = setTimeout(() => {
      marked.current = unreadAt;
      api.read(share, unreadAt).then(() => live.refresh(), () => { marked.current = ''; });
    }, 1500);
    return () => clearTimeout(timer);
  }, [api, share, unreadAt, tall, doc?.visible, file, panel, live.refresh]);

  async function act(label: string, run: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(''); setDone(''); setMenu(false);
    try { await run(); } catch (e) { setError(message(e)); } finally { setBusy(''); }
  }

  /** Share first, write the Record, then retire the card's old share — a failed write leaves nothing dangling. */
  async function place(source: { resourceId: string; title: string } | { from: string }) {
    const { binding: next } = await api.share({ ...source, ...(docTitle ? { docTitle } : {}) });
    await adopt(next, 'from' in source && source.from === binding?.share && copied);
  }
  /** Writes a freshly minted share into the Record; `keepOld` when the old share belongs to another document's copy. */
  async function adopt(next: ShareResult['binding'], keepOld = false) {
    try { await host.bind(next); }
    catch (e) { void api.unshare({ share: next.share }).catch(() => {}); throw e; }
    if (binding && binding.share !== next.share && !keepOld) void api.unshare({ share: binding.share }).catch(() => {});
    setPicking(false); setFile(null); setPanel(null);
  }
  const pick = (choice: SessionChoice, title: string) => place({ resourceId: choice.resourceId, title });
  const stopSharing = () => act('停止共享', async () => {
    if (!binding) return;
    await api.unshare({ share: binding.share });
    await host.bind(null).catch(() => {});
  });

  const shell = (body: React.ReactNode, footer?: React.ReactNode) => <main className={`card surface-${host.surface}${doc?.dark ? ' dark' : ''}`} data-theme={doc?.dark ? 'dark' : 'light'}>
    {preview && <div className="preview-flag">本地预览 · 模拟数据，不连接真实 Agent</div>}
    {body}
    {footer}
  </main>;

  if (hostError) return shell(<div className="center"><Logo size={40}/><p>卡片没有加载成功：{hostError}</p></div>);
  if (!doc) return shell(<div className="center"><span className="spinner"/></div>);
  // A document-share card controls links, not a session; a board card shows an agent's page. Neither offers the session picker.
  if (doc.docShare) return <SharePanel host={host} api={api} doc={doc} card={doc.docShare} preview={preview}/>;
  if (doc.board) return <BoardCard host={host} api={api} doc={doc} board={doc.board} preview={preview}/>;

  // ── empty card: put an Agent here ──
  if (!binding || picking) {
    const canPlace = doc.editable && me.username;
    return shell(<>
      <header className="bar">
        <Logo/>
        <div className="title"><h1>{picking === 'new' ? '新建 Agent' : 'Octopus Agent'}</h1><p>{picking === 'new' ? `在你的设备上启动，放进${docTitle ? `《${docTitle}》` : '这篇文档'}` : '把你的 Agent 放进文档，协作者实时观看'}</p></div>
      </header>
      {canPlace && picking === 'new'
        ? <NewAgent api={api} doc={doc.doc} docTitle={docTitle} readDocument={() => host.documentText()} onPlaced={(next) => adopt(next)} onCancel={() => setPicking(binding ? 'list' : false)}/>
        : canPlace
        ? <Picker api={api} current={undefined} onPick={pick} onNew={() => setPicking('new')} onCancel={binding ? () => setPicking(false) : undefined}/>
        : <div className="intro">
            <div className="roles">
              <div><b>所有者</b><span>查看自己的 Agent，在文档里直接给它布置任务</span></div>
              <div><b>协作者</b><span>实时只读观看 Agent 的进展，无需 Octopus 账号</span></div>
            </div>
            {!doc.editable && <Notice>只有能编辑这篇文档的人可以放入 Agent。</Notice>}
            {doc.editable && me.state === 'connecting' && <Notice>正在用飞书身份连接 Octopus…</Notice>}
            {doc.editable && me.state === 'ready' && !me.username && <Notice tone="warn">你的飞书账号还没有关联 Octopus 账号，暂时不能放入自己的 Agent。请联系管理员关联后再试。</Notice>}
            {me.error && <Notice tone="error" action={<button className="link" onClick={retryLogin}>重试</button>}>{me.error}</Notice>}
          </div>}
    </>);
  }

  // ── a bound card ──
  const title = live.meta?.title ?? binding.title;
  const ownerName = live.meta?.owner ?? binding.owner;
  const about = [assistant ? `文档助手 · 为 ${assistant.guest} 工作` : `${ownerName} 的 Agent`, live.meta?.device ?? binding.device, providerName(live.meta?.provider ?? binding.provider)].filter(Boolean).join(' · ');
  // The status bar: still readable when the card is folded down to this header.
  const lineage = live.meta?.origin?.kind === 'fork' ? `分叉自《${live.meta.origin.from}》· ${live.meta.origin.by}` : '';
  const detail = isSnapshot ? [`截至 ${clock(live.meta?.snapshotAt)}`] : [...statusDetail(live.status, now), ...(lineage ? [lineage] : [])];
  const canExpand = host.surface === 'inline';
  const roleChip = !live.meta ? null : readOnly ? <span className="chip" title="这台设备只读：可以查看，不能发消息或分叉">只读</span>
    : operator && !assistant ? <span className="chip chip-owner">可操作</span> : talker ? <span className="chip chip-owner">可对话</span> : <span className="chip">只读</span>;

  const header = <header className="bar">
    <Logo/>
    <div className="title"><h1 title={title}>{title}</h1><p className="status-line" title={[...detail, about].join(' · ')}>{detail.length ? <><span className="status-detail">{detail.join(' · ')}</span> · </> : null}{about}</p></div>
    <div className="bar-side">
      {!copied && !live.gone && (isSnapshot ? <span className="pill pill-snapshot" role="status" title="这张卡片固定在某一轮完成时，之后不再变化">快照</span> : <StatusPill status={live.status} error={syncError}/>)}
      {roleChip}
      {canExpand && <button className="icon-btn" title="放大查看" aria-label="放大查看" onClick={() => void act('', () => host.expand(title))}><Icon name="expand"/></button>}
      {canExpand && <button className="icon-btn" title="在侧边栏打开" aria-label="在侧边栏打开" onClick={() => void act('', () => host.float())}><Icon name="side"/></button>}
      {owner && !assistant && <div className="menu-wrap">
        <button className="icon-btn" aria-label="更多操作" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><Icon name="more"/></button>
        {menu && <div className="menu" role="menu">
          {doc.editable && <button role="menuitem" onClick={() => { setMenu(false); setPicking('list'); }}><Icon name="swap" size={14}/>更换会话</button>}
          {doc.editable && <button role="menuitem" onClick={() => { setMenu(false); setPicking('new'); }}><Icon name="plus" size={14}/>新建 Agent</button>}
          {!isSnapshot && <button role="menuitem" disabled={Boolean(busy)} onClick={() => void act('快照', async () => {
            const result = await api.snapshot(binding!.share, doc.doc);
            setDone(result.notice ?? '已在下方固定一份快照：它停在最近一轮完成时，之后不再变化');
          })}><Icon name="snapshot" size={14}/>在下方固定快照</button>}
          {!readOnly && <button role="menuitem" onClick={() => { setMenu(false); setFile(null); setPanel('speakers'); }}><Icon name="people" size={14}/>允许谁对话</button>}
          <button role="menuitem" onClick={() => { setMenu(false); setFile(null); setPanel('workspace'); }}><Icon name="share" size={14}/>共享工作区文件</button>
          <button role="menuitem" onClick={() => { setMenu(false); setAsViewer((v) => !v); }}><Icon name="eye" size={14}/>{asViewer ? '回到所有者视角' : '以协作者视角预览'}</button>
          <button role="menuitem" className="danger" onClick={() => void stopSharing()}><Icon name="close" size={14}/>移出文档并停止共享</button>
        </div>}
      </div>}
    </div>
  </header>;

  // Whether the caller owns the share is the bridge's decision; any signed-in account holder may ask.
  const mayReshare = Boolean(me.username && doc.editable);
  if (copied) {
    return shell(<>{header}<div className="center">
      <p className="lead">这张卡片是从另一篇文档复制来的。</p>
      <p>为避免 Agent 在你不知情时被更多人看到，复制的卡片需要 {binding.owner} 在这里重新确认共享。</p>
      {error && <Notice tone="error">{error}</Notice>}
      {mayReshare && <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void act('共享', () => place({ from: binding.share }))}>我是 {binding.owner}，在这篇文档中继续共享</button>}
      {me.state === 'connecting' && <span className="muted">正在确认你的身份…</span>}
    </div></>);
  }

  if (live.gone) {
    return shell(<>{header}<div className="center">
      <p className="lead">{live.gone.message}</p>
      {mayReshare && live.gone.status === 410 && <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void act('共享', () => place({ from: binding.share }))}>重新共享（仅限 {binding.owner}）</button>}
      {doc.editable && me.username && <button className="btn" onClick={() => setPicking('list')}>换一个会话</button>}
      {error && <Notice tone="error">{error}</Notice>}
    </div></>);
  }

  const banner = me.error
    ? <Notice tone="error" action={<button className="link" onClick={retryLogin}>重试</button>}>{me.error}</Notice>
    : syncError ? <Notice tone="warn">{syncError}</Notice> : error ? <Notice tone="error">{error}</Notice> : done ? <Notice>{done}</Notice> : busy === '快照' ? <Notice>正在固定快照…</Notice> : null;
  const empty = me.error ? '暂时无法连接 Octopus' : me.state !== 'ready' ? '正在连接…' : live.meta ? '这个会话还没有对话内容' : '正在读取对话…';

  const conversation = !file && !panel;
  return shell(<>
    {header}
    {asViewer && <div className="viewer-flag">正在以协作者视角预览 · <button className="link" onClick={() => setAsViewer(false)}>返回</button></div>}
    {conversation && banner}
    {panel === 'speakers' && owner
      ? <SpeakersPanel api={api} share={binding.share} onClose={() => setPanel(null)}/>
      : panel === 'workspace' && owner
      ? <WorkspacePanel api={api} share={binding.share} onClose={() => setPanel(null)}
          onAskAgent={async (task) => { await api.send(binding.share, task, crypto.randomUUID(), origin); live.refresh(); }}/>
      : file
      ? <FileViewer api={api} share={binding.share} path={file} owner={ownerName} isOwner={owner} canExpand={canExpand}
          onClose={() => setFile(null)} onExpand={(path) => void act('', () => host.expand(title, path))} onShareWorkspace={() => { setFile(null); setPanel('workspace'); }}/>
      : <Feed rows={live.rows} status={live.status} user={readOnly ? '用户' : assistant ? assistant.guest : ownerName} empty={empty} onLink={(url) => void host.open(url).catch(() => {})}
          onFile={assistant ? undefined : (path) => setFile(path)} older={{ ...live.older, load: live.loadOlder }} expand={(i) => api.message(binding.share, i).then((reply) => reply.text)}/>}
  </>, !conversation ? undefined : talker
    ? <Composer api={api} share={binding.share} status={live.status} origin={origin} snapshot={isSnapshot} speaker={!owner && !assistant} fork={!assistant} onSent={live.refresh}/>
    : <footer className="foot">{assistant
      ? <><Icon name="eye" size={13}/>文档助手 · 为 {assistant.guest} 工作 · 你可以实时观看，对话只限 {assistant.guest} 和 {ownerName}</>
      : live.meta && readOnly
      ? <><Icon name="eye" size={13}/>这个会话在只读设备 {live.meta.device} 上 · 可以{isSnapshot ? '查看这份快照' : '实时观看'}，不能发消息或分叉</>
      : live.meta
      ? <><Icon name="eye" size={13}/>{ownerName} 共享了这个 Agent · 你可以实时{isSnapshot ? '查看这份快照' : '观看'}，对话需要 {ownerName} 本人或 {ownerName} 授权的人</>
      : me.error ? <>{ownerName} 共享了这个 Agent · 连接后即可实时观看</> : <><span className="spinner small"/>正在连接 Octopus…</>}</footer>);
}

/** A moment as the card shows it: month-day hour:minute, local time. */
function clock(at?: string): string {
  const time = at ? new Date(at) : null;
  if (!time || Number.isNaN(time.getTime())) return '某一轮完成时';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
}
