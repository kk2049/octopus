/**
 * Turning `session_plus:` in the YAML into something that is safe to serve.
 *
 * ── The two things configuration must not be allowed to say ─────────────────
 *
 * 1. **A wildcard.** `frame-src https://*.apps.example.org` and `frame-ancestors
 *    https://*.example.org` each look like one line of convenience and are each a
 *    hole: the first lets the panel frame any package, the second lets any host
 *    frame the view and drive it. Both directions are exact origins here, and a
 *    `*` anywhere is a refusal rather than a warning.
 * 2. **A hostname that disagrees with the code.** The whole point of a
 *    digest-addressed origin is that the URL names the package. If the operator
 *    writes last release's hostname, the browser isolates the frame perfectly
 *    and the guarantee is still gone, because the label no longer identifies
 *    what is being served. So the configured origin's first label must equal
 *    `app-<first-20-hex of packageDigest>` — computed here, compared here.
 *
 * ── Why an unusable configuration is an error and not a silent "off" ────────
 *
 * The feature flag is closed by default and a missing block is simply off. But
 * `enabled: true` with a broken origin is an operator who believes the feature
 * is on. Answering that with silence produces the worst outcome available: a
 * control plane that looks configured and serves nothing. So `resolve()` reports
 * every problem it found, and the composition root refuses to start.
 *
 * ── The local-development path ──────────────────────────────────────────────
 *
 * `https://app-<digest>.apps.example.org` needs DNS and a certificate, which a
 * laptop has neither of. `http://app-<digest>.localhost:<port>` is accepted
 * instead, because every current browser resolves `*.localhost` to loopback
 * WITHOUT a hosts-file entry, and — the part that matters — it is a different
 * HOST, not merely a different port. Cookies are not port-scoped: serving the
 * view on another port of `localhost` would hand it the panel's session cookie
 * and quietly invalidate the whole exercise.
 */

import { allowedOrigins } from "@claude-bot/web-trust";
import { SESSION_RESOURCE_CATALOG } from "../session-resource/catalog.js";
import { sessionPlusIdentity, type SessionPlusIdentity } from "./identity.js";
import type { AppPackage } from "./view-app.js";
import { DEFAULT_MAX_HOSTED_APPS, MAX_HOSTED_APPS } from "./hosting-limits.js";

export { DEFAULT_MAX_HOSTED_APPS, MAX_HOSTED_APPS };

export interface SessionPlusYamlConfig {
  /** Missing or false is closed. */
  enabled?: boolean;
  /** Explicitly opt into digest-addressed paths on dashboard.public_url (including IP URLs). */
  shared_origin?: boolean;
  /**
   * The exact public origin the Agent View is served from, e.g.
   * `https://app-a74cf19708be421842fa.apps.example.org`.
   *
   * **This form PINS the hostname.** The leading label must match the active
   * release's package digest, which means activating a different release is
   * refused while it is set — correctly, because a deployment that wrote one
   * exact origin also wrote one exact reverse-proxy site block, and moving the
   * active pointer under it would serve the new package from a name that no
   * longer describes it. Use `app_domain` for hot release updates.
   */
  view_origin?: string;
  /**
   * The host SUFFIX every release of this app is served under, e.g.
   * `apps.example.org`. The origin is then `<scheme>://app-<20 hex>.<app_domain>`,
   * recomputed from whichever release is active — which is what makes an
   * activation visible in the address bar without an operator editing a site
   * block per version.
   */
  app_domain?: string;
  /** `https` (default) or `http`, and `http` only for the loopback dev path. */
  app_scheme?: string;
  /** Public port for the App origin, when the proxy does not terminate on 443/80. */
  app_public_port?: number;
  /** Local port the view listener binds. Defaults to the origin's port, else 9821. */
  view_port?: number;
  /** Local interface for that listener. Defaults to loopback — a proxy dials it. */
  view_host?: string;
  /**
   * Loopback port for the reverse proxy's on-demand-TLS `ask` endpoint. 0 or
   * absent leaves it unbuilt. See `app-registry/origin-ask.ts`.
   */
  origin_ask_port?: number;
  /** Interface for that endpoint. Loopback only; a routable value is refused. */
  origin_ask_host?: string;
  /** Hosted supervisor ceiling, including the compiled-in Session Plus App. */
  max_hosted_apps?: number;
  /** Owner → exact deployment-managed operation set. */
  grants?: Record<string, { operations?: string[]; auto_allow?: string[] }>;
}

