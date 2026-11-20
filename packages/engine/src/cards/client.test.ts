/**
 * The browser deliverable is a build artefact with no compiler behind it: a
 * template-literal edit that breaks the script fails silently at runtime, in
 * the browser, on someone else's machine. So:
 *
 *  1. every emitted script string must PARSE;
 *  2. every field an app (i.e. an agent) controls must survive an adversarial
 *     value without producing executable HTML.
 *
 * The second half runs the real source string, not a re-implementation.
 */

import { describe, expect, it } from "vitest";
import { CLIENT_JS } from "./client.js";
import { VIEW_RUNTIME_JS } from "./view-js.js";
import { FACTORY_JS } from "../host/factory-page.js";
import { VIEW_FRAME_JS } from "../host/view-frame.js";

describe("emitted scripts parse", () => {
  const scripts: Array<[string, string]> = [
    ["CLIENT_JS", CLIENT_JS],
    ["FACTORY_JS", FACTORY_JS],
    ["VIEW_FRAME_JS", VIEW_FRAME_JS],
    ["VIEW_RUNTIME_JS", `return (${VIEW_RUNTIME_JS})`],
  ];
  for (const [name, src] of scripts) {
    it(`${name} is valid JavaScript`, () => {
      expect(() => new Function(src)).not.toThrow();
    });
  }
});

// ── adversarial projection data ──

interface Runtime {
  esc(s: unknown): string;
  tok(s: unknown): string;
  mdLite(s: unknown): string;
  nodeHtml(node: unknown): string;
  entryHtml(e: unknown): string;
  widgets: Record<string, (node: unknown, data?: unknown) => string>;
}

function runtime(host: Record<string, unknown> = {}): Runtime {
  const make = new Function(`return (${VIEW_RUNTIME_JS})`)() as (h: unknown) => Runtime;
  return make({ allowed: {}, specs: {}, locals: {}, resolve: () => null, ...host });
}

/** Payloads that break out of text, out of a quoted attribute, or out of a class token. */
const PAYLOADS = [
  `<script>alert(1)</script>`,
  `"><img src=x onerror=alert(1)>`,
  `' onmouseover='alert(1)`,
  `" onload="alert(1)`,
  `javascript:alert(1)`,
  `</textarea><svg onload=alert(1)>`,
  `<script>`,
];

/**
 * Escaped text legitimately contains the STRING "onerror=" — asserting on
 * substrings would be both noisy and wrong. What matters is the parse: which
 * elements and attributes the browser would actually create.
 *
 * So tokenize the way a parser does (only `<` followed by a name starts a
 * tag; `&lt;` never does) and check the element and attribute names against
 * what the renderer is allowed to emit.
 */
const ALLOWED_TAGS = new Set([
  "h2", "h3", "h4", "h5", "div", "span", "dl", "dt", "dd", "b", "p", "ul", "li", "code", "a",
  "table", "tr", "th", "td", "form", "label", "select", "option", "input", "textarea", "button",
  "details", "summary", "pre",
]);
const ALLOWED_ATTRS = new Set([
  "class", "data-sel", "data-act", "data-params", "data-form", "data-sub", "data-agent",
  "data-mode0", "data-action", "id", "name", "type", "rows", "placeholder", "for", "value",
  "href", "target", "rel", "title", "hidden", "style", "selected", "list",
]);

function tokenize(html: string): { tags: string[]; attrs: string[] } {
  const tags: string[] = [];
  const attrs: string[] = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    tags.push(m[1].toLowerCase());
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[2]))) attrs.push(a[1].toLowerCase());
  }
  return { tags, attrs };
}

function assertInert(html: string): void {
  const { tags, attrs } = tokenize(html);
  for (const t of tags) expect(ALLOWED_TAGS, `unexpected element <${t}> in: ${html}`).toContain(t);
  for (const a of attrs) {
    expect(a.startsWith("on"), `event handler attribute "${a}" in: ${html}`).toBe(false);
    expect(ALLOWED_ATTRS, `unexpected attribute "${a}" in: ${html}`).toContain(a);
  }
  // No href/src may carry a scheme we did not vet.
  for (const m of html.matchAll(/(?:href|src)\s*=\s*"([^"]*)"/gi)) {
    expect(/^https?:/.test(m[1]) || m[1] === "" , `unsafe URL ${m[1]}`).toBe(true);
  }
}

