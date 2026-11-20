/**
 * The reverse proxy's "should I get a certificate for this name?" endpoint.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * A digest-addressed origin means every release has its own hostname. With one
 * exact site block per release, publishing is an operator editing a proxy config
 * — which is precisely the thing a hot update must not require. On-demand TLS
 * removes the edit, but it also means the proxy will otherwise try to obtain a
 * certificate for ANY name that resolves to this machine, which is both a way to
 * burn an issuance rate limit and a way to make this host answer to names nobody
 * chose. Caddy's `ask` closes that: before issuing, it asks a URL whether the
 * name is one this deployment actually serves.
 *
 * ── The three rules, and what each one is for ───────────────────────────────
 *
 *  1. **Loopback only.** This endpoint answers a question about which releases
 *     exist here. Bound to a routable address it is an enumeration API, so the
 *     configuration refuses a non-loopback bind rather than warning about it,
 *     and the listener asserts the peer address as a second, independent check.
 *  2. **Syntax first, catalog second, and nothing else ever.** The name must be
 *     exactly `app-<20 lowercase hex>.<configured app domain>`; then the label
 *     must be one the registry publishes. There is no DNS lookup, no network
 *     call and no wildcard — an `ask` handler that reached the network would put
 *     a resolver on the certificate path.
 *  3. **Fail closed, and say nothing.** Anything that is not an exact match is a
 *     403 with an empty body. The name being asked about is attacker-chosen (it
 *     is whatever arrived in TLS SNI), so it is never echoed and never logged.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createLogger } from "../logger.js";
import { labelFromHost } from "./view-server.js";
import type { SessionPlusOriginPolicy } from "../app-core/settings.js";

const log = createLogger("app-origin-ask");

export interface OriginAskStats {
  allowed: number;
  refused: number;
  /** Requests that did not come from the loopback interface. Should be 0. */
  nonLoopback: number;
}

export interface OriginAskOptions {
  host: string;
  port: number;
  /** How an App hostname is built, so the suffix is compared exactly. */
  policy?: SessionPlusOriginPolicy;
  /** Which digest labels this host publishes right now. */
  publishedLabels?: () => Set<string>;
  /** Other exact, already-provisioned origins served by this process. */
  additionalAllowedHost?: (host: string) => boolean;
}

/** Exactly the loopback literals. A name would need resolving; a resolver is a dependency. */
function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const clean = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (clean === "::1") return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean);
  return Boolean(v4 && v4.slice(1).every((n) => Number(n) <= 255));
}

export class AppOriginAskServer {
  private server: Server | null = null;
  private bound = 0;
  readonly stats: OriginAskStats = { allowed: 0, refused: 0, nonLoopback: 0 };

  constructor(private readonly options: OriginAskOptions) {}

  get port(): number {
    return this.bound;
  }

  get listening(): boolean {
    return this.server !== null;
  }

  /** The URL a Caddy `on_demand_tls { ask … }` block should be given. */
  get askUrl(): string {
    return `http://${this.options.host}:${this.bound}/ask`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.port, this.options.host, () => resolve());
      });
    } catch (err) {
      server.close();
      server.removeAllListeners();
      throw err;
    }
    this.server = server;
    const addr = server.address();
    this.bound = typeof addr === "object" && addr ? addr.port : this.options.port;
    log.info(
      { listen: `${this.options.host}:${this.bound}`, appDomain: this.options.policy?.domain ?? null },
      "app origin ask endpoint listening (loopback only)",
    );
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.bound = 0;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // Independent of the bind address: a deployment that misconfigures the bind,
    // or a future one that puts this behind something, still fails closed here.
    if (!isLoopbackPeer(req.socket.remoteAddress ?? undefined)) {
      this.stats.nonLoopback += 1;
      log.error("app origin ask received a non-loopback request; refusing");
      return this.answer(res, 403);
    }
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return this.answer(res, 405);

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      this.stats.refused += 1;
      return this.answer(res, 403);
    }
    if (url.pathname !== "/ask") {
      this.stats.refused += 1;
      return this.answer(res, 404);
    }
    const domain = url.searchParams.get("domain") ?? "";
    const label = this.options.policy ? labelFromHost(this.options.policy, domain) : null;
    const appAllowed = Boolean(label && this.options.publishedLabels?.().has(label));
    const additionalAllowed = !appAllowed && this.options.additionalAllowedHost?.(domain.toLowerCase()) === true;
    if (!appAllowed && !additionalAllowed) {
      this.stats.refused += 1;
      return this.answer(res, 403);
    }
    this.stats.allowed += 1;
    this.answer(res, 200);
  }

  /**
   * The answer is the status code. No body, no echo of the name, no header that
   * varies with it: Caddy reads the status, and everything else would only be a
   * place to put something an attacker chose.
   */
  private answer(res: ServerResponse, status: number): void {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": "0",
      "cache-control": "no-store",
    });
    res.end();
  }
}
