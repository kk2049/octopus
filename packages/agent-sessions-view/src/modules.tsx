/**
 * The seven sessions modules: a manifest and a mount for each.
 *
 * ── What a module is here ───────────────────────────────────────────────────
 *
 * A manifest (what it is, where it may go, which port it needs, which resource
 * kinds it can open) plus a thin component that reads the controller from
 * context and hands PROPS to the presentational component next door. The split
 * is what keeps the components reusable: `AgentChat` takes a session and four
 * callbacks, so a read-only harness can render it from a fixture without a
 * controller at all.
 *
 * ── What is deliberately not here ───────────────────────────────────────────
 *
 * No wire action strings, no channel primitives, no protocol constants, no
 * transport of any kind. These modules import `@claude-bot/agent-view-react/ui`
 * — presentation only — and the contract. The App is the thing that has a
 * channel; a module has a port.
 *
 * ── The one synthetic resource ──────────────────────────────────────────────
 *
 * `new-session` is a resource kind with a single ref. That is a deliberate use
 * of the one opening mechanism rather than a second one: the roster's `＋` fills
 * the draft and raises `open-resource/v1`, the coordinator applies the SAME
 * reuse rule it applies to a session (clicking `＋` twice focuses the form
 * instead of stacking two), and closing it is closing a panel. A `mode: "new"`
 * flag inside a module would have been a private layout system.
 */

import { useCallback, useRef, useEffect, useMemo, useState } from "react";
import {
  AGENT_PERMISSION_PROFILES,
  type SessionSummary,
} from "@claude-bot/agent-sessions-contract";
import type { ResourceLink } from "@claude-bot/agent-module-contract";
import {
  FEISHU_DOCUMENT_RESOURCE_KIND,
  feishuDocumentLabel,
  readFeishuDocumentLink,
} from "@claude-bot/agent-feishu-view/links";
import {
  useNarrowViewport,
  type ModuleProps,
  type ModuleRegistryEntry,
} from "@claude-bot/agent-view-react/workspace";
import { EmptyState, StatusChip } from "@claude-bot/agent-view-react/ui";
import {
  annotationRootsByRef,
  listedFileContext,
  useOptionalWorkspaceFiles,
  useWorkspaceDirectories,
  type ListedFileLocation,
  type WorkspaceFilesController,
} from "@claude-bot/agent-workspace-files-view";
import {
  WORKSPACE_MEDIA_RESOURCE_KIND,
  WORKSPACE_TEXT_RESOURCE_KIND,
  isWorkspaceMediaLabel,
  type WorkspaceFilesDirectory,
} from "@claude-bot/workspace-files-contract";
import {
  AGENT_CHAT_MANIFEST,
  NEW_SESSION_MANIFEST,
  NEW_SESSION_RESOURCE,
  REMOTE_TERMINAL_MANIFEST,
  REMOTE_TERMINAL_RESOURCE_KIND,
  SESSION_DIRECTORY_INDEX_MANIFEST,
  SESSION_OPERATIONS_MANIFEST,
  SESSION_ROSTER_MANIFEST,
  SESSION_SEARCH_MANIFEST,
} from "./manifests.js";
import { useSessions, useSessionResource, useSessionNavigation, useSessionSearch, useAsyncQuestionPersistence } from "./context.js";
import { AgentChat } from "./components/AgentChat.js";
import {
  DirectoryIndex,
  SharedSessionsIndex,
  SourcesStatus,
  type SessionDirectoryTarget,
} from "./components/DirectoryIndex.js";
import { Navigator, type NavigatorView } from "./components/Navigator.js";
import { SessionNavigator } from "./components/SessionNavigator.js";
import { NewSession } from "./components/NewSession.js";
import { DEFAULT_CODEX_MODEL, launchChoiceOf, normalizeEffort, type LaunchChoiceId } from "./lib/cli.js";
import {
  planWalk,
  relativeLinkSegments,
  resolveLinkPath,
  walkToFile,
  type ListDirectory,
  type ResolveEntry,
} from "./lib/file-link.js";
import { planFileReveal, planWorkspaceReveal } from "./lib/home-directory-tree.js";
import { RemoteTerminal } from "./components/RemoteTerminal.js";
import { SessionOperations } from "./components/SessionOperations.js";
import { SessionRoster } from "./components/SessionRoster.js";
import { SessionHistory } from "./components/SessionHistory.js";
import { SessionSearch } from "./components/SessionSearch.js";
import { titleOf } from "./lib/projection.js";
import type { SessionsController } from "./controller.js";
import type { ReadFullBlock } from "@claude-bot/chat-ui-commons/transcript-ui";

/** First instance keeps legacy DOM hooks; later mounted copies get a stable namespace. */
function useDomIdScope({ panel, workspace }: ModuleProps): string | undefined {
  // Decide once for this mounted panel. If the original first instance closes,
  // a sibling must not rename all of its DOM hooks (or its splitter storage key)
  // halfway through its lifetime.
  const [scope] = useState(() => {
    const first = workspace.state.panels.find((candidate) => candidate.moduleId === panel.moduleId);
    return first?.panelId === panel.panelId ? undefined : panel.panelId;
  });
  return scope;
}

function openSession(
  workspace: ModuleProps["workspace"],
  sessions: Pick<ReturnType<typeof useSessions>, "sessionOf" | "select">,
  resource: string,
): boolean {
  const session = sessions.sessionOf(resource);
  const opened = workspace.open({
    kind: "session",
    ref: resource,
    label: session ? titleOf(session) : "会话",
  } satisfies ResourceLink);
  // Selection follows an accepted open intent. A composition that did not
  // declare the session resource must not silently replace the standing chat.
  if (opened) sessions.select(resource);
  return opened;
}

