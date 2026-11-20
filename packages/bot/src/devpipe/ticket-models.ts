/** Dev-pipeline ticket choices, defaults, CLI routing, and input normalization. */

import type { DevTicketLane, TicketActorKind } from "../store/repositories/dev-tickets.js";

/**
 * The one ticket model catalog: every id the dashboard may need to name, in
 * the order the filing pickers offer them. The roster serves it as
 * `model_catalog` ({id, label, family}); browser code keeps no copy.
 *
 * `offered: true` ids are what newly filed tickets may choose. Full ids keep
 * the chosen generation auditable after floating CLI aliases move. Retired and
 * system-made ids stay listed only so persisted tickets keep their label; any
 * id missing here still resumes unchanged and is displayed as itself.
 */
const TICKET_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string; offered: boolean }> = [
  { id: "claude-opus-5-5", label: "Opus 5.5", offered: true },
  { id: "claude-opus-4-7", label: "Opus 4.7", offered: true },
  { id: "claude-opus-5", label: "Opus 5", offered: true },
  { id: "claude-fable-5-1", label: "Fable 5.1", offered: true },
  { id: "codex-gpt-6-astra", label: "Codex · GPT-6 Astra", offered: true },
  { id: "codex-gpt-5.6-sol", label: "Codex · GPT 5.6-sol", offered: true },
  { id: "codex-gpt-5.6-terra", label: "GPT-5.6 Terra", offered: true },
  { id: "codex-gpt-5.6-luna", label: "GPT-5.6 Luna", offered: true },
  { id: "codex-gpt-5.5", label: "GPT-5.5", offered: true },
  // The requester's OWN Runner device's Codex (#358): the turn's model brain
  // runs on that device with its own credentials, while the execution
  // environment stays the bot-host ticket worktree — see cliFamilyForModel.
  // The browser appends its localized "my Runner" qualifier from the family.
  { id: "codex-runner-gpt-6-astra", label: "Codex · GPT-6 Astra", offered: true },
  { id: "codex-runner-gpt-5.6-sol", label: "Codex · GPT 5.6-sol", offered: true },
  // Oh My Pi runs the same two subscriptions through its own harness (LSP,
  // AST edits, in-process shell, subagent fleets). Its ticket agent sees a
  // WIDER MCP tool surface than the other two — see cliFamilyForModel.
  { id: "omp-gpt-5.6-sol", label: "omp · GPT 5.6-sol", offered: true },
  { id: "omp-opus", label: "omp · Opus", offered: true },
  // Persisted tickets only; new filing no longer offers them.
  { id: "claude-fable-5", label: "Fable 5", offered: false },
  // Read-only rows created by registering a local CLI session.
  { id: "codex-native", label: "Codex · 原生 CLI", offered: false },
  { id: "claude-native", label: "Claude Code · 原生 CLI", offered: false },
];

export const DEV_TICKET_MODELS: ReadonlySet<string> = new Set(
  TICKET_MODEL_CATALOG.filter((entry) => entry.offered).map((entry) => entry.id),
);

export const FABLE_TICKET_MODEL = "claude-fable-5-1";
// Every implicit ticket route uses the first-party Codex backend. Runner and
// omp remain explicit choices; neither is allowed to become a silent default.
export const DEV_TICKET_MODEL_DEFAULT = "codex-gpt-6-astra";
export const DEV_TICKET_EFFORTS = new Set(["high", "xhigh", "max"]);
export const DEV_TICKET_EFFORT_DEFAULT = "xhigh";

// `app` is retained for historical path-gated tickets; new filing routes do
// not offer it because delivery is classified from the final submit diff.
// `discuss` remains the explicit discussion-only entry. `cli` is system-made.
export const DEV_TICKET_KINDS = new Set(["simple", "complex", "app", "discuss"]);

export interface DevTicketInput {
  title: string;
  body: string;
  requester: string;
  kind?: string;
  app_id?: string | null;
  model?: string;
  effort?: string;
  agent_source?: string;
  workspace?: string;
  parent_ticket_id?: number | null;
  via?: string;
  /**
   * How the opening request was written (review 6.10). The caller derives it
   * from the credential it already authenticated — a Dashboard route from its
   * identity, Head-generated tickets as `system`. Omitted = unknown (NULL).
   */
  actor_kind?: TicketActorKind | null;
  /** Stable derived-graph conflict id; only the knowledge collaboration route sets it. */
  knowledge_subject_id?: string | null;
  /**
   * Ticket #219: the spec files a red batch blamed, as a JSON array. Only the
   * CI result adapter sets it; a non-null value (including `[]`) puts the
   * ticket in the repair lane — see devpipe/ci-roster.ts.
   */
  ci_roster?: string | null;
  /**
   * 'direct' or 'review' (migration v51). The pipeline decides it from the
   * requester's capabilities; callers never choose a lane for themselves.
   */
  lane?: DevTicketLane;
}

export interface PersistedDevTicketInput extends DevTicketInput {
  kind: string;
  app_id: string | null;
  model: string;
  effort: string;
}

/**
 * Apply the business rules for a newly filed ticket before it crosses the
 * persistence boundary. Unknown choices retain the historical clamp behavior.
 * Only app tickets carry app ids; scope-table validation remains in pipeline.
 */
