/**
 * The host — kernel material (drain/restart tier, never hot-plugged).
 *
 * What it owns: HTTP + SSE connections, the manifest hot-reloader, the
 * (app, scope) → AppInstance registry, auth. What it does NOT own: domain
 * logic (lives in app event logs + pure functions) and rendering decisions
 * (live in page YAML + the shared client runtime).
 *
 * Refresh is ONE semantic everywhere: append → recompute projection → push
 * full view to subscribers (SSE). Polling exists only as the transport
 * fallback the browser's EventSource gives us for free on reconnect.
 *
 * Editing materials while running:
 *   *.yaml   → manifests revalidate; open pages get {reload:true}. A broken
 *              edit keeps the last good manifest and shows the error banner —
 *              hot-plug must fail loudly and safely, never half-apply.
 *   *.ts     → nothing to do here; HotModule re-imports on next call, and we
 *              nudge subscribers so views recompute promptly.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import { recordConvergenceUsage } from "@claude-bot/convergence-gates";
import { factoryPage } from "./factory-page.js";
import { VIEW_FRAME_SANDBOX, viewFrameHeaders, viewFrameHtml } from "./view-frame.js";
import { renderFeishuCard } from "../cards/feishu.js";
import { CLIENT_CSS, CLIENT_JS } from "../cards/client.js";
import { resolveShimToken } from "../agent/shim-registry.js";
import { AppInstance, type ActionCtx, type ActionResult, type ActionSpec, type ControllerRun } from "../dispatch.js";
import {
  DeliveryBroker,
  REPLY_RECEIVED,
  REPORT_RECEIVED,
  type ReportEnvelope,
} from "./delivery.js";
import { loadApp, type AppManifest, ManifestError } from "../manifest.js";
import { AppSandbox } from "../runtime/sandbox.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import {
  SAFE_METHODS,
  clearSessionCookies,
  issueSessionCookies,
  mutationGate,
  parseJsonBodyText,
  type CookieContract,
} from "@claude-bot/web-trust";
import {
  CSRF_HEADER,
  HostSecurity,
  allowedOrigins as computeAllowedOrigins,
  hostCookies,
  originOk,
  secretEquals,
  type AppInstanceBinding,
} from "./security.js";
import { stampOf, versionOf as computeVersion, type AppVersion } from "./versions.js";
import type { Actor, EngineEvent } from "../types.js";

/** Cap on any request body, in bytes. A Host is not a file server. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * A raw ServerResponse reports some failed writes by emitting `error` on a
 * later tick. A try/catch around `write()` cannot see that event, so every SSE
 * owner must install this listener before its first write and make teardown
 * idempotent across `error`, `finish`, and `close`.
 */
export function onRawSseEnd(
  response: Pick<http.ServerResponse, "on">,
  cleanup: () => void,
): () => void {
  let ended = false;
  const stop = (): void => {
    if (ended) return;
    ended = true;
    cleanup();
  };
  response.on("error", stop);
  response.on("finish", stop);
  response.on("close", stop);
  return stop;
}

function observeFactory(
  principal: string,
  entry: string,
  effect: "read" | "write",
  outcome: "ok" | "refused" | "observed",
  reason?: string,
  release?: string,
): void {
  recordConvergenceUsage({
    candidate: "v3-host-factory",
    principal,
    entry,
    provider: "v3-host",
    effect,
    outcome,
    ...(reason ? { reason } : {}),
    ...(release ? { release } : {}),
  });
}

function observeEngineAgent(principal: string, entry: string, effect: "read" | "write" | "execute", outcome: "refused", reason: string): void {
  recordConvergenceUsage({
    candidate: "engine-agent-plane",
    principal,
    entry,
    provider: "v3-host-agent",
    effect,
    outcome,
    reason,
  });
}

/**
 * What an app name or a scope may look like.
 *
 * A scope is a TRUSTED IDENTIFIER (a username, or the literal "shared"), and
 * the only reason it is ever concatenated into a path is that a log file needs
 * a name. Anything that could also be read as a path — a separator, a `..`, a
 * leading dot, an absolute path, a NUL — is refused here rather than escaped,
 * because escaping invites "did we catch every spelling".
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function safeIdentifier(s: unknown): boolean {
  return typeof s === "string" && SAFE_IDENTIFIER.test(s) && !s.includes("..");
}

/**
 * Short aliases, because these two appear in every handler signature. They are
 * Fastify's own types: the Host no longer touches `http.ServerResponse` except
 * on the one route that streams (SSE), which hijacks the reply and says so.
 */
type Req = FastifyRequest;
type Reply = FastifyReply;

export interface HostUser {
  token: string;
  admin?: boolean;
}

export interface Viewer {
  username: string;
  admin: boolean;
}

/**
 * A viewer plus how it authenticated. `sessionKey` is empty for a bearer,
 * which is why a bearer cannot open an AppInstance: an instance's lifetime is
 * its session's, and there is no session to end.
 */
export interface ResolvedViewer extends Viewer {
  viaSession: boolean;
  sessionKey: string;
}

