/**
 * Feishu document assistants (文档助手).
 *
 * A tenant member reading a Feishu document that carries an Octopus control
 * card starts their own Claude agent from it. The agent runs on the card
 * owner's device, as the owner's session (the owner's Claude subscription),
 * attributed to the member's verified Feishu open_id. It reaches two things
 * and nothing else: the document's project — the one registered workspace the
 * owner linked on the card — read-only; and the document itself, through the
 * assistant's own via='assistant' share, as the Feishu app, with the rights
 * the owner set for assistants. No command, no file write, no account tool,
 * no Codex.
 *
 * ── Where the confinement is ───────────────────────────────────────────────
 *
 * Not here. A launch carries this module's id (`op_fda_…`) as its
 * client_request_id; the post-Gate dispatch preparer finds the row written
 * here and issues a `read_only` session scope bound to the assistant's share
 * (`mcp/session-execution.ts`); Claude runs with no tools of its own and only
 * that scope's MCP server; the MCP surface serves exactly the three workspace
 * reads and the share's tools (`mcp/service.ts`); the share answers only to
 * that live scope (`doc-share.ts`). Renewal, rotation, recovery and restart
 * keep the flavour, because the registry takes it from the row kept here,
 * never from a caller.
 *
 * ── Who may do what ─────────────────────────────────────────────────────────
 *
 * Callers authenticate: `openId` is the add-on login's verified identity,
 * never a request field, and `username` its mapped account, if any. The card's
 * owner configures the card, sees and ends every assistant on it; a guest
 * starts, sees, talks to, ends and pins their own. The share is the one
 * switch: paused, terminated (on the card, by its guest, by the owner turning
 * assistants off) or its card gone, every tool stops; terminated, the
 * assistant ends with it and its scope goes at once.
 *
 * Starts are capped per card, per guest and card, and per guest per day. They
 * raise no approval; the owner hears about them in Feishu, coalesced per guest
 * and card.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AssistantSettings, AssistantStatus, AssistantTarget, AssistantView } from '@claude-bot/feishu-docs-addon/protocol';
import { SESSION_OPERATION_PROTOCOL, sessionOperationReceiptFromWire } from '@claude-bot/runner/gateway-protocol';
import { MACHINE_LIMITS } from '@claude-bot/runner/limits';
import { createLogger } from '../logger.js';
import { SESSION_READ_ONLY_OPERATIONS, type AssistantSessionPlacement, type SessionExecutionRegistry } from '../mcp/session-execution.js';
import type { RunnerCapabilities } from '../runner/capability.js';
import { resourceId } from '../sessionhub/core.js';
import type { AssistantRights, DocAssistant, DocAssistantSettings, FeishuDocAssistantsRepository } from '../store/repositories/feishu-doc-assistants.js';
import type { FeishuDocShareLinksRepository } from '../store/repositories/feishu-doc-share-links.js';
import type { FeishuDocsSharesRepository } from '../store/repositories/feishu-docs-shares.js';
import { DocsAddonError } from './docs-addon-auth.js';
import type { LaunchDefaults, LaunchReceipt } from './docs-launch.js';
import type { DocRef, DocsNotice } from './docs-notify.js';
import { insertCard, type BlockSlot, type FeishuDocsClient } from './docs-openapi.js';
import { anchorBlock, SHARED_DOC_READ_TOOLS, SHARED_DOC_WRITE_TOOLS, type FeishuDocShareService } from './doc-share.js';

/** Every assistant launch's client_request_id starts so; the dispatch preparer refuses one it did not register. */
export const DOC_ASSISTANT_OPERATION_PREFIX = 'op_fda_';
/** Live (not ended) assistants on one control card. */
export const ASSISTANTS_PER_CARD = 20;
/** Live assistants of one guest on one control card. */
export const ASSISTANTS_PER_GUEST = 3;
/** Assistants one guest may start in any 24 hours, on any card. */
export const STARTS_PER_GUEST_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60_000;
/** A launch the device still has no record of after this long was lost on the way: it fails, so its guest can start another. */
const LOST_LAUNCH_MS = 5 * 60_000;
const GUEST_NAME_MAX = 40;
const TITLE_MAX = 60;
/** A device's or project's label as the card shows it (its reader keeps at most 240 UTF-16 units). */
const PLACE_LABEL_MAX = 120;
const REQUEST_ID = /^[A-Za-z0-9:_-]{8,80}$/;
const WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;
/** Card capabilities remembered per assistant in this process; the oldest goes first. */
const REMEMBERED = 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const log = createLogger('feishu-doc-assistants');
/**
 * What a guest is told when the device did not do what they asked. The
 * device's own words (paths, hosts, configuration) are logged here, and the
 * owner sees them; the guest never does.
 */
