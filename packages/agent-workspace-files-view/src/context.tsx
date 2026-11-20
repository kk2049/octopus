/**
 * How a workspace-files module gets its port.
 *
 * One provider per bound port, and the modules read it from context — the same
 * shape `agent-sessions/v1` uses, and for the same reason: every module taking a
 * `port` prop would put the same wiring in every composition and make "which
 * port is this module on" an App-level detail that has to be right in N places.
 *
 * ── What the provider owns, and what it deliberately does not ───────────────
 *
 * It owns exactly one thing: the ROOTS. Enumerating the registered workspaces is
 * one capability call per refresh, and two file trees mounted side by side must
 * not each spend one — an approval card is per call, so a duplicate enumeration
 * is a duplicate thing to click. The provider does NOT enumerate on its own:
 * mounting only a FileViewer must not spend the FileTree's capability call. A
 * tree asks for roots when it mounts.
 *
 * Everything else — which directories are expanded, what is cached, which file
 * is selected, what a listing refused — belongs to the mounted instance. A
 * second tree is a second reader's view of the same workspace, and their
 * expansion state is not shared state; it is not written to App State or to a
 * database either, because a tree's shape is not durable App data.
 *
 * ── What is absent ─────────────────────────────────────────────────────────
 *
 * A client, a message channel, an owner, a scope, an instance handle, an action
 * string. This file takes either version's workspace-files port — the same
 * three named methods — and nothing here could name the transport underneath
 * it if it tried.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AnyWorkspaceFilesPort,
  WorkspaceFilesRoots,
} from "@claude-bot/workspace-files-contract";
import type { FileAnnotationsAdapter, ListedFileLocation, PublishedFileLinks } from "@claude-bot/agent-file-preview";

export interface RootsState {
  status: "idle" | "loading" | "ready" | "refused";
  /** Every roots page loaded so far; `truncated` says more follow the last. */
  value: WorkspaceFilesRoots | null;
  /** Bounded text the Host wrote, when the last refresh was refused. */
  message: string;
  code: string;
  /** The next roots page: in flight, or refused. Absent while idle. */
  more?: { status: "loading" } | { status: "refused"; message: string; code: string };
}

export interface FileNavigation {
  /** Local generation token; never sent to a resource port. */
  scope: symbol;
  reveal(ref: string, location: ListedFileLocation): void;
  current: { resource: string; phase: "pending" | "succeeded" | "refused"; message: string } | null;
}

export interface WorkspaceFilesController {
  navigation?: FileNavigation;
  links?: PublishedFileLinks;
  port: AnyWorkspaceFilesPort;
  roots: RootsState;
  /** Each accepted roots refresh also invalidates mounted directory caches. */
  refreshVersion: number;
  /** Re-enumerate. Single-flight: a refresh while one is in flight is a no-op. */
  refreshRoots(): void;
  /**
   * Load the next roots page after the last root held, when the answer said
   * more follow. One page per call, sharing `refreshRoots`'s single flight.
   * Optional so a hand-built controller (a harness) stays valid.
   */
  loadMoreRoots?(): void;
  /**
   * Optional App-provided reader/writer for per-file annotations. The provider
   * itself never stores the list; the composition is responsible for wiring
   * this to a durable channel (App event stream, CRDT doc, etc.). Absence is
   * a composition statement — module code renders honestly without a panel.
   */
  annotations: FileAnnotationsAdapter | null;
}

const EMPTY: RootsState = Object.freeze({ status: "idle", value: null, message: "", code: "" });

const WorkspaceFilesContext = createContext<WorkspaceFilesController | null>(null);

export interface WorkspaceFilesProviderProps {
  navigation?: FileNavigation;
  links?: PublishedFileLinks;
  port: AnyWorkspaceFilesPort;
  annotations?: FileAnnotationsAdapter;
  children: ReactNode;
}

/**
 * What is in flight, and for WHICH port.
 *
 * A pair rather than a boolean, because the two questions a shared `busy` flag
 * conflates have different answers: "is a refresh already running that I should
 * join?" is about the CURRENT port, while "may this answer land?" is about the
 * port it was issued against. With one boolean, an old port's late answer both
 * overwrote the new port's state and cleared the new port's flag — leaving a
 * provider that showed the wrong workspaces and would not refresh out of it.
 */
interface Inflight {
  port: AnyWorkspaceFilesPort;
  /**
   * A refresh joins only a refresh. A page load in flight is superseded by a
   * refresh (its late answer is dropped by the token check), never joined:
   * a person who pressed 刷新 asked for page one again.
   */
  kind: "refresh" | "page";
  token: symbol;
  promise: Promise<void>;
}

interface ScopedRoots {
  port: AnyWorkspaceFilesPort;
  roots: RootsState;
  refreshVersion: number;
}

