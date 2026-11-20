import { expect, it } from 'vitest';
import { AgentApiError, type DocShareConnect, type DocShareLink, type DocSharePanel } from './protocol';
import { NO_SHARES, panelProblem, reduceShares, refusalText, shownAssistant, shownInvite, shownLinks, shownSelfServe, taskRefusal, type ShareEvent } from './share-state';

const link = (status: DocShareLink['status'] = 'active', id = 'a'): DocShareLink => ({ id, label: id.toUpperCase(), rights: 'write', status, created_at: 1, last_used_at: null, via: 'owner', mine: false });
const panel = (status: DocShareLink['status'] = 'active', patch: Partial<DocSharePanel> = {}): DocSharePanel => ({
  document_id: 'doc', host_matches: true, viewer_is_owner: true, card_state: 'present', lease_until: null, shares: [link(status)],
  self_serve: 'write', app_access: 'edit', app_name: 'Octopus', invite: { active: false, created_at: null }, limits: { per_hour: 10, active_max: 50 },
  assistant: { rights: null, project: null, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } }, ...patch,
});
const connect: DocShareConnect = { claude: 'claude mcp add x', codex: 'printf x', endpoint: 'https://bridge.example/api/mcp', token: 'omt_x' };
const run = (...events: ShareEvent[]) => events.reduce(reduceShares, NO_SHARES);
const read = (seq: number, status: DocShareLink['status'] = 'active', patch: Partial<DocSharePanel> = {}): ShareEvent => ({ type: 'panel', seq, panel: panel(status, patch) });

it('replaces the panel whole with each newer read and drops a read that a newer one overtook', () => {
  const state = run(read(2, 'paused'), read(1, 'active'));
  expect(state.seq).toBe(2);
  expect(shownLinks(state)).toEqual([{ share: link('paused') }]);
});

it('shows an action as pending at once and ignores another on the same key until the first is answered', () => {
  const state = run(read(1), { type: 'start', id: 'a', rid: 'r1', action: 'pause' }, { type: 'start', id: 'a', rid: 'r2', action: 'terminate' });
  expect(shownLinks(state)).toEqual([{ share: link(), sending: 'pause' }]);
  expect(state.overlays.a.rid).toBe('r1');
});

it('keeps a confirmed key over reads issued before the answer, and lets the first later read decide', () => {
  const confirmed = run(read(1), { type: 'start', id: 'a', rid: 'r1', action: 'pause' }, { type: 'confirmed', id: 'a', rid: 'r1', share: link('paused'), after: 2 });
  expect(shownLinks(confirmed)).toEqual([{ share: link('paused') }]);
  // Read 2 was issued before the answer and may predate the pause.
  const early = reduceShares(confirmed, read(2, 'active'));
  expect(shownLinks(early)[0].share.status).toBe('paused');
  // Read 3 was issued after it: the bridge's word stands, whatever it says.
  const later = reduceShares(early, read(3, 'terminated'));
  expect(later.overlays).toEqual({});
  expect(shownLinks(later)[0].share.status).toBe('terminated');
});

it('reverts a refused action with its reason, until the next action on that key', () => {
  const refused = run(read(1), { type: 'start', id: 'a', rid: 'r1', action: 'delete' }, { type: 'refused', id: 'a', rid: 'r1', reason: '删除没有完成：这个密钥已不存在' });
  expect(shownLinks(refused)).toEqual([{ share: link(), refusal: '删除没有完成：这个密钥已不存在' }]);
  expect(shownLinks(reduceShares(refused, read(2)))[0].refusal).toBe('删除没有完成：这个密钥已不存在');
  expect(shownLinks(reduceShares(refused, { type: 'start', id: 'a', rid: 'r2', action: 'delete' }))).toEqual([{ share: link(), sending: 'delete' }]);
});

it('drops an answer for an action that is no longer the current one', () => {
  const state = run(read(1), { type: 'start', id: 'a', rid: 'r1', action: 'pause' });
  expect(reduceShares(state, { type: 'confirmed', id: 'a', rid: 'old', share: link('terminated'), after: 1 })).toBe(state);
  expect(reduceShares(state, { type: 'refused', id: 'a', rid: 'old', reason: 'x' })).toBe(state);
});

