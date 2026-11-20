/**
 * Feishu Docs Agent card: one Octopus session shown inside a Feishu document.
 *
 *  - The session's owner, signed in with Feishu, reads and operates it.
 *  - Every other signed-in member of the configured tenant observes it read-only.
 *
 * Observation is the owner's explicit, revocable act. `share` stores only the
 * SHA-256 of a fresh capability; the card keeps the capability in its document
 * Record, so "who may watch" is "who can read that card". `view` serves a
 * plain-text projection of that one session on the owner's behalf — the same
 * pattern as a dev ticket's read-only transcript lease: the owner and device
 * come from the stored row, never from the caller. Input never rides on the
 * capability: `send` and `stop` require the caller's own login to be the owner
 * and go through the durable operation coordinator unchanged.
 *
 * Every viewer of one share reads one shared tail (Session Hub `liveGrant` +
 * `openRunnerTail`, the primitives behind the Dashboard's live transcript): one
 * Context and one audit row per watch, at most one device read per REFRESH_MS,
 * closed after IDLE_MS without a viewer.
 *
 * Beyond the card itself (2026-10-18): the owner's agents place sessions into
 * documents (`place`), the owner starts new agents from a card or an agent
 * (`launch`, `startForAgent`), and readers open files the agent mentions inside
 * workspaces the owner granted them (`file`, `grantWorkspace`). None of these
 * raise approval cards; the owner is notified in Feishu of every one instead.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { activityPhase } from '@claude-bot/agent-sessions-contract';
import type {
  AgentOperation, AgentStatus, AssistantSettings, AssistantStatus, AssistantTarget, AssistantView, BoardReply, CardFrame, CardFrameReply, CardOrigin,
  LaunchStatus, OlderRows, PlacedCard, SessionChoice, ShareResult, SpeakersInfo, TranscriptRow, WorkspaceInfo,
} from '@claude-bot/feishu-docs-addon/protocol';
import { MACHINE_LIMITS } from '@claude-bot/runner/limits';
import type { HubPrincipal, HubSessionSummary, SessionHubService } from '../sessionhub/service.js';
import type { SessionOperationCoordinator, SessionOperationView } from '../sessionhub/operations.js';
import { openRunnerTail, type TailSource, type TailState } from '../sessionhub/runner-tail.js';
import { ApprovalRequiredError } from '../runner/account-authority.js';
import type { FeishuDocsOrigin, FeishuDocsShare, FeishuDocsSharesRepository, FeishuDocsSnapshot, FeishuDocsSpeakersRepository } from '../store/repositories/feishu-docs-shares.js';
import { resourceId } from '../sessionhub/core.js';
import type { WorkspaceGrantsRepository } from '../store/repositories/workspace-grants.js';
import { DocsAddonError, FeishuDocsAddonAuth, type DocsAddonIdentity } from './docs-addon-auth.js';
import { collectDocsFile, type DocsWorkspaceFiles, type DocsFileContent } from './docs-files.js';
import { LAUNCH_DEFAULTS_KEY, readDefaults, type DocsLauncher, type LaunchOptions, type LaunchProvider, type LaunchReceipt } from './docs-launch.js';
import type { DocsNotifier } from './docs-notify.js';
import { atFirstSlot, blockIdsOf, cardBlock, cardRecord, cardSlots, findDocument, insertCard, outlinePage, parseDocumentRef, writeMarkdown, type BlockSlot, type DocTarget, type FeishuDocsClient } from './docs-openapi.js';
import type {
  DocShareAction, DocShareInviteInfo, DocShareInviteView, DocSharePanelView, DocShareRevealView, DocShareSelfView, DocShareViewer, FeishuDocShareService,
} from './doc-share.js';
import type { FeishuDocsBoard, FeishuDocsBoardsRepository } from '../store/repositories/feishu-docs-boards.js';
import type { DocAssistant } from '../store/repositories/feishu-doc-assistants.js';
import { verifiedGuestName, type FeishuDocAssistants } from './doc-assistants.js';

export const REFRESH_MS = 1500;
export const IDLE_MS = 60_000;
/** A failed read waits this long, doubling, before the watch resolves a fresh read path. */
export const RETRY_MS = 2000;
const RETRY_MAX_MS = 60_000;
/** Cards watched at once across the whole service; each holds one Context and reads one device. */
export const MAX_WATCHES = 64;
const WINDOW = 120;
/** Pages a snapshot reaches back for its turn: an agent can be hundreds of messages into the next one. */
const SNAPSHOT_PAGES = 10;
/**
 * A frame's window: each message carries at most MAX_TEXT characters (marked
 * `cut`, the rest one `message` read away) and a frame at most MAX_FRAME_TEXT
 * (older rows one `older` read away). The conversation itself is not bounded.
 */
const MAX_TEXT = 12_000;
const MAX_FRAME_TEXT = 300_000;
/** History reads one card may have in flight at once. */
const MAX_HISTORY_READS = 2;
const CAPABILITY = /^ds_[A-Za-z0-9_-]{43}$/;
const BOARD_CAPABILITY = /^db_[A-Za-z0-9_-]{43}$/;
/** A board is one self-contained page: generous for tables and inline SVG, small enough to poll. */
const MAX_BOARD_HTML = 200_000;
/**
 * How much of one image the bot holds while inserting it. Not Feishu's limit:
 * Feishu takes 20 MB per request and larger images in 4 MB parts
 * (`FeishuDocsClient.uploadMedia`). It bounds one buffered copy in this
 * process; feeding the device's file windows straight into the parts would
 * remove it.
 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const REQUEST_ID = /^[0-9a-f-]{36}$/i;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** A signed-in reader as the assistants see them: the verified Feishu identity, and the mapped account if any. */
const callerOf = (identity: DocsAddonIdentity) => ({ openId: identity.openId, username: identity.username });
/** A card reader as the share service sees them: who they are, never their login's credentials. */
const viewerOf = (identity: DocsAddonIdentity | null): DocShareViewer | null => identity ? { openId: identity.openId, username: identity.username } : null;

type Hub = Pick<SessionHubService, 'roster' | 'liveGrant' | 'decodeResourceId'>;
type Operations = Pick<SessionOperationCoordinator, 'submit' | 'get'>;
type Session = NonNullable<ReturnType<Hub['decodeResourceId']>>;
const LAUNCH_WAIT_MS = 90_000;
/** An agent's tool call waits less than common MCP client timeouts (Codex: 60 s). */
const AGENT_WAIT_MS = 45_000;
/** How long the new-agent form waits for recent directories before showing without them. */
const ROSTER_WAIT_MS = 4_000;
const MAX_LAUNCHES = 256;
const SETTINGS_KEY = LAUNCH_DEFAULTS_KEY;

/** The session an agent's MCP call came from, as the trusted transport reported it (never an argument). */
export interface CallerSession { device: string; source: string; sessionId: string }

/** The document-facing powers beyond the card itself; each is absent when its plane is not composed. */
export interface DocsAddonExtras {
  /** Feishu document calls as the owner (OpenAPI user token). */
  docs?: FeishuDocsClient;
  /** The widget's block type id: what an OpenAPI-inserted card block is. */
  componentTypeId?: string;
  notifier?: DocsNotifier;
  launcher?: DocsLauncher;
  files?: DocsWorkspaceFiles;
  grants?: WorkspaceGrantsRepository;
  /** Accounts an owner may grant workspace reads to: registered users with a Feishu identity. */
  members?: () => Array<{ username: string; name: string }>;
  settings?: { get(owner: string, key: string): string | undefined; set(owner: string, key: string, value: string): void };
  /** Boards: visual cards an owner's agents publish and update. */
  boards?: FeishuDocsBoardsRepository;
  /** Members an owner lets talk to one of their agents in its cards. */
  speakers?: FeishuDocsSpeakersRepository;
  /** The device reported itself read-only: it lists and reads sessions and refuses sending, forking and the rest. */
  readOnly?: (owner: string, device: string) => boolean;
  /** Document share links: an owner's collaborators' agents on one document, as the app (`doc-share.ts`). */
  docShares?: FeishuDocShareService;
  /**
   * Document assistants (`doc-assistants.ts`): a card that shows one is
   * watched by its guest and the owner until pinned, talked to by them only
   * (the guest through per-call grants, never the owner's Session Hub), and
   * never forked, snapshotted, given speakers or opening workspace files.
   */
  assistants?: FeishuDocAssistants;
}

/** A message or stop a document assistant's guest sent from a card, followed through the device's receipt. */
interface GuestTalk {
  owner: string;
  device: string;
  openId: string;
  operation: 'append_session' | 'interrupt_session';
  view: AgentOperation;
  at: string;
  checkedAt: number;
  refreshing?: Promise<void>;
}

interface Launch {
  owner: string;
  device: string;
  provider: LaunchProvider;
  operationId: string;
  title: string;
  model: string;
  effort: string;
  directory: string;
  docTitle?: string;
  at: number;
  binding?: ShareResult['binding'];
  error?: string;
  settling?: Promise<LaunchStatus>;
}

interface Watch {
  share: FeishuDocsShare;
  session: Session;
  /** The open read path: one Session Hub live grant and its tail. Dropped after a failed read. */
  source: { tail: TailSource; close(): void } | null;
  counter: number;
  offset: number;
  total: number;
  rows: TranscriptRow[];
  activity?: TailState['activity'];
  /** The Runner's declassified turn facts (turn state, turn start, a pending question). */
  runtime?: unknown;
  /** Why the shown transcript may be old. */
  error?: string;
  /** An approval was requested: never read again while this watch lives, so no more approvals are raised. */
  blocked: boolean;
  failures: number;
  retryAt: number;
  fetchedAt: number;
  seenAt: number;
  inflight?: Promise<void>;
}

