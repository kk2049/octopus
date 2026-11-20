// Explicit, opt-in real GUI probe. Not part of the synchronous landing gate.
// Run where loopback is shared with the configured browser container.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const cli = process.env.OCTOPUS_BROWSER_CLI ?? 'octopus-browser';
const contexts = [], evidence = [];
const html = `<!doctype html><meta charset="utf-8"><title>Browser acceptance fixture</title>
<style>body{font:18px system-ui;margin:30px;max-width:700px}input,button{font:inherit;margin:8px;padding:8px}iframe{width:95%;height:180px;border:1px solid #bbb}output{display:block;margin:16px;color:#14613f}</style>
<h1>Local browser acceptance</h1><p>Private disposable fixture — no production writes.</p>
<form><label>Title<input id="title"></label><button>Save</button></form><output id="saved"></output>
<iframe title="Isolated app" src="/frame"></iframe><p><a href="/popup" target="_blank">Open preview tab</a></p>
<button id="error">Emit expected test error</button>
<script>const saved=document.querySelector('#saved');saved.textContent=localStorage.getItem('savedTitle')||'Nothing saved.';
document.querySelector('form').onsubmit=e=>{e.preventDefault();const value=document.querySelector('#title').value;localStorage.setItem('savedTitle',value);requestAnimationFrame(()=>saved.textContent='Saved: '+value)};
document.querySelector('#error').onclick=()=>console.error('EXPECTED_BROWSER_SMOKE_ERROR');</script>`;
const server = http.createServer((req,res) => {
  res.setHeader('content-type','text/html; charset=utf-8');
  res.end(req.url === '/frame' ? '<!doctype html><meta charset="utf-8"><label>Frame input<input id="frame-input"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Apply in frame</button><output></output>'
    : req.url === '/popup' ? '<!doctype html><title>Preview tab</title><h1>Preview opened</h1>' : html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
async function call(name,args={}) {
  const start=performance.now();
  const {stdout}=await exec(cli,[name,JSON.stringify(args)],{timeout:22_000,maxBuffer:300_000});
  const result=JSON.parse(stdout);evidence.push({tool:name,elapsed_ms:Math.round(performance.now()-start),artifact:result.path});return result;
}
try {
  const health=await call('doctor');assert.equal(health.ready,true);
  const first=await call('browser_open',{url,label:'opt-in-local-gui-smoke'});contexts.push(first.session);
  const session=first.session;
  await call('browser_action',{session,action:'fill',selector:'#title',text:'GUI smoke saved value'});
  await call('browser_action',{session,action:'press',selector:'#title',key:'Enter'});
  await call('browser_wait_for',{session,selector:'#saved:has-text("Saved: GUI smoke saved value")'});
  await call('browser_action',{session,frame_selector:'iframe',action:'fill',selector:'#frame-input',text:'iframe input received'});
  await call('browser_action',{session,frame_selector:'iframe',action:'click',selector:'button'});
  const frame=await call('browser_observe',{session,frame_selector:'iframe'});assert.match(frame.snapshot,/iframe input received/);
  const screenshot=await call('browser_screenshot',{session});assert.ok(screenshot.path);
  const second=await call('browser_open',{url,label:'storage-isolation-smoke',width:390,height:844});contexts.push(second.session);
  assert.match(second.snapshot,/Nothing saved/);assert.doesNotMatch(second.snapshot,/GUI smoke saved value/);
  await call('browser_screenshot',{session:second.session});
  await call('browser_action',{session,action:'click',selector:'a'});
  const observed=await call('browser_observe',{session});assert.equal(observed.tabs.length,2);
  await call('browser_tabs',{session,index:1});
  assert.match((await call('browser_observe',{session})).snapshot,/Preview opened/);
  await call('browser_tabs',{session,index:1,close:true});
  await call('browser_action',{session,action:'click',selector:'#error'});
  assert.ok((await call('browser_errors',{session})).errors.some(e=>e.message.includes('EXPECTED_BROWSER_SMOKE_ERROR')));
  console.log(JSON.stringify({passed:true,checks:['real form submit','rendered completion','iframe input/click/observe','desktop/mobile screenshot','storage isolation','popup select/close','console error capture'],evidence},null,2));
} finally {
  for(const session of contexts)await call('browser_close',{session}).catch(error=>process.stderr.write(error.message+'\n'));
  await new Promise(resolve=>server.close(resolve));
}
