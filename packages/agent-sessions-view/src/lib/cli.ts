/**
 * What each local CLI actually offers.
 *
 * ── Why this is not in the form ─────────────────────────────────────────────
 *
 * The CLIs do not share an effort ladder — omp even publishes an explicit
 * "off" — so switching between them can leave a selection the target does not
 * have. Clamping only where the
 * `<select>` is rendered would let the form show one thing and the approval card
 * carry another — a mismatch nobody can see until they read the card. So the
 * clamp lives here, the form uses it to render, and the controller uses it again
 * on the way out: the value a person sees IS the value that is proposed.
 *
 * ── Why the model is a list of choices now (ticket #191) ────────────────────
 *
 * It used to be a free-text box with a `<datalist>`, on the reasoning that an
 * unlisted model should stay usable without redeploying this file. In practice a
 * datalist has no affordance on a phone and almost none on a desktop: people
 * could not see that there was a list at all, typed a name from memory, and got
 * a launch that failed on the device — silently, until this ticket. A model
 * nobody can spell is not more available than one that is not listed.
 *
 * So the form renders a `<select>` over these entries plus an empty "Runner
 * 默认" choice. Two things keep that from becoming a cage:
 *
 *  · a draft value that is NOT in this table still renders as its own option,
 *    so nothing silently rewrites a name somebody already chose;
 *  · the trusted side's rule is unchanged — it accepts any well-formed model
 *    string — so adding a model here is one line and no protocol change.
 *
 * These lists remain suggestions, not authority: the device decides what it can
 * actually run, and now a device that cannot run one says so where the person
 * who asked can read it.
 */

import { AGENT_EFFORTS, DEFAULT_CODEX_MODEL, MODELS, type CliKind, type PlacementDevice, type ModelChoice, type SessionSummary } from "@claude-bot/agent-sessions-contract";

export { DEFAULT_CODEX_MODEL, MODELS, type ModelChoice };

/** Selectable CLI kinds, in the order a picker offers them. */
export const CLI_KINDS: readonly CliKind[] = ["claude", "codex", "omp"];

/** Product name for a CLI kind. One place, so no surface invents its own. */
export const CLI_KIND_LABELS: Readonly<Record<CliKind, string>> = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  omp: "Oh My Pi",
});

export function cliKindLabel(value: string | null | undefined): string {
  return CLI_KIND_LABELS[value as CliKind] ?? "CLI";
}

/**
 * What the picker offers, which is not the same list as what a session can be.
 *
 * Claude has two lanes. The bilingual one hands the prompt to a GPT translator
 * before Claude sees it and projects the reply in both languages; the plain one
 * never reaches a second provider at all. They are separate entries here
 * because choosing between them is the person's decision and has to be visible
 * at the moment of choosing — not a hidden default that a translator outage can
 * turn into "no Claude at all".
 *
 * They are NOT two `CliKind`s. What a bilingual launch produces is an ordinary
 * Claude session: same transcript store, same scanner, same roster row. A
 * fourth provider would put a session kind into the projection that no store
 * can ever produce, so the lane travels as a launch option on `claude` and
 * every surface that names a provider keeps seeing exactly three.
 */
export type LaunchChoiceId = "claude" | "claude-bilingual" | "codex" | "omp";

export interface LaunchChoice {
  id: LaunchChoiceId;
  /** The provider actually started; what the roster will show. */
  source: CliKind;
  /** Translate the prompt to English before the provider sees it. */
  translatePrompt: boolean;
  label: string;
  /** One line under the picker, or "" when the plain name says everything. */
  hint: string;
}

export const LAUNCH_CHOICES: readonly LaunchChoice[] = Object.freeze([
  { id: "claude", source: "claude", translatePrompt: false, label: "Claude Code", hint: "" },
  {
    id: "claude-bilingual",
    source: "claude",
    translatePrompt: true,
    label: "Claude Code（中英双语）",
    hint: "中文提示先由 GPT 译成英文再交给 Claude，回复中英对照。翻译不可用时这一项会启动失败，普通 Claude 不受影响。",
  },
  { id: "codex", source: "codex", translatePrompt: false, label: "Codex", hint: "" },
  { id: "omp", source: "omp", translatePrompt: false, label: "Oh My Pi", hint: "" },
] as const);

/** The picker entry a draft currently sits on. */
export function launchChoiceIdOf(source: string, translatePrompt: boolean): LaunchChoiceId {
  return source === "claude" && translatePrompt ? "claude-bilingual" : (source as LaunchChoiceId);
}

/** The lane a picked entry means. Unknown ids fall back to plain Claude. */
export function launchChoiceOf(id: string): LaunchChoice {
  return LAUNCH_CHOICES.find((choice) => choice.id === id) ?? LAUNCH_CHOICES[0]!;
}

/** Existing-session provider label; account metadata never modifies the user's title. */
export function sessionCliKindLabel(
  value: string | null | undefined,
  accountLabel?: string,
): string {
  if (value !== "codex") return value || "CLI";
  return /^[a-z]$/.test(accountLabel ?? "") ? `Codex-${accountLabel}` : "Codex";
}

