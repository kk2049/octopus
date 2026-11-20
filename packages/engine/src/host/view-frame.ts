/**
 * The Agent View trust domain: a sandboxed iframe with no credentials.
 *
 * The browser trust layer (doc/tcb-reading-guide.md §4) asks for exactly
 * this shape, and the previous pass did not have it — the
 * generated projection was rendered by same-origin script that also held the
 * session cookie, the CSRF secret and the instance handle. One escaping bug
 * there was a full account takeover.
 *
 * Now:
 *   Trusted Host (same origin, has Session + CSRF + instance handle)
 *      |  <iframe sandbox="allow-scripts">      <- opaque origin: its script
 *      |                                         reads no cookie and no DOM
 *      |  MessagePort (transferred once, per instance)
 *      v
 *   Agent View (this file): renders projection data, PROPOSES actions
 *
 * What the View structurally cannot do, by construction rather than by review:
 *   · read a cookie or the CSRF secret — the sandbox gives it an OPAQUE origin,
 *     so `document.cookie` is not merely empty, it throws;
 *   · learn the instance handle — the Host never sends it;
 *   · open an active connection — CSP `connect-src 'none'` blocks fetch, XHR,
 *     WebSocket and EventSource, and it has no ambient credentials anyway;
 *   · navigate the TOP window or open a popup — sandbox grants neither;
 *   · reach the Host DOM — the opaque origin is nobody's same-origin.
 *
 * Two things it CAN do, stated because the previous wording implied otherwise:
 *
 *   · **the initial navigation carries host cookies.** The sandbox applies to
 *     the DOCUMENT, not to the request that fetched it. This frame is served
 *     from this Host's own origin, so that request — and any self-navigation —
 *     goes out with this Host's cookies attached. The document cannot read them
 *     afterwards, but they have already reached the server and any log on the
 *     way. It is same-origin by design here (the route is `/view-frame` on this
 *     Host); Session Plus, which frames genuinely untrusted first-party app
 *     packages, puts its view on a separate HOSTNAME for exactly this reason —
 *     cookies are scoped by host, not by origin and not by port.
 *   · **it can navigate ITSELF.** No sandbox token and no CSP directive
 *     available in Chrome 1.62 removes that (`navigate-to` is unrecognised).
 *     Where it may navigate to is bounded by the embedding page's `frame-src`.
 *
 * Neither weakens this Host's authority gates — every write still needs the
 * session, the CSRF secret and an exact Origin, and the View has none of them —
 * but "no cookies, no navigation" would have been a false sentence, so it is
 * not written here.
 *
 * Its whole vocabulary is the proposal messages below, and the Host decides
 * what any of them mean.
 */

import {
  SANDBOX_ALLOW_SCRIPTS,
  viewFrameHeaders as buildViewFrameHeaders,
} from "@claude-bot/web-trust";
import { VIEW_RUNTIME_JS } from "../cards/view-js.js";
import { CLIENT_CSS } from "../cards/client.js";

