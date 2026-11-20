import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  useProjection,
  usePropose,
  useAgentViewStatus,
} from "@claude-bot/agent-view-react";
import {
  boundedCanvasSize,
  researchRole,
  isHierarchyRelation,
  type GraphPosition,
  type CanvasSide,
  type GraphEdgePorts,
  type ResearchEdge,
  readResearchLocation,
  researchLocationUrl,
  parseResearchReference,
  canvasCardSize,
  canvasTree,
  canvasEdgeCurve,
  canEdit,
  canRun,
  type NodeType,
  type ResearchNode,
  type ResearchSubscription,
} from "@claude-bot/research-canvas-contract";
import {
  emptyGraph,
  encodeParams,
  persist,
  readGraph,
  refreshGraph,
  requestId,
  stored,
  type Call,
  type CanvasBoot,
} from "./client.js";
import { InlineEditor, cardKind, cardKinds, contentTypes } from "./InlineEditor.js";
import { CardIcon } from "./CardIcon.js";
import { WorkflowPanel, type WorkflowIntent } from "./WorkflowPanel.js";
import { useWorkflowPage } from "./workflow-client.js";
import { ResearchSidebar, type WorkbenchPanel } from "./ResearchSidebar.js";
import { SourcePanel } from "./SourcePanel.js";
import { AssetPanel } from "./AssetPanel.js";
import "./workbench.css";
import { ReferenceDialog } from "./ReferenceDialog.js";
import { useEdgeArchive } from "./edge-archive.js";
import { edgeKeyboardContext, mainlineEdges } from "./edge-interaction.js";
import { readReferenceLayouts, rememberReferencePositions } from "./reference-layout.js";
import { readNodeCreation, resumeNodeCreation, type NodeCreation } from "./creation.js";
import { CardPreview } from "./CardPreview.js";
import { AudioUploadController } from "./audio-upload.js";
import "./audio.css";
import { CanvasDocument } from "./collaboration.js";
import { nodeTypes, pluginFor } from "./plugins.js";
import { WindowFrame } from "./windows/Frame.js";
import {
  detailWindowSize,
  openWindow,
  type Camera,
  type WorkWindow,
} from "./windows/state.js";
import { SubscriptionEditor } from "./SubscriptionEditor.js";
import { NodeWindow } from "./windows/NodeWindow.js";
import { Dialog } from "./Dialog.js";
import {OrganizeDialog} from "./OrganizeDialog.js";
import { buildHierarchy, fitScopeCamera, nodeStatus, scopeEdges, scopeReferences, oneHopNeighbors, nodesInRectangle } from "./hierarchy.js";
import "./styles.css";
import "./presentation.css";
import "./sidebar.css";
import "./mobile.css";
import { useCanvasViewport } from "./viewport.js";
import { useCanvasTouch, zoomCameraAt } from "./canvas-touch.js";

const NAVIGATION_DRAWER_WIDTH = 1120;

