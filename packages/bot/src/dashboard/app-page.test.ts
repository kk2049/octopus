/**
 * The document, and what may not be inside it.
 *
 * Two properties, and both are what let the CSP be `script-src 'self'`:
 *
 *  · no executable inline script — not one, on any page. The retired pages each
 *    carried several and needed a per-response nonce to admit them;
 *  · the JSON blocks cannot break out of their element however the data is
 *    shaped, which is what makes "just inline the payload" safe at all.
 *
 * And one property about content rather than form: the payload carries trusted
 * identity CONTEXT and no credential.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appPageScriptCsp, inlineJson, renderAppPage } from "./app-page.js";
import type { DashboardBootstrap } from "@claude-bot/dashboard-web/contract";

const MANIFEST = {
  script: "/ui/a/app-abc12345.js",
  styles: ["/ui/a/style-def67890.css"],
  buildId: "abc123def456",
};

const BOOTSTRAP: DashboardBootstrap = {
  buildId: MANIFEST.buildId,
  surface: "bootstrap-v3",
  features: [],
  viewer: { username: "alice", admin: false, dev: false, deploy: false, contribute: false, session: true },
  nav: [{ id: "page.sessionsPlus", path: "/sessions-plus", label: "📜 会话" }],
  pages: ["page.sessionsPlus"],
  redirects: {},
  approvals: true,
  csrfCookieNames: ["__Host-octopus_csrf"],
  themePreference: "deepseek",
  page: "page.sessionsPlus",
  pageProps: {},
};

function render(extra: Partial<Parameters<typeof renderAppPage>[0]> = {}): string {
  return renderAppPage({ title: "t", bootstrap: BOOTSTRAP, manifest: MANIFEST, ...extra });
}

/** Every `<script>` in the document, with its attributes. */
function scriptTags(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
}

describe("the app document", () => {
  it("asks supporting mobile browsers to resize content around the keyboard", () => {
    expect(render()).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">',
    );
    expect(render()).not.toMatch(/user-scalable=no|maximum-scale/i);
  });

  it("ships exactly one executable script, and it is a same-origin module", () => {
    const tags = scriptTags(render());
    const executable = tags.filter((tag) => !tag.includes('type="application/json"'));
    expect(executable).toHaveLength(1);
    expect(executable[0]).toContain('type="module"');
    expect(executable[0]).toContain('src="/ui/a/app-abc12345.js"');
  });

  it("has no inline executable script at all — that is what buys script-src 'self'", () => {
    const html = render();
    // Every script element either has a `src` or is a JSON data block.
    for (const tag of scriptTags(html)) {
      expect(tag.includes("src=") || tag.includes('type="application/json"'), tag).toBe(true);
    }
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("links the stylesheet from the same namespace", () => {
    expect(render()).toContain('<link rel="stylesheet" href="/ui/a/style-def67890.css">');
  });

  it("carries the viewer context the app needs to render navigation", () => {
    const html = render();
    expect(html).toContain('id="octopus-bootstrap"');
    expect(html).toContain('"username":"alice"');
    expect(html).toContain('"page":"page.sessionsPlus"');
  });

  it("carries cookie NAMES but never a cookie value", () => {
    const html = render();
    expect(html).toContain("__Host-octopus_csrf");
    // The value lives in the browser's own jar; the payload has no field for it.
    expect(JSON.stringify(BOOTSTRAP)).not.toMatch(/token|secret|csrfValue/i);
  });

  it("puts the Session Plus handle in its own block, not in the bootstrap", () => {
    const html = render({ appInstance: "handle-xyz" });
    expect(html).toContain('id="octopus-app-instance"');
    const bootstrapBlock = /id="octopus-bootstrap">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(bootstrapBlock).not.toContain("handle-xyz");
  });

  it("omits the handle block entirely when there is no instance", () => {
    expect(render()).not.toContain("octopus-app-instance");
  });
});

describe("inlineJson", () => {
  it("cannot be closed early by a payload containing </script>", () => {
    const out = inlineJson({ text: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
  });

  it("escapes the two separators that end a JavaScript line but not a JSON string", () => {
    const out = inlineJson({ text: `a\u2028b\u2029c` });
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(out).not.toMatch(new RegExp("[\u2028\u2029]"));
  });

  it("round-trips ordinary data unchanged", () => {
    expect(JSON.parse(inlineJson({ a: 1, b: ["x"] }))).toEqual({ a: 1, b: ["x"] });
  });
});

describe("shared runtime import map CSP", () => {
  it("authorizes the exact JSON bytes placed before the module entry", () => {
    const manifest = { ...MANIFEST, imports: {
      react: "/ui/a/react-12345678.js",
      "react/jsx-runtime": "/ui/a/jsx-87654321.js",
      "@claude-bot/agent-view-react": "/ui/a/agent-runtime-abcdefgh.js",
    } };
    const html = render({ manifest });
    const maps = [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)];
    expect(maps).toHaveLength(1);
    const bytes = maps[0]![1]!;
    expect(JSON.parse(bytes)).toEqual({ imports: manifest.imports });
    const hash = createHash("sha256").update(bytes, "utf8").digest("base64");
    expect(appPageScriptCsp(manifest)).toBe("script-src 'self' 'sha256-" + hash + "'");
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('type="module"'));
    expect(appPageScriptCsp(manifest)).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(appPageScriptCsp({ ...manifest, imports: { ...manifest.imports, react: "/ui/a/react-different.js" } }))
      .not.toBe(appPageScriptCsp(manifest));
  });

  it("hashes escaped emitted bytes, preserving script boundaries and JSON values", () => {
    const marker = "</script><script>unexpected()</script>";
    const manifest = { ...MANIFEST, imports: { ["entry-" + marker]: "/ui/a/runtime.js?text=" + marker + "\u2028\u2029" } };
    const html = render({ manifest });
    const match = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
    const bytes = match![1]!;
    expect(JSON.parse(bytes)).toEqual({ imports: manifest.imports });
    expect(bytes).not.toContain("</script>");
    expect(bytes).not.toMatch(new RegExp("[\u2028\u2029]"));
    expect(scriptTags(html)).toHaveLength(3);
    const emittedHash = createHash("sha256").update(bytes, "utf8").digest("base64");
    expect(appPageScriptCsp(manifest)).toContain("'sha256-" + emittedHash + "'");
    expect(emittedHash).not.toBe(createHash("sha256").update(JSON.stringify({ imports: manifest.imports })).digest("base64"));
  });

  it("keeps the legacy document and CSP free of any import-map requirement", () => {
    expect(render()).not.toContain('type="importmap"');
    expect(appPageScriptCsp(MANIFEST)).toBe("script-src 'self'");
  });
});
