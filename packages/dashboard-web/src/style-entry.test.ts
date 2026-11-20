import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("Dashboard bundle stylesheet ownership", () => {
  it("opts into the neutral chat stylesheet at the bundle entry", () => {
    const entry = [
      path.resolve(process.cwd(), "packages/dashboard-web/src/main.tsx"),
      path.resolve(process.cwd(), "src/main.tsx"),
    ].find((candidate) => existsSync(candidate));
    expect(entry).toBeTruthy();
    const source = readFileSync(entry!, "utf8");
    expect(source).toMatch(
      /import\s+["']@claude-bot\/chat-ui-commons\/transcript-ui\.css["']/,
    );
  });

  it("keeps the phone viewport bounded and lets App frames fill their slots", () => {
    const source = (relative: string) => {
      const candidates = [
        path.resolve(process.cwd(), relative),
        path.resolve(process.cwd(), relative.replace("packages/dashboard-web/", "")),
      ];
      const found = candidates.find((candidate) => existsSync(candidate));
      expect(found, `missing ${relative}`).toBeTruthy();
      return readFileSync(found!, "utf8");
    };
    const tokens = source("packages/dashboard-web/src/styles/tokens.css");
    const shell = source("packages/dashboard-web/src/app/Shell.module.css");
    const appOpen = source("packages/dashboard-web/src/pages/AppOpenPage.module.css");
    const sessionPlus = source("packages/dashboard-web/src/pages/SessionPlusPage.module.css");

    expect(tokens).toContain("height: 100dvh");
    expect(tokens).toMatch(/textarea,[\s\S]*font-size: max\(16px, var\(--mobile-control-font-size, 16px\)\) !important/);
    expect(tokens).toMatch(
      /@media \(max-width: 720px\), \(hover: none\) and \(pointer: coarse\)[\s\S]*textarea,[\s\S]*font-size: max\(16px, var\(--mobile-control-font-size, 16px\)\) !important/,
    );
    expect(shell).toContain("min-width: 0");
    expect(shell).toContain("navigationOpen");
    for (const css of [appOpen, sessionPlus]) {
      expect(css).toMatch(/iframe\.spframe\)[\s\S]*position: absolute;[\s\S]*inset: 0;/);
      expect(css).not.toContain("top: 94px");
    }
    expect(appOpen).toContain("grid-template-areas:");
    const compactSessionPlus = sessionPlus.slice(sessionPlus.indexOf("@media (max-width: 720px)"));
    expect(compactSessionPlus).toMatch(/\.workspace,[\s\S]*\.slot[\s\S]*min-width: 0/);
    expect(compactSessionPlus).toMatch(/\.drop[\s\S]*position: fixed/);
  });

  it("reserves the phone ticket pane for chat instead of secondary cards", () => {
    const candidates = [
      path.resolve(process.cwd(), "packages/dashboard-web/src/pages/TicketsPage.module.css"),
      path.resolve(process.cwd(), "src/pages/TicketsPage.module.css"),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    expect(found).toBeTruthy();
    const css = readFileSync(found!, "utf8");
    const mobile = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(mobile).toMatch(/\.ticketInfo,[\s\S]*\.spec[\s\S]*display: none/);
    expect(mobile).toMatch(/\.sendBox[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
    expect(mobile).toMatch(
      /\.sendBox :global\(textarea\.ant-input\)[\s\S]*min-height: 52px[\s\S]*max-height:/,
    );
    expect(mobile).toMatch(/\.transcript :global\(\.av-chat-windowbar\)[\s\S]*display: none/);
  });
});
