/**
 * `app-data/v1` — an App's OWN projection and action surface, as a typed port.
 *
 * ── Why this is a port and not a hook ───────────────────────────────────────
 *
 * `useProjection()` and `usePropose()` live on `@claude-bot/agent-view-react`'s
 * ROOT entry, which also re-exports the transport and the wire vocabulary. A
 * reusable View module may not import that entry — the narrow `./ui` and
 * `./workspace` entries are what make "a module does not know what is on the
 * other end" a type error rather than a habit. So the modules here take a port,
 * exactly as the sessions and workspace-files modules do, and the App (or the
 * standard shell) adapts its one channel onto it in `createAppDataPort`.
 *
 * ── Why it is NOT an `agent-resource-bindings/v1` binding ───────────────────
 *
 * That document declares typed ports a DEPLOYMENT must provide from its trusted
 * provider catalog — a workspace, a mailbox, a device. An App's own projection
 * is not one of those: it arrives over the single channel every Agent View
 * already has, produced by the App's own backend. Declaring it as a binding
 * would ask a deployment to install a provider for something no provider serves,
 * and `linkResourceBindings` would then be enforcing a wire that cannot exist.
 * The manifests therefore declare `ports: ["app-data/v1"]` — the module's honest
 * dependency — while no App is expected to declare a binding for that contract,
 * which is precisely the case the linker skips.
 *
 * ── What is absent ─────────────────────────────────────────────────────────
 *
 * No owner, username, app or scope id, instance handle, grant, capability,
 * context id, cookie or URL. Not filtered — ABSENT. `submit()` takes an action
 * id, and that id is never a constant in this package: it comes from the
 * composition's instance config, which is data an App author wrote and a
 * reviewer read. What the Host does with it is the Host's decision.
 */

export const APP_DATA_CONTRACT = "app-data/v1";

/** Whether there is a channel at all. Never an error state — a refusal is data. */
export type AppDataPhase = "waiting" | "open" | "closed";

/** Anything the App's backend chose to project. Opaque to this package. */
export type AppProjection = Record<string, unknown>;

/**
 * One proposal's lifecycle as a module can see it (structurally identical to
 * the SDK's `PendingProposal`, declared here because this package must not
 * import the transport). `inflight` entries let a module paint a pending
 * overlay the moment the user acts; `refused` entries carry the Host's bounded
 * sentence until the module dismisses them. The projection itself remains
 * authoritative and is never merged locally — the ledger is a render input
 * layered on top.
 */
export interface AppDataProposal {
  rid: string;
  action: string;
  params: Readonly<Record<string, string>>;
  phase: "inflight" | "refused";
  code?: string;
  /** Bounded refusal text when refused; "" while in flight. */
  message: string;
}

export interface AppDataSnapshot {
  phase: AppDataPhase;
  /** Replaced wholesale on every update, never merged locally. */
  projection: AppProjection | null;
  /** The last bounded refusal, for showing a person. "" when there is none. */
  refusal: string;
  /**
   * The action-lifecycle ledger, oldest first. Empty on channels that predate
   * it — a module treats "no ledger entries" and "no ledger" identically.
   */
  proposals: readonly AppDataProposal[];
}

export interface AppDataReply {
  ok: boolean;
  code?: string;
  result?: unknown;
  /** Bounded refusal text, or "" when accepted. */
  message: string;
}

export interface AppDataPort {
  readonly contract: typeof APP_DATA_CONTRACT;
  snapshot(): AppDataSnapshot;
  /** Subscribe to snapshot changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Clear the last refusal — e.g. because the reader started something new. */
  clearRefusal(): void;
  /**
   * Propose one of the App's own actions.
   *
   * Resolves with the Host's bounded answer; it never rejects, because "the
   * trusted side said no" is an answer and not an exception.
   */
  submit(action: string, values: Readonly<Record<string, string>>): Promise<AppDataReply>;
  /**
   * Drop one refused entry from the proposal ledger after showing it (e.g.
   * once the revert animation played). In-flight entries cannot be dismissed.
   */
  dismissProposal(rid: string): void;
}