/**
 * Where an App origin's name comes from, independent of which release is active.
 *
 * Splitting this out is what makes a hot activation expressible at all: the
 * hostname is `app-<label>.<domain>`, and only the label moves. `pinnedLabel`
 * records the legacy deployment shape, where the operator named one exact origin
 * and therefore also one exact proxy site block.
 */
export interface SessionPlusOriginPolicy {
  /** `https:` or `http:`, matching `URL.protocol`. */
  scheme: "https:" | "http:";
  /** Everything after `app-<label>.`, without a port. */
  domain: string;
  /** Public port, when it is not the scheme's default. */
  publicPort: number | null;
  /** Non-null when configuration named one exact origin. */
  pinnedLabel: string | null;
  /** Opt-in shared-origin publication; absent preserves per-release hostnames. */
  pathPrefix?: typeof SHARED_APP_VIEW_PATH;
}

export const SHARED_APP_VIEW_PATH = "/__octopus/apps/";

/** Document location is distinct from the origin used in browser CSP. */
export function viewUrlFor(policy: SessionPlusOriginPolicy, packageHostLabel: string): string {
  return `${viewOriginFor(policy, packageHostLabel)}${policy.pathPrefix ? `${policy.pathPrefix}${packageHostLabel}/` : "/"}`;
}

/** The origin one release is served from under a policy. */
export function viewOriginFor(policy: SessionPlusOriginPolicy, packageHostLabel: string): string {
  const authority = viewHostFor(policy, packageHostLabel);
  return `${policy.scheme}//${authority}`;
}

/** The `Host` header value that same release must arrive with. */
export function viewHostFor(policy: SessionPlusOriginPolicy, packageHostLabel: string): string {
  const host = policy.pathPrefix ? policy.domain : `${packageHostLabel}.${policy.domain}`;
  return policy.publicPort === null
    ? host
    : `${host}:${policy.publicPort}`;
}

export interface SessionPlusConfiguredGrant {
  owner: string;
  operations: readonly string[];
  autoAllow: readonly string[];
}

/** Loopback-only by default: in production a reverse proxy terminates TLS. */
export const DEFAULT_VIEW_PORT = 9821;
export const DEFAULT_VIEW_HOST = "127.0.0.1";

/** How much of a digest to show in a message; enough to compare by eye. */
const PREVIEW = 16;

export interface SessionPlusSettings {
  /** Exact origin, no trailing slash. Used for `frame-src` and the iframe src. */
  viewOrigin: string;
  /** Digest-addressed document URL for shared-origin deployments. */
  viewUrl?: string;
  /** The `Host` header the listener requires, as it appears in the URL. */
  viewHostHeader: string;
  /** How that origin is derived, so a new release can produce a new one. */
  origin: SessionPlusOriginPolicy;
  listenHost: string;
  listenPort: number;
  /** Loopback listener for the proxy's on-demand-TLS ask, or null. */
  originAsk: { host: string; port: number } | null;
  /** Exactly who may frame the view. Never a wildcard, never empty. */
  frameAncestors: readonly string[];
  identity: SessionPlusIdentity;
  /** True for the documented plain-http loopback path. */
  development: boolean;
  /** Validated deployment grants; each becomes one source=config intent row. */
  grants: readonly SessionPlusConfiguredGrant[];
  /** Process-wide supervisor ceiling, including Session Plus itself. */
  maxHostedApps: number;
}

export type SessionPlusSettingsForRelease =
  | { ok: true; settings: SessionPlusSettings }
  | { ok: false; error: string };

/**
 * The same deployment, serving a different release.
 *
 * A pinned origin refuses rather than silently serving new bytes from the old
 * name: the whole guarantee of a digest-addressed origin is that the label
 * identifies the package, and a deployment that wrote one exact origin also
 * wrote one exact proxy site block for it.
 */
