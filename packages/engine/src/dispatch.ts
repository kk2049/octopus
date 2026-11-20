/**
 * The single door — the Actions primitive.
 *
 * One action declaration serves every face: the page button, the HTTP API and
 * the agent tool all end in `AppInstance.dispatch()`, so validation,
 * authorization and audit happen exactly once (generalizing hq/ops.ts, which
 * proved the shape). Nothing else in the system may append domain events.
 *
 * Consistency model, deliberately boring: every dispatch for a given
 * (app, scope) runs on one serial chain — read state, run the pure handler,
 * append its events as one batch. Races are prevented by construction, not by
 * app-level locking; the cost is that a scope's writes are single-file, which
 * at human+agent scale is the right trade.
 *
 * ── A dispatch writes ONE log, and it is this instance's ────────────────────
 *
 * `ActionResult.deliveries` used to let a handler name another scope and a
 * batch of events, and the engine appended them for it. Three things were
 * wrong with that at once (SEC-01): the write happened after the ControllerRun
 * had already been closed, so it passed through no gate at all; the handler —
 * hot-reloaded code chosen by a language model — picked the target, the event
 * types and the payloads; and the target doubled as a filesystem path segment,
 * so `../` in a "username" moved the file.
 *
 * Cross-scope information flow is legitimate (a report from one person to
 * another is the point of the reports app). What is not legitimate is a
 * general-purpose append into a scope nobody authorised. So the local append
 * below is now the ONLY thing a dispatch can do to an event log, and it has no
 * scope parameter; a transfer is an explicit capability operation
 * (`host/delivery.ts`) that the handler requests like any other resource.
 */

import { EventLog } from "./store.js";
import {
  type Actor,
  actorUser,
  type EngineEvent,
  type EventInput,
  type Predicate,
} from "./types.js";

export interface ParamSpec {
  type: "string" | "number" | "boolean" | "object";
  required?: boolean;
  enum?: string[];
  /**
   * UI affordance only: options come from a view path (array of strings or
   * {id, title}). The server does NOT validate against it — the handler's own
   * check stays the single source of truth, so a stale dropdown degrades to a
   * helpful handler error instead of a silent lie.
   */
  enumBind?: string;
  description?: string;
}

export interface ActionSpec {
  name: string;
  title?: string;
  description?: string;
  predicate: Predicate;
  /** Gates whose point is proving a human is present (dead-man switches). */
  humanOnly?: boolean;
  /** Internal plumbing not worth a button. */
  agentOnly?: boolean;
  params?: Record<string, ParamSpec>;
  /** Opt-in to feishu card rendering (card-grade surfaces). */
  feishu?: boolean;
  /** Ask the web UI for an extra confirmation click. Advisory, UI-level. */
  confirm?: boolean;
}

export interface ActionCtx<V = unknown> {
  actor: Actor;
  scope: string;
  scopeOwner: string;
  /** Projection view at dispatch time — read inside the serial section. */
  state: V;
  now: string;
  /**
   * The ControllerRun's bound capabilities — the ONLY way a handler can touch
   * a platform resource. Created before the handler runs and destroyed after,
   * from the App Context the trusted launcher established; the handler cannot
   * name a principal, an App or a Context, only a slot it was given.
   *
   * Absent when the handler runs in a Host with no capability service wired,
   * which is the same as holding nothing.
   */
  capabilities?: ControllerCapabilities;
}

/**
 * What a handler holds. Re-declared so engine consumers do not have to import
 * the kernel; `result` is scoped to the AppInstance, not the run.
 */
export interface ControllerCapabilities {
  request(
    slot: string,
    operation: string,
    args: unknown,
  ): Promise<
    | { status: "succeeded"; result: unknown }
    | { status: "approval_required"; pendingCallId: string }
    | { status: "denied"; reason: string }
    | { status: "failed"; reason: string }
    | { status: "unknown"; reason: string }
  >;
  /**
   * What happened to a dangerous call THIS app instance made.
   *
   * Answered at the instance level rather than the run level, because the
   * dispatch that created a PendingCall is not the dispatch that comes back to
   * render it — the next one is a sibling, and siblings cannot see each other's
   * calls. `null` for anything else: a pending id is a lookup key, never a
   * credential, so one learned from another instance or another user reads
   * nothing.
   */
  result?(pendingCallId: string): {
    state: string;
    outcome: string | null;
    result: unknown;
    reason: string | null;
  } | null;
}