const START_FAILED = '设备暂时无法启动助手，请稍后再试';
const TURN_FAILED = '助手这一轮没有完成，请稍后再试';
/** A workspace that is a whole home directory or a system root (or says nothing of where it is): never a document's project. */
const TOO_BROAD = new Set(['~', '/', '/home', '/Users', '/root']);
const tooBroad = (display: string | undefined) => display === undefined || TOO_BROAD.has(display.replace(/\/+$/, '') || '/');

/** A signed-in tenant member, as the add-on login verified them. */
export interface AssistantCaller { openId: string; username: string | null }
/** A member starting an assistant; `name` is what their card read from the SDK, used for labels only. */
export interface AssistantGuest { openId: string; name: string }

/*
 * What this module answers is the card's wire contract itself
 * (`@claude-bot/feishu-docs-addon/protocol`): `AssistantSettings` (every
 * reader of the card sees it), `AssistantTarget`, `AssistantView` and
 * `AssistantStatus` (with, once there is a session, the v2 card over it).
 */

/** A registered launch, as the dispatch preparer checks it. */
export interface AssistantLaunch { id: string; shareId: string; device: string; workspaceId: string }

export interface DocAssistantsOptions {
  assistants: FeishuDocAssistantsRepository;
  /** Control cards (read only here). */
  links: Pick<FeishuDocShareLinksRepository, 'anchor'>;
  docShares: Pick<FeishuDocShareService, 'cardAnchor' | 'assistantAnchor' | 'openAssistantShare' | 'endAssistant'>;
  /** v2 card capabilities (`ds_`, hash only): how an assistant's conversation is shown. */
  cards: Pick<FeishuDocsSharesRepository, 'create' | 'get' | 'revoke'>;
  /** The owner's Runner root: one auto-allowed operation per call. */
  caps: Pick<RunnerCapabilities, 'open' | 'listDevices'>;
  /** Registered workspaces with their display paths; ending an assistant releases its scope here. */
  executions: Pick<SessionExecutionRegistry, 'deviceWorkspaces' | 'releaseDocShare'>;
  /** Feishu docx calls; `asApp()` reads the title and pins cards as the app. */
  docs: FeishuDocsClient;
  componentTypeId?: string;
  /** The owner's saved launch defaults (`docs-launch` readDefaults): an assistant's model and effort. */
  launchDefaults(owner: string): LaunchDefaults;
  displayName(username: string): string;
  notify?(owner: string, notice: DocsNotice): void;
  transaction<T>(work: () => T): T;
  now?: () => number;
}

type Dispatched =
  | { kind: 'receipt'; receipt: LaunchReceipt }
  | { kind: 'refused'; status: number; message: string }
  | { kind: 'unknown'; message: string };

export class FeishuDocAssistants {
  private readonly now: () => number;
  /** One device check per starting assistant at a time; status calls arriving meanwhile wait for it. */
  private readonly observing = new Map<string, Promise<DocAssistant>>();
  /** The card capability each assistant's conversation shows under, while this process lives: only its hash is stored. */
  private readonly capabilities = new Map<string, string>();
  /** One pin per assistant at a time. */
  private readonly pinning = new Map<string, Promise<{ block: string }>>();

  constructor(private readonly options: DocAssistantsOptions) {
    this.now = options.now ?? Date.now;
  }

  // ── the card's owner ──

  /**
   * The owner's devices, and the projects each could give assistants: an
   * online device whose Runner hosts read-only scopes and split Claude
   * sessions, and its registered workspaces other than Home.
   */
  async targets(owner: string): Promise<AssistantTarget[]> {
    const devices = this.options.caps.listDevices(owner).filter((row) => !row.device.startsWith('dsh:'));
    return await Promise.all(devices.map(async (row): Promise<AssistantTarget> => {
      const base = { device: row.device, label: clip(row.display_name || row.device, PLACE_LABEL_MAX) };
      const problem = this.placementProblem(owner, row.device);
      if (problem) return { ...base, eligible: false, reason: problem, workspaces: [] };
      const listed = await this.options.executions.deviceWorkspaces(owner, row.device);
      if (!listed.ok) return { ...base, eligible: false, reason: listed.reason, workspaces: [] };
      const workspaces = listed.workspaces.filter((workspace) => !tooBroad(workspace.display))
        .map((workspace) => ({ workspace_id: workspace.workspace_id, label: clip(workspace.label, PLACE_LABEL_MAX) }));
      return workspaces.length ? { ...base, eligible: true, workspaces }
        : { ...base, eligible: false, reason: '这台设备上只有主目录或系统根目录这样的工作区；请先把项目目录登记为单独的工作区', workspaces };
    }));
  }

