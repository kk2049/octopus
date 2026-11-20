/**
 * `allowedOrigins()` — the list every mutation gate and every `frame-ancestors`
 * is built from, so what it refuses matters more than what it returns.
 *
 * The case that made this file necessary: `new URL("data:text/html,x").origin`
 * is the STRING `"null"`, and so are `javascript:` and `file:`. Returning that
 * put `"null"` into an allow-list — and `"null"` is exactly the `Origin` a
 * browser sends for a sandboxed or otherwise opaque document. A typo in
 * `public_url` could therefore configure a surface to accept state-changing
 * requests from any opaque origin, and it configured Session Plus with a
 * `frame-ancestors null` that only failed on the first request rather than at
 * startup.
 */

import { describe, expect, it } from "vitest";
import { allowedOrigins, originOk } from "./origin.js";

describe("a configured public URL", () => {
  it("yields exactly its origin", () => {
    expect(allowedOrigins({ publicUrl: "https://bot.example.org" })).toEqual(["https://bot.example.org"]);
    expect(allowedOrigins({ publicUrl: "http://localhost:9820" })).toEqual(["http://localhost:9820"]);
    // A default port is not part of a serialized origin.
    expect(allowedOrigins({ publicUrl: "https://bot.example.org:443" })).toEqual(["https://bot.example.org"]);
  });

  it("uses only the origin when the URL carries more than one", () => {
    // Extra parts are not an error: only the origin is ever used, and it is
    // well defined. Pinned so nobody "fixes" it into a refusal by surprise.
    expect(allowedOrigins({ publicUrl: "https://bot.example.org/panel?x=1#f" })).toEqual(["https://bot.example.org"]);
    expect(allowedOrigins({ publicUrl: "https://user:pw@bot.example.org" })).toEqual(["https://bot.example.org"]);
  });

  it("refuses every scheme that cannot express an origin", () => {
    // Each of these makes `URL.origin` the literal "null".
    for (const bad of [
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "about:blank",
      "blob:https://bot.example.org/1234",
      "ws://bot.example.org",
      "ftp://bot.example.org",
    ]) {
      expect(allowedOrigins({ publicUrl: bad }), bad).toEqual([]);
    }
  });

  it("refuses something that is not a URL", () => {
    expect(allowedOrigins({ publicUrl: "bot.example.org" })).toEqual([]);
    expect(allowedOrigins({ publicUrl: "   " })).toEqual([]);
  });

  it("refuses wildcard hostnames, including URL-decoded wildcards", () => {
    for (const bad of [
      "https://*.apps.example.com",
      "https://%2A.apps.example.com",
      "https://app-foo*bar.apps.example.com",
      "https://app-foo%2Abar.apps.example.com",
    ]) {
      expect(allowedOrigins({ publicUrl: bad }), bad).toEqual([]);
    }
  });

  it("never produces the string that means 'opaque'", () => {
    // The property, stated directly: whatever goes in, "null" never comes out.
    const inputs = ["data:x", "javascript:x", "file:///x", "https://ok.example", "nonsense", ""];
    for (const i of inputs) expect(allowedOrigins({ publicUrl: i }), i).not.toContain("null");
  });
});

describe("the loopback fallback", () => {
  it("is the three spellings of this machine on the bound port", () => {
    expect(allowedOrigins({ loopbackPort: 9820 })).toEqual([
      "http://127.0.0.1:9820",
      "http://localhost:9820",
      "http://[::1]:9820",
    ]);
  });

  it("is empty when the surface cannot say who it is", () => {
    expect(allowedOrigins({})).toEqual([]);
    expect(allowedOrigins({ loopbackPort: 0 })).toEqual([]);
  });
});

describe("membership", () => {
  it("refuses a missing Origin and the opaque one", () => {
    const allowed = allowedOrigins({ publicUrl: "https://bot.example.org" });
    expect(originOk("https://bot.example.org", allowed)).toBe(true);
    expect(originOk(undefined, allowed)).toBe(false);
    // "null" can only be accepted if something put it in the list — which is
    // now impossible, and this is the assertion that says so.
    expect(originOk("null", allowed)).toBe(false);
    expect(originOk("https://evil.example", allowed)).toBe(false);
  });
});
