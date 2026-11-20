import { AgentApiError, type AssistantSettings, type DocShareAction, type DocShareConnect, type DocShareInvite, type DocShareLink, type DocSharePanel, type DocShareSelfServe } from './protocol';

/**
 * What a reader does to one key on the card: the owner pauses, resumes or
 * terminates it, or takes a pending key's ways in (`reveal`); anyone else
 * deletes it, which is a terminate in the reader's words.
 */
export type ShareOp = DocShareAction | 'delete' | 'reveal';
/** A card-wide operation: taking a key for oneself, the owner's self-serve level, the owner's claim link. One of each runs at a time. */
export type ShareTask = 'take' | 'settings' | 'invite';

/**
 * A share card's state. The panel is the bridge's projection and is replaced
 * whole by every newer read. Operations are overlays on top of it: per key,
 * keyed by key id and correlated by a request id — `sending` until the bridge
 * answers, then `confirmed` (showing the key the bridge returned) until a read
 * issued after that answer arrives, or removed with a reason when refused.
 * Card-wide operations (`tasks`) follow the same lifecycle.
 */
export type ShareOverlay =
  | { rid: string; action: ShareOp; phase: 'sending' }
  | { rid: string; action: ShareOp; phase: 'confirmed'; share: DocShareLink; after: number };

/** A card-wide operation on its way (`value`: the level or claim-link change asked for), or refused with a reason. */
export type ShareTaskState = { rid: string; phase: 'sending'; value: string } | { rid: string; phase: 'refused'; reason: string };

/**
 * A key's ways in, as the bridge answered them once: they live here only —
 * never stored or logged — until their reader closes them, their key ends or
 * leaves the panel, or the card unmounts. `after`: the last read issued before
 * the answer; only a later read may judge the key gone.
 */
export interface ShareSecret { share: DocShareLink; connect: DocShareConnect; via: 'take' | 'reveal'; after: number }

export interface ShareState {
  panel: DocSharePanel | null;
  /** The read that produced `panel`: reads are numbered when issued, and an older one never replaces a newer one. */
  seq: number;
  overlays: Readonly<Record<string, ShareOverlay>>;
  /** Why the last operation on a key was refused, until the next one on it. */
  refusals: Readonly<Record<string, string>>;
  /** Keys this card just took, shown until a read issued after the answer reports them (or does not). */
  taken: Readonly<Record<string, { share: DocShareLink; after: number }>>;
  /** One-time ways in, by key id. */
  secrets: Readonly<Record<string, ShareSecret>>;
  tasks: Readonly<Partial<Record<ShareTask, ShareTaskState>>>;
  /** The claim link as the owner's last change left it, until a read issued after that answer. */
  invite: { value: DocShareInvite; after: number } | null;
  /** A new claim link, shown once like a key's ways in: gone when closed, or once a later read shows another link or none. */
  claim: { link: string; created_at: number | null; after: number } | null;
  /** The document assistants' settings as the owner's last change left them, until a read issued after that answer. */
  assistant: { value: AssistantSettings; after: number } | null;
}

export type ShareEvent =
  | { type: 'panel'; seq: number; panel: DocSharePanel }
  | { type: 'start'; id: string; rid: string; action: ShareOp }
  /** `after`: the last read issued before the answer; only a later read may retire the overlay. `connect`: a reveal's. */
  | { type: 'confirmed'; id: string; rid: string; share: DocShareLink; after: number; connect?: DocShareConnect }
  | { type: 'refused'; id: string; rid: string; reason: string }
  /** The reader has kept a key's ways in: forget them. */
  | { type: 'dismiss'; id: string }
  | { type: 'begin'; task: ShareTask; rid: string; value: string }
  | { type: 'fail'; task: ShareTask; rid: string; reason: string }
  /** A refusal the reader has set aside (the form closed). */
  | { type: 'clear'; task: ShareTask }
  | { type: 'taken'; rid: string; share: DocShareLink; connect: DocShareConnect; after: number }
  /** The self-serve change answered with the panel as it is now: a read numbered when its answer arrived. */
  | { type: 'settled'; rid: string; seq: number; panel: DocSharePanel }
  | { type: 'invited'; rid: string; invite: DocShareInvite; link?: string; after: number }
  /** The owner has kept the claim link: forget it. */
  | { type: 'unclaim' }
  /** The owner changed the card's assistants; `settings` is the bridge's answer. */
  | { type: 'assistant'; settings: AssistantSettings; after: number };

export const NO_SHARES: ShareState = { panel: null, seq: 0, overlays: {}, refusals: {}, taken: {}, secrets: {}, tasks: {}, invite: null, claim: null, assistant: null };

const without = <T>(map: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const { [key]: _, ...rest } = map;
  return rest;
};
const keep = <T>(map: Readonly<Record<string, T>>, test: (value: T, key: string) => boolean): Record<string, T> =>
  Object.fromEntries(Object.entries(map).filter(([key, value]) => test(value, key)));

