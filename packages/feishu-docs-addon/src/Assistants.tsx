import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Composer, useLive } from './Conversation';
import { Feed } from './Feed';
import { AgentApiError, type AgentApi, type AssistantSettings, type AssistantStatus, type AssistantTarget, type AssistantView, type DocSharePanel, type DocShareRights, type MessageOrigin } from './protocol';
import { dateTime, Icon, Notice, statusDetail, StatusPill } from './ui';

/** What the assistants tab asks of the bridge: the assistant calls, and a conversation's own. */
export type AssistantApi = Pick<AgentApi, 'assistantTargets' | 'assistantConfigure' | 'assistantList' | 'assistantStart' | 'assistantStatus' | 'assistantEnd' | 'assistantPin'
  | 'view' | 'older' | 'message' | 'send' | 'stop' | 'fork' | 'operation'>;
type Binding = NonNullable<AssistantStatus['binding']>;

const STATE_TEXT: Record<AssistantView['state'], string> = { starting: '启动中', ready: '就绪', failed: '失败', ended: '已结束' };
const STATE_BADGE: Record<AssistantView['state'], string> = { starting: 'pending', ready: 'active', failed: 'failed', ended: 'terminated' };
/** How the assistant will address its guest, as the bridge bounds it. */
const NAME_MAX = 40;
/** A starting assistant is asked about this often, until it is ready or failed. */
const STATUS_MS = 2_000;
/** While the card is on screen, the list follows what others do within this. */
const LIST_MS = 30_000;
const errorText = (e: unknown) => e instanceof Error && e.message ? e.message.slice(0, 300) : '请重试';
/** Signing in is what failed: the host had no Feishu login to give, or the bridge refused the reader's code or tenant. */
const signedOut = (e: unknown) => !(e instanceof AgentApiError) || e.status === 401 || e.status === 403;
const projectKey = (device: string, workspace: string) => `${device}\n${workspace}`;

/** One line on what a card's assistants may do: 可读项目「ACC」（只读）· 可读写本文档 · 使用 Claude. */
export function assistantSummary(settings: AssistantSettings): string {
  return `${settings.project ? `可读项目「${settings.project.label}」（只读）· ` : ''}${settings.rights === 'write' ? '可读写' : '只读'}本文档 · 使用 Claude`;
}

/**
 * The 文档助手 tab: a signed-in reader starts their own Claude agent here. It
 * runs on the owner's device as the owner's session, reads the card's project
 * (never writes it) and reads, or also writes, this document as the Octopus
 * app. Each reader sees their own assistants, the owner all of them; a ready
 * one opens as a live conversation in this panel, over the card capability
 * its status answers (held in memory, written nowhere).
 */
