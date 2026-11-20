/**
 * The App declaration, as this build reads it.
 *
 * ── Versioned schemas, and why old ones are frozen rather than generalised ─
 *
 * `schema: 1` is the M4 surface: eight actions, string-only parameters, no
 * agents. It is parsed by code that behaves exactly as it did before this file
 * grew a second branch — including the literal action-list assertion, which is
 * what pins the three installed release shapes (legacy 7 / modular-v1 9 /
 * modular-v2 10) to the surface the trusted coordinator binds. Those releases
 * are the rollback targets; a rollback that stopped working the day a new
 * declaration format shipped would not be a rollback.
 *
 * `schema: 2` is the surface that can declare `agents:` and richer parameters.
 * It is NOT "schema 1 plus optional fields": an old `app.yaml` is never read as
 * a subset of the new one, because that would make "what did this release
 * declare" an inference instead of a sentence. Unknown keys are refused and
 * listed, for the reason `agent-module-contract` gives about release assets —
 * an unrecognised key is either a newer schema or a typo that quietly turned
 * something off, and neither should be ignored.
 *
 * ── The prompt is inline, and that is a deliberate simplification ───────────
 *
 * The design sketch (`doc/development/app-runtime-agents-design.md` §3.4) put
 * each agent's system prompt in its own `prompts/<name>.md` release asset, and
 * then had to add a whole shape rule to keep the CLOSED asset sets from
 * exploding — plus two refusals for "declared a prompt file that is not there"
 * and "shipped a prompt file nothing declared".
 *
 * Putting the prompt in `app.yaml` buys every property that rule was protecting
 * and deletes the rule. `app/app.yaml` is already a release asset covered by
 * `packageDigest`, not by `backendCodeDigest` and not by
 * `permissionContractDigest` — so: a prompt edit changes the release identity
 * and the hostname (it IS part of what a person consents to); it does not make
 * the Runtime child stale (the prompt is read by the trusted plane, never by the
 * Runtime); and it does not require re-consenting to the permission contract.
 * The two refusals become unrepresentable rather than checked. The cost is a
 * bounded prompt (16 KiB) living in YAML, which is a real but small one.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { load } from "js-yaml";
import { appAgentAdapterVerdict } from "@claude-bot/engine";
import { WIRE_PARAM_LIMITS } from "@claude-bot/typed-port-kit";
import { bundledAppDir } from "./app-path.js";

/** A parameter's declared type. Deliberately NOT `object`: see `normalize`. */
export type SessionPlusParamType = "string" | "number" | "boolean";

export interface SessionPlusParamSpec {
  type: SessionPlusParamType;
  /** Maximum length of the WIRE form (every parameter travels as a string). */
  max: number;
  /** schema 1 has no `required`; every parameter there is optional. */
  required: boolean;
  /** For the agent and MCP faces. The button face does not need it. */
  description?: string;
  /** Server-checked closed set. `enum_bind` is deliberately not ported. */
  enum?: readonly string[];
}

export interface SessionPlusActionSpec {
  binding: "runtime" | "resource" | "agent";
  handler?: string;
  /** Schema 4: bounded own-stream history, passed only to the sandbox handler. */
  historyCursor?: string;
  /** `binding: agent`: the declared agent that receives the required `prompt`. */
  agent?: string;
  /** Display name for a button and a tool. */
  title?: string;
  /** Extra prose for the agent and MCP faces only. */
  description?: string;
  /**
   * Never generate an agent tool for this action, and refuse it when an agent
   * asks anyway. BOTH halves are needed: filtering only the tool list leaves a
   * model free to name the action, and refusing only at the door leaves a model
   * retrying a tool it can see.
   */
  humanOnly: boolean;
  /** The mirror image: an action only the agent plane may drive. */
  agentOnly: boolean;
  /**
   * schema 3, shared-scope Apps only: which declared roles may drive this
   * action. Absent = any non-observer member; an observer role acts only on
   * actions that name it. Both halves are the platform door's (`app-instance`);
   * "whose turn it is" stays in the App's own rules door (ADR 0007 原则 2).
   */
  roles?: readonly string[];
  params: Readonly<Record<string, SessionPlusParamSpec>>;
}

