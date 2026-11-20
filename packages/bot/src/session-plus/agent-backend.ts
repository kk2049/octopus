/**
 * Session Plus, as the agent plane sees it.
 *
 * Thin on purpose. Everything it does is either a lookup in the release's own
 * declaration or a call onto `SessionPlusAppService` — there is no second
 * validator, no second permission check and no second wire format here, because
 * the whole claim being made is "the agent's tool call and the person's button
 * arrive at the same door". A file that translated between two shapes would be
 * the place that claim quietly stops being true.
 *
 * The dependency points this way (App → platform) rather than the other way:
 * the plane must not import Session Plus, or the "second App" the convergence
 * plan is heading for would mean editing the platform.
 */

import { SESSION_PLUS_APP_ID } from "../app-core/identity.js";
import type { SessionPlusAppService } from "./app-service.js";
import { sessionPlusAgentPrincipal } from "../app-core/principal.js";
import {
  appActionTool,
  sessionPlusActionsFor,
  type SessionPlusManifest,
} from "../app-core/manifest.js";
import type {
  AppAgentBackend,
  AppAgentDeclaration,
  AppAgentScope,
  AppAgentTool,
  AppAgentTurnHandle,
} from "../app-agents/types.js";

export interface SessionPlusAgentBackendOptions {
  app: SessionPlusAppService;
  /**
   * The manifest of whichever release is ACTIVE, re-read on every use.
   *
   * A snapshot would let an agent keep driving the previous release's action
   * surface after an activation — the same hazard the coordinator documents for
   * its own identity, and with the same answer.
   */
  manifest: () => SessionPlusManifest | null;
}

export class SessionPlusAgentBackend implements AppAgentBackend {
  readonly appId = SESSION_PLUS_APP_ID;

  constructor(private readonly o: SessionPlusAgentBackendOptions) {}

  agents(): readonly AppAgentDeclaration[] {
    const manifest = this.o.manifest();
    if (!manifest) return [];
    return Object.values(manifest.agents);
  }

  /**
   * The tool table, derived from the same `actions:` a button reads.
   *
   * `human_only` actions are absent here AND refused at the door. Filtering
   * alone would leave a model free to name one; refusing alone would leave it
   * retrying a tool it can see. Both, or neither works.
   */
  tools(_scope: AppAgentScope, _agent: string): readonly AppAgentTool[] {
    const manifest = this.o.manifest();
    if (!manifest) return [];
    return sessionPlusActionsFor(manifest, "agent").map((row) => appActionTool(row.name, row.spec));
  }

  scopeKey(scope: AppAgentScope): string {
    // The App's State scope, spelled the way `open()` resolves it.
    if (scope.kind !== "account") throw new Error("Session Plus agents are account-scoped");
    return `account:${scope.owner}`;
  }

  scopeFromKey(scopeKey: string): AppAgentScope | null {
    if (!scopeKey.startsWith("account:")) return null;
    const owner = scopeKey.slice("account:".length);
    return owner ? { kind: "account", owner } : null;
  }

  appendInbox(input: { scope: AppAgentScope; agent: string; text: string; from: string; dispatchId?: string }) {
    if (input.scope.kind !== "account") return Promise.resolve({ ok: false as const, message: "Session Plus agents are account-scoped" });
    return this.o.app.appendAgentInbox({
      owner: input.scope.owner,
      agent: input.agent,
      text: input.text,
      from: input.from,
      ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
    });
  }

  async readInbox(scope: AppAgentScope, agent: string, cursor: number) {
    if (scope.kind !== "account") return { head: cursor, messages: [] };
    const read = await this.o.app.readAgentInbox(scope.owner, agent, cursor);
    return { head: read.head, messages: read.messages };
  }

  async openTurn(input: { scope: AppAgentScope; agent: string; turnId: string }): Promise<AppAgentTurnHandle> {
    if (input.scope.kind !== "account") throw new Error("Session Plus agents are account-scoped");
    const identity = { owner: input.scope.owner, agent: input.agent, turnId: input.turnId };
    const principal = sessionPlusAgentPrincipal({ ...identity, app: this.appId });
    const opened = await this.o.app.openAgentTurn({ ...identity, app: this.appId });
    const app = this.o.app;
    const lifetime = new AbortController();
    const subscription = app.subscribe(opened.handle, principal, (event) => {
      if (event.type === "closed") lifetime.abort(new Error(`App agent instance closed: ${event.reason}`));
    });
    if (!subscription) {
      app.closeInstance(opened.handle, principal);
      throw new Error("App agent instance ended while its turn was opening");
    }
    let closed = false;
    return {
      projection: opened.projection,
      signal: lifetime.signal,
      async dispatch(action, params) {
        if (closed) return { ok: false, code: "instance_expired", message: "这一轮已经结束" };
        // The SAME method a browser proposal reaches. The actor rides on the
        // principal, which trusted code built; nothing a model emitted can
        // change it, and there is no argument here that could carry an owner.
        const answer = await app.dispatch(opened.handle, principal, { action, params });
        return answer.ok
          ? { ok: true, result: answer.result }
          // The provider's own refusal code travels alongside, because
          // `approval_required` is an instruction and flattening it into
          // "rejected" is what makes a model retry it.
          : { ok: false, code: answer.resourceCode ?? answer.code, message: answer.message };
      },
      async close() {
        if (closed) return;
        closed = true;
        subscription.close();
        app.closeInstance(opened.handle, principal);
      },
    };
  }
}