function SessionSearchModule(props: ModuleProps) {
  const sessions = useSessionSearch();
  const domIdScope = useDomIdScope(props);
  // The query is display state of THIS instance; the hits are the provider's.
  const [query, setQuery] = useState("");
  return (
    <SessionSearch
      query={query}
      domIdScope={domIdScope}
      result={sessions.projection?.search}
      customTitles={sessions.projection?.customTitles}
      onQuery={setQuery}
      onSubmit={(cursor) => sessions.search(query, cursor)}
      onSelect={(resource) => openSession(props.workspace, sessions, resource)}
    />
  );
}

function SessionRosterModule({ panel, workspace }: ModuleProps) {
  const sessions = useSessionNavigation();
  const domIdScope = useDomIdScope({ panel, workspace });
  // Tree expansion is display state of this instance, and the caller passes what
  // the row is currently SHOWING rather than only its key: devices default to
  // open and directories to closed, and a second copy of that rule here would be
  // wrong the moment a key looked like the other kind — which it does, since a
  // directory's key starts with `dev:<device>/`.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const openForm = (device: string, directory: string): void => {
    sessions.prefillNewSession(device, directory);
    workspace.open(NEW_SESSION_RESOURCE);
  };
  if (!sessions.roster.length) {
    return (
      <EmptyState
        icon="＋"
        title="还没有可显示的会话"
        text="你可以刷新已有会话，也可以在设备账号能访问的任意目录启动新的本地 Agent。"
        action={{
          id: "new_session",
          label: "启动新会话",
          onSelect: () => {
            sessions.requestWorkspaces(true);
            openForm("", "");
          },
        }}
      />
    );
  }
  return (
    <SessionRoster
      sessions={sessions.roster}
      domIdScope={domIdScope}
      pinned={sessions.projection?.pinned ?? []}
      selected={sessions.selected}
      expanded={expanded}
      workspacesByDevice={sessions.workspaces}
      onRefresh={() => {
        sessions.refresh();
        sessions.requestWorkspaces(true);
      }}
      onSelect={(resource) => openSession(workspace, sessions, resource)}
      onToggle={(key, open) => setExpanded((previous) => ({ ...previous, [key]: !open }))}
      onNewSession={openForm}
    />
  );
}

/** Bounded echo of a link somebody clicked, for a one-line status. */
function shortPath(path: string): string {
  return path.length > 80 ? `${path.slice(0, 80)}…` : path;
}

/**
 * Translate one transcript file reference into an opened viewer.
 *
 * The whole flow is ONE user gesture's consequence: resolve the path against
 * the session's cwd, choose a workspace root through `directoryKey` equality,
 * then descend with `listDirectory` one level at a time — each level a
 * capability call through the Gate, silent under a read auto-allow and an
 * approval card without one, which is exactly the permission flow the click
 * should take. Successful listings are cached per chat instance so a second
 * link into the same directory spends nothing; refusals are never cached,
 * because the next click is a new explicit request.
 */
function useFileLinkOpener(input: {
  files: WorkspaceFilesController | null;
  session: SessionSummary | null;
  workspacesByDevice: ReturnType<typeof useSessions>["workspaces"];
  workspace: ModuleProps["workspace"];
}): { open?: (path: string) => void; notice: string } {
  const { files, session, workspacesByDevice, workspace } = input;
  const [notice, setNotice] = useState("");
  const listings = useRef(new Map<string, WorkspaceFilesDirectory>());
  const token = useRef(0);
  // A new port is a new ref vocabulary; nothing cached under the old one may
  // answer for it.
  const port = files?.port ?? null;
  useEffect(() => {
    listings.current.clear();
    token.current += 1;
    setNotice("");
  }, [port, session?.resourceId, files?.links, files?.refreshVersion]);
  if (!files || !session) return { notice };
  const open = (path: string): void => {
    const mine = ++token.current;
    const say = (text: string): void => {
      if (token.current === mine) setNotice(text);
    };
    if (files.links) {
      say(`正在定位 ${shortPath(path)} …`);
      void files.links.resolve({ href: path, sessionRef: session.resourceId }).then(result => {
        if (token.current !== mine) return;
        if (!result.ok) { say(result.message); return; }
        const opened = workspace.open({
          kind: isWorkspaceMediaLabel(result.label) ? WORKSPACE_MEDIA_RESOURCE_KIND : WORKSPACE_TEXT_RESOURCE_KIND,
          ref: result.ref, label: result.label,
        }, { context: listedFileContext(result.location) });
        say(opened ? '' : '当前工作台无法打开此文件。');
      }, () => say('文件链接读取失败，请检查连接。'));
      return;
    }
    // Two readings of one link, both bounded: where the session's cwd says it
    // is, and what it says relative to wherever it is opened. A link this side
    // cannot anchor (an elided cwd, a session with no cwd at all) still has the
    // second reading, which is why "工作区未知" is no longer a dead end.
    const target = resolveLinkPath(session.cwdDisplay ?? "", path);
    const relative = relativeLinkSegments(path);
    if (!target && !relative) {
      say(`无法把这个链接解析为工作区路径：${shortPath(path)}`);
      return;
    }
    if (files.roots.status === "loading") {
      // Somebody else's enumeration is in flight; a second one would be a
      // second approval card for a question already being asked.
      say("工作区列表正在读取中，稍后再点一次。");
      return;
    }
    const list: ListDirectory = async (ref) => {
      const cached = listings.current.get(ref);
      if (cached) return { ok: true, value: cached };
      const answer = await files.port.listDirectory(ref);
      if (answer.ok) {
        listings.current.set(ref, answer.value);
        return { ok: true, value: answer.value };
      }
      return { ok: false, code: answer.code, message: answer.message };
    };
    // One round trip per candidate when the port can resolve (ticket #243);
    // the trusted side runs the same listing walk where the network is stable.
    // Ports without the method (the harness, a v1 wire) keep the per-level walk.
    const resolve: ResolveEntry | null = files.port.resolvePath
      ? async (rootRef, labels) => {
        const answer = await files.port.resolvePath!(rootRef, labels);
        return answer.ok
          ? { ok: true, value: { ref: answer.value.ref, label: answer.value.label, kind: answer.value.kind } }
          : { ok: false, code: answer.code, message: answer.message };
      }
      : null;
    say(`正在定位 ${shortPath(path)} …（需要读取工作区目录，可能需要批准）`);
    void (async () => {
      // A chat link can also be used in a composition without the directory
      // index mounted. In that case one click pays for enumeration itself
      // rather than telling the reader to open another module first.
      let roots = files.roots.status === "ready" ? files.roots.value : null;
      if (!roots) {
        const answer = await files.port.refreshRoots();
        if (token.current !== mine) return;
        if (!answer.ok) {
          say(answer.message);
          return;
        }
        roots = answer.value;
      }
      const plan = planWalk({ target, relative, session, workspacesByDevice, roots });
      if (!plan.ok) {
        say(plan.message);
        return;
      }
      const result = await walkToFile({ list, resolve }, plan);
      if (token.current !== mine) return;
      if (!result.ok) {
        say(result.message);
        return;
      }
      const annotationRoot = annotationRootsByRef(roots.roots).get(result.candidate.rootRef) ?? "";
      const opened = workspace.open({
        kind: isWorkspaceMediaLabel(result.label)
          ? WORKSPACE_MEDIA_RESOURCE_KIND
          : WORKSPACE_TEXT_RESOURCE_KIND,
        ref: result.ref,
        label: result.label,
      } satisfies ResourceLink, {
        context: listedFileContext({
          rootRef: result.candidate.rootRef,
          labels: result.candidate.segments,
          ...(annotationRoot ? { annotationRoot } : {}),
        }),
      });
      if (!opened) {
        say("这个组合没有声明可打开该文件的视图。");
        return;
      }
      // A key-exact join needs no explanation; a fallback must name the INDEX
      // ROOT that answered without calling that root the session's workspace.
      // The session cwd and the candidate root may be several directories apart.
      say(
        result.candidate.via === "key" || result.candidate.via === "owner"
          ? ""
          : `已从目录根「${result.candidate.rootLabel || "?"}」定位并打开 ${result.label}`,
      );
    })();
  };
  return { open, notice };
}

