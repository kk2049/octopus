import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { BrowserSessions } from './core.mjs';
import { tools } from './tools.mjs';

process.umask(0o077);
const state = process.env.OCTOPUS_BROWSER_STATE ?? '/state';
const socket = path.join(state, 'browser.sock');
await fs.mkdir(state, { recursive: true, mode: 0o700 });
// The container's supervised service is the sole socket owner. Never use TCP.
await fs.rm(socket, { force: true });
const browser = await chromium.launch({ headless: false, chromiumSandbox: process.env.OCTOPUS_BROWSER_SANDBOX === '1' });
const sessions = new BrowserSessions(browser, { state, origin: process.env.OCTOPUS_BROWSER_ORIGIN ?? 'https://203.0.113.21:444',
  credentialFile: process.env.OCTOPUS_BROWSER_CREDENTIAL_FILE });
const checkpoint = setInterval(() => sessions.checkpointIdle().catch(() => {}), 30_000); checkpoint.unref();
const server = http.createServer(async (req, res) => {
  const reply = (status, body) => { const data = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }); res.end(data); };
  if (req.method === 'GET' && req.url === '/tools') { reply(200, { tools }); return; }
  if (req.method !== 'POST' || req.url !== '/call') { reply(404, { error: 'Unknown route' }); return; }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) { reply(413, { error: 'Request exceeds limit' }); req.destroy(); return; } chunks.push(chunk); }
    const { name, arguments: args } = JSON.parse(Buffer.concat(chunks).toString());
    if (!tools.some((t) => t.name === name) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool request');
    const result = await sessions.invoke(name, args);
    reply(200, { result });
  } catch (error) { reply(400, { error: sessions.redact(error.message).slice(0, 1500), input_outcome: 'Do not replay automatically; inspect the page before deciding on further input.' }); }
});
server.requestTimeout = 20_000;
server.listen(socket, async () => { await fs.chmod(socket, 0o600); process.stderr.write('Octopus isolated browser ready on private Unix socket\n'); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { clearInterval(checkpoint); server.close(); await sessions.shutdown(); await browser.close(); await fs.rm(socket, { force: true }); process.exit(0); });
