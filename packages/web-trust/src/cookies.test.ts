/**
 * The cookie contract, which is a pairing rather than a name.
 *
 * Every assertion here is about a property a BROWSER enforces and a server can
 * only get wrong: `__Host-` without `Secure` is a cookie that is never stored,
 * a `Domain` on the same name is the sibling-domain bypass the prefix exists to
 * close, and a retired name that is still read is that bypass with extra steps.
 */

import { describe, expect, it } from "vitest";
import {
  HOST_PREFIX,
  clearCookie,
  clearSessionCookies,
  cookieContract,
  csrfCookieCandidates,
  issueSessionCookies,
  serializeCookie,
} from "./cookies.js";

const base = { session: "octopus_sess", csrf: "octopus_csrf" };

describe("the name follows the Secure decision", () => {
  it("is host-prefixed on a secure deployment and retires the plain pair", () => {
    const c = cookieContract({ base, secure: true, retired: ["octopus_dash"] });
    expect(c.names).toEqual({ session: "__Host-octopus_sess", csrf: "__Host-octopus_csrf" });
    expect(c.hostPrefixed).toBe(true);
    expect(c.retired).toEqual(["octopus_sess", "octopus_csrf", "octopus_dash"]);
  });

  it("falls back to the plain pair on plain http, and retires the prefixed one", () => {
    // Not a weaker production contract — a different deployment. `__Host-`
    // demands Secure, and a Secure cookie on http is a cookie the browser
    // never sends back, so the http box would simply have no login at all.
    const c = cookieContract({ base, secure: false, retired: ["octopus_dash"] });
    expect(c.names).toEqual(base);
    expect(c.hostPrefixed).toBe(false);
    expect(c.retired).toEqual(["__Host-octopus_sess", "__Host-octopus_csrf", "octopus_dash"]);
  });

  it("never retires a name it is currently issuing", () => {
    // The guard that matters if somebody retires a name that is also the base
    // name: clearing it in the same response that sets it is a logout.
    const c = cookieContract({ base, secure: false, retired: ["octopus_sess"] });
    expect(c.retired).not.toContain("octopus_sess");
  });
});

