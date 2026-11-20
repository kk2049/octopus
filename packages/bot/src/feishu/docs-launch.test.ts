import { describe, expect, it, vi } from 'vitest';
import { validateArgs } from '@claude-bot/capability-kernel';
import { SESSION_OPERATION_PROTOCOL } from '@claude-bot/runner/gateway-protocol';
import { RUNNER_OPERATIONS } from '../runner/capability.js';
import { directoryProblem, DocsLauncher, FALLBACK_DEFAULTS, readDefaults } from './docs-launch.js';

const inventory = (kinds: string[]) => ({ agent_backends: kinds.map((kind) => ({ kind, available: true })), session_operations: { protocol: SESSION_OPERATION_PROTOCOL } });
const devices = [
  { device: 'laptop', display_name: 'Laptop', online: true, inventory: inventory(['claude', 'codex']) },
  { device: 'old', online: true, inventory: { agent_backends: [{ kind: 'codex', available: true }] } },
  { device: 'away', online: false, inventory: inventory(['claude']) },
  { device: 'dsh:web', online: true },
];

function launcher(answer: (operation: string, args: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (operation: string, args: Record<string, unknown>) => {
    const checked = validateArgs(RUNNER_OPERATIONS[operation as 'start_session'], args);
    if (!checked.ok) throw new Error(checked.message);
    return { status: 'succeeded' as const, result: answer(operation, args) };
  });
  const open = vi.fn(() => ({ request, destroy: vi.fn() }));
  const caps = { open, listDevices: vi.fn(() => devices) };
  return { launcher: new DocsLauncher(caps as never), open, request };
}
const receipt = (id: string, patch: Record<string, unknown> = {}) => ({ protocol: SESSION_OPERATION_PROTOCOL, operation_id: id, state: 'running', ...patch });

describe('DocsLauncher', () => {
  it('offers only devices that can start a durable session, and recent absolute directories', () => {
    const { launcher: l } = launcher(() => null);
    const options = l.options('lht', [
      { device: 'laptop', cwd: '/home/u/paper', lastActivity: '2026-10-18T02:00:00Z' },
      { device: 'laptop', cwd: '/home/u/paper', lastActivity: '2026-10-17T02:00:00Z' },
      { device: 'laptop', cwd: '~/relative' },
      { device: 'laptop', cwd: '/home/u/octopus', lastActivity: '2026-10-18T03:00:00Z' },
    ], FALLBACK_DEFAULTS);
    expect(options.devices).toEqual([
      { device: 'laptop', label: 'Laptop', online: true, providers: ['claude', 'codex'] },
      { device: 'away', label: 'away', online: false, providers: [], reason: '设备离线' },
      { device: 'old', label: 'old', online: false, providers: [], reason: '这台设备的 Runner 需要升级' },
    ]);
    expect(options.directories.map((d) => d.path)).toEqual(['/home/u/octopus', '/home/u/paper']);
    expect(options.models.claude.map((m) => m.value)).toContain('opus');
    expect(options.efforts.codex.map((e) => e.label)).toEqual(['低', '中', '高', '很高', '最高']);
  });

  it('dispatches start_session with a durable id that is stable per request, auto-allowed for this one call', async () => {
    const { launcher: l, open, request } = launcher((operation, args) => receipt(String(args.operation_id)));
    const form = { device: 'laptop', directory: '~/paper', provider: 'claude' as const, model: 'opus', effort: 'max', prompt: '复现基线', requestId: 'req-00000001' };
    const first = await l.start('lht', form);
    // The device's launch journal refuses any other shape (runner/src/launch-journal.ts validRequestId).
    expect(first).toMatch(/^op_[A-Za-z0-9_-]{8,120}$/);
    expect(await l.start('lht', form)).toBe(first);
    expect(await l.start('bob', form)).not.toBe(first);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ username: 'lht', device: 'laptop', rights: ['start_session'], autoAllow: ['start_session'] }));
    expect(request.mock.calls[0]![1]).toMatchObject({ device: 'laptop', directory: '~/paper', source: 'claude', model: 'opus', effort: 'max', permission_profile: 'full_access',
      client_request_id: first, operation_id: first, input_receipt: true });
  });

  it('refuses what the device would refuse, before dispatching', async () => {
    const { launcher: l, request } = launcher(() => null);
    const base = { device: 'laptop', directory: '/x', provider: 'codex' as const, model: '', effort: 'xhigh', prompt: 'p', requestId: 'req-00000001' };
    await expect(l.start('lht', { ...base, device: 'away' })).rejects.toMatchObject({ status: 409 });
    await expect(l.start('lht', { ...base, directory: 'relative/dir' })).rejects.toMatchObject({ status: 400 });
    await expect(l.start('lht', { ...base, effort: 'off' })).rejects.toMatchObject({ status: 400 });
    await expect(l.start('lht', { ...base, model: '--evil' })).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it('reads the device receipt until it names the session or fails', async () => {
    let polls = 0;
    const { launcher: l } = launcher((operation, args) => operation === 'get_session_operation'
      ? receipt(String(args.operation_id), ++polls < 2 ? {} : { state: 'succeeded', session_id: 'sess-1' })
      : receipt(String(args.operation_id)));
    expect(await l.waitForSession('lht', 'laptop', 'fdl-1', Date.now() + 5_000)).toEqual({ state: 'succeeded', sessionId: 'sess-1' });
    const refused = { launcher: new DocsLauncher({ listDevices: () => devices, open: () => ({ request: async () => ({ status: 'failed' as const, reason: 'client_request_id 无效' }), destroy: vi.fn() }) } as never) };
    await expect(refused.launcher.start('lht', { device: 'laptop', directory: '/x', provider: 'codex', model: '', effort: '', prompt: 'p', requestId: 'req-00000003' }))
      .rejects.toMatchObject({ status: 422, message: '设备没有启动 Agent：client_request_id 无效' });
    const failing = launcher((_op, args) => receipt(String(args.operation_id), { state: 'failed', result: { ok: false, error: '目录不存在：/x' } }));
    await expect(failing.launcher.start('lht', { device: 'laptop', directory: '/x', provider: 'codex', model: '', effort: '', prompt: 'p', requestId: 'req-00000002' }))
      .rejects.toMatchObject({ status: 422, message: '目录不存在：/x' });
  });
});

it('remembers sane defaults only', () => {
  expect(readDefaults(JSON.stringify({ device: 'laptop', directory: 'bad', provider: 'claude', model: { claude: 'sonnet', codex: '--x' }, effort: { claude: 'off' } })))
    .toEqual({ device: 'laptop', provider: 'claude', model: { claude: 'sonnet', codex: FALLBACK_DEFAULTS.model.codex }, effort: FALLBACK_DEFAULTS.effort });
  expect(readDefaults('{broken')).toEqual(FALLBACK_DEFAULTS);
  expect(directoryProblem('~')).toBe('');
  expect(directoryProblem(' /x')).not.toBe('');
});
