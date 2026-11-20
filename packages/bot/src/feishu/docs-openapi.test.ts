import { describe, expect, it, vi } from 'vitest';
import { cardRecord, FeishuDocsClient, markdownPieces, outlineOf, parseDocumentRef, pickDocument, slotsAfter, tenantTokenSource, UPLOAD_ALL_MAX_BYTES, type DocBlock } from './docs-openapi.js';
import { docsNoticeCard, DocsNotifier } from './docs-notify.js';

const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
const refused = (code: number, status = 400) => new Response(JSON.stringify({ code, msg: 'refused' }), { status });

describe('parseDocumentRef', () => {
  it('reads docx and wiki links and bare tokens; refuses everything else', () => {
    expect(parseDocumentRef('https://example.feishu.cn/wiki/ExampleWikiToken0123456789a?from=x')).toEqual({ kind: 'wiki', token: 'ExampleWikiToken0123456789a', origin: 'https://example.feishu.cn' });
    expect(parseDocumentRef(' https://a.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWxYz1 ')).toMatchObject({ kind: 'docx', token: 'AbCdEfGhIjKlMnOpQrStUvWxYz1' });
    expect(parseDocumentRef('AbCdEfGhIjKlMnOpQrStUvWxYz1')).toEqual({ kind: 'token', token: 'AbCdEfGhIjKlMnOpQrStUvWxYz1' });
    for (const bad of ['http://a.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWxYz1', 'https://evil.example/docx/AbCdEfGhIjKlMnOpQrStUvWxYz1', 'https://a.feishu.cn/sheets/AbCdEfGhIjKlMnOpQrStUvWxYz1', '组会周报', '']) {
      expect(parseDocumentRef(bad), bad).toBeNull();
    }
  });
});

