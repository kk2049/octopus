/**
 * A stable store per bound port. Orchestration remains in one controller; each
 * resource surface subscribes only to its immutable display slice.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { SessionsPort } from "@claude-bot/agent-sessions-contract";
import { useSessionsController, type SessionsController } from "./controller.js";
import type { ComposerDraftPersistence } from "./composer-drafts.js";
import { createSessionsStore, sessionNavigationSnapshot, sessionSearchSnapshot, sessionResourceSnapshot, shareSessionValue } from "./resource-store.js";

const SessionsContext = createContext<ReturnType<typeof createSessionsStore> | null>(null);
const SessionsControllerContext = createContext<SessionsController | null>(null);
const AsyncQuestionPersistenceContext = createContext<ComposerDraftPersistence | undefined>(undefined);

export const useAsyncQuestionPersistence = () => useContext(AsyncQuestionPersistenceContext);

export interface SessionsProviderProps {
  port: SessionsPort;
  wakeToken?: number;
  draftPersistence?: ComposerDraftPersistence;
  /** Browser-local ignored-question preferences, separate from composer text. */
  asyncQuestionPersistence?: ComposerDraftPersistence;
  initialSelectedResource?: string | null;
  children: ReactNode;
}

export function SessionsProvider({ port, wakeToken, draftPersistence, asyncQuestionPersistence, initialSelectedResource, children }: SessionsProviderProps) {
  const controller = useSessionsController(port, wakeToken, draftPersistence, initialSelectedResource);
  const store = useMemo(() => createSessionsStore(controller), [port]);
  useLayoutEffect(() => store.update(controller), [controller, store]);
  return <SessionsContext.Provider value={store}>
    <SessionsControllerContext.Provider value={controller}>
      <AsyncQuestionPersistenceContext.Provider value={asyncQuestionPersistence}>{children}</AsyncQuestionPersistenceContext.Provider>
    </SessionsControllerContext.Provider>
  </SessionsContext.Provider>;
}

function useSessionsStore() {
  const store = useContext(SessionsContext);
  if (!store) throw new Error("sessions modules require a <SessionsProvider> above them");
  return store;
}

/** Forms must receive controlled values in the controller's own commit. Going
 * through the layout-effect store publication leaves an intermediate commit
 * with the previous value, which can cancel an active IME composition. */
export function useSessions(): SessionsController {
  const controller = useContext(SessionsControllerContext);
  if (!controller) throw new Error("sessions modules require a <SessionsProvider> above them");
  return controller;
}

export function useSessionResource(resource: string | null) {
  const select = useCallback((controller: SessionsController) => sessionResourceSnapshot(controller, resource), [resource]);
  const [value, actions] = useSessionsSlice(select);
  return useMemo(() => ({ ...value, actions }), [value, actions]);
}

/** Equal full frames keep the selected data and command object stable. */
function useSessionsSlice<T>(select: (controller: SessionsController) => T) {
  const store = useSessionsStore();
  const snapshot = useMemo(() => {
    let previousController: SessionsController | undefined;
    let value: T;
    return () => {
      const controller = store.snapshot();
      if (controller !== previousController) {
        value = shareSessionValue(previousController ? value : undefined, select(controller));
        previousController = controller;
      }
      return value;
    };
  }, [select, store]);
  const value = useSyncExternalStore(store.subscribe, snapshot, snapshot);
  return [value, store.actions] as const;
}

export function useSessionNavigation() {
  const [value, actions] = useSessionsSlice(sessionNavigationSnapshot);
  return useMemo(() => ({ ...value, ...actions }), [value, actions]);
}

export function useSessionSearch() {
  const [value, actions] = useSessionsSlice(sessionSearchSnapshot);
  return useMemo(() => ({ ...value, ...actions }), [value, actions]);
}
