/**
 * Login cookie names and serialisation — one contract, both browser surfaces.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Cookies are not scoped by port and not scoped by scheme. Once a deployment
 * serves untrusted app code from a sibling host under the same registrable site
 * (`app-<digest>.apps.example.org` next to `bot.example.org`), the interesting
 * failure is no longer "somebody stole the cookie" but "somebody SET one": a
 * sibling that can write `octopus_sess=…; Domain=example.org` fixes a session on
 * the main site. The browser-side answer to that is the `__Host-` prefix, which
 * a browser only accepts when the cookie is `Secure`, `Path=/` and carries no
 * `Domain` at all — so a domain cookie of the same name is refused before it is
 * ever stored.
 *
 * That is a property of a NAME plus its attributes, which means it can only
 * hold if the two are decided together. Both surfaces in this repo used to
 * assemble their `Set-Cookie` strings by hand at four call sites, and the flags
 * had already drifted once (see the table in `index.ts`). So the name and the
 * serialisation live here, together, and the `__Host-` invariants are asserted
 * at serialisation time: an attempt to emit a `__Host-` cookie without `Secure`,
 * or with a `Domain`, throws instead of shipping a cookie the browser will
 * silently drop.
 *
 * ── The local-development path, and why it is a different NAME ──────────────
 *
 * `__Host-` requires `Secure`, and `Secure` is decided from the configured
 * public URL — never from a request header (`origin.ts`, `cookieSecure`). A
 * plain-http development box therefore cannot use a `__Host-` cookie at all: it
 * would be rejected by the browser and login would simply not work. Rather than
 * weaken the production contract with a "well, except on http" branch, the
 * contract picks a different NAME when it cannot be host-prefixed. One
 * deployment, one accepted name; the operator can read which one they are on
 * from the startup log.
 *
 * ── Migration, and why the old name is not kept as a sibling ────────────────
 *
 * Names that are not the contract's are RETIRED, not accepted-for-a-while: they
 * are cleared on login and on logout and never read. Keeping an old
 * non-prefixed name readable would leave exactly the sibling-domain bypass the
 * prefix exists to close — the attacker sets the old name with a `Domain` and
 * the server, being helpful, accepts it. A browser holding only the retired
 * cookie sees the login page and pastes its key once, which is what every
 * framework does when the session format changes.
 */

export interface CookieNames {
  session: string;
  csrf: string;
}

export interface CookieContract {
  /** The only names issued and the only names read. */
  names: CookieNames;
  /**
   * True when `__Host-` is in force, i.e. this deployment is https.
   *
   * This is also the `Secure` attribute: the prefix requires it, so the two are
   * one decision and `issueSessionCookies` takes no second opinion. A contract
   * whose names disagree with this flag is refused at serialization time.
   */
  hostPrefixed: boolean;
  /**
   * Names this deployment must actively clear and must never accept: the
   * other spelling of the same pair, plus anything explicitly retired.
   */
  retired: readonly string[];
}

export const HOST_PREFIX = "__Host-";

/**
 * The CSRF cookie names a browser page should look for, most-likely first.
 *
 * Page JS has to read that cookie to echo it into a header, so it needs the
 * name the SERVER issued — and a page that looks for the retired spelling finds
 * nothing and silently stops sending the header, which turns every mutation on
 * a production deployment into a 403. (That is precisely what happened when the
 * server moved to `__Host-` and two hard-coded client regexes did not.)
 *
 * The order is the deployment rule, not a guess: `__Host-` requires `Secure`,
 * `Secure` requires https, so an https page is looking at a prefixed jar and an
 * http page at a plain one. The other name is kept as a second candidate only so
 * that a mid-upgrade page still works; it is safe because the CSRF cookie is not
 * an authentication credential — the server compares the presented header
 * against the hash it stored, so reading the wrong value produces a REFUSAL,
 * never an acceptance. A sibling host cannot plant the prefixed name at all,
 * which is why the prefixed one is preferred wherever it can exist.
 */
export function csrfCookieCandidates(base: CookieNames, https: boolean): [string, string] {
  const prefixed = HOST_PREFIX + base.csrf;
  return https ? [prefixed, base.csrf] : [base.csrf, prefixed];
}

/**
 * Decide the names for one deployment.
 *
 * `secure` is the SAME boolean that decides the `Secure` attribute
 * (`cookieSecure(publicUrl)`), which is what keeps the pair consistent: a name
 * that demands `Secure` is only ever chosen when `Secure` is actually going on
 * the cookie.
 */
