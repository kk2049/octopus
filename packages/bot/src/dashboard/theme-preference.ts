/**
 * The per-account Dashboard theme setting.
 *
 * The closed id list comes from the same server/browser contract placed in the
 * page bootstrap. Unknown rows are treated as absent: a future bundle may have
 * written them, and an older process must neither expose an invalid id nor
 * overwrite it with its own default.
 */

import {
  DASHBOARD_THEME_IDS,
  type DashboardThemeId,
} from "@claude-bot/dashboard-web/contract";
import type { DashboardStorePort } from "./ports.js";

export const DASHBOARD_THEME_SETTING = "dashboard_theme";

const THEME_IDS = new Set<string>(DASHBOARD_THEME_IDS);

export function dashboardThemeId(value: unknown): DashboardThemeId | null {
  return typeof value === "string" && THEME_IDS.has(value)
    ? value as DashboardThemeId
    : null;
}

export function storedDashboardTheme(
  store: Pick<DashboardStorePort, "getSetting">,
  username: string | null | undefined,
): DashboardThemeId | null {
  if (!username) return null;
  return dashboardThemeId(store.getSetting(username, DASHBOARD_THEME_SETTING));
}