  /** The card's assistant settings and limits. Anyone holding the card may read them. */
  settings(anchorCapability: string): AssistantSettings {
    return this.settingsOf(this.options.docShares.cardAnchor(anchorCapability).id);
  }

  /** The same, by the card's id: what its share panel shows every reader (`doc-share.ts`). */
  settingsOf(anchorId: string): AssistantSettings {
    return assistantSettingsView(this.options.assistants.settings(anchorId));
  }

  /**
   * The card's owner links its document to a project (a registered, non-Home
   * workspace on an eligible device) and sets what assistants may do to the
   * document. `rights: null` turns assistants off and ends every live one on
   * the card (the kill switch); the project stays. A live assistant that no
   * longer fits — another project, or more rights than assistants now get —
   * ends too.
   */
  async configure(owner: string, anchorCapability: string, input: { rights: string | null; device?: string; workspaceId?: string }): Promise<AssistantSettings> {
    const anchor = this.options.docShares.cardAnchor(anchorCapability);
    if (anchor.owner !== owner) throw new DocsAddonError(403, '只有这张卡片的所有者可以设置文档助手');
    if (input.rights === null) {
      this.options.assistants.configure(anchor.id, null);
      for (const row of this.options.assistants.unended(anchor.id)) this.stop(row);
      return this.settings(anchorCapability);
    }
    if (input.rights !== 'read' && input.rights !== 'write') throw new DocsAddonError(400, '文档助手的权限只能是 read 或 write');
    const device = input.device?.trim() ?? '';
    const workspaceId = input.workspaceId?.trim() ?? '';
    if (!device || !WORKSPACE_ID.test(workspaceId)) throw new DocsAddonError(400, '请选择一台设备上的一个项目工作区');
    const problem = this.placementProblem(owner, device);
    if (problem) throw new DocsAddonError(409, problem);
    const listed = await this.options.executions.deviceWorkspaces(owner, device);
    if (!listed.ok) throw new DocsAddonError(409, listed.reason);
    const workspace = listed.workspaces.find((each) => each.workspace_id === workspaceId);
    if (!workspace) throw new DocsAddonError(404, `设备 ${device} 上没有登记这个工作区`);
    if (tooBroad(workspace.display)) throw new DocsAddonError(422, '整个主目录或系统根目录不能关联给文档；请把项目目录登记为单独的工作区');
    this.options.assistants.configure(anchor.id, input.rights, { device, workspaceId, label: clip(workspace.label, PLACE_LABEL_MAX) });
    for (const row of this.options.assistants.unended(anchor.id)) {
      if (row.device !== device || row.workspaceId !== workspaceId || (input.rights === 'read' && row.rights === 'write')) this.stop(row);
    }
    return this.settings(anchorCapability);
  }

  // ── a guest ──

