export function project(_events: unknown[], context: {viewer?: {role?: string}} = {}) {
  return {title: '自动科研 v2', viewer_role: context.viewer?.role ?? 'viewer'};
}
