import { dateLocale } from "../lib/format.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, localizedLabels } from "../i18n/ui-text.js";
import { UiButton, UiTabs } from "../ui-kit/primitives.js";
/**
 * `/architecture` — a read-only atlas of this repository's own architecture.
 *
 * ── What this page is ───────────────────────────────────────────────────────
 *
 * The server generates an architecture snapshot (modules, zones, dependencies,
 * flows, constraints, TCB budget) with its own analysis job; this page renders
 * that snapshot from seven angles — 审阅 / 总览 / 模组 / 依赖 / 权限 / 流程 /
 * 演进 — plus a
 * persistent profile rail on the right. It computes layout, never facts: every
 * verdict (constraint pass/fail, violations, TCB overrun) is the server's.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *
 *  · `GET /api/architecture` is a plain server-local read (REPLAY_SAFE), so it
 *    may poll — through `pollInterval()` only.
 *  · The refresh mutation is never retried and is disabled while a job runs.
 *  · Both sides of this contract are developed in parallel, so every render is
 *    defensive: a missing array is empty, a missing optional is not rendered.
 *
 * The response types are declared in place (AppsPage precedent) — they are this
 * page's reading of the wire, not a shared contract module.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../lib/api.js";
import { pollInterval } from "../lib/query.js";
import { ErrorBox, Loading, StaleDataBanner, Status, useNow } from "../ui/misc.js";
import styles from "./ArchitecturePage.module.css";
import { ReviewView } from "./architecture/ReviewView.js";
import { OverviewView } from "./architecture/OverviewView.js";
import { DependencyView } from "./architecture/DependencyView.js";
import { PermissionsView } from "./architecture/PermissionsView.js";
import { FlowsView } from "./architecture/FlowsView.js";
import { EvolutionView } from "./architecture/EvolutionView.js";
import { ModuleEcosystemView } from "./architecture/ModuleEcosystemView.js";
import { MetaCard, ModuleCard, StepCard } from "./architecture/ModuleCard.js";
import { emptyView } from "./architecture/model.js";

// ── Wire types (kept in step with the server's /api/architecture) ───────────

export interface ArchSource {
  path: string;
  line: number;
}

export interface ArchZone {
  id: string;
  label: string;
  trust: string;
  color: string;
  description?: string;
}

export interface ArchModule {
  id: string;
  label: string;
  description: string;
  zone: string;
  criticality: string;
  tags: string[];
  docs: string[];
  files: number;
  codeLoc: number;
  testFiles: number;
  gitTouches: number;
  runtimeFanIn: number;
  runtimeFanOut: number;
  typeOnlyFanIn: number;
  typeOnlyFanOut: number;
  /** Runtime-only compatibility aliases from the server DTO. */
  fanIn: number;
  fanOut: number;
  annotations: number;
}

export interface ArchDependency {
  from: string;
  to: string;
  runtimeCount: number;
  typeOnlyCount: number;
  testCount: number;
  dynamicCount: number;
  circular: boolean;
  samples: Array<{ path: string; line: number; specifier: string }>;
}

export interface ArchFrontendModule {
  id: string;
  title: string;
  version: string;
  implementation: string;
  packageId: string;
  packagePath: string;
  slots: string[];
  ports: Array<{ id: string; packageId?: string }>;
  opens: string[];
  summary: string;
  preview: "search" | "tree" | "chat" | "document" | "form" | "board" | "slides" | "detail" | "status" | "panel";
  configKeys: string[];
  source: ArchSource;
}

export interface ArchModuleContract {
  id: string;
  packageId?: string;
  packagePath?: string;
  summary: string;
  actions: Array<{ id: string; summary: string; operation?: string }>;
  source?: ArchSource;
  provision: "trusted-provider" | "app-or-host";
}

export interface ArchBackendModule {
  id: string;
  name: string;
  summary: string;
  packageId: string;
  path: string;
  files: number;
  loc: number;
  kind: "provider";
  contracts: string[];
  actions: Array<{ id: string; summary: string; operation?: string }>;
  registered: boolean;
  dependencies: string[];
  source: ArchSource;
}

export interface ArchModuleEcosystem {
  frontend: ArchFrontendModule[];
  contracts: ArchModuleContract[];
  backend: ArchBackendModule[];
  dependencies: Array<{
    from: string;
    to: string;
    kind: "requires" | "provides" | "provider";
    label: string;
  }>;
  issues: Array<{ message: string; source?: ArchSource }>;
}

export interface ArchFlowStep {
  id: string;
  label: string;
  description?: string;
  zone: string;
  after: string[];
  role?: string;
  condition?: string;
  outcome?: string;
  authority?: string;
  terminal?: boolean;
  source?: ArchSource;
}