/** schema 3: one shared-scope role's declaration. */
export interface SessionPlusRoleSpec {
  /** How many members may hold this role at once (1..64). */
  max: number;
  /** A watch-only role: barred from every action that does not name it. */
  observer: boolean;
}

/**
 * The adapter vocabulary, which keeps all three names even though this build
 * implements one.
 *
 * Deleting `claude-code`/`codex` would turn a SEC-06 refusal ("this deployment
 * forbids a coding CLI as an ordinary App agent's backend, and here is what to
 * use instead") into `unknown adapter "claude-code"` — a sentence that sends an
 * operator looking for a dependency that does not exist.
 */
export const APP_AGENT_ADAPTERS = ["openai-loop", "claude-code", "codex"] as const;
export type AppAgentAdapter = (typeof APP_AGENT_ADAPTERS)[number];

/** Deployment-facing vocabulary; values pass through without substitution. */
export const APP_AGENT_EFFORTS = ["minimal", "low", "medium", "high", "max"] as const;
export type AppAgentEffort = (typeof APP_AGENT_EFFORTS)[number];

export const APP_AGENT_LIMITS = Object.freeze({
  maxAgents: 4,
  maxPromptChars: 16_384,
  maxDailyPromptChars: 2_048,
  maxModelChars: 120,
});

export interface SessionPlusAgentSpec {
  name: string;
  adapter: AppAgentAdapter;
  /** The system prompt, verbatim from the release. `{{user}}` is substituted. */
  prompt: string;
  model?: string;
  effort?: AppAgentEffort;
  /** `"HH:MM"` in the host's local timezone, or absent. */
  daily?: string;
  dailyPrompt?: string;
  /** schema 4 shared Apps: the role this trusted agent actor occupies. */
  role?: string;
}

export interface SessionPlusManifest {
  /**
   * Which App this `app.yaml` belongs to.
   *
   * Widened from the literal when a second App started being read by this
   * loader (`app-registry/app-instance.ts`). The FORMAT is the `publisher-js`
   * profile's, not Session Plus's; the literal was the only thing saying
   * otherwise, and it is why a declared App's manifest could not be loaded at
   * all.
   */
  id: string;
  schema: 1 | 2 | 3 | 4;
  /**
   * Which partition this App's durable state lives in (ADR 0007 P1).
   * `account` — today's behavior, one private stream per owner — for every
   * schema ≤2 release and for schema 3 unless it says otherwise. `shared` —
   * one stream per server-minted instance key, opened through the membership
   * door. Only schema 3 can say `shared`, and saying it requires `roles`, so
   * an older build refuses the file instead of quietly serving it privately.
   */
  stateScope: "account" | "shared";
  /**
   * App-author assertion that every release in this epoch may co-write one
   * event stream. The numeric fallback remains 0 for readers, but coexistence
   * is opt-in and separately checks that schema 2/3 declared the field.
   */
  stateEpoch: number;
  /** True only when app.yaml explicitly carries `state_epoch`. */
  stateEpochDeclared: boolean;
  /** schema 3 shared Apps: the declared role vocabulary. Empty otherwise. */
  roles: Readonly<Record<string, SessionPlusRoleSpec>>;
  actions: Readonly<Record<string, SessionPlusActionSpec>>;
  /** Always present; empty for every `schema: 1` release. */
  agents: Readonly<Record<string, SessionPlusAgentSpec>>;
  pageFile: string;
}

export interface LoadManifestOptions {
  /**
   * Which models this deployment is willing to spend on, when it wants to
   * decide that at all.
   *
   * A release names a model, and an LLM call spends the DEPLOYMENT's money — so
   * "the publisher picked it" is not the same as "the operator agreed to it".
   * Checked here rather than at turn time so it is visible before the active
   * pointer moves. Omitted means this caller is not adjudicating models (the
   * source-tree load, and every test that does not care).
   */
  allowedModels?: readonly string[];
  /**
   * Which App this file is expected to declare. Default `"session-plus"`.
   *
   * Compared, never derived: a loader that took the id FROM the file would
   * happily read one App's release as if it were another's, and the caller
   * asking already knows which App it activated.
   */
  appId?: string;
}

