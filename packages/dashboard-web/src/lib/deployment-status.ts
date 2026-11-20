export interface EdgeDeployment {
  id: number | null;
  status: string;
  observed_at: number;
  http_ready: boolean;
  created_at?: string;
  updated_at?: string;
}
export const DEPLOY_REQUEST_EVENT = "octopus-deploy-request";
export const DEPLOY_OBSERVED_KEY = "octopus-deploy-observed";
export const DEPLOY_DISMISSED_KEY = "octopus-deploy-dismissed";
export const activeDeployment = (status: string) => ["requested", "claimed", "building", "restarting", "health_gate", "rolling_back", "confirm_wait"].includes(status);
export function freshDeployment(value: EdgeDeployment | undefined, now = Date.now()): value is EdgeDeployment {
  return Boolean(value && Number.isFinite(value.observed_at) && Math.abs(now - value.observed_at) < 8000);
}
export function rememberDeployment(key: string, id: number): void {
  try { sessionStorage.setItem(key, String(id)); } catch { /* Storage is optional. */ }
}
export function recalledDeployment(key: string): number {
  try { return Number(sessionStorage.getItem(key)) || 0; } catch { return 0; }
}
export function deploymentRequested(id: number | null): void {
  if (id) rememberDeployment(DEPLOY_OBSERVED_KEY, id);
  dispatchEvent(new CustomEvent(DEPLOY_REQUEST_EVENT, { detail: id }));
}
