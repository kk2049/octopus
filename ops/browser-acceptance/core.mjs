import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const zip = promisify(gzip), unzip = promisify(gunzip);
const CHECKPOINT_BYTES = 4 * 1024 ** 2, EXPANDED_BYTES = 64 * 1024 ** 2;

async function encodeCheckpoint(saved) {
  const plain = JSON.stringify(saved), bytes = Buffer.byteLength(plain);
  if (bytes > EXPANDED_BYTES) throw new Error('Login state exceeds the expanded checkpoint budget');
  if (bytes <= CHECKPOINT_BYTES) return plain;
  const payload = (await zip(plain)).toString('base64');
  const packed = JSON.stringify({ version: 2, encoding: 'gzip-base64', payload });
  if (Buffer.byteLength(packed) > CHECKPOINT_BYTES) throw new Error('Login state exceeds the compressed checkpoint budget');
  return packed;
}

async function decodeCheckpoint(data) {
  let saved = JSON.parse(data);
  if (saved.version === 2) {
    if (saved.encoding !== 'gzip-base64' || typeof saved.payload !== 'string') throw new Error('Invalid checkpoint encoding');
    const plain = await unzip(Buffer.from(saved.payload, 'base64'), { maxOutputLength: EXPANDED_BYTES });
    saved = JSON.parse(plain.toString('utf8'));
  }
  return saved;
}

export function webUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  return url.href;
}