const ID = /^[a-z][a-z0-9_]{0,63}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const DAILY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const SCHEMA1_TOP = ["id", "schema", "state", "actions", "view"] as const;
const SCHEMA2_TOP = [...SCHEMA1_TOP, "agents", "state_epoch"] as const;
// `roles` is deliberately a NEW top-level key rather than a `state` sub-key:
// schema 2 ignores `state` content, so a shared declaration hiding in there
// would be served privately by an older build. A top-level key an old build
// does not know is refused by its `refuseUnknown` — fail-closed for free.
const SCHEMA3_TOP = [...SCHEMA2_TOP, "roles"] as const;
// Schema 4 changes no asset inventory. Its new meaning is inside app.yaml:
// every shared agent names a declared role, and older builds reject the schema
// number before they can silently serve that agent without role evidence.
const SCHEMA4_TOP = SCHEMA3_TOP;
const SCHEMA2_ACTION = ["binding", "handler", "agent", "title", "description", "human_only", "agent_only", "params"] as const;
const SCHEMA3_ACTION = [...SCHEMA2_ACTION, "roles"] as const;
const SCHEMA4_ACTION = [...SCHEMA3_ACTION, "history_cursor"] as const;
const SCHEMA2_PARAM = ["type", "max", "required", "description", "enum"] as const;
const SCHEMA2_AGENT = ["adapter", "prompt", "model", "effort", "daily", "daily_prompt"] as const;
const SCHEMA4_AGENT = [...SCHEMA2_AGENT, "role"] as const;
const SCHEMA3_STATE = ["scope"] as const;
const SCHEMA3_ROLE = ["max", "observer"] as const;

/**
 * The M4 action surface, spelled once.
 *
 * Only `schema: 1` is held to it. That is the whole point of the second schema:
 * this equality is what made every extension of `app.yaml` — including the one
 * this file exists for — fail before it was read.
 */
const M4_ACTIONS =
  "pin_session,refresh_sessions,open_session,search_sessions,refresh_workspaces,start_session,append_session,resume_session";

let cached: SessionPlusManifest | null = null;

