import { CapabilityService } from '@claude-bot/capability-kernel';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../store/store.js';
import { PermissionService } from '../permissions/service.js';
import { SessionHubService } from '../sessionhub/service.js';
import { DiscussionService } from '../discussions/service.js';
import { DiscussionCapabilities, DISCUSSION_OPERATION_IDS } from '../discussions/capability.js';
import { McpSurface } from './service.js';
import { MCP_SUBJECT_ID, mcpSubjectEntry } from './catalog.js';
import { mcpSessionExecutionPolicy, mcpTokenPolicy } from './tokens.js';
import { handleMcpRpc } from './http.js';

describe('meeting MCP capability boundary', () => {
  it('supports generic MCP, Runner account bridge and hosted session scopes without widening other tools', async () => {
    const store = new Store(':memory:'), kernel = new CapabilityService();
    for (const [index, username] of ['lht', 'lilei', 'other'].entries()) { store.saveUser({ username, uid: index + 1, home_dir: '/x', created_at: 'now' }); store.saveIdentity(username, { provider: 'feishu', externalId: `ou_${username}` }); }
    const create = vi.fn(async () => 'oc_room');
    const meetings = new DiscussionService(store, { create, send: vi.fn(), card: vi.fn(async () => 'card'), history: vi.fn() }, { enabled: true, filter: vi.fn(), run: vi.fn(async () => ({ kind: 'done' as const, text: '', toolCalls: 0 })) });
    const capabilities = new DiscussionCapabilities(kernel, meetings, owner => Boolean(store.getUser(owner)));
    const permissions = new PermissionService({ store, subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false, discussionsComposed: () => true })], extraAccountOperations: [owner => capabilities.accountOperations(owner)] });
    const resolve = vi.fn(() => ({}));
    const surface = new McpSurface({ hub: new SessionHubService({ store, permissions }), permissions, discussions: capabilities, sessionExecution: { resolve, close: vi.fn(), releaseCredential: vi.fn(), releaseOwner: vi.fn() } as never });
    const principal = { owner: 'lht', credential: 'mcp:test', policy: mcpTokenPolicy({ groups: ['discussions'] }) };
    const args = { request_id: 'wish-1', topic: '自动科研', participants: 'lilei' };
    const grant = (autoAllow: string[]) => permissions.grant({ subjectType: 'service', subjectId: MCP_SUBJECT_ID, owner: 'lht', operations: DISCUSSION_OPERATION_IDS, autoAllow, source: 'user', createdBy: 'lht' });
    try {
      expect(surface.listTools(principal)).toEqual([]);
      expect(await surface.callTool(principal, 'discussion_start', args)).toMatchObject({ ok: false, code: 'no_authority' });
      grant([]);
      expect(surface.listTools(principal).map(tool => tool.name)).toEqual(DISCUSSION_OPERATION_IDS);
      expect(await surface.callTool(principal, 'discussion_start', { ...args, owner: 'other' })).toMatchObject({ ok: false, code: 'invalid_params' });
      expect(await surface.callTool(principal, 'discussion_start', args)).toMatchObject({ ok: false, code: 'approval_required' });
      expect(await surface.callTool(principal, 'discussion_start', args)).toMatchObject({ ok: false, code: 'approval_required' });
      expect(kernel.listPending('lht')).toHaveLength(1); expect(create).not.toHaveBeenCalled();
      expect((await kernel.approve(kernel.listPending('lht')[0]!.id, 'lilei')).status).toBe('denied');
      expect((await kernel.approve(kernel.listPending('lht')[0]!.id, 'lht')).status).toBe('succeeded');
      expect(await surface.callTool(principal, 'discussion_start', args)).toMatchObject({ ok: true, result: { topic: '自动科研' } });
      expect(create).toHaveBeenCalledTimes(1);
      grant(DISCUSSION_OPERATION_IDS);
      const rpc = await handleMcpRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discussion_list', arguments: {} } }, surface, { ...principal, credential: 'runner-local:laptop' });
      expect(rpc.status).toBe(200); expect(JSON.stringify(rpc.body)).toContain('自动科研');
      const scoped = { ...principal, credential: 'mcp:session', policy: mcpSessionExecutionPolicy({ operationId: 'op-test', runtimeDevice: 'runner', executionDevice: 'runner', workspaceId: 'ws_' + 'a'.repeat(24), permissionProfile: 'full_access' }) };
      expect(surface.listTools(scoped).map(tool => tool.name)).toContain('discussion_start');
      expect(await surface.callTool(scoped, 'discussion_list', {})).toMatchObject({ ok: true });
      expect(await surface.callTool(scoped, 'feishu_chat_create_as_bot', {})).toMatchObject({ ok: false, code: 'unknown_tool' });
      expect(await surface.callTool({ ...principal, policy: mcpTokenPolicy({ groups: ['feishu'] }) }, 'discussion_list', {})).toMatchObject({ ok: false, code: 'unknown_tool' });
      resolve.mockReturnValueOnce(null as never);
      expect(await surface.callTool(scoped, 'discussion_list', {})).toMatchObject({ ok: false, code: 'no_authority' });
      permissions.grant({ subjectType: 'service', subjectId: MCP_SUBJECT_ID, owner: 'lht', operations: [], autoAllow: [], source: 'user', createdBy: 'lht' });
      expect(surface.listTools(principal)).toEqual([]);
      expect(await surface.callTool(principal, 'discussion_start', args)).toMatchObject({ ok: false });
    } finally { surface.close(); await meetings.close(); permissions.close(); kernel.close(); store.close(); }
  });
});
