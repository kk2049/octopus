/** Published provenance. Paths describe evidence; they never authorize a read or execution. */
export interface SourceLocations {
  revision: number;
  roots: string[];
  aliases?: Record<string, string>;
  sessions: Record<string, { cwd: string; document_base?: string; device?: string; provider?: string; session_id?: string }>;
}

export function canonicalSourcePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const path = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) return null;
  if (path.split('/').some(part => part === '..' || part === '.') || path.includes('//')) return null;
  return path && path !== '/' ? path : null;
}

export function research_set_source_locations(ctx: any, p: any) {
  if (ctx.actor?.role !== 'owner') throw new Error('只有项目 Owner 可以维护来源位置映射');
  const previous = ctx.state?.source_locations?.revision ?? 0;
  if (String(previous) !== p.expected_revision) throw new Error('来源映射已更新，请重新读取');
  const input = JSON.parse(p.locations);
  if (!input || Object.keys(input).some(key => !['roots', 'aliases', 'sessions'].includes(key)) || !Array.isArray(input.roots) || !input.roots.length || input.roots.length > 32 || !input.sessions || typeof input.sessions !== 'object' || Array.isArray(input.sessions) || Object.keys(input.sessions).length > 128) throw new Error('来源映射格式无效');
  const roots = input.roots.map((root: unknown) => canonicalSourcePath(root));
  if (roots.some((root: string | null) => !root) || new Set(roots).size !== roots.length) throw new Error('项目根目录必须是明确、唯一的绝对路径');
  const sessions: SourceLocations['sessions'] = {};
  const relative = (value: unknown) => typeof value === 'string' && value.length <= 1024 && !/[\\\u0000-\u001f\u007f]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.');
  const aliases: Record<string, string> = {};
  if (input.aliases !== undefined) {
    if (!input.aliases || typeof input.aliases !== 'object' || Array.isArray(input.aliases) || Object.keys(input.aliases).length > 32) throw new Error('历史路径别名无效');
    for (const [path, prefix] of Object.entries(input.aliases)) {
      if (canonicalSourcePath(path) !== path || !relative(prefix)) throw new Error('历史路径别名必须对应明确的项目内前缀');
      aliases[path] = prefix as string;
    }
  }
  for (const [key, row] of Object.entries(input.sessions) as Array<[string, any]>) {
    if (ctx.state?.sources?.[key]?.kind !== 'session' || ctx.state.sources[key].hidden || !row || Object.keys(row).some(k => !['cwd', 'document_base', 'device', 'provider', 'session_id'].includes(k))) throw new Error('会话映射必须对应已绑定的可见来源');
    const cwd = canonicalSourcePath(row.cwd);
    if (!cwd) throw new Error('会话工作目录必须是明确的绝对路径');
    const locator = [row.device, row.provider, row.session_id];
    if (locator.some(value => value !== undefined) && (!locator.every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) || !['codex', 'claude', 'omp'].includes(row.provider))) throw new Error('执行定位须同时提供设备、provider 和真实 session id');
    if (row.document_base !== undefined && !relative(row.document_base)) throw new Error('会话文档基准必须是项目内相对前缀');
    sessions[key] = { cwd, ...(row.document_base !== undefined ? { document_base: row.document_base } : {}), ...(row.device ? { device: row.device, provider: row.provider, session_id: row.session_id } : {}) };
  }
  if (typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 500) throw new Error('请填写映射依据');
  const locations = { revision: previous + 1, roots, sessions, ...(input.aliases !== undefined ? { aliases } : {}) };
  return { events: [{ type: 'research_source_locations_set', data: { locations, reason: p.reason }, at: ctx.now ?? '', by: 'research-program' }], result: { revision: locations.revision } };
}

export function foldSourceLocations(state: any, event: any): boolean {
  if (event.type !== 'research_source_locations_set') return false;
  state.source_locations = event.data.locations;
  return true;
}