/**
 * The unified index behind `session.directory-index/v1`.
 *
 * The mounted component stays the same when the optional files provider comes
 * and goes. Its render body chooses the joined file props or the honest
 * sessions-only degradation; interaction state therefore remains below one
 * stable hook owner instead of a conditional component-type boundary.
 */
function SessionDirectoryIndexModule(props: ModuleProps) {
  const files = useOptionalWorkspaceFiles();
  return <DirectoryIndexModule {...props} files={files} />;
}

function useDirectoryIndexShared({ panel, workspace }: ModuleProps) {
  const sessions = useSessionNavigation();
  const domIdScope = useDomIdScope({ panel, workspace });
  // The kernel's own media query, not a second breakpoint: the shell switches
  // to the layered phone presentation on exactly this question, and the rail's
  // chrome should stand down on exactly the same one. It reports a fact; what
  // the rail does with it is display state and nothing else.
  const narrow = useNarrowViewport();
  // Tree expansion is display state of THIS instance; the caller passes what
  // the row is currently showing and this just flips it.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Dot-prefixed entries, hidden until the reader asks for them (ticket #350).
  // The same kind of display state as expansion, and on both viewport layers:
  // it is the reader's decision, not a chrome budget.
  const [hideDotEntries, setHideDotEntries] = useState(true);
  // The navigator's active view, its filter and the full-text query: display
  // state of this instance, like expansion.
  const [view, setView] = useState<NavigatorView>("sessions");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [searchToken, setSearchToken] = useState(0);
  const requestSearch = useCallback(() => setSearchToken((token) => token + 1), []);
  const revealNavigation = useCallback((keys: readonly string[], showHidden: boolean): void => {
    setExpanded((previous) => {
      // Reveal inside this mounted index without replacing the reader's own
      // recent/index split. The desktop default is already collapsed; an
      // explicit open (and its SplitHandle size) is sticky interaction state.
      const next: Record<string, boolean> = { ...previous };
      for (const key of keys) next[key] = true;
      return next;
    });
    if (showHidden) setHideDotEntries(false);
  }, []);
  const openForm = (device: string, directory: string): void => {
    sessions.prefillNewSession(device, directory);
    workspace.open(NEW_SESSION_RESOURCE);
  };
  const openTerminal = (device: string): void => {
    if (!device) return;
    workspace.open({
      kind: REMOTE_TERMINAL_RESOURCE_KIND,
      ref: device,
      label: `终端 · ${device}`,
    } satisfies ResourceLink);
  };
  return {
    sessions,
    domIdScope,
    narrow,
    expanded,
    hideDotEntries,
    view,
    setView,
    filter,
    setFilter,
    query,
    setQuery,
    searchToken,
    requestSearch,
    onToggleHidden: (hidden: boolean) => setHideDotEntries(!hidden),
    onToggle: (key: string, open: boolean) => setExpanded((previous) => ({ ...previous, [key]: !open })),
    openForm,
    openTerminal,
    revealNavigation,
  };
}

interface WorkspaceRevealWalk {
  requestId: number;
  targetRef?: string;
  atRef: string;
  steps: readonly {
    label: string;
    registeredRootRef?: string;
  }[];
  index: number;
  display: string;
}