export function cookieContract(o: {
  base: CookieNames;
  secure: boolean;
  /** Dead names from earlier versions (e.g. a cookie that once held a bearer). */
  retired?: readonly string[];
}): CookieContract {
  const prefixed: CookieNames = {
    session: HOST_PREFIX + o.base.session,
    csrf: HOST_PREFIX + o.base.csrf,
  };
  const names = o.secure ? prefixed : o.base;
  const other = o.secure ? o.base : prefixed;
  const active = new Set([names.session, names.csrf]);
  const retired = [other.session, other.csrf, ...(o.retired ?? [])].filter((n) => !active.has(n));
  return { names, hostPrefixed: o.secure, retired: [...new Set(retired)] };
}

export interface CookieAttributes {
  /** `__Host-` requires exactly "/". */
  path: string;
  sameSite: "Lax" | "Strict" | "None";
  maxAgeS: number;
  secure: boolean;
  httpOnly?: boolean;
  /** Present only to be REFUSED for `__Host-` names; no caller sets it today. */
  domain?: string;
}

/**
 * One `Set-Cookie` value, with the prefix rules enforced rather than assumed.
 *
 * Throwing is deliberate. A `__Host-` cookie missing `Secure` is not a
 * degraded cookie, it is no cookie: the browser drops it and the only symptom
 * is a login that silently never sticks. A thrown error names the mistake at
 * the moment it is made.
 */
export function serializeCookie(name: string, value: string, a: CookieAttributes): string {
  if (name.startsWith(HOST_PREFIX)) {
    if (!a.secure) throw new Error(`cookie ${name} needs Secure (the __Host- prefix requires it)`);
    if (a.path !== "/") throw new Error(`cookie ${name} needs Path=/ (the __Host- prefix requires it)`);
    if (a.domain) throw new Error(`cookie ${name} must not carry Domain (the __Host- prefix forbids it)`);
  }
  const parts = [`${name}=${value}`];
  if (a.httpOnly) parts.push("HttpOnly");
  if (a.domain) parts.push(`Domain=${a.domain}`);
  parts.push(`Path=${a.path}`, `SameSite=${a.sameSite}`, `Max-Age=${a.maxAgeS}`);
  if (a.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Delete a cookie, with the prefix rules applied to the DELETION too.
 *
 * A deletion is an ordinary `Set-Cookie` with `Max-Age=0`, so the browser
 * evaluates the `__Host-` constraints on it exactly as it does on the cookie
 * that created the jar entry: a `__Host-` deletion without `Secure` (or with a
 * `Domain`, or with a narrower `Path`) is REJECTED, and the cookie it was
 * supposed to remove stays. That failure is invisible — logout answers 200 and
 * the browser is still carrying the session — so the attribute is derived from
 * the name here rather than left to a caller.
 */
export function clearCookie(name: string): string {
  // Same serializer as issuance, so the prefix assertions run on this path too.
  return serializeCookie(name, "", {
    path: "/",
    sameSite: "Lax",
    maxAgeS: 0,
    secure: name.startsWith(HOST_PREFIX),
  });
}

/**
 * The `Set-Cookie` set for a fresh login: the session id (HttpOnly), the CSRF
 * secret (deliberately readable, it is the double-submit half), and a deletion
 * for every retired name.
 *
 * `secure` is NOT a parameter. It used to be, and that was a way to select a
 * host-prefixed NAME and then serialize it under contradictory transport
 * attributes — the one combination this module exists to make unrepresentable.
 * The contract already decided both, so it is the only thing asked.
 */
export function issueSessionCookies(
  contract: CookieContract,
  o: { sessionId: string; csrf: string; maxAgeS: number },
): string[] {
  assertContractConsistent(contract);
  const attrs: CookieAttributes = {
    path: "/",
    sameSite: "Lax",
    maxAgeS: o.maxAgeS,
    secure: contract.hostPrefixed,
  };
  return [
    serializeCookie(contract.names.session, o.sessionId, { ...attrs, httpOnly: true }),
    serializeCookie(contract.names.csrf, o.csrf, attrs),
    ...contract.retired.map(clearCookie),
  ];
}

/** Logout clears the contract's own names AND everything retired. */
export function clearSessionCookies(contract: CookieContract): string[] {
  assertContractConsistent(contract);
  return [contract.names.session, contract.names.csrf, ...contract.retired].map(clearCookie);
}

/**
 * A hand-built contract whose names and `hostPrefixed` disagree is refused.
 *
 * `cookieContract()` cannot produce one, but the type is exported and a literal
 * is easy to write; the failure it would cause (a `__Host-` name serialized
 * without `Secure`, or a plain name silently claiming the prefix's protection)
 * is exactly what this file promises cannot happen.
 */
function assertContractConsistent(c: CookieContract): void {
  for (const name of [c.names.session, c.names.csrf]) {
    if (name.startsWith(HOST_PREFIX) !== c.hostPrefixed) {
      throw new Error(
        `cookie contract is inconsistent: name ${name} vs hostPrefixed=${String(c.hostPrefixed)}`,
      );
    }
  }
}
