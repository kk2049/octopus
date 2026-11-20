/** A declared App's thin adapter onto the generic App agent plane. */

import { appActionTool } from "../app-core/manifest.js";
import type {
  AppAgentBackend,
  AppAgentDeclaration,
  AppAgentScope,
  AppAgentTool,
  AppAgentTurnHandle,
} from "../app-agents/types.js";
import type { AppInstanceService } from "./app-instance.js";

export class DeclaredAppAgentBackend implements AppAgentBackend {
  constructor(readonly appId: string, private readonly app: AppInstanceService) {}

  agents(): readonly AppAgentDeclaration[] {
    return this.app.agentDeclarations();
  }

  tools(scope: AppAgentScope, agent: string): readonly AppAgentTool[] {
    const surface = this.app.actionSurface("agent", { ...scope, agent });
    return surface ? surface.actions.map((row) => appActionTool(row.name, row.spec)) : [];
  }

  scopeKey(scope: AppAgentScope): string {
    return scope.kind === "account"
      ? `account:${scope.owner}`
      : `shared:${encodeURIComponent(scope.instanceKey)}:${encodeURIComponent(scope.owner)}`;
  }

  scopeFromKey(scopeKey: string): AppAgentScope | null {
    if (scopeKey.startsWith("account:")) {
      const owner = scopeKey.slice("account:".length);
      return owner ? { kind: "account", owner } : null;
    }
    if (!scopeKey.startsWith("shared:")) return null;
    const [encodedInstance, encodedOwner, ...extra] = scopeKey.slice("shared:".length).split(":");
    if (!encodedInstance || !encodedOwner || extra.length) return null;
    try {
      const instanceKey = decodeURIComponent(encodedInstance);
      const owner = decodeURIComponent(encodedOwner);
      return instanceKey && owner ? { kind: "shared", instanceKey, owner } : null;
    } catch {
      return null;
    }
  }

  appendInbox(input: { scope: AppAgentScope; agent: string; text: string; from: string; dispatchId?: string }) {
    return this.app.appendAgentInbox({
      owner: input.scope.owner,
      ...(input.scope.kind === "shared" ? { instanceKey: input.scope.instanceKey } : {}),
      agent: input.agent,
      text: input.text,
      from: input.from,
      ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
    });
  }

  readInbox(scope: AppAgentScope, agent: string, cursor: number) {
    return this.app.readAgentInbox(scope, agent, cursor);
  }

  async openTurn(input: { scope: AppAgentScope; agent: string; turnId: string }): Promise<AppAgentTurnHandle> {
    const opened = await this.app.openAgentTurn({
      owner: input.scope.owner,
      ...(input.scope.kind === "shared" ? { instanceKey: input.scope.instanceKey } : {}),
      agent: input.agent,
      turnId: input.turnId,
    });
    const lifetime = new AbortController();
    const subscription = this.app.subscribe(opened.handle, opened.principal, (event) => {
      if (event.type === "closed") lifetime.abort(new Error(`App agent instance closed: ${event.reason}`));
    });
    if (!subscription) {
      this.app.closeInstance(opened.handle, opened.principal);
      throw new Error("App agent instance ended while its turn was opening");
    }
    let closed = false;
    return {
      projection: opened.projection,
      signal: lifetime.signal,
      dispatch: async (action, params) => {
        if (closed) return { ok: false, code: "instance_expired", message: "这一轮已经结束" };
        const answer = await this.app.dispatch(opened.handle, opened.principal, { action, params });
        return answer.ok
          ? { ok: true, result: answer.result }
          : { ok: false, code: answer.code, message: answer.message };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        subscription.close();
        this.app.closeInstance(opened.handle, opened.principal);
      },
    };
  }
}