function DirectoryIndexModule(props: ModuleProps & { files: WorkspaceFilesController | null }) {
  const { files, panel, workspace } = props;
  const shared = useDirectoryIndexShared(props);
  const { sessions } = shared;
  const search = useSessionSearch();
  const filesPort = files?.port ?? null;
  const rootsStatus = files?.roots.status ?? "idle";
  const rootsValue = files?.roots.value ?? null;
  const rootsMessage = files?.roots.message ?? "";
  const refreshRoots = files?.refreshRoots;
  const directories = useWorkspaceDirectories(filesPort, files?.refreshVersion);
  // The compact list is keyed by the directory's opaque ref plus equality fact, not
  // by a row index. A transient projection frame therefore cannot move it to
  // a different directory or close it underneath the reader.
  const [sessionDirectory, setSessionDirectory] = useState<SessionDirectoryTarget | null>(null);
  const [revealWalk, setRevealWalk] = useState<WorkspaceRevealWalk | null>(null);
  // Enumeration belongs to the index (the surface that shows roots), not to
  // the shared provider: mounting only a viewer must not spend this call.
  useEffect(() => {
    if (rootsStatus === "idle") refreshRoots?.();
  }, [refreshRoots, rootsStatus]);
  useEffect(() => {
    if (!filesPort) {
      if (revealWalk) setRevealWalk(null);
      return;
    }
    const reveal = sessions.workspaceReveal;
    if (!reveal || reveal.phase === "refused") {
      if (revealWalk) setRevealWalk(null);
      return;
    }
    if (reveal.phase === "succeeded") return;
    if (revealWalk?.requestId === reveal.requestId) return;
    const session = sessions.sessionOf(reveal.resource);
    if (!session && !reveal.file) {
      sessions.settleWorkspaceReveal(reveal.requestId, {
        ok: false,
        message: "当前会话已不在可定位列表中。",
      });
      return;
    }
    if (rootsStatus === "idle" || rootsStatus === "loading") {
      if (rootsStatus === "idle") refreshRoots?.();
      return;
    }
    if (rootsStatus === "refused") {
      sessions.settleWorkspaceReveal(reveal.requestId, {
        ok: false,
        message: rootsMessage || "无法读取文件索引根。",
      });
      return;
    }
    if (reveal.file && reveal.file.scope !== files?.navigation?.scope) {
      sessions.settleWorkspaceReveal(reveal.requestId, { ok: false, message: "文件来源已切换，请重新打开文件。" });
      return;
    }
    const planned = reveal.file ? planFileReveal({
      location: reveal.file.location,
      workspacesByDevice: sessions.workspaces,
      roots: rootsValue,
    }) : planWorkspaceReveal({
      session: session!,
      workspacesByDevice: sessions.workspaces,
      roots: rootsValue,
    });
    if (!planned.ok) {
      sessions.settleWorkspaceReveal(reveal.requestId, planned);
      return;
    }
    shared.revealNavigation(planned.plan.expandedKeys, planned.plan.showHidden);
    setSessionDirectory(null);
    setRevealWalk({
      requestId: reveal.requestId,
      atRef: planned.plan.rootRef,
      steps: planned.plan.steps,
      index: 0,
      display: planned.plan.display,
    });
  }, [
    filesPort,
    files?.navigation?.scope,
    refreshRoots,
    revealWalk,
    rootsMessage,
    rootsStatus,
    rootsValue,
    sessions,
    sessions.workspaceReveal,
    shared.revealNavigation,
  ]);
  useEffect(() => {
    if (!filesPort || !revealWalk || revealWalk.targetRef) return;
    const reveal = sessions.workspaceReveal;
    if (!reveal || reveal.phase !== "pending" || reveal.requestId !== revealWalk.requestId) return;
    if (reveal.file && reveal.file.scope !== files?.navigation?.scope) {
      sessions.settleWorkspaceReveal(reveal.requestId, { ok: false, message: "文件来源已切换，请重新打开文件。" });
      return;
    }
    if (!directories.expanded.has(revealWalk.atRef)) {
      directories.toggle(revealWalk.atRef, false);
      return;
    }
    const listing = directories.cache.get(revealWalk.atRef);
    if (!listing) {
      directories.load(revealWalk.atRef);
      return;
    }
    if (listing.status === "loading") return;
    if (listing.status === "refused" || !listing.value) {
      sessions.settleWorkspaceReveal(revealWalk.requestId, {
        ok: false,
        message: listing.message || "工作目录的文件索引读取被拒绝。",
      });
      return;
    }
    // A name past the loaded pages is still a name in this directory: walk on
    // to the next page (one per step of this one requested reveal) before
    // concluding it is absent.
    const pageOn = (found: boolean): boolean => {
      if (found || !listing.value?.truncated) return false;
      if (listing.more?.status === "refused") {
        sessions.settleWorkspaceReveal(revealWalk.requestId, {
          ok: false,
          message: listing.more.message || "工作目录的下一页文件索引读取被拒绝。",
        });
        return true;
      }
      if (listing.more?.status !== "loading") directories.loadMore(revealWalk.atRef);
      return true;
    };
    if (revealWalk.index >= revealWalk.steps.length) {
      const target = reveal.file
        ? listing.value.entries.find((entry) => entry.kind === "file" && entry.ref === reveal.resource
          && entry.label === reveal.file!.location.labels.at(-1))?.ref
        : revealWalk.atRef;
      if (pageOn(Boolean(target))) return;
      if (!target) {
        sessions.settleWorkspaceReveal(revealWalk.requestId, { ok: false, message: "此文件已不在原目录索引中，请刷新目录后重新打开。" });
        return;
      }
      directories.select(target);
      setRevealWalk((previous) => previous?.requestId === revealWalk.requestId ? { ...previous, targetRef: target } : previous);
      sessions.settleWorkspaceReveal(revealWalk.requestId, {
        ok: true,
        message: `已在文件索引中定位 ${revealWalk.display}`,
      });
      return;
    }
    const step = revealWalk.steps[revealWalk.index]!;
    const entry = listing.value.entries.find((candidate) => candidate.label === step.label);
    if (pageOn(Boolean(entry))) return;
    if (!entry?.ref || entry.kind !== "directory") {
      sessions.settleWorkspaceReveal(revealWalk.requestId, {
        ok: false,
        message: `真实工作目录在当前文件索引中不可见：${step.label}`,
      });
      return;
    }
    const roots = (rootsValue?.roots ?? []) as readonly {
      ref: string;
      directoryKey?: string;
    }[];
    const entryDirectoryKey = (entry as typeof entry & { directoryKey?: string }).directoryKey;
    const registered = entryDirectoryKey
      ? roots.find((root) => root.directoryKey === entryDirectoryKey)
      : undefined;
    setRevealWalk((previous) => previous?.requestId === revealWalk.requestId
      ? {
          ...previous,
          // A parent listing from an older/narrower provider may omit the
          // child's directoryKey. The plan already paired every registered
          // root with its workspace row by exact key, so use that known root
          // at the display coordinate the tree folds into one visible row.
          atRef: step.registeredRootRef ?? registered?.ref ?? entry.ref!,
          index: previous.index + 1,
        }
      : previous);
  }, [
    directories.cache,
    directories.expanded,
    directories.load,
    directories.loadMore,
    directories.select,
    directories.toggle,
    filesPort,
    files?.navigation?.scope,
    revealWalk,
    rootsValue,
    sessions,
    sessions.workspaceReveal,
  ]);
  const focusedReveal = useRef(0);
  useEffect(() => {
    const reveal = sessions.workspaceReveal;
    if (reveal?.phase !== "succeeded" || revealWalk?.requestId !== reveal.requestId
      || focusedReveal.current === reveal.requestId) return;
    focusedReveal.current = reveal.requestId;
    workspace.focus(panel.panelId);
  }, [panel.panelId, revealWalk, sessions.workspaceReveal, workspace]);
  // Bound an unanswered listing without replaying a capability-bearing read.
  // The budget is per step of progress — a new level or a new page of the
  // same directory — never a total, so a very long directory still resolves.
  const revealPageProgress = revealWalk ? directories.cache.get(revealWalk.atRef)?.value?.entries.length ?? 0 : 0;
  useEffect(() => {
    const reveal = sessions.workspaceReveal;
    if (reveal?.phase !== "pending") return;
    const timer = window.setTimeout(() => sessions.settleWorkspaceReveal(reveal.requestId, {
      ok: false, message: "文件索引定位未返回结果，请稍后手动重试。",
    }), 20_000);
    return () => window.clearTimeout(timer);
  }, [revealWalk?.index, revealPageProgress, sessions.workspaceReveal?.requestId, sessions.workspaceReveal?.phase, sessions.settleWorkspaceReveal]);
  const editView = typeof panel.config?.edit_view === "string" ? panel.config.edit_view : "";
  const openFile = (link: ResourceLink, location?: ListedFileLocation): void => {
    if (workspace.open(link, { context: listedFileContext(location ?? null) })) directories.select(link.ref);
  };
  const editFile = (link: ResourceLink, location?: ListedFileLocation): void => {
    if (workspace.open(link, { view: editView, context: listedFileContext(location ?? null) })) directories.select(link.ref);
  };
  // A cwd reveal from a chat header targets the file tree: show that view.
  const revealRequest = sessions.workspaceReveal?.requestId;
  useEffect(() => {
    if (revealRequest && files) shared.setView("files");
  }, [revealRequest, files !== null]);
  const sharedOnly = Boolean(sessions.projection?.sharedAccess);
  const sharedList = (
    <SharedSessionsIndex props={{
      sharedOnly,
      sessions: sessions.roster,
      sharedSessions: sessions.projection?.sharedSessions ?? [],
      onOpenShared: sessions.openShare,
      onSelect: (resource) => openSession(workspace, sessions, resource),
    }} />
  );
  const historyControl = sessions.browseSessions ? <SessionHistory
    devices={sessions.devices}
    deviceLabels={Object.fromEntries((sessions.projection?.sources ?? []).map((row) =>
      [row.device ?? "", row.deviceLabel || row.device || ""]))}
    result={sessions.projection?.sessionHistory}
    customTitles={sessions.projection?.customTitles}
    selected={sessions.selected}
    pinned={sessions.projection?.pinned ?? []}
    onBrowse={sessions.browseSessions}
    onSelect={(resource) => openSession(workspace, sessions, resource)}
  /> : undefined;
  const refreshAll = (): void => {
    sessions.refresh();
    sessions.requestWorkspaces(true);
    // Re-list what is open rather than forgetting it: a refresh that
    // collapsed the tree made "show me the folder I just created" cost the
    // whole navigation the reader had opened to get there (ticket #350).
    if (files) files.refreshRoots();
  };
  const sessionsView = (
    <SessionNavigator
      domIdScope={shared.domIdScope}
      roster={sessions.roster}
      pinned={sessions.projection?.pinned ?? []}
      folders={sessions.projection?.sessionFolders ?? []}
      customTitles={sessions.projection?.customTitles}
      selected={sessions.selected}
      expanded={shared.expanded}
      narrow={shared.narrow}
      organize={sessions.organize}
      refreshing={sessions.rosterRefreshing || sessions.projection?.rosterIndexPending}
      status={<SourcesStatus sources={sessions.projection?.sources} />}
      historyControl={historyControl}
      shared={sharedList}
      sharedOnly={sharedOnly}
      sessionOf={sessions.sessionOf}
      filter={shared.filter}
      onFilter={shared.setFilter}
      onSearchAll={(query) => {
        shared.setQuery(query);
        shared.requestSearch();
        shared.setView("search");
      }}
      onSelect={(resource) => openSession(workspace, sessions, resource)}
      onToggle={shared.onToggle}
      onRefresh={refreshAll}
      onNewSession={() => {
        sessions.requestWorkspaces(true);
        shared.openForm("", "");
      }}
      onSetPinned={sessions.setPinned}
      onRename={sessions.setTitle}
      onSaveFolder={sessions.saveFolder}
      onDeleteFolder={sessions.deleteFolder}
      onFile={sessions.fileSessions}
    />
  );
  const filesView = (
    <DirectoryIndex
      sessions={sessions.roster}
      domIdScope={shared.domIdScope}
      pinned={sessions.projection?.pinned ?? []}
      selected={sessions.selected}
      expanded={shared.expanded}
      workspacesByDevice={sessions.workspaces}
      access={sessions.projection?.workspaceAccess ?? []}
      devices={sessions.devices}
      roots={rootsValue}
      rootsStatus={rootsStatus}
      rootsMessage={rootsMessage}
      indexPending={sessions.projection?.rosterIndexPending}
      sources={sessions.projection?.sources}
      sharedOnly={sharedOnly}
      refreshing={sessions.rosterRefreshing}
      cache={files ? directories.cache : NO_CACHE}
      expandedDirs={files ? directories.expanded : NO_EXPANDED}
      selectedFile={files ? directories.selected : null}
      revealDirectory={files && sessions.workspaceReveal?.phase === "succeeded"
        && revealWalk?.requestId === sessions.workspaceReveal.requestId
        ? { requestId: revealWalk.requestId, ref: revealWalk.targetRef ?? revealWalk.atRef }
        : null}
      showFiles={files !== null}
      narrow={shared.narrow}
      hideDotEntries={shared.hideDotEntries}
      onToggleHidden={shared.onToggleHidden}
      sessionDirectory={files ? sessionDirectory : null}
      onOpenSessions={files ? setSessionDirectory : () => {}}
      onCloseSessions={files ? () => setSessionDirectory(null) : () => {}}
      onRefresh={refreshAll}
      onSelect={(resource) => openSession(workspace, sessions, resource)}
      onToggle={shared.onToggle}
      onToggleDir={files ? directories.toggle : () => {}}
      onLoadRoot={files ? directories.load : () => {}}
      {...(files ? { onLoadMoreDir: directories.loadMore } : {})}
      {...(files?.loadMoreRoots ? {
        onLoadMoreRoots: files.loadMoreRoots,
        rootsMore: {
          loading: files.roots.more?.status === "loading",
          refusal: files.roots.more?.status === "refused" ? files.roots.more.message : "",
        },
      } : {})}
      onOpenFile={files ? openFile : () => {}}
      {...(files && editView ? { onEditFile: editFile } : {})}
      onNewSession={shared.openForm}
      onOpenTerminal={shared.openTerminal}
    />
  );
  const searchView = (
    <SessionSearch
      query={shared.query}
      domIdScope={shared.domIdScope}
      result={search.projection?.search}
      customTitles={search.projection?.customTitles}
      submitToken={shared.searchToken}
      onQuery={shared.setQuery}
      onSubmit={(cursor) => search.search(shared.query, cursor)}
      onSelect={(resource) => openSession(workspace, sessions, resource)}
    />
  );
  return (
    <Navigator
      view={sharedOnly ? "sessions" : shared.view}
      onView={shared.setView}
      narrow={shared.narrow}
      domIdScope={shared.domIdScope}
      views={{ sessions: sessionsView, files: filesView, search: searchView }}
    />
  );
}

