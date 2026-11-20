import { describe, expect, it } from 'vitest';
import {
  AgentApiError, mergeRows, parseBinding, parseDocShare, readAssistantList, readAssistantPinned, readAssistantSettings, readAssistantStarted, readAssistantStatus, readAssistantTargets,
  readAssistantView, readDocShareActionReply, readDocShareInviteReply, readDocSharePanel, readDocShareRevealReply, readDocShareSelfReply,
} from './protocol';

const share = `ds_${'A'.repeat(43)}`;
it('reads only a well-formed v2 binding from the shared Record', () => {
  expect(parseBinding({ v: 2, share, title: 'T', owner: 'lht', device: 'd', provider: 'codex', doc: 'doc' })).toMatchObject({ share, doc: 'doc' });
  for (const bad of [null, 'x', { v: 1, share, doc: 'doc' }, { v: 2, share: 'resource-id', doc: 'doc' }, { v: 2, share }]) expect(parseBinding(bad)).toBeNull();
  expect(parseBinding({ v: 2, share, doc: 'doc', title: 'x'.repeat(999) })!.title).toHaveLength(240);
});
it('patches rows from the first index of a frame and replaces them on reset', () => {
  const rows = [0, 1, 2].map((i) => ({ i, role: 'assistant' as const, text: `v${i}` }));
  expect(mergeRows(rows, { reset: false, messages: [{ i: 2, role: 'assistant', text: 'v2+' }, { i: 3, role: 'user', text: 'new' }] }).map((r) => r.text)).toEqual(['v0', 'v1', 'v2+', 'new']);
  expect(mergeRows(rows, { reset: false, messages: [] })).toBe(rows);
  expect(mergeRows(rows, { reset: true, messages: [] })).toEqual([]);
});

const anchor = `dsa_${'A'.repeat(43)}`;
it('reads a share card Record, and tells a newer or broken one apart from no share card at all', () => {
  expect(parseDocShare(undefined)).toBeNull();
  expect(parseDocShare({ v: 1, anchor, extra: 'ignored' })).toEqual({ v: 1, anchor });
  expect(parseDocShare({ v: 2, anchor })).toEqual({ invalid: 'version' });
  for (const bad of [null, 'x', [], {}, { v: 1 }, { v: '1', anchor }, { v: 1, anchor: share }, { v: 1, anchor: 'dsa_short' },
    { v: 1, anchor: `dsa_${'A'.repeat(129)}` }, { v: 1, anchor: `dsa_${'A'.repeat(42)}=` }, { v: 1, anchor: `dsa_${'A'.repeat(42)}/` }]) {
    expect(parseDocShare(bad)).toEqual({ invalid: 'malformed' });
  }
});

const link = { id: 's', label: '论文', rights: 'read', status: 'paused', created_at: 1, last_used_at: null, via: 'card', mine: true };
const connect = {
  claude: 'claude mcp add --transport http --scope user octopus-doc-s https://octopus.example/api/mcp --header "Authorization: Bearer secret-token"',
  codex: `printf '\\n[mcp_servers.octopus-doc-s]\\nurl = "https://octopus.example/api/mcp"\\n' >> ~/.codex/config.toml`,
  endpoint: 'https://octopus.example/api/mcp', token: 'secret-token',
};
/** Whatever a reader refuses, its error never quotes the token it was handed. */
const refusal = (read: () => unknown) => { try { read(); return null; } catch (error) { return error as Error; } };

