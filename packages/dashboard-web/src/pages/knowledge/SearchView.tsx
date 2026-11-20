import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
/** 搜索 — statements, capabilities and modules for a query. */
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, errorText } from "../../lib/api.js";
import { ErrorBox, Loading } from "../../ui/misc.js";
import styles from "../KnowledgePage.module.css";
import { StatementList, wikiHref } from "./StatementList.js";
import type { WikiSearchView } from "./types.js";

export function SearchView({ query }: { query: string }) {
  useDashboardLanguage();
  const result = useQuery<WikiSearchView>({
    queryKey: ["knowledge", "search", query],
    queryFn: () => api<WikiSearchView>(`/api/knowledge/search?q=${encodeURIComponent(query)}`),
    enabled: Boolean(query),
  });
  if (!query) return <p className={styles.empty}>{uiText("在上方输入要找的原则、决策、需求或非目标。")}</p>;
  if (result.isLoading) return <Loading what={uiText("搜索…")} />;
  if (result.error || !result.data) return <ErrorBox>{result.error ? errorText(result.error) : uiText("搜索失败")}</ErrorBox>;
  const data = result.data;
  return (
    <>
      <p className={styles.lead}>「{data.query}」</p>
      {(data.capabilities.length > 0 || data.modules.length > 0) && (
        <div className={styles.chips}>
          {data.capabilities.map((item) => (
            <Link key={item.id} className={styles.chip} to={`/knowledge?v=capability&id=${encodeURIComponent(item.id)}`} title={item.why.join("；")}>
              {uiText("能力 ")}{item.id}{item.certainty !== "exact" ? `（${item.certainty === "inferred" ? uiText("推断") : uiText("猜测")}）` : ""}
            </Link>
          ))}
          {data.modules.map((item) => (
            <Link key={item.id} className={styles.chip} to={wikiHref(item.id)}>
              {uiText("模块 ")}{item.id.replace(/^module:/, "")}
            </Link>
          ))}
        </div>
      )}
      <StatementList title={uiText("语句")} items={data.statements} filters empty={uiText("没有词法命中；换个说法，或从能力页进入。")} />
    </>
  );
}
