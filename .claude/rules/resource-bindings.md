---
paths:
  - "packages/typed-port-kit/**/*"
  - "packages/*-contract/**/*"
  - "packages/capability-kernel/**/*"
  - "packages/resource-stream-contract/**/*"
  - "packages/workspace-files-contract/**/*"
  - "packages/bot/src/agent-resources/**/*"
  - "packages/bot/src/workspace-files/**/*"
  - "packages/bot/src/resource-stream/**/*"
  - "packages/bot/src/session-resource/**/*"
  - "packages/runner/**/*"
---

# Typed ports and trusted resources

- Define a typed-port contract once with `@claude-bot/typed-port-kit`; derive
  wire descriptors, MCP descriptors, readers, and conformance from it. Do not
  copy action strings or schemas into a second source of truth.
- Refusal codes are a closed vocabulary with an explicit fallback. Validate
  request/response echo and re-check destruction after every await boundary.
- `resource-stream/v1` is a payload ABI, not a typed port. Preserve its bounded,
  pull-based, cancelable, single-in-flight semantics.
- An App binding plan names contracts and instances, never implementations,
  owners, devices, paths, commands, grants, tokens, or provider packages.
- Identity and resource scope come from trusted closures, not proposal fields.
  Dispatch only through a handle bound to the opened instance.
- A new backend resource gets its own capability Object. Adding operations to
  an existing Object requires an explicit version and revocation analysis.
- Writes require an expected digest, atomic replacement, and an explicit
  `retrySafe` decision. Do not truncate oversized payloads.
- Read `doc/deliveries/2026-08-06-trusted-resource-binding-foundation.md` and
  the nearest contract/provider package docs before changing this boundary.
