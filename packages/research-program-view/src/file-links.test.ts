import { describe, expect, it } from 'vitest';
import { createResearchFileLinks } from './file-links.js';
import type { ResearchProjection } from './model.js';
const root = '/home/ubuntu/lht/auto-research/agentcc';
const report = 'reports/R08-CLI-PIN-RECOVERY-2026-09-08.md';
function fixture(): ResearchProjection { return {
  project: { title: 'ProjectX 研究计划' },
  source_locations: { revision: 1, roots: [root, '/old/agentcc'], sessions: { lead: { cwd: root } } },
  documents: [{ key: 'recovery', path: report }, { key: 'index', path: 'reports/README.md' }],
}; }
describe('published project file links', () => {
  it('opens the exact reported absolute chat link and survives project rename', async () => {
    const projection = fixture(), links = createResearchFileLinks(() => projection);
    expect(await links.resolve({ href: root + '/' + report, sessionRef: 'lead' })).toMatchObject({ ok: true, ref: 'recovery', location: { rootRef: 'research-documents', labels: report.split('/') } });
    projection.project!.title = '用户改过的新名字';
    expect(await links.resolve({ href: '/old/agentcc/' + report })).toMatchObject({ ok: true, ref: 'recovery' });
  });
  it('uses session cwd and document location for relative links', async () => {
    const projection = fixture(), links = createResearchFileLinks(() => projection);
    expect(await links.resolve({ href: report, sessionRef: 'lead' })).toMatchObject({ ok: true, ref: 'recovery' });
    expect(await links.resolve({ href: report.split('/').at(-1)! + '#记录', fileRef: 'index' })).toMatchObject({ ok: true, ref: 'recovery' });
    projection.source_locations!.sessions.lead!.cwd += '/reports';
    expect(await links.resolve({ href: './' + report.split('/').at(-1), sessionRef: 'lead' })).toMatchObject({ ok: true, ref: 'recovery' });
  });
  it.each(['/other/' + report, root + '-sibling/' + report, root + '/../agentcc/' + report, root + '/%2e%2e/agentcc/' + report, '../' + report, 'https://evil.invalid/' + report, root + '/missing.md'])('refuses unbound or escaping paths: %s', async href => {
    expect(await createResearchFileLinks(fixture).resolve({ href })).toMatchObject({ ok: false });
  });
  it('refuses ambiguity and immediately forgets hidden documents', async () => {
    const projection = fixture(), links = createResearchFileLinks(() => projection);
    projection.documents!.push({ key: 'duplicate', path: report });
    expect(await links.resolve({ href: root + '/' + report })).toMatchObject({ ok: false, message: expect.stringContaining('多个') });
    projection.documents![0]!.hidden = true;
    projection.documents![2]!.hidden = true;
    expect(await links.resolve({ href: root + '/' + report })).toMatchObject({ ok: false });
  });
  it('keeps real cwd distinct from the explicitly selected project document base', async () => {
    const projection = fixture();
    projection.source_locations!.sessions.lead = { cwd: '/original/shared/checkout', document_base: '' };
    const links = createResearchFileLinks(() => projection);
    expect(await links.resolve({ href: report, sessionRef: 'lead' })).toMatchObject({ ok: true, ref: 'recovery' });
    expect(projection.source_locations!.sessions.lead.cwd).toBe('/original/shared/checkout');
    projection.source_locations!.aliases = { '/old/worktree': 'reports' };
    expect(await links.resolve({ href: '/old/worktree/' + report.split('/').at(-1) })).toMatchObject({ ok: true, ref: 'recovery' });
  });
});
