import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AgentApiError, mergeRows, type AgentApi, type AgentOperation, type AgentStatus, type CardFrame, type MessageOrigin, type TranscriptRow } from './protocol';
import { Icon, Notice } from './ui';

/**
 * A live conversation over one card capability, wherever it is held: an Agent
 * card's Record, or a document assistant the share card's side panel started
 * (in memory, never written anywhere). `useLive` follows it; `Composer` talks
 * to it.
 */

const message = (e: unknown) => e instanceof Error ? e.message.slice(0, 300) : '操作没有完成，请重试';

export type Live = {
  rows: TranscriptRow[];
  meta: Pick<CardFrame, 'role' | 'title' | 'owner' | 'device' | 'provider' | 'kind' | 'snapshotAt' | 'origin' | 'canTalk' | 'readOnly' | 'assistant'> | null;
  status: AgentStatus | null;
  /** Why the shown transcript may be old: the device read (from the frame) or this frame's own request. */
  frameError: string;
  requestError: string;
  gone: { status: number; message: string } | null;
  /** When the current frame arrived: elapsed times never read a clock older than their data. */
  at: number;
  /** Earlier messages, read on request: `from` is where the next page ends (0: nothing earlier). */
  older: { from: number; loading: boolean; error: string };
};
const NOTHING: Live = { rows: [], meta: null, status: null, frameError: '', requestError: '', gone: null, at: 0, older: { from: 0, loading: false, error: '' } };

/**
 * Poll the card's share while it is on screen: fast while the Agent works, slow while it idles, never while hidden.
 * A frame holds the newest rows; `loadOlder` prepends the page before them, back to the conversation's start.
 * The share is a capability held in memory: a card's Record, or an assistant the side panel started.
 */
export function useLive(api: Pick<AgentApi, 'view' | 'older'>, share: string | null, onScreen: boolean): Live & { refresh(): void; loadOlder(): void } {
  const [live, setLive] = useState<Live>(NOTHING);
  const kick = useRef<() => void>(() => {});
  const older = useRef<() => void>(() => {});
  const visible = useRef(onScreen);

  useEffect(() => {
    setLive(NOTHING);
    if (!share) return;
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rev = '';
    let rows: TranscriptRow[] = [];
    let working = false;
    let failures = 0;
    /** How far back `older` reads have reached; a reset frame starts over. */
    let reached = Number.MAX_SAFE_INTEGER;
    let generation = 0;
    let loadingOlder = false;
    const olderFrom = () => Math.min(reached, rows[0]?.i ?? 0);
    const schedule = (ms: number) => { clearTimeout(timer); if (!stopped) timer = setTimeout(() => void tick(), ms); };
    const tick = async () => {
      if (stopped || busy || !visible.current || document.hidden) return;
      busy = true;
      try {
        const reply = await api.view(share, rev, rows.at(-1)?.i ?? -1);
        if (stopped) return;
        failures = 0;
        if ('unchanged' in reply) setLive((s) => s.requestError ? { ...s, requestError: '' } : s);
        else {
          if (reply.reset) { reached = Number.MAX_SAFE_INTEGER; generation++; }
          rev = reply.rev; rows = mergeRows(rows, reply); working = reply.status.working;
          const { role, title, owner, device, provider, kind, snapshotAt, origin, canTalk, readOnly, assistant } = reply;
          setLive({ rows, meta: { role, title, owner, device, provider, kind, snapshotAt, origin, canTalk, readOnly, assistant }, status: reply.status, frameError: reply.error ?? '', requestError: '', gone: null, at: Date.now(),
            older: { from: olderFrom(), loading: loadingOlder, error: '' } });
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof AgentApiError && (e.status === 404 || e.status === 410 || e.status === 403)) {
          stopped = true;
          setLive({ ...NOTHING, gone: { status: e.status, message: e.message } });
          return;
        }
        failures++;
        setLive((s) => ({ ...s, requestError: message(e) }));
      } finally { busy = false; }
      schedule(failures ? Math.min(30_000, 4_000 * failures) : working ? 2_000 : 6_000);
    };
    kick.current = () => schedule(0);
    older.current = () => {
      const before = olderFrom();
      if (stopped || loadingOlder || before <= 0) return;
      const at = generation;
      loadingOlder = true;
      setLive((s) => ({ ...s, older: { ...s.older, loading: true, error: '' } }));
      api.older(share, before).then((page) => {
        // A reset frame in between replaced the rows this page was to extend.
        if (stopped || at !== generation) return;
        const first = rows[0]?.i ?? Number.MAX_SAFE_INTEGER;
        rows = [...page.messages.filter((row) => row.i < first), ...rows];
        reached = Math.min(reached, page.next);
        setLive((s) => ({ ...s, rows, older: { from: olderFrom(), loading: false, error: '' } }));
      }, (e) => { if (!stopped) setLive((s) => ({ ...s, older: { ...s.older, loading: false, error: message(e) } })); })
        .finally(() => { loadingOlder = false; });
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); kick.current = () => {}; older.current = () => {}; };
  }, [api, share]);

  useEffect(() => {
    visible.current = onScreen;
    if (onScreen) kick.current();
  }, [onScreen]);
  useEffect(() => {
    const wake = () => { if (!document.hidden) kick.current(); };
    document.addEventListener('visibilitychange', wake);
    return () => document.removeEventListener('visibilitychange', wake);
  }, []);
  return { ...live, refresh: useCallback(() => kick.current(), []), loadOlder: useCallback(() => older.current(), []) };
}

/**
 * How long an uncertain message is still followed: the device keeps looking for
 * it in the agent's own record, and a late confirmation clears the notice.
 */
