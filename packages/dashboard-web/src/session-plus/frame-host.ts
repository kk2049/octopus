import { uiMessage, uiValue, type UiMessage, type UiTextValue } from "../i18n/ui-text.js";
/**
 * The trusted half of the Session Plus boundary: the module that owns the iframe.
 *
 * It runs on the panel's origin, so it is the thing that holds authority — the
 * session cookie, the CSRF secret, the navigation, the approval pill. Its job is
 * therefore not "talk to the view" but **decide what anything the view says
 * means**, and the three rules it is written to are:
 *
 *  1. **One frame, one channel, one generation.** A port is transferred only to
 *     the window this module created, only once, and every port closes over the
 *     generation it belongs to. After a rebuild, a message from the previous
 *     generation is dropped even if it somehow still arrives — the closed port
 *     is the mechanism, the generation check is the assertion.
 *  2. **A proposal is not a request.** `owner`, `app`, `scope`, `instance` and
 *     `approved` are not read. The Host copies out only bounded primitive
 *     parameters and delegates to the same-origin coordinator. The answer
 *     contains no identity, because the view must not learn it even by
 *     reflection.
 *  3. **Loading has no deadline.** A slow network may leave the frame loading,
 *     but may never turn slowness into a terminal failure. Unavailable remains
 *     reserved for a concrete trusted-host operation that failed.
 *
 * ── Why it is a factory and not a component ─────────────────────────────────
 *
 * `createSessionPlusHost(deps)` takes its window, document, container, channel
 * factory and timers as arguments, so it can be driven in a test with fakes
 * through reconstruction, stale ports and forged proposals without a browser.
 * The browser suite then proves the parts only a browser can (cookies,
 * cross-origin DOM, CSP); the two are complementary rather than one
 * substituting for the other.
 *
 * ── What changed in the React migration, and what did not ───────────────────
 *
 * This used to ship as a template string evaluated by an inline `<script>`. It
 * is now an ordinary module in the bundle, which means the compiler checks it
 * and the page needs no inline script at all (`script-src 'self'`). Every rule
 * above, every counter and every bound is unchanged, and the same test drives it.
 */

import {
  MSG,
  BROWSER_DRAFT_ACTIVE_KEYS_MAX,
  BROWSER_DRAFT_KEY_MAX,
  BROWSER_DRAFT_TEXT_MAX,
  PORT_MESSAGE_BYTES,
  PORT_STREAM_PULL_ACTION,
  PORT_WINDOW_MESSAGES,
  PORT_WINDOW_MS,
  SANDBOX_ALLOW_SCRIPTS_AND_DOWNLOADS,
  SESSION_PLUS_PROTOCOL,
  VIEW_HELLO,
  VIEW_RECONNECT,
  VIEW_RECOVERY_BYTES,
  WAKE_WINDOW_MESSAGES,
  readAgentViewPerformanceWindow,
  type AgentViewPerformanceWindow,
  type AppearanceSpec,
} from "@claude-bot/web-trust/frame-protocol";

export type HostState = "idle" | "loading" | "ready" | "unavailable" | "degraded";

export interface Proposal {
  action: string;
  params: Record<string, unknown>;
}

export interface DispatchReply {
  ok?: boolean;
  code?: string;
  message?: string;
  result?: unknown;
  projection?: unknown;
  /** The server's monotonic projection revision, when it sent one. */
  revision?: unknown;
}

export interface HostSnapshot {
  state: HostState;
  detail: string;
  /** Trusted-shell display copy only; never sent through the View port. */
  notice?: UiMessage;
  /** Internal channel epoch for diagnostics and stale-message rejection. */
  generation: number;
  handshakes: number;
  ports: number;
  accepted: number;
  refused: number;
  ignored: number;
  lastProposal: Proposal | null;
  lastAnswer: { ok: boolean; action: string; code?: string } | null;
}

export interface HostDraftRecord {
  readonly text: string;
  readonly updatedAt: number;
}

export interface HostDraftStore {
  read(key: string): HostDraftRecord;
  write(key: string, text: string): HostDraftRecord;
  subscribe(key: string, listener: (record: HostDraftRecord) => void): () => void;
}

