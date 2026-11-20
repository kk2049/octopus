#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools.mjs';

const socketPath = process.env.OCTOPUS_BROWSER_SOCKET ?? path.join(os.homedir(), '.local/state/octopus-browser/browser.sock');
async function call(name, args) {
  const data = JSON.stringify({ name, arguments: args });
  const raw = await new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/call', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: 18_000 }, (response) => {
      const parts = []; let size = 0;
      response.on('data', (part) => { size += part.length; if (size > 250_000) request.destroy(new Error('Browser result exceeds output budget')); else parts.push(part); });
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString())); } catch (e) { reject(e); } });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Browser call timed out; inspect the same context before further input; do not resend automatically')));
    request.on('error', reject); request.end(data);
  });
  if (raw.error) throw new Error(raw.error);
  return raw.result;
}
function content(result) {
  const { image, ...summary } = result;
  if (summary.artifact) summary.path = path.join(path.dirname(socketPath), 'artifacts', summary.artifact);
  return { content: [{ type: 'text', text: JSON.stringify(summary) }, ...(image ? [{ type: 'image', mimeType: 'image/jpeg', data: image }] : [])] };
}
if (process.argv[2] === 'mcp') {
  const server = new Server({ name: 'octopus-browser', version: '1.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try { return content(await call(params.name, params.arguments ?? {})); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  await server.connect(new StdioServerTransport());
} else if (process.argv[2] === 'tools') {
  console.log(JSON.stringify(tools, null, 2));
} else {
  const name = process.argv[2] === 'doctor' ? 'browser_health' : process.argv[2];
  if (!tools.some((t) => t.name === name)) { console.error('Usage: octopus-browser doctor | tools | mcp | browser_<tool> JSON. Read tools for schemas.'); process.exitCode = 2; }
  else {
    try {
      const input = process.argv[3] === '-' ? JSON.parse(readFileSync(0, 'utf8')) : JSON.parse(process.argv[3] ?? '{}');
      const result = await call(name, input);
      const { image, ...summary } = result;
      if (summary.artifact) summary.path = path.join(path.dirname(socketPath), 'artifacts', summary.artifact);
      console.log(JSON.stringify(summary, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
