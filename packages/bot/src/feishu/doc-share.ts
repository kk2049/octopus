/**
 * Feishu document share links.
 *
 * An owner lets one collaborator's agent read — or read and write — ONE
 * Feishu docx through Octopus's `/api/mcp`. The collaborator needs no Octopus
 * account and no Feishu app: they register a one-line `claude mcp add`
 * command carrying an `mcp_` bearer whose policy names one share
 * (`feishuDocShare`, groups []). Every call then runs as the Octopus Feishu
 * app (tenant identity) on the document the share row names; no argument
 * names a document, and the operations below are the whole list: nothing here
 * creates, deletes or moves a document, or changes who may open one.
 *
 * Nothing secret travels through an agent or a Feishu message: the owner's
 * own agents can read both (tool results; the owner's chats, through their
 * OAuth). Creating a share mints no token: the share is `pending`, and the
 * owner is told, without a secret, to take its command on the control card.
 * There, signed in, the owner reveals it once: the token is minted and the
 * share turns `active` in one transaction, and the command is shown in that
 * answer only. Agents may only narrow a share (pause, terminate); resuming
 * takes the owner's login on the card too.
 *
 * Shares never expire by time. Each hangs off an anchor: an Octopus control
 * card (the docs add-on widget) in the same document, whose Record carries a
 * `dsa_` capability of which only the SHA-256 is stored — so anyone who can
 * edit the document can bring a deleted card back from its history. One
 * sighting of the card vouches for it for SHARE_ANCHOR_LEASE_MS; renewing that
 * lease asks Feishu again, as the owner, whether the owner may still share it.
 *
 * Who may share: the owner, by Feishu's own `share` permission on the
 * document, asked as the owner at every create, every reveal and every
 * renewal. Feishu is asked about the document's canonical identity, fixed on
 * the anchor when the card is made: its docx id, and the wiki node holding it
 * when it lives in a wiki — looked up from the docx id, never taken from what
 * a caller named. The control card goes in as the owner. The app's own
 * access, granted by adding the app to the document, is what the shared calls
 * run as; it never stands in for the owner's.
 *
 * Readers take their own keys (2026-10-30). The card's capability already
 * meant "whoever can read this card"; now that reader, signed in or not, may
 * also take a key for themselves up to the most the owner allows
 * (`self_serve`), and end any key the card lists. Each such act needs the
 * card to sit in its own document (`hostMatches` says exactly so: a copied
 * card does nothing) and to be vouched for now, and a card hands out a
 * bounded number of keys. A reader's key is minted active, token and row in
 * one transaction, and shown in that answer only. A claim link (`dsi_`, kept
 * as its SHA-256) carries the same power to someone who cannot see the card,
 * minus the host check: the link is not in a document. Pausing, resuming,
 * settings, claim links and the owner's own pending shares stay the owner's,
 * signed in on the card. The owner hears of keys others take or end, never
 * a secret. A shared read shows an add-on block as `[add_on]`, never its
 * Record, so a read key cannot learn the anchor and widen itself.
 *
 * `authorize` is the whole authorization path of a shared call. Writes to one
 * document run one at a time behind a short queue, a delete is pinned to the
 * revision it was read at, and a write in progress stops as soon as its share
 * does.
 */
import type {
  AssistantSettings, DocShareAppAccess, DocShareConnect, DocShareInviteReply, DocShareLink, DocSharePanel, DocShareRevealReply, DocShareSelfReply,
} from '@claude-bot/feishu-docs-addon/protocol';
import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '../logger.js';
import { FEISHU_DOC_SHARE_ID, mcpCredentialOf, mcpFeishuDocSharePolicy, mcpRegistration, mintMcpToken } from '../mcp/tokens.js';
import type { Store } from '../store/store.js';
import type {
  DocShare, DocShareAnchor, DocShareRights, DocShareSelfServe, DocShareStatus, DocShareVia, FeishuDocShareLinksRepository,
} from '../store/repositories/feishu-doc-share-links.js';
import type { CardPayload } from './direct-card.js';
import { DocsAddonError } from './docs-addon-auth.js';
import { docShareCreatedCard, docShareKeyCard, type DocShareKeyNotice } from './docs-notify.js';
import {
  blockIdsOf, blockKind, blockText, findDocument, FeishuRefusal, insertCard, outlinePage, readingOrder, writeMarkdown,
  type DocBlock, type DocTarget, type FeishuDocsClient,
} from './docs-openapi.js';

const log = createLogger('feishu-doc-share');

/** How long one sighting of a control card vouches for it (and for its owner's right to share): a deleted card stops its shares within this. */
export const SHARE_ANCHOR_LEASE_MS = 24 * 60 * 60_000;
/** One `feishu_shared_doc_read` answer carries about this many characters; `next` continues. */
export const READ_PAGE_CHARS = 100_000;
/** Markdown one shared write carries at most, in UTF-8 bytes. */
export const SHARED_WRITE_MAX_BYTES = 1024 * 1024;
/** Calls one share may make in a minute; past that it waits for the next minute. */
export const SHARE_CALLS_PER_MINUTE = 60;
/** A card shown while its anchor reads missing is looked for again at most this often. */
export const PANEL_RECHECK_MS = 60_000;
/** Shared writes waiting behind the one running on a document; past that a write is turned away to retry. */
export const WRITE_QUEUE_MAX = 4;
/** Keys readers may take for themselves on one card in a rolling hour, on the card and through its claim link together. */
export const SELF_SERVE_PER_HOUR = 10;
/** Keys one card may hold that are not terminated, whoever made them; a reader's key past that is refused. */
export const SHARES_PER_CARD = 50;
/** How long Feishu's answer about the app's own access to a document stands. */
export const APP_ACCESS_MS = 60_000;
/** Notices of keys readers take (or end) go to the owner once per card and kind in this window. */
export const KEY_NOTICE_MS = 10 * 60_000;
/** How long the panel's answer to "is this card in its own document" stands per card and host token: the card polls, and the answer may cost a Feishu call. */
export const HOST_MATCH_MS = 10 * 60_000;
/** Where the Dashboard serves a claim link's page; the link carries its secret after `#i=`. */
export const DOC_KEY_PATH = '/doc-key';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A block longer than this shows its beginning in a read page; block_read gives it whole. */
const READ_BLOCK_CHARS = 20_000;
const REMOVE_MAX = 50;
const LABEL_MAX = 60;
/** Nesting deeper than this is not walked, so nothing below it can be vouched for. */
const MAX_DEPTH = 64;
/** Entries each in-memory bookkeeping map keeps; the oldest goes first. */
const REMEMBERED = 4096;
/** What this bridge mints: `dsa_` and 32 random bytes in URL-safe base64 (43 characters, no padding). */
const ANCHOR = /^dsa_[A-Za-z0-9_-]{43}$/;
/** A claim link's secret, minted the same way as an anchor. */
const INVITE = /^dsi_[A-Za-z0-9_-]{43}$/;
/**
 * The public URL a key's ways in name: an https origin and plain path, so it
 * sits unquoted in a shell line and inside a printf format and a TOML string
 * (no quote, `%`, backslash, space or other shell-special character).
 */
const PLAIN_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*\/?$/;
/** A document token as a card's host reports it: a docx id or a wiki node token. */
const DOC_TOKEN = /^[A-Za-z0-9]{16,64}$/;
/** Block ids go into request paths under the shared document: nothing that could step out of it. */
const BLOCK_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Text blocks whose text `feishu_shared_doc_block_update` replaces: paragraph, headings, list items, code, quote, to-do. */
const TEXT_BLOCKS: ReadonlySet<number> = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]);
/** Synced blocks (source 49, reference 50) carry content other documents show too: a share never changes them. */
const SYNCED_BLOCKS: ReadonlySet<number> = new Set([49, 50]);
const ADD_ON = 40;
/** Hosts a collaborator outside this machine could never reach. */
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;

const TAKE_ON_CARD = '在文档的 Octopus 控制卡片上点「显示接入命令」领取（只显示一次）';
const CARD_GONE = '文档里的 Octopus 控制卡片已被删除，这个共享随之停止；如需继续，请联系文档所有者';
const OWNER_ON_HOLD = '无法确认文档所有者仍能分享这篇文档（他的分享权限被收回，或他的飞书授权已失效），这个共享暂停使用；所有者恢复后会自动恢复';
const SYNCED = '同步块的内容会同步到别的文档：共享连接不能改动或删除同步块，也不能往里面写入';
const HOLDS_ADD_ON = '这里有组件块（例如 Octopus 控制卡片）：共享连接不能删除或改动它';
const INCOMPLETE = '没能读到这部分文档的完整结构，为安全起见没有改动；请稍后重试';
const TOO_DEEP = `嵌套超过 ${MAX_DEPTH} 层，为安全起见没有改动`;
const SELF_SERVE_OFF = '文档所有者没有开放自助领取访问密钥；需要的话请联系所有者';
const READ_ONLY_CEILING = '文档所有者只开放了只读密钥：请改选「只读」';
const NOT_HERE = '无法确认这张卡片就在它管理的那篇文档里（例如它是从别的文档复制过来的），为安全起见';
const CARD_NOT_FOUND = '文档里的 Octopus 控制卡片已被删除（或暂时找不到），现在不能领取访问密钥；请联系文档所有者';
const INVITE_UNKNOWN = '这个领取链接无效，或者文档所有者已经重置或停用了它；请向所有者要新的链接';

