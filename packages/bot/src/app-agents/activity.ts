import type { AppAgentActivity } from "@claude-bot/dashboard-web/contract";

/** Trusted host scope, derived from a live instance, never from request params. */
export interface AppAgentActivityScope { appId: string; owner: string; instanceKey?: string }
export interface AppAgentActivityPort {
  readActivity(scope: AppAgentActivityScope): AppAgentActivity[];
  stopActivity(scope: AppAgentActivityScope, turnId: string): boolean;
}