/** The DOM surface this module needs, narrowed so a test can supply fakes. */
export interface HostDeps {
  doc: { createElement(tag: string): HTMLIFrameElement };
  win: {
    addEventListener(kind: string, fn: (ev: MessageEvent) => void): void;
    removeEventListener(kind: string, fn: (ev: MessageEvent) => void): void;
  };
  slot: { appendChild(child: unknown): void };
  appOrigin: string;
  /** Optional immutable document path; appOrigin remains the CSP origin. */
  appUrl?: string;
  projection: unknown;
  /**
   * Initial outer-shell appearance to include in the boot payload. Optional so
   * that (a) tests and legacy compositions omit it without a change of shape,
   * and (b) the boot exact-keys assertion still separates "no appearance" from
   * "appearance carried". The value is bounded by construction (see the
   * theme store's `getAppearance()` — the closed `THEMES` set is the source),
   * so nothing in this file re-validates it.
   */
  appearance?: AppearanceSpec;
  /**
   * Browser-local, viewer/release-scoped text cache. This interface contains
   * no namespace method on purpose: the trusted caller binds that scope before
   * handing it to a Host, so the View can neither choose nor learn it.
   */
  drafts?: HostDraftStore;
  /** Opaque, bounded browser checkpoint returned on the next View boot. */
  recovery?: string;
  /** Persist a newly published checkpoint in trusted, account-scoped tab storage. */
  onRecovery?: (checkpoint: string) => void;
  dispatch?: (proposal: Proposal) => Promise<DispatchReply>;
  /** Trusted parent asks the server to retire this frame generation's resources. */
  resetResources?: () => Promise<boolean>;
  /**
   * A debug-channel event the View volunteered to COMPLETE a request this
   * host started (today: the pick result after `debug("pick.start")`).
   * Bounded display data only; never an authority input.
   */
  onDebugEvent?: (op: string, result: unknown) => void;
  /** Closed numeric diagnostics from the untrusted View; never authority. */
  onPerformance?: (report: AgentViewPerformanceWindow) => void;
  onChange?: (snapshot: HostSnapshot) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  channel?: () => MessageChannel;
  now?: () => number;
}

export interface SessionPlusHost {
  mount(): void;
  destroy(why?: UiTextValue): void;
  reconstruct(): Promise<void>;
  /** Terminal teardown: unlike destroy(), also removes the global listener. */
  dispose(why?: UiTextValue): void;
  /**
   * Replace the retained projection and forward it to the View.
   *
   * `revision` is the server's monotonic number when the caller has one (the
   * SSE stream and dispatch replies both carry it). It rides the view frame so
   * the View can drop the duplicate it would otherwise re-render — one action
   * produces the same projection twice, once in the HTTP answer and once on
   * the broadcast stream. The Host also guards its retained copy: a numbered
   * update at or below the retained revision is a complete no-op, so a late
   * HTTP reply cannot reappear on the next boot. A legacy unnumbered update is
   * still accepted, but starts a fresh unnumbered epoch by clearing the
   * retained revision.
   */
  update(next: unknown, revision?: number): void;
  operation(next: unknown): void;
  /**
   * Forward one content-free wake (ADR 0006): "binding B's ref R changed;
   * worth asking again". Dropped silently past the per-window ceiling, never
   * retained, never counted by the View→Host fuse.
   */
  wake(next: { binding: string; ref: string }): void;
  /**
   * Push the outer shell's current appearance to the View (ticket #45).
   *
   * Semantics are RETAINED, not just live-broadcast: the Host holds the
   * latest appearance in memory. `updateAppearance(next)`:
   *
   *   1. always replaces the retained value;
   *   2. does not send a live frame if the port is not yet bound (there is
   *      no channel to send on), but the retained value it just set will
   *      ride the boot payload the moment the handshake completes;
   *   3. across generations after destroy/reconstruct, the RETAINED value
   *      is what the new boot carries — the previous port is closed, so
   *      there is no live frame to send there either.
   *
   * The Host constructs `next` from its own closed `THEMES` set, so this
   * method neither re-validates nor bounds it; the View has the defensive
   * reader (any unknown value folds to `classic`). Destroy/dispose do NOT
   * broadcast an appearance frame — a decoration change should not accompany
   * a teardown, and the next mount reads the same retained value anyway.
   */
  updateAppearance(next: AppearanceSpec): void;
  /**
   * Put one debug-channel/v1 request to the View (design §5). Resolves with
   * the View's bounded answer, a refusal when no channel is bound, or a
   * timeout refusal when the View never answers — it never rejects.
   */
  debug(op: string): Promise<{ ok: boolean; result?: unknown; message?: string }>;
  snapshot(): HostSnapshot;
  /** Exposed so a test can deliver a window message without a real window. */
  onWindowMessage(ev: MessageEvent): void;
}

/** How long a View may take to answer one debug request. */
const DEBUG_TIMEOUT_MS = 3_000;
/**
 * Stream handles holding a pull credit at once. The trusted broker keeps at
 * most 8 streams open per scope, so live streams never come near this; it only
 * stops credits for streams a View abandoned from accumulating.
 */
const PULL_CREDIT_HANDLES = 64;

