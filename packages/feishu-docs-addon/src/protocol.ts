/**
 * Wire contract between the Feishu Docs card and the Octopus bridge.
 *
 * Nothing here is authority. The server derives the caller from its own
 * Feishu login and the session from a share it stored; every value below is
 * display data or an opaque handle that the server re-checks.
 */

/** One session the signed-in owner may put into a card. */
export interface SessionChoice {
  resourceId: string;
  title: string;
  /** The latest message, for recognising a session in the picker. */
  preview?: string;
  device: string;
  provider: string;
  project?: string;
  lastActivity?: string;
  working: boolean;
  canSend: boolean;
  /** How many cards currently show this session. */
  shared: number;
}

/**
 * What a card keeps in its document Record. Every document reader can read it,
 * so it holds only the share capability and display labels. `doc` is the
 * document the share was made for: a copied card shows nothing until its
 * owner shares again for the new document.
 */
export interface CardBinding {
  v: 2;
  share: string;
  title: string;
  owner: string;
  device: string;
  provider: string;
  doc: string;
  /**
   * The same document's other name. A card placed through the OpenAPI knows
   * both the docx id and the wiki node token, and the host may report either.
   */
  alias?: string;
}

/**
 * A board card's Record: a visual page an owner's agent publishes and keeps up
 * to date. Kept under its own Record key, so a card is either an Agent or a
 * board and an older card build shows a board card as empty, never as an Agent.
 */
export interface BoardBinding {
  v: 1;
  board: string;
  title: string;
  owner: string;
  doc: string;
  alias?: string;
}

/** A board as the card shows it: static HTML, rendered without scripts or outside resources. */
export interface BoardFrame { role: 'owner' | 'viewer'; title: string; owner: string; version: number; updatedAt: string; html: string }
export type BoardReply = BoardFrame | { version: number; unchanged: true };

/**
 * One message or first instruction a session takes, in UTF-8 bytes: the
 * Runner's prompt budget (`MACHINE_LIMITS.startMaxPromptBytes` and
 * `appendMaxPromptBytes`; a bridge test keeps them equal). The card sends a
 * document's text along with a new agent only when it fits.
 */
export const PROMPT_MAX_BYTES = 384 * 1024;

/** UTF-8 size of a text, as the budget above counts it. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** One transcript row. `i` is the absolute message index, stable across frames. */
export interface TranscriptRow {
  i: number;
  role: 'user' | 'assistant';
  /** The message's text; only its beginning when `cut` is set. */
  text: string;
  /** The whole text's length in characters, when a frame carries only its beginning (`message` reads the rest). */
  cut?: number;
  /** Tool names only: inputs and outputs never leave the owner's device view. */
  tools?: string[];
  at?: string;
}

export interface AgentStatus {
  /** The same "live" judgement Dashboard and Session Hub make (activityPhase). */
  working: boolean;
  state: 'thinking' | 'tool' | 'responding' | 'idle' | 'unknown';
  tool?: string;
  since?: string;
  /** The agent is blocked on its owner: a question to answer, or a permission to grant. */
  waiting?: 'question' | 'permission';
  /** When the current (or last) turn began: the Runner's turn start, else the owner's last message. */
  turnStartedAt?: string;
  /** The agent's newest message in the transcript. */
  lastReplyAt?: string;
  /** Owner only: the agent finished a turn the owner has not yet seen in a card. */
  unread?: boolean;
}

/** A card frame. `messages` replaces the transcript when `reset`, else patches it from `messages[0].i`. */
export interface CardFrame {
  rev: string;
  role: 'owner' | 'viewer';
  title: string;
  owner: string;
  device: string;
  provider: string;
  status: AgentStatus;
  total: number;
  reset: boolean;
  messages: TranscriptRow[];
  /** The last good transcript is still shown; this says why it may be old. */
  error?: string;
  /** `live` follows the session; a `snapshot` shows it frozen at one completed turn. Absent means live. */
  kind?: 'live' | 'snapshot';
  /** A snapshot's moment: when it was taken. */
  snapshotAt?: string;
  /** How this card came to be: a snapshot of another card, or a fork from one. */
  origin?: CardOrigin;
  /** The reader may talk to this agent here (send, stop, fork): its owner, or a member the owner made a speaker. */
  canTalk?: boolean;
  /** The session is on a read-only device: anyone may read it here, nobody may send, stop or fork. */
  readOnly?: boolean;
  /**
   * The session is a document assistant: `guest` (a display name) talks to
   * it, besides the owner; it is never forked, frozen or given speakers or
   * files here. `pinned`: it is in the document for every reader to watch.
   */
  assistant?: { guest: string; pinned: boolean };
}

