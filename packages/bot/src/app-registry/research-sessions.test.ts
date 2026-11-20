import { describe, expect, it, vi } from 'vitest';
import type { SessionPlusInstanceBinding } from '../app-core/instance.js';
import type { DeclaredResourcePlane } from './resource-plane.js';
import { ResearchSessionPlane } from './research-sessions.js';
import { RESEARCH_SESSION_CONTRACT_DIGEST, RESEARCH_SESSION_PROFILE } from '../session-resource/research-contract.js';
import { emptyContractDigestFor } from './declared-adapter.js';
import { resourceId } from '../sessionhub/core.js';
import type { SessionResourceWatchEvent } from '../session-resource/types.js';
function fixture() {
  const binding = { id: 'instance', owner: 'alice', actorKind: 'user', stableAppId: 'research-program', packageDigest: 'package', contractDigest: RESEARCH_SESSION_CONTRACT_DIGEST,
    projection: { viewer_role: 'owner', project: { archived: false }, sources: { lead: { kind: 'session' } }, source_locations: { revision: 1, sessions: { lead: { device: 'runner', provider: 'codex', session_id: 'real' } } } },
  } as unknown as SessionPlusInstanceBinding;
  const resource = resourceId({ owner: 'alice', device: 'runner', cliKind: 'codex', sessionId: 'real' });
  const transcript = { messages: [{ role: 'assistant', blocks: [{ type: 'text', text: 'private live reply' }] }], offset: 0, totalMessages: 1, hasMore: false, runtime: { capabilities: { managed_resume: true } } };
  const authority = { profile: RESEARCH_SESSION_PROFILE, open: vi.fn(), destroy: vi.fn(), contextIds: () => ['context'] };
  const resources = { execute: vi.fn(async () => ({ ok: true, result: transcript, patch: { transcript: { [resource]: transcript } } })), watchTranscript: vi.fn(() => ({ ok: true, subscription: { close: vi.fn() } })) };
  const operation = { id: 'op', resourceId: resource, status: 'queued', operation: 'append_session' };
  const operations = { submit: vi.fn(async () => ({ ok: true, operation })), subscribe: vi.fn(() => vi.fn()), endContexts: vi.fn() };
  const interactions = { submit: vi.fn() };
  const plane = new ResearchSessionPlane({ authority, resources, operations, interactions, devices: () => ['runner'] } as never);
  const input = (action = 'open_session', params = { resource: 'lead', prompt: 'continue' }): Parameters<DeclaredResourcePlane['dispatch']>[0] => ({ binding, principal: { owner: 'alice', session: true, credential: 'login' }, action, params, current: () => binding, publish: vi.fn(), operation: vi.fn() });
  return { binding, resource, transcript, authority, resources, operations, plane, input };
}
describe('reviewed Research session resource composition', () => {
  it('retains loaded history while following current runtime and rejects regressed tail windows', async () => {
    const h = fixture();
    let follow!: (event: SessionResourceWatchEvent) => void;
    h.resources.watchTranscript.mockImplementation((...args: unknown[]) => {
      follow = args[2] as typeof follow;
      return { ok: true, subscription: { close: vi.fn() } };
    });
    const message = (text: string) => ({ role: 'assistant', blocks: [{ type: 'text', text }] });
    const initial = { ...h.transcript, messages: [message('older'), message('tail')], totalMessages: 2,
      version: { epoch: 'one', sequence: 1 } };
    h.resources.execute.mockResolvedValue({ ok: true, result: initial, patch: { transcript: { [h.resource]: initial } } });
    await h.plane.dispatch(h.input());
    follow({ type: 'data', resource: h.resource, data: { offset: 1, totalMessages: 3,
      messages: [message('tail'), message('new reply')], runtime: null, version: { epoch: 'one', sequence: 2 } } });
    const projected = () => (h.plane.project(h.binding, h.binding.projection) as any).sessionResources.transcript.lead;
    expect(projected()).toMatchObject({ offset: 0, totalMessages: 3, runtime: null,
      messages: [message('older'), message('tail'), message('new reply')] });
    follow({ type: 'data', resource: h.resource, data: initial });
    expect(projected()).toMatchObject({ totalMessages: 3, runtime: null, version: { sequence: 2 } });
  });

  it('rebinds a published alias to the current owner before using the shared session service', async () => {
    const h = fixture();
    expect(await h.plane.dispatch(h.input())).toMatchObject({ ok: true });
    expect(h.resources.execute).toHaveBeenCalledWith('instance', 'open_session', expect.objectContaining({ resource: h.resource }), expect.anything(), { isCurrent: expect.any(Function) });
    expect(await h.plane.dispatch(h.input('append_session'))).toMatchObject({ ok: true, result: { opId: 'op', status: 'queued' } });
    expect(h.operations.submit).toHaveBeenCalledWith(expect.objectContaining({ id: 'instance' }), expect.objectContaining({ owner: 'alice' }), 'append_session', expect.objectContaining({ resource: h.resource, prompt: 'continue' }));
  });
  it.each(['unknown', 'foreign-resource'])('rejects %s without a capability call', async resource => {
    const h = fixture(); expect(await h.plane.dispatch(h.input('open_session', { resource, prompt: '' }))).toMatchObject({ ok: false });
    expect(h.authority.open).not.toHaveBeenCalled(); expect(h.resources.execute).not.toHaveBeenCalled();
  });
  it.each(['member', 'viewer', 'agent', 'archive', 'old-contract', 'foreign-device', 'hidden'])('fails closed for %s', async condition => {
    const h = fixture(), root = h.binding.projection as any;
    if (['member', 'viewer'].includes(condition)) root.viewer_role = condition;
    if (condition === 'agent') (h.binding as any).actorKind = 'agent';
    if (condition === 'archive') root.project.archived = true;
    if (condition === 'old-contract') (h.binding as any).contractDigest = emptyContractDigestFor('research-program', 'octopus:first-party');
    if (condition === 'foreign-device') root.source_locations.sessions.lead.device = 'bobs-runner';
    if (condition === 'hidden') root.sources.lead.hidden = true;
    expect(await h.plane.dispatch(h.input())).toMatchObject({ ok: false });
    expect(h.authority.open).not.toHaveBeenCalled();
  });
  it('requires a successful real read before uploading or sending', async () => {
    const h = fixture();
    expect(await h.plane.dispatch(h.input('append_session'))).toMatchObject({ ok: false });
    expect(await h.plane.dispatch(h.input('attach_file'))).toMatchObject({ ok: false });
    expect(h.operations.submit).not.toHaveBeenCalled(); expect(h.resources.execute).not.toHaveBeenCalled();
  });
  it('never upgrades a failed read into a writable session', async () => {
    const h = fixture(); h.resources.execute.mockResolvedValue({ ok: false, code: 'no_authority', message: 'grant missing' } as never);
    expect(await h.plane.dispatch(h.input())).toMatchObject({ ok: false, message: 'grant missing' });
    expect(h.plane.project(h.binding, h.binding.projection)).toMatchObject({ sessionResources: { sessions: [] } });
    expect(await h.plane.dispatch(h.input('append_session'))).toMatchObject({ ok: false });
  });
  it('keeps live transcripts out of shared state and other viewers', async () => {
    const h = fixture(); await h.plane.dispatch(h.input());
    expect(JSON.stringify(h.binding.projection)).not.toContain('private live reply');
    expect(h.plane.project({ ...h.binding, id: 'other-viewer', owner: 'bob' }, h.binding.projection)).toMatchObject({ sessionResources: { sessions: [], transcript: {} } });
    const forged = { ...(h.binding.projection as object), sessionResources: { transcript: { stolen: h.transcript } }, operations: [{ id: 'forged' }] };
    expect(JSON.stringify(h.plane.project({ ...h.binding, id: 'other-viewer' }, forged))).not.toContain('stolen');
  });
  it('cancels subscriptions, authority and queued operations when mappings change', async () => {
    const h = fixture(); await h.plane.dispatch(h.input());
    (h.binding.projection as any).source_locations.sessions.lead.session_id = 'replacement';
    expect(h.plane.project(h.binding, h.binding.projection)).toMatchObject({ sessionResources: { sessions: [], transcript: {} } });
    expect(h.authority.destroy).toHaveBeenCalledWith('instance');
    expect(h.operations.endContexts).toHaveBeenCalledWith('alice', ['context'], 'project_binding_changed');
  });
  it('drops late reads after mapping or connection changes', async () => {
    const h = fixture(); let finish!: (value: any) => void;
    h.resources.execute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const answer = h.plane.dispatch(h.input());
    h.plane.close(h.binding.id, 'instance_closed');
    finish({ ok: true, result: h.transcript, patch: {} });
    expect(await answer).toMatchObject({ ok: false });
    expect(h.plane.project(h.binding, h.binding.projection)).toMatchObject({ sessionResources: { sessions: [] } });
  });
});
