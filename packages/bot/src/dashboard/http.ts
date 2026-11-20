/**
 * The panel's HTTP layer — the framework's, not ours.
 *
 * ── What this file replaces ─────────────────────────────────────────────────
 *
 * `server.ts` used to own a `createServer` callback, a 900-line `if`-chain that
 * matched method and pathname by hand, a `send()` that buffered and gzipped and
 * remembered the hardening headers, a `json()` on top of it, and a `body()` that
 * read a bounded stream. Every one of those is a generic HTTP concern with a
 * well-known failure list, and every one of them had already produced a real bug
 * here (413-then-continue, a route matched in two places, a header applied only
 * to responses that went through one helper).
 *
 * They are now, respectively: Fastify's router, `@fastify/compress`,
 * `@fastify/helmet`, Fastify's `bodyLimit` + one content-type parser, and a
 * single error handler.
 *
 * ── The three properties this assembly must hold ────────────────────────────
 *
 *  1. **Nothing is decided from a request header that a client controls.**
 *     `trustProxy` is off, so `request.ip` is the socket peer; the devpipe
 *     loopback check reads the socket directly anyway. There is no CORS plugin,
 *     because this panel has never sent an `Access-Control-Allow-Origin` and the
 *     Origin allowlist it does compute is consumed by the mutation gate, not by
 *     a browser preflight.
 *  2. **Validation may not answer before authorization does.** Fastify's own
 *     order is parse → validate → handler, and hooks registered `onRequest` run
 *     BEFORE the body is read. The gate therefore lives in `onRequest`
 *     (`server.ts`), which is what keeps a caller who should get 401/403/404
 *     from being told the shape of a body instead.
 *  3. **A schema that coerces is a comment.** `coerceTypes`, `useDefaults` and
 *     `removeAdditional` are all off, so a declared type REFUSES a wrong type
 *     rather than quietly rewriting the request into something plausible.
 *
 * ── Plugins deliberately NOT used ───────────────────────────────────────────
 *
 *  · `@fastify/cookie` — the panel's cookie names and attributes are decided
 *    together by `@claude-bot/web-trust` (`__Host-` requires `Secure`, and a
 *    deletion that omits it is silently dropped by the browser). A second
 *    serialiser is exactly the drift that contract exists to prevent.
 *  · `@fastify/session` / any session plugin — there is already one opaque
 *    server-side session model with revocation, idle and absolute expiry, and a
 *    credential handle that Contexts, streams and leases are keyed on.
 *  · `@fastify/cors` — see (1).
 *  · `@fastify/static` — `assets.ts` already resolves, canonicalises and
 *    allow-lists by extension, with no directory listing and no index fallback.
 *    A general static plugin would have to be configured back down to that.
 *  · `@fastify/rate-limit` — behind the reverse proxy every request shares one
 *    socket address, so the only key that separates users is the credential,
 *    and a limiter keyed on anything else collapses them together.
 */

import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyHelmet from "@fastify/helmet";
import { BUILD_ID_HEADER } from "@claude-bot/dashboard-web/contract";
import { parseJsonBodyText } from "@claude-bot/web-trust";

export type PanelRequest = FastifyRequest;
export type PanelReply = FastifyReply;
export type PanelApp = FastifyInstance;

/** Ceiling for a buffered request body. Enforced before a handler ever runs. */
const MAX_BODY_BYTES = 1_000_000;
/** Preserve node:http's old five-minute request-receive deadline. */
export const PANEL_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Deny-all baseline, as directives so one object feeds both helmet and the
 * string a page composes its own policy from.
 *
 * `frame-src` is absent, so `default-src 'none'` refuses every frame. The one
 * page that embeds one (`/sessions-plus`) appends the exact App origin — never a
 * wildcard, and never inherited by any other page.
 */
const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'none'"],
  // Workspace previews create Blob URLs from an already authorized file read.
  "img-src": ["'self'", "data:", "blob:"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "connect-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
};

/** The same policy as a header value, for the per-page overrides. */
export const DEFAULT_CSP = Object.entries(CSP_DIRECTIVES)
  .map(([name, values]) => `${name} ${values.join(" ")}`)
  .join("; ");

/**
 * Applied to every reply, so a route added later is hardened by construction
 * rather than by somebody remembering to call a helper. That property used to
 * come from `send()`, which the framework's serialiser replaced — this hook is
 * where it went.
 */
const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

export interface PanelAppOptions {
  /**
   * The bundle id this process publishes, or "" when there is no build. Read
   * per response and never allowed to throw: a composition with no frontend must
   * still answer its API routes.
   */
  buildId: () => string;
  /** Where a 500 goes. Kept out of this module so the logger stays one. */
  onInternalError: (err: unknown) => void;
}