export interface CardOrigin { kind: 'snapshot' | 'fork'; from: string; by: string; at: string }
/** Rows before a cursor, and where to continue further back (0: the conversation's start). */
export interface OlderRows { messages: TranscriptRow[]; next: number }
export type CardFrameReply = CardFrame | { rev: string; unchanged: true };

/** A message's lifecycle as the server words it. `at` is when it was submitted. */
export interface AgentOperation { id: string; status: string; message: string; live: boolean; at?: string }
/** A new card placed below this one: a snapshot, or a fork with its first message. `notice` says what did not happen. */
export interface PlacedCard { binding: Omit<CardBinding, 'v' | 'doc' | 'alias'>; operation?: AgentOperation; notice?: string }
/** Who besides the owner may talk to one agent in its cards. */
export interface SpeakersInfo { members: Array<{ username: string; name: string }>; candidates: Array<{ username: string; name: string }> }
/** The document a card's message is sent from, so the agent knows which one "this document" is. */
export interface MessageOrigin { doc: string; title: string }
export interface AddonLogin { token: string; username: string | null; expiresAt: number }
export interface ShareResult { binding: Omit<CardBinding, 'v' | 'doc' | 'alias'> }

// ── starting a new agent from a card ──

export type LaunchProvider = 'claude' | 'codex';
export interface LaunchChoice { value: string; label: string }
/** What the owner chose last time; the next form starts there. */
export interface LaunchDefaults {
  device?: string;
  directory?: string;
  provider: LaunchProvider;
  model: Record<LaunchProvider, string>;
  effort: Record<LaunchProvider, string>;
}
export interface LaunchOptions {
  devices: Array<{ device: string; label: string; online: boolean; providers: LaunchProvider[]; reason?: string }>;
  /** Recent working directories of the owner's sessions, newest first. */
  directories: Array<{ device: string; path: string; lastActivity?: string }>;
  models: Record<LaunchProvider, LaunchChoice[]>;
  efforts: Record<LaunchProvider, LaunchChoice[]>;
  defaults: LaunchDefaults;
}
export interface LaunchForm {
  device: string;
  directory: string;
  provider: LaunchProvider;
  model: string;
  effort: string;
  /** What the owner asks the new agent to do. */
  task: string;
  /** The card title readers see. */
  title: string;
  /** The document as the card sees it now: the agent's starting context. */
  doc?: string;
  docTitle?: string;
  /** The whole text, sent only when it fits one prompt (PROMPT_MAX_BYTES). */
  docText?: string;
  /** The text's UTF-8 size when it was too large to send; the agent is told to read it itself. */
  docBytes?: number;
  /** Stable per intent: a retry with the same id joins the first launch. */
  requestId: string;
}
export interface LaunchStatus { state: 'starting' | 'ready' | 'failed'; message: string; binding?: ShareResult['binding'] }

// ── workspace files ──

export interface WorkspaceMember { username: string; name: string }
/** The workspace that holds a session's directory, and who may read it. */
export interface WorkspaceInfo {
  device: string;
  workspace: { id: string; label: string; display?: string; shareable: boolean; reason?: string } | null;
  /** The session's directory inside the workspace ('' is the workspace root). */
  path?: string;
  members: WorkspaceMember[];
  /** Accounts the owner may grant: registered members with a Feishu identity. */
  candidates: WorkspaceMember[];
}
export interface FileEntry { name: string; path: string; dir: boolean; size?: number; modifiedAt?: string }
/**
 * One page of a directory. `next`, when present, continues it: send it back as
 * `after`. A bridge too old to page leaves `next` out even when `truncated`.
 */
export interface FileListing { kind: 'dir'; workspace: string; path: string; entries: FileEntry[]; truncated: boolean; next?: string }
export interface FileMeta { kind: 'file'; workspace: string; path: string; name: string; size: number; modifiedAt: string; mime: string }
/** A file's bytes travel as the response body; its description travels in this header. */
export const FILE_META_HEADER = 'x-octopus-file';
export type FileReply = (FileMeta & { data: Blob }) | FileListing;

export class AgentApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// ── document-share cards ──