export function loadSessionPlusManifest(
  appDir = bundledAppDir("session-plus"),
  options: LoadManifestOptions = {},
): SessionPlusManifest {
  const appId = options.appId ?? "session-plus";
  const cacheable =
    appDir === bundledAppDir("session-plus") &&
    options.allowedModels === undefined &&
    appId === "session-plus";
  if (cacheable && cached) return cached;
  const raw = load(readFileSync(path.join(appDir, "app.yaml"), "utf8")) as Record<string, unknown>;
  if (
    raw?.id !== appId
    || (raw?.schema !== 1 && raw?.schema !== 2 && raw?.schema !== 3 && raw?.schema !== 4)
  ) {
    throw new Error(`${appId} app.yaml has the wrong identity/schema`);
  }
  const schema = raw.schema as 1 | 2 | 3 | 4;
  if (schema === 2) refuseUnknown("app.yaml", raw, SCHEMA2_TOP);
  if (schema === 3) refuseUnknown("app.yaml", raw, SCHEMA3_TOP);
  if (schema === 4) refuseUnknown("app.yaml", raw, SCHEMA4_TOP);
  const roles = schema >= 3 ? readRoles(raw.roles) : {};
  const stateScope = schema >= 3 ? readStateScope(raw.state, roles) : "account";
  const stateEpochDeclared = schema >= 2 && raw.state_epoch !== undefined;
  const stateEpoch = schema >= 2 ? readStateEpoch(raw.state_epoch) : 0;
  // Schema 1 keeps its old tolerance for keys it never knew about — but NOT for
  // the one key schema 2 introduced. A `schema: 1` file carrying `agents:` is
  // somebody who believes they declared an agent; ignoring it is the quietly-
  // turned-something-off failure the strict branch exists to prevent, and no
  // release that exists today has this key.
  if (schema === 1 && raw.agents !== undefined) {
    throw new Error("app.yaml declares agents but says schema: 1; declare schema: 2 to use them");
  }
  if (schema === 1 && raw.state_epoch !== undefined) {
    throw new Error("app.yaml declares state_epoch but says schema: 1; declare schema: 2 or 3 to use it");
  }
  const input = raw.actions;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("session-plus app.yaml needs actions");
  const actions: Record<string, SessionPlusActionSpec> = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (!ID.test(name) || !value || typeof value !== "object") {
      throw new Error(`invalid session-plus action declaration: ${name}`);
    }
    const row = value as Record<string, unknown>;
    if (schema === 2) refuseUnknown(`action ${name}`, row, SCHEMA2_ACTION);
    if (schema >= 3) refuseUnknown(`action ${name}`, row, schema >= 4 ? SCHEMA4_ACTION : SCHEMA3_ACTION);
    const actionRoles = schema >= 3 ? readActionRoles(name, row.roles, roles, stateScope) : undefined;
    const params: Record<string, SessionPlusParamSpec> = {};
    for (const [key, spec] of Object.entries((row.params ?? {}) as Record<string, unknown>)) {
      params[key] = readParam(schema, name, key, spec);
    }
    if (Object.values(params).filter((param) => param.max > 4096).length > WIRE_PARAM_LIMITS.maxOversizedParams) {
      throw new Error(
        `action ${name} declares more than ${WIRE_PARAM_LIMITS.maxOversizedParams} parameter over 4096 characters`,
      );
    }
    const binding = schema === 1
      ? (row.binding === "resource" ? "resource" : "runtime")
      : readActionBinding(name, row.binding);
    const handler = row.handler === undefined ? undefined : String(row.handler);
    const agent = row.agent === undefined ? undefined : String(row.agent);
    if (binding === "runtime" && handler !== name) {
      throw new Error(`runtime action ${name} must name its same-id handler`);
    }
    if (binding === "resource" && handler !== undefined) {
      throw new Error(`resource action ${name} is implemented by the trusted capability binding, not an app handler`);
    }
    if (binding === "agent" && handler !== undefined) {
      throw new Error(`agent action ${name} is implemented by the trusted agent plane, not an app handler`);
    }
    if (binding !== "agent" && agent !== undefined) {
      throw new Error(`${binding} action ${name} cannot name an agent`);
    }
    const historyCursor = row.history_cursor;
    if (historyCursor !== undefined && (schema < 4 || binding !== "runtime" || typeof historyCursor !== "string"
      || !params[historyCursor] || params[historyCursor]!.type !== "string" || params[historyCursor]!.max > 12
      || !params[historyCursor]!.required)) {
      throw new Error(`action ${name}.history_cursor must name a required bounded string parameter on a schema-4 runtime action`);
    }
    const humanOnly = schema >= 2 && flag(row.human_only, `action ${name}.human_only`);
    const agentOnly = schema >= 2 && flag(row.agent_only, `action ${name}.agent_only`);
    if (humanOnly && agentOnly) {
      // Two switches that cancel out are not a narrow action; they are an
      // action nobody can call, declared by somebody who believed otherwise.
      throw new Error(`action ${name} declares both human_only and agent_only`);
    }
    actions[name] = {
      binding,
      ...(handler ? { handler } : {}),
      ...(typeof historyCursor === "string" ? { historyCursor } : {}),
      ...(agent ? { agent } : {}),
      ...(schema >= 2 && row.title !== undefined ? { title: text(row.title, 120, `action ${name}.title`) } : {}),
      ...(schema >= 2 && row.description !== undefined
        ? { description: text(row.description, 400, `action ${name}.description`) }
        : {}),
      humanOnly,
      agentOnly,
      ...(actionRoles ? { roles: actionRoles } : {}),
      params,
    };
  }
  // Only Session Plus's own schema-1 releases are held to the frozen M4 surface.
  // It is a statement about THAT App's three rollback targets, not about the
  // profile — no other App has ever shipped a schema-1 release, so applying it
  // everywhere would refuse a file for failing to be somebody else's.
  if (schema === 1 && appId === "session-plus" && Object.keys(actions).join(",") !== M4_ACTIONS) {
    throw new Error("session-plus action declarations do not match the M4 operation surface");
  }
  const agents = schema === 1
    ? {}
    : readAgents(raw.agents, actions, options, { appId, schema, stateScope, roles });
  for (const [name, action] of Object.entries(actions)) {
    if (action.binding !== "agent") continue;
    if (stateScope === "shared" && schema < 4) {
      throw new Error(`shared agent action ${name} requires manifest schema 4`);
    }
    if (!action.agent || !agents[action.agent]) {
      throw new Error(`agent action ${name} names an undeclared agent ${JSON.stringify(action.agent ?? null)}`);
    }
    if (!action.humanOnly) {
      throw new Error(`agent action ${name} must be human_only so an agent cannot enqueue itself`);
    }
    const params = Object.entries(action.params);
    const prompt = action.params.prompt;
    if (params.length !== 1 || !prompt || prompt.type !== "string" || !prompt.required) {
      throw new Error(`agent action ${name} must declare exactly one required string parameter named prompt`);
    }
  }
  const page = (raw.view as Record<string, unknown> | undefined)?.page;
  const pageFile = path.resolve(appDir, String(page ?? ""));
  if (!pageFile.startsWith(`${path.resolve(appDir)}${path.sep}`)) throw new Error("view page declaration leaves the app directory");
  const manifest: SessionPlusManifest = {
    id: appId,
    schema,
    stateScope,
    stateEpoch,
    stateEpochDeclared,
    roles,
    actions,
    agents,
    pageFile,
  };
  if (cacheable) cached = manifest;
  return manifest;
}

