/**
 * The view-frame CSP helper, held to the contract its docstring claims.
 *
 * The refusals below are the interesting half: a helper that promises "exact
 * origins" and then emits whatever it was handed as long as it lacks a `*` is a
 * helper whose promise is decorative. Every rejected value here is a string
 * that would have produced a valid-looking header carrying a second directive.
 */

import { describe, expect, it } from "vitest";
import { SANDBOX_ALLOW_SCRIPTS, viewFrameCsp, viewFrameHeaders } from "./frame.js";

const NONCE = "abcdef0123456789";

describe("frame-ancestors accepts only 'self' or an exact origin", () => {
  it("keeps the two shapes the surfaces actually use", () => {
    expect(viewFrameCsp({ nonce: NONCE, frameAncestors: ["'self'"] })).toContain("frame-ancestors 'self'");
    const csp = viewFrameCsp({
      nonce: NONCE,
      frameAncestors: ["https://bot.example.org", "http://127.0.0.1:9820", "http://[::1]:9820"],
    });
    expect(csp).toContain("frame-ancestors https://bot.example.org http://127.0.0.1:9820 http://[::1]:9820");
  });

  it("refuses anything that could smuggle a second directive or source", () => {
    const refused = [
      "https://*.apps.example.org",
      "*",
      "'none'",
      "",
      "  ",
      // A second directive after the entry — the case the old `*`-only check let through.
      "https://x.example; script-src 'unsafe-inline'",
      "https://x.example, https://evil.example",
      "https://x.example 'unsafe-inline'",
      // Not an origin: path, query, fragment, trailing slash, credentials.
      "https://x.example/",
      "https://x.example/app",
      "https://x.example?a=1",
      "https://x.example#f",
      "https://user:pw@x.example",
      // Not a fetch scheme.
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc",
      // Not a URL at all.
      "bot.example.org",
      "'unsafe-inline'",
    ];
    for (const a of refused) {
      expect(() => viewFrameCsp({ nonce: NONCE, frameAncestors: [a] }), a).toThrow(/frame-ancestors/);
    }
  });

  it("refuses an empty list — framing nowhere is a configuration mistake, not a policy", () => {
    expect(() => viewFrameCsp({ nonce: NONCE, frameAncestors: [] })).toThrow(/at least one/);
  });
});

describe("the nonce is validated as a nonce", () => {
  it("accepts a base64 token", () => {
    expect(viewFrameCsp({ nonce: "AbC0+/=_-xyz", frameAncestors: ["'self'"] })).toContain("'nonce-AbC0+/=_-xyz'");
  });

  it("refuses values that would end the directive early", () => {
    for (const bad of ["", "short", "abcdefgh ijklmnop", "abcdefgh;script-src *", "abcdefgh'", 'abc"defgh']) {
      expect(() => viewFrameCsp({ nonce: bad, frameAncestors: ["'self'"] }), bad).toThrow(/nonce/);
    }
  });
});

describe("immutable inline content is pinned by hash", () => {
  const scriptHash = "A".repeat(43) + "=";
  const styleHash = "b".repeat(43) + "=";

  it("accepts exact SHA-256 base64 values without enabling inline code generally", () => {
    const csp = viewFrameCsp({ scriptHash, styleHash, frameAncestors: ["'self'"] });
    expect(csp).toContain(`script-src 'sha256-${scriptHash}'`);
    expect(csp).toContain(`style-src 'sha256-${styleHash}'`);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("nonce-");
  });

  it("allows only local Blob-backed media inside an App frame", () => {
    const csp = viewFrameCsp({ scriptHash, styleHash, frameAncestors: ["'self'"] });
    expect(csp).toContain("img-src data: blob:");
    expect(csp).toContain("frame-src blob:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/(?:img|frame)-src[^;]*https?:/);
  });

  it("refuses malformed or header-shaped hashes", () => {
    for (const bad of ["", "short", "A".repeat(44), `${"A".repeat(43)};`]) {
      expect(() => viewFrameCsp({ scriptHash: bad, styleHash, frameAncestors: ["'self'"] })).toThrow(/hash/);
    }
  });
});

describe("the header set", () => {
  it("carries the policy and nothing that opens the origin up", () => {
    const h = viewFrameHeaders({ nonce: NONCE, frameAncestors: ["'self'"] });
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cache-control"]).toBe("no-store");
    expect(Object.keys(h)).not.toContain("access-control-allow-origin");
    expect(Object.keys(h)).not.toContain("set-cookie");
  });

  it("pins the sandbox token set", () => {
    expect(SANDBOX_ALLOW_SCRIPTS).toBe("allow-scripts");
  });
});
