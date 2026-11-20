import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { BrowserSessions, boundedAction, webUrl } from './core.mjs';

let state, browser, sessions, now;
function fakeBrowser() {
  const contexts = [];
  return { contexts, isConnected: () => true, version: () => 'test', newContext: vi.fn(async ({ viewport, storageState }) => {
    const context = new EventEmitter();
    const page = new EventEmitter();
    page.current = 'about:blank';
    page.url = () => page.current;
    page.goto = vi.fn(async (url) => { page.current = url; });
    page.title = async () => 'Task page';
    page.viewportSize = () => viewport;
    page.mouse = { click: vi.fn(), move: vi.fn(), down: vi.fn(), up: vi.fn(), wheel: vi.fn() };
    page.keyboard = { insertText: vi.fn(), press: vi.fn() };
    page.target = { ariaSnapshot: vi.fn(async () => '- button "Save"'), click: vi.fn(), fill: vi.fn(), press: vi.fn() };
    page.locator = vi.fn(() => page.target);
    page.screenshot = vi.fn(async () => Buffer.from('jpeg'));
    page.bringToFront = vi.fn(); page.close = vi.fn();
    context.saved = structuredClone(storageState ?? { cookies: [], origins: [] });
    context.storageState = vi.fn(async () => structuredClone(context.saved));
    context.setDefaultTimeout = vi.fn(); context.setDefaultNavigationTimeout = vi.fn();
    context.newPage = async () => { context.emit('page', page); return page; };
    context.pages = () => [page]; context.close = vi.fn(async () => {});
    contexts.push(context); return context;
  }) };
}
beforeEach(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'octopus-browser-test-'));
  browser = fakeBrowser(); now = 1000;
  sessions = new BrowserSessions(browser, { state, origin: 'https://octopus.test', clock: () => now, maxSessions: 2 });
});
afterEach(async () => { vi.useRealTimers(); await fs.rm(state, { recursive: true, force: true }); });

describe('task-owned browser contexts', () => {
  it('isolates tasks and does not expose handles in health', async () => {
    const a = await sessions.invoke('browser_open');
    const b = await sessions.invoke('browser_open');
    expect(a.session).not.toBe(b.session);
    expect(a.session).toMatch(/^[0-9a-f]{48}$/);
    expect(browser.contexts).toHaveLength(2);
    expect(JSON.stringify(await sessions.invoke('browser_health'))).not.toContain(a.session);
    await sessions.invoke('browser_close', { session: a.session });
    expect(browser.contexts[0].close).toHaveBeenCalledOnce();
    expect(browser.contexts[1].close).not.toHaveBeenCalled();
    await expect(sessions.invoke('browser_observe', { session: '../other' })).rejects.toThrow('not active');
  });
  it('keeps active and idle contexts past twenty minutes and seven days without an action limit', async () => {
    const a = await sessions.open({}), b = await sessions.open({});
    expect(a.expires_at).toBeNull();
    expect((await sessions.invoke('browser_health')).lease_seconds).toBeNull();
    await expect(sessions.open({})).rejects.toThrow('capacity');
    now += 21 * 60_000;
    await sessions.checkpointIdle();
    for (let i = 0; i < 260; i++) await sessions.invoke('browser_observe', { session: a.session });
    now += 7 * 86400_000;
    await sessions.invoke('browser_observe', { session: b.session });
    expect(browser.contexts.every((c) => c.close.mock.calls.length === 0)).toBe(true);
    await sessions.invoke('browser_close', { session: a.session });
    expect((await sessions.open({})).session).not.toBe(a.session);
  });
  it('rejects simultaneous input in one context and does not replay it', async () => {
    const { session } = await sessions.open({});
    let release;
    const page = sessions.sessions.get(session).page;
    page.mouse.click.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = sessions.invoke('browser_action', { session, action: 'click', x: 10, y: 10 });
    await Promise.resolve();
    await expect(sessions.invoke('browser_action', { session, action: 'click', x: 10, y: 10 })).rejects.toThrow('in flight');
    release(); await first;
    expect(page.mouse.click).toHaveBeenCalledOnce();
  });
  it('retires uncertain operations at their deadline without replay', async () => {
    vi.useFakeTimers();
    const retire = vi.fn(), run = vi.fn(() => new Promise(() => {}));
    const result = boundedAction(run, retire, 10);
    const rejection = expect(result).rejects.toThrow('do not replay');
    await vi.advanceTimersByTimeAsync(10); await rejection;
    expect(retire).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
  });
  it('bounds coordinates and refuses unsafe navigation before browser input', async () => {
    const { session } = await sessions.open({});
    const page = sessions.sessions.get(session).page;
    await expect(sessions.invoke('browser_action', { session, action: 'click', x: 1280, y: 1 })).rejects.toThrow('Coordinates');
    await expect(sessions.invoke('browser_action', { session, action: 'drag', x: 1, y: 1, to_x: -1, to_y: 2 })).rejects.toThrow('endpoint');
    await expect(sessions.invoke('browser_navigate', { session, url: 'file:///etc/passwd' })).rejects.toThrow('HTTP');
    expect(page.mouse.click).not.toHaveBeenCalled(); expect(page.mouse.down).not.toHaveBeenCalled();
  });
  it('writes private bounded screenshots and keeps them after close', async () => {
    const { session } = await sessions.open({});
    const result = await sessions.invoke('browser_screenshot', { session });
    const file = path.join(state, 'artifacts', result.artifact);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(result.image).toBe(Buffer.from('jpeg').toString('base64'));
    await sessions.invoke('browser_close', { session });
    expect(await fs.readFile(file, 'utf8')).toBe('jpeg');
  });
  it('rejects oversized image output rather than passing a truncated success', async () => {
    const { session } = await sessions.open({});
    const page = sessions.sessions.get(session).page;
    page.screenshot.mockResolvedValue(Buffer.alloc(160_001));
    await expect(sessions.invoke('browser_screenshot', { session })).rejects.toThrow('output');
    expect(page.screenshot).toHaveBeenCalledTimes(3);
  });
});