  /**
   * A guest's new assistant, from the card they hold, in the document its host
   * reports. The same request id joins the assistant it already made. The
   * card's owner must have turned assistants on; the card must be in its own
   * document and the owner still able to share it; the caps must allow one
   * more. Then, in one transaction, the assistant's share and its row; then
   * the launch on the project's device, whose first message tells the agent
   * who it works for and what it has. Returns at once: `status` follows it.
   */
  async start(guest: AssistantGuest, anchorCapability: string, hostToken: string | undefined, task: string, requestId: string): Promise<{ id: string }> {
    const text = task.trim();
    if (!text) throw new DocsAddonError(400, '请写清楚要文档助手做什么');
    if (!REQUEST_ID.test(requestId)) throw new DocsAddonError(400, '请求标识无效');
    const card = this.options.docShares.cardAnchor(anchorCapability);
    const id = `${DOC_ASSISTANT_OPERATION_PREFIX}${digest(JSON.stringify([card.owner, card.id, guest.openId, requestId])).slice(0, 40)}`;
    if (this.options.assistants.get(id)) return { id };
    const name = guestName(guest.name);
    const { project, rights } = this.options.assistants.settings(card.id);
    if (!rights || !project) throw new DocsAddonError(409, '这篇文档的所有者还没有开启文档助手');
    const problem = this.placementProblem(card.owner, project.device);
    if (problem) throw new DocsAddonError(409, problem);
    const anchor = await this.options.docShares.assistantAnchor(anchorCapability, hostToken);
    const title = (await this.app().document(anchor.owner, anchor.documentId).catch(() => null))?.title ?? '';
    const prompt = assistantInstruction({ guest: name, owner: this.options.displayName(anchor.owner), doc: { title, id: anchor.documentId },
      project: project.label, rights, task: text });
    if (Buffer.byteLength(prompt) > MACHINE_LIMITS.startMaxPromptBytes) {
      throw new DocsAddonError(413, `任务有 ${Math.ceil(Buffer.byteLength(text) / 1024)} KB，超过了一条任务能携带的 ${MACHINE_LIMITS.startMaxPromptBytes / 1024} KB`);
    }
    const at = this.now();
    const created = this.options.transaction(() => {
      if (this.options.assistants.get(id)) return false;
      // What the owner set may have changed while the card was checked.
      const current = this.options.assistants.settings(anchor.id);
      if (current.rights !== rights || current.project?.device !== project.device || current.project.workspaceId !== project.workspaceId) {
        throw new DocsAddonError(409, current.rights ? '文档助手的设置刚刚改过，请重试' : '这篇文档的所有者已经关闭了文档助手');
      }
      if (this.options.assistants.liveCount(anchor.id) >= ASSISTANTS_PER_CARD) {
        throw new DocsAddonError(429, `这篇文档里同时运行的文档助手已经有 ${ASSISTANTS_PER_CARD} 个，请等别人结束后再试`);
      }
      if (this.options.assistants.liveCount(anchor.id, guest.openId) >= ASSISTANTS_PER_GUEST) {
        throw new DocsAddonError(429, `你在这篇文档里同时最多运行 ${ASSISTANTS_PER_GUEST} 个文档助手，请先结束一个`);
      }
      if (this.options.assistants.startsSince(guest.openId, at - DAY_MS) >= STARTS_PER_GUEST_PER_DAY) {
        throw new DocsAddonError(429, `你在 24 小时内最多启动 ${STARTS_PER_GUEST_PER_DAY} 个文档助手，请稍后再试`);
      }
      const shareId = this.options.docShares.openAssistantShare(anchor, clip(`${name}的文档助手`, TITLE_MAX), rights);
      this.options.assistants.create({ id, owner: anchor.owner, anchorId: anchor.id, shareId, guestOpenId: guest.openId, guestName: name,
        title: clip(`${name}的文档助手：${text}`, TITLE_MAX), device: project.device, workspaceId: project.workspaceId, createdAt: at });
      return true;
    });
    if (!created) return { id };
    const defaults = this.options.launchDefaults(anchor.owner);
    this.notify(id, 'started', title ? { title } : undefined);
    // `permission_profile` is Claude's own setting (no prompt for a tool call); the read-only scope is what confines it.
    const launched = await this.dispatch(anchor.owner, project.device, 'start_session', {
      device: project.device, execution_device: project.device, workspace_id: project.workspaceId,
      source: 'claude', permission_profile: 'full_access', prompt,
      ...(defaults.model.claude ? { model: defaults.model.claude } : {}), ...(defaults.effort.claude ? { effort: defaults.effort.claude } : {}),
      client_request_id: id, operation_id: id, input_receipt: true,
    }, id, '飞书文档助手 · 启动');
    if (launched.kind === 'refused' || (launched.kind === 'receipt' && launched.receipt.state === 'failed')) {
      const reason = launched.kind === 'refused' ? launched.message : launched.receipt.error ?? '设备没有启动这个文档助手';
      log.warn({ assistant: id, owner: anchor.owner, device: project.device, reason }, 'Feishu document assistant did not start');
      this.fail(id, reason);
      throw new DocsAddonError(503, START_FAILED);
    }
    // A launch whose outcome is unknown may still be running: `status` asks the device.
    return { id };
  }

  /**
   * One assistant's state, for its guest or the card's owner. While it starts,
   * the device is asked for the launch's receipt (the dispatch preparer binds
   * its scope the moment that names the session). With a session there is a
   * card for its conversation.
   */
  async status(caller: AssistantCaller, id: string): Promise<AssistantStatus> {
    let row = this.visible(caller, id);
    if (row.live && !row.sessionId) row = await this.observe(row);
    row = this.settle(row);
    // A card over its conversation only while it may be used: an ended, paused or switched-off one gets none, old or new.
    return { ...this.view(row, caller), ...(row.usable && row.sessionId ? { binding: this.binding(row) } : {}) };
  }

  /** The card's assistants: a guest sees their own, the card's owner every one. Newest first. */
  list(caller: AssistantCaller, anchorCapability: string): AssistantView[] {
    const anchor = this.options.docShares.cardAnchor(anchorCapability);
    const rows = this.options.assistants.ofAnchor(anchor.id, caller.username === anchor.owner ? undefined : caller.openId);
    return rows.map((row) => this.view(this.settle(row), caller));
  }

  /** Its guest or the card's owner ends it: its share terminates, its scope goes, a running turn is asked to stop. */
  end(caller: AssistantCaller, id: string): AssistantView {
    const row = this.visible(caller, id);
    this.stop(row);
    return this.view(this.options.assistants.get(id) ?? row, caller);
  }