export interface ArchFlow {
  id: string;
  title: string;
  description: string;
  perspective: string;
  coverage?: { mode: string; scope: string; exclusions: string[] };
  steps: ArchFlowStep[];
}

export interface ArchConstraint {
  id: string;
  title: string;
  description: string;
  concern: string;
  severity: string;
  status: string;
  mechanismKind: string | null;
  summary?: string;
  violations: Array<{ message: string; source?: ArchSource }>;
  evidence: Array<{ grade: string; label: string; source?: ArchSource }>;
}

export interface ArchFinding {
  signal: string;
  severity: string;
  message: string;
  moduleIds: string[];
  source?: ArchSource;
}

export interface ArchTcb {
  label: string;
  lines: number;
  baseline: number;
  tolerance: number;
  files: Array<{ path: string; loc: number }>;
  unregistered: string[];
  stale: string[];
}

export interface ArchHotspot {
  moduleId: string;
  path: string;
  codeLoc: number;
  touches: number;
  score: number;
}

export interface ArchitectureView {
  meta: {
    commit: string;
    branch: string;
    dirty: boolean;
    generatedAt: string;
    totals: { files: number; codeLoc: number; symbols: number; calls: number; annotations: number };
  };
  zones: ArchZone[];
  modules: ArchModule[];
  dependencies: ArchDependency[];
  moduleEcosystem: ArchModuleEcosystem;
  flows: ArchFlow[];
  constraints: ArchConstraint[];
  findings: ArchFinding[];
  tcb: ArchTcb | null;
  hotspots: ArchHotspot[];
}

export interface ArchitectureApiResponse {
  generated: boolean;
  job:
    | { running_since: string }
    | { done: true; finished_at: string; ok: boolean; error?: string }
    | null;
  snapshot?: ArchitectureView;
}

// ── Page ────────────────────────────────────────────────────────────────────

const ARCH_PATH = "/api/architecture";

type ViewId = "review" | "overview" | "modules" | "deps" | "perms" | "flows" | "evolution";

const TABS = localizedLabels((): Array<{ id: ViewId; label: string }> => ([
  { id: "review", label: uiText("审阅") },
  { id: "overview", label: uiText("总览") },
  { id: "modules", label: uiText("模组") },
  { id: "deps", label: uiText("依赖") },
  { id: "perms", label: uiText("权限") },
  { id: "flows", label: uiText("流程") },
  { id: "evolution", label: uiText("演进") },
]));

function runningSince(job: ArchitectureApiResponse["job"]): string | null {
  if (job && "running_since" in job) return job.running_since;
  return null;
}

function failedJob(job: ArchitectureApiResponse["job"]): string | null {
  if (job && "done" in job && job.done && !job.ok) return job.error || uiText("分析失败（服务端未给出原因）");
  return null;
}

function RefreshButton({
  job,
  onRefresh,
  busy,
}: {
  job: ArchitectureApiResponse["job"];
  onRefresh: () => void;
  busy: boolean;
}) {
  useDashboardLanguage();
  const since = runningSince(job);
  const now = useNow(since !== null);
  const elapsed = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
  return (
    <span className={styles.refresh}>
      <UiButton disabled={busy || since !== null} onClick={onRefresh}>
        {uiText("重新分析")}</UiButton>
      {since !== null && (
        <Status>
          {uiText("分析中…已 ")}{Number.isFinite(elapsed) ? elapsed : 0}s
        </Status>
      )}
    </span>
  );
}

