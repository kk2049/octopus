import { list, type Root } from "postcss";

/** Scope rules, not declarations or keyframe steps. App roots replace document roots. */
export function scopeAppCss(root: Root, appId?: string): void {
  const surface = appId ? `[data-app-surface="${appId}"]` : "[data-app-surface]";
  root.walkRules((rule) => {
    let parent: Root["parent"] | typeof rule.parent = rule.parent;
    while (parent) {
      if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) return;
      parent = parent.parent;
    }
    rule.selector = list.comma(rule.selector).map((selector) => {
      const rooted = /^(?:html|body|:root|#root)(?=[\s.#:[>+~]|$)/.test(selector);
      if (!rooted) return `${surface} ${selector}`;
      return selector
        .replace(/^(?:html|body|:root|#root)/, surface)
        .replace(/\s+(?:body|#root)(?=[\s.#:[>+~]|$)/g, "");
    }).join(", ");
  });
}
