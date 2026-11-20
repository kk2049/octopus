/**
 * /factory — the visual dissection & assembly bench. Hand-written page (the
 * 80/20 ruling: interaction density this high stays artisanal), admin-only.
 *
 * What it shows is nothing but the manifest, drawn: pages→columns→slots,
 * actions with their three faces, agents with prompts and runtime config,
 * declared flows. What it edits goes through /api/factory/save, which
 * validates YAML against the real loader before a byte lands — the bench
 * cannot save a page the engine would refuse.
 */

import { csrfCookieCandidates } from "@claude-bot/web-trust";
import { CLIENT_CSS } from "../cards/client.js";
import { COOKIE_BASE } from "./security.js";

const FACTORY_CSS = `
#wrap { display:grid; grid-template-columns: 190px 1fr 330px; gap:12px; padding:12px 16px; align-items:start; }
#palette, #inspect { position:sticky; top:56px; max-height:calc(100vh - 70px); overflow-y:auto; }
.pal-chip { border:1px solid var(--line); background:var(--card); border-radius:10px; padding:7px 10px;
  margin-bottom:8px; cursor:grab; font-size:13px; transition:transform .15s, box-shadow .15s; }
.pal-chip:hover { transform:translateX(3px); box-shadow:0 2px 10px rgba(0,0,0,.15); }
.pal-chip small { display:block; color:var(--mut); font-size:11px; }
#canvas { position:relative; min-width:0; }
#linkline { position:absolute; inset:0; pointer-events:none; z-index:1; }
.fsec { font-size:12px; color:var(--mut); text-transform:uppercase; letter-spacing:.6px; margin:18px 0 8px; }
.fpage { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px; margin-bottom:14px; position:relative; z-index:2; }
.fpage-head { display:flex; gap:10px; align-items:center; margin-bottom:8px; }
.fpage-head b { font-size:14px; }
.fpage-head .sub { color:var(--mut); font-size:12px; }
.fcols { display:flex; gap:10px; align-items:flex-start; overflow-x:auto; padding-bottom:4px; }
.fcol { flex:1 1 0; min-width:130px; border:1.5px dashed var(--line); border-radius:10px; padding:8px;
  display:flex; flex-direction:column; gap:8px; transition:border-color .15s, background .15s, padding .2s cubic-bezier(.2,1.4,.4,1); }
.fcol.maghot { border-color:var(--acc); background:rgba(59,91,219,.07); padding:14px 8px; }
.slotchip { border:1px solid var(--line); background:var(--bg); border-radius:9px; padding:6px 9px; cursor:grab;
  font-size:12.5px; position:relative; z-index:2; will-change:transform; }
.slotchip.dragging { opacity:.4; }
.slotchip b { display:block; }
.slotchip small { color:var(--mut); word-break:break-all; }
.slotchip.selected { outline:2px solid var(--acc); }
.actrow, .agrow { display:flex; gap:10px; flex-wrap:wrap; position:relative; z-index:2; }
.actchip { border:1px solid var(--line); background:var(--card); border-radius:10px; padding:7px 11px; font-size:13px; cursor:pointer; }
.actchip .faces { color:var(--mut); font-size:12px; margin-left:6px; }
.actchip.selected { outline:2px solid var(--acc); }
.agcard { border:1px solid var(--line); background:var(--card); border-radius:12px; padding:10px 12px; min-width:250px; font-size:13px; }
.agcard h4 { margin:0 0 6px; }
.agcard .row { display:flex; gap:6px; align-items:center; margin:4px 0; flex-wrap:wrap; }
.agcard label.mcp { display:inline-flex; gap:4px; align-items:center; font-size:12px; border:1px solid var(--line);
  border-radius:99px; padding:2px 8px; cursor:pointer; }
.flowsvg { background:var(--card); border:1px solid var(--line); border-radius:12px; }
#inspect .box { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px; margin-bottom:10px; font-size:13px; }
#inspect textarea { width:100%; font:12px/1.5 ui-monospace,monospace; background:var(--bg); color:var(--fg);
  border:1px solid var(--line); border-radius:8px; padding:8px; }
#inspect input, #inspect select { width:100%; padding:6px 8px; border:1px solid var(--line); border-radius:8px;
  background:var(--bg); color:var(--fg); font:inherit; margin:2px 0 8px; }
#inspect label { font-size:12px; color:var(--mut); }
.problems { color:var(--err); white-space:pre-wrap; font-size:12px; }
#sidechat { width:100%; height:46vh; border:1px solid var(--line); border-radius:12px; background:var(--card); }
.dirtydot { width:8px; height:8px; border-radius:50%; background:var(--warn); display:inline-block; }
@keyframes landed { 0%{transform:scale(1.12)} 55%{transform:scale(.97)} 100%{transform:scale(1)} }
.slotchip.landed { animation:landed .38s cubic-bezier(.2,1.4,.4,1); }
`;

