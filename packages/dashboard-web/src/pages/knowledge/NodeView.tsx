import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
/** 节点 — one statement with everything the graph knows about it. */
import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, errorText } from "../../lib/api.js";
import { ErrorBox, Loading } from "../../ui/misc.js";
import styles from "../KnowledgePage.module.css";
import { ReportRepair } from "./IterationViews.js";
import { EvidenceDetails } from "./EvidenceDetails.js";
import { ConflictCard } from "./ConflictResolutionWorkspace.js";
import { CertaintyMark, KindTag, StatementRow, StatusTag } from "./StatementList.js";
import { DECISION_LABEL, AUTHORITY_LABEL, RELATION_LABEL, reviewNoteText, type WikiEdgeGroup, type WikiNodeView } from "./types.js";

/** Rows rendered before an explicit "show all"; the wire already carries every neighbour. */
export const EDGE_GROUP_DISPLAY = 60;

function EdgeGroup({ group }: { group: WikiEdgeGroup }) {
  useDashboardLanguage();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? group.nodes : group.nodes.slice(0, EDGE_GROUP_DISPLAY);
  return (
    <details open={group.total <= 8}>
      <summary>
        {RELATION_LABEL()[group.relation] ?? group.relation} <span className={styles.count}>{group.total}</span>
      </summary>
      <ul className={styles.list} style={{ marginTop: 6 }}>
        {shown.map((item) => <StatementRow key={item.id} item={item} compact />)}
      </ul>
      {group.nodes.length > EDGE_GROUP_DISPLAY && (
        <button type="button" className={styles.more} onClick={() => setExpanded((value) => !value)}>
          {expanded ? uiText("收起") : uiText("显示全部 {v0} 条", { v0: group.nodes.length })}
        </button>
      )}
    </details>
  );
}

function EdgeGroups({ title, groups }: { title: string; groups: WikiEdgeGroup[] }) {
  useDashboardLanguage();
  if (!groups.length) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {/* Keyed by relation: a refetch keeps each group's expansion. */}
      {groups.map((group) => <EdgeGroup key={group.relation} group={group} />)}
    </section>
  );
}

export function NodeView({ id }: { id: string }) {
  useDashboardLanguage();
  const query = useQuery<WikiNodeView>({
    queryKey: ["knowledge", "node", id],
    queryFn: () => api<WikiNodeView>(`/api/knowledge/node?id=${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });
  if (!id) return <ErrorBox>{uiText("缺少 id。")}</ErrorBox>;
  if (query.isLoading) return <Loading what={uiText("读取…")} />;
  if (query.error || !query.data) return <ErrorBox>{query.error ? errorText(query.error) : uiText("不存在")}</ErrorBox>;
  const { node, out, in: incoming, conflicts } = query.data;
  const d = node.detail;
  return (
    <>
      <nav className={styles.crumbs} aria-label={uiText("位置")}>
        <Link to="/knowledge">{uiText("索引")}</Link>
        <span>›</span>
        <span>{node.id}</span>
      </nav>
      <div className={styles.rowChips} style={{ marginTop: 8 }}>
        <KindTag kind={node.kind} />
        <span className={styles.authority}>{AUTHORITY_LABEL()[node.authority] ?? node.authority}</span>
        <CertaintyMark certainty={node.certainty} />
        <StatusTag status={node.status} />
      </div>
      <p className={styles.statement}>{node.statement}</p>
      {query.data.repair_fingerprint && <ReportRepair id={node.id} fingerprint={query.data.repair_fingerprint} />}
      {d.quote && <blockquote className={styles.note}>{uiText("原话：")}{d.quote}</blockquote>}
      {d.rationale && <p className={styles.note}>{uiText("依据：")}{d.rationale}</p>}
      {d.conflict_note && <p className={styles.note}>{uiText("⚠ 歧义：")}{d.conflict_note}</p>}
      {d.mandatory_facts?.length ? <p className={styles.note}>{uiText("必须捕获的事实：")}{d.mandatory_facts.join("、")}</p> : null}
      <dl className={styles.kv}>
        <dt>{uiText("来源")}</dt><dd>{node.source_ref}{node.source_sha && node.source_sha !== "WORKTREE" ? ` @ ${node.source_sha.slice(0, 12)}` : ""}</dd>
        {node.valid_from && <><dt>{uiText("生效")}</dt><dd>{node.valid_from.slice(0, 19).replace("T", " ")}{node.valid_to ? ` → ${node.valid_to.slice(0, 19).replace("T", " ")}` : ""}</dd></>}
        {node.realization && <><dt>{uiText("实现状态")}</dt><dd>{node.realization}</dd></>}
        {d.ticket != null && <><dt>{uiText("工单")}</dt><dd><Link to="/tickets">#{d.ticket}</Link></dd></>}
        {d.superseded_by && <><dt>{uiText("被取代")}</dt><dd><Link to={`/knowledge?v=node&id=${encodeURIComponent(d.superseded_by)}`}>{d.superseded_by}</Link></dd></>}
        {d.merged_from?.length ? <><dt>{uiText("同义来源")}</dt><dd>{d.merged_from.join("；")}</dd></> : null}
        {d.commands?.length ? <><dt>{uiText("验证命令")}</dt><dd><code>{d.commands.join(" ; ")}</code></dd></> : null}
        {d.zone && <><dt>{uiText("信任区")}</dt><dd>{d.zone}{d.criticality ? ` · ${d.criticality}` : ""}</dd></>}
        {d.lifecycle_source && <><dt>{uiText("生命周期来源")}</dt><dd>{d.lifecycle_source === "frontmatter" ? "frontmatter" : uiText("状态行（legacy）")}</dd></>}
      </dl>
      {conflicts.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{uiText("涉及的冲突候选 ")}<span className={styles.count}>{conflicts.length}</span></h3>
          {conflicts.map((item) => <ConflictCard key={item.id} item={item} />)}
        </section>
      )}
      <EvidenceDetails item={node} />
      {!!query.data.history?.length && <section className={styles.section}>
        <h3>{uiText("审阅与处理记录")}</h3>
        <ol>{query.data.history.map((entry, index) => <li key={`${entry.at}:${index}`}>
          <b>{entry.actor}</b> · <time dateTime={entry.at}>{entry.at}</time> · {DECISION_LABEL()[entry.decision] ?? entry.decision}<p>{reviewNoteText(entry.note)}</p>
        </li>)}</ol>
      </section>}
      <div className={styles.columns}>
        <EdgeGroups title={uiText("它指向")} groups={out} />
        <EdgeGroups title={uiText("指向它")} groups={incoming} />
      </div>
    </>
  );
}