export function AssistantsTab({ api, anchor, hostToken, settings, owner, visible, readerName, origin, app, checking, now, onConfigured, onKeys, onRecheck, onChat }: {
  api: AssistantApi; anchor: string; hostToken: string;
  settings: AssistantSettings; owner: boolean; visible: boolean;
  /** The reader's Feishu name: how the assistant will address them, unless they change it. */
  readerName: string;
  origin?: MessageOrigin;
  /** What the Octopus app may do in the document: the assistants act as it. */
  app: Pick<DocSharePanel, 'app_access' | 'app_name'>;
  checking: boolean; now: number;
  onConfigured(settings: AssistantSettings): void;
  /** A reader who cannot use assistants is sent to the keys. */
  onKeys(): void;
  onRecheck(): void;
  /** A conversation is open: it takes the whole panel. */
  onChat(open: boolean): void;
}) {
  const on = settings.rights !== null;
  const [assistants, setAssistants] = useState<AssistantView[] | null>(null);
  const [problem, setProblem] = useState<{ signin: boolean; text: string } | null>(null);
  const [setup, setSetup] = useState(false);
  const [composing, setComposing] = useState(false);
  /** The assistant this panel started and follows until it is ready (then it opens) or failed. */
  const [starting, setStarting] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [chat, setChat] = useState<{ view: AssistantView; binding: Binding } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<Readonly<Record<string, 'pin' | 'end'>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const alive = useRef(true);
  const issued = useRef(0);
  const newButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onChat(Boolean(chat)); }, [chat, onChat]);
  useEffect(() => () => onChat(false), [onChat]);

  /** Lists are numbered when asked for: an answer that a newer one overtook is dropped. */
  const reload = useCallback(async () => {
    const seq = ++issued.current;
    try {
      const { assistants: next } = await api.assistantList(anchor);
      if (!alive.current || seq !== issued.current) return;
      setAssistants(next);
      setProblem(null);
    } catch (e) {
      if (alive.current && seq === issued.current) setProblem({ signin: signedOut(e), text: errorText(e) });
    }
  }, [api, anchor]);
  // Read when the tab is in front (again): a reader who never opens it is never asked to sign in for it.
  useEffect(() => { if (on && visible) void reload(); }, [on, visible, reload]);
  // On screen, the list follows what others do; a reader who cannot sign in is not asked to on every tick.
  const signin = Boolean(problem?.signin);
  useEffect(() => {
    if (!on || !visible || signin) return;
    const timer = setInterval(() => { if (!document.hidden) void reload(); }, LIST_MS);
    return () => clearInterval(timer);
  }, [on, visible, signin, reload]);

  // The assistant just started is followed every 2 s, never while the document is hidden or the card scrolled away.
  const startingId = starting?.id;
  useEffect(() => {
    if (!startingId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      if (document.hidden || !visible) { timer = setTimeout(() => void tick(), STATUS_MS); return; }
      try {
        const status = await api.assistantStatus(startingId);
        if (stopped) return;
        if (status.state === 'starting' || (status.state === 'ready' && !status.binding)) {
          setStarting({ id: startingId, message: status.message });
          timer = setTimeout(() => void tick(), STATUS_MS);
          return;
        }
        setStarting(null);
        void reload();
        if (status.state === 'ready' && status.binding) setChat({ view: status, binding: status.binding });
        else setNotice({ tone: 'error', text: `助手没有启动：${status.message || STATE_TEXT[status.state]}` });
      } catch (e) {
        if (stopped) return;
        if (e instanceof AgentApiError && (e.status === 403 || e.status === 404 || e.status === 410)) {
          setStarting(null);
          setNotice({ tone: 'error', text: `助手没有启动：${errorText(e)}` });
          return;
        }
        // The bridge may be briefly unreachable: keep following, more slowly.
        timer = setTimeout(() => void tick(), STATUS_MS * 2);
      }
    };
    timer = setTimeout(() => void tick(), STATUS_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, startingId, visible, reload]);

  const start = async (task: string, name: string, requestId: string) => {
    const { id } = await api.assistantStart(anchor, hostToken, task, requestId, name);
    if (!alive.current) return;
    setNotice(null);
    setComposing(false);
    setStarting({ id, message: '' });
    void reload();
  };
  const fail = (id: string, text: string) => setErrors((all) => ({ ...all, [id]: text }));
  const clear = (id: string) => setErrors(({ [id]: _, ...rest }) => rest);
  const settle = (id: string) => setBusy(({ [id]: _, ...rest }) => rest);

  async function open(view: AssistantView) {
    if (opening) return;
    setOpening(view.id);
    clear(view.id);
    try {
      // The status of a ready assistant carries its card capability: into this panel's memory and nowhere else.
      const status = await api.assistantStatus(view.id);
      if (!alive.current) return;
      if (status.state === 'ready' && status.binding) setChat({ view: status, binding: status.binding });
      else { fail(view.id, `现在打不开：${status.message || STATE_TEXT[status.state]}`); void reload(); }
    } catch (e) {
      if (alive.current) fail(view.id, `没有打开：${errorText(e)}`);
    } finally {
      if (alive.current) setOpening(null);
    }
  }
  async function pin(view: AssistantView) {
    if (busy[view.id]) return;
    setBusy((all) => ({ ...all, [view.id]: 'pin' }));
    clear(view.id);
    try {
      await api.assistantPin(view.id);
      if (!alive.current) return;
      setNotice({ tone: 'info', text: `「${view.title}」已固定到文档：就在这张卡片下方，读者都能实时观看` });
      setChat((current) => current?.view.id === view.id ? { ...current, view: { ...current.view, pinned: true } } : current);
      setAssistants((list) => list?.map((a) => a.id === view.id ? { ...a, pinned: true } : a) ?? list);
      void reload();
    } catch (e) {
      if (alive.current) fail(view.id, `固定没有完成：${errorText(e)}`);
    } finally {
      if (alive.current) settle(view.id);
    }
  }
  async function end(view: AssistantView) {
    if (busy[view.id]) return;
    setConfirming(null);
    setBusy((all) => ({ ...all, [view.id]: 'end' }));
    clear(view.id);
    try {
      const ended = await api.assistantEnd(view.id);
      if (!alive.current) return;
      setAssistants((list) => list?.map((a) => a.id === ended.id ? ended : a) ?? list);
      setChat((current) => current?.view.id === view.id ? null : current);
      void reload();
    } catch (e) {
      if (alive.current) fail(view.id, `结束没有完成：${errorText(e)}`);
    } finally {
      if (alive.current) settle(view.id);
    }
  }
  const back = () => { setChat(null); void reload(); };

  if (chat) {
    return <AssistantChat api={api} view={chat.view} binding={chat.binding} visible={visible} origin={origin} now={now}
      busy={busy[chat.view.id]} error={errors[chat.view.id] ?? ''} notice={notice?.tone === 'info' ? notice.text : ''}
      onBack={back} onPin={() => void pin(chat.view)} onEnd={() => void end(chat.view)}/>;
  }
  if (!on) {
    // A bridge from before assistants answers no settings, read as off with no room for any: nothing to set up there.
    if (owner && settings.limits.per_card === 0) {
      return <div className="assist-note">
        <p className="lead">文档助手还不能在这里使用</p>
        <p>这个 Octopus 还没有开放文档助手；升级后，这里会出现开启的选项。现在可以用「访问密钥」让 Agent 读写这篇文档。</p>
        <button className="link" onClick={onKeys}>去访问密钥</button>
      </div>;
    }
    return owner
      ? <AssistantSetup api={api} anchor={anchor} current={null} limits={settings.limits} onSaved={onConfigured}/>
      : <div className="assist-note">
          <p className="lead">卡片所有者还没有开启文档助手</p>
          <p>开启后，你可以在这里启动一个自己的 Claude 助手：它读这篇文档和所有者关联的项目，帮你完成任务。</p>
          <button className="link" onClick={onKeys}>现在可以用「访问密钥」接入你自己的 Agent</button>
        </div>;
  }
  if (problem?.signin) {
    return <div className="assist-note">
      <p className="lead">文档助手需要用本组织的飞书账号登录</p>
      <p>没有登录飞书，或者账号不在接入 Octopus 的组织里，就不能启动文档助手。你可以改用「访问密钥」，让自己的 Agent 读写这篇文档。</p>
      {problem.text && <p className="muted">{problem.text}</p>}
      <div className="row-actions assist-note-actions">
        <button className="btn" onClick={() => void reload()}>重试</button>
        <button className="btn btn-primary" onClick={onKeys}><Icon name="key" size={14}/>去访问密钥</button>
      </div>
    </div>;
  }

  const live = (assistants ?? []).filter((a) => a.state === 'starting' || a.state === 'ready');
  const done = (assistants ?? []).filter((a) => a.state === 'failed' || a.state === 'ended');
  const rows = (list: AssistantView[]) => list.map((view) => <AssistantRow key={view.id} view={view} now={now} busy={busy[view.id]} error={errors[view.id] ?? ''}
    opening={opening === view.id} confirming={confirming === view.id} onOpen={() => void open(view)} onPin={() => void pin(view)}
    onEnd={() => void end(view)} onConfirm={(yes) => setConfirming(yes ? view.id : null)}/>);
  const writes = settings.rights === 'write';
  const blocked = app.app_access === 'none' || (writes && app.app_access === 'view');
  const appName = app.app_name || 'Octopus 应用';
  return <div className="assist">
    <div className="keys-top">
      <div className="keys-title"><h2>文档助手</h2><p>{assistantSummary(settings)}</p></div>
      <div className="assist-top-actions">
        {owner && <button className="btn btn-small" aria-expanded={setup} onClick={() => setSetup((open) => !open)}><Icon name="sliders" size={13}/>设置</button>}
        {!composing && <button ref={newButton} className="btn btn-primary" onClick={() => { setNotice(null); setComposing(true); }}><Icon name="plus" size={14}/>新对话</button>}
      </div>
    </div>
    {setup && owner && <AssistantSetup api={api} anchor={anchor} current={settings} limits={settings.limits}
      onSaved={(next) => { onConfigured(next); setSetup(false); }} onCancel={() => setSetup(false)}/>}
    {blocked && <Notice tone="warn" action={<button className="link" disabled={checking} onClick={onRecheck}>重新检查</button>}>
      <b className="notice-lead">{app.app_access === 'none' ? '助手现在还读不到这篇文档' : '助手现在只能读这篇文档'}</b>
      {`助手以飞书应用「${appName}」的身份访问文档，${app.app_access === 'none' ? '它还没有被添加到这篇文档' : '它现在只能查看'}。`
        + `请文档所有者在「…」→「添加文档应用」中添加「${appName}」，并给它「${writes ? '可编辑' : '可阅读'}」权限。`}
    </Notice>}
    {notice && <Notice tone={notice.tone} action={<button className="link" onClick={() => setNotice(null)}>知道了</button>}>{notice.text}</Notice>}
    {composing && <NewConversation name={readerName} settings={settings} onStart={start}
      onCancel={() => { setComposing(false); requestAnimationFrame(() => newButton.current?.focus()); }}/>}
    {starting && <p className="assist-starting" role="status"><span className="spinner small"/>正在启动你的助手…{starting.message && starting.message !== '正在启动…' ? `（${starting.message}）` : ''}</p>}
    {problem && <Notice tone="warn" action={<button className="link" onClick={() => void reload()}>重试</button>}>没有读到助手列表：{problem.text}</Notice>}
    {assistants === null
      ? !problem && <div className="assist-loading"><span className="spinner"/></div>
      : live.length
      ? <ul className="assistants" aria-label="进行中的助手">{rows(live)}</ul>
      : <div className="keys-empty">
          <p className="lead">{done.length ? '现在没有进行中的助手' : '还没有助手'}</p>
          <p>点「新对话」，写下要它做什么：它会读这篇文档{settings.project ? `和项目「${settings.project.label}」` : ''}，{writes ? '需要时直接改写文档' : '把结果告诉你'}。</p>
        </div>}
    {done.length > 0 && <details className="keys-ended">
      <summary><Icon name="chevron" size={13}/>已结束的助手（{done.length}）</summary>
      <ul className="assistants" aria-label="已结束的助手">{rows(done)}</ul>
    </details>}
  </div>;
}