  /**
   * Its guest puts its card into the document, right after the control card
   * (at the end when that is not found), as the Feishu app — never as the
   * owner. From then on any signed-in reader may watch it; only its guest
   * and the owner may talk to it. The app needs edit access to the document.
   */
  async pin(guest: { openId: string }, id: string): Promise<{ block: string }> {
    const row = this.options.assistants.get(id);
    if (!row || row.guestOpenId !== guest.openId) throw new DocsAddonError(404, '找不到这个文档助手');
    if (!row.sessionId) throw new DocsAddonError(409, '文档助手还没有启动好，稍后再固定到文档里');
    // Pinning writes the document as the app: only an assistant that may be used now (live, its card's assistants on
    // and not narrowed below it, its project unchanged) and that may write the document.
    if (!row.usable) throw new DocsAddonError(409, row.live ? '这个文档助手已被暂停或关闭，不能固定到文档里' : '这个文档助手已经结束，不能固定到文档里');
    if (row.rights !== 'write') throw new DocsAddonError(403, '这个文档助手只能读这篇文档，不能固定进文档');
    if (row.pinnedAt !== null) throw new DocsAddonError(409, '这个文档助手已经固定在文档里了');
    const componentTypeId = this.options.componentTypeId;
    if (!componentTypeId) throw new DocsAddonError(503, '这个 Octopus 没有配置飞书文档卡片的组件 ID，不能固定到文档');
    let pinning = this.pinning.get(id);
    if (!pinning) {
      pinning = this.pinOnce(row, componentTypeId).finally(() => this.pinning.delete(id));
      this.pinning.set(id, pinning);
    }
    return pinning;
  }

  // ── the dispatch preparer and the session registry (`bootstrap-v3.ts`) ──

  /** The launch a read-only scope may be issued for: registered here, live, and not yet bound to a session. */
  placementForOperation(owner: string, operationId: string): AssistantLaunch | null {
    if (!operationId.startsWith(DOC_ASSISTANT_OPERATION_PREFIX)) return null;
    const row = this.options.assistants.get(operationId);
    if (!row || row.owner !== owner || !row.live || row.sessionId !== null) return null;
    return { id: row.id, shareId: row.shareId, device: row.device, workspaceId: row.workspaceId };
  }

  /**
   * The assistant a provider session is. Any source string is matched: a
   * session id names one session, and an assistant's is never anything else.
   */
  bySession(owner: string, device: string, _source: string, sessionId: string): (AssistantSessionPlacement & { id: string }) | null {
    const row = this.options.assistants.bySession(owner, device, sessionId);
    return row ? { id: row.id, docShare: row.shareId, executionDevice: row.device, workspaceId: row.workspaceId, live: row.live } : null;
  }

  /** A receipt named the launch's session: recorded before its scope binds, so the scope binds only to a registered session. */
  attach(id: string, owner: string, sessionId: string): void {
    if (!this.options.assistants.attach(id, owner, sessionId)) throw new Error('文档助手的会话与登记不一致，或它已经结束');
  }

  /**
   * Its share ended (`onAssistantEnded`): the scope goes first, with its token
   * and binding, so a still-running agent loses its tools now; then the row
   * ends; a turn in progress is asked to stop.
   */
  ended(shareId: string): void {
    this.options.executions.releaseDocShare(shareId);
    const row = this.options.assistants.byShare(shareId);
    if (!row || !this.options.assistants.end(row.id, this.now())) return;
    if (row.sessionId) {
      // Every card over its conversation stops showing it — the guest's, and one pinned in the document: how the owner
      // takes a publication back.
      this.options.cards.revoke(row.owner, { resource: resourceId({ owner: row.owner, device: row.device, cliKind: 'claude', sessionId: row.sessionId }) }, this.now());
      this.capabilities.delete(row.id);
      void this.dispatch(row.owner, row.device, 'append_session', { device: row.device, id: row.sessionId, source: 'claude', interrupt: true,
        operation_id: `op_fdae_${digest(row.id).slice(0, 40)}`, input_receipt: true }, `op_fdae_${digest(row.id).slice(0, 40)}`, '飞书文档助手 · 结束')
        .catch(() => undefined);
    }
  }

  // ── its cards (`docs-addon.ts`) ──

  /** The assistant a card's session is; null for an ordinary card. */
  ofSession(owner: string, device: string, sessionId: string): DocAssistant | null {
    return this.options.assistants.bySession(owner, device, sessionId);
  }

