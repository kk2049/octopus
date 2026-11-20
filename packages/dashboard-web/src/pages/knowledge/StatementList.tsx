import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { actorKindHint, actorKindLabel } from "../../lib/actor-kind.js";
/**
 * The one way a statement is drawn anywhere on the wiki: kind / authority /
 * certainty / status chips, the statement text, its source, and a link to the
 * node view. Lists are filterable client-side; the server already ordered by
 * authority and recency.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { UiTag } from "../../ui-kit/primitives.js";
import styles from "../KnowledgePage.module.css";
import { StrengthTag } from "./EvidenceDetails.js";
import {
  AUTHORITY_LABEL,
  KIND_LABEL,
  STATUS_LABEL,
  shortSource,
  viewForId,
  type WikiStatement,
} from "./types.js";

export function wikiHref(id: string): string {
  const target = viewForId(id);
  return `/knowledge?v=${target.v}&id=${encodeURIComponent(target.id)}`;
}

export function KindTag({ kind }: { kind: string }) {
  useDashboardLanguage();
  const tone = kind === "principle" || kind === "constraint" ? "info" : kind === "non_goal" || kind === "risk" ? "warning" : "neutral";
  return <UiTag tone={tone}>{KIND_LABEL()[kind] ?? kind}</UiTag>;
}

export function StatusTag({ status }: { status: string }) {
  useDashboardLanguage();
  if (status === "active") return null;
  const tone = status === "rejected" || status === "superseded" ? "danger" : status === "proposed" ? "warning" : "neutral";
  return <UiTag tone={tone}>{STATUS_LABEL()[status] ?? status}</UiTag>;
}

export function CertaintyMark({ certainty }: { certainty: string }) {
  useDashboardLanguage();
  if (certainty === "exact") return null;
  return (
    <span className={styles.certainty} title={certainty === "inferred" ? uiText("推断：来源没有原话，见 rationale") : uiText("歧义：需要人裁决")}>
      {certainty === "inferred" ? uiText("推断") : uiText("歧义")}
    </span>
  );
}

export function StatementRow({ item, showKind = true, compact = false }: { item: WikiStatement; showKind?: boolean; compact?: boolean }) {
  useDashboardLanguage();
  return (
    <li className={`${styles.row} ${compact ? styles.rowCompact : ""}`} data-node-id={item.id}>
      <div className={styles.rowChips}>
        {showKind && <KindTag kind={item.kind} />}
        {["principle", "requirement", "decision", "non_goal", "risk"].includes(item.kind) && <StrengthTag item={item} />}
        <span className={styles.authority}>{AUTHORITY_LABEL()[item.authority] ?? item.authority}</span>
        <CertaintyMark certainty={item.certainty} />
        <StatusTag status={item.status} />
        {item.realization && item.realization !== "not_applicable" && item.realization !== "implemented" && (
          <UiTag tone="warning">{item.realization === "planned" ? uiText("尚未实施") : uiText("部分实施")}</UiTag>
        )}
      </div>
      <Link className={styles.statementText} to={wikiHref(item.id)}>
        {item.statement}
      </Link>
      <div className={styles.rowMeta}>
        <span title={item.source_ref}>{shortSource(item.source_ref)}</span>
        {item.valid_from && <span>{item.valid_from.slice(0, 10)}</span>}
        {item.detail.origins?.map((origin) => (
          <span key={`${origin.ticket}:${origin.requester}:${origin.role}`}>
            {origin.role === "user_requirement"
              ? uiText("用户 {v0} · 工单 #{v1}", { v0: origin.requester, v1: origin.ticket })
              : uiText("源自 {v0} 的工单 #{v1}", { v0: origin.requester, v1: origin.ticket })}
            {actorKindLabel(origin.actor_kind) ? (
              <span data-testid="origin-actor-kind" title={actorKindHint()}> · {actorKindLabel(origin.actor_kind)}</span>
            ) : null}
          </span>
        ))}
        {item.detail.ticket != null && !item.detail.origins?.length && <span>#{item.detail.ticket}</span>}
        {item.detail.quote && !compact && <q className={styles.quote}>{item.detail.quote}</q>}
      </div>
    </li>
  );
}

export interface StatementListProps {
  items: WikiStatement[];
  title?: string;
  empty?: string;
  showKind?: boolean;
  filters?: boolean;
  limit?: number;
}

const KIND_FILTERS = ["decision", "requirement", "non_goal", "risk", "principle", "pattern", "constraint"] as const;

export function StatementList({ items, title, empty = uiText("无记录。"), showKind = true, filters = false, limit }: StatementListProps) {
  useDashboardLanguage();
  const [kind, setKind] = useState<string>("all");
  const [status, setStatus] = useState<"current" | "all">("current");
  const [expanded, setExpanded] = useState(false);
  const visible = useMemo(() => {
    let list = items;
    if (kind !== "all") list = list.filter((item) => item.kind === kind);
    if (status === "current") list = list.filter((item) => item.status === "active" || item.status === "historical");
    return list;
  }, [items, kind, status]);
  const shown = limit && !expanded ? visible.slice(0, limit) : visible;
  const presentKinds = new Set(items.map((item) => item.kind));
  return (
    <section className={styles.section}>
      {title && (
        <h3 className={styles.sectionTitle}>
          {title} <span className={styles.count}>{visible.length}</span>
        </h3>
      )}
      {filters && items.length > 0 && (
        <div className={styles.filters} role="group" aria-label={uiText("筛选")}>
          <button type="button" className={kind === "all" ? styles.filterOn : styles.filter} onClick={() => setKind("all")}>
            {uiText("全部")}</button>
          {KIND_FILTERS.filter((value) => presentKinds.has(value)).map((value) => (
            <button key={value} type="button" className={kind === value ? styles.filterOn : styles.filter} onClick={() => setKind(value)}>
              {KIND_LABEL()[value]}
            </button>
          ))}
          <span className={styles.filterGap} />
          <button type="button" className={status === "current" ? styles.filterOn : styles.filter} onClick={() => setStatus("current")}>
            {uiText("现行")}</button>
          <button type="button" className={status === "all" ? styles.filterOn : styles.filter} onClick={() => setStatus("all")}>
            {uiText("含已取代/否决")}</button>
        </div>
      )}
      {shown.length === 0 ? (
        <p className={styles.empty}>{empty}</p>
      ) : (
        <ul className={styles.list}>
          {shown.map((item) => (
            <StatementRow key={item.id} item={item} showKind={showKind} />
          ))}
        </ul>
      )}
      {limit && visible.length > limit && (
        <button type="button" className={styles.more} onClick={() => setExpanded((value) => !value)}>
          {expanded ? uiText("收起") : uiText("显示全部 {v0} 条", { v0: visible.length })}
        </button>
      )}
    </section>
  );
}