/**
 * A transcript entry's anchor is `messageOffset.blockIndex`; the complete
 * block is read through the session's own read action, one window per call.
 */
function readFullBlock(
  readBlock: NonNullable<SessionsController["readBlock"]>,
  resource: string,
): ReadFullBlock {
  return async (anchor, field, charOffset) => {
    const [offset, block] = anchor.split(".").map(Number);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(block)) throw new Error("无法定位这个内容块");
    const reply = await readBlock({ resource, offset: offset!, block: block!, field, charOffset });
    if (!reply.ok) throw new Error(reply.message || "读取完整内容被拒绝");
    const result = (reply.result && typeof reply.result === "object" ? reply.result : {}) as Record<string, unknown>;
    if (typeof result.text !== "string" || typeof result.totalChars !== "number") throw new Error("设备返回了无法识别的内容");
    return {
      text: result.text,
      totalChars: result.totalChars,
      ...(typeof result.nextCharOffset === "number" ? { nextCharOffset: result.nextCharOffset } : {}),
    };
  };
}

const NO_CACHE: ReadonlyMap<string, never> = new Map<string, never>();
const NO_EXPANDED: ReadonlySet<string> = new Set<string>();


function AgentChatModule({ panel, workspace }: ModuleProps) {
  const asyncQuestionPersistence = useAsyncQuestionPersistence();
  const chat = useSessionResource(panel.resourceRef);
  const sessions = chat.actions;
  const files = useOptionalWorkspaceFiles();
  const domIdScope = useDomIdScope({ panel, workspace });
  // Bind the standing panel to the boot selection through the same declared
  // resource intent used by later clicks. Once it owns that stable resource,
  // every different session can become a sibling Dock tab instead of rebinding
  // the first panel. A composition without this open rule degrades to the old
  // selection-following behaviour after one refused attempt.
  //
  // A phone is the exception, and it is not a cosmetic one. There the shell
  // treats an accepted open intent as a JUMP (ticket #189), which is right for
  // a tap and wrong for a bind nobody asked for: entering the App landed the
  // reader inside whichever session sorted first — in practice the topmost
  // favourite — instead of the navigation layer they came for. So the boot bind
  // waits for a real tap on a narrow viewport. Nothing is lost by waiting: an
  // unbound chat still follows the selection, so the session layer already has
  // that same conversation in it when the person switches to it by hand.
  const autoOpenAttempted = useRef("");
  useEffect(() => {
    const resource = chat.resource;
    if (workspace.state.narrow) return;
    if (panel.resourceRef !== null || !resource || autoOpenAttempted.current === resource) return;
    autoOpenAttempted.current = resource;
    const session = chat.session;
    workspace.open({
      kind: "session",
      ref: resource,
      label: session ? titleOf(session) : "会话",
    } satisfies ResourceLink, { slot: panel.slot });
  }, [panel.resourceRef, panel.slot, sessions, chat.resource, workspace]);
  // A panel opened FOR a session shows that one; the unbound fallback follows
  // the current selection only when the composition refused the bind above.
  const resource = chat.resource;
  const { draftOf, setDraft, subscribeDraft } = sessions;
  const draftSource = useMemo(() => ({
    subscribe: (listener: () => void) => subscribeDraft(resource, listener),
    getSnapshot: () => draftOf(resource),
    set: (text: string) => setDraft(resource, text),
  }), [draftOf, resource, setDraft, subscribeDraft]);
  // And a panel opened for a session is the only thing that knows that session
  // needs reading: the controller's own path follows the SELECTION, which a
  // second chat beside the first one is not. Once per resource — the controller
  // remembers, so a refused read does not become a loop over every projection.
  const { retainTranscript } = sessions;
  useEffect(() => retainTranscript(resource), [retainTranscript, resource]);
  const session = chat.session;
  const fileLink = useFileLinkOpener({
    files,
    session,
    workspacesByDevice: chat.workspaces,
    workspace,
  });
  const navigationPanel = workspace.state.panels.find(
    (candidate) => candidate.moduleId === SESSION_DIRECTORY_INDEX_MANIFEST.id,
  );
  const workspaceReveal = chat.workspaceReveal;
  const openFeishuLink = (url: string, authoredLabel: string): boolean => {
    const link = readFeishuDocumentLink(url);
    if (!link) return false;
    return workspace.open({
      kind: FEISHU_DOCUMENT_RESOURCE_KIND,
      ref: link.url,
      label: feishuDocumentLabel(link, authoredLabel),
    } satisfies ResourceLink);
  };
  if (!session) {
    // Only reachable when the resource was NEVER known (no retained row): the
    // controller keeps the last known row for a selection that drops out of
    // one frame, so a transient absence renders the chat with a hint instead
    // of unmounting it (and its scroll/expansion DOM) here.
    return chat.rosterRefreshing ? (
      <div className="small"><StatusChip busy word="正在同步最新会话" tone="info" /></div>
    ) : <div className="small">选择左侧任意会话查看内容。</div>;
  }
  const absent = chat.absent;
  return (
    <AgentChat
      session={session}
      absent={absent}
      domIdScope={domIdScope}
      transcript={chat.transcript}
      transcriptStatus={chat.transcriptStatus}
      transcriptBusy={chat.busy}
      resolvedInteraction={chat.resolvedInteraction}
      draftSource={draftSource}
      asyncQuestionPersistence={asyncQuestionPersistence}
      permissionProfile={chat.permissionProfile}
      onPermissionProfileChange={(profile) => sessions.setPermissionProfile(resource, profile)}
      model={chat.model}
      models={chat.models}
      onModelChange={(model) => sessions.setModel(resource, model)}
      effort={chat.effort}
      onEffortChange={(effort) => sessions.setEffort(resource, effort)}
      pendingSends={chat.pendingSends}
      onDismissSend={sessions.dismissSend}
      expandOverrides={chat.groupOverrides}
      onToggleGroup={(key, open) => sessions.setGroupOverride(resource, key, open)}
      onSend={(prompt) => sessions.send(resource, prompt)}
      onTakeover={(prompt) => sessions.takeover(resource, prompt)}
      onFallback={(prompt) => sessions.fallback(resource, prompt)}
      onInterrupt={() => sessions.interrupt(resource)}
      interruptReceipt={chat.interrupt}
      {...(session.parentResourceId ? {
        onOpenParent: () => openSession(workspace, sessions, session.parentResourceId!),
      } : {})}
      controlRelease={chat.controlRelease}
      onReleaseControl={() => sessions.releaseControl(resource)}
      onDismissControlRelease={() => sessions.dismissControlRelease(resource)}
      onReadContinuation={() => sessions.readContinuation(session.resourceId)}
      onSaveContinuation={(prompt, revision) => sessions.saveContinuation(session.resourceId, prompt, revision)}
      customTitle={chat.customTitle}
      onSetTitle={async (title) => {
        const reply = await sessions.setTitle(session.resourceId, title);
        if (!reply.ok) return reply;
        const result = reply.result && typeof reply.result === "object"
          ? reply.result as Record<string, unknown>
          : {};
        const normalized = typeof result.title === "string"
          ? result.title
          : Array.from(title.replace(/\s+/gu, " ").trim()).slice(0, 48).join("");
        const providerSession = chat.providerSession;
        workspace.open({
          kind: "session",
          ref: session.resourceId,
          label: normalized || titleOf(providerSession ?? session),
        } satisfies ResourceLink, { slot: panel.slot });
        return reply;
      }}
      onPin={() => sessions.pin(resource)}
      pinned={chat.pinned}
      onAttachFile={(file, onProgress) => sessions.attachFile(session.resourceId, file, onProgress)}
      onRefresh={() => {
        sessions.refresh();
        sessions.read(resource, 200);
      }}
      onLoadOlder={() => sessions.loadOlder(resource)}
      onRespondInteraction={(interactionId, response) =>
        sessions.respondInteraction(resource, interactionId, response)}
      {...(fileLink.open ? { onOpenFileLink: fileLink.open } : {})}
      {...(sessions.readBlock ? { onReadFullBlock: readFullBlock(sessions.readBlock, session.resourceId) } : {})}
      onOpenFeishuLink={openFeishuLink}
      {...(fileLink.notice ? { fileLinkNotice: fileLink.notice } : {})}
      {...(files && navigationPanel ? {
        onRevealWorkspace: () => sessions.revealWorkspace(session.resourceId),
        workspaceReveal,
      } : {})}
    />
  );
}