/** A newer read: it replaces the panel and retires whatever it was issued after. */
function read(state: ShareState, seq: number, panel: DocSharePanel): ShareState {
  const before = (after: number) => after >= seq;
  const usable = new Set(panel.shares.filter((s) => s.status !== 'terminated').map((s) => s.id));
  const link = panel.invite;
  return {
    ...state, panel, seq,
    overlays: keep(state.overlays, (o) => o.phase === 'sending' || before(o.after)),
    taken: keep(state.taken, (t) => before(t.after)),
    // Ways in outlive reads, but not their key: once a read issued after them lists it as ended, or not at all, they go.
    secrets: keep(state.secrets, (s, id) => before(s.after) || usable.has(id)),
    invite: state.invite && before(state.invite.after) ? state.invite : null,
    assistant: state.assistant && before(state.assistant.after) ? state.assistant : null,
    // A claim link is dead once a later read shows no link, or a newer one (reset in another tab).
    claim: state.claim && (before(state.claim.after) || (link?.active && link.created_at === state.claim.created_at)) ? state.claim : null,
  };
}

export function reduceShares(state: ShareState, event: ShareEvent): ShareState {
  switch (event.type) {
    case 'panel':
      return event.seq <= state.seq ? state : read(state, event.seq, event.panel);
    case 'start':
      // One operation per key at a time: a second click while the first is on its way changes nothing.
      if (state.overlays[event.id]?.phase === 'sending') return state;
      return { ...state, overlays: { ...state.overlays, [event.id]: { rid: event.rid, action: event.action, phase: 'sending' } }, refusals: without(state.refusals, event.id) };
    case 'confirmed': {
      const overlay = state.overlays[event.id];
      if (overlay?.rid !== event.rid) return state;
      const secrets = event.share.status === 'terminated' ? without(state.secrets, event.id)
        : event.connect ? { ...state.secrets, [event.id]: { share: event.share, connect: event.connect, via: 'reveal' as const, after: event.after } } : state.secrets;
      return { ...state, overlays: { ...state.overlays, [event.id]: { rid: event.rid, action: overlay.action, phase: 'confirmed', share: event.share, after: event.after } }, secrets };
    }
    case 'refused':
      if (state.overlays[event.id]?.rid !== event.rid) return state;
      return { ...state, overlays: without(state.overlays, event.id), refusals: { ...state.refusals, [event.id]: event.reason } };
    case 'dismiss':
      return Object.hasOwn(state.secrets, event.id) ? { ...state, secrets: without(state.secrets, event.id) } : state;
    case 'begin':
      if (state.tasks[event.task]?.phase === 'sending') return state;
      return { ...state, tasks: { ...state.tasks, [event.task]: { rid: event.rid, phase: 'sending', value: event.value } } };
    case 'fail':
      if (state.tasks[event.task]?.rid !== event.rid) return state;
      return { ...state, tasks: { ...state.tasks, [event.task]: { rid: event.rid, phase: 'refused', reason: event.reason } } };
    case 'clear':
      return state.tasks[event.task]?.phase === 'refused' ? { ...state, tasks: without(state.tasks, event.task) } : state;
    case 'taken': {
      if (state.tasks.take?.rid !== event.rid) return state;
      const { share, connect, after } = event;
      return { ...state, tasks: without(state.tasks, 'take'), taken: { ...state.taken, [share.id]: { share, after } },
        secrets: { ...state.secrets, [share.id]: { share, connect, via: 'take', after } } };
    }
    case 'settled': {
      const tasks = state.tasks.settings?.rid === event.rid ? without(state.tasks, 'settings') : state.tasks;
      return event.seq <= state.seq ? { ...state, tasks } : read({ ...state, tasks }, event.seq, event.panel);
    }
    case 'invited': {
      if (state.tasks.invite?.rid !== event.rid) return state;
      // A new link replaces the old one, which stopped working; stopping it leaves none to show.
      const claim = event.link ? { link: event.link, created_at: event.invite.created_at, after: event.after } : null;
      return { ...state, tasks: without(state.tasks, 'invite'), invite: { value: event.invite, after: event.after }, claim };
    }
    case 'unclaim':
      return state.claim ? { ...state, claim: null } : state;
    case 'assistant':
      return { ...state, assistant: { value: event.settings, after: event.after } };
  }
}

export interface ShownLink { share: DocShareLink; sending?: ShareOp; refusal?: string }

/**
 * The keys to show, each with its overlay applied: keys this card just took
 * and no read lists yet (newest first), then the panel's in the bridge's
 * order. A key the panel no longer lists is not shown.
 */
export function shownLinks(state: ShareState): ShownLink[] {
  const listed = state.panel?.shares ?? [];
  const ids = new Set(listed.map((s) => s.id));
  const fresh = Object.values(state.taken).filter((t) => !ids.has(t.share.id)).map((t) => t.share).reverse();
  return [...fresh, ...listed].map((share) => {
    const overlay = state.overlays[share.id];
    const refusal = state.refusals[share.id];
    return {
      share: overlay?.phase === 'confirmed' ? overlay.share : share,
      ...(overlay?.phase === 'sending' ? { sending: overlay.action } : {}),
      ...(refusal ? { refusal } : {}),
    };
  });
}

