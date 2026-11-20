import type { DiscussionCapabilities } from '../../discussions/capability.js';
import { DISCUSSION_TOOLS, readToolArgs } from '../../mcp/tools.js';
import { bodyOf, replyJson as json } from '../http.js';
import type { GuardedRoutes } from './context.js';

export function registerDiscussionRoutes(routes: GuardedRoutes, capabilities?: DiscussionCapabilities): void {
  // Pure local projections: safe to refresh; no provider or capability call.
  routes.get('/api/discussions', 'api.discussions.read', (req, reply, identity) => {
    if (!capabilities) { json(reply, 200, { enabled: false, canConvene: false, discussions: [] }); return; }
    const owner = identity.username!;
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    try {
      const id = query.get('discussion_id');
      json(reply, 200, { enabled: capabilities.discussions.enabled, canConvene: capabilities.discussions.canConvene(owner), discussions: capabilities.discussions.list(owner), ...(id ? { selected: capabilities.discussions.read(owner, id) } : {}) });
    } catch (error) { json(reply, 403, { error: error instanceof Error ? error.message : '会议不可读' }); }
  });
  routes.post('/api/discussions/action', 'api.discussions.action', { body: { type: 'object', additionalProperties: false, required: ['action', 'args'], properties: { action: { type: 'string', enum: DISCUSSION_TOOLS.map(tool => tool.name) }, args: { type: 'object', maxProperties: 8 } } } }, async (req, reply, identity) => {
    if (!capabilities) { json(reply, 503, { error: '会议服务未启用' }); return; }
    // Only an authenticated browser can take the human path. Bearer callers
    // use MCP and its separate operation grants/approval lifecycle.
    if (!identity.session || !identity.username) { json(reply, 403, { error: '请本人登录后操作会议；CLI 请使用 MCP' }); return; }
    const body = bodyOf(req), spec = DISCUSSION_TOOLS.find(tool => tool.name === body.action);
    if (!spec) { json(reply, 400, { error: '未知会议操作' }); return; }
    const args = readToolArgs(spec, body.args);
    if (!args.ok) { json(reply, 400, { error: args.message }); return; }
    const grant = capabilities.open(identity.username, [spec.name], [spec.name]);
    if (!grant) { json(reply, 403, { error: '当前账号没有此会议能力' }); return; }
    try {
      const out = await grant.request(spec.name, args.value);
      if (out.status === 'succeeded') json(reply, 200, { result: out.result });
      else json(reply, out.status === 'approval_required' ? 409 : 400, { error: out.status === 'approval_required' ? '请在待批准中确认此会议操作' : out.reason, status: out.status });
    } finally { grant.close(); }
  });
}