it('keeps a revealed key\'s ways in across reads until dismissed, and drops them when the key ends', () => {
  const revealed = run(read(1, 'pending'), { type: 'start', id: 'a', rid: 'r1', action: 'reveal' },
    { type: 'confirmed', id: 'a', rid: 'r1', share: link('active'), after: 1, connect });
  expect(revealed.secrets).toEqual({ a: { share: link('active'), connect, via: 'reveal', after: 1 } });
  // A read issued before the answer still says pending: the secret stays, on the active key.
  expect(shownLinks(reduceShares(revealed, read(1, 'pending')))).toEqual([{ share: link('active') }]);
  // The first later read retires the overlay; the secret outlives it.
  const later = reduceShares(revealed, read(2, 'active'));
  expect(later.overlays).toEqual({});
  expect(Object.keys(later.secrets)).toEqual(['a']);
  expect(reduceShares(later, { type: 'dismiss', id: 'a' }).secrets).toEqual({});
  expect(reduceShares(later, { type: 'dismiss', id: 'other' })).toBe(later);
  expect(reduceShares(later, read(3, 'terminated')).secrets).toEqual({});
  expect(reduceShares(later, read(3, 'active', { shares: [] })).secrets).toEqual({});
  // Ending the revealed key from the card forgets its secret at once.
  const ended = reduceShares(later, { type: 'start', id: 'a', rid: 'r2', action: 'terminate' });
  expect(reduceShares(ended, { type: 'confirmed', id: 'a', rid: 'r2', share: link('terminated'), after: 2 }).secrets).toEqual({});
});

it('keeps no secret from an answer that is no longer the current one, or from a refused reveal', () => {
  const sending = run(read(1, 'pending'), { type: 'start', id: 'a', rid: 'r1', action: 'reveal' });
  expect(reduceShares(sending, { type: 'confirmed', id: 'a', rid: 'old', share: link('active'), after: 1, connect }).secrets).toEqual({});
  expect(reduceShares(sending, { type: 'refused', id: 'a', rid: 'r1', reason: '这个密钥的接入命令已经领取过；如果丢失，请终止后重新创建。' }).secrets).toEqual({});
});

it('shows a key the card just took before any read lists it, and keeps its ways in until the key leaves', () => {
  const mine = { ...link('active', 'n'), via: 'card' as const, mine: true };
  const sending = run(read(1), { type: 'begin', task: 'take', rid: 't1', value: 'write' });
  expect(sending.tasks.take).toEqual({ rid: 't1', phase: 'sending', value: 'write' });
  // A second take while the first is on its way changes nothing.
  expect(reduceShares(sending, { type: 'begin', task: 'take', rid: 't2', value: 'read' })).toBe(sending);
  const taken = reduceShares(sending, { type: 'taken', rid: 't1', share: mine, connect, after: 1 });
  expect(taken.tasks).toEqual({});
  expect(shownLinks(taken).map((l) => l.share.id)).toEqual(['n', 'a']);
  expect(taken.secrets.n).toEqual({ share: mine, connect, via: 'take', after: 1 });
  // A read issued before the answer does not list it yet: it stays, and so does its secret.
  const early = reduceShares(taken, read(1));
  expect(shownLinks(early).map((l) => l.share.id)).toEqual(['n', 'a']);
  expect(Object.keys(early.secrets)).toEqual(['n']);
  // A later read lists it: shown from the panel, once.
  const listed = reduceShares(taken, read(2, 'active', { shares: [mine, link()] }));
  expect(listed.taken).toEqual({});
  expect(shownLinks(listed).map((l) => l.share.id)).toEqual(['n', 'a']);
  expect(Object.keys(listed.secrets)).toEqual(['n']);
  // A later read that no longer lists it (deleted by someone else): the key and its ways in go.
  const gone = reduceShares(taken, read(2));
  expect(shownLinks(gone).map((l) => l.share.id)).toEqual(['a']);
  expect(gone.secrets).toEqual({});
});

it('keeps a refused take with its reason until it is set aside or tried again, and drops a stale answer', () => {
  const refused = run(read(1), { type: 'begin', task: 'take', rid: 't1', value: 'write' }, { type: 'fail', task: 'take', rid: 't1', reason: '领取没有完成：卡片所有者关闭了自助领取' });
  expect(refused.tasks.take).toEqual({ rid: 't1', phase: 'refused', reason: '领取没有完成：卡片所有者关闭了自助领取' });
  expect(reduceShares(refused, { type: 'clear', task: 'take' }).tasks).toEqual({});
  expect(reduceShares(refused, { type: 'begin', task: 'take', rid: 't2', value: 'read' }).tasks.take).toEqual({ rid: 't2', phase: 'sending', value: 'read' });
  expect(reduceShares(refused, { type: 'taken', rid: 'old', share: link('active', 'n'), connect, after: 1 })).toBe(refused);
  expect(reduceShares(refused, { type: 'fail', task: 'take', rid: 'old', reason: 'x' })).toBe(refused);
  // Nothing on its way is cleared.
  const sending = run(read(1), { type: 'begin', task: 'take', rid: 't1', value: 'write' });
  expect(reduceShares(sending, { type: 'clear', task: 'take' })).toBe(sending);
});

