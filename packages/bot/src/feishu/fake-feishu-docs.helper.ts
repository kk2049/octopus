/**
 * Test-only Feishu docx OpenAPI, in memory: the calls `FeishuDocsClient`
 * makes, per-document access for each user and for the app, and a record of
 * every request with the identity it carried. Not imported by any production
 * module.
 */

export const APP_TOKEN = 't-app';
export const userToken = (owner: string) => `u-${owner}`;

/** A block as a test or a request describes it, before it has an id and a place. */
export interface NewBlock {
  block_type: number;
  children?: string[];
  [field: string]: unknown;
}
export interface FakeBlock extends NewBlock {
  block_id: string;
  parent_id: string;
}

interface FakeDoc { title: string; revision: number; blocks: Map<string, FakeBlock> }
export interface FakeRequest { method: string; path: string; query: URLSearchParams; as: string; body?: unknown }
type Access = 'read' | 'edit';

const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
const refused = (code: number, status: number, msg = 'refused') => new Response(JSON.stringify({ code, msg }), { status });
const text = (content: string) => ({ elements: [{ text_run: { content } }] });

export class FakeFeishuDocs {
  readonly docs = new Map<string, FakeDoc>();
  /** Who may read or edit each document: an identity is `app` or a username. */
  readonly access = new Map<string, Map<string, Access>>();
  /** Wiki nodes by node token. A document has one origin node; shortcuts point at it from elsewhere. */
  readonly wiki = new Map<string, { obj_type: string; obj_token: string; title: string; node_type?: 'origin' | 'shortcut' }>();
  /** Raw `get_node` answers by docx id, exactly as given: to play a Feishu reply that leaves fields out. */
  readonly wikiAnswers = new Map<string, Record<string, unknown>>();
  /** `${documentId}:${who}` pairs that may edit but not share (Feishu's "who may add collaborators"). */
  readonly noShare = new Set<string>();
  readonly requests: FakeRequest[] = [];
  /** Answers a request instead of the document model when it returns something: a Response, or 'network' to throw. May wait first. */
  intercept: ((request: FakeRequest) => Response | 'network' | undefined | Promise<Response | 'network' | undefined>) | null = null;
  /** Blocks per page of a block listing. */
  pageSize = 500;
  /** The app's own name, as `bot/v3/info` answers it (outside `data`, as Feishu does). */
  appName = 'Octopus 助手';
  private next = 1;

  /** A document whose body holds `paragraphs` as text blocks. */
  addDoc(id: string, title: string, paragraphs: string[] = []): void {
    const blocks = new Map<string, FakeBlock>();
    blocks.set(id, { block_id: id, parent_id: '', block_type: 1, children: [], page: text(title) });
    this.docs.set(id, { title, revision: 1, blocks });
    for (const paragraph of paragraphs) this.append(id, { block_type: 2, text: text(paragraph) });
  }

  grant(documentId: string, who: string, access: Access): void {
    if (!this.access.has(documentId)) this.access.set(documentId, new Map());
    this.access.get(documentId)!.set(who, access);
  }

  revoke(documentId: string, who: string): void {
    this.access.get(documentId)?.delete(who);
  }

  /** Adds a block under `parent` (the body by default), at `index` (the end by default), as a person would; returns its id. */
  append(documentId: string, block: NewBlock, parent = documentId, index = -1): string {
    const doc = this.docs.get(documentId)!;
    const id = `blk${String(this.next++).padStart(4, '0')}`;
    doc.blocks.set(id, { ...block, block_id: id, parent_id: parent });
    this.place(doc, parent, id, index);
    doc.revision++;
    return id;
  }

  /** Moves a block (with what it holds) under `parent` at `index`, as a person dragging it would. */
  move(documentId: string, blockId: string, parent: string, index: number): void {
    const doc = this.docs.get(documentId)!;
    const block = doc.blocks.get(blockId)!;
    const from = doc.blocks.get(block.parent_id)!;
    from.children = (from.children ?? []).filter((child) => child !== blockId);
    block.parent_id = parent;
    this.place(doc, parent, blockId, index);
    doc.revision++;
  }

  /** Removes a block and everything under it, as a person deleting it in Feishu would. */
  delete(documentId: string, blockId: string): void {
    const doc = this.docs.get(documentId)!;
    const block = doc.blocks.get(blockId)!;
    const parent = doc.blocks.get(block.parent_id)!;
    parent.children = (parent.children ?? []).filter((child) => child !== blockId);
    const drop = (id: string) => { for (const child of doc.blocks.get(id)?.children ?? []) drop(child); doc.blocks.delete(id); };
    drop(blockId);
    doc.revision++;
  }

