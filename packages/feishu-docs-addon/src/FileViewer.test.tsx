import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileViewer, ROW_STEP } from './FileViewer';
import { AgentApiError, type AgentApi, type FileReply } from './protocol';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(file: { name: string; mime: string; body: string }) {
  const data = new Blob([file.body], { type: file.mime });
  const reply: FileReply = { kind: 'file', workspace: 'paper', path: file.name, name: file.name, size: data.size, modifiedAt: '2026-10-20T00:00:00Z', mime: file.mime, data };
  const api = { file: vi.fn(async () => reply) } as unknown as AgentApi;
  render(<FileViewer api={api} share="ds_x" path={file.name} owner="lht" isOwner canExpand={false} onClose={() => {}} onExpand={() => {}} onShareWorkspace={() => {}}/>);
}

it('shows a long text file a step at a time, through to its last line', async () => {
  const lines = Array.from({ length: 30_000 }, (_, n) => `line ${String(n).padStart(5, '0')} ${'x'.repeat(20)}`);
  open({ name: 'run.log', mime: 'text/plain', body: lines.join('\n') });
  await screen.findByText(/line 00000/);
  expect(screen.queryByText(/line 29999/)).toBeNull();
  for (let step = 0; step < 10 && screen.queryByRole('button', { name: '继续显示' }); step++) {
    const before = screen.getByText(/line 00000/).textContent!.length;
    fireEvent.click(screen.getByRole('button', { name: '继续显示' }));
    await waitFor(() => expect(screen.getByText(/line 00000/).textContent!.length).toBeGreaterThan(before));
  }
  await screen.findByText(/line 29999/);
  expect(screen.queryByRole('button', { name: '继续显示' })).toBeNull();
});

it('shows every row of a long table, a step at a time', async () => {
  const rows = ['task,score', ...Array.from({ length: ROW_STEP * 2 + 37 }, (_, n) => `t${n},${n}`)];
  open({ name: 'scores.csv', mime: 'text/csv', body: rows.join('\n') });
  await screen.findByText('t0');
  expect(screen.queryByText(`t${ROW_STEP}`)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: `再显示 ${ROW_STEP} 行` }));
  await screen.findByText(`t${ROW_STEP}`);
  fireEvent.click(screen.getByRole('button', { name: '再显示 37 行' }));
  await screen.findByText(`t${ROW_STEP * 2 + 36}`);
  expect(screen.queryByRole('button', { name: /再显示/ })).toBeNull();
});

it('never shows a table cut inside the file as complete, and reads on with one control', async () => {
  // Hold continuation reads until we have inspected the still-visible prefix.
  // One timer tick does not guarantee that FileReader has delivered its load event.
  const readAsText = FileReader.prototype.readAsText;
  let finishRead: (() => void) | undefined;
  const reads = vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader, blob, encoding) {
    const read = () => readAsText.call(this, blob, encoding);
    if (reads.mock.calls.length === 1) read(); else finishRead = read;
  });
  // Wider than one text step, so the first prefix ends in the middle of a row.
  const rows = ['task,note,value', ...Array.from({ length: 4_000 }, (_, n) => `task-${n},${'x'.repeat(180)},40.7`)];
  open({ name: 'big.csv', mime: 'text/csv', body: rows.join('\n') });
  await screen.findByText('task-0');
  expect(screen.getByText(/至少 \d+ 行/)).toBeTruthy();
  expect(screen.queryByText(/共 \d+ 行/)).toBeNull();
  // Page rows until they run out; the same control then reads the next part.
  for (let step = 0; step < 40; step++) {
    const next = screen.queryByRole('button', { name: /再显示/ }) ?? screen.queryByRole('button', { name: '继续显示' });
    if (!next) break;
    const before = document.querySelectorAll('.viewer-table tbody tr').length;
    const reading = next.textContent === '继续显示';
    fireEvent.click(next);
    if (reading) {
      expect(finishRead).toBeTypeOf('function');
      expect(screen.getByText(/至少 \d+ 行/)).toBeTruthy();
      expect(screen.queryByText(/共 \d+ 行/)).toBeNull();
      expect(document.querySelectorAll('.viewer-table tbody tr')).toHaveLength(before);
      const pending = screen.getByRole('button', { name: '正在读取…' }) as HTMLButtonElement;
      expect(pending.disabled).toBe(true);
      const started = reads.mock.calls.length;
      fireEvent.click(pending);
      expect(reads).toHaveBeenCalledTimes(started);
      await act(async () => { finishRead!(); });
      await waitFor(() => expect(screen.queryByRole('button', { name: '正在读取…' })).toBeNull());
      finishRead = undefined;
    }
    await waitFor(() => expect(document.querySelectorAll('.viewer-table tbody tr').length).toBeGreaterThan(before));
  }
  expect(screen.queryByText(/至少/)).toBeNull();
  // No half row was ever rendered as a row: every last cell is whole.
  const last = [...document.querySelectorAll('.viewer-table tbody tr td:last-child')].map((td) => td.textContent);
  expect(last.length).toBe(4_000);
  expect(last.every((value) => value === '40.7')).toBe(true);
}, 30_000);

// PDF.js does not run in jsdom: a document of 150 pages stands in for it, with an observer the test drives.
const painted: number[] = [];
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  PDFWorker: { create: () => ({ destroy() {} }) },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 150,
      getPage: async (index: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale }),
        render: () => { painted.push(index); return { promise: Promise.resolve(), cancel() {} }; },
      }),
    }),
    destroy: async () => {},
  }),
}));

