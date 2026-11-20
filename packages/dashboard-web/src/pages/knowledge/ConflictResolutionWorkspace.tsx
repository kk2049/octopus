import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText, localizedLabels } from "../../i18n/ui-text.js";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { bootstrap } from "../../lib/bootstrap.js";
import { ApiError, api, errorText } from "../../lib/api.js";
import { useBrowserDraft } from "../../lib/browser-drafts-react.js";
import { pollInterval } from "../../lib/query.js";
import { ErrorBox, Loading, Status } from "../../ui/misc.js";
import { Confirm } from "../../ui/Dialog.js";
import { UiButton, UiTextArea } from "../../ui-kit/primitives.js";
import styles from "../KnowledgePage.module.css";
import { StatementRow } from "./StatementList.js";
import { EvidenceDetails } from "./EvidenceDetails.js";
import { KnowledgeSessionPanel } from "./KnowledgeSessionPanel.js";
import { DECISION_LABEL, RULE_LABEL, reviewNoteText, type WikiConflict, type WikiConflictWorkspace } from "./types.js";

const RESOLUTION_INTENTS = localizedLabels(() => ([
  { value: "modify", label: uiText("修改现有知识"), body: "处理意图：修改现有知识，使它符合当前有效的用户要求。" },
  { value: "reject", label: uiText("保留现有知识并拒绝新要求"), body: "处理意图：保留现有知识，并把相冲突的新要求记录为已拒绝或已取代。" },
  { value: "close", label: uiText("关闭现有知识"), body: "处理意图：关闭不再有效的现有知识，并保留来源与取代依据。" },
] as const));


function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void): void {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  submit();
}

function ConflictDetail({ conflict, terminal }: { conflict: WikiConflict; terminal: boolean }) {
  useDashboardLanguage();
  return (
    <section className={styles.conflictDecision} aria-labelledby="conflict-object-heading">
      <div className={styles.conflictHead}>
        <span className={styles.conflictEyebrow}>{uiText("冲突对象")}</span>
        <span className={styles.reviewState}>{conflict.policy?.blocked ? uiText("上线前须管理员裁决") : uiText("知识提示，不阻止上线")}</span>
      </div>
      <h2 id="conflict-object-heading" className={styles.conflictObject}>
        {conflict.object?.statement ?? conflict.a?.statement ?? uiText("对象记录缺失")}
      </h2>
      <p className={styles.conflictQuestion}>{conflict.explanation}</p>
      {terminal ? <Status kind="ok">{uiText("该冲突已关闭；来源、批注和历史对话保持只读。")}</Status> : null}
      <div className={styles.sides} aria-label={uiText("对立内容")}>
        <section className={styles.side}>
          <div className={styles.sideLabel}>{uiText("一方这样规定")}</div>
          {conflict.a ? <ul className={styles.list}><StatementRow item={conflict.a} compact /></ul> : <p className={styles.empty}>{uiText("原始记录缺失")}</p>}
          {conflict.a && <EvidenceDetails item={conflict.a} />}
        </section>
        <section className={styles.side}>
          <div className={styles.sideLabel}>{uiText("另一方这样要求")}</div>
          {conflict.b ? <ul className={styles.list}><StatementRow item={conflict.b} compact /></ul> : <p className={styles.empty}>{uiText("没有第二条记录")}</p>}
          {conflict.b && <EvidenceDetails item={conflict.b} />}
        </section>
      </div>
      {conflict.policy?.investigation ? <dl className={styles.investigation}>
        <dt>{uiText("原设计要保护什么")}</dt><dd>{conflict.policy.investigation.original_motivation}</dd>
        <dt>{uiText("新任务为什么需要调整")}</dt><dd>{conflict.policy.investigation.proposed_motivation}</dd>
        <dt>{uiText("拟采用的行为")}</dt><dd>{conflict.policy.investigation.proposed_behavior}</dd>
        <dt>{uiText("考虑过的替代方案")}</dt><dd>{conflict.policy.investigation.alternatives}</dd>
        <dt>{uiText("影响与代价")}</dt><dd>{conflict.policy.investigation.impact}</dd>
        <dt>{uiText("验证依据")}</dt><dd>{conflict.policy.investigation.verification}</dd>
      </dl> : <p className={styles.why}>{uiText("调查尚未齐备：Agent 需核对两边原始动机、代码和测试，再给出妥协方案、影响与验证。")}</p>}
      <details className={styles.conflictEvidence}>
        <summary>{RULE_LABEL()[conflict.rule] ?? conflict.rule} {uiText(" · 查看检测证据")}</summary>
        <p>{conflict.why}</p>
        <code>{conflict.id}</code>
      </details>
    </section>
  );
}