/**
 * omp's managed transport is `omp --mode rpc`, which has no approval surface
 * at all: a tool that would prompt fails closed inside omp. Manual review is
 * therefore not a weaker option there, it is a session that cannot run, and no
 * picker should offer it. The trusted side refuses the same combination.
 */
export function supportsManualPermissionProfile(value: string | null | undefined): boolean {
  return value !== "omp";
}

/**
 * Each CLI's closed effort ladder. The trusted Host and the Runner enforce the
 * same contract definition, so the View renders exactly what they accept.
 */
export const EFFORTS: Readonly<Record<CliKind, readonly string[]>> = AGENT_EFFORTS;

/** Whether the next ordinary action opens a provider-managed turn whose model/effort can still be chosen. */
export function supportsManagedTurnConfiguration(session: SessionSummary): boolean {
  if (!CLI_KINDS.includes(session.cliKind as CliKind)) return false;
  const runtime = session.runtime;
  const attachment = runtime?.attachment;
  const capabilities = runtime?.capabilities;
  const externalTui = runtime?.control_mode === "external_cli"
    || attachment?.transport === "tmux"
    || attachment?.kind === "terminal_tmux"
    || attachment?.kind === "hook_observer"
    || attachment?.kind === "omp_terminal";
  if (externalTui || capabilities?.protocol_append === true || capabilities?.terminal_append === true) return false;
  if (capabilities?.managed_resume === true || capabilities?.append_when_idle === true) return true;
  if (session.cliKind === "codex" && Boolean(session.accountLabel) && session.status !== "live") return true;
  return session.status !== "live" && session.resumable === true;
}

/** Compatibility name for consumers that only render the effort half. */
export const supportsManagedTurnEffort = supportsManagedTurnConfiguration;

/**
 * Which ordinary action would carry a chosen model/effort, or null when none can.
 *
 * `managed`: the next send opens a provider-managed turn, so the choice applies
 * to it. `takeover`: the Agent was started somewhere else (a terminal TUI, a
 * hook-observed CLI) and an ordinary send only types into that process, which
 * cannot change its model; the Runner does honour the choice on the explicit
 * takeover that stops the exact CLI and opens a managed turn in its place
 * (`agent-control-plane.ts`, "Explicit takeover is different"). The View
 * therefore offers the same controls there, labelled for that route, and the
 * controller attaches them to the takeover proposal only — never to a
 * terminal append, which the device would refuse.
 */
export type TurnConfigurationRoute = "managed" | "takeover";

export function turnConfigurationRoute(session: SessionSummary): TurnConfigurationRoute | null {
  if (session.inputMode === "parent_owned" || !CLI_KINDS.includes(session.cliKind as CliKind)) return null;
  if (supportsManagedTurnConfiguration(session)) return "managed";
  return session.runtime?.capabilities?.takeover === true ? "takeover" : null;
}

/** Whether one concrete write proposal may carry the selected model/effort. */
export function carriesTurnConfiguration(
  session: SessionSummary,
  action: "append" | "resume" | "takeover" | "fallback",
): boolean {
  const route = turnConfigurationRoute(session);
  if (route === "managed") return true;
  return route === "takeover" && action === "takeover";
}

/** The effort actually submitted: the one on screen, clamped to what exists. */
export function normalizeEffort(source: CliKind, effort: string): string {
  return EFFORTS[source]?.includes(effort) ? effort : "xhigh";
}

export function codexModelsForDevice(device: PlacementDevice | undefined, account?: { id?: string; label?: string }): readonly ModelChoice[] | undefined {
  const accounts = device?.codexAccounts ?? [];
  if (account?.id) return accounts.find(row => row.id === account.id)?.models;
  if (account?.label) return accounts.find(row => row.label === `codex${account.label}`)?.models;
  // Automatic routing has not selected an account yet. Offer the discovered union.
  const choices = accounts.flatMap(row => row.models ?? []);
  return choices.length ? [...new Map(choices.map(row => [row.value, row])).values()] : undefined;
}

/**
 * The options one CLI's model `<select>` renders, in order.
 *
 * The empty value is first because it is the honest default: this View does not
 * know which model the Runner is configured with, and pretending otherwise by
 * pre-selecting one would change what people get without them asking. A model
 * carried in from an older draft (or a future release's list) is appended
 * rather than dropped — see the header.
 */
export function modelChoices(source: CliKind, selected: string, discovered?: readonly ModelChoice[]): readonly ModelChoice[] {
  const listed = source === "codex" && discovered?.length ? discovered : MODELS[source] ?? [];
  const known = listed.some((choice) => choice.value === selected);
  return Object.freeze([
    { value: "", label: "Runner 默认（不指定）" },
    ...listed,
    ...(selected && !known ? [{ value: selected, label: `${selected}（自定义）` }] : []),
  ]);
}
