import { describe, expect, it } from 'vitest';
import { research_bind_source, research_publish_source, research_read_source, research_source_status, research_unbind_source } from './source-bindings.js';
import { project, projectIncremental } from './projection.js';
const generation = 'a'.repeat(64);
function harness() {
  let state = project([]), seq = 0;
  const events: any[] = [];
  const ctx = () => ({ state, actor: { kind: 'agent', role: 'owner', user: 'alice' }, now: '2026-09-07T00:00:00.000Z' });
  const run = (action: typeof research_bind_source, params: any) => {
    const result = action(ctx(), params);
    const stamped = result.events.map((event: any) => ({ ...event, seq: ++seq, by: 'agent:importer' }));
    events.push(...stamped); state = projectIncremental(state, stamped); return result;
  };
  return { ctx, run, events };
}
const bind = { source_key: 'key-agent', generation, expected_generation: '', kind: 'session', total: '2', provider: 'codex', title: '历史主导 Agent', source_ref: 'codex:real-session-id', reason: '用户明确选择的关键历史 Agent' };
describe('explicit project source bindings', () => {
  it('keeps figure encoding in the source identity and refuses malformed or reinterpreted chunks', () => {
    const h = harness();
    const png = { ...bind, kind: 'document', encoding: 'png-base64', total: '12', source_ref: 'figures/plot.png' };
    h.run(research_bind_source, png);
    expect(h.ctx().state.sources[bind.source_key].encoding).toBe('png-base64');
    expect(() => h.run(research_bind_source, { ...png, encoding: 'text' })).toThrow('身份');
    expect(() => h.run(research_publish_source, { source_key: bind.source_key, generation, offset: '0', payload: 'bad!' })).toThrow('编码');
    expect(h.run(research_publish_source, { source_key: bind.source_key, generation, offset: '0', payload: 'iVBORw0KGgo=' }).result.complete).toBe(true);
    expect(() => research_bind_source(h.ctx(), { ...bind, encoding: 'png-base64' })).toThrow('编码');
  });
  it('keeps one native message across bounded fragments and resumes by its inner offset', () => {
    const h = harness(); h.run(research_bind_source, { ...bind, total: '1' });
    const payload = JSON.stringify([{ role: 'assistant', blocks: [{ type: 'text', text: '完整正文'.repeat(18000) }] }]);
    const first = { source_key: bind.source_key, generation, offset: '0', fragment_offset: '0', fragment_total: String(payload.length), payload: payload.slice(0, 32000) };
    expect(h.run(research_publish_source, first).result).toMatchObject({ next: 0, fragment_next: 32000, complete: false });
    expect(h.run(research_publish_source, first).result.duplicate).toBe(true);
    expect(h.ctx().state.sources[bind.source_key].partial).toMatchObject({ next: 32000, total: payload.length });
    expect(() => h.run(research_publish_source, { ...first, fragment_offset: '1' })).toThrow('偏移');
    expect(() => h.run(research_publish_source, { source_key: bind.source_key, generation, offset: '0', payload: '[]' })).toThrow('先完成');
    for (let offset = 32000; offset < payload.length; offset += 32000) h.run(research_publish_source, { ...first, fragment_offset: String(offset), payload: payload.slice(offset, offset + 32000) });
    expect(h.ctx().state.sources[bind.source_key]).toMatchObject({ next: 1, total: 1 });
    expect(h.ctx().state.sources[bind.source_key].partial).toBeUndefined();
    expect(h.ctx().state.sessions[0].messageCount).toBe(1);
  });
  it('renames and unbinds a source while preserving its indexed history and protecting the default', () => {
    const h = harness(); h.run(research_bind_source, { ...bind, total: '1' });
    h.run(research_publish_source, { source_key: bind.source_key, generation, offset: '0', payload: '[{"role":"user","blocks":[]}]' });
    h.run(research_bind_source, { ...bind, total: '1', title: '更清楚的名字' });
    expect(research_source_status(h.ctx(), { source_key: bind.source_key }).result.source).toMatchObject({ title: '更清楚的名字', next: 1, ranges: [[2, 0, 1]] });
    h.ctx().state.lead_agent = { session_key: bind.source_key };
    expect(() => h.run(research_unbind_source, { source_key: bind.source_key, generation, reason: '误绑定' })).toThrow('默认');
    h.ctx().state.lead_agent = null;
    h.run(research_unbind_source, { source_key: bind.source_key, generation, reason: '误绑定' });
    expect(h.ctx().state.sessions[0].hidden).toBe(true);
    const directory = research_source_status(h.ctx(), {}).result.sources;
    expect(directory).toHaveLength(1);
    expect(directory![0]).not.toHaveProperty('ranges');
    h.run(research_bind_source, { ...bind, total: '1', title: '更清楚的名字' });
    expect(h.ctx().state.sessions[0].hidden).toBe(false);
  });
  it('preserves native rich blocks and indexed offsets without promoting a historical leader', () => {
    const h = harness(); h.run(research_bind_source, bind);
    const payload = JSON.stringify([{ role: 'user', blocks: [{ type: 'text', text: '验证这个实验' }] }, { role: 'assistant', blocks: [{ type: 'tool', tool: 'exec_command', input: '{"cmd":"test"}', output: 'passed', truncated: true }, { type: 'text', text: '实验通过。' }] }]);
    expect(h.run(research_publish_source, { source_key: bind.source_key, generation, offset: '0', payload }).result).toMatchObject({ next: 2, complete: true });
    expect(h.ctx().state.lead_agent).toBeNull();
    expect(h.ctx().state.sources['key-agent'].ranges).toEqual([[2, 0, 2]]);
    expect(h.ctx().state.sessions[0]).toMatchObject({ curated: true, messageCount: 2, source_key: 'key-agent' });
    const result = research_read_source({ ...h.ctx(), actor: { role: 'viewer' }, history: { events: h.events, cursor: 2, head: 2 } }, { source_key: bind.source_key, generation });
    expect(JSON.parse(result.result.chunks[0].payload)).toEqual(JSON.parse(payload));
    const publicView = projectIncremental(h.ctx().state, [], { viewer: { kind: 'user', user: 'alice', role: 'owner' } });
    expect(publicView).not.toHaveProperty('source_last');
  });
  it('reconciles an exact duplicate and rejects offset, version and role conflicts', () => {
    const h = harness(); h.run(research_bind_source, { ...bind, total: '1' });
    const params = { source_key: bind.source_key, generation, offset: '0', payload: '[{"role":"user","blocks":[{"type":"text","text":"x"}]}]' };
    h.run(research_publish_source, params);
    expect(h.run(research_publish_source, params).result.duplicate).toBe(true);
    expect(() => h.run(research_publish_source, { ...params, payload: params.payload.replace('"x"', '"y"') })).toThrow('偏移');
    expect(() => h.run(research_bind_source, { ...bind, generation: 'b'.repeat(64) })).toThrow('版本');
    expect(() => research_publish_source({ ...h.ctx(), actor: { role: 'viewer' } }, params)).toThrow('权限');
    expect(() => research_read_source({ ...h.ctx(), history: { events: h.events } }, { ...params, generation: 'b'.repeat(64) })).toThrow('版本');
    h.run(research_bind_source, { ...bind, generation: 'b'.repeat(64), expected_generation: generation });
    expect(h.ctx().state.sources['key-agent']).toMatchObject({ next: 0, ranges: [] });
    expect(h.events).toHaveLength(3);
  });
  it('repairs evidence in a frozen project as owner without reopening it or creating human attestations', () => {
    const h = harness(); h.ctx().state.project.archived = true;
    h.run(research_bind_source, { ...bind, kind: 'document', total: '5', source_ref: 'README.md' });
    h.run(research_publish_source, { source_key: bind.source_key, generation, offset: '0', payload: ' x\n\ny' });
    expect(h.ctx().state.project.archived).toBe(true);
    expect(h.events[1].data.payload).toBe(' x\n\ny');
    expect(h.ctx().state.research.attestations).toEqual([]);
    expect(() => research_bind_source({ ...h.ctx(), actor: { role: 'member' } }, bind)).toThrow('Owner');
  });
});