export function ConflictCard({ item }: { item: WikiConflict }) {
  useDashboardLanguage();
  const terminal = item.review?.decision === "dismissed" || item.review?.decision === "resolved";
  return (
    <article className={styles.conflict} data-conflict-id={item.id}>
      <ConflictDetail conflict={item} terminal={terminal} />
    </article>
  );
}

function AnnotationPanel({ subject, workspace }: { subject: string; workspace: WikiConflictWorkspace }) {
  useDashboardLanguage();
  const client = useQueryClient();
  const annotationDraft = useBrowserDraft(`knowledge:conflict-annotation:${subject}`);
  const [intents, setIntents] = useState<Record<string, string>>({});
  const draft = annotationDraft.text;
  useEffect(() => {
    if (workspace.terminal) annotationDraft.clear();
  }, [annotationDraft, workspace.terminal]);
  const save = useMutation({
    mutationFn: () => api("/api/knowledge/conflict/annotate", {
      method: "POST",
      json: { subject_id: subject, body: draft.trim() },
    }),
    onMutate: () => annotationDraft.beginSubmission(),
    onSuccess: async (_response, _variables, submission) => {
      annotationDraft.completeSubmission(submission ?? null);
      setIntents((current) => ({ ...current, [subject]: "" }));
      await client.invalidateQueries({ queryKey: ["knowledge", "conflict", subject] });
    },
    onError: (error, _variables, submission) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        annotationDraft.restoreSubmission(submission ?? null);
      }
    },
  });
  const submit = () => {
    if (!draft.trim() || save.isPending || workspace.terminal) return;
    save.mutate();
  };
  return (
    <section className={styles.annotationPanel} aria-labelledby="conflict-annotations-heading">
      <div className={styles.annotationHead}>
        <h3 id="conflict-annotations-heading">{uiText("用户批注")}</h3>
        <span>{workspace.annotations.length} {uiText(" 条已保存")}</span>
      </div>
      {workspace.annotations.length ? (
        <ol className={styles.annotationList}>
          {workspace.annotations.map((annotation) => (
            <li key={annotation.id}>
              <div><b>{annotation.actor}</b><time dateTime={annotation.at}>{annotation.at.slice(0, 16).replace("T", " ")}</time></div>
              <p>{annotation.body}</p>
            </li>
          ))}
        </ol>
      ) : <p className={styles.empty}>{uiText("还没有批注。Agent 只会读取保存后的内容。")}</p>}
      <div className={styles.resolutionOptions} role="group" aria-label={uiText("处理意图")}>
        {RESOLUTION_INTENTS().map((intent) => (
          <button
            type="button"
            key={intent.value}
            aria-pressed={intents[subject] === intent.value}
            disabled={workspace.terminal}
            onClick={() => {
              setIntents((current) => ({ ...current, [subject]: intent.value }));
              annotationDraft.set(intent.body);
            }}
          >
            {intent.label}
          </button>
        ))}
      </div>
      <label className="srOnly" htmlFor="knowledge-conflict-annotation">{uiText("写批注")}</label>
      <UiTextArea
        id="knowledge-conflict-annotation"
        value={draft}
        disabled={workspace.terminal}
        autoSize={{ minRows: 2, maxRows: 5 }}
        placeholder={workspace.terminal ? uiText("冲突已关闭") : uiText("写下意图或问题；Enter 保存，Shift+Enter 换行")}
        onChange={(event) => {
          setIntents((current) => ({ ...current, [subject]: "" }));
          annotationDraft.set(event.target.value);
        }}
        onKeyDown={(event) => submitOnEnter(event, submit)}
      />
      <div className={styles.annotationActions}>
        <span>{uiText("未保存文字不会进入 Agent 上下文。")}</span>
        <UiButton className="primary" disabled={!draft.trim() || save.isPending || workspace.terminal} onClick={submit}>
          {save.isPending ? uiText("保存中…") : uiText("保存批注")}
        </UiButton>
      </div>
      {save.error ? <Status kind="err">{errorText(save.error)}{uiText("；批注仍保留，可重试。")}</Status> : null}
    </section>
  );
}