describe('FeishuDocsClient', () => {
  it('resolves a wiki node to its docx and inserts the card block as the owner', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer u-token');
      if (u.includes('wiki/v2/spaces/get_node')) return ok({ node: { obj_type: 'docx', obj_token: 'DocxToken1234567890abcdefg', title: '组会周报' } });
      if (u.includes('/children')) return ok({ children: [{ block_id: 'blk-new' }] });
      throw new Error(u);
    });
    const client = new FeishuDocsClient(async (owner) => owner === 'lht' ? 'u-token' : null, fetcher as unknown as typeof fetch);
    const target = await client.resolve('lht', parseDocumentRef('https://t.feishu.cn/wiki/WikiToken1234567890abcdefgh')!);
    expect(target).toEqual({ documentId: 'DocxToken1234567890abcdefg', wikiToken: 'WikiToken1234567890abcdefgh', title: '组会周报', url: 'https://t.feishu.cn/wiki/WikiToken1234567890abcdefgh' });
    const block = await client.insertAddOn('lht', target.documentId, 'blk_type', { octopusAgent: { v: 2 } }, { parent: target.documentId, index: -1 }, 'ct-1');
    expect(block).toBe('blk-new');
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toContain('/docx/v1/documents/DocxToken1234567890abcdefg/blocks/DocxToken1234567890abcdefg/children?document_revision_id=-1&client_token=ct-1');
    expect(JSON.parse(String(init!.body))).toEqual({ index: -1, children: [{ block_type: 40, add_ons: { component_type_id: 'blk_type', record: '{"octopusAgent":{"v":2}}' } }] });
  });

  it('tries a bare token as docx first, then as a wiki node', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('docx/v1/documents/') ? refused(1770002, 404) : ok({ node: { obj_type: 'docx', obj_token: 'D'.repeat(27), title: 'T' } }));
    const client = new FeishuDocsClient(async () => 'u', fetcher as unknown as typeof fetch);
    expect((await client.resolve('lht', { kind: 'token', token: 'W'.repeat(27) })).documentId).toBe('D'.repeat(27));
  });

  it('says what the owner must fix, in their words', async () => {
    const run = async (response: Response | null) => {
      const client = new FeishuDocsClient(async () => response ? 'u' : null, (async () => response!) as unknown as typeof fetch);
      return client.resolve('lht', { kind: 'docx', token: 'D'.repeat(27) }).catch((e: { status: number; message: string }) => e);
    };
    expect(await run(null)).toMatchObject({ status: 409, message: expect.stringContaining('连接飞书账号') });
    expect(await run(refused(99991679))).toMatchObject({ status: 409, message: expect.stringContaining('缺少文档权限') });
    expect(await run(refused(1770032, 403))).toMatchObject({ status: 403, message: '你没有这篇文档的编辑权限' });
    expect(await run(refused(1770002, 404))).toMatchObject({ status: 404 });
  });

  it('refuses a wiki node that is not a new-style document', async () => {
    const client = new FeishuDocsClient(async () => 'u', (async () => ok({ node: { obj_type: 'sheet', obj_token: 'S'.repeat(27) } })) as unknown as typeof fetch);
    await expect(client.resolve('lht', { kind: 'wiki', token: 'W'.repeat(27) })).rejects.toMatchObject({ status: 422 });
  });

  it('reads every block with its visible text, page by page, and inserts under any parent', async () => {
    const run = (content: string) => ({ text_run: { content } });
    const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/children')) return ok({ children: [{ block_id: 'blk-new' }] });
      return u.includes('page_token=p2')
        ? ok({ has_more: false, items: [{ block_id: 'b2', parent_id: 'D', block_type: 4, heading2: { elements: [run('A0｜'), { equation: { content: 'x+y' } }] } }] })
        : ok({ has_more: true, page_token: 'p2', items: [
          { block_id: 'D', block_type: 1, children: ['b1', 'b2'], page: { elements: [run('标题')] } },
          { block_id: 'b1', parent_id: 'D', block_type: 2, text: { elements: [run('见 '), { mention_doc: { title: '周报' } }] } },
        ] });
    });
    const client = new FeishuDocsClient(async () => 'u', fetcher as unknown as typeof fetch);
    expect(await client.blocks('lht', 'D')).toEqual([
      { id: 'D', parent: '', children: ['b1', 'b2'], text: '标题', type: 1 },
      { id: 'b1', parent: 'D', children: [], text: '见 周报', type: 2 },
      { id: 'b2', parent: 'D', children: [], text: 'A0｜x+y', type: 4 },
    ]);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/docx/v1/documents/D/blocks?page_size=500&document_revision_id=-1');
    expect(String(fetcher.mock.calls[1]![0])).toContain('page_token=p2');
    await client.insertAddOn('lht', 'D', 'blk_type', {}, { parent: 'b1', index: 2 }, 'ct');
    expect(String(fetcher.mock.calls[2]![0])).toContain('/docx/v1/documents/D/blocks/b1/children?');
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]!.body)).index).toBe(2);
  });

  it('pages through a document of any length, 500 blocks per request, and anchors past the old 10 000-block stop', async () => {
    const pages = 30;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const page = Number(/page_token=p(\d+)/.exec(String(url))?.[1] ?? 0);
      const items = Array.from({ length: 500 }, (_, k) => {
        const n = page * 500 + k;
        return n === 0
          ? { block_id: 'D', block_type: 1, children: Array.from({ length: pages * 500 - 1 }, (_, c) => `b${c + 1}`) }
          : { block_id: `b${n}`, parent_id: 'D', block_type: 2, text: { elements: [{ text_run: { content: `段落 ${n}。` } }] } };
      });
      return ok({ items, ...(page + 1 < pages ? { has_more: true, page_token: `p${page + 1}` } : { has_more: false }) });
    });
    const client = new FeishuDocsClient(async () => 'u', fetcher as unknown as typeof fetch);
    const blocks = await client.blocks('lht', 'D');
    expect(blocks).toHaveLength(15_000);
    expect(fetcher).toHaveBeenCalledTimes(pages);
    const found = slotsAfter(blocks, 'D', '段落 14321。');
    expect('slots' in found && found.block.id).toBe('b14321');
  });

  it('stops with an error, not a loop, when Feishu repeats a page token', async () => {
    const fetcher = vi.fn(async () => ok({ has_more: true, page_token: 'same', items: [{ block_id: 'D', block_type: 1, children: [] }] }));
    const client = new FeishuDocsClient(async () => 'u', fetcher as unknown as typeof fetch);
    await expect(client.blocks('lht', 'D')).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('markdownPieces', () => {
  it('cuts only at blank lines outside fenced code, and keeps an oversized block whole', () => {
    const code = '```ts\nconst a = 1;\n\nconst b = 2;\n```';
    const text = ['# 标题', 'a'.repeat(30), code, '| x | y |\n|---|---|\n| 1 | 2 |', 'b'.repeat(80)].join('\n\n');
    const pieces = markdownPieces(text, 40);
    expect(pieces).toEqual(['# 标题\n\n' + 'a'.repeat(30), code, '| x | y |\n|---|---|\n| 1 | 2 |', 'b'.repeat(80)]);
    expect(markdownPieces('one\n\n\n\ntwo', 100)).toEqual(['one\n\ntwo']);
    expect(markdownPieces('~~~\nopen fence\n\nnever closed', 5)).toEqual(['~~~\nopen fence\n\nnever closed']);
  });
});

describe('removing a card block', () => {
  it('deletes exactly the block, at its index under its parent', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return String(url).includes('/blocks/p9?') ? ok({ block: { block_id: 'p9', children: ['a0', 'card', 'a1'] } }) : ok({});
    });
    const client = new FeishuDocsClient(async () => 'u', fetcher as unknown as typeof fetch);
    await client.deleteBlock('lht', 'D', { id: 'card', parent: 'p9' });
    expect(calls[1]).toEqual({ url: expect.stringContaining('/docx/v1/documents/D/blocks/p9/children/batch_delete?document_revision_id=-1'), method: 'DELETE', body: { start_index: 1, end_index: 2 } });
    await expect(client.deleteBlock('lht', 'D', { id: 'gone', parent: 'p9' })).rejects.toMatchObject({ status: 409 });
  });

  it('recognises only its own widget\'s blocks', () => {
    const block = (type: string, record: string) => ({ block_type: 40, parent_id: 'D', add_ons: { component_type_id: type, record } });
    expect(cardRecord(block('blk_ours', '{"octopusBoard":{"v":1}}'), 'blk_ours')).toEqual({ record: { octopusBoard: { v: 1 } }, parent: 'D' });
    expect(cardRecord(block('blk_other', '{}'), 'blk_ours')).toBeNull();
    expect(cardRecord(block('blk_ours', 'not json'), 'blk_ours')).toBeNull();
    expect(cardRecord({ block_type: 2, parent_id: 'D' }, 'blk_ours')).toBeNull();
    expect(cardRecord(null, 'blk_ours')).toBeNull();
  });
});

