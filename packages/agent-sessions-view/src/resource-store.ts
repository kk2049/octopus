import { codexModelsForDevice } from "./lib/cli.js";
import type { SessionsController } from "./controller.js";

/** Keep equal JSON projection branches by identity, including messages received
 * again in a full frame. Only selected resource data crosses this boundary. */
export function shareSessionValue<T>(previous: T | undefined, incoming: T): T {
  if (Object.is(previous, incoming)) return incoming;
  if (!previous || !incoming || typeof previous !== "object" || typeof incoming !== "object") return incoming;
  if (Array.isArray(previous) !== Array.isArray(incoming)) return incoming;
  const old = previous as Record<string, unknown>;
  const next = incoming as Record<string, unknown>;
  const keys = Object.keys(next);
  if (Array.isArray(incoming)) {
    const rows = incoming.map((value, index) => shareSessionValue((previous as unknown[])[index], value));
    return (rows.length === (previous as unknown[]).length && rows.every((value, index) => value === (previous as unknown[])[index])
      ? previous : rows) as T;
  }
  let same = keys.length === Object.keys(old).length;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = shareSessionValue(old[key], next[key]);
    if (result[key] !== old[key] || !Object.hasOwn(old, key)) same = false;
  }
  return (same ? previous : result) as T;
}

type ActionKey = {
  [K in keyof SessionsController]-?: NonNullable<SessionsController[K]> extends (...args: never[]) => unknown ? K : never
}[keyof SessionsController];
export type SessionsActions = Pick<SessionsController, ActionKey>;

export function createSessionsStore(initial: SessionsController) {
  let current = initial;
  const listeners = new Set<() => void>();
  // Stable commands sample the latest committed controller at the click. Data
  // returned by selectors are immutable snapshots, never live property getters.
  const actions = Object.fromEntries(Object.entries(initial)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => [key, (...args: unknown[]) => {
      const action = current[key as keyof SessionsController];
      return typeof action === "function" ? Reflect.apply(action, current, args) : undefined;
    }])) as SessionsActions;
  return {
    actions,
    snapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(next: SessionsController) {
      if (next === current) return;
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

export function sessionResourceSnapshot(controller: SessionsController, boundResource: string | null) {
  const resource = boundResource ?? controller.selected;
  const projection = controller.projection;
  const session = controller.sessionOf(resource);
  return {
    resource,
    session,
    models: session?.cliKind === "codex" ? codexModelsForDevice(
      controller.placementDevices.find(row => row.device === session.deviceId), { label: session.accountLabel },
    ) : undefined,
    providerSession: projection?.sessions?.find((row) => row.resourceId === resource) ?? null,
    absent: controller.sessionAbsent(resource),
    transcript: controller.windowOf(resource),
    transcriptStatus: projection?.transcriptStatuses?.[resource ?? ""] ?? projection?.transcriptStatus,
    busy: controller.transcriptRefreshing(resource),
    rosterRefreshing: controller.rosterRefreshing,
    workspaces: controller.workspaces,
    workspaceReveal: controller.workspaceReveal?.resource === resource ? controller.workspaceReveal : null,
    resolvedInteraction: controller.resolvedInteractionOf(resource),
    pendingSends: controller.pendingSendsOf(resource),
    controlRelease: controller.controlReleaseOf(resource),
    interrupt: controller.interruptOf(resource),
    permissionProfile: controller.permissionProfileOf(resource),
    model: controller.modelOf(resource),
    effort: controller.effortOf(resource),
    groupOverrides: controller.groupOverridesOf(resource),
    customTitle: projection?.customTitles?.[resource ?? ""] ?? "",
    pinned: Boolean(resource && projection?.pinned?.includes(resource)),
  };
}

/** Navigation owns roster metadata, never transcript bodies or composer state.
 * Runtime/review changes already flow through rosterOf and remain observable. */
export function sessionNavigationSnapshot(controller: SessionsController) {
  const projection = controller.projection;
  return {
    roster: controller.roster,
    selected: controller.selected,
    workspaces: controller.workspaces,
    devices: controller.devices,
    rosterRefreshing: controller.rosterRefreshing,
    workspaceReveal: controller.workspaceReveal,
    organize: controller.organize,
    projection: {
      pinned: projection?.pinned,
      sessionFolders: projection?.sessionFolders,
      rosterTruncated: projection?.rosterTruncated,
      workspaceAccess: projection?.workspaceAccess,
      rosterIndexPending: projection?.rosterIndexPending,
      sharedAccess: projection?.sharedAccess,
      sharedSessions: projection?.sharedSessions,
      sources: projection?.sources,
      sessionHistory: projection?.sessionHistory,
      customTitles: projection?.customTitles,
    },
  };
}

export function sessionSearchSnapshot(controller: SessionsController) {
  return {
    projection: {
      search: controller.projection?.search,
      customTitles: controller.projection?.customTitles,
    },
  };
}
