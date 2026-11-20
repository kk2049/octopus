import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
/**
 * `/knowledge` — the development knowledge wiki.
 *
 * ── What this page is ───────────────────────────────────────────────────────
 *
 * A human-facing index over the derived knowledge graph the dev pipeline
 * builds (`packages/bot/src/knowledge`): capabilities → principles, mechanical
 * constraints, decisions, non-goals, recurrence patterns, recent landings and
 * the modules/code they point at — every statement with its source and
 * authority. The same graph the ticket agents read, seen from the human side,
 * plus the one thing only a human can add: a decision on a conflict candidate
 * or an ambiguous record (the 裁决队列).
 *
 * ── Views ───────────────────────────────────────────────────────────────────
 *
 *  `?v=home`                  capability index, review summary, recent landings
 *  `?v=capability&id=…`       one capability's reading list
 *  `?v=module&id=…`           one atlas module's reading list
 *  `?v=node&id=…`             one statement/node with its neighbourhood
 *  `?v=graph`                 all nodes and directed edges in one read-only map
 *  `?v=search&q=…`            statements, capabilities and modules for a query
 *  `?v=preview`               what a ticket agent would be handed for a text
 *  `?v=review`                conflicts, ambiguities, ADR lifecycle, coverage
 *  `?v=chat`                  personal knowledge conversations (not tickets)
 *
 * State lives in the URL on purpose: a capability, a statement or a conflict is
 * something people paste into a ticket or a chat. Selection therefore keys on
 * stable ids, never on list positions (frontend-stability.md).
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *
 *  · `GET /api/knowledge*` are plain server-local reads (REPLAY_SAFE), so they
 *    may be refetched; POSTs are never retried automatically. Knowledge Chat
 *    keeps one request id while a rejected create/send draft is unchanged.
 *  · Every statement is rendered as text. The preview pack is Markdown from
 *    the server and goes through the shared `Markdown` component only.
 */

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, errorText } from "../lib/api.js";
import { ErrorBox, Loading } from "../ui/misc.js";
import styles from "./KnowledgePage.module.css";
import { HomeView } from "./knowledge/HomeView.js";
import { CapabilityView } from "./knowledge/CapabilityView.js";
import { NodeView } from "./knowledge/NodeView.js";
import { GraphView } from "./knowledge/GraphView.js";
import { SearchView } from "./knowledge/SearchView.js";
import { PreviewView } from "./knowledge/PreviewView.js";
import { SourcesView, RepairsView } from "./knowledge/IterationViews.js";
import { ReviewView } from "./knowledge/ReviewView.js";
import { KnowledgeChatView } from "./knowledge/KnowledgeChatView.js";
import { ArtifactHealthPanel } from "./knowledge/ArtifactHealthPanel.js";
import type { WikiArtifactHealth, WikiOverview } from "./knowledge/types.js";

export const KNOWLEDGE_PATH = "/api/knowledge";
export const KNOWLEDGE_HEALTH_PATH = "/api/knowledge/health";

type ViewId = "sources" | "repairs" | "home" | "graph" | "capability" | "module" | "node" | "search" | "preview" | "review" | "chat";

function viewOf(value: string | null): ViewId {
  switch (value) {
    case "sources":
    case "repairs":
    case "graph":
    case "capability":
    case "module":
    case "node":
    case "search":
    case "preview":
    case "review":
    case "chat":
      return value;
    default:
      return "home";
  }
}

export function KnowledgePage() {
  useDashboardLanguage();
  const [params, setParams] = useSearchParams();
  const view = viewOf(params.get("v"));
  const id = params.get("id") ?? "";
  const q = params.get("q") ?? "";

  const overview = useQuery<WikiOverview>({
    queryKey: ["knowledge", "overview"],
    queryFn: () => api<WikiOverview>(KNOWLEDGE_PATH),
  });
  const health = useQuery<WikiArtifactHealth>({
    queryKey: ["knowledge", "artifact-health"],
    queryFn: () => api<WikiArtifactHealth>(KNOWLEDGE_HEALTH_PATH),
    enabled: view === "home",
  });
  const reviewOpen = useMemo(() => {
    const review = overview.data?.review;
    if (!review) return 0;
    return review.conflictsOpen + review.ambiguous;
  }, [overview.data]);

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("q");
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return;
    setParams({ v: "search", q: text });
  };

  if (overview.isLoading) return <Loading what={uiText("读取知识图谱…")} />;
  if (!overview.data && overview.error) {
    return (
      <div className={styles.page}>
        <ErrorBox>{errorText(overview.error)}</ErrorBox>
      </div>
    );
  }
  const data = overview.data;
  if (!data) return <Loading what={uiText("读取知识图谱…")} />;

  const nav = (target: ViewId, label: string, badge?: number) => (
    <Link key={target} to={`/knowledge?v=${target}`} className={view === target ? styles.subnavOn : undefined} aria-current={view === target ? "page" : undefined}>
      {label}
      {badge ? <span className={styles.badge}>{badge}</span> : null}
    </Link>
  );

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h2>{uiText("知识库")}</h2>
        {data.generated && data.meta ? (
          <div className={styles.metaChips}>
            <span title={data.meta.commit}>{uiText("图 @ ")}{data.meta.commit.slice(0, 10)}</span>
            <span>{data.meta.nodes} {uiText(" 节点 · ")}{data.meta.edges} {uiText(" 边")}</span>
            <span>{uiText("构建于 ")}{data.meta.built_at.slice(0, 16).replace("T", " ")}</span>
          </div>
        ) : (
          <span className={styles.metaChips}>
            <span>{uiText("知识图谱尚未构建：开发流水线会在启动与每次落地后生成它")}</span>
          </span>
        )}
        <form className={styles.searchForm} role="search" onSubmit={submitSearch}>
          <input className={styles.searchInput} name="q" type="search" defaultValue={q} placeholder={uiText("搜原则、决策、需求、非目标…")} aria-label={uiText("搜索知识库")} />
          <button type="submit" className={styles.filterOn}>
            {uiText("搜索")}</button>
        </form>
      </header>
      <nav className={styles.subnav} aria-label={uiText("知识库视图")}>
        {nav("home", uiText("索引"))}
        {nav("chat", uiText("知识 Chat"))}
        {nav("graph", uiText("关系图"))}
        {nav("review", uiText("需要裁决"), reviewOpen)}
        {nav("repairs", uiText("内容纠错"))}
        {nav("sources", uiText("我的知识来源"))}
        {nav("preview", uiText("试算启动包"))}
      </nav>
      {view === "home" ? (
        <ArtifactHealthPanel
          health={health.data}
          loading={health.isLoading}
          error={health.error ? errorText(health.error) : null}
          refreshing={health.isFetching}
          onRefresh={() => { void health.refetch(); }}
        />
      ) : null}
      {view === "home" && <HomeView overview={data} />}
      {view === "graph" && <GraphView />}
      {view === "capability" && <CapabilityView kind="capability" id={id} />}
      {view === "module" && <CapabilityView kind="module" id={id} />}
      {view === "node" && <NodeView id={id} />}
      {view === "search" && <SearchView query={q} />}
      {view === "preview" && <PreviewView />}
      {view === "review" && <ReviewView overview={data} />}
      {view === "sources" && <SourcesView />}
      {view === "repairs" && <RepairsView />}
      {view === "chat" && <KnowledgeChatView />}
    </div>
  );
}