/**
 * A document-share control card's Record (`octopusShare`). The anchor only
 * names the card to the bridge, which keeps the links bound to it and decides
 * who may list or change them; the Record carries no label, owner or document.
 */
export interface DocShareCard { v: 1; anchor: string }
/** The `octopusShare` Record as read: the card, or why it cannot be shown (written by a newer card, or broken). */
export type DocShareRecord = DocShareCard | { invalid: 'version' | 'malformed' };
/** `pending`: created, its command not yet taken; only the owner's reveal on the card makes it `active`. */
export type DocShareStatus = 'pending' | 'active' | 'paused' | 'terminated';
export type DocShareAction = 'pause' | 'resume' | 'terminate';
export type DocShareRights = 'read' | 'write';
/**
 * How a key was made: by the owner (through an agent, taken on the card), by
 * a reader on this card, or through the card's claim link. `assistant` is a
 * document assistant's own share: the bridge lists those under assistants,
 * but a bridge rolled back to before assistants lists them here, and the
 * card must still read.
 */
export type DocShareVia = 'owner' | 'card' | 'invite' | 'assistant';
/** The most a reader may take for themselves on this card; `off`: only the owner makes keys. */
export type DocShareSelfServe = 'off' | DocShareRights;
/** What the Octopus Feishu app itself may do in the document: every key runs as the app, so a write key writes only with `edit`. */
export type DocShareAppAccess = 'edit' | 'view' | 'none' | 'unknown';
/** One key that lets an external agent read (or also write) this document through Octopus over MCP. Times are ms epoch. */
export interface DocShareLink {
  id: string;
  label: string;
  rights: DocShareRights;
  status: DocShareStatus;
  created_at: number;
  last_used_at: number | null;
  via: DocShareVia;
  /** Taken on this card by the signed-in reader who asks. */
  mine: boolean;
}
/**
 * One key's ways in, each holding its token: shown once, kept in the card's
 * memory alone. `claude` and `codex` are one printable line each; other MCP
 * clients use `endpoint` with `Authorization: Bearer <token>`.
 */
export interface DocShareConnect { claude: string; codex: string; endpoint: string; token: string }
/** `share-reveal`: the owner, signed in on the card, takes a pending link's command. Once. */
export interface DocShareRevealRequest { anchor: string; share_id: string }
/** The link, now active, and its ways in: shown this once, never again. `command` is `connect.claude`, for cards that predate `connect`. */
export interface DocShareRevealReply { share: DocShareLink; command: string; connect: DocShareConnect }
/** `share-self`: a reader of the card takes a key for themselves, within the owner's `self_serve`. */
export interface DocShareSelfRequest { anchor: string; host_token: string; label: string; rights: DocShareRights }
/** The new key, already active, and its ways in: shown this once. */
export interface DocShareSelfReply { share: DocShareLink; connect: DocShareConnect }
/** The card's claim link, as its owner sees it: the link itself exists only in the answer that made it. */
export interface DocShareInvite { active: boolean; created_at: number | null }
/**
 * `share-invite`: the owner makes a new claim link (the old one stops) or
 * stops it. `link` — the claim page on the Octopus Dashboard, its secret in
 * the fragment — is in the `create` answer only.
 */
export interface DocShareInviteReply { invite: DocShareInvite; link?: string }
/** A share card's links as the bridge reports them (`share-panel`). */
export interface DocSharePanel {
  /** The document the links control. */
  document_id: string;
  /**
   * The bridge's judgement of the `host_token` the card sent (the token its
   * host reports, a docx or a wiki token): whether the card sits in the
   * controlled document. `false` is a card copied elsewhere; `null` means the
   * bridge cannot tell.
   */
  host_matches: boolean | null;
  /** Only the links' creator may pause, resume or terminate them. */
  viewer_is_owner: boolean;
  /**
   * The bridge's last check for this card in its document. `present`: found;
   * links work without another check until `lease_until`, after which their
   * next use checks again. `missing`: not found, so every link is already
   * stopped until a check finds the card again. `unknown`: never checked.
   */
  card_state: 'present' | 'missing' | 'unknown';
  lease_until: number | null;
  shares: DocShareLink[];
  self_serve: DocShareSelfServe;
  app_access: DocShareAppAccess;
  /** The Feishu app's own name, as the document's 「添加文档应用」 dialog lists it; null when the bridge could not learn it. */
  app_name: string | null;
  /** The owner's view of the claim link; null for everyone else. */
  invite: DocShareInvite | null;
  /** Self-served keys per card per hour, and keys not yet terminated per card. */
  limits: { per_hour: number; active_max: number };
  /** The card's document assistants, as every reader sees them. */
  assistant: AssistantSettings;
}

