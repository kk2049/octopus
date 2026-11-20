import { uiText } from "../../i18n/ui-text.js";
import { UiButton, UiSelect, UiTextArea } from "../../ui-kit/primitives.js";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { handleModifierSubmitKeyDown } from "@claude-bot/chat-ui-commons/composer";
import { useCompactChatViewport } from "@claude-bot/chat-ui-commons/composer-react";
import { ApiError, api, errorText } from "../../lib/api.js";
import { useBrowserDraft } from "../../lib/browser-drafts-react.js";
import { AttachmentStrip, useAttachments } from "../../ui/Attachments.js";
import styles from "../TicketsPage.module.css";
import { ticketModelLabel, ticketModelSource, type Roster } from "./model.js";
import { bootstrap } from "../../lib/bootstrap.js";
import { TicketExecutionFields, useTicketExecution } from "../../ui/TicketExecutionFields.js";
import { useMessages } from "../../i18n/react.js";

interface NewTicketForm {
  body: string;
  model: string;
  effort: string;
  requester: string;
}

/** Pick a valid value when async roster options arrive after the form mounts. */
function hydratedChoice(current: string, options: readonly string[], preferred?: string): string | null {
  if (!options.length || options.includes(current)) return null;
  return preferred && options.includes(preferred) ? preferred : options[0]!;
}

/**
 * The filing form lives in the MAIN pane, not the 340px sidebar: a ticket body
 * is the whole brief the agent gets, and people write it long.
 *
 * The server assigns a temporary title and the ticket agent replaces it through
 * `devpipe_rename` once it has read the request. Asking the user for a title here
 * duplicated that work and produced worse list labels.
 */
