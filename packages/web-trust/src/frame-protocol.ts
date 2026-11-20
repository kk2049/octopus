/**
 * The whole vocabulary that crosses the Session Plus trust boundary.
 *
 * Two programs speak it: the trusted shell (the Dashboard's React bundle, same
 * origin as the panel, holds the session cookie and the CSRF secret) and the
 * Agent View (`packages/bot/src/session-plus/view-app.ts`, a sandboxed frame on
 * a different origin with no credentials). They are compiled into two different
 * documents served from two different origins, so the only way they can agree is
 * by importing the same constants — which is why this file is a dependency-free
 * leaf that neither side may add behaviour to.
 *
 * It lives in `@claude-bot/web-trust`, next to the sandbox token set it belongs
 * with, and is reachable as its own package subpath (`.../frame-protocol`) so
 * the browser bundle can import it without pulling in the server-side halves of
 * this package.
 *
 * The message kinds are deliberately few, and the asymmetry is the design:
 *
 *   view  → host   hello (a window event), ready, height, propose, recovery,
 *                  performance,
 *                  draft-read, draft-write
 *   host  → view   reconnect (a payload-free window event), port (a window
 *                  event carrying ONE MessagePort), boot, view, result, op,
 *                  appearance, recovery, wake, draft-update
 *
 * `propose` is the only inbound kind that asks for an external action, and its
 * name is the contract: the View proposes, the Host decides. The View may put whatever it
 * likes in the message — including `owner`, `app`, `scope` and `instance` — and
 * the Host copies only the declared action fields before handing the proposal
 * to its same-origin coordinator. Nothing resembling identity crosses back.
 *
 * `appearance` is a Host→View decoration channel for the outer shell's theme
 * preference (see `APPEARANCE_CONTRACT` below). It is additive by design: a
 * message kind added, no fields removed, no existing kind's shape touched, so
 * both `SESSION_PLUS_PROTOCOL` and every already-shipped View continue to work —
 * an old View simply ignores an unknown kind, and an old Host never sends one.
 *
 * `wake` (ADR 0006, first implemented 2026-08-10) is the one kind that carries
 * NO content on purpose: it says "a resource this App already holds changed;
 * it is worth asking again", never what changed or for whom. The View's answer
 * is its own `propose`, which still passes the capability Gate — so the wake
 * channel is a hint, not a bypass, and not an authorisation. It rides the same
 * additive rule as `appearance`: "never receiving a wake" is exactly the
 * already-shipped behaviour, so the protocol id does not move.
 *
 * The draft trio is narrower still: a lossy browser-local text preference,
 * never a provider action. The opaque View cannot access Web Storage itself,
 * so it names one bounded semantic key and the trusted parent adds the current
 * viewer + exact View-release namespace before touching localStorage. No
 * identity crosses back, no network call is made, and an old Host/View pair
 * simply ignores the additive kinds. Empty text is a tombstone, not absence.
 *
 * `recovery` is the browser-document checkpoint channel. The View may publish
 * one bounded opaque string; the trusted shell may keep it in account-scoped
 * tab storage and return it on the next boot. The Host never interprets it,
 * and the View must revalidate every recovered semantic identity against the
 * current projection before using it. It grants no resource access and never
 * bypasses a proposal or Gate decision.
 *
 * `performance` is the other content-free additive kind. The View may send at
 * most a fixed numeric window: no text, resource ref, URL, action, identity or
 * arbitrary dimensions fit its closed reader. It is diagnostics only, never a
 * proposal or an authority input; an old Host ignores it and an old View never
 * sends it.
 */

export {
  SANDBOX_ALLOW_SCRIPTS,
  SANDBOX_ALLOW_SCRIPTS_AND_DOWNLOADS,
} from "./frame.js";

/** Bumped only for an incompatible change; both sides refuse a mismatch. */
export const SESSION_PLUS_PROTOCOL = "session-plus/2";