export function createSessionPlusHost(deps: HostDeps): SessionPlusHost {
  const doc = deps.doc;
  const win = deps.win;
  const slot = deps.slot;
  const origin = deps.appOrigin;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => window.clearTimeout(handle as number));
  const channel = deps.channel ?? (() => new MessageChannel());
  const nowMs = deps.now ?? (() => Date.now());

  // Authority/lifecycle epoch, not a user-facing View version or rebuild count.
  let generation = 0;
  let frame: HTMLIFrameElement | null = null;
  let port: MessagePort | null = null;
  let projection = deps.projection;
  /** The newest server revision seen, or null before any numbered update. */
  let projectionRevision: number | null = null;
  /**
   * The retained appearance (ticket #45). Seeded from `deps.appearance` so a
   * caller that supplies an initial value has it available on every subsequent
   * boot too; `undefined` means "no appearance has ever been offered", which
   * is observably different from `{contract:.., theme:"classic"}` — the first
   * lets an old-Host / new-View pair still work with a boot payload that has
   * exactly `{projection, protocol, t}`, the second sends an appearance field.
   */
  let currentAppearance: AppearanceSpec | undefined = deps.appearance;
  let currentRecovery = boundedRecovery(deps.recovery);
  /** Wake frames sent inside the rolling window; over the cap they are dropped. */
  let wakesSent: number[] = [];
  let arrivals: number[] = [];
  /**
   * Stream handles whose last pull was answered with a chunk. Each holds ONE
   * pull the fuse admits uncounted (`PORT_STREAM_PULL_ACTION`); the set is
   * per generation and bounded, and a dropped credit only means a counted pull.
   */
  const pullCredits = new Set<string>();
  let fused = false;
  let state: HostState = "idle";
  let detail = "";
  let notice: UiMessage | undefined;
  const counts = { handshakes: 0, ports: 0, accepted: 0, refused: 0, ignored: 0 };
  let lastProposal: Proposal | null = null;
  let lastAnswer: HostSnapshot["lastAnswer"] = null;
  let disposed = false;
  let observedFrameLoad = false;
  let resetForGeneration: Promise<boolean> | null = null;
  let rebuilding: Promise<void> | null = null;
  /** In-flight debug requests, keyed by their own rid namespace. */
  const debugPending = new Map<string, (reply: { ok: boolean; result?: unknown; message?: string }) => void>();
  let nextDebugRid = 0;
  const draftSubscriptions = new Map<string, () => void>();

  function snapshot(): HostSnapshot {
    return {
      state,
      detail,
      ...(notice ? { notice } : {}),
      generation,
      handshakes: counts.handshakes,
      ports: counts.ports,
      accepted: counts.accepted,
      refused: counts.refused,
      ignored: counts.ignored,
      lastProposal,
      lastAnswer,
    };
  }

  function emit(next: HostState, why?: UiTextValue): void {
    state = next;
    notice = typeof why === "object" ? why : undefined;
    // Diagnostic text stays in its original language. Only the shell renders notice.
    detail = uiValue(why, "zh-CN");
    deps.onChange?.(snapshot());
  }

  function notify(): void {
    deps.onChange?.(snapshot());
  }

  function settleDebugRequests(why: string): void {
    for (const rid of [...debugPending.keys()]) {
      const resolve = debugPending.get(rid)!;
      debugPending.delete(rid);
      resolve({ ok: false, message: why });
    }
  }

  function closePort(): void {
    for (const off of draftSubscriptions.values()) off();
    draftSubscriptions.clear();
    if (port) {
      try {
        port.close();
      } catch {
        /* already gone */
      }
      port = null;
    }
  }

  const validDraftKey = (key: unknown): key is string => (
    typeof key === "string" && Boolean(key) && key.length <= BROWSER_DRAFT_KEY_MAX
  );

  function sendDraft(gen: number, key: string, record: HostDraftRecord): void {
    if (!port || gen !== generation) return;
    const text = typeof record.text === "string" && record.text.length <= BROWSER_DRAFT_TEXT_MAX
      ? record.text
      : "";
    const updatedAt = typeof record.updatedAt === "number" && Number.isSafeInteger(record.updatedAt) && record.updatedAt > 0
      ? record.updatedAt
      : nowMs();
    port.postMessage({ t: MSG.draftUpdate, key, text, updatedAt });
  }

  function observeDraft(gen: number, key: string): boolean {
    if (!deps.drafts) return false;
    const existing = draftSubscriptions.get(key);
    if (existing) {
      draftSubscriptions.delete(key);
      draftSubscriptions.set(key, existing);
      return true;
    }
    if (draftSubscriptions.size >= BROWSER_DRAFT_ACTIVE_KEYS_MAX) {
      const oldest = draftSubscriptions.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        draftSubscriptions.get(oldest)?.();
        draftSubscriptions.delete(oldest);
      }
    }
    const off = deps.drafts.subscribe(key, (record) => sendDraft(gen, key, record));
    draftSubscriptions.set(key, off);
    return true;
  }

  function requestFrameAnnouncement(): void {
    frame?.contentWindow?.postMessage(VIEW_RECONNECT, "*");
  }

  function onFrameLoad(): void {
    if (disposed || !frame) return;
    if (!observedFrameLoad) {
      observedFrameLoad = true;
      // HELLO/READY usually arrive during parsing, before `load`. Preserve that
      // live port; if they did not, ask the now-loaded document to announce
      // once more. There is deliberately no deadline: network slowness is not
      // evidence that the immutable View is unavailable.
      if (state !== "ready") {
        requestFrameAnnouncement();
      }
      return;
    }

    // Mobile browsers can discard and reload the child process while leaving
    // this trusted page alive. Rotate only the channel generation: retain the
    // latest authoritative projection/appearance, never reset resources and
    // never replay an action whose server outcome could be unknown.
    generation += 1;
    arrivals = [];
    pullCredits.clear();
    fused = false;
    settleDebugRequests("视图已重新加载，旧调试请求已结束");
    closePort();
    emit("loading", uiMessage("Agent View 重建中"));
    requestFrameAnnouncement();
  }

  function mount(why: UiTextValue = uiMessage("Agent View 加载中")): void {
    if (disposed || frame) return;
    arrivals = [];
    pullCredits.clear();
    fused = false;
    generation += 1;
    const created = doc.createElement("iframe");
    observedFrameLoad = false;
    // The token set is a constant on purpose: adding allow-same-origin would
    // hand the view this document's origin, and with it the cookie jar and the
    // parent DOM.
    created.setAttribute("sandbox", SANDBOX_ALLOW_SCRIPTS_AND_DOWNLOADS);
    created.setAttribute("src", deps.appUrl ?? `${origin}/`);
    created.setAttribute("title", "session-plus agent view");
    created.setAttribute("referrerpolicy", "no-referrer");
    created.setAttribute("data-testid", "session-plus-frame");
    created.className = "spframe";
    created.addEventListener("load", onFrameLoad);
    frame = created;
    slot.appendChild(created);
    emit("loading", why);
  }

  function destroy(why?: UiTextValue): void {
    generation += 1; // everything from the old generation is now stale
    // Nothing may be left awaiting a debug answer no channel can deliver.
    settleDebugRequests("视图通道已关闭");
    closePort();
    if (frame) {
      try {
        frame.removeEventListener("load", onFrameLoad);
        frame.parentNode?.removeChild(frame);
      } catch {
        /* detached */
      }
      frame = null;
    }
    observedFrameLoad = false;
    emit("idle", why || uiMessage("视图已销毁"));
  }

  function beginResourceReset(): Promise<boolean> {
    if (!resetForGeneration) {
      const started = deps.resetResources
        ? Promise.resolve().then(deps.resetResources).catch(() => false)
        : Promise.resolve(true);
      resetForGeneration = started;
      // Keep a successful reset for reconstruct() to join even if the flood
      // fuse finished it before the person clicks. A failed attempt is not a
      // permanent latch: the next click must be able to retry a transient
      // network/backend failure.
      void started.then((ok) => {
        if (!ok && resetForGeneration === started) resetForGeneration = null;
      });
    }
    return resetForGeneration;
  }

  function reconstruct(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (rebuilding) return rebuilding;
    destroy(uiMessage("Agent View 重建中"));
    const work = beginResourceReset().then((ok) => {
      if (disposed) return;
      if (!ok) {
        emit("unavailable", uiMessage("旧视图的资源没有安全结束；本次没有启动新视图"));
        return;
      }
      resetForGeneration = null;
      mount(uiMessage("Agent View 重建中"));
    });
    const pending = work.finally(() => {
      if (rebuilding === pending) rebuilding = null;
    });
    rebuilding = pending;
    return rebuilding;
  }

  function dispose(why?: UiTextValue): void {
    if (disposed) return;
    disposed = true;
    destroy(why ?? uiMessage("页面已离开"));
    win.removeEventListener("message", onWindowMessage as (ev: MessageEvent) => void);
  }

  function onWindowMessage(ev: MessageEvent): void {
    if (disposed) return;
    if (ev.data !== VIEW_HELLO) return;
    counts.handshakes += 1;
    // Authentication of the sender, and the only one available: a sandboxed
    // frame has an opaque origin ("null"), so identity here IS "the window I
    // created and still hold". A rogue frame the page acquired some other way
    // fails this and gets nothing.
    //
    // The origin is checked too, and it is a TRIPWIRE rather than a second
    // identity: "null" is what an opaque origin serialises to, so a frame that
    // reports anything else is a frame that is no longer sandboxed the way this
    // file assumes. Adding allow-same-origin would otherwise change nothing
    // visible — the handshake would keep working with a frame that has powers
    // nobody granted it. Here it fails loudly instead.
    if (!frame || ev.source !== frame.contentWindow || String(ev.origin) !== "null") {
      counts.ignored += 1;
      notify();
      return;
    }
    if (port || fused) {
      // One channel per generation, no re-handshake.
      counts.ignored += 1;
      notify();
      return;
    }
    const gen = generation;
    const ch = channel();
    port = ch.port1;
    counts.ports += 1;
    port.onmessage = (event: MessageEvent) => onPortMessage(gen, event.data);
    port.start?.();
    // targetOrigin "*" is forced by the opaque origin; the payload is one
    // transferred port and a protocol tag, and the recipient is a window we are
    // holding a reference to.
    frame.contentWindow!.postMessage({ t: MSG.port, protocol: SESSION_PLUS_PROTOCOL }, "*", [
      ch.port2,
    ]);
    // The initial appearance rides on the boot payload (rather than as a
    // separate frame delivered after `ready`) so the View has the outer
    // shell's theme in hand for its FIRST paint. That avoids a one-frame
    // classic flash when boot is already `aurora`/`ink`, which is what the
    // "live switch does not repaint the frame" property would otherwise be
    // silently violated by. The key is optional so an omitted appearance is
    // observably different from "appearance = classic".
    //
    // Reads the RETAINED value (`currentAppearance`), not the immutable
    // `deps.appearance`: `updateAppearance()` calls that arrived between
    // mount and this handshake have already replaced the retained value, so
    // the boot payload carries the most recent theme the outer shell picked
    // — not the one that was current when the host was constructed.
    const bootPayload: Record<string, unknown> = {
      t: MSG.boot,
      protocol: SESSION_PLUS_PROTOCOL,
      // Data only. No session, no CSRF, no instance handle, no username, no app
      // or scope — the view is told what to draw, never who it is drawing it for.
      projection,
    };
    if (currentAppearance !== undefined) bootPayload.appearance = currentAppearance;
    if (currentRecovery !== null) bootPayload.recovery = currentRecovery;
    // A rebuilt View starts its revision epoch at the newest state the Host
    // retained, so a stream frame it already carried is not re-applied.
    if (projectionRevision !== null) bootPayload.revision = projectionRevision;
    port.postMessage(bootPayload);
    notify();
  }

  function onPortMessage(gen: number, msg: unknown): void {
    // @architecture flow=agent-view-proposal step=host-validate after=shape-proposal role=gate label="Validate generation, rate and message kind" condition="Host receives a private-port message" outcome=envelope-verdict authority="Host generation and rate-fuse state"
    if (gen !== generation) {
      // @architecture flow=agent-view-proposal step=stale-generation after=host-validate role=refusal label="Drop a stale View generation" condition="port generation is stale" outcome=drop authority=none terminal=true
      counts.ignored += 1;
      return;
    }
    // @architecture flow=agent-view-proposal step=rate-fused after=host-validate role=refusal label="Fuse an over-rate View channel" condition="message rate exceeds the Host window" outcome=drop authority=none terminal=true
    if (!spendPullCredit(msg) && !admitMessage()) return;
    // @architecture flow=agent-view-proposal step=invalid-envelope after=host-validate role=refusal label="Drop a non-object envelope" condition="message is not an object" outcome=drop authority=none terminal=true
    if (!msg || typeof msg !== "object") return;
    const message = msg as { t?: string };
    if (message.t === MSG.ready) {
      emit("ready", uiMessage("Agent View 已就绪"));
      return;
    }
    if (message.t === MSG.height) {
      // Layout is Host-owned. A View may speak the old height message for
      // protocol compatibility, but it cannot grow the frame, create a second
      // document scroller or crowd trusted chrome off screen.
      return;
    }
    if (message.t === MSG.debugResult) {
      const reply = msg as Record<string, unknown>;
      if (typeof reply.rid === "string") {
        const resolve = debugPending.get(reply.rid);
        if (resolve) {
          debugPending.delete(reply.rid);
          resolve({
            ok: reply.ok === true,
            ...(reply.result === undefined ? {} : { result: reply.result }),
            ...(typeof reply.message === "string" ? { message: str(reply.message, 240) } : {}),
          });
        }
      }
      return;
    }
    if (message.t === MSG.debugEvent) {
      // The one unsolicited debug message: completion of a pick this host
      // started. Bounded display data; the consumer treats it as such.
      const event = msg as Record<string, unknown>;
      if (typeof event.op === "string") deps.onDebugEvent?.(str(event.op, 40), event.result);
      return;
    }
    if (message.t === MSG.draftRead) {
      const draft = msg as Record<string, unknown>;
      if (!validDraftKey(draft.key) || !observeDraft(gen, draft.key)) return;
      sendDraft(gen, draft.key, deps.drafts!.read(draft.key));
      return;
    }
    if (message.t === MSG.draftWrite) {
      const draft = msg as Record<string, unknown>;
      if (!validDraftKey(draft.key) || typeof draft.text !== "string" || !observeDraft(gen, draft.key)) return;
      // Never truncate into a plausible instruction. Oversize means the old
      // persisted value is tombstoned while the View keeps its live text.
      deps.drafts!.write(
        draft.key,
        draft.text.length <= BROWSER_DRAFT_TEXT_MAX ? draft.text : "",
      );
      return;
    }
    if (message.t === MSG.recovery) {
      const next = boundedRecovery((msg as Record<string, unknown>).checkpoint);
      if (next === null || next === currentRecovery) return;
      currentRecovery = next;
      try {
        deps.onRecovery?.(next);
      } catch {
        // Recovery is best effort. A storage failure cannot disturb the port.
      }
      return;
    }
    if (message.t === MSG.performance) {
      const report = readAgentViewPerformanceWindow((msg as Record<string, unknown>).report);
      if (report) deps.onPerformance?.(report);
      else counts.ignored += 1;
      return;
    }
    // Any other message kind falls through this dispatch and is dropped.
    // @architecture flow=agent-view-proposal step=unsupported-message after=host-validate role=refusal label="Drop an unsupported private message" condition="message kind is neither a supported control/draft kind nor propose" outcome=drop authority=none terminal=true
    if (message.t === MSG.propose) answer(gen, msg as Record<string, unknown>);
  }

  /** A bounded string, or "". Everything the view sends passes through here. */
  function str(value: unknown, max: number): string {
    if (typeof value !== "string") return "";
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  function admitMessage(): boolean {
    const at = nowMs();
    while (arrivals.length && arrivals[0] <= at - PORT_WINDOW_MS) arrivals.shift();
    arrivals.push(at);
    if (arrivals.length <= PORT_WINDOW_MESSAGES) return true;
    fused = true;
    counts.ignored += 1;
    if (port) {
      try {
        port.close();
      } catch {
        /* already gone */
      }
      port = null;
    }
    emit("degraded", uiMessage("视图消息过快，通道已熔断；可重建视图恢复"));
    // Closing the port is not enough: a malicious generation may have left
    // provider streams idle on the server. Begin retirement immediately; the
    // reconstruct button joins this same reset before mounting its successor.
    void beginResourceReset();
    return false;
  }

  /**
   * Whether this message continues a stream the trusted side is still feeding.
   *
   * True only for a `stream_pull` naming a handle whose previous pull was
   * answered with a chunk, and it spends that credit. Everything else — the
   * first pull of a stream, a handle nobody answered, a pull after `end` or a
   * refusal — goes through the counted fuse as before.
   */
  function spendPullCredit(msg: unknown): boolean {
    if (!pullCredits.size || !msg || typeof msg !== "object") return false;
    try {
      const row = msg as { t?: unknown; action?: unknown; params?: unknown };
      if (row.t !== MSG.propose || row.action !== PORT_STREAM_PULL_ACTION) return false;
      const handle = (row.params as { handle?: unknown } | null | undefined)?.handle;
      return typeof handle === "string" && pullCredits.delete(handle);
    } catch {
      return false;
    }
  }

  /** A chunk answer earns its stream one uncounted follow-up pull. */
  function grantPullCredit(gen: number, proposal: Proposal, reply: DispatchReply | null | undefined): void {
    if (gen !== generation || proposal.action !== PORT_STREAM_PULL_ACTION || !reply?.ok) return;
    const handle = proposal.params.handle;
    const kind = (reply.result as { kind?: unknown } | null | undefined)?.kind;
    if (typeof handle !== "string" || kind !== "chunk") return;
    // Bounded by the streams the trusted side has open; the cap only guards
    // against handles a View abandoned mid-stream. Oldest credit goes first.
    if (pullCredits.size >= PULL_CREDIT_HANDLES) pullCredits.delete(pullCredits.values().next().value!);
    pullCredits.add(handle);
  }

  function bytes(text: string): number {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    return String(text).length * 3;
  }

  function boundedRecovery(value: unknown): string | null {
    if (typeof value !== "string" || value.length === 0) return null;
    return bytes(value) <= VIEW_RECOVERY_BYTES ? value : null;
  }

  /**
   * Turn whatever arrived into the small schema this milestone accepts.
   *
   * The Host used to RETAIN `msg.params` — an arbitrary object graph chosen by
   * the untrusted view — and the trusted page then rendered it. Structured clone
   * happily transfers a CYCLIC object and `JSON.stringify` throws on one, so
   * three lines of view code could stop the trusted shell's status rendering.
   * Nothing about that needed a bug on our side; it needed us to keep something
   * we were never going to interpret.
   *
   * So the boundary copies out only flat primitive fields, each coerced to a
   * bounded primitive. No reference to the incoming graph survives, which makes
   * cycles, getters, huge blobs and unexpected keys all the same uninteresting
   * case. A separate payload limit and per-port rate fuse bound the remaining
   * wire-level work.
   *
   * ── Why a clipped value must never be dispatchable ────────────────────────
   *
   * This used to clip each string at 4096 characters and pass it on. Nothing sent
   * one that long, so nothing noticed — but the editor batch made a proposal
   * parameter a whole FILE BODY, and a silently shortened body written back over
   * a compare-and-swap is exactly the "App wrote badly, data was lost" failure
   * the convergence plan's decision 12 raises above everything else. Truncation
   * is not a bound; it is a different request.
   *
   * So the per-value clip is `PORT_MESSAGE_BYTES` characters, which makes
   * clipping IMPLY refusal: a JSON string of N characters serialises to at least
   * N+2 bytes, so anything that got clipped is already over the message ceiling
   * checked in `answer()`. The running budget below stops the copy shortly after
   * the ceiling for the same reason — the retained total is what the ceiling
   * check then measures, so it refuses rather than dispatches, and no view can
   * make this function copy megabytes.
   *
   * This layer still does not know what any parameter MEANS; the per-parameter
   * bound a contract declares is the trusted coordinator's business.
   */
  function normalizeParams(raw: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!raw || typeof raw !== "object") return out;
    let keys: string[];
    try {
      keys = Object.keys(raw as object).slice(0, 16);
    } catch {
      return out;
    }
    let spent = 0;
    for (const rawKey of keys) {
      const key = str(rawKey, 64);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
      let value: unknown;
      try {
        value = (raw as Record<string, unknown>)[rawKey];
      } catch {
        continue;
      }
      if (typeof value === "string") {
        const kept = str(value, PORT_MESSAGE_BYTES);
        out[key] = kept;
        spent += kept.length;
        // Over the ceiling already: whatever else is in there cannot make this
        // proposal deliverable, and copying it would only cost memory.
        if (spent > PORT_MESSAGE_BYTES) break;
      } else if (typeof value === "boolean" || value === null) out[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  }

  function answer(gen: number, msg: Record<string, unknown>): void {
    const action = str(msg.action, 64);
    // Recorded for the panel's own status panel. Note which fields are kept:
    // what the view ASKED FOR, never what it claimed to be — and normalized, so
    // the trusted side never holds a reference to the view's object graph.
    // @architecture flow=agent-view-proposal step=host-rebind after=host-validate role=boundary label="Copy bounded fields into Host-owned data" condition="current, rate-admitted proposal envelope" outcome=host-owned-proposal authority="trusted Host interpretation" enforces=DATA-001
    const proposal: Proposal = { action, params: normalizeParams(msg.params) };
    lastProposal = proposal;
    // The correlation id is the view's too: echoed back so it can match its own
    // promise, bounded so it cannot be a payload.
    const rid = str(msg.rid, 64);
    if (bytes(JSON.stringify(proposal)) > PORT_MESSAGE_BYTES) {
      // @architecture flow=agent-view-proposal step=message-too-large after=host-rebind role=refusal label="Refuse an oversized proposal" condition="normalized proposal exceeds 512 KiB" outcome=deny authority=none terminal=true
      finish(gen, rid, proposal.action, {
        ok: false,
        code: "message_too_large",
        // Derived, not spelled: the number moved once already, and a message
        // naming a stale limit is worse than one naming none.
        message: `提议超过 ${Math.round(PORT_MESSAGE_BYTES / 1024)}KB 上限`,
      });
      return;
    }
    if (!action || typeof deps.dispatch !== "function") {
      // @architecture flow=agent-view-proposal step=unknown-action after=host-rebind role=refusal label="Refuse an unavailable action" condition="action is empty or no Host dispatcher exists" outcome=deny authority=none terminal=true
      finish(gen, rid, proposal.action, { ok: false, code: "unknown_action", message: "动作不可用" });
      return;
    }
    // @architecture flow=agent-view-proposal step=same-origin-dispatch after=host-rebind role=dispatch label="Dispatch under the trusted Host identity" condition="bounded action is available" outcome=dispatch authority="same-origin Host session" enforces=DATA-001
    Promise.resolve()
      .then(() => deps.dispatch!(proposal))
      .then(
        (reply) => {
          grantPullCredit(gen, proposal, reply);
          finish(gen, rid, proposal.action, reply || { ok: false, code: "dispatch_failed", message: "动作没有返回结果" });
        },
        () => finish(gen, rid, proposal.action, { ok: false, code: "backend_unavailable", message: "应用后端暂时不可用" }),
      );
  }

  function finish(gen: number, rid: string, action: string, reply: DispatchReply): void {
    if (gen !== generation) {
      // @architecture flow=agent-view-proposal step=stale-reply after=same-origin-dispatch role=refusal label="Drop a reply for a replaced View" condition="generation changed during dispatch" outcome=drop authority=none terminal=true
      counts.ignored += 1;
      return;
    }
    const ok = Boolean(reply && reply.ok);
    if (ok) counts.accepted += 1;
    else counts.refused += 1;
    if (ok && Object.prototype.hasOwnProperty.call(reply, "projection")) {
      update(reply.projection, typeof reply.revision === "number" ? reply.revision : undefined);
    }
    const out = ok
      ? { t: MSG.result, rid, ok: true, result: reply.result == null ? null : reply.result }
      : {
          t: MSG.result,
          rid,
          ok: false,
          code: str(reply?.code, 64),
          result: { message: str(reply?.message, 500) },
        };
    // Resource/search/transcript results belong inside the App View. The trusted
    // shell records only a bounded disposition for diagnostics; the complete
    // result still goes over the private MessagePort below.
    lastAnswer = ok
      ? { ok: true, action }
      : { ok: false, action, code: (out as { code: string }).code };
    // @architecture flow=agent-view-proposal step=host-reply after=same-origin-dispatch role=boundary label="Return a bounded disposition" condition="dispatch settles on the current generation" outcome=success-or-refusal authority="Host-authored bounded result" terminal=true
    if (port && gen === generation) port.postMessage(out);
    notify();
  }

  function update(next: unknown, revision?: number): void {
    const numbered = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
    if (numbered && projectionRevision !== null && revision <= projectionRevision) return;

    projection = next;
    projectionRevision = numbered ? revision : null;
    if (port) {
      const viewFrame: Record<string, unknown> = { t: MSG.view, projection };
      if (numbered) viewFrame.revision = revision;
      port.postMessage(viewFrame);
    }
  }

  function operation(next: unknown): void {
    if (port) port.postMessage({ t: MSG.op, operation: next });
  }

  /**
   * Forward one content-free wake to the View (ADR 0006).
   *
   * Outbound like `update()`/`operation()`, so the View→Host fuse never
   * counts it — but unlike appearance it has its OWN hard ceiling here, and
   * over it wakes are DROPPED: the server already debounces per (instance,
   * binding, ref), so this cap only fires on a broken or hostile trusted-side
   * caller, and a dropped wake is safe because the next one means exactly the
   * same thing. Not retained either: a wake is a moment, not a state, and the
   * View re-reads what it holds on boot anyway.
   */
  function wake(next: { binding: string; ref: string }): void {
    if (!port) return;
    const binding = typeof next?.binding === "string" ? next.binding : "";
    const ref = typeof next?.ref === "string" ? next.ref : "";
    if (!binding || !ref || binding.length > 64 || ref.length > 256) return;
    const at = nowMs();
    wakesSent = wakesSent.filter((stamp) => at - stamp < PORT_WINDOW_MS);
    if (wakesSent.length >= WAKE_WINDOW_MESSAGES) return;
    wakesSent.push(at);
    port.postMessage({ t: MSG.wake, binding, ref });
  }

  /**
   * Ticket #45: retain and (when the port exists) forward the outer shell's
   * theme choice to the View.
   *
   * The RETENTION half is what makes pre-handshake correctness work: an
   * outer-shell theme change that lands between `mount()` and the View's
   * hello would otherwise be lost, because there is no port to send on and
   * `deps.appearance` was captured once at construction. Replacing the
   * retained value first means the boot payload the handshake will produce
   * carries the latest theme, not a stale one. It ALSO means a call across
   * a torn-down generation is not a bug: the retained value is set for
   * whenever the next generation boots.
   *
   * The LIVE-FORWARD half is what a running View sees. Comment on the rate
   * fuse: `admitMessage()` (and its 100-in-10s window) is for View->Host
   * messages arriving on the port. Host->View traffic is outbound and does
   * not go through it — this method sends directly like `update()` and
   * `operation()` do, and is subject only to the same per-generation guard
   * (no port, no send). The theme picker in the outer shell is a human
   * control; a fuse here would only ever fire on a broken caller, and would
   * then wedge every subsequent legitimate change.
   */
  function updateAppearance(next: AppearanceSpec): void {
    currentAppearance = next;
    if (port) port.postMessage({ t: MSG.appearance, appearance: next });
  }

  /**
   * One debug-channel request (design §5). Outbound like update()/wake(), so
   * the View→Host fuse never counts it; the timeout keeps a wedged View from
   * wedging the trusted chrome that asked.
   */
  function debug(op: string): Promise<{ ok: boolean; result?: unknown; message?: string }> {
    if (!port) return Promise.resolve({ ok: false, message: "视图通道未就绪" });
    const rid = `d${++nextDebugRid}`;
    const reply = new Promise<{ ok: boolean; result?: unknown; message?: string }>((resolve) => {
      let timeout: unknown = null;
      // The stored settler clears the timeout, so every path — an answer, a
      // teardown, the timeout itself — resolves exactly once and leaks nothing.
      debugPending.set(rid, (answer) => {
        if (timeout) clearTimer(timeout);
        resolve(answer);
      });
      timeout = setTimer(() => {
        const pending = debugPending.get(rid);
        if (!pending) return;
        debugPending.delete(rid);
        resolve({ ok: false, message: "调试请求超时" });
      }, DEBUG_TIMEOUT_MS);
    });
    port.postMessage({ t: MSG.debug, rid, op: String(op).slice(0, 40) });
    return reply;
  }

  win.addEventListener("message", onWindowMessage as (ev: MessageEvent) => void);

  return {
    mount,
    destroy,
    reconstruct,
    dispose,
    update,
    operation,
    wake,
    updateAppearance,
    debug,
    snapshot,
    onWindowMessage,
  };
}