function readStateEpoch(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("app.yaml state_epoch must be a non-negative safe integer");
  }
  return Number(value);
}

function readActionBinding(name: string, value: unknown): SessionPlusActionSpec["binding"] {
  if (value === "runtime" || value === "resource" || value === "agent") return value;
  throw new Error(`action ${name} declares an unknown binding ${JSON.stringify(value ?? null)}`);
}

/** Test seam: forget the memoised source-tree manifest. */
export function resetSessionPlusManifestCache(): void {
  cached = null;
}

function readParam(schema: 1 | 2 | 3 | 4, action: string, key: string, spec: unknown): SessionPlusParamSpec {
  const field = spec as Record<string, unknown>;
  if (!ID.test(key) || !field || typeof field !== "object") throw new Error(`invalid parameter ${action}.${key}`);
  if (schema === 1) {
    // Byte-for-byte the old branch: string only, no `required`, no `enum`.
    if (field.type !== "string") throw new Error(`invalid parameter ${action}.${key}`);
    const max = Number(field.max);
    if (!Number.isInteger(max) || max < 1 || max > 4096) throw new Error(`invalid maximum for ${action}.${key}`);
    return { type: "string", max, required: false };
  }
  refuseUnknown(`parameter ${action}.${key}`, field, SCHEMA2_PARAM);
  const type = String(field.type ?? "");
  if (type !== "string" && type !== "number" && type !== "boolean") {
    throw new Error(`parameter ${action}.${key} has an unsupported type ${JSON.stringify(field.type ?? null)}`);
  }
  const max = field.max === undefined ? defaultMax(type) : Number(field.max);
  if (!Number.isInteger(max) || max < 1 || max > WIRE_PARAM_LIMITS.maxDeclaredValueLength) {
    throw new Error(`invalid maximum for ${action}.${key}`);
  }
  const enumeration = field.enum === undefined ? undefined : readEnum(action, key, field.enum, max);
  return {
    type,
    max,
    required: flag(field.required, `parameter ${action}.${key}.required`),
    ...(field.description !== undefined
      ? { description: text(field.description, 400, `parameter ${action}.${key}.description`) }
      : {}),
    ...(enumeration ? { enum: enumeration } : {}),
  };
}

function defaultMax(type: SessionPlusParamType): number {
  return type === "string" ? 1024 : 24;
}

function readEnum(action: string, key: string, value: unknown, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error(`parameter ${action}.${key} declares an unusable enum`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry || entry.length > max) {
      throw new Error(`parameter ${action}.${key} declares an unusable enum entry`);
    }
    if (out.includes(entry)) throw new Error(`parameter ${action}.${key} repeats an enum entry`);
    out.push(entry);
  }
  return Object.freeze(out);
}

