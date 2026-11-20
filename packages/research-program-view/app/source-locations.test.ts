import { describe, expect, it } from 'vitest';
import { research_set_source_locations } from './source-locations.js';
import { project, projectIncremental } from './projection.js';
const ctx = () => ({ actor: { kind: 'agent', role: 'owner' }, state: { ...project([]), sources: { lead: { kind: 'session' } } } });
const params = { expected_revision: '0', reason: '核对原始 transcript metadata', locations: JSON.stringify({ roots: ['/project', '/old/project'], sessions: { lead: { cwd: '/project', device: 'runner', provider: 'codex', session_id: 'real-id' } } }) };
describe('explicit source location maintenance', () => {
  it('persists audited revisions independently of display titles and source generation', () => {
    const result = research_set_source_locations(ctx(), params);
    const next = projectIncremental(ctx().state, result.events);
    expect(next.source_locations).toMatchObject({ revision: 1, roots: ['/project', '/old/project'], sessions: { lead: { session_id: 'real-id' } } });
    expect(() => research_set_source_locations({ ...ctx(), state: next }, params)).toThrow('已更新');
  });
  it.each(['member', 'viewer'])('does not let %s rewrite project execution targets', role => {
    expect(() => research_set_source_locations({ ...ctx(), actor: { role } }, params)).toThrow('Owner');
  });
  it.each([
    { roots: ['项目标题'], sessions: {} },
    { roots: ['/'], sessions: {} },
    { roots: ['/project/../outside'], sessions: {} },
    { roots: ['/project'], sessions: { unknown: { cwd: '/project' } } },
    { roots: ['/project'], sessions: { lead: { cwd: '/project', device: 'runner' } } },
  ])('refuses malformed or unbound mapping %j', locations => {
    expect(() => research_set_source_locations(ctx(), { ...params, locations: JSON.stringify(locations) })).toThrow();
  });
});