it('lays out every page of a long PDF and paints only the pages near the reader, releasing them again', async () => {
  const observers: Array<{ node: Element; callback: IntersectionObserverCallback }> = [];
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(node: Element) { observers.push({ node, callback: this.callback }); }
    disconnect() {}
  });
  vi.stubGlobal('Worker', class { addEventListener() {} removeEventListener() {} terminate() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  const { default: PdfView } = await import('./pdf');
  render(<PdfView data={new ArrayBuffer(8)} onFailure={() => {}}/>);
  await waitFor(() => expect(screen.getAllByLabelText(/^第 \d+ 页$/)).toHaveLength(150));
  // DOM commit can precede the passive effects that register the observers.
  // Drive visibility only once every page has subscribed, even if React yields.
  await waitFor(() => expect(observers).toHaveLength(150));
  expect(painted).toEqual([]);
  const page = (n: number) => observers.find((o) => o.node.querySelector(`canvas[aria-label="第 ${n} 页"]`))!;
  const near = (n: number, isIntersecting: boolean) => act(async () => { page(n).callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver); });
  await near(120, true);
  await waitFor(() => expect(painted).toEqual([120]));
  const canvas = screen.getByLabelText('第 120 页') as HTMLCanvasElement;
  expect(canvas.width).toBeGreaterThan(0);
  await near(120, false);
  expect(canvas.width).toBe(0);
  await near(120, true);
  await waitFor(() => expect(painted).toEqual([120, 120]));
});

it('lists a long folder page by page with 继续加载, each entry once, until the last page', async () => {
  const names = Array.from({ length: 1_100 }, (_, n) => `f${String(n).padStart(4, '0')}.txt`);
  const entry = (name: string) => ({ name, path: `results/${name}`, dir: false, size: 1 });
  const pages: Record<string, FileReply> = {
    '': { kind: 'dir', workspace: 'paper', path: 'results', truncated: true, next: 'file/f0499.txt', entries: names.slice(0, 500).map(entry) },
    'file/f0499.txt': { kind: 'dir', workspace: 'paper', path: 'results', truncated: true, next: 'file/f0999.txt', entries: [entry('f0499.txt'), ...names.slice(500, 1_000).map(entry)] },
    'file/f0999.txt': { kind: 'dir', workspace: 'paper', path: 'results', truncated: false, entries: names.slice(1_000).map(entry) },
  };
  const file = vi.fn(async (_share: string, _path: string, after?: string) => pages[after ?? '']!);
  render(<FileViewer api={{ file } as unknown as AgentApi} share="ds_x" path="results/" owner="lht" isOwner canExpand={false} onClose={() => {}} onExpand={() => {}} onShareWorkspace={() => {}}/>);
  await screen.findByText('f0000.txt');
  expect(screen.getByText('已列出 500 项，后面还有')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '继续加载' }));
  await screen.findByText('f0999.txt');
  fireEvent.click(screen.getByRole('button', { name: '继续加载' }));
  await screen.findByText('f1099.txt');
  expect(screen.queryByRole('button', { name: '继续加载' })).toBeNull();
  expect(screen.queryByText(/已列出|只列出/)).toBeNull();
  // A row repeated across pages is shown once; every row is there, in order.
  expect(screen.getAllByRole('listitem').map((row) => row.textContent?.replace(/1 B$/, ''))).toEqual(names);
  expect(file.mock.calls.map((call) => call[2])).toEqual([undefined, 'file/f0499.txt', 'file/f0999.txt']);
  expect(screen.getByText(/1100 项/)).toBeTruthy();
});

it('says an older bridge listed only part of a folder instead of implying it is whole', async () => {
  const reply: FileReply = { kind: 'dir', workspace: 'paper', path: 'results', truncated: true, entries: [{ name: 'a.txt', path: 'results/a.txt', dir: false, size: 1 }] };
  render(<FileViewer api={{ file: vi.fn(async () => reply) } as unknown as AgentApi} share="ds_x" path="results/" owner="lht" isOwner canExpand={false} onClose={() => {}} onExpand={() => {}} onShareWorkspace={() => {}}/>);
  expect(await screen.findByText(/只列出了前 1 项/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '继续加载' })).toBeNull();
});

it('keeps 继续加载 available after a failed page and says why', async () => {
  const first: FileReply = { kind: 'dir', workspace: 'paper', path: 'results', truncated: true, next: 'file/a.txt', entries: [{ name: 'a.txt', path: 'results/a.txt', dir: false, size: 1 }] };
  const file = vi.fn(async (_share: string, _path: string, after?: string) => {
    if (after) throw new AgentApiError(503, '设备暂时离线');
    return first;
  });
  render(<FileViewer api={{ file } as unknown as AgentApi} share="ds_x" path="results/" owner="lht" isOwner canExpand={false} onClose={() => {}} onExpand={() => {}} onShareWorkspace={() => {}}/>);
  fireEvent.click(await screen.findByRole('button', { name: '继续加载' }));
  expect((await screen.findByRole('alert')).textContent).toBe('设备暂时离线');
  expect((screen.getByRole('button', { name: '继续加载' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('a.txt')).toBeTruthy();
});
