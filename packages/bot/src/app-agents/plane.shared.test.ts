/** Shared lanes retain the personal-agent stop/approval discipline. */

import { describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { AgentLoop } from "./loop.js";
import { AppAgentPlane } from "./plane.js";
import type {
  AppAgentBackend,
  AppAgentDispatch,
  AppAgentScope,
  AppAgentTurnHandle,
} from "./types.js";

const SCOPE = { kind: "shared" as const, owner: "alice", instanceKey: "asi_research" };

function toolCall(name: string) {
  return {
    content: null,
    tool_calls: [{
      id: "call-1",
      type: "function",
      function: { name, arguments: JSON.stringify({ text: "finding" }) },
    }],
  };
}

function scriptedLoop(queue: Array<Record<string, unknown>>) {
  const requests: unknown[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: queue.shift() ?? { content: "done" } }] }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return {
    loop: new AgentLoop({ baseUrl: "http://llm.invalid/v1", apiKey: "test", fetchImpl }),
    requests,
  };
}

class SharedBackend implements AppAgentBackend {
  readonly appId = "research-board";
  readonly lifetime = new AbortController();
  dispatches = 0;
  private readonly inbox: Array<{ seq: number; text: string; from: string; at: string }> = [];

  constructor(private readonly answer: () => AppAgentDispatch) {}

  agents() {
    return [{ name: "scout", adapter: "openai-loop", prompt: "Research.", role: "researcher" }];
  }

  tools(_scope: AppAgentScope, _agent: string) {
    return [{
      name: "publish",
      description: "Publish one finding.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    }];
  }

  scopeKey(scope: AppAgentScope): string {
    if (scope.kind !== "shared") throw new Error("expected shared scope");
    return `shared:${scope.instanceKey}:${scope.owner}`;
  }

  scopeFromKey(scopeKey: string): AppAgentScope | null {
    const match = /^shared:([^:]+):([^:]+)$/.exec(scopeKey);
    return match ? { kind: "shared", instanceKey: match[1]!, owner: match[2]! } : null;
  }

  async appendInbox(input: { scope: AppAgentScope; agent: string; text: string; from: string }) {
    this.inbox.push({ seq: this.inbox.length + 1, text: input.text, from: input.from, at: "now" });
    return { ok: true as const, revision: this.inbox.length, duplicate: false };
  }

  async readInbox(_scope: AppAgentScope, _agent: string, cursor: number) {
    return { head: this.inbox.length, messages: this.inbox.filter((message) => message.seq > cursor) };
  }

  async openTurn(): Promise<AppAgentTurnHandle> {
    return {
      projection: { viewer: { kind: "agent", app: this.appId, agent: "scout", role: "researcher" } },
      signal: this.lifetime.signal,
      dispatch: async () => {
        this.dispatches += 1;
        return this.answer();
      },
      close: async () => undefined,
    };
  }
}

describe("AppAgentPlane shared lanes", () => {
  it("ends approval_required after one dispatch and one model request", async () => {
    const backend = new SharedBackend(() => ({
      ok: false,
      code: "approval_required",
      message: "需要成员批准",
    }));
    const scripted = scriptedLoop([toolCall("publish"), { content: "must not run" }]);
    const store = new Store(":memory:");
    const plane = new AppAgentPlane({ store, backends: [backend], loop: scripted.loop });
    try {
      const report = await plane.trigger({
        appId: backend.appId,
        owner: SCOPE.owner,
        instanceKey: SCOPE.instanceKey,
        agent: "scout",
        prompt: "publish it",
      });
      expect(report.status).toBe("suspended");
      expect(backend.dispatches).toBe(1);
      expect(scripted.requests).toHaveLength(1);
    } finally {
      plane.stop();
      store.close();
    }
  });

  it("honours a revoked turn signal before the model can continue", async () => {
    let backend!: SharedBackend;
    backend = new SharedBackend(() => {
      backend.lifetime.abort(new Error("shared membership revoked"));
      return { ok: false, code: "action_rejected", message: "成员权限已撤销" };
    });
    const scripted = scriptedLoop([toolCall("publish"), { content: "must not run" }]);
    const store = new Store(":memory:");
    const plane = new AppAgentPlane({ store, backends: [backend], loop: scripted.loop });
    try {
      const report = await plane.trigger({
        appId: backend.appId,
        owner: SCOPE.owner,
        instanceKey: SCOPE.instanceKey,
        agent: "scout",
        prompt: "publish it",
      });
      expect(report).toMatchObject({ status: "failed", reason: expect.stringContaining("权限已撤销") });
      expect(backend.dispatches).toBe(1);
      expect(scripted.requests).toHaveLength(1);
    } finally {
      plane.stop();
      store.close();
    }
  });
});
