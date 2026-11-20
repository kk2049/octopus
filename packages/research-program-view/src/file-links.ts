import type { PublishedFileLinks } from '@claude-bot/agent-file-preview';
import { canonicalSourcePath } from '../app/source-locations.js';
import { researchDocumentContext } from './documents-adapter.js';
import { rows, type DocumentRow, type ResearchProjection } from './model.js';

function relativePath(value: string): string | null {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

export function createResearchFileLinks(current: () => ResearchProjection): PublishedFileLinks {
  return { async resolve({ href, sessionRef, fileRef, location }) {
    const projection = current(), mappings = projection.source_locations;
    const documents = rows<DocumentRow>(projection.documents).filter(row => row.key && row.path && !row.hidden);
    const fail = (message: string) => ({ ok: false as const, message });
    if (!href || href.length > 2048 || /[\u0000-\u001f\u007f]/.test(href) || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[/\\]/.test(href)) return fail('此地址不是已发布的项目文件链接。');
    let path: string;
    try { path = decodeURIComponent(href.split(/[?#]/, 1)[0]!).replace(/\\/g, '/'); } catch { return fail('文件链接编码无效。'); }
    const roots = (mappings?.roots ?? []).filter(root => canonicalSourcePath(root) === root);
    const anchors = [...roots.map(root => [root, ''] as const), ...Object.entries(mappings?.aliases ?? {}).filter(([root]) => canonicalSourcePath(root) === root)];
    const candidates = new Set<string>();
    if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
      // Anchor first; '..' may not escape that exact published root.
      for (const [root, prefix] of anchors) if (path.startsWith(`${root}/`)) {
        const relative = relativePath(path.slice(root.length + 1));
        if (relative !== null) candidates.add([prefix, relative].filter(Boolean).join('/'));
      }
      if (!candidates.size) return fail('此路径没有匹配的项目来源位置；请维护项目映射。');
    } else {
      const source = fileRef ? documents.find(row => row.key === fileRef) : null;
      if (fileRef && !source) return fail('链接所在文档已经解除绑定。');
      if (source) {
        const base = source.path!.split('/').slice(0, -1).join('/');
        const relative = relativePath(`${base}/${path}`); if (relative !== null) candidates.add(relative);
      } else if (sessionRef && mappings?.sessions[sessionRef]) {
        const session = mappings.sessions[sessionRef]!;
        const cwd = session.cwd;
        if (session.document_base !== undefined) {
          const relative = relativePath(`${session.document_base}/${path}`); if (relative !== null) candidates.add(relative);
        } else for (const [root, prefix] of anchors) if (cwd === root || cwd.startsWith(`${root}/`)) {
          const base = cwd === root ? '' : cwd.slice(root.length + 1);
          const relative = relativePath(`${prefix}/${base}/${path}`); if (relative !== null) candidates.add(relative);
        }
      } else {
        // Published index-relative links remain usable before location migration.
        const base = location?.labels.slice(0, -1).join('/') ?? '';
        const relative = relativePath(`${base}/${path}`); if (relative !== null) candidates.add(relative);
      }
    }
    const matches = documents.filter(doc => candidates.has(doc.path!.replace(/^\.\//, '')));
    if (matches.length !== 1) return fail(matches.length ? '此链接对应多个已绑定文档，请修正来源映射。' : '链接目标尚未发布到此项目。');
    const doc = matches[0]!, context = researchDocumentContext(doc);
    if (!context) return fail('这份文档缺少已发布路径。');
    return { ok: true, ref: doc.key!, label: doc.path!.split('/').at(-1)!, location: context };
  } };
}
