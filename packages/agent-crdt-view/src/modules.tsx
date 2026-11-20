/**
 * The collaborative-note module: a manifest and a mount.
 *
 * ── What lives here rather than in the component ───────────────────────────
 *
 * The per-instance `NoteSession`, and nothing else. One mounted panel is one
 * collaborator: it holds its own `Y.Doc` replica, its own pending queue and its
 * own sync cycle. That is also what lets a harness render `CollabNote` from a
 * fixture with no port at all, and what makes two panels in one browser a
 * genuine two-client convergence case rather than two views of one object.
 *
 * ── The subscription is `useSyncExternalStore` ─────────────────────────────
 *
 * Because the session's state changes from three places that are not renders —
 * a Yjs `update` event, a debounce timer, and a settled proposal — and mirroring
 * those into `useState` is how a component ends up showing a document one edit
 * behind the replica it is supposedly displaying.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 *
 * No wire action strings, no channel primitives, no protocol constants, no
 * transport. This module imports `@claude-bot/agent-view-react/ui` and
 * `/workspace` — presentation and layout — plus the contract and Yjs. The App is
 * the thing that has a channel; a module has a port.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ModuleProps, ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { CRDT_NOTE_RESOURCE_KIND, type CrdtDocEntry, type CrdtDocPort } from "@claude-bot/crdt-doc-contract";
import { CollabNote } from "./components/CollabNote.js";
import { DocList, type DocListState } from "./components/DocList.js";
import { useCrdtDoc } from "./context.js";
import { NoteSession } from "./lib/session.js";
import { CRDT_DOC_LIST_MANIFEST, CRDT_NOTE_MANIFEST } from "./manifests.js";

/** First instance keeps the plain DOM hooks; a later copy gets a namespace. */
function useDomIdScope({ panel, workspace }: ModuleProps): string | undefined {
  const [scope] = useState(() => {
    const first = workspace.state.panels.find((candidate) => candidate.moduleId === panel.moduleId);
    return first?.panelId === panel.panelId ? undefined : panel.panelId;
  });
  return scope;
}

function CollabNoteModule({ panel, workspace }: ModuleProps) {
  const { port, wakes } = useCrdtDoc();
  const domIdScope = useDomIdScope({ panel, workspace });
  const ref = panel.resourceRef;
  const wakeToken = ref ? wakes[ref] ?? 0 : 0;

  /**
   * One session per (port, document), CREATED BY THE EFFECT THAT OWNS IT.
   *
   * The obvious shape — `useMemo` to build it, an effect to open and destroy it
   * — is wrong, and StrictMode says so out loud: React probes an effect with
   * setup → cleanup → setup, so the second setup gets a session the cleanup has
   * already destroyed, and a destroyed session cannot reopen. The panel then
   * sits on "opening" for ever. That is not a StrictMode artefact; it is what
   * happens whenever React re-attaches an effect, and it would show up in
   * production as a note that never loads after some unrelated remount.
   *
   * So each effect run creates its own session and tears down exactly that one.
   * Rebuilding on either dependency is not just hygiene: a replica carries the
   * document's history, so reusing it across documents would merge two unrelated
   * notes, and reusing it across ports would keep editing under an authority
   * that has been replaced.
   */
  const [session, setSession] = useState<NoteSession | null>(null);

  useEffect(() => {
    if (!ref) {
      setSession(null);
      return undefined;
    }
    const made = new NoteSession({ port, doc: ref });
    setSession(made);
    void made.open();
    return () => {
      made.destroy();
      // Only if nothing has replaced it since: React may run this cleanup after
      // the next effect's setup, and clearing unconditionally there would blank
      // the live session.
      setSession((current) => (current === made ? null : current));
    };
  }, [port, ref]);

  const subscribe = useCallback(
    (listener: () => void) => (session ? session.subscribe(listener) : () => {}),
    [session],
  );
  const snapshot = useCallback(() => session?.getState() ?? IDLE, [session]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);

  // ADR 0006: a wake token moved, so the trusted side says this document
  // changed. The SESSION decides what that means — a fetch only while its
  // last exchange was clean, a rendered hint otherwise — so ten wakes after
  // one refusal are ten renders and zero proposals. Token zero is "no wake
  // ever", which is exactly the old behaviour.
  useEffect(() => {
    if (wakeToken > 0) session?.wake();
  }, [wakeToken, session]);

  return (
    <CollabNote
      hasDocument={ref !== null}
      label={panel.label}
      state={state}
      domIdScope={domIdScope}
      onChange={(text) => session?.setText(text)}
      onSync={() => void session?.sync()}
      {...(ref ? { onClose: () => workspace.close(panel.panelId) } : {})}
    />
  );
}

/** A standing panel with nothing opened into it has no session and no state. */
const IDLE = Object.freeze({
  status: "idle" as const,
  text: "",
  unsent: false,
  syncing: false,
  incompatible: false,
  message: "",
  code: "" as const,
  syncedAt: null,
  remoteHint: false,
});

/**
 * The document rail: one `listDocs` at mount, refresh by explicit gesture.
 *
 * State is per (port, mount) and owned the same way the note session is — by
 * the effect that made the request — so a StrictMode re-attach issues its own
 * enumeration rather than adopting a torn one. A stale answer (the port
 * changed underneath a slow reply) is dropped by identity comparison.
 */
function DocListModule({ panel, workspace }: ModuleProps) {
  const { port } = useCrdtDoc();
  const domIdScope = useDomIdScope({ panel, workspace });
  const [scoped, setScoped] = useState<{ port: CrdtDocPort; state: DocListState }>(() => ({
    port,
    state: LOADING,
  }));
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let live = true;
    setScoped({ port, state: LOADING });
    void port.listDocs().then((answer) => {
      if (!live) return;
      setScoped({
        port,
        state: answer.ok
          ? { status: "ready", docs: answer.value.docs, message: "" }
          : { status: "refused", docs: [], message: answer.message },
      });
    });
    return () => {
      live = false;
    };
  }, [port, epoch]);

  const state = scoped.port === port ? scoped.state : LOADING;
  // Which document is on show: the note module's panel in this workspace, if
  // any — read from layout state the coordinator already publishes, so the
  // rail's highlight cannot disagree with the panel it points at.
  const activeRef =
    workspace.state.panels.find(
      (candidate) => candidate.resourceKind === CRDT_NOTE_RESOURCE_KIND && candidate.resourceRef !== null,
    )?.resourceRef ?? null;

  return (
    <DocList
      state={state}
      activeRef={activeRef}
      domIdScope={domIdScope}
      onRefresh={() => setEpoch((n) => n + 1)}
      onOpen={(entry: CrdtDocEntry) =>
        workspace.open({ kind: CRDT_NOTE_RESOURCE_KIND, ref: entry.doc, label: entry.title })
      }
    />
  );
}

const LOADING: DocListState = Object.freeze({ status: "loading", docs: Object.freeze([]), message: "" });

/**
 * The module, ready to be registered.
 *
 * An App picks from this list rather than assembling the entry itself: a
 * manifest and its component belong together, and a composition that could pair
 * a manifest with a different implementation would make the lock a claim rather
 * than a fact.
 */
export const CRDT_NOTE_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: CRDT_NOTE_MANIFEST,
  component: CollabNoteModule,
});

export const CRDT_DOC_LIST_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: CRDT_DOC_LIST_MANIFEST,
  component: DocListModule,
});

export const CRDT_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([
  CRDT_NOTE_MODULE,
  CRDT_DOC_LIST_MODULE,
]);
