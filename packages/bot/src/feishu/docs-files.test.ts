import { describe, expect, it, vi } from 'vitest';
import { compareWorkspaceListPositions, readWorkspaceListCursor } from '@claude-bot/workspace-files-contract';
import { collectDocsFile, deriveLayout, DocsWorkspaceFiles, locate, mimeOf, type Layout } from './docs-files.js';
import type { WorkspaceFilesCapabilities } from '../workspace-files/capability.js';

const WS_HOME = 'ws_' + '0'.repeat(24);
const WS_PAPER = 'ws_' + '1'.repeat(24);
const WS_DATA = 'ws_' + '2'.repeat(24);
const snapshot = {
  device: 'laptop',
  roots: [
    { workspaceId: WS_HOME, label: 'Home', display: '~' },
    { workspaceId: WS_PAPER, label: 'paper', display: '~/lht/repos/paper' },
    { workspaceId: WS_DATA, label: 'data', display: '~/…/data' },
  ],
  sessionDirectories: [
    { source: 'claude' as const, id: 's1', workspaceId: WS_PAPER, relativePath: 'experiments' },
    { source: 'codex' as const, id: 's2', workspaceId: WS_HOME, relativePath: 'notes' },
    { source: 'codex' as const, id: 's3', workspaceId: WS_DATA, relativePath: '' },
  ],
};
const cwds = new Map([
  ['claude\u0000s1', '/home/u/lht/repos/paper/experiments'],
  ['codex\u0000s2', '/home/u/notes/'],
  ['codex\u0000s3', '/mnt/data'],
]);

describe('deriveLayout', () => {
  it('recovers each workspace root from a session cwd minus its path inside the workspace', () => {
    const layout = deriveLayout(snapshot, cwds);
    expect(layout.roots.map((r) => [r.label, r.root])).toEqual([['Home', '/home/u'], ['paper', '/home/u/lht/repos/paper'], ['data', '/mnt/data']]);
    expect(layout.home).toBe('/home/u');
  });

  it('leaves a root unknown when the cwd does not end with the reported path', () => {
    const layout = deriveLayout(snapshot, new Map([['claude\u0000s1', '/elsewhere/x']]));
    expect(layout.roots.find((r) => r.label === 'paper')?.root).toBeUndefined();
  });
});

describe('locate', () => {
  const layout: Layout = deriveLayout(snapshot, cwds);
  const s1 = { cliKind: 'claude', sessionId: 's1' };
  it('maps relative, absolute and ~ mentions into the deepest containing workspace', () => {
    expect(locate(layout, s1, 'results/fig.png')).toMatchObject({ workspace: { label: 'paper' }, relativePath: 'experiments/results/fig.png' });
    expect(locate(layout, s1, '../README.md')).toMatchObject({ workspace: { label: 'paper' }, relativePath: 'README.md' });
    expect(locate(layout, s1, '/home/u/lht/repos/paper/draft.pdf')).toMatchObject({ workspace: { label: 'paper' }, relativePath: 'draft.pdf' });
    expect(locate(layout, s1, '~/notes/todo.md')).toMatchObject({ workspace: { label: 'Home' }, relativePath: 'notes/todo.md' });
    expect(locate(layout, s1, '/mnt/data/')).toMatchObject({ workspace: { label: 'data' }, relativePath: '' });
  });

  it('uses the cwd of a session the Runner did not place in any workspace', () => {
    const outside = deriveLayout(snapshot, new Map([...cwds, ['claude\u0000s9', '/home/u/lht/repos/paper/scratch']]));
    expect(locate(outside, { cliKind: 'claude', sessionId: 's9' }, 'out.csv')).toMatchObject({ workspace: { label: 'paper' }, relativePath: 'scratch/out.csv' });
  });

  it('refuses what no registered workspace contains', () => {
    expect(locate(layout, s1, '/etc/passwd')).toBeNull();
    expect(locate(layout, s1, '/home/u/../../etc/passwd')).toBeNull();
  });

  it('without a known root, joins a relative mention onto the session place and never climbs out', () => {
    const blind = deriveLayout(snapshot, new Map());
    expect(locate(blind, s1, 'results/fig.png')).toMatchObject({ workspace: { label: 'paper' }, relativePath: 'experiments/results/fig.png' });
    expect(locate(blind, s1, '../../x')).toBeNull();
    expect(locate(blind, s1, '/home/u/lht/repos/paper/draft.pdf')).toBeNull();
  });
});