/** The shared-document tools, all of them. A read share gets the first three. */
export const SHARED_DOC_READ_TOOLS = ['feishu_shared_doc_read', 'feishu_shared_doc_outline', 'feishu_shared_doc_block_read'] as const;
export const SHARED_DOC_WRITE_TOOLS = ['feishu_shared_doc_write', 'feishu_shared_doc_block_update', 'feishu_shared_doc_remove'] as const;
const ACTIONS = ['pause', 'resume', 'terminate'] as const;
export type DocShareAction = typeof ACTIONS[number];

/** One link as a control card lists it (`share-panel`, `share-action`). Times are epoch ms. */
export type DocShareLinkView = DocShareLink;
/** A control card's links as `share-panel` reports them. */
export type DocSharePanelView = DocSharePanel;
/** What `share-reveal` answers the owner: the link, now active, and its command, this once. */
export type DocShareRevealView = DocShareRevealReply;
/** What a reader's own key answers (`share-self`, `invite-claim`): the key, active, and its ways in, this once. */
export type DocShareSelfView = DocShareSelfReply;
/** What `share-invite` answers the owner; a new link's secret only in the answer that made it. */
export type DocShareInviteView = DocShareInviteReply;
/** What a claim link's page shows before anything is taken. `doc_title` is empty when the app could not read it. */
export interface DocShareInviteInfo { doc_title: string; self_serve: DocShareSelfServe }

/**
 * Who looks at a control card: a tenant member signed in on it (with their
 * Octopus account when one is mapped), or null for a reader who is not. The
 * card's capability is the authority; this decides only who is its owner
 * and which keys are the reader's own.
 */
export interface DocShareViewer { openId: string; username: string | null }

/**
 * Who calls through a share: the token's owner and credential handle, and the
 * share its policy names. Never from arguments. `via: 'assistant'` is set by
 * the MCP surface only once a document assistant's read-only scope resolved.
 */
export interface DocShareCaller { shareId: string; owner: string; credential: string; via?: 'assistant' }

export interface FeishuDocShareOptions {
  links: FeishuDocShareLinksRepository;
  /** A share's token is an ordinary MCP token row, minted and revoked in one transaction with the share row. */
  tokens: Pick<Store, 'saveMcpToken' | 'revokeMcpToken' | 'withinTransaction'>;
  /** Docx calls as the owner; `asApp()` gives the same calls as the Octopus app. */
  docs: FeishuDocsClient;
  /** The docs add-on widget's block type id. Without it there are no control cards, so no shares. */
  componentTypeId?: string;
  /** The deployment's public URL, which a share's command names. Shares are made only when it is https and not a loopback host. */
  publicUrl?: string;
  /** Sends the owner a private Feishu message from the app (never anything secret); rejects when it cannot be delivered. */
  notifyOwner(owner: string, card: CardPayload): Promise<void>;
  /**
   * The live read-only scope an assistant caller's credential is: the share
   * it reaches and where it reads (its device and workspace). Null when there
   * is none; absent, no assistant share answers.
   */
  assistantScope?(caller: DocShareCaller): AssistantScope | null;
  /** A document assistant's share ended (terminated, or its token revoked): the assistant ends with it. */
  onAssistantEnded?(shareId: string): void;
  /** What the card's panel tells every reader about its document assistants (`doc-assistants.ts`); absent or undefined: there are none. */
  assistantSettings?(anchorId: string): AssistantSettings | undefined;
  now?: () => number;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();

/** A share's status as it stands: once revealed, a token revoked elsewhere (or deleted with its account) ended it too. */
export const shareStatus = (share: DocShare): DocShareStatus =>
  (share.status === 'active' || share.status === 'paused') && !share.tokenLive ? 'terminated' : share.status;

/** A document's canonical identity: its docx id, and the wiki node holding it when it lives in a wiki. */
interface Canonical { documentId: string; wikiToken: string | null }
/** What Feishu's permission check is asked about, decided by the canonical identity alone. */
const identityOf = (doc: Canonical): { token: string; type: 'wiki' | 'docx' } =>
  doc.wikiToken ? { token: doc.wikiToken, type: 'wiki' } : { token: doc.documentId, type: 'docx' };
const sameIdentity = (a: Canonical, b: Canonical) => a.documentId === b.documentId && a.wikiToken === b.wikiToken;

/** A document assistant's live read-only scope, as the session registry holds it. */
export interface AssistantScope { docShare: string; device: string; workspaceId: string }

/** A card's assistants where none can run: off, with nothing to read and no room. */
const ASSISTANTS_OFF: AssistantSettings = { rights: null, project: null, limits: { per_card: 0, per_guest: 0, per_guest_per_day: 0 } };

/** The card's last sighting still vouches for it. */
const vouched = (anchor: DocShareAnchor, now: number) => anchor.state === 'present' && anchor.leaseUntil > now;

/** The card's owner, signed in on it. */
const isOwner = (viewer: DocShareViewer | null, anchor: DocShareAnchor) => viewer !== null && viewer.username === anchor.owner;

/**
 * A share as its control card lists it; `mine` for the signed-in reader who
 * took it. The card's contract does not know `assistant` yet: such a key is
 * the owner's doing, and shows as theirs.
 */
const cardView = (share: DocShare, viewer: DocShareViewer | null): DocShareLinkView => ({
  id: share.id, label: share.label, rights: share.rights, status: shareStatus(share), created_at: share.createdAt, last_used_at: share.lastUsedAt,
  via: viaOf(share.via), mine: viewer !== null && share.mintedBy === viewer.openId,
});
const viaOf = (via: DocShareVia): DocShareLinkView['via'] => via === 'assistant' ? 'owner' : via;

/** A share as the owner's agent reads it. Its token is never part of it. */
const ownerView = (share: DocShare, anchor: DocShareAnchor | null) => ({
  share_id: share.id, document_id: share.documentId, label: share.label, rights: share.rights, status: shareStatus(share), via: share.via,
  created_at: iso(share.createdAt), last_used_at: share.lastUsedAt === null ? null : iso(share.lastUsedAt),
  card: { state: anchor?.state ?? 'unknown', ...(anchor?.blockId ? { block: anchor.blockId } : {}),
    ...(anchor?.state === 'present' ? { seen_until: iso(anchor.leaseUntil) } : {}) },
});

export class FeishuDocShareService {
  private readonly app: FeishuDocsClient;
  private readonly now: () => number;
  /** One presence check per card at a time; every call arriving meanwhile waits for it. */
  private readonly checks = new Map<string, Promise<boolean>>();
  /** One card placement per owner and document at a time, so parallel creates share one card. */
  private readonly placing = new Map<string, Promise<{ anchor: DocShareAnchor; reused: boolean }>>();
  /** Host tokens an owner's card reported, resolved as wiki nodes: the docx each holds ('' when it holds something else). */
  private readonly hosts = new Map<string, string>();
  /** When a card shown while missing last had its anchor looked for. */
  private readonly rechecked = new Map<string, number>();
  /** Each share's calls in its current minute. */
  private readonly calls = new Map<string, { since: number; count: number }>();
  /** Each document's write lane: the tail of its queue, and how many writes run or wait in it. */
  private readonly writing = new Map<string, { tail: Promise<void>; size: number }>();
  /** What the app may do in each document, as Feishu last said, and when. */
  private readonly access = new Map<string, { at: number; access: DocShareAppAccess }>();
  /** When the owner of each card last heard of a reader's key, per kind of notice. */
  private readonly noticed = new Map<string, number>();
  /** The panel's host matches per card and host token, and when each was made. */
  private readonly matched = new Map<string, { at: number; matches: boolean | null }>();
  /** The app's name, once Feishu said it. */
  private name: string | null = null;

  constructor(private readonly options: FeishuDocShareOptions) {
    this.app = options.docs.asApp();
    this.now = options.now ?? Date.now;
  }

  // ── the owner, through their own agent ──

  /**
   * A new share of one document, pending. The owner names the document as
   * themselves; it is pinned to its canonical identity, and Feishu, asked as
   * the owner about that identity, must say they may share it. The app must be
   * able to read it (else the owner is told to add the app); the owner's
   * control card there is reused once found, or put in at the end as the
   * owner. No token exists yet: the owner takes the command on the card. The
   * owner is told so in a private message that carries no secret; whether it
   * arrived is part of the answer, and a lost one changes nothing else. The
   * answer says what the app may do in the document, and warns when a
   * read-write share would not be able to write.
   */
  async create(owner: string, input: { document: string; label: string; rights?: string }): Promise<Record<string, unknown>> {
    const componentTypeId = this.componentTypeId();
    this.endpoint();
    const label = labelOf(input.label, '请给这个共享起个名字（label），例如协作者的名字');
    const rights: DocShareRights = input.rights === undefined || input.rights === 'write' ? 'write' : input.rights === 'read' ? 'read' : invalid('rights 只能是 write 或 read');
    const target = await this.canonical(owner, input.document);
    // Feishu is asked about the identity the card carries — fixed when it was made — or, for a new card, this one.
    const asked: Canonical = this.options.links.liveAnchor(owner, target.documentId) ?? target;
    await this.ownerMayShare(owner, asked, 'owner');
    // What every shared call will run as must be able to read the document.
    const shared = await this.app.document(owner, target.documentId);
    const placed = await this.anchorFor(owner, target, asked, componentTypeId);
    const id = `shr_${randomBytes(12).toString('hex')}`;
    this.options.links.createShare({ id, anchorId: placed.anchor.id, owner, documentId: placed.anchor.documentId, label, rights, createdAt: this.now() });
    const document = { id: target.documentId, title: shared.title || target.title, ...(target.url ? { url: target.url } : {}) };
    let notified = true;
    try {
      await this.options.notifyOwner(owner, docShareCreatedCard({ doc: { title: document.title || '飞书文档', ...(document.url ? { url: document.url } : {}) }, label, rights }));
    } catch (error) {
      notified = false;
      log.warn({ err: error, owner, share: id }, 'document share notice could not be delivered');
    }
    const access = await this.appAccess(owner, target.documentId);
    return {
      share_id: id, label, rights, status: 'pending', document, next: TAKE_ON_CARD, owner_notified: notified,
      notice: notified ? '已私信通知所有者（通知里没有命令）' : '私信通知没有发出；直接到文档里的 Octopus 控制卡片上领取即可',
      app_access: access, ...(rights === 'write' && access !== 'edit' ? { warning: editHint(access, await this.appName()) } : {}),
    };
  }

