/**
 * The listener that serves Agent View documents, and nothing else.
 *
 * ── One listener, every App this host publishes ─────────────────────────────
 *
 * It used to be called `SessionPlusViewServer` and it was handed one hosted
 * app's publication. Nothing in the body was ever about Session Plus: a request
 * arrives, its `Host` is split into a digest LABEL, and that label is looked up.
 * The name was the only thing tying it to one app, and a name that says "this
 * serves Session Plus" is the reason a declared App could be declared,
 * installed, activated — and still not be openable in a browser.
 *
 * So it is `AppViewServer`, and the publication it resolves through spans the
 * whole catalog (`AppReleaseHost.publishedLabels` / `.documentFor`). That is
 * safe for exactly one reason, and it is worth stating: a label is
 * `app-<first 20 hex of packageDigest>`, and the package digest covers the
 * stable app id and the publisher. Two apps therefore cannot mint the same
 * label except by finding a digest collision, and the catalog refuses to answer
 * ambiguously anyway (see `AppReleaseHost.documentFor`).
 *
 * ── Why it is a second server rather than a route ───────────────────────────
 *
 * A path on the panel (`/sessions-plus/view`) would be SAME ORIGIN: the frame
 * would carry the session cookie, could read the parent DOM, and could call
 * every API with the browser's ambient credentials. `sandbox="allow-scripts"`
 * without `allow-same-origin` does give the frame an opaque origin even then —
 * but one attribute would be all that stands between the two trust domains, and
 * the first person to add `allow-same-origin` "to fix scrolling" would delete
 * the boundary without touching anything called security. A separate origin
 * makes the browser enforce it, so the sandbox attribute is the second lock and
 * not the only one.
 *
 * ── Why this remains in the control plane after M2 ──────────────────────────
 *
 * This class publishes digest-addressed static bytes; it does not execute App
 * backend logic. Keeping publication in the trusted control plane prevents a
 * compromised Runtime from changing which bytes a release URL names. Dynamic
 * action/projection code and durable state are the pieces split into supervised
 * Runtime and State child processes.
 *
 * ── What the response contract buys ─────────────────────────────────────────
 *
 * Headers come from `@claude-bot/web-trust` (`viewFrameHeaders`), shared with
 * the v3 Host's own view frame. On top of that, four refusals that are specific
 * to being a separate host:
 *
 *   · **`Host` is validated, never trusted.** Nothing here is derived from it —
 *     the CSP and the origin come from configuration. It is compared so that a
 *     misconfigured proxy fails loudly instead of serving the package under a
 *     name that does not match its digest.
 *   · **Exactly one request target is served**, the bare document. Any other
 *     path, any query and any non-read method is a 404/405 that never re-serves
 *     app code — and, just as importantly, is never written down. See the long
 *     note in `handle()`: the whole request target is attacker-chosen, so this
 *     origin is the confinement for a browser residual rather than a place to
 *     log one.
 *   · **No `Set-Cookie`, ever.** A cookie on this host is a cookie a sibling can
 *     aim at, and the view has no session to keep.
 *   · **No CORS headers.** There is no API on this origin to share, and
 *     `connect-src 'none'` blocks the view's active connection APIs anyway.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { viewFrameHeaders } from "@claude-bot/web-trust";
import { createLogger } from "../logger.js";
import { viewHostFor, type SessionPlusOriginPolicy } from "../app-core/settings.js";
import { renderViewDocument, type PublishedViewDocument } from "../app-core/view-app.js";

const log = createLogger("app-view");

/**
 * Where the bytes for one digest label come from.
 *
 * A port rather than a direct registry import, and the shape is the whole point:
 * the only key is the LABEL. This listener cannot ask for "the current release",
 * "whatever is newest" or "app X's release" — it can only ask what a specific
 * digest names, so serving one package's bytes under another package's hostname
 * is not an operation that exists here. The catalog-wide implementation is
 * `AppReleaseHost.publishedLabels` / `.documentFor`.
 */
