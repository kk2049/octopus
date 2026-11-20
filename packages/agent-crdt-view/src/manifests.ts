/**
 * The collaborative-note manifest, as pure data.
 *
 * Separated from the component so that something with no DOM can read it: a
 * release builder has to emit the module lock and the binding plan as JSON
 * assets, and it runs in a Node process that has no business importing React or
 * a stylesheet.
 *
 * The split is also what makes the lock trustworthy. `modules.tsx` pairs this
 * with its component, and the registry DERIVES the lock from the manifests it
 * was given — so the file a release ships and the object that can mount come
 * from one statement, not two that happen to agree.
 */

import type { AgentModuleManifest } from "@claude-bot/agent-module-contract";
import { CRDT_DOC_CONTRACT, CRDT_DOC_CONTRACT_V2, CRDT_NOTE_RESOURCE_KIND } from "@claude-bot/crdt-doc-contract";

// Compatibility re-export, the same one the workspace-files modules make: the
// kind's ownership is the port ABI, so a second editor can declare that it opens
// the same documents without depending on this particular implementation.
export { CRDT_NOTE_RESOURCE_KIND } from "@claude-bot/crdt-doc-contract";

const VERSION = "1.1.0";
const PACKAGE = "@claude-bot/agent-crdt-view";

export const CRDT_NOTE_MODULE_ID = "crdt.note/v1";
export const CRDT_DOC_LIST_MODULE_ID = "crdt.doc-list/v1";

export const CRDT_NOTE_MANIFEST: AgentModuleManifest = {
  id: CRDT_NOTE_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#CollabNote`,
  title: "协作文档",
  // `primary` first: a document being edited by several people is the thing
  // somebody is looking at, not a side panel. `secondary` is there so a
  // composition can put one beside a primary surface it does not own — which
  // is where Session Plus stands it.
  slots: ["primary", "secondary"],
  // Both versions present the same `CrdtDocPort`; v2 has no document ceiling.
  ports: [CRDT_DOC_CONTRACT, CRDT_DOC_CONTRACT_V2],
  opens: [CRDT_NOTE_RESOURCE_KIND],
};

/**
 * The rail that makes documents FINDABLE (2026-08-10).
 *
 * The contract's bootstrap verb (`list_docs`) exists because every other
 * action needs a ref and nothing could hand a View its first one; this module
 * is that verb's consumer. It enumerates once at mount and on an explicit
 * refresh — never on a timer — and raises `open-resource/v1` intents that the
 * App's composition routes at the note surface.
 */
export const CRDT_DOC_LIST_MANIFEST: AgentModuleManifest = {
  id: CRDT_DOC_LIST_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#DocList`,
  title: "文档",
  slots: ["navigation"],
  // Both versions present the same `CrdtDocPort`; v2 has no document ceiling.
  ports: [CRDT_DOC_CONTRACT, CRDT_DOC_CONTRACT_V2],
  opens: [],
};

/** Every crdt manifest, in registration order. */
export const CRDT_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([
  CRDT_NOTE_MANIFEST,
  CRDT_DOC_LIST_MANIFEST,
]);
