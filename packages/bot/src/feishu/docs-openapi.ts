/**
 * The few Feishu document calls the docs agent surface makes AS the owner,
 * with the owner's stored OAuth user token (refreshed by FeishuAuthManager).
 * The token never leaves this process; callers pass a username, never a token.
 *
 * Feishu enforces the document ACL on every call, so "may this owner put a
 * card here" is answered by Feishu itself: inserting a block needs edit access.
 *
 * `asApp()` makes the same calls as the Octopus app itself (tenant token):
 * only for a document its owner shared with the app and then shared onward
 * through a document share link (`doc-share.ts`). Feishu then checks the app's
 * own access to that document, which the owner granted by adding the app.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DocsAddonError } from './docs-addon-auth.js';

const API = 'https://open.feishu.cn/open-apis';
const TOKEN = /^[A-Za-z0-9]{16,64}$/;

/** A document reference as a person or agent writes it: a share link or a bare token. */
export interface DocumentRef { kind: 'docx' | 'wiki' | 'token'; token: string; origin?: string }

export function parseDocumentRef(input: string): DocumentRef | null {
  const value = input.trim();
  if (TOKEN.test(value)) return { kind: 'token', token: value };
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !/(^|\.)(feishu\.cn|larksuite\.com|feishu-pre\.cn)$/.test(url.hostname)) return null;
  const match = /^\/(docx|wiki)\/([A-Za-z0-9]{16,64})(?:\/|$)/.exec(url.pathname);
  return match ? { kind: match[1] as 'docx' | 'wiki', token: match[2], origin: url.origin } : null;
}

/** A document a title search found. */
export interface DocumentHit { title: string; ref: DocumentRef; documentId?: string; url?: string }

const safeOrigin = (value: string): string | undefined => {
  try { return parseDocumentRef(value)?.origin; } catch { return undefined; }
};

/**
 * The one document a title names: the unique exact title match, else the only
 * hit. Several plausible hits are not guessed between.
 */
export function pickDocument(query: string, hits: readonly DocumentHit[]): { hit: DocumentHit } | { candidates: DocumentHit[] } {
  const norm = (value: string) => value.replace(/[《》「」"“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = norm(query);
  const exact = hits.filter((hit) => norm(hit.title) === wanted);
  if (exact.length === 1) return { hit: exact[0] };
  if (!exact.length && hits.length === 1) return { hit: hits[0] };
  return { candidates: (exact.length ? exact : hits).slice(0, 6) };
}

/** One concrete docx document, with every name a card may later see it by. */
export interface DocTarget {
  /** The docx document id: where blocks are created. */
  documentId: string;
  /** The wiki node token when the document lives in a wiki space. */
  wikiToken?: string;
  title: string;
  url?: string;
  /** The document's revision when it was read (docx `revision_id`). */
  revision?: number;
  /** The wiki node it was named by is a shortcut to a node elsewhere, not the document's own node. */
  wikiShortcut?: boolean;
}

/** Whose token a client's calls carry: the named owner's OAuth token, or the Octopus app's own tenant token. */
export type FeishuDocsIdentity = 'user' | 'app';

/** One block of a document, reduced to what placing a card reads. */
export interface DocBlock {
  id: string; parent: string; children: readonly string[]; text: string; /** docx block_type */ type?: number;
  /** An add-on block's component and Record (JSON text), as the document stores them. */
  addOn?: { component: string; record: string };
}

/** The block of the card whose Record carries `capability` (a session card's share), if the document has it. */
export function cardBlock(blocks: readonly DocBlock[], componentTypeId: string, capability: string): DocBlock | undefined {
  return blocks.find((block) => {
    if (block.addOn?.component !== componentTypeId) return false;
    try { return (JSON.parse(block.addOn.record) as { octopusAgent?: { share?: unknown } }).octopusAgent?.share === capability; } catch { return false; }
  });
}

/** A position for a new block: under `parent`, at `index` among its children (-1 = last). */
export interface BlockSlot { parent: string; index: number }

/** Feishu answered and refused; `code` is Feishu's own error code. */
export class FeishuRefusal extends DocsAddonError {
  constructor(status: number, message: string, readonly code: number) { super(status, message); }
}

const compact = (text: string) => text.replace(/\s+/g, '');

/**
 * Where a card placed after `anchor` goes. The anchor is a block id or text
 * from the document; text is matched with whitespace ignored, in reading
 * order, and may run across neighbouring blocks. The card follows the block
 * where the text ends, as that block's next sibling. The later slots step out
 * through each enclosing block to the document body, for a parent Feishu will
 * not hold a card in. Text that ends in several blocks is not guessed between.
 */
export function slotsAfter(blocks: readonly DocBlock[], documentId: string, anchor: string): { slots: BlockSlot[]; block: DocBlock } | { matches: DocBlock[] } {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const named = anchor.trim();
  let block = named !== documentId ? byId.get(named) : undefined;
  if (!block) {
    const order: DocBlock[] = [];
    const visit = (id: string, depth: number) => {
      const next = byId.get(id);
      if (!next || depth > 64) return;
      if (id !== documentId) order.push(next);
      for (const child of next.children) visit(child, depth + 1);
    };
    visit(documentId, 0);
    let stream = '';
    const owner: number[] = [];
    order.forEach((each, i) => { const text = compact(each.text); stream += text; for (let k = 0; k < text.length; k++) owner.push(i); });
    const needle = compact(named);
    const ends = new Set<number>();
    for (let at = needle ? stream.indexOf(needle) : -1; at >= 0; at = stream.indexOf(needle, at + 1)) ends.add(owner[at + needle.length - 1]);
    const matches = [...ends].map((i) => order[i]);
    if (matches.length !== 1) return { matches };
    block = matches[0];
  }
  const slots: BlockSlot[] = [];
  for (let current = block, depth = 0; current.id !== documentId && depth < 64; depth++) {
    const parent = byId.get(current.parent);
    if (!parent) break;
    slots.push({ parent: parent.id, index: parent.children.indexOf(current.id) + 1 });
    current = parent;
  }
  return slots.length ? { slots, block } : { matches: [] };
}

/** The visible text of one block as the docx API returns it. */
export function blockText(raw: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of Object.values(raw)) {
    const elements = value && typeof value === 'object' ? (value as { elements?: unknown }).elements : undefined;
    if (!Array.isArray(elements)) continue;
    for (const element of elements as Record<string, Record<string, unknown> | undefined>[]) {
      const run = element.text_run ?? element.equation;
      if (typeof run?.content === 'string') parts.push(run.content);
      if (typeof element.mention_doc?.title === 'string') parts.push(element.mention_doc.title);
    }
  }
  return parts.join('');
}

/** Blocks sent in one nested-create call; a longer insert goes in several, in order. */
const MAX_DESCENDANTS = 400;
/** Feishu's ceiling for one `medias/upload_all` request (20 MB); larger media go up in parts. */
export const UPLOAD_ALL_MAX_BYTES = 20 * 1024 * 1024;
/** Characters sent in one Markdown conversion; longer Markdown is converted piece by piece. */
export const CONVERT_PIECE_CHARS = 50_000;

/**
 * Markdown cut into pieces for conversion, each at most `max` characters where
 * the text allows: cuts fall only on blank lines outside fenced code, so no
 * paragraph, list item, table or code block is split. A single block longer
 * than `max` stays one piece. Converted one after another, the pieces give
 * the same blocks the whole text would.
 */
export function markdownPieces(markdown: string, max = CONVERT_PIECE_CHARS): string[] {
  const pieces: string[] = [];
  let piece: string[] = [];
  let size = 0;
  let block: string[] = [];
  let fence = '';
  const close = () => {
    if (!block.length) return;
    const text = block.join('\n');
    block = [];
    if (piece.length && size + 2 + text.length > max) { pieces.push(piece.join('\n\n')); piece = []; size = 0; }
    size += (piece.length ? 2 : 0) + text.length;
    piece.push(text);
  };
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = ''; }
    else if (marker) fence = marker;
    if (!fence && !line.trim()) { close(); continue; }
    block.push(line);
  }
  close();
  if (piece.length) pieces.push(piece.join('\n\n'));
  return pieces;
}

