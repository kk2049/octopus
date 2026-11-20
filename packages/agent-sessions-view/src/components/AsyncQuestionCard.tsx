import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { TranscriptWindow } from "@claude-bot/agent-sessions-contract";
import { AvButton } from "@claude-bot/agent-view-react/ui";
import { sendPhaseWord } from "@claude-bot/chat-ui-commons/transcript-ui";
import type { PendingSend } from "../controller.js";
import type { ComposerDraftPersistence } from "../composer-drafts.js";
import { asyncAnswerMarker, asyncAnswerPrompt, collectAsyncQuestions, type AsyncQuestionRequest } from "../lib/async-questions.js";
import { InteractionQuestion } from "./AgentInteractionCard.js";

// Preferences are bounded display state; they never alter transcript evidence.
function ignoredIds(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(-128) : [];
  } catch { return []; }
}

export function AsyncQuestions(props: {
  scope: string;
  resource?: string;
  persistence?: ComposerDraftPersistence;
  transcript: TranscriptWindow | null;
  canSend: boolean;
  pendingSends?: readonly PendingSend[];
  onSend(prompt: string): void;
}) {
  const requests = useMemo(() => collectAsyncQuestions(props.transcript), [props.transcript]);
  const resource = props.resource ?? props.scope;
  const { persistence } = props;
  const [local, setLocal] = useState({ resource, text: "" });
  const subscribe = useCallback((listener: () => void) => persistence?.subscribe(resource, listener) ?? (() => {}), [persistence, resource]);
  const snapshot = useCallback(() => persistence?.get(resource).text ?? "", [persistence, resource]);
  const saved = useSyncExternalStore(subscribe, snapshot, snapshot);
  const ignored = useMemo(() => new Set([...ignoredIds(saved),
    ...ignoredIds(local.resource === resource ? local.text : "")]), [saved, local, resource]);
  const [limit, setLimit] = useState(12);
  const [open, setOpen] = useState<boolean>();
  const [notice, setNotice] = useState("");
  if (!requests.length) return null;
  const pending = requests.filter((request) => !request.answered && !ignored.has(request.id));
  const answered = requests.filter((request) => request.answered);
  const dismissed = requests.filter((request) => !request.answered && ignored.has(request.id));
  const ignore = (id: string): void => {
    const ids = [...new Set([...ignored, ...ignoredIds(snapshot()), id])].slice(-128);
    // Stay below the existing browser preference transport's text budget.
    while (JSON.stringify(ids).length > 60_000) ids.shift();
    const text = JSON.stringify(ids);
    setLocal({ resource, text });
    try { persistence?.set(resource, text); }
    catch { setNotice("忽略状态仅在当前页面保留，刷新页面后可能需要重新忽略。"); }
  };
  return <details className="async-questions" open={open ?? pending.length > 0}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>异步问题 · {pending.length} 组未确认</summary>
    <p>仅检查已加载的记录；更早的问题可向上滚动加载。外部普通回复不会自动标记为已回答。</p>
    {notice ? <p role="status">{notice}</p> : null}
    <div className="async-questions-list">
      {pending.slice(-limit).reverse().map((request) => <AsyncQuestionCard key={request.id} request={request}
        scope={props.scope} canSend={props.canSend} pendingSends={props.pendingSends} onSend={props.onSend}
        onIgnore={() => ignore(request.id)} />)}
      {pending.length > limit ? <AvButton onClick={() => setLimit((value) => value + 12)}>显示更早的问题</AvButton> : null}
      {answered.length ? <details><summary>已回答 · {answered.length} 组</summary>
        {answered.map((request) => <AsyncQuestionCard key={request.id} request={request}
          scope={props.scope} canSend={false} onSend={props.onSend} />)}
      </details> : null}
      {dismissed.length ? <details><summary>已忽略 · {dismissed.length} 组</summary>
        {dismissed.map((request) => <AsyncQuestionCard key={request.id} request={request} ignored
          scope={props.scope} canSend={false} onSend={props.onSend} />)}
      </details> : null}
    </div>
  </details>;
}

