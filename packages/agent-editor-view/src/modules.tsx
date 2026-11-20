/**
 * `workspace.editor/v1`: resource/CAS state around the shared text surface.
 *
 * ── What lives here rather than in the components ───────────────────────────
 *
 * Save/CAS state, the dirty projection and reload counter live here per mounted
 * instance. The actual buffer/undo/selection live in the shared CodeMirror
 * surface. None is written to App State or a database: an unsaved buffer is not
 * durable App data. It lives and dies with the panel, so the presentation must
 * keep the renderer subtree mounted across tab moves and phone navigation.
 *
 * ── Where the text comes from ───────────────────────────────────────────────
 *
 * `useWorkspaceFiles()` for the port, `useWorkspaceText()` for the read. Both
 * are the workspace-files package's, reused rather than reimplemented: the
 * bounded pull loop, the "a late chunk never lands" rule and the "close the
 * stream on every exit" rule are already right there, and a second copy would be
 * a second place for them to be nearly right. This module adds writing.
 *
 * ── The one intent-context consumer ─────────────────────────────────────────
 *
 * `panel.context.line`. The layout kernel transports it and never reads it
 * (decision 7), and it is deliberately not part of panel reuse identity — so
 * "the same file at line 120" focuses this panel and replaces the instruction
 * rather than opening a second one. The jump is applied after the document is in
 * the buffer, and again whenever a new intent arrives.
 *
 * ── What this module cannot do ──────────────────────────────────────────────
 *
 * Name an action string, a binding, an owner, a device or a path; retry a
 * refused call; poll for an approval; or write anything without the reader
 * pressing something. The first is structural (it holds a port with named
 * methods), and the rest are the rules in `lib/save.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModuleProps, ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import {
  useWorkspaceDownload,
  useWorkspaceFiles,
  useWorkspaceText,
} from "@claude-bot/agent-workspace-files-view";
import {
  workspaceFilesCanWrite,
  workspaceTextWindows,
  type AnyWorkspaceFilesPort,
  type WorkspaceMutationReceipt,
} from "@claude-bot/workspace-files-contract";
import {
  languageForFileName,
  type CodeMirrorTextSurfaceHandle,
} from "@claude-bot/agent-text-view";
import { CodeSurface } from "./components/CodeSurface.js";
import { EditorPane } from "./components/EditorPane.js";
import { requestedLine } from "./lib/line.js";
import { IDLE_SAVE, SAVING, canSave, saveStateFrom, type SaveState } from "./lib/save.js";
import { EDITOR_MANIFEST, WORKSPACE_TEXT_RESOURCE_KIND } from "./manifests.js";

/** First instance keeps the plain DOM hooks; a later copy gets a namespace. */
function useDomIdScope({ panel, workspace }: ModuleProps): string | undefined {
  const [scope] = useState(() => {
    const first = workspace.state.panels.find((candidate) => candidate.moduleId === panel.moduleId);
    return first?.panelId === panel.panelId ? undefined : panel.panelId;
  });
  return scope;
}

