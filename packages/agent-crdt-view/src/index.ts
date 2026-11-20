/**
 * `@claude-bot/agent-crdt-view` — the reusable collaborative-note module.
 *
 * ── The whole public surface ───────────────────────────────────────────────
 *
 * A provider that takes a `CrdtDocPort`, a hook to read it, one module entry,
 * one presentational component, the session object behind it, and the pure
 * manifest. Every omission is deliberate:
 *
 *  · no client, no channel, no transport — the App owns the channel;
 *  · no owner, scope, instance handle or capability — the View is never told;
 *  · no action strings — those belong to the contract;
 *  · no awareness/presence API — §15.4 keeps ephemeral state out of the
 *    persistent document, and the cheapest guarantee is having nowhere to put
 *    it. There is also nowhere it could travel: presence needs push, and this
 *    platform has none (see `lib/session.ts`).
 *
 * A consumer wires it in three lines: create a port, wrap the tree in
 * `<CrdtDocProvider port={…}>`, and register `CRDT_MODULES`.
 *
 * ── Its one third-party dependency ─────────────────────────────────────────
 *
 * `yjs`. The View holds a replica so that editing is local and a merge is
 * possible at all; the trusted side holds the authoritative one. Writing a CRDT
 * instead is ruled out by the design document (§12) and would be ruled out
 * anyway by the failure modes — a merge that is not commutative produces
 * documents that quietly differ per replica, months later.
 */

import "./crdt-note.css";

export {
  CrdtDocProvider,
  useCrdtDoc,
  type CrdtDocController,
  type CrdtDocProviderProps,
} from "./context.js";

export { CRDT_DOC_LIST_MODULE, CRDT_MODULES, CRDT_NOTE_MODULE } from "./modules.js";

export { CollabNote, type CollabNoteProps } from "./components/CollabNote.js";
export { DocList, type DocListProps, type DocListState } from "./components/DocList.js";

export {
  CRDT_DOC_LIST_MANIFEST,
  CRDT_DOC_LIST_MODULE_ID,
  CRDT_MANIFESTS,
  CRDT_NOTE_MANIFEST,
  CRDT_NOTE_MODULE_ID,
  CRDT_NOTE_RESOURCE_KIND,
} from "./manifests.js";

export {
  applyMarkdownCommand,
  type MarkdownCommand,
  type MarkdownEditState,
} from "./lib/markdown-edit.js";

export {
  NOTE_FIELD,
  NoteSession,
  decode,
  encode,
  type NoteSessionOptions,
  type NoteState,
  type NoteStatus,
} from "./lib/session.js";

export { diffText, type TextEdit } from "./lib/textdiff.js";
