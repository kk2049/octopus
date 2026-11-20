/**
 * One mounted surface's lazy directory book: expansion, per-directory cache,
 * selection, and the request discipline around `listDirectory`.
 *
 * Extracted from the file-tree module so a SECOND surface (the unified
 * session/file index) inherits the same semantics instead of re-deriving them:
 *
 *  · **A directory is listed once, on first open.** Each listing is one
 *    capability call and potentially one approval card, so a ref already
 *    loaded or already loading is never re-fetched. Collapsing and re-opening
 *    costs nothing; only an explicit `reset()` forgets.
 *  · **The RPC is issued from an event handler, never from a state updater.**
 *    React may call an updater more than once for one update (StrictMode does
 *    exactly that), and issuing the call inside one used to send every listing
 *    twice.
 *  · **A replaced port's late answer is dropped.** State is tagged with the
 *    port that produced it, so a render that observes a new port never paints
 *    the previous scope's refs or labels — even before effects commit.
 *
 * This is per-instance state on purpose: two mounted surfaces are two readers'
 * views of the same workspace, and their expansion is not shared state. Only
 * the ROOTS enumeration is shared (by the provider), because that one is a
 * single capability call two siblings must not each spend.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceListCursorAfter, type AnyWorkspaceFilesPort } from "@claude-bot/workspace-files-contract";
import type { DirectoryCache, DirectoryState, ExpandedDirectories } from "./tree.js";

interface DirectoryScopeState {
  port: AnyWorkspaceFilesPort | null;
  expanded: ReadonlySet<string>;
  cache: ReadonlyMap<string, DirectoryState>;
  selected: string | null;
}

interface PendingDirectory {
  token: symbol;
  generation: number;
  port: AnyWorkspaceFilesPort;
}

function emptyScope(port: AnyWorkspaceFilesPort | null): DirectoryScopeState {
  return { port, expanded: new Set(), cache: new Map(), selected: null };
}

export interface WorkspaceDirectories {
  /** What each listed ref has produced so far. Never another instance's. */
  cache: DirectoryCache;
  expanded: ExpandedDirectories;
  /** The ref most recently handed to `select`. */
  selected: string | null;
  /** Flip one directory; fetches its listing the FIRST time it opens. */
  toggle(ref: string, isExpanded: boolean): void;
  /** Fetch one listing if it is neither cached nor in flight. */
  load(ref: string): void;
  /**
   * Fetch the next page of a listing that said more entries follow, and append
   * it. One page per explicit request: each is a capability call, and a page
   * nobody asked for is a speculative read.
   */
  loadMore(ref: string): void;
  select(ref: string | null): void;
  /**
   * Re-list every directory that is currently open, KEEPING the expansion.
   *
   * This is what "refresh" means for a lazy tree (ticket #350). A directory is
   * listed once on first open, so a folder created outside the browser is
   * invisible for as long as its parent stays cached — and the only escape used
   * to be `reset()`, which also collapsed the whole tree the reader had just
   * finished opening. Re-issuing exactly the open directories' listings costs
   * one call per open directory, which is bounded by what the reader opened,
   * and refs are stable within a scope so the shape survives the round trip.
   */
  refresh(): void;
  /** Forget everything this instance knows, including in-flight requests. */
  reset(): void;
}

