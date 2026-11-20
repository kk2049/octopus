import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Decode the actual HTTP MCP envelope: successful structuredContent IS the result. */
export function appToolOutcome(value: any): { ok: true; result: any } | { ok: false; code: string; message: string } {
  const rendered = value.content?.find((row: any) => row.type === 'text')?.text ?? '';
  if (value.isError) {
    const match = /^([a-z_]+):\s*([\s\S]*)$/.exec(rendered);
    return { ok: false, code: match?.[1] ?? 'unknown', message: match?.[2] ?? rendered };
  }
  const result = value.structuredContent ?? (rendered ? JSON.parse(rendered) : undefined);
  if (result === undefined) throw new Error('MCP did not return a structured response');
  return { ok: true, result };
}
export async function openResearchMcp(configPath: string) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const url = new URL(config.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('MCP transport must use HTTPS or loopback');
  const token = readFileSync(config.token_file, 'utf8').trim();
  const client = new Client({ name: 'octopus-research-sync', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