const FOLLOW_UNKNOWN_MS = 10 * 60_000;
/** The device clock and the server's may disagree by a little. */
const CLOCK_SKEW_MS = 10_000;

/**
 * Talking to the card's agent. A live card sends into the conversation, or
 * forks it: a new agent from the last completed turn, in its own card below.
 * A snapshot never changes, so it only forks — from the moment it keeps.
 */
export function Composer({ api, share, status, origin, snapshot, speaker, fork = true, onSent }: {
  api: Pick<AgentApi, 'send' | 'stop' | 'fork' | 'operation'>; share: string; status?: AgentStatus | null; origin?: MessageOrigin;
  snapshot: boolean;
  /** A member the owner let talk here: their messages carry their name. */
  speaker: boolean;
  /** Whether this agent may be branched from here; a document assistant never is. */
  fork?: boolean;
  onSent(): void;
}) {
  const working = Boolean(status?.working) && !snapshot;
  const [draft, setDraft] = useState('');
  const [op, setOp] = useState<AgentOperation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'send' | 'fork'>('');
  const [forked, setForked] = useState('');
  // The same text retried after a failure keeps its request id, so the bridge can never start it (or fork it) twice.
  const pending = useRef<{ prompt: string; id: string; mode: 'send' | 'fork' } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // A live record is followed until it settles; an uncertain one a while longer,
  // because its confirmation can still arrive from the device.
  const following = op?.live ? 'live' : op?.status === 'unknown' ? 'unknown' : null;
  useEffect(() => {
    if (!op || !following) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async () => {
      if (stopped || Date.now() - started > (following === 'live' ? 120_000 : FOLLOW_UNKNOWN_MS)) return;
      try {
        const next = await api.operation(op.id);
        if (stopped) return;
        setOp(next);
        if (!next.live && next.status !== 'unknown') { onSent(); return; }
      } catch { /* the transcript keeps reporting what the Agent does */ }
      timer = setTimeout(() => void poll(), following === 'live' ? 1500 : 5000);
    };
    timer = setTimeout(() => void poll(), following === 'live' ? 1200 : 3000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, op?.id, following, onSent]);

  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [draft]);

  async function submit(mode: 'send' | 'fork') {
    const prompt = draft.trim();
    if (!prompt || busy) return;
    if (pending.current?.prompt !== prompt || pending.current.mode !== mode) pending.current = { prompt, id: crypto.randomUUID(), mode };
    setBusy(mode); setError(''); setForked('');
    try {
      if (mode === 'fork') {
        const result = await api.fork(share, prompt, pending.current.id, origin);
        setOp(null);
        setForked(result.notice ?? `已分叉：新卡片「${result.binding.title}」在下方，这条消息已经发给它`);
      } else {
        setOp(await api.send(share, prompt, pending.current.id, origin));
      }
      setDraft(''); pending.current = null; onSent();
    } catch (e) { setError(message(e)); }
    finally { setBusy(''); }
  }
  async function stop() {
    setError('');
    try { setOp(await api.stop(share, crypto.randomUUID())); onSent(); } catch (e) { setError(message(e)); }
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(snapshot ? 'fork' : 'send'); }
  };
  // An uncertain send is not a failure. While the agent is running, or once a
  // turn began after the message was sent, it evidently got through: say nothing.
  const sentAt = op?.at ? Date.parse(op.at) : NaN;
  const ranAfter = Boolean(status?.turnStartedAt && Date.parse(status.turnStartedAt) >= sentAt - CLOCK_SKEW_MS);
  const uncertain = op?.status === 'unknown' && !working && !ranAfter;
  const failed = op && !op.live && op.status !== 'succeeded' && op.status !== 'unknown';

  return <footer className="composer">
    {error || failed ? <Notice tone="error">{error || op?.message}</Notice> : uncertain ? <Notice tone="warn">{op?.message}</Notice> : forked ? <Notice>{forked}</Notice> : null}
    <div className="compose-box">
      <label className="sr-only" htmlFor="agent-prompt">给 Agent 的任务</label>
      <textarea id="agent-prompt" ref={area} rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
        placeholder={snapshot ? '从这份快照接着聊…' : '给 Agent 布置任务…'}/>
      {working && <button className="btn btn-stop" title="停止 Agent 当前的工作" onClick={() => void stop()}><Icon name="stop" size={12}/>停止</button>}
      {!snapshot && fork && <button className="btn btn-fork" disabled={!draft.trim() || Boolean(busy)} onClick={() => void submit('fork')}
        title="从最近一轮完成处分叉出一个新对话，在下方新开一张卡片，并把这条消息发给它"><Icon name="fork" size={13}/>分叉</button>}
      {snapshot
        ? <button className="btn btn-primary btn-fork-primary" disabled={!draft.trim() || Boolean(busy)} onClick={() => void submit('fork')}><Icon name="fork" size={13}/>从这里分叉</button>
        : <button className="btn btn-primary btn-send" disabled={!draft.trim() || Boolean(busy)} onClick={() => void submit('send')} aria-label="发送"><Icon name="send" size={15}/></button>}
    </div>
    <div className="compose-hint">{op?.live ? op.message : busy === 'fork' ? '正在分叉，新卡片会出现在下方…'
      : snapshot ? `快照不会再变化 · ⌘/Ctrl + Enter 从这里分叉，在下方新开一张卡片继续${speaker ? ' · 消息开头会标出你的名字' : ''}`
      : `⌘/Ctrl + Enter 发送${fork ? ' · 分叉会在下方新开一张卡片' : ''}${speaker ? ' · 消息开头会标出你的名字' : ''}`}</div>
  </footer>;
}
