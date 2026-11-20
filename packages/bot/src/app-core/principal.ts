import type { SessionPlusActor, SessionPlusPrincipal } from "./instance.js";

/**
 * The principal one App-agent turn runs as.
 *
 * The credential is deliberately outside the browser-login namespace: ending
 * one login cannot resolve an agent turn, while account teardown still can.
 */
export function sessionPlusAgentPrincipal(input: {
  owner: string;
  app: string;
  agent: string;
  turnId: string;
  role?: string;
}): SessionPlusPrincipal {
  return {
    owner: input.owner,
    credential: `agent:${input.app}/${input.agent}#${input.turnId}`,
    session: false,
    actor: {
      kind: "agent",
      app: input.app,
      agent: input.agent,
      turnId: input.turnId,
      ...(input.role ? { role: input.role } : {}),
    },
  };
}

/**
 * Stamp the existing event-author vocabulary without letting App code choose
 * its author. Human events retain the stable App id; agent events name the
 * exact App agent and account.
 */
export function eventAuthor(stableAppId: string, actor: SessionPlusActor, owner: string): string {
  if (actor.kind !== "agent") return stableAppId;
  // Schema-4 shared agents are App participants, not impersonated humans. The
  // role is part of their durable audit identity; account and legacy external
  // agents retain the established owner-qualified vocabulary.
  return actor.role
    ? `agent:${actor.app}/${actor.agent}#${actor.role}`
    : `agent:${actor.app}/${actor.agent}@${owner}`;
}
