import { useEffect, useState } from "react";
import { AvButton, AvCheckbox, AvInput } from "@claude-bot/agent-view-react/ui";
import type {
  AgentInteraction,
  AgentInteractionResponse,
  AgentInteractionQuestion,
} from "@claude-bot/agent-sessions-contract";
import { cliKindLabel } from "../lib/cli.js";
import { interactionReceiptResponse } from "../lib/interaction.js";

export interface AgentInteractionCardProps {
  interaction: AgentInteraction;
  onRespond(response: AgentInteractionResponse): Promise<void>;
  /** A previously accepted response makes this instance a non-actionable receipt. */
  resolvedResponse?: AgentInteractionResponse;
}

/** Provider-neutral question/permission card for the isolated Agent View. */
export function AgentInteractionCard({ interaction, onRespond, resolvedResponse }: AgentInteractionCardProps) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState<AgentInteractionResponse | null>(null);
  const interactionId = String(interaction.id ?? "");

  useEffect(() => {
    setSelected({});
    setOther({});
    setMessage("");
    setBusy(false);
    setError("");
    setSubmitted(null);
  }, [interactionId]);

  const questions = (interaction.questions ?? []).filter((question) => Boolean(question.id && question.prompt));
  const respond = async (decision: "allow" | "deny"): Promise<void> => {
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
      const id = String(question.id);
      const typed = (other[id] ?? "").trim();
      const values = question.multiple
        ? [...(selected[id] ?? []), ...(typed ? [typed] : [])]
        : typed ? [typed] : (selected[id] ?? []).slice(0, 1);
      if (decision === "allow" && values.length === 0) {
        setError(`请回答「${question.header || question.prompt}」`);
        return;
      }
      answers[id] = values;
    }
    setBusy(true);
    setError("");
    try {
      const response: AgentInteractionResponse = {
        decision,
        answers,
        ...(message.trim() ? { message: message.trim() } : {}),
      };
      await onRespond(response);
      setSubmitted(interactionReceiptResponse(interaction, response));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const resolved = submitted ?? resolvedResponse ?? null;
  const projectedResolution = interaction.status === "resolved" ? interaction.resolution : undefined;
  if (resolved || projectedResolution) {
    const answer = resolved ? Object.values(resolved.answers).flat().filter(Boolean).join("、") : "";
    const decision = resolved?.decision ?? projectedResolution?.decision;
    const summary = projectedResolution?.summary
      ? projectedResolution.summary
      : interaction.kind === "question"
        ? decision === "allow"
          ? `已提交：${answer || "回答"}`
          : "已拒绝回答"
        : decision === "allow"
          ? "已允许一次，Agent 正在继续"
          : "已拒绝，Agent 正在继续";
    return (
      <section
        className="agent-interaction-card agent-interaction-card-resolved"
        data-av-agent-interaction={interactionId}
        data-agent-interaction={interactionId}
        data-agent-interaction-state="resolved"
        aria-live="polite"
      >
        <div className="agent-interaction-head">
          <div className="agent-interaction-resolved-title">
            <span className="agent-interaction-provider">
              {cliKindLabel(interaction.provider)}
            </span>
            {interaction.tool ? <code>{interaction.tool}</code> : null}
            <span>{summary}</span>
          </div>
          <span className="agent-interaction-resolved-badge">已处理</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className="agent-interaction-card"
      data-av-agent-interaction={interactionId}
      data-agent-interaction={interactionId}
      aria-labelledby={`agent-interaction-${interactionId}`}
    >
      <div className="agent-interaction-head">
        <div>
          <span className="agent-interaction-provider">
            {cliKindLabel(interaction.provider)}
          </span>
          <h3 id={`agent-interaction-${interactionId}`}>{interaction.title || "Agent 请求"}</h3>
        </div>
        <span className="agent-interaction-waiting">等待你的操作</span>
      </div>
      {interaction.description ? <p className="agent-interaction-description">{interaction.description}</p> : null}
      {interaction.tool ? <div className="agent-interaction-tool">工具：<code>{interaction.tool}</code></div> : null}

      {questions.map((question) => (
        <InteractionQuestion
          key={String(question.id)}
          interactionId={interactionId}
          question={question}
          selected={selected[String(question.id)] ?? []}
          other={other[String(question.id)] ?? ""}
          busy={busy}
          onSelected={(values) => setSelected((before) => ({ ...before, [String(question.id)]: values }))}
          onOther={(value) => {
            setOther((before) => ({ ...before, [String(question.id)]: value }));
            if (!question.multiple && value) {
              setSelected((before) => ({ ...before, [String(question.id)]: [] }));
            }
          }}
        />
      ))}

      {interaction.detail ? (
        <details className="agent-interaction-detail">
          <summary>查看请求详情</summary>
          <pre>{interaction.detail}</pre>
        </details>
      ) : null}
      <label className="agent-interaction-message">
        {interaction.kind === "permission" ? "拒绝原因（可选）" : "附言（可选）"}
        <AvInput value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} />
      </label>
      {error ? <div className="agent-interaction-error" role="alert">{error}</div> : null}
      <div className="agent-interaction-actions">
        <AvButton
          disabled={busy || interaction.capabilities?.respond !== true || interaction.capabilities?.deny !== true}
          onClick={() => void respond("deny")}
        >
          拒绝
        </AvButton>
        <AvButton
          tone="primary"
          disabled={busy || interaction.capabilities?.respond !== true || interaction.capabilities?.allow !== true}
          onClick={() => void respond("allow")}
        >
          {interaction.kind === "question" ? "提交回答并继续" : "允许一次并继续"}
        </AvButton>
      </div>
    </section>
  );
}