function readAgents(
  value: unknown,
  actions: Readonly<Record<string, SessionPlusActionSpec>>,
  options: LoadManifestOptions,
  manifest: {
    appId: string;
    schema: 2 | 3 | 4;
    stateScope: "account" | "shared";
    roles: Readonly<Record<string, SessionPlusRoleSpec>>;
  },
): Readonly<Record<string, SessionPlusAgentSpec>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("app.yaml agents must be a mapping");
  const rows = Object.entries(value as Record<string, unknown>);
  if (rows.length > APP_AGENT_LIMITS.maxAgents) {
    throw new Error(`app.yaml declares more than ${APP_AGENT_LIMITS.maxAgents} agents`);
  }
  const agents: Record<string, SessionPlusAgentSpec> = {};
  for (const [name, row] of rows) {
    if (!AGENT_ID.test(name) || !row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`invalid agent declaration: ${name}`);
    }
    const spec = row as Record<string, unknown>;
    refuseUnknown(`agent ${name}`, spec, manifest.schema === 4 ? SCHEMA4_AGENT : SCHEMA2_AGENT);
    const adapter = String(spec.adapter ?? "");
    if (!(APP_AGENT_ADAPTERS as readonly string[]).includes(adapter)) {
      throw new Error(`agent ${name} declares an unknown adapter ${JSON.stringify(spec.adapter ?? null)}`);
    }
    // SEC-06, at the FIRST of its gates. The predicate is imported from the
    // engine rather than restated here: two spellings of "may an ordinary App
    // agent run on this adapter" is how a release gets accepted in one place
    // and refused in another.
    const verdict = appAgentAdapterVerdict(adapter);
    if (!verdict.ok) throw new Error(`agent ${name} may not use adapter ${adapter}: ${verdict.reason}`);
    const prompt = text(spec.prompt, APP_AGENT_LIMITS.maxPromptChars, `agent ${name}.prompt`);
    if (!prompt.trim()) throw new Error(`agent ${name} declares an empty prompt`);
    const model = spec.model === undefined
      ? undefined
      : text(spec.model, APP_AGENT_LIMITS.maxModelChars, `agent ${name}.model`);
    if (model !== undefined && options.allowedModels && !options.allowedModels.includes(model)) {
      throw new Error(
        `agent ${name} asks for model ${JSON.stringify(model)}, which this deployment does not serve`
        + `（app_agents.models 里没有它；LLM 调用花的是部署者的钱，所以这条不能由发布者单方面决定）`,
      );
    }
    const effort = spec.effort === undefined ? undefined : String(spec.effort);
    if (effort !== undefined && !(APP_AGENT_EFFORTS as readonly string[]).includes(effort)) {
      throw new Error(`agent ${name} declares an unknown effort ${JSON.stringify(spec.effort ?? null)}`);
    }
    const daily = spec.daily === undefined ? undefined : String(spec.daily);
    if (daily !== undefined && !DAILY.test(daily)) {
      throw new Error(`agent ${name} declares an unusable daily time ${JSON.stringify(spec.daily ?? null)}`);
    }
    const dailyPrompt = spec.daily_prompt === undefined
      ? undefined
      : text(spec.daily_prompt, APP_AGENT_LIMITS.maxDailyPromptChars, `agent ${name}.daily_prompt`);
    if (dailyPrompt !== undefined && daily === undefined) {
      throw new Error(`agent ${name} declares daily_prompt without daily`);
    }
    const role = manifest.schema === 4 && spec.role !== undefined
      ? String(spec.role)
      : undefined;
    if (manifest.stateScope === "shared") {
      if (manifest.schema < 4) {
        // Schema 3 may carry dormant agent declarations, but it cannot bind
        // them to a shared actor. Keeping them dormant preserves the old
        // release's meaning; schema 4 is the explicit opt-in.
      } else if (!role || !manifest.roles[role]) {
        throw new Error(`shared agent ${name} must name a declared role`);
      }
    } else if (role !== undefined) {
      throw new Error(`account-scoped agent ${name} must not declare a role`);
    }
    if (role && `agent:${manifest.appId}/${name}#${role}`.length > 160) {
      throw new Error(`shared agent ${name}'s role evidence is too long for the audit actor`);
    }
    agents[name] = {
      name,
      adapter: adapter as AppAgentAdapter,
      prompt,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort: effort as AppAgentEffort } : {}),
      ...(daily !== undefined ? { daily } : {}),
      ...(dailyPrompt !== undefined ? { dailyPrompt } : {}),
      ...(role !== undefined ? { role } : {}),
    };
  }
  // An agent that can reach nothing is a declaration nobody can act on. Said
  // once, here, rather than discovered at the first turn.
  if (Object.keys(agents).length && !Object.values(actions).some((action) => !action.humanOnly)) {
    throw new Error("app.yaml declares agents but every action is human_only");
  }
  return agents;
}

