import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText, localizedLabels } from "../../i18n/ui-text.js";
/**
 * 需要裁决 — the human-in-the-loop queue.
 *
 * The graph only produces candidates. A reviewer records one of three
 * decisions per subject (dismiss as a false positive, confirm as real and to
 * be handled, mark resolved once Git carries the fix); the decision is runtime
 * state on the server and never edits knowledge. "开工单" files a normal dev
 * ticket with both sides and their sources, so the resolution lands through
 * the ordinary path.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../../lib/api.js";
import { bootstrap } from "../../lib/bootstrap.js";
import { ErrorBox, Loading, Status } from "../../ui/misc.js";
import { UiButton, UiTag } from "../../ui-kit/primitives.js";
import styles from "../KnowledgePage.module.css";
import { StatementRow, wikiHref } from "./StatementList.js";
import { ConflictResolutionWorkspace } from "./ConflictResolutionWorkspace.js";
import { RetrievalTickets } from "./RetrievalTickets.js";
import {
  DECISION_LABEL,
  reviewNoteText,
  type WikiClassificationAudit,
  type WikiIndexAttemptAudit,
  type WikiOverview,
  type WikiRetrievalEvent,
  type WikiRetrievalReviewList,
  type WikiRetrievalReviewRow,
  type WikiRetrievalTraceDetail,
  type WikiReviewState,
  type WikiReviewView,
} from "./types.js";

type Tab = "conflicts" | "ambiguous" | "adr" | "coverage" | "retrieval";

/** Availability hint only: the server's `UseDev` gate decides, and a refusal is rendered as such. */
function canDecide(): boolean {
  return Boolean(bootstrap.viewer?.dev || bootstrap.viewer?.admin);
}


function DecisionBar({ subject, rule, review }: { subject: string; rule: string; review: WikiReviewState | null }) {
  useDashboardLanguage();
  const client = useQueryClient();
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState("");
  const decide = useMutation({
    mutationFn: (decision: string) =>
      api<{ ok: boolean; error?: string }>("/api/knowledge/review/decide", { method: "POST", json: { subject_id: subject, rule, decision, note } }),
    onSuccess: async () => {
      setFailed("");
      await client.invalidateQueries({ queryKey: ["knowledge"] });
    },
    onError: (error) => setFailed(errorText(error)),
  });
  const allowed = canDecide();
  return (
    <div className={styles.actions}>
      {review && (
        <span className={styles.reviewState}>
          {DECISION_LABEL()[review.decision] ?? review.decision} · {review.actor} · {review.at.slice(0, 16).replace("T", " ")}
          {review.note ? ` · ${reviewNoteText(review.note)}` : ""}
        </span>
      )}
      {allowed ? (
        <>
          <input className={styles.noteInput} placeholder={uiText("备注（可选）")} value={note} onChange={(event) => setNote(event.target.value)} aria-label={uiText("裁决备注")} />
          {(!review || review.decision !== "dismissed") && (
            <UiButton size="small" disabled={decide.isPending} onClick={() => decide.mutate("dismissed")}>{uiText("忽略（误报）")}</UiButton>
          )}
          {(!review || review.decision !== "confirmed") && (
            <UiButton size="small" disabled={decide.isPending} onClick={() => decide.mutate("confirmed")}>{uiText("确认，待处理")}</UiButton>
          )}
          {(!review || review.decision !== "resolved") && (
            <UiButton size="small" disabled={decide.isPending} onClick={() => decide.mutate("resolved")}>{uiText("已在 Git 处理")}</UiButton>
          )}
          {review && review.decision !== "reopened" && (
            <UiButton size="small" disabled={decide.isPending} onClick={() => decide.mutate("reopened")}>{uiText("重新打开")}</UiButton>
          )}
        </>
      ) : (
        <span className={styles.reviewState}>{uiText("裁决需要开发权限；你可以开工单交给有权限的人。")}</span>
      )}
      {failed && <Status kind="err">{failed}</Status>}
    </div>
  );
}

function OpenTicketButton({ body }: { body: string }) {
  useDashboardLanguage();
  const create = useMutation({
    mutationFn: () => api<{ id?: number }>("/api/tickets", { method: "POST", json: { body } }),
  });
  return (
    <>
      <UiButton size="small" disabled={create.isPending || Boolean(create.data)} onClick={() => create.mutate()}>
        {create.data ? uiText("已开工单 #{v0}", { v0: create.data.id ?? "" }) : uiText("开工单")}
      </UiButton>
      {create.error && <Status kind="err">{errorText(create.error)}</Status>}
    </>
  );
}


