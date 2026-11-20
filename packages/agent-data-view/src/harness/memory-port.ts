/**
 * A second real implementation of `app-data/v1`, backed by a fixture.
 *
 * It exists for the same reason the sessions and workspace-files harnesses do: a
 * claim that these modules depend on a PORT and not on a transport is only
 * checkable if there is a second thing that satisfies the port. This one has no
 * network, no message channel and no trusted side at all — it answers out of an
 * object graph.
 *
 * ── Why it is a harness entry rather than a test helper ─────────────────────
 *
 * Because tests are not the only consumer that needs it: `app:preview` renders a
 * draft composition against exactly this, which is what makes a second-long
 * feedback loop possible without a Host, an approval or a release. It is
 * exported from `./harness` rather than from the package root so a production
 * bundle cannot pick it up by reaching for the obvious import.
 */

import {
  APP_DATA_CONTRACT,
  READ_ONLY_REFUSAL,
  type AppDataPort,
  type AppDataProposal,
  type AppDataReply,
  type AppDataSnapshot,
  type AppProjection,
} from "../port.js";

export interface MemoryAppDataFixture {
  projection: AppProjection | null;
  /**
   * What each action answers. An action with no entry is refused as unknown —
   * a preview that silently accepted every proposal would be teaching an App
   * author that their composition works.
   */
  actions?: Readonly<
    Record<
      string,
      AppDataReply | ((values: Readonly<Record<string, string>>) => AppDataReply | Promise<AppDataReply>)
    >
  >;
  /** Refuse every submission, whatever `actions` says. The read-only shape. */
  readOnly?: boolean;
}

export interface MemoryAppDataPort {
  port: AppDataPort;
  /** Every submission this port has served, for asserting what a form sent. */
  readonly submissions: ReadonlyArray<{ action: string; values: Record<string, string> }>;
  /** Replace the projection and notify subscribers, as a Host update would. */
  setProjection(projection: AppProjection | null): void;
  /** Set the bounded refusal text, as the App provider's notice would. */
  setRefusal(text: string): void;
}

export function createMemoryAppDataPort(fixture: MemoryAppDataFixture): MemoryAppDataPort {
  const submissions: Array<{ action: string; values: Record<string, string> }> = [];
  const listeners = new Set<() => void>();
  let projection = fixture.projection;
  let refusal = "";
  let proposals: readonly AppDataProposal[] = [];
  let nextRid = 0;
  // Identity-stable while nothing changed: `useSyncExternalStore` compares
  // snapshots by identity, and a new object per call would re-render the whole
  // workspace on every tick — the exact bug this memoisation exists to prevent
  // in the real adapter too.
  let snapshot: AppDataSnapshot = { phase: "open", projection, refusal, proposals };

  const publish = (): void => {
    snapshot = { phase: "open", projection, refusal, proposals };
    for (const listener of [...listeners]) listener();
  };

  const port: AppDataPort = {
    contract: APP_DATA_CONTRACT,
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearRefusal() {
      if (!refusal) return;
      refusal = "";
      publish();
    },
    async submit(action, values) {
      submissions.push({ action, values: { ...values } });
      // The same lifecycle the real transport keeps: visible while in flight,
      // gone on acceptance, retained with the sentence on refusal — so a
      // preview shows exactly the pending/revert behaviour a Host would.
      const rid = `m${++nextRid}`;
      proposals = [...proposals, { rid, action, params: Object.freeze({ ...values }), phase: "inflight", message: "" }];
      publish();
      const answer = await (fixture.readOnly
        ? READ_ONLY_REFUSAL
        : fixture.actions && Object.prototype.hasOwnProperty.call(fixture.actions, action)
          ? (() => {
            const entry = fixture.actions![action];
            return typeof entry === "function" ? entry({ ...values }) : entry;
          })()
          : { ok: false as const, code: "unknown_action", message: `这个 App 没有声明动作 ${action}。` });
      proposals = answer.ok
        ? proposals.filter((p) => p.rid !== rid)
        : proposals.map((p) => (p.rid === rid ? { ...p, phase: "refused" as const, code: answer.code, message: answer.message } : p));
      publish();
      return answer;
    },
    dismissProposal(rid) {
      const entry = proposals.find((p) => p.rid === rid);
      if (!entry || entry.phase !== "refused") return;
      proposals = proposals.filter((p) => p.rid !== rid);
      publish();
    },
  };

  return {
    port,
    submissions,
    setProjection(next) {
      projection = next;
      publish();
    },
    setRefusal(text) {
      refusal = text;
      publish();
    },
  };
}
