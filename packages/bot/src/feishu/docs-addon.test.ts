import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { FeishuDocsAddonAuth, type DocsAddonIdentity } from './docs-addon-auth.js';
import { cardMessage, FeishuDocsAddonService, IDLE_MS, project, REFRESH_MS, RETRY_MS } from './docs-addon.js';
import { resourceId, decodeResourceId } from '../sessionhub/core.js';
import type { SessionHubService } from '../sessionhub/service.js';
import type { SessionOperationCoordinator } from '../sessionhub/operations.js';
import { ApprovalRequiredError } from '../runner/account-authority.js';
import { MIGRATIONS } from '../store/migrations.js';
import { validateArgs } from '@claude-bot/capability-kernel';
import { RUNNER_OPERATIONS } from '../runner/capability.js';
import { FeishuDocsSharesRepository } from '../store/repositories/feishu-docs-shares.js';
import { MACHINE_LIMITS } from '@claude-bot/runner/limits';
import { PROMPT_MAX_BYTES } from '@claude-bot/feishu-docs-addon/protocol';

const origin = 'https://widget.feishu.cn';
const ALICE = resourceId({ owner: 'alice', device: 'laptop', cliKind: 'claude', sessionId: 'session-a' });
const BOB = resourceId({ owner: 'bob', device: 'desk', cliKind: 'codex', sessionId: 'session-b' });
const REQUEST = '00000000-0000-4000-8000-000000000000';
const transcript = (texts: string[], working = false) => ({
  total_messages: texts.length, offset: 0,
  messages: texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', timestamp: `2026-10-16T00:00:0${i}Z`, blocks: [{ type: 'text', text }] })),
  meta: { activity: working ? { state: 'tool', tool: 'Bash', observed_at: new Date().toISOString() } : { state: 'idle' } },
});

let now = 1_000_000;
let auth: FeishuDocsAddonAuth;
let service: FeishuDocsAddonService;
let db: Database.Database;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); now = 1_000_000; });
afterEach(() => { service?.close(); auth?.close(); db?.close(); vi.useRealTimers(); });

async function setup(read: (args: Record<string, unknown>) => unknown = () => transcript(['hello', 'hi there'])) {
  db = new Database(':memory:');
  for (const m of MIGRATIONS) db.exec(m.sql);
  const shares = new FeishuDocsSharesRepository(db);
  const people = new Map([['ou_alice', 'alice'], ['ou_bob', 'bob']]);
  let next = 'ou_alice';
  auth = new FeishuDocsAddonAuth({ tenantKey: 't', allowedOrigins: [origin], verifyCode: async () => ({ openId: next, tenantKey: 't' }) }, (id) => people.get(id), vi.fn(), () => now);
  // Every tail read must pass the real Runner argument contract, as the Gate would check it.
  const grant = { call: vi.fn(async (method: string, args: Record<string, unknown>) => {
    const checked = validateArgs(RUNNER_OPERATIONS[method as 'read_session'], args);
    if (!checked.ok) throw new Error(checked.message);
    return read(args);
  }), close: vi.fn() };
  const hub = {
    decodeResourceId,
    roster: vi.fn(async () => ({ sessions: [
      { resourceId: ALICE, title: 'Paper', preview: 'latest reply', deviceLabel: 'laptop', cliKind: 'claude', status: 'live', resumable: true, sortActivity: '2026-10-16T00:00:00Z' },
      { resourceId: BOB.replace('bob', 'alice'), first_user_text: 'Reproduce Table 2', preview: 'done', deviceLabel: 'desk', cliKind: 'codex', status: 'idle', resumable: true },
    ], permissions: { effective: ['list_sessions', 'append_session'] } })),
    liveGrant: vi.fn(() => ({ ok: true as const, grant, local: false })),
  };
  const operations = { submit: vi.fn(async () => ({ ok: true, operation: { id: 'op', status: 'submitted', message: '已提交', live: true } })), get: vi.fn() };
  service = new FeishuDocsAddonService(auth, hub as unknown as Pick<SessionHubService, 'roster' | 'liveGrant' | 'decodeResourceId'>,
    operations as unknown as Pick<SessionOperationCoordinator, 'submit' | 'get'>, shares, (u) => u === 'alice' ? 'Alice' : u, () => now);
  const as = async (openId: string): Promise<DocsAddonIdentity> => { next = openId; return auth.authenticate((await auth.login(`code-${openId}-${Math.random()}`, origin)).token, origin); };
  return { hub, grant, operations, shares, db, as, people };
}