export function sessionPlusSettingsFor(
  base: SessionPlusSettings,
  identity: SessionPlusIdentity,
): SessionPlusSettingsForRelease {
  const label = identity.packageHostLabel;
  if (base.origin.pinnedLabel && base.origin.pinnedLabel !== label) {
    return {
      ok: false,
      error:
        `session_plus.view_origin 把 Agent View 钉在了 ${base.origin.pinnedLabel}，`
        + `而这个 release 的主机名是 ${label}。`
        + "要在不重启的情况下切换 release，请改配 session_plus.app_domain（每个 release 自动得到自己的主机名），"
        + "并把反代改成受 ask 限制的 on-demand TLS。",
    };
  }
  return {
    ok: true,
    settings: {
      ...base,
      identity,
      viewOrigin: viewOriginFor(base.origin, label),
      ...(base.origin.pathPrefix ? { viewUrl: viewUrlFor(base.origin, label) } : {}),
      viewHostHeader: viewHostFor(base.origin, label),
    },
  };
}

export type SessionPlusResolution =
  | { enabled: false; errors: readonly [] }
  | { enabled: true; settings: SessionPlusSettings; errors: readonly [] }
  | { enabled: true; settings: null; errors: readonly string[] };

export interface ResolveInput {
  config: SessionPlusYamlConfig | undefined;
  /** `dashboard.public_url`; its origin is the only place a browser may frame from. */
  publicUrl?: string;
  /** The port the panel actually bound, for the loopback development path. */
  dashboardPort?: number;
  /** Test seam: resolve against another package so digests can be varied. */
  appPackage?: AppPackage;
  /**
   * The release this composition intends to serve.
   *
   * Defaults to what this checkout would publish, which is what a first boot
   * seeds. A composition that already has an active pointer passes that
   * release's identity instead — the configuration is validated against what
   * will actually be served, not against the source tree.
   */
  identity?: SessionPlusIdentity;
}

/**
 * Is this hostname one that only ever means "this machine"?
 *
 * Exact membership, never a substring test: `localhost` and anything under the
 * RFC 6761 special-use `.localhost` tree, the whole 127/8 loopback block, and
 * IPv6 `::1`. Deceptive names that merely CONTAIN the word — `localhost.evil.com`,
 * `evil-localhost`, `notlocalhost` — are not local, and the http development
 * path below is the one place where getting that wrong would put a plaintext
 * session on a network.
 */
function isLoopbackName(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  // 127/8, as an address rather than as a prefix string.
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(v4 && v4.slice(1).every((n) => Number(n) <= 255));
}

/**
 * Validate and complete the block. Never throws: the caller decides whether a
 * broken configuration is fatal (it is, at startup) or merely reportable.
 */
