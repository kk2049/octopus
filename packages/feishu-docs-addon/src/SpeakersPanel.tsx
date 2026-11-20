import { useEffect, useState } from 'react';
import type { AgentApi, SpeakersInfo } from './protocol';
import { Icon, Notice } from './ui';

const message = (e: unknown) => e instanceof Error ? e.message : '操作没有完成，请重试';

/**
 * The owner decides who besides themselves may talk to this agent in its
 * cards: send it tasks, stop it, and fork their own branch from it. Every
 * message from someone else starts with their name, and the owner is notified.
 */
export function SpeakersPanel({ api, share, onClose }: { api: AgentApi; share: string; onClose(): void }) {
  const [info, setInfo] = useState<SpeakersInfo | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.speakers(share).then((value) => { if (live) { setInfo(value); setChosen(new Set(value.members.map((m) => m.username))); } }, (e) => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [api, share]);

  const toggle = (name: string) => setChosen((set) => { const next = new Set(set); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const dirty = info ? info.members.map((m) => m.username).sort().join() !== [...chosen].sort().join() : false;
  const save = async () => {
    setBusy(true); setError(''); setSaved('');
    try {
      const next = await api.setSpeakers(share, [...chosen]);
      setInfo(next); setChosen(new Set(next.members.map((m) => m.username)));
      setSaved(next.members.length ? `现在 ${next.members.map((m) => m.name).join('、')} 也可以和这个 Agent 对话` : '现在只有你可以和这个 Agent 对话');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  return <section className="panel" aria-label="允许谁对话">
    <header className="viewer-bar">
      <button className="icon-btn" aria-label="返回对话" title="返回对话" onClick={onClose}><Icon name="back"/></button>
      <Icon name="people" size={15}/>
      <div className="viewer-title"><b>允许谁对话</b><span>被选中的成员可以在卡片里给 Agent 发消息、停止它，或分叉出自己的对话</span></div>
    </header>
    <div className="panel-body">
      {!info && !error && <div className="viewer-empty"><span className="spinner"/>正在读取…</div>}
      {error && <Notice tone="error">{error}</Notice>}
      {info && <>
        <p className="panel-text">Agent 仍在你的设备上、以你的身份运行。别人发的消息开头会标出发言人，Agent 和读者都能看到是谁说的；每次有人发言或分叉，你都会收到飞书通知。</p>
        <div className="members" role="group" aria-label="可以对话的成员">
          {info.candidates.length === 0 && <p className="muted">还没有其他关联了飞书的 Octopus 成员。</p>}
          {info.candidates.map((m) => <label key={m.username} className={`member${chosen.has(m.username) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={chosen.has(m.username)} onChange={() => toggle(m.username)}/>
            <span className="avatar" aria-hidden="true">{m.name.slice(0, 1)}</span>
            <span className="member-name">{m.name}</span>
            {m.name !== m.username && <span className="member-id">{m.username}</span>}
          </label>)}
        </div>
        {saved && <Notice>{saved}</Notice>}
        <div className="row-actions">
          <button className="btn" disabled={busy} onClick={onClose}>完成</button>
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '正在保存…' : '保存'}</button>
        </div>
      </>}
    </div>
  </section>;
}
