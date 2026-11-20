import { describe, expect, it } from 'vitest';
import { cleanCss, renderBoard } from './board-html';

const mount = (html: string) => {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const stats = renderBoard(root, html, ':host{display:block}');
  return { root, stats };
};

describe('renderBoard', () => {
  it('keeps the layout, tables and inline styles a dashboard is made of', () => {
    const { root } = mount('<h2>进度</h2><div class="bar" style="width:40%;background:var(--board-good)">40%</div>'
      + '<table><tr><th>条目</th><td colspan="2">A0</td></tr></table><details open><summary>风险</summary><p>无</p></details>');
    expect(root.querySelector('h2')?.textContent).toBe('进度');
    const bar = root.querySelector<HTMLElement>('.bar')!;
    expect(bar.style.width).toBe('40%');
    expect(root.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(root.querySelector('details')?.hasAttribute('open')).toBe(true);
  });

  it('drops everything that runs, submits, frames or listens', () => {
    const { root, stats } = mount('<p onclick="steal()">t</p><script>steal()</script><iframe src="https://evil.example"></iframe>'
      + '<form action="https://evil.example"><input name="pw"><button>go</button></form><object data="x"></object><img src="https://evil.example/t.png" onerror="steal()">');
    expect(root.querySelector('script, iframe, form, input, button, object')).toBeNull();
    expect(root.querySelector('p')?.getAttribute('onclick')).toBeNull();
    const img = root.querySelector('img')!;
    expect(img.getAttribute('src')).toBeNull();
    expect(img.getAttribute('onerror')).toBeNull();
    expect(stats.dropped).toBe(4);
  });

  it('opens only web and mail links, in a new context', () => {
    const { root } = mount('<a href="javascript:steal()">x</a><a href="https://example.com/r">y</a><a href="mailto:a@b.c">z</a>');
    const [bad, web, mail] = Array.from(root.querySelectorAll('a'));
    expect(bad.hasAttribute('href')).toBe(false);
    expect(web.getAttribute('href')).toBe('https://example.com/r');
    expect(web.getAttribute('target')).toBe('_blank');
    expect(web.getAttribute('rel')).toBe('noopener noreferrer');
    expect(mail.getAttribute('href')).toBe('mailto:a@b.c');
  });

  it('loads nothing from outside: inline images and #references only', () => {
    const { root } = mount('<style>@import url(https://evil.example/x.css); .a{background:url("https://evil.example/t.png")} .b{background:url(data:image/png;base64,AAAA)}</style>'
      + '<img src="data:image/png;base64,AAAA"><p class="a" style="background-image:url(https://evil.example/p.png)">x</p>');
    const css = Array.from(root.querySelectorAll('style'), (s) => s.textContent).join('\n');
    expect(css).not.toContain('evil.example');
    expect(css).not.toContain('@import');
    expect(css).toContain('data:image/png;base64,AAAA');
    expect(css).toContain(':host{display:block}');
    expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(root.querySelector<HTMLElement>('.a')!.style.backgroundImage).not.toContain('evil.example');
  });

  it('keeps inline SVG charts and drops their ways out', () => {
    const { root } = mount('<svg viewBox="0 0 100 20"><defs><linearGradient id="g"><stop offset="0" stop-color="#3370ff"/></linearGradient></defs>'
      + '<rect width="40" height="10" fill="url(#g)"/><use href="#g"/><use href="https://evil.example/s.svg#x"/>'
      + '<a href="javascript:steal()"><text x="0" y="18">A0</text></a><animate attributeName="href" values="javascript:steal()"/><image href="https://evil.example/i.png"/></svg>');
    const svg = root.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 20');
    expect(root.querySelector('rect')?.getAttribute('fill')).toBe('url(#g)');
    const uses = Array.from(root.querySelectorAll('use'));
    expect(uses.map((u) => u.getAttribute('href'))).toEqual(['#g', null]);
    expect(root.querySelector('svg a, animate, image')).toBeNull();
    expect(root.querySelector('text')?.textContent).toBe('A0');
  });

  it('unwraps unknown tags, keeps their text, and stops at its size bound', () => {
    expect(mount('<center><b>x</b></center>').root.querySelector('b')?.textContent).toBe('x');
    // The size bound is shared by both root types. jsdom scans the entire
    // shadow tree for slots on each insertion (quadratic for 8000 siblings);
    // exercise the full bound through the ordinary-element root instead.
    const root = document.createElement('div');
    const stats = renderBoard(root, '<span>x</span>'.repeat(9000));
    expect(stats.truncated).toBe(true);
    expect(stats.nodes).toBe(8000);
    expect(root.querySelectorAll('span')).toHaveLength(8000);
  });
});

describe('cleanCss', () => {
  it('keeps ordinary rules and removes outside references', () => {
    expect(cleanCss('.a{color:red} .b{background:url(https://x/y)}')).toBe('.a{color:red} .b{background:none}');
    expect(cleanCss("@font-face{src:url('https://x/f.woff')}")).toBe('@font-face{src:none}');
    expect(cleanCss('.c{-moz-binding:url(x.xml#a)} .d{width:expression(alert(1))}')).not.toMatch(/binding|expression/);
  });
});
