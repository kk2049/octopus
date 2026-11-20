import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DiscussionDetail, DiscussionSnapshot } from '../../contract.js';
import { api, errorText, query } from '../../lib/api.js';
import { pollInterval } from '../../lib/query.js';
import { Dialog } from '../../ui/Dialog.js';
import { Markdown } from '../../ui/Markdown.js';
import { UiButton } from '../../ui-kit/primitives.js';
import { useDashboardLanguage } from '../../i18n/react.js';
import { uiText } from '../../i18n/ui-text.js';
import styles from './Discussions.module.css';

async function act(action: string, args: Record<string, unknown>) {
  return api<{ result: { id?: string; status?: string } }>('/api/discussions/action', { method: 'POST', json: { action, args } });
}

export function Discussions() {
  useDashboardLanguage();
  const [open, setOpen] = useState(false), [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false), [topic, setTopic] = useState(''), [agenda, setAgenda] = useState(''), [participants, setParticipants] = useState('lilei');
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), createIntent = useRef({ body: '', id: '' });
  const data = useQuery({ queryKey: ['discussions', selected], queryFn: () => api<DiscussionSnapshot>(`/api/discussions${query({ discussion_id: selected })}`), enabled: open, refetchInterval: open ? pollInterval('/api/discussions', 2500) : false });
  const choose = (value: string) => { generation.current++; setSelected(value); setCreating(false); setError(''); };
  async function create() {
    if (pending) return;
    const snapshot = JSON.stringify({ topic, agenda, participants });
    if (createIntent.current.body !== snapshot) createIntent.current = { body: snapshot, id: crypto.randomUUID() };
    const epoch = generation.current;
    setPending(true); setError('');
    try {
      const out = await act('discussion_start', { ...JSON.parse(snapshot), request_id: createIntent.current.id });
      if (epoch !== generation.current) return;
      if (out.result.id) { choose(out.result.id); setTopic(''); setAgenda(''); createIntent.current = { body: '', id: '' }; }
      await data.refetch();
    } catch (error) { if (epoch === generation.current) setError(errorText(error)); }
    finally { setPending(false); }
  }
  return <>
    <UiButton onClick={() => setOpen(true)}>{uiText('会议')}</UiButton>
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) generation.current++; }} title={uiText('议题会议')} width={1000}>
      <div className={styles.toolbar}>
        <UiButton onClick={() => void data.refetch()}>{uiText('刷新')}</UiButton>
        {data.data?.canConvene && <UiButton onClick={() => { generation.current++; setCreating(true); setError(''); }}>{uiText('发起会议')}</UiButton>}
      </div>
      {(error || data.error) && <p role="alert">{error || errorText(data.error)}</p>}
      {data.data && !data.data.enabled && <p>{uiText('会议服务未启用或模型尚未配置。')}</p>}
      <div className={styles.layout}>
        <nav className={styles.roster} aria-label={uiText('会议列表')}>
          {data.data?.discussions.map(room => <button key={room.id} aria-current={room.id === selected ? 'true' : undefined} onClick={() => choose(room.id)}><strong>{room.topic}</strong><small>{room.activityText}</small></button>)}
        </nav>
        <div className={styles.detail}>
          {creating ? <div className={styles.form}>
            <label>{uiText('议题')}<input value={topic} maxLength={200} onChange={event => setTopic(event.target.value)} /></label>
            <label>{uiText('参会账号（逗号分隔）')}<input value={participants} maxLength={1000} onChange={event => setParticipants(event.target.value)} /></label>
            <label>{uiText('议程与预期产出')}<textarea value={agenda} maxLength={8000} onChange={event => setAgenda(event.target.value)} /></label>
            <p>{uiText('将创建飞书群，邀请这些真人与 Bot；秘书会保存群消息，并在需要时发言。')}</p>
            <UiButton disabled={pending || !topic.trim() || !participants.trim()} onClick={() => void create()}>{pending ? uiText('正在创建…') : uiText('创建群并启动秘书')}</UiButton>
          </div> : data.data?.selected ? <Meeting key={data.data.selected.id} room={data.data.selected} refresh={() => data.refetch()} /> : <p>{uiText('选择一个议题，查看秘书活动和群消息。')}</p>}
        </div>
      </div>
    </Dialog>
  </>;
}