  /**
   * A message or a stop from the assistant's own guest, as one auto-allowed
   * call on the owner's device — never through the owner's Session Hub, so a
   * guest login derives no Context there. The card follows it by `receipt`.
   */
  async talk(row: DocAssistant, guest: { openId: string }, input: { prompt: string } | { interrupt: true }, requestId: string, doc?: DocRef): Promise<{ id: string; receipt: LaunchReceipt }> {
    const current = this.options.assistants.get(row.id);
    if (!current || current.guestOpenId !== guest.openId || !current.sessionId) throw new DocsAddonError(403, '只有发起这个文档助手的人和文档所有者可以和它对话');
    if ('prompt' in input && !current.usable) throw new DocsAddonError(409, current.live ? '这个文档助手已被暂停，或者控制卡片已不在文档里' : '这个文档助手已经结束');
    const operationId = `op_fdam_${digest(JSON.stringify([current.id, guest.openId, requestId])).slice(0, 40)}`;
    const sent = await this.dispatch(current.owner, current.device, 'append_session', {
      device: current.device, id: current.sessionId, source: 'claude',
      ...('prompt' in input ? { prompt: input.prompt } : { interrupt: true }),
      operation_id: operationId, input_receipt: true,
    }, operationId, '飞书文档助手 · 对话');
    if (sent.kind === 'refused') {
      log.warn({ assistant: current.id, owner: current.owner, device: current.device, reason: sent.message }, 'Feishu document assistant turn refused');
      throw new DocsAddonError(503, TURN_FAILED);
    }
    if ('prompt' in input) this.notify(current.id, 'spoke', doc);
    return { id: operationId, receipt: sent.kind === 'receipt' ? guestReceipt(current, sent.receipt) : { state: 'unknown' } };
  }

  /** The device's receipt for one of those calls. */
  async receipt(row: Pick<DocAssistant, 'owner' | 'device'>, operationId: string): Promise<LaunchReceipt> {
    const read = await this.dispatch(row.owner, row.device, 'get_session_operation', { device: row.device, operation_id: operationId }, operationId, '飞书文档助手 · 查询');
    return read.kind === 'receipt' ? guestReceipt(row, read.receipt) : { state: 'unknown' };
  }

  // ── internals ──

  /** Whether a device can host an assistant now: online, its Runner new enough, with split Claude. Null when it can. */
  private placementProblem(owner: string, device: string): string | null {
    const row = this.options.caps.listDevices(owner).find((each) => each.device === device);
    if (!row?.online) return `${device} 当前不在线`;
    const inventory = row.inventory;
    if (!inventory || inventory.read_only || !inventory.execution.shell || !inventory.execution.workspace_files) {
      return `${row.display_name || device} 没有开放工作区与会话操作，不能运行文档助手`;
    }
    if (inventory.session_operations?.protocol !== SESSION_OPERATION_PROTOCOL || inventory.execution.read_only_scope !== true) {
      return `${row.display_name || device} 的 Runner 需要升级后才能运行文档助手`;
    }
    if (!inventory.agent_backends.some((backend) => backend.kind === 'claude' && backend.available && backend.split_execution)) {
      return `${row.display_name || device} 上没有可用的 Claude Code`;
    }
    return null;
  }

  /** The assistant, for its guest or the card's owner; nobody else learns it exists. */
  private visible(caller: AssistantCaller, id: string): DocAssistant {
    const row = typeof id === 'string' && id.startsWith(DOC_ASSISTANT_OPERATION_PREFIX) ? this.options.assistants.get(id) : null;
    if (!row || (row.guestOpenId !== caller.openId && caller.username !== row.owner)) throw new DocsAddonError(404, '找不到这个文档助手');
    return row;
  }

  private view(row: DocAssistant, caller: AssistantCaller): AssistantView {
    const mine = row.guestOpenId === caller.openId;
    const state: AssistantView['state'] = row.live ? (row.sessionId ? 'ready' : 'starting') : row.error ? 'failed' : 'ended';
    const message = state === 'starting' ? '正在启动…'
      : state === 'ready' ? (row.usable ? '可以对话' : '已暂停：所有者暂停或关闭了它，或者控制卡片已不在文档里')
      // Why the device failed is the owner's to read; its guest gets the fixed words.
      : state === 'failed' ? (caller.username === row.owner ? row.error! : START_FAILED) : '已结束';
    return { id: row.id, title: row.title, guest: mine ? row.guestName : verifiedGuestName(row), mine, state, message, rights: row.rights,
      created_at: row.createdAt, ended_at: row.endedAt, pinned: row.pinnedAt !== null };
  }

  /** An assistant whose share ended without telling (its token revoked from the token list) ends now. */
  private settle(row: DocAssistant): DocAssistant {
    if (row.live || row.endedAt !== null) return row;
    this.ended(row.shareId);
    return this.options.assistants.get(row.id) ?? row;
  }

  /** Every way of ending is this one: its share terminates, and `ended` follows (here too, for a share that already ended). */
  private stop(row: DocAssistant): void {
    if (row.endedAt !== null) return;
    if (row.live) this.options.docShares.endAssistant(row.shareId);
    this.ended(row.shareId);
  }