describe('editing a document', () => {
  type Call = { url: string; method?: string; auth?: string; body?: unknown };
  const harness = (reply: (call: Call) => Response) => {
    const calls: Call[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const form = (data: FormData) => { const out: Record<string, unknown> = {}; data.forEach((value, key) => { out[key] = value; }); return out; };
      const body = init?.body instanceof FormData ? form(init.body) : init?.body ? JSON.parse(String(init.body)) : undefined;
      const call = { url: String(url), method: init?.method, auth: (init?.headers as Record<string, string>)?.Authorization, body };
      calls.push(call);
      return reply(call);
    });
    return { calls, client: new FeishuDocsClient(async () => 'u-token', fetcher as unknown as typeof fetch, async () => 't-token') };
  };

  it('converts Markdown as the app, leaving out images and the read-only table merge info', async () => {
    const { calls, client } = harness(() => ok({
      first_level_block_ids: ['h', 'img', 't'],
      blocks: [
        { block_id: 'h', block_type: 3, heading1: { elements: [] }, parent_id: '' },
        { block_id: 'img', block_type: 27, image: {} },
        { block_id: 't', block_type: 31, table: { property: { row_size: 1, column_size: 1, merge_info: [{}] } }, children: ['c'] },
        { block_id: 'c', block_type: 32, table_cell: {}, children: [] },
      ],
    }));
    const converted = await client.convert('# 标题\n\n![x](a.png)\n\n| a |\n|---|');
    expect(calls[0]).toMatchObject({ url: expect.stringContaining('/docx/v1/documents/blocks/convert'), auth: 'Bearer t-token', body: { content_type: 'markdown' } });
    expect(converted).toEqual({ children: ['h', 't'], droppedImages: 1, blocks: [
      { block_id: 'h', block_type: 3, heading1: { elements: [] } },
      { block_id: 't', block_type: 31, table: { property: { row_size: 1, column_size: 1 } }, children: ['c'] },
      { block_id: 'c', block_type: 32, table_cell: {}, children: [] },
    ] });
  });

  it('inserts long content in ordered batches and returns the real ids of its top blocks', async () => {
    const { calls, client } = harness((call) => {
      const ids = (call.body as { children_id: string[] }).children_id;
      return ok({ block_id_relations: ids.map((id) => ({ temporary_block_id: id, block_id: `real-${id}` })) });
    });
    const tree = (id: string) => [{ block_id: id, block_type: 2, children: Array.from({ length: 250 }, (_, k) => `${id}${k}`) },
      ...Array.from({ length: 250 }, (_, k) => ({ block_id: `${id}${k}`, block_type: 2, children: [] }))];
    const created = await client.insertBlocks('lht', 'D', { parent: 'p9', index: 5 }, { children: ['a', 'b', 'c'], blocks: [...tree('a'), ...tree('b'), ...tree('c')], droppedImages: 0 }, 'tok');
    expect(created).toEqual(['real-a', 'real-b', 'real-c']);
    expect(calls.map((c) => [(c.body as { index: number }).index, (c.body as { descendants: unknown[] }).descendants.length])).toEqual([[5, 251], [6, 251], [7, 251]]);
    expect(calls[0].url).toContain('/docx/v1/documents/D/blocks/p9/descendant?');
  });

  it('puts an image in three steps, and takes the empty block out again when the upload fails', async () => {
    let failUpload = false;
    const { calls, client } = harness((call) => {
      if (call.url.includes('/children?')) return ok({ children: [{ block_id: 'img1' }] });
      if (call.url.includes('medias/upload_all')) return failUpload ? refused(1061002, 400) : ok({ file_token: 'ft' });
      if (call.url.includes('/blocks/p9?')) return ok({ block: { block_id: 'p9', children: ['img1'] } });
      return ok({});
    });
    expect(await client.insertImage('lht', 'D', { parent: 'p9', index: 2 }, { name: 'fig.png', data: Buffer.from('png') }, 'tok')).toBe('img1');
    expect(calls[0].body).toEqual({ index: 2, children: [{ block_type: 27, image: {} }] });
    expect(calls[1].body).toMatchObject({ file_name: 'fig.png', parent_type: 'docx_image', parent_node: 'img1', size: '3' });
    expect(calls[2]).toMatchObject({ method: 'PATCH', url: expect.stringContaining('/blocks/img1?'), body: { replace_image: { token: 'ft' } } });
    failUpload = true;
    calls.length = 0;
    await expect(client.insertImage('lht', 'D', { parent: 'p9', index: 2 }, { name: 'fig.png', data: Buffer.from('png') }, 'tok2')).rejects.toBeTruthy();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: expect.stringContaining('/blocks/p9/children/batch_delete'), body: { start_index: 0, end_index: 1 } });
  });

  it('uploads an image larger than one upload_all request in the parts Feishu plans', async () => {
    const { calls, client } = harness((call) => {
      if (call.url.includes('/children?')) return ok({ children: [{ block_id: 'img1' }] });
      if (call.url.includes('medias/upload_prepare')) return ok({ upload_id: 'up1', block_size: 4 * 1024 * 1024, block_num: 6 });
      if (call.url.includes('medias/upload_part')) return ok({});
      if (call.url.includes('medias/upload_finish')) return ok({ file_token: 'ft-big' });
      return ok({});
    });
    const big = Buffer.alloc(UPLOAD_ALL_MAX_BYTES + 1, 7);
    expect(await client.insertImage('lht', 'D', { parent: 'p9', index: 2 }, { name: 'big.png', data: big }, 'tok')).toBe('img1');
    expect(calls.some((c) => c.url.includes('upload_all'))).toBe(false);
    expect(calls[1].body).toEqual({ file_name: 'big.png', parent_type: 'docx_image', parent_node: 'img1', size: big.length });
    const parts = calls.filter((c) => c.url.includes('upload_part')).map((c) => c.body as Record<string, unknown>);
    expect(parts.map((p) => [p.upload_id, p.seq, Number(p.size)])).toEqual([0, 1, 2, 3, 4, 5].map((seq) => ['up1', String(seq), seq < 5 ? 4 * 1024 * 1024 : 1]));
    expect(parts.reduce((sum, p) => sum + (p.file as Blob).size, 0)).toBe(big.length);
    expect(calls.find((c) => c.url.includes('upload_finish'))!.body).toEqual({ upload_id: 'up1', block_num: 6 });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { replace_image: { token: 'ft-big' } } });
  });

  it('waits and retries when Feishu says the document is being edited too fast', async () => {
    let n = 0;
    const { client } = harness(() => (++n < 3 ? new Response(JSON.stringify({ code: 99991400, msg: 'too fast' }), { status: 400 }) : ok({ block: { block_id: 'b' } })));
    expect(await client.block('lht', 'D', 'b')).toEqual({ block_id: 'b' });
    expect(n).toBe(3);
  });

  it('caches the app token until shortly before it expires', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 0, tenant_access_token: 't1', expire: 7200 })));
    const token = tenantTokenSource('cli_x', 's', fetcher as unknown as typeof fetch);
    expect([await token(), await token()]).toEqual(['t1', 't1']);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('lists the body in reading order with kinds and depth', () => {
    const blocks: DocBlock[] = [
      { id: 'D', parent: '', children: ['h', 'p'], text: '', type: 1 },
      { id: 'h', parent: 'D', children: [], text: '标题', type: 3 },
      { id: 'p', parent: 'D', children: ['c'], text: '段落', type: 2 },
      { id: 'c', parent: 'p', children: [], text: 'x'.repeat(400), type: 12 },
    ];
    expect(outlineOf(blocks, 'D')).toEqual([
      { id: 'h', kind: 'h1', depth: 0, text: '标题' }, { id: 'p', kind: 'text', depth: 0, text: '段落' },
      { id: 'c', kind: 'bullet', depth: 1, text: `${'x'.repeat(300)}…` },
    ]);
  });
});

