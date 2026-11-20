/**
 * Owner notices for the Feishu Docs agent surface.
 *
 * Placing sessions into documents, starting agents, opening workspace files
 * and changing workspace grants run without approval clicks; the owner hears
 * about every one of them in Feishu instead. A notice never blocks or fails
 * the action it reports: delivery problems are logged and dropped.
 *
 * Repeated observations (someone watching a card, the same file opened again)
 * are coalesced per actor and subject for a window, so the channel stays
 * readable. Changes — place, remove, create, grant — are never coalesced.
 */
import type { CardPayload } from './direct-card.js';

export type DocsNotice =
  | { kind: 'placed'; actor: string; via: 'agent' | 'card'; session: string; device: string; provider: string; doc: DocRef; agent?: string }
  | { kind: 'removed'; actor: string; session: string; cards: number }
  | { kind: 'created'; actor: string; via: 'agent' | 'card'; session: string; device: string; provider: string; model: string; effort: string; directory: string; doc?: DocRef; agent?: string }
  | { kind: 'viewed'; actor: string; session: string; doc?: DocRef }
  | { kind: 'file'; actor: string; session: string; path: string; workspace: string; doc?: DocRef }
  | { kind: 'workspace'; actor: string; workspace: string; device: string; members: readonly string[] }
  | { kind: 'board'; actor: string; title: string; doc: DocRef }
  | { kind: 'edited'; actor: string; doc: DocRef; change: string }
  | { kind: 'spoke'; actor: string; session: string; doc?: DocRef }
  | { kind: 'forked'; actor: string; session: string; fork: string; from: 'live' | 'snapshot'; doc?: DocRef }
  /**
   * A tenant member's document assistant on one of the owner's cards. `guest`
   * (their open_id) and `anchor` (the card) only key the coalescing: starts
   * and messages of one guest on one card are told once per window; a pin
   * changes the document and is always told.
   */
  | { kind: 'assistant'; event: 'started' | 'spoke' | 'pinned'; actor: string; guest: string; anchor: string; title: string; device: string; project: string;
    rights: 'read' | 'write'; doc?: DocRef };

export interface DocRef { title?: string; url?: string }

/** Observations coalesce per (kind, actor, subject) for this long. */
const WINDOW_MS: Partial<Record<DocsNotice['kind'], number>> = { viewed: 6 * 60 * 60_000, file: 10 * 60_000, edited: 10 * 60_000, spoke: 10 * 60_000, assistant: 10 * 60_000 };
const MAX_REMEMBERED = 2048;

export class DocsNotifier {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly send: (owner: string, card: CardPayload) => Promise<void>,
    private readonly failed: (owner: string, kind: DocsNotice['kind'], error: unknown) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  notify(owner: string, notice: DocsNotice): void {
    const window = WINDOW_MS[notice.kind];
    if (window && (notice.kind === 'viewed' || notice.kind === 'file' || notice.kind === 'edited' || notice.kind === 'spoke'
      || (notice.kind === 'assistant' && notice.event !== 'pinned'))) {
      const subject = notice.kind === 'edited' ? `${notice.doc.url ?? notice.doc.title ?? ''}`
        : notice.kind === 'assistant' ? notice.anchor : `${notice.session}\u0000${notice.kind === 'file' ? notice.path : ''}`;
      const actor = notice.kind === 'assistant' ? notice.guest : notice.actor;
      const key = `${owner}\u0000${notice.kind}\u0000${actor}\u0000${subject}`;
      const at = this.seen.get(key);
      if (at !== undefined && this.now() - at < window) return;
      if (this.seen.size >= MAX_REMEMBERED) this.seen.delete(this.seen.keys().next().value!);
      this.seen.set(key, this.now());
    }
    void this.send(owner, docsNoticeCard(notice)).catch((error) => this.failed(owner, notice.kind, error));
  }
}