function ReviewChange({ subject, workspace }: { subject: string; workspace: WikiConflictWorkspace }) {
  useDashboardLanguage();
  const client = useQueryClient();
  const draft = useBrowserDraft(`knowledge:design-review:${subject}`);
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: (decision: string) => api("/api/knowledge/review/decide", { method: "POST", json: {
      subject_id: subject, decision, note: draft.text.trim(), fingerprint: workspace.conflict?.policy?.fingerprint,
    } }),
    onSuccess: async () => {
      draft.clear();
      setConfirming(false);
      await client.invalidateQueries({ queryKey: ["knowledge"] });
    },
    onError: () => setConfirming(false),
  });
  const investigated = Boolean(workspace.conflict?.policy?.investigation);
  return <section className={styles.annotationPanel}>
    <h3>{uiText("审阅与处理记录")}</h3>
    <p>{uiText("提问、收到和同意查看只记录历史。批准修改是一次明确确认，可附说明；它不会自动提高知识的证据等级。")}</p>
    <UiTextArea aria-label={uiText("审阅说明（可选）")} value={draft.text} onChange={(event) => draft.set(event.target.value)}
      placeholder={uiText("可选：写下审阅说明或理由，会随记录保存。")}
      disabled={save.isPending} autoSize={{ minRows: 3, maxRows: 8 }} />
    <div className={styles.actions}>
      {bootstrap.viewer?.admin && workspace.conflict && <UiButton disabled={save.isPending || !investigated} loading={save.isPending}
        onClick={() => setConfirming(true)}>{uiText("批准此修改…")}</UiButton>}
      <UiButton disabled={save.isPending} onClick={() => save.mutate("confirmed")}>{uiText("确认存在冲突")}</UiButton>
      <UiButton disabled={save.isPending || workspace.conflict?.policy?.blocked} onClick={() => save.mutate("dismissed")}>{uiText("忽略误报")}</UiButton>
      {workspace.review && <UiButton disabled={save.isPending} onClick={() => save.mutate("reopened")}>{uiText("重新打开")}</UiButton>}
    </div>
    {bootstrap.viewer?.admin && workspace.conflict && !investigated
      ? <p className={styles.why}>{uiText("还不能批准：需先由 Agent 提交完整调查（两边动机、修改、代价与验证）。")}</p> : null}
    {save.error && <ErrorBox>{errorText(save.error)}</ErrorBox>}
    {save.isSuccess && <Status kind="ok">{uiText("审阅记录已保存")}</Status>}
    <Confirm
      open={confirming}
      title={uiText("批准此修改？")}
      confirmLabel={uiText("确认批准")}
      busy={save.isPending}
      body={draft.text.trim()
        ? uiText("批准后此冲突不再阻止上线，记录写明由你批准，并附上你填写的说明。")
        : uiText("批准后此冲突不再阻止上线，记录写明由你批准。未填写说明，也可以直接批准。")}
      onConfirm={() => save.mutate("approved_change")}
      onCancel={() => setConfirming(false)}
    />
    <ol className={styles.annotationList}>{workspace.history?.map((entry, index) => <li key={`${entry.at}:${index}`}>
      <b>{entry.actor}</b> · <time dateTime={entry.at}>{entry.at.slice(0, 16).replace("T", " ")}</time> · {DECISION_LABEL()[entry.decision] ?? entry.decision}<p>{reviewNoteText(entry.note)}</p>
    </li>)}</ol>
  </section>;
}