/** Markdown converted to docx blocks: first-level temporary ids, every block, and how many images were left out. */
export interface ConvertedBlocks { children: string[]; blocks: Record<string, unknown>[]; droppedImages: number }

export class FeishuDocsClient {
  constructor(
    private readonly userToken: (username: string) => Promise<string | null>,
    private readonly fetcher: typeof fetch = fetch,
    /** The app's own tenant token: for calls that read no user data (Markdown conversion), and for `asApp()`. */
    private readonly appToken?: () => Promise<string>,
    /** Whose token `userToken` yields; it decides how a refusal is explained. */
    private readonly identity: FeishuDocsIdentity = 'user',
  ) {}

  /**
   * The same calls, made as the Octopus app (tenant token) on behalf of the
   * named owner. Only for a document the owner shared with the app.
   */
  asApp(): FeishuDocsClient {
    const appToken = this.appToken;
    if (!appToken) throw new DocsAddonError(503, '这个 Octopus 没有配置飞书应用凭据');
    return new FeishuDocsClient(() => appToken(), this.fetcher, appToken, 'app');
  }

  private async call(owner: string, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = await this.userToken(owner);
    if (!token) {
      throw new DocsAddonError(this.identity === 'app' ? 502 : 409,
        this.identity === 'app' ? '飞书应用凭据不可用' : '还没有可用的飞书授权：请先在 Octopus 里连接飞书账号（Dashboard → 飞书授权）');
    }
    return this.send(token, method, path, body);
  }

  /** One accepted call's `data`. */
  private async send(token: string, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown): Promise<Record<string, unknown>> {
    return ((await this.envelope(token, method, path, body)).data ?? {}) as Record<string, unknown>;
  }