export function InteractionQuestion(props: {
  interactionId: string;
  question: AgentInteractionQuestion;
  selected: string[];
  other: string;
  busy: boolean;
  onSelected(values: string[]): void;
  onOther(value: string): void;
}) {
  const id = String(props.question.id);
  const choose = (label: string, checked: boolean): void => {
    props.onOther("");
    const values = props.question.multiple
      ? checked
        ? [...props.selected.filter((value) => value !== label), label]
        : props.selected.filter((value) => value !== label)
      : checked ? [label] : [];
    props.onSelected(values);
  };
  return (
    <fieldset className="agent-interaction-question">
      <legend>{props.question.header || "问题"}</legend>
      <p>{props.question.prompt}</p>
      <div className="agent-interaction-options">
        {(props.question.options ?? []).map((option) => {
          const label = String(option.label ?? "");
          if (!label) return null;
          const checked = props.selected.includes(label);
          const content = (
            <span>
              <b>{label}</b>
              {option.description ? <small>{option.description}</small> : null}
            </span>
          );
          return props.question.multiple ? (
            <AvCheckbox
              key={label}
              className="agent-interaction-option"
              checked={checked}
              disabled={props.busy}
              onChange={(event) => choose(label, event.target.checked)}
            >
              {content}
            </AvCheckbox>
          ) : (
            <label key={label} className="agent-interaction-option">
              <input
                type="radio"
                name={`agent-question-${props.interactionId}-${id}`}
                checked={checked}
                disabled={props.busy}
                onChange={(event) => choose(label, event.target.checked)}
              />
              {content}
            </label>
          );
        })}
      </div>
      {props.question.allow_other !== false || (props.question.options ?? []).length === 0 ? (
        <label className="agent-interaction-other">
          {(props.question.options ?? []).length ? "其他回答" : "回答"}
          <AvInput
            type={props.question.secret ? "password" : "text"}
            autoComplete="off"
            value={props.other}
            disabled={props.busy}
            onChange={(event) => props.onOther(event.target.value)}
          />
        </label>
      ) : null}
    </fieldset>
  );
}