it('takes a share panel reply only as the contract words it', () => {
  const reply = {
    document_id: 'doc', host_matches: false, viewer_is_owner: false, card_state: 'missing', lease_until: 5,
    shares: [link, { ...link, id: 't', last_used_at: 2, via: 'owner', mine: false }, { ...link, id: 'u', status: 'pending', via: 'invite' }],
    self_serve: 'read', app_access: 'view', app_name: 'Octopus', invite: null, limits: { per_hour: 10, active_max: 50 },
    assistant: { rights: null, project: null, limits: { per_card: 20, per_guest: 3, per_guest_per_day: 10 } },
  };
  expect(readDocSharePanel(reply)).toEqual(reply);
  // The owner's view carries the claim link's state; the app's name may be unknown, and is bounded.
  expect(readDocSharePanel({ ...reply, invite: { active: true, created_at: 9 }, app_name: null })).toMatchObject({ invite: { active: true, created_at: 9 }, app_name: null });
  expect(readDocSharePanel({ ...reply, invite: { active: false, created_at: null } }).invite).toEqual({ active: false, created_at: null });
  expect(readDocSharePanel({ ...reply, app_name: 'x'.repeat(999) }).app_name).toHaveLength(240);
  // A bridge that does not answer the host match leaves it unknown.
  const { host_matches: _, ...unmatched } = reply;
  expect(readDocSharePanel(unmatched).host_matches).toBeNull();
  expect(readDocSharePanel({ ...reply, host_matches: null }).host_matches).toBeNull();
  const { invite: _i, ...noInvite } = reply;
  const { limits: _l, ...noLimits } = reply;
  for (const bad of [null, { ...reply, shares: undefined }, { ...reply, card_state: 'gone' }, { ...reply, viewer_is_owner: 'no' }, { ...reply, lease_until: undefined }, { ...reply, host_matches: 'yes' },
    { ...reply, shares: [{ ...link, status: 'expired' }] }, { ...reply, shares: [{ ...link, rights: 'admin' }] }, { ...reply, shares: [{ ...link, created_at: '2026-10-27' }] },
    { ...reply, shares: [{ ...link, via: 'agent' }] }, { ...reply, shares: [{ ...link, mine: 'yes' }] }, { ...reply, shares: [{ ...link, via: undefined }] },
    { ...reply, self_serve: 'admin' }, { ...reply, self_serve: undefined }, { ...reply, app_access: 'owner' }, { ...reply, app_name: 7 }, { ...reply, app_name: undefined },
    noInvite, { ...reply, invite: { active: 'yes', created_at: null } }, { ...reply, invite: { active: true, created_at: '2026-10-30' } }, { ...reply, invite: {} },
    noLimits, { ...reply, limits: { per_hour: '10', active_max: 50 } }, { ...reply, limits: { per_hour: 10 } },
    { ...reply, assistant: null }, { ...reply, assistant: { ...reply.assistant, rights: 'admin' } }, { ...reply, assistant: { ...reply.assistant, limits: { per_card: 20 } } }]) {
    expect(() => readDocSharePanel(bad)).toThrow(AgentApiError);
  }
  // A bridge from before assistants (or rolled back to one) still reads: no `assistant` is "off", and an assistant's own share is listed.
  const { assistant: _a, ...older } = reply;
  expect(readDocSharePanel(older).assistant).toEqual({ rights: null, project: null, limits: { per_card: 0, per_guest: 0, per_guest_per_day: 0 } });
  expect(readDocSharePanel({ ...reply, shares: [{ ...link, via: 'assistant' }] }).shares[0].via).toBe('assistant');
  expect(readDocShareActionReply({ share: link })).toEqual({ share: link });
  expect(() => readDocShareActionReply({ share: { ...link, id: '' } })).toThrow('Octopus 返回的共享链接格式不对');
  expect(() => readDocShareActionReply({ share: { ...link, mine: undefined } })).toThrow(AgentApiError);
});

it('takes a reveal reply only as one valid key, its one-line command and its ways in, and never quotes them when refusing it', () => {
  const share = { ...link, status: 'active', via: 'owner', mine: false };
  const command = connect.claude;
  expect(readDocShareRevealReply({ share, command, connect })).toEqual({ share, command, connect });
  for (const bad of [null, { share, connect }, { command, connect }, { share, command }, { share, command: '', connect }, { share, command: '   ', connect }, { share, command: 42, connect },
    { share, command: `${command}\nrm -rf ~`, connect }, { share, command: `${command}\u001b[2K`, connect }, { share, command: 'x'.repeat(8193), connect }, { share: { ...share, status: 'revealed' }, command, connect }]) {
    expect(() => readDocShareRevealReply(bad)).toThrow(AgentApiError);
  }
  const refused = refusal(() => readDocShareRevealReply({ share, command: `${command}\r`, connect }));
  expect(refused).toBeInstanceOf(AgentApiError);
  expect(refused?.message).not.toContain('secret-token');
});

it('takes a self-serve reply only as one valid key and its ways in: each one printable line, the endpoint HTTPS', () => {
  const share = { ...link, status: 'active', rights: 'write' };
  expect(readDocShareSelfReply({ share, connect })).toEqual({ share, connect });
  expect(readDocShareSelfReply({ share, connect: { ...connect, extra: 'ignored' } }).connect).toEqual(connect);
  for (const bad of [null, { share }, { connect }, { share: { ...share, mine: 1 }, connect }, { share, connect: { ...connect, claude: undefined } }, { share, connect: { ...connect, codex: '' } },
    { share, connect: { ...connect, token: 7 } }, { share, connect: { ...connect, endpoint: 'http://octopus.example/api/mcp' } }, { share, connect: { ...connect, endpoint: 'octopus.example' } },
    { share, connect: { ...connect, codex: `${connect.codex}\n` } }, { share, connect: { ...connect, claude: 'x'.repeat(8193) } }, { share, connect: { ...connect, token: 'a\u0000b' } }]) {
    expect(() => readDocShareSelfReply(bad)).toThrow(AgentApiError);
  }
  const refused = refusal(() => readDocShareSelfReply({ share, connect: { ...connect, token: 'secret-token\u0007' } }));
  expect(refused).toBeInstanceOf(AgentApiError);
  expect(refused?.message).not.toContain('secret-token');
});

