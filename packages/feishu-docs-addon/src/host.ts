import { BlockitClient, type DocMiniApp, type DocumentPermission, type RecordChangeset, type RecordData, type ViewportChangeEvent } from '@lark-opdev/block-docs-addon-api';
import { parseBinding, parseBoard, parseDocShare, type CardBinding, type DocsHost, type HostSnapshot } from './protocol';

const KEY = 'octopusAgent';
const BOARD_KEY = 'octopusBoard';
/** A document-share control card: its own key, so an Agent card and a board are never read as one. */
const SHARE_KEY = 'octopusShare';
const EXPAND_KEY = 'octopus-agent:expand-file';
export type Surface = 'inline' | 'modal' | 'float';
/** Feishu on a phone or tablet (an iPad may call itself a Mac, with a touch screen). */
const mobileClient = () => /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

/**
 * The only module that talks to the official Docs add-on SDK. It turns the
 * document into one snapshot: which document this is, whether the reader may
 * edit, what the card's shared Record says, whether it is on screen, and the
 * host theme. Every subscription it opens is closed by `close()`.
 */
export class FeishuDocsHost implements DocsHost {
  private snapshot?: HostSnapshot;
  private change?: (snapshot: HostSnapshot) => void;
  private blockId = '';
  private closed = false;
  private readonly cleanups: Array<() => Promise<void>> = [];

  constructor(readonly surface: Surface, private readonly sdk: DocMiniApp = new BlockitClient().initAPI()) {}

  private readonly onRecord = (record: RecordData) => this.update({
    binding: parseBinding(record?.[KEY]), board: parseBoard(record?.[BOARD_KEY]), docShare: parseDocShare(record?.[SHARE_KEY]),
  });
  private readonly onPermission = (permission: DocumentPermission) => this.update({ editable: Boolean(permission?.editable) });
  private readonly onViewport = (event: ViewportChangeEvent) => {
    if (this.blockId) this.update({ visible: (event?.viewportBlockIds ?? []).some((id) => String(id) === this.blockId) });
  };
  private readonly onDark = (dark: boolean) => this.update({ dark });