/**
 * The frame's announcement, posted to `window.parent` with `targetOrigin: "*"`.
 *
 * `"*"` is unavoidable and safe here: a frame sandboxed without
 * `allow-same-origin` has an OPAQUE origin, so it cannot name its parent's
 * origin and the parent cannot match on the frame's. The payload is a constant
 * string carrying no data, and the Host authenticates the sender by comparing
 * `event.source` against the frame element it created itself.
 */
export const VIEW_HELLO = "session-plus:view-hello";

/**
 * A payload-free prompt sent only to the iframe window after its document
 * fires `load`. It closes the race where a mobile browser reloads the child
 * document and its eager hello reaches a Host that has not observed `load`
 * yet. The View answers by announcing again only while it has no port; no
 * projection, identity or action is carried or replayed on this path.
 */
export const VIEW_RECONNECT = "session-plus:view-reconnect";

/** Message kinds, named once so a typo is a compile error on both sides. */
export const MSG = {
  port: "port",
  boot: "boot",
  view: "view",
  ready: "ready",
  height: "height",
  propose: "propose",
  result: "result",
  op: "op",
  appearance: "appearance",
  recovery: "recovery",
  wake: "wake",
  debug: "debug",
  debugResult: "debug_result",
  debugEvent: "debug_event",
  draftRead: "draft_read",
  draftWrite: "draft_write",
  draftUpdate: "draft_update",
  performance: "performance",
} as const;

/** Bounds shared by the hostile View sender and trusted browser-cache reader. */
export const BROWSER_DRAFT_KEY_MAX = 512;
export const BROWSER_DRAFT_TEXT_MAX = 64 * 1024;
/** A View may observe only this many draft keys in one channel generation. */
export const BROWSER_DRAFT_ACTIVE_KEYS_MAX = 32;
/** Hard ceiling for one browser-only recovery checkpoint in either direction. */
export const VIEW_RECOVERY_BYTES = 48 * 1024;

/** Maximum values accepted from one untrusted View performance window. */
const VIEW_PERFORMANCE_MAX_COUNT = 1_000_000;
const VIEW_PERFORMANCE_MAX_DURATION_MS = 3_600_000;

/**
 * A content-free performance window volunteered by an Agent View.
 *
 * Counts and durations are deliberately verbose rather than extensible: the
 * Host copies this exact closed shape, so a compromised View cannot turn a
 * metric name or extra field into a log-content channel.
 */
export interface AgentViewPerformanceWindow {
  version: 1;
  windowMs: number;
  inputEventCount: number;
  inputFrameCount: number;
  inputFrameTotalMs: number;
  inputFrameMaxMs: number;
  inputFrameOver50Count: number;
  projectionCommitCount: number;
  projectionCommitTotalMs: number;
  projectionCommitMaxMs: number;
  projectionFrameCount: number;
  projectionFrameTotalMs: number;
  projectionFrameMaxMs: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  timerLagCount: number;
  timerLagMaxMs: number;
  domNodes: number;
}

const VIEW_PERFORMANCE_COUNT_KEYS = [
  "inputEventCount",
  "inputFrameCount",
  "inputFrameOver50Count",
  "projectionCommitCount",
  "projectionFrameCount",
  "longTaskCount",
  "timerLagCount",
  "domNodes",
] as const;

const VIEW_PERFORMANCE_DURATION_KEYS = [
  "windowMs",
  "inputFrameTotalMs",
  "inputFrameMaxMs",
  "projectionCommitTotalMs",
  "projectionCommitMaxMs",
  "projectionFrameTotalMs",
  "projectionFrameMaxMs",
  "longTaskTotalMs",
  "longTaskMaxMs",
  "timerLagMaxMs",
] as const;

/** Defensively copy the exact numeric View metric vocabulary, or refuse it. */
export function readAgentViewPerformanceWindow(value: unknown): AgentViewPerformanceWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.version !== 1) return null;
  const report: Record<string, number> = { version: 1 };
  for (const key of VIEW_PERFORMANCE_COUNT_KEYS) {
    const metric = source[key];
    if (
      typeof metric !== "number"
      || !Number.isSafeInteger(metric)
      || metric < 0
      || metric > VIEW_PERFORMANCE_MAX_COUNT
    ) return null;
    report[key] = metric;
  }
  for (const key of VIEW_PERFORMANCE_DURATION_KEYS) {
    const metric = source[key];
    if (
      typeof metric !== "number"
      || !Number.isFinite(metric)
      || metric < 0
      || metric > VIEW_PERFORMANCE_MAX_DURATION_MS
    ) return null;
    report[key] = metric;
  }
  return report as unknown as AgentViewPerformanceWindow;
}