export function resolveSessionPlus(input: ResolveInput): SessionPlusResolution {
  const cfg = input.config;
  if (!cfg?.enabled) return { enabled: false, errors: [] };

  const errors: string[] = [];
  const identity = input.identity ?? sessionPlusIdentity(input.appPackage);
  const grants = configuredGrants(cfg.grants, errors);
  const maxHostedApps = configuredHostedAppLimit(cfg.max_hosted_apps, errors);

  const rawOrigin = String(cfg.view_origin ?? "").trim();
  const rawDomain = String(cfg.app_domain ?? "").trim();
  if (cfg.shared_origin !== undefined && typeof cfg.shared_origin !== "boolean") {
    errors.push("session_plus.shared_origin 必须是布尔值");
  }
  if (cfg.shared_origin && (rawOrigin || rawDomain || cfg.app_scheme || cfg.app_public_port !== undefined)) {
    errors.push("session_plus.shared_origin 从 dashboard.public_url 推导地址，不能同时配置 view_origin、app_domain、app_scheme 或 app_public_port");
    return { enabled: true, settings: null, errors };
  }
  if (rawOrigin && rawDomain) {
    errors.push(
      "session_plus 同时配置了 view_origin 与 app_domain,它们是两种互斥的部署形态:"
        + "view_origin 钉住一个精确主机名(每次发版都要改反代),app_domain 让每个 release 自动得到自己的主机名。请只留一个",
    );
    return { enabled: true, settings: null, errors };
  }
  if (!cfg.shared_origin && !rawOrigin && !rawDomain) {
    errors.push(
      "session_plus.enabled 为 true 但既没有配置 session_plus.app_domain 也没有 session_plus.view_origin;"
        + `本次构建的 Agent View 应当来自 <scheme>://${identity.packageHostLabel}.<你的 app 域>`,
    );
    return { enabled: true, settings: null, errors };
  }

  const policy = cfg.shared_origin
    ? sharedOriginPolicy(input.publicUrl, errors)
    : rawDomain
    ? domainPolicy(cfg, rawDomain, errors)
    : pinnedPolicy(rawOrigin, identity, errors);
  if (!policy) return { enabled: true, settings: null, errors };

  // A pinned deployment is checked against the origin the OPERATOR wrote, not
  // against the one this release would produce. Otherwise a hostname that is
  // wrong in two ways at once — last release's label AND the panel's own host —
  // would only ever report the first, and fixing that one would reveal the
  // second on the next restart.
  const viewOrigin = viewOriginFor(policy, policy.pinnedLabel ?? identity.packageHostLabel);
  let url: URL;
  try {
    url = new URL(viewOrigin);
  } catch {
    errors.push(`session_plus 推导出的 Agent View origin 不是合法 URL:${viewOrigin}`);
    return { enabled: true, settings: null, errors };
  }
  const loopback = isLoopbackName(url.hostname);

  // Who may frame it. Production: the configured panel URL and nothing else.
  // Development: the loopback origins of the port the panel actually bound —
  // the same list `allowedOrigins()` computes for the mutation gate, so the two
  // cannot disagree about what "this panel" means.
  let frameAncestors: string[] = [];
  if (input.publicUrl) {
    frameAncestors = allowedOrigins({ publicUrl: input.publicUrl });
    if (frameAncestors.length === 0) errors.push(`dashboard.public_url 不是合法 URL:${input.publicUrl}`);
  } else if (loopback && input.dashboardPort && input.dashboardPort > 0) {
    frameAncestors = allowedOrigins({ loopbackPort: input.dashboardPort });
  } else {
    errors.push(
      "启用 session_plus 需要知道主站的确切 origin:请配置 dashboard.public_url"
        + "(本机开发可以省略,但那时 view_origin 必须是 http://<label>.localhost:<port>)",
    );
  }

  // ── The PAIR, not the View on its own ────────────────────────────────────
  //
  // Validating the View in isolation misses the failure that matters, because
  // the property being bought is a relationship: the panel's cookies must not
  // reach the View. Cookies are scoped by HOST, not by origin — they ignore the
  // port entirely and (without `Secure`) the scheme too. So
  // `https://box:9820` + `https://box:9821` are two different origins, which
  // makes the browser's DOM boundary hold, while every cookie the panel sets is
  // sent to the View on its very first navigation. That deployment reads as
  // "isolated" and is not.
  if (!policy.pathPrefix) errors.push(...pairErrors(url, frameAncestors));

  const listenPort = cfg.view_port ?? (!policy.pathPrefix && url.port ? Number(url.port) : DEFAULT_VIEW_PORT);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    errors.push(`session_plus.view_port 不是合法端口:${String(cfg.view_port)}`);
  }
  const originAsk = askEndpoint(cfg, errors);
  if (policy.pathPrefix && originAsk) errors.push("shared_origin 使用主站证书，不支持 origin_ask_port");

  if (errors.length > 0) return { enabled: true, settings: null, errors };

  return {
    enabled: true,
    settings: {
      viewOrigin: url.origin,
      ...(policy.pathPrefix ? { viewUrl: viewUrlFor(policy, identity.packageHostLabel) } : {}),
      viewHostHeader: url.host,
      origin: policy,
      listenHost: cfg.view_host ?? DEFAULT_VIEW_HOST,
      listenPort,
      originAsk,
      frameAncestors,
      identity,
      development: url.protocol === "http:",
      grants,
      maxHostedApps,
    },
    errors: [],
  };
}

function sharedOriginPolicy(raw: string | undefined, errors: string[]): SessionPlusOriginPolicy | null {
  try {
    if (!raw || raw.includes("*")) throw new Error("missing exact origin");
    const url = new URL(raw);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackName(url.hostname)))) {
      throw new Error("invalid origin");
    }
    return {
      scheme: url.protocol as "https:" | "http:", domain: url.hostname,
      publicPort: url.port ? Number(url.port) : null, pinnedLabel: null,
      pathPrefix: SHARED_APP_VIEW_PATH,
    };
  } catch {
    errors.push("session_plus.shared_origin 需要确切的 HTTPS dashboard.public_url（仅本机允许 HTTP），不能带路径、查询或凭据");
    return null;
  }
}

