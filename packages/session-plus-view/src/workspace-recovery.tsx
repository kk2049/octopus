import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { SessionsProjection } from "@claude-bot/agent-sessions-contract";
import {
  DockWorkspaceShell, useWorkspaceLayout, defaultDockPresentation,
  type DockPresentation, type MobileSection, type WorkspacePlan,
} from "@claude-bot/agent-view-react/workspace";
import { SessionsRefreshAction } from "@claude-bot/agent-sessions-view";
import { FILE_VIEWER_MODULE_ID, useWorkspaceFiles } from "@claude-bot/agent-workspace-files-view";
import { EDITOR_MODULE_ID } from "@claude-bot/agent-editor-view";
import { FEISHU_DOCUMENT_MODULE_ID } from "@claude-bot/agent-feishu-view";
import { encodeSessionPlusRecovery, readSessionPlusRecovery, restoreSessionPlusLayout, mapRecoveryPresentation,
  type SessionPlusRecovery, type ResolvedRecoveryDocument } from "./recovery.js";
import { resolveRecoveryFiles } from "./recovery-files.js";

const SESSION_DOCUMENT_CHROME = Object.freeze({
  [FILE_VIEWER_MODULE_ID]: "av-dock-surface-inset",
  [EDITOR_MODULE_ID]: "av-dock-surface-inset",
  [FEISHU_DOCUMENT_MODULE_ID]: "av-dock-surface-inset",
});
const MOBILE_SECTION_LABELS = Object.freeze({ main: "会话", resource: "文件", status: "终端" });

export function useSessionPlusRecovery(plan: WorkspacePlan, projection: SessionsProjection | null, encoded: string | null) {
  const recovery = useMemo(() => projection ? readSessionPlusRecovery(encoded, plan, projection) : null, [encoded, projection, plan]);
  return { recovery };
}

interface WorkspaceProps {
  plan: WorkspacePlan;
  narrow: boolean;
  recovery: SessionPlusRecovery | null;
  publishRecovery(checkpoint: string): boolean;
}

/** A bounded mount transaction: no default Dock or module can overwrite recovery while files resolve. */
export const SessionPlusWorkspace = memo(function SessionPlusWorkspace(props: WorkspaceProps) {
  const [checkpoint] = useState(props.recovery);
  const files = useWorkspaceFiles();
  const documents = checkpoint?.documents ?? [];
  const [resolved, setResolved] = useState<readonly ResolvedRecoveryDocument[] | null>(
    () => documents.some((row) => row.file) ? null : documents,
  );
  const partial = useRef<readonly ResolvedRecoveryDocument[]>(documents.filter((row) => !row.file));
  const currentPort = useRef<typeof files.port | null>(null);
  const pending = useRef<{ port: typeof files.port; promise: ReturnType<typeof resolveRecoveryFiles> } | null>(null);
  useEffect(() => {
    if (resolved !== null) return;
    // A replacement port owns a new resource scope, even while its roots are
    // still pending. Do not carry old partial refs into its timeout fallback.
    if (pending.current?.port !== files.port) partial.current = documents.filter((row) => !row.file);
    // The provider's one roots enumeration is shared with the navigation that
    // mounts afterwards. The deadline covers unanswered roots AND file reads.
    files.refreshRoots();
    const timer = window.setTimeout(() => setResolved(partial.current), 10_000);
    return () => window.clearTimeout(timer);
  }, [files.port, files.refreshRoots, resolved]);
  useEffect(() => {
    if (resolved !== null || !["ready", "refused"].includes(files.roots.status)) return;
    currentPort.current = files.port;
    let live = true;
    if (pending.current?.port !== files.port) {
      pending.current = { port: files.port, promise: resolveRecoveryFiles(documents, files.roots.value, files.port,
        () => currentPort.current === files.port, (row) => {
          partial.current = [...partial.current, row];
        }) };
    }
    void pending.current.promise.then((rows) => {
      if (live) setResolved(rows);
    });
    return () => { live = false; currentPort.current = null; };
  }, [files.port, files.roots.status, files.roots.value, resolved]);
  if (resolved === null) return <div role="status">正在恢复工作区…</div>;
  return <RestoredWorkspace {...props} recovery={checkpoint} documents={resolved} />;
}, (previous, next) => previous.plan === next.plan && previous.narrow === next.narrow
  && previous.publishRecovery === next.publishRecovery);

function RestoredWorkspace({ plan, narrow, recovery, documents, publishRecovery }: WorkspaceProps & {
  documents: readonly ResolvedRecoveryDocument[];
}) {
  const [initial] = useState(() => restoreSessionPlusLayout(plan, recovery, documents, narrow));
  const { state, dispatch, api } = useWorkspaceLayout(plan, { initialState: initial.state });
  const [presentation, setPresentation] = useState<DockPresentation | undefined>(initial.presentation);
  const [mobileSection, setMobileSection] = useState<MobileSection>(recovery?.mobileSection ?? "navigation");
  useEffect(() => dispatch({ type: "viewport", narrow }), [dispatch, narrow]);
  useEffect(() => {
    // Phone maximization is transient: checkpoint the retained desktop tree,
    // only updating a front tab when semantic focus names a member of its group.
    const desktop = presentation ?? (state.narrow ? defaultDockPresentation(plan, state) : null);
    if (!desktop) return;
    const snapshot = state.narrow ? mapRecoveryPresentation(desktop, (group) =>
      state.focused && group.panels.includes(state.focused)
        ? { ...group, activePanel: state.focused } : group) : desktop;
    if (!snapshot) return;
    const encoded = encodeSessionPlusRecovery({ state, presentation: snapshot, mobileSection });
    if (encoded) publishRecovery(encoded);
  }, [mobileSection, plan, presentation, publishRecovery, state]);
  return <DockWorkspaceShell
    plan={plan} state={state} api={api} className="cols"
    surfaceClassName={{ navigation: "av-dock-surface-inset", primary: "av-dock-surface-inset", bottom: "av-dock-surface-inset-compact" }}
    documentClassNameByModule={SESSION_DOCUMENT_CHROME}
    initialPresentation={initial.presentation}
    onPresentationChange={setPresentation}
    initialMobileSection={recovery?.mobileSection ?? "navigation"}
    onMobileSectionChange={setMobileSection}
    mobileSectionLabels={MOBILE_SECTION_LABELS} mobileActions={<SessionsRefreshAction />}
  />;
}
