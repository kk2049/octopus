#!/usr/bin/env node
/** Capture the real, authorized research-v2 page on an explicitly chosen browser device. */
import { chromium } from 'playwright';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const help = `Usage: node scripts/research-v2/capture-page.mjs
  --base https://your-octopus-site --instance asi_...
  --state /private/browser-state.json --out /private/research.png
  --browser /path/to/chrome-headless-shell
  [--scope node_id] [--layout tree|hierarchy|canvas] [--node node_id]
  [--width 1600] [--height 1040]

Run on an authorized browser-capable device (4090 in this deployment).
The state file is a Playwright storageState for the caller's own authorized
browser session. No login keys appear in URLs, command arguments or reports.
Captures the actual page; canvas_snapshot is a separate structural SVG preview.
`;
export async function captureResearchPage(options) {
for (const key of ['base', 'instance', 'state', 'out', 'browser']) {
  if (!options[key]) throw new Error(`--${key} is required. Use --help.`);
}
const base = new URL(options.base);
if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('--base must be an origin without credentials.');
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('HTTPS is required except for an explicit loopback preview.');
if (!/^asi_[a-zA-Z0-9_-]{1,90}$/.test(options.instance)) throw new Error('Invalid instance identifier.');
if (options.layout && !['tree', 'hierarchy', 'canvas'].includes(options.layout)) throw new Error('Invalid layout.');
const width = Number(options.width ?? 1600), height = Number(options.height ?? 1040);
if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 2560 || height < 480 || height > 2160) throw new Error('Viewport outside supported bounds.');
const output = resolve(options.out);
if (!/\.(png|jpe?g)$/i.test(output)) throw new Error('--out must end with .png, .jpg or .jpeg');
const storageState = JSON.parse(await readFile(resolve(options.state), 'utf8'));
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const url = new URL('/apps/research-v2/open', base);
url.searchParams.set('instance', options.instance);
if (options.scope) url.searchParams.set('researchScope', options.scope);
if (options.layout) url.searchParams.set('researchLayout', options.layout);
const browser = await chromium.launch({ executablePath: resolve(options.browser), headless: true });
const errors = [];
try {
  const context = await browser.newContext({ storageState, viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', error => { if (errors.length < 20) errors.push(error.message.slice(0, 500)); });
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('.rv-app[data-project]').waitFor({ timeout: 150_000 });
  await page.waitForFunction(() => {
    const surface = document.querySelector('.rv-app[data-project]');
    return surface && surface.getAttribute('data-graph-revision') && surface.getAttribute('data-layout-revision') && ![...surface.querySelectorAll('.rv-notice')].some(el => el.textContent.includes('正在读取项目'));
  }, undefined, { timeout: 150_000 });
  const project = await page.locator('.rv-app[data-project]').getAttribute('data-project');
  if (project !== options.instance) throw new Error('Page did not open the requested instance.');
  if (options.node) {
    // Evaluate only the supplied stable node ID; never interpret it as a CSS selector.
    const target = await page.locator('[data-node]').evaluateAll((elements, id) => elements.findIndex(el => el.getAttribute('data-node') === id), options.node);
    if (target < 0) throw new Error('Requested node is outside the visible scope.');
    await page.locator('[data-node]').nth(target).getByRole('button', { name: /^查看详情 / }).click();
    await page.waitForFunction((id) => [...document.querySelectorAll('.rv-window')].some(el =>
      el.getAttribute('data-window') === `${id}:current` && !el.hidden && el.getBoundingClientRect().width > 0
    ), options.node, { timeout: 10_000 });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  const inspect = () => page.evaluate(() => {
    const surface = document.querySelector('.rv-app');
    return {
      graphRevision: surface.getAttribute('data-graph-revision'),
      layoutRevision: surface.getAttribute('data-layout-revision'),
      nodes: [...surface.querySelectorAll('[data-node]')].map(node => {
        const rect = node.getBoundingClientRect();
        return { id: node.getAttribute('data-node'), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      }),
    };
  });
  let geometry;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await inspect();
    await page.screenshot({ path: output, animations: 'disabled', ...(/\.jpe?g$/i.test(output) ? { type: 'jpeg', quality: 90 } : {}) });
    const after = await inspect();
    if (JSON.stringify(before) === JSON.stringify(after)) { geometry = after; break; }
  }
  if (!geometry) throw new Error('Canvas changed during capture; take a fresh screenshot.');
  await chmod(output, 0o600);
  const report = { ...geometry, instance: project, scope: options.scope ?? '', layout: options.layout ?? 'tree', url: page.url(), viewport: { width, height }, capturedAt: new Date().toISOString(), screenshot: output, visibleNodes: await page.locator('[data-node]').count(), errors };
  const reportPath = output.replace(/\.(png|jpe?g)$/i, '.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
} finally {
  await browser.close();
}

}

async function main() {
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(help); process.exit(0); }
const allowed = new Set(['base', 'instance', 'state', 'out', 'browser', 'scope', 'layout', 'node', 'width', 'height']);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
    throw new Error(`Unknown or incomplete option ${args[i]}. Use --help.`);
  }
  options[key] = args[i + 1];
}
  const report = await captureResearchPage(options);
  console.log(JSON.stringify(report));
  if (report.errors.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
