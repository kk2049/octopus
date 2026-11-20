import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceMarkdown } from '@claude-bot/agent-file-preview';
import type { AnyWorkspaceFilesPort } from '@claude-bot/workspace-files-contract';

const location = { rootRef: 'bound-root', labels: ['reports', 'current.md'] };
function port(resolvePath: unknown) { return { resolvePath } as AnyWorkspaceFilesPort; }

describe('shared Markdown file links', () => {
  it('passes a decoded Markdown path and the exact source file to the owner link resolver', async () => {
    const resolve = vi.fn(async () => ({ ok: false as const, message: 'not found' }));
    render(<WorkspaceMarkdown text="[下一份](../report%20v2.pdf#page=2)" sourceRef="file-current"
      location={location} port={port(vi.fn())} links={{ resolve }} onOpenFile={() => true} />);
    fireEvent.click(screen.getByRole('link', { name: '下一份' }));
    await screen.findByText('not found');
    expect(resolve).toHaveBeenCalledWith({ href: '../report v2.pdf', fileRef: 'file-current', location });
  });
  it('resolves a relative document once through the supplied port and preserves directory context', async () => {
    let complete!: (value: unknown) => void;
    const resolve = vi.fn(() => new Promise(r => { complete = r; }));
    const open = vi.fn(() => true);
    render(<WorkspaceMarkdown text="[下一份](../results/next.md)" location={location} port={port(resolve)} onOpenFile={open} />);
    fireEvent.click(screen.getByRole('link', { name: '下一份' }));
    fireEvent.click(screen.getByRole('link', { name: '下一份' }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('bound-root', ['results', 'next.md']);
    complete({ ok: true, value: { ref: 'bound-next', label: 'next.md', kind: 'file' } });
    await waitFor(() => expect(open).toHaveBeenCalledWith('bound-next', 'next.md', { rootRef: 'bound-root', labels: ['results', 'next.md'] }));
  });

  it('shows an authoritative refusal without retry and blocks an above-root link', async () => {
    const resolve = vi.fn(async () => ({ ok: false, code: 'not_found', message: '未绑定这份文档' }));
    const open = vi.fn(() => true);
    render(<WorkspaceMarkdown text="[缺失](missing.md) [越界](../../secret.md)" location={location} port={port(resolve)} onOpenFile={open} />);
    fireEvent.click(screen.getByRole('link', { name: '缺失' }));
    await screen.findByText('未绑定这份文档');
    fireEvent.click(screen.getByRole('link', { name: '越界' }));
    expect(resolve).toHaveBeenCalledTimes(1);expect(open).not.toHaveBeenCalled();
  });

  it('does not open a late answer after changing the displayed document', async () => {
    let complete!: (value: unknown) => void;
    const source = port(vi.fn(() => new Promise(r => { complete = r; })));
    const open = vi.fn(() => true);
    const view = render(<WorkspaceMarkdown text="[下一份](next.md)" location={location} port={source} onOpenFile={open} />);
    fireEvent.click(screen.getByRole('link', { name: '下一份' }));
    view.rerender(<WorkspaceMarkdown text="另一份报告" location={location} port={source} onOpenFile={open} />);
    complete({ ok: true, value: { ref: 'late-ref', label: 'next.md', kind: 'file' } });
    await new Promise(r => setTimeout(r, 0));expect(open).not.toHaveBeenCalled();
  });

  it('ends an unanswered read and ignores the late success without retrying', async () => {
    vi.useFakeTimers();
    try {
      let complete!: (value: unknown) => void;
      const resolve = vi.fn(() => new Promise(r => { complete = r; }));
      const open = vi.fn(() => true);
      render(<WorkspaceMarkdown text="[下一份](next.md)" location={location} port={port(resolve)} onOpenFile={open} />);
      fireEvent.click(screen.getByRole('link', { name: '下一份' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
      expect(screen.getByRole('status').textContent).toContain('未收到答复');
      complete({ ok: true, value: { ref: 'late-ref', label: 'next.md', kind: 'file' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(open).not.toHaveBeenCalled();expect(resolve).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
