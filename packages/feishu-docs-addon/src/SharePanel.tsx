import { useCallback, useEffect, useId, useReducer, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AssistantsTab, type AssistantApi } from './Assistants';
import type { AgentApi, DocShareConnect, DocShareInvite, DocShareLink, DocSharePanel, DocShareRecord, DocShareRights, DocShareSelfServe, DocsHost, HostSnapshot } from './protocol';
import {
  NO_SHARES, panelProblem, reduceShares, refusalText, shownAssistant, shownInvite, shownLinks, shownSelfServe, taskRefusal,
  type PanelProblem, type ShareOp, type ShareSecret, type ShareTaskState, type ShownLink, type TaskVerb,
} from './share-state';
import { dateTime, Icon, Logo, Notice, relativeTime, useNow } from './ui';

type ShareApi = Pick<AgentApi, 'sharePanel' | 'shareAction' | 'shareReveal' | 'shareSelf' | 'shareSettings' | 'shareInvite'> & AssistantApi;
type ShareHost = Pick<DocsHost, 'surface' | 'float' | 'fitHeight' | 'readerName' | 'documentTitle'>;
type Tab = 'assistant' | 'keys';
interface FrameProps { host: ShareHost; doc: Pick<HostSnapshot, 'doc' | 'dark'> & { visible?: boolean }; preview?: boolean }

const ABOUT = '在这里启动文档助手，或用访问密钥让你自己的 Agent 读写这篇文档';
/** The tab a viewer last chose, remembered in this browser: a preference, so storage that fails just forgets it. */
const TAB_KEY = 'octopus-docs:share-tab';
const rememberedTab = (): Tab | null => {
  try {
    const tab = localStorage.getItem(TAB_KEY);
    return tab === 'assistant' || tab === 'keys' ? tab : null;
  } catch { return null; }
};
const STATUS_TEXT: Record<DocShareLink['status'], string> = { pending: '待领取', active: '生效', paused: '已暂停', terminated: '已终止' };
const RIGHTS_TEXT: Record<DocShareRights, string> = { write: '读写', read: '只读' };
const SENDING_TEXT: Record<ShareOp, string> = { pause: '正在暂停…', resume: '正在恢复…', terminate: '正在终止…', delete: '正在删除…', reveal: '正在生成接入方式…' };
const INVITE_SENDING: Record<string, string> = { create: '正在生成…', reset: '正在重置…', revoke: '正在停用…' };
const ONCE = '只显示这一次，关闭或刷新后无法再看到；它等同密码，只发给要用它的人。';
const LEVELS: Array<{ value: DocShareSelfServe; text: string; hint: string }> = [
  { value: 'off', text: '关闭', hint: '只有你能创建密钥；读者只能查看和删除。' },
  { value: 'read', text: '只读', hint: '能看到这张卡片的人可以自己领取只读密钥。' },
  { value: 'write', text: '读写', hint: '能看到这张卡片的人可以自己领取只读或读写密钥。' },
];
/** A key's name, as the bridge bounds it. */
const LABEL_MAX = 60;
/** The inline card's height, as it asks the host: past the cap its body scrolls. */
const FIT_MIN = 120;
const FIT_MAX = 720;
/** While the card is on screen, keys others take or delete show up within this. */
const POLL_MS = 30_000;
const PROBLEMS: Record<PanelProblem['kind'], { lead: string; text: string; detail: boolean; retry: boolean }> = {
  signin: { lead: '需要登录飞书', text: '用飞书账号登录后，才能查看这张卡片的访问密钥。', detail: true, retry: true },
  tenant: { lead: '仅限本组织成员查看', text: '你的飞书账号不在接入 Octopus 的组织里。', detail: true, retry: false },
  unknown: { lead: 'Octopus 不认识这张卡片', text: '它没有在 Octopus 登记，或登记已被清除，因此不控制任何访问密钥。', detail: false, retry: false },
  network: { lead: '暂时连不上 Octopus', text: '请检查网络后重试。', detail: false, retry: true },
  failed: { lead: '没有读到访问密钥', text: '', detail: true, retry: true },
};

/**
 * A document-share card, 「Octopus 文档协作」: the access keys that let
 * external agents read, or also write, this document through Octopus over
 * MCP. Anyone who can read the card may take a key for themselves (within the
 * owner's self-serve level) and end any key; the owner also pauses and
 * resumes keys, sets that level, and keeps a claim link for people who cannot
 * see the card. Its Record holds only the anchor: what the keys are and who
 * may do what is the bridge's answer.
 */
export function SharePanel({ api, card, ...frame }: FrameProps & { api: ShareApi; card: DocShareRecord }) {
  if ('invalid' in card) {
    return <Frame {...frame} fit>
      <Center lead={card.invalid === 'version' ? '这张卡片需要更新版本的组件' : '无法读取这张卡片'}>
        {card.invalid === 'version' ? '它由更新版本的 Octopus 组件写入。刷新文档页面后再试。' : '卡片数据不完整或格式不对，无法显示它的访问密钥。'}
      </Center>
    </Frame>;
  }
  // Another anchor is another card: nothing shown for the previous one carries over.
  return <ShareKeys key={card.anchor} api={api} anchor={card.anchor} {...frame}/>;
}