describe('slotsAfter', () => {
  // The shape of a real plan document: a section's heading and plan are children of an indented paragraph.
  const blocks: DocBlock[] = [
    { id: 'D', parent: '', children: ['h1', 'p9', 'hb'], text: '组会周报' },
    { id: 'h1', parent: 'D', children: [], text: '🛠️ 2. 执行细节' },
    { id: 'p9', parent: 'D', children: ['a0', 'a0plan', 'a1', 'a1plan'], text: '论述口径：缩小论述。' },
    { id: 'a0', parent: 'p9', children: [], text: 'A0｜把隐式依赖纳入统一分析框架' },
    { id: 'a0plan', parent: 'p9', children: [], text: '计划：  定义输入 --- 中间态 --- 输出的task 内依赖图；说明恢复流程的原理' },
    { id: 'a1', parent: 'p9', children: [], text: 'A1｜原型系统 v2 的版本管理' },
    { id: 'a1plan', parent: 'p9', children: [], text: '计划：用该系统做一组基准测试' },
    { id: 'hb', parent: 'D', children: [], text: 'B｜相关工作部分改写' },
  ];
  const after = (anchor: string) => slotsAfter(blocks, 'D', anchor);

  it('puts the card right after the block where the quoted text ends, then each enclosing block', () => {
    const quoted = 'A0｜把隐式依赖纳入统一分析框架\n  计划：  定义输入 --- 中间态 --- 输出的task 内依赖图；说明恢复流程的原理';
    expect(after(quoted)).toEqual({ block: blocks[4], slots: [{ parent: 'p9', index: 2 }, { parent: 'D', index: 2 }] });
    expect(after('计划：定义输入---中间态')).toMatchObject({ block: { id: 'a0plan' } });
    expect(after('A0｜把隐式依赖')).toMatchObject({ block: { id: 'a0' }, slots: [{ parent: 'p9', index: 1 }, { parent: 'D', index: 2 }] });
    expect(after('B｜相关工作')).toEqual({ block: blocks[7], slots: [{ parent: 'D', index: 3 }] });
    expect(after('a1')).toMatchObject({ block: { id: 'a1' } });
  });

  it('does not guess between several places, and says when there is none', () => {
    expect(after('计划：')).toEqual({ matches: [blocks[4], blocks[6]] });
    expect(after('没有这段话')).toEqual({ matches: [] });
    expect(after('   ')).toEqual({ matches: [] });
    expect(after('组会周报')).toEqual({ matches: [] });
  });
});

