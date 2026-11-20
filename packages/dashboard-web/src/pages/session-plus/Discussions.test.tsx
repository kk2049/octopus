import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiscussionDetail } from '../../contract.js';
import { Meeting, Discussions } from './Discussions.js';
import { renderPage } from '../../test-utils.js';

const room = (): DiscussionDetail => ({ id: 'meeting-one', topic: '科研议题', agenda: '比较实验', convener: 'lht', members: ['lht', 'lilei'], writable: true, status: 'active', settings: { filter: { model: 'gpt-5.6-sol', effort: 'low', prompt: '快速过滤' }, secretary: { model: 'gpt-6-astra', effort: 'high', prompt: '会议秘书' }, maxToolTurns: 12, maxRepliesPerTurn: 3 }, revision: 1, memory: '', activity: 'thinking', activityText: '正在整理', createdAt: 'now', updatedAt: 'now', events: [{ seq: 1, agent: 'secretary', kind: 'note', text: '<img src=x onerror="alert(1)">', created_at: 'now' }], messages: [], uncertainDeliveries: [] });

describe('Sessions+ discussion pane', () => {
  it('renders activities safely and preserves the composer across authoritative refreshes', () => {
    const first = room(); const view = render(<Meeting room={first} refresh={vi.fn()} />);
    expect(screen.getByText(first.events[0]!.text)).toBeInTheDocument(); expect(document.querySelector('img')).toBeNull();
    const input = screen.getByRole('textbox', { name: '给秘书的补充（会议成员可见）' });
    fireEvent.change(input, { target: { value: '先保存我的想法' } }); input.focus();
    view.rerender(<Meeting room={{ ...first, activityText: '正在查历史', updatedAt: 'later' }} refresh={vi.fn()} />);
    expect(input).toHaveValue('先保存我的想法'); expect(input).toHaveFocus();
  });
  it('submits one bounded append and keeps edits made while the receipt is pending', async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal('fetch', fetcher);
    const refresh = vi.fn(async () => undefined); render(<Meeting room={room()} refresh={refresh} />);
    const input = screen.getByRole('textbox', { name: '给秘书的补充（会议成员可见）' });
    fireEvent.change(input, { target: { value: '一个新问题' } }); fireEvent.click(screen.getByRole('button', { name: '追加给秘书' }));
    expect(screen.getByRole('button', { name: '正在提交…' })).toBeDisabled();
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(sent).toEqual({ action: 'discussion_append', args: { discussion_id: 'meeting-one', text: '一个新问题', request_id: expect.any(String) } });
    fireEvent.change(input, { target: { value: '另一个未发送的想法' } });
    resolve(new Response(JSON.stringify({ result: { accepted: true } }), { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); expect(input).toHaveValue('另一个未发送的想法');
  });
  it('keeps the edit revision and draft when concurrent configuration changes are refused', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: '会议配置已改变' }), { status: 400 })); vi.stubGlobal('fetch', fetcher);
    const view = render(<Meeting room={room()} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '模型与提示词' }));
    const input = screen.getByRole('textbox', { name: '模型配置 JSON' });
    fireEvent.change(input, { target: { value: '{"filter":{"effort":"medium"}}' } });
    view.rerender(<Meeting room={{ ...room(), revision: 2 }} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('会议配置已改变'); expect(input).toHaveValue('{"filter":{"effort":"medium"}}');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).args.revision).toBe(1);
  });
  it('keeps closed meetings readable without writable controls', () => {
    render(<Meeting room={{ ...room(), status: 'closed' }} refresh={vi.fn()} />);
    expect(screen.getByText('科研议题')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '追加给秘书' })).toBeNull();
    expect(screen.queryByRole('button', { name: '模型与提示词' })).toBeNull();
  });
  it('loads local meeting state only when the trusted pane is opened', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ enabled: true, canConvene: true, discussions: [room()] }), { status: 200 })); vi.stubGlobal('fetch', fetcher);
    renderPage(<Discussions />, '/sessions-plus');
    expect(fetcher).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '会议' }));
    expect(await screen.findByText('科研议题')).toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/api/discussions');
  });
});