it('shows the owner\'s self-serve choice at once, the bridge\'s answer once it comes, and reverts a refusal', () => {
  const sending = run(read(1), { type: 'begin', task: 'settings', rid: 's1', value: 'read' });
  expect(shownSelfServe(sending)).toBe('read');
  // The answer is the panel as of its arrival: it outranks the reads issued before it.
  const settled = reduceShares(sending, { type: 'settled', rid: 's1', seq: 3, panel: panel('active', { self_serve: 'read' }) });
  expect(settled.tasks).toEqual({});
  expect(shownSelfServe(settled)).toBe('read');
  expect(reduceShares(settled, read(2)).panel?.self_serve).toBe('read');
  const refused = reduceShares(sending, { type: 'fail', task: 'settings', rid: 's1', reason: '保存设置没有完成：只有卡片所有者可以这样操作' });
  expect(shownSelfServe(refused)).toBe('write');
  expect(refused.tasks.settings).toMatchObject({ phase: 'refused' });
  expect(shownSelfServe(NO_SHARES)).toBeNull();
});

it('shows a new claim link once, its state until a later read, and forgets the link when it is replaced or stopped', () => {
  const made = { active: true, created_at: 50 };
  const sending = run(read(1), { type: 'begin', task: 'invite', rid: 'i1', value: 'create' });
  const link = 'https://octopus.example/feishu/doc-key#i=dsi_one';
  const created = reduceShares(sending, { type: 'invited', rid: 'i1', invite: made, link, after: 1 });
  expect(created.tasks).toEqual({});
  expect(shownInvite(created)).toEqual(made);
  expect(created.claim).toEqual({ link, created_at: 50, after: 1 });
  // A read issued before the answer cannot judge it; a later one that reports the same link keeps it shown.
  expect(shownInvite(reduceShares(created, read(1)))).toEqual(made);
  const same = reduceShares(created, read(2, 'active', { invite: made }));
  expect(same.invite).toBeNull();
  expect(same.claim?.link).toBe(link);
  expect(reduceShares(same, { type: 'unclaim' }).claim).toBeNull();
  // Reset in another tab, or stopped there: the link shown here is dead.
  expect(reduceShares(created, read(2, 'active', { invite: { active: true, created_at: 60 } })).claim).toBeNull();
  expect(reduceShares(created, read(2, 'active', { invite: { active: false, created_at: null } })).claim).toBeNull();
  // Stopping it here forgets it at once.
  const stopping = reduceShares(created, { type: 'begin', task: 'invite', rid: 'i2', value: 'revoke' });
  const stopped = reduceShares(stopping, { type: 'invited', rid: 'i2', invite: { active: false, created_at: null }, after: 1 });
  expect(stopped.claim).toBeNull();
  expect(shownInvite(stopped)).toEqual({ active: false, created_at: null });
});

it('words the contract error codes and keeps any other bridge message', () => {
  expect(refusalText('pause', new AgentApiError(403, 'not_owner'))).toBe('暂停没有完成：只有卡片所有者可以这样操作');
  expect(refusalText('pause', new AgentApiError(409, 'pending'))).toBe('暂停没有完成：这个密钥还没有领取接入命令，不能暂停或恢复；不需要了可以直接终止');
  expect(refusalText('reveal', new AgentApiError(409, 'not_pending'))).toBe('这个密钥的接入命令已经领取过；如果丢失，请终止后重新创建。');
  expect(refusalText('reveal', new AgentApiError(0, '暂时连不上 Octopus，请检查网络'))).toBe('显示接入命令没有完成：暂时连不上 Octopus，请检查网络');
  expect(refusalText('resume', new AgentApiError(404, 'unknown_share'))).toBe('恢复没有完成：这个密钥已不存在');
  expect(refusalText('terminate', new AgentApiError(409, 'terminated'))).toBe('终止没有完成：这个密钥已经终止，不能再更改');
  // Deleting a key someone already ended: what the reader wanted is done.
  expect(refusalText('delete', new AgentApiError(409, 'terminated'))).toBe('这个密钥已经停用了。');
  expect(refusalText('delete', new AgentApiError(404, 'unknown_anchor'))).toBe('删除没有完成：Octopus 不认识这张卡片');
  expect(refusalText('pause', new AgentApiError(500, 'toString'))).toBe('暂停没有完成：toString');
});