function ShareKeys({ api, anchor, ...frame }: FrameProps & { api: ShareApi; anchor: string }) {
  const { host, doc } = frame;
  const [state, dispatch] = useReducer(reduceShares, NO_SHARES);
  const [problem, setProblem] = useState<PanelProblem | null>(null);
  const [loading, setLoading] = useState(false);
  /** The key whose ending waits for its confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [taking, setTaking] = useState(false);
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState('');
  const [readerName, setReaderName] = useState('');
  const [docTitle, setDocTitle] = useState('');
  /** The viewer's tab: the one they last chose, else (once the first answer comes) 文档助手 when assistants are on. */
  const [tab, setTab] = useState<Tab | null>(rememberedTab);
  /** An assistant's conversation is open: it takes the whole body. */
  const [chatting, setChatting] = useState(false);
  const issued = useRef(0);
  const alive = useRef(true);
  /** Operations on their way, by key id or task: a second click before the first re-render starts nothing. */
  const running = useRef(new Set<string>());
  const takeButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const refocus = useRef(false);
  const now = useNow(60_000);
  const visible = doc.visible ?? true;
  const hostToken = doc.doc;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The reader's Feishu name prefills a key's name; a host that will not say leaves it to them.
  useEffect(() => {
    let live = true;
    host.readerName().then((name) => { if (live) setReaderName(name.slice(0, LABEL_MAX)); }, () => {});
    // The document's title rides along with what is said to an assistant, as with any card.
    host.documentTitle().then((title) => { if (live) setDocTitle(title); }, () => {});
    return () => { live = false; };
  }, [host]);

  /** Reads are numbered when issued; the reducer drops one that a newer read overtook. `quiet`: no spinner (a poll, or the read after an action). */
  const load = useCallback(async (quiet = false) => {
    const seq = ++issued.current;
    if (!quiet) setLoading(true);
    try {
      // The bridge, not the card, decides whether the host's token (a docx or a wiki token) names the controlled document.
      const panel = await api.sharePanel(anchor, hostToken);
      if (!alive.current) return;
      dispatch({ type: 'panel', seq, panel });
      if (seq === issued.current) setProblem(null);
    } catch (e) {
      if (alive.current && seq === issued.current) setProblem(panelProblem(e));
    } finally {
      if (alive.current && seq === issued.current) setLoading(false);
    }
  }, [api, anchor, hostToken]);
  useEffect(() => { void load(); }, [load]);

  const panel = state.panel;
  const gone = problem?.kind === 'unknown';
  const copied = panel?.host_matches === false;
  // The default tab is settled by the first answer and never jumps after it.
  useEffect(() => {
    if (tab === null && panel) setTab(panel.assistant.rights !== null ? 'assistant' : 'keys');
  }, [tab, panel]);
  const choose = (next: Tab) => {
    setTab(next);
    try { localStorage.setItem(TAB_KEY, next); } catch { /* remembered for this page only */ }
  };
  // On screen, the list follows what others do; a card that controls nothing here has nothing to follow.
  useEffect(() => {
    if (!visible || gone || copied) return;
    const timer = setInterval(() => { if (!document.hidden) void load(true); }, POLL_MS);
    return () => clearInterval(timer);
  }, [visible, gone, copied, load]);
  // A closed form hands the focus back to the button that opened it.
  useEffect(() => {
    if (!taking && refocus.current) { refocus.current = false; takeButton.current?.focus(); }
  }, [taking]);

  /** Runs one operation at a time per key or task; whatever its answer, the read after it shows what the bridge holds now. */
  async function once(key: string, run: () => Promise<void>) {
    if (running.current.has(key)) return;
    running.current.add(key);
    try { await run(); } finally { running.current.delete(key); }
    if (alive.current) void load(true);
  }

  const act = (share: DocShareLink, op: ShareOp) => once(share.id, async () => {
    const rid = crypto.randomUUID();
    setConfirming(null);
    dispatch({ type: 'start', id: share.id, rid, action: op });
    try {
      // A reveal's answer holds the key's ways in: they go into this card's memory and nowhere else.
      // An action names the host's document too: a reader's terminate counts only on the card in the document it controls.
      const reply: { share: DocShareLink; connect?: DocShareConnect } = op === 'reveal' ? await api.shareReveal(anchor, share.id)
        : await api.shareAction(anchor, share.id, op === 'delete' ? 'terminate' : op, hostToken);
      if (alive.current) dispatch({ type: 'confirmed', id: share.id, rid, share: reply.share, after: issued.current, ...(reply.connect ? { connect: reply.connect } : {}) });
    } catch (e) {
      if (alive.current) dispatch({ type: 'refused', id: share.id, rid, reason: refusalText(op, e) });
    }
  });

  const take = (label: string, rights: DocShareRights) => once('take', async () => {
    const rid = crypto.randomUUID();
    dispatch({ type: 'begin', task: 'take', rid, value: rights });
    try {
      // The answer holds the new key's ways in: into this card's memory and nowhere else.
      const reply = await api.shareSelf(anchor, hostToken, label, rights);
      if (!alive.current) return;
      dispatch({ type: 'taken', rid, share: reply.share, connect: reply.connect, after: issued.current });
      setTaking(false);
    } catch (e) {
      if (alive.current) dispatch({ type: 'fail', task: 'take', rid, reason: taskRefusal('take', e, panel?.limits) });
    }
  });

  const setLevel = (level: DocShareSelfServe) => level !== shownSelfServe(state) && once('settings', async () => {
    const rid = crypto.randomUUID();
    dispatch({ type: 'begin', task: 'settings', rid, value: level });
    try {
      const next = await api.shareSettings(anchor, level, hostToken);
      // The answer is the panel as it is now: newer than any read issued before it arrived.
      if (alive.current) dispatch({ type: 'settled', rid, seq: ++issued.current, panel: next });
    } catch (e) {
      if (alive.current) dispatch({ type: 'fail', task: 'settings', rid, reason: taskRefusal('settings', e) });
    }
  });

  const changeInvite = (op: 'create' | 'revoke') => once('invite', async () => {
    const verb: TaskVerb = op === 'revoke' ? 'revoke' : shownInvite(state)?.active ? 'reset' : 'create';
    const rid = crypto.randomUUID();
    dispatch({ type: 'begin', task: 'invite', rid, value: verb });
    try {
      // A new link is in this answer alone: into this card's memory and nowhere else.
      const reply = await api.shareInvite(anchor, op);
      if (alive.current) dispatch({ type: 'invited', rid, invite: reply.invite, ...(reply.link ? { link: reply.link } : {}), after: issued.current });
    } catch (e) {
      if (alive.current) dispatch({ type: 'fail', task: 'invite', rid, reason: taskRefusal(verb, e) });
    }
  });

  const openForm = () => { dispatch({ type: 'clear', task: 'take' }); setTaking(true); };
  const closeForm = () => { refocus.current = true; setTaking(false); dispatch({ type: 'clear', task: 'take' }); };
  const forget = (id: string) => { dispatch({ type: 'dismiss', id }); (takeButton.current ?? heading.current)?.focus(); };
  const openSide = () => {
    setNotice('');
    host.float().catch((e: unknown) => { if (alive.current) setNotice(`没有打开侧边栏：${e instanceof Error && e.message ? e.message.slice(0, 200) : '请重试'}`); });
  };

  const owner = Boolean(panel?.viewer_is_owner) && !copied;
  const side = <>
    {owner && <span className="chip chip-owner">所有者</span>}
    {host.surface === 'inline' && !copied && !gone && <button className="btn btn-small btn-ghost side-open" title="在侧边栏打开：文档滚动时它一直在旁边" aria-label="在侧边栏打开" onClick={openSide}>
      <Icon name="side" size={15}/><span>侧边栏</span>
    </button>}
    {!copied && !gone && <button className={`icon-btn${loading ? ' is-loading' : ''}`} title="刷新" aria-label="刷新" disabled={loading} onClick={() => void load()}><Icon name="refresh"/></button>}
  </>;

  if (problem && (!panel || gone)) {
    const words = PROBLEMS[problem.kind];
    return <Frame {...frame} side={side} fit>
      <Center lead={words.lead} detail={words.detail ? problem.detail : ''} action={words.retry && <button className="btn" onClick={() => void load()}>重试</button>}>{words.text}</Center>
    </Frame>;
  }
  // Until the first answer the card keeps the height the host gave it: one resize, to the real content, not two.
  if (!panel) return <Frame {...frame} side={side}><Center spinner>正在连接 Octopus…</Center></Frame>;
  // A card copied from another document lists nothing of that document's keys, and changes none.
  if (copied) {
    return <Frame {...frame} side={side} fit>
      <Center lead="此卡片不属于本文档">它从另一篇文档复制而来，这里不显示也不能更改那篇文档的密钥。</Center>
    </Frame>;
  }

  const links = shownLinks(state);
  // An ended key folds away, unless it carries a refusal still to be read (it ended elsewhere while the reader acted on it).
  const folded = (l: ShownLink) => l.share.status === 'terminated' && !l.refusal;
  const live = links.filter((l) => !folded(l));
  const ended = links.filter(folded);
  const level = shownSelfServe(state) ?? 'off';
  // Every key acts as the Octopus app: a write key writes only once the app may edit the document.
  const usable = live.filter(({ share }) => share.status !== 'terminated');
  const writable = level === 'write' || usable.some(({ share }) => share.rights === 'write' && (share.status === 'active' || share.status === 'paused'));
  const needsApp = panel.app_access === 'view' ? writable : panel.app_access === 'none' && (level !== 'off' || usable.length > 0);
  const secrets = Object.entries(state.secrets).reverse();
  const cap: DocShareRights = level === 'write' ? 'write' : 'read';
  const intro = owner
    ? level === 'off' ? '自助领取已关闭：只有你能创建密钥。可以在下方「设置」里开启。' : `能看到这张卡片的人都可以领取${level === 'write' ? '读写或只读' : '只读'}密钥，交给自己的 Agent。`
    : level === 'off' ? '卡片所有者关闭了自助领取，只有所有者可以创建密钥；不再需要的密钥你仍可以删除。'
    : `领取一个你自己的${level === 'read' ? '只读' : ''}密钥交给你的 Agent；不再需要的密钥可以删除。`;
  const empty = level !== 'off' ? `点「领取访问密钥」，把它添加到 Claude Code 或 Codex，你的 Agent 就能通过 Octopus ${level === 'write' ? '读写' : '读取'}这篇文档。`
    : owner ? '开启自助领取后，能看到卡片的人可以自己领取；你的 Agent 创建的密钥也会列在这里。' : '卡片所有者创建的密钥会列在这里。';

  const assistant = shownAssistant(state) ?? panel.assistant;
  const shown: Tab = tab ?? (assistant.rights !== null ? 'assistant' : 'keys');
  const chat = shown === 'assistant' && chatting;
  const footer = shown === 'keys'
    ? <footer className="foot share-foot">删除这张卡片会停止全部密钥，最迟 1 天；暂停、删除立即生效</footer>
    : assistant.rights !== null && !chat ? <footer className="foot share-foot">每人只看到自己的助手，卡片所有者能看到全部；助手在所有者的设备上运行</footer> : undefined;

  return <Frame {...frame} side={side} fit={chat ? 'max' : true} fill={chat} footer={footer}
    tabs={<Tabs value={shown} onChange={choose} assistantOn={assistant.rights !== null} keys={usable.length}/>}>
    {problem && <Notice tone="warn" action={<button className="link" onClick={() => void load()}>重试</button>}>
      刷新没有完成：{PROBLEMS[problem.kind].lead}{PROBLEMS[problem.kind].detail && problem.detail ? `（${problem.detail}）` : ''}
    </Notice>}
    {notice && <Notice tone="error" action={<button className="link" onClick={() => setNotice('')}>知道了</button>}>{notice}</Notice>}
    {panel.card_state === 'missing' && <Notice tone="warn" action={<button className="link" disabled={loading} onClick={() => void load()}>刷新</button>}>
      上次检查时文档里没有这张卡片，所有密钥已停止。卡片恢复后，打开本卡片或下次有人使用密钥时会重新检查。
    </Notice>}
    <div className="tab-panel assist-panel" role="tabpanel" id="share-panel-assistant" aria-labelledby="share-tab-assistant" hidden={shown !== 'assistant'}>
      <AssistantsTab api={api} anchor={anchor} hostToken={hostToken} settings={assistant} owner={owner} visible={visible && shown === 'assistant'} readerName={readerName}
        origin={{ doc: hostToken, title: docTitle }} app={panel} checking={loading} now={now} onKeys={() => choose('keys')} onRecheck={() => void load()} onChat={setChatting}
        onConfigured={(settings) => dispatch({ type: 'assistant', settings, after: issued.current })}/>
    </div>
    <div className="tab-panel" role="tabpanel" id="share-panel-keys" aria-labelledby="share-tab-keys" hidden={shown !== 'keys'}>
      {needsApp && <AppAccess panel={panel} writable={writable} checking={loading} onCheck={() => void load()}/>}
      {secrets.map(([id, secret]) => <SecretBox key={id} secret={secret} onClose={() => forget(id)}/>)}
      <section className={`keys-section${owner ? ' is-owner' : ''}`} aria-labelledby="share-keys-title">
        <div className="keys-top">
          <div className="keys-title"><h2 id="share-keys-title" ref={heading} tabIndex={-1}>访问密钥</h2><p>{intro}</p></div>
          {level !== 'off' && !taking && <button ref={takeButton} className="btn btn-primary" onClick={openForm}><Icon name="key" size={14}/>领取访问密钥</button>}
        </div>
        {taking && level !== 'off' && <TakeForm cap={cap} name={readerName} task={state.tasks.take} onSubmit={take} onCancel={closeForm}/>}
        {live.length
          ? <div className="keys">
              <div className="keys-head" aria-hidden="true"><span>名称</span><span>权限</span><span>状态</span><span>最近使用</span><span>操作</span></div>
              <ul className="keys-list" aria-label="访问密钥">
                {live.map((link) => <KeyRow key={link.share.id} link={link} owner={owner} now={now} confirming={confirming === link.share.id}
                  onAct={(op) => void act(link.share, op)} onConfirm={(on) => setConfirming(on ? link.share.id : null)}/>)}
              </ul>
            </div>
          : <div className="keys-empty"><p className="lead">{ended.length ? '现在没有可用的密钥' : '还没有访问密钥'}</p><p>{empty}</p></div>}
        {ended.length > 0 && <details className="keys-ended">
          <summary><Icon name="chevron" size={13}/>已停用的密钥（{ended.length}）</summary>
          <ul className="keys-list" aria-label="已停用的密钥">
            {ended.map((link) => <KeyRow key={link.share.id} link={link} owner={owner} now={now}/>)}
          </ul>
        </details>}
      </section>
      {owner && <OwnerSettings open={settings} onToggle={() => setSettings((on) => !on)} level={level} limits={panel.limits} now={now}
        levelTask={state.tasks.settings} onLevel={(next) => void setLevel(next)}
        invite={shownInvite(state)} inviteTask={state.tasks.invite} onInvite={(op) => void changeInvite(op)}
        claim={state.claim?.link ?? null} onUnclaim={() => dispatch({ type: 'unclaim' })}/>}
      {/* The bridge names the document to the card's owner alone; anyone else gets an empty id, and no line. */}
      {panel.host_matches === null && panel.document_id && <p className="share-doc">这些密钥作用于文档 {panel.document_id}</p>}
    </div>
  </Frame>;
}