// ── document assistants ──

/** The registered workspace a card's assistants read (never write), on the owner's device that runs them. */
export interface AssistantProject { device: string; workspace_id: string; label: string }
/**
 * Whether a signed-in reader may start their own assistant here, and with
 * what: `rights` is what the assistant may do to this document (null: the
 * owner has not turned assistants on); `project` what it may read.
 */
export interface AssistantSettings {
  rights: DocShareRights | null;
  project: AssistantProject | null;
  limits: { per_card: number; per_guest: number; per_guest_per_day: number };
}
/** One of the owner's devices assistants could run on, with its registered workspaces (Home never listed). */
export interface AssistantTarget { device: string; label: string; eligible: boolean; reason?: string; workspaces: Array<{ workspace_id: string; label: string }> }
export type AssistantState = 'starting' | 'ready' | 'failed' | 'ended';
/** One assistant, as its guest (who sees their own) or the owner (who sees all) does. Times are ms epoch. */
export interface AssistantView {
  id: string;
  title: string;
  /** Who it works for: the name they gave. */
  guest: string;
  mine: boolean;
  state: AssistantState;
  /** Why it failed or ended, or what it is waiting for; may be empty. */
  message: string;
  rights: DocShareRights;
  created_at: number;
  ended_at: number | null;
  pinned: boolean;
}
/** An assistant and, once `ready`, the Agent card over its session that the side panel shows (`share` is its `ds_` capability). */
export interface AssistantStatus extends AssistantView {
  binding?: { share: string; title: string; owner: string; device: string; provider: 'claude' };
}

export interface AgentApi {
  /** Signs in with a fresh one-time Feishu code; other calls do this on demand. */
  login(): Promise<AddonLogin>;
  sessions(): Promise<{ sessions: SessionChoice[]; notice?: string }>;
  /**
   * A new capability for one of the caller's sessions, or for the session
   * behind a card they shared before. `docTitle` only labels the owner's notice.
   */
  share(input: ({ resourceId: string; title: string } | { from: string }) & { docTitle?: string }): Promise<ShareResult>;
  unshare(input: { share: string } | { resourceId: string }): Promise<{ revoked: number }>;
  view(share: string, since: string, after: number): Promise<CardFrameReply>;
  /** Rows before absolute index `before` (the frame keeps only the newest). */
  older(share: string, before: number): Promise<OlderRows>;
  /** One message's whole text (a row marked `cut`). */
  message(share: string, index: number): Promise<{ i: number; text: string }>;
  /** The owner has now seen the agent's replies up to `at` (the newest reply's timestamp). */
  read(share: string, at: string): Promise<{ ok: true }>;
  send(share: string, prompt: string, requestId: string, origin?: MessageOrigin): Promise<AgentOperation>;
  stop(share: string, requestId: string): Promise<AgentOperation>;
  operation(id: string): Promise<AgentOperation>;
  /** Freezes this card's agent at its last completed turn into a snapshot card placed below (owner only). */
  snapshot(share: string, doc: string): Promise<PlacedCard>;
  /** Branches this card's agent (a snapshot: at its moment) into a new agent with its own card below, and sends it `prompt`. */
  fork(share: string, prompt: string, requestId: string, origin?: MessageOrigin): Promise<PlacedCard>;
  /** Who besides the owner may talk to this card's agent (owner only). */
  speakers(share: string): Promise<SpeakersInfo>;
  setSpeakers(share: string, members: string[]): Promise<SpeakersInfo>;
  /** Devices, directories, models and efforts the owner can start a new agent with. */
  launchOptions(): Promise<LaunchOptions>;
  /** Starts a new agent; poll `launchStatus` until it is ready to place. */
  launch(form: LaunchForm): Promise<{ id: string }>;
  launchStatus(id: string): Promise<LaunchStatus>;
  /** The workspace that holds this card's session, and who may read it (owner only). */
  workspace(share: string): Promise<WorkspaceInfo>;
  grantWorkspace(share: string, workspace: string, members: string[]): Promise<WorkspaceInfo>;
  /** A file or directory the agent mentioned, if the reader may open it. */
  /** `after` continues a directory listing from the previous page's `next`. */
  file(share: string, path: string, after?: string): Promise<FileReply>;
  /** The board behind a board card; `since` is the version shown, answered "unchanged" when current. */
  board(board: string, since: string): Promise<BoardReply>;
  /** The owner stops sharing a board (the card then clears its Record). */
  unboard(board: string): Promise<{ revoked: boolean }>;
  /** The document-share links bound to a share card; `hostToken` is the document the host reports, for the bridge to match. */
  sharePanel(anchor: string, hostToken?: string): Promise<DocSharePanel>;
  /**
   * Pauses or resumes one of them (their creator only), or terminates one
   * (any reader of the card; a pending link is only terminated). `hostToken`
   * is the document the host reports: a reader's terminate counts only when
   * the bridge finds the card in the document whose keys it ends.
   */
  shareAction(anchor: string, shareId: string, action: DocShareAction, hostToken?: string): Promise<{ share: DocShareLink }>;
  /** Activates a pending link and returns its command, once (their creator only). The caller keeps the command in memory alone. */
  shareReveal(anchor: string, shareId: string): Promise<DocShareRevealReply>;
  /** Takes a key for the reader, within the card's `self_serve`; signed in or not. The answer holds its token. */
  shareSelf(anchor: string, hostToken: string, label: string, rights: DocShareRights): Promise<DocShareSelfReply>;
  /** The owner sets how much readers may take for themselves; answers the panel as it is now. */
  shareSettings(anchor: string, selfServe: DocShareSelfServe, hostToken?: string): Promise<DocSharePanel>;
  /** The owner makes (or stops) the card's claim link. */
  shareInvite(anchor: string, op: 'create' | 'revoke'): Promise<DocShareInviteReply>;
  /** The owner's devices and workspaces assistants could use. */
  assistantTargets(): Promise<{ devices: AssistantTarget[] }>;
  /** The owner turns the card's assistants on (with a project) or off (`rights` null ends every live one). */
  assistantConfigure(anchor: string, config: { rights: DocShareRights | null; device?: string; workspace_id?: string }): Promise<AssistantSettings>;
  /** The reader's own assistants on this card (the owner: everyone's), newest first. */
  assistantList(anchor: string): Promise<{ assistants: AssistantView[] }>;
  /** Starts the reader's own assistant with its first task; `name` is how it will address them. */
  assistantStart(anchor: string, hostToken: string, task: string, requestId: string, name: string): Promise<{ id: string }>;
  assistantStatus(id: string): Promise<AssistantStatus>;
  assistantEnd(id: string): Promise<AssistantView>;
  /** Puts the reader's assistant into the document as a live card right below the control card. */
  assistantPin(id: string): Promise<{ block: string }>;
  disconnect(): void;
}

