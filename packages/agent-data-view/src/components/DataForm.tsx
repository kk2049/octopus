import { AvButton, AvCheckbox, AvInput, AvTextArea, Banner } from "@claude-bot/agent-view-react/ui";
/**
 * A form generated from an action's parameter declaration.
 *
 * ── Why there is no `<form>` element ────────────────────────────────────────
 *
 * The frame this renders in is sandboxed without `allow-forms`: a real
 * submission is blocked by the browser, and relying on React's `onSubmit` to fire
 * anyway would make the whole panel depend on a behaviour the boundary is
 * explicitly configured to prevent. A button that calls a function is the same
 * interaction with none of that ambiguity. Enter-to-submit is wired on the
 * single-line inputs by hand for the same reason.
 *
 * ── Why the declaration is data and not props ───────────────────────────────
 *
 * `fields` comes from the App's own projection — the same statement its backend
 * validates against. That is the engine probe's verified design ("form 从 action
 * params 自动生成") carried over intact: one declaration, two consumers, so a
 * parameter that was added, renamed or made required cannot be missing from the
 * form and present in the handler.
 *
 * Values are strings all the way out, because that is what the proposal channel
 * carries; the App's backend does the coercion it already declared.
 */

import type { DeclarationStatus, FieldSpec, Tone } from "../lib/select.js";

export interface FormNotice {
  tone: Tone;
  text: string;
}

/**
 * A parameter the opening context filled in — a record panel injecting its own
 * record id. Shown as a locked row instead of an input: the reader should see
 * WHAT the action will apply to, and should not have to (or be able to) retype
 * it.
 */
export interface FormContext {
  label: string;
  value: string;
}

export interface DataFormProps {
  title: string;
  fields: readonly FieldSpec[];
  status: DeclarationStatus;
  /** The configured declaration path, quoted back when it does not resolve. */
  source: string;
  values: Readonly<Record<string, string>>;
  /** Field names the reader must still fill in, after a refused submit. */
  invalid: readonly string[];
  busy: boolean;
  /** No projection has arrived yet. Checked before `status` — see `DataList`. */
  booting: boolean;
  notice: FormNotice | null;
  /** The context-injected parameter, when the instance carries one. */
  context?: FormContext | null;
  submitLabel: string;
  hint: string;
  domIdScope?: string;
  onChange(name: string, value: string): void;
  onSubmit(): void;
  /** Present only when `notice` belongs to a refused ledger entry. */
  onDismissNotice?(): void;
  onClose?(): void;
}

export function DataForm({
  title,
  fields,
  status,
  source,
  values,
  invalid,
  busy,
  booting,
  notice,
  context = null,
  submitLabel,
  hint,
  domIdScope,
  onChange,
  onSubmit,
  onDismissNotice,
  onClose,
}: DataFormProps) {
  const id = (name: string): string => (domIdScope ? `dv-f-${name}-${domIdScope}` : `dv-f-${name}`);
  const bad = new Set(invalid);
  return (
    <section className="dv-form" data-dv-source={source} data-dv-status={status} aria-busy={busy || undefined}>
      <header className="dv-head">
        <b>{title || "提交"}</b>
        {onClose ? (
          <AvButton className="dv-close" data-dv-close onClick={onClose}>
            关闭
          </AvButton>
        ) : null}
      </header>
      {booting ? (
        <p className="dv-note" role="note">⏳ 正在等待第一份投影…</p>
      ) : status === "missing" ? (
        <p className="dv-note" role="note">
          这个组合指向的参数声明不存在：<code>{source}</code>
        </p>
      ) : status === "not_a_declaration" ? (
        <p className="dv-note" role="note">
          <code>{source}</code> 上不是一份可用的参数声明。
        </p>
      ) : status === "too_wide" ? (
        <p className="dv-note" role="note">这个动作声明的参数超出了一次提议能携带的数量。</p>
      ) : (
        <>
          {context ? (
            <div className="dv-context" data-dv-context>
              <span className="dv-context-label">{context.label}</span>
              <code className="dv-context-value">{context.value}</code>
            </div>
          ) : null}
          <div className="dv-fields">
            {fields.map((field) => (
              <div
                className="dv-field"
                key={field.name}
                data-dv-field={field.name}
                data-dv-invalid={bad.has(field.name) ? "1" : undefined}
              >
                <label htmlFor={id(field.name)}>
                  {field.label}
                  {field.required ? <span aria-hidden="true"> *</span> : null}
                </label>
                <FieldInput
                  field={field}
                  inputId={id(field.name)}
                  value={values[field.name] ?? ""}
                  busy={busy}
                  onChange={onChange}
                  onEnter={onSubmit}
                />
                {field.description ? <small className="dv-hint">{field.description}</small> : null}
              </div>
            ))}
          </div>
          {notice ? (
            <div className="dv-form-notice">
              <Banner tone={notice.tone} title={notice.text} />
              {onDismissNotice ? (
                <AvButton className="dv-notice-dismiss" onClick={onDismissNotice}>
                  清除
                </AvButton>
              ) : null}
            </div>
          ) : null}
          <div className="dv-actions">
            <AvButton className="primary" data-dv-submit disabled={busy} onClick={onSubmit}>
              {busy ? (
                <>
                  <span className="av-spin dv-submit-spin" aria-hidden="true" />
                  提交中…
                </>
              ) : submitLabel || "提交"}
            </AvButton>
            {hint ? <small className="dv-hint">{hint}</small> : null}
          </div>
        </>
      )}
    </section>
  );
}

function FieldInput({
  field,
  inputId,
  value,
  busy,
  onChange,
  onEnter,
}: {
  field: FieldSpec;
  inputId: string;
  value: string;
  busy: boolean;
  onChange(name: string, value: string): void;
  onEnter(): void;
}) {
  const enter = (event: React.KeyboardEvent): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onEnter();
    }
  };
  if (field.options.length) {
    return (
      <select
        id={inputId}
        disabled={busy}
        value={value}
        onChange={(event) => onChange(field.name, event.target.value)}
      >
        {field.required ? null : <option value="">（不填）</option>}
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "boolean") {
    return (
      <AvCheckbox
        id={inputId}
        disabled={busy}
        checked={value === "true"}
        onChange={(event) => onChange(field.name, event.target.checked ? "true" : "false")}
      />
    );
  }
  if (field.type === "text") {
    return (
      <AvTextArea
        id={inputId}
        rows={4}
        disabled={busy}
        value={value}
        onChange={(event) => onChange(field.name, event.target.value)}
      />
    );
  }
  return (
    <AvInput
      id={inputId}
      type={field.type === "number" ? "number" : "text"}
      disabled={busy}
      value={value}
      onChange={(event) => onChange(field.name, event.target.value)}
      onKeyDown={enter}
    />
  );
}
