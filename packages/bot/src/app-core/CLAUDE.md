# Shared Agentic App core

This directory owns the release-neutral contracts and mechanics shared by the
compiled-in Session Plus composition and the generic App registry: manifest
parsing, release/identity facts, instance admission, projection caching, View
document packaging, hosting settings, trusted actor stamps, and the policy-free
State/Runtime coordination engine.

Dependencies point into this directory from composition roots. Production
files here must not import `../session-plus/` or `../app-registry/`; policy that
exists for only one composition stays at that root and is injected through a
narrow callback. Moving a responsibility here must preserve release bytes,
instance handle grammar, State stream keys, snapshot ABI, and refusal codes.

Focused verification:

```bash
npx vitest run --project node --maxWorkers=1 packages/bot/src/app-core
npx tsc --noEmit -p packages/bot/tsconfig.json
```
