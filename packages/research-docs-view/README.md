# 研究文档
An independent shared App at /apps/research-docs/open. BlockNote supplies the rich block editor; Yjs owns rich text and block order. The Octopus App action channel is the only network transport. The host validates membership, a new permission digest and original research resource grants on every operation.

The library is server-owned metadata. Each page has an independent durable CRDT update log. Draft replicas are private to the viewer, space and page; refused writes stop automatic synchronization and preserve the draft for explicit retry/export. Received updates do not replace the editor or selection. Files and audio bytes live outside CRDT; blocks hold immutable attachment IDs or fixed project/node references. Imported pages are editable snapshots with source links. Import never edits the original project, launches agents, sends messages or transcribes audio.

Plugins are reviewed React components in src/plugins.tsx. They declare labels, resource kinds and renderers. Document data cannot install executable code. Unknown plugins retain their reference and show a fallback. The source panel reuses existing research resource components and all calls pass the original research-v2 Gate as the current caller.

Run the package typecheck/build and focused Vitest tests on a compute device. The HTTP fixture uses real App instances, permissions, CRDT persistence and two separately authenticated users. Production acceptance must exercise independent users, concurrent text edits, reconnect, sharing revocation, resource access, attachment round-trips and narrow screens.