describe('DocsNotifier', () => {
  it('tells the owner about edits by one agent to one document once per ten minutes', async () => {
    let now = 0;
    const send = vi.fn(async () => {});
    const notifier = new DocsNotifier(send, vi.fn(), () => now);
    const edit = (doc: string, change: string) => notifier.notify('lht', { kind: 'edited', actor: '秘书', doc: { title: doc, url: `https://t.feishu.cn/wiki/${doc}` }, change });
    edit('plan', '写入了 3 个内容块');
    edit('plan', '插入了图片 fig.png');
    edit('other', '删除了 1 个内容块');
    now = 11 * 60_000;
    edit('plan', '替换了一段内容');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(JSON.stringify((send.mock.calls[0] as unknown[])[1])).toContain('10 分钟内');
  });

  it('sends every change, coalesces repeated observations, and never throws', async () => {
    let now = 0;
    const sent: string[] = [];
    const send = vi.fn(async (_owner: string, card: { header?: { title: unknown } }) => { sent.push(JSON.stringify(card.header?.title)); if (sent.length === 3) throw new Error('feishu down'); });
    const failed = vi.fn();
    const notifier = new DocsNotifier(send, failed, () => now);
    notifier.notify('lht', { kind: 'viewed', actor: '张三', session: '实验' });
    notifier.notify('lht', { kind: 'viewed', actor: '张三', session: '实验' });
    notifier.notify('lht', { kind: 'viewed', actor: '李四', session: '实验' });
    notifier.notify('lht', { kind: 'placed', actor: 'lht 的 Agent', via: 'agent', session: '实验', device: 'laptop', provider: 'codex', doc: { title: '周报', url: 'https://t.feishu.cn/wiki/x' } });
    notifier.notify('lht', { kind: 'placed', actor: 'lht 的 Agent', via: 'agent', session: '实验', device: 'laptop', provider: 'codex', doc: { title: '周报' } });
    now = 7 * 60 * 60_000;
    notifier.notify('lht', { kind: 'viewed', actor: '张三', session: '实验' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
    expect(failed).toHaveBeenCalledWith('lht', 'placed', expect.any(Error));
  });

  it('escapes names as HTML entities, the only escape card Markdown honours, and links the document', () => {
    const card = docsNoticeCard({ kind: 'file', actor: 'a*b', session: '实验', path: 'results/[x]_1.csv', workspace: 'paper' });
    expect(card.elements).toEqual([{ tag: 'markdown', content: expect.stringContaining('a&#42;b') }]);
    expect(JSON.stringify(card)).toContain('打开了 results/&#91;x&#93;&#95;1.csv');
    expect(JSON.stringify(card)).not.toMatch(/\\\\|`/);
    const placed = docsNoticeCard({ kind: 'placed', actor: 'lht', via: 'card', session: 's', device: 'd', provider: 'claude', doc: { title: '周报', url: 'https://t.feishu.cn/wiki/x' } });
    expect(JSON.stringify(placed)).toContain('[周报](https://t.feishu.cn/wiki/x)');
  });
});

describe('finding a document by title', () => {
  it('merges wiki and Drive hits as the owner and picks only an unambiguous one', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('wiki/v1/nodes/search')
      ? ok({ items: [{ node_id: 'WikiToken1234567890abcdefgh', obj_token: 'DocxToken1234567890abcdefg', title: '组会周报', url: 'https://t.feishu.cn/wiki/WikiToken1234567890abcdefgh' }] })
      : ok({ docs_entities: [
        { docs_token: 'DocxToken1234567890abcdefg', docs_type: 'docx', title: '组会周报' },
        { docs_token: 'OtherDocx1234567890abcdefg', docs_type: 'docx', title: '组会周报（旧）' },
        { docs_token: 'SheetToken1234567890abcdef', docs_type: 'sheet', title: '组会周报' },
      ] }));
    const client = new FeishuDocsClient(async () => 'u', fetcher as unknown as typeof fetch);
    const hits = await client.search('lht', '组会周报');
    expect(hits.map((h) => [h.title, h.ref.kind])).toEqual([['组会周报', 'wiki'], ['组会周报（旧）', 'docx']]);
    expect(pickDocument('《组会周报》', hits)).toEqual({ hit: hits[0] });
    expect(pickDocument('周报', hits)).toMatchObject({ candidates: [{ title: '组会周报' }, { title: '组会周报（旧）' }] });
    expect(pickDocument('周报', [hits[1]])).toEqual({ hit: hits[1] });
    expect(pickDocument('nothing', [])).toEqual({ candidates: [] });
  });
});
