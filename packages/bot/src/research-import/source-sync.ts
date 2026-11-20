/** Explicit local source plan -> frozen, reviewable MCP source snapshots. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parseSessionRich, type Source } from '@claude-bot/plugin-sessions/parse';
import { redact, chunks, type ImportProject } from './prepare.js';
import { openResearchMcp, appToolOutcome } from './mcp-client.js';
export const sourceHash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export interface PreparedSource {
  encoding?: 'text' | 'png-base64';
  key: string; kind: 'session' | 'document'; title: string; ref: string; provider: string;
  generation: string; source_digest: string; total: number; source_path: string; reason: string; redactions: number;
  chunks: Array<{ offset: number; count: number; payload: string; fragment_offset?: number; fragment_total?: number }>;
}
export interface SourceProject extends ImportProject { documents: Array<ImportProject['documents'][number] & { key?: string }>; sessions: Array<ImportProject['sessions'][number] & { key?: string }> }
export interface SourceBundle { version: 1; key: string; title: string; instance: string; sources: PreparedSource[] }
function privateJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temporary, 0o600); renameSync(temporary, path);
}
function read(path: string, binary = false) {
  const stat = statSync(path); if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error(`Source is not a bounded file: ${path}`);
  const bytes = readFileSync(path); return { bytes, text: binary ? '' : new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}
function clean(value: unknown, count: { value: number }): unknown {
  if (typeof value === 'string') { const result = redact(value); count.value += result.count; return result.text; }
  if (Array.isArray(value)) return value.map(item => clean(item, count));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item, count)]));
  return value;
}
/**
 * The receiving App's own bound: research-program's `research_bind_source` accepts
 * a source of at most this many characters (base64 characters for a PNG figure),
 * published in 24,000-character chunks. The old 1 MiB check here named a text
 * viewer limit that no longer exists (viewers read in windows).
 */
export const RESEARCH_SOURCE_MAX_CHARACTERS = 2_000_000;
export function prepareSourceProject(project: SourceProject): SourceBundle {
  if (!project.instance || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(project.key)) throw new Error('The reviewed plan needs an exact existing instance and project key');
  const sources: PreparedSource[] = [];
  for (const doc of project.documents) {
    const png = /\.png$/i.test(doc.display);
    const raw = read(doc.path, png);
    if (png && !raw.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`PNG figure must have its native signature: ${doc.display}`);
    const cleaned = png ? { text: raw.bytes.toString('base64'), count: 0 } : redact(raw.text);
    const key = doc.key ?? `doc-${sourceHash(doc.display).slice(0, 32)}`;
    if (cleaned.text.length > RESEARCH_SOURCE_MAX_CHARACTERS) throw new Error(`${png ? 'PNG figure (base64)' : 'Document'} has ${cleaned.text.length} characters; research-program accepts at most ${RESEARCH_SOURCE_MAX_CHARACTERS} per source, so it was not prepared: ${doc.display}`);
    let offset = 0;
    sources.push({ key, kind: 'document', ...(png ? { encoding: 'png-base64' as const } : {}), title: raw.text.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 200) || basename(doc.display), ref: doc.display, provider: '', generation: sourceHash(cleaned.text), source_digest: sourceHash(raw.bytes), total: cleaned.text.length, source_path: doc.path, reason: doc.summary || '用户要求绑定的现有项目文档', redactions: cleaned.count,
      chunks: chunks(cleaned.text, 24000).map(payload => { const chunk = { offset, count: payload.length, payload }; offset += payload.length; return chunk; }) });
  }
  for (const session of project.sessions) {
    const raw = read(session.path), count = { value: 0 };
    const parsed = parseSessionRich(session.provider as Source, raw.text);
    const messages = clean(parsed.messages, count) as typeof parsed.messages;
    const slices: PreparedSource['chunks'] = [];
    let batch: typeof messages = [], offset = 0;
    const flush = () => { if (batch.length) { slices.push({ offset, count: batch.length, payload: JSON.stringify(batch) }); offset += batch.length; batch = []; } };
    for (const message of messages) {
      const serialized = JSON.stringify([message]);
      if (serialized.length > 4_194_304) throw new Error(`Native message exceeds the 4 Mi-character serialized message limit; source was not truncated: ${session.id}`);
      if (serialized.length > 32000) {
        flush(); let fragmentOffset = 0;
        for (const payload of chunks(serialized, 24000)) {
          slices.push({ offset, count: 1, payload, fragment_offset: fragmentOffset, fragment_total: serialized.length });
          fragmentOffset += payload.length;
        }
        offset++; continue;
      }
      if (batch.length >= 64 || JSON.stringify([...batch, message]).length > 32000) flush();
      batch.push(message);
    }
    flush();
    sources.push({ key: session.key ?? session.id, kind: 'session', title: session.title.replace(/\s+/g, ' ').slice(0, 200), ref: `${session.provider}:${session.id}`, provider: session.provider, generation: sourceHash(JSON.stringify(messages)), source_digest: sourceHash(raw.bytes), total: messages.length, source_path: session.path, reason: session.association.slice(0, 500), redactions: count.value, chunks: slices });
  }
  if (new Set(sources.map(row => row.key)).size !== sources.length) throw new Error('Duplicate source key in reviewed project plan');
  return { version: 1, key: project.key, title: project.title, instance: project.instance, sources };
}

