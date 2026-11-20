import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunks, conversation, prepareProject, redact } from './prepare.js';
describe('research import provenance and complete visible conversations', () => {
    it('deduplicates Codex mirrors per occurrence, retaining messages from partially mirrored histories', () => {
        const raw = [
            { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] } },
            { type: 'event_msg', payload: { type: 'user_message', message: 'question' } },
            { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'unique old answer' }] } },
            { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private reasoning' }] } },
            { type: 'event_msg', payload: { type: 'agent_message', message: 'new answer' } },
        ].map(e => JSON.stringify(e)).join('\n');
        expect(conversation('codex', raw).messages.map(m => m.text)).toEqual(['question', 'unique old answer', 'new answer']);
        expect(conversation('codex', JSON.stringify({ type: 'session_meta', payload: { thread_source: 'subagent' } })).excluded).toContain('subagent');
    });
    it('preserves long text and Unicode while removing credentials', () => {
        const value = `${'😀研究'.repeat(4000)}\nEND`;
        expect(chunks(value).join('')).toBe(value);
        expect(chunks(value).every(p => p.length <= 9000 && !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
        const secret = 'sk-' + 'a'.repeat(40);
        expect(redact(`keep text ${secret}`)).toEqual({ text: 'keep text [REDACTED credential]', count: 1 });
    });
    it('produces stable staged actions, source hashes and explicit missing-source coverage without fabricated approval', () => {
        const dir = mkdtempSync(join(tmpdir(), 'research-import-'));
        try {
            writeFileSync(join(dir, 'USER-DECISIONS.md'), '# Historical claim\nThe document says the user approved.');
            const config = { key: 'example', title: 'Example', documents: [{ path: join(dir, 'USER-DECISIONS.md'), display: 'USER-DECISIONS.md' }, { path: join(dir, 'missing'), display: 'missing.md' }], sessions: [] };
            const first = prepareProject(config);
            expect(prepareProject(config)).toEqual(first);
            expect(first.summary.missing).toBe(1);
            const record = first.actions.find(a => a.action === 'research_record')!;
            expect(record.params).toMatchObject({ origin: 'imported', kind: 'request' });
            expect(first.actions.some(a => ['research_attest', 'research_merge', 'set_lead_agent'].includes(a.action))).toBe(false);
            expect(first.sources[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