// A timed-out input may already have reached the page. Retire that context,
// cancel its outstanding Playwright work, and never replay the input.
export async function boundedAction(run, retire, milliseconds = 15_000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
      timer = setTimeout(() => {
        retire();
        reject(new Error('Browser action exceeded its deadline; context closed. Input outcome may be unknown; do not replay automatically.'));
      }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export class BrowserSessions {
  constructor(browser, { state, origin, credentialFile, maxSessions = 4, clock = Date.now } = {}) {
    this.browser = browser;
    this.state = state;
    this.origin = new URL(webUrl(origin)).origin;
    this.credentialFile = credentialFile;
    this.maxSessions = maxSessions;
    this.clock = clock;
    this.sessions = new Map();
    this.opening = 0;
    this.restoring = new Set();
    this.secrets = new Set();
  }
  redact(value) { let text = String(value); for (const secret of this.secrets) text = text.replaceAll(secret, '[credential]'); return text; }
  stateFile(id) {
    if (!/^[0-9a-f]{48}$/.test(id ?? '')) throw new Error('Invalid task session handle');
    return path.join(this.state, 'sessions', `${id}.json`);
  }
  async checkpoint(id, s) {
    if (!s.persistent || s.retired) return;
    // Serialize writes with retirement: close can never resurrect saved login.
    const save = async () => {
      if (s.retired) return;
      const storageState = await s.context.storageState({ indexedDB: true });
      const savedAt = new Date(this.clock()).toISOString();
      const data = await encodeCheckpoint({ version: 1, viewport: s.page.viewportSize(),
        url: webUrl(s.page.url()), label: s.label, savedAt, storageState });
      if (s.retired) return;
      const file = this.stateFile(id), temp = `${file}.tmp`;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(temp, data, { mode: 0o600 });
        await fs.rename(temp, file);
        s.savedAt = savedAt; s.saveFailed = false;
      } finally { await fs.rm(temp, { force: true }); }
    };
    s.saving = (s.saving ?? Promise.resolve()).catch(() => {}).then(save);
    try { await s.saving; } catch (error) { s.saveFailed = true; throw error; }
  }
  async checkpointIdle() {
    for (const [id, s] of this.sessions) {
      if (!s.persistent || s.busy || s.retired) continue;
      s.busy = true;
      try { await boundedAction(() => this.checkpoint(id, s), () => this.retire(id, s)); }
      catch { s.saveFailed = true; }
      finally { s.busy = false; }
    }
  }
  retire(id, s) {
    s.retired = true;
    this.sessions.delete(id);
    // Preserve the last completed checkpoint, never retry uncertain input.
    void s.context.close().catch(() => {});
  }
  async close(id, preserve = false) {
    const s = this.sessions.get(id);
    const file = this.stateFile(id);
    if (this.restoring.has(id)) throw new Error('Session restore is in flight');
    if (!s) {
      if (preserve) throw new Error('Session is not active; use browser_resume');
      // Explicit close also forgets a suspended task. Do not parse its secrets.
      await fs.unlink(file);
      return { closed: true, login_forgotten: true };
    }
    if (preserve && !s.persistent) throw new Error('This task did not opt into persist_login');
    if (preserve) await this.checkpoint(id, s);
    s.retired = true;
    await s.saving?.catch(() => {});
    if (!preserve) await fs.rm(file, { force: true });
    await s.context.close();
    this.sessions.delete(id);
    return preserve ? { suspended: true, saved_at: s.savedAt } : { closed: true, login_forgotten: true };
  }
  async shutdown() {
    // HTTP admission is stopped by the service first. No input is replayed.
    await Promise.allSettled([...this.sessions].map(async ([id, s]) => {
      if (!s.busy) await this.checkpoint(id, s);
      s.retired = true;
      await s.saving?.catch(() => {});
      await s.context.close();
    }));
    this.sessions.clear();
  }
  async resume(args) {
    const id = args.session, file = this.stateFile(id);
    if (this.sessions.has(id)) return { session: id, expires_at: null, ...await this.invoke('browser_observe', { session: id }) };
    if (this.restoring.has(id)) throw new Error('Session restore is in flight');
    this.restoring.add(id);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > CHECKPOINT_BYTES) throw new Error('Saved login must be a private bounded regular file');
      let saved;
      try { saved = await decodeCheckpoint(await fs.readFile(file, 'utf8')); }
      catch { throw new Error('Saved login state is invalid'); }
      if (saved.version !== 1 || !saved.storageState || !Array.isArray(saved.storageState.cookies) || !Array.isArray(saved.storageState.origins)) throw new Error('Saved login state is invalid');
      return await this.open({ url: args.url ?? saved.url, ...saved.viewport, label: saved.label, persist_login: true }, { id, saved });
    } finally { this.restoring.delete(id); }
  }
  async open(args = {}, restore) {
    if (this.sessions.size + this.opening >= this.maxSessions) throw new Error('Browser capacity is full; suspend or close your own task context');
    if (args.persist_login !== undefined && typeof args.persist_login !== 'boolean') throw new Error('persist_login must be boolean');
    const width = args.width ?? 1280, height = args.height ?? 900;
    if (!Number.isInteger(width) || width < 320 || width > 1600 || !Number.isInteger(height) || height < 320 || height > 1200) throw new Error('Viewport exceeds supported bounds');
    const url = webUrl(args.url ?? this.origin);
    this.opening++;
    let context;
    try {
      const artifacts = path.join(this.state, 'artifacts');
      await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
      // Preserve existing evidence instead of silently deleting another task's
      // screenshots. Directory enumeration is bounded to this service's store.
      if (!restore) {
        const directory = await fs.opendir(artifacts); let retained = 0;
        for await (const entry of directory) if (entry.isDirectory() && ++retained >= 128) throw new Error('Evidence retention is full; archive completed browser sessions before opening more');
      }
      context = await this.browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, acceptDownloads: false, ...(restore ? { storageState: restore.saved.storageState } : {}) });
      context.setDefaultTimeout(8_000);
      context.setDefaultNavigationTimeout(12_000);
      const id = restore?.id ?? randomBytes(24).toString('hex');
      const dir = path.join(this.state, 'artifacts', id);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const shots = (await fs.readdir(dir)).filter((name) => /^\d{3}\.jpg$/.test(name));
      const count = Math.max(0, ...shots.map((name) => Number.parseInt(name, 10)));
      const s = { context, dir, count, bytes: count * 160_000, busy: false, events: [], label: String(args.label ?? '').slice(0, 120), persistent: args.persist_login === true, retired: false, savedAt: restore?.saved.savedAt };
      const attach = (page) => {
        page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') add(m.type(), m.text()); });
        page.on('pageerror', (error) => add('pageerror', error.message));
        page.on('requestfailed', (request) => add('requestfailed', `${new URL(request.url()).origin} ${request.failure()?.errorText ?? ''}`));
        page.on('response', (response) => { if (response.status() >= 400) add('http', `${response.status()} ${new URL(response.url()).origin}${new URL(response.url()).pathname}`); });
      };
      const add = (kind, message) => { s.events.push({ at: new Date(this.clock()).toISOString(), kind, message: this.redact(message).slice(0, 1200) }); s.events = s.events.slice(-40); };
      context.on('page', (page) => {
        if (context.pages().length > 8) { void page.close().catch(() => {}); return; }
        attach(page);
      });
      s.page = await context.newPage();
      const observation = await boundedAction(async () => {
        await s.page.goto(url, { waitUntil: 'domcontentloaded' });
        const observation = await this.observe(s);
        // Recovery is separate from the completed navigation. A failed save
        // must not destroy the live login or turn success into a retry signal.
        await this.checkpoint(id, s).catch(() => {});
        return observation;
      }, () => { s.retired = true; void context.close().catch(() => {}); });
      this.sessions.set(id, s);
      return { session: id, expires_at: null, persistent_login: s.persistent, viewport: { width, height }, ...observation,
        ...(s.persistent ? { login_checkpoint: { saved_at: s.savedAt, failed: s.saveFailed === true } } : {}) };
    } catch (error) { await context?.close().catch(() => {}); throw error; }
    finally { this.opening--; }
  }
  async observe(s, args = {}) {
    const page = s.page;
    const root = args.frame_selector ? page.frameLocator(args.frame_selector) : page;
    const aria = await root.locator(args.selector ?? 'body').ariaSnapshot({ timeout: 8_000 });
    return { url: this.redact(page.url()), title: this.redact(await page.title()), snapshot: this.redact(aria).slice(0, 28_000),
      truncated: aria.length > 28_000, tabs: s.context.pages().map((p, index) => ({ index, url: this.redact(p.url()), selected: p === page })) };
  }
  async invoke(name, args = {}) {
    if (name === 'browser_health') return { ready: this.browser.isConnected(), browser: this.browser.version(), headed: true, contexts: this.sessions.size, max_contexts: this.maxSessions, lease_seconds: null, persistent_login_supported: true, checkpoint_failures: [...this.sessions.values()].filter((s) => s.saveFailed).length };
    if (name === 'browser_open') return await this.open(args);
    if (name === 'browser_resume') return await this.resume(args);
    const s = this.sessions.get(args.session);
    if (!s) {
      if (name === 'browser_close') return await this.close(args.session);
      throw new Error('Session is not active; use browser_resume for a saved task or browser_open for a new task');
    }
    if (s.busy) throw new Error('Another action is in flight in this context; query before issuing further input');
    s.busy = true;
    try {
      return await boundedAction(async () => {
      const perform = async () => {
      if (name === 'browser_close') return await this.close(args.session);
      if (name === 'browser_suspend') return await this.close(args.session, true);
      if (name === 'browser_observe') return await this.observe(s, args);
      if (name === 'browser_wait_for') {
        if (!args.selector || !['visible', 'hidden'].includes(args.state ?? 'visible')) throw new Error('A selector and visible/hidden state are required');
        const root = args.frame_selector ? s.page.frameLocator(args.frame_selector) : s.page;
        await root.locator(args.selector).waitFor({ state: args.state ?? 'visible', timeout: 8_000 });
        return { matched: true, state: args.state ?? 'visible', url: this.redact(s.page.url()) };
      }
      if (name === 'browser_errors') return { errors: s.events };
      if (name === 'browser_navigate') { await s.page.goto(webUrl(args.url), { waitUntil: 'domcontentloaded' }); return await this.observe(s); }
      if (name === 'browser_tabs') {
        const page = s.context.pages()[args.index]; if (!page) throw new Error('No such tab');
        if (args.close) { if (s.context.pages().length === 1) throw new Error('Use browser_close to close the last tab'); await page.close(); s.page = s.context.pages()[0]; }
        else { s.page = page; await page.bringToFront(); }
        return await this.observe(s);
      }
      if (name === 'browser_screenshot') {
        if (s.count >= 80 || s.bytes >= 16 * 1024 ** 2) throw new Error('This session reached its screenshot evidence budget');
        let bytes;
        for (const quality of [60, 40, 25]) {
          bytes = await s.page.screenshot({ type: 'jpeg', quality, scale: 'css', timeout: 8_000 });
          if (bytes.length <= 160_000) break;
        }
        if (bytes.length > 160_000) throw new Error('Screenshot exceeds bounded MCP output; use a smaller viewport');
        const file = `${String(++s.count).padStart(3, '0')}.jpg`;
        await fs.writeFile(path.join(s.dir, file), bytes, { mode: 0o600, flag: 'wx' }); s.bytes += bytes.length;
        return { artifact: `${args.session}/${file}`, mimeType: 'image/jpeg', image: bytes.toString('base64'), url: this.redact(s.page.url()), bytes: bytes.length };
      }
      if (name === 'browser_login_acceptance') {
        if (new URL(s.page.url()).origin !== this.origin) throw new Error('Acceptance login is restricted to the configured Octopus origin');
        if (!this.credentialFile) throw new Error('No acceptance credential is provisioned');
        const stat = await fs.lstat(this.credentialFile);
        if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Acceptance credential must be a private regular file');
        const secret = (await fs.readFile(this.credentialFile, 'utf8')).trim(); if (!secret || secret.length > 1024) throw new Error('Invalid credential file');
        this.secrets.add(secret);
        await s.page.goto(`${this.origin}/login`, { waitUntil: 'domcontentloaded' });
        if (new URL(s.page.url()).origin !== this.origin) throw new Error('Login redirected outside the configured Octopus origin');
        await s.page.locator('#octopus-login-token').fill(secret);
        if (new URL(s.page.url()).origin !== this.origin) throw new Error('Login origin changed before submission');
        await s.page.locator('button[type=submit]').click();
        await s.page.waitForURL((url) => url.origin === this.origin && url.pathname !== '/login', { timeout: 12_000 });
        return { authenticated: true, identity: 'configured acceptance account', ...await this.observe(s) };
      }
      if (name === 'browser_action') {
        const page = s.page;
        const root = args.frame_selector ? page.frameLocator(args.frame_selector) : page;
        const locator = args.selector ? root.locator(args.selector) : null;
        const point = () => { if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.y < 0 || args.x >= page.viewportSize().width || args.y >= page.viewportSize().height) throw new Error('Coordinates must be inside the current screenshot viewport'); };
        const text = String(args.text ?? '');
        switch (args.action) {
          case 'click': if (locator) await locator.click(); else { point(); await page.mouse.click(args.x, args.y); } break;
          case 'hover': if (locator) await locator.hover(); else { point(); await page.mouse.move(args.x, args.y); } break;
          case 'fill': if (!locator) throw new Error('fill requires a selector'); await locator.fill(text); break;
          case 'type': await page.keyboard.insertText(text); break;
          case 'press': if (!args.key || args.key.length > 80) throw new Error('A bounded key chord is required'); if (locator) await locator.press(args.key); else await page.keyboard.press(args.key); break;
          case 'select': if (!locator) throw new Error('select requires a selector'); await locator.selectOption(text); break;
          case 'check': case 'uncheck': if (!locator) throw new Error('check requires a selector'); await locator.setChecked(args.action === 'check'); break;
          case 'scroll': if (![args.dx ?? 0, args.dy ?? 0].every((v) => Number.isFinite(v) && Math.abs(v) <= 3000)) throw new Error('Scroll exceeds bounds'); if (args.x !== undefined) { point(); await page.mouse.move(args.x, args.y); } await page.mouse.wheel(args.dx ?? 0, args.dy ?? 0); break;
          case 'drag': point(); if (!Number.isFinite(args.to_x) || !Number.isFinite(args.to_y) || args.to_x < 0 || args.to_y < 0 || args.to_x >= page.viewportSize().width || args.to_y >= page.viewportSize().height) throw new Error('Drag endpoint must be inside the viewport'); await page.mouse.move(args.x, args.y); await page.mouse.down(); try { await page.mouse.move(args.to_x, args.to_y, { steps: 10 }); } finally { await page.mouse.up(); } break;
          default: throw new Error('Unknown browser action');
        }
        // Some UIs paint in a later frame. Call observe/screenshot separately;
        // returning success here does not claim application-level correctness.
        return { performed: args.action, url: this.redact(page.url()), needs_observation: true };
      }
      throw new Error('Unknown browser tool');
      };
      const result = await perform();
      // Never hide a completed input/observation behind a recovery I/O error.
      // Explicit suspend above still requires a successful fresh checkpoint.
      await this.checkpoint(args.session, s).catch(() => {});
      return { ...result, ...(s.persistent && !s.retired ? { login_checkpoint: { saved_at: s.savedAt, failed: s.saveFailed === true } } : {}) };
      }, () => this.retire(args.session, s));
    } finally {
      s.busy = false;
      const log = path.join(s.dir, 'actions.jsonl');
      if ((await fs.stat(log).catch(() => null))?.size >= 64 * 1024) await fs.rename(log, `${log}.previous`).catch(() => {});
      await fs.appendFile(log, JSON.stringify({ at: new Date(this.clock()).toISOString(), tool: name }) + '\n', { mode: 0o600 }).catch(() => {});
    }
  }
}
