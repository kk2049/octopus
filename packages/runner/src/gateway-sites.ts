import { createHash } from "node:crypto";
import path from "node:path";
import { validateRunnerGatewayUrl } from "./gateway-reconnect.js";

export interface AdditionalRunnerSite {
  id: string;
  dashboard_url: string;
  runner_url: string;
  token_file: string;
}

export interface RunnerSitePolicy {
  additional_sites?: AdditionalRunnerSite[];
  /** Stable legacy site id is `primary`, even after control moves elsewhere. */
  control_site?: string;
  update_site?: string;
  primary_enabled?: boolean;
}

export interface RunnerSite {
  id: string;
  runnerUrl: string;
  tokenFile?: string;
  token?: string;
  controlsMachine: boolean;
  providesUpdates: boolean;
}

export function validateSiteId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error("Runner site id must use 1–32 lowercase letters, digits, underscores or hyphens");
  }
  return value;
}

export function parseAdditionalSites(raw: unknown): AdditionalRunnerSite[] {
  if (!Array.isArray(raw) || raw.length > 8) throw new Error("Runner additional_sites must be an array of at most eight sites");
  const ids = new Set<string>(["primary", "none"]);
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Runner site configuration");
    const row = value as Record<string, unknown>;
    const id = validateSiteId(row.id);
    if (ids.has(id)) throw new Error("Duplicate or reserved Runner site id");
    ids.add(id);
    const runnerUrl = validateRunnerGatewayUrl(String(row.runner_url ?? ""));
    const gateway = new URL(runnerUrl);
    let dashboard: URL;
    try { dashboard = new URL(String(row.dashboard_url ?? "")); } catch { throw new Error("Invalid site dashboard URL"); }
    if (dashboard.protocol !== (gateway.protocol === "wss:" ? "https:" : "http:")
      || dashboard.host !== gateway.host || dashboard.pathname !== "/" || dashboard.search || dashboard.hash
      || dashboard.username || dashboard.password || gateway.search) {
      throw new Error("A Runner site's dashboard and gateway must use the same exact authority without credentials or query strings");
    }
    if (typeof row.token_file !== "string" || !path.isAbsolute(row.token_file)) throw new Error("Runner site token_file must be absolute");
    return { id, dashboard_url: dashboard.origin, runner_url: runnerUrl, token_file: row.token_file };
  });
}

export function resolveRunnerSites(primary: { runnerUrl: string; token?: string; tokenFile?: string }, policy: RunnerSitePolicy = {}): RunnerSite[] {
  const control = policy.control_site ?? "primary";
  const update = policy.update_site ?? "primary";
  const sites = [
    ...(policy.primary_enabled === false ? [] : [{ id: "primary", ...primary }]),
    ...parseAdditionalSites(policy.additional_sites ?? []).map((site) => ({ id: site.id, runnerUrl: site.runner_url, tokenFile: site.token_file })),
  ];
  if (!sites.some((site) => site.id === control) || (update !== "none" && !sites.some((site) => site.id === update))) {
    throw new Error("Runner control_site and update_site must name enabled sites (update_site may be none)");
  }
  const urls = new Set<string>();
  return sites.map((site) => {
    const url = new URL(validateRunnerGatewayUrl(site.runnerUrl)).href;
    if (urls.has(url)) throw new Error("The same Runner gateway cannot be configured twice");
    urls.add(url);
    return { ...site, controlsMachine: site.id === control, providesUpdates: site.id === update };
  });
}

/** Preserve legacy launch keys; distinct sites may legitimately reuse an operation id. */
export function siteOperationId(siteId: string | undefined, operationId: string): string {
  if (!siteId || siteId === "primary") return operationId;
  return `op_site_${createHash("sha256").update(siteId).update("\0").update(operationId).digest("hex")}`;
}