/**
 * One JSON body reader for every content type, because callers here do not all
 * send one — the CLI shim, ops scripts and `fetch(..., {method:"POST"})` with no
 * body all reach routes that expect an object.
 *
 * Three outcomes, and the distinction between them is the point: an EMPTY body
 * is `{}` (a POST with nothing to say), MALFORMED JSON is a 400 that says so
 * (substituting `{}` turns "your JSON is broken" into "you forgot a field"), and
 * a non-object — `[1,2]`, `"hi"` — is a 400 as well, so no handler ever indexes
 * into an array believing it has named fields.
 */
function jsonBodyParser(
  _req: PanelRequest,
  body: string,
  done: (err: Error | null, value?: unknown) => void,
): void {
  const parsed = parseJsonBodyText(body);
  if (parsed.ok) {
    done(null, parsed.body);
    return;
  }
  done(Object.assign(new Error(parsed.message), { statusCode: 400, code: "PANEL_BAD_JSON" }));
}

/**
 * Build the panel's Fastify instance: plugins, parsers, error and 404 plumbing.
 *
 * Routes are NOT registered here. They are registered by `server.ts` inside two
 * encapsulated scopes, which is what makes "is this route behind the gate?" a
 * structural question instead of one answered by reading an if-chain to its end.
 */
export function buildPanelApp(options: PanelAppOptions): PanelApp {
  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    // Fastify defaults to no deadline. This port may be reached directly, so a
    // client must not be able to reserve a socket forever by dribbling a body.
    // Five minutes is the node:http default the transport migration replaced.
    requestTimeout: PANEL_REQUEST_TIMEOUT_MS,
    logger: false,
    // Never. The devpipe loopback rule and the session cookie's `Secure` flag
    // are both decisions this process makes about the network it is on; a
    // forwarded header is something the caller writes.
    trustProxy: false,
    // One method per registered route. Without this Fastify would answer HEAD
    // for every GET, and the panel's authorization table has no HEAD rules —
    // a routed request the gate then refuses is a route that reads as served.
    exposeHeadRoutes: false,
    ajv: {
      customOptions: {
        // A schema that rewrites the request has not validated it. With
        // coercion on, `{persona: {}}` becomes the string "[object Object]"
        // and the declared type has said nothing.
        coerceTypes: false,
        useDefaults: false,
        removeAdditional: false,
        allErrors: false,
      },
    },
  });

  // Fastify ships higher-priority application/json AND text/plain parsers. A
  // catch-all alone therefore does not mean "every content type": text/plain
  // would stay a string and bodyOf() would silently turn it into {}. Remove the
  // built-ins first so every caller follows the panel's one JSON contract.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, jsonBodyParser);

  void app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: Object.fromEntries(
        Object.entries(CSP_DIRECTIVES).map(([name, values]) => [name, [...values]]),
      ),
    },
    // The approval surface must not be framable: a clickjacked approval is a
    // real human click on somebody else's dangerous call. Helmet's default is
    // SAMEORIGIN, and this panel is never framed by anything, including itself.
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    // TLS termination belongs to the reverse proxy, and HSTS is STICKY: a
    // browser that sees it will refuse plain http for this host for months.
    // Turning it on is an operator decision about a domain that hosts other
    // services, not something a transport migration should do silently.
    hsts: false,
    // Neither is sent today, and both change how a document may be embedded or
    // share a browsing-context group. `/sessions-plus` frames a separate origin
    // and hands it a MessagePort; that boundary is expressed by an exact
    // `frame-src` and by the App origin's own headers, not by these.
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
  });

  // Transcript JSON and page HTML compress ~8×, which on a slow uplink is the
  // difference between seconds and minutes. The hand-written version called
  // `gzipSync` on the event loop; this one streams, negotiates properly
  // (q-values, `identity`, `x-no-compression`) and manages `vary` itself.
  //
  // Live streams are unaffected: an SSE route hijacks its reply, so no `onSend`
  // hook — this one included — ever sees it.
  void app.register(fastifyCompress, {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip", "deflate"],
  });

  app.addHook("onSend", async (req, reply, payload) => {
    void reply.header("permissions-policy", PERMISSIONS_POLICY);
    // On EVERY reply, not only the compressed ones. `@fastify/compress` adds it
    // when it acts, which is correct for the response it produced but leaves an
    // uncompressed one cacheable under a key that ignores `accept-encoding` —
    // the hand-written sender set it unconditionally and a shared cache is
    // entitled to rely on that.
    if (!reply.getHeader("vary")) void reply.header("vary", "accept-encoding");
    // Which bundle this server is currently publishing. An open tab compares it
    // against the id it booted with and OFFERS a refresh — it is never forced to
    // reload, because its own bundle is immutable and complete.
    const id = options.buildId();
    if (id) void reply.header(BUILD_ID_HEADER, id);
    return revalidatedJson(req, reply, payload);
  });

  /**
   * Every refusal the framework raises, in the panel's own shape.
   *
   * The wording is load-bearing: the browser reads `error`, the security tests
   * assert on it, and two of these strings ("请求体过大", "不是合法 JSON") name
   * distinctions the hand-written reader had already got right.
   */
  app.setErrorHandler((rawErr, _req, reply) => {
    const err = rawErr as Error & { statusCode?: number; code?: string; validation?: unknown };
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 500) options.onInternalError(err);
    const message =
      err.code === "FST_ERR_CTP_BODY_TOO_LARGE"
        ? "请求体过大"
        : err.validation
          ? `请求参数不合法: ${err.message}`
          : err.message;
    // `reply.raw.headersSent` rather than `reply.sent`: a hijacked stream owns
    // its socket, and writing a JSON error into a half-sent event stream is
    // worse than the error itself.
    if (reply.raw.headersSent) {
      void reply.raw.end();
      return;
    }
    void reply
      .code(status)
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({ error: message }));
  });

  return app;
}