describe('acceptance credentials', () => {
  it('never fills credentials at another origin or after a login redirect', async () => {
    const credentialFile = path.join(state, 'credential');
    await fs.writeFile(credentialFile, 'private-test-key', { mode: 0o600 });
    sessions.credentialFile = credentialFile;
    const { session } = await sessions.open({ url: 'https://other.test' });
    const page = sessions.sessions.get(session).page;
    await expect(sessions.invoke('browser_login_acceptance', { session })).rejects.toThrow('restricted');
    page.current = 'https://octopus.test';
    page.goto.mockImplementation(async () => { page.current = 'https://other.test/login'; });
    await expect(sessions.invoke('browser_login_acceptance', { session })).rejects.toThrow('redirected');
    expect(page.target.fill).not.toHaveBeenCalled();
    expect(sessions.redact('private-test-key')).toBe('[credential]');
  });
  it('refuses a broadly readable credential file', async () => {
    const credentialFile = path.join(state, 'credential');
    await fs.writeFile(credentialFile, 'test', { mode: 0o644 });
    await fs.chmod(credentialFile, 0o644); sessions.credentialFile = credentialFile;
    const { session } = await sessions.open({});
    await expect(sessions.invoke('browser_login_acceptance', { session })).rejects.toThrow('private');
  });
  it.each(['file:///tmp/local', 'javascript:alert(1)', 'https://user:pass@octopus.test/'])('rejects %s', (url) => {
    expect(() => webUrl(url)).toThrow();
  });
});


