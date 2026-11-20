import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSessionPlusManifest } from './manifest.js';
const source = `id: history-test
schema: 4
state: {scope: account}
actions:
  read_history:
    binding: runtime
    handler: read_history
    history_cursor: after_seq
    params:
      after_seq: {type: string, max: 12, required: true}
view: {page: main.yaml}
`;
function load(text: string) {
    const dir = mkdtempSync(resolve(tmpdir(), 'manifest-history-'));
    try {
        writeFileSync(resolve(dir, 'app.yaml'), text);
        return loadSessionPlusManifest(dir, { appId: 'history-test' });
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
describe('release-declared history access', () => {
    it('requires schema-4 explicit opt-in and a bounded required cursor', () => {
        expect(load(source).actions.read_history?.historyCursor).toBe('after_seq');
        expect(() => load(source.replace('schema: 4', 'schema: 3'))).toThrow('unknown key');
        expect(() => load(source.replace('history_cursor: after_seq', 'history_cursor: invented'))).toThrow('history_cursor');
        expect(() => load(source.replace('max: 12', 'max: 100'))).toThrow('history_cursor');
        expect(() => load(source.replace('required: true', 'required: false'))).toThrow('history_cursor');
    });
    it('parses the real research release with separate human receipts and MCP/secretary seats', () => {
        const app = loadSessionPlusManifest(resolve('packages/research-program-view/app'), { appId: 'research-program' });
        expect(app.actions.research_read_history?.historyCursor).toBe('after_seq');
        expect(app.actions.research_attest?.humanOnly).toBe(true);
        expect(app.agents.secretary?.role).toBe('member');
        expect(app.agents.mcp?.role).toBe('member');
        expect(app.actions.ask_secretary?.binding).toBe('agent');
    });
});