/** Card Markdown shows a reserved character only as an HTML entity (`&#42;`); a backslash would be printed as-is. */
const md = (text: string) => text.replace(/[*_`[\]<>~\\]/g, (c) => `&#${c.charCodeAt(0)};`);
const doc = (ref?: DocRef) => !ref ? '' : ref.url ? `[${md(ref.title || '飞书文档')}](${ref.url})` : `《${md(ref.title || '飞书文档')}》`;
const PROVIDERS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', omp: 'Oh My Pi' };
const provider = (value: string) => PROVIDERS[value] ?? value;

/**
 * The notice an owner gets when a document share is created for them. It
 * carries no command and no secret: the owner's own agents can read the
 * owner's private chats, so the command is shown only on the control card,
 * to the owner signed in there, once.
 */
export function docShareCreatedCard(share: { doc: DocRef; label: string; rights: 'read' | 'write' }): CardPayload {
  const title = share.doc.title || '飞书文档';
  const lines = [
    `已为${share.doc.url ? `[《${md(title)}》](${share.doc.url})` : `《${md(title)}》`}创建共享「${md(share.label)}」（${share.rights === 'write' ? '读写' : '只读'}）。`,
    '在文档里的 Octopus 控制卡片上点「显示接入命令」领取，命令只显示一次。不是你发起的话，在卡片上终止即可。',
  ];
  return {
    header: { title: { tag: 'plain_text', content: '新的文档共享待领取' }, template: 'orange' },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  };
}

/** A reader took an access key on a control card (or through its claim link), or ended one there. Never a secret. */
export type DocShareKeyNotice =
  | { kind: 'taken'; actor: string; label: string; rights: 'read' | 'write'; via: 'card' | 'invite' }
  | { kind: 'ended'; actor: string; label: string };

/**
 * The notice a card's owner gets when a reader takes or ends a key there:
 * the key's name and rights, never its token. The share service sends the
 * first of each kind per card in a window; the card lists them all.
 */
export function docShareKeyCard(notice: DocShareKeyNotice & { doc: DocRef }): CardPayload {
  const lines = notice.kind === 'taken'
    ? [`**${md(notice.actor)}** ${notice.via === 'invite' ? '通过领取链接' : '在控制卡片上'}为 ${doc(notice.doc)} 领取了访问密钥「${md(notice.label)}」（${notice.rights === 'write' ? '读写' : '只读'}）。`,
      '不认识的话，在文档里的 Octopus 控制卡片上终止它。10 分钟内这张卡片上的后续领取不再逐条通知。']
    : [`**${md(notice.actor)}** 在 ${doc(notice.doc)} 的控制卡片上终止了访问密钥「${md(notice.label)}」，它立即失效、不可恢复。`,
      '10 分钟内这张卡片上的后续终止不再逐条通知。'];
  return {
    header: { title: { tag: 'plain_text', content: notice.kind === 'taken' ? '有人领取了文档访问密钥' : '有人终止了文档访问密钥' }, template: notice.kind === 'taken' ? 'orange' : 'grey' },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  };
}

/** One short card per notice: what happened, who did it, where. */
export function docsNoticeCard(notice: DocsNotice): CardPayload {
  const lines: string[] = [];
  let title = 'Octopus · 飞书文档';
  let template = 'blue';
  switch (notice.kind) {
    case 'placed':
      title = '会话已放进文档';
      lines.push(`**${md(notice.actor)}** 把 **${md(notice.session)}** 放进了 ${doc(notice.doc)}`);
      lines.push(`${md(notice.device)} · ${provider(notice.provider)} · ${notice.via === 'agent' ? `由 Agent 工具发起${notice.agent ? `（${md(notice.agent)}）` : ''}` : '在卡片里操作'}`);
      lines.push('文档读者现在可以实时只读观看这段对话。');
      break;
    case 'removed':
      title = '已停止共享';
      template = 'grey';
      lines.push(`**${md(notice.actor)}** 停止了 **${md(notice.session)}** 的共享（${notice.cards} 张卡片失效）`);
      break;
    case 'created':
      title = '新建了 Agent';
      template = 'turquoise';
      lines.push(`**${md(notice.actor)}** 新建了 **${md(notice.session)}**${notice.doc ? `，放在 ${doc(notice.doc)}` : ''}`);
      lines.push(`${provider(notice.provider)} · ${md(notice.model || '默认模型')} · ${md(notice.effort || '默认强度')}`);
      lines.push(`${md(notice.device)}：${md(notice.directory)} · ${notice.via === 'agent' ? `由 Agent 工具发起${notice.agent ? `（${md(notice.agent)}）` : ''}` : '在卡片里操作'}`);
      break;
    case 'viewed':
      title = '有人在看你的 Agent';
      template = 'wathet';
      lines.push(`**${md(notice.actor)}** 正在${notice.doc ? ` ${doc(notice.doc)} 里` : ''}观看 **${md(notice.session)}**`);
      break;
    case 'file':
      title = '共享文件被打开';
      template = 'orange';
      lines.push(`**${md(notice.actor)}** 在 **${md(notice.session)}** 的卡片里打开了 ${md(notice.path)}`);
      lines.push(`工作区：${md(notice.workspace)}`);
      break;
    case 'board':
      title = '文档里新增了看板';
      template = 'indigo';
      lines.push(`**${md(notice.actor)}** 在 ${doc(notice.doc)} 里放了一块看板 **${md(notice.title)}**`);
      lines.push('之后的更新会直接刷新这张卡片，不再另行通知。');
      break;
    case 'edited':
      title = 'Agent 修改了文档';
      template = 'yellow';
      lines.push(`**${md(notice.actor)}** ${md(notice.change)}：${doc(notice.doc)}`);
      lines.push('同一个 Agent 10 分钟内对这篇文档的后续修改不再逐条通知。');
      break;
    case 'spoke':
      title = '有人在和你的 Agent 对话';
      template = 'orange';
      lines.push(`**${md(notice.actor)}** 在${notice.doc ? ` ${doc(notice.doc)} 的` : ''}卡片里给 **${md(notice.session)}** 发了消息`);
      lines.push('消息开头标着发言人；10 分钟内同一个人的后续消息不再逐条通知。');
      break;
    case 'forked':
      title = '有人分叉了你的 Agent';
      template = 'turquoise';
      lines.push(`**${md(notice.actor)}** 从${notice.from === 'snapshot' ? '快照' : ''} **${md(notice.session)}** 分叉出 **${md(notice.fork)}**${notice.doc ? `，卡片在 ${doc(notice.doc)}` : ''}`);
      lines.push('分叉在你的设备上作为你的 Agent 运行，原会话不受影响。');
      break;
    case 'workspace':
      title = '工作区共享已更新';
      template = 'purple';
      lines.push(`**${md(notice.actor)}** 更新了工作区 **${md(notice.workspace)}**（${md(notice.device)}）`);
      lines.push(notice.members.length ? `现在可以读取的人：${notice.members.map(md).join('、')}` : '现在只有你自己可以读取。');
      break;
    case 'assistant':
      template = notice.event === 'pinned' ? 'indigo' : 'turquoise';
      if (notice.event === 'pinned') {
        title = '文档助手被固定进了文档';
        lines.push(`**${md(notice.actor)}** 把文档助手 **${md(notice.title)}** 固定进了 ${doc(notice.doc) || '文档'}`);
        lines.push('文档读者现在可以实时观看这段对话；对话仍只有发起人和你可以参与。');
        break;
      }
      title = notice.event === 'started' ? '有人启动了文档助手' : '有人在用文档助手';
      lines.push(notice.event === 'started'
        ? `**${md(notice.actor)}** 在 ${doc(notice.doc) || '文档'} 里启动了文档助手 **${md(notice.title)}**`
        : `**${md(notice.actor)}** 在给文档助手 **${md(notice.title)}** 发消息`);
      lines.push(`它在你的 ${md(notice.device)} 上作为你的 Claude 会话运行：只读访问项目「${md(notice.project)}」，${notice.rights === 'write' ? '读写' : '只读'}这篇文档。`);
      lines.push('在文档的 Octopus 控制卡片上可以结束它，也可以关闭这篇文档的文档助手（同时结束全部）。10 分钟内同一个人在这篇文档里的后续活动不再逐条通知。');
      break;
  }
  return {
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  };
}