/** The panel's two tabs; arrow keys move between them, as in any tab list. */
function Tabs({ value, onChange, assistantOn, keys }: { value: Tab; onChange(tab: Tab): void; assistantOn: boolean; keys: number }) {
  const tabs: Array<{ id: Tab; text: string; icon: string; hint: string }> = [
    { id: 'assistant', text: '文档助手', icon: 'chat', hint: assistantOn ? '' : '未开启' },
    { id: 'keys', text: '访问密钥', icon: 'key', hint: keys ? String(keys) : '' },
  ];
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = tabs[(tabs.findIndex((t) => t.id === value) + 1) % tabs.length].id;
    onChange(next);
    document.getElementById(`share-tab-${next}`)?.focus();
  };
  return <div className="share-tabs" role="tablist" aria-label="文档协作" onKeyDown={onKey}>
    {tabs.map((t) => <button key={t.id} id={`share-tab-${t.id}`} type="button" role="tab" aria-selected={value === t.id} aria-controls={`share-panel-${t.id}`}
      tabIndex={value === t.id ? 0 : -1} className={`share-tab${value === t.id ? ' is-on' : ''}`} onClick={() => onChange(t.id)}>
      <Icon name={t.icon} size={14}/>{t.text}{t.hint && <span className="share-tab-hint">{t.hint}</span>}
    </button>)}
  </div>;
}

