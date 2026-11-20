import { useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FILE_SCHEME, mentionOf, remarkFileMentions } from './paths';
import type { AgentStatus } from './protocol';

/** Octopus mark: head and three arms, drawn to sit on a 24px grid. */
export function Logo({ size = 28 }: { size?: number }) {
  return <span className="logo" style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="0 0 24 24" width={size * 0.64} height={size * 0.64} fill="currentColor">
      <path d="M12 2.6c-3.6 0-6.3 2.7-6.3 6.3v2.2c0 1.1-.5 2.1-1.4 2.7l-.8.5a.9.9 0 1 0 1 1.5l.8-.5c.5-.4 1-.8 1.3-1.3.2 1.6-.4 3.3-1.6 4.5a.9.9 0 1 0 1.3 1.3 7.7 7.7 0 0 0 2.2-4.7l.6.2-.2 4.6a.9.9 0 0 0 1.8.1l.2-4.5h2.2l.2 4.5a.9.9 0 0 0 1.8-.1l-.2-4.6.6-.2a7.7 7.7 0 0 0 2.2 4.7.9.9 0 1 0 1.3-1.3 5.6 5.6 0 0 1-1.6-4.5c.3.5.8.9 1.3 1.3l.8.5a.9.9 0 1 0 1-1.5l-.8-.5a3.2 3.2 0 0 1-1.4-2.7V8.9c0-3.6-2.7-6.3-6.3-6.3Zm-2.4 6.2a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Zm4.8 0a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z"/>
    </svg>
  </span>;
}

const ICONS: Record<string, string> = {
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  side: 'M4 5h16v14H4zM14 5v14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  send: 'M5 12h13M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14ZM20 20l-4-4',
  down: 'M12 5v14M6 13l6 6 6-6',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-.6-.6-2.6 2.6-2.2Z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  swap: 'M7 7h13l-4-4M17 17H4l4 4',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12l5 5 9-10',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  back: 'M15 6l-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  share: 'M16 8a3 3 0 1 0-3-3M8 15a3 3 0 1 0 0 .01M16 21a3 3 0 1 0 0-.01M10.6 13.5l2.8 1.8M13.4 6.7l-2.8 1.8',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  fork: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  snapshot: 'M4 7h3l2-3h6l2 3h3v12H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  refresh: 'M21 4v6h-6M19.5 14.5a8 8 0 1 1-1.9-8.3L21 10',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  chevron: 'M9 6l6 6-6 6',
  alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  copy: 'M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  pin: 'M12 17v5M9 3h6l-1 6 4 3v2H6v-2l4-3z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
};
export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  return <svg className="icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]}/></svg>;
}

const PROVIDERS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', omp: 'Oh My Pi' };
export const providerName = (provider: string) => PROVIDERS[provider] ?? provider;

export type StatusTone = 'busy' | 'ask' | 'done' | 'idle' | 'warn' | 'off';

/** The one word the status pill shows: what needs the reader's eye first wins. */
export function statusText(status: AgentStatus | null, error?: string): { tone: StatusTone; text: string } {
  if (!status) return { tone: 'off', text: '连接中' };
  if (status.waiting) return { tone: 'ask', text: status.waiting === 'permission' ? '等你批准' : '等你回答' };
  if (status.working) return { tone: 'busy', text: '工作中' };
  if (error) return { tone: 'warn', text: '同步中断' };
  if (status.unread) return { tone: 'done', text: '已完成 · 未读' };
  return { tone: 'idle', text: status.lastReplyAt ? '已完成' : '空闲' };
}

/** A span of time as people say it: "不到 1 分钟", "12 分钟", "1 小时 5 分", "2 天 3 小时". */
export function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`;
}

/**
 * The status bar's details, after the pill: how long the current turn has
 * run, how long the agent has waited, or how long the last turn took (from
 * the owner's last message to the agent's last reply) and when it ended.
 */
export function statusDetail(status: AgentStatus | null, now = Date.now()): string[] {
  if (!status) return [];
  const at = (iso?: string) => iso ? Date.parse(iso) : NaN;
  const started = at(status.turnStartedAt);
  const replied = at(status.lastReplyAt);
  if (status.waiting) {
    const since = at(status.since) || replied;
    return Number.isFinite(since) ? [`已等 ${span(now - since)}`] : [];
  }
  if (status.working) {
    const doing = status.state === 'tool' ? (status.tool ? `正在用 ${status.tool.split(',')[0]}` : '正在用工具') : status.state === 'responding' ? '正在回复' : '正在思考';
    return [...(Number.isFinite(started) ? [`已运行 ${span(now - started)}`] : []), doing];
  }
  if (!Number.isFinite(replied)) return [];
  return [...(Number.isFinite(started) && started <= replied ? [`用时 ${span(replied - started)}`] : []), `${relativeTime(status.lastReplyAt, now)}结束`];
}

export function StatusPill({ status, error }: { status: AgentStatus | null; error?: string }) {
  const { tone, text } = statusText(status, error);
  return <span className={`pill pill-${tone}`} role="status" title={error || text}><span className="pulse" aria-hidden="true"/>{text}</span>;
}

/** Re-renders on a timer so elapsed times stay true without a new frame. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** How long ago, as people say it; takes an ISO string or ms since the epoch. */
export function relativeTime(when: string | number | null | undefined, now = Date.now()): string {
  const at = typeof when === 'number' ? when : when ? Date.parse(when) : NaN;
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} 天前` : new Date(at).toLocaleDateString('zh-CN');
}

/** A moment in local time: "10-27 14:05" this year, "2025-10-27" before it. */
export function dateTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return '';
  const time = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  const day = `${two(time.getMonth() + 1)}-${two(time.getDate())}`;
  return time.getFullYear() === new Date(now).getFullYear() ? `${day} ${two(time.getHours())}:${two(time.getMinutes())}` : `${time.getFullYear()}-${day}`;
}

const SAFE_URL = /^(https?:|mailto:)/i;
const safeUrl = (url: string) => SAFE_URL.test(url) || url.startsWith(FILE_SCHEME) ? url : '';

/**
 * Agent text is untrusted. react-markdown builds React elements from an AST,
 * raw HTML stays text (no rehype-raw), and only http(s)/mailto links survive;
 * they open through the host rather than navigating this frame. File mentions
 * become buttons: clicking one asks the bridge, which alone decides access.
 */
export function Markdown({ text, onLink, onFile }: { text: string; onLink(url: string): void; onFile?(path: string): void }) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      const path = href ? mentionOf(href) : null;
      if (path) {
        return onFile
          ? <button type="button" className="file-ref" title={`打开 ${path}`} onClick={() => onFile(path)}><Icon name="file" size={12}/>{children}</button>
          : <span className="file-ref is-static">{children}</span>;
      }
      return href
        ? <a href={href} onClick={(event) => { event.preventDefault(); onLink(href); }} rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>;
    },
    img: ({ alt }) => <span className="img-alt">[{alt || '图片'}]</span>,
  }), [onLink, onFile]);
  return <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm, remarkFileMentions]} urlTransform={safeUrl} components={components}>{text}</ReactMarkdown></div>;
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode; action?: ReactNode }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><span>{children}</span>{action}</div>;
}