/**
 * The transport-shaped bounds a generic form has to respect.
 *
 * The key count mirrors the resource-proposal discipline on the Session Plus
 * wire (eight short keys); the value bound matches the widest parameter an
 * `app.yaml` action door accepts today (4096 — a report body), and stays three
 * orders of magnitude under the 512 KiB port frame. This package does not know
 * which wire carries it, and a form that quietly produced a frame the transport
 * drops would look like the Host refusing for no reason. The App's own action
 * declaration is still the real authority — this is the point at which the View
 * stops before finding out.
 */
export const APP_DATA_LIMITS = Object.freeze({
  maxFields: 8,
  /** Actions one compact launcher may expose. */
  maxActions: 12,
  maxValueLength: 4096,
  /**
   * Largest page one list instance reveals at a time (its `limit` is clamped to
   * this). A page bounds one render step, not the collection: "显示更多"
   * reveals the next page until every row is shown.
   */
  maxRows: 500,
  /** Facts one detail instance will render. */
  maxFacts: 32,
  /** Markdown sections one detail instance will render. */
  maxSections: 8,
  /** Thread entries one detail instance reveals per page; more on request. */
  maxThreadEntries: 200,
});

/**
 * A port that can only read.
 *
 * Not a different interface — the same one, with `submit` refusing. A read-only
 * consumer therefore reuses the modules unchanged, and the modules discover the
 * limit the way they discover every other limit: a bounded refusal.
 */
export const READ_ONLY_REFUSAL: AppDataReply = Object.freeze({
  ok: false,
  code: "read_only",
  result: null,
  message: "这个视图是只读的：它没有被授予任何可提交的动作。",
});

/**
 * The channel shape `createAppDataPort` adapts.
 *
 * Declared structurally rather than imported, because importing
 * `@claude-bot/agent-view-react` would put this package downstream of the
 * transport it is not allowed to know about. An `AgentViewContextValue` from
 * the SDK satisfies it as written; so does anything else with the same three
 * members, which is what makes a preview harness possible without a MessagePort.
 */
export interface AppDataChannel {
  client: {
    snapshot(): { phase: AppDataPhase; projection: AppProjection | null; proposals?: readonly AppDataProposal[] };
    subscribe(listener: () => void): () => void;
    /** Optional: a channel that predates the ledger simply lacks it. */
    dismissProposal?(rid: string): void;
  };
  /**
   * The PROVIDER's proposal function, not the raw client's, when the two
   * differ: the provider's records the Host's bounded refusal and clears it on
   * the next attempt, and dropping that sentence is dropping the only thing
   * written for the reader.
   */
  propose(
    action: string,
    params?: Record<string, string>,
  ): Promise<{ ok: boolean; code?: string; result?: unknown; message: string }>;
  refusal: { readonly text: string; clear(): void };
}

/**
 * Present an App channel as an `app-data/v1` port.
 *
 * The snapshot is derived rather than stored — the client already publishes a
 * fresh object per change — but it is memoised on the pair it was derived from,
 * because `useSyncExternalStore` compares by identity and a new object per call
 * would re-render the workspace on every tick.
 */
const NO_PROPOSALS: readonly AppDataProposal[] = Object.freeze([]);

export function createAppDataPort(channel: AppDataChannel): AppDataPort {
  let cachedSource: { phase: AppDataPhase; projection: AppProjection | null } | null = null;
  let cachedRefusal = "";
  let cached: AppDataSnapshot | null = null;

  return {
    contract: APP_DATA_CONTRACT,
    snapshot() {
      const source = channel.client.snapshot();
      const refusal = channel.refusal.text;
      if (!cached || source !== cachedSource || refusal !== cachedRefusal) {
        cachedSource = source;
        cachedRefusal = refusal;
        cached = { phase: source.phase, projection: source.projection, refusal, proposals: source.proposals ?? NO_PROPOSALS };
      }
      return cached;
    },
    subscribe: (listener) => channel.client.subscribe(listener),
    clearRefusal: () => channel.refusal.clear(),
    submit: (action, values) =>
      channel.propose(action, { ...values }).then((answer) => ({
        ok: answer.ok,
        code: answer.code,
        result: answer.result,
        message: answer.message,
      })),
    dismissProposal: (rid) => channel.client.dismissProposal?.(rid),
  };
}
