/**
 * The browser-trust rules, tested once instead of twice-and-differently.
 *
 * Each `describe` below corresponds to a row on which the two former copies had
 * drifted. That is the reason this package exists: not deduplication, but that
 * the next person to fix one of these should not have to know how many copies
 * there are.
 */

import { describe, expect, it } from "vitest";
import { MemorySessionStore, WebSessions } from "./sessions.js";
import { allowedOrigins, cookieSecure, originOk, readCookie, secretEquals } from "./origin.js";
import { mutationGate, parseJsonBodyText, type CredentialChannel } from "./gate.js";

function gate(o: {
  method?: string;
  via: CredentialChannel;
  origin?: string;
  allowed?: readonly string[];
  /** Absent = no session secret to double-submit, i.e. the no-token loopback mode. */
  csrfOk?: boolean;
}): { ok: boolean; code?: string } {
  const out = mutationGate({
    method: o.method ?? "POST",
    via: o.via,
    origin: o.origin,
    allowed: o.allowed ?? [],
    csrf: o.csrfOk === undefined ? undefined : { presented: "x", ok: () => o.csrfOk !== false },
  });
  return out.ok ? { ok: true } : { ok: false, code: out.code };
}

const PANEL = allowedOrigins({ publicUrl: "https://panel.example.com" });
const LOOPBACK = allowedOrigins({ loopbackPort: 9820 });

describe("the mutation gate turns on the ambient/presented distinction", () => {
  it("a safe method is never gated, whatever the channel", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(gate({ method, via: "cookie", origin: undefined }).ok).toBe(true);
    }
  });

  it("a cookie session needs BOTH an exact Origin and the double-submit secret", () => {
    const base = { via: "cookie" as const, allowed: PANEL, csrfOk: true };
    expect(gate({ ...base, origin: "https://panel.example.com" }).ok).toBe(true);
    expect(gate({ ...base, origin: "https://evil.test" })).toEqual({ ok: false, code: "origin" });
    expect(gate({ ...base, origin: "https://panel.example.com", csrfOk: false })).toEqual({ ok: false, code: "csrf" });
    // A cross-site form submit sends no Origin at all in some browsers; refuse.
    expect(gate({ ...base, origin: undefined })).toEqual({ ok: false, code: "origin" });
  });

  it("a bearer passes: a cross-site page cannot set an Authorization header", () => {
    expect(gate({ via: "bearer", origin: undefined }).ok).toBe(true);
  });

  it("with no session secret the Origin check stands alone", () => {
    // The no-token loopback mode. It used to be a channel of its own; it is
    // just "no csrf verifier", which the gate already models.
    expect(gate({ via: "cookie", origin: "http://127.0.0.1:9820", allowed: LOOPBACK }).ok).toBe(true);
    expect(gate({ via: "cookie", origin: "https://evil.test", allowed: LOOPBACK })).toEqual({
      ok: false,
      code: "origin",
    });
  });

  it("an unconfigured surface accepts nothing — the empty list is a real answer", () => {
    expect(gate({ via: "cookie", origin: "https://panel.example.com", allowed: [] })).toEqual({
      ok: false,
      code: "origin",
    });
  });
});

describe("where a request came from is not something the request states", () => {
  it("a configured canonical origin is the only thing accepted", () => {
    expect(originOk("https://panel.example.com", PANEL)).toBe(true);
    // The classic proxy trick: the attacker controls Host and sets Origin to
    // match it. With a configured list, agreeing with yourself proves nothing —
    // and there is no longer a parameter through which to try.
    expect(originOk("https://evil.test", PANEL)).toBe(false);
    expect(originOk("http://panel.example.com", PANEL)).toBe(false);
    expect(originOk(undefined, PANEL)).toBe(false);
  });

  it("takes the allowlist and nothing from the request but the Origin", () => {
    // Two parameters, and the second one was computed at startup. There is no
    // shape here through which `Host` or `x-forwarded-proto` could arrive.
    expect(originOk.length).toBe(2);
  });

  it("the allowlist is decided at startup, from config or from the bound port", () => {
    expect(allowedOrigins({ publicUrl: "https://panel.example.com" })).toEqual(["https://panel.example.com"]);
    // Port included: a browser on some OTHER local service is a different origin.
    expect(allowedOrigins({ loopbackPort: 9820 })).toEqual([
      "http://127.0.0.1:9820",
      "http://localhost:9820",
      "http://[::1]:9820",
    ]);
    // Unusable config and no config both accept nothing, rather than everything.
    expect(allowedOrigins({ publicUrl: "not a url" })).toEqual([]);
    expect(allowedOrigins({})).toEqual([]);
  });

  it("Secure follows the configured URL, not a header", () => {
    expect(cookieSecure("https://panel.example.com")).toBe(true);
    expect(cookieSecure("http://127.0.0.1:9820")).toBe(false);
    expect(cookieSecure(undefined)).toBe(false);
    expect(cookieSecure("not a url")).toBe(false);
  });
});

