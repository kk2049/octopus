/**
 * A document share's bearer belongs to someone outside the account: it opens
 * one document over `/api/mcp` and nothing else, the runner bundle included.
 * Every other identity keeps the access it had.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardTestServer, runnerBundleSourceFromFile } from '../e2e/dashboard-test-support.js';
import { mcpFeishuDocSharePolicy, mcpTokenPolicy, mintMcpToken } from '../mcp/tokens.js';
import { Store } from '../store/store.js';
import { DashboardServer, mintDashboardToken } from './server.js';

let dir: string;
let store: Store;
let dash: DashboardServer;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dash-share-bundle-'));
  store = new Store(join(dir, 't.db'));
  store.saveUser({ username: 'alice', uid: 5001, home_dir: join(dir, 'alice'), created_at: '2026-10-27T00:00:00.000Z' });
  const bundle = join(dir, 'standalone.js');
  writeFileSync(bundle, '// fake runner bundle');
  dash = createDashboardTestServer(store, undefined, {
    port: 0, host: '127.0.0.1', authToken: 'sekrit', surface: 'bootstrap-v3', runnerBundle: runnerBundleSourceFromFile(bundle),
  });
  await dash.start();
  base = `http://127.0.0.1:${dash.port}`;
});

afterAll(async () => {
  await dash.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('refuses the runner bundle to a document share token and serves it to every other identity as before', async () => {
  const download = (token: string) => fetch(`${base}/download/runner.js`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.status);
  const share = mintMcpToken(store, { username: 'alice', label: '飞书文档共享 · x', policy: mcpFeishuDocSharePolicy(`shr_${'0'.repeat(24)}`) });
  const generic = mintMcpToken(store, { username: 'alice', label: 'agent', policy: mcpTokenPolicy({ groups: ['sessions'] }) });
  expect(await download(share.token)).toBe(401);
  expect(await download(generic.token)).toBe(200);
  expect(await download(mintDashboardToken(store, 'alice'))).toBe(200);
  expect(await download('sekrit')).toBe(200);
  expect(await download('mcp_bogus')).toBe(401);
});
