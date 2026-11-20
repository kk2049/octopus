import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
/** 能力 / 模块 — one subject's reading list, grouped the way the startup pack groups it. */
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, errorText } from "../../lib/api.js";
import { ErrorBox, Loading } from "../../ui/misc.js";
import { UiTag } from "../../ui-kit/primitives.js";
import styles from "../KnowledgePage.module.css";
import { StatementList, StatementRow, wikiHref } from "./StatementList.js";
import type { WikiCapabilityView } from "./types.js";

export function CapabilityView({ kind, id }: { kind: "capability" | "module"; id: string }) {
  useDashboardLanguage();
  const query = useQuery<WikiCapabilityView>({
    queryKey: ["knowledge", kind, id],
    queryFn: () => api<WikiCapabilityView>(`/api/knowledge/${kind}?id=${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });
  if (!id) return <ErrorBox>{uiText("缺少 id。")}</ErrorBox>;
  if (query.isLoading) return <Loading what={uiText("读取…")} />;
  if (query.error || !query.data) return <ErrorBox>{query.error ? errorText(query.error) : uiText("不存在")}</ErrorBox>;
  const view = query.data;
  const subject = view.capability;
  const [title, ...rest] = subject.statement.split("：");
  return (
    <>
      <nav className={styles.crumbs} aria-label={uiText("位置")}>
        <Link to="/knowledge">{uiText("索引")}</Link>
        <span>›</span>
        <span>{kind === "capability" ? uiText("能力") : uiText("模块")}</span>
      </nav>
      <h2 style={{ margin: "8px 0 4px" }}>{title}</h2>
      {rest.length > 0 && <p className={styles.lead}>{rest.join("：")}</p>}
      <div className={styles.chips}>
        {view.modules.map((module) => (
          <Link key={module.id} className={styles.chip} to={wikiHref(module.id)} title={module.statement}>
            {module.id.replace(/^module:/, "")}
            {module.detail.zone ? ` · ${module.detail.zone}` : ""}
          </Link>
        ))}
        {view.docs.map((doc) => (
          <span key={doc} className={styles.chip} title={uiText("文档路径")}>
            📄 {doc}
          </span>
        ))}
      </div>
      <div className={styles.columns}>
        <div>
          <StatementList title={uiText("适用原则")} items={view.principles} showKind={false} limit={12} empty={uiText("没有按路径或能力登记的原则。")} />
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{uiText("机械约束与验证 ")}<span className={styles.count}>{view.constraints.length}</span></h3>
            {view.constraints.length === 0 ? <p className={styles.empty}>{uiText("无 atlas 约束。")}</p> : (
              <ul className={styles.list}>
                {view.constraints.map((item) => (
                  <li key={item.id} className={styles.row}>
                    <div className={styles.rowChips}><UiTag tone="info">{uiText("约束")}</UiTag></div>
                    <Link className={styles.statementText} to={wikiHref(item.id)}>{item.statement}</Link>
                    {item.detail.commands?.length ? (
                      <div className={styles.rowMeta}><code>{item.detail.commands[0]}</code></div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <StatementList
            title={uiText("决策、需求、非目标与风险")}
            items={[...view.decisions, ...view.requirements, ...view.nonGoals, ...view.risks]}
            filters
            limit={20}
            empty={uiText("没有结构化的需求或决策记录。")}
          />
        </div>
        <aside>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{uiText("复发模式 ")}<span className={styles.count}>{view.patterns.length}</span></h3>
            {view.patterns.length === 0 ? <p className={styles.empty}>{uiText("无。")}</p> : (
              <ul className={styles.list}>
                {view.patterns.map((item) => (
                  <li key={item.id} className={styles.row}>
                    <div className={styles.rowChips}><UiTag tone="warning">{uiText("模式")}</UiTag></div>
                    <Link className={styles.statementText} to={wikiHref(item.id)}>{item.statement}</Link>
                    <div className={styles.rowMeta}>
                      {item.detail.tickets?.map((ticket) => <span key={ticket}>#{ticket}</span>)}
                      {item.detail.mandatory_facts?.length ? <span>{uiText("必须捕获：")}{item.detail.mandatory_facts.join("、")}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{uiText("最近落地 ")}<span className={styles.count}>{view.landings.length}</span></h3>
            {view.landings.length === 0 ? <p className={styles.empty}>{uiText("无。")}</p> : (
              <ul className={styles.list}>
                {view.landings.map((item) => <StatementRow key={item.id} item={item} showKind={false} compact />)}
              </ul>
            )}
          </section>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{uiText("未知 / 缺口")}</h3>
            {view.unknown.length === 0 ? <p className={styles.empty}>{uiText("无已知缺口。")}</p> : (
              <ul className={styles.list}>{view.unknown.map((item) => <li key={item} className={styles.note}>{item}</li>)}</ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
