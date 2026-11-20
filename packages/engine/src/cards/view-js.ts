/**
 * The untrusted view runtime: projection data -> HTML strings.
 *
 * Everything in here consumes data an app (and therefore an agent) authored,
 * so it is the one place where an escaping mistake becomes stored XSS. Two
 * defences, both required:
 *
 *  1. This code runs inside the sandboxed Agent View frame (see host/view.ts),
 *     which has an opaque origin — no cookies, no CSRF secret, no instance
 *     handle, no same-origin fetch. A bug here cannot act as the user.
 *  2. It still escapes everything, because "it's sandboxed" is a reason to
 *     survive a mistake, not a reason to make one.
 *
 * Exported as a SOURCE STRING evaluating to a factory, so the same bytes the
 * browser runs are the bytes the tests exercise:
 *
 *     const make = new Function("return (" + VIEW_RUNTIME_JS + ")")();
 *     const rt = make({ allowed, specs, locals, resolve });
 *     rt.nodeHtml(node)   // -> html string
 *
 * There is deliberately no `document`, `fetch` or `window` reference below.
 */

export const VIEW_RUNTIME_JS = `function(host){
  var ALLOWED = host.allowed || {};
  var SPEC = host.specs || {};
  var LOCAL = host.locals || {};
  var resolve = host.resolve || function(){ return null; };

  /* Text AND quoted-attribute escaping. Single quotes are escaped too, so a
     value is safe in either quoting style. */
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  /* Class names and other bare (unquoted-ish) tokens: allowlist, never escape.
     An app that ships tone:'" onload=x' gets nothing, not a mangled attribute. */
  function tok(s){ return String(s==null?'':s).replace(/[^A-Za-z0-9_-]/g, ''); }

  /* DOM ids we synthesize from app-controlled names. Same allowlist, plus a
     stable prefix so an empty result cannot collide with a real element. */
  function idOf(action, name){ return 'f_' + tok(action) + '_' + tok(name); }

  function mdLite(src){
    var out=[], lines=String(src||'').split(/\\n/), inList=false, i, ln;
    function inline(s){
      s = esc(s);
      s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
      s = s.replace(/\\u0060([^\\u0060]+)\\u0060/g, '<code>$1</code>');
      /* Only http(s) links, and the URL has already been escaped, so it can
         neither carry a quote out of the attribute nor be a javascript: URL. */
      s = s.replace(/\\[([^\\]]+)\\]\\((https?:[^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return s;
    }
    for(i=0;i<lines.length;i++){ ln=lines[i];
      if(/^\\s*[-*]\\s+/.test(ln)){ if(!inList){ out.push('<ul>'); inList=true; }
        out.push('<li>'+inline(ln.replace(/^\\s*[-*]\\s+/,''))+'</li>'); continue; }
      if(inList){ out.push('</ul>'); inList=false; }
      if(/^#{1,4}\\s+/.test(ln)){ var lvl=(ln.match(/^#+/)||['#'])[0].length;
        out.push('<h'+Math.min(4,lvl+1)+'>'+inline(ln.replace(/^#+\\s+/,''))+'</h'+Math.min(4,lvl+1)+'>'); continue; }
      if(!ln.trim()){ out.push(''); continue; }
      out.push('<p>'+inline(ln)+'</p>');
    }
    if(inList) out.push('</ul>');
    return out.join('');
  }

  function toneDot(t){ return '<span class="t '+tok(t)+'"></span>'; }
  function wt(node){ var t=(node.props||{}).title; return t?'<h2>'+esc(t)+'</h2>':''; }

  var R = {
    heading: function(node, data){
      var d = data || node.props || {};
      return '<h2>'+esc(d.title||'')+'</h2>' + (d.subtitle?'<div class="sub">'+esc(d.subtitle)+'</div>':'');
    },
    markdown: function(node, data){ return wt(node)+'<div class="md">'+mdLite(data)+'</div>'; },
    kv: function(node, data){
      var entries = Array.isArray(data) ? data.map(function(e){return [e.k,e.v];})
        : Object.keys(data||{}).map(function(k){ return [k,(data||{})[k]]; });
      return wt(node)+'<dl class="kv">'+entries.map(function(e){
        return '<dt>'+esc(e[0])+'</dt><dd>'+esc(e[1])+'</dd>'; }).join('')+'</dl>';
    },
    list: function(node, data){
      var items = Array.isArray(data)?data:[];
      if(!items.length) return wt(node)+'<div class="sub">（空）</div>';
      var canSel = node.on && node.on.select;
      var lk = canSel && node.on.select.indexOf('local:')===0 ? node.on.select.slice(6) : null;
      return wt(node)+items.map(function(it){
        var on = lk && LOCAL[lk]===String(it.id||'');
        return '<div class="item'+(canSel?' sel':'')+(on?' active':'')+'" data-sel="'+esc(it.id||'')+'">'
          + toneDot(it.tone) + '<b>'+esc(it.title||it.id||'')+'</b>'
          + (it.badge?'<span class="badge">'+esc(it.badge)+'</span>':'')
          + (it.subtitle?'<span class="sub2">'+esc(it.subtitle)+'</span>':'')
          + '</div>';
      }).join('');
    },
    table: function(node, data){
      var t = data||{}, cols=t.columns||[], rows=t.rows||[];
      return '<table class="tb"><tr>'+cols.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr>'
        + rows.map(function(r){ return '<tr>'+(Array.isArray(r)?r:[]).map(function(c){return '<td>'+esc(c)+'</td>';}).join('')+'</tr>'; }).join('')
        + '</table>';
    },
    banner: function(node, data){
      if(!data) return '';
      return '<div class="banner '+tok(data.tone||'')+'">'+esc(data.text||'')+'</div>';
    },
    form: function(node){
      var action = String((node.props||{}).action||''), spec = SPEC[action];
      if(!Object.prototype.hasOwnProperty.call(ALLOWED, action) || !spec) return '';
      var fields = Object.keys(spec.params||{}).map(function(name){
        var p = spec.params[name], id = idOf(action, name);
        var label = '<label for="'+id+'">'+esc(p.description||name)+(p.required?' *':'')+'</label>';
        var opts = p.enum;
        if(!opts && p.enumBind){
          opts = (resolve(p.enumBind)||[]).map(function(o){
            return (o && typeof o==='object') ? String(o.id) : String(o); });
        }
        if(opts) return '<div>'+label+'<select id="'+id+'" name="'+esc(name)+'">'+opts.map(function(v){
          return '<option value="'+esc(v)+'">'+esc(v)+'</option>';}).join('')+'</select></div>';
        if(p.type==='boolean') return '<div><label><input type="checkbox" id="'+id+'" name="'+esc(name)+'"> '+esc(p.description||name)+'</label></div>';
        if(p.type==='object') return '<div>'+label+'<textarea id="'+id+'" name="'+esc(name)+'" rows="3" placeholder="JSON"></textarea></div>';
        return '<div>'+label+'<input id="'+id+'" name="'+esc(name)+'" type="'+(p.type==='number'?'number':'text')+'"></div>';
      }).join('');
      return '<form class="af" data-form="'+esc(action)+'">'+fields
        + '<div><button class="btn primary" type="submit">'+esc(spec.title||action)+'</button></div></form>';
    },
    actions: function(node){
      var items = ((node.props||{}).items||[]).filter(function(it){
        return Object.prototype.hasOwnProperty.call(ALLOWED, it.action); });
      if(!items.length) return '';
      return '<div class="btnrow">'+items.map(function(it){
        var spec = SPEC[it.action]||{};
        return '<button class="btn" data-act="'+esc(it.action)+'" data-params="'+esc(JSON.stringify(it.params||{}))+'">'
          + esc(it.label||spec.title||it.action)+'</button>';
      }).join('')+'</div>';
    },
    timeline: function(node, data){
      var d = data||{}, secs=[['past','过去'],['today','今天'],['future','未来']];
      var canSel = node.on && node.on.select;
      return wt(node)+'<div class="tl">'+secs.map(function(sc){
        var items = d[sc[0]]||[];
        return '<h4>'+sc[1]+'</h4>' + (items.length ? items.map(function(it){
          return '<div class="item'+(canSel?' sel':'')+'" data-sel="'+esc(it.id||'')+'">'+toneDot(it.tone)
            + '<span class="at">'+esc(it.at||'')+'</span><span>'+esc(it.text||'')+'</span></div>';
        }).join('') : '<div class="sub">（无）</div>');
      }).join('')+'</div>';
    },
    'agent-chat': function(node){
      return '<div class="chat" data-agent="'+esc(node.agent)+'" data-mode0="'+tok((node.props||{}).mode||'rich')+'">'
        + '<div class="chathead"><span class="chip adchip">…</span>'
        + '<span class="chip modechip" title="切换呈现模式（富/简）"></span>'
        + '<span style="flex:1"></span><button class="btn mini cfgbtn" title="agent 配置">⚙</button></div>'
        + '<div class="cfgpanel" hidden></div>'
        + '<div class="chatlog"></div><div class="chatstatus"></div>'
        + '<div class="chatsend"><textarea placeholder="对本页 agent 说点什么…（它能做你在这页能做的一切）Ctrl+Enter 发送"></textarea>'
        + '<button class="btn primary send">发送</button></div></div>';
    },
    docedit: function(node, data){
      var action = String((node.props||{}).action||'');
      var canEdit = Object.prototype.hasOwnProperty.call(ALLOWED, action);
      return wt(node)
        + '<div class="docedit" data-action="'+esc(action)+'">'
        + '<div class="docview md" title="'+(canEdit?'点击编辑':'')+'">'+mdLite(data)
        + (canEdit?'<div class="docedit-hint">✎ 点击任意处编辑</div>':'')+'</div>'
        + '<div class="docsrc" hidden><textarea rows="14"></textarea>'
        + '<div class="btnrow"><button class="btn primary d_save">保存</button>'
        + '<button class="btn d_cancel">取消</button></div></div></div>';
    },
    unknown: function(node){ return '<div class="banner err">未知组件 '+esc(node && node.widget)+'</div>'; }
  };

  function nodeHtml(node){
    if(!node || typeof node!=='object') return R.unknown({});
    if(node.widget==='section'){
      var kids = (node.children||[]).map(function(c,i){
        return '<div class="subnode" data-sub="'+Number(i)+'">'+nodeHtml(c)+'</div>'; }).join('');
      return wt(node)+'<div class="sec">'+kids+'</div>';
    }
    var fn = Object.prototype.hasOwnProperty.call(R, node.widget) ? R[node.widget] : R.unknown;
    return fn(node, resolve(node.bind));
  }

  function entryHtml(e){
    if(!e || typeof e!=='object') return '';
    if(e.kind==='user') return '<div class="msg user">'+esc(e.text)+'</div>';
    if(e.kind==='assistant') return '<div class="msg assistant">'+mdLite(e.text)+'</div>';
    if(e.kind==='thinking') return '<details class="think"><summary>🧠 思考</summary><div class="md">'+mdLite(e.text)+'</div></details>';
    if(e.kind==='tool') return '<div class="msg tool"><details><summary>🔧 '+esc(e.text)+'</summary><pre>'+esc(e.detail||'（无结果记录）')+'</pre></details></div>';
    if(e.kind==='file') return '<div class="filechip">📝 '+esc(e.text)+'</div>';
    if(e.kind==='subagent') return '<div class="subagentblk">🤖 <b>'+esc(e.text)+'</b><details><summary>详情</summary><pre>'+esc(e.detail||'')+'</pre></details></div>';
    if(e.kind==='note') return '<div class="msg tool">📎 '+esc(e.text)+'</div>';
    if(e.kind==='elicit'){
      return '<div class="msg assistant elicitwrap"><div class="elicit"><div class="elicit-tag">🙋 请你回应</div>'
        + '<div class="md">'+mdLite(e.text)+'</div>'
        + ((e.action && Object.prototype.hasOwnProperty.call(ALLOWED, e.action)) ? R.form({ props: { action: e.action } }) : '')
        + '</div></div>';
    }
    return '';
  }

  return { esc: esc, tok: tok, mdLite: mdLite, nodeHtml: nodeHtml, entryHtml: entryHtml, widgets: R };
}`;
