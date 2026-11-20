import { useInfiniteQuery } from "@tanstack/react-query";
import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { api, errorText } from "../../lib/api.js";
import { ErrorBox, Loading } from "../../ui/misc.js";
import { UiButton } from "../../ui-kit/primitives.js";
import styles from "../KnowledgePage.module.css";
import type { WikiTicketRetrievalPage } from "./types.js";

export function RetrievalTickets({ select }: { select: (ticket: number) => void }) {
  useDashboardLanguage();
  const query = useInfiniteQuery({
    queryKey: ["knowledge", "retrieval-tickets"],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api<WikiTicketRetrievalPage>(`/api/knowledge/retrievals?view=tickets&limit=50${pageParam ? `&before_ticket=${pageParam}` : ""}`),
    getNextPageParam: (page) => page.has_more ? page.next_before ?? null : null,
  });
  if (query.isLoading) return <Loading what={uiText("读取工单查询记录…")} />;
  if (!query.data) return <ErrorBox>{errorText(query.error)}</ErrorBox>;
  const items = [...new Map(query.data.pages.flatMap((page) => page.items).map((item) => [item.ticket_id, item])).values()];
  return <section className={styles.section} aria-label={uiText("按工单观察")}>
    <p className={styles.lead}>{uiText("仅统计工单 Agent 的保留期内记录；CLI 查询请看全部追踪。无记录不等于从未查询，申报引用不证明实际采用。")}</p>
    <p className={styles.reviewState}>{uiText("成功送达只统计已组装并交付的主动查询；申报引用按知识记录去重，反馈按事件计数。")}</p>
    <div className={styles.retrievalTableScroll}>
      <table className={styles.retrievalTable}>
        <caption>{uiText("工单知识查询与引用")}</caption>
        <thead><tr>
          {[uiText("工单"), uiText("自动注入"), uiText("主动查询"), uiText("成功送达"), uiText("提交检查"), uiText("申报引用"), uiText("反馈"), uiText("最近主动查询")].map((label) => <th scope="col" key={label}>{label}</th>)}
        </tr></thead>
        <tbody>{items.map((item) => <tr key={item.ticket_id}>
          <th scope="row">#{item.ticket_id} {item.title}</th>
          <td>{item.startup}</td>
          <td><UiButton size="small" onClick={() => select(item.ticket_id)} aria-label={uiText("查看工单 #{v0} 的追踪", { v0: item.ticket_id })}>{item.path_queries}</UiButton></td>
          <td>{item.delivered_queries}</td><td>{item.submit_checks}</td><td>{item.cited_records}</td><td>{item.feedback}</td>
          <td>{item.last_query_at?.slice(0, 19).replace("T", " ") ?? "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {!items.length && <p className={styles.empty}>{uiText("没有工单记录。")}</p>}
    {query.isFetchNextPageError && <ErrorBox>{errorText(query.error)}</ErrorBox>}
    {query.hasNextPage && <UiButton loading={query.isFetchingNextPage} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{uiText("加载更早的工单")}</UiButton>}
  </section>;
}