export interface HostSnapshot {
  doc: string;
  editable: boolean;
  binding: CardBinding | null;
  /** Present when this card is a board rather than an Agent. */
  board: BoardBinding | null;
  /** Present when this card controls document-share links rather than showing an Agent. */
  docShare: DocShareRecord | null;
  /** Rendered as the attached side FloatCard rather than inline or in the large modal. */
  float: boolean;
  /** False while the inline card is scrolled out of view: nothing needs syncing then. */
  visible: boolean;
  dark: boolean;
}

export interface DocsHost {
  readonly surface: 'inline' | 'modal' | 'float';
  initialize(change: (snapshot: HostSnapshot) => void): Promise<HostSnapshot>;
  loginCode(): Promise<string>;
  /** Writes (or clears) this card's binding in the shared document Record. */
  bind(binding: Omit<CardBinding, 'v' | 'doc'> | null): Promise<HostSnapshot>;
  /** Clears a board card's Record, leaving an empty card. */
  clearBoard(): Promise<HostSnapshot>;
  /** The large reading view (host modal); `file` opens it on that file. */
  expand(title: string, file?: string): Promise<void>;
  /** The file this modal view was opened on, read once. */
  takeExpandedFile(): string | null;
  /** The document's title, for labels and the owner's notices. */
  documentTitle(): Promise<string>;
  /** The document as Markdown: a new agent's starting context. */
  documentText(): Promise<string>;
  /** The narrow side panel that stays open while the document scrolls. */
  float(): Promise<void>;
  open(url: string): Promise<void>;
  /** Asks the host to show the inline card this tall (px), so it neither clips nor leaves a blank tail; a no-op elsewhere. */
  fitHeight(height: number): Promise<void>;
  /** The reader's Feishu display name, to prefill a key's name; empty when the host will not say. */
  readerName(): Promise<string>;
  close(): Promise<void>;
}