function configuredHostedAppLimit(raw: unknown, errors: string[]): number {
  if (raw === undefined) return DEFAULT_MAX_HOSTED_APPS;
  if (Number.isInteger(raw) && Number(raw) >= 1 && Number(raw) <= MAX_HOSTED_APPS) {
    return Number(raw);
  }
  errors.push(
    `session_plus.max_hosted_apps 必须是 1–${MAX_HOSTED_APPS} 的整数（包含 Session Plus 本身）；收到:${String(raw)}`,
  );
  return DEFAULT_MAX_HOSTED_APPS;
}

/** The legacy shape: one exact origin, pinned to the release it names. */
function pinnedPolicy(
  raw: string,
  identity: SessionPlusIdentity,
  errors: string[],
): SessionPlusOriginPolicy | null {
  if (raw.includes("*")) {
    errors.push(`session_plus.view_origin 不接受通配符:${raw}。请写出精确 origin`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    errors.push(`session_plus.view_origin 不是合法 URL:${raw}`);
    return null;
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    errors.push(`session_plus.view_origin 只能是一个 origin(scheme + host + 可选端口),不能带路径/查询/凭据:${raw}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackName(url.hostname))) {
    errors.push(
      `session_plus.view_origin 必须是 https;只有明确的本机开发路径(http://${identity.packageHostLabel}.localhost:<port>)可以是 http。收到:${raw}`,
    );
  }
  const labels = url.hostname.split(".");
  const label = labels[0] ?? "";
  if (label !== identity.packageHostLabel) {
    errors.push(
      `session_plus.view_origin 的主机名与当前 release 的 package digest 不一致:`
        + `配置写的是 "${label}",当前 release 是 "${identity.packageHostLabel}"`
        + `(packageDigest=${identity.packageDigest.slice(0, PREVIEW)}…)。`
        + "digest 变了就说明 Agent View 的代码变了,URL 必须一起换,否则地址栏里的名字不再代表里面跑的东西",
    );
  }
  if (labels.length < 2) {
    errors.push(`session_plus.view_origin 的主机名没有 app 域后缀:${url.hostname}`);
    return null;
  }
  // Deliberately returns a policy even when the label is wrong: the remaining
  // checks — is this the panel's own host, do the schemes agree, is a public
  // page framing localhost — are about the origin as written, and reporting one
  // problem per restart is how a misconfiguration takes three deploys to fix.
  return {
    scheme: url.protocol as "https:" | "http:",
    domain: labels.slice(1).join("."),
    publicPort: url.port ? Number(url.port) : null,
    pinnedLabel: label,
  };
}

/** The hot-update shape: one host suffix, one label per release. */
function domainPolicy(
  cfg: SessionPlusYamlConfig,
  domain: string,
  errors: string[],
): SessionPlusOriginPolicy | null {
  if (domain.includes("*")) {
    errors.push(`session_plus.app_domain 不接受通配符:${domain}。它是一个精确的主机名后缀`);
    return null;
  }
  if (domain.includes("/") || domain.includes(":") || domain.startsWith(".") || domain.endsWith(".")) {
    errors.push(
      `session_plus.app_domain 只能是主机名后缀(例如 apps.example.com),不带 scheme、端口、路径或前后点:${domain}`,
    );
    return null;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)) {
    errors.push(`session_plus.app_domain 不是合法主机名:${domain}`);
    return null;
  }
  const rawScheme = String(cfg.app_scheme ?? "https").trim().toLowerCase().replace(/:$/, "");
  if (rawScheme !== "https" && rawScheme !== "http") {
    errors.push(`session_plus.app_scheme 只能是 https 或 http:${String(cfg.app_scheme)}`);
    return null;
  }
  if (rawScheme === "http" && !isLoopbackName(domain)) {
    errors.push(
      `session_plus.app_scheme=http 只支持本机开发路径(app_domain 必须是 localhost 之类的本机名)。收到:${domain}`,
    );
    return null;
  }
  let publicPort: number | null = null;
  if (cfg.app_public_port !== undefined && cfg.app_public_port !== null) {
    const port = Number(cfg.app_public_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`session_plus.app_public_port 不是合法端口:${String(cfg.app_public_port)}`);
      return null;
    }
    // URL and Host normalise a scheme's default port away. Keeping an explicit
    // 443/80 in policy would make `labelFromHost` require a spelling browsers
    // and reverse proxies normally omit, so canonicalise it to the same null
    // representation used when the operator leaves the field out.
    const defaultPort = rawScheme === "https" ? 443 : 80;
    publicPort = port === defaultPort ? null : port;
  }
  return { scheme: `${rawScheme}:` as "https:" | "http:", domain, publicPort, pinnedLabel: null };
}

