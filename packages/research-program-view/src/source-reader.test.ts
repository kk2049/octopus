import { describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { readSourceChunks } from './source-reader.js';
import { createResearchSessionsAdapter } from './sessions-adapter.js';
import { createResearchDocumentsAdapter } from './documents-adapter.js';
import { collectWorkspaceDownload } from '@claude-bot/workspace-files-contract';
import type { SourceRow, ResearchProjection } from './model.js';
const source: SourceRow = { source_key: 'agent', generation: 'a'.repeat(64), kind: 'session', title: 'Codex 历史', source_ref: 'codex:uuid', provider: 'codex', reason: '指定历史', total: 4, next: 4, ranges: [[10, 0, 2], [30, 2, 2]], updated_at: '2026-09-07T00:00:00.000Z' };
const messages = ['one', 'two', 'three', 'four'].map(text => ({ role: 'assistant', blocks: [{ type: 'text', text }] }));
const reply = (result: unknown) => ({ ok: true, message: '', rid: 'read', result });
it('clears live display state and rejects a late real-session read after a mapping change', async () => {
  let finish!: (value: ReturnType<typeof reply>) => void;
  const adapter = createResearchSessionsAdapter(() => new Promise(resolve => { finish = resolve; }));
  const projection: ResearchProjection = { viewer_role: 'owner', sources: { agent: source }, sessions: [{ session_key: 'agent', curated: true }], source_locations: { revision: 1, roots: ['/project'], sessions: { agent: { cwd: '/project', device: 'runner', provider: 'codex', session_id: 'native' } } }, sessionResources: { sessions: [{ resourceId: 'agent', deviceId: 'runner' }], transcript: { agent: { messages, offset: 0 } } } };
  adapter.update(projection, true);
  const pending = adapter.port.readWindow({ resource: 'agent', limit: 50 });
  adapter.update({ ...projection, source_locations: { ...projection.source_locations!, revision: 2, sessions: {} }, sessionResources: { sessions: [], transcript: {} } }, true);
  finish(reply({ messages, offset: 0 }));
  expect(await pending).toMatchObject({ ok: false, code: 'unavailable' });
  expect(adapter.port.snapshot().projection?.transcript?.agent).toBeUndefined();
  expect(adapter.port.snapshot().projection?.sessions?.[0]?.deviceId).toBeUndefined();
});
it('uses shared session command encoding only for a confirmed live binding', async () => {
  const send = vi.fn(async () => reply({ opId: 'tracked-operation', status: 'queued' }));
  const adapter = createResearchSessionsAdapter(send);
  const projection: ResearchProjection = { viewer_role: 'owner', project: { archived: false }, sources: { agent: source }, sessions: [{ session_key: 'agent', curated: true, cliKind: 'codex' }], source_locations: { revision: 1, roots: ['/project'], sessions: { agent: { cwd: '/actual', document_base: '', device: 'runner', provider: 'codex', session_id: 'native' } } } };
  adapter.update(projection, true);
  expect(await adapter.port.append('agent', 'prompt')).toMatchObject({ ok: false });
  expect(send).not.toHaveBeenCalled();
  projection.sessionResources = { sessions: [{ resourceId: 'agent', deviceId: 'runner', cliKind: 'codex', sessionId: 'native' }] };
  adapter.update(projection, true);
  expect(await adapter.port.append('agent', 'prompt', 'manual', 'high', 'model')).toMatchObject({ ok: true, result: { opId: 'tracked-operation' } });
  expect(send).toHaveBeenLastCalledWith('append_session', { resource: 'agent', prompt: 'prompt', permission_profile: 'manual', effort: 'high', model: 'model' });
  projection.project!.archived = true;
  adapter.update(projection, true);
  expect(adapter.port.snapshot().projection?.sessions?.[0]?.deviceId).toBeUndefined();
  expect(await adapter.port.append('agent', 'blocked')).toMatchObject({ ok: false });
});
const propose = vi.fn(async (_action: string, params?: Record<string, string>) => reply({ chunks: params?.after_seq === '9' ? [{ seq: 10, offset: 0, count: 2, payload: JSON.stringify(messages.slice(0, 2)) }] : [{ seq: 30, offset: 2, count: 2, payload: JSON.stringify(messages.slice(2)) }] }));
describe('research ports reuse Sessions+ resource semantics', () => {
  it('opens a bound PNG through the shared media port and downloads original bytes, never base64 text', async () => {
    vi.stubGlobal('crypto', webcrypto);
    try {
      const payload = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBWQAAAAASUVORK5CYII=';
      const bytes = Buffer.from(payload, 'base64');
      const figure = { ...source, kind: 'document' as const, encoding: 'png-base64' as const, total: payload.length, next: payload.length, ranges: [[30, 0, payload.length] as [number, number, number]] };
      const projection = { documents: [{ key: 'agent', path: 'figures/plot.png' }], sources: { agent: figure } };
      const port = createResearchDocumentsAdapter(() => projection, async () => reply({ chunks: [{ seq: 30, offset: 0, count: payload.length, payload }] }));
      expect(await port.resolvePath!('research-documents', ['figures', 'plot.png'])).toMatchObject({ ok: true, value: { ref: 'agent' } });
      expect(await port.openText('agent')).toMatchObject({ ok: false, code: 'not_text' });
      const opened = await port.openMedia('agent');
      expect(opened).toMatchObject({ ok: true, value: { document: { mediaType: 'image/png', sizeBytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` } } });
      if (!opened.ok) throw new Error('media refused');
      expect(await opened.value.stream.next()).toMatchObject({ kind: 'chunk', value: { offset: 0, bytes: bytes.length, data: payload } });
      expect(await opened.value.stream.next()).toMatchObject({ kind: 'end' });
      expect(await collectWorkspaceDownload(port, 'agent', () => {})).toMatchObject({ ok: true });
      expect(await port.openMedia('outside')).toMatchObject({ ok: false });
      const malformed = createResearchDocumentsAdapter(() => projection, async () => reply({ chunks: [{ seq: 30, offset: 0, count: payload.length, payload: 'A'.repeat(payload.length) }] }));
      expect(await malformed.openMedia('agent')).toMatchObject({ ok: false, message: expect.stringContaining('签名') });
    } finally { vi.unstubAllGlobals(); }
  });
  it('reassembles a long native message before handing it to Sessions+, without splitting its Markdown or message identity', async () => {
    const message = { role: 'assistant', blocks: [{ type: 'text', text: '# 完整回复\n\n```txt\n' + '证据😀'.repeat(25000) + '\n```\n末尾结论' }] };
    const serialized = JSON.stringify([message]);
    const fragments: Array<{ seq: number; offset: number; count: number; payload: string; fragment_offset: number; fragment_total: number }> = [];
    for (let i = 0; i < serialized.length; i += 24000) fragments.push({ seq: 20 + fragments.length, offset: 0, count: i + 24000 < serialized.length ? 0 : 1, payload: serialized.slice(i, i + 24000), fragment_offset: i, fragment_total: serialized.length });
    const complete = { ...source, total: 1, next: 1, ranges: fragments.map(f => [f.seq, 0, 1] as [number, number, number]) };
    const read = vi.fn(async () => reply({ chunks: fragments }));
    const adapter = createResearchSessionsAdapter(read);
    adapter.update({ sources: { agent: complete }, sessions: [{ session_key: 'agent', curated: true }] }, true);
    expect(await adapter.port.readWindow({ resource: 'agent', limit: 50 })).toMatchObject({ ok: true });
    expect(adapter.port.snapshot().projection?.transcript?.agent).toMatchObject({ offset: 0, totalMessages: 1, messages: [message] });
    expect(read).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => reply({ chunks: fragments.filter((_, i) => i !== 1) }));
    await expect(readSourceChunks(complete, 0, 1, bad)).rejects.toThrow('未返回');
  });
  it('seeks across interleaved stream events without empty pages or scanning unrelated content', async () => {
    propose.mockClear();
    expect((await readSourceChunks(source, 2, 4, propose))[0]?.seq).toBe(30);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0]?.[1]?.after_seq).toBe('29');
  });
  it('presents tail and older windows in the same absolute message coordinates as Sessions+', async () => {
    const adapter = createResearchSessionsAdapter(propose);
    adapter.update({ sources: { agent: source }, sessions: [{ session_key: 'agent', curated: true, title: source.title, cliKind: 'codex' }] }, true);
    expect(await adapter.port.readWindow({ resource: 'agent', limit: 2 })).toMatchObject({ ok: true });
    expect(adapter.port.snapshot().projection?.transcript?.agent).toMatchObject({ offset: 2, totalMessages: 4, hasMore: true, messages: messages.slice(2) });
    await adapter.port.readWindow({ resource: 'agent', limit: 4, offset: 0 });
    expect(adapter.port.snapshot().projection?.transcript?.agent).toMatchObject({ offset: 0, hasMore: false, messages });
    expect(await adapter.port.append('agent', 'must not impersonate a real agent')).toMatchObject({ ok: false, code: 'read_only' });
  });
  it('does not show an incomplete import as an empty, completed chat', async () => {
    const adapter = createResearchSessionsAdapter(propose);
    adapter.update({ sources: { agent: { ...source, next: 2 } } }, true);
    expect(await adapter.port.readWindow({ resource: 'agent', limit: 2 })).toMatchObject({ ok: false, message: expect.stringContaining('2/4') });
    expect(adapter.port.snapshot().projection?.transcript?.agent).toBeUndefined();
  });
  it('reads full documents after body eviction and downloads identical UTF-8 bytes', async () => {
    const text = '# 中文文档\n\n原始内容。';
    const documentSource = { ...source, kind: 'document' as const, total: text.length, next: text.length, ranges: [[30, 0, text.length] as [number, number, number]] };
    const projection: ResearchProjection = { documents: [{ key: 'agent', source_key: 'agent', path: 'reports/README.md', title: '报告', body: '' }], sources: { agent: documentSource } };
    const reader = vi.fn(async () => reply({ chunks: [{ seq: 30, offset: 0, count: text.length, payload: text }] }));
    const port = createResearchDocumentsAdapter(() => projection, reader);
    const opened = await port.openText('agent');
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('open refused');
    expect(await opened.value.stream.next()).toMatchObject({ kind: 'chunk', value: { text } });
    const downloaded = await collectWorkspaceDownload(port, 'agent', () => {});
    expect(downloaded.ok).toBe(true);
    expect(await port.openText('invented')).toMatchObject({ ok: false });
  });
});