function EditorModule({ panel, workspace }: ModuleProps) {
  const files = useWorkspaceFiles();
  const domIdScope = useDomIdScope({ panel, workspace });
  const { port } = files;
  const download = useWorkspaceDownload(port, panel.resourceRef);
  const [reload, setReload] = useState(0);
  const read = useWorkspaceText(port, panel.resourceRef, reload);
  const [dirty, setDirty] = useState(false);
  const surface = useRef<CodeMirrorTextSurfaceHandle | null>(null);
  const [save, setSave] = useState<SaveState>(IDLE_SAVE);
  /**
   * One `read_only` refusal is a fact about this scope, not about this attempt.
   *
   * Remembered so the panel stops offering a control that cannot work — the same
   * "nothing to submit" discipline an `other` entry's missing ref relies on.
   */
  const [scopeReadOnly, setScopeReadOnly] = useState(false);
  /**
   * The last applied write: its receipt and the exact text it committed.
   *
   * Kept apart from `save`, which is attempt state. A later attempt that is
   * saving, refused or in conflict does not un-commit the earlier write, so the
   * next attempt must still carry that write's digest; deriving this from
   * `save.status === "saved"` made a retry conflict with the panel's own write.
   * Cleared only with the document (new key or port) or an explicit re-read.
   */
  const [committed, setCommitted] = useState<{ receipt: WorkspaceMutationReceipt; text: string } | null>(null);

  /**
   * Which document the buffer belongs to.
   *
   * The digest is in the key on purpose: re-reading a file that changed
   * underneath produces a genuinely different document, and a buffer keyed only
   * on the ref would keep the old text beside the new precondition — which is
   * how somebody's edit gets applied on top of a version they never saw.
   */
  const docKey = read.document
    ? `${read.document.ref}|${read.document.digest}|${reload}`
    : "";
  const loaded = read.status === "ready" && read.document !== null;
  const inFlight = useRef<symbol | null>(null);
  const currentDocKey = useRef(docKey);
  currentDocKey.current = docKey;
  /**
   * What the file holds NOW, as far as this panel can prove.
   *
   * After an applied write that is the receipt, not the read: the receipt's
   * `afterDigest` is the precondition the next edit must carry, and its text is
   * what "unchanged" now means. Without this, a second save in the same session
   * would submit the digest the file had before the first one — a guaranteed
   * conflict against a version this panel produced itself — and the buffer would
   * still look dirty after being saved.
   */
  const applied = committed && committed.receipt.ref === read.document?.ref ? committed.receipt : null;
  const displayDocument = applied && read.document
    ? {
        ...read.document,
        digest: applied.afterDigest,
        sizeBytes: applied.sizeBytes,
        modifiedAt: applied.committedAt,
      }
    : read.document;
  const baseText = applied ? committed!.text : read.text;
  const baseDigest = applied ? applied.afterDigest : read.document?.digest ?? "";
  const currentDirty = loaded && dirty;
  const closeGuarded = currentDirty || save.status === "saving";
  const browseView = typeof panel.config?.browse_view === "string" ? panel.config.browse_view : "";

  // A new document (or a new port) discards attempt-local save state. A
  // submitted approval is deliberately different: the trusted pending call
  // can outlive this read, resource binding and even this View, and the port
  // provides no terminal-status/cancel API. Preserve that warning for the
  // mounted tab's lifetime and keep Save fail-closed so a reload cannot mint a
  // second approval card while the first may still be actionable.
  useEffect(() => {
    inFlight.current = null;
    setDirty(false);
    setSave((previous) => previous.status === "submitted" ? previous : IDLE_SAVE);
    setCommitted(null);
  }, [docKey, port]);
  useEffect(() => {
    setScopeReadOnly(false);
  }, [port]);

  // Dirty is document lifecycle state, not Dockview state. The coordinator is
  // the one place allowed to turn a close request into an actual unmount.
  const setWorkspaceDirty = workspace.setDirty;
  useEffect(() => {
    setWorkspaceDirty?.(panel.panelId, closeGuarded);
    return () => setWorkspaceDirty?.(panel.panelId, false);
  }, [closeGuarded, panel.panelId, setWorkspaceDirty]);

  // No size gate: a save past one call's window is staged by the port, and a
  // document past the whole-document budget never reaches `ready` (it stays a
  // partial read), so it can never be saved over a file it does not hold.
  const writable = workspaceFilesCanWrite(port) && !scopeReadOnly;
  const live = useRef<AnyWorkspaceFilesPort | null>(null);
  useEffect(() => {
    live.current = port;
    return () => {
      if (live.current === port) live.current = null;
    };
  }, [port]);

  const submit = useCallback((providedBody?: string): boolean => {
    const document = read.document;
    if (!document || !loaded) return false;
    const body = providedBody ?? surface.current?.getText();
    if (body === undefined) return false;
    if (!canSave({ writable, scopeReadOnly, hasDocument: true, dirty: currentDirty, status: save.status })) return false;
    const write = port.replaceText;
    if (!write) return false;
    // Exactly one in flight. A second press while the first is unanswered would
    // be a second approval card for the same edit.
    const token = Symbol("workspace-save");
    const submittedDocKey = docKey;
    inFlight.current = token;
    setSave(SAVING);
    void write
      .call(port, document.ref, { expectedDigest: baseDigest, text: body })
      .then(
        (answer) => {
          if (
            inFlight.current !== token
            || live.current !== port
            || currentDocKey.current !== submittedDocKey
          ) return;
          inFlight.current = null;
          const next = saveStateFrom(answer, { staged: workspaceTextWindows(body).length > 1 });
          // Structural, so it is remembered; every other refusal is about this
          // attempt and leaves the control alone.
          if (!answer.ok && answer.code === "read_only") setScopeReadOnly(true);
          if (answer.ok) {
            setCommitted({ receipt: answer.value, text: body });
            // The person may have edited or undone while the write was in
            // flight. Publish dirty against the just-committed body in this
            // same render as the receipt, before the surface's clean-token
            // layout effect independently calibrates its internal baseline.
            const currentBody = surface.current?.getText();
            setDirty(currentBody === undefined || currentBody !== body);
          }
          setSave(next);
        },
        () => {
          if (
            inFlight.current !== token
            || live.current !== port
            || currentDocKey.current !== submittedDocKey
          ) return;
          inFlight.current = null;
          // The port promises to resolve. A rejection is a broken implementation
          // of it, and a panel stuck on "正在提交…" would be worse than a refusal.
          setSave({ status: "refused", message: "这次保存没有返回结果。", code: "unavailable", receipt: null });
        },
      );
    return true;
  }, [baseDigest, currentDirty, docKey, loaded, port, read.document, save.status, scopeReadOnly, writable]);

  const onReload = useCallback(() => {
    // The only thing that issues a second read, and only because somebody asked.
    // It cannot prove that a trusted approval reached a terminal state, so a
    // submitted warning intentionally survives the new snapshot.
    inFlight.current = null;
    setDirty(false);
    setSave((previous) => previous.status === "submitted" ? previous : IDLE_SAVE);
    setCommitted(null);
    setReload((value) => value + 1);
  }, []);

  const browse = useCallback(() => {
    if (!browseView || !panel.resourceRef || closeGuarded) return;
    const opened = workspace.open({
      kind: WORKSPACE_TEXT_RESOURCE_KIND,
      ref: panel.resourceRef,
      label: panel.label,
    }, { view: browseView, ...(panel.context ? { context: panel.context } : {}) });
    if (opened) workspace.close(panel.panelId);
  }, [browseView, closeGuarded, panel.context, panel.label, panel.panelId, panel.resourceRef, workspace]);

  const line = useMemo(() => requestedLine(panel.context), [panel.context]);
  // Identity of the last open intent, so clicking "line 120" twice jumps twice
  // while an unrelated re-render does not.
  const lineToken = useLineToken(panel.context, line);
  const language = useMemo(
    () => languageForFileName(displayDocument?.label ?? panel.label),
    [displayDocument?.label, panel.label],
  );

  // A standing editor with no file renders nothing at all: the tree and the
  // viewer have already said everything an empty state would, and the App hides
  // the slot rather than the module drawing a placeholder into it. Every hook
  // above still runs, because a panel keeps its buffer while it is off screen.
  if (!panel.resourceRef) return null;

  return (
    <EditorPane
      document={displayDocument}
      label={panel.label}
      status={read.status}
      streaming={read.streaming}
      readMessage={read.message}
      readCode={read.code}
      save={save}
      baseDigest={baseDigest}
      dirty={currentDirty}
      writable={writable}
      readOnlyReason={
        scopeReadOnly
          ? "当前授权只覆盖读取，这个文件不能在这里保存。"
          : "这个视图的资源通道没有提供写入。"
      }
      canSave={canSave({ writable, scopeReadOnly, hasDocument: loaded, dirty: currentDirty, status: save.status })}
      onSave={() => void submit()}
      onReload={onReload}
      reloadDisabled={save.status === "saving"}
      download={download}
      onDownload={download.start}
      {...(browseView ? { onBrowse: browse, browseDisabled: closeGuarded } : {})}
      domIdScope={domIdScope}
      {...(panel.resourceRef ? { onClose: () => workspace.close(panel.panelId) } : {})}
    >
      <CodeSurface
        ref={surface}
        doc={baseText}
        docKey={docKey}
        cleanToken={baseDigest}
        readOnly={!loaded || !writable}
        line={loaded ? line : null}
        lineToken={lineToken}
        onDirtyChange={setDirty}
        onSave={submit}
        domIdScope={domIdScope}
        language={language}
      />
    </EditorPane>
  );
}

/**
 * A token that changes exactly when a new open intent arrived.
 *
 * The reducer replaces `panel.context` with the intent's own object on every
 * open and copies the reference on every other action, so object identity is
 * the signal — but identity cannot be a dependency value, so it is counted.
 */
function useLineToken(context: unknown, line: number | null): string {
  const previous = useRef<unknown>(undefined);
  const count = useRef(0);
  if (previous.current !== context) {
    previous.current = context;
    count.current += 1;
  }
  return line === null ? "" : `${count.current}:${line}`;
}

export const EDITOR_MODULE: ModuleRegistryEntry = Object.freeze({
  manifest: EDITOR_MANIFEST,
  component: EditorModule,
});

/** Every module in this package, ready to be registered. */
export const EDITOR_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([EDITOR_MODULE]);