export async function runSourceSync(argv: string[]) {
  const option = (name: string) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
  const out = option('--out'); if (!out) throw new Error('--out /private/bundle is required');
  mkdirSync(out, { recursive: true, mode: 0o700 }); chmodSync(out, 0o700);
  const receiptPath = resolve(out, 'sources.json');
  const mode = argv.includes('--verify') ? 'verify' : argv.includes('--apply') ? 'apply' : 'prepare';
  let bundles: SourceBundle[];
  if (mode === 'prepare') {
    const plan = JSON.parse(readFileSync(option('--plan') ?? '', 'utf8'));
    if (plan.version !== 1 || !Array.isArray(plan.projects)) throw new Error('Invalid source plan');
    if (new Set(plan.projects.map((p: SourceProject) => p.key)).size !== plan.projects.length || new Set(plan.projects.map((p: SourceProject) => p.instance)).size !== plan.projects.length) throw new Error('Duplicate project key or instance');
    bundles = plan.projects.map(prepareSourceProject);
    privateJson(receiptPath, { version: 1, bundles, digest: sourceHash(JSON.stringify(bundles)) });
    privateJson(resolve(out, 'coverage.json'), bundles.map(bundle => ({ key: bundle.key, title: bundle.title, instance: bundle.instance, sources: bundle.sources.map(({ chunks: content, ...source }) => ({ ...source, chunks: content.length })) })));
    console.log(JSON.stringify(bundles.map(bundle => ({ project: bundle.key, documents: bundle.sources.filter(row => row.kind === 'document').length, sessions: bundle.sources.filter(row => row.kind === 'session').length, chunks: bundle.sources.reduce((n, row) => n + row.chunks.length, 0) }))));
    return;
  }
  const frozen = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (frozen.version !== 1 || sourceHash(JSON.stringify(frozen.bundles)) !== frozen.digest) throw new Error('Frozen source bundle differs from its receipt');
  bundles = frozen.bundles;
  const config = option('--mcp-config'); if (!config) throw new Error('--mcp-config /private/mcp.json is required');
  const client = await openResearchMcp(config);
  const evidence: unknown[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = appToolOutcome(await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 }));
    if (!answer.ok) throw new Error(`${answer.code}: ${answer.message}`);
    return answer.result;
  };
  try {
    const catalog = await call('app_list', {});
    const app = catalog.apps?.find((row: any) => row.app === 'research-program');
    if (!app?.actions?.some((row: any) => row.name === 'research_bind_source')) throw new Error('The source-binding release is not active');
    if (bundles.some(bundle => bundle.sources.some(source => source.encoding === 'png-base64')) && !app.actions.find((row: any) => row.name === 'research_bind_source')?.parameters?.properties?.encoding) throw new Error('The report-figure source release is not active');
    if (bundles.some(bundle => bundle.sources.some(source => source.chunks.some(chunk => chunk.fragment_total))) && !app.actions.find((row: any) => row.name === 'research_publish_source')?.parameters?.properties?.fragment_total) throw new Error('The complete-transcript fragment release is not active');
    for (const bundle of bundles) {
      if (!app.instances?.some((row: any) => row.instance === bundle.instance)) throw new Error(`Project is unavailable: ${bundle.key}`);
    }
    // Restore the complete directory before a large history transfer starts.
    if (mode === 'apply') for (const bundle of bundles) await call('app_dispatch', { app: 'research-program', instance: bundle.instance, action: 'configure_project', params: { title: bundle.title } });
    for (const bundle of bundles) {
      const dispatch = (action: string, params: Record<string, string>) => call('app_dispatch', { app: 'research-program', instance: bundle.instance, action, params });
      for (const item of bundle.sources) {
        const status = (await dispatch('research_source_status', { source_key: item.key })).result?.source;
        if (mode === 'apply') {
          await dispatch('research_bind_source', { source_key: item.key, kind: item.kind, generation: item.generation, expected_generation: status?.generation ?? '', total: String(item.total), title: item.title, source_ref: item.ref, provider: item.provider, reason: item.reason, ...(item.encoding ? { encoding: item.encoding } : {}) });
          const start = status?.generation === item.generation ? status.next : 0;
          for (const chunk of item.chunks) {
            if (chunk.offset + chunk.count <= start) continue;
            if (chunk.offset < start) throw new Error('Source offset cuts across a frozen chunk; reconcile the exact version');
            const partialNext = status?.generation === item.generation && chunk.offset === start ? status.partial?.next ?? 0 : 0;
            if (chunk.fragment_total && chunk.fragment_offset! + chunk.payload.length <= partialNext) continue;
            if (chunk.fragment_total && chunk.fragment_offset! < partialNext) throw new Error('Source fragment offset cuts across a frozen chunk');
            // A durable pending record survives a transport failure. A later invocation
            // re-reads this exact generation's authoritative next offset before writing.
            privateJson(resolve(out, 'pending.json'), { instance: bundle.instance, key: item.key, generation: item.generation, offset: chunk.offset, count: chunk.count, fragment_offset: chunk.fragment_offset });
            const answer = await dispatch('research_publish_source', { source_key: item.key, generation: item.generation, offset: String(chunk.offset), payload: chunk.payload, ...(chunk.fragment_total ? { fragment_offset: String(chunk.fragment_offset), fragment_total: String(chunk.fragment_total) } : {}) });
            const count = chunk.fragment_total && chunk.fragment_offset! + chunk.payload.length < chunk.fragment_total ? 0 : chunk.count;
            if (answer.result?.next !== chunk.offset + count || chunk.fragment_total && answer.result?.fragment_next !== chunk.fragment_offset! + chunk.payload.length) throw new Error('Unexpected source publication receipt');
            privateJson(resolve(out, 'pending.json'), null);
          }
        }
        const after = (await dispatch('research_source_status', { source_key: item.key })).result?.source;
        if (!after || after.generation !== item.generation || after.next !== item.total) throw new Error(`Source is incomplete: ${item.key}`);
        const readBack = new Map<string, string>(), readSequences = new Set<number>();
        for (const [seq] of after.ranges) {
          if (readSequences.has(seq)) continue;
          const page = await dispatch('research_read_source', { source_key: item.key, generation: item.generation, after_seq: String(seq - 1) });
          for (const chunk of page.result?.chunks ?? []) { readBack.set(`${chunk.offset}:${chunk.fragment_offset ?? ''}`, chunk.payload); if (chunk.seq !== undefined) readSequences.add(chunk.seq); }
        }
        for (const chunk of item.chunks) if (readBack.get(`${chunk.offset}:${chunk.fragment_offset ?? ''}`) !== chunk.payload) throw new Error(`Read-back content differs: ${item.key} at ${chunk.offset}`);
        if (mode === 'apply') privateJson(resolve(out, 'pending.json'), null);
        evidence.push({ project: bundle.key, instance: bundle.instance, key: item.key, kind: item.kind, generation: item.generation, total: item.total, verified_chunks: item.chunks.length });
        privateJson(resolve(out, 'verified.json'), evidence);
        console.log(bundle.key, item.kind, item.key, item.total, 'verified');
      }
    }
  } finally { await client.close(); }
}
