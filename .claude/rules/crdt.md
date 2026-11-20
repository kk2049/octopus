---
paths:
  - "packages/agent-crdt-view/**/*"
  - "packages/crdt-doc-contract/**/*"
  - "packages/bot/src/crdt-doc/**/*"
---

# CRDT and collaboration

- The untrusted View has one MessagePort and `connect-src 'none'`; do not add a
  Yjs network/indexeddb provider or a second transport.
- Do not poll capability-bearing resources and do not disguise the absence of
  push/presence with a loading animation.
- Send a diff against the last trusted server state vector instead of keeping a
  lossy queue of merged updates in the View.
- Persist in this order: validate, append and fsync, apply in memory, then
  reply. Invalid updates never enter the replay log.
- Do not store CRDT binary state in App State; that log has different bounds
  and projection semantics.
- Read `doc/development/crdt-p6c-worklog.md` before changing the collaboration
  model.
