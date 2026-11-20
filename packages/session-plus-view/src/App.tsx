/**
 * The Session Plus Agent View — a composition root and nothing else.
 *
 * ── What this program is, and is not ────────────────────────────────────────
 *
 * It runs in a frame with an opaque origin: no cookie jar, no parent DOM, no
 * fetch/XHR/WebSocket/EventSource, no forms, no popups, no top navigation, and
 * no idea who is logged in. Its only supported channel is the MessagePort the
 * trusted shell transfers in — and over that channel it can only PROPOSE. Owner,
 * app, scope, instance, approval and capability are the Host's, and are never
 * sent in either direction.
 *
 * ── What is left here after modularisation ──────────────────────────────────
 *
 * Composition, four times over: adapt this App's ONE channel onto the three
 * typed ports it uses (sessions, workspace files and CRDT; each owns its own
 * action vocabulary); register the modules and plans `plan.ts` ships as JSON;
 * paint the small App chrome; select the reusable docking presentation.
 *
 * NOT here: transcript paging, the single-flight read interlock, the workspace
 * queue, the once-only operation rule, directory walking, stream pulling, and
 * every protocol action string. Those belong to the module packages.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  AgentViewAlerts,
  useAgentView,
  useAgentViewSnapshot,
  useRefusal,
} from "@claude-bot/agent-view-react";
import type { FileAnnotation } from "@claude-bot/agent-sessions-contract";
import type { FileAnnotationsAdapter } from "@claude-bot/agent-file-preview";
import {
  createModuleRegistry,
  createWorkspacePlan,
  useNarrowViewport,
} from "@claude-bot/agent-view-react/workspace";
import { AGENT_SESSIONS_WAKE_REF, type SessionsProjection } from "@claude-bot/agent-sessions-contract";
import {
  SESSIONS_MODULES,
  SessionsProvider,
} from "@claude-bot/agent-sessions-view";
import {
  WORKSPACE_FILES_MODULES,
} from "@claude-bot/agent-workspace-files-view";
// The editor rides the SAME provider: one port, one roots enumeration, one
// grant. A second provider would be a second capability call for the same list.
import { EDITOR_MODULES } from "@claude-bot/agent-editor-view";
import { CRDT_MODULES, CrdtDocProvider } from "@claude-bot/agent-crdt-view";
import { FEISHU_MODULES } from "@claude-bot/agent-feishu-view";
import { createRemoteWorkspaceFilesPortV4 } from "@claude-bot/workspace-files-contract";
import { createRemoteCrdtDocPortV2 } from "@claude-bot/crdt-doc-contract";
import { SessionFilesProvider, sessionFileLinks } from "./file-navigation.js";
import { createSessionsAdapter } from "./adapter.js";
import { createAsyncQuestionPersistence, createSessionComposerDraftPersistence } from "./drafts.js";
import {
  DOCS_BINDING,
  SESSION_PLUS_COMPOSITION,
  SESSION_PLUS_RESOURCE_BINDINGS,
  WORKSPACE_BINDING,
} from "./plan.js";
import { SessionPlusWorkspace, useSessionPlusRecovery } from "./workspace-recovery.js";
import { useSessionPlusViewPerformance } from "./view-performance.js";

/** Below this width the workbench switches to navigation/main/resource layers. */
const NARROW_PX = 720;
/** Identity-stable empty tuple so `read()` never returns a fresh array. */
const EMPTY_ANNOTATIONS: readonly FileAnnotation[] = Object.freeze([]);
export function App() {
  const { client, propose } = useAgentView();
  const refusal = useRefusal();
  const snapshot = useAgentViewSnapshot();
  const projection = snapshot.projection as SessionsProjection | null;
  const narrow = useNarrowViewport(NARROW_PX);
  useSessionPlusViewPerformance(client, snapshot);

  // Read through a ref so a new refusal does not give the port a new identity:
  // the controller subscribes to the port, and re-subscribing on every notice
  // would restart work that is already in flight.
  const refusalRef = useRef(refusal);
  refusalRef.current = refusal;
  const port = useMemo(
    () =>
      createSessionsAdapter({
        client,
        propose,
        refusal: { get text() { return refusalRef.current.text; }, clear: () => refusalRef.current.clear() },
      }),
    [client, propose],
  );
  const composerDrafts = useMemo(() => createSessionComposerDraftPersistence(client), [client]);
  const asyncQuestionPersistence = useMemo(() => createAsyncQuestionPersistence(client), [client]);
  // Resource ports share the MessagePort. v4 keeps directory identity and media
  // preview while adding the separately consented bounded download stream.
  const files = useMemo(() => createRemoteWorkspaceFilesPortV4({ propose }, WORKSPACE_BINDING), [propose]);
  const fileLinks = useMemo(() => sessionFileLinks(files.port), [files]);
  useEffect(() => () => files.destroy(), [files]);
  const docs = useMemo(() => createRemoteCrdtDocPortV2({ propose }, DOCS_BINDING), [propose]);
  useEffect(() => () => docs.destroy(), [docs]);
  // Wake tokens (ADR 0006) flow to the document modules as DATA: the module
  // package may not import the SDK root, so the App — which owns the channel —
  // reads the snapshot and hands the counters down through the provider.
  const { wakes } = snapshot;
  // The binding plan goes in too: it tells the coordinator which instances are
  // CONNECTED, and so which surfaces stay one named panel.
  const plan = useMemo(
    () =>
      createWorkspacePlan({
        composition: SESSION_PLUS_COMPOSITION,
        registry: createModuleRegistry([
          ...SESSIONS_MODULES,
          ...WORKSPACE_FILES_MODULES,
          ...EDITOR_MODULES,
          ...CRDT_MODULES,
          ...FEISHU_MODULES,
        ]),
        bindings: SESSION_PLUS_RESOURCE_BINDINGS,
      }),
    [],
  );
  const { recovery } = useSessionPlusRecovery(plan, projection, snapshot.recovery);

  // Adapter identity is stable so context consumers do not resubscribe every
  // frame. The projection snapshot is read through a ref, so a new frame updates
  // the answers without changing the object the workspace-files-view sees.
  // Kept before any conditional return so hook order stays fixed across renders.
  const annotationsRef = useRef<Readonly<Record<string, FileAnnotation[]>> | undefined>(projection?.fileAnnotations);
  annotationsRef.current = projection?.fileAnnotations;
  const readAnnotations = useCallback((key: string) => annotationsRef.current?.[key] ?? EMPTY_ANNOTATIONS, []);
  const annotationsAdapter = useMemo<FileAnnotationsAdapter>(() => ({
    read: readAnnotations,
    save: (fileKey, next) => port.setFileAnnotations(fileKey, next).then((reply) =>
      reply.ok
        ? { ok: true as const }
        : {
            ok: false as const,
            message: reply.message ?? "批注保存被拒绝。",
            ...(reply.code ? { code: reply.code } : {}),
          },
    ),
    drafts: client.drafts,
  }), [client, port, readAnnotations]);

  if (!projection) {
    return (
      <div className="banner">
        {snapshot.phase === "closed" ? "⚠ 通道已关闭；可信外层可以重建这个视图。" : "⏳ 等待可信外层转交通道…"}
      </div>
    );
  }

  return (
    <div className="session-plus-app" data-session-plus-app>
      <SessionsProvider
        port={port}
        wakeToken={wakes[AGENT_SESSIONS_WAKE_REF] ?? 0}
        draftPersistence={composerDrafts}
        asyncQuestionPersistence={asyncQuestionPersistence}
        initialSelectedResource={projection.sharedAccess ? projection.sessions?.[0]?.resourceId : recovery?.activeSession}
      >
        <SessionFilesProvider port={files.port} annotations={annotationsAdapter} links={projection.sharedAccess ? undefined : fileLinks}>
          <CrdtDocProvider port={docs.port} wakes={wakes}>
            {/* Refusals span every adapted port. Keep them in one runtime-owned
                surface; the trusted outer shell renders operation history, and
                each device terminal owns its lease inside its Dock tab. */}
            <AgentViewAlerts />
            <SessionPlusWorkspace
              plan={plan}
              narrow={narrow}
              recovery={recovery}
              publishRecovery={client.publishRecovery}
            />
          </CrdtDocProvider>
        </SessionFilesProvider>
      </SessionsProvider>
    </div>
  );
}