it('lets only the owner list and share their own sessions; the Record gets a capability, the database only its hash', async () => {
  const { as, db } = await setup();
  const alice = await as('ou_alice');
  const { sessions } = await service.sessions(alice);
  expect(sessions[0]).toEqual({ resourceId: ALICE, title: 'Paper', preview: 'latest reply', device: 'laptop', provider: 'claude', lastActivity: '2026-10-16T00:00:00Z', working: true, canSend: true, shared: 0 });
  // Without a provider title the first instruction names the session; the latest message is only a hint.
  expect(sessions[1]).toMatchObject({ title: 'Reproduce Table 2', preview: 'done' });
  const { binding } = service.share(alice, { resourceId: ALICE, title: '  Paper \n draft ' });
  expect(binding).toMatchObject({ title: 'Paper draft', owner: 'Alice', device: 'laptop', provider: 'claude' });
  expect(binding.share).toMatch(/^ds_[A-Za-z0-9_-]{43}$/);
  expect(JSON.stringify(db.prepare('SELECT * FROM feishu_docs_shares').all())).not.toContain(binding.share);
  expect((await service.sessions(alice)).sessions[0].shared).toBe(1);
  expect(() => service.share(alice, { resourceId: BOB, title: 'not mine' })).toThrow(expect.objectContaining({ status: 403 }));
  const guest = await as('ou_guest');
  expect(guest.username).toBeNull();
  await expect(service.sessions(guest)).rejects.toMatchObject({ status: 403 });
  expect(() => service.share(guest, { from: binding.share })).toThrow(expect.objectContaining({ status: 403 }));
});

it('shows a shared session read-only to every tenant member through one shared tail', async () => {
  const { as, hub, grant } = await setup();
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  const bob = await as('ou_bob');
  const guest = await as('ou_guest');
  const [a, b, g] = await Promise.all([service.view(alice, binding.share, '', -1), service.view(bob, binding.share, '', -1), service.view(guest, binding.share, '', -1)]);
  expect(a).toMatchObject({ role: 'owner', owner: 'Alice', title: 'Paper', reset: true, messages: [{ i: 0, role: 'user', text: 'hello' }, { i: 1, role: 'assistant', text: 'hi there' }] });
  expect(b).toMatchObject({ role: 'viewer' });
  expect(g).toMatchObject({ role: 'viewer' });
  // One Context, one device read, made as the share's owner under the share's own credential.
  expect(hub.liveGrant).toHaveBeenCalledTimes(1);
  expect(hub.liveGrant).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice', session: false, admin: false, credential: expect.stringMatching(/^feishu-docs-share:/) }), 'alice', 'laptop');
  expect(grant.call).toHaveBeenCalledTimes(1);
  expect(grant.call).toHaveBeenCalledWith('read_session', expect.objectContaining({ id: 'session-a', source: 'claude', device: 'laptop', rich: true, _octopus_include_session_plus: true }));
  // Unchanged frames are a revision echo; reads are throttled per share, not per viewer.
  // Each card echoes its own revision: only the owner's carries the unread mark.
  const rev = 'rev' in b ? b.rev : '';
  // The owner may also talk to the agent here, which is part of what the card shows.
  expect('rev' in a && a.rev).toBe(`${rev}.u.t`);
  expect(await service.view(bob, binding.share, rev, 1)).toEqual({ rev, unchanged: true });
  now += REFRESH_MS;
  await service.view(bob, binding.share, rev, 1);
  expect(grant.call).toHaveBeenCalledTimes(2);
});

it('sends only the newest rows to a reader who already has the rest', async () => {
  let texts = ['one', 'two'];
  const { as } = await setup(() => transcript(texts));
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  await service.view(alice, binding.share, '', -1);
  texts = ['one', 'two', 'three', 'four'];
  now += REFRESH_MS;
  const frame = await service.view(alice, binding.share, 'old', 1);
  expect(frame).toMatchObject({ reset: false, total: 4, messages: [{ i: 1, text: 'two' }, { i: 2, text: 'three' }, { i: 3, text: 'four' }] });
  expect(await service.view(alice, binding.share, 'old', 9)).toMatchObject({ reset: true });
});

