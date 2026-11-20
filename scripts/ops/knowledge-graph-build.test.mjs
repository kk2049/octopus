import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const helper = fileURLToPath(new URL('./knowledge-graph-build.mjs', import.meta.url));

function build(mode, failBuild = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-prerequisites-')); roots.push(root);
  const bin = path.join(root, 'bin'), out = path.join(root, 'out'), trace = path.join(root, 'calls.jsonl');
  fs.mkdirSync(bin);
  // Execute the real helper. The index collector refuses a cold workspace
  // until its package export build has succeeded, matching the production fault.
  fs.writeFileSync(path.join(bin, 'pnpm'), `#!${process.execPath}\n` + `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_GRAPH_TRACE, JSON.stringify(args) + '\\n');
    if (args.at(-1) === 'build') {
      if (process.env.TEST_GRAPH_FAIL === '1') process.exit(7);
      fs.writeFileSync('workspace-ready', 'yes');
    }
    if (args.includes('packages/architecture-observatory/src/code-index/cli.ts')) {
      if (!fs.existsSync('workspace-ready')) { console.error('workspace exports missing'); process.exit(8); }
    }
  `, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'node'), `#!${process.execPath}\n` + `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_GRAPH_TRACE, JSON.stringify(args) + '\\n');
    fs.writeFileSync(path.join(process.env.OCTOPUS_JOB_ARTIFACT_DIR, 'graph.db'), 'fixture graph');
    fs.writeFileSync(path.join(process.env.OCTOPUS_JOB_ARTIFACT_DIR, 'context.json'), '{}');
    console.log(JSON.stringify({sha: '${'a'.repeat(40)}'}));
  `, { mode: 0o700 });
  const result = spawnSync(process.execPath, [helper, 'a'.repeat(40), mode], { cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OCTOPUS_COMPUTE_ROLE: 'worker',
      OCTOPUS_JOB_INPUT_DIR: root, OCTOPUS_JOB_ARTIFACT_DIR: out, TEST_GRAPH_TRACE: trace, TEST_GRAPH_FAIL: failBuild ? '1' : '0' } });
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { result, calls, published: fs.existsSync(path.join(out, 'graph-result.json')) };
}

it('prepares workspace exports before collecting a cold code-aware graph', () => {
  const { result, calls, published } = build('code');
  expect(result.status, result.stderr).toBe(0);
  expect(calls[0]).toEqual(['install', '--frozen-lockfile', '--prefer-offline']);
  expect(calls[1]).toEqual(['--filter', '@claude-bot/runner', '--filter', '@claude-bot/plugin-sessions',
    '--filter', '@claude-bot/dashboard-web', '--filter', '@claude-bot/session-plus-view', 'build']);
  expect(calls[2]).toContain('packages/architecture-observatory/src/code-index/cli.ts');
  expect(published).toBe(true);
});

it('does not collect or publish evidence after workspace preparation fails', () => {
  const { result, calls, published } = build('code', true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('pnpm failed: 7');
  expect(calls).toHaveLength(2);
  expect(published).toBe(false);
});

it('keeps graph-only rebuilds free of code-index prerequisite builds', () => {
  const { result, calls, published } = build('graph');
  expect(result.status, result.stderr).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain('packages/bot/src/knowledge/cli.ts');
  expect(calls[1]).not.toContain('--code-index');
  expect(published).toBe(true);
});
