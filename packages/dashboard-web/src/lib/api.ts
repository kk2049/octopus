import { uiText } from "../i18n/ui-text.js";
/**
 * The one place the browser talks to this server.
 *
 * ── Why it is one place ─────────────────────────────────────────────────────
 *
 * The hand-built pages wrapped `window.fetch` in the document head so that two
 * dozen call sites across six pages could not each forget the CSRF header. That
 * worked, but it made every third-party or future script inherit the behaviour
 * and made "which requests carry the secret" a question about a monkey patch.
 * A module the whole app imports gives the same single point of discipline
 * without touching a global.
 *
 * ── The rules, and the failure each one prevents ────────────────────────────
 *
 *  1. **Same-origin only, always relative.** `request()` refuses anything that
 *     resolves off this origin. The CSRF secret is a same-site credential; the
 *     way it leaks is a request that leaves the site carrying it.
 *  2. **The CSRF header goes on unsafe methods only.** GET/HEAD/OPTIONS never
 *     carry it, matching the server's `mutationGate`, which only demands it for
 *     unsafe methods on a cookie credential.
 *  3. **The cookie NAME is a deployment fact.** An https panel issues
 *     `__Host-octopus_csrf`; a plain-http one issues `octopus_csrf`. Both
 *     spellings come from the server (`csrfCookieNames` in the bootstrap), in
 *     the server's own preference order. A page that looked for the retired
 *     spelling would find nothing, send no header, and turn every mutation into
 *     a 403 — which is exactly what happened the last time this list was
 *     hard-coded in a page script.
 *  4. **No automatic retry, ever, at this layer.** One call is one request.
 *     Some GETs on this server traverse the capability kernel and a refused
 *     read can materialise a pending approval card, and no mutation is
 *     idempotent. Repeating a read is the query layer's decision
 *     (`lib/query.ts`): it retries only ordinary GETs after a network or 5xx
 *     failure, and the capability-bearing reads are not queried at all.
 *  5. **An empty body is words, not a parser crash.** A reverse proxy 502 while
 *     the bot restarts used to surface as "Unexpected end of JSON input".
 *  6. **No credentials are persisted.** No token, session id or CSRF value is
 *     ever written to `localStorage`, `sessionStorage`, a URL or a log line.
 *     The separate browser-drafts module stores only bounded user-authored
 *     textarea text; it never receives anything from this request layer.
 */

import { BUILD_ID_HEADER } from "../contract.js";
import { bootstrap } from "./bootstrap.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** An error that still knows what the server actually answered. */
export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable code when the server supplied one. */
  readonly code: string | null;
  /** The parsed body, when there was one. Useful for 409/202 payloads. */
  readonly body: Record<string, unknown> | null;

  constructor(
    message: string,
    status: number,
    code: string | null = null,
    body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Same-origin check on the resolved URL, not on the string that was passed. */
function sameOrigin(path: string): boolean {
  try {
    return new URL(path, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * The CSRF secret, read from the cookie the server set.
 *
 * Split-and-compare rather than a built regular expression: the name goes into
 * a string comparison, so there is no escaping question to get wrong. The value
 * is not itself a credential — the server compares the presented header against
 * the hash it stored, so a wrong value is refused rather than believed.
 */
export function csrfSecret(names: readonly string[] = bootstrap.csrfCookieNames): string {
  const parts = (document.cookie || "").split(";");
  for (const name of names) {
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== name) continue;
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return "";
}

export interface RequestOptions {
  method?: string;
  /** Serialised as JSON with the right content type. */
  json?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Survives page unload (`/api/session-plus/close` on `pagehide`). */
  keepalive?: boolean;
  /**
   * Statuses that are a normal answer rather than a failure. 202 and 409 carry
   * meaning on the session-append route and must reach the caller as data.
   */
  expect?: readonly number[];
}

/** Latest build id the server reported, for stale-tab detection. */
let observedBuildId: string | null = null;
const buildListeners = new Set<(id: string) => void>();

/** Session expiry is document-wide: one 401 stops every later `api()` poll. */
let expired = false;
const expiryListeners = new Set<() => void>();
const expiredError = () => new ApiError(uiText("登录已过期，请重新登录"), 401, "unauthenticated");

export function sessionExpired(): boolean {
  return expired;
}

export function subscribeSessionExpired(listener: () => void): () => void {
  expiryListeners.add(listener);
  return () => expiryListeners.delete(listener);
}

function markSessionExpired(): never {
  if (!expired) {
    expired = true;
    for (const listener of [...expiryListeners]) listener();
  }
  throw expiredError();
}

/** Test isolation only; a production document clears this state by reloading. */
export function resetSessionExpiredForTests(): void {
  expired = false;
}

export function onServerBuildChanged(fn: (id: string) => void): () => void {
  buildListeners.add(fn);
  return () => buildListeners.delete(fn);
}

function noteBuildId(res: Response): void {
  const id = res.headers.get(BUILD_ID_HEADER);
  if (!id || id === observedBuildId) return;
  observedBuildId = id;
  if (id !== bootstrap.buildId) for (const fn of buildListeners) fn(id);
}

/**
 * Raw response, with the origin and CSRF rules applied. Prefer {@link api}.
 */
export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  if (!sameOrigin(path)) {
    throw new ApiError(`refusing a cross-origin request to ${path}`, 0, "cross_origin");
  }
  const target = new URL(path, location.href);
  // The login exchange must be allowed to return its own 401 so the form can
  // say "密钥无效". Every other request shares one document login and stops as
  // soon as that login is known to be gone.
  const isLoginExchange = target.pathname === "/login";
  if (expired && !isLoginExchange) throw expiredError();
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers ?? {});
  if (options.json !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!SAFE_METHODS.has(method)) {
    const secret = csrfSecret();
    if (secret && !headers.has("x-csrf-token")) headers.set("x-csrf-token", secret);
  }
  const res = await fetch(path, {
    method,
    headers,
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
    signal: options.signal,
    keepalive: options.keepalive,
    // Cookies are same-origin here by definition; being explicit keeps a
    // future refactor from silently dropping the session.
    credentials: "same-origin",
    redirect: "follow",
  });
  noteBuildId(res);
  if (res.status === 401 && !isLoginExchange) markSessionExpired();
  return res;
}

/**
 * A parsed JSON answer, or a thrown {@link ApiError} carrying the server's own
 * wording. Refusal sentences on this server are written for the person reading
 * them, so they are passed through rather than replaced.
 */
export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await request(path, options);
  const text = await res.text();
  if (!text) {
    if (res.ok) return {} as T;
    throw new ApiError(
      uiText("HTTP {status} · 响应为空(服务可能正在重启),稍后重试", { status: res.status }),
      res.status,
      "empty_body",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(
      uiText("HTTP {status} · 响应不是 JSON:{body}", { status: res.status, body: text.slice(0, 120) }),
      res.status,
      "not_json",
    );
  }
  const body = (parsed && typeof parsed === "object" ? parsed : null) as Record<
    string,
    unknown
  > | null;
  const expected = options.expect?.includes(res.status) ?? false;
  if (!res.ok && !expected) {
    const message = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    const code = typeof body?.code === "string" ? body.code : null;
    throw new ApiError(message, res.status, code, body);
  }
  return parsed as T;
}

/** `?a=b` from a record, dropping empty values so no `?x=` noise is sent. */
export function query(params: Record<string, string | number | undefined | null>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    out.set(key, String(value));
  }
  const text = out.toString();
  return text ? `?${text}` : "";
}

/** Human-readable message for anything a fetch chain can reject with. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
