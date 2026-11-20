---
paths:
  - "packages/dashboard-web/**/*"
  - "packages/agent-*view*/**/*"
  - "packages/session-plus-view/**/*"
  - "packages/showcase-view/**/*"
  - "packages/chess-view/**/*"
  - "packages/bot/src/session-plus/**/*"
  - "packages/bot/src/session-resource/**/*"
---

# Frontend interaction stability and action lifecycle

Design rationale: `doc/development/frontend-interaction-stability-design.md`.

## Interaction-state ownership

- Key user-owned interaction state (selection, expansion, drafts, scroll
  anchors) by stable semantic identity — resourceId, absolute message offset,
  directoryKey. Never a list index.
- Store that state where data frames cannot rebuild it: controller/store level,
  or components mounted under a stable key. No conditional component-type
  switches around stateful subtrees; render transient empty/error/loading
  states in place (hide, don't unmount).
- Data frames initialize defaults; they never reset a user's explicit choice.
  Absence of the selected item in one frame is not deletion: keep the
  selection and render a placeholder instead of moving focus.
- Derived display state uses `userOverride ?? derivedDefault(stableKey)`.
  Derived defaults change only at semantic boundaries; overrides are sticky.
- Every async result must pass a generation/abort guard before writing shared
  state. Stale responses are dropped, never applied.
- Refresh results that are content-equal must keep object identity
  (structural sharing) so memo/effect chains do not fire on no-change.

## Action lifecycle

- Every user action shows a local pending state within one frame, reconciled
  by correlation id (`rid`/`opId`) — pending → confirmed (drop overlay after
  the authoritative frame) or refused (revert with a bounded reason, restore
  user input). Receipts are consumed, never `void`-discarded.
- Pending/optimistic overlays are module render inputs layered over the
  authoritative projection. The projection itself is still replaced wholesale;
  never merge or mutate it locally.
- Rule-gate refusals must carry the handler's bounded message (truncated, no
  stack); do not genericize it away.

## Sync-layer bounds

- Projection pushes carry a monotonic revision; consumers drop duplicate or
  stale frames.
- Projections are bounded: accumulating maps (transcripts per resource) are
  LRU-evicted; consumers re-request evicted data through their existing
  single-flight paths.
- Caches live in the View controller (per-generation, dropped on port change)
  or on the trusted/device side (reuse of post-Gate results, invalidated by
  wake). Contract layers (`typed-port-kit`, `remote-core`) stay cache-free.
  A cache hit never skips a Gate decision.
- Partial device fan-out failure keeps the last known rows for the missing
  device (marked stale) instead of dropping them for a frame.
- No automatic retries and no speculative prefetch for capability-bearing
  reads; prefetch only what an identical already-granted call has proven, and
  keep it bounded.