/** One assistant in the list: who it works for (to the owner), its state, and what may be done with it. */
function AssistantRow({ view, now, busy, error, opening, confirming, onOpen, onPin, onEnd, onConfirm }: {
  view: AssistantView; now: number; busy?: 'pin' | 'end'; error: string; opening: boolean; confirming: boolean;
  onOpen(): void; onPin(): void; onEnd(): void; onConfirm(yes: boolean): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const ask = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);
  const live = view.state === 'starting' || view.state === 'ready';
  const ready = view.state === 'ready';
  const said = view.state === 'failed' || (ready && view.message) ? view.message : '';
  const back = () => { onConfirm(false); ask.current?.focus(); };
  return <li className={`assistant assistant-${view.state}`} aria-label={view.title}>
    <div className="assistant-main">
      <span className="key-line"><span className="key-label" title={view.title}>{view.title}</span>{view.pinned && <span className="tag">已固定</span>}</span>
      <span className="key-sub" title={said}>{[view.mine ? '' : `为 ${view.guest} 工作`, dateTime(view.created_at, now), said].filter(Boolean).join(' · ')}</span>
    </div>
    <span className={`badge badge-${STATE_BADGE[view.state]}`}>{STATE_TEXT[view.state]}</span>
    {live && <div className="key-ops">
      {busy
        ? <span className="share-sending" role="status"><span className="spinner small"/>{busy === 'pin' ? '正在固定…' : '正在结束…'}</span>
        : <>
            {ready && <button className="btn btn-small btn-primary" disabled={opening} onClick={onOpen}>{opening ? '正在打开…' : '打开'}</button>}
            {ready && view.mine && !view.pinned && view.rights === 'write' && <button className="btn btn-small" onClick={onPin}>固定到文档</button>}
            <button ref={ask} className="btn btn-small btn-danger" aria-expanded={confirming} onClick={() => onConfirm(!confirming)}>结束</button>
          </>}
    </div>}
    {live && confirming && !busy && <div className="key-confirm" role="group" aria-label="确认结束" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); back(); } }}>
      <span>结束后不能再和它对话{view.pinned ? '，文档里的卡片只留下对话记录' : ''}。</span>
      <span className="key-confirm-actions">
        <button ref={cancel} className="btn btn-small" onClick={back}>取消</button>
        <button className="btn btn-small btn-danger-solid" onClick={onEnd}>确认结束</button>
      </span>
    </div>}
    {error && <p className="key-refusal" role="alert">{error}</p>}
  </li>;
}