export function App() {
  const projection = useProjection<{ canvas?: CanvasBoot | null }>(),
    status = useAgentViewStatus();
  if (!projection?.canvas)
    return (
      <div className="rv-app rv-opening">
        {status.ready ? "请从项目列表打开自动科研 v2。" : "正在连接研究项目…"}
      </div>
    );
  return (
    <CanvasProject
      key={`${projection.canvas.viewer}:${projection.canvas.project}`}
      boot={projection.canvas}
    />
  );
}
function CanvasProject({ boot }: { boot: CanvasBoot }) {
  const propose = usePropose(),
    status = useAgentViewStatus(),
    key = `research-v2:${boot.viewer}:${boot.project}`;
  const dataEpoch = boot.dataEpoch ?? boot.epoch;
  const call = useCallback<Call>(
    async <T,>(action: string, params: Record<string, unknown> = {}) => {
      const answer = await propose(action, encodeParams(params));
      if (!answer.ok) throw new Error(answer.message || "操作未完成");
      const domain = answer.result as { status?: string; error?: { message?: string } };
      if (domain?.status === "rejected") throw new Error(domain.error?.message ?? "操作被拒绝");
      return answer.result as T;
    },
    [propose],
  );
  const nodeArchive = useEdgeArchive(propose, `${key}:node-archive`, "node");
  const [creationReceipts, setCreationReceipts] = useState<Array<{ node: ResearchNode; edge?: ResearchEdge; parent?: ResearchNode }>>([]);
  const [graphFrame, setGraph] = useState(emptyGraph),
    graphRef = useRef(graphFrame),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  // Acknowledged receipts overlay the trusted frame until its change stream catches up.
  // A slow/failed refresh never turns a successful write back into a pending write.
  const graph = useMemo(() => {
    if (!creationReceipts.length && nodeArchive.state?.phase !== "confirmed") return graphFrame;
    const nodes = new Map(graphFrame.nodes.map(node => [node.id, node]));
    const edges = new Map(graphFrame.edges.map(edge => [edge.id, edge]));
    for (const receipt of creationReceipts) {
      if (!nodes.has(receipt.node.id)) nodes.set(receipt.node.id, receipt.node);
      if (receipt.parent) { const current = nodes.get(receipt.parent.id); if (!current || current.version <= receipt.parent.version) nodes.set(receipt.parent.id, { ...receipt.parent, data: { ...receipt.parent.data, members: [...new Set([...(Array.isArray(current?.data.members) ? current.data.members : []), ...(Array.isArray(receipt.parent.data.members) ? receipt.parent.data.members : [])])] } }); }
      if (receipt.edge && !edges.has(receipt.edge.id)) edges.set(receipt.edge.id, receipt.edge);
    }
    const removed = nodeArchive.state?.phase === "confirmed" ? nodeArchive.state.params.node : undefined;
    if (removed && nodes.has(removed)) nodes.set(removed, { ...nodes.get(removed)!, archived: true });
    return { ...graphFrame, nodes: [...nodes.values()], edges: [...edges.values()] };
  }, [graphFrame, creationReceipts, nodeArchive.state]);
  useEffect(() => {
    setCreationReceipts(previous => previous.some(receipt => graphFrame.nodes.some(node => node.id === receipt.node.id)) ? previous.filter(receipt => !graphFrame.nodes.some(node => node.id === receipt.node.id)) : previous);
    const archived = graphFrame.nodes.find(node => node.id === nodeArchive.state?.params.node && node.archived);
    if (archived) nodeArchive.observedArchived(archived.id);
  }, [graphFrame.nodes, nodeArchive.state]);
  const [camera, setCamera] = useState<Camera>(() =>
    stored(`${key}:camera`, { x: 0, y: 0, zoom: 1 }),
  );
  const [windows, setWindows] = useState<WorkWindow[]>(() =>
    stored(`${key}:windows`, []),
  );
  const root = useRef<HTMLDivElement>(null), scopeHeader = useRef<HTMLElement>(null);
  const [scopeBottom, setScopeBottom] = useState(0);
  const viewport = useCanvasViewport(root);
  const compact = viewport.width < 800 || viewport.coarse && viewport.width < NAVIGATION_DRAWER_WIDTH;
  const compactShort = compact && viewport.visibleHeight < 450;
  const gestureCancel = useRef<(() => void) | null>(null), suppressTouchClick = useRef(false);
  useCanvasTouch(root, camera, setCamera, gestureCancel, suppressTouchClick);
  const [organizing,setOrganizing]=useState(false);
  const [scope, setScope] = useState(() => new URLSearchParams(window.location.search).has("researchScope") ? readResearchLocation(window.location.href).scope : stored<string>(`${key}:scope`, ""));
  // Legacy researchLayout links open this same editable canvas. Layout is an action.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => stored(`${key}:tree-expanded`, {}));
  const [relations, setRelations] = useState<"none" | "selected" | "scope" | "all">("scope");
  const edgeArchive = useEdgeArchive(propose, `${key}:edge-archive`);
  const archiveControllers = useRef({ nodes: nodeArchive, edges: edgeArchive });
  archiveControllers.current = { nodes: nodeArchive, edges: edgeArchive };
  const [selectedEdge, setSelectedEdge] = useState(() => edgeArchive.state?.params.edge ?? "");
  const composing = useRef(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => stored(`${key}:navigation:collapsed`, false));
  const [searchRequest, setSearchRequest] = useState(0);
  const navigationButton = useRef<HTMLButtonElement>(null);
  const closeNavigation = () => { setNavigationOpen(false); navigationButton.current?.focus(); };
  const searchNavigation = () => { setNavigationCollapsed(false); setNavigationOpen(viewport.width < NAVIGATION_DRAWER_WIDTH); setSearchRequest(previous => previous + 1); };
  useEffect(() => { persist(`${key}:navigation:collapsed`, navigationCollapsed); }, [key, navigationCollapsed]);
  const [workbench, setWorkbench] = useState<"sources" | "workflow" | "assets" | "">(() => stored(`${key}:workbench`, ""));
  const [visitedPanels, setVisitedPanels] = useState<Set<string>>(() => new Set([stored(`${key}:workbench`, "")]));
  const workflow = useWorkflowPage(call, dataEpoch);
  const workSummary = workflow.page?.summaries ?? {};
  const [workflowIntent, setWorkflowIntent] = useState<WorkflowIntent>();
  const showWorkbench = (panel: WorkbenchPanel) => { setWorkbench(panel); setVisitedPanels(old => new Set([...old, panel])); };
  useEffect(() => { persist(`${key}:workbench`, workbench); }, [key, workbench]);
  const cameras = useRef(new Map<string, Camera>());
  const cameraScope = useRef("");
  const [cameraReadyScope, setCameraReadyScope] = useState("");
  const [copied, setCopied] = useState("");
  const [editing, setEditing] = useState(""), [visitedEditors, setVisitedEditors] = useState<Set<string>>(() => new Set());
  const [cardMenu, setCardMenu] = useState("");
  const [editingField, setEditingField] = useState<"title" | "summary" | "body">("summary");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [interactionMode, setInteractionMode] = useState<"pan" | "select">("pan");
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [referenceNode, setReferenceNode] = useState("");
  const [deleteNode, setDeleteNode] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [hiddenReferences, setHiddenReferences] = useState<Record<string, string[]>>({});
  const [referenceLayouts, setReferenceLayouts] = useState(() => readReferenceLayouts(stored(`${key}:reference-layouts`, {})));
  useEffect(() => { persist(`${key}:reference-layouts`, referenceLayouts); }, [key, referenceLayouts]);
  const [pasteText, setPasteText] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [previewNode, setPreviewNode] = useState("");
  const suppressedClick = useRef("");
  const editCard = (id: string, field: "title" | "summary" | "body" = "summary") => { setSelectedEdge(""); if (compact) { open(id, undefined, true, field); return; } setSelected(id); setSelectedIds(new Set([id])); setEditingField(field); if (!canEdit(boot.role)) return; setEditing(id); setCardMenu(""); setVisitedEditors(previous => new Set(previous).add(id)); };
  const [selected, setSelected] = useState(() => readResearchLocation(window.location.href).node),
    [menu, setMenu] = useState<"create" | "history" | null>(null);
  const [creation, setCreation] = useState(() => readNodeCreation(stored(`${key}:creation`, null)));
  const creationRequest = useRef(creation), creationRunning = useRef(false);
  const [creationError, setCreationError] = useState("");
  const saveCreation = (next: NodeCreation | undefined) => {
    creationRequest.current = next; persist(`${key}:creation`, next ?? null); setCreation(next);
  };
  const initialCreationMeta = creation?.data.data.meta as { researchRole?: string; successCriteria?: string } | undefined;
  const [newRole, setNewRole] = useState<"target" | "motivation" | null>(() => initialCreationMeta?.researchRole === "target" || initialCreationMeta?.researchRole === "motivation" ? initialCreationMeta.researchRole : null);
  const [newSummary, setNewSummary] = useState(creation?.data.summary ?? ""), [successCriteria, setSuccessCriteria] = useState(initialCreationMeta?.successCriteria ?? "");
  const [newType, setNewType] = useState<NodeType>(creation?.data.type ?? "note"),
    [title, setTitle] = useState(creation?.data.title ?? ""),
    [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState<{
    source: string;
    kind: "semantic" | "event";
    side: CanvasSide;
    x: number;
    y: number;
  } | null>(null);
  const [relation, setRelation] = useState<{
      source: string;
      target: string;
      ports: GraphEdgePorts;
    } | null>(null),
    [label, setLabel] = useState("支持");
  const [relationPending, setRelationPending] = useState(false);
  const relationRequest = useRef<Record<string, unknown> | null>(null);
  const [subscription, setSubscription] = useState<{
    source: string;
    target: string;
    previous?: ResearchSubscription;
  } | null>(null);
  const docs = useRef(new Map<string, CanvasDocument>()),
    syncing = useRef(false),
    again = useRef(false),
    mounted = useRef(true),
    disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const documentFor = useCallback(
    (node: string, field: "text" | "layout") => {
      const id = `${node}:${field}`;
      let doc = docs.current.get(id);
      if (!doc) {
        doc = new CanvasDocument(call, node, field, `${key}:doc:${id}`);
        docs.current.set(id, doc);
      }
      return doc;
    },
    [call, key],
  );
  const audioUploads = useMemo(() => ({ controllers: new Map<string, AudioUploadController>(), cleanup: undefined as ReturnType<typeof setTimeout> | undefined }), [call, key]);
  useEffect(() => {
    if (audioUploads.cleanup) clearTimeout(audioUploads.cleanup);
    return () => { audioUploads.cleanup = setTimeout(() => {
      for (const controller of audioUploads.controllers.values()) controller.close();
      audioUploads.controllers.clear();
    }, 0); };
  }, [audioUploads]);
  const audioFor = useCallback((node: string) => {
    let controller = audioUploads.controllers.get(node);
    if (!controller) { controller = new AudioUploadController(call, key, node); audioUploads.controllers.set(node, controller); }
    return controller;
  }, [audioUploads, call, key]);
  const layout = documentFor("board", "layout"),
    layoutState = useSyncExternalStore(layout.subscribe, layout.snapshot);
  const positions = layout.positions;
  const [dragged, setDragged] = useState<(GraphPosition & { id: string }) | null>(null);
  const [groupDragged, setGroupDragged] = useState<Record<string, GraphPosition>>({});
  const hierarchy = useMemo(() => buildHierarchy(graph.nodes), [graph.nodes]);
  const nodes = useMemo(() => graph.nodes.filter((node) => !node.archived), [graph.nodes]), byId = hierarchy.byId;
  const navigationRuns = useMemo(() => [...graph.runs, ...(workflow.page?.runs ?? [])], [graph.runs, workflow.page?.runs]);
  const scopeNode = scope ? byId.get(scope) : undefined;
  const goals = hierarchy.roots.filter((node) => node.type === "goal");
  const projectTitle = boot.title || (goals[0]?.title ? (/GOAL\s*$/i.test(goals[0].title) ? `${goals[0].title.replace(/\s*[·•|｜-]?\s*GOAL\s*$/i, "").trim() || "项目"} 研究计划` : goals[0].title) : "研究工作空间");
  const expandedIds = new Set(nodes.filter(node => expanded[node.id] ?? (hierarchy.roots.some(root => root.id === node.id) && node.type === "goal")).map(node => node.id));
  const tree = useMemo(() => canvasTree(graph.nodes, scope && byId.has(scope) ? scope : "", new Set(nodes.filter(node => expanded[node.id] ?? (hierarchy.roots.some(root => root.id === node.id) && node.type === "goal")).map(node => node.id))), [graph.nodes, scope, expanded]);
  const references = useMemo(() => scopeReferences(graph.nodes, graph.edges, scope && !byId.has(scope) ? [] : tree.nodes, scope), [graph.nodes, graph.edges, tree, scope]);
  const scopedNodes = references.nodes.filter(node => !(hiddenReferences[scope] ?? []).includes(node.id));
  // A reference has a private display location near its focused scope. The original public geometry is untouched.
  const referencePositions = new Map<string, GraphPosition>();
  if (scope && tree.nodes.length) {
    const right = Math.max(...tree.nodes.map(node => { const p = positions.get(node.id) ?? node; return p.x + canvasCardSize(node, "canvas", positions.get(node.id)).width; })) + 112;
    let top = Math.min(...tree.nodes.map(node => (positions.get(node.id) ?? node).y));
    const saved = referenceLayouts[scope] ?? {};
    const external = scopedNodes.filter(node => references.external.has(node.id));
    // Keep established reference cards still when an owned card moves or the graph refreshes.
    for (const node of external) if (saved[node.id]) referencePositions.set(node.id, { ...positions.get(node.id), ...saved[node.id] });
    for (const node of external) {
      if (referencePositions.has(node.id)) continue;
      const size = canvasCardSize(node, "canvas", positions.get(node.id));
      for (;;) {
        const collision = external.find(other => {
          const at = referencePositions.get(other.id);
          if (!at) return false;
          const otherSize = canvasCardSize(other, "canvas", positions.get(other.id));
          return right < at.x + otherSize.width + 32 && right + size.width + 32 > at.x && top < at.y + otherSize.height + 32 && top + size.height + 32 > at.y;
        });
        if (!collision) break;
        top = referencePositions.get(collision.id)!.y + canvasCardSize(collision, "canvas", positions.get(collision.id)).height + 32;
      }
      referencePositions.set(node.id, { ...positions.get(node.id), x: right, y: top });
      top += size.height + 32;
    }
  }
  useEffect(() => {
    if (loading || !layoutState.ready || !scope) return;
    setReferenceLayouts(previous => rememberReferencePositions(previous, scope, referencePositions));
  }, [scope, loading, layoutState.ready, referencePositions]);
  const toggleTree = (id: string) => setExpanded(current => ({ ...current, [id]: !expandedIds.has(id) }));
  const navigationNarrow = viewport.width < NAVIGATION_DRAWER_WIDTH;
  useEffect(() => { if (!navigationNarrow) setNavigationOpen(false); }, [navigationNarrow]);
  useEffect(() => {
    const element = scopeHeader.current, app = root.current;
    if (!element || !app) return;
    // The toolbar can wrap as scopes and navigation width change. Keep the
    // related panel below its actual local bounds, including inside an iframe.
    const update = () => {
      if (element.offsetHeight > 0) {
        const bottom = element.offsetTop + element.offsetHeight;
        app.style.setProperty("--rv-scope-bottom", `${bottom}px`); setScopeBottom(bottom);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact]);
  const position = (node: ResearchNode): GraphPosition => dragged?.id === node.id ? dragged : groupDragged[node.id] ?? referencePositions.get(node.id) ?? positions.get(node.id) ?? { x: node.x, y: node.y };
  const cardSize = (node: ResearchNode) => canvasCardSize(node, "canvas", position(node));
  const navigationWidth = navigationNarrow ? 0 : navigationCollapsed ? 80 : 304;
  const scopeTop = Math.max(compact ? compactShort ? 132 : 188 : 172, scopeBottom + 24);
  const scopeArea = { left: compact ? 20 : navigationWidth + 24, top: scopeTop, width: Math.max(280, viewport.width - (compact ? 40 : navigationWidth + 48)), height: Math.max(60, viewport.visibleHeight - scopeTop - (compact ? 40 : 68)) };
  const fit = () => setCamera(fitScopeCamera(scopedNodes, position, scopeArea, cardSize));
  const writeLocation = (next: string, node = "", replace = false) => {
    const url = researchLocationUrl(window.location.href, boot.project, { scope: next, node });
    if (url !== window.location.href) window.history[replace ? "replaceState" : "pushState"](window.history.state, "", url);
  };
  const navigate = (next: string, node = "") => {
    cameras.current.set(`${scope}:canvas`, camera);
    setSelectedEdge(""); setScope(next); writeLocation(next, node); setNavigationOpen(false); setSelected(""); setSelectedIds(new Set()); setEditing(""); setMenu(null); setPreviewNode("");
  };
  // Host history handling can flush pending effects during event dispatch. Keep
  // one listener for this project; camera changes only update the saved view.
  const navigationView = useRef({ scope, camera });
  navigationView.current = { scope, camera };
  useEffect(() => {
    const pop = () => {
      const location = readResearchLocation(window.location.href);
      const previous = navigationView.current;
      cameras.current.set(`${previous.scope}:canvas`, previous.camera);
      setSelectedEdge(""); setScope(location.scope); setSelected(location.node); setSelectedIds(new Set(location.node ? [location.node] : [])); setEditing(""); setCardMenu(""); setPreviewNode("");
      setWindows(previous => previous.map(item => ({ ...item, minimized: item.node !== location.node })));
      setPendingOpen(location.node);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [key]);
  useEffect(() => { persist(`${key}:scope`, scope); }, [scope, key]);
  useEffect(() => { persist(`${key}:tree-expanded`, expanded); }, [expanded, key]);
  useEffect(() => {
    if (loading || (!layoutState.ready && !layoutState.error) || !viewport.width) return;
    const id = `${scope}:canvas:${compact ? "compact" : "wide"}`;
    if (cameraScope.current === id) return;
    cameraScope.current = id;
    setCameraReadyScope(id);
    const initial = fitScopeCamera(scopedNodes, position, scopeArea, cardSize);
    // Start narrow screens at readable text size; the overview remains one tap away.
    const focus = scopedNodes.find((node) => node.type === "goal") ?? [...scopedNodes].sort((a, b) => position(a).x - position(b).x || position(a).y - position(b).y)[0];
    if (compact && focus && initial.zoom < 0.85) {
      initial.zoom = 0.85;
      initial.x = scopeArea.left - position(focus).x * initial.zoom;
      initial.y = scopeArea.top - position(focus).y * initial.zoom;
    }
    setCamera(cameras.current.get(`${scope}:canvas`) ?? initial);
    root.current?.querySelector(".rv-canvas")?.scrollTo?.(0, 0);
  }, [scope, loading, compact, viewport.width, layoutState.ready, layoutState.error]);
  const refresh = useCallback(async () => {
    if (syncing.current) {
      again.current = true;
      return;
    }
    syncing.current = true;
    try {
      do {
        again.current = false;
        const reconcileNodes = archiveControllers.current.nodes.reconcileRead();
        const reconcileEdges = archiveControllers.current.edges.reconcileRead();
        const result = graphRef.current.cursor
          ? await refreshGraph(call, graphRef.current)
          : await readGraph(call);
        if (!mounted.current) return;
        graphRef.current = result;
        reconcileNodes(result.nodes); reconcileEdges(result.edges);
        setGraph(result);
        setLoading(false);
      } while (again.current);
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      syncing.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [call]);
  useEffect(() => {
    if (disposeTimer.current) clearTimeout(disposeTimer.current);
    mounted.current = true;
    return () => {
      mounted.current = false;
      disposeTimer.current = setTimeout(() => {
        for (const doc of docs.current.values()) doc.close();
        docs.current.clear();
      }, 0);
    };
  }, [refresh, layout]);
  useEffect(() => {
    void refresh();
    for (const doc of docs.current.values()) if (doc.field === "text") void doc.sync();
  }, [dataEpoch, refresh]);
  useEffect(() => { void layout.sync(); }, [boot.epoch, layout]);
  useEffect(() => {
    persist(`${key}:camera`, camera);
  }, [camera, key]);
  useEffect(() => {
    persist(`${key}:windows`, windows);
  }, [windows, key]);
  const editable = canEdit(boot.role), runnable = canRun(boot.role);
  const visualPosition = (node: ResearchNode) => { const p = position(node); return { x: p.x * camera.zoom + camera.x, y: p.y * camera.zoom + camera.y }; };
  const visualPlugin = (node: ResearchNode) => { const size = cardSize(node); return { width: size.width * camera.zoom, height: size.height * camera.zoom }; };
  const point = (clientX: number, clientY: number) => {
    const rect = root.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - camera.x) / camera.zoom,
      y: (clientY - rect.top - camera.y) / camera.zoom,
    };
  };
  const panDetail = (p: { x: number; y: number }) => {
    if (compact) return;
    const screen = { x: p.x * camera.zoom + camera.x, y: p.y * camera.zoom + camera.y };
    const detail = detailWindowSize(camera.zoom, viewport);
    const maxLeft = viewport.width - detail.width - 12, maxTop = viewport.height - detail.height - 12;
    const safeLeft = Math.min(navigationWidth + 20, maxLeft), safeTop = Math.min(compact ? 128 : 172, maxTop);
    const nextLeft = Math.max(safeLeft, Math.min(screen.x, maxLeft));
    const nextTop = Math.max(safeTop, Math.min(screen.y, maxTop));
    setCamera((current) => ({ ...current, x: current.x + nextLeft - screen.x, y: current.y + nextTop - screen.y }));
  };
  const open = (nodeId: string, version?: string, record = true, editField?: WorkWindow["editField"]) => {
    setSelectedEdge("");
    const node = byId.get(nodeId);
    if (!node) {
      setError("引用的节点不在当前项目中");
      return;
    }
    if (record) writeLocation(scope, nodeId);
    setWorkbench(""); setMenu(null); setCardMenu(""); setEditing("");
    setPreviewNode("");
    setSelected(nodeId);
    let p = position(node);
    panDetail(p);
    setWindows((previous) =>
      openWindow(
        previous,
        nodeId,
        { x: p.x * camera.zoom + camera.x, y: p.y * camera.zoom + camera.y },
        viewport,
        version,
        { x: p.x, y: p.y },
      ).map((window) => window.id === `${nodeId}:${version ?? "current"}` ? { ...window, scope, editField } : window),
    );
  };
  const openFile = (path: string, source: string) => {
    setWorkbench("");
    const matches = graph.nodes.filter(
      (node) =>
        node.type === "file" && (node.id === path || node.data.path === path),
    );
    if (matches.length === 1) {
      open(matches[0].id);
      return;
    }
    const node = byId.get(source);
    if (!node) return;
    const p = position(node),
      version = `reference:${path}`;
    panDetail({ x: p.x + 35, y: p.y + 35 });
    setWindows((previous) =>
      openWindow(
        previous,
        source,
        { x: p.x * camera.zoom + camera.x, y: p.y * camera.zoom + camera.y },
        viewport,
        version,
        { x: p.x + 35, y: p.y + 35 },
      ).map((window) =>
        window.node === source && window.version === version
          ? { ...window, filePath: path, scope }
          : window,
      ),
    );
  };
  const focus = (node: ResearchNode) => {
    setSelectedEdge("");
    const parent = (hierarchy.parents.get(node.id) ?? [])[0] ?? "";
    if (parent !== scope) navigate(parent, node.id); else writeLocation(scope, node.id);
    setSelected(node.id); setSelectedIds(new Set([node.id]));
  };
  const reveal = (node: ResearchNode) => {
    if (node.type === "folder") { navigate(node.id); return; }
    focus(node);
    // Defer opening until the destination scope has committed its coordinates.
    setPendingOpen(node.id);
  };
  const [pendingOpen, setPendingOpen] = useState(() => readResearchLocation(window.location.href).node);
  const [pendingLocate, setPendingLocate] = useState("");
  useEffect(() => {
    if (cameraReadyScope !== `${scope}:canvas:${compact ? "compact" : "wide"}` || !pendingLocate) return;
    const node = byId.get(pendingLocate);
    if (node) setCamera(fitScopeCamera([node], position, scopeArea, cardSize));
    setPendingLocate("");
  }, [scope, compact, cameraReadyScope, pendingLocate, graph.nodes]);
  useEffect(() => {
    const destination = `${scope}:canvas:${compact ? "compact" : "wide"}`;
    // The scope effect schedules its camera above. Wait for that state to commit
    // before applying any detail visibility pan against the destination camera.
    if (cameraReadyScope !== destination || !pendingOpen) return;
    if (byId.has(pendingOpen)) {
      open(pendingOpen, undefined, false);
      setPendingOpen("");
    }
  }, [scope, compact, cameraReadyScope, pendingOpen, graph.nodes]);
  const mutate = async (action: string, params: Record<string, unknown>) => {
    setError("");
    try {
      const result = await call(action, { request: requestId(), ...params });
      void refresh();
      return result;
    } catch (error) {
      setError(String(error));
      return null;
    }
  };
  const tracePointer = (
    event: ReactPointerEvent<HTMLElement>,
    move: (event: PointerEvent) => void,
    end?: (event: PointerEvent) => void,
  ) => {
    const element = event.currentTarget;
    const update = (next: PointerEvent) => { if (next.pointerId === event.pointerId) move(next); };
    element.setPointerCapture(event.pointerId);
    const finish = (last: PointerEvent) => {
      if (last.pointerId !== event.pointerId) return;
      gestureCancel.current = null;
      element.removeEventListener("pointermove", update);
      element.removeEventListener("pointerup", finish);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", cancel);
      end?.(last);
    };
    const cancel = (next?: PointerEvent) => {
      if (next && next.pointerId !== event.pointerId) return;
      gestureCancel.current = null;
      element.removeEventListener("pointermove", update);
      element.removeEventListener("pointerup", finish);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", cancel);
      setDragged(null); setGroupDragged({}); setSelectionBox(null);
      setConnecting(null);
      void layout.endMove();
    };
    gestureCancel.current = cancel;
    element.addEventListener("pointermove", update);
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", cancel);
    element.addEventListener("lostpointercapture", cancel);
  };
  useEffect(() => {
    const surface = root.current?.querySelector<HTMLElement>(".rv-canvas");
    if (!surface) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = surface.getBoundingClientRect();
      const x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      setCamera((previous) => {
        const zoom = Math.max(
          0.2,
          Math.min(2.4, previous.zoom * Math.exp(-event.deltaY * 0.001)),
        );
        return {
          zoom,
          x: x - ((x - previous.x) * zoom) / previous.zoom,
          y: y - ((y - previous.y) * zoom) / previous.zoom,
        };
      });
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, []);
  const startConnection = (
    event: ReactPointerEvent<HTMLElement>,
    node: ResearchNode,
    kind: "semantic" | "event",
    side: CanvasSide = "right",
  ) => {
    if (kind === "semantic" ? !editable : !runnable) return;
    event.preventDefault();
    event.stopPropagation();
    const p = point(event.clientX, event.clientY);
    setConnecting({ source: node.id, kind, side, ...p });
    tracePointer(
      event,
      (next) =>
        setConnecting({
          source: node.id,
          kind, side,
          ...point(next.clientX, next.clientY),
        }),
      (next) => {
        const targetId = document
          .elementFromPoint(next.clientX, next.clientY)
          ?.closest<HTMLElement>("[data-node]")?.dataset.node;
        setConnecting(null);
        if (!targetId || targetId === node.id) return;
        if (kind === "semantic") {
          const element = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>("[data-side]");
          const target = byId.get(targetId), at = point(next.clientX, next.clientY);
          const targetSide = element?.dataset.side as CanvasSide | undefined;
          const inferred: CanvasSide | undefined = target ? (() => { const p = position(target), size = cardSize(target); return ([ ["left", Math.abs(at.x - p.x)], ["right", Math.abs(at.x - p.x - size.width)], ["top", Math.abs(at.y - p.y)], ["bottom", Math.abs(at.y - p.y - size.height)] ] as [CanvasSide, number][]).sort((a, b) => a[1] - b[1])[0][0]; })() : undefined;
          relationRequest.current = null;
          setRelation({ source: node.id, target: targetId, ports: { sourceSide: side, targetSide: targetSide ?? inferred } });
          setLabel("支持");
        } else if (byId.get(targetId)?.type === "agent")
          setSubscription({ source: node.id, target: targetId });
        else setError("事件插头应连接到 Agent 的输入端");
      },
    );
  };
  const curve = (source: ResearchNode, target: ResearchNode | { x: number; y: number }, ports?: GraphEdgePorts) => {
    const a = position(source), b = "id" in target ? position(target) : target;
    const route = canvasEdgeCurve(a, b, cardSize(source), "id" in target ? cardSize(target) : { width: 0, height: 0 }, undefined, ports);
    const middle = route.points[8];
    return { d: route.d, x: middle.x, y: middle.y };
  };
  const copyReference = async (node: ResearchNode) => {
    try {
      const location = { scope: scope || (hierarchy.parents.get(node.id) ?? [])[0] || "", node: node.id };
      await navigator.clipboard.writeText(researchLocationUrl(window.location.href, boot.project, location));
      if (mounted.current) { setCopied(node.id); setNotice("已复制节点引用"); }
    } catch { setError("无法访问剪贴板，请使用更多菜单中的节点地址。"); }
  };
  const acceptReference = (text: string) => {
    const reference = parseResearchReference(text, window.location.href, boot.project);
    if (!reference || !byId.has(reference.node)) { setError("请粘贴当前项目的有效节点地址；普通文本不会成为节点引用。"); return false; }
    if (!editable) { reveal(byId.get(reference.node)!); setPasteText(null); return true; }
    if (!scopeNode) { reveal(byId.get(reference.node)!); setNotice("已定位节点；进入目标子图后可引入引用。"); }
    else if (scopeNode.id === reference.node) { setError("当前节点已经是这个子图的入口。"); return false; }
    else setReferenceNode(reference.node);
    setPasteText(null); return true;
  };
  const toggleSelection = (id: string, additive: boolean) => {
    setSelectedEdge("");
    setSelected(id);
    setSelectedIds(previous => { if (!additive) return new Set([id]); const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const expandAll = async () => {
    const all = scopeNode ? [scopeNode, ...hierarchy.descendants(scopeNode.id)] : nodes;
    setExpanded(previous => ({ ...previous, ...Object.fromEntries(all.map(node => [node.id, true])) }));
    if (editable && await layout.arrange("tree", all.map(node => node.id), true) && mounted.current) {
      setCamera(fitScopeCamera(all, node => layout.positions.get(node.id) ?? node, scopeArea, node => canvasCardSize(node, "canvas", layout.positions.get(node.id))));
    }
  };
  const expandedNodeIds = new Set(windows.filter((window) => !window.closed && !window.minimized && (window.scope === undefined || window.scope === scope)).map((window) => window.node));
  const canvasNodes = scopedNodes.filter((node) => !expandedNodeIds.has(node.id));
  const scopeIds = new Set(scopedNodes.map((node) => node.id));
  const windowInScope = (window: WorkWindow) => window.scope !== undefined ? window.scope === scope : scopeIds.has(window.node) || window.node === scope || !scope && goals.some(goal => goal.id === window.node);
  const frontWindow = windows.filter(window => !window.closed && !window.minimized && windowInScope(window)).reduce<WorkWindow | undefined>((top, next) => !top || next.z >= top.z ? next : top, undefined);
  const visible = canvasNodes.filter((node) => {
    if (dragged?.id === node.id || groupDragged[node.id]) return true;
    const p = visualPosition(node), plugin = visualPlugin(node);
    return p.x < viewport.width + 300 && p.x + plugin.width > -300 && p.y < viewport.height + 300 && p.y + plugin.height > -300;
  });
  const selectedEdgeRecord = graph.edges.find(edge => edge.id === selectedEdge);
  const mainline = useMemo(() => mainlineEdges(graph.nodes, graph.edges), [graph.nodes, graph.edges]);
  const displayedEdges = scopeEdges(graph.edges, scopeIds, relations === "all" ? "scope" : relations, selected || selectedEdgeRecord?.source || "", true)
    .filter(edge => (relations === "all" || !mainline.hidden.has(edge.id)) && !byId.get(edge.source)?.archived && !byId.get(edge.target)?.archived
      && byId.has(edge.source) && byId.has(edge.target)
      && !(edgeArchive.state?.phase === "confirmed" && edgeArchive.state.params.edge === edge.id));
  const selectedBusinessEdge = displayedEdges.find(edge => edge.id === selectedEdge);
  const selectEdge = (id: string) => {
    if (!displayedEdges.some(edge => edge.id === id)) return;
    edgeArchive.clearRefusal();
    setSelectedEdge(id); setSelected(""); setSelectedIds(new Set()); setEditing(""); setPreviewNode(""); setCardMenu("");
    root.current?.querySelector<HTMLElement>(".rv-canvas")?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (selectedEdgeRecord?.archived) setSelectedEdge("");
    const archived = graph.edges.find(edge => edge.id === edgeArchive.state?.params.edge && edge.archived);
    if (archived) edgeArchive.observedArchived(archived.id);
  }, [graph.edges, selectedEdgeRecord, edgeArchive.state]);
  const archiveSelectedEdge = async (retry = false) => {
    if (!editable || !selectedBusinessEdge) return;
    if (retry && edgeArchive.state?.params.edge !== selectedBusinessEdge.id) return;
    const confirmed = await (retry ? edgeArchive.retry() : edgeArchive.start(selectedBusinessEdge, byId.get(selectedBusinessEdge.source)?.snapshot));
    if (confirmed && mounted.current) { setNotice("关系已删除"); void refresh(); }
  };
  const canArchiveEdge = editable && !!selectedBusinessEdge && (!edgeArchive.state || edgeArchive.state.phase === "refused");
  const edgeOperation = edgeArchive.state;
  return (
    <div ref={root} className={`rv-app rv-free ${compact ? "rv-compact" : ""} ${compactShort ? "rv-short" : ""} ${navigationCollapsed ? "rv-nav-collapsed" : "rv-nav-expanded"} ${navigationNarrow ? "rv-nav-narrow" : ""}`} onCompositionStartCapture={() => { composing.current = true; }} onCompositionEndCapture={() => { composing.current = false; }}
      onPointerDownCapture={event => { if ((event.target as Element).closest("[data-node],[data-window]")) setSelectedEdge(""); }}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); event.stopPropagation(); searchNavigation(); return; }
        if (event.defaultPrevented || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
          || !root.current || !edgeKeyboardContext(event.target, document.activeElement, root.current)) return;
        if (event.key === "Escape") { setSelectedEdge(""); return; }
        if (!["Backspace", "Delete"].includes(event.key) || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
          || !canArchiveEdge || edgeOperation) return;
        event.preventDefault(); event.stopPropagation(); void archiveSelectedEdge();
      }} data-project={boot.project} data-layout="canvas" data-scope={scope} data-graph-revision={graph.revision ?? ""} data-layout-revision={layout.revision} onPaste={event => { if ((event.target as Element).closest("input,textarea,[contenteditable=true]")) return; const text = event.clipboardData.getData("text/plain"); if (parseResearchReference(text, window.location.href, boot.project)) { event.preventDefault(); acceptReference(text); } }}>
      <div
        className={`rv-canvas rv-mode-${interactionMode}`}
        tabIndex={0} aria-label="研究画布"
        style={{
          backgroundSize: `${20 * camera.zoom}px ${20 * camera.zoom}px`,
          backgroundPosition: `${camera.x}px ${camera.y}px`,
        }}
        onClickCapture={event => { if (suppressTouchClick.current) { event.preventDefault(); event.stopPropagation(); suppressTouchClick.current = false; } }}
        onPointerDown={(event) => {
          const touchPan = event.pointerType === "touch" && compact && interactionMode === "pan";
          if (touchPan ? (event.target as Element).closest("button,input,textarea,select,a,summary,[data-edge],.rv-edge-label") : (event.target as Element).closest("[data-node], [data-edge],.rv-edge-label")) return;
          event.preventDefault();
          const start = { x: event.clientX, y: event.clientY };
          setSelectedEdge(""); event.currentTarget.focus({ preventScroll: true });
          setEditing(""); setCardMenu(""); setPreviewNode("");
          if ((interactionMode === "select" || event.shiftKey) && event.button !== 1) {
            const origin = point(event.clientX, event.clientY), additive = event.shiftKey || event.metaKey || event.ctrlKey;
            const before = additive ? selectedIds : new Set<string>();
            if (!additive) { setSelected(""); setSelectedIds(new Set()); }
            tracePointer(event, next => {
              const end = point(next.clientX, next.clientY);
              setSelectionBox({ x: Math.min(origin.x, end.x), y: Math.min(origin.y, end.y), width: Math.abs(end.x - origin.x), height: Math.abs(end.y - origin.y) });
              setSelectedIds(new Set([...before, ...nodesInRectangle(canvasNodes, origin, end, position, cardSize)]));
            }, () => setSelectionBox(null));
          } else {
            setSelected(""); setSelectedIds(new Set());
            tracePointer(event, next => {
              if (touchPan && Math.hypot(next.clientX - start.x, next.clientY - start.y) > 6) suppressTouchClick.current = true;
              setCamera({ ...camera, x: camera.x + next.clientX - start.x, y: camera.y + next.clientY - start.y });
            }, last => {
              // WebKit may retarget/suppress click after canvas pointer capture.
              // Resolve a stationary touch here, and suppress any following click.
              const id = (event.target as Element).closest<HTMLElement>("[data-node]")?.dataset.node;
              if (!touchPan || !id || suppressTouchClick.current || Math.hypot(last.clientX - start.x, last.clientY - start.y) > 6) return;
              suppressTouchClick.current = true;
              if (byId.get(id)?.type === "folder") navigate(id); else open(id);
            });
          }
        }}
      >
        <div
          className="rv-world"
          style={{
            // Nodes and SVG edges below already use screen coordinates. A CSS
            // transform would raster-scale glyphs and make copied text fuzzy.
            transform: "none",
          }}
        >
          <svg className="rv-edges" width="1" height="1" aria-label="节点关系" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`, transformOrigin: "0 0" }}>
            <defs>
              <marker
                id="rv-arrow"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0 0 L7 3.5 L0 7" fill="#a0ae97" />
              </marker>
              <marker id="rv-arrow-selected" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="#1d6bba" /></marker>
            </defs>
            {displayedEdges.map((edge) => {
                const source = byId.get(edge.source),
                  target = byId.get(edge.target);
                if (!source || !target || source.archived || target.archived)
                  return null;
                const path = curve(source, target, layout.edgePorts.get(edge.id));
                return (
                  <g key={edge.id} data-edge={edge.id} data-selected={selectedEdge === edge.id || undefined}
                    className={`rv-business-edge ${selectedEdge === edge.id ? "rv-edge-selected" : ""} ${mainline.emphasized.has(edge.id) ? "rv-mainline-edge" : ""} ${isHierarchyRelation(edge.label) ? "rv-containment" : ""} ${references.external.has(edge.source) || references.external.has(edge.target) ? "rv-reference-edge" : ""}`}
                    onPointerDown={event => { if (event.button === 0) event.stopPropagation(); }}>
                    <path className="rv-edge-stroke" d={path.d} markerEnd={selectedEdge === edge.id ? "url(#rv-arrow-selected)" : "url(#rv-arrow)"} />
                    <path className="rv-edge-hit" d={path.d} vectorEffect="non-scaling-stroke" onClick={event => { event.stopPropagation(); selectEdge(edge.id); }} />
                    <foreignObject
                      className="rv-edge-label"
                      x={path.x - 28}
                      y={path.y - 13}
                      width="56"
                      height="26"
                    >
                      <button
                        title={`${source.title} → ${target.title} · ${edge.created.owner}`}
                        aria-label={`选择关系 ${source.title} → ${target.title}：${edge.label}`}
                        aria-pressed={selectedEdge === edge.id}
                        onClick={event => { event.stopPropagation(); selectEdge(edge.id); }}
                      >
                        {edge.label === "contains" ? "包含" : edge.label === "references" ? "引用" : edge.label}
                      </button>
                    </foreignObject>
                  </g>
                );
              })}
            {graph.subscriptions
              .filter((edge) => relations !== "none" && !edge.archived && scopeIds.has(edge.source) && scopeIds.has(edge.target) && (relations === "scope" || relations === "all" || edge.source === selected || edge.target === selected))
              .map((edge) => {
                const source = byId.get(edge.source),
                  target = byId.get(edge.target);
                if (!source || !target || source.archived || target.archived)
                  return null;
                const path = curve(source, target);
                return (
                  <g
                    key={edge.id}
                    className={`rv-automation ${edge.enabled ? "" : "paused"}`}
                  >
                    <path d={path.d} />
                    <foreignObject
                      className="rv-edge-label"
                      x={path.x - 40}
                      y={path.y - 14}
                      width="80"
                      height="30"
                    >
                      <button
                        onClick={() => {
                          setSelectedEdge("");
                          setSubscription({ source: source.id, target: target.id, previous: edge });
                        }}
                      >
                        {edge.error
                          ? "监听故障"
                          : edge.enabled
                            ? "正在监听"
                            : "已暂停"}
                      </button>
                    </foreignObject>
                  </g>
                );
              })}
            {connecting && byId.has(connecting.source) && (
              <path
                className="rv-drawing"
                d={curve(byId.get(connecting.source)!, { x: connecting.x, y: connecting.y }, { sourceSide: connecting.side }).d}
              />
            )}
          </svg>
          {selectionBox && <div className="rv-selection-box" style={{ left: selectionBox.x * camera.zoom + camera.x, top: selectionBox.y * camera.zoom + camera.y, width: selectionBox.width * camera.zoom, height: selectionBox.height * camera.zoom }} />}
          {visible.map((node) => {
            const plugin = pluginFor(node.type),
              p = position(node),
              active = graph.runs.some(
                (run) =>
                  (run.node === node.id || node.ref?.endsWith(":" + run.node)) &&
                  ["running", "queued", "waiting"].includes(run.status),
              );
            return (
              <article
                key={node.id}
                data-node={node.id}
                data-reference={references.external.has(node.id) || undefined}
                aria-selected={selectedIds.has(node.id)}
                aria-label={node.title}
                tabIndex={0}
                className={`rv-node ${plugin.color} ${node.type} ${researchRole(node) ? "rv-role-" + researchRole(node) : ""} ${selectedIds.has(node.id) || selected === node.id ? "selected" : ""} ${references.external.has(node.id) ? "rv-external-reference" : ""} ${editing === node.id ? "editing" : ""}`}
                style={{
                  left: p.x * camera.zoom + camera.x,
                  top: p.y * camera.zoom + camera.y,
                  width: visualPlugin(node).width,
                  height: visualPlugin(node).height,
                  fontSize: 16 * camera.zoom,
                }}
                onClick={(event) => {
                  if ((event.target as Element).closest("button,input,textarea,select,a,summary")) return;
                  if (suppressedClick.current === node.id) { suppressedClick.current = ""; return; }
                  if (interactionMode === "select" || event.shiftKey || event.metaKey || event.ctrlKey) { toggleSelection(node.id, compact || event.shiftKey || event.metaKey || event.ctrlKey); setEditing(""); return; }
                  if (compact || node.type === "agent") { if (node.type === "folder") navigate(node.id); else open(node.id); return; }
                  editCard(node.id, (event.target as Element).closest("[data-edit-field=body]") ? "body" : (event.target as Element).closest("h3") ? "title" : "summary");
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter") { if (node.type === "agent") open(node.id); else editCard(node.id); }
                  if (event.key === " ") { event.preventDefault(); toggleSelection(node.id, event.shiftKey || event.metaKey || event.ctrlKey); }
                  if (event.key === "Escape") { setSelectedIds(new Set()); setSelected(""); setPreviewNode(""); }
                }}
                onPointerDown={(event) => {
                  if (event.pointerType === "touch" && compact && interactionMode === "pan") return;
                  if (event.button !== 0 || !(event.target as Element).closest(".rv-card-drag,.rv-title-drag") || (event.target as Element).closest("button,input,textarea,select")) return;
                  event.stopPropagation();
                  if (event.shiftKey || event.metaKey || event.ctrlKey) return;
                  setSelected(node.id);
                  if (!editable && !references.external.has(node.id)) return;
                  const displayed = new Set(canvasNodes.map(item => item.id));
                  // Only explicitly selected, currently displayed cards join this gesture.
                  // Collapsed descendants and cards from another scope never follow a parent.
                  const ids = selectedIds.has(node.id)
                    ? [...selectedIds].filter(id => displayed.has(id) && (editable || references.external.has(id)))
                    : [node.id];
                  const sharedIds = new Set(ids.filter(id => !references.external.has(id)));
                  if (sharedIds.size && (!layoutState.ready || !layout.beginMove())) return;
                  // Native text/image dragging must not take over this admitted gesture.
                  event.preventDefault();
                  setSelectedIds(new Set(ids));
                  const originals = Object.fromEntries(ids.map(id => [id, { ...position(byId.get(id)!) }]));
                  const start = point(event.clientX, event.clientY);
                  let moved = false;
                  suppressedClick.current = "";
                  const movedPoints = (next: PointerEvent) => {
                    const at = point(next.clientX, next.clientY);
                    return Object.fromEntries(Object.entries(originals).map(([id, p]) => [id, { ...p, x: p.x + at.x - start.x, y: p.y + at.y - start.y }]));
                  };
                  tracePointer(event, next => {
                    moved ||= Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) > 6;
                    if (!moved) return;
                    suppressedClick.current = node.id; setGroupDragged(movedPoints(next));
                  }, next => {
                    if (moved) {
                      const points = movedPoints(next);
                      const personal = new Map(Object.entries(points).filter(([id]) => !sharedIds.has(id)));
                      if (personal.size) setReferenceLayouts(previous => rememberReferencePositions(previous, scope, personal, true));
                      if (sharedIds.size) void layout.endMoves(Object.fromEntries(Object.entries(points).filter(([id]) => sharedIds.has(id))), ["position"], originals);
                    } else if (sharedIds.size) void layout.endMove();
                    setGroupDragged({});
                  });
                }}
              >
                <div className="rv-card-preview-face" hidden={editing === node.id}>
                  <header className="rv-card-drag" title={references.external.has(node.id) ? "拖动只调整自己在当前子图中的引用位置" : "拖动移动此卡片；明确多选后成组移动"}><span className="rv-drag-grip"><CardIcon name="grip" /></span><span>{cardKinds[cardKind(node)] ?? plugin.title}</span><span className={`rv-phase tone-${nodeStatus(node).tone}`}>{nodeStatus(node).label}</span></header>
                  <h3 className={node.type === "agent" ? "rv-agent-title rv-title-drag" : "rv-title-drag"}>{node.type === "agent" && <span className="rv-agent-avatar"><CardIcon name="agent" /></span>}{node.title}</h3>{workSummary[node.id] && (workSummary[node.id].review > 0 || workSummary[node.id].decision > 0) && <button className="rv-review-badge" onClick={() => showWorkbench("workflow")} aria-label={`${node.title} 的待审与待决策事项`}>待审 {workSummary[node.id].review} · 待决策 {workSummary[node.id].decision}</button>}{references.external.has(node.id) && <small className="rv-reference-badge">外部引用 · 同一节点</small>}
                  <CardPreview node={node} children={hierarchy.children.get(node.id) ?? []} nodes={nodes} call={call} epoch={dataEpoch} documentFor={documentFor} open={open} editable={editable} audioUpload={node.type === "audio" ? audioFor(node.id) : undefined} />
                  <footer onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                    {node.type === "agent" && <button className="rv-agent-chat" onClick={() => open(node.id)}><CardIcon name="chat" />继续聊天</button>}<span className="rv-card-activity">{active ? "● 运行中" : ""}</span>
                    {!references.external.has(node.id) && (hierarchy.children.get(node.id)?.length ?? 0) > 0 && <button className="rv-tree-toggle rv-icon-button" aria-expanded={expandedIds.has(node.id) || node.id === scope} aria-label={`${expandedIds.has(node.id) ? "收起" : "展开"} ${node.title}`} title={expandedIds.has(node.id) ? "收起子节点" : "展开子节点"} disabled={node.id === scope} onClick={() => toggleTree(node.id)}><CardIcon name={expandedIds.has(node.id) || node.id === scope ? "collapse" : "expand"} /></button>}
                    {node.type !== "agent" && <button className="rv-icon-button" aria-label={node.type === "folder" ? `进入 ${node.title}` : `查看详情 ${node.title}`} title={node.type === "folder" ? "进入分组" : "打开完整内容"} onClick={() => node.type === "folder" ? navigate(node.id) : open(node.id)}><CardIcon name="open" /></button>}
                    {(hierarchy.children.get(node.id)?.length ?? 0) > 0 && node.type !== "folder" && <button className="rv-icon-button" aria-label={`进入子图 ${node.title}`} title="进入子图，只看从属内容" onClick={() => navigate(node.id)}><CardIcon name="enter" /></button>}
                    {node.type !== "agent" && <button className="rv-icon-button rv-card-secondary" aria-label={`复制引用 ${node.title}`} title={copied === node.id ? "已复制节点引用" : "复制节点引用"} onClick={() => void copyReference(node)}><CardIcon name="reference" /></button>}
                    {node.type !== "agent" && <button className="rv-icon-button rv-card-secondary" aria-label={`预览邻居 ${node.title}`} title="预览一跳入边和出边" onClick={() => { setSelected(node.id); setEditing(""); setPreviewNode(previewNode === node.id ? "" : node.id); }}><CardIcon name="neighbors" /></button>}
                    <button className="rv-icon-button" aria-label={`更多 ${node.title}`} title="更多操作" aria-expanded={cardMenu === node.id} onClick={() => setCardMenu(cardMenu === node.id ? "" : node.id)}><CardIcon name="more" /></button>
                  </footer>
                  {cardMenu === node.id && <div className="rv-card-menu" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
                    {(compact || node.type === "agent") && <><button onClick={() => void copyReference(node)}>复制节点引用</button><button onClick={() => { setSelected(node.id); setPreviewNode(node.id); setCardMenu(""); }}>预览一跳邻居</button></>}
                    {node.type === "folder" && <button onClick={() => { setCardMenu(""); open(node.id); }}>分组设置与完整说明</button>}
                    <button onClick={() => { void navigator.clipboard.writeText(`${node.title}\n${node.summary || (typeof node.data.text === "string" ? node.data.text : "")}`).then(() => setCopied(node.id), () => setError("无法访问剪贴板，请直接选择文字复制。")); }}>{copied === node.id ? "已复制" : "复制内容"}</button>
                    <a href={researchLocationUrl(window.location.href, boot.project, { scope: scope || (hierarchy.parents.get(node.id) ?? [])[0] || "", node: node.id })} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); reveal(node); } }}>节点地址</a>
                    {references.external.has(node.id) && <button onClick={async () => { const link = graph.edges.find(edge => !edge.archived && edge.source === scope && edge.target === node.id && edge.label === "references"); if (link && editable && !await mutate("edge_archive", { edge: link.id, version: link.version, snapshot: scopeNode?.snapshot })) return; setHiddenReferences(previous => ({ ...previous, [scope]: [...(previous[scope] ?? []), node.id] })); setCardMenu(""); }}>移除此处引用</button>}
                    {editable && <button disabled={!!nodeArchive.state && nodeArchive.state.phase !== "refused"} title={nodeArchive.state ? "请先核对上次删除结果" : undefined} onClick={() => { nodeArchive.clearRefusal(); setDeleteNode(node.id); setCardMenu(""); }}>从图中删除节点…</button>}
                    {editable && <button onClick={() => editCard(node.id, "summary")}>编辑摘要</button>}
                    {editable && contentTypes.includes(node.type) && <button onClick={() => editCard(node.id, "body")}>编辑正文</button>}
                  </div>}
                </div>
                {visitedEditors.has(node.id) && <InlineEditor node={node} call={call} doc={contentTypes.includes(node.type) ? documentFor(node.id, "text") : undefined} draftKey={`${key}:inline:${node.id}`} active={editing === node.id} field={editingField} close={() => setEditing("")} changed={() => void refresh()} />}
                {editable && !references.external.has(node.id) && <button className="rv-resize-card" disabled={!layoutState.ready} aria-label={`调整 ${node.title} 尺寸`} title="拖动调整预览大小；方向键微调" onPointerDown={event => {
                  event.stopPropagation(); event.preventDefault();
                  if (!layout.beginMove()) return;
                  const start = point(event.clientX, event.clientY), original = { ...position(node), ...cardSize(node) };
                  const geometry = (next: PointerEvent): GraphPosition => {
                    const at = point(next.clientX, next.clientY);
                    return { ...original, ...boundedCanvasSize({ width: original.width + at.x - start.x, height: original.height + at.y - start.y }) };
                  };
                  tracePointer(event, next => setDragged({ id: node.id, ...geometry(next) }), next => {
                    const final = geometry(next); setDragged({ id: node.id, ...final });
                    void layout.endMove(node.id, final, ["size"], original); setDragged(null);
                  });
                }} onKeyDown={event => {
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault(); event.stopPropagation();
                  if (!layout.beginMove()) return;
                  const step = event.shiftKey ? 64 : 24, size = cardSize(node);
                  const next = { ...position(node), ...boundedCanvasSize({ width: size.width + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), height: size.height + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) }) };
                  void layout.endMove(node.id, next, ["size"], { ...position(node), ...size }); setDragged(null);
                }}>◢</button>}
                {editable &&
                  (["top", "right", "bottom", "left"] as const).map((side) => (
                    <button
                      key={side}
                      className={`rv-handle ${side}`}
                      data-side={side}
                      aria-label={`从${node.title}${({ top: "上", right: "右", bottom: "下", left: "左" })[side]}侧连线`}
                      onPointerDown={(event) =>
                        startConnection(event, node, "semantic", side)
                      }
                    />
                  ))}
                {plugin.events.length > 0 && (
                  <button
                    className="rv-event-port"
                    title={plugin.events.map((event) => event.title).join("、")}
                    aria-label={`${node.title}事件插头`}
                    onPointerDown={(event) =>
                      startConnection(event, node, "event")
                    }
                  >
                    ⌁
                  </button>
                )}
                {node.type === "agent" && (
                  <span className="rv-input-port" title="事件输入">
                    ⊞
                  </span>
                )}
              </article>
            );
          })}
        </div>
      </div>
      <header className="rv-project-header">
        <a className="rv-project-mark" href="/apps/research-v2/open" aria-label="返回科研项目">∞</a>
        <div><strong>{projectTitle}</strong><small>自动科研 · {nodes.length} 个节点</small></div>
        <div className="rv-header-actions">
          <button ref={navigationButton} className="rv-nav-mobile-toggle" aria-label="打开研究导航" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(!navigationOpen)}>☰ 导航</button>
          <span className={`rv-connection ${status.ready ? "ready" : ""}`}>{!layoutState.ready ? "载入布局…" : layoutState.error ? "保存待核对" : layoutState.pending ? "保存中 · 可继续操作" : status.ready ? "已保存" : "连接中"}</span>
          <button className="rv-primary" disabled={!editable} onClick={() => setMenu(menu === "create" ? null : "create")}>＋ 新建</button>
        </div>
      </header>
      <aside className="rv-workbench" hidden={!workbench} aria-label="科研协作工作台">
        <header><strong>{workbench === "sources" ? "讨论来源" : workbench === "assets" ? "资源材料" : "Agent 与审查"}</strong><button aria-label="收起工作台" onClick={() => setWorkbench("")}>×</button></header>
        <div hidden={workbench !== "sources"}>{visitedPanels.has("sources") && <SourcePanel nodes={nodes} runs={graph.runs} call={call} epoch={dataEpoch} open={open} reveal={id => { const node = byId.get(id); if (node) reveal(node); }} />}</div>
        <div hidden={workbench !== "workflow"}>{visitedPanels.has("workflow") && <WorkflowPanel key={`${boot.project}:${boot.viewer}`} project={boot.project} viewer={boot.viewer} nodes={nodes} selected={[...selectedIds]} call={call} epoch={dataEpoch} editable={editable} runnable={runnable} openNode={open} openFile={(agent, path) => openFile(path, agent)} workflow={workflow} intent={workflowIntent} />}</div>
        <div hidden={workbench !== "assets"}>{visitedPanels.has("assets") && <AssetPanel nodes={nodes} call={call} open={open} editable={editable} owner={boot.role === "owner"} />}</div>
      </aside>
      <ResearchSidebar storageKey={`${key}:navigation`} projectTitle={projectTitle} nodes={nodes} agents={workflow.page?.agents ?? []}
        runs={navigationRuns} scope={scope} selected={selected} loading={loading}
        collapsed={navigationCollapsed} narrow={navigationNarrow} mobileOpen={navigationOpen} searchRequest={searchRequest}
        panel={workbench} pendingFlags={workflow.page?.flags.filter(flag => flag.state === "open").length ?? 0}
        pendingProposals={graph.proposals.filter(proposal => proposal.state === "pending").length} runnable={runnable}
        onCollapse={setNavigationCollapsed} onMobileClose={closeNavigation} onSearch={searchNavigation}
        onNavigate={next => { setWorkbench(""); navigate(next); }} onOpen={node => { setWorkbench(""); reveal(node); }} onLocate={node => { setWorkbench(""); focus(node); setPendingLocate(node.id); }}
        onAgent={node => { if (byId.has(node.id) && !workflow.page?.runs.some(run => run.node === node.id)) { setWorkbench(""); reveal(node); return; } showWorkbench("workflow"); setWorkflowIntent(previous => ({ agent: node.id, request: (previous?.request ?? 0) + 1 })); }}
        onPanel={showWorkbench} onHistory={() => setMenu("history")} onOrganize={() => setOrganizing(true)} />
      <section ref={scopeHeader} className="rv-scope-header">
        <nav className="rv-breadcrumbs" aria-label="研究层级">
          <button onClick={() => navigate("")}>项目总览</button>{scope && hierarchy.trail(scope).map((node) => <span key={node.id}> / <button aria-current={node.id === scope ? "page" : undefined} onClick={() => navigate(node.id)}>{node.title}</button></span>)}
        </nav>
        <div className="rv-scope-title"><div><h1>{scope ? scopeNode?.title ?? "目录暂不可用" : "研究全景"}</h1><p>{scope ? scopeNode?.summary || "从属内容与外部引用 · 从引用可回到原节点。" : "展开子节点查看全景，进入子图聚焦一个目标。"}</p></div><span>{scopedNodes.length} 项</span></div>
        <div className="rv-view-toolbar">
          <div className="rv-segment" aria-label="画布操作"><button aria-pressed={interactionMode === "pan"} onClick={() => { setInteractionMode("pan"); setSelectedIds(new Set()); }}>拖动画布</button><button aria-pressed={interactionMode === "select"} onClick={() => { setInteractionMode("select"); setEditing(""); }} title="拖出选框多选；Shift 可随时框选或追加选择">框选节点</button></div>
          <span role="status">{selectedIds.size > 1 ? `已选 ${selectedIds.size} 项 · 拖动顶部一起移动` : interactionMode === "select" ? "空白处拖出选框 · Shift 追加选择" : "Shift + 拖动可框选"}</span>
          <div className="rv-segment" aria-label="排版命令"><button disabled={!editable || !layoutState.ready} title="重新排列当前从属节点，保留卡片尺寸" onClick={() => void layout.arrange("tree", tree.nodes.map(node => node.id), true)}>横向排列</button><button disabled={!editable || !layoutState.ready} title="重新紧凑排列当前从属节点" onClick={() => void layout.arrange("compact", tree.nodes.map(node => node.id), true)}>紧凑排列</button></div>
          <button disabled={!layoutState.ready} onClick={() => void expandAll()}>全展开并排列</button><button onClick={() => setExpanded(Object.fromEntries(nodes.map(node => [node.id, false])))}>全部收起</button>
          <button disabled={!layoutState.undo} onClick={() => void layout.undo()}>撤销布局</button><button onClick={fit} aria-label="适应当前层">适应当前层</button>
          {editable && <button onClick={() => { setPasteText(""); setError(""); }}>粘贴节点引用</button>}
          {(hiddenReferences[scope]?.length ?? 0) > 0 && <button onClick={() => setHiddenReferences(previous => ({ ...previous, [scope]: [] }))}>显示隐藏引用</button>}
          <label>关系<select aria-label="关系显示" value={relations} onChange={event => { setSelectedEdge(""); setRelations(event.target.value as typeof relations); }}><option value="none">隐藏连线</option><option value="selected">选中节点</option><option value="scope">当前关系</option><option value="all">全部关系</option></select></label>
          {scope && <button onClick={() => navigate((hierarchy.parents.get(scope) ?? [])[0] ?? "")}>↑ 返回上层</button>}
        </div>
      </section>

      {(selectedEdge || edgeOperation) && <aside className="rv-edge-selection" aria-label="选中关系">
        <header><strong>{selectedEdgeRecord ? `${byId.get(selectedEdgeRecord.source)?.title ?? selectedEdgeRecord.source} → ${byId.get(selectedEdgeRecord.target)?.title ?? selectedEdgeRecord.target}` : selectedEdge ? "所选关系暂不可用" : "关系删除状态"}</strong><button aria-label="取消关系选择" onClick={() => setSelectedEdge("")}>×</button></header>
        {selectedEdgeRecord && <span>{selectedEdgeRecord.label === "contains" ? "包含" : selectedEdgeRecord.label === "references" ? "引用" : selectedEdgeRecord.label}</span>}
        {edgeOperation && <p role={edgeOperation.phase === "refused" || edgeOperation.phase === "unknown" ? "alert" : "status"}>{edgeOperation.message}</p>}
        {selectedEdge && !selectedBusinessEdge && edgeOperation?.phase !== "confirmed" && <p>关系当前未显示，请先在图中重新选择。</p>}
        {selectedBusinessEdge && <button className="rv-delete-edge" disabled={!canArchiveEdge} onClick={() => void archiveSelectedEdge()}>删除关系</button>}
        {selectedBusinessEdge && !editable && <small>只读，不能删除关系</small>}
        {canArchiveEdge && !edgeOperation && !compact && <small>Backspace / Delete 删除 · Esc 取消</small>}
        {edgeOperation?.phase === "unknown" && <button disabled={!editable || selectedBusinessEdge?.id !== edgeOperation.params.edge} onClick={() => void archiveSelectedEdge(true)}>核对原删除请求</button>}
        {edgeOperation && edgeOperation.params.edge !== selectedEdge && displayedEdges.some(edge => edge.id === edgeOperation.params.edge) && <button onClick={() => selectEdge(edgeOperation.params.edge!)}>选择待确认关系</button>}
        {edgeOperation && edgeOperation.phase !== "pending" && <button onClick={() => void refresh()}>刷新关系</button>}
      </aside>}
      {scope && !scopedNodes.length && !loading && <div className="rv-empty"><h2>{scopeNode ? "这个目录还没有内容" : "此目录当前不可用"}</h2><p>{scopeNode ? "添加事项或在目录详情中收纳已有材料。" : "保留你的浏览位置；可返回上层继续查看。"}</p><button onClick={() => scopeNode ? open(scopeNode.id) : navigate("")}>{scopeNode ? "管理目录" : "返回项目总览"}</button></div>}
      {!workbench && !expandedNodeIds.has(previewNode || selected) && (previewNode || selected && editing !== selected && relations !== "none") && <aside className="rv-related" aria-label="选中节点的关系"><header><strong>{byId.get(previewNode || selected)?.title} · 一跳邻居</strong><button aria-label="关闭邻居预览" onClick={() => { setPreviewNode(""); setSelected(""); }}>×</button></header>{oneHopNeighbors(nodes, graph.edges, previewNode || selected).map(({ edge, node, direction }) => <button key={edge.id} onClick={() => reveal(node)}><small>{direction === "in" ? "入边 ←" : "出边 →"} {edge.label === "references" ? "引用" : edge.label} · {cardKinds[cardKind(node)] ?? pluginFor(node.type).title}{scopeIds.has(node.id) ? "" : " · 其他子图"}</small><span>{node.title} ↗</span></button>)}{!oneHopNeighbors(nodes, graph.edges, previewNode || selected).length && <p>暂时没有一跳关系</p>}</aside>}
      {notice && <div className="rv-notice" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
      {!nodes.length && !loading && !error && (
        <div className="rv-empty">
          <span>✳</span>
          <h2>把研究的第一条线索放在这里</h2>
          <p>从一张便签、一份文件，或一个 Agent 开始。</p>
          <button
            className="rv-primary"
            disabled={!editable}
            onClick={() => setMenu("create")}
          >
            新建节点
          </button>
        </div>
      )}
      {(loading || !layoutState.ready && !layoutState.error) && <div className="rv-notice">正在读取项目…</div>}
      {layoutState.notice && <div className="rv-notice">{layoutState.notice}</div>}
      {(error || layoutState.error) && (
        <div role="alert" className="rv-notice error">
          <span>{error || layoutState.error}</span>
          <button
            onClick={() => {
              setError("");
              void refresh();
              void layout.sync(true);
            }}
          >
            重试
          </button>
          {layoutState.error && <button onClick={() => layout.discardLayout()}>放弃未确认布局</button>}
          <button aria-label="关闭提示" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      <div className="rv-bottom">
        <span>单击 Agent 聊天 · 拖动标题移动 · Shift 框选 · 右下角调整大小</span>
        <span role="status">{!layoutState.ready ? "正在载入布局…" : layoutState.error ? "本地调整待核对" : layoutState.pending ? `正在保存 ${layoutState.queued ?? 1} 个布局操作 · 可继续拖动` : "布局已保存 · 个人浏览位置"}</span>
      </div>
      <div className="rv-zoom">
        <button
          aria-label="缩小画布"
          onClick={() =>
            setCamera(previous => zoomCameraAt(previous, previous.zoom - 0.1, { x: scopeArea.left + scopeArea.width / 2, y: scopeArea.top + scopeArea.height / 2 }))
          }
        >
          −
        </button>
        <span>{Math.round(camera.zoom * 100)}%</span>
        <button
          aria-label="放大画布"
          onClick={() =>
            setCamera(previous => zoomCameraAt(previous, previous.zoom + 0.1, { x: scopeArea.left + scopeArea.width / 2, y: scopeArea.top + scopeArea.height / 2 }))
          }
        >
          ＋
        </button>
      </div>
      {referenceNode && scopeNode && byId.has(referenceNode) && <ReferenceDialog node={byId.get(referenceNode)!} scope={scopeNode} call={call} close={() => setReferenceNode("")} changed={() => { setHiddenReferences(previous => ({ ...previous, [scope]: (previous[scope] ?? []).filter(id => id !== referenceNode) })); void refresh(); }} />}
      {pasteText !== null && <Dialog title="粘贴节点引用" close={() => setPasteText(null)}><form className="rv-dialog small" onSubmit={event => { event.preventDefault(); acceptReference(pasteText); }}><h2>粘贴节点引用</h2><label>节点地址<input autoFocus aria-label="节点引用地址" value={pasteText} onChange={event => setPasteText(event.target.value)} /></label><p>先在卡片上复制节点引用，再进入目标子图粘贴。</p><button className="rv-primary">引入引用</button><button type="button" onClick={() => setPasteText(null)}>取消</button></form></Dialog>}
      {nodeArchive.state && !deleteNode && <aside className="rv-operation-status" role="status">{nodeArchive.state.message}{nodeArchive.state.phase === "unknown" && <button onClick={() => setDeleteNode(nodeArchive.state!.params.node!)}>核对删除结果</button>}{nodeArchive.state.phase === "confirmed" && <button onClick={() => void refresh()}>刷新图谱</button>}</aside>}
      {deleteNode && byId.has(deleteNode) && <Dialog title="删除节点" close={() => setDeleteNode("")}><section className="rv-dialog small"><h2>从图中删除「{byId.get(deleteNode)!.title}」？</h2><p>所有子图中的引用将不可用。正文文件和已有会话仍保留；如果只想移走当前引用，请使用“移除此处引用”。</p>{nodeArchive.state && <p role="status">{nodeArchive.state.message}</p>}<button disabled={deleting} onClick={async () => { setDeleting(true); const node = byId.get(deleteNode)!; const confirmed = await (nodeArchive.state?.phase === "unknown" ? nodeArchive.retry() : nodeArchive.start(node, node.snapshot)); if (mounted.current) { setDeleting(false); if (confirmed) { setDeleteNode(""); setEditing(""); void refresh(); } } }}>{deleting ? "正在删除…" : nodeArchive.state?.phase === "unknown" ? "核对原删除请求" : "确认删除节点"}</button><button disabled={deleting} onClick={() => setDeleteNode("")}>取消</button></section></Dialog>}
      {menu && (
        <div className="rv-popover">
          <header>
            <h2>
              {menu === "create" ? "新建一个节点" : "决策与提案"}
            </h2>
            <button aria-label="关闭菜单" onClick={() => setMenu(null)}>
              ×
            </button>
          </header>
          {menu === "create" && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (creationRunning.current) return;
                creationRunning.current = true; setCreating(true); setCreationError("");
                try {
                  if (!creationRequest.current) {
                    const initialData = newType === "folder" ? { members: [] } : newType === "review" ? { targets: {} } : newType === "goal" ? { text: title.trim() } : {};
                    const selectedParent = selected ? byId.get(selected) : undefined;
                    const parent = newType === "goal" && !newRole ? undefined : scopeNode ?? (selectedParent && researchRole(selectedParent) ? selectedParent : goals[0]);
                    saveCreation({
                      request: requestId(),
                      data: {
                        type: newType, title: title.trim() || `新的${pluginFor(newType).title}`,
                        x: (viewport.width / 2 - camera.x) / camera.zoom,
                        y: (viewport.height / 2 - camera.y) / camera.zoom,
                        summary: newSummary.trim(),
                        ...(parent ? { parent: { id: parent.id, label: newRole === "target" && parent.type === "goal" ? "decomposes" : "contains" } } : {}),
                        data: { ...initialData, ...(newRole ? { meta: { researchRole: newRole, ...(newRole === "target" && successCriteria.trim() ? { successCriteria: successCriteria.trim() } : {}) } } : {}) },
                      },
                      ...(parent ? { parent: { id: parent.id, label: newRole === "target" && parent.type === "goal" ? "decomposes" : "contains", request: requestId() } } : {}),
                    });
                  }
                  const pending = creationRequest.current!;
                  const id = await resumeNodeCreation(call, pending, saveCreation, receipt => { if (mounted.current) setCreationReceipts(previous => [...previous.filter(item => item.node.id !== receipt.node.id), receipt]); });
                  if (!mounted.current) return;
                  if (pending.parent) setExpanded(current => ({ ...current, [pending.parent!.id]: true }));
                  saveCreation(undefined); setMenu(null);
                  setTitle(""); setNewSummary(""); setSuccessCriteria("");
                  setSelected(id); setSelectedIds(new Set([id]));
                  // A read failure after completion retries only the read, never node_add.
                  void refresh();
                } catch (reason) {
                  if (mounted.current) setCreationError(`${creationRequest.current?.node ? "节点已创建，连接尚未确认；重试只补连接。" : "创建结果尚未确认；重试会沿用原请求。"} ${String(reason)}`);
                } finally {
                  creationRunning.current = false;
                  if (mounted.current) setCreating(false);
                }
              }}
            >
              {creation && <p role="status">{creation.node ? `已创建「${creation.data.title}」，正在确认归属；再次提交只完成连接。` : `正在确认「${creation.data.title}」的创建结果；可关闭菜单，稍后继续。`}</p>}
              {creationError && <p role="alert">{creationError}</p>}
              <fieldset disabled={creating || !!creation} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
              <div className="rv-type-grid">
                <button type="button" className={newRole === "target" ? "active" : ""} onClick={() => { setNewType("goal"); setNewRole("target"); }}><span>◎</span>TARGET · 具体目标</button>
                <button type="button" className={newRole === "motivation" ? "active" : ""} onClick={() => { setNewType("note"); setNewRole("motivation"); }}><span>▱</span>动机便签</button>
                {nodeTypes.filter((plugin) => plugin.type !== "adapter").map((plugin) => (
                  <button
                    type="button"
                    key={plugin.type}
                    className={!newRole && newType === plugin.type ? "active" : ""}
                    onClick={() => { setNewType(plugin.type); setNewRole(null); }}
                  >
                    <span>{plugin.icon}</span>
                    {plugin.title}
                  </button>
                ))}
              </div>
              <label>
                标题
                <input
                  aria-label="节点标题"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={newType === "task" ? "对象 + 操作，例如 ACC 第3轮：验证长事务回退" : newType === "finding" ? "对象 + 核心结论，例如 ACC 第3轮：长事务未发生覆盖" : "对象 + 要做什么，例如 ACC：验证并发正确性"}
                  maxLength={200}
                />
              </label>
              <label>简短说明<textarea aria-label="节点简短说明" value={newSummary} onChange={event => setNewSummary(event.target.value)} placeholder={newRole === "motivation" ? "为什么值得做；完整讨论可在详情中补充" : "要得到什么结果，或这份内容为什么重要"} maxLength={1000} /></label>
              {newRole === "target" && <label>完成依据<input aria-label="目标完成依据" value={successCriteria} onChange={event => setSuccessCriteria(event.target.value)} placeholder="需要哪些证明、实验或产物；也可以暂留待明确" maxLength={600} /></label>}
              </fieldset>
              <button className="rv-primary" disabled={!editable || creating}>
                {creating ? creation?.node ? "正在连接…" : "创建中…" : creation ? creation.node ? "重试连接" : "重试确认创建" : "放到画布"}
              </button>
              {creation?.node && creationError && !creating && <button type="button" onClick={() => {
                const id = creation.node!;
                saveCreation(undefined); setCreationError(""); setMenu(null);
                setTitle(""); setNewSummary(""); setSuccessCriteria("");
                setSelected(id); setSelectedIds(new Set([id])); void refresh();
              }}>保留节点，结束本次重试</button>}
            </form>
          )}
          {menu === "history" && (
            <div className="rv-history">
              {graph.proposals
                .filter((proposal) => proposal.state === "pending")
                .map((proposal) => (
                  <article key={proposal.id}>
                    <b>{proposal.reason}</b>
                    <pre>{JSON.stringify(proposal.params, null, 2)}</pre>
                    <small>
                      {proposal.created.owner} ·{" "}
                      {proposal.created.model ?? "模型未知"}
                    </small>
                    <div className="rv-inline">
                      <button
                        disabled={!editable}
                        onClick={() =>
                          void mutate("proposal_resolve", {
                            proposal: proposal.id,
                            version: proposal.version,
                            decision: "reject",
                          })
                        }
                      >
                        拒绝
                      </button>
                      <button
                        disabled={!editable}
                        onClick={() =>
                          void mutate("proposal_resolve", {
                            proposal: proposal.id,
                            version: proposal.version,
                            decision: "approve",
                          })
                        }
                      >
                        确认修改
                      </button>
                    </div>
                  </article>
                ))}
              {graph.runs
                .slice()
                .reverse()
                .map((run) => (
                  <article key={run.id}>
                    <b>
                      {byId.get(run.node)?.title ?? run.node} · {run.status}
                    </b>
                    <p>{run.prompt.slice(0, 160)}</p>
                    <small>
                      归属 {run.binding.owner} · 触发 {run.trigger} ·{" "}
                      {run.model ?? "模型未知"}
                    </small>
                  </article>
                ))}
            </div>
          )}
        </div>
      )}
      {windows.filter(window=>!window.closed).map((window) => {
        const original = byId.get(window.node);
        if (!original) return null;
        const node = window.filePath
          ? {
              ...original,
              type: "file" as const,
              title: window.filePath.split("/").at(-1) || window.filePath,
            }
          : original;
        const plugin = pluginFor(node.type);
        return (
          <WindowFrame
            key={window.id}
            window={window}
            title={node.title}
            icon={plugin.icon}
            viewport={viewport}
            compact={compact}
            hidden={!windowInScope(window) || compact && frontWindow?.id !== window.id}
            canvasZoom={camera.zoom}
            screenPosition={window.worldX !== undefined && window.worldY !== undefined ? { x: window.worldX * camera.zoom + camera.x, y: window.worldY * camera.zoom + camera.y } : undefined}
            change={(patch) =>
              setWindows((previous) =>
                previous.map((item) => {
                  if (item.id !== window.id) return item;
                  const next = { ...item, ...patch };
                  if (patch.x !== undefined && patch.y !== undefined && item.worldX !== undefined && item.worldY !== undefined) {
                    next.worldX = (patch.x - camera.x) / camera.zoom;
                    next.worldY = (patch.y - camera.y) / camera.zoom;
                  }
                  return next;
                }),
              )
            }
            close={() => {
              setWindows(previous => previous.map(item => item.id === window.id ? { ...item, closed: true } : item));
              if (readResearchLocation(globalThis.window.location.href).node === window.node) {
                const remaining = windows.filter(item => item.id !== window.id && !item.closed && !item.minimized && windowInScope(item)).sort((a, b) => b.z - a.z)[0];
                writeLocation(scope, compact ? remaining?.node ?? "" : "");
              }
            }}
          >
            <NodeWindow
              node={node}
              original={original}
              window={window}
              nodes={nodes}
              boot={boot}
              call={call}
              documentFor={documentFor}
              audioFor={audioFor}
              editable={editable}
              runnable={runnable}
              storageKey={key}
              open={open}
              openFile={(path) => openFile(path, node.id)}
              mutate={mutate}
            />
          </WindowFrame>
        );
      })}
      <div className="rv-window-dock">
        {windows
          .filter((window) => window.minimized && !window.closed && windowInScope(window))
          .map((window) => (
            <button
              key={window.id}
              onClick={() =>
                setWindows((previous) =>
                  previous.map((item) =>
                    item.id === window.id
                      ? {
                          ...item,
                          minimized: false,
                          z: Math.max(...previous.map((item) => item.z)) + 1,
                        }
                      : item,
                  ),
                )
              }
            >
              {byId.get(window.node)?.title ?? "工作窗"} ↗
            </button>
          ))}
      </div>
      {relation && (
        <Dialog title="建立关系" close={() => setRelation(null)}>
          <form
            className="rv-dialog small"
            onSubmit={async (event) => {
              event.preventDefault();
              if (relationPending) return;
              setRelationPending(true);
              relationRequest.current ??= { request: requestId(), source: relation.source, target: relation.target, label };
              const result = await mutate("edge_add", relationRequest.current) as { edge?: ResearchEdge } | null;
              if (!mounted.current) return;
              if (result?.edge) {
                const routed = await layout.routeEdge(result.edge.id, relation.ports);
                if (!routed) setError("关系已建立，连线方位尚未确认；可在布局提示中重试。");
                setRelation(null); relationRequest.current = null;
              }
              setRelationPending(false);
            }}
          >
            <header>
              <h2>这两条线索有什么关系？</h2>
              <button type="button" onClick={() => setRelation(null)}>
                ×
              </button>
            </header>
            <input
              aria-label="关系标签"
              disabled={relationPending || !!relationRequest.current}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={120}
            />
            <div className="rv-inline">
              {["支持", "反对", "佐证", "产物", "回应", "前置"].map((value) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => setLabel(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <button className="rv-primary" disabled={relationPending}>{relationPending ? "正在建立…" : relationRequest.current ? "重试建立关系" : "建立关系"}</button>
          </form>
        </Dialog>
      )}
      {organizing&&<OrganizeDialog agents={nodes.filter(node=>node.type==='agent')} call={call} close={()=>setOrganizing(false)} open={open}/>}
      {subscription &&
        byId.has(subscription.source) &&
        byId.has(subscription.target) && (
          <SubscriptionEditor
            source={byId.get(subscription.source)!}
            target={byId.get(subscription.target)!}
            previous={subscription.previous}
            call={call}
            close={() => setSubscription(null)}
          />
        )}
    </div>
  );
}