function NewSessionModule({ panel, workspace }: ModuleProps) {
  const sessions = useSessions();
  const domIdScope = useDomIdScope({ panel, workspace });
  const draft = sessions.newSession;
  const openedLaunch = useRef("");
  useEffect(() => {
    const launch = sessions.launch;
    if (
      launch?.phase !== "succeeded"
      || !launch.newResourceId
      // Input acceptance may precede the native transcript/roster. Open only
      // once the authoritative roster has made this resource readable.
      || !sessions.sessionOf(launch.newResourceId)
      || openedLaunch.current === launch.key
    ) return;
    openedLaunch.current = launch.key;
    // The launcher is an empty chat (ticket #767): once the new session's own
    // chat accepted the open intent, this panel has nothing left to say, so
    // it hands over instead of lingering as a second tab with an old receipt.
    // A composition that refuses the session intent keeps the receipt here.
    if (openSession(workspace, sessions, launch.newResourceId)) {
      sessions.dismissLaunch();
      workspace.close(panel.panelId);
    }
  }, [panel.panelId, sessions, sessions.launch, workspace]);
  return (
    <NewSession
      devices={sessions.devices}
      placementDevices={sessions.placementDevices}
      workspaces={sessions.workspaces}
      domIdScope={domIdScope}
      advanced={draft.advanced}
      runtimeDevice={draft.runtimeDevice}
      codexAccount={draft.codexAccounts?.[draft.advanced ? draft.runtimeDevice || draft.device : draft.device]}
      onCodexAccount={(account) => sessions.setNewSession({ codexAccounts: { ...draft.codexAccounts,
        [draft.advanced ? draft.runtimeDevice || draft.device : draft.device]: account } })}
      workspaceId={draft.workspaceId}
      device={draft.device}
      directory={draft.directory}
      source={draft.source}
      translatePrompt={draft.translatePrompt}
      model={draft.model}
      effort={normalizeEffort(draft.source, draft.effort)}
      permissionProfile={draft.permissionProfile}
      prompt={draft.prompt}
      launch={sessions.launch}
      onDismissLaunch={() => sessions.dismissLaunch()}
      onAdvanced={(advanced) => sessions.setNewSession({
        advanced,
        runtimeDevice: draft.runtimeDevice || draft.device,
      })}
      onRuntimeDevice={(runtimeDevice) => sessions.setNewSession({ runtimeDevice })}
      onWorkspace={(workspaceId) => sessions.setNewSession({ workspaceId })}
      onDevice={(device) => sessions.setNewSession({
        device,
        ...(draft.advanced ? { workspaceId: "" } : {}),
      })}
      onDirectory={(directory) => sessions.setNewSession({ directory })}
      onSource={(id: LaunchChoiceId) => {
        const choice = launchChoiceOf(id);
        sessions.setNewSession({
          source: choice.source,
          translatePrompt: choice.translatePrompt,
          model: choice.source === "codex" ? DEFAULT_CODEX_MODEL : "",
          ...(choice.source === "omp"
            ? { permissionProfile: AGENT_PERMISSION_PROFILES.fullAccess }
            : {}),
        });
      }}
      onModel={(model) => sessions.setNewSession({ model })}
      onEffort={(effort) => sessions.setNewSession({ effort })}
      onPermissionProfile={(permissionProfile) => sessions.setNewSession({ permissionProfile })}
      onPrompt={(prompt) => sessions.setNewSession({ prompt })}
      onCancel={() => workspace.close(panel.panelId)}
      onAttachFile={(file, onProgress) => sessions.attachFile({ device: draft.device,
        ...(draft.advanced ? { workspaceId: draft.workspaceId } : {}) }, file, onProgress)}
      onStart={(prompt) => void sessions.startNewSession(prompt)}
    />
  );
}