/** A session of `texts` that honours the window a read asks for; without an offset, its last page. */
const conversation = (texts: string[]) => (args: Record<string, unknown>) => {
  const all = texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', timestamp: `2026-10-16T00:00:00Z`, blocks: [{ type: 'text', text }] }));
  const max = Number(args.max_messages ?? 120);
  const offset = typeof args.offset === 'number' ? args.offset : Math.max(0, all.length - max);
  return { total_messages: all.length, offset, messages: all.slice(offset, offset + max), meta: { activity: { state: 'idle' } } };
};

it('marks a message a frame carries only the beginning of, and reads the whole of it on request', async () => {
  const { as } = await setup(conversation(['hi', `开头${'长'.repeat(19_998)}`]));
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  const bob = await as('ou_bob');
  const frame = await service.view(bob, binding.share, '', -1);
  const row = 'messages' in frame ? frame.messages[1] : undefined;
  expect(row).toMatchObject({ i: 1, cut: 20_000 });
  expect(row!.text).toHaveLength(12_000);
  // Any reader of the card may expand it; the read runs as the owner, under a history Context of its own.
  const whole = await service.message(bob, binding.share, 1);
  expect(whole).toEqual({ i: 1, text: `开头${'长'.repeat(19_998)}` });
  await expect(service.message(bob, binding.share, 7)).rejects.toMatchObject({ status: 404 });
  service.unshare(alice, { share: binding.share });
  await expect(service.message(bob, binding.share, 1)).rejects.toMatchObject({ status: 410 });
});

it('pages older rows back to the start instead of dropping what a frame has no room for', async () => {
  // 30 messages of 12 000 characters: one frame holds 25 of them; the five oldest are one `older` away.
  const big = Array.from({ length: 30 }, (_, n) => `${n}`.padEnd(12_000, '·'));
  const { as, hub } = await setup(conversation(big));
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  const frame = await service.view(alice, binding.share, '', -1);
  const rows = 'messages' in frame ? frame.messages : [];
  expect(rows.map((r) => r.i)).toEqual(Array.from({ length: 25 }, (_, k) => k + 5));
  const back = await service.older(alice, binding.share, rows[0].i);
  expect(back).toEqual({ messages: big.slice(0, 5).map((text, i) => expect.objectContaining({ i, text })), next: 0 });
  expect(hub.liveGrant).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice', credential: expect.stringMatching(/^feishu-docs-history:/) }), 'alice', 'laptop');
  expect(await service.older(alice, binding.share, 0)).toEqual({ messages: [], next: 0 });

  // A long conversation: the live window is the newest 120 messages, and each `older` page reaches 120 further back.
  const many = Array.from({ length: 300 }, (_, n) => `m${n}`);
  const second = await setup(conversation(many));
  const bob = await second.as('ou_bob');
  const owner = await second.as('ou_alice');
  const share = service.share(owner, { resourceId: ALICE, title: 'Long' }).binding.share;
  const live = await service.view(bob, share, '', -1);
  expect('messages' in live && live.messages[0].i).toBe(180);
  const page1 = await service.older(bob, share, 180);
  expect([page1.messages[0].i, page1.messages.at(-1)!.i, page1.next]).toEqual([60, 179, 60]);
  const page2 = await service.older(bob, share, page1.next);
  expect([page2.messages[0].i, page2.messages.at(-1)!.i, page2.next]).toEqual([0, 59, 0]);
});

it('keeps at most two history reads of one card in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = conversation(Array.from({ length: 300 }, (_, n) => `m${n}`));
  const { as } = await setup(async (args) => { if (typeof args.offset === 'number') await gate; return read(args); });
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  const first = service.older(alice, binding.share, 180);
  const second = service.message(alice, binding.share, 3);
  await expect(service.older(alice, binding.share, 60)).rejects.toMatchObject({ status: 429 });
  release();
  expect((await first).next).toBe(60);
  expect(await second).toEqual({ i: 3, text: 'm3' });
  expect((await service.older(alice, binding.share, 60)).next).toBe(0);
});

