import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentViewProvider } from '@claude-bot/agent-view-react';
import { createFixtureAgentViewClient } from '@claude-bot/agent-view-preview';
import { ResearchProgramProvider } from './runtime.js';
import { ResearchWorkbench } from './ResearchWorkbench.js';
import { project } from '../app/projection.js';
import type { ResearchProjection } from './model.js';
const node = { id: 'delivery-1', kind: 'delivery', title: '对照实验交付', body: '# 结果\n\n没有显著提升。<script>bad()</script>', parents: [], links: [], source: 'report@sha256:abc', source_level: 'infer', critical: true, tags: [] };
function view(role = 'member', archived = false): ResearchProjection {
    return project([
        { type: 'research_forked', by: 'agent:worker', at: '2026-09-05', seq: 1, data: { id: 'b', title: '基线对照', purpose: '检查混杂', head: '', base: '', status: 'active', delivery: '', review_main: '' } },
        { type: 'research_delivered', by: 'agent:worker', at: '2026-09-05', seq: 2, data: { branch: 'b', record: node, main: '' } },
        ...(archived ? [{ type: 'project_archived', by: 'user:alice', at: '2026-09-05', seq: 3, data: { reason: 'Frozen' } }] : []),
    ], { viewer: { user: 'alice', kind: 'user', role } });
}
function mount(projection = view(), propose = vi.fn().mockResolvedValue({ ok: true, message: '' })) {
    const fixture = createFixtureAgentViewClient({ projection: { ...projection } });
    function tree(value: ResearchProjection) { return <AgentViewProvider client={fixture.client}><ResearchProgramProvider value={{ projection: value, channelOpen: true, propose }}><ResearchWorkbench /></ResearchProgramProvider></AgentViewProvider>; }
    const rendered = render(tree(projection));
    return { propose, update: (v: ResearchProjection) => rendered.rerender(tree(v)) };
}
describe('ResearchWorkbench human participation', () => {
    it('shows an actionable return window and exact version-scoped personal learning', async () => {
        const h = mount();
        expect(screen.getByRole('heading', { name: '回到项目' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '审阅交付：基线对照' }));
        expect(screen.getByRole('button', { name: '明确批准' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('我的理解或明确意见（仅代表本人）'), { target: { value: '理解了负结果和小样本的限制。' } });
        fireEvent.click(screen.getByRole('button', { name: '已理解' }));
        await waitFor(() => expect(h.propose).toHaveBeenCalledWith('research_attest', { record: 'delivery-1', kind: 'understood', response: '理解了负结果和小样本的限制。', main: '' }));
        expect(document.querySelector('script')).toBeNull();
        expect(screen.getByText('Agent infer')).toBeInTheDocument();
    });
    it('preserves a refused response and prevents duplicate submission while pending', async () => {
        let resolve!: (value: unknown) => void;
        const propose = vi.fn().mockImplementation(() => new Promise(r => { resolve = r; }));
        mount(view(), propose);
        fireEvent.click(screen.getByRole('button', { name: '审阅交付：基线对照' }));
        const draft = screen.getByLabelText('我的理解或明确意见（仅代表本人）');
        fireEvent.change(draft, { target: { value: '保留我的判断' } });
        fireEvent.click(screen.getByRole('button', { name: '不同意' }));
        fireEvent.click(screen.getByRole('button', { name: '不同意' }));
        expect(propose).toHaveBeenCalledTimes(1);
        await act(async () => resolve({ ok: false, message: '分支已变化' }));
        expect(await screen.findByText('分支已变化')).toBeInTheDocument();
        expect(draft).toHaveValue('保留我的判断');
    });
    it('retains record selection and a draft across unrelated or temporarily missing projections', () => {
        const h = mount();
        fireEvent.click(screen.getByRole('button', { name: '审阅交付：基线对照' }));
        fireEvent.change(screen.getByLabelText('我的理解或明确意见（仅代表本人）'), { target: { value: '草稿' } });
        const next = view();
        next.research!.records = [];
        h.update(next);
        expect(screen.getByText(/所选记录暂未出现在当前投影/)).toBeInTheDocument();
        h.update(view());
        expect(screen.getByLabelText('我的理解或明确意见（仅代表本人）')).toHaveValue('草稿');
    });
    it.each([['viewer', false], ['member', true]])('keeps %s archived=%s read-only', (role, archived) => {
        mount(view(role as string, archived as boolean));
        expect(screen.queryByRole('button', { name: '新研究分支' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '审阅交付：基线对照' }));
        expect(screen.queryByLabelText('我的理解或明确意见（仅代表本人）')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '科研秘书' }));
        expect(screen.queryByRole('button', { name: '交给科研秘书' })).toBeNull();
    });
    it('sends a real secretary action without pretending a local echo is an answer', async () => {
        const h = mount();
        fireEvent.click(screen.getByRole('button', { name: '科研秘书' }));
        fireEvent.change(screen.getByLabelText('问秘书 / 交代下一步'), { target: { value: '教我理解最近的负结果' } });
        fireEvent.click(screen.getByRole('button', { name: '交给科研秘书' }));
        await waitFor(() => expect(h.propose).toHaveBeenCalledWith('ask_secretary', { prompt: '教我理解最近的负结果' }));
    });
});
