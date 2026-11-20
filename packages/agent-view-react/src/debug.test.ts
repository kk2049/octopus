/**
 * The embedded debug agent: bounded serialization and a pick that swallows
 * the click. The channel plumbing (only the parent can ask, closed op set)
 * is covered with the client transport tests and the host side.
 */

import { describe, expect, it } from "vitest";
import { createDebugAgent, serializeSubtree } from "./debug.js";

function build(depth: number, breadth: number): HTMLElement {
  const root = document.createElement("div");
  root.className = "root level0";
  let level: HTMLElement[] = [root];
  for (let d = 1; d <= depth; d += 1) {
    const next: HTMLElement[] = [];
    for (const parent of level) {
      for (let i = 0; i < breadth; i += 1) {
        const child = document.createElement("span");
        child.textContent = `n${d}-${i} ${"x".repeat(200)}`;
        parent.appendChild(child);
        next.push(child);
      }
    }
    level = next;
  }
  document.body.appendChild(root);
  return root;
}

describe("serializeSubtree", () => {
  it("caps depth, node count and text length, and says so", () => {
    const root = build(10, 3);
    try {
      const picked = serializeSubtree(root);
      expect(picked.truncated).toBe(true);
      expect(picked.nodes).toBeLessThanOrEqual(200);
      let deepest = 0;
      const walk = (node: { kids?: unknown[] }, depth: number): void => {
        deepest = Math.max(deepest, depth);
        for (const kid of node.kids ?? []) walk(kid as { kids?: unknown[] }, depth + 1);
      };
      walk(picked.subtree, 0);
      expect(deepest).toBeLessThanOrEqual(8);
      const text = JSON.stringify(picked);
      expect(text).not.toContain("x".repeat(120));
      expect(picked.ancestors.length).toBeLessThanOrEqual(10);
    } finally {
      root.remove();
    }
  });
});

describe("createDebugAgent", () => {
  it("reports the clicked element once, swallows the click, then disarms", () => {
    const target = document.createElement("button");
    target.id = "suspicious";
    let realClicks = 0;
    target.addEventListener("click", () => { realClicks += 1; });
    document.body.appendChild(target);
    const picks: unknown[] = [];
    const agent = createDebugAgent(document, (result) => picks.push(result));
    try {
      agent.start();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(picks).toHaveLength(1);
      expect((picks[0] as { subtree: { id?: string } }).subtree.id).toBe("suspicious");
      // The armed pick swallowed the press; a later click is real again.
      expect(realClicks).toBe(0);
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(picks).toHaveLength(1);
      expect(realClicks).toBe(1);
    } finally {
      agent.stop();
      target.remove();
    }
  });
});