/** An asynchronous question is ordinary input, not a blocking broker request. */
export function AsyncQuestionCard({ request, scope = "", canSend, pendingSends, onSend, ignored = false, onIgnore }: {
  request: AsyncQuestionRequest;
  scope?: string;
  canSend: boolean;
  pendingSends?: readonly PendingSend[];
  onSend(prompt: string): void;
  ignored?: boolean;
  onIgnore?(): void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [previousReceiptKey, setPreviousReceiptKey] = useState<string | undefined>();
  const [error, setError] = useState("");
  const marker = `${asyncAnswerMarker(request.id)}\n`;
  const latestReceipt = [...(pendingSends ?? [])].reverse().find((entry) => entry.prompt.startsWith(marker));
  const receipt = attempted && latestReceipt?.key === previousReceiptKey ? undefined : latestReceipt;
  const failed = receipt?.phase === "failed" || receipt?.phase === "refused";
  const locked = request.answered || ignored || Boolean((attempted || receipt) && !failed);
  const delivered = receipt?.input?.phase === "input_observed" || receipt?.input?.phase === "provider_accepted";
  const send = (): void => {
    if (!canSend || locked || request.error) return;
    const answers: Record<string, string[]> = {};
    for (const question of request.questions) {
      const id = String(question.id);
      const value = (other[id] ?? "").trim();
      answers[id] = value ? [value] : selected[id] ?? [];
      if (!answers[id].length) { setError(`请回答「${question.header}」`); return; }
    }
    setError("");
    setPreviousReceiptKey(latestReceipt?.key);
    setAttempted(true);
    try { onSend(asyncAnswerPrompt(request, answers)); }
    catch { setError("发送结果未确认，请先核对会话记录；不会自动重发。"); }
  };
  const summary = request.answered ? "已回答 · 会话记录已确认"
    : ignored ? "已忽略"
    : delivered ? "回答已被 Agent 接收"
    : receipt ? sendPhaseWord(receipt)
    : attempted ? "回答发送结果待确认"
    : request.laterUserMessage ? "回答状态未确认" : "尚未发现回答";
  return <section className="agent-interaction-card" data-av-async-question={request.id}
    data-av-async-question-state={request.answered ? "answered" : ignored ? "ignored" : locked ? "submitted" : "unconfirmed"}>
    <div className="agent-interaction-head"><h3>Codex 异步提问</h3><span role="status">{summary}</span></div>
    {request.answered || ignored || delivered ? <details><summary>查看问题</summary>
      {request.questions.map((question) => <p key={question.id}>{question.prompt}</p>)}
    </details> : <>
      {request.laterUserMessage ? <p>提问后有新消息，无法确认是否已在其它入口回答。</p> : null}
      {request.error ? <p role="alert">{request.error}</p> : request.questions.map((question) => <InteractionQuestion
        key={question.id} interactionId={`async-${scope}-${request.id}`} question={question}
        selected={selected[String(question.id)] ?? []} other={other[String(question.id)] ?? ""}
        busy={locked || !canSend}
        onSelected={(values) => setSelected((before) => ({ ...before, [String(question.id)]: values }))}
        onOther={(value) => {
          setOther((before) => ({ ...before, [String(question.id)]: value }));
          if (value) setSelected((before) => ({ ...before, [String(question.id)]: [] }));
        }} />)}
      {!canSend ? <p>当前会话不能直接发送回答，请使用原会话或已有的显式接管入口。</p> : null}
      {locked ? <p>回答沿会话输入通道发送；等待确认期间不会重复发送。</p> : null}
      {receipt?.message ? <p role={failed ? "alert" : "status"}>{receipt.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <AvButton tone="primary" disabled={!canSend || locked || Boolean(request.error)} onClick={send}>发送回答</AvButton>
    </>}
    {!request.answered && !ignored && onIgnore ? <AvButton onClick={onIgnore}>忽略</AvButton> : null}
  </section>;
}