const LABEL = 240;
export function parseBinding(value: unknown): CardBinding | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  if (b.v !== 2 || typeof b.share !== 'string' || !/^ds_[A-Za-z0-9_-]{43}$/.test(b.share)) return null;
  const text = (key: string) => typeof b[key] === 'string' ? (b[key] as string).slice(0, LABEL) : '';
  if (!text('doc')) return null;
  return { v: 2, share: b.share, title: text('title') || 'Agent 会话', owner: text('owner'), device: text('device'), provider: text('provider'), doc: text('doc'),
    ...(text('alias') ? { alias: text('alias') } : {}) };
}

export function parseBoard(value: unknown): BoardBinding | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  if (b.v !== 1 || typeof b.board !== 'string' || !/^db_[A-Za-z0-9_-]{43}$/.test(b.board)) return null;
  const text = (key: string) => typeof b[key] === 'string' ? (b[key] as string).slice(0, LABEL) : '';
  if (!text('doc')) return null;
  return { v: 1, board: b.board, title: text('title') || '看板', owner: text('owner'), doc: text('doc'), ...(text('alias') ? { alias: text('alias') } : {}) };
}

/** `dsa_` and URL-safe base64. The bridge chooses the length; the card only bounds it. */
const ANCHOR = /^dsa_[A-Za-z0-9_-]{16,128}$/;
/**
 * A share card's Record value. `undefined` (no `octopusShare` key) is not a
 * share card; anything else under that key is one, shown as an error when
 * it cannot be read, never as an empty Agent card.
 */
export function parseDocShare(value: unknown): DocShareRecord | null {
  if (value === undefined) return null;
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof r.v === 'number' && Number.isInteger(r.v) && r.v > 1) return { invalid: 'version' };
  return r.v === 1 && typeof r.anchor === 'string' && ANCHOR.test(r.anchor) ? { v: 1, anchor: r.anchor } : { invalid: 'malformed' };
}

const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T => (options as readonly unknown[]).includes(value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** One link as the bridge sent it, or null when it does not follow the contract. */
export function readDocShareLink(value: unknown): DocShareLink | null {
  const s = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof s.id !== 'string' || !s.id || typeof s.label !== 'string' || !oneOf(s.rights, ['read', 'write'] as const)
    || !oneOf(s.status, ['pending', 'active', 'paused', 'terminated'] as const) || !isTime(s.created_at) || !(s.last_used_at === null || isTime(s.last_used_at))
    || !oneOf(s.via, ['owner', 'card', 'invite', 'assistant'] as const) || typeof s.mine !== 'boolean') return null;
  return { id: s.id, label: s.label.slice(0, LABEL), rights: s.rights, status: s.status, created_at: s.created_at, last_used_at: s.last_used_at, via: s.via, mine: s.mine };
}

const malformedReply = () => new AgentApiError(502, 'Octopus 返回的共享链接格式不对');
const readInvite = (value: unknown): DocShareInvite | undefined => {
  const i = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return typeof i.active === 'boolean' && (i.created_at === null || isTime(i.created_at)) ? { active: i.active, created_at: i.created_at } : undefined;
};
/** The `share-panel` reply, checked against the contract: a reply that breaks it fails clearly instead of breaking the card. */
export function readDocSharePanel(value: unknown): DocSharePanel {
  const p = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const shares = Array.isArray(p.shares) ? p.shares.map(readDocShareLink) : [null];
  // A bridge that says nothing about the host token has not matched it: that is `null`, not an error.
  const hostMatches = p.host_matches ?? null;
  const invite = p.invite === null ? null : readInvite(p.invite);
  const limits = p.limits && typeof p.limits === 'object' ? p.limits as Record<string, unknown> : {};
  // A bridge from before assistants says nothing about them: that is "off", not an error.
  const assistant = p.assistant === undefined ? ASSISTANTS_OFF : readAssistantSettingsValue(p.assistant);
  if (typeof p.document_id !== 'string' || !(hostMatches === null || typeof hostMatches === 'boolean') || typeof p.viewer_is_owner !== 'boolean'
    || !oneOf(p.card_state, ['present', 'missing', 'unknown'] as const) || !(p.lease_until === null || isTime(p.lease_until))
    || !shares.every((s): s is DocShareLink => s !== null)
    || !oneOf(p.self_serve, ['off', 'read', 'write'] as const) || !oneOf(p.app_access, ['edit', 'view', 'none', 'unknown'] as const)
    || !(p.app_name === null || typeof p.app_name === 'string') || invite === undefined
    || !isTime(limits.per_hour) || !isTime(limits.active_max) || !assistant) throw malformedReply();
  return {
    document_id: p.document_id, host_matches: hostMatches, viewer_is_owner: p.viewer_is_owner, card_state: p.card_state, lease_until: p.lease_until, shares,
    self_serve: p.self_serve, app_access: p.app_access, app_name: p.app_name === null ? null : p.app_name.slice(0, LABEL), invite,
    limits: { per_hour: limits.per_hour, active_max: limits.active_max }, assistant,
  };
}