it('serves media by type and never hands active content to the card', () => {
  expect(mimeOf('fig.PNG')).toBe('image/png');
  expect(mimeOf('a.svg')).toBe('image/svg+xml');
  expect(mimeOf('page.html')).toBe('text/plain');
  expect(mimeOf('train.py')).toBe('text/plain');
  expect(mimeOf('weights.safetensors')).toBe('application/octet-stream');
});

describe('DocsWorkspaceFiles', () => {
  /** A device that answers the workspace-files operations the way the Runner does. */
  function device(files: Record<string, string>, placements?: Record<string, Record<string, unknown>>) {
    const request = vi.fn(async (operation: string, args: Record<string, unknown>) => {
      // A current Runner answers "where is this path" itself; an older one ignores `path`.
      if (operation === 'list_session_workspaces' && args.path !== undefined && placements) {
        return { status: 'succeeded', result: placements[String(args.path)] ?? { placement: null, reason: 'outside' } };
      }
      if (operation === 'list_session_workspaces') {
        return { status: 'succeeded', result: { workspaces: snapshot.roots.map((r) => ({ id: r.workspaceId, label: r.label, display: r.display })),
          session_directories: snapshot.sessionDirectories.map((d) => ({ source: d.source, id: d.id, workspace_id: d.workspaceId, relative_path: d.relativePath })) } };
      }
      const path = String(args.relative_path);
      if (operation === 'read_workspace_binary') {
        const body = files[path];
        if (body === undefined) return { status: 'succeeded', result: { status: 'refused', code: path in dirs ? 'not_a_directory' : 'not_found' } };
        const bytes = Buffer.from(body);
        const offset = Number(args.offset);
        const slice = bytes.subarray(offset, offset + Number(args.max_bytes));
        return { status: 'succeeded', result: { status: 'ok', encoding: 'base64', workspace_id: args.workspace_id, relative_path: path, offset, bytes: slice.length, size: bytes.length,
          eof: offset + slice.length >= bytes.length, digest: 'sha256:' + 'a'.repeat(64), modified_at: '2026-10-18T00:00:00.000Z', data: slice.toString('base64') } };
      }
      if (operation === 'list_workspace_entries') {
        return { status: 'succeeded', result: { status: 'ok', workspace_id: args.workspace_id, relative_path: path, truncated: false,
          entries: (dirs[path] ?? []).map((name) => ({ name, kind: name.includes('.') ? 'file' : 'directory', relative_path: path ? `${path}/${name}` : name, ...(name.includes('.') ? { size: 3, modified_at: '2026-10-18T00:00:00.000Z' } : {}) })) } };
      }
      throw new Error(operation);
    });
    const dirs: Record<string, string[]> = { 'experiments/results': ['fig.png', 'plots'] };
    const open = vi.fn(() => ({ request, destroy: vi.fn() }));
    return { open, request, capabilities: { open } as unknown as WorkspaceFilesCapabilities };
  }

  it('reads a mentioned file through read-only pooled rights, and lists a directory', async () => {
    const { capabilities, open, request } = device({ 'experiments/results/fig.png': 'PNG' });
    const files = new DocsWorkspaceFiles(capabilities, async () => cwds);
    const session = { owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: 's1' };
    const target = await files.resolve(session, 'results/fig.png');
    const file = await files.read('alice', 'laptop', target);
    expect(file).toMatchObject({ kind: 'file', name: 'fig.png', size: 3, path: 'experiments/results/fig.png' });
    expect(file.kind === 'file' && (await collectDocsFile(file, 16, 'too large')).toString()).toBe('PNG');
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice', device: 'laptop', rights: ['list_session_workspaces', 'list_workspace_entries', 'read_workspace_binary'], autoAllow: ['list_session_workspaces', 'list_workspace_entries', 'read_workspace_binary'], pool: 'feishu-docs-files:laptop' }));
    const listing = await files.read('alice', 'laptop', await files.resolve(session, 'results'));
    expect(listing).toMatchObject({ kind: 'dir', entries: [{ name: 'plots', dir: true }, { name: 'fig.png', dir: false }] });
    expect(request.mock.calls.filter(([op, args]) => op === 'list_session_workspaces' && args.path === undefined)).toHaveLength(1);
  });

  it('lists a directory of any length page by page through the device cursor, each entry once', async () => {
    const { capabilities, request } = device({});
    // 1,203 entries: more than two device pages of 500, mixed kinds.
    const names = Array.from({ length: 1_203 }, (_, i) => i % 3 ? `f${String(i).padStart(4, '0')}.txt` : `d${String(i).padStart(4, '0')}`);
    const kindOf = (name: string) => name.includes('.') ? 'file' : 'directory';
    const ordered = [...names].sort((a, b) => compareWorkspaceListPositions({ kind: kindOf(a), label: a }, { kind: kindOf(b), label: b }));
    const original = request.getMockImplementation()!;
    let echo = true;
    request.mockImplementation(async (operation: string, args: Record<string, unknown>) => {
      if (operation !== 'list_workspace_entries' || args.relative_path !== 'experiments/big') return original(operation, args);
      const position = typeof args.after === 'string' ? readWorkspaceListCursor(args.after) : null;
      const rest = position ? ordered.filter((name) => compareWorkspaceListPositions({ kind: kindOf(name), label: name }, position) > 0) : ordered;
      const page = rest.slice(0, Number(args.limit));
      return { status: 'succeeded', result: { status: 'ok', workspace_id: args.workspace_id, relative_path: args.relative_path,
        truncated: rest.length > page.length, ...(echo && args.after !== undefined ? { after: args.after } : {}),
        entries: page.map((name) => ({ name, kind: kindOf(name), relative_path: `experiments/big/${name}`, ...(kindOf(name) === 'file' ? { size: 1 } : {}) })) } };
    });
    const files = new DocsWorkspaceFiles(capabilities, async () => cwds);
    const session = { owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: 's1' };
    const target = await files.resolve(session, 'big/');
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 1; ; pages += 1) {
      const listing = await files.read('alice', 'laptop', target, true, after);
      if (listing.kind !== 'dir') throw new Error('expected a listing');
      expect(listing.entries.length).toBeLessThanOrEqual(500);
      seen.push(...listing.entries.map((entry) => entry.name));
      if (!listing.next) { expect(pages).toBe(3); expect(listing.truncated).toBe(false); break; }
      expect(listing.truncated).toBe(true);
      after = listing.next;
    }
    expect([...seen].sort()).toEqual([...names].sort());
    expect(new Set(seen).size).toBe(names.length);
    // A continuation never probes for a file first.
    expect(request.mock.calls.filter(([op, args]) => op === 'read_workspace_binary' && args.relative_path === 'experiments/big')).toHaveLength(0);
    // A malformed cursor is refused before any device call; an older Runner that ignores it says to upgrade.
    await expect(files.read('alice', 'laptop', target, true, 'nonsense')).rejects.toMatchObject({ status: 400 });
    echo = false;
    await expect(files.read('alice', 'laptop', target, true, after)).rejects.toMatchObject({ status: 413, message: expect.stringContaining('升级 Runner') });
  });

  it('streams a file of any size window by window, pulling only as the consumer reads', async () => {
    const body = 'v'.repeat(9 * 1024 * 1024 + 5);
    const { capabilities, request } = device({ 'experiments/results/clip.mp4': body });
    const files = new DocsWorkspaceFiles(capabilities, async () => cwds);
    const session = { owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: 's1' };
    const file = await files.read('alice', 'laptop', await files.resolve(session, 'results/clip.mp4'));
    if (file.kind !== 'file') throw new Error('expected a file');
    expect(file.size).toBe(body.length);
    const reads = () => request.mock.calls.filter(([op]) => op === 'read_workspace_binary').length;
    expect(reads()).toBe(1);
    let received = 0;
    for await (const part of file.chunks) received += part.length;
    expect(received).toBe(body.length);
    expect(reads()).toBe(Math.ceil(body.length / (256 * 1024)));
    await expect(collectDocsFile({ ...file, chunks: (async function* () {})() }, 1024, '太大了')).rejects.toMatchObject({ status: 413 });
  });

  it('aborts the stream when the file changes between windows', async () => {
    const { capabilities, request } = device({ 'experiments/results/log.txt': 'x'.repeat(300_000) });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (operation: string, args: Record<string, unknown>) => {
      const answer = await original(operation, args) as { status: string; result: Record<string, unknown> };
      if (operation === 'read_workspace_binary' && Number(args.offset) > 0) answer.result.digest = 'sha256:' + 'b'.repeat(64);
      return answer;
    });
    const files = new DocsWorkspaceFiles(capabilities, async () => cwds);
    const session = { owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: 's1' };
    const file = await files.read('alice', 'laptop', await files.resolve(session, 'results/log.txt'));
    if (file.kind !== 'file') throw new Error('expected a file');
    await expect((async () => { for await (const _part of file.chunks) { /* drain */ } })()).rejects.toMatchObject({ status: 409 });
  });

  it('opens an absolute path where the device places it, without knowing any absolute root', async () => {
    const { capabilities, request } = device({ 'lab-share/talk.md': '# talk' }, {
      '/home/u/lht/repos/paper/lab-share/talk.md': { placement: { workspace_id: WS_PAPER, relative_path: 'lab-share/talk.md' } },
      '/home/u/gone.md': { placement: null, reason: 'not_found' },
    });
    // The Runner reports display paths only, so the Head knows no cwd at all.
    const files = new DocsWorkspaceFiles(capabilities, async () => new Map());
    const session = { owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: 's1' };
    const target = await files.resolve(session, '/home/u/lht/repos/paper/lab-share/talk.md');
    expect(target).toMatchObject({ workspace: { workspaceId: WS_PAPER, label: 'paper' }, relativePath: 'lab-share/talk.md' });
    expect(request).toHaveBeenCalledWith('list_session_workspaces', expect.objectContaining({ path: '/home/u/lht/repos/paper/lab-share/talk.md', source: 'claude', id: 's1' }));
    await expect(files.resolve(session, '/home/u/gone.md')).rejects.toMatchObject({ status: 404, message: '文件不存在，或已被移动' });
    await expect(files.resolve(session, '/etc/shadow')).rejects.toMatchObject({ status: 404, message: '这个路径不在所有者登记的任何工作区里' });
  });

  it('falls back to the reported layout when the device cannot place a path', async () => {
    const { capabilities } = device({ 'experiments/results/fig.png': 'PNG' }, {
      'results/fig.png': { placement: null, reason: 'unavailable' },
    });
    const files = new DocsWorkspaceFiles(capabilities, async () => cwds);
    await expect(files.resolve({ owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: 's1' }, 'results/fig.png'))
      .resolves.toMatchObject({ workspace: { workspaceId: WS_PAPER }, relativePath: 'experiments/results/fig.png' });
  });

  it('refuses a path no registered workspace holds', async () => {
    const { capabilities } = device({ 'experiments/big.bin': 'x' });
    const files = new DocsWorkspaceFiles(capabilities, async () => cwds);
    await expect(files.resolve({ owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: 's1' }, '/etc/shadow')).rejects.toMatchObject({ status: 404 });
  });
});