/**
 * Wrap a route handler so it obeys Fastify's `return reply` rule.
 *
 * ── The failure this prevents, which is not obvious ─────────────────────────
 *
 * An `async` handler that answers through `reply.send()` and then resolves
 * `undefined` makes Fastify send AGAIN (`wrap-thenable.js`: it only skips when
 * the payload is defined, or when the socket has already finished). With an
 * uncompressed reply the first send finishes synchronously and the second is a
 * no-op, so nothing shows. With a COMPRESSED one the first send is a pipeline
 * that has not finished yet, and the second send wins — the panel's pages came
 * back 200, with every header correct, and a zero-byte body.
 *
 * So: one wrapper, applied to every route, rather than `return reply` remembered
 * at the end of forty handlers. The hooks solve the same problem the other way —
 * they are callback-style and simply never call `done()` after answering, which
 * halts the chain outright instead of depending on what `reply.sent` says at
 * that instant.
 *
 * Hijacked replies are unaffected: Fastify skips a hijacked reply entirely.
 */
export function panelHandler(
  fn: (req: PanelRequest, reply: PanelReply) => void | Promise<void>,
): (req: PanelRequest, reply: PanelReply) => Promise<PanelReply> {
  return async (req, reply) => {
    await fn(req, reply);
    return reply;
  };
}

/** A JSON response, in the shape every panel route has always used. */
export function replyJson(reply: PanelReply, status: number, payload: unknown): void {
  void reply.code(status).type("application/json; charset=utf-8").send(JSON.stringify(payload));
}

/**
 * A validator for successful JSON reads, so a polling page that receives the
 * same body again gets a bodiless 304 instead (2026-10-15, egress).
 *
 * Runs after the handler, so authorization, capability checks and every side
 * effect of the read happen exactly as before; only an unchanged body is not
 * resent. `private, no-cache` lets the browser keep the body and makes it
 * revalidate on every use, which `fetch()` does transparently: the page still
 * sees a 200 with the identical body. Replies that already chose their own
 * caching (pages, bundles, `no-store`) or validator are left alone.
 */
function revalidatedJson(req: FastifyRequest, reply: FastifyReply, payload: unknown): unknown {
  if (req.method !== "GET" || reply.statusCode !== 200 || typeof payload !== "string") return payload;
  const type = reply.getHeader("content-type");
  if (typeof type !== "string" || !type.startsWith("application/json")) return payload;
  if (reply.getHeader("cache-control") !== undefined || reply.getHeader("etag") !== undefined) return payload;
  const etag = `W/"${createHash("sha256").update(payload).digest("base64url").slice(0, 32)}"`;
  void reply.header("etag", etag);
  void reply.header("cache-control", "private, no-cache");
  const presented = req.headers["if-none-match"];
  const candidates = typeof presented === "string" ? presented.split(",").map((value) => value.trim()) : [];
  if (!candidates.some((value) => value === "*" || value.replace(/^W\//, "") === etag.slice(2))) return payload;
  void reply.code(304);
  void reply.removeHeader("content-type");
  // `null`, not "": a 304 carries no body and therefore no Content-Length.
  return null;
}

/** A response with an explicit content type — pages, assets, the runner bundle. */
export function replyBody(
  reply: PanelReply,
  status: number,
  contentType: string,
  body: string | Buffer,
  extraHeaders?: Record<string, string>,
): void {
  void reply.code(status).type(contentType);
  if (extraHeaders) void reply.headers(extraHeaders);
  void reply.send(body);
}

/**
 * The parsed body of a request the framework has already validated.
 *
 * Always an object: the content-type parser refuses anything else with a 400
 * before a handler runs, and a request with no body at all parses to `{}`. The
 * old `body()` returned `null` on refusal and every caller had to remember to
 * bail — the compiler enumerated those call sites once, and now the framework
 * removes the case entirely.
 */
export function bodyOf(req: PanelRequest): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * The request URL, for the handlers that read a query string.
 *
 * Built from the RAW url rather than from Fastify's parsed `query`, because the
 * panel's existing readers take a `URLSearchParams` and because `/ui/` needs the
 * still-encoded pathname — `assets.ts` does its own decoding and traversal
 * checks, and handing it a pre-decoded path would move that decision.
 */
export function panelUrl(req: PanelRequest): URL {
  return new URL(req.raw.url ?? "/", "http://localhost");
}
