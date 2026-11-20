/**
 * The run-configuration bar every Agent composer shares (ticket #767).
 *
 * Starting an Agent and talking to one used to configure the same Agent in two
 * different places with two different vocabularies: a full-page form with
 * paired fields for a new Agent, and model/effort fields folded inside the
 * chat's settings card for the next turn of an existing one. Both surfaces now
 * render these controls, in this order — 后端 → 模型 → Effort — as compact
 * items directly under the input. What is rarely changed (account, permission
 * profile, placement) stays folded behind the composer's ⚙ card on both.
 *
 * Nothing here is an authority. The bar renders values and reports choices;
 * the launch form and the controller clamp with the same `lib/cli.ts`
 * functions on the way out, and the trusted side re-validates every proposal.
 */

import type { ReactNode, SelectHTMLAttributes } from "react";
import {
  AGENT_PERMISSION_PROFILES,
  type AgentPermissionProfile,
  type CliKind,
  type ModelChoice,
} from "@claude-bot/agent-sessions-contract";
import { EFFORTS, modelChoices } from "../lib/cli.js";

/** One labelled group of compact controls. */
export function RunConfigBar(props: { label: string; className?: string; children: ReactNode }) {
  return (
    <div
      className={props.className ? `run-config-bar ${props.className}` : "run-config-bar"}
      role="group"
      aria-label={props.label}
      data-av-run-config
    >
      {props.children}
    </div>
  );
}

/**
 * One control with its visible short label. `hint` is the tooltip that says
 * when the value applies; `invalid` marks a value the form will not submit.
 */
export function RunConfigField(props: {
  label: string;
  htmlFor?: string;
  hint?: string;
  invalid?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const className = ["run-config-field", props.invalid ? "run-config-invalid" : "", props.className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className} title={props.hint || undefined}>
      {props.htmlFor
        ? <label htmlFor={props.htmlFor}>{props.label}</label>
        : <span className="run-config-label">{props.label}</span>}
      {props.children}
    </div>
  );
}

type PickerProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "children" | "onChange" | "value"> & {
  source: CliKind;
  value: string;
  onValue(value: string): void;
};

/** The provider's model list plus the empty Runner default; see `modelChoices`. */
export function ModelPicker({ source, value, onValue, models, ...select }: PickerProps & { models?: readonly ModelChoice[] }) {
  return (
    <select {...select} value={value} onChange={(event) => onValue(event.target.value)}>
      {modelChoices(source, value, models).map((choice) => (
        <option value={choice.value} key={choice.value || "default"}>{choice.label}</option>
      ))}
    </select>
  );
}

/**
 * The provider's closed effort ladder. `keepLabel` adds the empty choice an
 * existing session uses to mean "leave the Runner's current value alone"; a
 * launch has no current value and therefore no such choice.
 */
export function EffortPicker({ source, value, onValue, keepLabel, ...select }: PickerProps & { keepLabel?: string }) {
  return (
    <select {...select} value={value} onChange={(event) => onValue(event.target.value)}>
      {keepLabel !== undefined ? <option value="">{keepLabel}</option> : null}
      {EFFORTS[source].map((effort) => <option value={effort} key={effort}>{effort}</option>)}
    </select>
  );
}

/**
 * `allowManual` is not styling. A CLI whose managed transport has no approval
 * surface cannot honour manual review at all, and the trusted side refuses it;
 * rendering the option anyway would hand people a choice that always fails.
 */
export function AgentPermissionField(props: {
  id: string; label: string; value: AgentPermissionProfile; hint: string;
  disabled?: boolean;
  allowManual?: boolean;
  onChange(value: AgentPermissionProfile): void;
}) {
  const allowManual = props.allowManual !== false;
  return <div className="field">
    <label htmlFor={props.id}>{props.label}</label>
    <select
      id={props.id}
      value={allowManual ? props.value : AGENT_PERMISSION_PROFILES.fullAccess}
      disabled={props.disabled || !allowManual}
      onChange={(event) => props.onChange(event.target.value as AgentPermissionProfile)}
    >
      <option value={AGENT_PERMISSION_PROFILES.fullAccess}>全通过（默认）</option>
      {allowManual ? <option value={AGENT_PERMISSION_PROFILES.manual}>手动确认</option> : null}
    </select>
    {props.hint ? <div className="small">{props.hint}</div> : null}
  </div>;
}
