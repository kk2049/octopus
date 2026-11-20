/**
 * How a collaborative-note module gets its port.
 *
 * One provider per bound port, and the module reads it from context — the same
 * shape `agent-sessions/v1` and `workspace-files/v1` use, and for the same
 * reason: every module taking a `port` prop would put the same wiring in every
 * composition and make "which port is this module on" an App-level detail that
 * has to be right in N places.
 *
 * ── What this provider owns: nothing ───────────────────────────────────────
 *
 * Unlike the workspace-files provider, which owns the roots because enumerating
 * them costs a capability call two trees must not each spend, this one owns no
 * shared state at all. Every panel has its OWN `Y.Doc` replica, its own pending
 * queue and its own sync cycle, because two panels on the same document are two
 * collaborators — sharing one replica between them would make the second panel
 * unable to demonstrate the thing the module exists to do.
 *
 * That has a real cost, stated rather than hidden: two panels on one document in
 * one browser tab pull separately, so they cost twice the calls and can briefly
 * disagree. A shared-replica optimisation is possible and deliberately not done
 * here, because it would make the module's behaviour depend on whether its peer
 * happens to be in the same tab.
 *
 * ── What is absent ─────────────────────────────────────────────────────────
 *
 * A client, a message channel, an owner, a scope, an instance handle, an action
 * string. This file takes a `CrdtDocPort` — three named methods — and nothing
 * here could name the transport underneath it if it tried.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { CrdtDocPort } from "@claude-bot/crdt-doc-contract";

export interface CrdtDocController {
  readonly port: CrdtDocPort;
  /**
   * Wake tokens per document ref (ADR 0006), supplied by the App.
   *
   * The App is the thing that owns the channel and may read the SDK root
   * entry; this module package may not, so the tokens arrive as ordinary
   * props on the provider — data, not transport. An App that predates the
   * wake channel simply never passes them, and every session then behaves
   * exactly as it did: manual sync, no hints.
   */
  readonly wakes: Readonly<Record<string, number>>;
}

const CrdtDocContext = createContext<CrdtDocController | null>(null);

export interface CrdtDocProviderProps {
  port: CrdtDocPort;
  wakes?: Readonly<Record<string, number>>;
  children: ReactNode;
}

const NO_WAKES: Readonly<Record<string, number>> = Object.freeze({});

export function CrdtDocProvider({ port, wakes, children }: CrdtDocProviderProps) {
  const value = useMemo(() => ({ port, wakes: wakes ?? NO_WAKES }), [port, wakes]);
  return <CrdtDocContext.Provider value={value}>{children}</CrdtDocContext.Provider>;
}

export function useCrdtDoc(): CrdtDocController {
  const controller = useContext(CrdtDocContext);
  if (!controller) throw new Error("crdt modules require a <CrdtDocProvider> above them");
  return controller;
}