  /** The owner's shares, of one document or all of them; never their tokens. */
  async list(owner: string, document?: string): Promise<Record<string, unknown>> {
    this.componentTypeId();
    const documentId = document?.trim() ? (await findDocument(this.options.docs, owner, document)).documentId : undefined;
    return { shares: this.options.links.ownedShares(owner, documentId).map((share) => ownerView(share, this.options.links.anchor(share.anchorId))) };
  }

  /**
   * An agent narrows one of the owner's shares: pause or terminate. Resuming
   * widens authority again, so it takes the owner's own login on the card.
   */
  update(owner: string, shareId: string, action: string): Record<string, unknown> {
    this.componentTypeId();
    if (action === 'resume') throw new DocsAddonError(400, '恢复共享只能由所有者在文档里的 Octopus 控制卡片上操作；Agent 只能暂停或终止共享');
    if (action !== 'pause' && action !== 'terminate') invalid('action 只能是 pause 或 terminate');
    const share = this.options.links.share(shareId.trim());
    if (!share || share.owner !== owner) throw new DocsAddonError(404, '找不到这个文档共享：请用 feishu_doc_share_list 返回的 share_id');
    const next = this.transition(share, action as DocShareAction);
    if (next === 'terminated') throw new DocsAddonError(409, '这个文档共享已经终止，不能再暂停；需要的话请重新创建一个');
    if (next === 'pending') throw new DocsAddonError(409, '这个文档共享还没有领取接入命令，没有可以暂停的；不需要了就终止它');
    return { share: ownerView(next, this.options.links.anchor(next.anchorId)) };
  }

  // ── the control card (docs add-on routes; errors are the contract's codes) ──

  /**
   * What a control card shows. Anyone holding the card may look, signed in
   * or not. A card shown while its anchor reads missing is probably back
   * (restored from history, say): it is looked for again at once — at most
   * once per PANEL_RECHECK_MS per card — so its links return without waiting
   * for one of them to be used; a check that fails leaves the state as it
   * was. `hostToken`, the document the card's host says it is in, is matched
   * for every reader, so a copied card shows as one to all of them; as the
   * card polls and a match may cost a Feishu call, each card and host token's
   * answer stands for HOST_MATCH_MS. A reader's own acts match it afresh. The
   * claim link's state is the owner's alone.
   */
  async panel(viewer: DocShareViewer | null, capability: string, hostToken?: string): Promise<DocSharePanelView> {
    let anchor = this.anchorOf(capability);
    if (anchor.state === 'missing' && this.mayRecheck(anchor.id)) {
      await this.present(anchor).catch(() => false);
      anchor = this.options.links.anchor(anchor.id) ?? anchor;
    }
    const owner = isOwner(viewer, anchor);
    const [hostMatches, appAccess, appName] = await Promise.all([
      this.panelHost(anchor, hostToken), this.appAccess(anchor.owner, anchor.documentId), this.appName(),
    ]);
    const assistant = this.options.assistantSettings?.(anchor.id) ?? ASSISTANTS_OFF;
    return {
      // Which document the card manages, and where its project lives, are the owner's: a reader of a copy of the card
      // must not learn the original's id here and replay it as the host token.
      document_id: owner ? anchor.documentId : '',
      host_matches: hostMatches,
      viewer_is_owner: owner,
      card_state: anchor.state,
      lease_until: anchor.state === 'present' ? anchor.leaseUntil : null,
      shares: this.options.links.anchorShares(anchor.id).map((share) => cardView(share, viewer)),
      self_serve: anchor.selfServe,
      app_access: appAccess,
      app_name: appName,
      invite: owner ? { active: anchor.inviteHash !== null, created_at: anchor.inviteCreatedAt } : null,
      limits: { per_hour: SELF_SERVE_PER_HOUR, active_max: SHARES_PER_CARD },
      assistant: owner || !assistant.project ? assistant : { ...assistant, project: { device: '', workspace_id: '', label: assistant.project.label } },
    };
  }

  /**
   * One key the card lists, acted on. Its owner, signed in on the card, may
   * pause and resume it (the one place a paused share is resumed) or
   * terminate it. Anyone else holding the card may only terminate it, and
   * only on the card in its own document: a copy elsewhere ends nothing. A
   * pending share is revealed or terminated, never paused or resumed.
   */
  async act(viewer: DocShareViewer | null, capability: string, shareId: string, action: DocShareAction, hostToken?: string): Promise<{ share: DocShareLinkView }> {
    const anchor = this.anchorOf(capability);
    if (!(ACTIONS as readonly string[]).includes(action)) throw new DocsAddonError(400, 'invalid_action');
    const owner = isOwner(viewer, anchor);
    if (!owner && action !== 'terminate') throw new DocsAddonError(403, 'not_owner');
    if (!owner && await this.hostMatches(anchor, hostToken) !== true) throw new DocsAddonError(403, `${NOT_HERE}不能在这里终止密钥`);
    const share = this.listed(anchor, shareId);
    // A document assistant's share is not one of the card's keys: here only its owner acts on it (its guest ends it as an assistant).
    if (!owner && share.via === 'assistant') throw new DocsAddonError(403, 'not_owner');
    const next = this.transition(share, action);
    if (next === 'terminated' || next === 'pending') throw new DocsAddonError(409, next);
    if (!owner) this.tell(anchor, { kind: 'ended', actor: actorOf(viewer, 'card'), label: share.label });
    return { share: cardView(next, viewer) };
  }

  /**
   * The owner, signed in on the card, takes a pending share's command. Feishu
   * is asked again, as the owner, whether they may share the document; then
   * its MCP token is minted and the share turns active in one transaction, so
   * this happens once. The command exists in this answer only: it is never
   * stored, logged or sent anywhere else. `live` re-checks the owner's login
   * just before the token is minted.
   */
  async reveal(viewer: DocShareViewer | null, capability: string, shareId: string, live: () => void = () => {}): Promise<DocShareRevealView> {
    const { anchor, share } = this.ownersShare(viewer, capability, shareId);
    if (share.status !== 'pending') throw new DocsAddonError(409, 'not_pending');
    const endpoint = this.endpoint();
    await this.ownerMayShare(anchor.owner, anchor, 'owner');
    live();
    const at = this.now();
    const minted = this.options.tokens.withinTransaction(() => {
      const token = mintMcpToken(this.options.tokens, { username: share.owner, label: `飞书文档共享 · ${share.label}`, policy: mcpFeishuDocSharePolicy(share.id), now: () => at });
      if (!this.options.links.activate(share.owner, share.id, token.row.token_hash, at)) throw new DocsAddonError(409, 'not_pending');
      return token;
    });
    const connect = shareConnect(endpoint, share.id, minted.token);
    return { share: cardView(this.options.links.share(share.id)!, viewer), command: connect.claude, connect };
  }

  /**
   * A reader of the card takes a key for themselves, signed in or not: the
   * card's capability is the authority. The rights asked must be within the
   * owner's ceiling, the card must be the one in its own document (exactly:
   * a copy, or a host that cannot be matched, is refused), and the card must
   * be vouched for now. Then the key is minted active (see `mint`).
   */
  async selfServe(input: { capability: string; hostToken: string; label: string; rights: string; viewer: DocShareViewer | null }): Promise<DocShareSelfView> {
    this.componentTypeId();
    const anchor = this.anchorOf(input.capability);
    const key = keyOf(anchor.selfServe, input.label, input.rights);
    const endpoint = this.endpoint();
    if (await this.hostMatches(anchor, input.hostToken || undefined) !== true) throw new DocsAddonError(403, `${NOT_HERE}不能在这里领取密钥`);
    await this.vouch(anchor);
    return this.mint(anchor.id, { ...key, via: 'card', mintedBy: input.viewer?.openId ?? null }, endpoint, { viewer: input.viewer });
  }

  /** The owner, signed in on the card, sets the most readers may take for themselves; answers the panel as it is now. */
  async settings(viewer: DocShareViewer | null, capability: string, selfServe: string, hostToken?: string): Promise<DocSharePanelView> {
    const anchor = this.ownedAnchor(viewer, capability);
    if (selfServe !== 'off' && selfServe !== 'read' && selfServe !== 'write') throw new DocsAddonError(400, 'invalid_self_serve');
    this.options.links.setSelfServe(anchor.id, selfServe);
    return this.panel(viewer, capability, hostToken);
  }

  /**
   * The owner, signed in on the card, makes its claim link — a new secret,
   * of which only the SHA-256 is kept, so whatever link it had stops at once
   * — or stops it. The link (the Dashboard's claim page, the secret in its
   * fragment) is in the `create` answer only.
   */
  invite(viewer: DocShareViewer | null, capability: string, op: string): DocShareInviteView {
    const anchor = this.ownedAnchor(viewer, capability);
    if (op === 'revoke') {
      this.options.links.setInvite(anchor.id, null);
      return { invite: { active: false, created_at: null } };
    }
    if (op !== 'create') throw new DocsAddonError(400, 'invalid_op');
    const page = `${this.endpoint().replace(/\/+$/, '')}${DOC_KEY_PATH}`;
    const secret = `dsi_${randomBytes(32).toString('base64url')}`;
    const at = this.now();
    this.options.links.setInvite(anchor.id, { hash: digest(secret), at });
    return { invite: { active: true, created_at: at }, link: `${page}#i=${secret}` };
  }

