/**
 * The pick has to answer "where is this", not only "what is this".
 *
 * The property that makes the answer honest is testable in one line: the
 * selector a pick reports must resolve, through `querySelector`, back to the
 * element that was picked. Everything else here is a bound.
 */

import { describe, expect, it } from "vitest";
import { describeElement, elementPath, stepSelector } from "./element-path.js";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("elementPath", () => {
  it("resolves back to the element it describes", () => {
    mount(`
      <div id="root">
        <main class="page">
          <ul class="list"><li>一</li><li>二</li><li>三</li></ul>
        </main>
      </div>
    `);
    const target = document.querySelectorAll("li")[2]!;
    const picked = describeElement(target, "/tickets");
    expect(document.querySelector(picked.selector)).toBe(target);
    expect(picked.selector).toContain("li:nth-of-type(3)");
  });

  it("stops at the nearest id, because nothing above it can change the answer", () => {
    mount(`<div class="outer"><section id="anchor"><span class="leaf">x</span></section></div>`);
    const steps = elementPath(document.querySelector(".leaf")!);
    expect(steps.map(stepSelector)).toEqual(["#anchor", "span.leaf"]);
  });

  it("omits the ordinal when an element is the only one of its tag", () => {
    mount(`<div id="root"><button class="primary">发</button></div>`);
    const picked = describeElement(document.querySelector("button")!, "/");
    expect(picked.selector).toBe("#root > button.primary");
  });

  it("carries the accessible name and the route a report needs", () => {
    mount(`<div id="root"><button aria-label="关闭抽屉">✕</button></div>`);
    const picked = describeElement(document.querySelector("button")!, "/sessions-plus");
    expect(picked.route).toBe("/sessions-plus");
    expect(picked.path.at(-1)).toContain('"关闭抽屉"');
  });

  it("refuses a class or id that is not a CSS identifier", () => {
    mount(`<div id="root"><div class="a/b ok"><i>x</i></div></div>`);
    const picked = describeElement(document.querySelector("i")!, "/");
    expect(picked.selector).not.toContain("a/b");
    expect(document.querySelector(picked.selector)).toBe(document.querySelector("i"));
  });

  it("bounds the subtree it reports and says when it did", () => {
    const rows = Array.from({ length: 300 }, (_unused, index) => `<p>row ${index}</p>`).join("");
    mount(`<div id="root"><section>${rows}</section></div>`);
    const picked = describeElement(document.querySelector("section")!, "/");
    expect(picked.truncated).toBe(true);
    expect(picked.nodes).toBeLessThanOrEqual(120);
  });

  it("reports only an element's own text, never its descendants'", () => {
    mount(`<div id="root"><div class="box">外层 <span>内层</span></div></div>`);
    const picked = describeElement(document.querySelector(".box")!, "/");
    expect(picked.subtree.text).toBe("外层");
    expect(picked.subtree.kids?.[0]?.text).toBe("内层");
  });
});
