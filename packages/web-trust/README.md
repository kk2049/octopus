# `@octo-kit/web-trust`

Dependency-free browser trust primitives for Node.js services that need several
web surfaces to enforce the same security decisions.

This package centralizes five rules that are easy to duplicate and dangerous to
let drift:

- exact startup-derived origin allowlists and constant-time secret comparison;
- cookie names coupled to their `Secure`, `Path`, `SameSite`, and `__Host-`
  requirements;
- bounded in-memory web sessions with absolute and idle expiry;
- mutation admission for safe methods, bearer credentials, cookies, Origin,
  and CSRF;
- a restrictive CSP and sandbox contract for untrusted iframe documents.

It also exports the dependency-free `frame-protocol` subpath: the bounded wire
vocabulary shared by a trusted host and an opaque-origin iframe.

## Install

```bash
pnpm add @octo-kit/web-trust
```

The package is ESM-only and requires Node.js `^22.19.0` or `>=24.0.0`.

The public package name is `@octo-kit/web-trust`. Releases follow Semantic
Versioning: incompatible trust-contract changes require a major version;
additive primitives use a minor version; compatible fixes use a patch version.

## Origin and mutation gates

Decide the canonical origins once from trusted startup configuration, then pass
the fixed list to request-time checks:

```ts
import { allowedOrigins, mutationGate } from "@octo-kit/web-trust";

const origins = allowedOrigins({ publicUrl: "https://control.example.com" });

const verdict = mutationGate({
  method: request.method,
  via: "cookie",
  origin: request.headers.origin,
  allowed: origins,
  csrf: {
    presented: request.headers["x-csrf-token"],
    ok: (presented) => sessions.csrfOk(session, presented),
  },
});

if (!verdict.ok) {
  // Reject without touching the protected resource.
}
```

`allowedOrigins` accepts only exact HTTP(S) origins. Invalid URLs, opaque
origins, and wildcard hosts produce an empty list. `mutationGate` allows safe
methods, treats bearer authentication as a separate non-browser channel, and
requires an allowed Origin plus the caller-supplied CSRF verifier for
cookie-backed mutations.

## Cookie contract

```ts
import {
  cookieContract,
  cookieSecure,
  issueSessionCookies,
} from "@octo-kit/web-trust";

const contract = cookieContract({
  base: { session: "app_session", csrf: "app_csrf" },
  secure: cookieSecure("https://control.example.com"),
});

const setCookie = issueSessionCookies(contract, {
  sessionId: "opaque-session-id",
  csrf: "opaque-csrf-secret",
  maxAgeS: 3600,
});
```

On HTTPS, the contract selects `__Host-` names and refuses any serialization
that would violate the prefix requirements. On plain HTTP loopback development,
it selects distinct non-prefixed names. Retired names are cleared and are never
accepted as compatibility credentials.

## Sandboxed frames

```ts
import {
  SANDBOX_ALLOW_SCRIPTS,
  viewFrameHeaders,
} from "@octo-kit/web-trust";

iframe.sandbox.value = SANDBOX_ALLOW_SCRIPTS;

const headers = viewFrameHeaders({
  nonce: crypto.randomUUID(),
  frameAncestors: ["https://control.example.com"],
});
```

The sandbox token set is deliberately only `allow-scripts`; adding
`allow-same-origin` removes the opaque-origin boundary. The CSP denies network
connections and undeclared content, uses a per-response nonce, and accepts only
exact frame ancestors. It does not authenticate the parent page or make iframe
navigation impossible; the embedder must still bind the window or MessagePort
to the frame element it created and serve untrusted documents from a dedicated
origin.

Use the protocol-only entry point when a browser bundle needs the shared message
constants without the Node.js session and hashing code:

```ts
import {
  BROWSER_DRAFT_KEY_MAX,
  BROWSER_DRAFT_TEXT_MAX,
  MSG,
  PORT_MESSAGE_BYTES,
  SESSION_PLUS_PROTOCOL,
  VIEW_HELLO,
} from "@octo-kit/web-trust/frame-protocol";
```

The additive `draft_read` / `draft_write` / `draft_update` messages are not
provider actions. They carry one bounded semantic key and lossy text over the
already private port; the trusted embedder binds viewer and exact release before
touching browser storage. Empty text is a tombstone. A View receives neither the
bound namespace nor storage access, and this package defines no server sync.

## Sessions and JSON bodies

`WebSessions` implements session issue, resolve, rotate, and revoke behavior
against the exported `SessionStore` interface. `MemorySessionStore` is suitable
for a fail-closed-on-restart host or tests; a long-running service should supply
a durable implementation. `parseJsonBodyText` returns a closed result union and
refuses malformed and non-object JSON payloads. If object keys cross a further
trust boundary, validate them against a closed schema before use.

## Trust boundary

This package supplies primitives, not a complete web framework. The caller is
responsible for TLS termination, authenticating bearer credentials, selecting
trusted startup configuration, binding sessions to application principals,
enforcing request body byte limits before parsing, and ensuring protected
resources are not touched after a failed gate. Audit cookie and frame settings
as pairs: names and attributes form one contract, as do sandbox tokens and CSP.