/** A new conversation: what the assistant should do, and how it should address the reader. ⌘/Ctrl+Enter starts it, Esc cancels. */
function NewConversation({ name: given, settings, onStart, onCancel }: {
  name: string; settings: AssistantSettings;
  onStart(task: string, name: string, requestId: string): Promise<void>;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState('');
  const [name, setName] = useState(given.slice(0, NAME_MAX));
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The same task retried after a failure keeps its request id: the bridge joins the first start instead of starting another.
  const pending = useRef<{ task: string; id: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => { if (!edited) setName(given.slice(0, NAME_MAX)); }, [given, edited]);
  useEffect(() => { area.current?.focus(); }, []);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const task = draft.trim();
    if (!task || busy) return;
    if (pending.current?.task !== task) pending.current = { task, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try { await onStart(task, name.trim(), pending.current.id); }
    catch (e) { setError(`没有启动：${errorText(e)}`); }
    finally { setBusy(false); }
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); }
  };
  const { limits } = settings;
  return <form className="assist-new" aria-label="新对话" onSubmit={(e) => void submit(e)} onKeyDown={onKey}>
    <label className="sr-only" htmlFor={`${id}-task`}>让助手做什么？</label>
    <textarea id={`${id}-task`} ref={area} className="input textarea" rows={3} value={draft} disabled={busy} placeholder="让助手做什么？"
      onChange={(e) => setDraft(e.target.value)}/>
    <div className="assist-new-foot">
      <label className="assist-name">它称呼你
        <input className="input" value={name} maxLength={NAME_MAX} disabled={busy} placeholder="你的名字" autoComplete="off"
          onChange={(e) => { setName(e.target.value); setEdited(true); }}/>
      </label>
      <span className="row-actions">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>{busy ? <><span className="spinner small"/>正在启动…</> : '启动助手'}</button>
      </span>
    </div>
    <p className="field-hint">⌘/Ctrl + Enter 启动 · 每人同时最多 {limits.per_guest} 个，24 小时内最多启动 {limits.per_guest_per_day} 个</p>
    {error && <p className="take-error" role="alert">{error}</p>}
  </form>;
}