function SessionOperationsModule() {
  const sessions = useSessions();
  return <SessionOperations operations={sessions.operations} limit={4} />;
}

function RemoteTerminalModule({ panel }: ModuleProps) {
  const sessions = useSessions();
  const device = panel.resourceRef ?? "";
  const size = { cols: 120, rows: 32 };
  const requestWorkspaces = sessions.requestWorkspaces;
  useEffect(() => {
    if (device) requestWorkspaces(true, device);
  }, [device, requestWorkspaces]);
  if (!device) return <div className="small">没有可用的终端设备。</div>;
  return (
    <RemoteTerminal
      device={device}
      workspaces={sessions.workspaces[device]}
      refusal={sessions.refusal}
      onRefreshWorkspaces={() => sessions.requestWorkspaces(true, device)}
      onOpen={(targetDevice, workspace) => sessions.openTerminal(targetDevice, workspace, size)}
      onRead={(targetDevice, terminal) => sessions.readTerminal(targetDevice, terminal, size)}
      onSend={(targetDevice, terminal, input) => sessions.sendTerminal(targetDevice, terminal, input, size)}
      onClose={sessions.closeTerminal}
    />
  );
}

/**
 * Every sessions module, ready to be registered.
 *
 * An App picks from this list rather than assembling entries itself: a manifest
 * and its component belong together, and a composition that could pair a
 * manifest with a different implementation would make the lock a claim rather
 * than a fact.
 */
export const SESSIONS_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([
  { manifest: SESSION_SEARCH_MANIFEST, component: SessionSearchModule },
  { manifest: SESSION_ROSTER_MANIFEST, component: SessionRosterModule },
  { manifest: SESSION_DIRECTORY_INDEX_MANIFEST, component: SessionDirectoryIndexModule },
  { manifest: AGENT_CHAT_MANIFEST, component: AgentChatModule },
  { manifest: NEW_SESSION_MANIFEST, component: NewSessionModule },
  { manifest: SESSION_OPERATIONS_MANIFEST, component: SessionOperationsModule },
  { manifest: REMOTE_TERMINAL_MANIFEST, component: RemoteTerminalModule },
]);