  private fail(id: string, reason: string): void {
    this.options.assistants.failed(id, reason);
    const row = this.options.assistants.get(id);
    if (row) this.stop(row);
  }

  /** Asks the device how the launch is going; one check per assistant at a time. */
  private observe(row: DocAssistant): Promise<DocAssistant> {
    let running = this.observing.get(row.id);
    if (!running) {
      running = (async () => {
        const read = await this.dispatch(row.owner, row.device, 'get_session_operation', { device: row.device, operation_id: row.id }, row.id, '飞书文档助手 · 启动');
        if (read.kind === 'receipt' && read.receipt.state === 'failed') {
          log.warn({ assistant: row.id, owner: row.owner, device: row.device, reason: read.receipt.error }, 'Feishu document assistant did not start');
          this.fail(row.id, read.receipt.error ?? '设备没有启动这个文档助手');
        }
        else if (read.kind === 'receipt' && read.receipt.state === 'missing' && this.now() - row.createdAt > LOST_LAUNCH_MS) {
          this.fail(row.id, '设备上没有这次启动的记录，请重新开始');
        }
        return this.options.assistants.get(row.id) ?? row;
      })().finally(() => this.observing.delete(row.id));
      this.observing.set(row.id, running);
    }
    return running;
  }

  /**
   * The card that shows an assistant's conversation. Only a capability's hash
   * is stored, so one is minted the first time this process shows it, and
   * kept for this process; one minted before a restart (in a guest's panel,
   * or pinned in the document) keeps working.
   */
  private binding(row: DocAssistant): NonNullable<AssistantStatus['binding']> {
    let capability = this.capabilities.get(row.id);
    if (!capability || this.options.cards.get(digest(capability))?.revokedAt !== null) {
      capability = `ds_${randomBytes(32).toString('base64url')}`;
      const resource = resourceId({ owner: row.owner, device: row.device, cliKind: 'claude', sessionId: row.sessionId! });
      this.options.cards.create({ id: digest(capability), owner: row.owner, resource, title: row.title, createdAt: this.now(), revokedAt: null });
      this.capabilities.delete(row.id);
      if (this.capabilities.size >= REMEMBERED) this.capabilities.delete(this.capabilities.keys().next().value!);
      this.capabilities.set(row.id, capability);
    }
    return { share: capability, title: row.title, owner: this.options.displayName(row.owner), device: row.device, provider: 'claude' };
  }

  private async pinOnce(row: DocAssistant, componentTypeId: string): Promise<{ block: string }> {
    const anchor = this.options.links.anchor(row.anchorId);
    if (!anchor) throw new DocsAddonError(404, '找不到这个文档助手的控制卡片');
    const binding = this.binding(row);
    const app = this.app();
    const blocks = await app.blocks(row.owner, anchor.documentId);
    const card = anchorBlock(blocks, componentTypeId, anchor.capabilityHash);
    const parent = card ? blocks.find((block) => block.id === card.parent) : undefined;
    const end: BlockSlot = { parent: anchor.documentId, index: -1 };
    const slots = card && parent ? [{ parent: parent.id, index: parent.children.indexOf(card.id) + 1 }, end] : [end];
    const record = { octopusAgent: { v: 2, ...binding, doc: anchor.documentId, ...(anchor.wikiToken ? { alias: anchor.wikiToken } : {}) } };
    const block = await insertCard(app, row.owner, anchor.documentId, componentTypeId, record, slots, binding.share);
    this.options.assistants.pin(row.id, this.now());
    this.notify(row.id, 'pinned');
    return { block };
  }

  private app(): FeishuDocsClient {
    return this.options.docs.asApp();
  }

  private notify(id: string, event: 'started' | 'spoke' | 'pinned', doc?: DocRef): void {
    const row = this.options.assistants.get(id);
    if (!row || !this.options.notify) return;
    const project = this.options.assistants.settings(row.anchorId).project;
    this.options.notify(row.owner, { kind: 'assistant', event, actor: verifiedGuestName(row), guest: row.guestOpenId, anchor: row.anchorId, title: row.title,
      device: row.device, project: project?.workspaceId === row.workspaceId ? project.label : row.workspaceId, rights: row.rights, ...(doc ? { doc } : {}) });
  }