  private update(patch: Partial<HostSnapshot>): void {
    if (!this.snapshot || this.closed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.change?.(this.snapshot);
  }
  private alive(): void { if (this.closed) throw new Error('卡片已关闭'); }

  /** Subscribes, then reads: a change that lands in between is never lost. */
  private async listen<T>(on: (fn: T) => Promise<void>, off: (fn: T) => Promise<void>, fn: T): Promise<void> {
    await on(fn);
    this.cleanups.push(() => off(fn));
    this.alive();
  }

  async initialize(change: (snapshot: HostSnapshot) => void): Promise<HostSnapshot> {
    try {
      this.change = change;
      const doc = await this.sdk.getActiveDocumentRef(); this.alive();
      this.snapshot = { doc: doc.docToken, editable: false, binding: null, board: null, docShare: null, float: this.surface === 'float', visible: true, dark: false };
      const sdk = this.sdk;
      await this.listen((fn) => sdk.Record.onRecordChange(fn), (fn) => sdk.Record.offRecordChange(fn), this.onRecord);
      await this.listen((fn) => sdk.Service.Permission.onDocumentPermissionChange(doc, fn), (fn) => sdk.Service.Permission.offDocumentPermissionChange(doc, fn), this.onPermission);
      const [record, permission, dark] = await Promise.all([
        sdk.Record.getRecord(),
        sdk.Service.Permission.getDocumentPermission(doc),
        sdk.Env.DarkMode.getIsDarkMode().catch(() => false),
      ]);
      this.alive();
      this.onRecord(record); this.onPermission(permission); this.onDark(dark);
      // Optional comforts: a host without them still renders a working card.
      await this.listen((fn) => sdk.Env.DarkMode.onDarkModeChange(fn), (fn) => sdk.Env.DarkMode.offDarkModeChange(fn), this.onDark).catch(() => {});
      if (this.surface === 'inline') {
        this.blockId = String((await sdk.getActiveBlock().catch(() => null))?.id ?? '');
        await this.listen((fn) => sdk.Viewport.onViewportChange(fn), (fn) => sdk.Viewport.offViewportChange(fn), this.onViewport).catch(() => {});
      }
      await sdk.LifeCycle.notifyAppReady(); this.alive();
      return this.snapshot;
    } catch (error) { await this.close(); throw error; }
  }

  loginCode(): Promise<string> { return this.sdk.Service.User.login(); }

  async bind(binding: Omit<CardBinding, 'v' | 'doc'> | null): Promise<HostSnapshot> {
    if (!this.snapshot) throw new Error('卡片尚未准备好');
    const permission = await this.sdk.Service.Permission.getDocumentPermission(await this.sdk.getActiveDocumentRef());
    this.alive();
    if (!permission.editable) throw new Error('需要这篇文档的编辑权限才能更换卡片里的 Agent');
    const value: CardBinding | null = binding ? { v: 2, ...binding, doc: this.snapshot.doc } : null;
    const record = await this.sdk.Record.getRecord(); this.alive();
    // A transaction touches only this card's key and keeps undo/redo history.
    const exists = record?.[KEY] !== undefined;
    const change: RecordChangeset = value
      ? { type: exists ? 'replace' : 'insert', data: { path: [KEY], value } }
      : { type: 'remove', data: { path: [KEY] } };
    const result = await this.sdk.Record.setRecord([change]).catch((error: unknown) => {
      throw new Error(error instanceof Error && error.message ? `文档未保存这次更改：${error.message}` : '文档未保存这次更改，请确认处于编辑模式');
    });
    this.alive();
    this.onRecord(result);
    return this.snapshot;
  }

  async clearBoard(): Promise<HostSnapshot> {
    if (!this.snapshot) throw new Error('卡片尚未准备好');
    const record = await this.sdk.Record.getRecord(); this.alive();
    if (record?.[BOARD_KEY] === undefined) return this.snapshot;
    const result = await this.sdk.Record.setRecord([{ type: 'remove', data: { path: [BOARD_KEY] } }]).catch((error: unknown) => {
      throw new Error(error instanceof Error && error.message ? `文档未保存这次更改：${error.message}` : '文档未保存这次更改，请确认处于编辑模式');
    });
    this.alive();
    this.onRecord(result);
    return this.snapshot;
  }

  /**
   * The modal is a separate frame of the same package. A file to open there is
   * handed over through this origin's storage, read once and only while fresh.
   */
  async expand(title: string, file?: string): Promise<void> {
    if (file) { try { localStorage.setItem(EXPAND_KEY, JSON.stringify({ file, at: Date.now() })); } catch { /* the modal then opens on the conversation */ } }
    await this.sdk.View.Action.openModal({ key: 'view', title: title.slice(0, 60) || 'Octopus Agent', width: 1040 });
  }
  takeExpandedFile(): string | null {
    if (this.surface !== 'modal') return null;
    try {
      const raw = localStorage.getItem(EXPAND_KEY);
      localStorage.removeItem(EXPAND_KEY);
      const value = raw ? JSON.parse(raw) as { file?: unknown; at?: unknown } : null;
      return value && typeof value.file === 'string' && typeof value.at === 'number' && Date.now() - value.at < 15_000 ? value.file : null;
    } catch { return null; }
  }
  async documentTitle(): Promise<string> {
    return String(await this.sdk.Document.getTitle(await this.sdk.getActiveDocumentRef()).catch(() => '') ?? '').slice(0, 200);
  }
  async documentText(): Promise<string> {
    const markdown = await this.sdk.Document.getDocAsMarkdown().catch(() => this.sdk.Document.getDocAsPlainText()).catch(() => '');
    return String(markdown ?? '');
  }
  float(): Promise<void> { return this.sdk.Service.FloatCard.enterFloatCard(); }
  open(url: string): Promise<void> { return this.sdk.Service.Hyperlink.open(url); }
  /**
   * Only the inline card has a height of its own, and only Feishu's mobile
   * clients size its block by `Bridge.updateHeight`. On desktop the block
   * keeps the height readers give it (changing it there is a collaborative
   * document edit, `updateResize`), so the card fills the block and asks
   * nothing. The modal and the side card fill what the host gives them.
   */
  async fitHeight(height: number): Promise<void> {
    if (this.surface !== 'inline' || this.closed || !Number.isFinite(height) || !mobileClient()) return;
    try { await this.sdk.Bridge.updateHeight(Math.round(height)); } catch { /* the card keeps its height */ }
  }
  async readerName(): Promise<string> {
    try {
      const name = (await this.sdk.Service.User.getUserInfo())?.nickName;
      return typeof name === 'string' ? name.trim().slice(0, 200) : '';
    } catch { return ''; }
  }

  async close(): Promise<void> {
    this.closed = true; this.change = undefined;
    for (const cleanup of this.cleanups.splice(0)) await cleanup().catch(() => {});
  }
}