export function Meeting({ room, refresh }: { room: DiscussionDetail; refresh(): Promise<unknown> }) {
  useDashboardLanguage();
  const [text, setText] = useState(''), [settings, setSettings] = useState(''), [revision, setRevision] = useState(room.revision);
  const [editing, setEditing] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const intent = useRef({ text: '', id: '' }), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = ['active', 'paused'].includes(room.status);
  async function submit(action: string, args: Record<string, unknown>, done?: () => void) {
    if (pending) return;
    setPending(true); setError('');
    try { await act(action, { discussion_id: room.id, ...args }); if (mounted.current) { done?.(); await refresh(); } }
    catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { if (mounted.current) setPending(false); }
  }
  return <article>
    <h3>{room.topic}</h3><p>{room.members.join(' · ')} · {room.status}</p>
    <p role="status">{room.activityText}</p>
    {error && <p role="alert">{error}</p>}
    {room.uncertainDeliveries.map(row => <p key={row.id} role="alert">{uiText('发送结果未知，请先核对飞书群：')}{row.text}</p>)}
    {room.writable && active && <div className={styles.toolbar}>
      <UiButton disabled={pending} onClick={() => void submit('discussion_configure', { revision: room.revision, status: room.status === 'paused' ? 'active' : 'paused' })}>{room.status === 'paused' ? uiText('继续会议') : uiText('暂停会议')}</UiButton>
      <UiButton disabled={pending} onClick={() => void submit('discussion_configure', { revision: room.revision, status: 'closed' })}>{uiText('结束会议')}</UiButton>
      <UiButton disabled={pending} onClick={() => { setSettings(JSON.stringify(room.settings, null, 2)); setRevision(room.revision); setEditing(true); }}>{uiText('模型与提示词')}</UiButton>
    </div>}
    {room.writable && room.status === 'unknown' && <UiButton disabled={pending} onClick={() => void submit('discussion_configure', { revision: room.revision, status: 'closed' })}>{uiText('结束会议')}</UiButton>}
    {editing && <div className={styles.form}>
      <label>{uiText('模型配置 JSON')}<textarea rows={14} value={settings} onChange={event => setSettings(event.target.value)} /></label>
      <UiButton disabled={pending} onClick={() => void submit('discussion_configure', { revision, settings }, () => setEditing(false))}>{uiText('保存配置')}</UiButton>
    </div>}
    {room.memory && <details open><summary>{uiText('会议纪要')}</summary><Markdown>{room.memory}</Markdown></details>}
    <details open><summary>{uiText('Agent 活动')}</summary><div className={styles.timeline}>{room.events.map(event => <div key={event.seq}><small>{event.agent} · {event.kind} · {event.created_at}</small><p>{event.text}</p></div>)}</div></details>
    <details><summary>{uiText('最近群消息')}</summary><div className={styles.timeline}>{room.messages.map(message => <div key={message.seq}><small>#{message.seq} · {message.sender} · {message.triage}</small><p>{message.text}</p></div>)}</div></details>
    {active && <div className={styles.form}><label>{uiText('给秘书的补充（会议成员可见）')}<textarea value={text} maxLength={16000} onChange={event => setText(event.target.value)} /></label><UiButton disabled={pending || !text.trim()} onClick={() => {
      const sent = text;
      if (intent.current.text !== sent) intent.current = { text: sent, id: crypto.randomUUID() };
      void submit('discussion_append', { text: sent, request_id: intent.current.id }, () => { setText(current => current === sent ? '' : current); intent.current = { text: '', id: '' }; });
    }}>{pending ? uiText('正在提交…') : uiText('追加给秘书')}</UiButton></div>}
  </article>;
}