/** schema 3 only. The role vocabulary the membership door will admit against. */
function readRoles(value: unknown): Readonly<Record<string, SessionPlusRoleSpec>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("app.yaml roles must be a mapping");
  const roles: Record<string, SessionPlusRoleSpec> = {};
  const rows = Object.entries(value as Record<string, unknown>);
  if (rows.length > 16) throw new Error("app.yaml declares more than 16 roles");
  for (const [name, row] of rows) {
    if (!ID.test(name) || !row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`invalid role declaration: ${name}`);
    }
    const spec = row as Record<string, unknown>;
    refuseUnknown(`role ${name}`, spec, SCHEMA3_ROLE);
    const max = Number(spec.max);
    if (!Number.isInteger(max) || max < 1 || max > 64) throw new Error(`role ${name} needs max in 1..64`);
    roles[name] = { max, observer: flag(spec.observer, `role ${name}.observer`) };
  }
  return roles;
}

/**
 * schema 3 only. `shared` requires a non-empty role vocabulary — not for the
 * door's convenience, but so the file is UNREADABLE by builds that would have
 * served it as a per-account App (`roles` is a top-level key they refuse).
 */
function readStateScope(
  value: unknown,
  roles: Readonly<Record<string, SessionPlusRoleSpec>>,
): "account" | "shared" {
  let scope: "account" | "shared" = "account";
  if (value !== undefined) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("app.yaml state must be a mapping");
    const row = value as Record<string, unknown>;
    refuseUnknown("state", row, SCHEMA3_STATE);
    const declared = row.scope === undefined ? "account" : String(row.scope);
    if (declared !== "account" && declared !== "shared") {
      throw new Error(`state.scope must be account or shared, not ${JSON.stringify(row.scope)}`);
    }
    scope = declared;
  }
  // Cross-checks run whether or not `state:` was written at all: an absent
  // block is one of the two spellings of account scope, not an exemption.
  if (scope === "shared" && !Object.keys(roles).length) {
    throw new Error("state.scope: shared requires a top-level roles declaration");
  }
  if (scope === "account" && Object.keys(roles).length) {
    throw new Error("roles are declared but state.scope is account; roles only mean something in a shared App");
  }
  return scope;
}

/** schema 3 only. An action's role allowlist, checked against the vocabulary. */
function readActionRoles(
  action: string,
  value: unknown,
  roles: Readonly<Record<string, SessionPlusRoleSpec>>,
  stateScope: "account" | "shared",
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (stateScope !== "shared") throw new Error(`action ${action} declares roles but state.scope is not shared`);
  if (!Array.isArray(value) || value.length === 0) throw new Error(`action ${action}.roles must be a non-empty list`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !roles[entry]) {
      throw new Error(`action ${action} names an undeclared role ${JSON.stringify(entry)}`);
    }
    if (out.includes(entry)) throw new Error(`action ${action} repeats role ${entry}`);
    out.push(entry);
  }
  return Object.freeze(out);
}

function refuseUnknown(where: string, row: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(row).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(`${where} declares unknown key(s): ${unknown.sort().join(", ")}`);
  }
}