export interface ViewPublication {
  /** Which labels this host publishes right now. Exact membership, no prefixes. */
  publishedLabels(): Set<string>;
  /** That label's document under this response nonce, or null. */
  documentFor(label: string, nonce: string): Promise<PublishedViewDocument | null>;
}

/**
 * What this listener needs to know about the deployment it serves.
 *
 * Structurally the SERVING subset of `SessionPlusSettings` — the origin policy,
 * where to bind, who may frame, and one release's label for the no-publication
 * fallback. Deliberately not the whole settings object: this listener has no
 * business reading grants, a permission contract or an App's manifest, and a
 * type that cannot name them is a stronger statement than a comment saying it
 * does not. `SessionPlusSettings` satisfies it structurally, so the composition
 * root passes the same object it always did.
 */
export interface AppViewServerSettings {
  /** Exact origin, no trailing slash. Reported; also the no-publication host check. */
  viewOrigin: string;
  /** The `Host` header value the no-publication path requires, as it appears in the URL. */
  viewHostHeader: string;
  /** How an App hostname is built, so the label can be split off exactly. */
  origin: SessionPlusOriginPolicy;
  listenHost: string;
  listenPort: number;
  /** Exactly who may frame these documents. Never a wildcard, never empty. */
  frameAncestors: readonly string[];
  /** The release this deployment resolved at startup. Logged; the fallback label. */
  identity: { packageDigest: string; packageHostLabel: string };
}

/** `app-` + 20 lowercase hex, and nothing else, ever. */
const PACKAGE_LABEL = /^app-[0-9a-f]{20}$/;

/**
 * Split a `Host` header into the release label this deployment would serve.
 *
 * Purely syntactic, and deliberately strict: the suffix must equal the
 * configured app domain exactly (not end with it — `evil-apps.example.com` ends
 * with nothing useful, but `x.apps.example.com.attacker.tld` is the shape a
 * suffix test lets through), the port must be the configured public one, and the
 * label must be the exact digest form. Returns null for everything else.
 */
export function labelFromHost(policy: SessionPlusOriginPolicy, host: string): string | null {
  if (!host || host.length > 253 + 6) return null;
  const [authority, ...extra] = host.split(":");
  if (extra.length > 1) return null;
  const port = extra[0];
  const implied = policy.scheme === "https:" ? "443" : "80";
  const wanted = policy.publicPort === null ? null : String(policy.publicPort);
  if (wanted === null) {
    if (port !== undefined && port !== implied) return null;
  } else if (port !== wanted) {
    return null;
  }
  const name = String(authority ?? "").toLowerCase();
  const dot = name.indexOf(".");
  if (dot < 0) return null;
  const label = name.slice(0, dot);
  const domain = name.slice(dot + 1);
  if (domain !== policy.domain.toLowerCase()) return null;
  return PACKAGE_LABEL.test(label) ? label : null;
}

export interface ViewServerStats {
  /** Documents served. */
  served: number;
  /** Requests refused because the `Host` header was not the configured one. */
  wrongHost: number;
  /**
   * Requests refused because the target was not the bare document.
   *
   * The tripwire for the browser confinement residual: a sandboxed frame can
   * navigate its own browsing context, so a View that wants to signal outward
   * can put data in its own URL — in the query (`/?leak=…`) or in the path
   * (`/leak…`), which are equally attacker-chosen. It cannot reach any other
   * origin (the embedder's `frame-src` is exact), and here it gets a 404 with no
   * app code and **no record of what it tried to say**: this number is the whole
   * signal, deliberately, because a counter cannot carry a payload and a log
   * line can.
   */
  refusedTargets: number;
  /**
   * Document requests that arrived carrying ANY cookie.
   *
   * Should be 0 forever: the panel's cookies are host-only and this is a
   * different host. It is counted rather than assumed because the failure is
   * invisible otherwise — a `Domain` cookie added by a future deployment would
   * start riding along in silence, and this is the number that would say so.
   */
  withCookies: number;
  /**
   * Requests whose `Host` had the right SHAPE but named a release this host does
   * not publish. Counted apart from `wrongHost` because they mean different
   * things: a wrong host is a misconfigured proxy, an unknown release is a stale
   * DNS record or a tab left open across an uninstall.
   */
  unknownRelease: number;
}