  /** What a claim link's page shows first: the document's title (read as the app; empty when it cannot be) and the most it may take. */
  async inviteInfo(secret: string): Promise<DocShareInviteInfo> {
    const anchor = this.anchorByInvite(secret);
    const title = await this.app.document(anchor.owner, anchor.documentId).then((doc) => doc.title, () => '');
    return { doc_title: title, self_serve: anchor.selfServe };
  }

  /**
   * Someone holding the card's claim link takes a key: the link is the
   * authority, with the card's own ceiling, limits and presence. There is no
   * host to match, as the link is not in a document.
   */
  async inviteClaim(secret: string, label: string, rights: string): Promise<DocShareSelfView> {
    this.componentTypeId();
    const anchor = this.anchorByInvite(secret);
    const key = keyOf(anchor.selfServe, label, rights);
    const endpoint = this.endpoint();
    await this.vouch(anchor);
    return this.mint(anchor.id, { ...key, via: 'invite', mintedBy: null }, endpoint, { viewer: null, invite: digest(secret) });
  }

  // ── a collaborator's agent, through the share's token ──

  /** The shared-document tools a share may call, by its rights; none unless the bearer is the share's own token. */
  toolNames(caller: DocShareCaller): readonly string[] {
    const share = this.options.links.share(caller.shareId);
    if (!share || !this.bound(share, caller)) return [];
    return share.rights === 'write' ? [...SHARED_DOC_READ_TOOLS, ...SHARED_DOC_WRITE_TOOLS] : SHARED_DOC_READ_TOOLS;
  }

  /** One shared-document call: counted, authorized afresh, then run as the app on the share's own document. */
  async call(caller: DocShareCaller, tool: string, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const access = (SHARED_DOC_READ_TOOLS as readonly string[]).includes(tool) ? 'read' : (SHARED_DOC_WRITE_TOOLS as readonly string[]).includes(tool) ? 'write' : null;
    if (!access) throw new DocsAddonError(404, `没有名为 ${tool} 的文档共享工具`);
    this.admit(caller.shareId);
    const share = await this.authorize(caller, access);
    const at: Shared = { owner: share.owner, documentId: share.documentId, caller };
    switch (tool) {
      case 'feishu_shared_doc_read': return this.read(at, num(args.from));
      case 'feishu_shared_doc_outline': return this.outline(at, { from: num(args.from), limit: num(args.limit) });
      case 'feishu_shared_doc_block_read': return this.blockRead(at, blockId(args.block_id));
      case 'feishu_shared_doc_write': return this.write(at, { markdown: str(args.markdown), ...(typeof args.after === 'string' ? { after: args.after } : {}),
        ...(args.position === 'start' || args.position === 'end' ? { position: args.position } : {}) });
      case 'feishu_shared_doc_block_update': return this.blockUpdate(at, blockId(args.block_id), str(args.text), num(args.revision));
      case 'feishu_shared_doc_remove': return this.remove(at, str(args.blocks));
      default: throw new DocsAddonError(404, `没有名为 ${tool} 的文档共享工具`);
    }
  }

  /**
   * The authorization of every shared call. The bearer must be the share's
   * own token, the share active with the rights `access` needs, and its card
   * seen within the lease; past the lease the owner's right to share and the
   * card are checked now (one check per card at a time). A check that cannot
   * finish refuses and changes nothing. A pause or termination while the
   * check ran wins.
   */
  async authorize(caller: DocShareCaller, access: 'read' | 'write'): Promise<DocShare> {
    this.componentTypeId();
    const share = this.usable(caller, access);
    const anchor = this.options.links.anchor(share.anchorId);
    if (!anchor) throw new DocsAddonError(403, '这个文档共享不存在或已失效');
    if (!vouched(anchor, this.now())) {
      let found: boolean;
      try { found = await this.present(anchor); } catch (error) { throw unchecked(error); }
      if (!found) throw new DocsAddonError(403, CARD_GONE);
    }
    const current = this.usable(caller, access);
    this.options.links.touch(current.id, this.now());
    return current;
  }

  // ── internals ──

  private componentTypeId(): string {
    if (!this.options.componentTypeId) {
      throw new DocsAddonError(503, '这个 Octopus 没有配置飞书文档卡片的组件 ID（feishu_docs_addon.block_type_id），文档共享暂不可用');
    }
    return this.options.componentTypeId;
  }

  /**
   * The public URL a share's command names: https, reachable from outside and
   * plain enough to sit in a key's one-line commands (PLAIN_URL), or no share
   * at all.
   */
  private endpoint(): string {
    let url: URL | undefined;
    try { url = new URL(this.options.publicUrl ?? ''); } catch { url = undefined; }
    if (!url || url.protocol !== 'https:' || LOOPBACK.test(url.hostname) || !PLAIN_URL.test(this.options.publicUrl!)) {
      throw new DocsAddonError(503, '这个 Octopus 的 dashboard.public_url 不是外部可访问的 https 地址，不能创建文档共享：访问令牌只能经 HTTPS 交给协作者');
    }
    return this.options.publicUrl!;
  }

  /**
   * A reader's key, minted active: within the card's ceiling and limits as
   * they stand at this moment (a setting changed, or the claim link replaced,
   * while the checks ran wins), its MCP token — the card owner's, naming this
   * one share — and its row in one transaction. The token is in this answer
   * only: never stored, logged or sent anywhere else. The owner hears that a
   * key was taken, unless they took it.
   */
  private mint(anchorId: string, key: { label: string; rights: DocShareRights; via: 'card' | 'invite'; mintedBy: string | null },
    endpoint: string, by: { viewer: DocShareViewer | null; invite?: string }): DocShareSelfView {
    const id = `shr_${randomBytes(12).toString('hex')}`;
    const at = this.now();
    const { anchor, token } = this.options.tokens.withinTransaction(() => {
      const anchor = this.options.links.anchor(anchorId);
      if (!anchor) throw new DocsAddonError(404, 'unknown_anchor');
      if (by.invite !== undefined && anchor.inviteHash !== by.invite) throw new DocsAddonError(404, INVITE_UNKNOWN);
      within(anchor.selfServe, key.rights);
      if (this.options.links.selfServedSince(anchor.id, at - HOUR_MS) >= SELF_SERVE_PER_HOUR) {
        throw new DocsAddonError(429, `这张卡片一小时内最多自助领取 ${SELF_SERVE_PER_HOUR} 个访问密钥，请稍后再试`);
      }
      if (this.options.links.liveShareCount(anchor.id) >= SHARES_PER_CARD) {
        throw new DocsAddonError(429, `这张卡片上未终止的访问密钥已有 ${SHARES_PER_CARD} 个，到了上限：请先终止不用的密钥`);
      }
      const minted = mintMcpToken(this.options.tokens, { username: anchor.owner, label: `飞书文档共享 · ${key.label}`, policy: mcpFeishuDocSharePolicy(id), now: () => at });
      this.options.links.createActiveShare({ id, anchorId: anchor.id, owner: anchor.owner, documentId: anchor.documentId, label: key.label, rights: key.rights,
        via: key.via, mintedBy: key.mintedBy, mcpTokenHash: minted.row.token_hash, createdAt: at });
      return { anchor, token: minted.token };
    });
    if (!isOwner(by.viewer, anchor)) this.tell(anchor, { kind: 'taken', actor: actorOf(by.viewer, key.via), label: key.label, rights: key.rights, via: key.via });
    return { share: cardView(this.options.links.share(id)!, by.viewer), connect: shareConnect(endpoint, id, token) };
  }

  /**
   * The card vouches for itself now, before a key is taken: seen within its
   * lease, else looked for at once (one check per card at a time; a card last
   * read missing at most once per PANEL_RECHECK_MS). A check that cannot
   * finish refuses.
   */
  private async vouch(anchor: DocShareAnchor): Promise<void> {
    if (vouched(anchor, this.now())) return;
    if (anchor.state === 'missing' && !this.mayRecheck(anchor.id)) throw new DocsAddonError(403, CARD_NOT_FOUND);
    let found: boolean;
    try { found = await this.present(anchor); } catch (error) { throw unconfirmed(error); }
    if (!found) throw new DocsAddonError(403, CARD_NOT_FOUND);
  }

  /**
   * Tells a card's owner, from the app, that someone else took or ended a
   * key there: the first time per card and kind in KEY_NOTICE_MS (the card
   * lists them all). No secret; the document's title is read as the app.
   * Nothing waits for it, and a notice that cannot be sent changes nothing.
   */
  private tell(anchor: DocShareAnchor, notice: DocShareKeyNotice): void {
    const key = `${anchor.id}\u0000${notice.kind}`;
    const last = this.noticed.get(key);
    if (last !== undefined && this.now() - last < KEY_NOTICE_MS) return;
    remember(this.noticed, key, this.now());
    void (async () => {
      const title = await this.app.document(anchor.owner, anchor.documentId).then((doc) => doc.title, () => '');
      await this.options.notifyOwner(anchor.owner, docShareKeyCard({ ...notice, doc: { title } }));
    })().catch((error: unknown) => log.warn({ err: error, owner: anchor.owner, anchor: anchor.id, kind: notice.kind }, 'document share key notice could not be delivered'));
  }

