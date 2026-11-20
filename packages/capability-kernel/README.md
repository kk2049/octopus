# `@octo-kit/capability-kernel`

A scenario-neutral capability kernel for trusted Node.js control planes. It
provides attenuating grants, complete mediation, durable human approvals,
exactly-once claim semantics, audit records, and SQLite persistence without
learning what a user, agent, app, HTTP request, or MCP call is.

The runtime dependency closure is intentionally small: `better-sqlite3` plus
Node.js built-ins.

## Install

```bash
pnpm add @octo-kit/capability-kernel
```

The package is ESM-only and requires Node.js `^22.19.0` or `>=24.0.0`.

The public package name is `@octo-kit/capability-kernel`. Releases follow
Semantic Versioning. Any change that widens authority, changes persistence or
recovery semantics, or breaks the exported API requires an explicit security
review and the corresponding major version when incompatible.

## Security model

An untrusted caller receives only a facade bound by the trusted channel:

```text
request(slot, operation, args)
  -> authorize(bound context, slot, operation)
  -> validate and canonicalize args
  -> mandatory object policy
  -> fixed object adapter
```

The request payload never carries a principal, Context, capability, Object, or
approval. A `slot` is a Context-local name, not a bearer token. The trusted
control plane creates Contexts, registers fixed Objects, mints root grants,
derives attenuated grants, and then binds a facade to one Context.

The kernel enforces these invariants:

1. `(Context, slot)` selects a capability; the capability fixes the Object.
2. Derived rights and `GrantTerms.autoAllow` can only shrink.
3. Authorization re-walks the full parent capability chain on every request.
   Revoking any ancestor capability or destroying any ancestor Context denies
   all descendants.
4. Unknown Contexts, slots, Objects, operations, arguments, and states fail
   closed. Policy exceptions are denials.
5. Denied and approval-required requests do not reach the resource adapter.
6. Approval creates no authority. Resume replays the saved call through the
   complete gate with branded, package-internal approval evidence.
7. Object definitions are immutable after registration. A stable Object id
   cannot be rebound to a different identity after restart.
8. Contexts, capabilities, slots, pending calls, claims, results, and audits
   have one durable representation: SQLite. There is no in-memory authority
   cache.

This model provides isolation only when the surrounding control plane keeps its
side of the boundary: Context identity and Object bindings must come from
trusted channel state, policies must decide from trusted facts, and adapters
must be the only code holding real resources.

## Minimal trusted-control-plane example

```ts
import {
  CapabilityService,
  SqliteCapabilityStore,
  type PolicyDecision,
} from "@octo-kit/capability-kernel";

const store = new SqliteCapabilityStore("./capabilities.db");
const service = new CapabilityService({ store });

service.registerObject({
  id: "document:roadmap",
  kind: "document",
  binding: { text: "Draft" },
  operations: {
    read: { effect: "read", args: {} },
    replace: {
      effect: "modify",
      args: { text: { type: "string", required: true, maxLength: 100_000 } },
    },
  },
  policy(input): PolicyDecision {
    if (input.operation === "read") return { kind: "allow" };
    if (input.approval) return { kind: "allow" };
    return {
      kind: "approval_required",
      summary: {
        title: "Replace roadmap document",
        target: input.object.id,
        details: [`${String(input.args.text).length} characters`],
        allowedApprover: input.context.metadata.owner,
      },
    };
  },
  async adapter(document, operation, args) {
    if (operation === "read") return document.text;
    document.text = String(args.text);
    return { saved: true };
  },
});

const account = service.createContext("account", { owner: "alice" });
const run = service.createContext("agent-run", { owner: "alice" }, account);

service.mintRoot(account, "roadmap", "document:roadmap", ["read", "replace"]);
service.derive(account, "roadmap", run, "roadmap", ["read", "replace"]);

// This is the whole capability API handed to the untrusted runtime.
const capabilities = service.bind(run);
const result = await capabilities.request("roadmap", "read", {});
```

The default root terms auto-allow only requested operations whose declared
effect is `observe` or `read`. `modify` and `execute` operations require a
per-call approval unless the trusted issuer explicitly includes them in
`autoAllow`; derived grants still cannot widen their parent's terms.

## Approval flow

When a policy returns `approval_required`, the untrusted caller receives only a
pending-call id. The trusted approval surface uses the service methods:

```ts
const cards = service.listPending("alice");
const final = await service.approve(cards[0].id, "alice");

// The original caller can read only results visible from its bound Context.
const ownResult = capabilities.result(cards[0].id);
```

Pending ids are not credentials: result lookup is scoped to the bound Context
or its ancestors. Repeated approval returns the recorded result and does not
execute the adapter again. If an adapter throws `IndeterminateOutcome`, the
terminal result is `unknown`; callers must consult `retrySafe` before deciding
whether issuing a new request is safe.

After a process interruption, claimed retry-safe operations are returned to
their existing pending state without being executed. Claimed non-retry-safe
operations become terminal `unknown`. Recovery itself never calls an adapter.

## Persistence and lifecycle

`SqliteCapabilityStore` uses WAL mode, full synchronous writes, a single-writer
lease, and restrictive file permissions. Pass an explicit database path in
production; the service default is an in-memory store intended for tests.
Call `service.close()` during orderly shutdown.

Destroy a Context immediately when its authority must end. For a short-lived
request holder whose already-created approval must remain actionable, use
`destroyContext(contextId, { deferWhilePending: true })`; the service destroys
it after all descendant pending calls become terminal. This option is a
lifecycle tool, not a substitute for revocation.

## Public surface

The main entry point exports:

- `CapabilityService` and `SqliteCapabilityStore`;
- capability, Object, policy, adapter, result, persistence, and audit types;
- `validateArgs`, `argsTooLarge`, `canonicalJson`, and `hashArgs`;
- `IndeterminateOutcome`, `StoreOwnershipError`, and the closed `EFFECTS` list.

Internal graph and gate instances and the approval-evidence minting function are
intentionally not exported. Do not add an alternate invocation path around
`CapabilityService.bind()` or treat audit output as authority.

### Dependency failures

A trusted adapter may throw `DependencyUnavailable(resource, detail)` when its dependency was
unavailable before any effect (or a read lost its response). An immediate failed invocation then
carries structured `dependency` evidence. Error text and lookalike properties do not acquire that
classification. The kernel performs no retry, grants no new authority, and preserves existing
`IndeterminateOutcome` behavior for uncertain effects. Durable approval results retain their
existing terminal failure semantics; this additional immediate evidence does not reopen an approval.