export const VIEW_FRAME_JS = `
(function(){
  var PORT = null, BOOT = null, LOCAL = Object.create(null), VIEW = null, RID = 1;
  var pending = Object.create(null);

  function resolve(pathExpr){
    if(!pathExpr) return null;
    var raw = String(pathExpr);
    if(raw.indexOf('local:')===0) return LOCAL[raw.slice(6)];
    var cur = BOOT ? BOOT.view : null, parts = raw === 'view' ? [] : raw.replace(/^view\\./,'').split('.');
    for(var i=0;i<parts.length && cur!=null;i++) cur = cur[parts[i]];
    return cur;
  }

  function build(){
    VIEW = (${VIEW_RUNTIME_JS})({
      allowed: BOOT.allowed, specs: BOOT.specs, locals: LOCAL, resolve: resolve
    });
  }

  function send(msg){ if(PORT) PORT.postMessage(msg); }
  function propose(kind, payload){
    var rid = 'r' + (RID++);
    return new Promise(function(res){ pending[rid] = res; send(Object.assign({ t: kind, rid: rid }, payload)); });
  }

  function toast(text, ok){
    var t = document.getElementById('toast');
    t.textContent = text; t.className = ok ? 'ok' : 'bad'; t.hidden = false;
    setTimeout(function(){ t.hidden = true; }, 3200);
  }

  function reportHeight(){
    send({ t: 'height', px: Math.max(80, document.body.scrollHeight) });
  }

  function wire(el, node){
    Array.prototype.slice.call(el.querySelectorAll('[data-act]')).forEach(function(btn){
      btn.onclick = function(){
        var a = btn.getAttribute('data-act'), spec = BOOT.specs[a] || {};
        var params = {};
        try { params = JSON.parse(btn.getAttribute('data-params')||'{}'); } catch(e){}
        Object.keys(params).forEach(function(k){
          if(typeof params[k]==='string' && params[k].charAt(0)==='$') params[k] = LOCAL[params[k].slice(1)];
        });
        propose('act', { action: a, params: params }).then(function(out){
          toast(out && out.ok ? ('✓ ' + (out.reply||'已执行')) : ('✖ ' + ((out&&out.message)||'失败')), !!(out&&out.ok));
        });
      };
    });
    if(node && node.on && node.on.select){
      var target = node.on.select;
      Array.prototype.slice.call(el.querySelectorAll('[data-sel]')).forEach(function(item){
        item.onclick = function(){
          var v = item.getAttribute('data-sel');
          if(target.indexOf('local:')===0){ LOCAL[target.slice(6)] = v; build(); render(); }
          else propose('act', { action: target.slice(7), params: { id: v } });
        };
      });
    }
    Array.prototype.slice.call(el.querySelectorAll('form[data-form]')).forEach(function(f){
      f.onsubmit = function(ev){
        ev.preventDefault();
        var action = f.getAttribute('data-form'), spec = BOOT.specs[action] || {}, params = {};
        Object.keys(spec.params||{}).forEach(function(name){
          var input = f.querySelector('[name="'+CSS.escape(name)+'"]'); if(!input) return;
          if(input.type==='checkbox'){ params[name] = input.checked; return; }
          var v = input.value; if(v==='') return;
          if((spec.params[name]||{}).type==='object'){ try { v = JSON.parse(v); } catch(e){} }
          params[name] = v;
        });
        propose('act', { action: action, params: params }).then(function(out){
          toast(out && out.ok ? ('✓ ' + (out.reply||'已执行')) : ('✖ ' + ((out&&out.message)||'失败')), !!(out&&out.ok));
          if(out && out.ok) f.reset();
        });
      };
    });
    Array.prototype.slice.call(el.querySelectorAll('.chat')).forEach(initChat);
  }

  function initChat(chat){
    if(chat.getAttribute('data-wired')) return;
    chat.setAttribute('data-wired','1');
    var agent = chat.getAttribute('data-agent');
    var logEl = chat.querySelector('.chatlog'), st = chat.querySelector('.chatstatus'),
        ta = chat.querySelector('textarea'), adchip = chat.querySelector('.adchip');
    function paint(data){
      if(!data) return;
      var ents = (data.rich && data.rich.entries) || (data.messages||[]).map(function(m){
        return { kind: m.role==='tool'?'tool':m.role, text: m.text, action: m.action }; });
      logEl.innerHTML = ents.map(VIEW.entryHtml).join('') || '<div class="sub">（还没有对话）</div>';
      wire(logEl, {});
      logEl.scrollTop = logEl.scrollHeight;
      st.textContent = data.running ? '⏳ agent 运行中' : '';
      adchip.textContent = (data.adapter||'?') + (data.model ? (' · '+data.model) : '');
      reportHeight();
    }
    chat.querySelector('.send').onclick = function(){
      var text = ta.value.trim(); if(!text) return;
      ta.value = '';
      propose('agentSend', { agent: agent, text: text });
    };
    ta.onkeydown = function(ev){ if((ev.ctrlKey||ev.metaKey) && ev.key==='Enter') chat.querySelector('.send').onclick(); };
    chat.__paint = paint;
    propose('agentPoll', { agent: agent });
  }

  function render(){
    var root = document.getElementById('cols');
    root.innerHTML = '';
    (BOOT.page.layout||[]).forEach(function(column, i){
      var col = document.createElement('div');
      col.className = 'col';
      col.style.flexGrow = String((BOOT.page.widths||[])[i] || 1);
      column.forEach(function(name){
        var node = BOOT.page.slots[name];
        if(!node) return;
        var slot = document.createElement('div');
        slot.className = 'slot';
        slot.innerHTML = VIEW.nodeHtml(node);
        wire(slot, node);
        col.appendChild(slot);
      });
      root.appendChild(col);
    });
    reportHeight();
  }

  function onMessage(msg){
    if(!msg || typeof msg !== 'object') return;
    if(msg.t === 'boot'){ BOOT = msg; LOCAL = Object.create(null); build(); render(); return; }
    if(msg.t === 'view'){ if(!BOOT) return; BOOT.view = msg.view; build(); render(); return; }
    if(msg.t === 'result'){ var f = pending[msg.rid]; if(f){ delete pending[msg.rid]; f(msg); } return; }
    if(msg.t === 'transcript'){
      var chat = document.querySelector('.chat[data-agent="' + CSS.escape(String(msg.agent)) + '"]');
      if(chat && chat.__paint) chat.__paint(msg.data);
      return;
    }
  }

  /* The parent hands us exactly one port. We ignore every other message, and
     we never postMessage to window.parent again — the port IS the channel. */
  window.addEventListener('message', function(ev){
    if(PORT || !ev.ports || !ev.ports.length) return;
    PORT = ev.ports[0];
    PORT.onmessage = function(e){ onMessage(e.data); };
    PORT.start();
    send({ t: 'ready' });
  });
  window.parent.postMessage('view-frame-ready', '*');
})();
`;

/**
 * The frame document. CSP is the second half of the boundary: even with the
 * sandbox attribute the frame must not be able to open a network connection,
 * load a remote script, or be framed by anyone but us.
 */
export function viewFrameHtml(nonce: string): string {
  return `<!doctype html><meta charset="utf-8">
<title>view</title>
<style nonce="${nonce}">${CLIENT_CSS}
body { margin:0; padding:0; background:transparent; }
#toast { position:fixed; left:12px; bottom:12px; padding:8px 12px; border-radius:8px; font-size:13px;
         background:#333; color:#fff; z-index:9 }
#toast.bad { background:#b03030 }
#toast.ok { background:#1e824c }
</style>
<div id="cols"></div>
<div id="toast" hidden></div>
<script nonce="${nonce}">${VIEW_FRAME_JS}</script>`;
}

/**
 * Header set for the frame document. Mirrored in tests.
 *
 * The policy itself lives in `@claude-bot/web-trust` because Session Plus
 * serves a view document too, from a different origin — one decision, two
 * deployments. This Host's view is same-origin, so its ancestors are `'self'`;
 * that argument is the only difference between the two.
 */
export function viewFrameHeaders(nonce: string): Record<string, string> {
  return buildViewFrameHeaders({ nonce, frameAncestors: ["'self'"] });
}

/** The sandbox token set. Deliberately minimal: scripts, nothing else. */
export const VIEW_FRAME_SANDBOX = SANDBOX_ALLOW_SCRIPTS;
