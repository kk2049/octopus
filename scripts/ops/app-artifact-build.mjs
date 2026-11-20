#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const [sha, script] = process.argv.slice(2), out = process.env.OCTOPUS_JOB_ARTIFACT_DIR;
if (process.env.OCTOPUS_COMPUTE_ROLE !== 'worker' || !out || !/^[0-9a-f]{40}$/.test(sha ?? '') || !/^app:pack(?::[a-z0-9-]+)?$/.test(script ?? '')) throw Error('invalid remote App pack request');
async function run(args) {
  await new Promise((resolve, reject) => {
    const p = spawn('pnpm', args, { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=3072' } });
    p.on('error', reject); p.on('close', code => code === 0 ? resolve() : reject(Error(`pnpm ${args[0]} failed: ${code}`)));
  });
}
await fs.mkdir(out, { recursive: true });
await run(['install', '--frozen-lockfile', '--prefer-offline']);
await run(['-r', '--workspace-concurrency=2', 'build']);
await run(['run', script, '--', '--out', path.join(out, 'app.json')]);
const bytes = await fs.readFile(path.join(out, 'app.json'));
if (bytes.length > 24 * 1024 * 1024) throw Error('App release exceeds limit');
await fs.writeFile(path.join(out, 'app-manifest.json'), JSON.stringify({ version: 1, sha, bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') }));