function flag(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${where} must be true or false`);
  return value;
}

function text(value: unknown, max: number, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  if (value.length > max) throw new Error(`${where} is longer than ${max} characters`);
  return value;
}

/** Who is proposing. Supplied by trusted code; never read off a proposal. */
export type SessionPlusActorKind = "user" | "agent";

/**
 * Why a proposal was not normalised.
 *
 * `invalid_params` is separate from `unknown_action` because the agent and MCP
 * faces need to tell a model "you left out `session`" rather than "no such
 * tool" — the second sends it off to invent a different tool name.
 */
export type NormalizedAction =
  | { ok: true; action: string; params: Record<string, string> }
  | { ok: false; code: "unknown_action" | "invalid_params"; message: string };

/**
 * Copy only fields declared by trusted release metadata; retain no caller
 * object references.
 *
 * Values are normalised to STRINGS whatever their declared type, because the
 * whole wire — MessagePort proposal, Runtime `invoke`, operation binding — is
 * flat strings, and a second representation would be a second thing to keep in
 * step. `number`/`boolean` change which requests are ACCEPTED (and what the
 * derived tool schema says), not what an accepted one turns into.
 */
export function normalizeSessionPlusAction(
  manifest: SessionPlusManifest,
  action: unknown,
  rawParams: unknown,
  actor: SessionPlusActorKind = "user",
): NormalizedAction {
  if (typeof action !== "string") return { ok: false, code: "unknown_action", message: "这个动作不在当前 release 的声明里" };
  const spec = manifest.actions[action];
  if (!spec) return { ok: false, code: "unknown_action", message: "这个动作不在当前 release 的声明里" };
  if (actor === "agent" && spec.humanOnly) {
    return { ok: false, code: "unknown_action", message: `动作 ${action} 只接受本人操作，不接受 agent 提议` };
  }
  if (actor === "user" && spec.agentOnly) {
    return { ok: false, code: "unknown_action", message: `动作 ${action} 只由 agent 平面驱动` };
  }
  const input = rawParams && typeof rawParams === "object" ? rawParams as Record<string, unknown> : {};
  const params: Record<string, string> = {};
  for (const [key, field] of Object.entries(spec.params)) {
    const value = input[key];
    if (manifest.schema === 1) {
      // Unchanged: absent or non-string becomes "".
      params[key] = typeof value === "string" ? value.slice(0, field.max) : "";
      continue;
    }
    if (value === undefined || value === null || value === "") {
      if (field.required) {
        return { ok: false, code: "invalid_params", message: `缺少必填参数 ${key}` };
      }
      params[key] = "";
      continue;
    }
    const coerced = coerce(field, value);
    if (coerced === null) {
      // Present but unusable is a REFUSAL, never "absent". Treating a
      // malformed number as missing is exactly the silent coercion schema 2
      // exists to remove: the caller learns nothing and the action runs with a
      // parameter it never received.
      return { ok: false, code: "invalid_params", message: `参数 ${key} 不是一个合法的 ${field.type}` };
    }
    if (coerced.length > field.max) {
      return { ok: false, code: "invalid_params", message: `参数 ${key} 超过 ${field.max} 个字符` };
    }
    if (field.enum && !field.enum.includes(coerced)) {
      return { ok: false, code: "invalid_params", message: `参数 ${key} 不在允许的取值里` };
    }
    params[key] = coerced;
  }
  return { ok: true, action, params };
}

/** The wire form of one declared parameter, or null when it is unusable. */
function coerce(field: SessionPlusParamSpec, value: unknown): string | null {
  switch (field.type) {
    case "string":
      return typeof value === "string" ? value : null;
    case "number": {
      if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
      if (typeof value !== "string") return null;
      return Number.isFinite(Number(value)) && value.trim() !== "" ? value.trim() : null;
    }
    case "boolean": {
      if (typeof value === "boolean") return value ? "true" : "false";
      if (value === "true" || value === "false") return value;
      return null;
    }
  }
}

/** The actions one actor kind may see and drive, in declaration order. */
export function sessionPlusActionsFor(
  manifest: SessionPlusManifest,
  actor: SessionPlusActorKind,
): Array<{ name: string; spec: SessionPlusActionSpec }> {
  return Object.entries(manifest.actions)
    .filter(([, spec]) => (actor === "agent" ? !spec.humanOnly : !spec.agentOnly))
    .map(([name, spec]) => ({ name, spec }));
}

export interface AppActionToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
}

/**
 * Derive one action's tool description.
 *
 * The SAME declaration the button face reads, and deliberately no validator of
 * its own: whatever this schema says, the door still runs
 * `normalizeSessionPlusAction`. A JSON-Schema check here would be a second
 * answer to "is this parameter required", and two answers disagree per-face,
 * which is the hardest class of bug to find.
 */
export function appActionTool(name: string, spec: SessionPlusActionSpec): AppActionToolSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(spec.params)) {
    properties[key] = {
      type: field.type,
      ...(field.description ? { description: field.description } : {}),
      ...(field.type === "string" ? { maxLength: field.max } : {}),
      ...(field.enum ? { enum: [...field.enum] } : {}),
    };
    if (field.required) required.push(key);
  }
  return {
    name,
    description: [spec.title, spec.description].filter(Boolean).join(" — ") || name,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}
