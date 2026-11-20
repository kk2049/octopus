import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { AGENT_VIEW_THEME_PROFILES, THEMES, applyTheme, getAppearance } from "./themes.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaults = readFileSync(join(here, "tokens.css"), "utf8");
const apple = readFileSync(join(here, "theme-apple.css"), "utf8");
const provider = readFileSync(join(here, "../ui-kit/UiProvider.tsx"), "utf8");
const graph = readFileSync(join(here, "../pages/knowledge/GraphView.module.css"), "utf8");

function declaration(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`missing --${name}`);
  return match[1].trim();
}

function schemeDeclarations(css: string, name: string): readonly [string, string] {
  const values = [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-f]{6}|#[0-9a-f]{3});`, "gi"))]
    .map((match) => match[1].toLowerCase());
  if (values.length !== 2) throw new Error(`expected light and dark --${name}, found ${values.length}`);
  return [values[0], values[1]];
}

function relativeLuminance(hex: string): number {
  const compact = hex.slice(1);
  const expanded = compact.length === 3 ? [...compact].map((channel) => channel.repeat(2)).join("") : compact;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function generated(name: string): string {
  const profile = AGENT_VIEW_THEME_PROFILES.find(({ id }) => id === "apple");
  const token = profile?.tokens[name];
  if (!token || !("value" in token)) throw new Error(`missing generated Apple --av-${name}`);
  return token.value;
}

afterEach(() => {
  applyTheme("classic");
});

describe("the global Apple appearance", () => {
  it("is a first-class picker choice and appearance payload", () => {
    expect(THEMES).toContainEqual({ id: "apple", label: "Apple" });
    expect(AGENT_VIEW_THEME_PROFILES.map((profile) => profile.id)).toEqual(
      THEMES.map((theme) => theme.id),
    );
    applyTheme("apple");
    expect(document.documentElement.dataset.theme).toBe("apple");
    expect(getAppearance().theme).toBe("apple");
  });

  it("differs materially from Classic in all five design-language dimensions", () => {
    expect([declaration(defaults, "control-height"), declaration(apple, "control-height")]).toEqual(["32px", "40px"]);
    expect([declaration(defaults, "radius-md"), declaration(apple, "radius-md")]).toEqual(["10px", "18px"]);
    expect([declaration(defaults, "space-3"), declaration(apple, "space-3")]).toEqual(["12px", "16px"]);
    expect([declaration(defaults, "page-title-size"), declaration(apple, "page-title-size")]).toEqual(["var(--text-xl)", "var(--text-2xl)"]);
    expect([declaration(defaults, "chrome-filter"), declaration(apple, "chrome-filter")]).toEqual(["none", "saturate(180%) blur(24px)"]);

    expect(generated("control-h")).toBe("40px");
    expect(generated("rm")).toBe("18px");
    expect(generated("s3")).toBe("16px");
    expect(generated("font-heading")).toBe("28px");
    expect(generated("material-filter")).toBe("saturate(180%) blur(24px)");
  });

  it("keeps geometry and materials in CSS tokens instead of runtime theme branches", () => {
    expect(provider).not.toMatch(/themeId\s*===\s*["']apple["']/);
    expect(provider).toContain('cssNumber("--control-height", 32)');
    expect(apple).toContain("@supports ((-webkit-backdrop-filter: blur(0)) or (backdrop-filter: blur(0)))");
    expect(apple).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(graph).not.toMatch(/background:\s*#101c18|color:\s*#f1eadc/);
    expect(graph).toContain("var(--knowledge-graph-bg, #0c1412)");
  });

  it("keeps small semantic text at WCAG AA contrast in both colour schemes", () => {
    const pairs = [
      ["fg", "bg"],
      ["fg", "card"],
      ["fg", "tool-bg"],
      ["fg", "user-bg"],
      ["muted", "bg"],
      ["muted", "card"],
      ["think", "bg"],
      ["think", "card"],
      ["accent", "bg"],
      ["accent", "card"],
      ["accent-fg", "accent"],
      ["ok", "bg"],
      ["err", "bg"],
      ["q-normal", "bg"],
      ["q-warning", "bg"],
      ["q-critical", "bg"],
      ["knowledge-graph-text", "knowledge-graph-bg"],
      ["knowledge-graph-text", "knowledge-graph-panel"],
      ["knowledge-graph-text", "knowledge-graph-raised"],
      ["knowledge-graph-text", "knowledge-graph-control"],
      ["knowledge-graph-text", "knowledge-graph-results-bg"],
      ["knowledge-graph-text", "knowledge-graph-inspector-bg"],
      ["knowledge-graph-text", "knowledge-graph-relation-bg"],
      ["knowledge-graph-muted", "knowledge-graph-bg"],
      ["knowledge-graph-muted", "knowledge-graph-panel"],
      ["knowledge-graph-muted", "knowledge-graph-raised"],
      ["knowledge-graph-kicker", "knowledge-graph-intro"],
      ["knowledge-graph-accent", "knowledge-graph-stat-bg"],
      ["knowledge-graph-placeholder", "knowledge-graph-control"],
      ["knowledge-graph-chip-text", "knowledge-graph-results-bg"],
      ["knowledge-graph-stage-head", "knowledge-graph-bg"],
      ["knowledge-graph-cluster-label", "knowledge-graph-bg"],
      ["knowledge-graph-node-text", "knowledge-graph-bg"],
      ["knowledge-graph-node-selected-text", "knowledge-graph-node-selected"],
      ["knowledge-graph-hint-text", "knowledge-graph-panel"],
      ["knowledge-graph-code", "knowledge-graph-inspector-bg"],
      ["knowledge-graph-relation-heading", "knowledge-graph-inspector-bg"],
      ["knowledge-graph-detail-link", "knowledge-graph-inspector-bg"],
      ["knowledge-graph-mark", "knowledge-graph-inspector-bg"],
    ] as const;
    const schemes = ["light", "dark"] as const;
    const failures = pairs.flatMap(([foregroundToken, backgroundToken]) => {
      const foregrounds = schemeDeclarations(apple, foregroundToken);
      const backgrounds = schemeDeclarations(apple, backgroundToken);
      return schemes.flatMap((scheme, index) => {
        const ratio = contrastRatio(foregrounds[index], backgrounds[index]);
        return ratio >= 4.5 ? [] : [{ scheme, foregroundToken, backgroundToken, ratio }];
      });
    });
    expect(failures).toEqual([]);
  });

  it("keeps every pre-Apple graph nuance as the fallback for other themes", () => {
    expect([
      declaration(graph, "graph-kicker"),
      declaration(graph, "graph-stat-bg"),
      declaration(graph, "graph-hover-border"),
      declaration(graph, "graph-results-border"),
      declaration(graph, "graph-results-bg"),
      declaration(graph, "graph-stage-head"),
      declaration(graph, "graph-cluster-label"),
      declaration(graph, "graph-hint-border"),
      declaration(graph, "graph-hint-text"),
      declaration(graph, "graph-inspector-bg"),
      declaration(graph, "graph-code"),
      declaration(graph, "graph-relation-heading"),
      declaration(graph, "graph-relation-bg"),
      declaration(graph, "graph-relation-hover"),
      declaration(graph, "graph-detail-link"),
      declaration(graph, "graph-mark-border"),
      declaration(graph, "graph-mark"),
    ]).toEqual([
      "var(--knowledge-graph-kicker, #e8bd64)",
      "var(--knowledge-graph-stat-bg, #0c1613)",
      "var(--knowledge-graph-hover-border, #d6ac59)",
      "var(--knowledge-graph-results-border, #496156)",
      "var(--knowledge-graph-results-bg, #101d19)",
      "var(--knowledge-graph-stage-head, #a8b0a9)",
      "var(--knowledge-graph-cluster-label, #8f9e96)",
      "var(--knowledge-graph-hint-border, rgb(94 119 108 / 45%))",
      "var(--knowledge-graph-hint-text, #8e9b94)",
      "var(--knowledge-graph-inspector-bg, #111e1a)",
      "var(--knowledge-graph-code, #d9cda9)",
      "var(--knowledge-graph-relation-heading, #eac36e)",
      "var(--knowledge-graph-relation-bg, #0c1714)",
      "var(--knowledge-graph-relation-hover, #182b25)",
      "var(--knowledge-graph-detail-link, #f0ca77)",
      "var(--knowledge-graph-mark-border, #d8af5c)",
      "var(--knowledge-graph-mark, #e6bd69)",
    ]);
    expect(graph).toMatch(/\.stageHead\s*\{[^}]*color:\s*var\(--graph-stage-head\)/s);
    expect(graph).toMatch(/\.searchResults button small\s*\{[^}]*color:\s*var\(--graph-muted\)/s);
  });
});
