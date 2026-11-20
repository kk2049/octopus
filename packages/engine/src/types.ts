/**
 * Core vocabulary of the engine — five primitives, two laws.
 *
 * ⚠ This package is a PROBE (v3): a working hypothesis extracted from the live
 * bot, to be corrected by practice. Nothing in it is ground truth.
 *
 * Primitives:
 *   StateStore  — per-(app,scope) append-only event log; the only durable truth.
 *   Actions     — the single door through which state changes. One declaration
 *                 serves the human button, the HTTP API and the agent tool.
 *   AgentPlane  — an agent is "a thing with an inbox"; scheduling is one pump.
 *   Projection  — pure fold(events) → view; caches deletable, hot-reloadable.
 *   Binding     — pages are data wiring widgets to views, actions and agents.
 *
 * Laws:
 *   Discovery is automatic, authority is not. Whatever is rendered for a user
 *   is enumerable and invocable by the agent bound to that (user, page) —
 *   through the SAME predicate, with agent authorship stamped. Pages never
 *   mint authority; predicates live on the action declaration.
 *
 *   Hot-plug is a property of material, not a wish. Data (manifests, pages,
 *   wiring) reloads live; pure functions (projections, handlers) reload per
 *   call; kernel code (connections, pump, this file) waits for drain+restart.
 */

/** Who is acting. Engine-stamped onto every event; handlers cannot forge it. */
export type Actor =
  | { kind: "user"; username: string; admin?: boolean }
  | { kind: "agent"; app: string; agent: string; onBehalfOf: string }
  | { kind: "system"; name: string };

/** Canonical string form used in event `by` fields and audit lines. */
export function actorId(a: Actor): string {
  switch (a.kind) {
    case "user":
      return `user:${a.username}`;
    case "agent":
      return `agent:${a.app}/${a.agent}@${a.onBehalfOf}`;
    case "system":
      return `system:${a.name}`;
  }
}

/** The username on whose behalf this actor works (authorship ≠ authority). */
export function actorUser(a: Actor): string | null {
  switch (a.kind) {
    case "user":
      return a.username;
    case "agent":
      return a.onBehalfOf;
    case "system":
      return null;
  }
}

/** Engine-stamped envelope around app-defined event payloads. */
export interface EngineEvent<T = unknown> {
  /** 1-based position in its log. Assigned at append, never reused. */
  seq: number;
  /** ISO timestamp, assigned at append. */
  at: string;
  /** `actorId()` of whoever caused the append. */
  by: string;
  type: string;
  data: T;
}

/** What handlers hand to the engine: payload only — seq/at/by are stamped. */
export interface EventInput<T = unknown> {
  type: string;
  data: T;
}

/**
 * The predicate vocabulary — deliberately a closed set of WORDS, not code.
 * Words are data: verifiable by schema, hot-pluggable, and impossible to
 * accidentally Turing-complete.
 *
 *   any    — every authenticated identity.
 *   owner  — the scope's owner only. Admin deliberately does NOT satisfy
 *            `owner`: events carry authorship, so an admin writing into
 *            someone else's scope would be forgery (ticket #15's canWriteAs).
 *   admin  — configured administrators (cross-user READ or infra actions).
 */
export type Predicate = "any" | "owner" | "admin";

export const PREDICATES: readonly Predicate[] = ["any", "owner", "admin"];