  /**
   * What the app itself may do in a document (every key runs as the app),
   * as Feishu said within APP_ACCESS_MS; `unknown` when Feishu would not say.
   */
  private async appAccess(owner: string, documentId: string): Promise<DocShareAppAccess> {
    const known = this.access.get(documentId);
    if (known && this.now() - known.at < APP_ACCESS_MS) return known.access;
    const access = await this.app.access(owner, documentId).catch((): DocShareAppAccess => 'unknown');
    remember(this.access, documentId, { at: this.now(), access });
    return access;
  }

  /** The app's name, as a document's 「添加文档应用」 lists it: learned once, null until Feishu says it. */
  private async appName(): Promise<string | null> {
    if (this.name !== null) return this.name;
    const name = await this.app.appName().catch(() => null);
    this.name ??= name;
    return this.name;
  }

  /** The caller's own share, active, with the rights the call needs. */
  private usable(caller: DocShareCaller, access: 'read' | 'write'): DocShare {
    const share = this.options.links.share(caller.shareId);
    if (!share || !this.bound(share, caller)) throw new DocsAddonError(403, '这个文档共享不存在或已失效');
    const status = shareStatus(share);
    if (status === 'pending') throw new DocsAddonError(403, '这个文档共享还没有启用：所有者还没有在控制卡片上领取接入命令');
    if (status === 'terminated') throw new DocsAddonError(403, '这个文档共享已被所有者终止');
    if (status === 'paused') throw new DocsAddonError(403, '这个文档共享已被所有者暂停；恢复之前不能访问这篇文档');
    if (access === 'write' && share.rights !== 'write') throw new DocsAddonError(403, '这个文档共享只允许读取');
    return share;
  }

  /** Between the steps of one write: the share must still be usable and its card not found gone. Database reads only. */
  private still(caller: DocShareCaller): void {
    const share = this.usable(caller, 'write');
    const anchor = this.options.links.anchor(share.anchorId);
    if (!anchor || anchor.state === 'missing') throw new DocsAddonError(403, CARD_GONE);
  }

  /** Counts one call of a share; past SHARE_CALLS_PER_MINUTE it waits for the next minute. */
  private admit(shareId: string): void {
    const now = this.now();
    let window = this.calls.get(shareId);
    if (!window || now - window.since >= MINUTE_MS) {
      window = { since: now, count: 0 };
      remember(this.calls, shareId, window);
    }
    if (++window.count > SHARE_CALLS_PER_MINUTE) {
      throw new DocsAddonError(429, `调用太频繁：每个共享每分钟最多 ${SHARE_CALLS_PER_MINUTE} 次，请过一会儿再试`);
    }
  }

  private mayRecheck(anchorId: string): boolean {
    const last = this.rechecked.get(anchorId);
    if (last !== undefined && this.now() - last < PANEL_RECHECK_MS) return false;
    remember(this.rechecked, anchorId, this.now());
    return true;
  }

  /**
   * `hostMatches` for the panel: one card and host token's answer stands for
   * HOST_MATCH_MS, so polling asks Feishu at most once per token in that
   * window. A token that is not a document token is decided without Feishu,
   * so it is never kept.
   */
  private async panelHost(anchor: DocShareAnchor, host: string | undefined): Promise<boolean | null> {
    if (!host || !DOC_TOKEN.test(host)) return this.hostMatches(anchor, host);
    const key = `${anchor.id}\u0000${host}`;
    const known = this.matched.get(key);
    if (known && this.now() - known.at < HOST_MATCH_MS) return known.matches;
    const matches = await this.hostMatches(anchor, host);
    remember(this.matched, key, { at: this.now(), matches });
    return matches;
  }

  /**
   * Whether the card's host document is the share's document: its id, or the
   * wiki node the owner named it by; else the host token is resolved as a wiki
   * node, as the app (remembered). Null with no host token, or when that
   * resolution fails.
   */
  private async hostMatches(anchor: DocShareAnchor, host: string | undefined): Promise<boolean | null> {
    if (!host) return null;
    if (host === anchor.documentId || host === anchor.wikiToken) return true;
    if (!DOC_TOKEN.test(host)) return null;
    let holds = this.hosts.get(host);
    if (holds === undefined) {
      try {
        const node = await this.app.wikiNode(anchor.owner, host);
        holds = node.objType === 'docx' ? node.objToken : '';
      } catch {
        return null;
      }
      remember(this.hosts, host, holds);
    }
    return holds === anchor.documentId;
  }

  /** A share the card lists, for its owner signed in on that card; else the contract's refusal. */
  private ownersShare(viewer: DocShareViewer | null, capability: string, shareId: string): { anchor: DocShareAnchor; share: DocShare } {
    const anchor = this.ownedAnchor(viewer, capability);
    return { anchor, share: this.listed(anchor, shareId) };
  }

  /** The card, for its owner signed in on it; else the contract's refusal. */
  private ownedAnchor(viewer: DocShareViewer | null, capability: string): DocShareAnchor {
    const anchor = this.anchorOf(capability);
    if (!isOwner(viewer, anchor)) throw new DocsAddonError(403, 'not_owner');
    return anchor;
  }

  /** One share this card lists, as it is now. */
  private listed(anchor: DocShareAnchor, shareId: string): DocShare {
    const share = typeof shareId === 'string' ? this.options.links.share(shareId) : null;
    if (!share || share.anchorId !== anchor.id || share.owner !== anchor.owner) throw new DocsAddonError(404, 'unknown_share');
    return share;
  }

  private anchorOf(capability: string): DocShareAnchor {
    const anchor = typeof capability === 'string' && ANCHOR.test(capability) ? this.options.links.anchorByCapability(digest(capability)) : null;
    if (!anchor) throw new DocsAddonError(404, 'unknown_anchor');
    return anchor;
  }

  /** The card a live claim link names; an unknown, malformed, replaced or stopped link is answered alike. */
  private anchorByInvite(secret: string): DocShareAnchor {
    const anchor = typeof secret === 'string' && INVITE.test(secret) ? this.options.links.anchorByInvite(digest(secret)) : null;
    if (!anchor) throw new DocsAddonError(404, INVITE_UNKNOWN);
    return anchor;
  }

  /**
   * One owner action. 'terminated' when the share already is (final);
   * 'pending' for a pause or resume of a share not yet revealed.
   */
  private transition(share: DocShare, action: DocShareAction): DocShare | 'terminated' | 'pending' {
    const at = this.now();
    if (shareStatus(share) === 'terminated') {
      // A token revoked elsewhere already ended it: record that too.
      if (share.status !== 'terminated') {
        this.options.links.transition(share.owner, share.id, ['active', 'paused'], 'terminated', at);
        if (share.via === 'assistant') this.options.onAssistantEnded?.(share.id);
      }
      return 'terminated';
    }
    if (action === 'terminate') this.terminate(share, at);
    else if (share.status === 'pending') return 'pending';
    // Pausing a paused share, or resuming an active one, changes nothing.
    else this.options.links.transition(share.owner, share.id, action === 'pause' ? ['active'] : ['paused'], action === 'pause' ? 'paused' : 'active', at);
    return this.options.links.share(share.id)!;
  }

  /** Ends a share for good: its row and, once revealed, its token, in one transaction. A document assistant's share ends its assistant too. */
  private terminate(share: Pick<DocShare, 'id' | 'owner' | 'mcpTokenHash' | 'via'>, at: number): void {
    this.options.tokens.withinTransaction(() => {
      this.options.links.transition(share.owner, share.id, ['pending', 'active', 'paused'], 'terminated', at);
      if (share.mcpTokenHash) this.options.tokens.revokeMcpToken(share.owner, share.mcpTokenHash, iso(at));
    });
    if (share.via === 'assistant') this.options.onAssistantEnded?.(share.id);
  }

  /**
   * The document the owner named, by its canonical identity: the docx id, and
   * the wiki node holding it when it lives in a wiki. The node is looked up
   * from the docx id itself (Feishu `get_node` with `obj_type=docx`), as the
   * owner — never taken from what was named, so another node or a shortcut
   * cannot stand in for it. A shortcut is refused outright.
   */
  private async canonical(owner: string, named: string): Promise<Canonical & { title: string; url?: string }> {
    const target = await findDocument(this.options.docs, owner, named);
    if (target.wikiShortcut) throw new DocsAddonError(400, '这是知识库里的快捷方式，不是文档本身：请打开原文档，给出它的链接');
    let wikiToken: string | null = null;
    try {
      const node = await this.options.docs.wikiNode(owner, target.documentId, 'docx');
      // Fail closed: only an origin node that names this very docx counts; a
      // reply missing either field cannot stand in for the document.
      if (!node.nodeToken || node.nodeType !== 'origin' || node.objToken !== target.documentId) {
        throw new DocsAddonError(502, '飞书给出的知识库节点与这篇文档对不上，没有创建共享；请稍后重试');
      }
      wikiToken = node.nodeToken;
    } catch (error) {
      // Feishu finds no wiki node for it: the document lives outside any wiki.
      if (!(error instanceof FeishuRefusal && error.status === 404)) throw error;
    }
    return { documentId: target.documentId, wikiToken, title: target.title, ...(target.url ? { url: target.url } : {}) };
  }

