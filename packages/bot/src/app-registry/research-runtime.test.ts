import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { AppRuntimeService } from '@claude-bot/app-runtime';
import { bundleAppBackend } from './backend-bundle.js';
it('executes the shipped research closure and trusted history in the real capability-free sandbox', async () => {
    const app = resolve(dirname(fileURLToPath(import.meta.url)), '../../../research-program-view/app');
    const directory = mkdtempSync(resolve(tmpdir(), 'research-runtime-'));
    let runtime: AppRuntimeService | undefined;
    try {
        for (const name of ['actions.ts', 'projection.ts']) {
            const bundle = await bundleAppBackend(resolve(app, name), app);
            expect(bundle.moduleCount).toBeGreaterThan(1);
            writeFileSync(resolve(directory, name), bundle.source);
        }
        runtime = new AppRuntimeService(directory, { timeoutMs: 15000 });
        const backendCodeDigest = runtime.release.backendCodeDigest;
        const state = await runtime.project({ backendCodeDigest, events: [] });
        const out = await runtime.invoke({ backendCodeDigest, action: 'research_record',
            context: { state, actor: { kind: 'agent', agent: 'secretary', role: 'member' }, now: '2026-09-05T00:00:00Z' },
            params: { record: 'claim', kind: 'claim', title: '尚未验收的结果', body: '种子 42，样本 10。' } });
        const events = out.events.map((event, index) => ({ ...event, seq: index + 1, by: 'agent:research-program/secretary' }));
        expect(await runtime.project({ backendCodeDigest, events, context: { viewer: { kind: 'agent', agent: 'secretary', role: 'member' } } }))
            .toMatchObject({ available: true, research: { records: [{ id: 'claim', source_level: 'infer' }], controls: { can_attest: false } } });
        const read = await runtime.invoke({ backendCodeDigest, action: 'research_read_history',
            context: { state, actor: { kind: 'agent', role: 'member' }, history: { events, cursor: 1, hasMore: false, head: 1 } }, params: { after_seq: '0' } });
        expect(read.events).toEqual([]);
        expect(read.result).toMatchObject({ cursor: 1, events: [{ data: { id: 'claim' } }] });
    }
    finally {
        await runtime?.stop();
        rmSync(directory, { recursive: true, force: true });
    }
}, 90000);