/**
 * A ControllerRun lease: capabilities for exactly one dispatch, plus the
 * teardown that ends the Context when the call returns.
 */
export interface ControllerRun {
  caps: ControllerCapabilities;
  close(): void;
}

export interface ActionResult {
  /** Appended to THIS instance's log. There is no scope parameter, by design. */
  events?: EventInput[];
  /** Short human/agent-facing acknowledgement. */
  reply?: string;
}

export type ActionHandler<V = unknown> = (
  ctx: ActionCtx<V>,
  params: Record<string, unknown>,
) => ActionResult | Promise<ActionResult> | void;

export type DispatchOutcome =
  | { ok: true; seq: number; reply?: string; events: EngineEvent[]; warnings?: string[] }
  | {
      ok: false;
      code: "unknown_action" | "forbidden" | "invalid_params" | "handler_error";
      message: string;
    };

export interface InstanceDeps {
  actions: () => Record<string, ActionSpec> | Promise<Record<string, ActionSpec>>;
  /**
   * Run one action handler. Returns a `no_handler` marker rather than a map of
   * functions because the handler no longer lives in this process: app code
   * runs in the sandboxed runtime and is reachable only by name.
   */
  runHandler: (
    action: string,
    ctx: ActionCtx,
    params: Record<string, unknown>,
    run?: ControllerRun,
  ) => Promise<ActionResult>;
  project: (events: readonly EngineEvent[]) => unknown | Promise<unknown>;
  admins?: string[];
  /**
   * Trusted control plane hook: derive a ControllerRun Context for this
   * dispatch. `parent` is an opaque server-side handle (an AgentRun Context,
   * when an agent is the caller) — never anything the caller supplied.
   */
  controllerRun?: (action: string, actor: Actor, parent?: unknown) => Promise<ControllerRun | null>;
}

/** Light param validation with form-friendly coercion ("5" → 5, "true" → true). */
export function validateParams(
  specs: Record<string, ParamSpec> | undefined,
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, message: "params must be an object" };
  }
  const src = (raw ?? {}) as Record<string, unknown>;
  const specMap = specs ?? {};
  for (const key of Object.keys(src)) {
    // hasOwnProperty, not `in`: `in` walks the prototype chain, so "toString",
    // "constructor" and "__proto__" would all look like declared params on
    // every schema. The kernel's arg validator already learned this; the other
    // "single door" had not.
    if (!Object.prototype.hasOwnProperty.call(specMap, key)) {
      return { ok: false, message: `unknown param "${key}"` };
    }
  }
  const value: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specMap)) {
    let v = src[key];
    if (v === undefined || v === null || v === "") {
      if (spec.required) return { ok: false, message: `missing required param "${key}"` };
      continue;
    }
    if (spec.type === "number" && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      v = Number(v);
    }
    if (spec.type === "boolean" && (v === "true" || v === "false")) v = v === "true";
    const t = spec.type === "object" ? typeof v === "object" : typeof v === spec.type;
    if (!t) return { ok: false, message: `param "${key}" must be a ${spec.type}` };
    if (spec.enum && !spec.enum.includes(String(v))) {
      return { ok: false, message: `param "${key}" must be one of: ${spec.enum.join(", ")}` };
    }
    value[key] = v;
  }
  return { ok: true, value };
}