/**
 * The proxy's on-demand-TLS question endpoint, or nothing.
 *
 * Loopback only, and refused rather than warned about: this endpoint answers
 * "should a certificate be issued for this hostname", so a routable one is a way
 * for anybody to enumerate which releases exist on this host.
 */
function askEndpoint(
  cfg: SessionPlusYamlConfig,
  errors: string[],
): { host: string; port: number } | null {
  const raw = cfg.origin_ask_port;
  if (raw === undefined || raw === null || Number(raw) === 0) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`session_plus.origin_ask_port 不是合法端口:${String(raw)}`);
    return null;
  }
  const host = String(cfg.origin_ask_host ?? "127.0.0.1").trim();
  if (!isLoopbackName(host)) {
    errors.push(
      `session_plus.origin_ask_host 必须是回环地址(收到 ${host})。`
        + "这个端点回答「要不要给这个主机名签证书」,对外暴露等于让任何人枚举本机安装了哪些 release",
    );
    return null;
  }
  return { host, port };
}

function configuredGrants(
  input: SessionPlusYamlConfig["grants"],
  errors: string[],
): readonly SessionPlusConfiguredGrant[] {
  if (input === undefined) return [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push("session_plus.grants 必须是 owner 到权限配置的映射");
    return [];
  }
  const out: SessionPlusConfiguredGrant[] = [];
  const owners = new Set<string>();
  for (const [rawOwner, raw] of Object.entries(input as Record<string, unknown>)) {
    const owner = rawOwner.trim();
    if (!owner || owners.has(owner)) {
      errors.push(`session_plus.grants 包含空或重复 owner:${JSON.stringify(rawOwner)}`);
      continue;
    }
    owners.add(owner);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`session_plus.grants.${owner} 必须是对象`);
      continue;
    }
    const row = raw as { operations?: unknown; auto_allow?: unknown };
    const operations = stringArray(row.operations, `session_plus.grants.${owner}.operations`, errors);
    const autoAllow = stringArray(row.auto_allow, `session_plus.grants.${owner}.auto_allow`, errors);
    const unknown = operations.filter((op) => !SESSION_RESOURCE_CATALOG.ids.includes(op));
    if (unknown.length) errors.push(`session_plus.grants.${owner}.operations 含未知权限:${unknown.join(",")}`);
    const invalidAuto = autoAllow.filter(
      (op) => !operations.includes(op) || !SESSION_RESOURCE_CATALOG.autoAllowable.includes(op),
    );
    if (invalidAuto.length) {
      errors.push(
        `session_plus.grants.${owner}.auto_allow 必须是已授予且契约允许静默执行的权限子集:${invalidAuto.join(",")}`,
      );
    }
    if (unknown.length || invalidAuto.length) continue;
    out.push({
      owner,
      operations: SESSION_RESOURCE_CATALOG.ids.filter((op) => operations.includes(op)),
      autoAllow: SESSION_RESOURCE_CATALOG.ids.filter((op) => autoAllow.includes(op)),
    });
  }
  return Object.freeze(out.map((row) => Object.freeze(row)));
}

function stringArray(input: unknown, path: string, errors: string[]): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string" || !value.trim())) {
    errors.push(`${path} 必须是非空字符串数组`);
    return [];
  }
  return [...new Set(input.map((value) => String(value).trim()))];
}

