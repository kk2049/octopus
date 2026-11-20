#!/usr/bin/env node
/** Runs only on an execution provider. Outputs contain no Git state, data or credentials. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const sha = process.argv[2];
const out = process.env.OCTOPUS_JOB_ARTIFACT_DIR;
if (!/^[0-9a-f]{40}$/.test(sha ?? '') || !out || process.env.OCTOPUS_COMPUTE_ROLE !== 'worker') {
  throw Error('release-build requires an exact SHA and an execution-provider artifact directory');
}
async function run(bin, args, capture = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: root, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=3072' },
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    const chunks = []; if (capture) child.stdout.on('data', b => chunks.push(b));
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(Error(`${bin} exited ${code}`)));
  });
}
async function digest(file) { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); }
if ((await run('git', ['rev-parse', 'HEAD'], true)).trim() !== sha) throw Error('release source SHA mismatch');
await run('git', ['diff', '--quiet', 'HEAD', '--']);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
console.log(JSON.stringify({ phase: 'install', sha, node: process.version, platform: process.platform, arch: process.arch }));
await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline']);
console.log(JSON.stringify({ phase: 'build', sha }));
await run('pnpm', ['-r', '--workspace-concurrency=2', 'build']);

// Ship every repository-owned App package with the exact trusted-code release.
// Activation remains an explicit, independently gated after-deploy operation.
const apps = [];
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}'));
for (const script of Object.keys(packageJson.scripts ?? {}).filter(s => /^app:pack(?::[a-z0-9-]+)?$/.test(s)).sort()) {
  const file = `packages/bot/dist/release-apps/${script.replaceAll(':', '-')}.json`;
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await run('pnpm', ['run', script, '--', '--out', path.join(root, file)]);
  const info = await fs.stat(path.join(root, file));
  if (info.size < 1 || info.size > 24 * 1024 ** 2) throw Error('App release exceeds limit');
  apps.push({ script, file, bytes: info.size, sha256: await digest(path.join(root, file)) });
}

// All runtime workspace links are relative, and the complete private .pnpm store travels with them.
const dependencies = ['node_modules'];
const outputs = [];
for (const parent of ['packages', 'plugins', 'tools']) {
  for (const entry of await fs.readdir(path.join(root, parent), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const prefix = `${parent}/${entry.name}`;
    for (const name of ['node_modules', 'dist']) {
      if (await fs.stat(path.join(root, prefix, name)).then(s => s.isDirectory()).catch(() => false)) {
        (name === 'dist' ? outputs : dependencies).push(`${prefix}/${name}`);
      }
    }
  }
}
for (const required of ['packages/dashboard-web/dist', 'packages/runner/dist', 'plugins/sessions/dist']) {
  if (!outputs.includes(required)) throw Error(`missing release output ${required}`);
}
const dashboardDist = path.join(root, 'packages/dashboard-web/dist');
const dashboardManifest = JSON.parse(await fs.readFile(path.join(dashboardDist, '.vite/manifest.json'), 'utf8'));
if (!Object.values(dashboardManifest).some(entry => entry.isEntry)) throw Error('dashboard manifest has no entry');
for (const entry of Object.values(dashboardManifest)) {
  for (const name of [entry.file, ...(entry.css ?? [])]) {
    if (typeof name !== 'string' || path.isAbsolute(name) || name.split('/').includes('..')
      || !(await fs.stat(path.join(dashboardDist, name))).isFile()) throw Error('dashboard manifest references missing or unsafe asset');
  }
}
const parts = [];
let dependencyIndex;
for (const [name, entries] of [['dependencies', dependencies], ['outputs', outputs]]) {
  if (name === 'outputs') {
    // Build the index here on the execution provider, from immutable tar bytes,
    // before publishing. It travels in the existing outputs part: old installers
    // remain compatible and the dependency archive remains reusable by digest.
    const file = 'packages/bot/dist/release-dependency-index.jsonl';
    const indexer = fileURLToPath(new URL('./release-index.py', import.meta.url));
    const metadata = JSON.parse(await run('python3', [indexer, path.join(out, 'dependencies.tar.gz'), path.join(root, file)], true));
    dependencyIndex = { ...metadata, file, archiveSha256: parts[0].sha256 };
    if (!entries.includes('packages/bot/dist')) entries.push('packages/bot/dist');
    console.log(JSON.stringify({ phase: 'dependency_index', ...dependencyIndex }));
  }
  const file = path.join(out, `${name}.tar.gz`);
  const list = path.join(out, `${name}.list`);
  await fs.writeFile(list, entries.sort().join('\0') + '\0');
  await run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--hard-dereference',
    ...(name === 'dependencies' ? ['--exclude=.modules.yaml', '--exclude=.pnpm-workspace-state-v1.json', '--exclude=.cache', '--exclude=.vite', '--exclude=.vite-temp'] : []),
    '-czf', `${file}.partial`, '--null', '-T', list]);
  await fs.rename(`${file}.partial`, file); await fs.rm(list);
  const stat = await fs.stat(file);
  if (stat.size > 2 * 1024 * 1024 * 1024) throw Error('release archive exceeds 2 GiB');
  parts.push({ name, file: `${name}.tar.gz`, bytes: stat.size, sha256: await digest(file) });
}
// Smoke the native runtime dependency on the provider as well as checking package presence.
await run('node', ['--input-type=module', '-e', "import {createRequire} from 'node:module';const require=createRequire(process.cwd()+'/packages/bot/package.json');const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close()"]);
const manifest = { version: 1, repoSha: sha, node: process.version, platform: process.platform, arch: process.arch,
  nodeAbi: process.versions.modules, lockSha256: await digest(path.join(root, 'pnpm-lock.yaml')), parts, outputs, apps,
  dependencyIndex, builtAt: new Date().toISOString(), builder: 'workspace-release/v1' };
const temp = path.join(out, 'release.json.partial');
const handle = await fs.open(temp, 'w', 0o600);
try { await handle.writeFile(JSON.stringify(manifest)); await handle.sync(); } finally { await handle.close(); }
await fs.rename(temp, path.join(out, 'release.json'));
console.log(JSON.stringify({ phase: 'ready', sha, parts }));