export function ArchitecturePage() {
  useDashboardLanguage();
  const client = useQueryClient();
  // The architecture entry point answers the user's first question directly:
  // what the frontend looks like and what each trusted backend does. Review,
  // dependencies and flows remain one tab away.
  const [view, setView] = useState<ViewId>("modules");
  const [selectedModule, setSelectedModule] = useState<string | null>(null);
  const [depFocus, setDepFocus] = useState<string[]>([]);
  const [step, setStep] = useState<{ flow: string; step: string } | null>(null);
  const [refreshFailed, setRefreshFailed] = useState("");

  const query = useQuery<ArchitectureApiResponse>({
    queryKey: ["architecture"],
    queryFn: () => api<ArchitectureApiResponse>(ARCH_PATH),
    refetchInterval: pollInterval(ARCH_PATH, 15_000),
    refetchIntervalInBackground: false,
  });

  const refresh = useMutation({
    mutationFn: async () =>
      await api<Record<string, unknown>>("/api/architecture/refresh", { method: "POST", json: {} }),
    onSuccess: async () => {
      setRefreshFailed("");
      await client.invalidateQueries({ queryKey: ["architecture"] });
    },
    onError: (err) => setRefreshFailed(errorText(err)),
  });

  const data = query.data;
  const snap = useMemo(() => emptyView(data?.snapshot), [data?.snapshot]);

  // Cross-view intents. Selection survives view switches on purpose.
  const showInDeps = (ids: string[]) => {
    setDepFocus(ids);
    if (ids.length === 1) setSelectedModule(ids[0]);
    setView("deps");
  };
  const jumpToModule = (id: string) => {
    setSelectedModule(id);
    setView("overview");
  };

  if (query.isLoading) return <Loading what={uiText("读取架构快照…")} />;
  if (!data && query.error) {
    return (
      <div className={styles.page}>
        <ErrorBox>{errorText(query.error)}</ErrorBox>
      </div>
    );
  }
  if (!data) return <Loading what={uiText("读取架构快照…")} />;

  const jobError = failedJob(data.job);

  if (!data.generated) {
    return (
      <div className={styles.page}>
        <header className={styles.head}>
          <h2>{uiText("架构")}</h2>
          {query.error && (
            <StaleDataBanner
              message={errorText(query.error)}
              dataUpdatedAt={query.dataUpdatedAt}
            />
          )}
        </header>
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>{uiText("架构快照尚未生成")}</p>
          <p className={styles.muted}>{uiText("服务会为新的运行版本自动分析；也可以点「重新分析」立即重试。")}</p>
          <RefreshButton job={data.job} onRefresh={() => refresh.mutate()} busy={refresh.isPending} />
          {jobError && <ErrorBox>{uiText("上次分析失败：")}{jobError}</ErrorBox>}
          {refreshFailed && <ErrorBox>{refreshFailed}</ErrorBox>}
        </div>
      </div>
    );
  }

  const meta = snap.meta;
  const selected = selectedModule ? snap.modules.find((m) => m.id === selectedModule) ?? null : null;
  const currentFlow = step ? snap.flows.find((f) => f.id === step.flow) ?? null : null;
  const currentStep = currentFlow && step ? currentFlow.steps.find((s) => s.id === step.step) ?? null : null;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <h2>{uiText("架构")}</h2>
          {meta && (
            <span className={styles.metaChips}>
              <span className={styles.mono} title={meta.commit}>
                {String(meta.commit ?? "").slice(0, 8)}
              </span>
              {meta.branch && <span className={styles.chip}>{meta.branch}</span>}
              {meta.dirty && (
                <span className={styles.dirty} title={uiText("快照生成时工作树有未提交改动")}>
                  {uiText("未提交")}</span>
              )}
              <span className={styles.muted}>{formatWhen(meta.generatedAt)}</span>
            </span>
          )}
          <span className={styles.grow} />
          <RefreshButton job={data.job} onRefresh={() => refresh.mutate()} busy={refresh.isPending} />
        </div>
        {jobError && <ErrorBox>{uiText("上次分析失败：")}{jobError}</ErrorBox>}
        {refreshFailed && <ErrorBox>{refreshFailed}</ErrorBox>}
        {query.error && (
          <StaleDataBanner
            message={errorText(query.error)}
            dataUpdatedAt={query.dataUpdatedAt}
          />
        )}
        <UiTabs
          className={styles.tabs}
          aria-label={uiText("架构剖面")}
          activeKey={view}
          onChange={(key) => setView(key as ViewId)}
          items={TABS().map((tab) => ({ key: tab.id, label: tab.label, children: null }))}
        />
      </header>

      <div className={styles.body}>
        <main className={styles.main}>
          {view === "review" && (
            <ReviewView
              snap={snap}
              onShowInDeps={showInDeps}
              onJumpToModule={jumpToModule}
            />
          )}
          {view === "overview" && (
            <OverviewView snap={snap} selected={selectedModule} onSelectModule={setSelectedModule} />
          )}
          {view === "modules" && <ModuleEcosystemView ecosystem={snap.moduleEcosystem} />}
          {view === "deps" && (
            <DependencyView
              snap={snap}
              focus={depFocus}
              selected={selectedModule}
              onSelectModule={setSelectedModule}
            />
          )}
          {view === "perms" && <PermissionsView snap={snap} />}
          {view === "evolution" && <EvolutionView />}
          {view === "flows" && (
            <FlowsView
              snap={snap}
              selectedStep={step}
              onSelectStep={(flow, stepId) => setStep({ flow, step: stepId })}
            />
          )}
        </main>
        {view !== "modules" && (
          <aside className={styles.rail} aria-label={uiText("档案卡")}>
            {view === "flows" && currentStep && currentFlow ? (
              <StepCard flow={currentFlow} step={currentStep} onClose={() => setStep(null)} />
            ) : selected ? (
              <ModuleCard
                snap={snap}
                module={selected}
                onClose={() => setSelectedModule(null)}
              />
            ) : (
              <MetaCard snap={snap} />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function formatWhen(value: string | undefined): string {
  if (!value) return "";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString(dateLocale());
}