it('takes a message as large as one session prompt from a card, and says so when it is larger', async () => {
  const { as, operations } = await setup();
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  // Far past the old 12 000-character refusal.
  await service.send(alice, binding.share, '改'.repeat(100_000), REQUEST);
  expect(operations.submit).toHaveBeenCalledTimes(1);
  expect(PROMPT_MAX_BYTES).toBe(MACHINE_LIMITS.appendMaxPromptBytes);
  expect(PROMPT_MAX_BYTES).toBe(MACHINE_LIMITS.startMaxPromptBytes);
  await expect(service.send(alice, binding.share, 'x'.repeat(PROMPT_MAX_BYTES + 1), REQUEST.replace(/0$/, '1')))
    .rejects.toMatchObject({ status: 413, message: expect.stringContaining('超过一条消息能携带的 384 KB') });
  expect(operations.submit).toHaveBeenCalledTimes(1);
});

it('never projects thinking, tool input or tool output, only text and tool names', () => {
  expect(project([
    { role: 'assistant', blocks: [{ type: 'thinking', text: 'secret plan' }, { type: 'tool', tool: 'Bash', input: '{"command":"cat ~/.ssh/id_rsa"}', output: 'PRIVATE KEY' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }, { type: 'tool', tool: 'Read' }] },
    { role: 'system', blocks: [{ type: 'text', text: 'hidden' }] },
    { role: 'user', text: 'plain row' },
  ], 10)).toEqual([
    { i: 10, role: 'assistant', text: '', tools: ['Bash'] },
    { i: 11, role: 'assistant', text: 'Done.', tools: ['Read'] },
    { i: 13, role: 'user', text: 'plain row' },
  ]);
});

it('ends a card and its reads the moment the owner stops sharing; viewers cannot', async () => {
  const { as, grant } = await setup();
  const alice = await as('ou_alice');
  const first = service.share(alice, { resourceId: ALICE, title: 'Paper' }).binding.share;
  const second = service.share(alice, { resourceId: ALICE, title: 'Paper' }).binding.share;
  const bob = await as('ou_bob');
  await service.view(bob, first, '', -1);
  expect(service.unshare(bob, { share: first })).toEqual({ revoked: 0 });
  expect(service.unshare(alice, { share: first })).toEqual({ revoked: 1 });
  expect(grant.close).toHaveBeenCalledTimes(1);
  await expect(service.view(bob, first, '', -1)).rejects.toMatchObject({ status: 410, message: 'Alice 已停止共享这个会话' });
  await expect(service.view(bob, second, '', -1)).resolves.toMatchObject({ role: 'viewer' });
  // The owner may carry a revoked or copied card over to a fresh capability; everyone else may not.
  const again = service.share(alice, { from: first }).binding.share;
  await expect(service.view(bob, again, '', -1)).resolves.toMatchObject({ title: 'Paper' });
  expect(service.unshare(alice, { resourceId: ALICE })).toEqual({ revoked: 2 });
  await expect(service.view(bob, `ds_${'x'.repeat(43)}`, '', -1)).rejects.toMatchObject({ status: 404 });
});

it('accepts input only from the owner own login, through the durable operation path', async () => {
  const { as, operations } = await setup();
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  const bob = await as('ou_bob');
  await expect(service.send(bob, binding.share, 'run', REQUEST)).rejects.toMatchObject({ status: 403 });
  await expect(service.stop(await as('ou_guest'), binding.share, REQUEST)).rejects.toMatchObject({ status: 403 });
  expect(operations.submit).not.toHaveBeenCalled();
  await expect(service.send(alice, binding.share, '  run the tests  ', REQUEST)).resolves.toEqual({ id: 'op', status: 'submitted', message: '已提交', live: true });
  expect(operations.submit).toHaveBeenLastCalledWith('hub', expect.objectContaining({ username: 'alice', session: false, admin: false }),
    { owner: 'alice', device: 'laptop', sessionId: 'session-a', source: 'claude', operation: 'append_session', prompt: 'run the tests' }, { requestId: `feishu-docs:${REQUEST}` });
  await service.stop(alice, binding.share, REQUEST.replace(/0$/, '1'));
  expect(operations.submit).toHaveBeenLastCalledWith('hub', expect.anything(), expect.objectContaining({ operation: 'interrupt_session' }), expect.anything());
  await expect(service.send(alice, binding.share, 'x', 'not-a-uuid')).rejects.toMatchObject({ status: 400 });
});