  /**
   * Feishu's own answer, asked with the owner's identity, to "may this owner
   * share this document" (`share`: may add collaborators), about its
   * canonical identity: a wiki page by its node. The owner reads Feishu's own reason; a collaborator's
   * call learns the share is on hold, and only a transient failure stays
   * retryable.
   */
  private async ownerMayShare(owner: string, doc: Canonical, audience: 'owner' | 'collaborator'): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.options.docs.permitted(owner, identityOf(doc), 'share');
    } catch (error) {
      if (audience === 'owner' || !(error instanceof DocsAddonError) || error.status >= 500) throw error;
      throw new DocsAddonError(403, OWNER_ON_HOLD);
    }
    if (!allowed) {
      throw new DocsAddonError(403, audience === 'owner'
        ? '飞书说你不能分享这篇文档（文档的"谁可以添加协作者"不包括你），所以也不能为它创建共享链接' : OWNER_ON_HOLD);
    }
  }

  /** The owner's control card in this document, once per owner and document at a time. `asked` is the identity already checked. */
  private anchorFor(owner: string, target: Canonical, asked: Canonical, componentTypeId: string): Promise<{ anchor: DocShareAnchor; reused: boolean }> {
    const key = `${owner}\u0000${target.documentId}`;
    let placing = this.placing.get(key);
    if (!placing) {
      placing = this.placeAnchor(owner, target, asked, componentTypeId).finally(() => this.placing.delete(key));
      this.placing.set(key, placing);
    }
    return placing;
  }

  /**
   * The card already there, else a new one at the end of the document. An
   * existing card is looked for even within its lease: a share made now must
   * hang off a card the owner can see now, not one deleted an hour ago. A new
   * card carries the canonical identity just resolved, for good; if that is
   * not what Feishu was asked about, it is asked about this one first. The
   * card goes in as the owner. Until Feishu answers, its row is 'unknown';
   * one that never answers is looked for by the next create.
   */
  private async placeAnchor(owner: string, target: Canonical, asked: Canonical, componentTypeId: string): Promise<{ anchor: DocShareAnchor; reused: boolean }> {
    const current = this.options.links.liveAnchor(owner, target.documentId);
    if (current && await this.present(current)) return { anchor: current, reused: true };
    if (!sameIdentity(target, asked)) await this.ownerMayShare(owner, target, 'owner');
    const capability = `dsa_${randomBytes(32).toString('base64url')}`;
    const id = `anc_${randomBytes(12).toString('hex')}`;
    this.options.links.createAnchor({ id, owner, documentId: target.documentId, wikiToken: target.wikiToken, capabilityHash: digest(capability), createdAt: this.now() });
    const block = await insertCard(this.options.docs, owner, target.documentId, componentTypeId, { octopusShare: { v: 1, anchor: capability } },
      [{ parent: target.documentId, index: -1 }], capability);
    const at = this.now();
    this.options.links.markPresent(id, block, at + SHARE_ANCHOR_LEASE_MS, at);
    return { anchor: this.options.links.anchor(id)!, reused: false };
  }

  /** Is the card in its document, and may its owner still share it? One check per card at a time. */
  private present(anchor: DocShareAnchor): Promise<boolean> {
    let check = this.checks.get(anchor.id);
    if (!check) {
      check = this.look(anchor).finally(() => this.checks.delete(anchor.id));
      this.checks.set(anchor.id, check);
    }
    return check;
  }

  /**
   * One renewal: Feishu, asked as the owner, still lets them share the
   * document; then the whole document, read as the app, still holds the card.
   * Found: vouched for another lease. Not found: missing. Anything else
   * refuses and changes nothing.
   */
  private async look(anchor: DocShareAnchor): Promise<boolean> {
    const componentTypeId = this.componentTypeId();
    await this.ownerMayShare(anchor.owner, anchor, 'collaborator');
    const card = anchorBlock(await this.app.blocks(anchor.owner, anchor.documentId), componentTypeId, anchor.capabilityHash);
    const at = this.now();
    if (card) this.options.links.markPresent(anchor.id, card.id, at + SHARE_ANCHOR_LEASE_MS, at);
    else this.options.links.markMissing(anchor.id, at);
    return Boolean(card);
  }

  /**
   * Runs one write on a document after the writes queued before it there.
   * One runs and at most WRITE_QUEUE_MAX wait; another is turned away, to be
   * retried, rather than queued without end.
   */
  private async exclusive<T>(documentId: string, work: () => Promise<T>): Promise<T> {
    const lane = this.writing.get(documentId) ?? { tail: Promise.resolve(), size: 0 };
    if (lane.size > WRITE_QUEUE_MAX) throw new DocsAddonError(429, '这篇文档上排队的写入太多了，这次没有执行；请稍后重试');
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const before = lane.tail;
    lane.tail = before.then(() => mine);
    lane.size++;
    this.writing.set(documentId, lane);
    try {
      await before;
      return await work();
    } finally {
      release();
      if (--lane.size === 0 && this.writing.get(documentId) === lane) this.writing.delete(documentId);
    }
  }

  /** The document as of one revision: the revision, read first, and every block at it. */
  private async snapshot(at: Shared): Promise<{ revision: number; byId: Map<string, DocBlock> }> {
    const meta = await this.app.document(at.owner, at.documentId);
    if (meta.revision === undefined) throw new DocsAddonError(502, '飞书没有给出文档的当前版本，这一步没有执行；请稍后重试');
    const blocks = await this.app.blocks(at.owner, at.documentId, meta.revision);
    return { revision: meta.revision, byId: new Map(blocks.map((block) => [block.id, block])) };
  }

  // ── the shared-document operations, as the app, on the share's document ──

  private async read(at: Shared, from?: number): Promise<Record<string, unknown>> {
    const meta = await this.app.document(at.owner, at.documentId);
    return { document: docOf(meta), ...markdownPage(await this.app.blocks(at.owner, at.documentId), at.documentId, from) };
  }

  private async outline(at: Shared, page: { from?: number; limit?: number }): Promise<Record<string, unknown>> {
    const meta = await this.app.document(at.owner, at.documentId);
    return { document: docOf(meta), ...outlinePage(await this.app.blocks(at.owner, at.documentId), at.documentId, page) };
  }

  private async blockRead(at: Shared, id: string): Promise<Record<string, unknown>> {
    const raw = await this.app.block(at.owner, at.documentId, id);
    if (!raw) throw new DocsAddonError(404, `这篇文档里没有块 ${id}`);
    return {
      block_id: id, kind: blockKind(typeof raw.block_type === 'number' ? raw.block_type : undefined),
      ...(typeof raw.parent_id === 'string' && raw.parent_id ? { parent_id: raw.parent_id } : {}),
      children: Array.isArray(raw.children) ? raw.children.filter((child): child is string => typeof child === 'string') : [],
      text: blockText(raw),
    };
  }

  /** Markdown in, at one place: never under an add-on or synced block, and each piece only while the share still stands. */
  private async write(at: Shared, input: { markdown: string; after?: string; position?: 'start' | 'end' }): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(input.markdown, 'utf8') > SHARED_WRITE_MAX_BYTES) {
      throw new DocsAddonError(413, `一次最多写入 ${SHARED_WRITE_MAX_BYTES / 1024 / 1024} MB 的 Markdown，请分几次写`);
    }
    return this.exclusive(at.documentId, async () => {
      const written = await writeMarkdown(this.app, at.owner, { documentId: at.documentId, title: '' }, input, {
        parent: (parent, blocks) => insertable(blocks, at.documentId, parent),
        beforeEach: () => this.still(at.caller),
      });
      return { document: { id: at.documentId }, blocks: written.created,
        ...(written.droppedImages ? { skipped_images: written.droppedImages, note: 'Markdown 里的图片没有插入：共享连接不能上传图片' } : {}) };
    });
  }

  /**
   * Replaces one text block's text in place (same id, kind and place); its
   * inline styles go. Judged on a snapshot of the latest revision, and sent
   * pinned to that revision unless the caller names the one they read.
   */
  private async blockUpdate(at: Shared, id: string, text: string, revision?: number): Promise<Record<string, unknown>> {
    if (!text.trim()) throw new DocsAddonError(400, 'text 是空的：要删掉整个块，请用 feishu_shared_doc_remove');
    return this.exclusive(at.documentId, async () => {
      const read = await this.snapshot(at);
      const block = read.byId.get(id);
      if (!block) throw new DocsAddonError(404, `这篇文档里没有块 ${id}`);
      const kind = blockKind(block.type);
      if (SYNCED_BLOCKS.has(block.type ?? 0)) throw new DocsAddonError(409, SYNCED);
      if (!TEXT_BLOCKS.has(block.type ?? 0)) {
        throw new DocsAddonError(409, `块 ${id} 是 ${kind}，不是文本块：只能替换段落、标题、列表项、代码、引用和待办的文字；其他内容请用 feishu_shared_doc_write 与 feishu_shared_doc_remove`);
      }
      vet(() => guardBlock(read.byId, at.documentId, block, false), id);
      this.still(at.caller);
      const updated = await pinned(() => this.app.updateText(at.owner, at.documentId, id, text, { revision: revision ?? read.revision, clientToken: randomBytes(16).toString('hex') }));
      return { block_id: id, kind, previous_text: block.text, ...(updated.revision !== undefined ? { revision: updated.revision } : {}) };
    });
  }

  /**
   * Deletes blocks with their children. Every block is vetted on one snapshot
   * before any is deleted; then each delete reads the latest revision, vets
   * its block again there, and is pinned to exactly that revision, so a
   * document changed in between refuses it instead of losing the wrong block.
   */
  private async remove(at: Shared, list: string): Promise<Record<string, unknown>> {
    const ids = blockIdsOf(list);
    if (!ids.length) throw new DocsAddonError(400, '请给出要删除的块 ID（feishu_shared_doc_outline 里的 id）');
    if (ids.length > REMOVE_MAX) throw new DocsAddonError(400, `一次最多删除 ${REMOVE_MAX} 个块`);
    ids.forEach(blockId);
    if (ids.includes(at.documentId)) throw new DocsAddonError(400, '不能删除整篇文档');
    return this.exclusive(at.documentId, async () => {
      const { byId } = await this.snapshot(at);
      for (const id of ids) {
        const block = byId.get(id);
        if (!block) throw new DocsAddonError(404, `这篇文档里没有块 ${id}；没有删除任何内容`);
        vet(() => guardBlock(byId, at.documentId, block, true), id, '；没有删除任何内容');
      }
      // A listed block inside another listed block goes with that one.
      const listed = new Set(ids);
      const inside = (block: DocBlock) => {
        for (let up = byId.get(block.parent), depth = 0; up && depth < MAX_DEPTH; up = byId.get(up.parent), depth++) if (listed.has(up.id)) return true;
        return false;
      };
      const top = ids.filter((id) => !inside(byId.get(id)!));
      let deleted = 0;
      for (const id of top) {
        try {
          this.still(at.caller);
          await this.deleteOne(at, id);
        } catch (error) {
          throw new DocsAddonError(error instanceof DocsAddonError ? error.status : 502,
            `${error instanceof DocsAddonError ? error.message : '删除没有完成'}（已删除 ${deleted}/${top.length} 个块）`);
        }
        deleted++;
      }
      return { document: { id: at.documentId }, deleted };
    });
  }

  /**
   * One vetted delete, by position. Feishu does not enforce the revision pin
   * on batch_delete (a stale revision still deletes, seen on live Feishu
   * 2026-10-28), so a person's edit between this read and the delete can shift
   * the index; writes on the document are serialized here, and the block is
   * checked to be gone afterwards so a misplaced delete is reported, not hidden.
   */
  private async deleteOne(at: Shared, id: string): Promise<void> {
    const { revision, byId } = await this.snapshot(at);
    const block = byId.get(id);
    if (!block) throw new DocsAddonError(404, `块 ${id} 已经不在文档里了`);
    vet(() => guardBlock(byId, at.documentId, block, true), id);
    const parent = byId.get(block.parent);
    const index = parent ? parent.children.indexOf(id) : -1;
    if (!parent || index < 0) throw new DocsAddonError(409, '文档刚刚变化，没找到要删除的块的位置；请重新读取后再试');
    await pinned(() => this.app.deleteChild(at.owner, at.documentId, parent.id, index, revision));
    if (await this.app.block(at.owner, at.documentId, id)) {
      // Whatever went instead may have been the control card: find out now, not at the next renewal.
      const anchorId = this.options.links.share(at.caller.shareId)?.anchorId;
      const anchor = anchorId ? this.options.links.anchor(anchorId) : undefined;
      if (anchor) await this.present(anchor).catch(() => false);
      throw new DocsAddonError(409, `删除可能落到了相邻的块上：块 ${id} 还在文档里，说明文档在读取和删除之间被别人改动了；请在飞书文档的历史记录里检查并恢复`);
    }
  }

  /**
   * A share answers only to its own caller, presented by its own owner's
   * credential: a link share to its token; an assistant share to the live
   * read-only scope of the assistant it was made for. Neither kind of caller
   * ever reaches the other kind of share.
   */
  private bound(share: DocShare, caller: DocShareCaller): boolean {
    if (share.mcpTokenHash === null || !FEISHU_DOC_SHARE_ID.test(caller.shareId) || share.owner !== caller.owner) return false;
    return caller.via === 'assistant'
      ? share.via === 'assistant' && this.options.assistantScope?.(caller)?.docShare === caller.shareId
      : share.via !== 'assistant' && mcpCredentialOf(share.mcpTokenHash) === caller.credential;
  }

  // ── document assistants (`doc-assistants.ts`) ──

  /**
   * The control card one capability names; the owner check is the caller's.
   * Unknown capabilities are the contract's 404.
   */
  cardAnchor(capability: string): DocShareAnchor {
    return this.anchorOf(capability);
  }

  /**
   * The card a document assistant starts from, ready for a new share: the
   * host the card reports is its own document (a copy of the card elsewhere
   * starts nothing), the card is in it (vouched for, or found now), and
   * Feishu, asked as the owner, still lets the owner share the document.
   */
  async assistantAnchor(capability: string, hostToken: string | undefined): Promise<DocShareAnchor> {
    this.componentTypeId();
    const anchor = this.anchorOf(capability);
    // Exactly, as for a reader's key: a copy elsewhere, or a host that cannot be matched now, starts nothing.
    if (await this.hostMatches(anchor, hostToken || undefined) !== true) throw new DocsAddonError(403, `${NOT_HERE}不能在这里启动文档助手`);
    // Within the lease Feishu is asked about the owner now; past it, the renewal asks.
    if (vouched(anchor, this.now())) await this.ownerMayShare(anchor.owner, anchor, 'collaborator');
    else {
      let found: boolean;
      try { found = await this.present(anchor); } catch (error) { throw unchecked(error); }
      if (!found) throw new DocsAddonError(403, '文档里的 Octopus 控制卡片已被删除（或暂时找不到），现在不能启动文档助手；请联系文档所有者');
    }
    return this.options.links.anchor(anchor.id) ?? anchor;
  }

  /**
   * A document assistant's own share of the card's document: via 'assistant',
   * active at once, with the rights the owner set for assistants. Its MCP
   * token row is minted and the plaintext dropped here: the row is what keeps
   * an active share live (the owner's token list can still revoke it), and
   * the assistant reaches the share only through its session scope. The
   * caller checked the card first (`assistantAnchor`).
   */
  openAssistantShare(anchor: DocShareAnchor, label: string, rights: DocShareRights): string {
    const id = `shr_${randomBytes(12).toString('hex')}`;
    const at = this.now();
    this.options.tokens.withinTransaction(() => {
      const token = mintMcpToken(this.options.tokens, { username: anchor.owner, label: `飞书文档助手 · ${label}`, policy: mcpFeishuDocSharePolicy(id), now: () => at });
      this.options.links.createAssistantShare({ id, anchorId: anchor.id, owner: anchor.owner, documentId: anchor.documentId, label, rights, mcpTokenHash: token.row.token_hash, createdAt: at });
    });
    return id;
  }

  /**
   * Whether an assistant's tools are listed: its share bound to its live
   * scope, active, its card not known gone, and what the card's owner set
   * now still admitting it — assistants on, not narrowed below its share's
   * rights, the project still the one its scope reads. The owner's switch
   * holds here at every use, whether or not every assistant was ended.
   * Database reads only.
   */
  assistantUsable(caller: DocShareCaller): void {
    if (caller.via !== 'assistant') throw new DocsAddonError(403, '这个文档共享不存在或已失效');
    const share = this.usable(caller, 'read');
    const anchor = this.options.links.anchor(share.anchorId);
    if (!anchor || anchor.state === 'missing') throw new DocsAddonError(403, CARD_GONE);
    const settings = this.options.assistantSettings?.(anchor.id);
    const scope = this.options.assistantScope?.(caller);
    if (!settings?.rights) throw new DocsAddonError(403, '这篇文档的所有者已经关闭了文档助手');
    if (settings.rights === 'read' && share.rights === 'write') throw new DocsAddonError(403, '这篇文档的所有者已经把文档助手改成只读');
    if (!scope || settings.project?.device !== scope.device || settings.project.workspace_id !== scope.workspaceId) {
      throw new DocsAddonError(403, '这篇文档的所有者已经把文档助手关联到别的项目');
    }
  }

  /**
   * What every call of an assistant needs first, its project reads included:
   * `assistantUsable`, then what `authorize` checks for a read. Past the
   * lease the card is looked for again, so a deleted card stops an assistant
   * that only ever reads its project within the lease, as it stops every key;
   * a card known gone refuses from the database alone.
   */
  async assistantAuthorize(caller: DocShareCaller): Promise<void> {
    this.assistantUsable(caller);
    await this.authorize(caller, 'read');
  }

  /** Ends a document assistant's share, for whoever `doc-assistants.ts` let end it; `onAssistantEnded` follows. */
  endAssistant(shareId: string): void {
    const share = this.options.links.share(shareId);
    if (!share || share.via !== 'assistant') throw new DocsAddonError(404, 'unknown_share');
    this.transition(share, 'terminate');
  }
}