export interface AgentPlaneApi {
  transcript(
    app: string,
    scope: string,
    agent: string,
    viewer: Viewer,
  ): Promise<
    | {
        ok: true;
        messages: Array<{ role: string; text: string; at?: string }>;
        running: boolean;
        since?: number;
        adapter?: string;
        adapterReady?: boolean;
        model?: string;
        effort?: string;
        session?: { kind: string; id?: string; file?: string };
        rich?: {
          source: string;
          entries: Array<{ kind: string; text: string; detail?: string; action?: string; at?: string }>;
          files: string[];
        };
        mcp?: string[];
      }
    | { ok: false; message: string }
  >;
  setAgentConfig?(
    app: string,
    scope: string,
    agent: string,
    viewer: Viewer,
    cfg: { adapter?: string; model?: string; effort?: string; mcp?: string[] },
  ): Promise<{ ok: true; config: unknown } | { ok: false; message: string }>;
  send(
    app: string,
    scope: string,
    agent: string,
    viewer: Viewer,
    text: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface HostOptions {
  port: number;
  host?: string;
  appsDir: string;
  dataDir: string;
  users: Record<string, HostUser>;
  publicUrl?: string;
  /** Names of grantable MCP servers (full entries live with the plane). */
  mcpCatalogNames?: string[];
  /**
   * Trusted control plane for platform resources. Absent = no App, Controller
   * or Agent in this Host can reach any resource at all, which is the correct
   * default for a probe with no resources of its own.
   */
  capabilities?: HostCapabilityPlane;
  /**
   * The controlled cross-scope transfer broker. Absent = no app in this Host
   * can write into another scope at all, by construction — there is no other
   * code path that appends to a log this Host did not open for the caller.
   *
   * The Host attaches its own mailbox writer to it at construction, so the
   * broker never learns a path and the Host never learns a policy.
   */
  delivery?: DeliveryBroker;
  /** Injectable clock for session/instance lifetimes (tests). */
  now?: () => number;
}

/**
 * What the Host needs from a capability service, and nothing more. Kept as an
 * interface so the engine does not have to know whose Objects these are: the
 * bot supplies Runner authority, a test supplies a fake one.
 */
export interface HostCapabilityPlane {
  /**
   * Derive an AppInstance Context for a user opening an app. Returns null
   * when the user has no authority to derive from — a closed answer, not a
   * reason to run the app unbound.
   */
  openApp(o: { username: string; app: string; scope: string; digest: string }): Promise<string | null> | string | null;
  /** Per-dispatch ControllerRun lease, derived from `parent`. */
  openControllerRun(o: {
    username: string;
    app: string;
    action: string;
    parentContextId: string;
    /** Code identity of the version this dispatch is bound to (audit). */
    digest?: string;
  }): Promise<ControllerRun | null> | ControllerRun | null;
  /** Per-turn AgentRun Context, derived from the App Context. */
  openAgentRun(o: {
    username: string;
    app: string;
    agent: string;
    parentContextId: string;
    digest?: string;
  }): Promise<{ contextId: string; close(): void } | null> | { contextId: string; close(): void } | null;
  destroyContext(contextId: string): void;
  /**
   * Is a previously derived Context still worth reusing — live, and still
   * holding something? Only the agent path reuses a Context at all; browser
   * instances derive a fresh one per launch.
   */
  appContextUsable?(contextId: string): boolean;
  /**
   * The recorded outcome of a dangerous call made by ONE app instance, looked
   * up from that instance's Context. Optional; a plane without it means the
   * result endpoint has nothing to answer.
   */
  pendingResult?(appContextId: string, pendingCallId: string): {
    state: string;
    outcome: string | null;
    result: unknown;
    reason: string | null;
  } | null;
}

interface ProjectionModuleShape {
  project(events: readonly EngineEvent[]): unknown;
}

export class Host {
  private manifests = new Map<string, AppManifest>();
  private manifestErrors = new Map<string, string>();
  private instances = new Map<string, AppInstance>();
  /** One sandboxed child per app; app code never runs in this process. */
  private sandboxes = new Map<string, AppSandbox>();
  /**
   * Per-app version state: code identity, executable identity, presentation
   * identity, the (mtime, size) stamp that decides whether to recompute, and
   * whether the app is halted. A CODE change destroys Contexts; a presentation
   * change does not (SEC-02, `host/versions.ts`).
   */
  private versions = new Map<string, AppVersion>();
  /**
   * app/scope/agent → the Context an AGENT runs its turns from.
   *
   * Agents are not tabs: they have no session and no handle, so they cannot
   * borrow an AppInstance Context. They get their own, derived from the account
   * root on first use and destroyed on a code change. Nothing in the browser
   * path reads this map.
   */
  private agentContexts = new Map<string, string>();
  readonly security: HostSecurity;
  /**
   * The cookie names this deployment issues and accepts, decided once from the
   * same configuration that decides `Secure` (`security.ts`, `hostCookies`).
   * Read at every cookie site so `__Host-` cannot hold at one and not another.
   */
  private cookies: CookieContract;
  private app: FastifyInstance | null = null;
  private sse = new Map<string, Set<http.ServerResponse>>();
  private pushTimers = new Map<string, NodeJS.Timeout>();
  private watchers: fs.FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | null = null;
  private server: http.Server | null = null;
  private agentPlane: AgentPlaneApi | null = null;
  private instanceHooks: Array<(inst: AppInstance) => void> = [];

  constructor(readonly opts: HostOptions) {
    this.security = new HostSecurity(opts.now);
    this.cookies = hostCookies(opts.publicUrl);
    // The broker holds the only reference to this function, and this function
    // is the only way anything reaches another scope's log.
    opts.delivery?.attachMailbox((o) => this.receiveDelivery(o));
  }

  /**
   * Deposit ONE server-authored envelope in a recipient's mailbox.
   *
   * Reached only from the delivery adapter, i.e. only after the Gate said yes.
   * What it still enforces itself, because a writer should not depend on its
   * caller having been careful:
   *
   *  · the app must exist and be per-user — a shared-scope app has no mailboxes;
   *  · the recipient becomes a path only through `logFileFor`, which refuses
   *    anything that is not an identifier and asserts the data root;
   *  · the event type is one of two constants, and the author is the broker
   *    (`system:delivery/<sender>`) rather than the sender. The sender did not
   *    write in the recipient's log; the broker did, on their behalf, after a
   *    decision — and an app cannot produce `system:` authorship anywhere.
   *  · the write is idempotent on (delivery_id, from) INSIDE the log's serial
   *    chain, so a retry — or two concurrent sends of one id — leaves one
   *    receipt.
   */
  private async receiveDelivery(o: {
    app: string;
    recipient: string;
    envelope: ReportEnvelope;
  }): Promise<{ delivered: boolean; duplicate: boolean }> {
    const m = this.manifests.get(o.app);
    if (!m) throw new Error(`unknown app "${o.app}"`);
    if (m.scope !== "per-user") throw new Error(`app "${o.app}" is not per-user and has no mailboxes`);
    const inst = this.instance(o.app, o.recipient);
    const env = o.envelope;
    const { kind, ...data } = env;
    const out = await inst.log.appendUnique(
      [{ type: kind, data }],
      { kind: "system", name: `delivery/${env.from}` },
      (existing) =>
        existing.some((e) => {
          if (e.type !== REPORT_RECEIVED && e.type !== REPLY_RECEIVED) return false;
          const d = e.data as { delivery_id?: unknown; from?: unknown } | null;
          return d?.delivery_id === env.delivery_id && d?.from === env.from;
        }),
    );
    return { delivered: true, duplicate: out.duplicate };
  }

  /** Registered callbacks fire for existing instances too (restart recovery). */
  onInstanceCreated(cb: (inst: AppInstance) => void): void {
    this.instanceHooks.push(cb);
    for (const inst of this.instances.values()) cb(inst);
  }

  // ── registry ──

  get admins(): string[] {
    return Object.entries(this.opts.users)
      .filter(([, u]) => u.admin)
      .map(([name]) => name);
  }

  listManifests(): AppManifest[] {
    return [...this.manifests.values()].sort((a, b) => a.app.localeCompare(b.app));
  }

  getManifest(app: string): AppManifest | undefined {
    return this.manifests.get(app);
  }

  /**
   * The sandbox serving one (app, scope) — i.e. one security context.
   *
   * This pool is for PROJECTION ONLY — pure `fold(events) -> view` over one
   * (app, scope) log, never handed a capability broker, so a forged frame from
   * it is refused for want of anything to attribute it to.
   *
   * Handler runtimes are deliberately NOT pooled: each invocation gets its own
   * process, created with that run's broker and reaped before the call returns
   * (runtime/sandbox.ts). Ownership therefore follows the ControllerRun rather
   * than an (app, scope, user) string, and there is no residency for a delayed
   * forged frame to be written from.
   */
  private projectionPool(m: AppManifest, appName: string, scope: string): AppSandbox {
    const key = `${appName}/${scope}/#projection`;
    let sb = this.sandboxes.get(key);
    if (!sb) {
      sb = new AppSandbox({
        appDir: m.dir,
        contextKey: key,
        onStderr: (line) => console.warn(`[app:${key}] ${line}`),
      });
      this.sandboxes.set(key, sb);
    }
    return sb;
  }

  /**
   * A runtime for exactly one handler invocation. It holds no process until
   * `runHandler` is called and none afterwards, so "teardown" is the call
   * returning — nothing to key, cache or invalidate.
   */
  private runSandbox(m: AppManifest, label: string): AppSandbox {
    return new AppSandbox({
      appDir: m.dir,
      contextKey: label,
      onStderr: (line) => console.warn(`[app:${label}] ${line}`),
    });
  }

  /**
   * Where one (app, scope) log lives — the one place a scope becomes a path.
   *
   * Two independent checks, because either alone has been enough somewhere:
   * the identifiers must LOOK like identifiers (no separator, no `..`, no
   * absolute path, bounded length), and the resolved file must still be under
   * the data root. The second is defence in depth against a future spelling
   * the first does not anticipate — and it is the assertion the backlog asks
   * for, so that "scope is a trusted identifier" has a check behind it rather
   * than a convention.
   */
  private logFileFor(appName: string, scope: string): string {
    if (!safeIdentifier(appName)) throw new Error(`invalid app identifier "${appName}"`);
    if (!safeIdentifier(scope)) throw new Error(`invalid scope identifier "${scope}"`);
    const root = path.resolve(this.opts.dataDir, "apps");
    const file = path.resolve(root, appName, scope, "log.jsonl");
    if (!file.startsWith(root + path.sep)) throw new Error("event log path escaped the data root");
    return file;
  }

  instance(appName: string, scope: string): AppInstance {
    // Settle the version BEFORE handing out an instance. Everything that
    // dispatches goes through here, so this is where "no new dispatch on a
    // stale Context" is enforced — and because `refreshDir` is synchronous,
    // nothing can interleave between the switch and the call that follows it.
    this.ensureFresh(appName);
    if (this.versions.get(appName)?.halted) {
      throw new Error(`app "${appName}" is halted: its running version cannot be established`);
    }
    const key = `${appName}/${scope}`;
    const cached = this.instances.get(key);
    if (cached) return cached;
    const m = this.manifests.get(appName);
    if (!m) throw new Error(`unknown app "${appName}"`);
    // Resolved per call, not captured: a code-version change replaces the
    // sandbox (killing the old child), and the instance must pick up the new
    // one rather than talk to a corpse.
    // One process per handler invocation, holding that run's broker for its
    // whole life. Not keyed by anything: sharing is what the exploit needed.
    const handlerSandbox = (label: string): AppSandbox =>
      this.runSandbox(this.manifests.get(appName) ?? m, label);
    // Projections are capability-free pure functions over this (app, scope)
    // log, so they may share a pooled child.
    const projectionSandbox = (): AppSandbox =>
      this.projectionPool(this.manifests.get(appName) ?? m, appName, scope);
    const projFile = path.join(m.dir, "projection.ts");
    const actionsFile = path.join(m.dir, "actions.ts");
    const scopeOwner = m.scope === "per-user" ? scope : "";
    const logFile = this.logFileFor(appName, scope);
    const inst = new AppInstance(appName, scope, scopeOwner, logFile, {
      // Live references: manifest hot-reload and pure-function edits take
      // effect on the NEXT dispatch, no instance rebuild needed. The module
      // itself is loaded inside the sandbox, keyed by mtime.
      actions: () => this.manifests.get(appName)?.actions ?? {},
      runHandler: async (action, ctx, params, run) => {
        // `ctx` crosses a process boundary, so only serialisable state goes:
        // the capability facade is reconstructed on the far side and brokered
        // back through `run`, which the handler can neither name nor keep.
        const wire = {
          actor: ctx.actor,
          scope: ctx.scope,
          scopeOwner: ctx.scopeOwner,
          state: ctx.state,
          now: ctx.now,
        };
        const owner =
          ctx.actor.kind === "user" ? ctx.actor.username : ctx.actor.kind === "agent" ? ctx.actor.onBehalfOf : "#system";
        // The version this call is bound to. A dispatch cannot START on a stale
        // one (`instance()` settles it first, synchronously), but a file can
        // move WHILE the handler is awaiting the sandbox — and the sandbox
        // re-imports by mtime, so the second half of a call could run newer
        // code than the Context was derived for. Recording it here is what lets
        // the check below refuse to finish such a call. It is the RUNNABLE
        // identity, so a mid-call halt reads as a change too: halting leaves
        // `code` where it was, and comparing raw digests would have let a call
        // finish into a version we can no longer name.
        const startedAt = this.codeIdentity(appName);
        // Label only — it names the run in stderr; it does not decide who
        // shares a process with whom, because nobody does.
        const out = await handlerSandbox(`${appName}/${scope}/${action}@${owner}`).runHandler(
          actionsFile,
          action,
          wire,
          params,
          run
            ? (slot, operation, args) =>
                // `__result` is not a resource operation and never reaches an
                // Object: it is how a handler asks what happened to a call this
                // instance already made. Kept on the same channel so the app
                // still has exactly one verb to learn.
                slot === "__pending"
                  ? Promise.resolve(run.caps.result?.(String(operation)) ?? null)
                  : run.caps.request(slot, operation, args)
            : async () => ({ status: "denied" as const, reason: "this controller was granted no capabilities" }),
        );
        // Refuse to finish a call whose code moved under it: appending events
        // here would attribute a new version's output to the old version's
        // Context, which is exactly the mixed state SEC-02 forbids. Whatever
        // capability calls the handler already made are done and are not undone
        // by anything — but they were gated against the version it started on,
        // and no further effect is recorded.
        this.ensureFresh(appName);
        const endedAt = this.codeIdentity(appName);
        if (startedAt && endedAt !== startedAt) {
          throw new Error("应用代码在这次调用期间发生了变化，本次结果已作废，请刷新页面重试");
        }
        return (out ?? {}) as ActionResult;
      },
      project: async (events) => await projectionSandbox().project(projFile, events),
      admins: this.admins,
      controllerRun: async (action, actor, parent) => {
        const plane = this.opts.capabilities;
        if (!plane) return null;
        const username = actor.kind === "user" ? actor.username : actor.kind === "agent" ? actor.onBehalfOf : "";
        if (!username) return null;
        // The parent Context is passed in by whoever resolved the caller: an
        // agent's tool call names ITS run Context, a human's button names the
        // Context recorded in the instance handle it presented.
        //
        // There is deliberately NO fallback to "look up the current App
        // Context for (app, scope, user)". That lookup answers a different
        // question — what authority exists NOW — so a handle minted against a
        // Context that has since died would pick up a fresh one derived after
        // the account was re-authorised. A handle that can gain authority it
        // was not minted with is not a binding.
        const parentContextId = typeof parent === "string" && parent ? parent : null;
        if (!parentContextId) return null;
        return await plane.openControllerRun({
          username,
          app: appName,
          action,
          parentContextId,
          digest: this.versions.get(appName)?.code,
        });
      },
    });
    inst.log.onAppend(() => this.schedulePush(key));
    this.instances.set(key, inst);
    for (const cb of this.instanceHooks) cb(inst);
    return inst;
  }

  attachAgentPlane(plane: AgentPlaneApi): void {
    this.agentPlane = plane;
  }

  // ── manifest loading & hot reload (T2 material) ──

  /** Public so plane/tests can (re)load manifests without binding a port. */
  reload(): void {
    this.loadAll();
  }

  private loadAll(): void {
    if (!fs.existsSync(this.opts.appsDir)) return;
    for (const entry of fs.readdirSync(this.opts.appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.opts.appsDir, entry.name);
      if (!fs.existsSync(path.join(dir, "app.yaml"))) continue;
      this.refreshDir(dir, entry.name);
    }
  }

  /**
   * Load (or reload) ONE app directory and settle its version.
   *
   * Reload failure has two very different endings, and telling them apart is
   * the whole point:
   *
   *  · the declaration is broken but the executable files are exactly the ones
   *    the last good release ran — keep serving it, show the banner. This is
   *    the established "a bad YAML edit does not take the app down" behaviour.
   *  · the declaration is broken AND `actions.ts`/`projection.ts`/`prompts/**`
   *    have moved — we cannot say which version would run, so the app HALTS.
   *    Serving "the last good release" would be a claim we cannot support.
   */
  private refreshDir(dir: string, entryName: string): void {
    try {
      const m = loadApp(dir);
      this.manifests.set(m.app, m);
      this.manifestErrors.delete(entryName);
      this.applyVersion(m);
    } catch (err) {
      this.manifestErrors.set(entryName, err instanceof ManifestError ? err.message : String(err));
      // Find the app this directory belongs to, if we ever loaded it.
      const known = [...this.manifests.values()].find((m) => m.dir === dir);
      if (!known) return;
      const next = computeVersion(dir);
      const prev = this.versions.get(known.app);
      const halted = !prev || prev.exec !== next.exec;
      this.versions.set(known.app, { ...(prev ?? next), stamp: next.stamp, halted });
      if (halted && !prev?.halted) {
        console.error(
          `[engine] ${known.app} halted: its declaration does not load and its executable files have changed `
            + "since the last good release, so no version can be run consistently",
        );
        this.rotate(known.app, "halted");
      }
    }
  }

  /**
   * Settle an app's version, rotating running authority when the CODE identity
   * moved.
   *
   * A code change destroys every instance handle, every App/Agent Context and
   * every undecided approval derived from them: a new version must re-derive
   * its authority, never inherit the old slots (kernel invariant 9). It does
   * NOT touch the persistent grant — the user authorised an app and a
   * permission contract, not a hash, so the next launch re-derives silently.
   *
   * A presentation-only change (pages/**) rotates nothing. The distinction is
   * why the two digests exist: a copy fix must not cost anyone a pending
   * approval, and an `actions.ts` change must.
   */
  private applyVersion(m: AppManifest): void {
    const next = computeVersion(m.dir);
    const prev = this.versions.get(m.app);
    this.versions.set(m.app, { ...next, halted: false });
    if (!prev || prev.code === next.code) return;
    this.rotate(m.app, `code changed (${prev.code.slice(0, 8)} → ${next.code.slice(0, 8)})`);
  }

  /** Destroy everything running as one app: handles, Contexts, sandboxes. */
  private rotate(app: string, why: string): void {
    // Invalidate against the identity that may run FROM NOW ON — which for a
    // halted app is the empty one, so every handle goes. Passing the recorded
    // `code` instead would have kept a halted app's instances alive (halting
    // does not move `code`, it only sets the flag), and with them their App
    // Contexts and every approval still queued against the old version. The
    // point of halting is that no version may run; leaving an approvable
    // PendingCall behind is that same version running, later, by consent.
    for (const inst of this.security.invalidateApp(app, this.codeIdentity(app))) this.dropInstance(inst);
    for (const [key, ctxId] of this.agentContexts) {
      if (key.startsWith(`${app}/`)) {
        this.opts.capabilities?.destroyContext(ctxId);
        this.agentContexts.delete(key);
      }
    }
    // The sandbox holds the previous module version in its import cache; a new
    // child is the simplest way to guarantee the old code stops running.
    for (const [key, sb] of this.sandboxes) {
      if (key === app || key.startsWith(`${app}/`)) {
        sb.stop();
        this.sandboxes.delete(key);
      }
    }
    console.warn(`[engine] ${app} ${why}; contexts destroyed`);
  }

  /**
   * Make sure this app's version is the one on disk, HERE, before it is used.
   *
   * The watcher used to be the only mechanism, and for `.ts` files it returned
   * early — so a code edit left the sandbox importing new code while the
   * Context, the handle and the pending approvals were the old version's. That
   * is the SEC-02 defect, and moving the check to the point of use removes the
   * whole class: whether a watcher fired, and when, no longer decides anything.
   *
   * Cheap enough to do per request: a handful of `stat` calls, and the digests
   * are only recomputed when one of them moved.
   */
  private ensureFresh(app: string): void {
    const m = this.manifests.get(app);
    if (!m) return;
    const v = this.versions.get(app);
    if (v && v.stamp === stampOf(m.dir)) return;
    this.refreshDir(m.dir, path.basename(m.dir));
  }

  /** True when this app cannot be run because its version is not provable. */
  isHalted(app: string): boolean {
    this.ensureFresh(app);
    return this.versions.get(app)?.halted === true;
  }

  /**
   * The identity anything may run as right now, WITHOUT touching the disk.
   *
   * Empty for a halted app: "we cannot say which version would run" and "this
   * version would run" have to be different values, or every comparison that
   * decides whether to keep running reads the same either way.
   */
  private codeIdentity(app: string): string {
    const v = this.versions.get(app);
    return v && !v.halted ? v.code : "";
  }

  /** The executing code's identity. Refreshes from disk first, by design. */
  digestFor(app: string): string {
    this.ensureFresh(app);
    // A halted app has no runnable identity, so every handle minted against
    // the last good one stops resolving.
    return this.codeIdentity(app);
  }

  /** Both digests plus the halt flag — diagnostics, and what tests assert on. */
  versionFor(app: string): AppVersion | null {
    this.ensureFresh(app);
    return this.versions.get(app) ?? null;
  }

  /**
   * End one AppInstance: destroy the Context it ran as. Nothing else to undo —
   * the Context belongs to this instance alone, and handler runtimes are
   * created and reaped per invocation, so there is no residency to stop.
   */
  private dropInstance(inst: AppInstanceBinding): void {
    // Hard destroy: every undecided PendingCall in this Context's subtree
    // expires with it, so an approval that arrives afterwards fails closed.
    if (inst.contextId) this.opts.capabilities?.destroyContext(inst.contextId);
  }

  /** Destroy the Contexts of everything that has timed out. */
  private sweepExpired(): void {
    for (const inst of this.security.reapExpired()) this.dropInstance(inst);
  }

  private stopSandbox(key: string): void {
    const sb = this.sandboxes.get(key);
    if (!sb) return;
    sb.stop();
    this.sandboxes.delete(key);
  }

  /**
   * Trusted launcher. The owner comes from the caller's session — never from
   * a request field — and the resulting handle is the only thing the browser
   * ever holds.
   */
  async openInstanceFor(
    viewer: Viewer & { sessionKey: string },
    m: AppManifest,
    scope: string,
  ): Promise<string> {
    const digest = this.digestFor(m.app);
    // ONE Context per launch. Sharing one between launches made every lifecycle
    // question ambiguous — whose logout ends it, which tab's close destroys it,
    // what a stale handle picks up after re-derivation — and it also meant a
    // revoked device left a dead-but-cached Context that no reload could fix.
    const contextId = this.opts.capabilities
      ? ((await this.opts.capabilities.openApp({ username: viewer.username, app: m.app, scope, digest })) ?? null)
      : null;
    return this.security.openInstance({
      owner: viewer.username,
      admin: viewer.admin,
      app: m.app,
      scope,
      sessionKey: viewer.sessionKey,
      contextId,
      digest,
    });
  }

  /**
   * Explicit close: end this instance and everything derived from it.
   *
   * Keyed on the SESSION, not the username. A handle is not a bearer token, so
   * "the same person in another browser, holding a handle they learned" is not
   * the session whose lifetime this instance belongs to and may not end it.
   */
  closeInstanceHandle(handle: string, viewer: ResolvedViewer): boolean {
    if (!viewer.sessionKey) return false;
    const dropped = this.security.closeInstance(handle, viewer.sessionKey);
    if (dropped) this.dropInstance(dropped);
    return Boolean(dropped);
  }

  /**
   * The AgentRun Context for one turn.
   *
   * An agent has no session and no instance handle, so it cannot derive from a
   * browser tab's Context — it holds its own, created on first use from the
   * account root and destroyed when the app's code changes. What it may ask for
   * is whatever the plane grants an agent, which defaults to nothing.
   */
  async openAgentRun(
    app: string,
    scope: string,
    owner: string,
    agent: string,
  ): Promise<{ contextId: string; close(): void } | null> {
    const plane = this.opts.capabilities;
    if (!plane) return null;
    const key = `${app}/${scope}/${agent}@${owner}`;
    let parentContextId = this.agentContexts.get(key) ?? null;
    if (parentContextId && !(plane.appContextUsable?.(parentContextId) ?? true)) {
      plane.destroyContext(parentContextId);
      this.agentContexts.delete(key);
      parentContextId = null;
    }
    if (!parentContextId) {
      parentContextId =
        (await plane.openApp({ username: owner, app, scope, digest: this.digestFor(app) })) ?? null;
      if (parentContextId) this.agentContexts.set(key, parentContextId);
    }
    if (!parentContextId) return null;
    return (await plane.openAgentRun({
      username: owner,
      app,
      agent,
      parentContextId,
      digest: this.digestFor(app),
    })) ?? null;
  }

  private setupWatchers(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    const dirs = new Set<string>([this.opts.appsDir]);
    for (const m of this.manifests.values()) {
      dirs.add(m.dir);
      const pagesDir = path.join(m.dir, "pages");
      if (fs.existsSync(pagesDir)) dirs.add(pagesDir);
      const promptsDir = path.join(m.dir, "prompts");
      if (fs.existsSync(promptsDir)) dirs.add(promptsDir);
    }
    for (const dir of dirs) {
      try {
        // The watched directory travels with the event. Without it the callback
        // could not say WHICH app changed, which is why the old one had to
        // choose between reloading everything and reloading nothing — and for
        // `.ts` it chose nothing.
        const w = fs.watch(dir, (_ev, filename) => this.onSourceChange(dir, String(filename ?? "")));
        // Watchers can fail after construction (unmounts, descriptor pressure,
        // backend errors). With no listener EventEmitter treats that as an
        // uncaught exception. Watching is only a promptness hint here, so drop
        // the failed watcher and keep the point-of-use freshness checks.
        w.on("error", () => {
          try { w.close(); } catch { /* already failed/closed */ }
          this.watchers = this.watchers.filter((candidate) => candidate !== w);
        });
        this.watchers.push(w);
      } catch {
        // A vanished directory is fine; next reload rebuilds the watcher set.
      }
    }
  }

  /**
   * A file under a watched directory moved.
   *
   * The watcher is no longer load-bearing for correctness — `ensureFresh` does
   * the version switch at the point of use, so a missed or late event cannot
   * produce a mixed version. What it still does is make the switch PROMPT and
   * notice apps that appear or disappear.
   *
   * It no longer returns early for `.ts`. That early return is SEC-02: it meant
   * a code edit re-imported new code on the next call while the Context, the
   * handle and the pending approvals stayed the previous version's.
   */
  private onSourceChange(dir: string, _filename: string): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      const owner = [...this.manifests.values()].find((m) => m.dir === dir || dir.startsWith(m.dir + path.sep));
      if (owner) {
        this.refreshDir(owner.dir, path.basename(owner.dir));
      } else {
        // The apps directory itself: an app may have appeared or vanished.
        this.loadAll();
      }
      this.setupWatchers();
      for (const clients of this.sse.values()) {
        for (const res of clients) {
          if (!this.sseWrite(res, { reload: true })) clients.delete(res);
        }
      }
    }, 250);
  }

  // ── subscribe-project-patch ──

  private schedulePush(key: string): void {
    if (this.pushTimers.has(key)) return;
    this.pushTimers.set(
      key,
      setTimeout(() => {
        this.pushTimers.delete(key);
        void this.pushNow(key);
      }, 30),
    );
  }

  private async pushNow(key: string): Promise<void> {
    const clients = this.sse.get(key);
    if (!clients?.size) return;
    const [app, scope] = key.split("/", 2);
    let frame: Record<string, unknown>;
    try {
      const inst = this.instance(app, scope);
      frame = { rev: inst.log.revision, view: await inst.view() };
    } catch (err) {
      frame = { error: String((err as Error)?.message ?? err) };
    }
    for (const res of clients) {
      if (!this.sseWrite(res, frame)) clients.delete(res);
    }
  }

  private sseWrite(res: http.ServerResponse, data: unknown): boolean {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  // ── auth ──

  /**
   * The configured `users[].token` is a LOGIN credential now, not a session.
   * It can still be presented directly (scripts, curl, the CLI shim's sibling
   * tools) and it still identifies a user for reads — but `viaSession` stays
   * false, and every state-changing route requires a real session. A static
   * token that arrives in a query string cannot be the thing that proves a
   * human pressed a button (entry chains: doc/tcb-reading-guide.md §3).
   */
  private resolveViewer(req: Req, u: URL): ResolvedViewer | null {
    const sid = readCookie(req.headers.cookie, this.cookies.names.session);
    const session = this.security.resolveSession(sid);
    if (session) {
      return { username: session.username, admin: session.admin, viaSession: true, sessionKey: session.key };
    }
    // Header only. A token in a query string is written down in browser
    // history, in the Referer of the next request, and in every log between
    // here and the process — and it is the same long-lived credential that
    // logs in, so it is the last thing that should travel that way.
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) return null;
    for (const [username, cfg] of Object.entries(this.opts.users)) {
      // No session key: a bearer cannot launch an app instance, because there
      // is no session for its lifetime to be tied to.
      // Constant time: a `===` here walks the token until the first differing
      // byte, and this is the credential that logs a user in.
      if (secretEquals(cfg.token, token)) {
        return { username, admin: cfg.admin === true, viaSession: false, sessionKey: "" };
      }
    }
    return null;
  }

  /**
   * Gate in front of everything that changes state, run ONCE before route
   * dispatch rather than by each route remembering.
   *
   * It used to be eight per-route calls and ten unsafe routes. Both numbers were
   * right at the time, which is the problem: the discipline held until it did
   * not, and a route that forgets is a route where any page on the internet can
   * make an authenticated browser POST. The rule itself is shared with the panel
   * (`@claude-bot/web-trust`).
   *
   * A bearer is refused here — unlike on the panel, where ops tooling needs to
   * script writes. This host serves generated application code, so "a credential
   * exists somewhere" is not evidence that a person pressed a button.
   */
  /**
   * The origins a browser may POST from, decided once. From `public_url` when
   * configured, otherwise from the loopback port this probe binds to.
   */
  private originAllowlist: readonly string[] | null = null;

  private allowedOrigins(): readonly string[] {
    const cached = this.originAllowlist;
    if (cached) return cached;
    // The BOUND port, not the configured one: tests and dev runs ask for 0 and
    // get whatever the OS hands out, and an allowlist built from 0 accepts
    // nothing. Not memoised until we actually have it.
    const a = this.server?.address();
    const loopbackPort = a && typeof a === "object" ? a.port : this.opts.port;
    const computed = computeAllowedOrigins({ publicUrl: this.opts.publicUrl, loopbackPort });
    if (loopbackPort > 0 || this.opts.publicUrl) this.originAllowlist = computed;
    return computed;
  }

  private stateChangeOk(req: Req, res: Reply, viewer: { viaSession: boolean }): boolean {
    if (!viewer.viaSession) {
      this.json(res, 403, { ok: false, code: "needs_session", message: "写操作需要浏览器登录会话（先到 /login 登录）" });
      return false;
    }
    const session = this.security.resolveSession(readCookie(req.headers.cookie, this.cookies.names.session));
    if (!session) {
      this.json(res, 403, { ok: false, code: "csrf", message: "CSRF 校验失败，请刷新页面" });
      return false;
    }
    const verdict = mutationGate({
      method: req.method ?? "GET",
      via: "cookie",
      origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      allowed: this.allowedOrigins(),
      csrf: {
        presented: typeof req.headers[CSRF_HEADER] === "string" ? (req.headers[CSRF_HEADER] as string) : undefined,
        ok: (presented) => this.security.csrfOk(session, presented),
      },
    });
    if (verdict.ok) return true;
    this.json(res, verdict.status, {
      ok: false,
      code: verdict.code === "origin" ? "origin" : "csrf",
      message: verdict.message,
    });
    return false;
  }

  /** Read access to a scope: your own, or shared, or admin (read-only lens). */
  private canReadScope(m: AppManifest, scope: string, viewer: Viewer): boolean {
    // An identifier that is not one is refused before the permission question,
    // so an admin's cross-user lens cannot be pointed at `../../outside`.
    if (!safeIdentifier(scope)) return false;
    if (m.scope === "shared") return true;
    return scope === viewer.username || viewer.admin;
  }

  private resolveScope(m: AppManifest, u: URL, viewer: Viewer): string {
    if (m.scope === "shared") return "shared";
    return u.searchParams.get("scope") ?? viewer.username;
  }

  // ── http ──

  /**
   * The HTTP layer, which is now the framework's rather than ours.
   *
   * What moved out of this file, and where each thing went:
   *
   *   · the hardening headers on every HTML response — `@fastify/helmet`, which
   *     applies them to EVERY reply rather than only the ones that remembered
   *     to go through `send()`;
   *   · reading a bounded JSON body — Fastify's `bodyLimit`, refusing before it
   *     buffers rather than after, and answering 413 without ever reaching a
   *     handler (which is where the panel's "413 then run with `{}`" bug was);
   *   · parsing and serialising cookies — `@fastify/cookie`;
   *   · the Origin allowlist — `@fastify/cors`, given the exact list
   *     `allowedOrigins()` computes. That is what the simplification in
   *     `web-trust` was for: the value now hands straight to the library.
   *
   * The dispatch below is still one `route()` — turning it into per-path route
   * registrations with schemas is the next step, and it is mechanical.
   */
  async start(): Promise<void> {
    this.loadAll();
    this.setupWatchers();
    const app = Fastify({
      bodyLimit: MAX_BODY_BYTES,
      logger: false,
      trustProxy: false,
      // Fastify coerces by default, which is the very behaviour these schemas
      // exist to replace: with it on, `{instance: 12345}` becomes the string
      // "12345" and the schema has said nothing. A type that does not reject a
      // wrong type is a comment.
      ajv: { customOptions: { coerceTypes: false } },
    });

    /**
     * Parse anything as JSON, leniently, because callers (the CLI shim, tests,
     * feishu) do not all send a content type. The three answers — empty is `{}`,
     * malformed is a 400 that says so, a non-object is a 400 too — come from
     * `@claude-bot/web-trust`, which the panel registers as its parser as well:
     * one decision, two surfaces, no room to drift.
     */
    const parseJson = (_req: unknown, body: string, done: (e: Error | null, v?: unknown) => void): void => {
      const parsed = parseJsonBodyText(body);
      if (parsed.ok) return done(null, parsed.body);
      done(Object.assign(new Error(parsed.message), { statusCode: 400, code: "BAD_JSON" }));
    };
    app.addContentTypeParser("application/json", { parseAs: "string" }, parseJson);
    app.addContentTypeParser("*", { parseAs: "string" }, parseJson);

    await app.register(fastifyCookie);
    await app.register(fastifyHelmet, {
      // The same deny-all default the hand-written `send()` used, now applied to
      // every reply. Pages that need a script nonce override it per response.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'none'"],
          "frame-ancestors": ["'none'"],
        },
      },
      referrerPolicy: { policy: "no-referrer" },
      // Helmet defaults to SAMEORIGIN; this Host is never framed by anything,
      // including itself — the Agent View is a sandboxed iframe the Host owns,
      // not the Host being embedded.
      frameguard: { action: "deny" },
      crossOriginEmbedderPolicy: false,
    });
    // Not a helmet default, so it stays ours — but as one hook rather than one
    // line per response.
    app.addHook("onSend", async (_req, reply) => {
      void reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    });
    await app.register(fastifyCors, { origin: [...this.allowedOrigins()], credentials: true });

    app.setErrorHandler((rawErr, _req, reply) => {
      const err = rawErr as Error & { statusCode?: number };
      const status = typeof err.statusCode === "number" ? err.statusCode : 500;
      const validation = (err as { validation?: unknown }).validation;
      const code = validation
        ? "bad_request"
        : status === 413
          ? "too_large"
          : status === 400 || status === 415
            ? "bad_json"
            : "internal";
      void reply.code(status).send({ ok: false, code, message: err.message });
    });

    // Record the table as Fastify builds it, so "what does this Host serve?"
    // has an answer that cannot disagree with what it actually serves.
    this.routeTable = [];
    app.addHook("onRoute", (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) this.routeTable.push({ method: m, url: r.url });
    });
    await this.registerRoutes(app);

    this.app = app;
    const host = this.opts.host ?? "127.0.0.1";
    await app.listen({ port: this.opts.port, host });
    this.server = app.server;
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    void this.app?.close();
    this.app = null;
    for (const clients of this.sse.values()) for (const res of clients) res.end();
    for (const sb of this.sandboxes.values()) sb.stop();
    this.sandboxes.clear();
  }

  private routeTable: Array<{ method: string; url: string }> = [];

  /**
   * Every (method, path) this Host answers, as the router itself holds it.
   *
   * Diagnostics, and the thing a test can walk to prove the table and the
   * handlers have not drifted — the drift this refactor made impossible by
   * construction, which is worth keeping a check on anyway.
   */
  get routes(): ReadonlyArray<{ method: string; url: string }> {
    return this.routeTable;
  }

  /** Loopback base once listening — CLI shims call back through this. */
  get boundUrl(): string | undefined {
    const a = this.server?.address();
    return a && typeof a === "object" ? `http://127.0.0.1:${a.port}` : undefined;
  }

  private json(res: Reply, status: number, body: unknown): void {
    void res.code(status).type("application/json; charset=utf-8").send(JSON.stringify(body));
  }

  private html(res: Reply, status: number, body: string): void {
    this.send(res, status, body);
  }

  /**
   * An HTML response. The hardening headers no longer live here — `@fastify/helmet`
   * puts them on every reply, including ones from routes nobody remembered to
   * harden, which is the property this method used to provide by convention.
   * What stays is the per-page override: a page needing a script nonce passes
   * its own CSP and it wins.
   */
  private send(res: Reply, status: number, body: string, extra: Record<string, string> = {}): void {
    void res.code(status).headers({ "content-type": "text/html; charset=utf-8", ...extra }).send(body);
  }

  /**
   * Read a JSON body with a hard cap.
   *
   * Unbounded before: a POST is reachable before any per-route check, so
   * anyone who can open the port could make the Host buffer whatever they
   * could send. Two gates, because either alone is bypassable — a declared
   * `content-length` lets us refuse before reading a byte, and the running
   * total catches a chunked body that declares nothing (or lies).
   */
  /**
   * Read a JSON body, or answer and return null. Shared with the panel
   * (`@claude-bot/web-trust`) — this side already refused correctly, and the panel
   * answered 413 and then ran the handler with an empty body, which is precisely
   * the kind of divergence one implementation prevents.
   */
  private async readBody(req: Req, res: Reply): Promise<Record<string, unknown> | null> {
    const body = req.body;
    if (body === undefined || body === null) return {};
    if (typeof body !== "object" || Array.isArray(body)) {
      this.json(res, 400, { ok: false, code: "bad_json", message: "请求体必须是 JSON 对象" });
      return null;
    }
    return body as Record<string, unknown>;
  }

  /**
   * The routes that answer BEFORE anyone is identified, because each has a
   * credential rule that is not "who is this viewer": `/login` is the door,
   * `/logout` GET only says "use POST", and the CLI shim carries a per-turn
   * token bound to one agent turn. They are registered in their own Fastify
   * scope, which is what keeps them narrowly exempt instead of exempt by name
   * inside a gate everything else also passes through.
   */
  /**
   * The query string, for the handlers that read one.
   *
   * Fastify has already matched the route by the time a handler runs, so this
   * is only ever used for `?scope=` / `?agent=` / `?page=` — never to decide
   * WHICH handler is running. That decision has exactly one home now, and it is
   * the route table.
   */
  private query(req: Req): URL {
    return new URL(req.url ?? "/", "http://x");
  }

  /**
   * GET /login — the form.
   *
   * A credential in a query string ends up in browser history, in the Referer
   * of every later request, in the proxy log and in the server log. The link
   * people are handed still points here; the page turns it into a POST that is
   * never written down anywhere.
   */
  private pageLogin(req: Req, res: Reply): void {
    const u = this.query(req);
    const nonce = randomBytes(16).toString("base64url");
    return this.send(
      res,
      u.searchParams.has("token") ? 400 : 200,
      loginFormPage(u.searchParams.has("token") ? "令牌不能放在网址里 —— 请粘贴到下面的输入框。" : "", nonce),
      {
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'nonce-${nonce}'`,
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
        "cache-control": "no-store",
      },
    );
  }

  /** POST /login — the configured token buys a session; it never becomes the cookie. */
  private async apiLogin(req: Req, res: Reply): Promise<void> {
    if (!originOk(typeof req.headers.origin === "string" ? req.headers.origin : undefined, this.allowedOrigins())) {
      return this.json(res, 403, { ok: false, code: "origin", message: "Origin 校验失败" });
    }
    const body = await this.readBody(req, res);
    if (!body) return;
    const t = String(body.token ?? "");
    const entry = t ? Object.entries(this.opts.users).find(([, cfg]) => secretEquals(cfg.token, t)) : undefined;
    if (!entry) return this.html(res, 401, loginPage("令牌无效。"));
    const s = this.security.issueSession(entry[0], entry[1].admin === true);
    // 303: the browser must GET the destination, so the credential does not
    // survive a resubmit.
    return void res
      .code(303)
      .headers({
        // `secure` is not passed: the contract already decided both the name
        // and the transport attribute, and a second opinion here is how they
        // could contradict each other.
        "set-cookie": issueSessionCookies(this.cookies, {
          sessionId: s.sessionId,
          csrf: s.csrf,
          maxAgeS: s.maxAgeS,
        }),
        location: "/",
      })
      .send();
  }

  /**
   * GET /logout — refused.
   *
   * Logging out ends sessions and destroys Contexts, so it is a state change:
   * a GET could be triggered by any `<img>` on any page.
   */
  private logoutNeedsPost(res: Reply): void {
    return this.json(res, 405, { ok: false, code: "method", message: "退出登录请用 POST" });
  }

  /**
   * POST /logout. Registered in the PUBLIC scope and gating itself, because it
   * must still work for a session whose Contexts it is about to destroy, and
   * because it answers 401 rather than a login page.
   */
  private apiLogout(req: Req, res: Reply): void {
    const viewer = this.resolveViewer(req, this.query(req));
    if (!viewer || !this.stateChangeOk(req, res, viewer)) {
      if (viewer) return;
      return this.json(res, 401, { ok: false, code: "unauthorized" });
    }
    const sid = readCookie(req.headers.cookie, this.cookies.names.session);
    const session = this.security.resolveSession(sid);
    this.security.revokeSession(sid);
    // Logging out ends the app instances THIS session opened, and their
    // Contexts with them. An instance handle that outlives its session is a
    // credential the user thinks they just gave up — but the same person in
    // another browser holds a different session and is left alone.
    if (session) for (const inst of this.security.closeInstancesForSession(session.key)) this.dropInstance(inst);
    // 303 so the browser GETs the login page after a POST.
    return void res
      .code(303)
      .headers({
        "set-cookie": clearSessionCookies(this.cookies),
        location: "/login",
      })
      .send();
  }

  /**
   * POST /api/shim/call — the CLI shim callback.
   *
   * Authenticated by a per-turn capability token rather than a user cookie,
   * which is why it lives in the public scope; the token check runs in
   * `preValidation` so an expired turn cannot learn the body shape.
   */
  private async apiShimCall(req: Req, res: Reply): Promise<void> {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const handler = resolveShimToken(token);
    if (!handler) {
      return this.json(res, 401, { ok: false, message: "shim token 无效或已过期（该轮已结束）" });
    }
    const body = await this.readBody(req, res);
    if (!body) return;
    try {
      const result = await handler(String(body.name ?? ""), (body.args ?? {}) as Record<string, unknown>);
      return this.json(res, 200, { ok: true, result });
    } catch (err) {
      return this.json(res, 200, { ok: false, message: String((err as Error)?.message ?? err) });
    }
  }

  // ── behind the gate ────────────────────────────────────────────────────────
  //
  // By the time one of these runs, the guarded scope's `preHandler` has
  // identified the viewer and — for every unsafe method — has already applied
  // the mutation gate. They are gated because of WHERE THEY ARE REGISTERED, not
  // because anyone remembered.

  /**
   * GET /view-frame — the Agent View shell. It contains no data: everything it
   * renders arrives later over the MessagePort, so this document is identical
   * for every user and every app.
   */
  private pageViewFrame(res: Reply): void {
    const nonce = randomBytes(16).toString("base64url");
    return void res.code(200).headers(viewFrameHeaders(nonce)).send(viewFrameHtml(nonce));
  }

  private pageFactory(res: Reply, viewer: ResolvedViewer): void {
    if (!viewer.admin) {
      observeFactory(viewer.username, "v3-factory.page", "read", "refused", "admin_required");
      return this.html(res, 403, loginPage("工厂页仅 admin 可入"));
    }
    observeFactory(viewer.username, "v3-factory.page", "read", "observed");
    return this.html(res, 200, factoryPage({ username: viewer.username, mcpCatalog: this.opts.mcpCatalogNames ?? [] }));
  }

  private async apiFactoryApps(res: Reply, viewer: ResolvedViewer): Promise<void> {
    if (!viewer.admin) {
      observeFactory(viewer.username, "v3-factory.apps", "read", "refused", "admin_required");
      return this.json(res, 403, { ok: false, message: "仅 admin" });
    }
    observeFactory(viewer.username, "v3-factory.apps", "read", "observed");
    const apps = this.listManifests().map((m) => {
      const files: Record<string, string> = {};
      const addFile = (rel: string) => {
        const fp = path.join(m.dir, rel);
        try {
          if (fs.existsSync(fp)) files[rel] = fs.readFileSync(fp, "utf8");
        } catch {
          /* unreadable file: dissect what we can */
        }
      };
      addFile("app.yaml");
      addFile("projection.ts");
      addFile("actions.ts");
      for (const sub of ["pages", "prompts"]) {
        const d = path.join(m.dir, sub);
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d)) if (/\.(yaml|md)$/.test(f)) addFile(`${sub}/${f}`);
      }
      return {
        app: m.app,
        title: m.title,
        scope: m.scope,
        actions: m.actions,
        agents: m.agents,
        pages: m.pages,
        flows: m.flows,
        deadlines: m.deadlines,
        feishuCards: m.feishuCards,
        files,
      };
    });
    const { WIDGETS } = await import("../cards/catalog.js");
    return this.json(res, 200, { ok: true, apps, widgets: WIDGETS, mcpCatalog: this.opts.mcpCatalogNames ?? [] });
  }

  private async apiFactorySave(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    if (!viewer.admin) {
      observeFactory(viewer.username, "v3-factory.save", "write", "refused", "admin_required");
      return this.json(res, 403, { ok: false, message: "仅 admin" });
    }
    const body = await this.readBody(req, res);
    if (!body) return;
    const m = this.manifests.get(String(body.app ?? ""));
    if (!m) return this.json(res, 404, { ok: false, message: "未知应用" });
    const rel = String(body.file ?? "");
    const content = String(body.content ?? "");
    if (!/^[\w./-]+$/.test(rel) || rel.includes("..") || path.isAbsolute(rel) || !/\.(yaml|md|ts)$/.test(rel)) {
      return this.json(res, 400, { ok: false, message: "非法路径（应用目录内的 .yaml/.md/.ts 相对路径）" });
    }
    if (content.length > 200_000) return this.json(res, 413, { ok: false, message: "内容过大" });
    const target = path.resolve(m.dir, rel);
    if (!target.startsWith(path.resolve(m.dir) + path.sep)) {
      return this.json(res, 400, { ok: false, message: "路径越界" });
    }
    // The bench cannot save what the loader would refuse: validate YAML
    // against a temp copy of the whole app before a byte lands.
    if (rel.endsWith(".yaml") && rel !== "seed.yaml") {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v3-validate-"));
      try {
        fs.cpSync(m.dir, tmp, { recursive: true });
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmp, rel), content);
        loadApp(tmp);
      } catch (err) {
        const msg = err instanceof ManifestError ? err.message : String((err as Error)?.message ?? err);
        return this.json(res, 422, { ok: false, problems: msg });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    const fm = this.manifests.get("factory");
    if (fm) {
      await this.instance("factory", "shared").log.append(
        [{ type: "file_saved", data: { app: m.app, file: rel, bytes: content.length } }],
        { kind: "user", username: viewer.username, admin: viewer.admin },
      );
    }
    observeFactory(viewer.username, "v3-factory.save", "write", "ok");
    return this.json(res, 200, { ok: true });
  }

  /** GET /a/:app and /a/:app/:page — Fastify supplies the two names. */
  private async pageApp(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    const params = (req.params ?? {}) as { app?: string; page?: string };
    const app = String(params.app ?? "");
    const manifest = this.manifests.get(app);
    observeFactory(
      viewer.username,
      "v3-app.page",
      "read",
      manifest ? "observed" : "refused",
      manifest ? undefined : "unknown_app",
      manifest ? this.digestFor(app) : undefined,
    );
    return this.servePage(app, params.page, this.query(req), viewer, res, req);
  }

  private async apiAct(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    const body = await this.readBody(req, res);
    if (!body) return;
    // App identity comes from the server-side instance binding the Host
    // minted when the page was served. `body.app` / `body.scope` are not
    // consulted at all — a View that sends someone else's app name is
    // simply describing an app it is not bound to.
    const inst = this.security.resolveInstance(String(body.instance ?? ""));
    if (!inst) {
      return this.json(res, 409, { ok: false, code: "stale_instance", message: "应用实例已失效，请刷新页面" });
    }
    // Session-bound, not username-bound — see `bind()`.
    if (!viewer.sessionKey || inst.sessionKey !== viewer.sessionKey) {
      return this.json(res, 403, { ok: false, code: "forbidden", message: "该实例不属于当前会话" });
    }
    const m = this.manifests.get(inst.app);
    if (!m) return this.json(res, 404, { ok: false, code: "unknown_app", message: "未知应用" });
    if (inst.digest !== this.digestFor(inst.app)) {
      return this.json(res, 409, { ok: false, code: "stale_code", message: "应用代码已更新，请刷新页面" });
    }
    const actor: Actor = { kind: "user", username: viewer.username, admin: viewer.admin };
    // The Context comes from the handle we just resolved — the one this
    // instance was minted against — never from a lookup by app and user.
    const out = await this.instance(m.app, inst.scope).dispatch(
      String(body.action ?? ""),
      body.params,
      actor,
      inst.contextId ?? undefined,
    );
    return this.json(res, out.ok ? 200 : 400, out);
  }

  private async apiPendingResult(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    const body = await this.readBody(req, res);
    if (!body) return;
    // Scope comes from the handle, exactly like `/api/act`: the instance whose
    // Context made the call is the only one that may read it. The pending id
    // is a lookup key — one from another instance or another user resolves to
    // nothing, so there is no cross-instance answer to leak.
    const bound = this.bind(String(body.instance ?? ""), viewer, res);
    if (!bound) return;
    const ctxId = bound.binding.contextId;
    const view = ctxId
      ? (this.opts.capabilities?.pendingResult?.(ctxId, String(body.pending_call_id ?? "")) ?? null)
      : null;
    if (!view) return this.json(res, 404, { ok: false, code: "no_such_pending" });
    return this.json(res, 200, { ok: true, ...view });
  }

  private async apiInstanceClose(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    const body = await this.readBody(req, res);
    if (!body) return;
    // Closing is owner-only and takes the handle, never an app name: a
    // caller who does not hold the handle has nothing to close.
    const closed = this.closeInstanceHandle(String(body.instance ?? ""), viewer);
    return this.json(res, closed ? 200 : 404, closed ? { ok: true } : { ok: false, code: "stale_instance" });
  }

  private async apiView(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    const got = this.lookup(this.query(req), viewer, res);
    if (!got) return;
    const { inst } = got;
    return this.json(res, 200, { ok: true, rev: inst.log.revision, view: await inst.view() });
  }

  private async apiSse(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    const got = this.lookup(this.query(req), viewer, res);
    if (!got) return;
    const { inst } = got;
    const key = `${inst.app}/${inst.scope}`;
    // The one route that streams. `hijack()` tells Fastify this reply is ours
    // now — no serializer, no onSend hooks — and everything after it talks to
    // the socket directly, which is what an open-ended event stream needs.
    res.hijack();
    const raw = res.raw;
    let set = this.sse.get(key);
    if (!set) this.sse.set(key, (set = new Set()));
    set.add(raw);
    let heartbeat: NodeJS.Timeout | null = null;
    let stopped = false;
    const stop = onRawSseEnd(raw, () => {
      stopped = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      set!.delete(raw);
    });
    req.raw.on("close", stop);
    // Install the async error owner before the first write. In particular,
    // `write()` can queue ERR_STREAM_WRITE_AFTER_END and only emit it after the
    // `await inst.view()` below has yielded back to the event loop.
    try {
      raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      raw.write(": hello\n\n");
    } catch {
      stop();
      return;
    }
    const view = await inst.view();
    if (stopped || !this.sseWrite(raw, { rev: inst.log.revision, view })) {
      stop();
      return;
    }
    heartbeat = setInterval(() => {
      if (raw.writableEnded || raw.destroyed) {
        stop();
        return;
      }
      try {
        raw.write(": hb\n\n");
      } catch {
        stop();
      }
    }, 25_000);
    heartbeat.unref?.();
    return;
  }

  private async apiCard(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    const u = this.query(req);
    const got = this.lookup(u, viewer, res);
    if (!got) return;
    const { m, inst } = got;
    const pageName = u.searchParams.get("page") ?? m.feishuCards[0];
    const page = pageName ? m.pages[pageName] : undefined;
    if (!page || !m.feishuCards.includes(page.name)) {
      return this.json(res, 404, { ok: false, code: "not_card_page", message: "该页未加入 feishu.cards" });
    }
    const actor: Actor = { kind: "user", username: viewer.username, admin: viewer.admin };
    const allowed = new Set((await inst.listActions(actor)).map((a) => a.name));
    const card = renderFeishuCard(m, page, await inst.view(), {
      link: `${this.opts.publicUrl ?? ""}/a/${m.app}/${page.name}`,
      allowed: (a) => allowed.has(a),
    });
    return this.json(res, 200, card);
  }

  private async apiFeishuCallback(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    // Card-callback dispatcher, e2e shape: what a real feishu WS/webhook
    // integration would call after mapping open_id → username. In the sim,
    // identity rides the normal token; the payload mirrors feishu's card
    // action callback ({action: {value, form_value}}), and the reply is a
    // feishu-style toast. Closes the button→dispatch loop without a real
    // feishu app — the remaining gap (real send/receive) stays documented.
    const body = await this.readBody(req, res);
    if (!body) return;
    const action = (body.action ?? {}) as { value?: Record<string, unknown>; form_value?: Record<string, unknown> };
    const value = (action.value ?? {}) as { app?: string; action?: string; params?: Record<string, unknown> };
    // The card's `app` is a selector the sender chose; the authority is the
    // instance this session opened. A callback with no live instance is
    // refused rather than resolved from the payload.
    const bound = this.bind(String(body.instance ?? ""), viewer, res);
    if (!bound) return;
    const { m } = bound;
    const scope = bound.binding.scope;
    if (value.app && value.app !== m.app) {
      return this.json(res, 403, { toast: { type: "error", content: "该卡片不属于当前实例" } });
    }
    const out = await this.instance(m.app, scope).dispatch(
      String(value.action ?? ""),
      { ...(value.params ?? {}), ...(action.form_value ?? {}) },
      { kind: "user", username: viewer.username, admin: viewer.admin },
      bound.binding.contextId ?? undefined,
    );
    return this.json(
      res,
      200,
      out.ok
        ? { toast: { type: "success", content: out.reply ?? "已执行" } }
        : { toast: { type: "error", content: out.message } },
    );
  }

  private async apiAgentTranscript(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    if (!this.agentPlane) {
      observeEngineAgent(viewer.username, "engine-agent.transcript", "read", "refused", "plane_disabled");
      return this.json(res, 200, { ok: false, message: "agent plane 未启用" });
    }
    const u = this.query(req);
    const got = this.lookup(u, viewer, res);
    if (!got) return;
    const out = await this.agentPlane.transcript(got.m.app, got.inst.scope, u.searchParams.get("agent") ?? "", viewer);
    return this.json(res, 200, out);
  }

  private async apiAgentConfig(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    const body = await this.readBody(req, res);
    if (!body) return;
    // Identity first: a route must not answer anything — not even "disabled"
    // — before it knows which instance is asking.
    const bound = this.bind(String(body.instance ?? ""), viewer, res);
    if (!bound) return;
    if (!this.agentPlane?.setAgentConfig) {
      observeEngineAgent(viewer.username, "engine-agent.config", "write", "refused", "plane_disabled");
      return this.json(res, 200, { ok: false, message: "agent plane 未启用" });
    }
    const { m, binding } = bound;
    const scope = binding.scope;
    const out = await this.agentPlane.setAgentConfig(m.app, scope, String(body.agent ?? ""), viewer, {
      adapter: body.adapter ? String(body.adapter) : undefined,
      model: body.model !== undefined ? String(body.model) : undefined,
      effort: body.effort !== undefined ? String(body.effort) : undefined,
      mcp: Array.isArray(body.mcp) ? body.mcp.map(String) : undefined,
    });
    return this.json(res, 200, out);
  }

  private async apiAgentSend(req: Req, res: Reply, viewer: ResolvedViewer): Promise<void> {
    const body = await this.readBody(req, res);
    if (!body) return;
    const bound = this.bind(String(body.instance ?? ""), viewer, res);
    if (!bound) return;
    if (!this.agentPlane) {
      observeEngineAgent(viewer.username, "engine-agent.send", "execute", "refused", "plane_disabled");
      return this.json(res, 200, { ok: false, message: "agent plane 未启用" });
    }
    const out = await this.agentPlane.send(
      bound.m.app,
      bound.binding.scope,
      String(body.agent ?? ""),
      viewer,
      String(body.text ?? ""),
    );
    return this.json(res, 200, out);
  }

  /** The viewer the scope's gate resolved, for the handler that follows it. */
  private viewers = new WeakMap<Req, ResolvedViewer>();

  /**
   * The gate, as a Fastify hook on the guarded scope.
   *
   * Same two steps as before — identify, then apply the mutation gate to every
   * unsafe method — but now the ENCAPSULATION carries the guarantee: a route
   * registered inside this scope cannot skip it, and a route registered
   * outside it is visibly outside it.
   */
  private guard = async (req: Req, res: Reply): Promise<void> => {
    this.sweepExpired();
    const u = new URL(req.url ?? "/", "http://x");
    const viewer = this.resolveViewer(req, u);
    if (!viewer) {
      if (u.pathname.startsWith("/api/")) {
        return this.json(res, 401, { ok: false, code: "unauthorized", message: "缺少令牌" });
      }
      return this.html(res, 401, loginPage("请先登录：打开 /login 并粘贴你的令牌。"));
    }
    if (!SAFE_METHODS.has((req.method ?? "GET").toUpperCase()) && !this.stateChangeOk(req, res, viewer)) return;
    this.viewers.set(req, viewer);
  };

  /**
   * Every path this Host serves. Fastify owns the table, so an unregistered
   * path is a 404 and a wrong method is a 405 before any of our code runs —
   * and the two scopes make "is this route behind the gate?" a structural
   * question rather than one answered by reading an if-chain to the end.
   */
  /**
   * Per-route body shapes.
   *
   * These replace the `String(body.x ?? "")` at the top of every handler: a
   * request whose shape is wrong is refused at the boundary, by a validator,
   * instead of being coerced into something plausible further in. Coercion is
   * how `{action: {malicious: 1}}` became the action named `[object Object]`.
   *
   * `additionalProperties` is deliberately left open. `/api/act` receives an
   * `app` field from clients that do not know it is ignored, and ignoring it is
   * the documented property — a 400 would be a different (defensible) design,
   * but not one to change in passing.
   *
   * ── Why nothing here is `required` ─────────────────────────────────────
   *
   * Fastify validates the body BEFORE the handler runs. Our order is identity
   * first: a route must not answer anything — not even "you are missing a
   * field" — before it knows who is asking. Two tests found this within
   * minutes of the schemas going in:
   *
   *   · `/api/shim/call` with an expired turn token answered 400 (body shape)
   *     instead of 401, telling a caller it had already refused what its body
   *     should look like. Fixed by authenticating in `preValidation`, which is
   *     the hook that runs BEFORE validation.
   *   · `/api/agent/send` with no `instance` at all answered 400 instead of
   *     409. The 409 is the point of that route: it refuses to resolve identity
   *     from the body, and "you forgot a field" is a weaker, different claim.
   *
   * So these schemas TYPE and CAP; they do not require. Requiredness of an
   * identity field is the handler's answer, after it knows who is asking.
   * Fastify's default order is a good default and the wrong one here — worth
   * knowing before the panel is ported.
   */
  private static readonly BODY = {
    login: { type: "object", required: ["token"], properties: { token: { type: "string", maxLength: 512 } } },
    shim: {
      type: "object",
      properties: { name: { type: "string", maxLength: 200 }, args: { type: "object" } },
    },
    act: {
      type: "object",
      properties: {
        instance: { type: "string", maxLength: 128 },
        action: { type: "string", maxLength: 128 },
        params: { type: "object" },
      },
    },
    pendingResult: {
      type: "object",
      properties: {
        instance: { type: "string", maxLength: 128 },
        pending_call_id: { type: "string", maxLength: 128 },
      },
    },
    instanceClose: {
      type: "object",
      properties: { instance: { type: "string", maxLength: 128 } },
    },
    factorySave: {
      type: "object",
      properties: {
        app: { type: "string", maxLength: 128 },
        file: { type: "string", maxLength: 256 },
        content: { type: "string" },
      },
    },
    feishuCallback: {
      type: "object",
      properties: {
        instance: { type: "string", maxLength: 128 },
        action: {
          type: "object",
          properties: { value: { type: "object" }, form_value: { type: "object" } },
        },
      },
    },
    agentConfig: {
      type: "object",
      properties: {
        instance: { type: "string", maxLength: 128 },
        agent: { type: "string", maxLength: 128 },
        adapter: { type: "string", maxLength: 64 },
        model: { type: "string", maxLength: 128 },
        effort: { type: "string", maxLength: 32 },
        mcp: { type: "array", items: { type: "string", maxLength: 128 } },
      },
    },
    agentSend: {
      type: "object",
      properties: {
        instance: { type: "string", maxLength: 128 },
        agent: { type: "string", maxLength: 128 },
        text: { type: "string" },
      },
    },
  } as const;

  /**
   * Every path this Host serves, wired to the ONE method that serves it.
   *
   * The previous pass registered the URLs here and then re-matched them inside
   * a 300-line if-chain, so a path existed in two lists that had to agree. That
   * is the same shape as the panel's P1-4 (a route table and a set of per-route
   * checks, and one route in the table that no check covered): the failure is
   * silent in both directions — a URL registered but not matched fell through
   * to the chain's terminal 404, and a branch whose URL nobody registered was
   * dead code that read as live. Now there is one list, and TypeScript will not
   * let an entry point at a method that does not exist.
   *
   * Fastify owns it, so an unregistered path is a 404 and a wrong method a 405
   * before any of our code runs — and the two scopes make "is this behind the
   * gate?" a structural question rather than one answered by reading to the end.
   */
  private async registerRoutes(app: FastifyInstance): Promise<void> {
    const pub = async (s: FastifyInstance): Promise<void> => {
      // Expiry is a transition, not an absence. The guarded scope sweeps in its
      // `preHandler`; the public scope has no gate, so it sweeps here — before
      // any route resolves a session or a handle, so an idle one has already had
      // its Context destroyed and its undecided approvals expired with it.
      s.addHook("onRequest", async () => void this.sweepExpired());
      s.get("/login", async (req, reply) => this.pageLogin(req, reply));
      s.post("/login", { schema: { body: Host.BODY.login } }, async (req, reply) => this.apiLogin(req, reply));
      s.get("/logout", async (_req, reply) => this.logoutNeedsPost(reply));
      s.post("/logout", async (req, reply) => this.apiLogout(req, reply));
      s.post(
        "/api/shim/call",
        {
          schema: { body: Host.BODY.shim },
          // Identity before validation, which is the reverse of Fastify's
          // default order: an expired turn token must not learn the body shape.
          preValidation: async (req: Req, reply: Reply) => {
            const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
            if (!resolveShimToken(token)) {
              return this.json(reply, 401, { ok: false, message: "shim token 无效或已过期（该轮已结束）" });
            }
          },
        },
        async (req, reply) => this.apiShimCall(req, reply),
      );
    };
    const guarded = async (s: FastifyInstance): Promise<void> => {
      s.addHook("preHandler", this.guard);
      /** Wrap a handler so it only runs when the gate produced a viewer. */
      const withViewer =
        (fn: (req: Req, res: Reply, viewer: ResolvedViewer) => void | Promise<void>) =>
        async (req: Req, reply: Reply): Promise<void> => {
          const viewer = this.viewers.get(req);
          // The hook already answered (401/403) and did not set a viewer.
          if (!viewer) return;
          return fn.call(this, req, reply, viewer);
        };
      s.get("/", withViewer((_req, res, v) => this.html(res, 200, this.indexPage(v))));
      s.get("/index.html", withViewer((_req, res, v) => this.html(res, 200, this.indexPage(v))));
      s.get("/view-frame", withViewer((_req, res) => this.pageViewFrame(res)));
      s.get("/factory", withViewer((_req, res, v) => this.pageFactory(res, v)));
      s.get("/a/:app", withViewer(this.pageApp));
      s.get("/a/:app/:page", withViewer(this.pageApp));
      s.get("/api/view", withViewer(this.apiView));
      s.get("/api/sse", withViewer(this.apiSse));
      s.get("/api/card", withViewer(this.apiCard));
      s.get("/api/factory/apps", withViewer((_req, res, v) => this.apiFactoryApps(res, v)));
      s.get("/api/agent/transcript", withViewer(this.apiAgentTranscript));

      const posts: Array<[string, object, (req: Req, res: Reply, v: ResolvedViewer) => Promise<void>]> = [
        ["/api/act", Host.BODY.act, this.apiAct],
        ["/api/pending/result", Host.BODY.pendingResult, this.apiPendingResult],
        ["/api/instance/close", Host.BODY.instanceClose, this.apiInstanceClose],
        ["/api/factory/save", Host.BODY.factorySave, this.apiFactorySave],
        ["/api/feishu/callback", Host.BODY.feishuCallback, this.apiFeishuCallback],
        ["/api/agent/config", Host.BODY.agentConfig, this.apiAgentConfig],
        ["/api/agent/send", Host.BODY.agentSend, this.apiAgentSend],
      ];
      for (const [url, body, fn] of posts) s.post(url, { schema: { body } }, withViewer(fn));
    };
    await app.register(pub);
    await app.register(guarded);
  }

  /**
   * The ONE way an app-scoped route learns which app and scope it is serving.
   *
   * Every caller passes a server-minted instance handle; `app` and `scope` in
   * a query string or a body are not consulted anywhere. The previous pass
   * only did this for `/api/act`, which left view/SSE/card/transcript/agent
   * routes deciding authority from caller-supplied selectors — the exact
   * pattern the kernel spec forbids.
   *
   * A bearer-authenticated script may still pass `?app=` for read-only routes,
   * because a bearer has no instance and the scope check below is the same one
   * the launcher applies; it can never reach a write route.
   */
  private bind(
    handleOrNull: string,
    viewer: ResolvedViewer,
    res: Reply,
  ): { m: AppManifest; inst: AppInstance; binding: AppInstanceBinding } | null {
    const b = this.security.resolveInstance(handleOrNull);
    if (!b) {
      this.json(res, 409, { ok: false, code: "stale_instance", message: "应用实例已失效，请刷新页面" });
      return null;
    }
    // The SESSION that opened it, not merely the same username. A handle is not
    // a bearer token: another browser holding one it learned somehow is a
    // different session, with a different lifetime, and gets nothing.
    if (!viewer.sessionKey || b.sessionKey !== viewer.sessionKey) {
      this.json(res, 403, { ok: false, code: "forbidden", message: "该实例不属于当前会话" });
      return null;
    }
    const m = this.manifests.get(b.app);
    if (!m) {
      this.json(res, 404, { ok: false, code: "unknown_app", message: "未知应用" });
      return null;
    }
    if (b.digest !== this.digestFor(b.app)) {
      this.json(res, 409, { ok: false, code: "stale_code", message: "应用代码已更新，请刷新页面" });
      return null;
    }
    return { m, inst: this.instance(b.app, b.scope), binding: b };
  }

  /** Read-only fallback for bearer scripts, which hold no instance handle. */
  private lookup(
    u: URL,
    viewer: ResolvedViewer,
    res: Reply,
  ): { m: AppManifest; inst: AppInstance } | null {
    const handle = u.searchParams.get("instance") ?? "";
    if (handle) {
      const bound = this.bind(handle, viewer, res);
      return bound ? { m: bound.m, inst: bound.inst } : null;
    }
    const m = this.manifests.get(u.searchParams.get("app") ?? "");
    if (!m) {
      this.json(res, 404, { ok: false, code: "unknown_app", message: "未知应用" });
      return null;
    }
    const scope = this.resolveScope(m, u, viewer);
    if (!this.canReadScope(m, scope, viewer)) {
      this.json(res, 403, { ok: false, code: "forbidden", message: "无权访问该 scope" });
      return null;
    }
    return { m, inst: this.instance(m.app, scope) };
  }

  // ── pages ──

  private errBanner(): string {
    if (!this.manifestErrors.size) return "";
    const text = [...this.manifestErrors.entries()].map(([app, e]) => `【${app}】${e}`).join("\n\n");
    return `<div class="errbar">⚠ 声明文件有错误（保留上一份好的配置在跑）：\n${escapeHtml(text)}</div>`;
  }

  private indexPage(viewer: Viewer): string {
    const apps = this.listManifests()
      .map((m) => {
        const pages = Object.values(m.pages)
          .map((pg) => `<a href="/a/${m.app}/${pg.name}">${escapeHtml(pg.title ?? pg.name)}</a>`)
          .join(" · ");
        return `<div class="slot"><h2><a href="/a/${m.app}">${escapeHtml(m.title)}</a></h2>
          <div class="sub">${m.app} · scope: ${m.scope}</div><div>${pages || "（无页面）"}</div></div>`;
      })
      .join("");
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>octopus v3 probe</title><style>${CLIENT_CSS}</style>
<div class="topbar"><span class="brand">🐙 v3 probe</span>
  ${viewer.admin ? '<a href="/factory">🏭 工厂</a>' : ""}
  <span class="who">${escapeHtml(viewer.username)}${viewer.admin ? " · admin" : ""} · <button id="logout" class="linkish">退出</button></span></div>
${this.errBanner()}
<div id="cols"><div class="col">${apps || '<div class="slot">apps 目录为空</div>'}</div></div>`;
  }

  private async servePage(
    appName: string,
    pageName: string | undefined,
    u: URL,
    viewer: ResolvedViewer,
    res: Reply,
    req: Req,
  ): Promise<void> {
    const m = this.manifests.get(appName);
    if (!m) return this.html(res, 404, loginPage(`未知应用 ${appName}`));
    const page = m.pages[pageName ?? ""] ?? Object.values(m.pages)[0];
    if (!page) return this.html(res, 404, loginPage(`应用 ${appName} 没有页面`));
    const scope = this.resolveScope(m, u, viewer);
    if (!this.canReadScope(m, scope, viewer)) return this.html(res, 403, loginPage("无权访问该 scope"));
    const inst = this.instance(m.app, scope);
    const actor: Actor = { kind: "user", username: viewer.username, admin: viewer.admin };
    const allowedSpecs = await inst.listActions(actor);
    const allowed = allowedSpecs.map((a) => a.name);
    const specs: Record<string, Pick<ActionSpec, "title" | "confirm" | "params">> = {};
    for (const s of allowedSpecs) specs[s.name] = { title: s.title, confirm: s.confirm, params: s.params };
    let view: unknown = null;
    let viewErr = "";
    try {
      view = await inst.view();
    } catch (err) {
      viewErr = String((err as Error)?.message ?? err);
    }
    // The handle is the App's identity for the lifetime of this page. It is
    // minted from the SESSION, embedded once, and is the only thing the View
    // can present — knowing another app's name buys nothing.
    // A bearer has no session, so it has nothing to bind an instance's lifetime
    // to; the page renders read-only and the View gets no handle.
    const instanceHandle = viewer.sessionKey ? await this.openInstanceFor(viewer, m, scope) : "";
    const csrf = readCookie(req.headers.cookie, this.cookies.names.csrf);
    const allowedMap: Record<string, 1> = {};
    for (const a of allowed) allowedMap[a] = 1;
    const boot = {
      // Display only; no route reads these back.
      app: m.app,
      scope,
      page,
      view,
      rev: inst.log.revision,
      viewer: { username: viewer.username, admin: viewer.admin },
      allowedMap,
      specs,
      // Authority. Never forwarded to the Agent View frame.
      instance: instanceHandle,
      csrf,
    };
    const nav = Object.values(m.pages)
      .map(
        (pg) =>
          `<a href="/a/${m.app}/${pg.name}${scope !== viewer.username && m.scope === "per-user" ? `?scope=${scope}` : ""}" class="${pg.name === page.name ? "cur" : ""}">${escapeHtml(pg.title ?? pg.name)}</a>`,
      )
      .join("");
    const cardLink = m.feishuCards.includes(page.name)
      ? ` · <a href="/api/card?app=${m.app}&scope=${scope}&page=${page.name}" target="_blank">🃏 卡片面</a>`
      : "";
    const nonce = randomBytes(16).toString("base64url");
    this.send(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(page.title ?? m.title)}</title><style nonce="${nonce}">${CLIENT_CSS}
#viewframe { width:100%; border:0; height:70vh; display:block; background:transparent; }
</style>
<div class="topbar"><a class="brand" href="/">🐙</a><span class="brand">${escapeHtml(m.title)}</span>
  <span class="nav">${nav}</span>
  <span class="who">${escapeHtml(viewer.username)}${viewer.admin ? " · admin" : ""}${scope !== viewer.username ? ` · 正在看 ${escapeHtml(scope)}（只读视角）` : ""}${cardLink}</span></div>
${this.errBanner()}
${viewErr ? `<div class="errbar">投影错误：${escapeHtml(viewErr)}</div>` : ""}
<iframe id="viewframe" sandbox="${VIEW_FRAME_SANDBOX}" src="/view-frame" title="app view"></iframe>
<div id="toast"></div>
<script nonce="${nonce}">window.__BOOT = ${jsonForScript(boot)};</script>
<script nonce="${nonce}">${CLIENT_JS}</script>`,
      {
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'nonce-${nonce}'`,
          "img-src data:",
          "connect-src 'self'",
          "frame-src 'self'",
          "form-action 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      },
    );
  }

}

