---
paths:
  - "packages/agent-*/**/*"
  - "packages/session-plus-view/**/*"
  - "packages/showcase-view/**/*"
  - "packages/chess-view/**/*"
  - "packages/app-registry/**/*"
  - "packages/app-runtime/**/*"
  - "packages/app-state/**/*"
  - "packages/bot/src/app-registry/**/*"
  - "packages/bot/src/app-agents/**/*"
  - "packages/bot/src/session-plus/**/*"
---

# Agentic Apps and shared frontend runtimes

- Keep contracts, reusable modules, App composition and host/provider wiring
  explicit. Dependencies point toward contracts, never a composition root.
- Current repository Apps export pure ESM React components. Dashboard mounts
  them in its existing React/Ant tree; do not add another React root, iframe,
  MessagePort handshake or isolation self-test to a new App.
- SDK hooks receive a caller-owned runtime. The host owns HTTP/SSE, drafts,
  instance/release binding and teardown. Every resource/action request is
  still authorized by the server; App code is reviewed internal frontend code,
  and must not be treated as a browser sandbox for hostile publishers.
- App CSS, portals and resize classes stay within the App surface. Shared
  React/UI imports resolve through the versioned host runtime import map.
- Module lock, composition, resource bindings, permissions, prompts, ESM entry
  and every declared auxiliary asset are immutable package-digest inputs.
  Missing assets, incompatible runtime ABI and stale builds fail closed.
- Only installed legacy IIFE releases use the host's old iframe loader, so
  rollback remains possible. Do not reinterpret an old release as an ESM App.
- A module emits layout/resource intents; it does not maintain another layout
  system. Composition and bindings connect named instances explicitly.
- Backend agents use the same dispatch path as human actions and do not
  replay a failed non-idempotent turn. An agent acting for the owner on the
  owner's own resources gets the owner's silent terms (owner decision,
  2026-10-15); a share guest does not get owner-only silence.
- Read the nearest package document and
  `doc/development/shared-app-frontend.md` before structural frontend work.
