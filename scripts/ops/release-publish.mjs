#!/usr/bin/env node
/** Create-once, content-addressed GitLab releases. Works without Octopus. */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const dir = process.env.OCTOPUS_JOB_ARTIFACT_DIR;
const sha = process.env.CI_COMMIT_SHA;
const api = new URL(process.env.CI_API_V4_URL);
const project = process.env.CI_PROJECT_ID;
const token = process.env.CI_JOB_TOKEN;
if (!dir || !/^[0-9a-f]{40}$/.test(sha ?? '') || !/^\d+$/.test(project ?? '') || !token
  || api.protocol !== 'https:' || api.username || api.password || !api.pathname.endsWith('/api/v4') || api.search || api.hash) throw Error('release publication requires an exact CI job/project and HTTPS GitLab API');
const root = `${api.href}/projects/${project}`;
const tag = `octopus-v4-${sha}`;
const manifestBytes = await fs.readFile(path.join(dir, 'release.json'));
if (manifestBytes.length > 65536) throw Error('release manifest exceeds limit');
const manifest = JSON.parse(manifestBytes.toString());
if (manifest.repoSha !== sha || manifest.version !== 1 || manifest.parts?.length !== 2
  || Buffer.from(JSON.stringify(manifest)).compare(manifestBytes) !== 0) throw Error('release manifest identity/encoding mismatch');
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestHash = hashBytes(manifestBytes);
const objectUrl = (hash, file) => `${root}/packages/generic/octopus-release/${sha}/${hash}-${file}`;
async function request(url, init = {}) {
  if (!url.startsWith(`${root}/`)) throw Error('release request leaves project');
  return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30 * 60 * 1000),
    headers: { 'JOB-TOKEN': token, 'User-Agent': 'octopus-development/1.0', ...init.headers } });
}
async function json(response) {
  const bytes = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 1024 * 1024) throw Error('release response exceeds limit'); bytes.push(chunk);
  }
  return JSON.parse(Buffer.concat(bytes).toString());
}
function matches(release) {
  return release.tag_name === tag && release.commit?.id === sha && release.assets?.links?.some(link =>
    link.name === `release.json@${manifestHash}` && link.url === objectUrl(manifestHash, 'release.json'));
}
const existing = await request(`${root}/releases/${tag}`);
if (existing.status === 200) {
  if (!matches(await json(existing))) throw Error('release already exists with a different manifest; it cannot be replaced');
  console.log(JSON.stringify({ state: 'already_published', sha, manifestSha256: manifestHash }));
  process.exit(0);
}
await existing.body?.cancel();
if (existing.status !== 404) throw Error(`release lookup failed (HTTP ${existing.status})`);
const files = [...manifest.parts, { file: 'release.json', bytes: manifestBytes.length, sha256: manifestHash }];
for (const part of files) {
  if (!['dependencies.tar.gz', 'outputs.tar.gz', 'release.json'].includes(part.file)
    || !/^[0-9a-f]{64}$/.test(part.sha256) || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > 2 * 1024 ** 3) throw Error('invalid release part');
  const file = path.join(dir, part.file), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== part.bytes) throw Error('release part size mismatch');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file, { highWaterMark: 256 * 1024 })) { hash.update(bytes); await delay(bytes.length * 1000 / (16 * 1024 ** 2)); }
  if (hash.digest('hex') !== part.sha256) throw Error('release part digest mismatch');
  const url = objectUrl(part.sha256, part.file);
  const prior = await request(url, { method: 'HEAD' });
  if (prior.status === 200) {
    if (Number(prior.headers.get('content-length')) !== part.bytes) throw Error('existing immutable package has a different size');
    continue;
  }
  if (prior.status !== 404) throw Error(`package lookup failed (HTTP ${prior.status})`);
  // Bound upload I/O; names are content-addressed, so a retry never overwrites
  // another build. GitLab duplicate generic packages must be disabled too.
  const body = Readable.from((async function* () {
    for await (const bytes of createReadStream(file, { highWaterMark: 256 * 1024 })) { yield bytes; await delay(bytes.length * 1000 / (4 * 1024 ** 2)); }
  })());
  const response = await request(url, { method: 'PUT', body, duplex: 'half', headers: { 'Content-Length': String(part.bytes), 'Content-Type': 'application/octet-stream' } });
  await response.body?.cancel();
  if (response.status !== 201) throw Error(`package publication failed (HTTP ${response.status}); inspect the immutable object before retrying`);
}
// The release record is the commit marker, written only after all objects exist.
let status = 'unknown';
try {
  const response = await request(`${root}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    name: `Octopus ${sha.slice(0, 12)}`, tag_name: tag, ref: sha,
    description: `Immutable Octopus release. Source ${sha}; manifest SHA256 ${manifestHash}.`,
    assets: { links: [{ name: `release.json@${manifestHash}`, url: objectUrl(manifestHash, 'release.json'), link_type: 'package' }] },
  }) });
  status = String(response.status); await response.body?.cancel();
} catch { /* Reconcile this exact tag after an ambiguous response; never replay POST. */ }
const result = await request(`${root}/releases/${tag}`);
if (result.status !== 200 || !matches(await json(result))) throw Error(`release publication not confirmed (POST ${status}); inspect ${tag}, do not replace it`);
console.log(JSON.stringify({ state: 'published', sha, manifestSha256: manifestHash }));
