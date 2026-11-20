# Managed execution

This module coordinates recovery of accepted work. It does not authorize actions,
reconstruct prompts from logs, or decide a product's completion semantics.

The shared data and decision contract is `@claude-bot/runner/managed-execution`.
Head adapters own durable intent and authorization; Runner owns continuation of
provider-acknowledged turns. A receipt query is not another input submission.
External CLI observations and parent-owned children are never recovery owners.

Dependency waits are durable before the first retry. For the first minute they
project `reconnecting`, then `waiting_resource`. Presence wakes the same adapter;
a bounded periodic probe covers missed events. An adapter must re-read its
current desired state and authorization before dispatching. Unknown dispatch
outcomes can only query the original operation, never replay it.

Live consumer inventory and the staging acceptance matrix are maintained in
`doc/design-managed-agent-lifecycle.md`. New consumers must choose a source,
a recovery owner and an effect boundary there; using AgentLoop alone does not
make a task restart-recoverable.

The generic HTTP loop lives in `loop.ts`; `app-agents/loop.ts` is a compatibility
re-export. Recovery infrastructure must not import an App domain implementation.
The architecture atlas registers this boundary independently from Bot composition;
review its dependency direction alongside focused tests. Existing architecture
findings should be distinguished from regressions introduced by this change.