it('tells the agent which document a card message came from, and words an uncertain send for the card', async () => {
  const { as, operations } = await setup();
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  const doc = 'Hq0ndUxBdoJ1Ytx3Cmzc1sAbnBe';
  await service.send(alice, binding.share, '在这个文档里把 A1 改短', REQUEST, { doc, title: 'Project\nPlan' });
  expect(operations.submit).toHaveBeenLastCalledWith('hub', expect.anything(), expect.objectContaining({
    prompt: `在这个文档里把 A1 改短\n\n（这条消息是从飞书云文档《Project Plan》里的 Agent 卡片发来的，document_id：${doc}；消息里说的“这个文档”就是它。）`,
  }), expect.anything());
  operations.get.mockReturnValueOnce({ id: 'op', status: 'unknown', operation: 'append_session', live: false, submittedAt: '2026-10-19T03:13:18.485Z',
    message: '结果无法确认 — 不会自动重发；请到本机 CLI 核对，确认未执行后可选择“交给 Octopus 托管”' });
  expect(service.operation(alice, 'op')).toEqual({ id: 'op', status: 'unknown', live: false, at: '2026-10-19T03:13:18.485Z',
    message: expect.stringContaining('还不能确认 Agent 收到了这条消息') });
});

it('adds only a sane document name and id to a card message', () => {
  expect(cardMessage('继续')).toBe('继续');
  expect(cardMessage('继续', { doc: 'https://evil.example/x', title: '' })).toBe('继续');
  expect(cardMessage('继续', { doc: '', title: '周报' })).toBe('继续\n\n（这条消息是从飞书云文档《周报》里的 Agent 卡片发来的；消息里说的“这个文档”就是它。）');
});

it('stops reading after an approval is required instead of raising more approvals', async () => {
  const { as, grant } = await setup(() => { throw new ApprovalRequiredError('pending', 'read_session'); });
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  const first = await service.view(alice, binding.share, '', -1);
  expect(first).toMatchObject({ messages: [], error: expect.stringContaining('人工批准') });
  for (let k = 0; k < 3; k++) { now += REFRESH_MS; await service.view(alice, binding.share, '', -1); }
  expect(grant.call).toHaveBeenCalledTimes(1);
});

it('keeps the last transcript while the device is unreachable, then resolves a fresh read path', async () => {
  let fail = false;
  const { as, hub, grant } = await setup(() => { if (fail) throw new Error('device offline'); return transcript(['a', 'b']); });
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  await service.view(alice, binding.share, '', -1);
  fail = true; now += REFRESH_MS;
  expect(await service.view(alice, binding.share, '', -1)).toMatchObject({ messages: [{ text: 'a' }, { text: 'b' }], error: expect.stringContaining('暂时无法') });
  // A failed path is dropped: Session Hub may have picked the bot host while the device was away.
  expect(grant.close).toHaveBeenCalledTimes(1);
  fail = false; now += REFRESH_MS;
  await service.view(alice, binding.share, '', -1);
  expect(grant.call).toHaveBeenCalledTimes(2); // still backing off
  now += RETRY_MS;
  expect(await service.view(alice, binding.share, '', -1)).not.toHaveProperty('error');
  expect(hub.liveGrant).toHaveBeenCalledTimes(2);
});

it('retries a refused read path with backoff and recovers once the owner allows it', async () => {
  const { as, hub } = await setup();
  hub.liveGrant.mockReturnValueOnce({ ok: false, status: 403, error: 'not granted' } as never);
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  expect(await service.view(alice, binding.share, '', -1)).toMatchObject({ messages: [], error: '所有者的 Octopus 授权暂不允许读取这个会话' });
  now += RETRY_MS;
  expect(await service.view(alice, binding.share, '', -1)).toMatchObject({ messages: [{ text: 'hello' }, { text: 'hi there' }] });
  expect(hub.liveGrant).toHaveBeenCalledTimes(2);
});

it('closes a watch nobody looked at for IDLE_MS and withholds a frame from a login revoked mid-read', async () => {
  let finish: (() => void) | undefined;
  const { as, grant, people } = await setup(() => new Promise((resolve) => { finish = () => resolve(transcript(['x'])); }));
  const alice = await as('ou_alice');
  const { binding } = service.share(alice, { resourceId: ALICE, title: 'Paper' });
  const bob = await as('ou_bob');
  const pending = service.view(bob, binding.share, '', -1);
  await vi.waitFor(() => expect(finish).toBeDefined());
  people.delete('ou_bob');
  finish!();
  await expect(pending).rejects.toMatchObject({ status: 401 });
  now += IDLE_MS + 1;
  vi.advanceTimersByTime(15_000);
  expect(grant.close).toHaveBeenCalledTimes(1);
});