export class FeishuDocsAddonService {
  private readonly watches = new Map<string, Watch>();
  /** History reads (`older`, `message`) in flight per share: each is one device read as the owner. */
  private readonly history = new Map<string, number>();
  private readonly launches = new Map<string, Launch>();
  /** Operations a speaker started from a card, so they can follow them: operation id → the agent's owner and the speaker. */
  private readonly talks = new Map<string, { owner: string; member: string }>();
  /** A fork request joins the one already running for the same speaker and request id. */
  private readonly forks = new Map<string, Promise<PlacedCard>>();
  /** What document assistants' guests sent from cards, by operation id. */
  private readonly guestTalks = new Map<string, GuestTalk>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    readonly auth: FeishuDocsAddonAuth,
    private readonly hub: Hub,
    private readonly operations: Operations,
    private readonly shares: FeishuDocsSharesRepository,
    private readonly displayName: (username: string) => string = (username) => username,
    private readonly now: () => number = Date.now,
    private readonly extras: DocsAddonExtras = {},
  ) {
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  /** Document assistants, for the add-on routes; null when not composed. */
  get assistants(): FeishuDocAssistants | null {
    return this.extras.assistants ?? null;
  }

  // ── the owner chooses and shares ──

  async sessions(identity: DocsAddonIdentity): Promise<{ sessions: SessionChoice[]; notice?: string }> {
    const owner = this.owner(identity);
    const result = await this.hub.roster(this.principal(identity), owner, { limit: 100, source: 'all', includeSessionPlus: true });
    this.auth.assertLive(identity);
    const counts = this.shares.liveCounts(owner);
    const canAppend = result.permissions.effective.includes('append_session');
    return {
      sessions: result.sessions.map((s) => ({
        resourceId: s.resourceId,
        // The provider title or the first instruction names a session; the last message only says where it is.
        title: label(s.title || s.first_user_text || s.preview || s.sessionId),
        ...(s.preview ? { preview: label(s.preview) } : {}),
        device: s.deviceLabel,
        provider: s.cliKind,
        ...(s.projectLabel ? { project: s.projectLabel } : {}),
        ...(s.sortActivity ?? s.lastActivity ? { lastActivity: s.sortActivity ?? s.lastActivity } : {}),
        working: s.status === 'live',
        canSend: canAppend && s.resumable && s.inputMode !== 'parent_owned',
        shared: counts.get(s.resourceId) ?? 0,
      })),
      ...(result.restricted ? { notice: result.restricted.explanation } : result.errors?.length ? { notice: '部分设备暂不可用，列表可能不完整' } : {}),
    };
  }

  /**
   * Mints a new card capability for one of the caller's own sessions — chosen
   * from the roster, or carried over from a card the caller shared before (a
   * copied or revoked card). Replacing a card's session is "share, write the
   * Record, then unshare the old one", so a failed Record write never leaves
   * the card pointing at a revoked share.
   */
  share(identity: DocsAddonIdentity, input: { resourceId?: string; title?: string; from?: string; docTitle?: string }): ShareResult {
    const owner = this.owner(identity);
    let resource: string;
    let title: string;
    if (input.from) {
      const source = this.shares.get(this.capabilityId(input.from));
      if (!source || source.owner !== owner) throw new DocsAddonError(403, '只有这个会话的所有者可以重新共享');
      ({ resource, title } = source);
    } else {
      resource = input.resourceId ?? '';
      title = label(input.title || 'Agent 会话');
    }
    const result = this.mint(owner, resource, title);
    this.notify(owner, { kind: 'placed', actor: this.displayName(owner), via: 'card', session: title, device: result.binding.device,
      provider: result.binding.provider, doc: { ...(input.docTitle ? { title: label(input.docTitle) } : {}) } });
    return result;
  }

  /** Ends one card (`share`) or every card showing one session (`resourceId`). */
  unshare(identity: DocsAddonIdentity, input: { share?: string; resourceId?: string }): { revoked: number } {
    const owner = this.owner(identity);
    const target: { id: string } | { resource: string } | null = input.share ? { id: this.capabilityId(input.share) } : input.resourceId ? { resource: input.resourceId } : null;
    if (!target) throw new DocsAddonError(400, '缺少要停止共享的卡片或会话');
    const title = 'id' in target ? this.shares.get(target.id)?.title : undefined;
    const revoked = this.end(owner, target);
    if (revoked) this.notify(owner, { kind: 'removed', actor: this.displayName(owner), session: title ?? this.sessionLabel(owner, target), cards: revoked });
    return { revoked };
  }

  // ── an owner's agent places a session into a document ──

  /**
   * The agent-facing twin of the card's own picker: mints a share for one of
   * the owner's sessions and inserts a card block carrying it into a document,
   * as the owner, through the Feishu OpenAPI. Feishu decides whether the owner
   * may edit that document. A failed insert revokes the share it minted.
   *
   * `after` puts the card right after a passage of the document (see
   * `slotsAfter`); a parent Feishu refuses to hold a card in sends it one level
   * out, so it lands at the nearest place Feishu accepts.
   */
  async place(owner: string, input: PlaceInput, caller?: CallerSession): Promise<{
    document: { title: string; url?: string; id: string }; card: { block: string; title: string; after?: string }; session: { resource_id: string; title: string; device: string; provider: string };
  }> {
    const { docs, componentTypeId } = this.cardPlane();
    const target = await findDocument(docs, owner, input.document);
    const chosen = await this.choose(owner, input.session, caller);
    const { slots, anchor } = await cardSlots(docs, owner, target, input);
    const title = label(input.title || chosen.title);
    const chosenSession = this.hub.decodeResourceId(chosen.resource);
    // A snapshot keeps the conversation through its last completed turn: for an
    // agent placing itself, the turn before the one asking for the snapshot.
    const snapshot = input.snapshot && chosenSession ? await this.freeze(owner, chosenSession) : undefined;
    const { binding } = this.mint(owner, chosen.resource, title,
      snapshot ? { snapshot, origin: { kind: 'snapshot', from: chosen.title, by: owner, at: this.now() } } : {});
    const record = { octopusAgent: { v: 2, ...binding, doc: target.documentId, ...(target.wikiToken ? { alias: target.wikiToken } : {}) } };
    let block: string;
    try {
      block = await insertCard(docs, owner, target.documentId, componentTypeId, record, slots, binding.share);
    } catch (error) {
      this.end(owner, { id: digest(binding.share) });
      throw error;
    }
    this.notify(owner, { kind: 'placed', actor: this.agentName(owner, caller), via: 'agent', session: snapshot ? `${title}（快照）` : title, device: binding.device, provider: binding.provider,
      doc: docRef(target) });
    return {
      document: { title: target.title, id: target.documentId, ...(target.url ? { url: target.url } : {}) },
      card: { block, title, ...(anchor ? { after: excerpt(anchor.text) || anchor.id } : {}), ...(snapshot ? { snapshot_at: snapshot.at } : {}) },
      session: { resource_id: chosen.resource, title: chosen.title, device: binding.device, provider: binding.provider },
    };
  }

  /** One agent tool call, by tool name, with its validated arguments whole (see `placeInput` and its siblings). */
  async agentTool(tool: string, owner: string, args: Readonly<Record<string, unknown>>, caller?: CallerSession): Promise<unknown> {
    switch (tool) {
      case 'feishu_doc_place': return this.place(owner, placeInput(args), caller);
      case 'feishu_doc_board': return this.board(owner, boardInput(args), caller);
      case 'feishu_doc_remove': return this.remove(owner, removeInput(args), caller);
      case 'session_start': return this.startForAgent(owner, startInput(args), caller);
      case 'feishu_doc_outline': return this.readDoc(owner, readInput(args));
      case 'feishu_doc_write': return this.writeDoc(owner, writeInput(args), caller);
      case 'feishu_doc_image': return this.imageDoc(owner, imageInput(args), caller);
      case 'feishu_doc_delete': return this.deleteDoc(owner, deleteInput(args), caller);
      case 'feishu_doc_share_create': return this.docSharesOrFail().create(owner, shareCreateInput(args));
      case 'feishu_doc_share_list': return this.docSharesOrFail().list(owner, typeof args.document === 'string' ? args.document : undefined);
      case 'feishu_doc_share_update': return this.docSharesOrFail().update(owner, String(args.share_id ?? ''), String(args.action ?? ''));
      default: throw new DocsAddonError(404, `没有名为 ${tool} 的文档工具`);
    }
  }

  /**
   * Takes one of the owner's cards (a session card or a board) out of a
   * document: ends what the card showed, then deletes its block. A block that
   * is not an Octopus card, or belongs to someone else, is left alone.
   */
  async remove(owner: string, input: RemoveInput, caller?: CallerSession): Promise<{ removed: 'session' | 'board'; title: string; document: { title: string; id: string } }> {
    const { docs, componentTypeId } = this.cardPlane();
    const target = await findDocument(docs, owner, input.document);
    const card = cardRecord(await docs.block(owner, target.documentId, input.block.trim()), componentTypeId);
    if (!card) throw new DocsAddonError(404, `《${target.title || '这篇文档'}》里没有这个 Octopus 卡片块`);
    const agent = card.record.octopusAgent as Record<string, unknown> | undefined;
    const boardCard = card.record.octopusBoard as Record<string, unknown> | undefined;
    let removed: 'session' | 'board';
    let title: string;
    if (typeof boardCard?.board === 'string' && BOARD_CAPABILITY.test(boardCard.board)) {
      const board = this.extras.boards?.byCapability(digest(boardCard.board));
      if (!board || board.owner !== owner) throw new DocsAddonError(403, '只能移走你自己的卡片');
      this.extras.boards!.revoke(owner, board.id, this.now());
      removed = 'board'; title = board.title;
    } else if (typeof agent?.share === 'string' && CAPABILITY.test(agent.share)) {
      const share = this.shares.get(digest(agent.share));
      if (!share || share.owner !== owner) throw new DocsAddonError(403, '只能移走你自己的卡片');
      this.end(owner, { id: share.id });
      removed = 'session'; title = share.title;
    } else {
      throw new DocsAddonError(409, '这是一张空卡片，没有可以移走的内容');
    }
    await docs.deleteBlock(owner, target.documentId, { id: input.block.trim(), parent: card.parent });
    this.notify(owner, { kind: 'removed', actor: this.agentName(owner, caller), session: title, cards: 1 });
    return { removed, title, document: { title: target.title, id: target.documentId } };
  }

  // ── editing documents as their owner ──

  /** The document as an outline an agent can address: every block in reading order, with its id, kind, depth and text. */
  async readDoc(owner: string, input: ReadInput): Promise<Record<string, unknown>> {
    const docs = this.docsOrFail();
    const target = await findDocument(docs, owner, input.document);
    return { document: docInfo(target), ...outlinePage(await docs.blocks(owner, target.documentId), target.documentId, input) };
  }

  /**
   * Writes Markdown into a document as the owner: Feishu converts it to
   * blocks, which go after a passage, at the start or end, or in place of one
   * block (`replace`; the old block goes only after the new content landed).
   */
  async writeDoc(owner: string, input: WriteInput, caller?: CallerSession): Promise<Record<string, unknown>> {
    const docs = this.docsOrFail();
    if (!input.markdown.trim()) throw new DocsAddonError(400, '请给出要写入的 markdown');
    const target = await findDocument(docs, owner, input.document);
    const written = await writeMarkdown(docs, owner, target, input);
    this.notify(owner, { kind: 'edited', actor: this.agentName(owner, caller), doc: docRef(target), change: written.replaced ? '替换了一段内容' : `写入了 ${written.created.length} 个内容块` });
    return { document: docInfo(target), blocks: written.created, ...(written.replaced ? { replaced: written.replaced } : {}),
      ...(written.droppedImages ? { skipped_images: written.droppedImages, note: 'Markdown 里的图片没有插入：请用 feishu_doc_image 逐张插入' } : {}) };
  }

  /** Inserts one image, read from the calling agent's own device (`path`) or given inline (`data`). */
  async imageDoc(owner: string, input: ImageInput, caller?: CallerSession): Promise<Record<string, unknown>> {
    const docs = this.docsOrFail();
    const image = await this.imageBytes(owner, input, caller);
    const target = await findDocument(docs, owner, input.document);
    const { slots } = await cardSlots(docs, owner, target, input);
    const block = await atFirstSlot(slots, randomBytes(16).toString('hex'), (slot, token) => docs.insertImage(owner, target.documentId, slot, image, token));
    this.notify(owner, { kind: 'edited', actor: this.agentName(owner, caller), doc: docRef(target), change: `插入了图片 ${image.name}` });
    return { document: docInfo(target), block, name: image.name, size: image.data.length };
  }

  /** Deletes blocks by id; an Octopus card among them is taken out the way feishu_doc_remove would. */
  async deleteDoc(owner: string, input: DeleteInput, caller?: CallerSession): Promise<Record<string, unknown>> {
    const docs = this.docsOrFail();
    const ids = blockIdsOf(input.blocks);
    if (!ids.length) throw new DocsAddonError(400, '请给出要删除的块 ID（feishu_doc_outline 里的 id）');
    if (ids.length > 50) throw new DocsAddonError(400, '一次最多删除 50 个块');
    const target = await findDocument(docs, owner, input.document);
    if (ids.includes(target.documentId)) throw new DocsAddonError(400, '不能删除整篇文档');
    const cards: string[] = [];
    let deleted = 0;
    for (const id of ids) {
      const raw = await docs.block(owner, target.documentId, id);
      if (!raw || typeof raw.parent_id !== 'string') throw new DocsAddonError(404, `《${target.title || '这篇文档'}》里没有块 ${id}（已删除 ${deleted + cards.length} 个）`);
      if (this.extras.componentTypeId && cardRecord(raw, this.extras.componentTypeId)) {
        await this.remove(owner, { document: target.documentId, block: id }, caller);
        cards.push(id);
        continue;
      }
      await docs.deleteBlock(owner, target.documentId, { id, parent: raw.parent_id });
      deleted++;
    }
    if (deleted) this.notify(owner, { kind: 'edited', actor: this.agentName(owner, caller), doc: docRef(target), change: `删除了 ${deleted} 个内容块` });
    return { document: docInfo(target), deleted: deleted + cards.length, ...(cards.length ? { cards_removed: cards } : {}) };
  }

  /** An image's bytes and name, checked to be a type Feishu shows. */
  private async imageBytes(owner: string, input: ImageInput, caller?: CallerSession): Promise<{ name: string; data: Buffer }> {
    let name: string;
    let data: Buffer;
    if (input.data) {
      data = Buffer.from(input.data.replace(/^data:[^,]*,/, ''), 'base64');
      name = (input.name || 'image').replace(/[\\/]/g, '_').slice(0, 120);
    } else if (input.path) {
      if (!caller) throw new DocsAddonError(400, '这个连接无法确定你在哪台设备上；请改用 data（base64）传图片');
      const files = this.filesOrFail();
      const session = { owner, device: caller.device, cliKind: caller.source, sessionId: caller.sessionId };
      const target = await files.resolve(session, input.path).catch((error: unknown) => {
        if (error instanceof DocsAddonError && error.status === 404) {
          throw new DocsAddonError(404, `${input.path}：${error.message}。图片须在这台设备已登记的某个工作区里（可以先放进当前工作目录），或者用 data 传 base64`);
        }
        throw error;
      });
      const content = await files.read(owner, caller.device, target);
      if (content.kind !== 'file') throw new DocsAddonError(400, `${input.path} 是一个目录，不是图片文件`);
      name = content.name; data = await collectDocsFile(content, MAX_IMAGE_BYTES, `图片最大 ${MAX_IMAGE_BYTES / 1048576} MB`);
    } else {
      throw new DocsAddonError(400, '请给出 path（你所在设备上的图片文件）或 data（base64）');
    }
    if (!data.length) throw new DocsAddonError(400, '图片是空的');
    if (data.length > MAX_IMAGE_BYTES) throw new DocsAddonError(413, `图片有 ${(data.length / 1048576).toFixed(1)} MB；Octopus 一次最多转交 ${MAX_IMAGE_BYTES / 1048576} MB 的图片`);
    const kind = imageKind(data);
    if (!kind) throw new DocsAddonError(415, /<svg[\s>]/i.test(data.subarray(0, 512).toString('utf8')) ? '飞书图片块不支持 SVG：请先转换成 PNG' : '只支持 PNG、JPEG、GIF、WEBP 或 BMP 图片');
    return { name: /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${kind}`, data };
  }

  private docsOrFail(): FeishuDocsClient {
    if (!this.extras.docs) throw new DocsAddonError(503, '这个 Octopus 没有接通飞书文档');
    return this.extras.docs;
  }

  // ── document share links, from their control card ──
  // The card's capability is the authority: a reader need not sign in to look,
  // take a key or end one (`identity` null); the owner's own acts need the
  // owner signed in. A login that is there must still be live.

  /** The keys a control card lists, for anyone holding the card. */
  async sharePanel(identity: DocsAddonIdentity | null, anchor: string, hostToken?: string): Promise<DocSharePanelView> {
    if (identity) this.auth.assertLive(identity);
    const panel = await this.docSharesOrFail().panel(viewerOf(identity), anchor, hostToken);
    if (identity) this.auth.assertLive(identity);
    return panel;
  }

  /** The owner pauses, resumes or terminates one key listed on the card; anyone else holding the card may terminate one. */
  shareAction(identity: DocsAddonIdentity | null, anchor: string, share: string, action: string, hostToken?: string): ReturnType<FeishuDocShareService['act']> {
    if (identity) this.auth.assertLive(identity);
    return this.docSharesOrFail().act(viewerOf(identity), anchor, share, action as DocShareAction, hostToken);
  }

  /** The owner, signed in on the card, takes a pending share's command: once, and only here. */
  shareReveal(identity: DocsAddonIdentity, anchor: string, share: string): Promise<DocShareRevealView> {
    this.auth.assertLive(identity);
    return this.docSharesOrFail().reveal(viewerOf(identity), anchor, share, () => this.auth.assertLive(identity));
  }

  /** A reader holding the card takes a key for themselves, within the owner's ceiling. The answer holds its token, once. */
  shareSelf(identity: DocsAddonIdentity | null, anchor: string, hostToken: string, label: string, rights: string): Promise<DocShareSelfView> {
    if (identity) this.auth.assertLive(identity);
    return this.docSharesOrFail().selfServe({ capability: anchor, hostToken, label, rights, viewer: viewerOf(identity) });
  }

  /** The owner, signed in on the card, sets the most readers may take for themselves. */
  shareSettings(identity: DocsAddonIdentity, anchor: string, selfServe: string, hostToken?: string): Promise<DocSharePanelView> {
    this.auth.assertLive(identity);
    return this.docSharesOrFail().settings(viewerOf(identity), anchor, selfServe, hostToken);
  }

  /** The owner, signed in on the card, makes or stops its claim link. */
  shareInvite(identity: DocsAddonIdentity, anchor: string, op: string): DocShareInviteView {
    this.auth.assertLive(identity);
    return this.docSharesOrFail().invite(viewerOf(identity), anchor, op);
  }

  /** A claim link's page: what it would take a key for. The link's secret is the authority. */
  inviteInfo(secret: string): Promise<DocShareInviteInfo> {
    return this.docSharesOrFail().inviteInfo(secret);
  }

  /** A claim link's page takes a key. The answer holds its token, once. */
  inviteClaim(secret: string, label: string, rights: string): Promise<DocShareSelfView> {
    return this.docSharesOrFail().inviteClaim(secret, label, rights);
  }

  private docSharesOrFail(): FeishuDocShareService {
    if (!this.extras.docShares) throw new DocsAddonError(503, '飞书文档共享在这个 Octopus 上没有启用');
    return this.extras.docShares;
  }

  // ── document assistants (`doc-assistants.ts`): a signed-in reader's own agent, from a control card ──
  // The guest is `identity.openId`, verified by the login; the owner, `identity.username`.

  /** The caller's devices and the projects each could give assistants. Account holders only: it is their own devices. */
  async assistantTargets(identity: DocsAddonIdentity): Promise<{ devices: AssistantTarget[] }> {
    const devices = await this.assistantsOrFail().targets(this.owner(identity));
    this.auth.assertLive(identity);
    return { devices };
  }

  /** The card's owner turns its assistants on with a project, or off (`rights` null ends every live one). */
  async assistantConfigure(identity: DocsAddonIdentity, anchor: string, config: { rights: string | null; device?: string; workspaceId?: string }): Promise<AssistantSettings> {
    const settings = await this.assistantsOrFail().configure(this.owner(identity), anchor, config);
    this.auth.assertLive(identity);
    return settings;
  }

  /** The caller's own assistants on the card; the card's owner sees every one. */
  assistantList(identity: DocsAddonIdentity, anchor: string): { assistants: AssistantView[] } {
    this.auth.assertLive(identity);
    return { assistants: this.assistantsOrFail().list(callerOf(identity), anchor) };
  }

  /** The caller starts their own assistant; `name` is what their card read from the SDK, a label only. */
  async assistantStart(identity: DocsAddonIdentity, anchor: string, hostToken: string, task: string, requestId: string, name: string): Promise<{ id: string }> {
    this.auth.assertLive(identity);
    const started = await this.assistantsOrFail().start({ openId: identity.openId, name }, anchor, hostToken || undefined, task, requestId);
    this.auth.assertLive(identity);
    return started;
  }

  async assistantStatus(identity: DocsAddonIdentity, id: string): Promise<AssistantStatus> {
    this.auth.assertLive(identity);
    const status = await this.assistantsOrFail().status(callerOf(identity), id);
    this.auth.assertLive(identity);
    return status;
  }

  assistantEnd(identity: DocsAddonIdentity, id: string): AssistantView {
    this.auth.assertLive(identity);
    return this.assistantsOrFail().end(callerOf(identity), id);
  }

  /** The guest puts their assistant's card into the document, as the Feishu app. */
  async assistantPin(identity: DocsAddonIdentity, id: string): Promise<{ block: string }> {
    this.auth.assertLive(identity);
    const pinned = await this.assistantsOrFail().pin({ openId: identity.openId }, id);
    this.auth.assertLive(identity);
    return pinned;
  }

  private assistantsOrFail(): FeishuDocAssistants {
    if (!this.extras.assistants) throw new DocsAddonError(503, '文档助手在这个 Octopus 上没有启用');
    return this.extras.assistants;
  }

  // ── boards: visual cards an agent keeps up to date ──

  /**
   * Publishes a board, or updates one in place. A new board needs a document
   * and becomes a card there (see `place` for where it goes); an update needs
   * the board id the first call returned and changes every card showing it.
   */
  async board(owner: string, input: BoardInput, caller?: CallerSession): Promise<Record<string, unknown>> {
    const boards = this.boardsOrFail();
    const html = boardHtml(input.html);
    if (input.board) {
      const current = boards.get(input.board.trim());
      if (!current || current.owner !== owner) throw new DocsAddonError(404, '找不到这块看板：请用第一次发布时返回的 board');
      if (current.revokedAt !== null) throw new DocsAddonError(410, '这块看板已经停止共享；请重新发布一块新的');
      const version = boards.update(owner, current.id, { title: label(input.title || current.title), html }, this.now());
      if (version === null) throw new DocsAddonError(410, '这块看板已经停止共享；请重新发布一块新的');
      return { board: current.id, version, updated: true };
    }
    if (!input.document) throw new DocsAddonError(400, '第一次发布看板需要给出 document；更新已有看板请给出 board');
    const { docs, componentTypeId } = this.cardPlane();
    const target = await findDocument(docs, owner, input.document);
    const { slots, anchor } = await cardSlots(docs, owner, target, input);
    const title = label(input.title || '看板');
    const capability = `db_${randomBytes(32).toString('base64url')}`;
    const id = `bd_${randomBytes(12).toString('hex')}`;
    boards.create({ id, capability: digest(capability), owner, title, html, createdAt: this.now() });
    const record = { octopusBoard: { v: 1, board: capability, title, owner: this.displayName(owner), doc: target.documentId, ...(target.wikiToken ? { alias: target.wikiToken } : {}) } };
    let block: string;
    try {
      block = await insertCard(docs, owner, target.documentId, componentTypeId, record, slots, capability);
    } catch (error) {
      boards.revoke(owner, id, this.now());
      throw error;
    }
    this.notify(owner, { kind: 'board', actor: this.agentName(owner, caller), title, doc: docRef(target) });
    return {
      board: id, version: 1,
      document: { title: target.title, id: target.documentId, ...(target.url ? { url: target.url } : {}) },
      card: { block, title, ...(anchor ? { after: excerpt(anchor.text) || anchor.id } : {}) },
    };
  }

  /** A board as a card reader sees it; `since` (the version shown) answers "unchanged" cheaply. */
  readBoard(identity: DocsAddonIdentity, capability: string, since: string): BoardReply {
    const board = this.liveBoard(capability);
    if (since && since === String(board.version)) return { version: board.version, unchanged: true };
    return { role: identity.username === board.owner ? 'owner' : 'viewer', title: board.title, owner: this.displayName(board.owner),
      version: board.version, updatedAt: new Date(board.updatedAt).toISOString(), html: board.html };
  }

  /** The owner ends a board from its card; the card then clears its Record. */
  unboard(identity: DocsAddonIdentity, capability: string): { revoked: boolean } {
    const owner = this.owner(identity);
    const board = this.liveBoard(capability);
    if (board.owner !== owner) throw new DocsAddonError(403, `只有 ${this.displayName(board.owner)} 可以停止共享这块看板`);
    const revoked = this.boardsOrFail().revoke(owner, board.id, this.now());
    if (revoked) this.notify(owner, { kind: 'removed', actor: this.displayName(owner), session: board.title, cards: 1 });
    return { revoked };
  }

  private liveBoard(capability: string): FeishuDocsBoard {
    if (!BOARD_CAPABILITY.test(capability)) throw new DocsAddonError(400, '看板的共享凭据格式无效');
    const board = this.boardsOrFail().byCapability(digest(capability));
    if (!board) throw new DocsAddonError(404, '找不到这块看板');
    if (board.revokedAt !== null) throw new DocsAddonError(410, '这块看板已停止共享');
    return board;
  }

  private boardsOrFail(): FeishuDocsBoardsRepository {
    if (!this.extras.boards) throw new DocsAddonError(503, '看板在这个 Octopus 上没有启用');
    return this.extras.boards;
  }

  private cardPlane(): { docs: FeishuDocsClient; componentTypeId: string } {
    const { docs, componentTypeId } = this.extras;
    if (!docs || !componentTypeId) throw new DocsAddonError(503, '这个 Octopus 没有配置飞书文档卡片的组件 ID，暂时不能从 Agent 放入卡片');
    return { docs, componentTypeId };
  }

  // ── starting a new agent ──

  async launchOptions(identity: DocsAddonIdentity): Promise<LaunchOptions> {
    const owner = this.owner(identity);
    const launcher = this.launcherOrFail();
    // Recent directories only prefill the form: a slow roster must not hold it back.
    const roster = await Promise.race([
      this.hub.roster(this.principal(identity), owner, { limit: 100, source: 'all', includeSessionPlus: true }).catch(() => null),
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), ROSTER_WAIT_MS).unref?.(); }),
    ]);
    this.auth.assertLive(identity);
    const recent = (roster?.sessions ?? []).map((s) => ({ device: s.deviceId ?? this.hub.decodeResourceId(s.resourceId)?.device ?? '', cwd: s.cwd, lastActivity: s.sortActivity ?? s.lastActivity }));
    return launcher.options(owner, recent, readDefaults(this.extras.settings?.get(owner, SETTINGS_KEY)));
  }

  /** Dispatches a new agent for the card's owner. The card polls `launchStatus` and then writes its Record. */
  async launch(identity: DocsAddonIdentity, form: { device: string; directory: string; provider: string; model: string; effort: string; task: string; title: string; doc?: string; docTitle?: string; docText?: string; docBytes?: number; requestId: string }): Promise<{ id: string }> {
    const owner = this.owner(identity);
    const task = form.task.trim();
    if (!task) throw new DocsAddonError(400, '请写清楚要新 Agent 做什么');
    const provider = form.provider === 'claude' ? 'claude' : form.provider === 'codex' ? 'codex' : null;
    if (!provider) throw new DocsAddonError(400, '只能新建 Claude Code 或 Codex Agent');
    const prompt = firstInstruction(task, { title: form.docTitle, id: form.doc, text: form.docText, bytes: form.docBytes });
    fitPrompt(prompt, MACHINE_LIMITS.startMaxPromptBytes, '任务');
    const operationId = await this.launcherOrFail().start(owner, { device: form.device, directory: form.directory, provider, model: form.model, effort: form.effort, prompt, requestId: form.requestId });
    this.auth.assertLive(identity);
    this.remember(owner, { device: form.device, directory: form.directory, provider, model: form.model, effort: form.effort });
    if (!this.launches.has(operationId)) {
      if (this.launches.size >= MAX_LAUNCHES) this.launches.delete(this.launches.keys().next().value!);
      this.launches.set(operationId, { owner, device: form.device, provider, operationId, title: label(form.title || task), model: form.model, effort: form.effort,
        directory: form.directory, ...(form.docTitle ? { docTitle: label(form.docTitle) } : {}), at: this.now() });
    }
    return { id: operationId };
  }

  /** Ready once the device names the new session; then the share exists and the card writes its Record. */
  async launchStatus(identity: DocsAddonIdentity, id: string): Promise<LaunchStatus> {
    const owner = this.owner(identity);
    const launch = this.launches.get(id);
    if (!launch || launch.owner !== owner) throw new DocsAddonError(404, '找不到这次新建，请在会话列表里查看');
    if (launch.binding) return { state: 'ready', message: '已启动', binding: launch.binding };
    if (launch.error) return { state: 'failed', message: launch.error };
    launch.settling ??= (async (): Promise<LaunchStatus> => {
      const receipt = await this.launcherOrFail().status(owner, launch.device, launch.operationId);
      if (receipt.state === 'failed') { launch.error = receipt.error ?? '设备没有启动这个 Agent'; return { state: 'failed', message: launch.error }; }
      if (!receipt.sessionId) {
        if (this.now() - launch.at > LAUNCH_WAIT_MS) return { state: 'starting', message: '设备还在启动 Agent，稍后可以在会话列表里找到它' };
        return { state: 'starting', message: receipt.state === 'missing' ? '正在把任务交给设备…' : '设备正在启动 Agent…' };
      }
      const resource = resourceId({ owner, device: launch.device, cliKind: launch.provider, sessionId: receipt.sessionId });
      launch.binding = this.mint(owner, resource, launch.title).binding;
      this.notify(owner, { kind: 'created', actor: this.displayName(owner), via: 'card', session: launch.title, device: launch.device, provider: launch.provider,
        model: launch.model, effort: launch.effort, directory: launch.directory, ...(launch.docTitle ? { doc: { title: launch.docTitle } } : {}) });
      return { state: 'ready', message: '已启动', binding: launch.binding };
    })().finally(() => { launch.settling = undefined; });
    return launch.settling;
  }

  /** An agent starts another agent for the same owner; optionally places it into a document. */
  async startForAgent(owner: string, input: StartInput, caller?: CallerSession): Promise<Record<string, unknown>> {
    const launcher = this.launcherOrFail();
    const defaults = readDefaults(this.extras.settings?.get(owner, SETTINGS_KEY));
    const provider: LaunchProvider = input.provider === 'claude' || input.provider === 'codex' ? input.provider : defaults.provider;
    const device = input.device || caller?.device || defaults.device || '';
    if (!device) throw new DocsAddonError(400, '请指定 device（list_execution_targets 或 list_recent_sessions 返回的设备名）');
    const model = input.model ?? defaults.model[provider];
    const effort = input.effort ?? defaults.effort[provider];
    const operationId = await launcher.start(owner, { device, directory: input.directory, provider, model, effort, prompt: input.prompt, requestId: randomBytes(16).toString('hex') });
    const title = label(input.title || input.prompt);
    const receipt = await launcher.waitForSession(owner, device, operationId, this.now() + AGENT_WAIT_MS, this.now);
    if (receipt.state === 'failed') throw new DocsAddonError(422, receipt.error ?? '设备没有启动这个 Agent');
    const base = { operation_id: operationId, device, provider, model, effort, directory: input.directory };
    if (!receipt.sessionId) return { ...base, state: 'starting', message: '设备还在启动 Agent；稍后用 list_recent_sessions 找到它' };
    const resource = resourceId({ owner, device, cliKind: provider, sessionId: receipt.sessionId });
    const placed = input.document ? await this.place(owner, { session: resource, document: input.document, title, ...(input.after ? { after: input.after } : {}), ...(input.position ? { position: input.position } : {}) }, caller) : null;
    this.notify(owner, { kind: 'created', actor: this.agentName(owner, caller), via: 'agent', session: title, device, provider, model, effort, directory: input.directory,
      ...(placed ? { doc: { title: placed.document.title, ...(placed.document.url ? { url: placed.document.url } : {}) } } : {}) });
    return { ...base, state: 'started', session_id: receipt.sessionId, resource_id: resource, ...(placed ? { document: placed.document, card: placed.card } : {}) };
  }

  // ── workspace files ──

  /** The workspace holding a card's session and who may read it. Owner only. */
  async workspace(identity: DocsAddonIdentity, capability: string): Promise<WorkspaceInfo> {
    const owner = this.owner(identity);
    const { share, session } = this.ownedShare(owner, capability);
    this.refuseAssistant(share, '文档助手的卡片不显示工作区');
    const found = await this.filesOrFail().sessionWorkspace({ owner, device: session.device, cliKind: session.cliKind, sessionId: session.sessionId });
    this.auth.assertLive(identity);
    return this.workspaceInfo(owner, session.device, found);
  }

  /** Makes `members` exactly the readers of the card session's workspace. Owner only; the whole home folder is never shareable. */
  async grantWorkspace(identity: DocsAddonIdentity, capability: string, workspaceId: string, members: readonly string[]): Promise<WorkspaceInfo> {
    const owner = this.owner(identity);
    const grants = this.extras.grants;
    if (!grants) throw new DocsAddonError(503, '工作区共享暂不可用');
    const { share, session } = this.ownedShare(owner, capability);
    this.refuseAssistant(share, '文档助手的卡片不能共享工作区');
    const found = await this.filesOrFail().sessionWorkspace({ owner, device: session.device, cliKind: session.cliKind, sessionId: session.sessionId });
    this.auth.assertLive(identity);
    if (!found || found.workspace.workspaceId !== workspaceId) throw new DocsAddonError(409, '这个会话所在的工作区已变化，请刷新后重试');
    if (!shareable(found.workspace)) throw new DocsAddonError(422, '整个主目录（Home 工作区）不能共享；请把项目目录登记为单独的工作区');
    const candidates = new Set(this.candidates(owner).map((m) => m.username));
    const unknown = members.filter((name) => !candidates.has(name));
    if (unknown.length) throw new DocsAddonError(400, `这些账号不能被授权：${unknown.slice(0, 5).join('、')}`);
    const rows = grants.replace(owner, session.device, workspaceId, found.workspace.label, members, this.now());
    this.notify(owner, { kind: 'workspace', actor: this.displayName(owner), workspace: found.workspace.label, device: session.device, members: rows.map((r) => this.displayName(r.grantee)) });
    return this.workspaceInfo(owner, session.device, found);
  }

  /**
   * A file or directory the agent mentioned. The reader must be the owner or
   * hold a grant on the workspace the path resolves into; the read itself runs
   * on the owner's Workspace Files root with read-only rights.
   */
  /** `after` continues a directory listing from the previous page's `next`. */
  async file(identity: DocsAddonIdentity, capability: string, mention: string, after?: string): Promise<DocsFileContent> {
    this.auth.assertLive(identity);
    const share = this.shares.get(this.capabilityId(capability));
    if (!share || share.revokedAt !== null) throw new DocsAddonError(410, '这张卡片已停止共享');
    this.refuseAssistant(share, '文档助手的卡片不能打开工作区文件');
    const viewer = identity.username;
    if (!viewer) throw new DocsAddonError(403, '打开文件需要你的飞书账号关联 Octopus 账号');
    const session = this.hub.decodeResourceId(share.resource);
    if (!session || session.owner !== share.owner) throw new DocsAddonError(410, '这张卡片的会话已失效');
    const path = mention.trim();
    if (!path || path.length > 1024 || /[\u0000\r\n]/.test(path)) throw new DocsAddonError(400, '文件路径无效');
    const files = this.filesOrFail();
    const target = await files.resolve({ owner: share.owner, device: session.device, cliKind: session.cliKind, sessionId: session.sessionId }, path);
    if (viewer !== share.owner && !this.extras.grants?.has(share.owner, session.device, target.workspace.workspaceId, viewer)) {
      throw new DocsAddonError(403, `${this.displayName(share.owner)} 还没有把工作区「${target.workspace.label}」共享给你`);
    }
    const content = await files.read(share.owner, session.device, target, path.endsWith('/'), after);
    this.auth.assertLive(identity);
    // A later page of a listing already notified the owner when it opened.
    if (viewer !== share.owner && after === undefined) {
      this.notify(share.owner, { kind: 'file', actor: this.displayName(viewer), session: share.title, path: content.path || '/', workspace: target.workspace.label });
    }
    return content;
  }

  // ── every tenant member observes ──

  async view(identity: DocsAddonIdentity, capability: string, since: string, after: number): Promise<CardFrameReply> {
    this.auth.assertLive(identity);
    const share = this.shares.get(this.capabilityId(capability));
    if (!share) throw new DocsAddonError(404, '这张卡片的共享凭据无效');
    if (share.revokedAt !== null) throw new DocsAddonError(410, `${this.displayName(share.owner)} 已停止共享这个会话`);
    const assistant = this.watchable(identity, share);
    if (share.snapshot) return this.snapshotFrame(identity, share, share.snapshot, since, after, assistant);
    const watch = this.watch(share);
    watch.seenAt = this.now();
    await this.refresh(watch);
    this.auth.assertLive(identity);
    if (this.watches.get(share.id) !== watch) throw new DocsAddonError(410, `${this.displayName(share.owner)} 已停止共享这个会话`);
    // An assistant's own guest watching it is no news to the owner: its start already was.
    if (identity.username !== share.owner && identity.openId !== assistant?.guestOpenId) {
      this.notify(share.owner, { kind: 'viewed', actor: identity.username ? this.displayName(identity.username) : `未关联 Octopus 的组织成员（…${identity.openId.slice(-6)}）`, session: share.title });
    }
    const role = identity.username === share.owner ? 'owner' : 'viewer';
    const readOnly = this.readOnly(share);
    const canTalk = this.mayTalk(share, identity, assistant);
    const status = statusOf(watch, this.now(), role === 'owner' ? share.readAt ?? null : undefined);
    // Waiting, unread and the right to talk change what the card shows without a new message, so they are part of the revision.
    const rev = `${watch.counter}.${status.working ? 1 : 0}${status.waiting ? `.${status.waiting}` : ''}${status.unread ? '.u' : ''}${canTalk ? '.t' : ''}${readOnly ? '.r' : ''}${pinnedMark(assistant)}`;
    if (since === rev) return { rev, unchanged: true };
    const reset = !Number.isSafeInteger(after) || after < watch.offset || after >= watch.total;
    return {
      rev,
      role,
      title: share.title,
      owner: this.displayName(share.owner),
      device: watch.session.device,
      provider: watch.session.cliKind,
      status,
      total: watch.total,
      reset,
      messages: reset ? watch.rows : watch.rows.filter((row) => row.i >= after),
      ...(watch.error ? { error: watch.error } : {}),
      kind: 'live',
      canTalk,
      ...(readOnly ? { readOnly } : {}),
      ...(share.origin ? { origin: this.originView(share.origin) } : {}),
      ...assistantFrame(assistant, identity, share.owner),
    };
  }

  /** A snapshot card: the rows kept when it was taken, read without the device. */
  private snapshotFrame(identity: DocsAddonIdentity, share: FeishuDocsShare, snapshot: FeishuDocsSnapshot, since: string, after: number,
    assistant: DocAssistant | null): CardFrameReply {
    const session = this.hub.decodeResourceId(share.resource);
    if (!session || session.owner !== share.owner) throw new DocsAddonError(410, '这张卡片的会话已失效');
    if (identity.username !== share.owner) {
      this.notify(share.owner, { kind: 'viewed', actor: identity.username ? this.displayName(identity.username) : `未关联 Octopus 的组织成员（…${identity.openId.slice(-6)}）`, session: share.title });
    }
    const readOnly = this.readOnly(share);
    const canTalk = this.mayTalk(share, identity, assistant);
    const rev = `snapshot${canTalk ? '.t' : ''}${readOnly ? '.r' : ''}${pinnedMark(assistant)}`;
    if (since === rev) return { rev, unchanged: true };
    const rows = snapshot.rows;
    const lastReplyAt = [...rows].reverse().find((row) => row.role === 'assistant')?.at;
    const first = rows[0]?.i ?? 0;
    const reset = !Number.isSafeInteger(after) || after < first || after >= first + rows.length;
    const frame: CardFrame = {
      rev,
      role: identity.username === share.owner ? 'owner' : 'viewer',
      title: share.title,
      owner: this.displayName(share.owner),
      device: session.device,
      provider: session.cliKind,
      status: { working: false, state: 'idle', ...(lastReplyAt ? { lastReplyAt } : {}) },
      total: first + rows.length,
      reset,
      messages: reset ? rows : rows.filter((row) => row.i >= after),
      kind: 'snapshot',
      snapshotAt: snapshot.at,
      canTalk,
      ...(readOnly ? { readOnly } : {}),
      ...(share.origin ? { origin: this.originView(share.origin) } : {}),
      ...assistantFrame(assistant, identity, share.owner),
    };
    return frame;
  }

  // ── only the owner operates ──

  /** The owner has seen the agent's replies up to `at` in a card; every card of that session then shows them read. */
  markRead(identity: DocsAddonIdentity, capability: string, at: string): { ok: true } {
    const owner = this.owner(identity);
    const share = this.shares.get(this.capabilityId(capability));
    if (!share || share.revokedAt !== null) throw new DocsAddonError(410, '这张卡片已停止共享');
    if (share.owner !== owner) throw new DocsAddonError(403, '只有所有者的已读状态会被记录');
    const time = Date.parse(at);
    if (!Number.isFinite(time) || time > this.now() + 60_000) throw new DocsAddonError(400, '已读时间无效');
    this.shares.markRead(owner, share.resource, new Date(time).toISOString());
    return { ok: true };
  }

  async send(identity: DocsAddonIdentity, capability: string, prompt: string, requestId: string, origin?: { doc?: string; title?: string }): Promise<AgentOperation> {
    const text = prompt.trim();
    if (!text) throw new DocsAddonError(400, '任务内容为空');
    const { share, session, member, assistant } = this.talker(identity, capability);
    if (share.snapshot) throw new DocsAddonError(409, '这是一份快照，内容不再变化；要接着聊，请从快照分叉');
    if (assistant && member !== share.owner) {
      const message = cardMessage(text, origin);
      fitPrompt(message, MACHINE_LIMITS.appendMaxPromptBytes, '消息');
      return this.guestTalk(identity, share, assistant, { prompt: message }, requestId, origin?.title ? { title: label(origin.title) } : undefined);
    }
    const message = cardMessage(text, origin, this.speakerOf(share, member));
    fitPrompt(message, MACHINE_LIMITS.appendMaxPromptBytes, '消息');
    const operation = await this.submit(identity, share, session, member, requestId, 'append_session', message);
    if (member !== share.owner) this.notify(share.owner, { kind: 'spoke', actor: this.displayName(member), session: share.title, ...(origin?.title ? { doc: { title: label(origin.title) } } : {}) });
    return operation;
  }

  async stop(identity: DocsAddonIdentity, capability: string, requestId: string): Promise<AgentOperation> {
    const { share, session, member, assistant } = this.talker(identity, capability, true);
    if (share.snapshot) throw new DocsAddonError(409, '快照里没有在运行的 Agent');
    if (assistant && member !== share.owner) return this.guestTalk(identity, share, assistant, { interrupt: true }, requestId);
    return this.submit(identity, share, session, member, requestId, 'interrupt_session');
  }

  /**
   * A message's progress for the card that sent it. A document assistant's
   * guest follows their own through the device's receipt: the answer is the
   * last one read, and a read for the next poll starts behind it.
   */
  operation(identity: DocsAddonIdentity, id: string): AgentOperation {
    this.auth.assertLive(identity);
    const guest = this.guestTalks.get(id);
    if (guest && guest.openId === identity.openId) {
      this.followGuestTalk(id, guest);
      return guest.view;
    }
    const member = identity.username;
    if (!member) throw new DocsAddonError(403, '你的飞书账号还没有关联 Octopus 账号');
    const talk = this.talks.get(id);
    const result = this.operations.get(talk && talk.member === member ? talk.owner : member, id);
    if (!result) throw new DocsAddonError(404, '找不到这个任务');
    return operationView(result);
  }

  // ── snapshots, forks and speakers ──

  /**
   * Freezes this card's agent at its last completed turn into a snapshot card
   * right below this one. A turn still running is left out: the snapshot is
   * what the agent had finished saying. Owner only.
   */
  async snapshot(identity: DocsAddonIdentity, capability: string, doc: string): Promise<PlacedCard> {
    const owner = this.owner(identity);
    const { share, session } = this.ownedShare(owner, capability);
    if (share.snapshot) throw new DocsAddonError(409, '这已经是一份快照');
    this.refuseAssistant(share, '文档助手的对话不能做成快照');
    const snapshot = await this.freeze(owner, session);
    this.auth.assertLive(identity);
    const { binding } = this.mint(owner, share.resource, share.title, { snapshot, origin: { kind: 'snapshot', from: share.title, by: owner, at: this.now() } });
    try {
      await this.placeBelow(owner, doc, capability, binding);
    } catch (error) {
      this.end(owner, { id: digest(binding.share) });
      throw error;
    }
    return { binding };
  }

  /**
   * Branches this card's agent into a new agent of the same owner: a snapshot
   * card branches at its moment, a live card at its last completed turn. The
   * branch gets its own card right below this one and `prompt`, if given, as
   * its first message. The owner and the owner's speakers may fork; a speaker
   * may then talk to their branch. Every branch runs on the owner's device as
   * the owner's agent, and the source is not touched.
   */
  async fork(identity: DocsAddonIdentity, capability: string, prompt: string, requestId: string, origin?: { doc?: string; title?: string }): Promise<PlacedCard> {
    const text = prompt.trim();
    if (!REQUEST_ID.test(requestId)) throw new DocsAddonError(400, '请求标识无效');
    const { share, session, member, assistant } = this.talker(identity, capability);
    // A fork would be an ordinary agent of the owner's, with every tool: never from an assistant.
    if (assistant) throw new DocsAddonError(409, '文档助手不能分叉');
    if (text) fitPrompt(cardMessage(text, origin, this.speakerOf(share, member)), MACHINE_LIMITS.appendMaxPromptBytes, '消息');
    const key = `${member}\u0000${requestId}`;
    const running = this.forks.get(key);
    if (running) return running;
    const work = this.forkOnce(identity, capability, share, session, member, text, origin);
    if (this.forks.size >= MAX_LAUNCHES) this.forks.delete(this.forks.keys().next().value!);
    this.forks.set(key, work);
    work.catch(() => { if (this.forks.get(key) === work) this.forks.delete(key); });
    return work;
  }

  private async forkOnce(identity: DocsAddonIdentity, capability: string, share: FeishuDocsShare, session: Session, member: string, text: string,
    origin?: { doc?: string; title?: string }): Promise<PlacedCard> {
    const name = this.displayName(member);
    const title = label(`${share.title} · ${name}的分叉`);
    const forked = await this.launcherOrFail().fork(share.owner, session.device, session.cliKind, session.sessionId, share.snapshot?.anchor, title);
    this.auth.assertLive(identity);
    const resource = resourceId({ owner: share.owner, device: session.device, cliKind: session.cliKind, sessionId: forked.sessionId });
    const { binding } = this.mint(share.owner, resource, title, { origin: { kind: 'fork', from: share.title, by: member, at: this.now() } });
    if (member !== share.owner) this.extras.speakers?.add(share.owner, resource, member, this.now());
    let notice: string | undefined;
    if (!origin?.doc) notice = '分叉已经建好，但卡片没有说明它在哪篇文档里，没能把新卡片放进去；它在所有者的会话列表里';
    else {
      notice = await this.placeBelow(share.owner, origin.doc, capability, binding)
        .then(() => undefined, (error: unknown) => `分叉已经建好，但没能把新卡片放进文档（${error instanceof Error ? error.message.slice(0, 120) : '未知原因'}）；它在所有者的会话列表里`);
    }
    let operation: AgentOperation | undefined;
    const branch = this.shares.get(digest(binding.share));
    const branchSession = this.hub.decodeResourceId(resource);
    if (text && branch && branchSession) {
      operation = await this.submit(identity, branch, branchSession, member, randomUUID(), 'append_session', cardMessage(text, origin, this.speakerOf(share, member)));
    }
    if (member !== share.owner) {
      this.notify(share.owner, { kind: 'forked', actor: name, session: share.title, fork: title, from: share.snapshot ? 'snapshot' : 'live',
        ...(origin?.title ? { doc: { title: label(origin.title) } } : {}) });
    }
    return { binding, ...(operation ? { operation } : {}), ...(notice ? { notice } : {}) };
  }

  /** Who besides the owner may talk to this card's agent. Owner only. */
  speakers(identity: DocsAddonIdentity, capability: string): SpeakersInfo {
    const owner = this.owner(identity);
    const { share } = this.ownedShare(owner, capability);
    this.refuseAssistant(share, '文档助手只能由发起人和所有者对话，不能授权别人');
    return this.speakersInfo(owner, share.resource);
  }

  /** Makes `members` exactly the people besides the owner who may talk to this card's agent. Owner only. */
  setSpeakers(identity: DocsAddonIdentity, capability: string, members: readonly string[]): SpeakersInfo {
    const owner = this.owner(identity);
    const speakers = this.extras.speakers;
    if (!speakers) throw new DocsAddonError(503, '授权对话暂不可用');
    const { share } = this.ownedShare(owner, capability);
    this.refuseAssistant(share, '文档助手只能由发起人和所有者对话，不能授权别人');
    const candidates = new Set(this.candidates(owner).map((m) => m.username));
    const unknown = members.filter((name) => !candidates.has(name));
    if (unknown.length) throw new DocsAddonError(400, `这些账号不能被授权：${unknown.slice(0, 5).join('、')}`);
    speakers.replace(owner, share.resource, members, this.now());
    return this.speakersInfo(owner, share.resource);
  }

  // ── lifecycle ──

  /** The owner's account or Feishu mapping ended: drop the reads made on their behalf. */
  revokeOwner(owner: string): void {
    for (const watch of this.watches.values()) if (watch.share.owner === owner) this.closeWatch(watch);
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const watch of this.watches.values()) this.closeWatch(watch);
  }

  // ── internals ──

  private owner(identity: DocsAddonIdentity): string {
    this.auth.assertLive(identity);
    if (!identity.username) throw new DocsAddonError(403, '你的飞书账号还没有关联 Octopus 账号，只能查看别人共享的 Agent');
    return identity.username;
  }

  /** Feishu Docs is an external add-on: it never receives the Dashboard's browser-only silent-submit exception. */
  private principal(identity: DocsAddonIdentity): HubPrincipal {
    return { username: identity.username!, admin: false, session: false, credential: identity.credential };
  }

  private capabilityId(capability: string): string {
    if (!CAPABILITY.test(capability)) throw new DocsAddonError(400, '卡片的共享凭据格式无效');
    return digest(capability);
  }

  /** The one place a card capability is born: a random secret whose hash is the row key. */
  private mint(owner: string, resource: string, title: string, extra: { snapshot?: FeishuDocsSnapshot; origin?: FeishuDocsOrigin } = {}): ShareResult {
    const session = this.hub.decodeResourceId(resource);
    if (!session || session.owner !== owner) throw new DocsAddonError(403, '只能共享你自己的会话');
    const capability = `ds_${randomBytes(32).toString('base64url')}`;
    this.shares.create({ id: digest(capability), owner, resource, title, createdAt: this.now(), revokedAt: null, ...extra });
    return { binding: { share: capability, title, owner: this.displayName(owner), device: session.device, provider: session.cliKind } };
  }

  private notify(owner: string, notice: Parameters<DocsNotifier['notify']>[1]): void {
    this.extras.notifier?.notify(owner, notice);
  }

  private agentName(owner: string, caller?: CallerSession): string {
    return caller ? `${this.displayName(owner)} 的 Agent（${caller.device} · ${caller.source} ${caller.sessionId.slice(0, 8)}）` : `${this.displayName(owner)} 的 Agent`;
  }

  private sessionLabel(owner: string, target: { id: string } | { resource: string }): string {
    if ('id' in target) return this.shares.get(target.id)?.title ?? 'Agent 会话';
    const session = this.hub.decodeResourceId(target.resource);
    return session && session.owner === owner ? `${session.device} 上的会话` : 'Agent 会话';
  }

  /**
   * Which of the owner's sessions an agent means: "self" (the caller's own
   * session, reported by the trusted transport), a native session id, or a
   * Session Hub resource id. Ownership is re-checked whichever form is used.
   */
  private async choose(owner: string, wanted: string | undefined, caller?: CallerSession): Promise<{ resource: string; title: string }> {
    const value = (wanted ?? '').trim();
    let resource: string | undefined;
    if (!value || value === 'self') {
      if (!caller) throw new DocsAddonError(400, '这个连接无法确定你自己是哪个会话：请传入原生会话 ID（Claude Code: $CLAUDE_CODE_SESSION_ID；Codex: $CODEX_THREAD_ID）或 list_recent_sessions 的 resource_id');
      resource = resourceId({ owner, device: caller.device, cliKind: caller.source, sessionId: caller.sessionId });
    } else if (this.hub.decodeResourceId(value)) {
      resource = value;
    }
    const principal: HubPrincipal = { username: owner, admin: false, session: false, credential: 'feishu-docs-agent' };
    const roster = await this.hub.roster(principal, owner, { limit: 300, source: 'all' }).catch(() => null);
    const rows = roster?.sessions ?? [];
    const row = resource
      ? rows.find((s) => s.resourceId === resource)
      : rows.filter((s) => s.sessionId === value).sort((a, b) => Number(this.hub.decodeResourceId(b.resourceId)?.device === caller?.device) - Number(this.hub.decodeResourceId(a.resourceId)?.device === caller?.device))[0]
        ?? sessionByTitle(rows, value);
    resource ??= row?.resourceId;
    if (!resource) throw new DocsAddonError(404, '在你的会话列表里找不到这个会话');
    const session = this.hub.decodeResourceId(resource);
    if (!session || session.owner !== owner) throw new DocsAddonError(403, '只能放入你自己的会话');
    return { resource, title: label(row ? row.title || row.first_user_text || row.preview || row.sessionId : `${session.device} · ${session.cliKind}`) };
  }

  private launcherOrFail(): DocsLauncher {
    if (!this.extras.launcher) throw new DocsAddonError(503, '新建 Agent 暂不可用');
    return this.extras.launcher;
  }

  private filesOrFail(): DocsWorkspaceFiles {
    if (!this.extras.files) throw new DocsAddonError(503, '工作区文件暂不可用');
    return this.extras.files;
  }

  /** The next launch form starts from what the owner chose this time. */
  private remember(owner: string, choice: { device: string; directory: string; provider: LaunchProvider; model: string; effort: string }): void {
    const settings = this.extras.settings;
    if (!settings) return;
    const previous = readDefaults(settings.get(owner, SETTINGS_KEY));
    settings.set(owner, SETTINGS_KEY, JSON.stringify({ device: choice.device, directory: choice.directory, provider: choice.provider,
      model: { ...previous.model, [choice.provider]: choice.model }, effort: { ...previous.effort, [choice.provider]: choice.effort } }));
  }

  private ownedShare(owner: string, capability: string): { share: FeishuDocsShare; session: Session } {
    const share = this.shares.get(this.capabilityId(capability));
    if (!share || share.revokedAt !== null) throw new DocsAddonError(410, '这张卡片已停止共享');
    if (share.owner !== owner) throw new DocsAddonError(403, `只有 ${this.displayName(share.owner)} 可以管理这个工作区`);
    const session = this.hub.decodeResourceId(share.resource);
    if (!session || session.owner !== owner) throw new DocsAddonError(410, '这张卡片的会话已失效');
    return { share, session };
  }

  private candidates(owner: string): WorkspaceInfo['candidates'] {
    return (this.extras.members?.() ?? []).filter((m) => m.username !== owner);
  }

  private workspaceInfo(owner: string, device: string, found: Awaited<ReturnType<DocsWorkspaceFiles['sessionWorkspace']>>): WorkspaceInfo {
    const candidates = this.candidates(owner);
    if (!found) return { device, workspace: null, members: [], candidates };
    const { workspace } = found;
    const members = (this.extras.grants?.members(owner, device, workspace.workspaceId) ?? []).map((g) => ({ username: g.grantee, name: this.displayName(g.grantee) }));
    return {
      device,
      workspace: { id: workspace.workspaceId, label: workspace.label, ...(workspace.display ? { display: workspace.display } : {}), shareable: shareable(workspace),
        ...(shareable(workspace) ? {} : { reason: '这是整个主目录（Home 工作区），不能共享；把项目目录登记为单独的工作区后再共享' }) },
      path: found.relativePath,
      members,
      candidates,
    };
  }

  /**
   * The caller may talk to this card's agent: its owner, or a member the owner
   * made a speaker. A document assistant's card: its owner, or its own guest
   * (by verified open_id, account or not) while it lives and its share is
   * usable — or, for a stop, at any time; the guest speaks as `feishu:<open_id>`.
   */
  private talker(identity: DocsAddonIdentity, capability: string, stop = false): { share: FeishuDocsShare; session: Session; member: string; assistant: DocAssistant | null } {
    this.auth.assertLive(identity);
    const share = this.shares.get(this.capabilityId(capability));
    if (!share || share.revokedAt !== null) throw new DocsAddonError(410, '这张卡片已停止共享');
    const assistant = this.assistantOf(share);
    if (!assistant && !identity.username) throw new DocsAddonError(403, '你的飞书账号还没有关联 Octopus 账号，只能查看');
    if (this.readOnly(share)) throw new DocsAddonError(409, '这个会话在只读设备上：可以查看，不能发消息、停止或分叉');
    const owner = this.displayName(share.owner);
    if (assistant) {
      // Its guest and the owner, while it may be talked to (what `mayTalk` shows); a stop always goes.
      if (identity.username !== share.owner && identity.openId !== assistant.guestOpenId) throw new DocsAddonError(403, `只有发起这个文档助手的人和 ${owner} 可以和它对话`);
      if (!stop && !assistant.usable) throw new DocsAddonError(409, assistant.live ? '这个文档助手已被暂停，或者控制卡片已不在文档里' : '这个文档助手已经结束');
    } else if (!this.mayTalk(share, identity, null)) {
      throw new DocsAddonError(403, `只有 ${owner} 和 ${owner} 授权的人可以和这个 Agent 对话`);
    }
    const session = this.hub.decodeResourceId(share.resource);
    if (!session || session.owner !== share.owner) throw new DocsAddonError(410, '这张卡片的会话已失效');
    const member = identity.username === share.owner ? share.owner : assistant ? `feishu:${identity.openId}` : identity.username!;
    return { share, session, member, assistant };
  }

  /** What a frame says: whether this reader may talk to the card's agent now. A document assistant's: exactly its guest and the owner, while it may be talked to. */
  private mayTalk(share: FeishuDocsShare, identity: DocsAddonIdentity, assistant: DocAssistant | null = this.assistantOf(share)): boolean {
    if (this.readOnly(share)) return false;
    if (assistant) return assistant.usable && (identity.username === share.owner || identity.openId === assistant.guestOpenId);
    const username = identity.username;
    if (!username) return false;
    return username === share.owner || Boolean(this.extras.speakers?.has(share.owner, share.resource, username));
  }

  /** The document assistant a card shows, by its session; null for an ordinary card. */
  private assistantOf(share: FeishuDocsShare): DocAssistant | null {
    const session = this.extras.assistants ? this.hub.decodeResourceId(share.resource) : null;
    return session ? this.extras.assistants!.ofSession(share.owner, session.device, session.sessionId) : null;
  }

  /**
   * Who may watch a card: any signed-in tenant member, except that a document
   * assistant's conversation (workspace contents in it) is its guest's and the
   * owner's until the guest pins it into the document. Returns the assistant.
   */
  private watchable(identity: DocsAddonIdentity, share: FeishuDocsShare): DocAssistant | null {
    const assistant = this.assistantOf(share);
    if (assistant && assistant.pinnedAt === null && identity.username !== share.owner && identity.openId !== assistant.guestOpenId) {
      throw new DocsAddonError(403, '这个文档助手的对话只有发起人和文档所有者能看；发起人把它固定到文档里之后，其他读者才能观看');
    }
    return assistant;
  }

  private refuseAssistant(share: FeishuDocsShare, message: string): void {
    if (this.assistantOf(share)) throw new DocsAddonError(409, message);
  }

  /** A guest's message or stop to their own assistant: one auto-allowed call on the owner's device, followed by its receipt. */
  private async guestTalk(identity: DocsAddonIdentity, share: FeishuDocsShare, assistant: DocAssistant, input: { prompt: string } | { interrupt: true },
    requestId: string, doc?: { title: string }): Promise<AgentOperation> {
    if (!REQUEST_ID.test(requestId)) throw new DocsAddonError(400, '请求标识无效');
    const sent = await this.extras.assistants!.talk(assistant, { openId: identity.openId }, input, requestId, doc);
    this.auth.assertLive(identity);
    const operation = 'prompt' in input ? 'append_session' : 'interrupt_session';
    const at = new Date(this.now()).toISOString();
    const talk: GuestTalk = { owner: assistant.owner, device: assistant.device, openId: identity.openId, operation, at,
      view: receiptView(sent.id, sent.receipt, operation, at), checkedAt: this.now() };
    if (this.guestTalks.size >= MAX_LAUNCHES) this.guestTalks.delete(this.guestTalks.keys().next().value!);
    this.guestTalks.set(sent.id, talk);
    // The next frame of every card of this session reads the device rather than the cache.
    for (const watch of this.watches.values()) if (watch.share.resource === share.resource) watch.fetchedAt = 0;
    return talk.view;
  }

  /** Reads the device's receipt for a guest's message behind the answer just given, at most once per REFRESH_MS. */
  private followGuestTalk(id: string, talk: GuestTalk): void {
    if (!talk.view.live || talk.refreshing || this.now() - talk.checkedAt < REFRESH_MS || !this.extras.assistants) return;
    talk.refreshing = this.extras.assistants.receipt(talk, id)
      .then((receipt) => { talk.view = receiptView(id, receipt, talk.operation, talk.at); }, () => undefined)
      .finally(() => { talk.refreshing = undefined; talk.checkedAt = this.now(); });
  }

  /** The card's session is on a device that reported itself read-only while online. */
  private readOnly(share: FeishuDocsShare): boolean {
    const session = this.extras.readOnly ? this.hub.decodeResourceId(share.resource) : null;
    return Boolean(session && this.extras.readOnly?.(share.owner, session.device));
  }

  /**
   * One message or stop for the card's agent through the durable operation
   * path. It runs as the agent's owner — the owner's agent, on the owner's
   * device — with the caller's own login as the credential, so a speaker's
   * logout ends what they left waiting. A speaker's name is on the message.
   */
  private async submit(identity: DocsAddonIdentity, share: FeishuDocsShare, session: Session, member: string, requestId: string,
    operation: 'append_session' | 'interrupt_session', prompt?: string): Promise<AgentOperation> {
    if (!REQUEST_ID.test(requestId)) throw new DocsAddonError(400, '请求标识无效');
    const principal: HubPrincipal = { username: share.owner, admin: false, session: false, credential: identity.credential };
    const result = await this.operations.submit('hub', principal, {
      owner: share.owner, device: session.device, sessionId: session.sessionId, source: session.cliKind, operation, ...(prompt ? { prompt } : {}),
    }, { requestId: `feishu-docs:${requestId}` });
    this.auth.assertLive(identity);
    if (!result.ok) throw new DocsAddonError(result.status, result.error);
    if (member !== share.owner) {
      if (this.talks.size >= MAX_LAUNCHES) this.talks.delete(this.talks.keys().next().value!);
      this.talks.set(result.operation.id, { owner: share.owner, member });
    }
    // The next frame of every card of this session reads the device rather than the cache.
    for (const watch of this.watches.values()) if (watch.share.resource === share.resource) watch.fetchedAt = 0;
    return operationView(result.operation);
  }

  /** The conversation as it stands at its last completed turn, kept for a snapshot card. */
  private async freeze(owner: string, session: Session): Promise<FeishuDocsSnapshot> {
    const found = await this.launcherOrFail().anchor(owner, session.device, session.cliKind, session.sessionId);
    if (!found) throw new DocsAddonError(409, '这个会话还没有完成的一轮对话，暂时没有可以固定的内容');
    const rows = cutAt(await this.readRows(owner, session, found.at), found.at);
    if (!rows.length) throw new DocsAddonError(409, '最近一轮之前的对话不在卡片能显示的范围里，没有可以固定的内容');
    return { anchor: found.anchor, at: found.at ?? new Date(this.now()).toISOString(), rows };
  }

  /**
   * One read of a session's conversation for a snapshot; no watch is kept. It
   * ends at `until`: past a long running turn it reaches back a page at a time
   * until it holds what was said by then, and it cuts there before rows are
   * projected, so the newer turn's text cannot crowd the kept turn out of the
   * frame's budget.
   */
  private async readRows(owner: string, session: Session, until?: string): Promise<TranscriptRow[]> {
    const limit = until ? Date.parse(until) : NaN;
    const by = (message: unknown): boolean => {
      const time = Date.parse(String((message as { timestamp?: unknown } | null)?.timestamp ?? ''));
      return Number.isFinite(time) && time <= limit;
    };
    return this.reading(owner, session, 'feishu-docs-snapshot', '暂时不能固定快照', async (read) => {
      const pages = [await read({ max_messages: WINDOW })];
      while (Number.isFinite(limit) && pages.length < SNAPSHOT_PAGES && pages[0].offset > 0 && !pages[0].messages.some(by)) {
        const offset = Math.max(0, pages[0].offset - WINDOW);
        pages.unshift(await read({ offset, max_messages: pages[0].offset - offset }));
      }
      let messages = pages.flatMap((page) => page.messages);
      if (Number.isFinite(limit)) {
        let end = messages.length - 1;
        while (end >= 0 && !by(messages[end])) end--;
        messages = messages.slice(0, end + 1);
      }
      const kept = messages.slice(-WINDOW);
      return project(kept, pages[0].offset + messages.length - kept.length);
    });
  }

  /**
   * One on-demand read of a session's conversation as its owner, under its own
   * Context: `read` takes a window of absolute message indexes. Nothing is kept.
   */
  private async reading<T>(owner: string, session: Session, credential: string, blocked: string,
    use: (read: (window: { offset?: number; max_messages: number }) => Promise<{ offset: number; messages: unknown[] }>) => Promise<T>): Promise<T> {
    const principal: HubPrincipal = { username: owner, admin: false, session: false, credential };
    const verdict = this.hub.liveGrant(principal, owner, session.device);
    if (!verdict.ok) throw new DocsAddonError(verdict.status, '所有者的 Octopus 授权暂不允许读取这个会话');
    const { grant, local } = verdict;
    try {
      return await use(async (window) => {
        const out = await grant.call('read_session', {
          id: session.sessionId, source: session.cliKind, rich: true, ...window,
          ...(local ? {} : { device: session.device, _octopus_include_session_plus: true }),
        }) as { offset?: number; messages?: unknown[] };
        return { offset: out.offset ?? 0, messages: out.messages ?? [] };
      });
    } catch (error) {
      if (error instanceof ApprovalRequiredError) throw new DocsAddonError(409, `所有者的 Octopus 授权需要人工批准读取，${blocked}`);
      throw error;
    } finally {
      grant.close();
    }
  }

  /** A card any tenant member may read, and the session behind it; the same checks `view` makes. */
  private readable(identity: DocsAddonIdentity, capability: string): { share: FeishuDocsShare; session: Session } {
    this.auth.assertLive(identity);
    const share = this.shares.get(this.capabilityId(capability));
    if (!share) throw new DocsAddonError(404, '这张卡片的共享凭据无效');
    if (share.revokedAt !== null) throw new DocsAddonError(410, `${this.displayName(share.owner)} 已停止共享这个会话`);
    this.watchable(identity, share);
    const session = this.hub.decodeResourceId(share.resource);
    if (!session || session.owner !== share.owner) throw new DocsAddonError(410, '这张卡片的会话已失效');
    return { share, session };
  }

  /**
   * The rows before absolute index `before`, the newest of them within one
   * frame's budget, and where to continue further back (`next`, 0 at the
   * start). A snapshot reaches back from its first kept row; earlier messages
   * do not change, so they read the same from the device.
   */
  async older(identity: DocsAddonIdentity, capability: string, before: number): Promise<OlderRows> {
    const { share, session } = this.readable(identity, capability);
    const end = Math.min(Math.floor(before), share.snapshot?.rows[0]?.i ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(end) || end <= 0) return { messages: [], next: 0 };
    const offset = Math.max(0, end - WINDOW);
    const page = await this.historyRead(share, session, '暂时读不到更早的消息', { offset, max_messages: end - offset });
    this.auth.assertLive(identity);
    const rows = project(page.messages, page.offset).filter((row) => row.i < end);
    return { messages: rows, next: rows.length ? rows[0].i : offset };
  }

  private async historyRead(share: FeishuDocsShare, session: Session, blocked: string, window: { offset: number; max_messages: number }): Promise<{ offset: number; messages: unknown[] }> {
    const running = this.history.get(share.id) ?? 0;
    if (running >= MAX_HISTORY_READS) throw new DocsAddonError(429, '这张卡片正在读取历史消息，请稍后再试');
    this.history.set(share.id, running + 1);
    try {
      return await this.reading(share.owner, session, `feishu-docs-history:${share.id.slice(0, 32)}`, blocked, (read) => read(window));
    } finally {
      const left = (this.history.get(share.id) ?? 1) - 1;
      if (left > 0) this.history.set(share.id, left); else this.history.delete(share.id);
    }
  }

  /** One message's whole text, for a row a frame carried only the beginning of. */
  async message(identity: DocsAddonIdentity, capability: string, index: number): Promise<{ i: number; text: string }> {
    const { share, session } = this.readable(identity, capability);
    const last = share.snapshot ? share.snapshot.rows.at(-1)?.i ?? -1 : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(index) || index < 0 || index > last) throw new DocsAddonError(404, '找不到这条消息');
    const page = await this.historyRead(share, session, '暂时读不到这条消息', { offset: index, max_messages: 1 });
    this.auth.assertLive(identity);
    const raw = page.messages[index - page.offset];
    const text = raw && typeof raw === 'object' ? shownText(raw as Record<string, unknown>) : null;
    if (text === null) throw new DocsAddonError(404, '找不到这条消息');
    return { i: index, text };
  }

  /**
   * Puts a new card right below the card that holds `capability`, as the
   * owner, in the document that card reported; at the end of the document
   * when that card is not found there, or Feishu refuses the place below it.
   */
  private async placeBelow(owner: string, doc: string, capability: string, binding: ShareResult['binding']): Promise<void> {
    const { docs, componentTypeId } = this.cardPlane();
    const ref = parseDocumentRef(doc.trim());
    if (!ref) throw new DocsAddonError(400, '卡片没有说明它在哪篇文档里');
    const target = await docs.resolve(owner, ref);
    const blocks = await docs.blocks(owner, target.documentId);
    const source = cardBlock(blocks, componentTypeId, capability);
    const parent = source ? blocks.find((block) => block.id === source.parent) : undefined;
    const end: BlockSlot = { parent: target.documentId, index: -1 };
    const slots = source && parent ? [{ parent: parent.id, index: parent.children.indexOf(source.id) + 1 }, end] : [end];
    const record = { octopusAgent: { v: 2, ...binding, doc: target.documentId, ...(target.wikiToken ? { alias: target.wikiToken } : {}) } };
    await insertCard(docs, owner, target.documentId, componentTypeId, record, slots, binding.share);
  }

  private originView(origin: FeishuDocsOrigin): CardOrigin {
    return { kind: origin.kind, from: origin.from, by: this.displayName(origin.by), at: new Date(origin.at).toISOString() };
  }

  /** A speaker's message says who is speaking; the owner's does not need to. */
  private speakerOf(share: FeishuDocsShare, member: string): { name: string; owner: string } | undefined {
    return member === share.owner ? undefined : { name: this.displayName(member), owner: this.displayName(share.owner) };
  }

  private speakersInfo(owner: string, resource: string): SpeakersInfo {
    const candidates = this.candidates(owner);
    const names = new Map(candidates.map((m) => [m.username, m.name]));
    return { members: (this.extras.speakers?.list(owner, resource) ?? []).map((username) => ({ username, name: names.get(username) ?? this.displayName(username) })), candidates };
  }

  private end(owner: string, target: { id: string } | { resource: string }): number {
    const ended = this.shares.revoke(owner, target, this.now());
    for (const id of ended) {
      const watch = this.watches.get(id);
      if (watch) this.closeWatch(watch);
    }
    return ended.length;
  }

  private watch(share: FeishuDocsShare): Watch {
    const existing = this.watches.get(share.id);
    if (existing) return existing;
    const session = this.hub.decodeResourceId(share.resource);
    if (!session || session.owner !== share.owner) throw new DocsAddonError(410, '这张卡片的会话已失效');
    if (this.watches.size >= MAX_WATCHES) this.sweep();
    if (this.watches.size >= MAX_WATCHES) throw new DocsAddonError(503, '正在同步的 Agent 卡片过多，请稍后再看');
    const watch: Watch = { share, session, source: null, counter: 0, offset: 0, total: 0, rows: [], blocked: false, failures: 0, retryAt: 0, fetchedAt: 0, seenAt: this.now() };
    this.watches.set(share.id, watch);
    return watch;
  }

  /**
   * Resolve a read path for the watch. The stored row is the owner's decision
   * to show this one session, so the read runs as the owner under a Context of
   * its own credential — never under any viewer's login. Session Hub picks the
   * plane (the device, or the bot host while the device is offline) at this
   * moment, which is why a failed read drops the path and resolves it again.
   */
  private open(watch: Watch): { tail: TailSource; close(): void } {
    return this.openTail(watch.share.owner, watch.session, `feishu-docs-share:${watch.share.id.slice(0, 32)}`);
  }

  private openTail(owner: string, session: Session, credential: string): { tail: TailSource; close(): void } {
    const principal: HubPrincipal = { username: owner, admin: false, session: false, credential };
    const verdict = this.hub.liveGrant(principal, owner, session.device);
    if (!verdict.ok) throw new DocsAddonError(verdict.status, '所有者的 Octopus 授权暂不允许读取这个会话');
    const { grant, local } = verdict;
    const tail = openRunnerTail(
      (method, args) => grant.call(method, local ? args : { ...args, _octopus_include_session_plus: true }),
      session.cliKind, session.sessionId, local ? undefined : session.device, WINDOW,
    );
    return { tail, close: () => { tail.close(); grant.close(); } };
  }

  /** One device read per watch at a time, none more often than REFRESH_MS, and failures back off. */
  private refresh(watch: Watch): Promise<void> {
    if (watch.inflight) return watch.inflight;
    const now = this.now();
    if (watch.blocked || now < watch.retryAt || (watch.counter > 0 && now - watch.fetchedAt < REFRESH_MS)) return Promise.resolve();
    // Cleared after assignment: a read path that fails synchronously settles the body before it returns.
    watch.inflight = this.read(watch).finally(() => { watch.inflight = undefined; });
    return watch.inflight;
  }

  private async read(watch: Watch): Promise<void> {
    try {
      watch.source ??= this.open(watch);
      const state = await watch.source.tail.fetch();
      watch.failures = 0;
      if (watch.error) { watch.error = undefined; watch.counter++; }
      if (state) {
        watch.rows = project(state.messages, state.offset);
        watch.offset = state.offset;
        watch.total = state.total;
        watch.activity = state.activity;
        watch.runtime = state.runtime;
        watch.counter++;
      }
    } catch (error) {
      watch.blocked = error instanceof ApprovalRequiredError;
      const reason = watch.blocked ? '所有者的 Octopus 授权需要人工批准读取，已暂停同步'
        : error instanceof DocsAddonError ? error.message : '暂时无法从设备读取最新内容，正在重试';
      if (watch.error !== reason) watch.counter++;
      watch.error = reason;
      watch.source?.close();
      watch.source = null;
      watch.retryAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** watch.failures++);
    } finally {
      watch.fetchedAt = this.now();
    }
  }

  private sweep(): void {
    for (const watch of this.watches.values()) if (this.now() - watch.seenAt > IDLE_MS) this.closeWatch(watch);
  }

  private closeWatch(watch: Watch): void {
    if (this.watches.get(watch.share.id) === watch) this.watches.delete(watch.share.id);
    watch.source?.close();
    watch.source = null;
  }
}

const label = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Agent 会话';
const excerpt = (value: string, max = 40) => { const text = value.replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };

export interface PlaceInput { document: string; session?: string; title?: string; after?: string; position?: 'start' | 'end'; snapshot?: boolean }
export interface RemoveInput { document: string; block: string }
export interface BoardInput { html: string; title?: string; board?: string; document?: string; after?: string; position?: 'start' | 'end' }
export interface ReadInput { document: string; from?: number; limit?: number }
export interface WriteInput { document: string; markdown: string; after?: string; position?: 'start' | 'end'; replace?: string }
export interface ImageInput { document: string; path?: string; data?: string; name?: string; after?: string; position?: 'start' | 'end' }
export interface DeleteInput { document: string; blocks: string }
export interface StartInput { prompt: string; directory: string; device?: string; provider?: string; model?: string; effort?: string; document?: string; title?: string; after?: string; position?: 'start' | 'end' }

/*
 * An agent tool's validated arguments, as the service takes them. Each tool's
 * declared fields all arrive here; a field the tool adds and these forget is
 * caught by the test that walks the tool specs.
 */
const strings = <K extends string>(args: Readonly<Record<string, unknown>>, keys: readonly K[]) =>
  Object.fromEntries(keys.filter((key) => typeof args[key] === 'string').map((key) => [key, args[key] as string])) as Partial<Record<K, string>>;
const position = (args: Readonly<Record<string, unknown>>): { position?: 'start' | 'end' } => args.position === 'start' || args.position === 'end' ? { position: args.position } : {};
export const placeInput = (args: Readonly<Record<string, unknown>>): PlaceInput =>
  ({ document: String(args.document ?? ''), ...strings(args, ['session', 'title', 'after']), ...position(args), ...(args.snapshot === true ? { snapshot: true } : {}) });
export const removeInput = (args: Readonly<Record<string, unknown>>): RemoveInput =>
  ({ document: String(args.document ?? ''), block: String(args.block ?? '') });
export const boardInput = (args: Readonly<Record<string, unknown>>): BoardInput =>
  ({ html: String(args.html ?? ''), ...strings(args, ['title', 'board', 'document', 'after']), ...position(args) });
const numbers = <K extends string>(args: Readonly<Record<string, unknown>>, keys: readonly K[]) =>
  Object.fromEntries(keys.filter((key) => typeof args[key] === 'number').map((key) => [key, args[key] as number])) as Partial<Record<K, number>>;
export const readInput = (args: Readonly<Record<string, unknown>>): ReadInput =>
  ({ document: String(args.document ?? ''), ...numbers(args, ['from', 'limit']) });
export const writeInput = (args: Readonly<Record<string, unknown>>): WriteInput =>
  ({ document: String(args.document ?? ''), markdown: String(args.markdown ?? ''), ...strings(args, ['after', 'replace']), ...position(args) });
export const imageInput = (args: Readonly<Record<string, unknown>>): ImageInput =>
  ({ document: String(args.document ?? ''), ...strings(args, ['path', 'data', 'name', 'after']), ...position(args) });
export const deleteInput = (args: Readonly<Record<string, unknown>>): DeleteInput =>
  ({ document: String(args.document ?? ''), blocks: String(args.blocks ?? '') });
export const shareCreateInput = (args: Readonly<Record<string, unknown>>): { document: string; label: string; rights?: string } =>
  ({ document: String(args.document ?? ''), label: String(args.label ?? ''), ...strings(args, ['rights']) });
export const startInput = (args: Readonly<Record<string, unknown>>): StartInput =>
  ({ prompt: String(args.prompt ?? ''), directory: String(args.directory ?? ''),
    ...strings(args, ['device', 'provider', 'model', 'effort', 'document', 'title', 'after']), ...position(args) });

const docRef = (target: DocTarget) => ({ title: target.title || '飞书文档', ...(target.url ? { url: target.url } : {}) });
const docInfo = (target: DocTarget) => ({ title: target.title, id: target.documentId, ...(target.url ? { url: target.url } : {}) });

/** The image type its first bytes say, among those Feishu image blocks show. */
function imageKind(data: Buffer): string | null {
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 6 && data.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
  return null;
}

/**
 * A board's HTML as stored. The card renders static markup only, so a script
 * is refused here with the reason rather than silently dropped there.
 */
function boardHtml(raw: string): string {
  const html = raw.trim();
  if (!html) throw new DocsAddonError(400, '看板需要 html 内容');
  if (html.length > MAX_BOARD_HTML) throw new DocsAddonError(413, `看板 HTML 最长 ${MAX_BOARD_HTML} 个字符；请精简内容或拆成几块看板`);
  if (/<script\b/i.test(html)) throw new DocsAddonError(400, '看板只显示静态 HTML：脚本不会执行。请改用 HTML 表格、CSS 和内联 SVG');
  return html;
}

/**
 * A session the owner named by its title (what its terminal shows, a leading
 * status glyph aside): the one exact match, else the one title containing the
 * name. Several are handed back with their ids rather than guessed between.
 */
function sessionByTitle(rows: readonly HubSessionSummary[], wanted: string): HubSessionSummary | undefined {
  const norm = (value: string) => value.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const name = norm(wanted);
  const titled = name ? rows.filter((row) => row.title && norm(row.title)) : [];
  const exact = titled.filter((row) => norm(row.title!) === name);
  const hits = exact.length ? exact : titled.filter((row) => norm(row.title!).includes(name));
  if (hits.length <= 1) return hits[0];
  throw new DocsAddonError(409, `有 ${hits.length} 个会话的标题像「${excerpt(wanted)}」，请改用其中一个的 resource_id：${hits.slice(0, 6)
    .map((row) => `「${excerpt(row.title!)}」${[row.deviceId, row.cwdDisplay ?? row.cwd, row.lastActivity].filter(Boolean).join(' · ')} → ${row.resourceId}`).join('；')}`);
}

/** The auto-registered whole home folder is never shared: it holds every credential the account has. */
const shareable = (workspace: { display?: string }) => workspace.display !== '~';

/**
 * The owner's message from a card, with the document it was sent from: "change
 * this in the document" then names a document the agent can open by its id.
 * Only the owner sends, so the card's own word for its document is enough.
 */
export function cardMessage(prompt: string, origin?: { doc?: string; title?: string }, speaker?: { name: string; owner: string }): string {
  const one = (value: string) => value.replace(/[\s【】]+/g, ' ').trim().slice(0, 60);
  const head = speaker ? `【发言人：${one(speaker.name)}，经 ${one(speaker.owner)} 授权】\n` : '';
  const title = (origin?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const doc = origin?.doc && parseDocumentRef(origin.doc)?.kind === 'token' ? origin.doc : '';
  const foot = title || doc ? `\n\n（这条消息是从飞书云文档${title ? `《${title}》` : ''}里的 Agent 卡片发来的${doc ? `，document_id：${doc}` : ''}；消息里说的“这个文档”就是它。）` : '';
  return `${head}${prompt}${foot}`;
}

/** The rows up to the turn that ended at `at`; rows after it belong to later turns. Without a time, all rows. */
export function cutAt(rows: readonly TranscriptRow[], at?: string): TranscriptRow[] {
  const limit = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(limit)) return [...rows];
  let end = -1;
  rows.forEach((row, index) => { const time = row.at ? Date.parse(row.at) : NaN; if (Number.isFinite(time) && time <= limit) end = index; });
  return rows.slice(0, end + 1);
}

const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/** A prompt the Runner cannot take as one message is refused here, saying how large it is. */
function fitPrompt(prompt: string, budget: number, what: string): void {
  const bytes = Buffer.byteLength(prompt);
  if (bytes > budget) throw new DocsAddonError(413, `${what}有 ${kb(bytes)}，超过一条${what}能携带的 ${kb(budget)}`);
}

/**
 * A new agent's first instruction: the owner's task, then the document it was
 * created in. The document text is a snapshot and goes along whole while the
 * instruction still fits one session prompt; otherwise none of it goes, and the
 * agent is told how long it is and how to read it itself. Never a silent cut.
 * `bytes` is the size of a text the card did not send because it could not fit.
 */
export function firstInstruction(task: string, doc: { title?: string; id?: string; text?: string; bytes?: number } = {}, budget: number = MACHINE_LIMITS.startMaxPromptBytes): string {
  const title = doc.title?.trim();
  const id = doc.id && parseDocumentRef(doc.id)?.kind === 'token' ? doc.id.trim() : '';
  const text = doc.text?.trim() ?? '';
  const omitted = text ? Buffer.byteLength(text) : Math.max(0, Math.floor(doc.bytes ?? 0));
  if (!title && !id && !omitted) return task;
  const head = [
    task,
    '',
    '---',
    `你是在飞书文档${title ? `《${title}》` : ''}里新建的 Agent。文档里的协作者会实时只读看到你的对话（只显示文字和用到的工具名）。`,
    '回复里提到文件时，写出相对当前目录的路径（例如 `results/fig1.png`），协作者可以在卡片里直接点开它们（前提是这个目录已共享给他们）。',
    ...(id ? [`这篇文档的 document_id：${id}。`] : []),
  ];
  if (text) {
    const whole = [...head, '', '以下是新建时文档的正文（之后可能有更新）：', '<<<', text, '>>>'].join('\n');
    if (Buffer.byteLength(whole) <= budget) return whole;
  }
  if (!omitted) return head.join('\n');
  return [...head, '', `文档正文有 ${kb(omitted)}，连同任务超过了一条任务能携带的 ${kb(budget)}，所以没有附在这里；`
    + (id ? '需要时请按上面的 document_id 读取全文（例如 feishu_doc_read；feishu_doc_outline 可以看结构）。' : '需要时请自己打开这篇文档阅读。')].join('\n');
}

/**
 * A card has no takeover action, so an uncertain send is worded for the card:
 * nothing will be resent, and the notice clears itself once the device finds
 * the message in the agent's own record.
 */
const operationView = (value: SessionOperationView): AgentOperation => ({ id: value.id, status: value.status, live: value.live, at: value.submittedAt,
  message: value.status !== 'unknown' ? value.message : uncertain(value.operation) });
const uncertain = (operation: string) => operation === 'interrupt_session'
  ? '还不能确认 Agent 已经停下，Octopus 不会再按一次停止；请看状态栏，或到本机 CLI 看一眼。'
  : '还不能确认 Agent 收到了这条消息，Octopus 不会自动重发；等它出现在会话里，这条提示会自动消失。也可以到本机 CLI 看一眼。';

/**
 * What a frame says of a document assistant's card: whom it works for — to
 * the owner, with the end of the guest's verified open_id, since the name is
 * whatever the guest's card sent — and whether it is in the document.
 */
const assistantFrame = (assistant: DocAssistant | null, identity: DocsAddonIdentity, owner: string): Pick<CardFrame, 'assistant'> =>
  assistant ? { assistant: {
    guest: identity.username === owner && identity.openId !== assistant.guestOpenId ? verifiedGuestName(assistant) : assistant.guestName,
    pinned: assistant.pinnedAt !== null,
  } } : {};
/** Pinning changes what an assistant's card shows without a new message, so it is part of the revision. */
const pinnedMark = (assistant: DocAssistant | null) => assistant?.pinnedAt != null ? '.p' : '';

/** A guest's message or stop as the card shows it, from the device's receipt for it. */
function receiptView(id: string, receipt: LaunchReceipt, operation: 'append_session' | 'interrupt_session', at: string): AgentOperation {
  switch (receipt.state) {
    case 'succeeded': return { id, status: 'succeeded', live: false, at, message: operation === 'interrupt_session' ? '已停止' : '已完成' };
    case 'failed': return { id, status: 'failed', live: false, at, message: receipt.error ?? (operation === 'interrupt_session' ? '没能停止' : '没有发出') };
    case 'running': return { id, status: 'running', live: true, at, message: operation === 'interrupt_session' ? '正在停止…' : '文档助手正在处理' };
    case 'missing': return { id, status: 'submitted', live: true, at, message: '正在交给设备…' };
    default: return { id, status: 'unknown', live: false, at, message: uncertain(operation) };
  }
}

/** Tools whose pending call means the agent is asking its owner something. */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'request_user_input', 'ask_user']);
const iso = (value: unknown): string | undefined => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

/**
 * What the card's status bar says. Working is the shared activityPhase
 * judgement; the Runner's turn facts add "waiting for the owner" and when the
 * turn began; the transcript gives the owner's last message and the agent's
 * last reply. `readAt` is passed for the owner only, who alone has unread.
 */
export function statusOf(watch: Pick<Watch, 'activity' | 'runtime' | 'rows'>, now: number, readAt?: string | null): AgentStatus {
  const { activity } = watch;
  const state = activity?.state ?? 'unknown';
  const runtime = watch.runtime && typeof watch.runtime === 'object' ? watch.runtime as Record<string, unknown> : {};
  const turn = runtime.turn && typeof runtime.turn === 'object' ? runtime.turn as Record<string, unknown> : {};
  const interaction = runtime.interaction && typeof runtime.interaction === 'object' ? runtime.interaction as Record<string, unknown> : null;
  const working = activityPhase(activity, now) === 'live';
  const waiting: AgentStatus['waiting'] = interaction ? (interaction.kind === 'permission' ? 'permission' : 'question')
    : runtime.turn_state === 'needs_input' || turn.state === 'needs_input' ? (runtime.event === 'PermissionRequest' ? 'permission' : 'question')
    : working && state === 'tool' && activity?.tool && ASKING_TOOLS.has(activity.tool) ? 'question' : undefined;
  const newest = (role: TranscriptRow['role']) => { for (let i = watch.rows.length - 1; i >= 0; i--) if (watch.rows[i].role === role) return watch.rows[i].at; return undefined; };
  const lastUserAt = iso(newest('user'));
  const lastReplyAt = iso(newest('assistant'));
  const turnStartedAt = iso(turn.started_at) ?? lastUserAt;
  const finished = !working && !waiting && lastReplyAt !== undefined && (!lastUserAt || lastReplyAt >= lastUserAt);
  return {
    working,
    state: (['thinking', 'tool', 'responding', 'idle'] as const).find((s) => s === state) ?? 'unknown',
    ...(activity?.tool ? { tool: activity.tool.slice(0, 80) } : {}),
    ...(activity?.since ? { since: activity.since } : {}),
    ...(waiting ? { waiting } : {}),
    ...(turnStartedAt ? { turnStartedAt } : {}),
    ...(lastReplyAt ? { lastReplyAt } : {}),
    ...(readAt !== undefined && finished && (!readAt || lastReplyAt! > readAt) ? { unread: true } : {}),
  };
}

/**
 * The card shows conversation text and tool NAMES only. Thinking, tool inputs
 * and tool outputs stay in the owner's own Octopus views: a card is readable by
 * the whole document audience.
 */
export function project(messages: readonly unknown[], offset: number): TranscriptRow[] {
  const rows = messages.flatMap((raw, k): TranscriptRow[] => {
    if (!raw || typeof raw !== 'object') return [];
    const m = raw as Record<string, unknown>;
    const whole = shownText(m);
    if (whole === null) return [];
    const blocks = blocksOf(m);
    const text = whole.slice(0, MAX_TEXT);
    const tools = [...new Set(blocks.filter((b) => b.type === 'tool' && typeof b.tool === 'string').map((b) => (b.tool as string).slice(0, 60)))].slice(0, 12);
    if (!text && !tools.length) return [];
    return [{ i: offset + k, role: m.role as TranscriptRow['role'], text, ...(whole.length > text.length ? { cut: whole.length } : {}),
      ...(tools.length ? { tools } : {}), ...(typeof m.timestamp === 'string' ? { at: m.timestamp } : {}) }];
  });
  // Keep the newest rows within one frame's budget; the card asks for older ones (`older`).
  let budget = MAX_FRAME_TEXT;
  let start = rows.length;
  while (start > 0 && budget - rows[start - 1].text.length >= 0) budget -= rows[--start].text.length;
  return rows.slice(start);
}

const blocksOf = (m: Record<string, unknown>) => Array.isArray(m.blocks) ? m.blocks.filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object') : [];

/** The text a card may show of one message, whole; null for a message a card never shows (not a user or agent turn). */
function shownText(m: Record<string, unknown>): string | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const blocks = blocksOf(m);
  return (blocks.length
    ? blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n\n')
    : typeof m.text === 'string' ? m.text : '').trim();
}