/**
 * debug-channel/v1 (design: doc/development/frontend-observability-design.md §5).
 *
 * The CLOSED vocabulary of debug requests a trusted parent may put to a View,
 * and the only ops a View runtime answers. Everything a View reports back is
 * display data it was already handed — a bounded DOM subtree, its own
 * transport timeline — so the channel discloses nothing new and grants
 * nothing; an unknown op is a bounded refusal, and only the parent may
 * initiate (the View emits `debugEvent` solely to complete a pick the parent
 * started).
 */
export const DEBUG_CHANNEL_VERSION = 1;
export const DEBUG_OPS = ["hello", "pick.start", "pick.stop", "events"] as const;

/**
 * The versioned identifier the Host stamps into every appearance payload.
 *
 * A single field decides whether the View recognises the payload at all: if the
 * literal below ever changes, a new-Host / old-View pair produces the same
 * outcome as an unknown message kind (silently ignored, keep classic). That is
 * what makes appearance additive without a protocol bump — the View has one
 * question to ask ("is this an appearance spec I understand?") and both answers
 * are safe.
 *
 * Future additive fields ride the same contract id; a breaking change ships a
 * new contract id, and the reader ignores payloads whose contract it does not
 * recognise. The View NEVER reflects this contract back to the Host, because
 * the Host is the authority on the outer shell's own theme.
 */
export const APPEARANCE_CONTRACT = "appearance/v1" as const;

/**
 * The wire-level bounds on a theme id.
 *
 * `theme` is an OPAQUE bounded string at this layer: the wire vocabulary is
 * intentionally NOT a closed enum here so a future outer-shell theme (e.g. a
 * new brand) can be added to `dashboard-web/styles/themes.ts` without a
 * synchronised change to `web-trust` and a rebuild of every already-shipped
 * Agent View bundle. The Host is bound to construct values only from its own
 * closed `THEMES` set (the source of truth for what the shell can offer); the
 * View maintains its own supported set (`SUPPORTED_VIEW_THEMES` in
 * `@claude-bot/agent-view-react`) and folds anything unknown to `classic`
 * best-effort. Two consequences:
 *
 *   - "the outer shell added a theme the View bundle predates" is a normal
 *     state, not a failure: the iframe stays classic, the shell reads its own
 *     palette. No user is broken.
 *   - a hostile or garbled value cannot exceed the length limit or the
 *     character class, so downstream code (rendering `data-av-theme`, CSS
 *     selectors keyed on it) never has to worry about markup, quotes, or
 *     runaway strings.
 *
 * ASCII kebab-case, 1..64 characters. Enforcement is a boundary responsibility
 * — the Host only builds theme ids from its own set (so the check is trivially
 * met upstream), and the View's defensive reader (`readAppearance` in
 * `client.ts`) applies the same rule as a belt-and-braces guard against a
 * malformed Host.
 */
export const APPEARANCE_THEME_ID_MAX_LEN = 64;
export const APPEARANCE_THEME_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The whole vocabulary of an `appearance` payload today.
 *
 * v1 carries the outer shell's theme choice and optional mobile control font
 * compensation. Other additive fields (colour scheme, density) are absent: there is
 * no separate outer-shell state for them today, so shipping empty slots for
 * them would be describing future behaviour rather than current behaviour, and
 * a View that read them would learn the wrong lesson about what the Host had
 * actually decided. Future extensions add fields; the reader defaults them.
 *
 * `theme` is a bounded `string`, not a closed union — see
 * `APPEARANCE_THEME_ID_PATTERN` for the wire-level bounds and the note there
 * for why the wire deliberately does not enumerate the shell's THEMES set.
 * The View decides for itself which theme ids it can render; unknown values
 * fold to `classic`.
 */
