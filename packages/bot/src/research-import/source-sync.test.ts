import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { prepareSourceProject, runSourceSync, sourceHash } from './source-sync.js';
import { appToolOutcome } from './mcp-client.js';

const mcp = vi.hoisted(() => ({ call: vi.fn(), connect: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { connect = mcp.connect; callTool = mcp.call; close = async () => {}; } }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));

it('decodes real HTTP MCP success and refusal envelopes', () => {
  expect(appToolOutcome({ structuredContent: { apps: [] }, content: [{ type: 'text', text: 'ignored' }] })).toEqual({ ok: true, result: { apps: [] } });
  expect(appToolOutcome({ isError: true, content: [{ type: 'text', text: 'forbidden: source access removed' }] })).toEqual({ ok: false, code: 'forbidden', message: 'source access removed' });
});

it('freezes an explicitly selected PNG figure losslessly and rejects a disguised text file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-figure-'));
  try {
    const path = join(dir, 'plot.png'), bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBWQAAAAASUVORK5CYII=', 'base64');
    writeFileSync(path, bytes);
    const plan = { key: 'demo', title: 'Demo', instance: 'asi_demo', documents: [{ path, display: 'figures/plot.png' }], sessions: [] };
    const source = prepareSourceProject(plan).sources[0]!;
    expect(source.encoding).toBe('png-base64');
    expect(Buffer.from(source.chunks.map(chunk => chunk.payload).join(''), 'base64')).toEqual(bytes);
    expect(source.source_digest).toBe(sourceHash(bytes));
    writeFileSync(path, 'not an image');
    expect(() => prepareSourceProject(plan)).toThrow('signature');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('prepares a document past the old 1 MiB check and names the receiving App bound past it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-long-doc-'));
  try {
    const path = join(dir, 'paper.md'), body = '# 长论文\n\n' + '研究正文。'.repeat(300_000);
    writeFileSync(path, body);
    const plan = { key: 'demo', title: 'Demo', instance: 'asi_demo', documents: [{ path, display: 'paper.md' }], sessions: [] };
    const source = prepareSourceProject(plan).sources[0]!;
    expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024 * 1024);
    expect(source.chunks.map(chunk => chunk.payload).join('')).toBe(body);
    expect(source.chunks.every(chunk => chunk.payload.length <= 24000)).toBe(true);
    writeFileSync(path, 'x'.repeat(2_000_001));
    expect(() => prepareSourceProject(plan)).toThrow('research-program accepts at most 2000000');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('freezes complete long assistant text as bounded fragments of the original single message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-full-message-'));
  try {
    const session = join(dir, 'session.jsonl');
    const body = '# Long evidence\n\n' + '完整😀'.repeat(20000) + '\nFinal finding';
    writeFileSync(session, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: body }] } }));
    const item = prepareSourceProject({ key: 'demo', title: 'Demo', instance: 'asi_demo', documents: [], sessions: [{ path: session, id: 'real', provider: 'codex', title: 'Real', association: 'User selected' }] }).sources[0]!;
    expect(item.total).toBe(1); expect(item.chunks.length).toBeGreaterThan(1);
    expect(item.chunks.every(chunk => chunk.payload.length <= 32000 && chunk.offset === 0 && chunk.fragment_total)).toBe(true);
    expect(JSON.parse(item.chunks.map(chunk => chunk.payload).join(''))).toEqual([{ role: 'assistant', blocks: [{ type: 'text', text: body }] }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('preserves rich tool content, Unicode and document whitespace in frozen explicit sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-source-'));
  try {
    const doc = join(dir, 'report.md'), session = join(dir, 'session.jsonl');
    const body = '# Evidence\n' + '😀'.repeat(12500) + '\n \n'; writeFileSync(doc, body);
    writeFileSync(session, [
      { type: 'session_meta', payload: { id: 'real', cwd: '/project' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call', arguments: '{"cmd":"test"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'passed' } },
    ].map(row => JSON.stringify(row)).join('\n'));
    const prepared = prepareSourceProject({ key: 'demo', title: 'Demo', instance: 'asi_demo', documents: [{ path: doc, display: 'report.md' }], sessions: [{ path: session, id: 'real', provider: 'codex', title: 'Real history', association: 'User selected' }] });
    expect(prepared.sources[0]!.chunks.map(row => row.payload).join('')).toBe(body);
    expect(prepared.sources[0]!.generation).toBe(sourceHash(body));
    expect(prepared.sources[0]!.chunks.every(row => !/[\uD800-\uDBFF]$/.test(row.payload))).toBe(true);
    expect(prepared.sources[1]!.chunks.flatMap(row => JSON.parse(row.payload)).flatMap(row => row.blocks)).toContainEqual(expect.objectContaining({ type: 'tool', tool: 'exec_command', output: 'passed' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('reconciles an uncertain append by authoritative offset, then verifies exact content without rereading changed sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-resume-')), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const doc = join(dir, 'report.md'), plan = join(dir, 'plan.json'), config = join(dir, 'mcp.json'), out = join(dir, 'bundle');
    writeFileSync(doc, '# Frozen evidence'); writeFileSync(join(dir, 'token'), 'fixture');
    writeFileSync(config, JSON.stringify({ url: 'http://127.0.0.1:1/api/mcp', token_file: join(dir, 'token') }));
    writeFileSync(plan, JSON.stringify({ version: 1, projects: [{ key: 'demo', title: 'Demo', instance: 'asi_demo', documents: [{ path: doc, display: 'report.md' }], sessions: [] }] }));
    await runSourceSync(['--plan', plan, '--out', out]);
    const item = JSON.parse(readFileSync(join(out, 'sources.json'), 'utf8')).bundles[0].sources[0];
    let source: any = null, writes = 0;
    mcp.call.mockImplementation(async ({ name, arguments: args }) => {
      if (name === 'app_list') return { structuredContent: { apps: [{ app: 'research-program', instances: [{ instance: 'asi_demo' }], actions: [{ name: 'research_bind_source' }] }] } };
      let result = {};
      if (args.action === 'research_source_status') result = { source };
      if (args.action === 'research_bind_source' && !source) source = { generation: item.generation, next: 0, ranges: [] };
      if (args.action === 'research_publish_source') {
        writes++; source.next = item.total; source.ranges = [[2, 0, item.total]];
        throw new Error('transport lost after commit');
      }
      if (args.action === 'research_read_source') result = { chunks: [{ offset: 0, payload: item.chunks[0].payload }] };
      return { structuredContent: { result } };
    });
    const args = ['--out', out, '--apply', '--mcp-config', config];
    await expect(runSourceSync(args)).rejects.toThrow('transport lost');
    expect(JSON.parse(readFileSync(join(out, 'pending.json'), 'utf8'))).toMatchObject({ offset: 0, generation: item.generation });
    unlinkSync(doc);
    await runSourceSync(args);
    expect(writes).toBe(1);
    expect(JSON.parse(readFileSync(join(out, 'verified.json'), 'utf8'))[0]).toMatchObject({ total: item.total, verified_chunks: 1 });
    const edited = JSON.parse(readFileSync(join(out, 'sources.json'), 'utf8')); edited.bundles[0].title = 'tampered';
    writeFileSync(join(out, 'sources.json'), JSON.stringify(edited));
    const calls = mcp.call.mock.calls.length;
    await expect(runSourceSync(args)).rejects.toThrow('differs'); expect(mcp.call).toHaveBeenCalledTimes(calls);
  } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it('resumes an uncertain long-message fragment without duplicating or splitting the native message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-fragment-resume-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const session = join(dir, 'session.jsonl'), plan = join(dir, 'plan.json'), config = join(dir, 'mcp.json'), out = join(dir, 'bundle');
    writeFileSync(session, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Evidence '.repeat(10000) }] } }));
    writeFileSync(join(dir, 'token'), 'fixture');writeFileSync(config, JSON.stringify({ url: 'http://127.0.0.1:1/api/mcp', token_file: join(dir, 'token') }));
    writeFileSync(plan, JSON.stringify({ version: 1, projects: [{ key: 'demo', title: 'Demo', instance: 'asi_demo', documents: [], sessions: [{ path: session, id: 'real', provider: 'codex', title: 'Real', association: 'Selected' }] }] }));
    await runSourceSync(['--plan', plan, '--out', out]);
    const item = JSON.parse(readFileSync(join(out, 'sources.json'), 'utf8')).bundles[0].sources[0];
    let source: any = null, writes = 0;const stored: any[] = [];
    mcp.call.mockImplementation(async ({ name, arguments: args }) => {
      if (name === 'app_list') return { structuredContent: { apps: [{ app: 'research-program', instances: [{ instance: 'asi_demo' }], actions: [{ name: 'research_bind_source' }, { name: 'research_publish_source', parameters: { properties: { fragment_total: {} } } }] }] } };
      let result: any = {};
      if (args.action === 'research_source_status') result = { source };
      if (args.action === 'research_bind_source' && !source) source = { generation: item.generation, next: 0, ranges: [] };
      if (args.action === 'research_publish_source') {
        const offset = Number(args.params.fragment_offset), total = Number(args.params.fragment_total), next = offset + args.params.payload.length;
        const chunk = { seq: ++writes, offset: 0, count: next === total ? 1 : 0, payload: args.params.payload, fragment_offset: offset, fragment_total: total };
        stored.push(chunk);source.ranges.push([chunk.seq, 0, 1]);source.next = chunk.count;source.partial = next === total ? undefined : { offset: 0, next, total };
        if (writes === 1) throw new Error('lost fragment receipt');
        result = { next: source.next, fragment_next: next };
      }
      if (args.action === 'research_read_source') result = { chunks: stored };
      return { structuredContent: { result } };
    });
    const args = ['--out', out, '--apply', '--mcp-config', config];
    await expect(runSourceSync(args)).rejects.toThrow('lost fragment receipt');
    unlinkSync(session);await runSourceSync(args);
    expect(writes).toBe(item.chunks.length);expect(source.next).toBe(1);expect(source.partial).toBeUndefined();
    expect(JSON.parse(readFileSync(join(out, 'verified.json'), 'utf8'))[0]).toMatchObject({ total: 1, verified_chunks: item.chunks.length });
  } finally { log.mockRestore();rmSync(dir, { recursive: true, force: true }); }
});