describe("no untrusted projection field reaches executable HTML", () => {
  it("tone becomes a token allowlist, never an attribute break-out", () => {
    const rt = runtime();
    for (const p of PAYLOADS) {
      assertInert(rt.widgets.list({ widget: "list" }, [{ id: "a", title: "t", tone: p }]));
      assertInert(rt.widgets.banner({ widget: "banner" }, { tone: p, text: "hi" }));
      assertInert(rt.widgets.timeline({ widget: "timeline" }, { today: [{ id: "x", tone: p, text: "t" }] }));
    }
    // and a legitimate tone still survives
    expect(rt.widgets.banner({ widget: "banner" }, { tone: "warn", text: "hi" })).toContain('class="banner warn"');
  });

  it("every list/timeline field is escaped", () => {
    const rt = runtime();
    for (const p of PAYLOADS) {
      assertInert(
        rt.widgets.list({ widget: "list", on: { select: "local:sel" } }, [
          { id: p, title: p, badge: p, subtitle: p, tone: p },
        ]),
      );
      assertInert(rt.widgets.timeline({ widget: "timeline" }, { past: [{ id: p, at: p, text: p, tone: p }] }));
    }
  });

  it("heading, kv, table and markdown are escaped", () => {
    const rt = runtime();
    for (const p of PAYLOADS) {
      assertInert(rt.widgets.heading({ widget: "heading" }, { title: p, subtitle: p }));
      assertInert(rt.widgets.kv({ widget: "kv" }, { [p]: p }));
      assertInert(rt.widgets.kv({ widget: "kv" }, [{ k: p, v: p }]));
      assertInert(rt.widgets.table({ widget: "table" }, { columns: [p], rows: [[p]] }));
      assertInert(rt.widgets.markdown({ widget: "markdown" }, p));
      assertInert(rt.widgets.unknown({ widget: p }));
    }
  });

  it("markdown links cannot smuggle javascript: or break the href attribute", () => {
    const rt = runtime();
    // `javascript:` never matches the link pattern, so it stays inert text.
    const js = rt.mdLite("[x](javascript:alert(1))");
    assertInert(js);
    expect(js).not.toContain("<a ");
    assertInert(rt.mdLite('[x](https://a" onload="alert(1))'));
    expect(rt.mdLite("[ok](https://example.com/a)")).toContain('href="https://example.com/a"');
    expect(rt.mdLite("[ok](https://example.com/a)")).toContain('rel="noopener noreferrer"');
  });

  it("form ids/names built from app-authored action and param names are inert", () => {
    for (const p of PAYLOADS) {
      const rt = runtime({
        allowed: { [p]: 1 },
        specs: { [p]: { title: p, params: { [p]: { type: "string", description: p, enum: [p] } } } },
      });
      assertInert(rt.widgets.form({ widget: "form", props: { action: p } }));
    }
  });

  it("action buttons escape action, label and params", () => {
    for (const p of PAYLOADS) {
      const rt = runtime({ allowed: { [p]: 1 }, specs: { [p]: { title: p } } });
      assertInert(rt.widgets.actions({ widget: "actions", props: { items: [{ action: p, label: p, params: { x: p } }] } }));
    }
  });

  it("agent-chat and docedit attributes are inert", () => {
    for (const p of PAYLOADS) {
      const rt = runtime({ allowed: { [p]: 1 } });
      assertInert(rt.widgets["agent-chat"]({ widget: "agent-chat", agent: p, props: { mode: p } }));
      assertInert(rt.widgets.docedit({ widget: "docedit", props: { action: p } }, p));
    }
  });

  it("transcript entries of every kind are escaped", () => {
    const rt = runtime();
    for (const p of PAYLOADS) {
      for (const kind of ["user", "assistant", "thinking", "tool", "file", "subagent", "note", "elicit"]) {
        assertInert(rt.entryHtml({ kind, text: p, detail: p, action: p }));
      }
    }
  });

  it("a widget name from the prototype chain does not select a function", () => {
    const rt = runtime();
    for (const widget of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const html = rt.nodeHtml({ widget });
      expect(html).toContain("未知组件");
      assertInert(html);
    }
  });

  it("an allowed-action check cannot be satisfied from the prototype chain", () => {
    const rt = runtime({ allowed: {}, specs: {} });
    // `ALLOWED["constructor"]` is truthy on a plain object; hasOwnProperty is not.
    expect(rt.widgets.actions({ widget: "actions", props: { items: [{ action: "constructor" }] } })).toBe("");
    expect(rt.widgets.form({ widget: "form", props: { action: "constructor" } })).toBe("");
  });

  it("a non-object node does not crash the renderer", () => {
    const rt = runtime();
    expect(() => rt.nodeHtml(null)).not.toThrow();
    expect(() => rt.nodeHtml("x")).not.toThrow();
    expect(() => rt.entryHtml(null)).not.toThrow();
  });
});
