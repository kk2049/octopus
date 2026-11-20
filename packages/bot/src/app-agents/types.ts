/**
 * What the agent plane needs from an App, and nothing more.
 *
 * ── Why this is an interface and not `SessionPlusAppService` ────────────────
 *
 * The plane runs turns; it does not know what an App is. Session Plus is the
 * only App today, and the convergence plan's P2/P3 replace the single hard-wired
 * adapter with a catalog — so the seam is written now, while there is exactly
 * one implementation to check it against. The concrete adapter lives beside the
 * App (`session-plus/agent-backend.ts`), which is the direction the dependency
 * has to point: the platform must not import the App.
 *
 * Note what is absent. There is no way for the plane to enumerate accounts, no
 * way to name a device, a workspace, a Context or a grant, and no way to reach
 * a capability. A turn gets an opaque handle whose `dispatch` is the same door
 * a human's button goes through, and everything authority-shaped was bound to
 * that handle by trusted code before the model was ever asked a question.
 */

/** One agent, as a release declares it. Structurally the manifest's row. */
export interface AppAgentDeclaration {
  name: string;
  adapter: string;
  prompt: string;
  model?: string;
  effort?: string;
  /** `"HH:MM"` local, or absent. */
  daily?: string;
  dailyPrompt?: string;
  /** Shared-scope agent role, bound by trusted release metadata. */
  role?: string;
}

/** One durable agent lane. Shared lanes retain the sponsoring member. */
export type AppAgentScope =
  | { kind: "account"; owner: string }
  | { kind: "shared"; owner: string; instanceKey: string };

/** One action, as a tool. Derived from the SAME declaration a button reads. */
export interface AppAgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type AppAgentDispatch =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

/**
 * One turn's App instance.
 *
 * Created before the model is asked anything and closed when the turn ends —
 * so a revocation that lands between two turns is honoured by the next one,
 * which opens a new instance rather than inheriting a long-lived handle. That
 * is exactly the provider catalog's "a closed instance never reopens" rule, met
 * by construction instead of by remembering.
 */
export interface AppAgentTurnHandle {
  /** The projection this instance opened with. Read-only context for a prompt. */
  readonly projection: unknown;
  /** Aborts when the App, release, shared instance or sponsoring member ends. */
  readonly signal: AbortSignal;
  dispatch(action: string, params: Record<string, unknown>): Promise<AppAgentDispatch>;
  close(): Promise<void>;
}

export interface AppAgentInboxMessage {
  seq: number;
  text: string;
  from: string;
  at: string;
}

export interface AppAgentBackend {
  /** Stable app id. Compared and used as a storage key; never resolved. */
  readonly appId: string;
  /**
   * The agents the ACTIVE release declares. Empty when the App has no servable
   * release, or when its release declares none — both mean "no turns".
   */
  agents(): readonly AppAgentDeclaration[];
  /** The tools this agent role may call, in declaration order. */
  tools(scope: AppAgentScope, agent: string): readonly AppAgentTool[];
  /** Stable bot.db key for one account or shared member lane. */
  scopeKey(scope: AppAgentScope): string;
  /** Inverse of `scopeKey`; invalid/obsolete rows fail closed. */
  scopeFromKey(scopeKey: string): AppAgentScope | null;
  /** Queue one message durably. `dispatchId` makes a repeat a no-op. */
  appendInbox(input: {
    scope: AppAgentScope;
    agent: string;
    text: string;
    from: string;
    dispatchId?: string;
  }): Promise<{ ok: true; revision: number; duplicate: boolean } | { ok: false; message: string }>;
  /** Everything queued after `cursor`, plus the stream head. */
  readInbox(scope: AppAgentScope, agent: string, cursor: number): Promise<{
    head: number;
    messages: AppAgentInboxMessage[];
  }>;
  openTurn(input: { scope: AppAgentScope; agent: string; turnId: string }): Promise<AppAgentTurnHandle>;
}
