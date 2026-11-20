import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runResearchImport, type ResearchImportBackend } from './cli.js';

const mcp = vi.hoisted(() => ({ call: vi.fn(), connect: vi.fn(), close: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  connect = mcp.connect; callTool = mcp.call; close = async () => { mcp.close(); };
} }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));


it('restages reviewed actions after sources disappear and refuses altered bundles before any MCP call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-frozen-'));
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const backend: ResearchImportBackend = {
    project: () => ({ project: {} }), incremental: state => state,
    invoke: () => ({ events: [] }),
  };
  try {
    const source = join(dir, 'source.md'); writeFileSync(source, '# Frozen original\nReview this version.');
    const plan = join(dir, 'plan.json'); writeFileSync(plan, JSON.stringify({ version: 1, projects: [{ key: 'demo', title: 'Demo', instance: null, documents: [{ path: source, display: 'source.md' }], sessions: [] }] }));
    const args = ['--plan', plan, '--out', join(dir, 'bundle')];
    await runResearchImport(args, backend);
    const before = readFileSync(join(dir, 'bundle/demo.actions.json'), 'utf8');
    unlinkSync(source);
    await runResearchImport([...args, '--restage'], backend);
    expect(readFileSync(join(dir, 'bundle/demo.actions.json'), 'utf8')).toBe(before);
    const edited = JSON.parse(before); edited.title = 'Changed without review';
    writeFileSync(join(dir, 'bundle/demo.actions.json'), JSON.stringify(edited));
    await expect(runResearchImport([...args, '--apply'], backend)).rejects.toThrow('reviewed coverage');
  } finally { stdout.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});


it('keeps ambiguous MCP outcomes pending and refuses replay or partial apply of an altered bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-checkpoint-'));
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const backend: ResearchImportBackend = { project: () => ({ project: {} }), incremental: state => state, invoke: () => ({ events: [] }) };
  try {
    const instance = 'asi_' + 'a'.repeat(32);
    const source = join(dir, 'source.md'); writeFileSync(source, '# Evidence');
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ version: 1, projects: ['one', 'two'].map(key => ({ key, instance, title: key,
      documents: [{ path: source, display: 'source.md' }], sessions: [] })) }));
    const args = ['--plan', plan, '--out', join(dir, 'bundle')];
    await runResearchImport(args, backend);
    const original = readFileSync(join(dir, 'bundle/two.actions.json'), 'utf8');
    const altered = JSON.parse(original); altered.title = 'unreviewed';
    writeFileSync(join(dir, 'bundle/two.actions.json'), JSON.stringify(altered));
    mcp.call.mockReset(); mcp.connect.mockReset();
    await expect(runResearchImport([...args, '--apply'], backend)).rejects.toThrow('reviewed coverage');
    expect(mcp.connect).not.toHaveBeenCalled();
    writeFileSync(join(dir, 'bundle/two.actions.json'), original);
    writeFileSync(join(dir, 'token'), 'test-token');
    const config = join(dir, 'config.json'); writeFileSync(config, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token_file: join(dir, 'token') }));
    mcp.call.mockResolvedValueOnce({ structuredContent: { apps: [{ app: 'research-program', instances: [{ instance }], actions: [{ name: 'research_register_archive' }] }] } })
      .mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'unavailable: commit outcome unknown' }] });
    const applying = [...args, '--apply', '--mcp-config', config];
    await expect(runResearchImport(applying, backend)).rejects.toThrow('no retry');
    expect(JSON.parse(readFileSync(join(dir, 'bundle/one.checkpoint.json'), 'utf8'))).toMatchObject({ next: 0, pending: true });
    await expect(runResearchImport(applying, backend)).rejects.toThrow('uncertain prior call');
    expect(mcp.call).toHaveBeenCalledTimes(2);
  } finally { stdout.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