  /**
   * One operation on the owner's device, auto-allowed for this call only: the
   * product decision (2026-10-18) that document actions raise no approval
   * card and the owner hears about them instead. The grant names the device
   * and dies with the call.
   */
  private async dispatch(owner: string, device: string, operation: 'start_session' | 'append_session' | 'get_session_operation',
    args: Record<string, unknown>, operationId: string, purpose: string): Promise<Dispatched> {
    const grant = this.options.caps.open({ username: owner, purpose, kind: 'job', device, rights: [operation], autoAllow: [operation],
      metadata: { surface: 'feishu-docs-assistant', operation_id: operationId } });
    if (!grant) return { kind: 'refused', status: 409, message: '这台设备不属于文档所有者，或已被移除' };
    try {
      const outcome = await grant.request(operation, args);
      if (outcome.status === 'approval_required') return { kind: 'refused', status: 409, message: '设备要求人工批准，没有执行' };
      if (outcome.status === 'denied') return { kind: 'refused', status: 403, message: '设备拒绝了这次操作' };
      // A definite refusal carries the device's (or the dispatch preparer's) own words.
      if (outcome.status === 'failed') return { kind: 'refused', status: 422, message: outcome.reason.slice(0, 200) };
      if (outcome.status !== 'succeeded') return { kind: 'unknown', message: '设备暂时没有响应，结果还不确定' };
      const receipt = sessionOperationReceiptFromWire(outcome.result, operationId);
      if (!receipt) return { kind: 'refused', status: 409, message: '这台设备的 Runner 需要升级后才能运行文档助手' };
      const sessionId = receipt.input?.session_id ?? receipt.session_id;
      const error = receipt.result && typeof receipt.result.error === 'string' ? receipt.result.error.slice(0, 300) : undefined;
      return { kind: 'receipt', receipt: { state: receipt.state, ...(sessionId ? { sessionId } : {}), ...(error ? { error } : {}) } };
    } finally { grant.destroy(); }
  }
}

/** What the owner set on a card, as the card reads it (in full: the share panel hides the project's place from readers). */
export function assistantSettingsView(settings: DocAssistantSettings): AssistantSettings {
  return {
    rights: settings.rights,
    project: settings.project ? { device: settings.project.device, workspace_id: settings.project.workspaceId, label: settings.project.label } : null,
    limits: { per_card: ASSISTANTS_PER_CARD, per_guest: ASSISTANTS_PER_GUEST, per_guest_per_day: STARTS_PER_GUEST_PER_DAY },
  };
}

/** A guest's turn as the guest sees it: a device's error becomes the fixed words, and goes to the log. */
function guestReceipt(row: Pick<DocAssistant, 'owner' | 'device'>, receipt: LaunchReceipt): LaunchReceipt {
  if (!receipt.error) return receipt;
  log.warn({ owner: row.owner, device: row.device, reason: receipt.error }, 'Feishu document assistant turn failed');
  return { ...receipt, error: TURN_FAILED };
}

/**
 * A guest's name as everyone but the guest sees it — the owner in lists,
 * frames and notices: the name their card supplied (anyone can type any
 * name), then the end of the open_id the login verified.
 */
export function verifiedGuestName(row: Pick<DocAssistant, 'guestName' | 'guestOpenId'>): string {
  return `${row.guestName}（…${row.guestOpenId.slice(-6)}）`;
}

/** A display name as the card read it: printable, one line, at most GUEST_NAME_MAX characters. Labels only, never authority. */
export function guestName(raw: unknown): string {
  return clip(typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ') : '', GUEST_NAME_MAX) || '飞书用户';
}

const clip = (value: string, max: number) => [...value.replace(/\s+/g, ' ').trim()].slice(0, max).join('');

/**
 * An assistant's first message: one paragraph on who it works for, which
 * document and project it has and exactly which tools, then the guest's task.
 */
export function assistantInstruction(input: { guest: string; owner: string; doc: { title: string; id: string }; project: string; rights: AssistantRights; task: string }): string {
  const docTools: readonly string[] = input.rights === 'write' ? [...SHARED_DOC_READ_TOOLS, ...SHARED_DOC_WRITE_TOOLS] : SHARED_DOC_READ_TOOLS;
  const doc = `${input.doc.title ? `《${clip(input.doc.title, 120)}》` : ''}（document_id：${input.doc.id}）`;
  const paragraph = `【文档助手】你是 ${input.guest} 在飞书文档${doc}里启动的文档助手，为 ${input.guest} 工作，运行在 ${input.owner} 的 Octopus 上。`
    + `你只有这些工具：项目「${clip(input.project, 120)}」的只读访问（${SESSION_READ_ONLY_OPERATIONS.join('、')}），`
    + `以及这篇文档的${input.rights === 'write' ? '读写' : '只读'}访问（${docTools.join('、')}，身份是 Octopus 飞书应用）。`
    + `没有命令、写文件或其他工具，也不能访问别的文档或工作区；${input.guest} 在文档侧边栏里实时看到你的回复。`;
  return `${paragraph}\n\n${input.task}`;
}