  /** One call's whole answer, once Feishu accepted it (`code` 0); a few endpoints answer outside `data`. */
  private async envelope(token: string, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown, attempt = 0): Promise<Record<string, unknown>> {
    const form = body instanceof FormData;
    let response: Response;
    try {
      response = await this.fetcher(`${API}/${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(form ? 60_000 : 15_000),
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined || form ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
        ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
      });
    } catch { throw new DocsAddonError(502, '暂时连不上飞书，请稍后重试'); }
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    const code = typeof result?.code === 'number' ? result.code : -1;
    if (response.ok && code === 0) return result!;
    // Feishu allows a few edits per second per app and per document: wait and try again a few times.
    if ((response.status === 429 || code === 99991400) && attempt < 3 && !(body instanceof FormData)) {
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      return this.envelope(token, method, path, body, attempt + 1);
    }
    throw feishuRefusal(code, response.status, typeof result?.msg === 'string' ? result.msg : '', this.identity);
  }

  /** One docx document's title and current revision. Reading them needs read access to it. */
  async document(owner: string, documentId: string): Promise<DocTarget> {
    const data = await this.call(owner, 'GET', `docx/v1/documents/${encodeURIComponent(documentId)}`);
    const document = (data.document ?? {}) as Record<string, unknown>;
    return { documentId, title: typeof document.title === 'string' ? document.title : '',
      ...(Number.isSafeInteger(document.revision_id) ? { revision: document.revision_id as number } : {}) };
  }

  /**
   * One wiki node: what it holds (a docx document's id when `objType` is
   * 'docx'), and whether it is a shortcut to a node elsewhere. With `objType`,
   * `token` is a document's own token and the answer is the wiki node holding
   * that document (Feishu: `get_node` with `obj_type`).
   */
  async wikiNode(owner: string, token: string, objType?: 'docx'): Promise<{ nodeToken: string; nodeType: string; objType: string; objToken: string; title: string }> {
    const data = await this.call(owner, 'GET', `wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}${objType ? `&obj_type=${objType}` : ''}`);
    const node = (data.node ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => typeof value === 'string' ? value : '';
    return { nodeToken: text(node.node_token), nodeType: text(node.node_type), objType: text(node.obj_type), objToken: text(node.obj_token), title: text(node.title) };
  }

  /** Resolves a link or token to the docx document behind it (a wiki node must hold a docx). */
  async resolve(owner: string, ref: DocumentRef): Promise<DocTarget> {
    const wiki = async (token: string): Promise<DocTarget> => {
      const node = await this.wikiNode(owner, token);
      if (node.objType !== 'docx' || !node.objToken) throw new DocsAddonError(422, '这个知识库节点不是新版文档（docx），卡片只能放进新版文档');
      return { documentId: node.objToken, wikiToken: token, title: node.title, ...(ref.origin ? { url: `${ref.origin}/wiki/${token}` } : {}),
        ...(node.nodeType === 'shortcut' ? { wikiShortcut: true } : {}) };
    };
    const docx = async (token: string): Promise<DocTarget> => ({ ...await this.document(owner, token), ...(ref.origin ? { url: `${ref.origin}/docx/${token}` } : {}) });
    if (ref.kind === 'wiki') return wiki(ref.token);
    if (ref.kind === 'docx') return docx(ref.token);
    // A bare token is either; a docx id answers the docx read, a wiki token does not.
    try { return await docx(ref.token); } catch (error) {
      if (error instanceof DocsAddonError && error.status === 404) return wiki(ref.token);
      throw error;
    }
  }

  /**
   * Inserts one add-on block carrying `record` — the same Record the card
   * itself would write — at `slot` (the document body is the block whose id is
   * the document id).
   */
  async insertAddOn(owner: string, documentId: string, componentTypeId: string, record: unknown, slot: BlockSlot, clientToken: string): Promise<string> {
    const data = await this.call(owner, 'POST',
      `docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(slot.parent)}/children?document_revision_id=-1&client_token=${encodeURIComponent(clientToken)}`,
      { index: slot.index, children: [{ block_type: 40, add_ons: { component_type_id: componentTypeId, record: JSON.stringify(record) } }] });
    const created = Array.isArray(data.children) ? data.children[0] as Record<string, unknown> | undefined : undefined;
    if (typeof created?.block_id !== 'string') throw new DocsAddonError(502, '飞书没有返回新建的卡片块');
    return created.block_id;
  }

  /**
   * Every block of the document with its text, read as the owner: 500 blocks
   * per request (Feishu's page size), as many requests as the document needs.
   * A page token Feishu hands back twice would never end the walk; that is the
   * one way it stops early. `revision` reads the document as of that revision
   * (-1, the default, is the latest).
   */
  async blocks(owner: string, documentId: string, revision = -1): Promise<DocBlock[]> {
    const out: DocBlock[] = [];
    const seen = new Set<string>();
    let pageToken = '';
    for (;;) {
      const data = await this.call(owner, 'GET',
        `docx/v1/documents/${encodeURIComponent(documentId)}/blocks?page_size=500&document_revision_id=${revision}${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`);
      for (const raw of (Array.isArray(data.items) ? data.items : []) as Record<string, unknown>[]) {
        if (typeof raw.block_id !== 'string') continue;
        const addOns = raw.block_type === 40 && raw.add_ons && typeof raw.add_ons === 'object' ? raw.add_ons as Record<string, unknown> : undefined;
        out.push({ id: raw.block_id, parent: typeof raw.parent_id === 'string' ? raw.parent_id : '',
          children: Array.isArray(raw.children) ? raw.children.filter((child): child is string => typeof child === 'string') : [], text: blockText(raw),
          ...(typeof raw.block_type === 'number' ? { type: raw.block_type } : {}),
          ...(addOns && typeof addOns.component_type_id === 'string' && typeof addOns.record === 'string' ? { addOn: { component: addOns.component_type_id, record: addOns.record } } : {}) });
      }
      if (data.has_more !== true || typeof data.page_token !== 'string' || !data.page_token) return out;
      if (seen.has(data.page_token)) throw new DocsAddonError(502, '飞书的分页没有前进，读不完这篇文档的内容块，请稍后重试');
      seen.add(data.page_token);
      pageToken = data.page_token;
    }
  }

  /** One block as the docx API returns it, or null when the document has no such block. */
  async block(owner: string, documentId: string, blockId: string): Promise<Record<string, unknown> | null> {
    try {
      const data = await this.call(owner, 'GET', `docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}?document_revision_id=-1`);
      return (data.block ?? null) as Record<string, unknown> | null;
    } catch (error) {
      if (error instanceof DocsAddonError && error.status === 404) return null;
      throw error;
    }
  }

  /** Deletes one block (with its children) from wherever it sits. */
  async deleteBlock(owner: string, documentId: string, block: { id: string; parent: string }): Promise<void> {
    const parent = await this.block(owner, documentId, block.parent);
    const index = Array.isArray(parent?.children) ? (parent.children as unknown[]).indexOf(block.id) : -1;
    if (index < 0) throw new DocsAddonError(409, '文档刚刚变化，没找到这张卡片的位置，请重试');
    await this.deleteChild(owner, documentId, block.parent, index, -1);
  }

  /**
   * Deletes the child at `index` under `parent` (with its children), as of
   * `revision`: the document revision the index was read at (-1 = the latest).
   * Feishu accepts the pin here but does not enforce it: a stale revision
   * still deletes at `index` in the latest document (live Feishu, 2026-10-28).
   * Callers must serialize their own edits and check the result.
   */
  async deleteChild(owner: string, documentId: string, parent: string, index: number, revision: number): Promise<{ revision?: number }> {
    const data = await this.call(owner, 'DELETE',
      `docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parent)}/children/batch_delete?document_revision_id=${revision}&client_token=${randomBytes(16).toString('hex')}`,
      { start_index: index, end_index: index + 1 });
    return Number.isSafeInteger(data.document_revision_id) ? { revision: data.document_revision_id as number } : {};
  }

  /**
   * Whether this client's identity holds `action` on a document
   * (`drive/v1/permissions/:token/members/auth`): a docx by its id, a wiki
   * page by its node token. `share` is Feishu's own "may add collaborators".
   */
  async permitted(owner: string, doc: { token: string; type: 'docx' | 'wiki' }, action: 'view' | 'edit' | 'share'): Promise<boolean> {
    const data = await this.call(owner, 'GET', `drive/v1/permissions/${encodeURIComponent(doc.token)}/members/auth?type=${doc.type}&action=${action}`);
    return data.auth_result === true;
  }

  /** What this client's identity may do in a docx, asked by its id: `edit`, else `view`, else `none`. */
  async access(owner: string, documentId: string): Promise<'edit' | 'view' | 'none'> {
    const doc = { token: documentId, type: 'docx' } as const;
    if (await this.permitted(owner, doc, 'edit')) return 'edit';
    return await this.permitted(owner, doc, 'view') ? 'view' : 'none';
  }

  /**
   * The app's own name (`bot/v3/info`, as the app), as a document's
   * 「添加文档应用」 dialog lists it. Feishu answers it outside `data`; it
   * needs the app's bot capability and no scope.
   */
  async appName(): Promise<string> {
    if (!this.appToken) throw new DocsAddonError(503, '这个 Octopus 没有配置飞书应用凭据');
    const bot = (await this.envelope(await this.appToken(), 'GET', 'bot/v3/info')).bot as { app_name?: unknown } | undefined;
    if (typeof bot?.app_name !== 'string' || !bot.app_name.trim()) throw new DocsAddonError(502, '飞书没有给出应用的名字');
    return bot.app_name.trim();
  }

  /**
   * Replaces all the text of one text block (paragraph, heading, list item,
   * code, quote, to-do) in place: its id, kind and place stay, its inline
   * styles go. `revision` is the document revision the edit is based on
   * (Feishu's `document_revision_id`, -1 = the latest), as the catalog's
   * `doc_block_write` sends it; `clientToken` makes a resend idempotent.
   */
  async updateText(owner: string, documentId: string, blockId: string, text: string, options: { revision?: number; clientToken: string }): Promise<{ revision?: number }> {
    const data = await this.call(owner, 'PATCH',
      `docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}?document_revision_id=${options.revision ?? -1}&client_token=${encodeURIComponent(options.clientToken)}`,
      { update_text_elements: { elements: [{ text_run: { content: text } }] } });
    return Number.isSafeInteger(data.document_revision_id) ? { revision: data.document_revision_id as number } : {};
  }

  /**
   * Documents the owner can open whose title matches `query`: wiki nodes (they
   * carry a link) and new-style documents in Drive. Either search failing on
   * its own leaves the other's answers.
   */
  async search(owner: string, query: string): Promise<DocumentHit[]> {
    const hits: DocumentHit[] = [];
    const [wiki, drive] = await Promise.allSettled([
      this.call(owner, 'POST', 'wiki/v1/nodes/search', { query }),
      this.call(owner, 'POST', 'suite/docs-api/search/object', { search_key: query, count: 20, offset: 0, docs_types: ['docx'] }),
    ]);
    if (wiki.status === 'fulfilled' && Array.isArray(wiki.value.items)) {
      for (const raw of wiki.value.items as Record<string, unknown>[]) {
        if (typeof raw.node_id !== 'string' || !TOKEN.test(raw.node_id)) continue;
        const origin = typeof raw.url === 'string' ? safeOrigin(raw.url) : undefined;
        hits.push({ title: typeof raw.title === 'string' ? raw.title : '', ref: { kind: 'wiki', token: raw.node_id, ...(origin ? { origin } : {}) },
          ...(typeof raw.obj_token === 'string' ? { documentId: raw.obj_token } : {}), ...(typeof raw.url === 'string' ? { url: raw.url } : {}) });
      }
    }
    if (drive.status === 'fulfilled' && Array.isArray(drive.value.docs_entities)) {
      for (const raw of drive.value.docs_entities as Record<string, unknown>[]) {
        if (raw.docs_type !== 'docx' || typeof raw.docs_token !== 'string' || !TOKEN.test(raw.docs_token)) continue;
        if (hits.some((hit) => hit.documentId === raw.docs_token)) continue;
        hits.push({ title: typeof raw.title === 'string' ? raw.title : '', ref: { kind: 'docx', token: raw.docs_token }, documentId: raw.docs_token });
      }
    }
    if (!hits.length && wiki.status === 'rejected' && drive.status === 'rejected') throw wiki.reason;
    return hits;
  }

  /**
   * Markdown as docx blocks, through Feishu's own converter. The call reads no
   * user data, so it runs as the app. Tables lose their read-only merge info;
   * images are dropped (their bytes are not reachable from here) and counted.
   */
  async convert(markdown: string): Promise<ConvertedBlocks> {
    if (!this.appToken) throw new DocsAddonError(503, '这个 Octopus 没有配置飞书应用凭据，暂时不能转换 Markdown');
    const data = await this.send(await this.appToken(), 'POST', 'docx/v1/documents/blocks/convert', { content_type: 'markdown', content: markdown });
    const blocks = (Array.isArray(data.blocks) ? data.blocks : []).filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object');
    const images = new Set(blocks.filter((b) => b.block_type === 27).map((b) => String(b.block_id)));
    const keep = (id: unknown) => typeof id === 'string' && !images.has(id);
    const cleaned = blocks.filter((b) => keep(b.block_id)).map((b) => {
      const copy: Record<string, unknown> = { ...b };
      delete copy.parent_id;
      if (Array.isArray(copy.children)) copy.children = copy.children.filter(keep);
      const table = copy.table as { property?: Record<string, unknown> } | undefined;
      if (table?.property && 'merge_info' in table.property) {
        const { merge_info: _readOnly, ...property } = table.property;
        copy.table = { ...table, property };
      }
      return copy;
    });
    const children = (Array.isArray(data.first_level_block_ids) ? data.first_level_block_ids : []).filter(keep) as string[];
    return { children, blocks: cleaned, droppedImages: images.size };
  }

  /**
   * Inserts converted blocks under `slot`, in order, in batches the API
   * accepts. Returns the new ids of the first-level blocks.
   */
  async insertBlocks(owner: string, documentId: string, slot: BlockSlot, converted: ConvertedBlocks, clientToken: string): Promise<string[]> {
    const byId = new Map(converted.blocks.map((block) => [String(block.block_id), block]));
    const tree = (id: string): string[] => [id, ...((byId.get(id)?.children as string[] | undefined) ?? []).flatMap(tree)];
    const created: string[] = [];
    let batch: string[] = [];
    let size = 0;
    const flush = async (part: number) => {
      if (!batch.length) return;
      const index = slot.index < 0 ? -1 : slot.index + created.length;
      const data = await this.call(owner, 'POST',
        `docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(slot.parent)}/descendant?document_revision_id=-1&client_token=${encodeURIComponent(`${clientToken}${part ? `-${part}` : ''}`.slice(0, 64))}`,
        { children_id: batch, index, descendants: batch.flatMap(tree).map((id) => byId.get(id)).filter(Boolean) });
      const relations = new Map((Array.isArray(data.block_id_relations) ? data.block_id_relations : [])
        .map((r: Record<string, unknown>) => [String(r.temporary_block_id), String(r.block_id)]));
      created.push(...batch.map((id) => relations.get(id) ?? id));
      batch = []; size = 0;
    };
    let part = 0;
    for (const id of converted.children) {
      const count = tree(id).length;
      if (batch.length && size + count > MAX_DESCENDANTS) await flush(part++);
      batch.push(id); size += count;
    }
    await flush(part);
    return created;
  }

  /** An image block at `slot` holding `image`: create the empty block, upload into it, then point it at the upload. */
  async insertImage(owner: string, documentId: string, slot: BlockSlot, image: { name: string; data: Buffer }, clientToken: string): Promise<string> {
    const created = await this.call(owner, 'POST',
      `docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(slot.parent)}/children?document_revision_id=-1&client_token=${encodeURIComponent(clientToken)}`,
      { index: slot.index, children: [{ block_type: 27, image: {} }] });
    const block = Array.isArray(created.children) ? (created.children[0] as Record<string, unknown> | undefined)?.block_id : undefined;
    if (typeof block !== 'string') throw new DocsAddonError(502, '飞书没有返回新建的图片块');
    try {
      const token = await this.uploadMedia(owner, block, image);
      await this.call(owner, 'PATCH', `docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(block)}?document_revision_id=-1`,
        { replace_image: { token } });
      return block;
    } catch (error) {
      // An empty image block helps nobody: take it out again, best effort.
      await this.deleteBlock(owner, documentId, { id: block, parent: slot.parent }).catch(() => {});
      throw error;
    }
  }

  /**
   * Uploads an image into its (empty) image block and returns the media token.
   * Feishu takes one request of at most 20 MB (`upload_all`); anything larger
   * goes in the blocks `upload_prepare` asks for (4 MB each), one request per
   * block, then `upload_finish`.
   */
  private async uploadMedia(owner: string, block: string, image: { name: string; data: Buffer }): Promise<string> {
    const size = image.data.length;
    if (size <= UPLOAD_ALL_MAX_BYTES) {
      const form = new FormData();
      form.append('file_name', image.name);
      form.append('parent_type', 'docx_image');
      form.append('parent_node', block);
      form.append('size', String(size));
      form.append('file', new Blob([new Uint8Array(image.data)]), image.name);
      const uploaded = await this.call(owner, 'POST', 'drive/v1/medias/upload_all', form);
      if (typeof uploaded.file_token !== 'string') throw new DocsAddonError(502, '飞书没有返回上传后的图片');
      return uploaded.file_token;
    }
    const prepared = await this.call(owner, 'POST', 'drive/v1/medias/upload_prepare', { file_name: image.name, parent_type: 'docx_image', parent_node: block, size });
    const { upload_id: uploadId, block_size: blockSize, block_num: blocks } = prepared;
    if (typeof uploadId !== 'string' || !Number.isSafeInteger(blockSize) || (blockSize as number) <= 0
      || !Number.isSafeInteger(blocks) || blocks !== Math.ceil(size / (blockSize as number))) {
      throw new DocsAddonError(502, '飞书没有给出可用的分片上传计划');
    }
    for (let seq = 0; seq < blocks; seq++) {
      const part = image.data.subarray(seq * (blockSize as number), (seq + 1) * (blockSize as number));
      const form = new FormData();
      form.append('upload_id', uploadId);
      form.append('seq', String(seq));
      form.append('size', String(part.length));
      form.append('file', new Blob([new Uint8Array(part)]), image.name);
      await this.call(owner, 'POST', 'drive/v1/medias/upload_part', form);
    }
    const finished = await this.call(owner, 'POST', 'drive/v1/medias/upload_finish', { upload_id: uploadId, block_num: blocks });
    if (typeof finished.file_token !== 'string') throw new DocsAddonError(502, '飞书没有返回上传后的图片');
    return finished.file_token;
  }

  /** Plain text of the document, for a new agent's first instruction. */
  async text(owner: string, documentId: string): Promise<string> {
    const data = await this.call(owner, 'GET', `docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`);
    return typeof data.content === 'string' ? data.content : '';
  }
}

const excerpt = (value: string, max = 40) => { const text = value.replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };

/**
 * The one document a person or agent named: a link or token, else a title
 * looked up in the owner's own wiki and Drive. Several plausible titles are
 * answered with links to choose from, never a guess.
 */
export async function findDocument(docs: FeishuDocsClient, owner: string, named: string): Promise<DocTarget> {
  const value = named.trim();
  if (!value || value.length > 2000) throw new DocsAddonError(400, '请给出飞书新版文档的链接、token 或标题');
  let ref = parseDocumentRef(value);
  if (!ref) {
    const found = pickDocument(value, await docs.search(owner, value));
    if ('candidates' in found) {
      throw new DocsAddonError(found.candidates.length ? 409 : 404, found.candidates.length
        ? `有 ${found.candidates.length} 篇文档可能是「${value}」，请给出其中一篇的链接：${found.candidates.map((hit) => `《${hit.title}》${hit.url ? ` ${hit.url}` : ` ${hit.ref.token}`}`).join('；')}`
        : `没有找到标题是「${value}」的文档；请给出文档链接`);
    }
    ref = found.hit.ref;
  }
  return docs.resolve(owner, ref);
}

/** Where a new card goes in `target`: right after a passage (see `slotsAfter`), else at the start or end of the body. */
export async function cardSlots(docs: FeishuDocsClient, owner: string, target: DocTarget, at: { after?: string; position?: 'start' | 'end' }): Promise<{ slots: BlockSlot[]; anchor?: DocBlock; blocks?: DocBlock[] }> {
  const anchor = at.after?.trim();
  if (!anchor) return { slots: [{ parent: target.documentId, index: at.position === 'start' ? 0 : -1 }] };
  const blocks = await docs.blocks(owner, target.documentId);
  const found = slotsAfter(blocks, target.documentId, anchor);
  if (!('matches' in found)) return { slots: found.slots, anchor: found.block, blocks };
  const doc = `《${target.title || '这篇文档'}》`;
  if (!found.matches.length) throw new DocsAddonError(404, `在${doc}里没有找到「${excerpt(anchor)}」：请给出文档里原样出现的一段文字（标题或段落，空白可以不同），或一个块 ID`);
  throw new DocsAddonError(409, `「${excerpt(anchor)}」在${doc}里出现在 ${found.matches.length} 处，请给一段只出现一次的更长文字。出现在：${found.matches.slice(0, 5).map((block, i) => `${i + 1}）${excerpt(block.text) || block.id}`).join('；')}`);
}

/**
 * Inserts one card block at the first slot Feishu accepts. Only a refusal of
 * the position itself moves the card outward; access, auth and transport
 * failures stand. Each slot has its own idempotency token.
 */
export function insertCard(docs: FeishuDocsClient, owner: string, documentId: string, componentTypeId: string, record: unknown, slots: readonly BlockSlot[], seed: string): Promise<string> {
  return atFirstSlot(slots, seed, (slot, token) => docs.insertAddOn(owner, documentId, componentTypeId, record, slot, token));
}

/**
 * Runs `insert` at the first slot Feishu accepts. Only a refusal of the
 * position itself moves on to the next (enclosing) slot; access, auth and
 * transport failures stand. Each slot gets its own idempotency token.
 */
export async function atFirstSlot<T>(slots: readonly BlockSlot[], seed: string, insert: (slot: BlockSlot, clientToken: string) => Promise<T>): Promise<T> {
  for (const [i, slot] of slots.entries()) {
    try {
      return await insert(slot, createHash('sha256').update(`${seed}\u0000${slot.parent}`).digest('hex').slice(0, 32));
    } catch (error) {
      if (i === slots.length - 1 || !(error instanceof FeishuRefusal) || error.status !== 502) throw error;
    }
  }
  throw new DocsAddonError(400, '没有可以放内容的位置');
}

/** What one Markdown write put into a document. */
export interface WrittenMarkdown { created: string[]; replaced?: string; droppedImages: number }

/** A caller's own limits on one write. Each throws to refuse or to stop. */
export interface WriteGuard {
  /** Judges a block new content would go under, on the listing its slot came from (the body itself is not asked). */
  parent?(parent: string, blocks: readonly DocBlock[]): void;
  /** Runs before each piece is written and before a replaced block is deleted. */
  beforeEach?(): void;
}

/**
 * Writes Markdown into `target`: Feishu converts it to blocks, which go after
 * a passage or block, at the start or end, or in place of one block
 * (`replace`; the old block goes only after the new content landed). Long
 * Markdown converts piece by piece, every piece before anything is written,
 * then lands in order at the same spot. The caller's client decides whose
 * identity writes: the owner's, or the app's for a shared document.
 */
export async function writeMarkdown(docs: FeishuDocsClient, owner: string, target: DocTarget,
  input: { markdown: string; after?: string; position?: 'start' | 'end'; replace?: string }, guard: WriteGuard = {}): Promise<WrittenMarkdown> {
  const markdown = input.markdown.trim();
  if (!markdown) throw new DocsAddonError(400, '请给出要写入的 markdown');
  let slots: BlockSlot[];
  let replaced: { id: string; parent: string } | undefined;
  let listed: readonly DocBlock[] = [];
  if (input.replace) {
    const blocks = await docs.blocks(owner, target.documentId);
    listed = blocks;
    const block = blockNamed(blocks, target.documentId, input.replace, target.title);
    if (block.type === 40 || block.type === 25 || block.type === 32) throw new DocsAddonError(409, '这个块不能整块替换：卡片请用 feishu_doc_remove，表格单元格或分栏请替换它们里面的段落');
    const parent = blocks.find((each) => each.id === block.parent);
    if (!parent) throw new DocsAddonError(409, '文档刚刚变化，没找到这个块的位置，请重试');
    slots = [{ parent: parent.id, index: parent.children.indexOf(block.id) }];
    replaced = { id: block.id, parent: parent.id };
  } else {
    const found = await cardSlots(docs, owner, target, input);
    slots = found.slots;
    listed = found.blocks ?? [];
  }
  if (guard.parent) for (const slot of slots) if (slot.parent !== target.documentId) guard.parent(slot.parent, listed);
  const converted: ConvertedBlocks[] = [];
  for (const piece of markdownPieces(markdown)) converted.push(await docs.convert(piece));
  const parts = converted.filter((part) => part.children.length);
  const droppedImages = converted.reduce((sum, part) => sum + part.droppedImages, 0);
  if (!parts.length) throw new DocsAddonError(400, 'Markdown 转换后没有可以写入的内容');
  const seed = randomBytes(16).toString('hex');
  let at: BlockSlot = slots[0];
  guard.beforeEach?.();
  const created = await atFirstSlot(slots, seed, (slot, token) => { at = slot; return docs.insertBlocks(owner, target.documentId, slot, parts[0], token); });
  for (const [k, part] of parts.slice(1).entries()) {
    // Each later piece goes right after what the earlier ones created, under the same parent.
    const next = { parent: at.parent, index: at.index < 0 ? -1 : at.index + created.length };
    try {
      guard.beforeEach?.();
      created.push(...await docs.insertBlocks(owner, target.documentId, next, part, createHash('sha256').update(`${seed}\u0000${at.parent}\u0000${k + 1}`).digest('hex').slice(0, 32)));
    } catch (error) {
      // The earlier pieces are in the document already: say so, and where they are.
      const reason = error instanceof Error ? error.message : '写入没有完成';
      throw new DocsAddonError(error instanceof DocsAddonError ? error.status : 502,
        `${reason}（已写入前 ${k + 1}/${parts.length} 段、${created.length} 个内容块，后面的没有写入${replaced ? '，被替换的块仍在' : ''}；新写入的块从 ${created[0]} 到 ${created.at(-1)}）`);
    }
  }
  if (replaced) {
    guard.beforeEach?.();
    await docs.deleteBlock(owner, target.documentId, replaced);
  }
  return { created, ...(replaced ? { replaced: replaced.id } : {}), droppedImages };
}

/** Block ids as an agent lists them: separated by commas or whitespace, each once. */
export const blockIdsOf = (text: string): string[] => [...new Set(text.split(/[\s,，]+/).map((id) => id.trim()).filter(Boolean))];

/** Block kinds by docx block_type, as an agent reads an outline. */
const KINDS: Record<number, string> = {
  2: 'text', 3: 'h1', 4: 'h2', 5: 'h3', 6: 'h4', 7: 'h5', 8: 'h6', 9: 'h7', 10: 'h8', 11: 'h9', 12: 'bullet', 13: 'ordered', 14: 'code',
  15: 'quote', 17: 'todo', 18: 'bitable', 19: 'callout', 20: 'chat_card', 21: 'diagram', 22: 'divider', 23: 'file', 24: 'grid', 25: 'grid_column',
  26: 'iframe', 27: 'image', 28: 'widget', 29: 'mindnote', 30: 'sheet', 31: 'table', 32: 'table_cell', 33: 'view', 34: 'quote_container',
  35: 'task', 40: 'add_on',
};

/** A docx block_type as an agent reads it. */
export const blockKind = (type: number | undefined): string => KINDS[type ?? 0] ?? `block_${type ?? '?'}`;

/** Every block under the document body in reading order, with its nesting depth (top level = 0). */
export function readingOrder(blocks: readonly DocBlock[], documentId: string): Array<{ block: DocBlock; depth: number }> {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const out: Array<{ block: DocBlock; depth: number }> = [];
  const visit = (id: string, depth: number) => {
    const block = byId.get(id);
    if (!block || depth > 64) return;
    if (id !== documentId) out.push({ block, depth });
    for (const child of block.children) visit(child, id === documentId ? 0 : depth + 1);
  };
  visit(documentId, 0);
  return out;
}

/** The document body in reading order: what an agent needs to choose where to write. */
export function outlineOf(blocks: readonly DocBlock[], documentId: string): Array<{ id: string; kind: string; depth: number; text: string }> {
  return readingOrder(blocks, documentId).map(({ block, depth }) => ({ id: block.id, kind: blockKind(block.type), depth, text: excerpt(block.text, 300) }));
}

/** One page of the outline: `limit` blocks (default 200, at most 500) from `from`, and where the next page starts. */
export function outlinePage(blocks: readonly DocBlock[], documentId: string, at: { from?: number; limit?: number }):
  { total: number; from: number; blocks: ReturnType<typeof outlineOf>; next?: number } {
  const outline = outlineOf(blocks, documentId);
  const from = Math.max(0, Math.floor(at.from ?? 0));
  const limit = Math.min(500, Math.max(1, Math.floor(at.limit ?? 200)));
  return { total: outline.length, from, blocks: outline.slice(from, from + limit), ...(from + limit < outline.length ? { next: from + limit } : {}) };
}

/** The one block a block id or a passage names (the block where the passage ends), else why not. */
export function blockNamed(blocks: readonly DocBlock[], documentId: string, named: string, docTitle: string): DocBlock {
  const found = slotsAfter(blocks, documentId, named);
  if (!('matches' in found)) return found.block;
  const doc = `《${docTitle || '这篇文档'}》`;
  if (!found.matches.length) throw new DocsAddonError(404, `在${doc}里没有找到「${excerpt(named)}」：请给出块 ID（feishu_doc_outline）或文档里原样出现的一段文字`);
  throw new DocsAddonError(409, `「${excerpt(named)}」在${doc}里出现在 ${found.matches.length} 处，请给块 ID 或更长的一段文字。出现在：${found.matches.slice(0, 5).map((block, i) => `${i + 1}）${block.id} ${excerpt(block.text)}`).join('；')}`);
}

/** The app's tenant token, cached until shortly before it expires. */
export function tenantTokenSource(appId: string, appSecret: string, fetcher: typeof fetch = fetch): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    const response = await fetcher(`${API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => { throw new DocsAddonError(502, '暂时连不上飞书，请稍后重试'); });
    const data = await response.json().catch(() => null) as { code?: number; tenant_access_token?: string; expire?: number } | null;
    if (data?.code !== 0 || typeof data.tenant_access_token !== 'string') throw new DocsAddonError(502, '飞书应用凭据不可用');
    cached = { token: data.tenant_access_token, until: Date.now() + Math.max(60, (data.expire ?? 7200) - 300) * 1000 };
    return cached.token;
  };
}