/** Why write keys cannot write, or no key can read: the Feishu app every key acts as lacks access, and how to give it. */
function AppAccess({ panel, writable, checking, onCheck }: { panel: DocSharePanel; writable: boolean; checking: boolean; onCheck(): void }) {
  const app = panel.app_name || 'Octopus 应用';
  const view = panel.app_access === 'view';
  return <Notice tone="warn" action={<button className="link" disabled={checking} onClick={onCheck}>重新检查</button>}>
    <b className="notice-lead">{view ? '读写密钥现在只能读' : '密钥现在还读不到这篇文档'}</b>
    {`每个密钥都以飞书应用「${app}」的身份访问文档，${view ? '它现在只能查看' : '它还没有被添加到这篇文档'}。`
      + `请文档所有者在「…」→「添加文档应用」中添加「${app}」，并给它「${writable ? '可编辑' : '可阅读'}」权限。`}
  </Notice>;
}

/** Taking a key: a name readers will recognise it by, and rights up to what the owner allows. Enter takes it, Esc cancels. */
function TakeForm({ cap, name, task, onSubmit, onCancel }: {
  cap: DocShareRights; name: string; task?: ShareTaskState;
  onSubmit(label: string, rights: DocShareRights): void;
  onCancel(): void;
}) {
  const [label, setLabel] = useState(name);
  const [edited, setEdited] = useState(false);
  const [chosen, setChosen] = useState<DocShareRights>(cap);
  const [missing, setMissing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const sending = task?.phase === 'sending';
  // The owner may have lowered the level since: never ask for more than it allows.
  const rights: DocShareRights = cap === 'read' ? 'read' : chosen;
  // The host may say the reader's name a moment late: it fills the field only while they have not typed.
  useEffect(() => { if (!edited) setLabel(name); }, [name, edited]);
  useEffect(() => {
    const field = input.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = label.trim();
    if (!text) { setMissing(true); input.current?.focus(); return; }
    if (!sending) onSubmit(text, rights);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !sending) { event.preventDefault(); onCancel(); }
  };
  return <form className="take" aria-label="领取访问密钥" onSubmit={submit} onKeyDown={onKey} noValidate>
    <div className="take-name">
      <label className="field" htmlFor={`${id}-name`}>名字<span>显示在密钥列表里，方便以后认出和删除</span></label>
      <input id={`${id}-name`} ref={input} className="input" value={label} maxLength={LABEL_MAX} disabled={sending} autoComplete="off" required
        placeholder="例如：张三的 Claude Code" aria-invalid={missing || undefined} aria-describedby={missing ? `${id}-missing` : undefined}
        onChange={(e) => { setLabel(e.target.value); setEdited(true); setMissing(false); }}/>
      {missing && <p className="field-hint warn" id={`${id}-missing`}>请填写名字</p>}
    </div>
    <div className="take-rights">
      <span className="field" id={`${id}-rights`}>权限</span>
      {cap === 'write'
        ? <div className="segmented" role="radiogroup" aria-labelledby={`${id}-rights`}>
            {(['write', 'read'] as const).map((r) => <button key={r} type="button" role="radio" aria-checked={rights === r} className={rights === r ? 'is-on' : ''}
              disabled={sending} onClick={() => setChosen(r)}>{RIGHTS_TEXT[r]}</button>)}
          </div>
        : <p className="take-fixed"><span className="rights rights-read">只读</span></p>}
      <p className="field-hint">{rights === 'write' ? '可以读取和修改这篇文档' : cap === 'read' ? '卡片所有者只允许领取只读密钥' : '只能读取，不能修改'}</p>
    </div>
    {task?.phase === 'refused' && <p className="take-error" role="alert">{task.reason}</p>}
    <div className="row-actions take-actions">
      <button type="button" className="btn" disabled={sending} onClick={onCancel}>取消</button>
      <button type="submit" className="btn btn-primary" disabled={sending}>{sending ? <><span className="spinner small"/>正在领取…</> : '领取'}</button>
    </div>
  </form>;
}

/**
 * One key: a table row on wide cards, stacked on narrow ones. The owner
 * pauses, resumes or terminates; anyone else may delete. A pending key (the
 * owner's, made through an agent) is revealed or ended, never paused.
 */
function KeyRow({ link: { share, sending, refusal }, owner, now, confirming = false, onAct = () => {}, onConfirm = () => {} }: {
  link: ShownLink; owner: boolean; now: number; confirming?: boolean;
  onAct?(op: ShareOp): void;
  onConfirm?(on: boolean): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const end = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);
  const back = () => { onConfirm(false); end.current?.focus(); };
  const label = share.label || '未命名密钥';
  const open = share.status !== 'terminated';
  const main: { op: ShareOp; text: string } | null = !owner ? null : share.status === 'pending' ? { op: 'reveal', text: '显示接入命令' }
    : share.status === 'active' ? { op: 'pause', text: '暂停' } : { op: 'resume', text: '恢复' };
  const made = share.via === 'card' ? '自助领取于' : share.via === 'invite' ? '经领取链接领取于' : '创建于';
  return <li className={`key key-${share.status}`} aria-label={label}>
    <div className="key-name">
      <span className="key-line"><span className="key-label" title={label}>{label}</span>{share.mine && <span className="tag key-mine">我的</span>}</span>
      <span className="key-sub">{made} {dateTime(share.created_at, now)}</span>
    </div>
    <span className="key-rights"><span className={`rights rights-${share.rights}`}>{RIGHTS_TEXT[share.rights]}</span></span>
    <span className="key-status"><span className={`badge badge-${share.status}`}>{STATUS_TEXT[share.status]}</span></span>
    <span className="key-used">{share.last_used_at === null ? '从未使用' : <><span className="key-used-label">最近使用 </span>{relativeTime(share.last_used_at, now)}</>}</span>
    <div className="key-ops">
      {open && (sending
        ? <span className="share-sending" role="status"><span className="spinner small"/>{SENDING_TEXT[sending]}</span>
        : <>
            {main && <button className={`btn btn-small${main.op === 'reveal' ? ' btn-primary' : ''}`} onClick={() => onAct(main.op)}>{main.text}</button>}
            <button ref={end} className="btn btn-small btn-danger" aria-expanded={confirming} onClick={() => onConfirm(!confirming)}>{owner ? '终止' : '删除'}</button>
          </>)}
    </div>
    {open && confirming && !sending && <div className="key-confirm" role="group" aria-label={owner ? '确认终止' : '确认删除'}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); back(); } }}>
      <span>{owner ? '终止后这个密钥永久失效，不能恢复。' : '删除后，用这个密钥的 Agent 立即失去访问权限，不能恢复。'}</span>
      <span className="key-confirm-actions">
        <button ref={cancel} className="btn btn-small" onClick={back}>取消</button>
        <button className="btn btn-small btn-danger-solid" onClick={() => onAct(owner ? 'terminate' : 'delete')}>{owner ? '确认终止' : '确认删除'}</button>
      </span>
    </div>}
    {refusal && <p className="key-refusal" role="alert">{refusal}</p>}
  </li>;
}

