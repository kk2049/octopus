/**
 * The web face — one client runtime shared by every page of every app.
 *
 * Server ships a shell with `window.__BOOT` (page def + view + viewer's
 * allowed actions) and this script inline; the client renders everything from
 * view JSON and re-renders on SSE pushes. Rendering is per-slot and idempotent;
 * a slot containing the user's focused input is left alone until blur, so live
 * updates never eat a half-typed form (the tickets-page lesson, made a law).
 *
 * Authored as a template string per repo idiom (page.ts etc.). Discipline for
 * sanity inside the string: no backticks, no ${} — concatenation only.
 */

import { VIEW_RUNTIME_JS } from "./view-js.js";

export const CLIENT_CSS = `
:root { --bg:#f7f7f5; --fg:#1c1c1a; --mut:#6b6b66; --card:#ffffff; --line:#e4e4df;
  --ok:#1a7f37; --warn:#b58900; --err:#c0392b; --acc:#3b5bdb; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#14141a; --fg:#e8e8e4; --mut:#8f8f98; --card:#1d1d26; --line:#2c2c38; --acc:#7c93f2; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:14px/1.55 -apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif; }
a { color: var(--acc); text-decoration: none; }
.topbar { display:flex; gap:14px; align-items:center; padding:9px 16px;
  border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; z-index:5; }
.topbar .brand { font-weight:700; }
.topbar .nav a { margin-right:10px; color:var(--mut); }
.topbar .nav a.cur { color:var(--fg); font-weight:600; }
.topbar .who { margin-left:auto; color:var(--mut); font-size:12px; }
.topbar .who .linkish { background:none; border:none; padding:0; font:inherit;
  color:var(--acc); cursor:pointer; text-decoration:underline; }
.errbar { background:#7a1f1f; color:#fff; padding:6px 16px; font-size:13px; white-space:pre-wrap; }
#cols { display:flex; gap:12px; padding:12px 16px; align-items:flex-start; }
.col { flex:1 1 0; min-width:0; display:flex; flex-direction:column; gap:12px; }
.slot { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.slot h2 { margin:0 0 4px; font-size:16px; }
.slot .sub { color:var(--mut); font-size:12px; margin-bottom:6px; }
.md p { margin:6px 0; } .md h3 { margin:10px 0 4px; font-size:14px; }
.md code { background:rgba(127,127,127,.15); padding:1px 4px; border-radius:4px; }
.md ul { margin:4px 0; padding-left:18px; }
.item { padding:7px 8px; border-radius:8px; display:flex; gap:8px; align-items:baseline; }
.item.sel { cursor:pointer; } .item.sel:hover { background:rgba(127,127,127,.10); }
.item.active { background:rgba(59,91,219,.13); box-shadow:inset 0 0 0 1px var(--acc); border-radius:8px; }
.item .t { flex:0 0 auto; width:8px; height:8px; border-radius:50%; background:var(--mut); align-self:center; }
.item .t.ok{background:var(--ok)} .item .t.warn{background:var(--warn)} .item .t.err{background:var(--err)}
.item b { font-weight:600; } .item .badge { font-size:11px; color:var(--mut);
  border:1px solid var(--line); border-radius:99px; padding:0 7px; }
.item .sub2 { color:var(--mut); font-size:12px; }
dl.kv { margin:0; display:grid; grid-template-columns:auto 1fr; gap:3px 12px; }
dl.kv dt { color:var(--mut); } dl.kv dd { margin:0; }
table.tb { border-collapse:collapse; width:100%; font-size:13px; }
table.tb th, table.tb td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); }
.banner { padding:8px 10px; border-radius:8px; font-size:13px; }
.banner.ok{background:rgba(26,127,55,.12)} .banner.warn{background:rgba(181,137,0,.14)} .banner.err{background:rgba(192,57,43,.14)}
form.af { display:flex; flex-direction:column; gap:8px; }
form.af label { font-size:12px; color:var(--mut); display:block; margin-bottom:2px; }
form.af input, form.af select, form.af textarea { width:100%; padding:7px 9px; border:1px solid var(--line);
  border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
.btn { display:inline-block; border:1px solid var(--line); background:var(--card); color:var(--fg);
  padding:6px 14px; border-radius:8px; cursor:pointer; font:inherit; }
.btn.primary { background:var(--acc); border-color:var(--acc); color:#fff; }
.btn:hover { filter:brightness(1.06); }
.btnrow { display:flex; gap:8px; flex-wrap:wrap; }
.tl h4 { margin:8px 0 4px; font-size:12px; color:var(--mut); text-transform:uppercase; letter-spacing:.4px; }
.tl .item .at { color:var(--mut); font-size:12px; min-width:74px; }
#toast { position:fixed; right:16px; bottom:16px; display:flex; flex-direction:column; gap:8px; z-index:50; }
#toast div { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--acc);
  padding:8px 12px; border-radius:8px; box-shadow:0 4px 14px rgba(0,0,0,.18); max-width:340px; }
#toast div.bad { border-left-color:var(--err); }
.chat { display:flex; flex-direction:column; height:72vh; }
.chatlog { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right:4px; }
.msg { max-width:88%; padding:7px 11px; border-radius:12px; white-space:pre-wrap; word-break:break-word; }
.msg.user { align-self:flex-end; background:var(--acc); color:#fff; }
.msg.assistant { align-self:flex-start; background:rgba(127,127,127,.12); }
.msg.tool { align-self:flex-start; color:var(--mut); font-size:12px; background:none; padding:0 4px; }
.chatstatus { color:var(--mut); font-size:12px; min-height:18px; margin:6px 0 4px; }
.sec { display:flex; flex-direction:column; gap:10px; }
.subnode { border-top:1px dashed var(--line); padding-top:8px; }
.subnode:first-child { border-top:none; padding-top:0; }
.msg.elicitwrap { max-width:96%; background:none; padding:0; }
.chathead { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
.chip { font-size:11px; color:var(--mut); border:1px solid var(--line); border-radius:99px; padding:2px 9px; }
.chip.modechip { cursor:pointer; } .chip.modechip:hover { color:var(--fg); border-color:var(--acc); }
.btn.mini { padding:2px 9px; font-size:12px; border-radius:99px; }
.cfgpanel { border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-bottom:8px;
  display:flex; flex-direction:column; gap:8px; background:var(--bg); }
.cfgrow { display:flex; gap:10px; align-items:center; }
.cfgrow label { font-size:12px; color:var(--mut); min-width:104px; }
.cfgrow input, .cfgrow select { flex:1; padding:5px 8px; border:1px solid var(--line); border-radius:8px;
  background:var(--card); color:var(--fg); font:inherit; }
details.think { color:var(--mut); font-size:13px; margin:2px 0; max-width:88%; }
details.think summary { cursor:pointer; }
.msg.tool details summary { cursor:pointer; }
.msg.tool pre, .subagentblk pre { white-space:pre-wrap; word-break:break-word; background:rgba(127,127,127,.10);
  border-radius:8px; padding:6px 8px; margin:4px 0 0; max-height:200px; overflow-y:auto; font-size:12px; }
.filechip { align-self:flex-start; font-size:12px; color:var(--ok); background:rgba(26,127,55,.10);
  border-radius:99px; padding:2px 10px; }
.subagentblk { align-self:flex-start; font-size:13px; border-left:3px solid var(--acc);
  padding:4px 10px; background:rgba(127,127,127,.08); border-radius:0 8px 8px 0; max-width:88%; }
.docedit .docview { cursor:text; position:relative; border-radius:8px; padding:4px 6px; min-height:60px; }
.docedit .docview:hover { outline:1px dashed var(--acc); }
.docedit-hint { position:absolute; right:8px; top:4px; font-size:11px; color:var(--mut); opacity:0;
  transition:opacity .15s; }
.docedit .docview:hover .docedit-hint { opacity:1; }
.docedit textarea { width:100%; padding:8px 10px; border:1px solid var(--acc); border-radius:8px;
  background:var(--bg); color:var(--fg); font:13px/1.5 ui-monospace,monospace; margin-bottom:8px; }
.elicit { border:1px solid var(--acc); border-radius:12px; padding:10px 12px; background:rgba(59,91,219,.06); }
.elicit-tag { font-size:12px; color:var(--acc); font-weight:600; margin-bottom:4px; }
.chatsend { display:flex; gap:8px; }
.chatsend textarea { flex:1; resize:none; height:56px; padding:8px 10px; border:1px solid var(--line);
  border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
@media (max-width: 900px) { #cols { flex-direction:column; } .chat { height:50vh; } }
`;