/**
 * Embed server data in a script tag. `<` and U+2028/2029 are the three ways a
 * JSON string can escape a script element or a JS string literal.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The login form. It is a plain HTML POST rather than a link with the token in
 * it: the URL of a GET is written down in half a dozen places (history, the
 * Referer of the next request, proxy and server logs), and a long-lived
 * credential must not be in any of them. The page carries no script, so the
 * deny-all CSP in `send()` applies unchanged.
 */
function loginPage(msg: string): string {
  return `<!doctype html><meta charset="utf-8"><title>v3 probe</title><style>${CLIENT_CSS}</style>
<div style="max-width:460px;margin:18vh auto;padding:0 16px"><div class="slot"><h2>🐙 octopus v3 probe</h2>
${msg ? `<p>${escapeHtml(msg)}</p>` : ""}</div></div>`;
}

/**
 * The login form.
 *
 * A `fetch` POST rather than a link carrying the token, because the URL of a
 * GET is written down in half a dozen places — history, the Referer of the
 * next request, the proxy log, the server log — and a long-lived credential
 * must not be in any of them. `fetch` rather than a plain `<form>` because a
 * form POST does not reliably send `Origin` on a same-origin submit, and the
 * Origin check is not something to make conditional.
 */
function loginFormPage(msg: string, nonce: string): string {
  return `<!doctype html><meta charset="utf-8"><title>v3 probe · 登录</title>
<style nonce="${nonce}">${CLIENT_CSS}</style>
<div style="max-width:460px;margin:18vh auto;padding:0 16px"><div class="slot">
<h2>🐙 octopus v3 probe</h2>
<p><input id="tok" type="password" placeholder="访问令牌" autocomplete="off" autofocus
   style="width:100%;padding:8px;box-sizing:border-box"></p>
<p><button id="go">登录</button></p>
<p id="msg" style="color:#dc2626;font-size:12px">${escapeHtml(msg)}</p>
<p style="font-size:12px;opacity:.7">令牌只随这次提交发送，不会出现在网址、浏览历史或日志里。</p>
</div></div>
<script nonce="${nonce}">
document.getElementById("go").addEventListener("click", async function () {
  var t = document.getElementById("tok").value.trim();
  if (!t) return;
  var r = await fetch("/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: t }),
    redirect: "follow",
  });
  if (r.redirected || r.ok) location.href = "/";
  else document.getElementById("msg").textContent = "令牌无效。";
});
document.getElementById("tok").addEventListener("keydown", function (e) {
  if (e.key === "Enter") document.getElementById("go").click();
});
</script>`;
}