export class AppViewServer {
  private server: Server | null = null;
  private bound = 0;
  /** One breadcrumb per server instance; see `noticeOnce`. */
  private noticed = false;
  readonly stats: ViewServerStats = { served: 0, wrongHost: 0, withCookies: 0, refusedTargets: 0, unknownRelease: 0 };

  /**
   * The publication this listener resolves labels through.
   *
   * Optional so a composition with no registry (the boundary tests, and the
   * documented single-release deployment) still serves exactly the settings'
   * release — the fallback answers only for the configured label and only from
   * this build's bytes, which is what it did before releases were installable.
   */
  constructor(
    private settings: AppViewServerSettings,
    private readonly publication?: ViewPublication,
    /**
     * Extra EXACT origins that may frame these documents, beyond the panel's
     * own (`external-app-host/v1`).
     *
     * Deployment-level and static, deliberately. A published document is
     * immutable and cacheable, so its `content-security-policy` may not depend
     * on anything per-user or per-binding: a policy that widened while one
     * person held a binding would be cached and then served to everyone. What
     * this list says is an operator statement of the same shape the allowlist
     * already is — "these origins are trusted shells for this deployment's
     * Apps" — and it is validated as exact origins by `viewFrameCsp`, which
     * refuses a wildcard, an empty entry, or anything carrying a second
     * directive.
     *
     * Framing is not authority: the View still gets no credential, still has
     * `connect-src 'none'`, and still does nothing at all until a parent hands
     * it a MessagePort. Nothing else in the policy moves.
     */
    private readonly externalFrameAncestors: readonly string[] = [],
  ) {}

  /** The panel's own origins plus the operator's external shells. */
  private frameAncestors(): readonly string[] {
    return this.externalFrameAncestors.length
      ? [...this.settings.frameAncestors, ...this.externalFrameAncestors]
      : this.settings.frameAncestors;
  }

  /**
   * Point the listener at another release's deployment settings.
   *
   * What actually moves is the reported origin and the frame-ancestors policy;
   * WHICH releases resolve is the publication's answer and does not change here.
   * Called after an activation of the app this deployment took its origin policy
   * from.
   */
  useSettings(settings: AppViewServerSettings): void {
    this.settings = settings;
  }

  get port(): number {
    return this.bound;
  }

