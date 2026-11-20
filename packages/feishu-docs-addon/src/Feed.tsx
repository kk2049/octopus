import { useLayoutEffect, useRef, useState } from 'react';
import { spoken } from './message';
import type { AgentStatus, TranscriptRow } from './protocol';
import { Icon, Markdown, statusText } from './ui';

/** `cut`: the whole message's length, when only its beginning is here yet. */
type Item =
  | { kind: 'user'; key: number; text: string; speaker?: string; cut?: number }
  | { kind: 'agent'; key: number; text: string; tools: string[]; cut?: number }
  | { kind: 'tools'; key: number; tools: Map<string, number> };

/** Consecutive tool-only turns read as one line of activity, not a wall of rows. `whole` holds messages read in full. */
function items(rows: readonly TranscriptRow[], whole: ReadonlyMap<number, string>): Item[] {
  const out: Item[] = [];
  for (const row of rows) {
    const full = whole.get(row.i);
    const text = full ?? row.text;
    const cut = full === undefined && row.cut ? { cut: row.cut } : {};
    if (row.role === 'user') {
      const { speaker, body } = spoken(text);
      if (body) out.push({ kind: 'user', key: row.i, text: body, ...(speaker ? { speaker } : {}), ...cut });
      continue;
    }
    if (text) { out.push({ kind: 'agent', key: row.i, text, tools: row.tools ?? [], ...cut }); continue; }
    const last = out.at(-1);
    const tools = last?.kind === 'tools' ? last.tools : new Map<string, number>();
    for (const tool of row.tools ?? []) tools.set(tool, (tools.get(tool) ?? 0) + 1);
    if (last?.kind !== 'tools') out.push({ kind: 'tools', key: row.i, tools });
  }
  return out;
}

const toolLine = (tools: Map<string, number>) => [...tools].map(([name, n]) => n > 1 ? `${name} ×${n}` : name).join(' · ');

const FOLD_LINES = 6;
const FOLD_CHARS = 360;

/** A long prompt (a pasted document, a first instruction carrying one) folds to its opening lines. */
function UserBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  if (lines.length <= FOLD_LINES && text.length <= FOLD_CHARS) return <div className="bubble">{text}</div>;
  const head = lines.slice(0, FOLD_LINES).join('\n').slice(0, FOLD_CHARS).trimEnd();
  return <div className="bubble">
    {open ? text : `${head}…`}
    <button className="bubble-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起' : '展开全文'}</button>
  </div>;
}

export function Feed({ rows, status, user, empty, onLink, onFile, older, expand }: {
  rows: readonly TranscriptRow[];
  status: AgentStatus | null;
  /** Who wrote a user message that names no speaker: the owner, or someone unnamed on a read-only device. */
  user: string;
  empty: string;
  onLink(url: string): void;
  /** A file path the agent mentioned was clicked. */
  onFile?(path: string): void;
  /** Earlier messages than the rows shown: `from` > 0 means there are some to load. */
  older?: { from: number; loading: boolean; error: string; load(): void };
  /** Reads one message whole, for a row that carries only its beginning. */
  expand?(i: number): Promise<string>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  const [whole, setWhole] = useState<ReadonlyMap<number, string>>(new Map());
  const [reading, setReading] = useState<ReadonlyMap<number, string>>(new Map());
  const list = items(rows, whole);
  const last = rows.at(-1)?.i ?? -1;
  const first = rows[0]?.i ?? -1;
  const before = useRef({ first, height: 0 });

  // Follow the conversation only while the reader is at the bottom; never yank them back up.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (pinned.current) node.scrollTop = node.scrollHeight;
    else setBehind(true);
  }, [last, status?.working]);
  // Older rows arrive above: keep the reader on what they were reading.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const prior = before.current;
    if (prior.first >= 0 && first >= 0 && first < prior.first) {
      if (pinned.current) node.scrollTop = node.scrollHeight;
      else node.scrollTop += node.scrollHeight - prior.height;
    }
    before.current = { first, height: node.scrollHeight };
  });

  const readWhole = (i: number) => {
    if (!expand || reading.get(i) === '') return;
    setReading((m) => new Map(m).set(i, ''));
    expand(i).then((text) => {
      setWhole((m) => new Map(m).set(i, text));
      setReading((m) => { const next = new Map(m); next.delete(i); return next; });
    }, (e: unknown) => setReading((m) => new Map(m).set(i, e instanceof Error ? e.message : '没有读到全文，请重试')));
  };
  const more = (item: { key: number; cut?: number }) => item.cut && expand ? <div className="msg-cut">
    {reading.get(item.key) ? <span className="muted">{reading.get(item.key)} </span> : null}
    <button className="bubble-more" disabled={reading.get(item.key) === ''} onClick={() => readWhole(item.key)}>
      {reading.get(item.key) === '' ? '正在读取全文…' : `这条消息共 ${item.cut} 字，这里只显示了开头 · 展开全文`}
    </button>
  </div> : null;

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    if (pinned.current) setBehind(false);
  };
  const jump = () => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
    pinned.current = true; setBehind(false);
  };
  const working = status?.working ? statusText(status).text : '';

  return <div className="feed-wrap">
    <div className="feed" ref={scroller} onScroll={onScroll} aria-live="polite" aria-label="Agent 对话">
      {older && older.from > 0 && list.length > 0 && <div className="feed-older">
        {older.error && <span className="muted">{older.error} </span>}
        <button className="link" disabled={older.loading} onClick={older.load}>{older.loading ? '正在读取更早的消息…' : '加载更早的消息'}</button>
      </div>}
      {list.length === 0 && <div className="feed-empty">{empty}</div>}
      {list.map((item, k) => item.kind === 'user'
        ? <article key={item.key} className={`msg msg-user${item.speaker ? ' msg-speaker' : ''}`}>
            {(list[k - 1]?.kind !== 'user' || (list[k - 1] as { speaker?: string }).speaker !== item.speaker) && <div className="who">{item.speaker ?? user}</div>}
            <UserBubble text={item.text}/>
            {more(item)}
          </article>
        : item.kind === 'agent'
          ? <article key={item.key} className="msg msg-agent">
              {(k === 0 || list[k - 1].kind === 'user') && <div className="who">Agent</div>}
              <Markdown text={item.text} onLink={onLink} onFile={onFile}/>
              {more(item)}
              {item.tools.length > 0 && <div className="tools"><Icon name="tool" size={12}/>{item.tools.join(' · ')}</div>}
            </article>
          : <div key={item.key} className="tools tools-row"><Icon name="tool" size={12}/>{toolLine(item.tools)}</div>)}
      {working && <div className="working"><span className="dots" aria-hidden="true"><i/><i/><i/></span>{working}…</div>}
    </div>
    {behind && <button className="jump" onClick={jump}><Icon name="down" size={14}/>新内容</button>}
  </div>;
}