export function ConflictResolutionWorkspace({ conflicts }: { conflicts: WikiConflict[] }) {
  useDashboardLanguage();
  const [params, setParams] = useSearchParams();
  const canCollaborate = Boolean(bootstrap.viewer?.dev || bootstrap.viewer?.admin);
  const requested = params.get("conflict") ?? "";
  const selectedFromList = requested ? conflicts.find((conflict) => conflict.id === requested) ?? null : conflicts[0] ?? null;
  const subject = requested || selectedFromList?.id || "";
  const workspace = useQuery<WikiConflictWorkspace>({
    queryKey: ["knowledge", "conflict", subject],
    enabled: Boolean(subject && canCollaborate),
    queryFn: () => api(`/api/knowledge/conflict?subject=${encodeURIComponent(subject)}`),
    refetchInterval: pollInterval("/api/knowledge", 5000),
    refetchIntervalInBackground: false,
  });
  const conflict = workspace.data?.conflict ?? selectedFromList;

  if (!subject) {
    return <p className={styles.empty}>{uiText("没有待裁决的冲突候选。")}</p>;
  }
  if (!conflict && workspace.isLoading) {
    return <Loading what={uiText("读取已关闭冲突…")} />;
  }
  if (!conflict && !workspace.data) {
    return workspace.error
      ? <ErrorBox>{errorText(workspace.error)}</ErrorBox>
      : <p className={styles.empty}>{uiText("没有待裁决的冲突候选。")}</p>;
  }
  return (
    <>
      <section className={`${styles.conflictWorkspace} ${canCollaborate ? styles.conflictWorkspaceWithAgent : ""}`}>
        <nav className={styles.conflictQueue} aria-label={uiText("冲突候选")}>
          {conflicts.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-current={item.id === subject ? "true" : undefined}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("conflict", item.id);
                next.delete("chat");
                setParams(next, { replace: true });
              }}
            >
              <b>{item.a?.statement ?? item.object?.statement ?? RULE_LABEL()[item.rule] ?? item.rule}</b>
              <span>{item.b?.statement ?? item.explanation}</span>
              <span>{item.policy?.blocked ? uiText("上线前须管理员裁决") : uiText("知识提示，不阻止上线")}</span>
            </button>
          ))}
        </nav>
        <div className={styles.conflictMain}>
          {conflict ? (
            <>
              <ConflictDetail conflict={conflict} terminal={workspace.data?.terminal ?? false} />
              {!workspace.data?.terminal ? (
                <Link
                  className={styles.knowledgeChatLink}
                  to={`/knowledge?v=chat&chat=new&subject=${encodeURIComponent(subject)}`}
                >
                  {uiText("在知识 Chat 中讨论")}</Link>
              ) : null}
            </>
          ) : (
            <section className={styles.conflictDecision} aria-labelledby="conflict-object-heading">
              <span className={styles.conflictEyebrow}>{uiText("已关闭冲突")}</span>
              <h2 id="conflict-object-heading" className={styles.conflictObject}>{subject}</h2>
              <Status kind="ok">{uiText("候选已退出当前知识图；保存的批注和历史对话保持只读。")}</Status>
            </section>
          )}
          {!canCollaborate ? (
            <Status kind="muted">{uiText("批注与 Agent 协作需要开发权限；冲突内容仍可阅读。")}</Status>
          ) : workspace.isLoading ? <Loading what={uiText("读取批注…")} /> : workspace.error ? <ErrorBox>{errorText(workspace.error)}</ErrorBox> : workspace.data ? (
            <AnnotationPanel subject={subject} workspace={workspace.data} />
          ) : null}
          {workspace.data && <ReviewChange key={subject} subject={subject} workspace={workspace.data} />}
        </div>
        {canCollaborate && <KnowledgeSessionPanel workspace={workspace.data} />}
      </section>
    </>
  );
}