/** The owner's settings, folded away until asked for: how much readers may take, and the claim link. */
function OwnerSettings({ open, onToggle, level, limits, now, levelTask, onLevel, invite, inviteTask, onInvite, claim, onUnclaim }: {
  open: boolean; onToggle(): void;
  level: DocShareSelfServe; limits: DocSharePanel['limits']; now: number;
  levelTask?: ShareTaskState; onLevel(level: DocShareSelfServe): void;
  invite: DocShareInvite | null; inviteTask?: ShareTaskState; onInvite(op: 'create' | 'revoke'): void;
  /** A link just made, shown this once. */
  claim: string | null; onUnclaim(): void;
}) {
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const saving = levelTask?.phase === 'sending';
  const inviting = inviteTask?.phase === 'sending' ? inviteTask.value : '';
  return <section className="settings" aria-label="所有者设置">
    <button ref={toggle} className="settings-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle}>
      <Icon name="chevron" size={14}/>设置<span>自助领取 · 领取链接</span>
    </button>
    {open && <div className="settings-body" id={`${id}-body`}>
      <div className="setting">
        <div className="setting-head">
          <span className="field" id={`${id}-level`}>自助领取</span>
          {saving && <span className="share-sending" role="status"><span className="spinner small"/>正在保存…</span>}
        </div>
        <div className="segmented" role="radiogroup" aria-labelledby={`${id}-level`}>
          {LEVELS.map((l) => <button key={l.value} type="button" role="radio" aria-checked={level === l.value} className={level === l.value ? 'is-on' : ''}
            disabled={saving} onClick={() => onLevel(l.value)}>{l.text}</button>)}
        </div>
        <p className="field-hint">{LEVELS.find((l) => l.value === level)?.hint} 每小时最多领取 {limits.per_hour} 个，同时最多 {limits.active_max} 个未终止的密钥。</p>
        {levelTask?.phase === 'refused' && <p className="key-refusal" role="alert">{levelTask.reason}</p>}
      </div>
      <div className="setting">
        <div className="setting-head"><span className="field">领取链接</span></div>
        <p className="field-hint">发给看不到这张卡片的人（例如组织外的人）：打开链接、填上名字就能领取，同样受自助领取的限制。{level === 'off' ? '自助领取关闭时，链接领不到密钥。' : ''}</p>
        {claim && <OnceBox label="新的领取链接" title="领取链接已生成" warning="只显示这一次，关闭或刷新后无法再看到。拿到链接的人都能领取密钥，只发给需要的人。"
          onClose={() => { onUnclaim(); toggle.current?.focus(); }}>
          <CopyField label="领取链接" value={claim} rows={2}/>
        </OnceBox>}
        <div className="invite-row">
          {invite?.active
            ? <>
                <span className="invite-state"><Icon name="link" size={13}/>{invite.created_at === null ? '已生成' : `已生成于 ${dateTime(invite.created_at, now)}`}</span>
                <button className="btn btn-small" disabled={Boolean(inviting)} title="生成新链接，旧链接立即失效" onClick={() => onInvite('create')}>重置链接</button>
                <button className="btn btn-small btn-danger" disabled={Boolean(inviting)} onClick={() => onInvite('revoke')}>停用</button>
              </>
            : <button className="btn btn-small" disabled={Boolean(inviting)} onClick={() => onInvite('create')}><Icon name="link" size={13}/>生成链接</button>}
          {inviting && <span className="share-sending" role="status"><span className="spinner small"/>{INVITE_SENDING[inviting]}</span>}
        </div>
        {inviteTask?.phase === 'refused' && <p className="key-refusal" role="alert">{inviteTask.reason}</p>}
      </div>
    </div>}
  </section>;
}

