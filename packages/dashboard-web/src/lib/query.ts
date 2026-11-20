/**
 * Server-state defaults, chosen against this server rather than against the
 * library's idea of a typical REST API.
 *
 * ── Ordinary reads heal themselves, within bounds ───────────────────────────
 *
 * Every GET this panel queries is a server-local read (SQLite, the pipeline's
 * memory, a cached probe): asking twice is indistinguishable from asking once.
 * So a read that failed because the network blinked or the box was restarting
 * is retried twice with backoff (1 s, then 2 s), and a reader who comes back
 * to the tab or whose connection returns gets data newer than a minute instead
 * of a page that only a manual refresh repairs. Answers the server actually
 * decided — 4xx refusals, a 401 expiry — are never retried.
 *
 * Bounds, because the panel's egress is billed per GB and some answers are
 * large: data counts as fresh for {@link QUERY_STALE_MS}, so switching windows
 * back and forth does not re-download it; nothing refetches on mount; and the
 * only interval polling is an explicit `refetchInterval` on an endpoint listed
 * in {@link REPLAY_SAFE}. These defaults add no polling.
 *
 * ── The reads that must never be replayed ───────────────────────────────────
 *
 * `/api/session`, `/api/sessions`, `/api/sessions/search` and
 * `/api/sessions/live` traverse per-account capability grants: when a read is
 * not auto-allowed it becomes a card a human has to approve, so a retry, a
 * focus refetch or a poll would ask somebody to approve the same read again.
 * The panel no longer calls them (the session views read through their App
 * resource channel); `query.test.ts` fails if a page starts to, so that such a
 * query is written with replay turned off rather than inheriting these
 * defaults.
 *
 * Mutations get `retry: false` for the stronger reason: append, approve,
 * reject, deploy, confirm, land, grant and revoke are not idempotent, and a
 * "helpful" second attempt is a second real effect on somebody's laptop.
 */

import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api.js";

/** How long a read counts as fresh; focus/reconnect refetch only older data. */
export const QUERY_STALE_MS = 60_000;
/** Further attempts after a transient failure. TanStack backs off 1 s, 2 s. */
export const QUERY_RETRIES = 2;

/**
 * A failure that says nothing about the request: the network failed (`fetch`
 * rejects with a TypeError) or the server answered 5xx (a restart, a proxy
 * 502). Anything else is the server's decision and is shown, not retried.
 */
export function transientFailure(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500;
  return error instanceof TypeError;
}

export function retryTransient(failureCount: number, error: unknown): boolean {
  return failureCount < QUERY_RETRIES && transientFailure(error);
}

/**
 * Endpoints a page may poll on an interval.
 *
 * The bar is: the handler reads server-local state (SQLite, the pipeline's own
 * memory, a cached probe) and never enters `gate.invoke`, so calling it twice
 * is indistinguishable from calling it once. Anything touching a Runner, a
 * session transcript or an operation submission is deliberately absent. Being
 * listed adds no polling by itself; a page still asks with `pollInterval()`.
 */
export const REPLAY_SAFE = [
  // Projects only the server-local device OAuth flow; never starts a flow.
  "/api/feishu/oauth/status",
  // Bounded local App-agent journal projection; no resource/Gate dispatch.
  "/api/app-view/agent-activity",
  "/api/session-plus/agent-activity",
  '/api/discussions',
  "/__octopus/deploy",
  "/api/overview",
  "/api/tickets",
  "/api/deploy",
  "/api/deploy/active",
  "/api/dev/quota",
  "/api/dev/system-status",
  "/api/capabilities/pending",
  "/api/admin/users",
  // The architecture snapshot is a server-local read of a pre-generated
  // analysis file — no capability traversal, no side effect.
  "/api/architecture",
  // The knowledge wiki reads are projections of a pre-built SQLite graph —
  // no capability traversal, no side effect. The preview/decide POSTs are
  // mutations and never retried.
  "/api/knowledge",
] as const;

/** Is this path one of the {@link REPLAY_SAFE} families? */
export function isReplaySafe(path: string): boolean {
  const clean = path.split("?")[0];
  return REPLAY_SAFE.some((safe) => clean === safe || clean.startsWith(`${safe}/`));
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: retryTransient,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        refetchOnMount: false,
        // Focus and reconnect refetch only data older than this, so moving
        // between windows does not re-download large answers.
        staleTime: QUERY_STALE_MS,
        gcTime: 5 * 60_000,
        // The panel is frequently used over a flaky uplink to a box that is
        // mid-restart. "Offline" here means "that request failed", which the
        // error path already says better than a paused query does.
        networkMode: "always",
      },
      mutations: {
        retry: false,
        networkMode: "always",
      },
    },
  });
}

/**
 * The interval a polled query should use, or `false` when the endpoint is not
 * on the replay-safe list.
 *
 * Written as a function rather than a literal at each call site so that adding
 * a poll to a capability-bearing endpoint is not something one can do by typing
 * a number.
 */
export function pollInterval(path: string, ms: number): number | false {
  return isReplaySafe(path) ? ms : false;
}
