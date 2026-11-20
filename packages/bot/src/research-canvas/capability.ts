import type {
  CapabilityService,
  OperationSpec,
} from "@claude-bot/capability-kernel";
import { CANVAS_OPERATIONS } from "@claude-bot/research-canvas-contract";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import type { IntentGrantResolver } from "../session-resource/intent-resolver.js";
import {
  RESEARCH_CANVAS_CATALOG,
  RESEARCH_CANVAS_CONTRACT,
} from "./contract.js";
import type { ResearchContext, ResearchGraph } from "./graph.js";

/** Capability API branch; graph membership and bindings are independent checks. */
export class ResearchCapabilities {
  private readonly authority: AccountAuthority<{ owner: string }>;
  constructor(
    private readonly kernel: CapabilityService,
    private readonly graph: ResearchGraph,
    private readonly grants: IntentGrantResolver,
  ) {
    const operations: Record<string, OperationSpec> = Object.fromEntries(
      RESEARCH_CANVAS_CATALOG.operations
        .filter((operation) => CANVAS_OPERATIONS.includes(operation.id))
        .map((operation) => [
          operation.id,
          {
            title: operation.title,
            effect: operation.effect,
            args: {
              project: { type: "string", required: true, maxLength: 160 },
              target: { type: "string", maxLength: 200 },
            },
            retrySafe: true,
          },
        ]),
    );
    this.authority = new AccountAuthority({
      service: kernel,
      slot: "research-canvas",
      objectPrefix: "research-canvas-v3",
      kind: "research-projects",
      operations,
      bindingFor: (owner) => ({ owner }),
      rootAutoAllow: () => CANVAS_OPERATIONS,
      policy: (input) =>
        input.terms.autoAllow.includes(input.operation)
          ? { kind: "allow" }
          : { kind: "deny", reason: "请在权限中心授权自动科研 v2 对应的操作" },
      adapter: async (binding, operation, args) => {
        this.graph.authorize(
          {
            project: String(args.project),
            actor: { kind: "human", owner: binding.owner },
          },
          operation === "edit_graph" ? "read_project" : operation,
        );
        return { authorized: true };
      },
    });
  }
  async check(
    context: ResearchContext,
    operation: string,
    target = "",
  ): Promise<void> {
    this.graph.authorize(context, operation);
    const effective = this.grants.effective(
      RESEARCH_CANVAS_CONTRACT,
      context.actor.owner,
    );
    if (
      !effective.operations.includes(operation) ||
      !effective.autoAllow.includes(operation)
    )
      throw new Error("请在权限中心授权自动科研 v2 对应操作");
    const derived = this.authority.derive({
      username: context.actor.owner,
      purpose: `自动科研 v2 · ${context.project} · ${context.actor.kind}`,
      kind: context.actor.kind === "agent" ? "agent-run" : "app-instance",
      rights: [operation],
      autoAllow: [operation],
    });
    if (!derived) throw new Error("项目操作授权不可用");
    const grant = new SlotGrant(
      this.kernel,
      derived.contextId,
      "research-canvas",
      "自动科研 v2",
      context.actor.owner,
      derived.borrowed,
    );
    try {
      await grant.call(operation, { project: context.project, target });
      if (!this.allowed(context, operation)) throw new Error("操作授权已变化");
    } finally {
      grant.close();
    }
  }
  allowed(context: ResearchContext, operation: string): boolean {
    try {
      this.graph.authorize(context, operation);
      const effective = this.grants.effective(
        RESEARCH_CANVAS_CONTRACT,
        context.actor.owner,
      );
      return (
        effective.operations.includes(operation) &&
        effective.autoAllow.includes(operation)
      );
    } catch {
      return false;
    }
  }
  revoke(owner: string): void {
    this.authority.revokeAccount(owner);
  }
}
