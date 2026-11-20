import { describe, expect, it } from "vitest";
import postcss from "postcss";
import { scopeAppCss } from "./scope-css.js";
describe("shared DOM App styles", () => {
  it("maps document roots and leaves keyframe steps intact", () => {
    const css = postcss.parse(':root{--av-fg:black} html[data-av-theme="ink"] body #root{height:100%} .row:is(.a,.b),button:hover{color:red}@keyframes fade{from{opacity:0}50%{opacity:.5}to{opacity:1}}');
    scopeAppCss(css, "session-plus");
    expect(css.toString()).toContain('[data-app-surface="session-plus"]{--av-fg:black}');
    expect(css.toString()).toContain('[data-app-surface="session-plus"][data-av-theme="ink"]{height:100%}');
    expect(css.toString()).toContain('[data-app-surface="session-plus"] .row:is(.a,.b), [data-app-surface="session-plus"] button:hover');
    expect(css.toString()).toContain('@keyframes fade{from{opacity:0}50%{opacity:.5}to{opacity:1}}');
  });
});