/**
 * What must hold between the trusted main origin(s) and the View origin.
 *
 * **There are exactly two supported shapes**, and everything else is refused:
 *
 * ```text
 *   production   https://<main host>          + https://app-<digest>.<app 域>
 *                (different hostnames, neither one loopback)
 *
 *   development  http://localhost:<port>      + http://app-<digest>.localhost:<port>
 *                (different hostnames, BOTH loopback/.localhost/127.x/::1)
 * ```
 *
 * Four rules produce that, and each one is a deployment somebody could
 * otherwise write and believe:
 *
 *  1. **Different hostname.** Not "different origin" — cookies are not
 *     port-scoped, so the same host on another port hands the View the panel's
 *     session on its first request.
 *  2. **Same scheme.** An https page cannot frame an http document at all
 *     (mixed content), and an http panel with an https View would select the
 *     unprefixed cookie contract while looking like a production deployment.
 *  3. **http means LOCAL.** The plain-http shape exists because a laptop has
 *     neither DNS nor a certificate — not because plaintext is acceptable. An
 *     http main origin on a routable name (`http://bot.internal:9820`, a LAN
 *     address) is a session id crossing a network in cleartext, and the previous
 *     version accepted it because it only compared the two schemes to each
 *     other.
 *  4. **Locality must MATCH.** A public https panel framing `…localhost` would
 *     ask every visitor's own machine for the View — each user framing whatever
 *     happens to run on their laptop — and a localhost panel framing a public
 *     View is the same mistake pointing the other way. Neither is a deployment;
 *     both are configuration accidents that would look like they worked for the
 *     one operator whose machine also runs the other half.
 */
function pairErrors(view: URL, frameAncestors: readonly string[]): string[] {
  const out: string[] = [];
  const viewLocal = isLoopbackName(view.hostname);
  for (const raw of frameAncestors) {
    let main: URL;
    try {
      main = new URL(raw);
    } catch {
      continue; // already reported by allowedOrigins()
    }
    const mainLocal = isLoopbackName(main.hostname);
    if (main.hostname === view.hostname) {
      out.push(
        `session_plus.view_origin 与主站共用主机名(${view.hostname})。`
          + "Cookie 不按端口隔离:换一个端口不会把主站会话挡在外面,"
          + "第一次导航就会把它交给不可信的 Agent View。请给它一个独立主机名"
          + `(本次构建应当是 ${view.hostname.split(".")[0]}.<你的 app 域>)`,
      );
    }
    if (main.protocol !== view.protocol) {
      out.push(
        `session_plus.view_origin 与主站的协议不一致(主站 ${main.protocol}//,视图 ${view.protocol}//)。`
          + "https 页面框不住 http 文档(混合内容),而 http 主站配 https 视图会让主站按开发契约"
          + "发不带 __Host- 前缀的 Cookie 却看起来像生产部署。两边必须同为 https,或同为本机 http 回环",
      );
    }
    if (main.protocol === "http:" && !mainLocal) {
      out.push(
        `主站 origin 是 http 但主机名不是本机名(${main.hostname})。`
          + "http 这条路只支持**本机开发**——它存在的理由是笔记本没有 DNS 也没有证书,"
          + "不是「明文可以接受」:一个可路由的 http 主站意味着会话 id 明文过网。"
          + "对外部署请配置 https 的 dashboard.public_url",
      );
    }
    if (mainLocal !== viewLocal) {
      out.push(
        `主站与 Agent View 的「本机/对外」属性不一致(主站 ${main.hostname} 是${mainLocal ? "本机名" : "对外名"},`
          + `视图 ${view.hostname} 是${viewLocal ? "本机名" : "对外名"})。`
          + "对外的页面去框 localhost,等于让每个访问者的**自己那台机器**提供这个视图;"
          + "反过来也一样。两边必须同为对外(生产),或同为本机(开发)",
      );
    }
  }
  return [...new Set(out)];
}

/**
 * The origin this build's package would be served from under a given app
 * domain. Startup logs it, so an operator can copy the right hostname instead
 * of deriving it from a digest by hand.
 */
export function suggestedViewOrigin(appDomain: string, identity = sessionPlusIdentity()): string {
  return `https://${identity.packageHostLabel}.${appDomain.replace(/^\.+/, "")}`;
}