it('words a refused take, setting or claim-link change, naming the limits a 429 hit', () => {
  const limits = { per_hour: 10, active_max: 50 };
  expect(taskRefusal('take', new AgentApiError(403, 'self_serve_off'), limits)).toBe('领取没有完成：卡片所有者关闭了自助领取');
  expect(taskRefusal('take', new AgentApiError(403, 'rights_exceed'), limits)).toBe('领取没有完成：卡片所有者只允许领取只读密钥');
  expect(taskRefusal('take', new AgentApiError(403, 'host_mismatch'), limits)).toBe('领取没有完成：这张卡片不属于本文档，不能在这里领取');
  expect(taskRefusal('take', new AgentApiError(409, 'card_missing'), limits)).toBe('领取没有完成：文档里暂时找不到这张卡片；确认卡片还在文档里后刷新再试');
  expect(taskRefusal('take', new AgentApiError(429, 'rate_limited'), limits)).toBe('领取没有完成：这张卡片每小时最多领取 10 个密钥，请稍后再试');
  expect(taskRefusal('take', new AgentApiError(429, 'too_many_keys'), limits)).toBe('领取没有完成：这张卡片的密钥已达上限（50 个），请先删除不用的密钥');
  // A 429 the bridge does not word names both limits; one it words is shown as it is.
  expect(taskRefusal('take', new AgentApiError(429, 'Octopus 返回错误（429）'), limits)).toBe('领取没有完成：领取太频繁或密钥太多（每小时最多 10 个，同时最多 50 个），请稍后再试或先删除不用的密钥');
  expect(taskRefusal('take', new AgentApiError(429, '这一小时已经领取了 10 个'), limits)).toBe('领取没有完成：这一小时已经领取了 10 个');
  expect(taskRefusal('take', new AgentApiError(0, '暂时连不上 Octopus，请检查网络'))).toBe('领取没有完成：暂时连不上 Octopus，请检查网络');
  expect(taskRefusal('settings', new AgentApiError(403, 'not_owner'))).toBe('保存设置没有完成：只有卡片所有者可以这样操作');
  expect(taskRefusal('create', new Error(''))).toBe('生成领取链接没有完成：请重试');
  expect(taskRefusal('reset', new AgentApiError(403, 'not_owner'))).toBe('重置领取链接没有完成：只有卡片所有者可以这样操作');
  expect(taskRefusal('revoke', new AgentApiError(0, '暂时连不上 Octopus，请检查网络'))).toBe('停用领取链接没有完成：暂时连不上 Octopus，请检查网络');
});

it('tells the bridge\'s refusals of the panel apart: no login, outside the tenant, an unknown card, the network', () => {
  expect(panelProblem(new AgentApiError(401, '连接已失效，请使用飞书身份重新连接'))).toEqual({ kind: 'signin', detail: '连接已失效，请使用飞书身份重新连接' });
  expect(panelProblem(new AgentApiError(403, '此飞书组织尚未接入 Octopus'))).toEqual({ kind: 'tenant', detail: '此飞书组织尚未接入 Octopus' });
  expect(panelProblem(new AgentApiError(404, 'unknown_anchor'))).toEqual({ kind: 'unknown', detail: '' });
  expect(panelProblem(new AgentApiError(0, '暂时连不上 Octopus，请检查网络')).kind).toBe('network');
  expect(panelProblem(new AgentApiError(404, 'not found')).kind).toBe('failed');
  // An error that is not the bridge's answer is the card's own failure.
  expect(panelProblem(new TypeError('x is undefined'))).toEqual({ kind: 'failed', detail: 'x is undefined' });
});

it('shows the owner\'s change to the card\'s assistants at once, until a read issued after the answer reports them', () => {
  const on = { rights: 'write' as const, project: { device: 'desk', workspace_id: 'ws_acc', label: 'ACC' }, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } };
  expect(shownAssistant(NO_SHARES)).toBeNull();
  const changed = reduceShares(run(read(1)), { type: 'assistant', settings: on, after: 1 });
  expect(shownAssistant(changed)).toEqual(on);
  // A read issued before the answer may predate it: the change stands.
  const kept = reduceShares(reduceShares(run(read(1)), { type: 'assistant', settings: on, after: 2 }), read(2));
  expect(shownAssistant(kept)).toEqual(on);
  // A read issued after it: the bridge's word stands, whatever it says.
  const later = reduceShares(changed, read(2));
  expect(later.assistant).toBeNull();
  expect(shownAssistant(later)?.rights).toBeNull();
});