it('takes a claim-link reply only with a well-formed link state, and a link only as an https page holding the minted secret', () => {
  const link = `https://octopus.example/feishu/doc-key#i=dsi_${'Q'.repeat(43)}`;
  const made = { active: true, created_at: 5 };
  expect(readDocShareInviteReply({ invite: made, link })).toEqual({ invite: made, link });
  expect(readDocShareInviteReply({ invite: { active: false, created_at: null } })).toEqual({ invite: { active: false, created_at: null } });
  // The old shape's bare secret is not a link: it is dropped, never shown.
  expect(readDocShareInviteReply({ invite: made, secret: `dsi_${'Q'.repeat(43)}` })).toEqual({ invite: made });
  for (const bad of [null, {}, { link }, { invite: null, link }, { invite: { active: 1, created_at: 5 } }, { invite: made, link: 42 }, { invite: made, link: '' },
    { invite: made, link: link.replace('https:', 'http:') }, { invite: made, link: `dsi_${'Q'.repeat(43)}` }, { invite: made, link: link.replace('#i=dsi_', '#i=dsa_') },
    { invite: made, link: `${link}x` }, { invite: made, link: `${link}&next=1` }, { invite: made, link: link.replace('octopus.example', 'octopus.example ') },
    { invite: made, link: `${link}\n` }, { invite: made, link: 'https://octopus.example/feishu/doc-key#i=dsi_short' }]) {
    expect(() => readDocShareInviteReply(bad)).toThrow(AgentApiError);
  }
});

describe('document assistant replies', () => {
  const limits = { per_card: 20, per_guest: 3, per_guest_per_day: 10 };
  const view = { id: 'as_1', title: '整理第三节', guest: '张三', mine: true, state: 'ready', message: '可以对话', rights: 'write', created_at: 1, ended_at: null, pinned: false };
  const bad = (read: (value: unknown) => unknown, values: unknown[]) => { for (const value of values) expect(() => read(value)).toThrow('Octopus 返回的文档助手数据格式不对'); };

  it('takes settings only as rights (or off), a project (or none) and the three limits', () => {
    const on = { rights: 'read', project: { device: 'desk', workspace_id: 'ws_acc', label: 'ACC' }, limits };
    expect(readAssistantSettings(on)).toEqual(on);
    expect(readAssistantSettings({ rights: null, project: null, limits })).toEqual({ rights: null, project: null, limits });
    expect(readAssistantSettings({ ...on, project: { ...on.project, label: 'x'.repeat(999) } }).project?.label).toHaveLength(240);
    bad(readAssistantSettings, [null, { ...on, rights: 'admin' }, { ...on, rights: undefined }, { ...on, project: { device: 'desk' } }, { ...on, project: undefined },
      { ...on, limits: { per_card: 20, per_guest: 3 } }, { ...on, limits: { ...limits, per_guest_per_day: '10' } }]);
  });

  it('takes targets only as devices with their workspaces, a reason only as text', () => {
    const devices = [{ device: 'desk', label: 'desk', eligible: true, workspaces: [{ workspace_id: 'ws_acc', label: 'ACC' }] }, { device: 'old', label: 'old', eligible: false, reason: '设备离线', workspaces: [] }];
    expect(readAssistantTargets({ devices })).toEqual({ devices });
    bad(readAssistantTargets, [null, {}, { devices: [{ ...devices[0], eligible: 'yes' }] }, { devices: [{ ...devices[0], workspaces: [{ workspace_id: 'ws_acc' }] }] },
      { devices: [{ ...devices[1], reason: 7 }] }, { devices: [{ ...devices[0], workspaces: undefined }] }]);
  });

  it('takes an assistant only in a known state, and a status\'s card only as a well-formed Claude capability', () => {
    expect(readAssistantView(view)).toEqual(view);
    expect(readAssistantList({ assistants: [view, { ...view, id: 'as_2', state: 'ended', ended_at: 2, mine: false }] }).assistants).toHaveLength(2);
    const binding = { share: `ds_${'B'.repeat(43)}`, title: '整理第三节', owner: 'lht', device: 'desk', provider: 'claude' };
    expect(readAssistantStatus({ ...view, binding })).toEqual({ ...view, binding });
    expect(readAssistantStatus({ ...view, state: 'starting', message: '正在启动…' })).not.toHaveProperty('binding');
    bad(readAssistantView, [null, { ...view, state: 'running' }, { ...view, id: '' }, { ...view, rights: 'admin' }, { ...view, pinned: 'no' }, { ...view, ended_at: undefined }, { ...view, mine: undefined }]);
    bad(readAssistantList, [null, {}, { assistants: [{ ...view, created_at: 'today' }] }]);
    bad(readAssistantStatus, [{ ...view, binding: { ...binding, share: 'ds_short' } }, { ...view, binding: { ...binding, provider: 'codex' } }, { ...view, binding: null }]);
    expect(readAssistantStarted({ id: 'as_1' })).toEqual({ id: 'as_1' });
    expect(readAssistantPinned({ block: 'blk_1' })).toEqual({ block: 'blk_1' });
    bad(readAssistantStarted, [null, { id: '' }, { id: 7 }]);
    bad(readAssistantPinned, [null, { block: '' }]);
  });
});
