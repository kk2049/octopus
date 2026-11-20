/**
 * How a data module gets its port — and its snapshot.
 *
 * One provider per bound port, and the modules read it from context. The
 * alternative — every module taking a `port` prop — would put the same wiring in
 * every composition and make "which port is this module on" an App-level detail
 * that has to be right in N places.
 *
 * ── Why the provider subscribes and the modules do not ─────────────────────
 *
 * Three modules rendering the same projection must observe the same value in
 * the same commit. `useSyncExternalStore` guarantees that per subscriber, but
 * three subscribers each holding their own copy is three chances to tear under
 * concurrent rendering; subscribing once here and passing the snapshot down
 * through context makes "everything below sees one projection" structural.
 *
 * It is a LIGHT provider on purpose. It owns no request book, no cache and no
 * selection: unlike an enumeration, reading a projection costs nothing and is
 * not a capability call, so there is nothing to de-duplicate. Everything a
 * module derives from the snapshot — which row is selected, what is typed into a
 * form — belongs to the mounted instance, because a second list beside the first
 * is a second reader's view and not shared state.
 *
 * ── What is absent ─────────────────────────────────────────────────────────
 *
 * A client, a message channel, an owner, a scope, an instance handle, an action
 * string. This file takes an `AppDataPort` and nothing here could name the
 * transport underneath it if it tried.
 */

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { AppDataPort, AppDataReply, AppDataSnapshot } from "./port.js";

export interface AppDataController {
  port: AppDataPort;
  /** The Host's current projection and phase. Replaced wholesale, never merged. */
  snapshot: AppDataSnapshot;
  /** Propose one of the App's own actions. Never rejects. */
  submit(action: string, values: Readonly<Record<string, string>>): Promise<AppDataReply>;
  clearRefusal(): void;
  /** Drop one refused ledger entry after showing it. */
  dismissProposal(rid: string): void;
}

const AppDataContext = createContext<AppDataController | null>(null);

export interface AppDataProviderProps {
  port: AppDataPort;
  children: ReactNode;
}

export function AppDataProvider({ port, children }: AppDataProviderProps) {
  // `port.snapshot` is required to be identity-stable while nothing changed —
  // both the real adapter and the harness memoise it — so this compares by
  // identity and never tears, including under concurrent rendering.
  const snapshot = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  const controller = useMemo<AppDataController>(
    () => ({
      port,
      snapshot,
      submit: (action, values) => port.submit(action, values),
      clearRefusal: () => port.clearRefusal(),
      dismissProposal: (rid) => port.dismissProposal(rid),
    }),
    [port, snapshot],
  );
  return <AppDataContext.Provider value={controller}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataController {
  const controller = useContext(AppDataContext);
  if (!controller) throw new Error("data modules require an <AppDataProvider> above them");
  return controller;
}
