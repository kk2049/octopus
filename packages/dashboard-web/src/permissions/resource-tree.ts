import { uiText, localizedLabels } from "../i18n/ui-text.js";
import type { PermissionStudioResource, PermissionStudioResourceAlias } from "../contract.js";

/** Display hierarchy only. A URL parent never supplies a child's permission. */
export interface ResourceTreeNode {
  uri: string;
  label: string;
  parent: string | null;
  children: string[];
  resources: PermissionStudioResource[];
  alias?: PermissionStudioResourceAlias;
}

const ROOT_LABELS = localizedLabels((): Record<string, string> => ({
  file: uiText("文件"), tool: uiText("工具"), feishu: uiText("飞书"), object: uiText("对象"),
}));

export function buildResourceTree(
  resources: PermissionStudioResource[],
  aliases: PermissionStudioResourceAlias[],
): Map<string, ResourceTreeNode> {
  const nodes = new Map<string, ResourceTreeNode>();
  const add = (uri: string) => {
    // These are already canonical server addresses. Keep encoded segments in
    // identity and decode only their labels; never resolve or fetch a URL here.
    const match = /^([a-z]+):\/\/([^/]+)(.*)$/.exec(uri);
    const parts = match ? [`${match[1]}://${match[2]}`, ...match[3].split("/").filter(Boolean)] : [uri];
    let parent: string | null = null;
    for (const [index, part] of parts.entries()) {
      const key: string = parent === null ? part : `${parent}/${part}`;
      if (!nodes.has(key)) {
        let label = part;
        try { label = decodeURIComponent(part); } catch { /* retain server text */ }
        if (index === 0 && match) label = `${ROOT_LABELS()[match[1]] ?? match[1]} · ${match[2]}`;
        nodes.set(key, { uri: key, label, parent, children: [], resources: [] });
        if (parent) nodes.get(parent)!.children.push(key);
      }
      parent = key;
    }
    return nodes.get(parent!)!;
  };
  for (const resource of resources) add(resource.uri).resources.push(resource);
  for (const alias of aliases) add(alias.uri).alias = alias;
  for (const node of nodes.values()) {
    node.children.sort((a, b) => nodes.get(a)!.label.localeCompare(nodes.get(b)!.label));
  }
  return nodes;
}

export function nodeAncestors(nodes: Map<string, ResourceTreeNode>, uri: string | null): ResourceTreeNode[] {
  const path: ResourceTreeNode[] = [];
  let node = uri ? nodes.get(uri) : undefined;
  while (node) {
    path.unshift(node);
    node = node.parent ? nodes.get(node.parent) : undefined;
  }
  return path;
}