/** Something shown this once: it takes the focus as it appears, and stays until its reader closes it. */
function OnceBox({ label, title, warning, onClose, children }: { label: string; title: string; warning: string; onClose(): void; children: ReactNode }) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  return <section ref={box} className="once" tabIndex={-1} aria-label={label}>
    <p className="once-title"><Icon name="check" size={15}/>{title}</p>
    <p className="once-warn"><Icon name="alert" size={14}/>{warning}</p>
    {children}
    <div className="once-foot"><button className="btn btn-small" onClick={onClose}>我已保存，关闭</button></div>
  </section>;
}

const CLIENTS = [{ id: 'claude', text: 'Claude Code' }, { id: 'codex', text: 'Codex' }, { id: 'other', text: '其他客户端' }] as const;
type Client = typeof CLIENTS[number]['id'];

/** A key's ways in, one tab per client, shown this once. */
function SecretBox({ secret: { share, connect, via }, onClose }: { secret: ShareSecret; onClose(): void }) {
  const [client, setClient] = useState<Client>('claude');
  const id = useId();
  const label = share.label || '未命名密钥';
  const does = share.rights === 'write' ? '读写' : '读取';
  // Arrow keys move between the tabs, as in any tab list.
  const onKey = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = CLIENTS[(CLIENTS.findIndex((c) => c.id === client) + step + CLIENTS.length) % CLIENTS.length].id;
    setClient(next);
    document.getElementById(`${id}-${next}`)?.focus();
  };
  return <OnceBox label={`「${label}」的接入方式`} title={`${via === 'take' ? '已领取' : '已启用'}「${label}」· ${RIGHTS_TEXT[share.rights]}`} warning={ONCE} onClose={onClose}>
    <div className="segmented small once-tabs" role="tablist" aria-label="接入方式" onKeyDown={onKey}>
      {CLIENTS.map((c) => <button key={c.id} id={`${id}-${c.id}`} type="button" role="tab" aria-selected={client === c.id} aria-controls={`${id}-panel`}
        tabIndex={client === c.id ? 0 : -1} className={client === c.id ? 'is-on' : ''} onClick={() => setClient(c.id)}>{c.text}</button>)}
    </div>
    <div className="once-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${client}`}>
      {client === 'claude' ? <CopyField key="claude" label="Claude Code 接入命令" value={connect.claude} hint={`在终端运行这一行，Claude Code 就能${does}这篇文档。`}/>
        : client === 'codex' ? <CopyField key="codex" label="Codex 接入命令" value={connect.codex} hint={`在终端运行这一行，它写入 ~/.codex/config.toml；重新打开 Codex 后就能${does}这篇文档。`}/>
        : <>
            <CopyField key="endpoint" label="MCP 地址" value={connect.endpoint} rows={1}/>
            <CopyField key="header" label="请求头" value={`Authorization: Bearer ${connect.token}`} rows={2}
              hint="填进支持远程 MCP（Streamable HTTP）的客户端：上面的地址，加上这个请求头。"/>
          </>}
    </div>
  </OnceBox>;
}

