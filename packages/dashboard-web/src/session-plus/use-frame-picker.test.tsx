import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentFramePicker } from '../lib/element-picker.js';
import { useFramePicker } from './use-frame-picker.js';
afterEach(cleanup);
describe('shared App frame picker', () => {
  it('captures an in-frame result even before the start acknowledgement', async () => {
    const host = { current: { debug: vi.fn(() => new Promise<{ ok: boolean }>(() => {})) } };
    const hook = renderHook(() => useFramePicker(host as never));
    const result = currentFramePicker()!();
    act(() => hook.result.current('pick', { module: 'agent.chat/v1', path: 'textarea' }));
    expect(await result).toEqual({ module: 'agent.chat/v1', path: 'textarea' });
  });
  it('settles failures and cancels a pending selection when the App closes', async () => {
    const host = { current: { debug: vi.fn(async () => ({ ok: false })) } };
    const hook = renderHook(() => useFramePicker(host as never));
    expect(await currentFramePicker()!()).toBeNull();
    host.current.debug.mockImplementation(() => new Promise(() => {}));
    const waiting = currentFramePicker()!();
    hook.unmount();
    expect(await waiting).toBeNull();
    expect(currentFramePicker()).toBeNull();
    expect(host.current.debug).toHaveBeenLastCalledWith('pick.stop');
  });
});