export function useWorkspaceDirectories(port: AnyWorkspaceFilesPort | null, refreshVersion = 0): WorkspaceDirectories {
  const [tree, setTree] = useState<DirectoryScopeState>(() => emptyScope(port));
  // Never paint state belonging to a previous port while the replacement
  // effect is waiting to commit. Refs are opaque within one provider scope;
  // even their labels are not data the next scope should inherit.
  const visible = tree.port === port ? tree : emptyScope(port);

  /**
   * Which directory reads are in flight, and for which port. A ref rather than
   * state, and deliberately NOT derived from `cache` — see the file header.
   */
  const pending = useRef(new Map<string, PendingDirectory>());
  const generation = useRef(0);
  /** The port whose answers may still be written. Null once unmounted. */
  const live = useRef<AnyWorkspaceFilesPort | null>(null);
  useEffect(() => {
    generation.current += 1;
    pending.current.clear();
    live.current = port;
    setTree(emptyScope(port));
    return () => {
      if (live.current === port) live.current = null;
    };
  }, [port]);

  const load = useCallback(
    (ref: string) => {
      if (!port) return;
      if (pending.current.has(ref)) return;
      const request: PendingDirectory = {
        token: Symbol("workspace-directory-request"),
        generation: generation.current,
        port,
      };
      pending.current.set(ref, request);
      setTree((previous) => {
        if (previous.port !== port || previous.cache.has(ref)) return previous;
        const cache = new Map(previous.cache);
        cache.set(ref, { status: "loading", value: null, message: "", code: "" });
        return { ...previous, cache };
      });
      const settle = (next: DirectoryState): void => {
        // Release the slot first, whatever happens next — see the provider's
        // `settle` for why the order matters.
        if (pending.current.get(ref)?.token !== request.token) return;
        pending.current.delete(ref);
        if (live.current !== port || generation.current !== request.generation) return;
        setTree((previous) => {
          if (previous.port !== port) return previous;
          const cache = new Map(previous.cache);
          cache.set(ref, next);
          return { ...previous, cache };
        });
      };
      void port.listDirectory(ref).then(
        (answer) => {
          settle(
            answer.ok
              ? { status: "ready", value: answer.value, message: "", code: "" }
              : { status: "refused", value: null, message: answer.message, code: answer.code },
          );
        },
        () => {
          settle({ status: "refused", value: null, message: "这个目录没有返回结果。", code: "unavailable" });
        },
      );
    },
    [port],
  );

  const loadMore = useCallback(
    (ref: string) => {
      if (!port) return;
      if (pending.current.has(ref)) return;
      const listed = visible.cache.get(ref);
      if (listed?.status !== "ready" || !listed.value?.truncated) return;
      const after = workspaceListCursorAfter(listed.value.entries);
      if (!after) return;
      const request: PendingDirectory = {
        token: Symbol("workspace-directory-page"),
        generation: generation.current,
        port,
      };
      pending.current.set(ref, request);
      setTree((previous) => {
        const cached = previous.cache.get(ref);
        if (previous.port !== port || cached?.status !== "ready") return previous;
        const cache = new Map(previous.cache);
        cache.set(ref, { ...cached, more: { status: "loading" } });
        return { ...previous, cache };
      });
      const settle = (apply: (cached: DirectoryState) => DirectoryState): void => {
        if (pending.current.get(ref)?.token !== request.token) return;
        pending.current.delete(ref);
        if (live.current !== port || generation.current !== request.generation) return;
        setTree((previous) => {
          const cached = previous.cache.get(ref);
          if (previous.port !== port || cached?.status !== "ready" || !cached.value) return previous;
          const cache = new Map(previous.cache);
          cache.set(ref, apply(cached));
          return { ...previous, cache };
        });
      };
      void port.listDirectory(ref, after).then(
        (answer) => {
          settle((cached) => {
            if (!answer.ok) {
              return { ...cached, more: { status: "refused", message: answer.message, code: answer.code } };
            }
            // Appended, never merged: the page starts strictly after the last
            // row we hold (the port checked), so concatenation is the listing.
            const { more: _more, ...rest } = cached;
            return {
              ...rest,
              value: {
                ...cached.value!,
                entries: [...cached.value!.entries, ...answer.value.entries],
                truncated: answer.value.truncated,
              },
            };
          });
        },
        () => {
          settle((cached) => ({
            ...cached,
            more: { status: "refused", message: "这个目录的下一页没有返回结果。", code: "unavailable" },
          }));
        },
      );
    },
    [port, visible.cache],
  );

  const toggle = useCallback(
    (ref: string, isExpanded: boolean) => {
      if (!port) return;
      setTree((previous) => {
        if (previous.port !== port) return previous;
        const expanded = new Set(previous.expanded);
        if (isExpanded) expanded.delete(ref);
        else expanded.add(ref);
        return { ...previous, expanded };
      });
      // Lazy: the children of a directory are fetched the first time somebody
      // opens it, never as part of walking the tree. `load` decides whether
      // this ref is already known — collapsing and re-opening costs nothing.
      if (!isExpanded && !visible.cache.has(ref)) load(ref);
    },
    [load, port, visible.cache],
  );

  const select = useCallback(
    (ref: string | null) => {
      if (!port) return;
      setTree((previous) => (previous.port === port ? { ...previous, selected: ref } : previous));
    },
    [port],
  );

  const refresh = useCallback(() => {
    if (!port) return;
    // Invalidate what is in flight first: an answer issued against the previous
    // generation describes the listing this refresh is replacing.
    generation.current += 1;
    pending.current.clear();
    // Read the open set from the rendered value rather than from inside the
    // updater — an updater may run twice for one update, and reading state
    // through a side effect there is exactly the bug this file's header warns
    // about for RPCs.
    const open = [...visible.expanded];
    setTree((previous) => (
      previous.port === port ? { ...previous, cache: new Map() } : emptyScope(port)
    ));
    for (const ref of open) load(ref);
  }, [load, port, visible.expanded]);

  const reset = useCallback(() => {
    generation.current += 1;
    pending.current.clear();
    setTree(emptyScope(port));
  }, [port]);

  const refreshed = useRef({ port, version: refreshVersion });
  useEffect(() => {
    const previous = refreshed.current;
    refreshed.current = { port, version: refreshVersion };
    // A new port starts empty. Only a refresh in this scope re-lists the
    // reader's open directories; completion frames do not trigger more reads.
    if (previous.port === port && previous.version !== refreshVersion) refresh();
  }, [port, refreshVersion, refresh]);

  return {
    cache: visible.cache,
    expanded: visible.expanded,
    selected: visible.selected,
    toggle,
    load,
    loadMore,
    select,
    refresh,
    reset,
  };
}