/**
 * The Trusted Host script.
 *
 * It holds everything with authority — the session cookie, the CSRF secret and
 * the server-minted instance handle — and it renders NO app-authored data. All
 * of that happens in the sandboxed Agent View frame (host/view-frame.ts), which
 * talks to this script over one transferred MessagePort and can only propose.
 *
 * The Host's job on every proposal is the same three lines: it is a proposal,
 * not a request; the identity is the Host's binding, not anything in the
 * message; the server checks it again anyway.
 *
 * Precision about what the frame cannot do, since it is easy to overclaim: its
 * SCRIPT cannot read cookies (opaque origin — `document.cookie` throws) and
 * cannot reach this DOM. Its initial navigation is still an ordinary request to
 * this Host's origin and therefore carries this Host's cookies, and it can
 * navigate itself. See `host/view-frame.ts` for why that is acceptable for this
 * same-origin probe and why Session Plus uses a separate hostname.
 */
export const CLIENT_JS = `
(function(){
  var B = window.__BOOT;
  var frame = document.getElementById('viewframe');
  var chan = new MessageChannel();
  var port = chan.port1;
  var booted = false;

  function toast(text, ok){
    var t = document.getElementById('toast');
    t.textContent = text; t.className = ok ? 'ok' : 'bad'; t.hidden = false;
    setTimeout(function(){ t.hidden = true; }, 3200);
  }

  function post(path, body){
    /* Authority-bearing headers live here and only here. */
    return fetch(path, { method:'POST',
      headers:{'content-type':'application/json','x-csrf-token':B.csrf||''},
      body: JSON.stringify(body) })
      .then(function(res){ return res.text().then(function(text){
        var out; try { out = JSON.parse(text); } catch(e){
          return { ok:false, message:'HTTP '+res.status+' · 响应为空（服务可能正在重启）' };
        }
        return out;
      }); })
      .catch(function(e){ return { ok:false, message:'网络错误：'+e }; });
  }

  /* Logout is a state change, so it is a POST carrying the CSRF secret — the
     same door every other write goes through, not an <a href> any page could
     trigger with an <img>. */
  var lo = document.getElementById('logout');
  if (lo) lo.addEventListener('click', function(){
    post('/logout', {}).then(function(){ location.href = '/login'; });
  });

  function bootFrame(){
    port.postMessage({
      t: 'boot',
      page: B.page,
      view: B.view,
      rev: B.rev,
      /* Discovery data only. The handle and the CSRF secret stay here. */
      allowed: B.allowedMap,
      specs: B.specs,
      viewer: { username: B.viewer.username, admin: B.viewer.admin }
    });
  }

  /* Proposals. Note what is NOT read from the message: app, scope, instance,
     user. The Host substitutes its own binding for every one of them. */
  var handlers = {
    act: function(m){
      return post('/api/act', { instance: B.instance, action: String(m.action||''), params: m.params||{} })
        .then(function(out){ return { ok: !!out.ok, reply: out.reply, message: out.message||out.code }; });
    },
    agentSend: function(m){
      return post('/api/agent/send', { instance: B.instance, agent: String(m.agent||''), text: String(m.text||'') })
        .then(function(out){ return { ok: !!out.ok, message: out.message }; });
    },
    agentConfig: function(m){
      return post('/api/agent/config', { instance: B.instance, agent: String(m.agent||''),
        adapter: m.adapter, model: m.model, effort: m.effort })
        .then(function(out){ return { ok: !!out.ok, message: out.message }; });
    },
    agentPoll: function(m){
      var agent = String(m.agent||'');
      function tick(){
        fetch('/api/agent/transcript?instance='+encodeURIComponent(B.instance)+'&agent='+encodeURIComponent(agent))
          .then(function(r){ return r.json(); })
          .then(function(out){ if(out.ok) port.postMessage({ t:'transcript', agent: agent, data: out }); })
          .catch(function(){})
          .then(function(){ setTimeout(tick, 3000); });
      }
      tick();
      return Promise.resolve({ ok: true });
    }
  };

  port.onmessage = function(ev){
    var m = ev.data;
    if(!m || typeof m !== 'object') return;
    if(m.t === 'ready'){ if(!booted){ booted = true; bootFrame(); } return; }
    if(m.t === 'height'){
      var px = Number(m.px);
      if(isFinite(px) && px > 0) frame.style.height = Math.min(20000, px + 8) + 'px';
      return;
    }
    var fn = Object.prototype.hasOwnProperty.call(handlers, m.t) ? handlers[m.t] : null;
    if(!fn) return;
    Promise.resolve(fn(m)).then(function(out){
      if(m.rid) port.postMessage(Object.assign({ t:'result', rid: m.rid }, out));
      if(out && out.ok === false && out.message) toast('✖ ' + out.message, false);
    });
  };
  port.start();

  /* Hand the port to the frame we created, once, after it announces itself.
     targetOrigin is "*" because a sandboxed frame has an opaque origin; the
     payload is a port and nothing else, and we verify the source window. */
  window.addEventListener('message', function(ev){
    if(ev.source !== frame.contentWindow) return;
    if(ev.data !== 'view-frame-ready') return;
    frame.contentWindow.postMessage({ t:'port' }, '*', [chan.port2]);
  });

  /* Live truth still flows through the Host, which forwards a data-only view. */
  var es = new EventSource('/api/sse?instance='+encodeURIComponent(B.instance));
  es.onmessage = function(ev){
    var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
    if(m.reload){ location.reload(); return; }
    if(m.rev !== undefined){ B.rev = m.rev; B.view = m.view; port.postMessage({ t:'view', view: m.view, rev: m.rev }); }
  };
})();
`;