export interface AppearanceSpec {
  contract: typeof APPEARANCE_CONTRACT;
  theme: string;
  /** Host-measured CSS pixels needed for a 16px readable mobile control after
   * page zoom. Finite 16..64; absent/invalid means the legacy 16px floor.
   * Presentation only: no screen dimensions, identity or authority cross. */
  controlFontSize?: number;
}

/** @deprecated Loading an Agent View no longer has a deadline. */
export const READY_TIMEOUT_MS = 8000;
/** Rolling window for the per-port rate fuse. */
export const PORT_WINDOW_MS = 10_000;
/** Messages allowed inside one window before the channel is fused. */
export const PORT_WINDOW_MESSAGES = 100;
/**
 * The one proposal the fuse admits without counting, and only on credit.
 *
 * A `resource-stream/v1` pull is self-clocked by the trusted side: one pull per
 * stream may be in flight, and a stream's length is the resource's length, not
 * the View's choice. Counting pulls against `PORT_WINDOW_MESSAGES` would cap a
 * stream at 100 chunks per 10 s and then CLOSE the channel mid-read, which is a
 * bound on the total size of what a View can open, not on its rate of asking.
 *
 * So the trusted host grants a credit when it answers a pull with a `chunk`
 * frame, and the next pull naming that handle spends it instead of a fuse slot.
 * A first pull, a pull for an unknown or ended handle, and a pull after a
 * refusal are all counted: uncounted traffic can never exceed what the trusted
 * side has already delivered. The verb is restated rather than imported, like
 * `PORT_MESSAGE_BYTES`; `typed-port-kit`'s wire test pins the pair.
 */
export const PORT_STREAM_PULL_ACTION = "resource.stream_pull";
/**
 * Hard ceiling on one proposal's serialised size.
 *
 * 512 KiB since the editor batch (2026-08-07), raised from 64 KiB so that ONE
 * declared parameter can carry a whole text file — `workspace-files/v1`'s
 * `replace_text` is a whole-file compare-and-swap, and a staged upload would
 * have been a second protocol with its own resumption and expiry story for a
 * value that is bounded at 256 KiB anyway.
 *
 * What did NOT change is the thing that actually bounds work: `PORT_WINDOW_MESSAGES`
 * per `PORT_WINDOW_MS`. A fused channel is still 100 messages per 10 seconds, so
 * this raises the size of one message rather than the traffic a view can
 * generate. It is a fuse parameter, not a protocol change: `SESSION_PLUS_PROTOCOL`
 * does not move, and neither half learns a new message kind.
 *
 * The trusted dispatcher's per-parameter bound is the narrower one and is
 * enforced separately (`WIRE_PARAM_LIMITS` in `@claude-bot/typed-port-kit`,
 * ceiling 384 KiB); this number only has to be large enough that a proposal
 * built inside that bound is deliverable.
 */
export const PORT_MESSAGE_BYTES = 512 * 1024;

/**
 * The wake channel's own two budgets (ADR 0006 §5).
 *
 * They sit beside the fuse constants because they must be READ together: a
 * wake costs nothing on the host→view direction (outbound frames are not
 * counted by the fuse), but every wake invites the View to spend one `propose`
 * — and `propose` IS counted, by a fuse that does not refuse but CLOSES the
 * channel. So the wake budget has to be far below `PORT_WINDOW_MESSAGES`, with
 * room left for the person's own clicks on the same channel. The numbers may
 * move; "wake budget ≪ fuse budget" may not, and a test pins the inequality.
 *
 * Debounce is trusted-side (per instance, binding and ref): N changes inside
 * one window collapse to one wake, and a wake over the per-window ceiling is
 * DROPPED — safe, because a wake carries nothing and the next one means
 * exactly the same thing.
 */
export const WAKE_DEBOUNCE_MS = 1000;
/** Wakes one instance may receive per rolling `PORT_WINDOW_MS`. */
export const WAKE_WINDOW_MESSAGES = 10;
