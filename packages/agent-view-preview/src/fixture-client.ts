/**
 * An `AgentViewClient` with no channel behind it.
 *
 * ── Why this exists, and why it is a separate entry ─────────────────────────
 *
 * A draft composition is worth looking at long before there is a Host to serve
 * it: the questions an author has at that point — does the rail hold three
 * modules, does the detail panel open where I said, does this config actually
 * reach the component — are all answerable with a fixture, and none of them is
 * worth a pack, an install, an activation and a re-consent to answer.
 *
 * `AgentViewProvider` already takes a caller-supplied client, so no production
 * code has to learn about previews. This is that client: a projection it
 * publishes, a table of canned answers, and a record of what was proposed.
 *
 * It lives in `@claude-bot/agent-view-preview` rather than in the SDK so a
 * released bundle cannot pick it up by reaching for the obvious import. A View
 * that shipped with this compiled in would answer its own proposals.
 *
 * ── What it deliberately does NOT simulate ─────────────────────────────────
 *
 * Approval, capability, identity, refusal-after-revocation, the port handshake,
 * the size and rate fuses. A preview that pretended to model those would teach
 * an author that their App is authorised — which is a claim only the real Host
 * can make, and the one thing this must never appear to say.
 */

import { APPEARANCE_CONTRACT, type AppearanceSpec } from "@claude-bot/web-trust/frame-protocol";
import type {
  AgentViewClient,
  AgentViewOperation,
  AgentViewSnapshot,
  PendingProposal,
  ProposalReply,
  Projection,
} from "@claude-bot/agent-view-react";

export interface FixtureAnswer {
  ok?: boolean;
  code?: string;
  result?: unknown;
  message?: string;
}

export interface FixtureClientOptions {
  /** The first boot frame. `null` previews the pre-boot state. */
  projection?: Projection | null;
  operations?: readonly AgentViewOperation[];
  /**
   * The initial appearance snapshot exposes (ticket #45). Defaults to
   * `classic`, which matches an old Host that predates the appearance
   * channel — the preview stays reachable through the pre-theme rendering
   * unless the author explicitly opts into a different theme.
   */
  appearance?: AppearanceSpec;
  /**
   * What each action answers, by action id. An action with no entry is refused
   * as unknown — a preview that accepted every proposal would be teaching an
   * author that their composition works.
   */
  actions?: Readonly<Record<string, FixtureAnswer | ((params: Record<string, string>) => FixtureAnswer)>>;
}

export interface FixtureAgentViewClient {
  client: AgentViewClient;
  /** Every proposal this client has served. */
  readonly proposals: ReadonlyArray<{ action: string; params: Record<string, string> }>;
  /** Replace the projection and notify subscribers, as a Host update would. */
  setProjection(projection: Projection | null): void;
  setOperations(operations: readonly AgentViewOperation[]): void;
  /**
   * Replace the appearance and notify subscribers, as a Host MSG.appearance
   * would (ticket #45). Available for a preview that wants to demonstrate a
   * theme switch; the preview itself does not model the wire, so unlike the
   * real reader this does NOT fold unknown values to classic — the author
   * gets exactly what they asked for, and misusing it fails visibly rather
   * than misleading them about production behaviour.
   */
  setAppearance(appearance: AppearanceSpec): void;
  /** Bump one ref's wake token, as a Host MSG.wake frame would (ADR 0006). */
  emitWake(ref: string): void;
}

const DEFAULT_APPEARANCE: AppearanceSpec = { contract: APPEARANCE_CONTRACT, theme: "classic" };

export function createFixtureAgentViewClient(options: FixtureClientOptions = {}): FixtureAgentViewClient {
  const proposals: Array<{ action: string; params: Record<string, string> }> = [];
  const listeners = new Set<(snapshot: AgentViewSnapshot) => void>();
  const draftValues = new Map<string, { text: string; updatedAt: number }>();
  const draftListeners = new Map<string, Set<(value: { text: string; updatedAt: number }) => void>>();
  let destroyed = false;
  // The same lifecycle the real transport keeps, so a preview demonstrates
  // pending/refused rendering exactly as a Host would produce it.
  let ledger: readonly PendingProposal[] = [];
  let nextRid = 0;
  let snapshot: AgentViewSnapshot = {
    phase: "open",
    projection: options.projection ?? null,
    operations: [...(options.operations ?? [])],
    inFlight: 0,
    appearance: options.appearance ?? DEFAULT_APPEARANCE,
    recovery: null,
    wakes: {},
    proposals: ledger,
  };

  const publish = (next: Partial<AgentViewSnapshot>): void => {
    snapshot = { ...snapshot, ...next, proposals: ledger };
    for (const listener of [...listeners]) listener(snapshot);
  };

  const client: AgentViewClient = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportPerformance() {
      // Preview owns no MessagePort and never impersonates a Host. Keep the
      // production client's quiet "diagnostic unavailable" result.
      return false;
    },
    async propose(action, params) {
      const values = { ...(params ?? {}) };
      proposals.push({ action, params: values });
      if (destroyed) {
        return { ok: false, code: "closed", message: "预览通道已关闭。" };
      }
      const rid = `f${++nextRid}`;
      ledger = [...ledger, { rid, action, params: Object.freeze({ ...values }), phase: "inflight", message: "" }];
      publish({});
      const table = options.actions;
      const answer = table && Object.prototype.hasOwnProperty.call(table, action) ? table[action] : undefined;
      const resolved = answer === undefined
        ? { ok: false, code: "unknown_action", message: `预览里没有为 ${action} 声明答案。` }
        : typeof answer === "function" ? answer(values) : answer;
      const reply: ProposalReply = {
        ok: resolved.ok !== false,
        code: resolved.code,
        result: resolved.result,
        message: resolved.message ?? "",
      };
      ledger = reply.ok
        ? ledger.filter((p) => p.rid !== rid)
        : ledger.map((p) => (p.rid === rid ? { ...p, phase: "refused" as const, code: reply.code, message: reply.message } : p));
      publish({});
      return reply;
    },
    dismissProposal(rid) {
      const entry = ledger.find((p) => p.rid === rid);
      if (!entry || entry.phase !== "refused") return;
      ledger = ledger.filter((p) => p.rid !== rid);
      publish({});
    },
    drafts: {
      get: (key) => draftValues.get(key) ?? { text: "", updatedAt: 0 },
      set: (key, text) => {
        const previous = draftValues.get(key) ?? { text: "", updatedAt: 0 };
        const value = { text, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) };
        draftValues.set(key, value);
        for (const listener of draftListeners.get(key) ?? []) listener(value);
      },
      subscribe: (key, listener) => {
        const set = draftListeners.get(key) ?? new Set();
        set.add(listener);
        draftListeners.set(key, set);
        return () => { set.delete(listener); };
      },
    },
    publishRecovery() {
      return !destroyed;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ledger = [];
      publish({ phase: "closed" });
      listeners.clear();
      draftListeners.clear();
      draftValues.clear();
    },
  };

  return {
    client,
    proposals,
    setProjection: (projection) => publish({ projection }),
    setOperations: (operations) => publish({ operations: [...operations] }),
    setAppearance: (appearance) => publish({ appearance }),
    emitWake: (ref) => publish({ wakes: { ...snapshot.wakes, [ref]: (snapshot.wakes[ref] ?? 0) + 1 } }),
  };
}