/**
 * The CSRF cookie names this page may look for, in the two deployment orders.
 * Emitted as data so the page never hard-codes a spelling of its own.
 */
const CSRF_NAME_JS =
  `var CSRF_NAMES_HTTPS = ${JSON.stringify(csrfCookieCandidates(COOKIE_BASE, true))};\n`
  + `  var CSRF_NAMES_HTTP = ${JSON.stringify(csrfCookieCandidates(COOKIE_BASE, false))};`;

export const FACTORY_JS = `
(function(){
  ${CSRF_NAME_JS}
  var S = { data:null, app:null, dirty:{}, sel:null, links:[] };
  /* Double-submit half of the CSRF pair; the session id itself is HttpOnly.

     The NAME is a deployment fact: an https Host issues __Host-v3csrf, a plain
     one issues v3csrf. Both spellings come from the same module the server asks
     (csrfCookieCandidates over COOKIE_BASE) and the order is the server's own
     rule — the prefix requires Secure, Secure requires https. Hard-coding one
     name is how this page silently stopped sending the header (every mutation
     403) the moment the server moved to the prefix. Split-and-compare instead
     of a built regex so there is no escaping question. */
  var CSRF_NAMES = location.protocol === 'https:' ? CSRF_NAMES_HTTPS : CSRF_NAMES_HTTP;
  function csrf(){
    var parts = (document.cookie||'').split(';');
    for (var n = 0; n < CSRF_NAMES.length; n++) {
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        if (eq < 0) continue;
        if (parts[i].slice(0, eq).trim() !== CSRF_NAMES[n]) continue;
        try { return decodeURIComponent(parts[i].slice(eq + 1).trim()); }
        catch (e) { return parts[i].slice(eq + 1).trim(); }
      }
    }
    return '';
  }
  function $(s,el){ return (el||document).querySelector(s); }
  function all(s,el){ return Array.prototype.slice.call((el||document).querySelectorAll(s)); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function toast(msg, ok){
    var box = $('#toast'), d = document.createElement('div');
    if(!ok) d.className='bad'; d.textContent=msg; box.appendChild(d); setTimeout(function(){ d.remove(); }, 5000);
  }
  var ICON = { list:'📋', form:'📝', actions:'🔘', markdown:'📄', kv:'📇', timeline:'📅', banner:'🚧',
    heading:'🔠', section:'🗂', 'agent-chat':'🤖', docedit:'✍', table:'🧮' };

  function cur(){ var a=null; (S.data.apps||[]).forEach(function(x){ if(x.app===S.app) a=x; }); return a; }
  function pageDef(name){
    if(!S.dirty[S.app]) S.dirty[S.app]={};
    if(!S.dirty[S.app][name]) S.dirty[S.app][name] = JSON.parse(JSON.stringify(cur().pages[name]));
    return S.dirty[S.app][name];
  }
  function isDirty(name){ return !!(S.dirty[S.app]&&S.dirty[S.app][name]&&S.dirty[S.app][name].__dirty); }
  function markDirty(name){ pageDef(name).__dirty = true; }

  // ── YAML emit: structure in YAML, nodes as JSON (valid YAML; hand-beautify later) ──
  function yamlPage(def){
    var L = [];
    if(def.title) L.push('title: '+JSON.stringify(def.title));
    if(def.locals && Object.keys(def.locals).length) L.push('locals: '+JSON.stringify(def.locals));
    L.push('layout:');
    def.layout.forEach(function(col){ L.push('  - '+JSON.stringify(col)); });
    if(def.widths && def.widths.length) L.push('widths: '+JSON.stringify(def.widths));
    L.push('slots:');
    Object.keys(def.slots).forEach(function(name){
      L.push('  '+name+': '+JSON.stringify(def.slots[name]));
    });
    return L.join('\\n')+'\\n';
  }

  // ── render ──
  function slotChip(pageName, slot, node){
    var refs = actionRefs(node);
    return '<div class="slotchip" draggable="true" id="chip-'+pageName+'-'+slot+'" data-page="'+pageName+'" data-slot="'+slot+'"'
      + (refs.length?' data-acts="'+refs.join(',')+'"':'')+'>'
      + '<b>'+(ICON[node.widget]||'▫')+' '+esc(slot)+'</b>'
      + '<small>'+esc(node.widget)+(node.bind?(' · '+node.bind):'')+(node.agent?(' · @'+node.agent):'')+'</small></div>';
  }
  function actionRefs(node){
    var out = [];
    if(node.props&&node.props.action) out.push(node.props.action);
    ((node.props&&node.props.items)||[]).forEach(function(it){ if(it.action) out.push(it.action); });
    Object.keys(node.on||{}).forEach(function(ev){
      var t = node.on[ev]; if(t&&t.indexOf('action:')===0) out.push(t.slice(7));
    });
    (node.children||[]).forEach(function(c){ out = out.concat(actionRefs(c)); });
    return out;
  }
  function pagesHtml(a){
    return Object.keys(a.pages).map(function(pn){
      var def = (S.dirty[S.app]&&S.dirty[S.app][pn]) || a.pages[pn];
      var cols = def.layout.map(function(col, ci){
        return '<div class="fcol" data-ci="'+ci+'" data-pg="'+pn+'">'
          + col.map(function(s){ return def.slots[s]?slotChip(pn, s, def.slots[s]):''; }).join('')
          + '<div class="sub" style="text-align:center;font-size:11px">拖组件到这</div></div>';
      }).join('');
      return '<div class="fpage" data-pg="'+pn+'"><div class="fpage-head">'
        + '<b>页面 '+esc(pn)+'</b><span class="sub">'+esc(def.title||'')+'</span>'
        + ((a.feishuCards||[]).indexOf(pn)>=0?'<span class="chip">🃏 卡片档</span>':'')
        + (isDirty(pn)?'<span class="dirtydot"></span><button class="btn primary mini savepg" data-pg="'+pn+'">保存</button>':'')
        + '<span style="flex:1"></span><a class="sub" href="/a/'+S.app+'/'+pn+'" target="_blank">打开 ↗</a></div>'
        + '<div class="fcols">'+cols+'<button class="btn mini addcol" data-pg="'+pn+'">＋列</button></div></div>';
    }).join('') || '<div class="sub">（这个应用没有页面）</div>';
  }
  function facesOf(a, name){
    var spec = a.actions[name], refs = 0;
    Object.keys(a.pages).forEach(function(pn){
      var def = a.pages[pn];
      Object.keys(def.slots).forEach(function(s){ if(actionRefs(def.slots[s]).indexOf(name)>=0) refs++; });
    });
    var f = [];
    f.push(refs ? ('🖱×'+refs) : '🖱–');
    f.push(spec.humanOnly ? '🚫🤖' : '🤖');
    if(spec.feishu) f.push('🃏');
    return f.join(' ');
  }
  function actionsHtml(a){
    var names = Object.keys(a.actions);
    if(!names.length) return '<div class="fsec">动作</div><div class="sub">（无——这个应用只读）</div>';
    return '<div class="fsec">动作 · 一次声明，三个面（🖱 按钮 · 🤖 agent 工具 · 🃏 飞书卡）</div><div class="actrow">'
      + names.map(function(n){
        var s = a.actions[n];
        var lock = s.predicate==='owner'?'🔒':s.predicate==='admin'?'🛡':'🌐';
        return '<div class="actchip" id="act-'+n+'" data-act="'+n+'">'+lock+' <b>'+esc(s.title||n)+'</b>'
          + '<span class="faces">'+facesOf(a,n)+(s.confirm?' ⚠':'')+'</span></div>';
      }).join('')+'</div>';
  }
  function agentsHtml(a){
    var names = Object.keys(a.agents||{});
    if(!names.length) return '';
    return '<div class="fsec">Agents（底层实现 / 模型 / 提示词 / 特殊 MCP）</div><div class="agrow">'
      + names.map(function(n){
        var g = a.agents[n];
        return '<div class="agcard" data-agent="'+n+'"><h4>🤖 '+esc(n)+'</h4>'
          + '<div class="row">声明 adapter：<span class="chip">'+esc(g.adapter)+'</span>'
          + '<span class="chip runchip" data-agent="'+n+'">运行时：…</span></div>'
          + (g.prompt?('<div class="row">prompt：<a href="#" class="editprompt" data-agent="'+n+'" data-file="'+esc(g.prompt)+'">'+esc(g.prompt)+' ✎</a></div>'):'')
          + '<div class="row mcps" data-agent="'+n+'">MCP：'
          + (S.data.mcpCatalog||[]).map(function(m){
              return '<label class="mcp"><input type="checkbox" value="'+esc(m)+'" disabled> '+esc(m)+'</label>';
            }).join('')+(S.data.mcpCatalog&&S.data.mcpCatalog.length?'':'<span class="sub">（目录为空）</span>')+'</div>'
          + '<div class="row"><button class="btn mini savemcp" data-agent="'+n+'">保存 MCP 授予</button>'
          + '<span class="sub">仅 CLI 面生效</span></div></div>';
      }).join('')+'</div>';
  }
  function flowsHtml(a){
    if(!(a.flows||[]).length) return '';
    return '<div class="fsec">状态机（flows · 声明式描述）</div>'
      + a.flows.map(function(f){
        var W = Math.max(560, 130*f.states.length), H = 150;
        var pos = {};
        f.states.forEach(function(s,i){ pos[s] = { x: 70+i*((W-140)/Math.max(1,f.states.length-1)), y: 95 }; });
        var nodes = f.states.map(function(s){
          var p = pos[s];
          return '<circle cx="'+p.x+'" cy="'+p.y+'" r="24" fill="none" stroke="var(--acc)" stroke-width="1.5"/>'
            + '<text x="'+p.x+'" y="'+(p.y+4)+'" text-anchor="middle" font-size="11" fill="var(--fg)">'+esc(s)+'</text>';
        }).join('');
        var edges = f.transitions.map(function(t,i){
          var A = pos[t.from], B = pos[t.to];
          var lift = (t.from===t.to)?-58:(-34 - (i%3)*16) * (A.x<=B.x?1:-1.4);
          var mx = (A.x+B.x)/2, my = A.y + lift;
          return '<path d="M '+A.x+' '+(A.y-24)+' Q '+mx+' '+my+' '+B.x+' '+(B.y-24)+'" fill="none" stroke="var(--mut)" marker-end="url(#arr)"/>'
            + '<text x="'+mx+'" y="'+(my+((lift<0)?-4:14))+'" text-anchor="middle" font-size="10" fill="var(--mut)">'+esc(t.via)+'</text>';
        }).join('');
        return '<div style="overflow-x:auto"><svg class="flowsvg" width="'+W+'" height="'+H+'">'
          + '<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">'
          + '<path d="M 0 0 L 8 4 L 0 8 z" fill="var(--mut)"/></marker></defs>'
          + '<text x="12" y="20" font-size="12" fill="var(--mut)">'+esc(f.name)+'</text>'+edges+nodes+'</svg></div>';
      }).join('');
  }

  function renderAll(withFlip){
    var a = cur(); if(!a) return;
    var canvas = $('#canvas');
    var before = withFlip ? snapRects() : null;
    canvas.innerHTML = '<svg id="linkline"></svg>'
      + '<div class="fsec">页面 · 布局与组件（拖动组装）</div>' + pagesHtml(a)
      + actionsHtml(a) + agentsHtml(a) + flowsHtml(a);
    wireCanvas();
    if(before) flipFrom(before);
    loadAgentRuntimes(a);
    requestAnimationFrame(drawLinks);
  }
  function snapRects(){
    var m = {};
    all('.slotchip').forEach(function(el){ m[el.id] = el.getBoundingClientRect(); });
    return m;
  }
  function flipFrom(before){
    all('.slotchip').forEach(function(el){
      var b = before[el.id]; if(!b) { el.classList.add('landed'); return; }
      var n = el.getBoundingClientRect();
      var dx = b.left-n.left, dy = b.top-n.top;
      if(!dx && !dy) return;
      el.style.transition='none'; el.style.transform='translate('+dx+'px,'+dy+'px)';
      requestAnimationFrame(function(){
        el.style.transition='transform .38s cubic-bezier(.2,1.4,.4,1)';
        el.style.transform='';
      });
    });
  }
  function drawLinks(){
    var svg = $('#linkline'); if(!svg) return;
    var canvas = $('#canvas');
    svg.setAttribute('width', canvas.scrollWidth); svg.setAttribute('height', canvas.scrollHeight);
    var cb = canvas.getBoundingClientRect();
    var paths = [];
    all('.slotchip[data-acts]').forEach(function(chip){
      chip.dataset.acts.split(',').forEach(function(actName){
        var act = $('#act-'+CSS.escape(actName)); if(!act) return;
        var r1 = chip.getBoundingClientRect(), r2 = act.getBoundingClientRect();
        var x1 = r1.left+r1.width/2-cb.left, y1 = r1.bottom-cb.top;
        var x2 = r2.left+r2.width/2-cb.left, y2 = r2.top-cb.top;
        paths.push('<path d="M '+x1+' '+y1+' C '+x1+' '+(y1+50)+', '+x2+' '+(y2-50)+', '+x2+' '+y2+'"'
          + ' fill="none" stroke="rgba(59,91,219,.45)" stroke-width="1.5"/>');
      });
    });
    svg.innerHTML = paths.join('');
  }

  // ── interactions ──
  var dragInfo = null;
  function wireCanvas(){
    all('.slotchip').forEach(function(chip){
      chip.addEventListener('dragstart', function(){
        dragInfo = { type:'move', page: chip.dataset.page, slot: chip.dataset.slot };
        chip.classList.add('dragging');
      });
      chip.addEventListener('dragend', function(){ chip.classList.remove('dragging'); });
      chip.onclick = function(){ selectSlot(chip.dataset.page, chip.dataset.slot); };
    });
    all('.fcol').forEach(function(col){
      col.addEventListener('dragover', function(ev){ ev.preventDefault(); col.classList.add('maghot'); });
      col.addEventListener('dragleave', function(){ col.classList.remove('maghot'); });
      col.addEventListener('drop', function(ev){
        ev.preventDefault(); col.classList.remove('maghot');
        onDrop(col.dataset.pg, Number(col.dataset.ci));
      });
    });
    all('.addcol').forEach(function(b){ b.onclick = function(){
      var def = pageDef(b.dataset.pg); def.layout.push([]); if(def.widths) def.widths.push(1);
      markDirty(b.dataset.pg); renderAll(true);
    };});
    all('.savepg').forEach(function(b){ b.onclick = function(){ savePage(b.dataset.pg); }; });
    all('.actchip').forEach(function(c){ c.onclick = function(){ selectAction(c.dataset.act); }; });
    all('.editprompt').forEach(function(aEl){ aEl.onclick = function(ev){ ev.preventDefault(); editPrompt(aEl.dataset.file); }; });
    all('.savemcp').forEach(function(b){ b.onclick = function(){ saveMcp(b.dataset.agent, b.closest('.agcard')); }; });
  }
  function onDrop(pg, ci){
    var def = pageDef(pg);
    if(dragInfo && dragInfo.type==='new'){
      var base = 'w', n = 1; while(def.slots[base+n]) n++;
      var name = base+n;
      def.slots[name] = { widget: dragInfo.widget, bind: '' };
      if(dragInfo.widget==='section') def.slots[name] = { widget:'section', props:{title:'新区块'}, children:[{widget:'markdown', bind:''}] };
      def.layout[ci].push(name);
      markDirty(pg); renderAll(true); selectSlot(pg, name);
    } else if(dragInfo && dragInfo.type==='move' && dragInfo.page===pg){
      def.layout = def.layout.map(function(col){ return col.filter(function(s){ return s!==dragInfo.slot; }); });
      def.layout[ci].push(dragInfo.slot);
      markDirty(pg); renderAll(true);
    }
    dragInfo = null;
  }
  function selectSlot(pg, slot){
    all('.slotchip').forEach(function(c){ c.classList.toggle('selected', c.dataset.page===pg&&c.dataset.slot===slot); });
    var def = pageDef(pg), node = def.slots[slot];
    var box = $('#inspect .box.sel');
    box.innerHTML = '<b>槽位 '+esc(slot)+'</b>（页面 '+esc(pg)+'）'
      + '<label>组件</label><select id="i_w">'+Object.keys(S.data.widgets).map(function(w){
          return '<option'+(w===node.widget?' selected':'')+'>'+w+'</option>'; }).join('')+'</select>'
      + '<label>bind（view.… 可含 $local）</label><input id="i_b" value="'+esc(node.bind||'')+'">'
      + '<label>props（JSON）</label><textarea id="i_p" rows="4">'+esc(JSON.stringify(node.props||{},null,1))+'</textarea>'
      + '<label>on.select（action:x / local:key，可空）</label><input id="i_s" value="'+esc((node.on&&node.on.select)||'')+'">'
      + (node.widget==='agent-chat'?('<label>agent</label><input id="i_a" value="'+esc(node.agent||'')+'">'):'')
      + (node.children?('<label>children（JSON）</label><textarea id="i_c" rows="5">'+esc(JSON.stringify(node.children,null,1))+'</textarea>'):'')
      + '<div class="btnrow"><button class="btn primary" id="i_apply">应用</button>'
      + '<button class="btn" id="i_del">删除槽位</button></div>'
      + '<div class="sub">应用只改工作副本；点页面卡上的「保存」才落盘（会先过 loader 校验）。</div>';
    $('#i_apply').onclick = function(){
      try {
        node.widget = $('#i_w').value;
        node.bind = $('#i_b').value || undefined;
        node.props = JSON.parse($('#i_p').value||'{}');
        var sv = $('#i_s').value.trim();
        node.on = sv ? { select: sv } : undefined;
        if($('#i_a')) node.agent = $('#i_a').value||undefined;
        if($('#i_c')) node.children = JSON.parse($('#i_c').value);
        if(!node.bind) delete node.bind; if(!node.on) delete node.on;
        if(node.props && !Object.keys(node.props).length) delete node.props;
        markDirty(pg); renderAll(true); selectSlot(pg, slot);
      } catch(e){ toast('JSON 解析失败：'+e, false); }
    };
    $('#i_del').onclick = function(){
      delete def.slots[slot];
      def.layout = def.layout.map(function(col){ return col.filter(function(s){ return s!==slot; }); });
      markDirty(pg); renderAll(true);
    };
  }
  function selectAction(name){
    all('.actchip').forEach(function(c){ c.classList.toggle('selected', c.dataset.act===name); });
    var a = cur(), s = a.actions[name];
    var src = a.files['actions.ts']||'';
    var m = src.split('export function '+name)[1]||'';
    var types = []; var re = /type:\\s*"([\\w-]+)"/g, mm;
    var body = m.split('export function')[0]||'';
    while((mm=re.exec(body))) if(types.indexOf(mm[1])<0) types.push(mm[1]);
    $('#inspect .box.sel').innerHTML = '<b>动作 '+esc(name)+'</b>'
      + '<div class="sub">谓词 '+s.predicate+(s.humanOnly?' · human_only（agent 面被拆除）':'')+(s.confirm?' · 需确认':'')+'</div>'
      + '<div style="margin:6px 0"><b>参数</b><br>'+Object.keys(s.params||{}).map(function(k){
          var p = s.params[k];
          return '· '+k+'：'+p.type+(p.required?'（必填）':'')+(p.enum?(' ∈ '+p.enum.join('/')):'')
            +(p.enumBind?(' ⇐ '+p.enumBind):'');
        }).join('<br>')+'</div>'
      + '<div><b>handler 落的事件</b>：'+(types.join('、')||'（未静态识别到）')+'</div>'
      + '<div class="sub" style="margin-top:6px">同一份声明 = 页面按钮 + HTTP + agent 工具；连线是引用它的槽位。</div>';
  }
  function editPrompt(file){
    var a = cur(); var content = a.files[file]||'';
    var box = $('#inspect .box.sel');
    box.innerHTML = '<b>✎ '+esc(file)+'</b>'
      + '<textarea id="pr_t" rows="16">'+esc(content)+'</textarea>'
      + '<div class="btnrow"><button class="btn primary" id="pr_save">保存 prompt</button></div>'
      + '<div class="sub">保存立即生效（agent 每轮重读 prompt 文件）。</div><div class="problems" id="pr_err"></div>';
    $('#pr_save').onclick = function(){
      saveFile(file, $('#pr_t').value, function(){ a.files[file] = $('#pr_t').value; });
    };
  }
  function loadAgentRuntimes(a){
    Object.keys(a.agents||{}).forEach(function(n){
      var scope = a.scope==='shared'?'shared':BOOT.username;
      fetch('/api/agent/transcript?app='+S.app+'&scope='+scope+'&agent='+n)
        .then(function(r){ return r.json(); }).then(function(o){
          if(!o.ok) return;
          var chip = $('.runchip[data-agent="'+n+'"]');
          if(chip) chip.textContent = '运行时：'+(o.adapter||'?')+(o.model?(' · '+o.model):'')+(o.effort?(' · '+o.effort):'')+(o.adapterReady===false?' ⚠未接入':'');
          var mcpbox = $('.mcps[data-agent="'+n+'"]');
          if(mcpbox) all('input', mcpbox).forEach(function(cb){
            cb.disabled = false;
            cb.checked = (o.mcp||[]).indexOf(cb.value)>=0;
          });
        }).catch(function(){});
    });
  }
  function saveMcp(agent, card){
    var a = cur(); var scope = a.scope==='shared'?'shared':BOOT.username;
    var mcp = all('.mcps input', card).filter(function(c){ return c.checked; }).map(function(c){ return c.value; });
    fetch('/api/agent/config', { method:'POST', headers:{'content-type':'application/json','x-csrf-token':csrf()},
      body: JSON.stringify({ app:S.app, scope:scope, agent:agent, mcp:mcp })
    }).then(function(r){ return r.json(); }).then(function(o){
      if(o.ok) toast('✓ '+agent+' 的 MCP 授予已更新（下一轮生效）', true);
      else toast('✖ '+(o.message||''), false);
    });
  }
  function saveFile(file, content, onOk){
    fetch('/api/factory/save', { method:'POST', headers:{'content-type':'application/json','x-csrf-token':csrf()},
      body: JSON.stringify({ app:S.app, file:file, content:content })
    }).then(function(r){ return r.json().then(function(o){ return {st:r.status, o:o}; }); })
    .then(function(res){
      if(res.o.ok){ toast('✓ 已保存 '+file, true); if(onOk) onOk(); }
      else {
        toast('✖ 保存被校验拒绝', false);
        var pe = $('#pr_err')||$('#inspect .box.sel');
        var div = document.createElement('div'); div.className='problems';
        div.textContent = res.o.problems || res.o.message || ('HTTP '+res.st);
        pe.appendChild(div);
      }
    }).catch(function(e){ toast('网络错误：'+e, false); });
  }
  function savePage(pn){
    var def = pageDef(pn);
    var clean = JSON.parse(JSON.stringify(def)); delete clean.__dirty; delete clean.name;
    saveFile('pages/'+pn+'.yaml', yamlPage(clean), function(){
      delete S.dirty[S.app][pn];
      load(); // re-fetch manifests so the anatomy matches disk truth
    });
  }
  function selectApp(app){ S.app = app; S.sel=null; renderAll(false); }
  function fillPalette(){
    $('.pal-chips').innerHTML = Object.keys(S.data.widgets).map(function(w){
      var def = S.data.widgets[w];
      return '<div class="pal-chip" draggable="true" data-w="'+w+'">'+(ICON[w]||'▫')+' <b>'+w+'</b>'
        + (def.cardGrade?'':' <span class="chip">富·仅网页</span>')
        + '<small>'+esc(String(def.description||'').slice(0,64))+'…</small></div>';
    }).join('');
    all('.pal-chip').forEach(function(chip){
      chip.addEventListener('dragstart', function(){ dragInfo = { type:'new', widget: chip.dataset.w }; });
    });
  }
  function load(){
    return fetch('/api/factory/apps').then(function(r){ return r.json(); }).then(function(d){
      if(!d.ok){ toast('✖ '+(d.message||''), false); return; }
      S.data = d;
      fillPalette();
      var sel = $('#apppick');
      sel.innerHTML = d.apps.map(function(a){
        return '<option value="'+a.app+'"'+(a.app===S.app?' selected':'')+'>'+esc(a.title)+'（'+a.app+'）</option>'; }).join('');
      if(!S.app && d.apps.length) S.app = d.apps[0].app;
      renderAll(false);
    });
  }
  $('#apppick').onchange = function(){ selectApp(this.value); };
  window.addEventListener('resize', drawLinks);
  $('#canvas').addEventListener('scroll', drawLinks, true);
  load();
})();
`;

export function factoryPage(boot: { username: string; mcpCatalog: string[] }): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>软件工厂</title><style>${CLIENT_CSS}${FACTORY_CSS}</style>
<div class="topbar"><a class="brand" href="/">🐙</a><span class="brand">🏭 软件工厂</span>
  <select id="apppick" style="padding:4px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)"></select>
  <span class="who">解剖 · 组装 · 授予 —— 保存前都会过 loader 校验</span></div>
<div id="wrap">
  <div id="palette">
    <div class="fsec">组件库（拖入页面列）</div>
    <div class="pal-chips"></div>
  </div>
  <div id="canvas"></div>
  <div id="inspect">
    <div class="box sel"><b>检查器</b><div class="sub">点一个槽位 / 动作 / prompt 链接查看与编辑。</div></div>
    <div class="fsec">建筑师（factory app 的常驻 agent）</div>
    <iframe id="sidechat" src="/a/factory/main"></iframe>
  </div>
</div>
<div id="toast"></div>
<script>window.BOOT = ${JSON.stringify(boot).replace(/</g, "\\u003c")};</script>
<script>${FACTORY_JS}</script>`;
}