/** Where a shared call runs: the share row's owner and document, and who called. */
interface Shared { owner: string; documentId: string; caller: DocShareCaller }

/** A renewal that could not finish refuses the call: a definite refusal says why, anything else is retryable. */
function unchecked(error: unknown): DocsAddonError {
  if (error instanceof DocsAddonError && error.status === 403) return error;
  if (error instanceof FeishuRefusal && error.status === 404) return new DocsAddonError(403, error.message);
  const reason = error instanceof DocsAddonError ? `（${error.message.slice(0, 120)}）` : '';
  return new DocsAddonError(503, `暂时无法确认这个共享仍然有效，这次调用没有执行；请稍后重试${reason}`);
}

/** A check that could not vouch for the card refuses the key: with Feishu's own reason when it gave one, else to retry. */
function unconfirmed(error: unknown): DocsAddonError {
  if ((error instanceof DocsAddonError && error.status === 403) || (error instanceof FeishuRefusal && error.status === 404)) {
    return new DocsAddonError(403, `现在不能领取访问密钥：${error.message}`);
  }
  return new DocsAddonError(503, '暂时无法确认文档里的 Octopus 控制卡片，没有领取访问密钥；请稍后重试');
}

/**
 * A key's ways in. `claude`: one line registering it for every project of
 * that Claude Code user (`--scope user`). `codex`: one line appending it to
 * `~/.codex/config.toml`, a single-quoted printf format whose `\n` are the
 * two characters printf turns into newlines. `endpoint` and `token`: for any
 * other MCP client. The URL passed PLAIN_URL and the name and token are hex,
 * so no quote, `%`, backslash or control character reaches either line.
 */
