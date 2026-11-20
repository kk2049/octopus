export interface DirectedEdge {
  from: string;
  to: string;
}
export function adjacency(edges: DirectedEdge[], include?: Iterable<string>): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  if (include) for (const node of include) graph.set(node, new Set());
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    if (!graph.has(edge.to)) graph.set(edge.to, new Set());
    graph.get(edge.from)!.add(edge.to);
  }
  return graph;
}

export function shortestPath(graph: Map<string, Set<string>>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const queue = [from];
  const previous = new Map<string, string | null>([[from, null]]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of graph.get(current) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      if (next === to) {
        const path = [to];
        let cursor: string | null = current;
        while (cursor) {
          path.unshift(cursor);
          cursor = previous.get(cursor) ?? null;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

export function stronglyConnectedComponents(graph: Map<string, Set<string>>): string[][] {
  let nextIndex = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const output: string[][] = [];

  const visit = (node: string): void => {
    index.set(node, nextIndex);
    low.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node)!, index.get(target)!));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    output.push(component.sort());
  };

  for (const node of [...graph.keys()].sort()) if (!index.has(node)) visit(node);
  return output;
}