const DETAIL_ID = "retrieval-trace-detail";
const CLASSIFICATION_DIMENSIONS: WikiClassificationAudit["dimension"][] = [
  "capability",
  "scenario",
  "provider",
  "launch_mode",
  "state",
  "action",
  "path",
  "symbol",
];
const EVENT_LABEL = localizedLabels((): Record<WikiRetrievalEvent["event"], string> => ({
  started: uiText("开始"),
  assembled: uiText("已组装"),
  miss: uiText("未命中"),
  error: uiText("检索错误"),
  delivered: uiText("已交付"),
  delivered_error: uiText("交付错误"),
  abandoned: uiText("已放弃"),
  reported_use: uiText("已报告使用"),
  feedback: uiText("反馈"),
}));
const EVENT_ORDER: Record<WikiRetrievalEvent["event"], number> = {
  started: 0,
  assembled: 1,
  miss: 1,
  error: 1,
  delivered: 2,
  delivered_error: 2,
  abandoned: 3,
  reported_use: 4,
  feedback: 5,
};


function DigestField({ label, value }: { label: string; value: string | undefined }) {
  useDashboardLanguage();
  return (
    <Fragment>
      <dt>{label}</dt>
      <dd>
        {value
          ? <code className={styles.digest} aria-label={`${label}：${value}`}>{value}</code>
          : <span className={styles.reviewState}>{uiText("未提供")}</span>}
      </dd>
    </Fragment>
  );
}

function RetrievalSummary({
  item,
  selected,
  select,
}: {
  item: WikiRetrievalReviewRow;
  selected: boolean;
  select: (id: string) => void;
}) {
  useDashboardLanguage();
  const metaId = `retrieval-${item.trace_id}-meta`;
  const tone = item.outcome === "error" || item.outcome === "abandoned"
    ? "danger"
    : item.outcome === "miss" ? "warning" : "neutral";
  return (
    <li className={`${styles.row} ${selected ? styles.rowSelected : ""}`}>
      <div className={styles.rowChips}>
        <UiTag tone={tone}>{item.outcome}</UiTag>
        <UiTag tone="neutral">{item.lane}</UiTag>
        <UiTag tone="neutral">{item.purpose}</UiTag>
      </div>
      <button
        type="button"
        className={styles.statementText}
        aria-current={selected ? "true" : undefined}
        aria-pressed={selected}
        aria-controls={selected ? DETAIL_ID : undefined}
        aria-describedby={metaId}
        onClick={() => select(item.trace_id)}
      >
        {item.subject_ref} · {item.trace_id}
      </button>
      <div className={styles.rowMeta} id={metaId}>
        <span>{item.started_at.slice(0, 19).replace("T", " ")}</span>
        <span aria-label={`repo ${item.repo_sha}`} title={item.repo_sha}>{uiText("仓库")}{item.repo_sha.slice(0, 10)}</span>
        {item.unknown_codes.map((code) => <span key={`unknown:${code}`}>{code}</span>)}
        {item.feedback_codes.map((code) => <span key={`feedback:${code}`}>{uiText("反馈：")}{code}</span>)}
      </div>
    </li>
  );
}

