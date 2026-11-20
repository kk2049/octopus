#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import path from 'node:path';
const [sha, withCode, asOf] = process.argv.slice(2), root = process.cwd();
const out = process.env.OCTOPUS_JOB_ARTIFACT_DIR, inputs = process.env.OCTOPUS_JOB_INPUT_DIR;
if (process.env.OCTOPUS_COMPUTE_ROLE !== 'worker' || !out || !inputs || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw Error('remote graph build requires a provider job');
async function run(bin, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: root, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=3072' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes < 8 * 1024 * 1024) chunks.push(chunk); });
    child.stderr.pipe(process.stderr); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(Error(`${bin} failed: ${code}`)));
  });
}
await fs.mkdir(out, { recursive: true });
await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline']);
let code;
if (withCode === 'code') {
  code = path.join(root, 'node_modules/.cache/octopus-graph-code', sha);
  if (!await fs.stat(path.join(code, 'code-index-manifest.json')).catch(() => null)) {
    // Vitest's test inventory imports workspace exports and reads built view
    // manifests/CSS. A frozen install only links packages; prepare the same
    // checkout's outputs before collecting the repository-wide inventory.
    await run('pnpm', ['--filter', '@claude-bot/runner', '--filter', '@claude-bot/plugin-sessions',
      '--filter', '@claude-bot/dashboard-web', '--filter', '@claude-bot/session-plus-view', 'build']);
    await run('pnpm', ['exec', 'tsx', 'packages/architecture-observatory/src/code-index/cli.ts', 'build', '--root', root, '--repo-sha', sha, '--out', code]);
  }
}
const output = await run('node', ['--import', 'tsx', 'packages/bot/src/knowledge/cli.ts', 'build', '--root', root,
  '--out', path.join(out, 'graph.db'), '--context-out', path.join(out, 'context.json'), '--at', sha,
  '--runtime', path.join(inputs, 'runtime.json'), ...(code ? ['--code-index', code] : []),
  ...(asOf ? ['--evaluation-as-of', asOf] : []), '--json']);
const result = JSON.parse(output.trim().split('\n').at(-1));
const files = [];
for (const name of ['graph.db', 'context.json']) {
  const file = path.join(out, name), hash = createHash('sha256'), gzipHash = createHash('sha256');
  for await (const b of createReadStream(file)) hash.update(b);
  await pipeline(createReadStream(file), createGzip({ level: 1 }), createWriteStream(file + '.gz'));
  for await (const b of createReadStream(file + '.gz')) gzipHash.update(b);
  files.push({ name, bytes: (await fs.stat(file)).size, sha256: hash.digest('hex'),
    compressedBytes: (await fs.stat(file + '.gz')).size, compressedSha256: gzipHash.digest('hex') });
}
await fs.writeFile(path.join(out, 'graph-result.json'), JSON.stringify({ version: 1, sha, result, files }));
console.log(JSON.stringify({ phase: 'knowledge_graph_ready', sha, files }));