/**
 * The owner's setup: which project the assistants read, how much they may do
 * to the document, and the plain warning of what turning them on means.
 * `current` is null while assistants are off.
 */
function AssistantSetup({ api, anchor, current, limits, onSaved, onCancel }: {
  api: Pick<AgentApi, 'assistantTargets' | 'assistantConfigure'>; anchor: string;
  current: AssistantSettings | null; limits: AssistantSettings['limits'];
  onSaved(settings: AssistantSettings): void;
  onCancel?(): void;
}) {
  const [targets, setTargets] = useState<AssistantTarget[] | null>(null);
  const [problem, setProblem] = useState('');
  // The owner gets the project's real ids (anyone else only its label); without them nothing is preselected.
  const [project, setProject] = useState(current?.project?.device && current.project.workspace_id ? projectKey(current.project.device, current.project.workspace_id) : '');
  const [rights, setRights] = useState<DocShareRights>(current?.rights ?? 'write');
  const [busy, setBusy] = useState<'' | 'save' | 'off'>('');
  const [error, setError] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  const id = useId();

  const load = useCallback(() => {
    setProblem('');
    api.assistantTargets().then(({ devices }) => {
      setTargets(devices);
      // Nothing chosen yet: the first workspace an eligible device offers.
      setProject((chosen) => chosen || (() => {
        const device = devices.find((d) => d.eligible && d.workspaces.length);
        return device ? projectKey(device.device, device.workspaces[0].workspace_id) : '';
      })());
    }, (e) => setProblem(errorText(e)));
  }, [api]);
  useEffect(() => { load(); }, [load]);

  async function save(next: DocShareRights | null) {
    if (busy) return;
    const [device, workspace] = project.split('\n');
    setBusy(next ? 'save' : 'off');
    setError('');
    try {
      onSaved(await api.assistantConfigure(anchor, next ? { rights: next, device, workspace_id: workspace } : { rights: null }));
    } catch (e) {
      setError(`${next ? (current ? '保存' : '开启') : '关闭'}没有完成：${errorText(e)}`);
    } finally {
      setBusy('');
    }
  }
  const eligible = (targets ?? []).some((d) => d.eligible && d.workspaces.length);
  const chosen = targets?.flatMap((d) => d.workspaces.map((w) => ({ key: projectKey(d.device, w.workspace_id), label: w.label, device: d }))).find((w) => w.key === project);
  return <section className="assist-setup" aria-label={current ? '文档助手设置' : '开启文档助手'}>
    {!current && <>
      <h2>开启文档助手</h2>
      <p className="assist-setup-about">让能打开这篇文档的组织成员各自启动一个 Claude 助手：它在你的设备上运行，读取你选的项目，读写这篇文档。</p>
    </>}
    <label className="field" htmlFor={`${id}-project`}>项目<span>助手只能读取它，不能改动</span></label>
    {targets === null
      ? problem
        ? <Notice tone="error" action={<button className="link" onClick={load}>重试</button>}>没有读到你的设备：{problem}</Notice>
        : <p className="assist-setup-loading"><span className="spinner small"/>正在读取你的设备…</p>
      : <select id={`${id}-project`} className="input" value={project} disabled={Boolean(busy)} onChange={(e) => setProject(e.target.value)}>
          {!chosen && <option value="" disabled>{eligible ? '选择一个项目' : '没有可用的项目'}</option>}
          {targets.map((d) => <optgroup key={d.device} label={d.eligible ? d.label : `${d.label}（${d.reason || '不能运行文档助手'}）`} disabled={!d.eligible}>
            {d.workspaces.map((w) => <option key={w.workspace_id} value={projectKey(d.device, w.workspace_id)}>{w.label}</option>)}
          </optgroup>)}
        </select>}
    {targets !== null && !eligible && <p className="field-hint warn">你的设备都不能运行文档助手：需要在线、Runner 足够新，并登记了项目工作区（不能是整个主目录）。</p>}
    <span className="field" id={`${id}-rights`}>对这篇文档</span>
    <div className="segmented" role="radiogroup" aria-labelledby={`${id}-rights`}>
      {(['write', 'read'] as const).map((r) => <button key={r} type="button" role="radio" aria-checked={rights === r} className={rights === r ? 'is-on' : ''}
        disabled={Boolean(busy)} onClick={() => setRights(r)}>{r === 'write' ? '读写' : '只读'}</button>)}
    </div>
    <p className="once-warn assist-warn"><Icon name="alert" size={14}/>
      {`开启后，能打开这篇文档的组织成员都能启动自己的助手：它能读取所选项目里的全部文件（包括配置和日志），并以 Octopus 应用身份${rights === 'write' ? '读写' : '读取'}这篇文档；助手使用你的 Claude 额度。`}
    </p>
    <p className="field-hint">每张卡片同时最多 {limits.per_card} 个助手；每人同时最多 {limits.per_guest} 个，24 小时内最多启动 {limits.per_guest_per_day} 个。</p>
    {error && <p className="take-error" role="alert">{error}</p>}
    <div className="assist-setup-actions">
      {current && !confirmOff && <button className="btn btn-danger" disabled={Boolean(busy)} onClick={() => setConfirmOff(true)}>关闭文档助手</button>}
      <span className="row-actions">
        {onCancel && <button className="btn" disabled={Boolean(busy)} onClick={onCancel}>取消</button>}
        <button className="btn btn-primary" disabled={Boolean(busy) || !chosen?.device.eligible} onClick={() => void save(rights)}>
          {busy === 'save' ? <><span className="spinner small"/>正在保存…</> : current ? '保存' : '开启'}
        </button>
      </span>
    </div>
    {confirmOff && <div className="key-confirm" role="group" aria-label="确认关闭文档助手">
      <span>关闭后，所有正在运行的助手都会结束；成员不能再启动新的助手。</span>
      <span className="key-confirm-actions">
        <button className="btn btn-small" disabled={Boolean(busy)} onClick={() => setConfirmOff(false)}>取消</button>
        <button className="btn btn-small btn-danger-solid" disabled={Boolean(busy)} onClick={() => void save(null)}>{busy === 'off' ? '正在关闭…' : '确认关闭'}</button>
      </span>
    </div>}
  </section>;
}