  private place(doc: FakeDoc, parent: string, id: string, index: number): void {
    const list = doc.blocks.get(parent)!.children ?? [];
    doc.blocks.get(parent)!.children = index < 0 ? [...list, id] : [...list.slice(0, index), id, ...list.slice(index)];
  }

  blocksOf(documentId: string): FakeBlock[] {
    return [...this.docs.get(documentId)!.blocks.values()];
  }

  /** Every add-on block's Record in the document, parsed. */
  records(documentId: string): Array<{ id: string; component: string; record: unknown }> {
    return this.blocksOf(documentId).filter((block) => block.block_type === 40).map((block) => {
      const addOns = block.add_ons as { component_type_id: string; record: string };
      return { id: block.block_id, component: addOns.component_type_id, record: JSON.parse(addOns.record) as unknown };
    });
  }

  /** The documents any request named in its path. */
  documentsTouched(): Set<string> {
    return new Set(this.requests.map((request) => /^docx\/v1\/documents\/([^/]+)/.exec(request.path)?.[1]).filter((id): id is string => Boolean(id) && id !== 'blocks'));
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/open-apis\//, '');
    const header = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    const token = header.replace(/^Bearer /, '');
    const as = token === APP_TOKEN ? 'app' : token.startsWith('u-') ? token.slice(2) : '?';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const request: FakeRequest = { method: init?.method ?? 'GET', path, query: url.searchParams, as, ...(body === undefined ? {} : { body }) };
    this.requests.push(request);
    const intercepted = await this.intercept?.(request);
    if (intercepted === 'network') throw new TypeError('fetch failed');
    if (intercepted) return intercepted;
    return this.answer(request);
  }) as typeof fetch;

  private may(documentId: string, who: string, need: Access): boolean {
    const access = this.access.get(documentId)?.get(who);
    return access === 'edit' || access === need;
  }

  private answer(request: FakeRequest): Response {
    const { method, path, query, as } = request;
    if (method === 'GET' && path === 'bot/v3/info') {
      return as === 'app' ? new Response(JSON.stringify({ code: 0, msg: 'ok', bot: { activate_status: 2, app_name: this.appName, open_id: 'ou_app' } }), { status: 200 })
        : refused(99991663, 401, 'invalid token');
    }
    const permission = /^drive\/v1\/permissions\/([^/]+)\/members\/auth$/.exec(path);
    if (method === 'GET' && permission) {
      const documentId = query.get('type') === 'wiki' ? this.wiki.get(permission[1])?.obj_token : permission[1];
      if (!documentId || !this.docs.has(documentId)) return refused(1063005, 404, 'resource not found');
      const action = query.get('action');
      const allowed = action === 'view' ? this.may(documentId, as, 'read')
        : action === 'edit' ? this.may(documentId, as, 'edit')
        : action === 'share' ? this.may(documentId, as, 'edit') && !this.noShare.has(`${documentId}:${as}`) : false;
      return ok({ auth_result: allowed });
    }
    if (method === 'GET' && path === 'wiki/v2/spaces/get_node') {
      const token = query.get('token') ?? '';
      if (query.get('obj_type') && this.wikiAnswers.has(token)) return ok({ node: this.wikiAnswers.get(token) });
      // With obj_type, the token is a document's own: the answer is the origin node holding it.
      const found = query.get('obj_type')
        ? [...this.wiki.entries()].find(([, node]) => node.obj_token === token && node.node_type !== 'shortcut')
        : this.wiki.has(token) ? [token, this.wiki.get(token)!] as const : undefined;
      return found ? ok({ node: { ...found[1], node_token: found[0], node_type: found[1].node_type ?? 'origin' } }) : refused(131005, 404, 'not found');
    }
    if (method === 'POST' && path === 'docx/v1/documents/blocks/convert') {
      const content = String((request.body as { content?: unknown }).content ?? '');
      const blocks = content.split('\n').filter((line) => line.trim()).map((line, i) => {
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        return heading ? { block_id: `tmp${i}`, block_type: 2 + heading[1].length, [`heading${heading[1].length}`]: text(heading[2]) }
          : { block_id: `tmp${i}`, block_type: 2, text: text(line) };
      });
      return ok({ first_level_block_ids: blocks.map((block) => block.block_id), blocks });
    }
    const match = /^docx\/v1\/documents\/([^/]+)(?:\/blocks(?:\/([^/]+)(\/children(?:\/batch_delete)?|\/descendant)?)?)?$/.exec(path);
    const doc = match ? this.docs.get(match[1]) : undefined;
    if (!match || !doc) return refused(1770002, 404, 'not found');
    const [, documentId, blockId, tail] = match;
    const reading = method === 'GET';
    if (!this.may(documentId, as, reading ? 'read' : 'edit')) return refused(1770032, 403, 'forbidden');
    if (reading && path === `docx/v1/documents/${documentId}`) {
      return ok({ document: { document_id: documentId, revision_id: doc.revision, title: doc.title } });
    }
    if (reading && !blockId) {
      const all = [...doc.blocks.values()];
      const from = Number(query.get('page_token') ?? 0);
      const items = all.slice(from, from + this.pageSize);
      return ok({ items, ...(from + this.pageSize < all.length ? { has_more: true, page_token: String(from + this.pageSize) } : { has_more: false }) });
    }
    const block = blockId ? doc.blocks.get(blockId) : undefined;
    if (!block) return refused(1770002, 404, 'block not found');
    if (reading && !tail) return ok({ block });
    // As live Feishu answers (probed 2026-10-28): a block edit pinned to a revision the
    // document has moved past is refused as 1770002 "not found"; batch_delete ignores
    // the pin and deletes at the index in the latest document.
    const pinned = Number(query.get('document_revision_id') ?? -1);
    if (method === 'PATCH' && pinned !== -1 && pinned !== doc.revision) return refused(1770002, 404, 'not found');
    if (method === 'PATCH' && !tail) {
      const elements = (request.body as { update_text_elements?: { elements?: unknown } }).update_text_elements?.elements;
      const field = Object.keys(block).find((key) => block[key] && typeof block[key] === 'object' && Array.isArray((block[key] as { elements?: unknown }).elements));
      if (!field || !Array.isArray(elements)) return refused(1770001, 400, 'invalid param');
      block[field] = { elements };
      return ok({ document_revision_id: ++doc.revision, block });
    }
    if (method === 'POST' && tail === '/children') {
      const { index, children } = request.body as { index: number; children: NewBlock[] };
      const created = children.map((child) => { const id = `blk${String(this.next++).padStart(4, '0')}`; doc.blocks.set(id, { ...child, block_id: id, parent_id: blockId }); return id; });
      const list = block.children ?? [];
      block.children = index < 0 ? [...list, ...created] : [...list.slice(0, index), ...created, ...list.slice(index)];
      doc.revision++;
      return ok({ children: created.map((id) => doc.blocks.get(id)) });
    }
    if (method === 'POST' && tail === '/descendant') {
      const { children_id: top, index, descendants } = request.body as { children_id: string[]; index: number; descendants: Array<Record<string, unknown>> };
      const ids = new Map(descendants.map((each) => [String(each.block_id), `blk${String(this.next++).padStart(4, '0')}`]));
      const parentOf = new Map<string, string>();
      for (const each of descendants) for (const child of (each.children as string[] | undefined) ?? []) parentOf.set(child, String(each.block_id));
      for (const each of descendants) {
        const temp = String(each.block_id);
        const parent = parentOf.get(temp);
        doc.blocks.set(ids.get(temp)!, { ...each, block_id: ids.get(temp)!, parent_id: parent ? ids.get(parent)! : blockId, block_type: Number(each.block_type),
          children: ((each.children as string[] | undefined) ?? []).map((child) => ids.get(child)!) });
      }
      const list = block.children ?? [];
      const placed = top.map((temp) => ids.get(temp)!);
      block.children = index < 0 ? [...list, ...placed] : [...list.slice(0, index), ...placed, ...list.slice(index)];
      doc.revision++;
      return ok({ block_id_relations: [...ids.entries()].map(([temporary_block_id, real]) => ({ temporary_block_id, block_id: real })) });
    }
    if (method === 'DELETE' && tail === '/children/batch_delete') {
      const { start_index: start, end_index: end } = request.body as { start_index: number; end_index: number };
      for (const child of (block.children ?? []).slice(start, end)) this.delete(documentId, child);
      doc.revision++;
      return ok({ document_revision_id: doc.revision });
    }
    return refused(1770001, 400, 'unsupported');
  }
}