/** The self-serve level to show: the owner's choice at once while it is on its way, else the bridge's. */
export function shownSelfServe(state: ShareState): DocShareSelfServe | null {
  const task = state.tasks.settings;
  return task?.phase === 'sending' ? task.value as DocShareSelfServe : state.panel?.self_serve ?? null;
}

/** The claim link's state to show: the owner's last change until a later read reports it. */
export function shownInvite(state: ShareState): DocShareInvite | null {
  return state.invite?.value ?? state.panel?.invite ?? null;
}

/** The document assistants' settings to show: the owner's last change until a later read reports it. */
export function shownAssistant(state: ShareState): AssistantSettings | null {
  return state.assistant?.value ?? state.panel?.assistant ?? null;
}

/** Why the panel cannot be shown, as the card words it. `detail` is the bridge's own bounded message. */
export type PanelProblem = { kind: 'signin' | 'tenant' | 'unknown' | 'network' | 'failed'; detail: string };

/**
 * The bridge answers a share card's reader signed in or not, so a refused read
 * is the bridge's word: 401 and 403 come only from a bridge that still wants a
 * login, or keeps this reader out.
 */
export function panelProblem(error: unknown): PanelProblem {
  const detail = error instanceof Error ? error.message.slice(0, 300) : '';
  if (!(error instanceof AgentApiError)) return { kind: 'failed', detail };
  if (error.status === 404 && error.message === 'unknown_anchor') return { kind: 'unknown', detail: '' };
  if (error.status === 401) return { kind: 'signin', detail };
  if (error.status === 403) return { kind: 'tenant', detail };
  return { kind: error.status === 0 ? 'network' : 'failed', detail };
}

const REFUSALS: Record<string, string> = {
  not_owner: '只有卡片所有者可以这样操作',
  unknown_share: '这个密钥已不存在',
  terminated: '这个密钥已经终止，不能再更改',
  pending: '这个密钥还没有领取接入命令，不能暂停或恢复；不需要了可以直接终止',
  unknown_anchor: 'Octopus 不认识这张卡片',
};
/** Refusals that are whole sentences of their own, shown as they are. */
const SENTENCES: Record<string, string> = {
  not_pending: '这个密钥的接入命令已经领取过；如果丢失，请终止后重新创建。',
};
const OP_NAMES: Record<ShareOp, string> = { pause: '暂停', resume: '恢复', terminate: '终止', delete: '删除', reveal: '显示接入命令' };

const bounded = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : '';

/** A refused operation in words: the contract's error codes translated, any other bridge message kept (bounded). */
export function refusalText(op: ShareOp, error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (Object.hasOwn(SENTENCES, text)) return SENTENCES[text];
  // Deleting a key someone already ended leaves it ended: the reader's wish, done.
  if (op === 'delete' && text === 'terminated') return '这个密钥已经停用了。';
  const reason = !text ? '请重试' : Object.hasOwn(REFUSALS, text) ? REFUSALS[text] : bounded(error);
  return `${OP_NAMES[op]}没有完成：${reason}`;
}

/** What a card-wide operation did, in the reader's words: the claim link is made, made anew, or stopped. */
export type TaskVerb = 'take' | 'settings' | 'create' | 'reset' | 'revoke';
const TASK_NAMES: Record<TaskVerb, string> = { take: '领取', settings: '保存设置', create: '生成领取链接', reset: '重置领取链接', revoke: '停用领取链接' };
const TASK_REFUSALS: Record<string, string> = {
  not_owner: '只有卡片所有者可以这样操作',
  unknown_anchor: 'Octopus 不认识这张卡片',
  self_serve_off: '卡片所有者关闭了自助领取',
  rights_exceed: '卡片所有者只允许领取只读密钥',
  host_mismatch: '这张卡片不属于本文档，不能在这里领取',
  card_missing: '文档里暂时找不到这张卡片；确认卡片还在文档里后刷新再试',
};

/**
 * A refused card-wide operation in words. Taking a key is limited per hour
 * and in number (the panel's `limits`): a 429 the bridge does not word itself
 * names both.
 */
export function taskRefusal(verb: TaskVerb, error: unknown, limits?: DocSharePanel['limits']): string {
  const text = error instanceof Error ? error.message : '';
  const many = verb === 'take' && limits && error instanceof AgentApiError && error.status === 429 ? limits : null;
  const reason = text === 'rate_limited' && limits ? `这张卡片每小时最多领取 ${limits.per_hour} 个密钥，请稍后再试`
    : text === 'too_many_keys' && limits ? `这张卡片的密钥已达上限（${limits.active_max} 个），请先删除不用的密钥`
    : Object.hasOwn(TASK_REFUSALS, text) ? TASK_REFUSALS[text]
    : many && (!text || /^Octopus 返回错误/.test(text)) ? `领取太频繁或密钥太多（每小时最多 ${many.per_hour} 个，同时最多 ${many.active_max} 个），请稍后再试或先删除不用的密钥`
    : text ? bounded(error) : '请重试';
  return `${TASK_NAMES[verb]}没有完成：${reason}`;
}