/**
 * One assistant's live conversation in the panel: the same transcript and
 * composer as an Agent card, over the capability its status answered. Never
 * forked; pinned into the document by its guest, ended by its guest or the
 * owner.
 */
function AssistantChat({ api, view, binding, visible, origin, now, busy, error, notice, onBack, onPin, onEnd }: {
  api: AssistantApi; view: AssistantView; binding: Binding; visible: boolean; origin?: MessageOrigin; now: number;
  busy?: 'pin' | 'end'; error: string; notice: string;
  onBack(): void; onPin(): void; onEnd(): void;
}) {
  const live = useLive(api, binding.share, visible);
  const [confirm, setConfirm] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  const talker = Boolean(live.meta?.canTalk) && !live.meta?.readOnly;
  const syncError = live.requestError || live.frameError;
  const title = live.meta?.title ?? binding.title;
  const detail = [...statusDetail(live.status, Math.max(now, live.at)), view.mine ? '' : `为 ${view.guest} 工作`].filter(Boolean);
  return <section className="assist-chat" aria-label={`助手「${title}」`}>
    <div className="assist-chat-bar">
      <button ref={back} className="icon-btn" title="返回助手列表" aria-label="返回助手列表" onClick={onBack}><Icon name="back"/></button>
      <div className="assist-chat-title"><b title={title}>{title}</b><span>{detail.join(' · ') || '文档助手'}</span></div>
      {!live.gone && <StatusPill status={live.status} error={syncError}/>}
      <div className="assist-chat-actions">
        {busy
          ? <span className="share-sending" role="status"><span className="spinner small"/>{busy === 'pin' ? '正在固定…' : '正在结束…'}</span>
          : <>
              {view.pinned ? <span className="tag">已固定在文档里</span>
                : view.mine && !live.gone && view.rights === 'write' && <button className="btn btn-small" onClick={onPin}><Icon name="pin" size={13}/>固定到文档</button>}
              {!live.gone && <button className="btn btn-small btn-danger" aria-expanded={confirm} onClick={() => setConfirm((c) => !c)}>结束</button>}
            </>}
      </div>
    </div>
    {confirm && !busy && <div className="key-confirm assist-chat-confirm" role="group" aria-label="确认结束">
      <span>结束后不能再和它对话。</span>
      <span className="key-confirm-actions">
        <button className="btn btn-small" onClick={() => setConfirm(false)}>取消</button>
        <button className="btn btn-small btn-danger-solid" onClick={() => { setConfirm(false); onEnd(); }}>确认结束</button>
      </span>
    </div>}
    {error ? <Notice tone="error">{error}</Notice> : notice ? <Notice>{notice}</Notice> : syncError && !live.gone ? <Notice tone="warn">{syncError}</Notice> : null}
    {live.gone
      ? <div className="center"><p className="lead">{live.gone.message}</p><button className="btn" onClick={onBack}>返回助手列表</button></div>
      : <Feed rows={live.rows} status={live.status} user={view.guest || '你'} empty={live.meta ? '还没有对话内容' : '正在读取对话…'}
          onLink={() => {}} older={{ ...live.older, load: live.loadOlder }} expand={(i) => api.message(binding.share, i).then((reply) => reply.text)}/>}
    {!live.gone && (talker
      ? <Composer api={api} share={binding.share} status={live.status} origin={origin} snapshot={false} speaker={false} fork={false} onSent={live.refresh}/>
      : live.meta && <footer className="foot"><Icon name="eye" size={13}/>现在不能和它对话：它已经结束，或被所有者暂停</footer>)}
  </section>;
}
