import type { TicketRunnerConfig } from "./runner-ticket.js";

/** Callers supply current trusted role resolution, never request-body capability bits. */
export function ticketResourceOwner(config: TicketRunnerConfig | undefined, requester: string, isDeveloper: (user: string) => boolean): string {
  const pool = config?.shared_pool;
  return pool && (pool.all_developers || pool.requesters.includes(requester)) && isDeveloper(requester) && config?.targets[pool.owner]?.workspaces?.length
    ? pool.owner : requester;
}