const malformedAssistant = () => new AgentApiError(502, 'Octopus 返回的文档助手数据格式不对');
const ASSISTANTS_OFF: AssistantSettings = { rights: null, project: null, limits: { per_card: 0, per_guest: 0, per_guest_per_day: 0 } };
const text = (value: unknown): value is string => typeof value === 'string';
function readAssistantSettingsValue(value: unknown): AssistantSettings | null {
  const a = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const project = a.project && typeof a.project === 'object' ? a.project as Record<string, unknown> : null;
  const limits = a.limits && typeof a.limits === 'object' ? a.limits as Record<string, unknown> : {};
  if (!(a.rights === null || oneOf(a.rights, ['read', 'write'] as const)) || !(a.project === null || (project && text(project.device) && text(project.workspace_id) && text(project.label)))
    || !isTime(limits.per_card) || !isTime(limits.per_guest) || !isTime(limits.per_guest_per_day)) return null;
  return {
    rights: a.rights, project: project ? { device: String(project.device), workspace_id: String(project.workspace_id), label: String(project.label).slice(0, LABEL) } : null,
    limits: { per_card: limits.per_card, per_guest: limits.per_guest, per_guest_per_day: limits.per_guest_per_day },
  };
}
/** The `assistant-configure` reply. */
export function readAssistantSettings(value: unknown): AssistantSettings {
  const settings = readAssistantSettingsValue(value);
  if (!settings) throw malformedAssistant();
  return settings;
}
/** The `assistant-targets` reply. */
export function readAssistantTargets(value: unknown): { devices: AssistantTarget[] } {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const devices = Array.isArray(r.devices) ? r.devices.map((value): AssistantTarget | null => {
    const d = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const workspaces = Array.isArray(d.workspaces) ? d.workspaces.map((w) => {
      const x = w && typeof w === 'object' ? w as Record<string, unknown> : {};
      return text(x.workspace_id) && text(x.label) ? { workspace_id: x.workspace_id, label: x.label.slice(0, LABEL) } : null;
    }) : [null];
    if (!text(d.device) || !text(d.label) || typeof d.eligible !== 'boolean' || !(d.reason === undefined || text(d.reason))
      || !workspaces.every((w): w is { workspace_id: string; label: string } => w !== null)) return null;
    return { device: d.device, label: d.label.slice(0, LABEL), eligible: d.eligible, ...(text(d.reason) ? { reason: d.reason.slice(0, 300) } : {}), workspaces };
  }) : [null];
  if (!devices.every((d): d is AssistantTarget => d !== null)) throw malformedAssistant();
  return { devices };
}
function readAssistantViewValue(value: unknown): AssistantView | null {
  const a = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!text(a.id) || !a.id || !text(a.title) || !text(a.guest) || typeof a.mine !== 'boolean' || !oneOf(a.state, ['starting', 'ready', 'failed', 'ended'] as const)
    || !text(a.message) || !oneOf(a.rights, ['read', 'write'] as const) || !isTime(a.created_at) || !(a.ended_at === null || isTime(a.ended_at))
    || typeof a.pinned !== 'boolean') return null;
  return { id: a.id, title: a.title.slice(0, LABEL), guest: a.guest.slice(0, LABEL), mine: a.mine, state: a.state, message: a.message.slice(0, 2000),
    rights: a.rights, created_at: a.created_at, ended_at: a.ended_at, pinned: a.pinned };
}
/** The `assistant-end` reply. */
export function readAssistantView(value: unknown): AssistantView {
  const view = readAssistantViewValue(value);
  if (!view) throw malformedAssistant();
  return view;
}
/** The `assistant-list` reply. */
export function readAssistantList(value: unknown): { assistants: AssistantView[] } {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const assistants = Array.isArray(r.assistants) ? r.assistants.map(readAssistantViewValue) : [null];
  if (!assistants.every((a): a is AssistantView => a !== null)) throw malformedAssistant();
  return { assistants };
}
/** The `assistant-status` reply; a `binding` must name an Agent card capability exactly as a card Record would. */
export function readAssistantStatus(value: unknown): AssistantStatus {
  const view = readAssistantViewValue(value);
  const b = value && typeof value === 'object' ? (value as Record<string, unknown>).binding : undefined;
  if (!view) throw malformedAssistant();
  if (b === undefined) return view;
  const x = b && typeof b === 'object' ? b as Record<string, unknown> : {};
  if (!text(x.share) || !/^ds_[A-Za-z0-9_-]{43}$/.test(x.share) || !text(x.title) || !text(x.owner) || !text(x.device) || x.provider !== 'claude') throw malformedAssistant();
  return { ...view, binding: { share: x.share, title: x.title.slice(0, LABEL), owner: x.owner.slice(0, LABEL), device: x.device.slice(0, LABEL), provider: 'claude' } };
}
/** The `assistant-start` reply. */
export function readAssistantStarted(value: unknown): { id: string } {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!text(r.id) || !r.id) throw malformedAssistant();
  return { id: r.id };
}
/** The `assistant-pin` reply. */
export function readAssistantPinned(value: unknown): { block: string } {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!text(r.block) || !r.block) throw malformedAssistant();
  return { block: r.block };
}