function ClassificationGroups({ items }: { items: WikiClassificationAudit[] }) {
  useDashboardLanguage();
  const groups = new Map<string, WikiClassificationAudit[]>();
  for (const item of items) {
    const group = groups.get(item.dimension) ?? [];
    group.push(item);
    groups.set(item.dimension, group);
  }
  const dimensions = [
    ...CLASSIFICATION_DIMENSIONS.filter((dimension) => groups.has(dimension)),
    ...Array.from(groups.keys()).filter((dimension) => !CLASSIFICATION_DIMENSIONS.includes(dimension as WikiClassificationAudit["dimension"])),
  ];
  return (
    <section className={styles.auditGroup} aria-label={uiText("分类判定")}>
      <h4>{uiText("分类判定")}</h4>
      <div className={styles.classificationGroups}>
        {dimensions.map((dimension) => (
          <section key={dimension} className={styles.classificationGroup}>
            <h5>{dimension}</h5>
            {groups.get(dimension)!.map((item, index) => (
              <details className={styles.auditDisclosure} key={`${item.value}:${index}`}>
                <summary>{item.value}</summary>
                <dl className={styles.auditGrid}>
                  <dt>{uiText("确定性")}</dt>
                  <dd>{item.certainty}</dd>
                  <dt>{uiText("分数")}</dt>
                  <dd>{item.score}</dd>
                  <dt>{uiText("原因代码")}</dt>
                  <dd>{item.reason_codes.length ? item.reason_codes.join(" · ") : uiText("无")}</dd>
                </dl>
              </details>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function IndexAttempt({ attempt, ordinal }: { attempt: WikiIndexAttemptAudit; ordinal: number }) {
  useDashboardLanguage();
  const index = attempt.index;
  return (
    <details className={styles.auditDisclosure}>
      <summary>
        {ordinal}. {index.id} · {attempt.status} · {index.freshness}
      </summary>
      <dl className={styles.auditGrid}>
        <dt>{uiText("种类")}</dt>
        <dd>{index.kind}</dd>
        <dt>{uiText("延迟")}</dt>
        <dd>{attempt.latency_ms} ms</dd>
        <dt>{uiText("隐私决策")}</dt>
        <dd>{attempt.privacy_decision ?? uiText("未记录")}</dd>
        <dt>{uiText("清单 schema")}</dt>
        <dd>{index.manifest_schema}</dd>
        <dt>{uiText("记录 schema")}</dt>
        <dd>{index.record_schema_version}</dd>
        <dt>{uiText("记录数")}</dt>
        <dd>{index.record_count}</dd>
        {attempt.error_code && (
          <>
            <dt>{uiText("错误代码")}</dt>
            <dd>{attempt.error_code}</dd>
          </>
        )}
        <DigestField label={uiText("来源 Git SHA")} value={index.source_git_sha} />
        <DigestField label={uiText("图 SHA-256")} value={index.graph_sha256} />
        <DigestField label={uiText("产物 SHA-256")} value={index.artifact_sha256} />
      </dl>
      {index.embedding && (
        <section className={styles.auditGroup} aria-label={uiText("嵌入绑定")}>
          <h5>{uiText("嵌入绑定")}</h5>
          <dl className={styles.auditGrid}>
            <dt>{uiText("提供方 / 模型")}</dt>
            <dd>{index.embedding.provider} / {index.embedding.model_id}</dd>
            <dt>{uiText("不可变版本")}</dt>
            <dd><code className={styles.digest}>{index.embedding.immutable_revision}</code></dd>
            <dt>{uiText("维度 / dtype")}</dt>
            <dd>{index.embedding.dimensions} / {index.embedding.dtype}</dd>
            <dt>{uiText("归一化 / 距离")}</dt>
            <dd>{String(index.embedding.normalized)} / {index.embedding.distance}</dd>
          </dl>
        </section>
      )}
      {(attempt.hits?.length ?? 0) > 0 && (
        <section className={styles.auditGroup} aria-label={uiText("索引命中")}>
          <h5>{uiText("命中")}</h5>
          <ul className={styles.compactAuditList}>
            {attempt.hits.map((hit) => (
              <li key={`${hit.record_id}:${hit.rank}`}>
                #{hit.rank} {hit.record_id} {uiText("· 原始值")}{hit.raw_score}
              </li>
            ))}
          </ul>
        </section>
      )}
    </details>
  );
}

function CandidateDetails({ event }: { event: WikiRetrievalEvent }) {
  useDashboardLanguage();
  const payload = event.payload ?? {};
  const contextKeys = payload.context_keys ?? [];
  return (
    <>
      {(payload.classifications?.length ?? 0) > 0 && <ClassificationGroups items={payload.classifications!} />}
      {(payload.indexes?.length ?? 0) > 0 && (
        <section className={styles.auditGroup} aria-label={uiText("索引尝试")}>
          <h4>{uiText("索引尝试")}</h4>
          {payload.indexes!.map((attempt, index) => (
            <IndexAttempt attempt={attempt} ordinal={index + 1} key={`${attempt.index.id}:${index}`} />
          ))}
        </section>
      )}
      {(payload.candidates?.length ?? 0) > 0 && (
        <section className={styles.auditGroup} aria-label={uiText("检索候选")}>
          <h4>{uiText("候选")}</h4>
          {payload.candidates!.map((candidate) => (
            <details className={styles.auditDisclosure} key={candidate.record_id}>
              <summary>#{candidate.fused_rank} {candidate.record_id}</summary>
              <dl className={styles.auditGrid}>
                <dt>{uiText("种类")}</dt>
                <dd>{candidate.kind}</dd>
                <dt>{uiText("来源坐标")}</dt>
                <dd><code className={styles.digest}>{candidate.source_ref}</code></dd>
                <DigestField label={uiText("来源 SHA")} value={candidate.source_sha} />
                <dt>{uiText("融合分数")}</dt>
                <dd>{candidate.fused_score}</dd>
                {candidate.dropped && (
                  <>
                    <dt>{uiText("丢弃原因")}</dt>
                    <dd>{candidate.dropped}</dd>
                  </>
                )}
              </dl>
              {(candidate.signals?.length ?? 0) > 0 && (
                <ul className={styles.compactAuditList} aria-label={uiText("候选索引信号")}>
                  {candidate.signals.map((signal) => (
                    <li key={`${signal.index_id}:${signal.rank}`}>
                      {signal.index_id} #{signal.rank} {uiText("· 原始值")}{signal.raw_score} · RRF {signal.rrf_contribution}
                    </li>
                  ))}
                </ul>
              )}
              {(candidate.allowed_edge_path?.length ?? 0) > 0 && (
                <ol className={styles.compactAuditList} aria-label={uiText("允许的图边路径")}>
                  {candidate.allowed_edge_path!.map((edge, index) => (
                    <li key={`${edge.from}:${edge.relation}:${edge.to}:${index}`}>{edge.from} —{edge.relation}→ {edge.to}</li>
                  ))}
                </ol>
              )}
              {(candidate.rerank?.length ?? 0) > 0 && (
                <ul className={styles.compactAuditList} aria-label={uiText("重排贡献")}>
                  {candidate.rerank.map((entry, index) => (
                    <li key={`${entry.feature}:${index}`}>{entry.feature} · {entry.contribution}</li>
                  ))}
                </ul>
              )}
            </details>
          ))}
        </section>
      )}
      {(payload.slots?.length ?? 0) > 0 && (
        <section className={styles.auditGroup} aria-label={uiText("组装槽位")}>
          <h4>{uiText("槽位")}</h4>
          <ul className={styles.list}>
            {payload.slots!.map((slot) => (
              <li className={styles.row} key={`${slot.slot}:${slot.ordinal}:${slot.record_id}`}>
                <Link className={styles.statementText} to={wikiHref(slot.record_id)}>
                  {slot.slot} #{slot.ordinal} · {slot.record_id}
                </Link>
                <span className={styles.rowMeta}>
                  {slot.chars} {uiText("字符 · 候选 #")}{slot.candidate_rank} {uiText("· 最终")}{slot.final_score} · {slot.reason_codes.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(payload.unknown?.length ?? 0) > 0 && (
        <section className={styles.auditGroup} aria-label={uiText("未知代码")}>
          <h4>{uiText("未知")}</h4>
          <div className={styles.chips}>
            {payload.unknown!.map((unknown, index) => (
              <UiTag key={`${unknown.code}:${unknown.slot ?? ""}:${index}`} tone="warning">
                {unknown.code}{unknown.slot ? ` · ${unknown.slot}` : ""}
              </UiTag>
            ))}
          </div>
        </section>
      )}
      {contextKeys.length > 0 && (
        <section className={styles.auditGroup} aria-label={uiText("上下文记录")}>
          <h4>{uiText("上下文记录")}</h4>
          <div className={styles.chips}>
            {contextKeys.map((entry, index) => {
              const recordId = typeof entry === "string" ? entry : entry.record_id;
              const suffix = typeof entry === "string"
                ? ""
                : ` · ${entry.origin}${entry.slot ? `/${entry.slot}` : ""}${entry.offered_by_trace ? ` · ${entry.offered_by_trace}` : ""}`;
              return <Link className={styles.chip} key={`${recordId}:${index}`} to={wikiHref(recordId)}>{recordId}{suffix}</Link>;
            })}
          </div>
        </section>
      )}
      {(payload.landing_ref || payload.slot || payload.expected_record_id) && (
        <dl className={styles.auditGrid}>
          {payload.landing_ref && (
            <>
              <dt>{uiText("落地坐标")}</dt>
              <dd><code className={styles.digest}>{payload.landing_ref}</code></dd>
            </>
          )}
          {payload.slot && (
            <>
              <dt>{uiText("槽位")}</dt>
              <dd>{payload.slot}</dd>
            </>
          )}
          {payload.expected_record_id && (
            <>
              <dt>{uiText("预期记录")}</dt>
              <dd>{payload.expected_record_id}</dd>
            </>
          )}
        </dl>
      )}
      {(payload.budget || payload.performance) && (
        <dl className={styles.auditGrid}>
          {payload.budget && (
            <>
              <dt>{uiText("字符预算")}</dt>
              <dd>{payload.budget.used_chars}/{payload.budget.limit_chars} {uiText("· 已排除")}{payload.budget.dropped_records}</dd>
            </>
          )}
          {payload.performance && (
            <>
              <dt>{uiText("性能")}</dt>
              <dd>
                {payload.performance.total_ms} ms
                {payload.performance.rss_delta_bytes === undefined ? "" : ` · RSS ${payload.performance.rss_delta_bytes} bytes`}
              </dd>
            </>
          )}
        </dl>
      )}
    </>
  );
}

function RetrievalEventDetails({ event, ordinal }: { event: WikiRetrievalEvent; ordinal: number }) {
  useDashboardLanguage();
  const payload = event.payload ?? {};
  const openByDefault = event.event === "assembled"
    || event.event === "miss"
    || event.event === "error"
    || event.event === "delivered_error"
    || event.event === "abandoned";
  const tone = event.event === "error" || event.event === "abandoned"
    ? "danger"
    : event.event === "miss" || event.event === "delivered_error" ? "warning" : "neutral";
  return (
    <li className={styles.lifecycleItem} data-event-key={event.event_key}>
      <details className={styles.lifecycleEvent} open={openByDefault}>
        <summary className={styles.lifecycleSummary}>
          <span className={styles.lifecycleOrdinal} aria-hidden="true">{ordinal}</span>
          <UiTag tone={tone}>{EVENT_LABEL()[event.event]}</UiTag>
          <span>{event.created_at.slice(0, 19).replace("T", " ")}</span>
          {payload.stage && <span>{payload.stage}</span>}
          {payload.code && <span>{payload.code}</span>}
          {payload.channel && <span>{payload.channel}</span>}
        </summary>
        <div className={styles.eventPayload}>
          <dl className={styles.auditGrid}>
            <dt>{uiText("事件键")}</dt>
            <dd><code className={styles.digest}>{event.event_key}</code></dd>
            <dt>{uiText("时间")}</dt>
            <dd>{event.created_at}</dd>
            {payload.stage && (
              <>
                <dt>{uiText("阶段")}</dt>
                <dd>{payload.stage}</dd>
              </>
            )}
            {payload.code && (
              <>
                <dt>{uiText("代码")}</dt>
                <dd>{payload.code}</dd>
              </>
            )}
            {payload.channel && (
              <>
                <dt>{uiText("交付通道")}</dt>
                <dd>{payload.channel}</dd>
              </>
            )}
          </dl>
          <CandidateDetails event={event} />
        </div>
      </details>
    </li>
  );
}

function RetrievalTraceDetail({
  trace,
  select,
  headingRef,
  canLoadOlder,
  loadingOlder,
  loadOlder,
  loadError,
}: {
  trace: WikiRetrievalTraceDetail;
  select: (id: string) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  loadError: string | null;
}) {
  useDashboardLanguage();
  const tone = trace.outcome === "error" || trace.outcome === "abandoned"
    ? "danger"
    : trace.outcome === "miss" ? "warning" : "neutral";
  const events = [...trace.events].sort((a, b) => {
    const time = a.created_at.localeCompare(b.created_at);
    return time || EVENT_ORDER[a.event] - EVENT_ORDER[b.event] || a.event_key.localeCompare(b.event_key);
  });
  return (
    <section className={styles.section} id={DETAIL_ID} aria-labelledby={`${DETAIL_ID}-title`}>
      <div className={styles.sectionTitle}>
        <h3 id={`${DETAIL_ID}-title`} ref={headingRef} tabIndex={-1}>{trace.trace_id}</h3>
        <UiTag tone={tone}>{trace.outcome}</UiTag>
      </div>
      <div className={styles.rowMeta}>
        <span>{trace.lane}/{trace.purpose}</span>
        <span>{trace.subject_ref}{trace.turn === undefined ? "" : ` · turn ${trace.turn}`}</span>
        {trace.parent_trace_id && (
          <button type="button" className={styles.chip} onClick={() => select(trace.parent_trace_id!)}>
            {uiText("查看父追踪 ")}{trace.parent_trace_id}
          </button>
        )}
      </div>
      <details className={styles.identityDisclosure}>
        <summary>{uiText("绑定与索引身份")}</summary>
        <dl className={styles.auditGrid}>
          <DigestField label={uiText("仓库 SHA")} value={trace.repo_sha} />
          <DigestField label={uiText("图输入指纹")} value={trace.graph_input_fingerprint} />
          <DigestField label={uiText("工作树输入指纹")} value={trace.worktree_input_fingerprint} />
          <DigestField label={uiText("代码索引 SHA")} value={trace.code_index_sha} />
          <DigestField label={uiText("向量索引 SHA")} value={trace.vector_index_sha} />
        </dl>
      </details>
      <p className={styles.paginationStatus}>
        <Status>
          {uiText("已加载 ")}{events.length}/{trace.events_total} {uiText(" 个事件")}{trace.events_has_more ? uiText("；更早的反馈与使用事件尚未加载。") : uiText("；事件已全部加载。")}
        </Status>
      </p>
      <ol className={styles.lifecycle} aria-label={uiText("检索生命周期")}>
        {events.map((event, index) => <RetrievalEventDetails event={event} ordinal={index + 1} key={event.event_key} />)}
      </ol>
      {loadError && <ErrorBox>{loadError}</ErrorBox>}
      {canLoadOlder && (
        <div className={styles.paginationActions}>
          <UiButton loading={loadingOlder} disabled={loadingOlder} onClick={loadOlder}>
            {uiText("加载更早的反馈与使用事件")}</UiButton>
        </div>
      )}
    </section>
  );
}

function RetrievalReviewPanel() {
  useDashboardLanguage();
  const [params, setParams] = useSearchParams();
  const selected = params.get("trace") ?? "";
  const mode = params.get("mode") ?? (selected ? "all" : "tickets");
  const ticket = params.get("ticket") ?? "";
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key); else next.set(key, value);
    }
    setParams(next);
  };
  const validSelected = /^kr_[0-9a-f]{32}$/u.test(selected);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const list = useInfiniteQuery({
    queryKey: ["knowledge", "retrievals", mode, ticket],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "50" });
      if (mode !== "attention") query.set("outcome", "all");
      if (ticket) query.set("ticket_id", ticket);
      if (pageParam) query.set("before", pageParam);
      return api<WikiRetrievalReviewList>(`/api/knowledge/retrievals?${query.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.has_more ? lastPage.next_before ?? null : null,
    enabled: mode !== "tickets",
  });
  const detail = useInfiniteQuery({
    queryKey: ["knowledge", "retrieval", selected],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ id: selected, events_limit: "25" });
      if (pageParam) query.set("events_before", pageParam);
      return api<WikiRetrievalTraceDetail>(`/api/knowledge/retrieval?${query.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.events_has_more ? lastPage.events_next_before ?? null : null,
    enabled: validSelected,
  });
  const listItems = useMemo(() => {
    const byId = new Map<string, WikiRetrievalReviewRow>();
    for (const page of list.data?.pages ?? []) {
      for (const item of page.items) if (!byId.has(item.trace_id)) byId.set(item.trace_id, item);
    }
    return Array.from(byId.values());
  }, [list.data?.pages]);
  const trace = useMemo(() => {
    const pages = detail.data?.pages;
    if (!pages?.length) return null;
    const events = new Map<string, WikiRetrievalEvent>();
    for (const page of pages) {
      for (const event of page.events) if (!events.has(event.event_key)) events.set(event.event_key, event);
    }
    const latestPage = pages[pages.length - 1]!;
    return {
      ...pages[0]!,
      events: Array.from(events.values()),
      events_total: latestPage.events_total,
      events_has_more: latestPage.events_has_more,
      events_next_before: latestPage.events_next_before,
    };
  }, [detail.data?.pages]);
  useEffect(() => {
    if (trace?.trace_id === selected) detailHeadingRef.current?.focus();
  }, [selected, trace?.trace_id]);
  return (
    <>
      <nav className={styles.subnav} aria-label={uiText("追踪范围")}>
        {([["tickets", uiText("按工单观察")], ["all", uiText("全部追踪")], ["attention", uiText("缺失、错误与反馈")]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} className={mode === value ? styles.subnavOn : undefined} onClick={() => update({ mode: value, ticket: null, trace: null })}>{label}</button>)}
      </nav>
      {mode === "tickets" ? <RetrievalTickets select={(id) => update({ mode: "all", ticket: String(id), trace: null })} /> : <>
      <p className={styles.lead}>
        {uiText("显示保留期内的查询追踪；自动注入、主动查询和提交检查分别记录。仅展示脱敏元数据。")}</p>
      {ticket && <p>{uiText("工单 #{v0}", { v0: ticket })} <UiButton size="small" onClick={() => update({ ticket: null, trace: null })}>{uiText("清除工单筛选")}</UiButton></p>}
      {list.isLoading && <Loading what={uiText("读取脱敏检索追踪…")} />}
      {list.isError && <ErrorBox>{errorText(list.error)}</ErrorBox>}
      {selected && !validSelected && <ErrorBox>{uiText("追踪 ID 格式无效。")}</ErrorBox>}
      {validSelected && detail.isLoading && <Loading what={uiText("读取追踪详情…")} />}
      {validSelected && detail.error && !detail.data && <ErrorBox>{errorText(detail.error)}</ErrorBox>}
      {trace && (
        <RetrievalTraceDetail
          trace={trace}
          select={(id) => update({ trace: id })}
          headingRef={detailHeadingRef}
          canLoadOlder={Boolean(detail.hasNextPage)}
          loadingOlder={detail.isFetchingNextPage}
          loadOlder={() => void detail.fetchNextPage()}
          loadError={detail.isFetchNextPageError && detail.error ? errorText(detail.error) : null}
        />
      )}
      <section className={styles.section} aria-labelledby="retrieval-review-list-title">
        <div className={styles.sectionTitle}>
          <h3 id="retrieval-review-list-title">{mode === "attention" ? uiText("待审阅追踪") : uiText("全部追踪")}</h3>
          <span className={styles.count}>{listItems.length}</span>
        </div>
        {list.data && listItems.length === 0
          ? <p className={styles.empty}>{uiText("当前范围没有保留的追踪记录。")}</p>
          : <ul className={styles.list}>{listItems.map((item) => <RetrievalSummary key={item.trace_id} item={item} selected={item.trace_id === selected} select={(id) => update({ trace: id })} />)}</ul>}
        <p className={styles.paginationStatus}>
          <Status>{list.hasNextPage ? uiText("已加载 {v0} 条；还有更早的追踪记录。", { v0: listItems.length }) : uiText("已加载全部 {v0} 条追踪记录。", { v0: listItems.length })}</Status>
        </p>
        {list.isFetchNextPageError && list.error && <ErrorBox>{errorText(list.error)}</ErrorBox>}
        {list.hasNextPage && (
          <div className={styles.paginationActions}>
            <UiButton loading={list.isFetchingNextPage} disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {uiText("加载更早的追踪记录")}</UiButton>
          </div>
        )}
      </section>
      </>}
    </>
  );
}

export function ReviewView({ overview }: { overview: WikiOverview }) {
  useDashboardLanguage();
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("tab");
  const tab: Tab = requestedTab === "ambiguous"
    || requestedTab === "adr"
    || requestedTab === "coverage"
    || requestedTab === "retrieval"
    ? requestedTab
    : "conflicts";
  const [showDismissed, setShowDismissed] = useState(false);
  const query = useQuery<WikiReviewView>({
    queryKey: ["knowledge", "review"],
    queryFn: () => api<WikiReviewView>("/api/knowledge/review"),
  });
  if (query.isLoading) return <Loading what={uiText("读取裁决队列…")} />;
  if (query.error || !query.data) return <ErrorBox>{query.error ? errorText(query.error) : uiText("读取失败")}</ErrorBox>;
  const data = query.data;
  const r = overview.review;
  const tabs: Array<[Tab, string, number]> = [
    ["conflicts", uiText("冲突候选"), r.conflictsOpen],
    ["ambiguous", uiText("歧义记录"), r.ambiguous],
    ["adr", uiText("ADR 状态"), r.adrPlanned + r.adrLegacy],
    ["coverage", uiText("覆盖缺口"), r.unmappedModules + r.emptyCapabilities],
    ["retrieval", uiText("检索追踪"), 0],
  ];
  const conflicts = data.conflicts.filter((item) => showDismissed || item.policy?.blocked || !item.review || item.review.decision === "reopened" || item.review.decision === "confirmed");
  return (
    <>
      <p className={styles.lead}>{uiText("候选需人工裁决；裁决写入审阅台账，知识变更仍通过 Git。")}</p>
      <nav className={styles.subnav} aria-label={uiText("裁决类别")}>
        {tabs.map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? "page" : undefined}
            aria-pressed={tab === id}
            className={tab === id ? styles.subnavOn : undefined}
            onClick={() => setParams({ v: "review", tab: id })}
          >
            {label}
            {count ? <span className={styles.badge}>{count}</span> : null}
          </button>
        ))}
      </nav>
      {tab === "retrieval" && <RetrievalReviewPanel />}
      {tab === "conflicts" && (
        <>
          <div className={styles.actions}>
            <label className={styles.reviewState}>
              <input type="checkbox" checked={showDismissed} onChange={(event) => setShowDismissed(event.target.checked)} /> {uiText(" 显示已忽略 / 已处理（")}{r.conflictsDismissed} {uiText(" 已忽略）")}</label>
          </div>
          <ConflictResolutionWorkspace conflicts={conflicts} />
        </>
      )}
      {tab === "ambiguous" && (
        data.ambiguous.length === 0 ? <p className={styles.empty}>{uiText("没有标为歧义的记录。")}</p> : (
          <ul className={styles.list}>
            {data.ambiguous.map(({ node, review }) => (
              <li key={node.id} className={styles.conflict}>
                <ul className={styles.list}><StatementRow item={node} /></ul>
                {node.detail.conflict_note && <p className={styles.why}>⚠ {node.detail.conflict_note}</p>}
                <div className={styles.actions}>
                  <OpenTicketButton body={`知识库歧义记录需要裁决：${node.id}\n\n陈述：${node.statement}\n来源：${node.source_ref}\n歧义说明：${node.detail.conflict_note ?? ""}\n\n请裁定正确读法并修改 architecture/knowledge/curated 中的该记录（certainty 改为 exact 或删除）。`} />
                </div>
                <DecisionBar subject={node.id} rule="ambiguous" review={review} />
              </li>
            ))}
          </ul>
        )
      )}
      {tab === "adr" && (
        data.adr.length === 0 ? <p className={styles.empty}>{uiText("所有 ADR 都有 frontmatter 且已实现。")}</p> : (
          <ul className={styles.list}>
            {data.adr.map(({ node, legacy }) => (
              <li key={node.id} className={styles.row}>
                <div className={styles.rowChips}>
                  {legacy && <UiTag tone="warning">{uiText("缺 frontmatter")}</UiTag>}
                  {node.status === "proposed" && <UiTag tone="warning">{uiText("提案")}</UiTag>}
                  {node.realization === "planned" && <UiTag tone="info">{uiText("已接受·尚未实施")}</UiTag>}
                  {node.realization === "partial" && <UiTag tone="info">{uiText("部分实施")}</UiTag>}
                </div>
                <Link className={styles.statementText} to={wikiHref(node.id)}>{node.statement}</Link>
                <div className={styles.rowMeta}><span>{node.source_ref}</span></div>
              </li>
            ))}
          </ul>
        )
      )}
      {tab === "coverage" && (
        <>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{uiText("未归入任何能力的模块 ")}<span className={styles.count}>{data.coverage.modulesWithoutCapability.length}</span></h3>
            <p className={styles.empty}>{uiText("这些模块的改动拿不到能力级的原则与决策；在 architecture/capabilities.json 里把它们归入能力。")}</p>
            <div className={styles.chips}>
              {data.coverage.modulesWithoutCapability.map((id) => <Link key={id} className={styles.chip} to={`/knowledge?v=module&id=${encodeURIComponent(id)}`}>{id}</Link>)}
            </div>
          </section>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{uiText("没有结构化记录的能力 ")}<span className={styles.count}>{data.coverage.emptyCapabilities.length}</span></h3>
            <div className={styles.chips}>
              {data.coverage.emptyCapabilities.map((id) => <Link key={id} className={styles.chip} to={`/knowledge?v=capability&id=${encodeURIComponent(id)}`}>{id}</Link>)}
            </div>
          </section>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{uiText("没有任何知识指向的工单 ")}<span className={styles.count}>{data.coverage.ticketsWithoutKnowledge.count}</span></h3>
            <p className={styles.empty}>{uiText("大多是 CI 修复票或简报已入图的 CLI 票；最近 30 张：")}{data.coverage.ticketsWithoutKnowledge.sample.map((id) => `#${id}`).join(" ")}</p>
          </section>
        </>
      )}
    </>
  );
}