export function shareConnect(publicUrl: string, shareId: string, token: string): DocShareConnect {
  const name = `octopus-doc-${shareId.slice(4, 10)}`;
  const { endpoint, command } = mcpRegistration(publicUrl, 0, { name, token, scope: 'user' });
  return {
    claude: command,
    codex: `printf '\\n[mcp_servers.${name}]\\nurl = "${endpoint}"\\nhttp_headers = { Authorization = "Bearer ${token}" }\\n' >> ~/.codex/config.toml`,
    endpoint,
    token,
  };
}

/** What a reader asks for: a name as a card lists it, and rights within the card's ceiling. */
function keyOf(ceiling: DocShareSelfServe, label: string, rights: string): { label: string; rights: DocShareRights } {
  if (rights !== 'read' && rights !== 'write') invalid('rights 只能是 read 或 write');
  within(ceiling, rights);
  return { label: labelOf(label, '请给这个访问密钥起个名字，例如你的名字或 Agent 的用途'), rights };
}

/** Refuses rights above the most the card's owner lets readers take for themselves. */
function within(ceiling: DocShareSelfServe, rights: DocShareRights): void {
  if (ceiling === 'off') throw new DocsAddonError(403, SELF_SERVE_OFF);
  if (ceiling === 'read' && rights === 'write') throw new DocsAddonError(403, READ_ONLY_CEILING);
}

/** A name as a card lists it: whitespace collapsed, 1 to LABEL_MAX characters. */
function labelOf(value: string, missing: string): string {
  const label = (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim();
  if (!label) invalid(missing);
  if (label.length > LABEL_MAX) invalid(`名字最长 ${LABEL_MAX} 个字`);
  return label;
}

/** Who took or ended a key, as the owner's notice names them. */
function actorOf(viewer: DocShareViewer | null, via: 'card' | 'invite'): string {
  if (viewer?.username) return viewer.username;
  if (viewer) return `组织成员（…${viewer.openId.slice(-6)}）`;
  return via === 'invite' ? '持有领取链接的人' : '一位未登录的读者';
}

/** What the owner does so a read-write share can write: give the app 可编辑 in the document. */
function editHint(access: DocShareAppAccess, name: string | null): string {
  const app = name ? `飞书应用「${name}」` : 'Octopus 飞书应用';
  const now = access === 'view' ? '现在只能查看这篇文档' : access === 'none' ? '现在不能访问这篇文档' : '能不能编辑这篇文档暂时无法确认';
  return `${app}${now}，而读写共享要靠它写入：请在文档右上角「…」→「添加文档应用」里找到${app}，给它「可编辑」权限，否则协作者只能读、不能写`;
}

/**
 * A change pinned to a revision. Feishu refusing it for a reason of its own
 * means the document moved on since it was read; nothing was changed, so it
 * is safe to read again and retry.
 */
async function pinned<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // Live Feishu refuses an edit pinned to a stale revision as 1770002 "not found".
    if (error instanceof FeishuRefusal && error.code === 1770002) {
      throw new DocsAddonError(409, '文档在你读取之后已被修改，或者这个块已经不在了；这一步没有执行，请重新读取文档后再试');
    }
    if (error instanceof FeishuRefusal && error.status === 502) {
      throw new DocsAddonError(409, `文档在这期间被改动了，这一步没有执行；请重新读取文档后再试（${error.message.slice(0, 120)}）`);
    }
    throw error;
  }
}

/**
 * Refuses a block a shared change may not reach: one inside a synced block;
 * and, with `subtree`, one holding an add-on block (the control card above
 * all) or a synced block. Every block on the way must be in the listing and
 * within MAX_DEPTH: what cannot be seen cannot be vouched for.
 */
function guardBlock(byId: ReadonlyMap<string, DocBlock>, documentId: string, block: DocBlock, subtree: boolean): void {
  for (let up = block.parent, depth = 0; up !== documentId; depth++) {
    const parent = byId.get(up);
    if (!parent) throw new DocsAddonError(409, INCOMPLETE);
    if (depth > MAX_DEPTH) throw new DocsAddonError(409, TOO_DEEP);
    if (SYNCED_BLOCKS.has(parent.type ?? 0)) throw new DocsAddonError(409, SYNCED);
    up = parent.parent;
  }
  if (!subtree) return;
  const visit = (each: DocBlock, depth: number): void => {
    if (depth > MAX_DEPTH) throw new DocsAddonError(409, TOO_DEEP);
    if (each.type === ADD_ON) throw new DocsAddonError(409, HOLDS_ADD_ON);
    if (SYNCED_BLOCKS.has(each.type ?? 0)) throw new DocsAddonError(409, SYNCED);
    for (const child of each.children) {
      const next = byId.get(child);
      if (!next) throw new DocsAddonError(409, INCOMPLETE);
      visit(next, depth + 1);
    }
  };
  visit(block, 0);
}

/** Where new content may go: under a block that is itself neither an add-on nor synced, nor inside a synced one. */
function insertable(blocks: readonly DocBlock[], documentId: string, parentId: string): void {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const parent = byId.get(parentId);
  if (!parent) throw new DocsAddonError(409, INCOMPLETE);
  if (parent.type === ADD_ON) throw new DocsAddonError(409, HOLDS_ADD_ON);
  if (SYNCED_BLOCKS.has(parent.type ?? 0)) throw new DocsAddonError(409, SYNCED);
  guardBlock(byId, documentId, parent, false);
}

/** Names the block a structural refusal is about. */
function vet(check: () => void, id: string, suffix = ''): void {
  try { check(); } catch (error) {
    if (error instanceof DocsAddonError) throw new DocsAddonError(error.status, `块 ${id}：${error.message}${suffix}`);
    throw error;
  }
}

/** A bounded memory: the oldest entry goes first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  if (map.size >= REMEMBERED) map.delete(map.keys().next().value!);
  map.set(key, value);
}

function invalid(message: string): never {
  throw new DocsAddonError(400, message);
}

const str = (value: unknown) => typeof value === 'string' ? value : '';
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function blockId(value: unknown): string {
  const id = str(value).trim();
  if (!BLOCK_ID.test(id)) invalid(`块 ID 无效：${id.slice(0, 40) || '（空）'}`);
  return id;
}
const docOf = (meta: DocTarget) => ({ id: meta.documentId, title: meta.title, ...(meta.revision !== undefined ? { revision: meta.revision } : {}) });

/** The control card of a share anchor among a document's blocks: our widget's block whose `octopusShare.anchor` hashes to `capabilityHash`. */
export function anchorBlock(blocks: readonly DocBlock[], componentTypeId: string, capabilityHash: string): DocBlock | undefined {
  return blocks.find((block) => {
    if (block.type !== ADD_ON || block.addOn?.component !== componentTypeId) return false;
    try {
      const anchor = (JSON.parse(block.addOn.record) as { octopusShare?: { anchor?: unknown } } | null)?.octopusShare?.anchor;
      return typeof anchor === 'string' && ANCHOR.test(anchor) && digest(anchor) === capabilityHash;
    } catch { return false; }
  });
}

/**
 * The document as Markdown an agent reads and addresses: blocks in reading
 * order from `from`, each after a `<!-- id · kind -->` line, as many as fit
 * in `budget` characters (always at least one); `next` continues. A block
 * longer than READ_BLOCK_CHARS shows its beginning and says how to read it all.
 */
export function markdownPage(blocks: readonly DocBlock[], documentId: string, from = 0, budget = READ_PAGE_CHARS): { total: number; from: number; markdown: string; next?: number } {
  const order = readingOrder(blocks, documentId);
  const start = Math.min(order.length, Math.max(0, Math.floor(from)));
  const parts: string[] = [];
  let size = 0;
  let end = start;
  for (; end < order.length; end++) {
    const part = markdownOf(order[end].block, order[end].depth);
    if (parts.length && size + part.length > budget) break;
    parts.push(part);
    size += part.length + 1;
  }
  return { total: order.length, from: start, markdown: parts.join('\n'), ...(end < order.length ? { next: end } : {}) };
}

function markdownOf(block: DocBlock, depth: number): string {
  const kind = blockKind(block.type);
  const text = block.text.length > READ_BLOCK_CHARS ? block.text.slice(0, READ_BLOCK_CHARS) : block.text;
  const indent = '  '.repeat(Math.min(depth, 8));
  const heading = /^h([1-9])$/.exec(kind);
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));
  const body = heading ? `${'#'.repeat(Math.min(6, Number(heading[1])))} ${text}`
    : kind === 'bullet' ? `${indent}- ${text}`
    : kind === 'ordered' ? `${indent}1. ${text}`
    : kind === 'todo' ? `${indent}- [ ] ${text}`
    : kind === 'code' ? `${fence}\n${text}\n${fence}`
    : kind === 'quote' ? text.split('\n').map((line) => `> ${line}`).join('\n')
    : kind === 'divider' ? '---'
    : kind === 'text' ? text
    : text || `[${kind}]`;
  const cut = block.text.length > text.length ? `\n<!-- 本块共 ${block.text.length} 字，上面只是开头；用 feishu_shared_doc_block_read 读全文 -->` : '';
  return `<!-- ${block.id} · ${kind} -->\n${body}${cut}`;
}