describe("serialisation refuses what the browser would silently drop", () => {
  const ok = { path: "/", sameSite: "Lax" as const, maxAgeS: 60, secure: true };

  it("emits the production attribute set, in one string", () => {
    const s = serializeCookie(`${HOST_PREFIX}octopus_sess`, "abc", { ...ok, httpOnly: true });
    expect(s).toBe("__Host-octopus_sess=abc; HttpOnly; Path=/; SameSite=Lax; Max-Age=60; Secure");
  });

  it("throws for a __Host- cookie without Secure", () => {
    expect(() => serializeCookie(`${HOST_PREFIX}x`, "v", { ...ok, secure: false })).toThrow(/Secure/);
  });

  it("throws for a __Host- cookie with a Domain — the tossing vector itself", () => {
    expect(() => serializeCookie(`${HOST_PREFIX}x`, "v", { ...ok, domain: "example.org" })).toThrow(/Domain/);
  });

  it("throws for a __Host- cookie scoped below the root", () => {
    expect(() => serializeCookie(`${HOST_PREFIX}x`, "v", { ...ok, path: "/app" })).toThrow(/Path=\//);
  });

  it("leaves an unprefixed name alone — the dev path stays expressible", () => {
    expect(serializeCookie("octopus_sess", "abc", { ...ok, secure: false, httpOnly: true })).toBe(
      "octopus_sess=abc; HttpOnly; Path=/; SameSite=Lax; Max-Age=60",
    );
  });
});

describe("deletion obeys the prefix too", () => {
  it("clears a __Host- name WITH Secure and Path=/", () => {
    // A deletion is an ordinary Set-Cookie, so the browser applies the prefix
    // constraints to it as well: without `Secure` the delete is rejected and
    // the session cookie stays in the jar while logout answers 200.
    const c = clearCookie("__Host-octopus_sess");
    expect(c).toBe("__Host-octopus_sess=; Path=/; SameSite=Lax; Max-Age=0; Secure");
  });

  it("clears an unprefixed name without inventing Secure", () => {
    // Deletion matches on name/path/domain, so a plain name needs no Secure —
    // and adding it would make the delete unusable on the http deployment where
    // that name is the live one.
    expect(clearCookie("octopus_dash")).toBe("octopus_dash=; Path=/; SameSite=Lax; Max-Age=0");
  });
});

describe("the contract is the only opinion about Secure", () => {
  it("derives the transport attribute from the contract, not from a parameter", () => {
    // The old signature took `secure` again here, which made it possible to
    // select a host-prefixed NAME and serialize it under contradictory
    // transport attributes — the one combination this module exists to forbid.
    const set = issueSessionCookies(cookieContract({ base, secure: true }), {
      sessionId: "s",
      csrf: "c",
      maxAgeS: 60,
    });
    expect(set[0]).toContain("__Host-octopus_sess=s");
    expect(set[0]).toContain("Secure");
  });

  it("refuses a hand-built contract whose names and flag disagree", () => {
    const lying = { names: { session: "__Host-a", csrf: "__Host-b" }, hostPrefixed: false, retired: [] };
    expect(() => issueSessionCookies(lying, { sessionId: "s", csrf: "c", maxAgeS: 60 })).toThrow(/inconsistent/);
    expect(() => clearSessionCookies(lying)).toThrow(/inconsistent/);
  });
});

describe("the CSRF name a page must look for", () => {
  it("prefers the prefixed name on https and the plain one on http", () => {
    // The rule, not a guess: `__Host-` requires Secure, Secure requires https.
    expect(csrfCookieCandidates(base, true)[0]).toBe("__Host-octopus_csrf");
    expect(csrfCookieCandidates(base, false)[0]).toBe("octopus_csrf");
    // The other spelling stays as a second candidate for a mid-upgrade page.
    expect(csrfCookieCandidates(base, true)[1]).toBe("octopus_csrf");
  });

  it("agrees with the name the server actually issues", () => {
    for (const https of [true, false]) {
      const contract = cookieContract({ base, secure: https });
      expect(csrfCookieCandidates(base, https)[0]).toBe(contract.names.csrf);
    }
  });
});

describe("login and logout both carry the migration", () => {
  const secure = cookieContract({ base, secure: true, retired: ["octopus_dash"] });

  it("a fresh login sets the two live cookies and clears every retired name", () => {
    const set = issueSessionCookies(secure, { sessionId: "s1", csrf: "c1", maxAgeS: 3600 });
    expect(set[0]).toContain("__Host-octopus_sess=s1");
    expect(set[0]).toContain("HttpOnly");
    // The CSRF half is readable on purpose: page JS echoes it into a header.
    expect(set[1]).toContain("__Host-octopus_csrf=c1");
    expect(set[1]).not.toContain("HttpOnly");
    for (const dead of ["octopus_sess", "octopus_csrf", "octopus_dash"]) {
      expect(set.some((s) => s.startsWith(`${dead}=; `) && s.includes("Max-Age=0")), dead).toBe(true);
    }
    expect(set.join("\n")).not.toContain("Domain=");
  });

  it("logout clears the live pair as well as the retired names, each validly", () => {
    const cleared = clearSessionCookies(secure);
    expect(cleared).toHaveLength(5);
    for (const c of cleared) expect(c).toContain("Max-Age=0");
    expect(cleared[0]).toContain("__Host-octopus_sess=;");
    // The half that used to be missing: the prefixed deletions carry Secure, so
    // the browser accepts them instead of ignoring them.
    for (const c of cleared) {
      if (c.startsWith("__Host-")) expect(c, c).toContain("Secure");
      expect(c, c).not.toContain("Domain=");
      expect(c, c).toContain("Path=/");
    }
  });
});