export function normalizeDevTicketInput(input: DevTicketInput): PersistedDevTicketInput {
  const kind = input.kind && DEV_TICKET_KINDS.has(input.kind) ? input.kind : "complex";
  const appId = String(input.app_id ?? "").trim().slice(0, 64) || null;
  const knowledgeSubjectId = String(input.knowledge_subject_id ?? "").trim().slice(0, 400) || null;
  return {
    ...input,
    kind,
    app_id: kind === "app" ? appId : null,
    knowledge_subject_id: knowledgeSubjectId,
    model: input.model && DEV_TICKET_MODELS.has(input.model) ? input.model : DEV_TICKET_MODEL_DEFAULT,
    effort: input.effort && DEV_TICKET_EFFORTS.has(input.effort) ? input.effort : DEV_TICKET_EFFORT_DEFAULT,
  };
}

export interface CliDeliveryTicketInput {
  native_ticket_id?: number;
  title: string;
  body: string;
  spec: string;
  requester: string;
  branch: string;
  commit_sha: string;
}

/** System-created CLI rows use the same explicit model/effort defaults. */
export function normalizeCliDeliveryTicketInput(input: CliDeliveryTicketInput): CliDeliveryTicketInput & {
  model: string;
  effort: string;
} {
  return {
    ...input,
    model: DEV_TICKET_MODEL_DEFAULT,
    effort: DEV_TICKET_EFFORT_DEFAULT,
  };
}

/**
 * Which CLI family should execute a stored model id.
 *
 * The three families do not offer the same containment. Claude pins the
 * agent's tool surface with `--strict-mcp-config` and Codex with
 * `ignoreUserConfig`, so those tickets see EXACTLY the per-turn MCP file the
 * pipeline writes. omp has no equivalent switch: it always also discovers
 * `~/.omp/agent/mcp.json` and the other tools' configs on the bot host, so an
 * omp ticket agent's tool surface is the pipeline's servers PLUS the host's.
 *
 * That widening was accepted explicitly (ticket #227) rather than inferred,
 * and it is not silent: `buildOmpDevTurnCommand` documents it, and the intro
 * prompt tells the agent, so a host-provided tool can never be mistaken for a
 * pipeline-provided one. Anything that must stay pipeline-only belongs in a
 * Claude or Codex ticket.
 *
 * "codex-runner" (#358) is Codex executed on the REQUESTER'S OWN Runner
 * device (their credentials, the isolated split home) while every shell/file
 * tool operates on the bot-host ticket worktree through a tunneled
 * exec-server. It gets NO MCP mounts — MCP command configs would spawn on the
 * remote device where the pipeline's server binaries do not exist — so devpipe
 * and machines tools run through the `pnpm devpipe:call` fallback inside the
 * worktree; the intro prompt states this explicitly.
 */
export type DevCliFamily = "claude" | "codex" | "omp" | "codex-runner";

export function cliFamilyForModel(model: string | null | undefined): DevCliFamily {
  if (!model) return "claude";
  if (model.startsWith("codex-runner-")) return "codex-runner";
  if (model.startsWith("codex-")) return "codex";
  if (model.startsWith("omp-")) return "omp";
  return "claude";
}

/** One catalog row as the dashboard receives it; `family` is cliFamilyForModel's answer. */
export interface TicketModelChoice {
  id: string;
  label: string;
  family: DevCliFamily;
}

/** Every catalogued id, offered or retained for display, with its routing family. */
export function ticketModelCatalog(): TicketModelChoice[] {
  return TICKET_MODEL_CATALOG.map(({ id, label }) => ({ id, label, family: cliFamilyForModel(id) }));
}

/**
 * The ids a new ticket may choose on this composition. Runner-placed tickets
 * choose their own device through the Agent source, so the codex-runner lane,
 * omp (no Runner ticket source) and Fable (approval-only, no Runner choice)
 * are not offered there.
 */
export function offeredTicketModels(runnerTickets: boolean): string[] {
  return [...DEV_TICKET_MODELS].filter((model) => {
    if (!runnerTickets) return true;
    const family = cliFamilyForModel(model);
    return (family === "claude" || family === "codex") && model !== FABLE_TICKET_MODEL;
  });
}

/**
 * The bot-host transcript namespace a ticket's session can be read from, or
 * null when there is no local transcript at all: a codex-runner session's
 * JSONL lives in the requester's device-private split home and is readable
 * only through the ticket relay. It is deliberately absent from Sessions+,
 * so the panel's local tail/read endpoints must answer plainly instead of
 * scanning the wrong namespace forever.
 */
export function localScanSourceForModel(model: string | null | undefined): "claude" | "codex" | "omp" | null {
  const family = cliFamilyForModel(model);
  return family === "codex-runner" ? null : family;
}

/** Strip the family prefix before passing a Codex/omp model id to its CLI. */
export function modelIdForCli(model: string): string {
  if (model.startsWith("codex-runner-")) return model.slice("codex-runner-".length);
  if (model.startsWith("codex-")) return model.slice("codex-".length);
  if (model.startsWith("omp-")) return model.slice("omp-".length);
  return model;
}