  /** The origin this listener is supposed to be reachable as. */
  get origin(): string {
    return this.settings.viewOrigin;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        log.error({ err }, "view request failed");
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("view unavailable");
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.settings.listenPort, this.settings.listenHost, () => resolve());
      });
    } catch (err) {
      // A failed listen leaves a live `Server` object holding whatever it did
      // manage to open. Keeping it in `this.server` made `port`/`stop()` lie
      // about a listener that never came up — and the caller, seeing a throw,
      // would never call `stop()` anyway. So the failure cleans up after
      // itself and the instance stays honestly unstarted.
      server.close();
      server.removeAllListeners();
      throw err;
    }
    this.server = server;
    const addr = this.server.address();
    this.bound = typeof addr === "object" && addr ? addr.port : this.settings.listenPort;
    log.info(
      {
        listen: `${this.settings.listenHost}:${this.bound}`,
        origin: this.settings.viewOrigin,
        packageDigest: this.settings.identity.packageDigest,
        frameAncestors: this.frameAncestors(),
        publication: this.publication ? "catalog" : "single-release",
      },
      "agent view origin listening",
    );
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.bound = 0;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** True only between a successful `start()` and `stop()`. */
  get listening(): boolean {
    return this.server !== null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      // The view is a static document. Nothing here accepts input, so anything
      // that is not a read is a caller with the wrong idea about this origin.
      // Counted with the other refusals and, like them, not described.
      this.stats.refusedTargets += 1;
      this.noticeOnce();
      return this.plain(res, 405, "method not allowed", { allow: "GET, HEAD" });
    }

    // Validated, not trusted: the comparison target is configuration. A proxy
    // that rewrites Host fails here instead of serving a package under a name
    // that does not describe it.
    //
    // What the header DOES decide is which release is served — and that is the
    // only thing it decides. `labelFromHost` accepts nothing but the exact
    // `app-<20 hex>.<configured domain>` shape, and the label is then used as a
    // lookup key, never as a path, a prefix or a default.
    const host = String(req.headers.host ?? "");
    const pathMode = this.settings.origin.pathPrefix;
    const rawUrl = req.url ?? "/";
    let label = pathMode ? null : this.labelFor(host);
    const hostMatches = pathMode
      ? host.toLowerCase() === viewHostFor(this.settings.origin, "").toLowerCase()
      : Boolean(label);
    if (!hostMatches) {
      this.stats.wrongHost += 1;
      // `Host` is logged where the request target is not, and the difference is
      // real: a browser sets `Host` from the URL's authority, so a View cannot
      // choose it, while it chooses the path and query freely. Without this line
      // a proxy that rewrites Host is undiagnosable.
      log.warn({ host, expected: this.expectedHostShape() }, "view request with an unexpected Host header");
      return this.plain(
        res,
        421,
        `此监听器只服务 ${this.expectedHostShape()}(Agent View 的 digest 地址)。收到的 Host:${host || "(空)"}`,
      );
    }

    // ── The self-navigation residual, and the only place it can be closed ──
    //
    // `connect-src 'none'` blocks fetch/XHR/WebSocket/EventSource. It does NOT
    // stop a sandboxed frame from navigating its OWN browsing context, and no
    // CSP directive available in Chrome 1.62 does (`navigate-to` is not
    // recognised). Measured, not assumed: a View that runs
    // `location.href = "./?leak=…"` produces a real request here.
    //
    // External destinations are refused by the embedder's exact `frame-src`,
    // so what remains is a navigation to THIS origin, and this listener is
    // where it either becomes a recorded exfiltration channel or does not:
    //
    //   · **the whole request target is attacker-controlled**, not just the
    //     query. `/?leak=secret` and `/leak-is-the-path` carry a value equally
    //     well, so both are refused and NEITHER is written down. Nothing in
    //     this function logs `req.url`, any part of it, or a length taken from
    //     it — a "path-only" log line is still a log line containing whatever
    //     the View chose to put in the path. The counter below is the entire
    //     signal, and the reverse-proxy example turns App-host access logging
    //     off for exactly the same reason;
    //   · the refusal never re-serves the package, so the frame cannot reload
    //     its own code under an attacker-chosen URL;
    //   · there is no API and no second path on this origin to aim at.
    //
    // What is left is a stated browser residual rather than a hidden one: the
    // request itself reaches the network stack, so a self-navigation is visible
    // to anyone who can observe connections at all — we remove the RECORD, not
    // the packet. It carries only what was declassified to this package, and it
    // lands on a first-party static origin that answers 404.
    if (pathMode && rawUrl.startsWith(pathMode)) {
      // Match the raw target: URL normalization must not turn traversal,
      // queries or alternate encodings into a published document.
      const matched = /^(app-[0-9a-f]{20})\/(?:index\.html)?$/.exec(rawUrl.slice(pathMode.length));
      label = matched?.[1] ?? null;
    }
    if (pathMode ? !label : rawUrl !== "/" && rawUrl !== "/index.html") {
      // One document, no asset tree, no query. Everything is inlined under the
      // nonce, so a second URL on this origin could only be somewhere to put
      // something that is not the digested package.
      this.stats.refusedTargets += 1;
      this.noticeOnce();
      return this.plain(res, 404, "not found");
    }

    if (req.headers.cookie) {
      this.stats.withCookies += 1;
      if (!pathMode) log.error(
        { host },
        "Agent View 的文档请求带上了 Cookie — 主站 Cookie 必须是 host-only,请检查是否有人给 Cookie 加了 Domain",
      );
    }

    const nonce = randomUUID().replace(/-/g, "");
    const document = await this.documentFor(label!, nonce);
    if (document === null) {
      // The name is well formed and belongs to this deployment's app domain, but
      // no installed release answers to it — a stale DNS record, or a tab open
      // across an uninstall. Refused without naming anything, like every other
      // target this origin does not serve.
      this.stats.unknownRelease += 1;
      return this.plain(res, 404, "not found");
    }
    const ancestors = this.frameAncestors();
    const headers = document.policy.kind === "hash"
      ? viewFrameHeaders({
          scriptHash: document.policy.scriptHash,
          styleHash: document.policy.styleHash,
          frameAncestors: ancestors,
        })
      : viewFrameHeaders({ nonce: document.policy.nonce, frameAncestors: ancestors });
    headers["cache-control"] = document.immutable
      ? "public, max-age=31536000, immutable"
      : "no-store";
    this.stats.served += 1;
    res.writeHead(200, { ...headers, "content-length": String(Buffer.byteLength(document.body, "utf8")) });
    if (method === "HEAD") return void res.end();
    res.end(document.body);
  }

  /**
   * The label this request names, or null.
   *
   * With a publication attached the label comes from the configured app domain,
   * so any installed release resolves. Without one the deployment serves exactly
   * the settings' release, which is the pre-registry behaviour and the shape a
   * pinned `view_origin` describes.
   */
  private labelFor(host: string): string | null {
    if (this.publication) return labelFromHost(this.settings.origin, host);
    return this.hostOk(host) ? this.settings.identity.packageHostLabel : null;
  }

  /**
   * The name shape a caller should have used, for the 421 body and its log line.
   *
   * With a publication attached this listener serves EVERY installed release of
   * every app in the catalog, so naming one release's hostname would send an
   * operator chasing the wrong release. Without one it serves exactly the
   * configured origin, and that exact string is the useful answer.
   */
  private expectedHostShape(): string {
    if (this.settings.origin.pathPrefix) return this.settings.viewHostHeader;
    if (!this.publication) return this.settings.viewHostHeader;
    const port = this.settings.origin.publicPort;
    return `app-<20 位十六进制>.${this.settings.origin.domain}${port === null ? "" : `:${port}`}`;
  }

  /**
   * Two refusals, deliberately distinguished.
   *
   * A `Host` that is not the right SHAPE is a misconfigured proxy (421 — "this
   * listener does not serve that name"). A well-formed name for a release this
   * host does not publish is a stale DNS record or a tab left open across an
   * uninstall (404 — "nothing here"). Collapsing them would make one of those
   * two very different operator problems undiagnosable.
   */
  private async documentFor(label: string, nonce: string): Promise<PublishedViewDocument | null> {
    if (!this.publication) return label === this.settings.identity.packageHostLabel ? renderViewDocument(nonce) : null;
    if (!this.publication.publishedLabels().has(label)) return null;
    return await this.publication.documentFor(label, nonce);
  }

  /**
   * Say once, per server instance, that a refusal happened — and say nothing about it.
   *
   * An operator needs a breadcrumb telling them to go look at
   * `stats.refusedTargets`; they do not need, and must not be given, the value
   * the View was trying to smuggle. So this line contains no path, no query, no
   * length and no count: it is a pointer to a counter.
   */
  private noticeOnce(): void {
    if (this.noticed) return;
    this.noticed = true;
    log.warn(
      "Agent View origin refused a request target that was not the bare document. "
        + "Self-navigation is confined here; the target is never recorded. "
        + "Read AppViewServer.stats.refusedTargets for the count.",
    );
  }

  /**
   * Accept the configured host, and — when the origin uses a default port —
   * the same name with that port spelled out, because a proxy may pass either.
   */
  private hostOk(host: string): boolean {
    const want = this.settings.viewHostHeader;
    if (host === want) return true;
    const url = new URL(this.settings.viewOrigin);
    if (url.port) return false;
    const implied = url.protocol === "https:" ? "443" : "80";
    return host === `${url.hostname}:${implied}`;
  }

  private plain(res: ServerResponse, status: number, text: string, extra?: Record<string, string>): void {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(text);
  }
}
