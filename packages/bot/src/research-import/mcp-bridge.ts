#!/usr/bin/env node
/** Project-scoped stdio registration for the existing authenticated Apps endpoint. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openResearchMcp } from './mcp-client.js';
const at = process.argv.indexOf('--config');
if (at < 0 || !process.argv[at + 1]) throw new Error('--config /private/mcp.json is required');
const client = await openResearchMcp(process.argv[at + 1]!);
const server = new Server({ name: 'octopus-research-apps', version: '1.0.0' }, {
  capabilities: { tools: {} },
  instructions: '先用 app_list 获取 research-program 的精确实例和动作 schema。通过 app_dispatch 调用 configure_project 改名；research_source_status 查询绑定与同步偏移；research_bind_source / research_publish_source 发布完整来源，research_read_source 回读验证。历史绑定不等于主导接力；set_lead_agent 单独登记真实继任者。只使用此令牌允许的实例；禁止代替真人确认学习或批准。项目维护步骤见 auto-research/AGENTS.md 和 OCTOPUS-MAINTENANCE.md。',
});
server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
server.setRequestHandler(CallToolRequestSchema, request => client.callTool(request.params, undefined, { timeout: 60000 }));
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { void client.close().then(() => server.close()); });