export class AppInstance {
  readonly log: EventLog;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly app: string,
    readonly scope: string,
    readonly scopeOwner: string,
    logFile: string,
    private deps: InstanceDeps,
  ) {
    this.log = new EventLog(logFile);
  }

  async view(): Promise<unknown> {
    return this.deps.project(this.log.read());
  }

  /**
   * Authorization = identity × predicate word. Pages never widen this; the
   * discovery guarantee is that whatever passes here for a user also passes
   * for that user's bound agent (unless humanOnly says the gate's whole point
   * is a human).
   */
  authz(spec: ActionSpec, actor: Actor): { ok: true } | { ok: false; message: string } {
    if (actor.kind === "system") {
      return { ok: false, message: "system actors append directly, not through dispatch" };
    }
    if (spec.humanOnly && actor.kind !== "user") {
      return { ok: false, message: `"${spec.name}" is human-only` };
    }
    if (spec.agentOnly && actor.kind !== "agent") {
      return { ok: false, message: `"${spec.name}" is agent-only` };
    }
    switch (spec.predicate) {
      case "any":
        return { ok: true };
      case "owner":
        return actorUser(actor) === this.scopeOwner
          ? { ok: true }
          : { ok: false, message: `"${spec.name}" is owner-only (authorship is not delegable)` };
      case "admin": {
        const u = actorUser(actor);
        return u && (this.deps.admins ?? []).includes(u)
          ? { ok: true }
          : { ok: false, message: `"${spec.name}" requires admin` };
      }
    }
  }

  /** The discovery guarantee, as an API: everything this actor could invoke. */
  async listActions(actor: Actor): Promise<ActionSpec[]> {
    const actions = await this.deps.actions();
    return Object.values(actions).filter((s) => this.authz(s, actor).ok);
  }

  /**
   * `runContext` is an opaque server-side handle (e.g. the AgentRun Context of
   * the agent making this tool call). It is supplied by the trusted caller,
   * never by a request body — the whole point is that a Controller's authority
   * is derived from the lifecycle that started it.
   */
  dispatch(action: string, params: unknown, actor: Actor, runContext?: unknown): Promise<DispatchOutcome> {
    const run = this.chain.then(() => this.doDispatch(action, params, actor, runContext));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doDispatch(
    action: string,
    params: unknown,
    actor: Actor,
    runContext?: unknown,
  ): Promise<DispatchOutcome> {
    const actions = await this.deps.actions();
    const spec = actions[action];
    if (!spec) return { ok: false, code: "unknown_action", message: `unknown action "${action}"` };
    const auth = this.authz(spec, actor);
    if (!auth.ok) return { ok: false, code: "forbidden", message: auth.message };
    const p = validateParams(spec.params, params);
    if (!p.ok) return { ok: false, code: "invalid_params", message: p.message };

    let result: ActionResult;
    // Short-lived by construction: created here, destroyed in `finally`. A
    // handler cannot stash it, because it never receives the Context — only a
    // facade bound to it for the duration of this call.
    const controllerRun = (await this.deps.controllerRun?.(action, actor, runContext)) ?? null;
    try {
      const state = await this.deps.project(this.log.read());
      result =
        (await this.deps.runHandler(
          action,
          { actor, scope: this.scope, scopeOwner: this.scopeOwner, state, now: new Date().toISOString() },
          p.value,
          controllerRun ?? undefined,
        )) ?? {};
    } catch (err) {
      return { ok: false, code: "handler_error", message: String((err as Error)?.message ?? err) };
    } finally {
      controllerRun?.close();
    }

    const events = result.events ?? [];
    const stamped = events.length ? await this.log.append(events, actor) : [];

    const warnings: string[] = [];
    // Not a filter that keeps a bypass alive — there is no code below that
    // could act on this key. It is said out loud because an app built against
    // the old shape would otherwise appear to send and silently not, and a
    // handler that still returns it is a handler nobody has migrated.
    if (Object.prototype.hasOwnProperty.call(result, "deliveries")) {
      warnings.push(
        'this handler returned "deliveries", which no longer exists: cross-scope transfer is an explicit '
          + 'capability operation (request the "delivery" slot), not a value a handler can return',
      );
    }

    return {
      ok: true,
      seq: this.log.revision,
      reply: result.reply,
      events: stamped,
      ...(warnings.length ? { warnings } : {}),
    };
  }
}
