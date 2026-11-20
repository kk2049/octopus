import { appToolOutcome as outcome } from './mcp-client.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { prepareProject, type ImportPlan, type PreparedProject } from './prepare.js';
function writePrivate(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
        renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ResearchImportBackend {
    project(events: any[]): any;
    incremental(state: any, events: any[], context?: any): any;
    invoke(action: string, context: any, params: Record<string, string>): {
        events: any[];
    };
}
export function stageProject(prepared: PreparedProject, directory: string, backend: ResearchImportBackend) {
    writePrivate(resolve(directory, `${prepared.key}.actions.json`), prepared);
    let state = backend.project([]);
    let seq = 0;
    const now = new Date().toISOString();
    const events: any[] = [];
    // This is an isolated preview fixture, not a claim of a human's production action.
    state.project.title = prepared.title;
    for (let i = 0; i < prepared.actions.length; i++) {
        const action = prepared.actions[i]!;
        let result: any;
        try {
            result = backend.invoke(action.action, { state, actor: { kind: 'agent', user: 'import-preview', role: 'member' }, now }, action.params);
        }
        catch (e) {
            throw new Error(`${prepared.key} action ${i} (${action.action}): ${e instanceof Error ? e.message : 'refused'}`);
        }
        const stamped = result.events.map((event: any) => ({ ...event, seq: ++seq, at: now, by: 'agent:research-import' }));
        events.push(...stamped);
        state = backend.incremental(state, stamped);
    }
    const view = backend.incremental(state, [], { viewer: { user: 'import-preview', kind: 'user', role: 'member' } });
    writePrivate(resolve(directory, `${prepared.key}.actions.json`), prepared);
    writePrivate(resolve(directory, `${prepared.key}.events.json`), events);
    writePrivate(resolve(directory, `${prepared.key}.projection.json`), view);
    return { key: prepared.key, title: prepared.title, ...prepared.summary, actions: prepared.actions.length, events: seq, projection_bytes: Buffer.byteLength(JSON.stringify(view)), pending: prepared.archived ? 'frozen_project_requires_owner_reopen_before_import' : prepared.instance ? 'release_activation_and_import' : 'create_shared_project_then_import', digest: digest(prepared) };
}
async function applyProject(prepared: PreparedProject, directory: string, configPath: string) {
    if (prepared.archived)
        throw new Error(`${prepared.key}: target is frozen; preserve it until its owner explicitly reopens it`);
    if (!prepared.instance)
        throw new Error(`${prepared.key}: create the shared project in trusted chrome and supply its exact instance first`);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const url = new URL(config.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
        throw new Error('MCP transport must use HTTPS or loopback');
    const token = readFileSync(config.token_file, 'utf8').trim();
    const client = new Client({ name: 'octopus-research-import', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const checkpointPath = resolve(directory, `${prepared.key}.checkpoint.json`);
    const fingerprint = digest(prepared);
    let checkpoint = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')) : { digest: fingerprint, next: 0, pending: false };
    if (checkpoint.digest !== fingerprint || checkpoint.pending || !Number.isSafeInteger(checkpoint.next) || checkpoint.next < 0 || checkpoint.next > prepared.actions.length)
        throw new Error('Import checkpoint differs or has an uncertain prior call; reconcile that exact call before resuming');
    try {
        await client.connect(transport);
        const list = outcome(await client.callTool({ name: 'app_list', arguments: {} }));
        const app = list.ok ? list.result?.apps?.find((row: any) => row.app === 'research-program') : undefined;
        if (!list.ok || !app?.instances?.some((i: any) => i.instance === prepared.instance) || !app.actions?.some((a: any) => a.name === 'research_register_archive'))
            throw new Error('Target instance unavailable or the new research release is not active');
        for (let i = checkpoint.next; i < prepared.actions.length; i++) {
            const action = prepared.actions[i]!;
            checkpoint = { digest: fingerprint, next: i, pending: true };
            writePrivate(checkpointPath, checkpoint);
            const answer = outcome(await client.callTool({ name: 'app_dispatch', arguments: { app: 'research-program', instance: prepared.instance, ...action } }, undefined, { timeout: 60000 }));
            if (!answer.ok) {
                // Only explicit pre-commit refusals are safe to resume after correction.
                // unavailable/unknown, malformed outcomes and transport errors may follow a commit.
                const definite = ['no_authority', 'unknown_app', 'invalid_params', 'action_rejected', 'state_conflict', 'invalid_instance', 'instance_stale', 'not_supported', 'approval_required'].includes(answer.code);
                writePrivate(checkpointPath, { ...checkpoint, pending: !definite, refusal: String(answer.code ?? 'unknown') });
                throw new Error(`${prepared.key} action ${i} refused (${answer.code ?? 'unknown'}); no retry`);
            }
            checkpoint = { digest: fingerprint, next: i + 1, pending: false };
            writePrivate(checkpointPath, checkpoint);
        }
    }
    finally {
        await client.close().catch(() => undefined);
    }
}
export async function runResearchImport(argv: string[], backend: ResearchImportBackend) {
    const value = (name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
    const out = value('--out');
    if (!out)
        throw new Error('usage: --plan /private/plan.json --out /private/bundle [--apply --mcp-config /private/mcp.json]');
    const directory = resolve(out);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const planPath = value('--plan');
    if (!planPath)
        throw new Error('--plan is required');
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as ImportPlan;
    if (plan.version !== 1 || !Array.isArray(plan.projects) || !plan.projects.length || plan.projects.length > 64)
        throw new Error('Invalid import plan');
    const applying = argv.includes('--apply');
    const frozen = applying || argv.includes('--restage');
    const coverage = frozen ? JSON.parse(readFileSync(resolve(directory, 'coverage.json'), 'utf8')) : null;
    if (applying && argv.includes('--restage')) throw new Error('Choose either --apply or --restage');
    if (new Set(plan.projects.map(item => item.key)).size !== plan.projects.length) throw new Error('Duplicate project key');
    // Validate every frozen item before touching any remote target or overwriting staging outputs.
    const preparedProjects = plan.projects.map(item => {
        if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(item.key)) throw new Error('Invalid project key');
        const previous = coverage?.reports?.find((row: any) => row.key === item.key);
        const prepared: PreparedProject = frozen
          ? JSON.parse(readFileSync(resolve(directory, `${item.key}.actions.json`), 'utf8')) : prepareProject(item);
        if (frozen && (!previous || previous.digest !== digest(prepared) || prepared.key !== item.key
          || (prepared.instance ?? undefined) !== (item.instance ?? undefined) || Boolean(prepared.archived) !== Boolean(item.archived))) {
            throw new Error('Prepared bundle or target differs from its reviewed coverage; prepare and review a new bundle');
        }
        return { prepared, previous };
    });
    if (applying) {
        if (!value('--mcp-config')) throw new Error('--apply requires an existing authorized --mcp-config');
        for (const { prepared } of preparedProjects) {
            if (prepared.archived || !prepared.instance) throw new Error(`${prepared.key}: target requires explicit creation or owner reopen before import`);
        }
    }
    const reports = [];
    for (const { prepared, previous } of preparedProjects) {
        const report = applying ? previous : stageProject(prepared, directory, backend);
        reports.push(report);
        process.stdout.write(JSON.stringify(report) + '\n');
        if (applying) {
            const config = value('--mcp-config');
            if (!config)
                throw new Error('--apply requires an existing authorized --mcp-config');
            await applyProject(prepared, directory, config);
        }
    }
    writePrivate(resolve(directory, applying ? 'applied.json' : 'coverage.json'), { version: 1, created_at: new Date().toISOString(), production_applied: applying, reports });
}
