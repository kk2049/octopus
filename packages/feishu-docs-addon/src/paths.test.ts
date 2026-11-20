import { describe, expect, it } from 'vitest';
import { FILE_SCHEME, fileMention, mentionOf, remarkFileMentions } from './paths';

describe('fileMention', () => {
  it('accepts the shapes agents print', () => {
    expect(fileMention('results/fig1.png')).toBe('results/fig1.png');
    expect(fileMention('`src/Card.tsx:42`')).toBe('src/Card.tsx');
    expect(fileMention('lr_schedule.py:12:5')).toBe('lr_schedule.py');
    expect(fileMention('/home/ubuntu/lht/temp/demo-agent/out.csv#L3')).toBe('/home/ubuntu/lht/temp/demo-agent/out.csv');
    expect(fileMention('~/notes/plan.md')).toBe('~/notes/plan.md');
    expect(fileMention('./run.sh')).toBe('./run.sh');
    expect(fileMention('results/')).toBe('results/');
    expect(fileMention('src/lib')).toBe('src/lib');
    expect(fileMention('/home/ubuntu/project')).toBe('/home/ubuntu/project');
    expect(fileMention('报告.md')).toBe('报告.md');
    expect(fileMention('.env')).toBe('.env');
  });

  it('refuses URLs, code and prose', () => {
    for (const raw of ['https://example.com/a.png', 'mailto:a@b.c', 'useState', 'foo.bar', 'v1.2', 'e.g.', '/', '~', '..', 'a b.md', 'C:\\x\\y.txt', 'npm run build']) {
      expect(fileMention(raw), raw).toBeNull();
    }
    expect(fileMention('~/x')).toBeNull();
  });

  it('is stricter in prose', () => {
    expect(fileMention('Node.js', true)).toBeNull();
    expect(fileMention('and/or', true)).toBeNull();
    expect(fileMention('results.csv', true)).toBe('results.csv');
    expect(fileMention('src/app.ts', true)).toBe('src/app.ts');
  });
});

type N = { type: string; value?: string; url?: string; children?: N[] };
const run = (tree: N) => { remarkFileMentions()(tree); return tree; };
const para = (...children: N[]): N => ({ type: 'root', children: [{ type: 'paragraph', children }] });
const links = (tree: N): string[] => {
  const out: string[] = [];
  const visit = (n: N) => { if (n.type === 'link' && n.url) out.push(n.url); n.children?.forEach(visit); };
  visit(tree);
  return out;
};

describe('remarkFileMentions', () => {
  it('turns inline code, prose paths and local links into file links', () => {
    const tree = run(para(
      { type: 'text', value: '结果写到了 results/fig1.png，表格在 table.csv。Node.js 不是文件；' },
      { type: 'inlineCode', value: 'lr_schedule.py' },
      { type: 'text', value: ' 和 ' },
      { type: 'link', url: '/home/u/repo/a.ts:12', children: [{ type: 'text', value: 'a.ts' }] },
      { type: 'link', url: 'https://example.com', children: [{ type: 'text', value: 'site' }] },
    ));
    expect(links(tree).map((url) => mentionOf(url) ?? url)).toEqual(['results/fig1.png', 'table.csv', 'lr_schedule.py', '/home/u/repo/a.ts', 'https://example.com']);
    const text = JSON.stringify(tree);
    expect(text).toContain('，表格在 ');
    expect(text).toContain('Node.js 不是文件');
  });

  it('leaves code blocks alone and drops unresolvable local links', () => {
    const tree = run({ type: 'root', children: [
      { type: 'code', value: 'cat results/fig1.png' },
      { type: 'paragraph', children: [{ type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', value: 'x' }] }] },
    ] });
    expect(links(tree)).toEqual([]);
    expect(mentionOf(`${FILE_SCHEME}${encodeURIComponent('a b')}`)).toBe('a b');
  });
});
