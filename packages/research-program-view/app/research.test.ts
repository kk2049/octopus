import { describe, expect, it } from 'vitest';
import * as actions from './research-actions.js';
import { project, projectIncremental } from './projection.js';
import { research_import_chat } from './actions.js';
function harness() {
    const events: any[] = [];
    let actor = { kind: 'agent', user: 'alice', role: 'member' };
    return {
        events, setActor: (value: typeof actor) => { actor = value; },
        state: () => project(events),
        call(name: keyof typeof actions, params: Record<string, string>) {
            const fn = actions[name] as (ctx: any, params: any) => any;
            const out = fn({ state: project(events), actor, now: '2026-09-05T04:00:00Z' }, params);
            for (const event of out.events)
                events.push({ ...event, seq: events.length + 1, by: actor.kind === 'user' ? `user:${actor.user}` : `agent:mcp@${actor.user}` });
            return out;
        },
    };
}
function prepare(h = harness(), suffix = '') {
    h.call('research_record', { record: `data${suffix}`, kind: 'dataset', title: 'Raw measurements', body: 'seed=42; n=10; SHA abc', origin: 'imported' });
    h.call('research_fork', { branch: `test${suffix}`, from: `data${suffix}`, title: 'Experiment', purpose: 'Investigate the mechanism' });
    h.call('research_transition', { branch: `test${suffix}`, expected_status: 'proposed', status: 'active', reason: 'Begin' });
    h.call('research_record', { record: `result${suffix}`, kind: 'claim', title: 'Result', body: 'No significant improvement', parents: JSON.stringify([`data${suffix}`]), links: JSON.stringify([{ relation: 'supports', target: `data${suffix}` }]) });
    h.call('research_advance', { branch: `test${suffix}`, expected_head: `data${suffix}`, record: `result${suffix}`, reason: 'Measured' });
    h.call('research_deliver', { branch: `test${suffix}`, expected_head: `result${suffix}`, record: `delivery${suffix}`, title: 'Review the negative result', evidence: JSON.stringify([`data${suffix}`, `result${suffix}`]), summary: 'No improvement', reproduce: 'Run command with seed=42', limitations: 'Small n', question: 'Accept the scoped negative result?' });
    return h;
}
function approve(h: ReturnType<typeof harness>, record = 'delivery', main = '') {
    h.setActor({ kind: 'user', user: 'alice', role: 'member' });
    h.call('research_attest', { record, kind: 'understood', response: 'I understand the baseline and limited sample.', main });
    h.call('research_attest', { record, kind: 'approve', response: 'Accept only for the measured workload.', main });
}
describe('research collaboration state machine', () => {
    it('preserves forks, negative evidence, separate learning and approval, then a merge commit', () => {
        const h = prepare();
        expect(() => h.call('research_merge', { branch: 'test', expected_head: 'delivery', expected_main: '', record: 'merge', reason: 'Accept' })).toThrow('同一真人');
        expect(() => h.call('research_attest', { record: 'delivery', kind: 'approve', response: 'The user agrees' })).toThrow('本人');
        approve(h);
        h.setActor({ kind: 'agent', user: 'alice', role: 'member' });
        h.call('research_merge', { branch: 'test', expected_head: 'delivery', expected_main: '', record: 'merge', reason: 'Scoped negative result accepted' });
        expect(h.state().research.main).toBe('merge');
        expect(h.state().research.branches[0]).toMatchObject({ status: 'merged', created_by: 'agent:mcp@alice' });
        expect(h.state().research.records.at(-1).parents).toEqual(['delivery']);
        expect(h.state().research.attestations.map((a: any) => a.kind)).toEqual(['understood', 'approve']);
        expect(h.state().research.records[0].source_level).toBe('imported');
    });
    it('refuses cycles, invented evidence and overwriting a concurrent head', () => {
        const h = prepare();
        expect(() => h.call('research_record', { record: 'loop', kind: 'note', title: 'Cycle', body: 'x', parents: '["loop"]' })).toThrow('不存在');
        expect(() => h.call('research_record', { record: 'data', kind: 'note', title: 'Overwrite', body: 'x' })).toThrow('已存在');
        expect(() => h.call('research_advance', { branch: 'test', expected_head: 'result', record: 'data', reason: 'Stale' })).toThrow('head 已变化');
        expect(() => h.call('research_transition', { branch: 'test', expected_status: 'active', status: 'paused', reason: 'Stale' })).toThrow('状态已变化');
    });
    it('requires re-review when another branch advances the mainline', () => {
        const h = prepare();
        prepare(h, '2');
        approve(h, 'delivery');
        approve(h, 'delivery2');
        h.call('research_merge', { branch: 'test', expected_head: 'delivery', expected_main: '', record: 'merge', reason: 'First' });
        expect(() => h.call('research_merge', { branch: 'test2', expected_head: 'delivery2', expected_main: '', record: 'merge2', reason: 'Stale approval' })).toThrow('主线已前移');
        expect(project(h.events, { viewer: { user: 'alice', role: 'member', kind: 'user' } }).research.branches[1].review_stale).toBe(true);
        h.call('research_deliver', { branch: 'test2', expected_head: 'delivery2', record: 'delivery3', title: 'Compatible with the accepted result', evidence: '["data2","result2"]', summary: 'No conflicting interpretation', reproduce: 'Same seed', limitations: 'Small n', question: 'Accept on the new mainline?' });
        approve(h, 'delivery3', 'merge');
        h.call('research_merge', { branch: 'test2', expected_head: 'delivery3', expected_main: 'merge', record: 'merge2', reason: 'Compatible results' });
        expect(h.state().research.records.at(-1).parents).toEqual(['merge', 'delivery3']);
    });
    it('does not combine one person learning with another person approving, and honors withdrawal', () => {
        const h = prepare();
        h.setActor({ kind: 'user', user: 'alice', role: 'member' });
        h.call('research_attest', { record: 'delivery', kind: 'understood', response: 'Learned', main: '' });
        h.setActor({ kind: 'user', user: 'bob', role: 'member' });
        expect(() => h.call('research_attest', { record: 'delivery', kind: 'approve', response: 'Agree', main: '' })).toThrow('先明确确认已理解');
        approve(h);
        h.call('research_attest', { record: 'delivery', kind: 'withdraw', response: 'Found a confound', main: '' });
        expect(() => h.call('research_merge', { branch: 'test', expected_head: 'delivery', expected_main: '', record: 'merge', reason: 'Ignore withdrawal' })).toThrow('同一真人');
    });
    it('requires independent approval of critical upstream judgments', () => {
        const h = harness();
        h.call('research_record', { record: 'decision', kind: 'decision', title: 'Change the baseline', body: 'Proposal only' });
        h.call('research_fork', { branch: 'b', from: 'decision', title: 'Work', purpose: 'Explore' });
        h.call('research_transition', { branch: 'b', expected_status: 'proposed', status: 'active', reason: 'Begin' });
        h.call('research_deliver', { branch: 'b', expected_head: 'decision', record: 'delivery', title: 'Delivery', evidence: '["decision"]', summary: 'Claim', reproduce: 'Steps', limitations: 'Small', question: 'Accept?' });
        approve(h);
        expect(() => h.call('research_merge', { branch: 'b', expected_head: 'delivery', expected_main: '', record: 'merge', reason: 'Accept' })).toThrow('关键判断');
    });
    it('derives per-person learning and cursors without leaking another person’s private cursor', () => {
        const h = prepare();
        approve(h);
        h.call('research_mark_seen', { through: '5' });
        const alice = project(h.events, { viewer: { kind: 'user', user: 'alice', role: 'member' } });
        const bob = project(h.events, { viewer: { kind: 'user', user: 'bob', role: 'member' } });
        expect(alice.research.records.at(-1).understood_by_me).toBe(true);
        expect(bob.research.records.at(-1).understood_by_me).toBe(false);
        expect(alice.research.seen_through).toBe(5);
        expect(bob.research.seen_through).toBe(0);
        expect(bob.research).not.toHaveProperty('seen');
        expect(project(h.events, { viewer: { kind: 'agent', agent: 'secretary', role: 'member' } }).research.controls.can_attest).toBe(false);
        expect(project(h.events, { viewer: { role: 'member' } }).available).toBe(false);
        expect(projectIncremental(project(h.events.slice(0, 4)), h.events.slice(4))).toEqual(h.state());
    });
    it('propagates supersession for review without erasing historical conclusions', () => {
        const h = prepare();
        h.call('research_record', { record: 'correction', kind: 'claim', title: 'Corrected units', body: 'Measurements were microseconds', links: '[{"relation":"supersedes","target":"data"}]' });
        const view = project(h.events, { viewer: { user: 'alice', role: 'member' } });
        expect(view.research.records.find((r: any) => r.id === 'data').superseded).toBe(true);
        expect(view.research.records.find((r: any) => r.id === 'delivery').needs_recheck).toBe(true);
    });
    it('honors withdrawal of an already merged delivery when a later branch depends on the mainline', () => {
        const h = prepare(); approve(h);
        h.call('research_merge', { branch: 'test', expected_head: 'delivery', expected_main: '', record: 'main', reason: 'Accept limited result' });
        h.call('research_attest', { record: 'delivery', kind: 'withdraw', response: 'The original baseline was invalid', main: '' });
        h.call('research_fork', { branch: 'next', from: 'main', title: 'Follow-up', purpose: 'Continue from main' });
        h.call('research_transition', { branch: 'next', expected_status: 'proposed', status: 'active', reason: 'Begin' });
        h.call('research_deliver', { branch: 'next', expected_head: 'main', record: 'next-delivery', title: 'Follow-up result', evidence: '["data"]', summary: 'Follow-up', reproduce: 'Same baseline', limitations: 'Small n', question: 'Accept?' });
        approve(h, 'next-delivery', 'main');
        expect(() => h.call('research_merge', { branch: 'next', expected_head: 'next-delivery', expected_main: 'main', record: 'next-main', reason: 'Ignore withdrawn foundation' })).toThrow('关键判断');
        expect(project(h.events, { viewer: { kind: 'user', user: 'alice', role: 'member' } }).research.records.find((r: any) => r.id === 'main').needs_recheck).toBe(true);
    });
    it('distinguishes a real person’s authored note from an agent inference without inventing approval', () => {
        const h = harness(); h.setActor({ kind: 'user', user: 'alice', role: 'member' });
        h.call('research_record', { record: 'note', kind: 'note', title: 'My observation', body: 'Needs a new baseline' });
        expect(h.state().research.records[0].source_level).toBe('human_authored');
        expect(h.state().research.attestations).toEqual([]);
    });
    it('queries are read-only, paginated, role-gated and available after archive', () => {
        const h = prepare();
        const state = h.state();
        state.project.archived = true;
        const ctx = { state, actor: { kind: 'user', user: 'bob', role: 'viewer' } };
        expect(actions.research_query(ctx, { query: 'seed=42' })).toMatchObject({ events: [], result: { total: 2 } });
        expect(() => actions.research_fork(ctx, { branch: 'x', title: 'x', purpose: 'x' })).toThrow('角色');
        expect(() => actions.research_query({ state, actor: {} }, {})).toThrow('角色');
    });
    it('quotes only authenticated original input, preserving the requester separately from the agent author', () => {
        const ctx = { state: project([]), actor: { kind: 'agent', role: 'member' }, history: { events: [{ seq: 7, type: 'sys_agent_inbox', by: 'user:bob', data: { to: 'secretary', text: '请先检查单位，再讨论结论。', owner: 'private-owner' } }], cursor: 7, hasMore: false, head: 7 } };
        const result = actions.research_capture_requirement(ctx, { record: 'request', title: '核对单位' });
        const quoted = project(result.events.map((event: any) => ({ ...event, seq: 1, by: 'agent:secretary' })));
        expect(actions.research_query({ ...ctx, state: quoted }, { author: 'user:bob' }).result.total).toBe(1);
        expect(result.events[0]?.data).toMatchObject({ body: '请先检查单位，再讨论结论。', origin_by: 'user:bob', source_level: 'user_direct', source: 'event:7' });
        expect(actions.research_read_history(ctx, {}).result.events[0]).toMatchObject({ type: 'secretary_question', data: { text: '请先检查单位，再讨论结论。' } });
        expect(actions.research_read_history(ctx, {}).result.events[0]?.data).not.toHaveProperty('owner');
        for (const source of [
            { type: 'chat_message_imported', by: 'agent:mcp', data: { role: 'user', text: 'Approved' } },
            { type: 'chat_message_published', by: 'agent:mcp', data: { role: 'user', text: 'Approved' } },
        ])
            expect(() => actions.research_capture_requirement({ ...ctx, history: { ...ctx.history, events: [source] } }, { record: 'fake', title: 'Pretend' })).toThrow('真人原始输入');
    });
});
describe('research transcript ingestion', () => {
    it('bounds pending secretary text while preserving full original questions in history', () => {
        const text = '重要研究要求。'.repeat(400);
        const events = Array.from({ length: 80 }, (_, i) => ({ seq: i + 1, type: 'sys_agent_inbox', by: 'user:alice', at: '2026-09-05', data: { to: 'secretary', text } }));
        const state = project(events);
        expect(JSON.stringify(state.secretary_messages).length).toBeLessThan(49000);
        expect(state.secretary_messages.at(-1).text).toBe(text);
        expect(actions.research_read_history({ state, actor: { role: 'viewer' }, history: { events: events.slice(0, 1), cursor: 1, hasMore: true, head: 80 } }, {}).result.events[0].data.text).toBe(text);
    });
    it('imports contiguous source batches idempotently, retains attribution and counts beyond the view tail', () => {
        const registration = { type: 'agent_session_published', at: '2026-09-05', by: 'agent:importer', seq: 1, data: { agent_key: 'a', workspace_key: 'w', session_key: 's', agent_label: 'Archive', provider: 'codex' } };
        const events: any[] = [registration];
        let state = project(events);
        for (let i = 0; i < 250; i++) {
            const params = { session_key: 's', offset: String(i), batch_id: `batch-${i}`, messages_json: JSON.stringify([{ role: 'user', text: `Source ${i}`, timestamp: '2026-08-20' }]) };
            const out = research_import_chat({ state, actor: { role: 'member', kind: 'agent' } }, params);
            const start = events.length;
            out.events.forEach((e: any) => events.push({ ...e, by: 'agent:importer', seq: events.length + 1 }));
            state = projectIncremental(state, events.slice(start));
            expect(research_import_chat({ state, actor: { role: 'member', kind: 'agent' } }, params).result.duplicate).toBe(true);
        }
        expect(project(events)).toEqual(state);
        expect(state.transcripts.s.messages).toHaveLength(240);
        expect(state.sessions[0].messageCount).toBe(250);
        expect(state.transcripts.s).toMatchObject({ offset: 10, totalMessages: 250, hasMore: true });
        expect(state.research.attestations).toEqual([]);
        const page = actions.research_read_history({ state, actor: { kind: 'user', user: 'alice', role: 'viewer' }, history: { events: events.slice(1, 5), cursor: 5, hasMore: true, head: 251 } }, { session: 's' });
        expect(page.result.events[0].data.text).toBe('Source 0');
        expect(page.events).toEqual([]);
    });
});