describe("secrets and cookies", () => {
  it("comparison is constant time and length-blind", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    // Different lengths must not throw, which a raw timingSafeEqual would.
    expect(secretEquals("a", "aaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("reads one cookie without being fooled by a value containing '='", () => {
    expect(readCookie("a=1; sess=eyJ=x; b=2", "sess")).toBe("eyJ=x");
    expect(readCookie("a=1", "sess")).toBe("");
    expect(readCookie(undefined, "sess")).toBe("");
  });
});

describe("sessions fail closed on every axis", () => {
  function fresh(now: () => number): WebSessions {
    return new WebSessions(new MemorySessionStore(), { idleMs: 1000, absoluteMs: 10_000 }, now);
  }

  it("resolves, then refuses after idle, after absolute expiry, and after revocation", () => {
    let t = 1_000_000;
    const s = fresh(() => t);
    const a = s.issue("alice");
    expect(s.resolve(a.sessionId)?.username).toBe("alice");
    t += 1001;
    expect(s.resolve(a.sessionId)).toBeNull(); // idle

    t = 1_000_000;
    const b = fresh(() => t);
    const c = b.issue("alice");
    t += 10_001;
    expect(b.resolve(c.sessionId)).toBeNull(); // absolute

    t = 1_000_000;
    const d = fresh(() => t);
    const e = d.issue("alice");
    d.revoke(e.sessionId);
    expect(d.resolve(e.sessionId)).toBeNull();
  });

  it("an unreadable timestamp is expired, not immortal", () => {
    // `NaN > x` is false for every comparison, so a corrupt row would otherwise
    // read as "not expired" forever.
    const store = new MemorySessionStore();
    const s = new WebSessions(store, { idleMs: 1000, absoluteMs: 10_000 }, () => 1_000_000);
    const issued = s.issue("alice");
    for (const field of ["absoluteExpiry", "lastSeenAt", "createdAt"] as const) {
      const row = store.live()[0];
      const good = row[field];
      store.put({ ...row, [field]: NaN });
      expect(s.resolve(issued.sessionId), field).toBeNull();
      store.put({ ...row, [field]: good });
    }
    expect(s.resolve(issued.sessionId)).not.toBeNull();
  });

  it("the csrf secret is checked against a hash, and an absent one fails", () => {
    const s = fresh(() => 1_000_000);
    const issued = s.issue("alice");
    const resolved = s.resolve(issued.sessionId)!;
    expect(s.csrfOk(resolved, issued.csrf)).toBe(true);
    expect(s.csrfOk(resolved, "wrong")).toBe(false);
    expect(s.csrfOk(resolved, undefined)).toBe(false);
  });
});

/**
 * The size ceiling moved to Fastify's `bodyLimit` on both surfaces — it refuses
 * before a handler exists, which is the one thing a hand-written reader could
 * never guarantee (the panel used to answer 413 and then run the handler with
 * `{}`, so an oversized POST to `/api/deploy` deployed the default target).
 *
 * What stayed here is the part the framework does not decide: what an empty,
 * malformed or non-object body MEANS. Both surfaces register this as their
 * content-type parser, so the three answers cannot drift.
 */
describe("a malformed body is REFUSED, never substituted", () => {
  it("never yields a body alongside a refusal", () => {
    const out = parseJsonBodyText("{not json");
    expect(out.ok).toBe(false);
    expect(out).not.toHaveProperty("body");
  });

  it("malformed JSON is the caller's mistake, not a missing field", () => {
    expect(parseJsonBodyText("{not json")).toMatchObject({ ok: false, message: expect.stringContaining("JSON") });
    // An array or a scalar is not an object of arguments either.
    expect(parseJsonBodyText("[1,2]")).toMatchObject({ ok: false });
    expect(parseJsonBodyText('"hi"')).toMatchObject({ ok: false });
    expect(parseJsonBodyText("null")).toMatchObject({ ok: false });
  });

  it("an empty body is an empty object, which is a legitimate request", () => {
    expect(parseJsonBodyText("")).toEqual({ ok: true, body: {} });
    expect(parseJsonBodyText("   \n ")).toEqual({ ok: true, body: {} });
  });

  it("an object survives verbatim — no coercion, no defaults, no stripping", () => {
    expect(parseJsonBodyText('{"a":1,"b":{"c":[2]}}')).toEqual({ ok: true, body: { a: 1, b: { c: [2] } } });
  });
});