/** The `share-action` reply: the link as it is now. */
export function readDocShareActionReply(value: unknown): { share: DocShareLink } {
  const share = readDocShareLink(value && typeof value === 'object' ? (value as { share?: unknown }).share : undefined);
  if (!share) throw malformedReply();
  return { share };
}

/** At most this long; a reply's command is pasted into a terminal, so it must also be one printable line. */
const COMMAND_MAX = 8192;
/**
 * The `share-reveal` reply: the link, now active, and its one-line command.
 * The command holds the link's token; an error raised here never quotes it.
 */
export function readDocShareRevealReply(value: unknown): DocShareRevealReply {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const share = readDocShareLink(r.share);
  const command = r.command;
  const connect = readConnect(r.connect);
  if (!share || !oneLine(command) || !connect) throw malformedReply();
  return { share, command, connect };
}

const oneLine = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= COMMAND_MAX && !/[\u0000-\u001f\u007f]/.test(value);
/** A key's ways in, each one printable line. An error raised here never quotes them. */
function readConnect(value: unknown): DocShareConnect | null {
  const c = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!oneLine(c.claude) || !oneLine(c.codex) || !oneLine(c.endpoint) || !oneLine(c.token) || !c.endpoint.startsWith('https://')) return null;
  return { claude: c.claude, codex: c.codex, endpoint: c.endpoint, token: c.token };
}

/** The `share-self` reply: the new key and its ways in. */
export function readDocShareSelfReply(value: unknown): DocShareSelfReply {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const share = readDocShareLink(r.share);
  const connect = readConnect(r.connect);
  if (!share || !connect) throw malformedReply();
  return { share, connect };
}

/** An https claim page whose fragment holds the claim secret, and nothing else after it. */
const INVITE_LINK = /^https:\/\/[^\s#]+#i=dsi_[A-Za-z0-9_-]{43}$/;
/** The `share-invite` reply; a `create` answer carries the claim link, once. */
export function readDocShareInviteReply(value: unknown): DocShareInviteReply {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const invite = readInvite(r.invite);
  if (!invite || !(r.link === undefined || (oneLine(r.link) && INVITE_LINK.test(r.link)))) throw malformedReply();
  return { invite, ...(typeof r.link === 'string' ? { link: r.link } : {}) };
}

/** Whether a card's Record was written for the document it is in now (not a copy). */
export function bindingIsFor(binding: Pick<CardBinding, 'doc' | 'alias'>, doc: string): boolean {
  return binding.doc === doc || binding.alias === doc;
}

/** Applies one frame to the rows already shown; rows are keyed by absolute index. */
export function mergeRows(current: readonly TranscriptRow[], frame: Pick<CardFrame, 'reset' | 'messages'>): TranscriptRow[] {
  if (frame.reset || !frame.messages.length) return frame.reset ? frame.messages : current as TranscriptRow[];
  const from = frame.messages[0].i;
  return [...current.filter((row) => row.i < from), ...frame.messages];
}