/** The card a block carries when it is one of ours: its Record, parsed. */
export function cardRecord(block: Record<string, unknown> | null, componentTypeId: string): { record: Record<string, unknown>; parent: string } | null {
  const addOns = block?.block_type === 40 ? block.add_ons as Record<string, unknown> | undefined : undefined;
  if (!addOns || addOns.component_type_id !== componentTypeId || typeof block?.parent_id !== 'string') return null;
  try {
    const record = JSON.parse(String(addOns.record ?? '{}')) as unknown;
    return record && typeof record === 'object' ? { record: record as Record<string, unknown>, parent: block.parent_id } : null;
  } catch { return null; }
}

/** What the owner must do before the app can work on a document they share. */
const APP_NO_ACCESS = 'Octopus 飞书应用还不能访问这篇文档：请文档所有者在文档右上角「…」→「添加文档应用」里添加 Octopus 应用，并给它编辑权限';

/** Feishu's refusal codes, in the words of whoever must fix them: the owner, or for the app's own calls, the owner and the app's administrator. */
function feishuRefusal(code: number, status: number, message: string, identity: FeishuDocsIdentity = 'user'): FeishuRefusal {
  const auth = code === 99991663 || code === 99991668 || code === 99991677 || status === 401;
  const scope = code === 99991672 || code === 99991679;
  const denied = code === 1770032 || code === 131006 || code === 1770003 || status === 403;
  const missing = code === 1770002 || code === 131005 || code === 1770001 && /not.?found/i.test(message) || status === 404;
  if (identity === 'app') {
    if (auth) return new FeishuRefusal(502, 'Octopus 飞书应用的身份凭据暂时不可用，请稍后重试', code);
    if (scope) return new FeishuRefusal(503, 'Octopus 飞书应用还没有开通应用身份的云文档权限（docx:document 等）：请管理员在飞书开发者后台开通并发布新版本', code);
    if (denied) return new FeishuRefusal(403, APP_NO_ACCESS, code);
    if (missing) return new FeishuRefusal(404, `找不到这篇文档，或者${APP_NO_ACCESS}`, code);
  } else {
    if (auth) return new FeishuRefusal(409, '飞书授权已失效：请在 Octopus 里重新连接飞书账号', code);
    if (scope) return new FeishuRefusal(409, '飞书授权缺少文档权限：请在 Octopus 里重新连接飞书账号', code);
    if (denied) return new FeishuRefusal(403, '你没有这篇文档的编辑权限', code);
    if (missing) return new FeishuRefusal(404, '找不到这篇文档，请检查链接', code);
  }
  return new FeishuRefusal(502, `飞书拒绝了这次操作（${code}${message ? `：${message.slice(0, 120)}` : ''}）`, code);
}