export function NewTicketPane({
  roster,
  onCancel,
  onCreated,
}: {
  roster: Roster | undefined;
  onCancel: () => void;
  onCreated: (id: number) => Promise<void>;
}) {
  const { t } = useMessages();
  const choices = roster?.requester_choices ?? [];
  const modelDefault = roster?.model_default;
  const effortDefault = roster?.effort_default;
  const compact = useCompactChatViewport();
  const bodyDraft = useBrowserDraft("tickets:new-ticket");
  const {
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
    setError,
    setValue,
    getValues,
    watch,
  } = useForm<NewTicketForm>({
    defaultValues: {
      body: bodyDraft.text,
      model: modelDefault && roster?.models?.includes(modelDefault) ? modelDefault : (roster?.models?.[0] ?? ""),
      effort: effortDefault && roster?.efforts?.includes(effortDefault) ? effortDefault : (roster?.efforts?.[0] ?? ""),
      requester: choices[0] ?? "",
    },
    shouldFocusError: true,
  });
  const owner = choices.length ? watch("requester") : bootstrap.viewer.username ?? "";
  const execution = useTicketExecution(roster?.execution_choices?.[owner], ticketModelSource(roster?.model_catalog, watch("model")), owner);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Ticket #201: paste the screenshot instead of describing it. The refs are
  // composed at submit time from the chips still on the draft.
  const attachments = useAttachments(owner);
  const executionKey = JSON.stringify([owner, watch("model"), watch("effort"), execution.payload]);
  const latestExecution = useRef(executionKey);
  latestExecution.current = executionKey;

  // Cross-tab storage changes are uncommon, but when one arrives the form and
  // the cache must move together. Ordinary local edits update both in the
  // Controller below, so this effect is a no-op on the hot typing path.
  useEffect(() => {
    if (getValues("body") !== bodyDraft.text) setValue("body", bodyDraft.text);
  }, [bodyDraft.text, getValues, setValue]);

  // The composer can be opened while `/api/tickets` is still in flight.
  // react-hook-form reads `defaultValues` only once, so without this hydration
  // the Ant Select options later become correct while their trigger keeps an
  // empty value. Only empty/unsupported fields move; a user's valid choice is
  // never overwritten by a roster refresh.
  useEffect(() => {
    const model = hydratedChoice(getValues("model"), roster?.models ?? [], modelDefault);
    const effort = hydratedChoice(getValues("effort"), roster?.efforts ?? [], effortDefault);
    const requester = hydratedChoice(getValues("requester"), choices);
    if (model) setValue("model", model);
    if (effort) setValue("effort", effort);
    if (requester) setValue("requester", requester);
  }, [choices, effortDefault, getValues, modelDefault, roster?.efforts, roster?.models, setValue]);

  const onSubmit = handleSubmit(async (values) => {
    if (!roster || !execution.ready) { setFailure(uiText("来源或工作区暂不可用，请选择可用组合。")); return; }
    setFailure(null);
    setNotice(null);
    try {
      await attachments.ready();
      if (latestExecution.current !== executionKey) throw new Error(uiText("执行选择已变化，请重新发送。"));
    } catch (err) {
      setFailure(errorText(err));
      setError("root", { message: errorText(err) });
      return;
    }
    const completeAttachments = attachments.markSubmission();
    const submission = bodyDraft.beginSubmission();
    try {
      const out = await api<{
        ticket?: { id: number };
        approval_required?: boolean;
        message?: string;
      }>("/api/tickets", {
        method: "POST",
        json: {
          body: attachments.compose(submission?.text ?? values.body),
          model: values.model,
          effort: values.effort,
          ...execution.payload,
          // Only sent when the shared admin key files on somebody's behalf; an
          // account always files as itself and the server ignores this.
          requester: choices.length ? values.requester : undefined,
        },
      });
      if (out.approval_required) {
        bodyDraft.completeSubmission(submission);
        completeAttachments();
        setNotice(out.message ?? t("composer.approvalQueued"));
        return;
      }
      if (!out.ticket) throw new Error(t("composer.serverMissingTicket"));
      bodyDraft.completeSubmission(submission);
      completeAttachments();
      await onCreated(out.ticket.id);
    } catch (err) {
      // This endpoint has legacy 400 catches around pipeline work, so a 400 is
      // not strong enough proof that no ticket was created. Gate/not-found/
      // schema refusals happen before dispatch and are safe to restore.
      if (err instanceof ApiError && [401, 403, 404, 422].includes(err.status)) {
        bodyDraft.restoreSubmission(submission);
      }
      setFailure(errorText(err));
      setError("root", { message: errorText(err) });
    }
  });

  return (
    <form className={styles.newPane} onSubmit={onSubmit}>
      <h2>{t("composer.newTitle")}</h2>
      <div className={styles.newSub}>{t("composer.newSubtitle")}</div>
      <label className={styles.fld} htmlFor="nf-body">
        {t("composer.bodyLabel")}
      </label>
      <Controller
        name="body"
        control={control}
        rules={{ required: t("composer.bodyRequired") }}
        render={({ field }) => (
          <UiTextArea
            {...field}
            id="nf-body"
            placeholder={compact ? t("composer.bodyCompact") : t("composer.bodyWide")}
            aria-invalid={Boolean(errors.body)}
            className={errors.body ? styles.badfield : undefined}
            onChange={(event) => {
              field.onChange(event);
              bodyDraft.set(event.target.value);
            }}
            onKeyDown={(event) => handleModifierSubmitKeyDown(event, () => void onSubmit())}
            onPaste={attachments.onPaste}
          />
        )}
      />
      <AttachmentStrip draft={attachments} />
      <div className={styles.newHint}>
        {t("composer.deliveryHint")}
      </div>
      <div className={styles.newRow}>
        <label className="srOnly" htmlFor="nf-model">
          {t("composer.model")}
        </label>
        <Controller
          name="model"
          control={control}
          render={({ field }) => (
            <UiSelect
              id="nf-model"
              value={field.value}
              onValueChange={field.onChange}
              options={(roster?.models ?? []).map((model) => ({
                value: model,
                label: t("composer.modelOption", { model: ticketModelLabel(model, roster?.model_catalog) }),
              }))}
            />
          )}
        />
        <label className="srOnly" htmlFor="nf-effort">
          {uiText("推理强度")}
        </label>
        <Controller
          name="effort"
          control={control}
          render={({ field }) => (
            <UiSelect
              id="nf-effort"
              value={field.value}
              onValueChange={field.onChange}
              options={(roster?.efforts ?? []).map((effort) => ({
                value: effort,
                label: `${uiText("推理强度")}: ${effort}`,
              }))}
            />
          )}
        />
      </div>
      <div className={styles.newRow}><TicketExecutionFields selection={execution} idPrefix="ticket-execution" /></div>
      {choices.length ? (
        <div className={styles.newRow}>
          <span className={styles.newHint}>{t("composer.onBehalf")}</span>
          <label className="srOnly" htmlFor="nf-requester">
            {t("composer.acceptor")}
          </label>
          <Controller
            name="requester"
            control={control}
            render={({ field }) => (
              <UiSelect
                id="nf-requester"
                value={field.value}
                onValueChange={field.onChange}
                options={choices.map((name) => ({ value: name, label: name }))}
              />
            )}
          />
          <span className={styles.newHint}>{t("composer.adminHint")}</span>
        </div>
      ) : null}
      <div className={styles.newHint}>{t("composer.effortHint")}</div>
      <div className={styles.newRow}>
        <UiButton htmlType="submit" className="primary" disabled={isSubmitting || !roster || !execution.ready}>
          {t("composer.submit")}
        </UiButton>
        <UiButton onClick={() => {
          bodyDraft.clear();
          onCancel();
        }}>
          {t("common.cancel")}
        </UiButton>
        {errors.body || failure ? (
          <span className={`${styles.newHint} ${styles.hintErr}`} role="alert">
            {failure ?? errors.body?.message}
          </span>
        ) : null}
        {notice ? <span className={styles.newHint} role="status">{notice}</span> : null}
      </div>
    </form>
  );
}
/**
 * Ticket #38-5: the lightweight discussion-mode entry point.
 *
 * Structurally simpler than NewTicketPane: no kind picker (it is always
 * `discuss`), no title field (agent renames via devpipe_rename after the
 * topic is clear), no app-scope picker. What's left is the two settings we
 * need before spawning an agent (model + effort), the opening message that
 * becomes the first unread inbox entry, and — for parity with the picker on
 * the normal form — an honest note when a codex model is selected.
 */
