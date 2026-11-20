import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
/** 索引 — the capability index is the wiki's table of contents. */
import { Link } from "react-router";
import styles from "../KnowledgePage.module.css";
import { StatementList } from "./StatementList.js";
import type { WikiCapabilitySummary, WikiOverview } from "./types.js";

function CapabilityCard({ item }: { item: WikiCapabilitySummary }) {
  useDashboardLanguage();
  const c = item.counts;
  return (
    <article className={styles.card} data-capability={item.id}>
      <h3 className={styles.cardTitle}>
        <Link to={`/knowledge?v=capability&id=${encodeURIComponent(item.id)}`}>{item.label}</Link>
      </h3>
      <p className={styles.cardDesc}>{item.description}</p>
      <div className={styles.counts}>
        <span><b>{c.principle ?? 0}</b> {uiText(" 原则")}</span>
        <span><b>{c.constraint ?? 0}</b> {uiText(" 约束")}</span>
        <span><b>{c.decision ?? 0}</b> {uiText(" 决策")}</span>
        <span><b>{c.requirement ?? 0}</b> {uiText(" 需求")}</span>
        <span><b>{c.non_goal ?? 0}</b> {uiText(" 非目标")}</span>
        <span><b>{c.pattern ?? 0}</b> {uiText(" 模式")}</span>
        <span><b>{item.modules}</b> {uiText(" 模块")}</span>
      </div>
      {item.direct === 0 && <span className={styles.emptyHint}>{uiText("暂无直接关联记录。")}</span>}
    </article>
  );
}

export function HomeView({ overview }: { overview: WikiOverview }) {
  useDashboardLanguage();
  const products = overview.capabilities.filter((item) => item.kind === "product");
  const concerns = overview.capabilities.filter((item) => item.kind === "concern");
  const r = overview.review;
  return (
    <>
      <p className={styles.lead}>
        {uiText("按能力查看原则、约束、决策、需求、复发模式及来源；“试算启动包”可预览 agent 获得的上下文。")}</p>
      {(r.conflictsOpen > 0 || r.ambiguous > 0 || r.adrPlanned > 0 || r.emptyCapabilities > 0) && (
        <section className={styles.section} aria-label={uiText("需要裁决")}>
          <h3 className={styles.sectionTitle}>{uiText("需要人介入")}</h3>
          <div className={styles.chips}>
            {r.conflictsOpen > 0 && <Link className={styles.chip} to="/knowledge?v=review&tab=conflicts">{r.conflictsOpen} {uiText(" 个冲突候选待裁决")}</Link>}
            {r.ambiguous > 0 && <Link className={styles.chip} to="/knowledge?v=review&tab=ambiguous">{r.ambiguous} {uiText(" 条歧义记录")}</Link>}
            {r.adrPlanned > 0 && <Link className={styles.chip} to="/knowledge?v=review&tab=adr">{r.adrPlanned} {uiText(" 份 ADR 已接受但未（完全）实现")}</Link>}
            {r.adrLegacy > 0 && <Link className={styles.chip} to="/knowledge?v=review&tab=adr">{r.adrLegacy} {uiText(" 份 ADR 缺少 frontmatter")}</Link>}
            {r.staleAnchors > 0 && <Link className={styles.chip} to="/knowledge?v=review&tab=conflicts">{r.staleAnchors} {uiText(" 个失效锚点")}</Link>}
            {r.unmappedModules > 0 && <Link className={styles.chip} to="/knowledge?v=review&tab=coverage">{r.unmappedModules} {uiText(" 个模块未归入任何能力")}</Link>}
            {r.emptyCapabilities > 0 && <Link className={styles.chip} to="/knowledge?v=review&tab=coverage">{r.emptyCapabilities} {uiText(" 个能力没有结构化记录")}</Link>}
            {r.ticketsWithoutKnowledge > 0 && <Link className={styles.chip} to="/knowledge?v=review&tab=coverage">{r.ticketsWithoutKnowledge} {uiText(" 张工单无任何知识")}</Link>}
          </div>
        </section>
      )}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{uiText("产品能力 ")}<span className={styles.count}>{products.length}</span></h3>
        {products.length === 0 ? <p className={styles.empty}>{uiText("知识图谱尚未构建。")}</p> : (
          <div className={styles.grid}>{products.map((item) => <CapabilityCard key={item.id} item={item} />)}</div>
        )}
      </section>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{uiText("横切关注点 ")}<span className={styles.count}>{concerns.length}</span></h3>
        <div className={styles.grid}>{concerns.map((item) => <CapabilityCard key={item.id} item={item} />)}</div>
      </section>
      <StatementList title={uiText("最近落地")} items={overview.landings} showKind={false} empty={uiText("还没有落地记录。")} />
    </>
  );
}
