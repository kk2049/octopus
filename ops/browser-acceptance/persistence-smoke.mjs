// Explicit real GUI fixture. Chromium stays in the approved sibling container.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const cli = process.env.OCTOPUS_BROWSER_CLI ?? 'octopus-browser';
const contexts = [], evidence = [];
let submissions = 0;
const html = String.raw`<!doctype html><meta charset="utf-8"><title>Task login recovery fixture</title>
<style>body{font:20px system-ui;margin:40px;line-height:1.7}button{font:inherit;padding:10px}output{display:block;white-space:pre-line;color:#175c36}</style>
<h1>Task login recovery</h1><p>Disposable local fixture; no real user credentials.</p>
<button id="login">Save fixture login once</button><output id="state">Loading</output>
<script>
const dbReady=new Promise((resolve,reject)=>{const r=indexedDB.open('login-fixture',1);r.onupgradeneeded=()=>r.result.createObjectStore('identity');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
async function value(write){const db=await dbReady;return new Promise((resolve,reject)=>{const tx=db.transaction('identity',write?'readwrite':'readonly');const r=write?tx.objectStore('identity').put('fixture-A','user'):tx.objectStore('identity').get('user');tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error)})}
async function paint(){const cookie=await(await fetch('/identity')).text();const idb=await value(false);document.querySelector('#state').textContent='Cookie: '+cookie+'\nLocal: '+(localStorage.getItem('fixture-user')||'none')+'\nIndexedDB: '+(idb||'none')}
document.querySelector('#login').onclick=async()=>{await fetch('/login',{method:'POST'});localStorage.setItem('fixture-user','fixture-A');await value(true);await paint()};paint();
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/login' && req.method === 'POST') {
    submissions++;
    res.setHeader('set-cookie', 'fixture-user=fixture-A; HttpOnly; SameSite=Lax; Path=/');
    res.end('ok');
  } else if (req.url === '/identity') res.end(req.headers.cookie?.includes('fixture-user=fixture-A') ? 'fixture-A' : 'none');
  else { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
async function call(name, args = {}) {
  const { stdout } = await exec(cli, [name, JSON.stringify(args)], { timeout: 22_000, maxBuffer: 300_000 });
  const result = JSON.parse(stdout);
  if (result.path) evidence.push(result.path);
  return result;
}
async function assertLogin(session, who) {
  await call('browser_wait_for', { session, selector: `#state:has-text("IndexedDB: ${who}")` });
  const observed = await call('browser_observe', { session, selector: '#state' });
  for (const key of ['Cookie', 'Local', 'IndexedDB']) assert.ok(observed.snapshot.includes(`${key}: ${who}`), `${key} identity`);
}
try {
  const health = await call('doctor');
  assert.equal(health.lease_seconds, null);
  assert.equal(health.persistent_login_supported, true);
  // A restart test is only appropriate with no unrelated live tasks.
  if (process.argv.includes('--restart')) assert.equal(health.contexts, 0);
  const first = await call('browser_open', { url, label: 'private-login-recovery-fixture', persist_login: true });
  const session = first.session; contexts.push(session);
  assert.equal(first.expires_at, null);
  await call('browser_action', { session, action: 'click', selector: '#login' });
  await assertLogin(session, 'fixture-A');
  await call('browser_suspend', { session });
  await call('browser_resume', { session });
  await assertLogin(session, 'fixture-A');
  if (process.argv.includes('--restart')) {
    process.stdout.write(JSON.stringify({ ready_for_restart: true, contexts: 1, fixture_submissions: submissions }) + '\n');
    await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', resolve); });
    process.stdin.pause();
    await call('browser_resume', { session });
    await assertLogin(session, 'fixture-A');
  }
  await call('browser_screenshot', { session });
  const second = await call('browser_open', { url, label: 'separate-login-isolation-fixture' });
  contexts.push(second.session);
  await assertLogin(second.session, 'none');
  assert.equal(submissions, 1, 'no login/input replay');
  const errors = await call('browser_errors', { session });
  assert.deepEqual(errors.errors, []);
  process.stdout.write(JSON.stringify({ passed: true, restart: process.argv.includes('--restart'), checks: ['no lifetime cap', 'HttpOnly session cookie', 'localStorage', 'IndexedDB', 'suspend/resume', 'task isolation', 'no input replay'], evidence }, null, 2) + '\n');
} finally {
  for (const session of contexts) await call('browser_close', { session }).catch(error => process.stderr.write(error.message + '\n'));
  await new Promise(resolve => server.close(resolve));
}