interface NewDiscussForm {
  body: string;
  model: string;
  effort: string;
  requester: string;
}

export function NewDiscussPane({
  roster,
  onCancel,
  onCreated,
}: {
  roster: Roster | undefined;
  onCancel: () => void;
  onCreated: (id: number) => Promise<void>;
}) {
  const { t } = useMessages();
  const choices = roster?.requester_choices ?? [];
  const modelDefault = roster?.model_default;
  const effortDefault = roster?.effort_default;
  const compact = useCompactChatViewport();
  const bodyDraft = useBrowserDraft("tickets:new-discussion");
  const {
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
    setError,
    setValue,
    getValues,
    watch,
  } = useForm<NewDiscussForm>({
    defaultValues: {
      body: bodyDraft.text,
      model: modelDefault && roster?.models?.includes(modelDefault) ? modelDefault : (roster?.models?.[0] ?? ""),
      effort: effortDefault && roster?.efforts?.includes(effortDefault) ? effortDefault : (roster?.efforts?.[0] ?? ""),
      requester: choices[0] ?? "",
    },
    shouldFocusError: true,
  });
  const owner = choices.length ? watch("requester") : bootstrap.viewer.username ?? "";
  const execution = useTicketExecution(roster?.execution_choices?.[owner], ticketModelSource(roster?.model_catalog, watch("model")), owner);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const attachments = useAttachments(owner);
  const executionKey = JSON.stringify([owner, watch("model"), watch("effort"), execution.payload]);
  const latestExecution = useRef(executionKey);
  latestExecution.current = executionKey;

  useEffect(() => {
    if (getValues("body") !== bodyDraft.text) setValue("body", bodyDraft.text);
  }, [bodyDraft.text, getValues, setValue]);

  useEffect(() => {
    const model = hydratedChoice(getValues("model"), roster?.models ?? [], modelDefault);
    const effort = hydratedChoice(getValues("effort"), roster?.efforts ?? [], effortDefault);
    const requester = hydratedChoice(getValues("requester"), choices);
    if (model) setValue("model", model);
    if (effort) setValue("effort", effort);
    if (requester) setValue("requester", requester);
  }, [choices, effortDefault, getValues, modelDefault, roster?.efforts, roster?.models, setValue]);

  const onSubmit = handleSubmit(async (values) => {
    if (!roster || !execution.ready) { setFailure(uiText("来源或工作区暂不可用，请选择可用组合。")); return; }
    setFailure(null);
    setNotice(null);
    try {
      await attachments.ready();
      if (latestExecution.current !== executionKey) throw new Error(uiText("执行选择已变化，请重新发送。"));
    } catch (err) {
      setFailure(errorText(err));
      setError("root", { message: errorText(err) });
      return;
    }
    const completeAttachments = attachments.markSubmission();
    const submission = bodyDraft.beginSubmission();
    try {
      const out = await api<{
        ticket?: { id: number };
        approval_required?: boolean;
        message?: string;
      }>("/api/tickets", {
        method: "POST",
        json: {
          // Title stays empty; the server assigns a "新讨论 · MM-DD HH:MM"
          // placeholder and the agent overwrites it via devpipe_rename.
          title: "",
          body: attachments.compose(submission?.text ?? values.body),
          kind: "discuss",
          model: values.model,
          effort: values.effort,
          ...execution.payload,
          requester: choices.length ? values.requester : undefined,
        },
      });
      if (out.approval_required) {
        bodyDraft.completeSubmission(submission);
        completeAttachments();
        setNotice(out.message ?? t("composer.approvalQueued"));
        return;
      }
      if (!out.ticket) throw new Error(t("composer.serverMissingTicket"));
      bodyDraft.completeSubmission(submission);
      completeAttachments();
      await onCreated(out.ticket.id);
    } catch (err) {
      if (err instanceof ApiError && [401, 403, 404, 422].includes(err.status)) {
        bodyDraft.restoreSubmission(submission);
      }
      setFailure(errorText(err));
      setError("root", { message: errorText(err) });
    }
  });

  return (
    <form className={styles.newPane} onSubmit={onSubmit}>
      <h2>{t("composer.discussTitle")}</h2>
      <div className={styles.newSub}>
        {t("composer.discussSubtitle")}
      </div>
      <label className={styles.fld} htmlFor="nd-body">
        {t("composer.opening")}
      </label>
      <Controller
        name="body"
        control={control}
        rules={{ required: t("composer.openingRequired") }}
        render={({ field }) => (
          <UiTextArea
            {...field}
            id="nd-body"
            placeholder={compact ? t("composer.discussCompact") : t("composer.discussWide")}
            aria-invalid={Boolean(errors.body)}
            className={errors.body ? styles.badfield : undefined}
            onChange={(event) => {
              field.onChange(event);
              bodyDraft.set(event.target.value);
            }}
            onKeyDown={(event) => handleModifierSubmitKeyDown(event, () => void onSubmit())}
            onPaste={attachments.onPaste}
          />
        )}
      />
      <AttachmentStrip draft={attachments} />
      <div className={styles.newRow}>
        <label className="srOnly" htmlFor="nd-model">
          {t("composer.model")}
        </label>
        <Controller
          name="model"
          control={control}
          render={({ field }) => (
            <UiSelect
              id="nd-model"
              value={field.value}
              onValueChange={field.onChange}
              options={(roster?.models ?? []).map((model) => ({
                value: model,
                label: t("composer.modelOption", { model: ticketModelLabel(model, roster?.model_catalog) }),
              }))}
            />
          )}
        />
        <label className="srOnly" htmlFor="nd-effort">
          {uiText("推理强度")}
        </label>
        <Controller
          name="effort"
          control={control}
          render={({ field }) => (
            <UiSelect
              id="nd-effort"
              value={field.value}
              onValueChange={field.onChange}
              options={(roster?.efforts ?? []).map((effort) => ({
                value: effort,
                label: `${uiText("推理强度")}: ${effort}`,
              }))}
            />
          )}
        />
      </div>
      <div className={styles.newRow}><TicketExecutionFields selection={execution} idPrefix="ticket-execution" /></div>
      {choices.length ? (
        <div className={styles.newRow}>
          <span className={styles.newHint}>{t("composer.onBehalf")}</span>
          <label className="srOnly" htmlFor="nd-requester">
            {t("composer.acceptor")}
          </label>
          <Controller
            name="requester"
            control={control}
            render={({ field }) => (
              <UiSelect
                id="nd-requester"
                value={field.value}
                onValueChange={field.onChange}
                options={choices.map((name) => ({ value: name, label: name }))}
              />
            )}
          />
        </div>
      ) : null}
      <div className={styles.newRow}>
        <UiButton htmlType="submit" className="primary" disabled={isSubmitting || !roster || !execution.ready}>
          {t("composer.start")}
        </UiButton>
        <UiButton onClick={() => {
          bodyDraft.clear();
          onCancel();
        }}>
          {t("common.cancel")}
        </UiButton>
        {errors.body || failure ? (
          <span className={`${styles.newHint} ${styles.hintErr}`} role="alert">
            {failure ?? errors.body?.message}
          </span>
        ) : null}
        {notice ? <span className={styles.newHint} role="status">{notice}</span> : null}
      </div>
    </form>
  );
}
