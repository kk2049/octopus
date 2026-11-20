/**
 * Agent-selected delivery classification, checked against the exact landing
 * diff.
 *
 * Ticket kind describes conversation discipline. It is not a trustworthy
 * statement about production blast radius: the requester files a need before
 * anybody has located the code, and one change may fan out to several Apps.
 * The agent therefore declares the delivery path only at submit time, when the
 * final diff exists, and this module independently proves the narrow claims.
 *
 * `full_deploy` is always conservative. `none` is deliberately tiny. The
 * useful middle lane, `app_releases`, accepts App compositions and explicitly
 * untrusted shared View modules; it computes every affected App from
 * `releasePaths` and requires the declared set to match exactly. Trusted
 * contracts, the Bot-owned View shell, build tooling, web-trust and the
 * lockfile remain outside even though they also affect release digests.
 */

import type { DevTicketRow } from "../store/repositories/dev-tickets.js";
import {
  APP_TICKET_SCOPES,
  appsWithReleaseChanges,
  pathMatches,
  type AppTicketScope,
} from "./app-scopes.js";

export const DELIVERY_MODES = ["full_deploy", "app_releases", "none"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export interface DeliveryClaim {
  mode: DeliveryMode;
  apps: string[];
}

export interface DeliveryPlan {
  mode: DeliveryMode;
  /** Exact Apps this ticket may publish ahead of a full deployment. */
  apps: AppTicketScope[];
  /** Extra focused tests the narrow App claim owes. */
  tests: string[];
  /** Whether the current agent supplied the claim (rather than legacy fallback). */
  explicit: boolean;
}

export type DeliveryResolution =
  | { ok: true; plan: DeliveryPlan }
  | { ok: false; message: string; files?: string[] };

interface SharedViewPath {
  path: string;
  /** Vitest project, or a node-project path for the package without a project. */
  test: string;
}

/**
 * Shared browser-only modules that may fan out to several App releases.
 *
 * This is intentionally not derived from every `releasePaths` entry. Those
 * lists also contain trusted contracts, build recipes and lockfiles. Each row
 * here is an untrusted View package with no runtime import in Bot/Dashboard;
 * `delivery.test.ts` pins both the release fan-out and the trusted-boundary
 * exclusions.
 */
export const HOT_PUBLISHABLE_SHARED_VIEW_PATHS: readonly SharedViewPath[] = [
  { path: "packages/agent-board-view/", test: "project:agent-board-view" },
  { path: "packages/agent-crdt-view/", test: "project:agent-crdt-view" },
  { path: "packages/agent-data-view/", test: "project:agent-data-view" },
  { path: "packages/agent-deck-view/", test: "project:agent-deck-view" },
  { path: "packages/agent-editor-view/", test: "project:agent-editor-view" },
  { path: "packages/agent-feishu-view/", test: "project:agent-feishu-view" },
  { path: "packages/agent-file-preview/", test: "packages/agent-file-preview" },
  { path: "packages/agent-intake-view/", test: "project:agent-intake-view" },
  { path: "packages/agent-schedule-view/", test: "project:agent-schedule-view" },
  { path: "packages/agent-sessions-view/", test: "project:agent-sessions-view" },
  { path: "packages/agent-text-view/", test: "project:agent-text-view" },
  { path: "packages/agent-view-react/", test: "project:agent-view" },
  { path: "packages/agent-workspace-files-view/", test: "project:agent-workspace-files-view" },
] as const;

const NO_RUNTIME_EXACT = new Set(["AGENTS.md", "CLAUDE.md", "README.md"]);

/** Paths whose landing changes neither a running service nor an App release. */
export function isNoRuntimePath(file: string): boolean {
  if (file.startsWith("doc/")) return true;
  if (NO_RUNTIME_EXACT.has(file)) return true;
  if (/(?:^|\/)(?:AGENTS|CLAUDE|README)\.md$/u.test(file)) return true;
  if (/\.(?:md|mdx)$/u.test(file)) return true;
  if (/(?:^|\/)__snapshots__\//u.test(file)) return true;
  if (/(?:^|\/)__tests__\//u.test(file)) return true;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);
}

/**
 * Documentation/test evidence is neutral only when the App packer also
 * excludes it. Some release inputs are directory-wide, so their README and
 * focused tests still change the content-addressed artifact.
 */
function isDeliveryNeutralPath(file: string): boolean {
  return isNoRuntimePath(file) && appsWithReleaseChanges([file]).length === 0;
}

/** A source path whose bytes are safe to publish only through App releases. */
export function isHotPublishableAppPath(file: string): boolean {
  if (APP_TICKET_SCOPES.some((scope) => scope.paths.some((pattern) => pathMatches(file, pattern)))) return true;
  return HOT_PUBLISHABLE_SHARED_VIEW_PATHS.some(({ path }) => pathMatches(file, path));
}

/**
 * A changed path that can reach users without new trusted code: an untrusted
 * App/View release input, or evidence outside every runtime and release. The
 * `app_releases` submit claim and automatic App publication share this rule.
 */
export function isAppOnlyPath(file: string): boolean {
  return isDeliveryNeutralPath(file) || isHotPublishableAppPath(file);
}

function normalizeApps(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  const apps = value.map((item) => item.trim()).filter(Boolean);
  if (apps.length > 16 || new Set(apps).size !== apps.length) return null;
  return apps.sort();
}

export function parseDeliveryClaim(value: unknown): DeliveryClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.mode !== "string" || !DELIVERY_MODES.includes(raw.mode as DeliveryMode)) return null;
  const apps = normalizeApps(raw.apps);
  if (!apps) return null;
  return { mode: raw.mode as DeliveryMode, apps };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function focusedAppTests(files: readonly string[], scopes: readonly AppTicketScope[]): string[] {
  const tests = new Set<string>();
  for (const scope of scopes) {
    for (const project of scope.projects) tests.add(`project:${project}`);
    for (const nodePath of scope.nodePaths) tests.add(nodePath);
  }
  for (const shared of HOT_PUBLISHABLE_SHARED_VIEW_PATHS) {
    if (files.some((file) => pathMatches(file, shared.path))) tests.add(shared.test);
  }
  return [...tests];
}

function legacyClaim(ticket: Pick<DevTicketRow, "kind" | "app_id">): DeliveryClaim {
  return ticket.kind === "app" && ticket.app_id
    ? { mode: "app_releases", apps: [ticket.app_id] }
    : { mode: "full_deploy", apps: [] };
}

/** Validate one submit claim against the exact `base...HEAD` path set. */
export function resolveDelivery(
  ticket: Pick<DevTicketRow, "kind" | "app_id">,
  files: readonly string[],
  rawClaim: unknown,
): DeliveryResolution {
  const explicit = rawClaim !== undefined;
  const claim = explicit ? parseDeliveryClaim(rawClaim) : legacyClaim(ticket);
  if (!claim) {
    return {
      ok: false,
      message: "delivery 声明格式无效:mode 只能是 full_deploy、app_releases、none；apps 必须是无重复的 App id 数组。",
    };
  }
  if (claim.mode !== "app_releases" && claim.apps.length) {
    return { ok: false, message: `${claim.mode} 不接受 apps；只有 app_releases 必须声明精确 App 集。` };
  }
  if (claim.mode === "full_deploy") {
    return { ok: true, plan: { mode: claim.mode, apps: [], tests: [], explicit } };
  }

  if (claim.mode === "none") {
    const runtimeFiles = files.filter((file) => !isDeliveryNeutralPath(file));
    if (runtimeFiles.length) {
      return {
        ok: false,
        files: runtimeFiles,
        message:
          "delivery=none 只接受不进入运行时或 App release identity 的文档和测试证据；"
          + "这些路径必须改报 full_deploy 或合法的 app_releases。",
      };
    }
    return { ok: true, plan: { mode: claim.mode, apps: [], tests: [], explicit } };
  }

  const scopes = appsWithReleaseChanges(files);
  const computedIds = scopes.map((scope) => scope.appId).sort();
  if (!computedIds.length) {
    return {
      ok: false,
      message: "delivery=app_releases，但最终 diff 没有改变任何可打包 App 的 release 输入。",
    };
  }
  if (!sameStrings(claim.apps, computedIds)) {
    return {
      ok: false,
      message:
        `App 集声明不等于系统从最终 diff 计算的影响集：声明 [${claim.apps.join(", ") || "空"}]，`
        + `实际 [${computedIds.join(", ")}]。必须逐个精确列出，不能漏报或多报。`,
    };
  }
  const unsafe = files.filter((file) => !isAppOnlyPath(file));
  if (unsafe.length) {
    return {
      ok: false,
      files: unsafe,
      message:
        "这些 release 输入不属于非可信 App/View 热发布边界；契约、Bot 壳、构建工具、依赖锁等即使影响 App digest，也必须 full_deploy。",
    };
  }
  return {
    ok: true,
    plan: {
      mode: claim.mode,
      apps: scopes.sort((left, right) => left.appId.localeCompare(right.appId)),
      tests: explicit ? focusedAppTests(files, scopes) : [],
      explicit,
    },
  };
}

export function encodeDeliveryApps(apps: readonly string[]): string {
  return JSON.stringify([...new Set(apps)].sort());
}

export function ticketDeliveryApps(
  ticket: Pick<DevTicketRow, "delivery_mode" | "delivery_apps" | "kind" | "app_id">,
): string[] {
  if (ticket.delivery_mode === "app_releases") {
    try {
      const decoded = JSON.parse(ticket.delivery_apps ?? "[]") as unknown;
      return Array.isArray(decoded)
        ? [...new Set(decoded.filter((app): app is string => typeof app === "string" && Boolean(app)))].sort()
        : [];
    } catch {
      return [];
    }
  }
  // Rows landed before delivery declarations keep their original hard scope.
  return ticket.delivery_mode == null && ticket.kind === "app" && ticket.app_id ? [ticket.app_id] : [];
}

/** Whether a full Bot rebuild/restart is part of this ticket's production debt. */
export function ticketNeedsTrustedDeploy(
  ticket: Pick<DevTicketRow, "delivery_mode" | "kind">,
): boolean {
  if (ticket.delivery_mode) return ticket.delivery_mode === "full_deploy";
  return ticket.kind !== "app";
}

/** A landed App-only claim may package its own exact clean worktree. */
export function ticketCanUseAppWorktree(
  ticket: Pick<DevTicketRow, "delivery_mode" | "delivery_apps" | "kind" | "app_id">,
  appId: string,
): boolean {
  return ticketDeliveryApps(ticket).includes(appId);
}

/**
 * Approval closure for one recorded App debt.
 *
 * Full-deploy tickets may settle their App debt from the deployed checkout;
 * only App-only tickets get the stronger exact-set assertion. `none` can never
 * legitimately own a release debt.
 */
export function ticketAllowsAppDebt(
  ticket: Pick<DevTicketRow, "delivery_mode" | "delivery_apps" | "kind" | "app_id">,
  appId: string,
): boolean {
  if (ticket.delivery_mode === "none") return false;
  if (ticket.delivery_mode === "app_releases") return ticketDeliveryApps(ticket).includes(appId);
  if (ticket.delivery_mode === "full_deploy") return true;
  return ticket.kind === "app" ? ticket.app_id === appId : true;
}