/**
 * A secret to copy, in a selectable monospace box. It lives in the card's
 * memory alone (never stored, logged or sent anywhere): copying it is the
 * reader's act. The host's frame may block the clipboard, so a failed copy
 * selects the text for the reader to copy by hand.
 */
function CopyField({ label, value, rows = 3, hint }: { label: string; value: string; rows?: number; hint?: string }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<'' | 'done' | 'manual'>('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied('done');
    } catch {
      box.current?.focus();
      box.current?.select();
      let done = false;
      try { done = document.execCommand('copy'); } catch { /* left to the reader */ }
      setCopied(done ? 'done' : 'manual');
    }
  }
  return <div className="copy-field">
    <div className="copy-head">
      <span className="copy-label">{label}</span>
      {copied && <span className="copy-state" role="status">{copied === 'done' ? '已复制' : '已选中，请按 ⌘/Ctrl + C 复制'}</span>}
      <button type="button" className="btn btn-small" aria-label={`复制${label}`} onClick={() => void copy()}><Icon name="copy" size={13}/>复制</button>
    </div>
    <textarea ref={box} className="copy-box" aria-label={label} readOnly rows={rows} value={value}
      spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" onFocus={(e) => e.currentTarget.select()}/>
    {hint && <p className="field-hint">{hint}</p>}
  </div>;
}

