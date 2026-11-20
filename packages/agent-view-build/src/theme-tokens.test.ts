import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AGENT_VIEW_THEME_PROFILES,
  type AgentViewSchemeToken,
  type AgentViewThemeProfile,
} from "@claude-bot/dashboard-web/theme-registry";
import { renderAgentViewThemeCss } from "@claude-bot/agent-view-build/theme-tokens";

function scheme(profile: AgentViewThemeProfile, name: string): AgentViewSchemeToken {
  const token = profile.tokens[name];
  if (!token || !("light" in token)) throw new Error(`${profile.id} has no scheme token --av-${name}`);
  return token;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`bad hex: ${hex}`);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = (channel: number) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear(channels[0]) + 0.7152 * linear(channels[1]) + 0.0722 * linear(channels[2]);
}

function contrast(left: string, right: string): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("generated Agent View theme tokens", () => {
  it("covers the Dashboard picker exactly and emits old-Safari light fallbacks", () => {
    expect(AGENT_VIEW_THEME_PROFILES.map((profile) => profile.id)).toEqual([
      "classic",
      "aurora",
      "ink",
      "feishu",
      "deepseek",
      "apple",
    ]);
    const css = renderAgentViewThemeCss();
    expect(css).toContain("Generated from @claude-bot/dashboard-web/theme-registry");
    expect(css).toContain("@supports not (color: light-dark(white, black))");
    for (const profile of AGENT_VIEW_THEME_PROFILES) {
      const selector = profile.id === "classic" ? ":root" : `html[data-av-theme="${profile.id}"]`;
      expect(css.split(`${selector} {`).length - 1, selector).toBe(2);
    }
    expect(css).toContain("--av-control-h: 40px");
    expect(css).toContain("--av-card-padding: 20px");
    expect(css).toContain("--av-s3: 16px");
    expect(css).toContain("--av-material-filter: saturate(180%) blur(24px)");
  });

  it("keeps every small-text semantic colour at WCAG AA contrast", () => {
    const foregrounds: Readonly<Record<string, readonly string[]>> = {
      fg: ["canvas", "surface", "user-bg", "tool-bg"],
      muted: ["canvas", "surface", "tool-bg"],
      ok: ["canvas", "surface"],
      warn: ["canvas", "surface"],
      error: ["canvas", "surface"],
      info: ["canvas", "surface"],
      think: ["canvas", "surface"],
    };
    for (const profile of AGENT_VIEW_THEME_PROFILES) {
      for (const arm of ["light", "dark"] as const) {
        for (const [foreground, backgrounds] of Object.entries(foregrounds)) {
          for (const background of backgrounds) {
            const ratio = contrast(scheme(profile, foreground)[arm], scheme(profile, background)[arm]);
            expect(ratio, `${profile.id}-${arm}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
          }
        }
        expect(
          contrast(scheme(profile, "accent-contrast")[arm], scheme(profile, "accent")[arm]),
          `${profile.id}-${arm}: accent-contrast on accent`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps palette literals out of the hand-written SDK stylesheet", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const styles = readFileSync(join(here, "../../agent-view-react/src/styles.css"), "utf8");
    const literals = styles.match(/#[0-9a-f]{3,8}\b|(?:rgb|rgba|hsl|hsla)\([^)]*\)/gi) ?? [];
    expect(literals.length).toBeLessThan(20);
    expect(styles).not.toMatch(/--av-(?:fg|muted|surface|canvas|accent):\s*light-dark/);
  });
});