export function WorkspaceFilesProvider({ port, annotations, links, navigation, children }: WorkspaceFilesProviderProps) {
  const [scoped, setScoped] = useState<ScopedRoots>(() => ({ port, roots: EMPTY, refreshVersion: 0 }));
  /**
   * The port whose answers may land. Set in the effect, cleared on unmount.
   *
   * Compared by IDENTITY against the port a request was issued with, so a
   * result from a replaced port is dropped rather than raced — and so the
   * StrictMode setup → cleanup → setup probe, which re-runs the effect with the
   * SAME port object, joins the request already in flight instead of issuing a
   * second capability call.
   */
  const current = useRef<AnyWorkspaceFilesPort | null>(null);
  const inflight = useRef<Inflight | null>(null);

  const refreshRoots = useCallback(() => {
    // Already running for this exact port: join it. Not a "drop the second
    // click" rule — the caller gets the answer either way — but a "do not spend
    // a second capability call" one, and one call is one approval card.
    if (inflight.current && inflight.current.port === port && inflight.current.kind === "refresh") return;
    const token = Symbol("workspace-roots-request");
    setScoped((previous) => ({
      port,
      refreshVersion: (previous.port === port ? previous.refreshVersion : 0) + 1,
      roots:
        previous.port === port && previous.roots.status === "loading"
          ? previous.roots
          : { ...(previous.port === port ? previous.roots : EMPTY), status: "loading" },
    }));
    const settle = (next: RootsState): void => {
      // Release the in-flight slot FIRST, unconditionally. Doing it after the
      // liveness check would leave a settled request recorded as running if the
      // answer landed while no port was claimed, and the next mount would then
      // "join" a promise that has already finished — a provider stuck on
      // loading with nothing left to wake it.
      if (inflight.current?.token !== token) return;
      inflight.current = null;
      // Only the CURRENT port's answer may be written. An old port's late reply
      // is dropped: it describes workspaces this scope is no longer reading.
      if (current.current !== port) return;
      setScoped((previous) => ({ ...previous, port, roots: next }));
    };
    const promise = port.refreshRoots().then(
      (answer) => {
        settle(
          answer.ok
            ? { status: "ready", value: answer.value, message: "", code: "" }
            : { status: "refused", value: null, message: answer.message, code: answer.code },
        );
      },
      () => {
        // The port promises to resolve; a rejection means a broken
        // implementation of it, and a stuck in-flight record would be worse
        // than an honest refusal.
        settle({ status: "refused", value: null, message: "工作区列表没有返回结果。", code: "unavailable" });
      },
    );
    inflight.current = { port, kind: "refresh", token, promise };
  }, [port]);

  const loadMoreRoots = useCallback(() => {
    if (inflight.current && inflight.current.port === port) return;
    const held = scoped.port === port ? scoped.roots : EMPTY;
    const last = held.value?.roots.at(-1);
    if (held.status !== "ready" || !held.value?.truncated || !last) return;
    const token = Symbol("workspace-roots-page");
    setScoped((previous) => previous.port === port && previous.roots.status === "ready"
      ? { ...previous, roots: { ...previous.roots, more: { status: "loading" } } }
      : previous);
    const settle = (apply: (roots: RootsState) => RootsState): void => {
      if (inflight.current?.token !== token) return;
      inflight.current = null;
      if (current.current !== port) return;
      setScoped((previous) => previous.port === port && previous.roots.status === "ready" && previous.roots.value
        ? { ...previous, roots: apply(previous.roots) }
        : previous);
    };
    const refused = (message: string, code: string) => (roots: RootsState): RootsState =>
      ({ ...roots, more: { status: "refused", message, code } });
    const promise = port.refreshRoots(last.ref).then(
      (answer) => {
        if (!answer.ok) {
          settle(refused(answer.message, answer.code));
          return;
        }
        settle((roots) => {
          const held = roots.value!;
          const known = new Set(held.roots.map((root) => root.ref));
          // A page that repeats a root we hold did not continue after the
          // cursor (an older Host); appending it would list workspaces twice.
          if (answer.value.roots.some((root) => known.has(root.ref))) {
            return refused("服务端没有按位置继续列出工作区（可能是较旧的版本）。", "unavailable")(roots);
          }
          const { more: _more, ...rest } = roots;
          return {
            ...rest,
            value: { ...held, roots: [...held.roots, ...answer.value.roots], truncated: answer.value.truncated },
          };
        });
      },
      () => settle(refused("工作区列表的下一页没有返回结果。", "unavailable")),
    );
    inflight.current = { port, kind: "page", token, promise };
  }, [port, scoped]);

  useEffect(() => {
    current.current = port;
    return () => {
      // Only relinquish if nothing has claimed the slot since. React runs the
      // cleanup of the old effect AFTER the new one's setup in some orders, and
      // clearing unconditionally there would silence the live port.
      if (current.current === port) current.current = null;
    };
  }, [port]);

  // State is tagged with the port that produced it. A render can observe a new
  // prop before effects commit; deriving the exposed value here ensures that
  // render still cannot show the old scope's workspace names or refs.
  const roots = scoped.port === port ? scoped.roots : EMPTY;

  return (
    <WorkspaceFilesContext.Provider value={{ ...(navigation ? { navigation } : {}), port, roots, refreshVersion: scoped.port === port ? scoped.refreshVersion : 0, refreshRoots, loadMoreRoots, annotations: annotations ?? null, ...(links ? { links } : {}) }}>
      {children}
    </WorkspaceFilesContext.Provider>
  );
}

export function useWorkspaceFiles(): WorkspaceFilesController {
  const controller = useContext(WorkspaceFilesContext);
  if (!controller) throw new Error("workspace-files modules require a <WorkspaceFilesProvider> above them");
  return controller;
}

/**
 * The same controller, or null when no provider is mounted.
 *
 * For a module that treats the file plane as an ENHANCEMENT rather than a
 * requirement — a sessions surface that joins file rows when a port exists and
 * renders honestly without one. Absence is a composition's statement, not an
 * error, so this hook does not throw.
 */
export function useOptionalWorkspaceFiles(): WorkspaceFilesController | null {
  return useContext(WorkspaceFilesContext);
}