/**
 * The inline card tells the host its content's own height, within bounds
 * (`'max'`: a conversation, which wants the room). Only Feishu's mobile
 * clients resize a block on this hint; on desktop the block keeps its height
 * and the card fills it, its body scrolling. Measured after layout and settled
 * for a moment; sent only when it moves.
 */
function useFitHeight(host: ShareHost, mode: boolean | 'max', frame: RefObject<HTMLElement | null>, body: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const outer = frame.current, scroller = body.current, inner = content.current;
    if (!mode || !outer || !scroller || !inner || typeof ResizeObserver === 'undefined') return;
    const height = (node: Element) => node.getBoundingClientRect().height;
    let sent = Math.round(height(outer));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Everything around the body, plus what the body's content takes.
        const want = mode === 'max' ? FIT_MAX : Math.round(Math.min(FIT_MAX, Math.max(FIT_MIN, height(outer) - height(scroller) + height(inner))));
        if (Math.abs(want - sent) < 4) return;
        sent = want;
        void host.fitHeight(want).catch(() => {});
      }, 80);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [host, mode, frame, body, content]);
}

/**
 * Every surface fills its frame: header, tabs and footer fixed, the body
 * between them scrolling (or, `fill`, given whole to a conversation).
 */
function Frame({ host, doc, preview, side, tabs, footer, fit = false, fill = false, children }: FrameProps & {
  side?: ReactNode; tabs?: ReactNode; footer?: ReactNode; fit?: boolean | 'max'; fill?: boolean; children: ReactNode;
}) {
  const main = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useFitHeight(host, host.surface === 'inline' ? fit : false, main, body, content);
  return <main ref={main} className={`card share-card surface-${host.surface}`} data-theme={doc.dark ? 'dark' : 'light'}>
    {preview && <div className="preview-flag">本地预览 · 模拟数据，不连接真实 Octopus</div>}
    <header className="bar">
      <Logo/>
      <div className="title"><h1>Octopus 文档协作</h1><p title={ABOUT}>{ABOUT}</p></div>
      {side && <div className="bar-side">{side}</div>}
    </header>
    {tabs}
    <div className={`share-body${fill ? ' is-fill' : ''}`} ref={body}><div className="share-content" ref={content}>{children}</div></div>
    {footer}
  </main>;
}

/** `detail`: the bridge's or the host's own words, under the card's explanation. */
function Center({ lead, spinner = false, detail, action, children }: { lead?: string; spinner?: boolean; detail?: string; action?: ReactNode; children?: ReactNode }) {
  return <div className="center">
    {spinner && <span className="spinner"/>}
    {lead && <p className="lead">{lead}</p>}
    {children && <p>{children}</p>}
    {detail && <p className="muted">{detail}</p>}
    {action}
  </div>;
}