describe('opt-in durable task login', () => {
  it('restores cookies, localStorage and IndexedDB after shutdown without input replay or identity crossover', async () => {
    const a = await sessions.open({ persist_login: true, label: 'task A' });
    const b = await sessions.open({ persist_login: true, label: 'task B' });
    const data = { cookies: [{ name: 'fixture-login', value: 'private-A', domain: 'octopus.test', path: '/' }],
      origins: [{ origin: 'https://octopus.test', localStorage: [{ name: 'user', value: 'A' }], indexedDB: [{ name: 'fixture', version: 1, stores: [] }] }] };
    browser.contexts[0].saved = data;
    const check = await sessions.invoke('browser_observe', { session: a.session });
    expect(check.login_checkpoint.failed).toBe(false);
    expect(JSON.stringify(check)).not.toContain('private-A');
    expect(browser.contexts[0].storageState).toHaveBeenCalledWith({ indexedDB: true });
    await sessions.shutdown();
    const next = new BrowserSessions(browser, { state, origin: 'https://octopus.test', clock: () => now });
    now += 7 * 86400_000;
    const resumed = await next.invoke('browser_resume', { session: a.session });
    expect(resumed.session).toBe(a.session);
    expect(resumed.expires_at).toBeNull();
    expect(browser.contexts[2].saved).toEqual(data);
    expect(browser.contexts[2].pages()[0].mouse.click).not.toHaveBeenCalled();
    await next.invoke('browser_resume', { session: b.session });
    expect(browser.contexts[3].saved.cookies).toEqual([]);
    const count = browser.contexts.length;
    await next.invoke('browser_resume', { session: a.session });
    expect(browser.contexts).toHaveLength(count);
    expect(JSON.stringify(await next.invoke('browser_health'))).not.toContain(a.session);
  });
  it('defaults to no disk login and only suspends opted-in tasks', async () => {
    const { session } = await sessions.open({});
    await sessions.checkpointIdle();
    await expect(fs.stat(sessions.stateFile(session))).rejects.toThrow();
    await expect(sessions.invoke('browser_suspend', { session })).rejects.toThrow('opt into');
    expect(browser.contexts[0].close).not.toHaveBeenCalled();
  });
  it('suspends to free capacity, preserves evidence numbering, then explicitly forgets only the chosen task', async () => {
    const a = await sessions.open({ persist_login: true });
    const b = await sessions.open({ persist_login: true });
    const shot = await sessions.invoke('browser_screenshot', { session: a.session });
    const saved = await sessions.invoke('browser_suspend', { session: a.session });
    expect(saved.suspended).toBe(true);
    expect((await sessions.invoke('browser_health')).contexts).toBe(1);
    const file = sessions.stateFile(a.session);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    await sessions.invoke('browser_resume', { session: a.session });
    const shot2 = await sessions.invoke('browser_screenshot', { session: a.session });
    expect(shot2.artifact).not.toBe(shot.artifact);
    await sessions.invoke('browser_close', { session: a.session });
    await expect(sessions.invoke('browser_resume', { session: a.session })).rejects.toThrow();
    expect(await fs.readFile(path.join(state, 'artifacts', shot.artifact), 'utf8')).toBe('jpeg');
    await sessions.invoke('browser_suspend', { session: b.session });
    await sessions.invoke('browser_close', { session: b.session });
    await expect(fs.stat(sessions.stateFile(b.session))).rejects.toThrow();
  });
  it('checkpoints an idle login completed outside tool calls', async () => {
    const { session } = await sessions.open({ persist_login: true });
    browser.contexts[0].saved.cookies.push({ name: 'qr-login', value: 'fixture' });
    await sessions.checkpointIdle();
    const saved = JSON.parse(await fs.readFile(sessions.stateFile(session), 'utf8'));
    expect(saved.storageState.cookies[0].name).toBe('qr-login');
  });
  it('serializes concurrent restore and keeps the capacity bound', async () => {
    const { session } = await sessions.open({ persist_login: true });
    await sessions.invoke('browser_suspend', { session });
    const first = sessions.invoke('browser_resume', { session });
    await expect(sessions.invoke('browser_resume', { session })).rejects.toThrow('in flight');
    await first;
    await sessions.open({});
    await expect(sessions.open({})).rejects.toThrow('capacity');
  });
  it('refuses unsafe handles, non-private files and oversized checkpoints without leaking secrets', async () => {
    await expect(sessions.invoke('browser_resume', { session: '../other' })).rejects.toThrow('handle');
    const { session } = await sessions.open({ persist_login: true });
    const file = sessions.stateFile(session);
    const original = await fs.readFile(file, 'utf8');
    browser.contexts[0].saved.cookies.push({ name: 'too-large', value: randomBytes(4 * 1024 ** 2).toString('base64') });
    const result = await sessions.invoke('browser_observe', { session });
    expect(result.snapshot).toContain('Save');
    expect(result.login_checkpoint.failed).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    browser.contexts[0].saved.cookies = [];
    await sessions.invoke('browser_suspend', { session });
    await fs.chmod(file, 0o644);
    await expect(sessions.invoke('browser_resume', { session })).rejects.toThrow('private');
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, 'broken-private-cookie');
    await expect(sessions.invoke('browser_resume', { session })).rejects.toThrow('Saved login state is invalid');
  });
  it('compresses large site storage without discarding cookies or IndexedDB across restart', async () => {
    const { session } = await sessions.open({ persist_login: true });
    const data = { cookies: [{ name: 'fixture-login', value: 'private-large-login' }], origins: [{
      origin: 'https://octopus.test', localStorage: [{ name: 'code-cache', value: 'program;'.repeat(700_000) }],
      indexedDB: [{ name: 'fixture-login', version: 1, stores: [{ name: 'login', records: [{ key: 'user', value: 'test-user' }] }] }],
    }] };
    browser.contexts[0].saved = data;
    const result = await sessions.invoke('browser_action', { session, action: 'click', x: 1, y: 1 });
    expect(result.performed).toBe('click');
    expect(result.login_checkpoint.failed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-large-login');
    const file = sessions.stateFile(session), packed = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(packed.version).toBe(2);
    expect((await fs.stat(file)).size).toBeLessThan(4 * 1024 ** 2);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await sessions.invoke('browser_suspend', { session });
    const next = new BrowserSessions(browser, { state, origin: 'https://octopus.test' });
    await next.invoke('browser_resume', { session });
    expect(browser.contexts[1].saved).toEqual(data);
    expect(browser.contexts[1].pages()[0].mouse.click).not.toHaveBeenCalled();
  });
  it('keeps successful actions and inspection usable after checkpoint failure without replay or login loss', async () => {
    const { session } = await sessions.open({ persist_login: true });
    const ctx = browser.contexts[0], file = sessions.stateFile(session), original = await fs.readFile(file);
    ctx.storageState.mockRejectedValue(new Error('private failure details'));
    const result = await sessions.invoke('browser_action', { session, action: 'click', x: 1, y: 1 });
    expect(result.performed).toBe('click');
    expect(result.login_checkpoint.failed).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private failure');
    expect((await sessions.invoke('browser_observe', { session })).snapshot).toContain('Save');
    expect((await sessions.invoke('browser_screenshot', { session })).image).toBeTruthy();
    expect((await sessions.invoke('browser_health')).checkpoint_failures).toBe(1);
    await expect(sessions.invoke('browser_suspend', { session })).rejects.toThrow();
    expect(ctx.close).not.toHaveBeenCalled();
    expect(ctx.pages()[0].mouse.click).toHaveBeenCalledOnce();
    expect(await fs.readFile(file)).toEqual(original);
    ctx.storageState.mockResolvedValue(ctx.saved);
    expect((await sessions.invoke('browser_observe', { session })).login_checkpoint.failed).toBe(false);
    expect((await sessions.invoke('browser_health')).checkpoint_failures).toBe(0);
  });
  it('retains a newly opened live context if its first recovery save fails', async () => {
    const create = browser.newContext.getMockImplementation();
    browser.newContext.mockImplementation(async (options) => {
      const ctx = await create(options);
      ctx.storageState.mockRejectedValue(new Error('save failed'));
      return ctx;
    });
    const result = await sessions.open({ persist_login: true });
    expect(result.login_checkpoint.failed).toBe(true);
    expect((await sessions.invoke('browser_observe', { session: result.session })).snapshot).toContain('Save');
    expect(browser.contexts[0].close).not.toHaveBeenCalled();
  });
  it('rejects malformed compressed state and expansion beyond its budget before restoring a browser', async () => {
    const { session } = await sessions.open({ persist_login: true });
    await sessions.invoke('browser_suspend', { session });
    const file = sessions.stateFile(session);
    for (const data of [
      { version: 2, encoding: 'other', payload: 'x' },
      { version: 2, encoding: 'gzip-base64', payload: 'not-gzip' },
      { version: 2, encoding: 'gzip-base64', payload: gzipSync(Buffer.alloc(64 * 1024 ** 2 + 1)).toString('base64') },
    ]) {
      await fs.writeFile(file, JSON.stringify(data));
      await expect(sessions.invoke('browser_resume', { session })).rejects.toThrow('Saved login state is invalid');
    }
    expect(browser.contexts).toHaveLength(1);
  });
  it('preserves last completed login checkpoint after uncertain retirement without replay', async () => {
    const { session } = await sessions.open({ persist_login: true });
    const s = sessions.sessions.get(session);
    sessions.retire(session, s);
    await sessions.invoke('browser_resume', { session });
    expect(browser.contexts[1].pages()[0].mouse.click).not.toHaveBeenCalled();
    expect(s.retired).toBe(true);
  });
  it('does not let a pending checkpoint resurrect login after explicit close', async () => {
    const { session } = await sessions.open({ persist_login: true });
    const s = sessions.sessions.get(session);
    let finish;
    s.context.storageState.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = sessions.checkpoint(session, s);
    await Promise.resolve(); await Promise.resolve();
    const closing = sessions.close(session);
    finish({ cookies: [], origins: [] });
    await pending; await closing;
    await expect(fs.stat(sessions.stateFile(session))).rejects.toThrow();
  });
  it('rotates bounded action logs without clearing login or prior screenshots', async () => {
    const { session } = await sessions.open({ persist_login: true });
    const s = sessions.sessions.get(session), log = path.join(s.dir, 'actions.jsonl');
    await fs.writeFile(log, 'x'.repeat(65536), { mode: 0o600 });
    await sessions.invoke('browser_observe', { session });
    expect((await fs.stat(log)).size).toBeLessThan(256);
    expect((await fs.stat(log + '.previous')).size).toBe(65536);
    expect(await fs.stat(sessions.stateFile(session))).toBeTruthy();
  });
});
