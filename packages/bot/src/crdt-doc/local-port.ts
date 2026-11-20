/**
 * `crdt-doc/v1` over an in-process dispatcher.
 *
 * ── Why this file exists at all ────────────────────────────────────────────
 *
 * Every other typed port in this repository gets its client half for free:
 * `createRemoteCall(declaration, transport)` builds one that runs the kit's
 * seven arrival checks. `crdt-doc/v1` cannot use it — `createRemoteCall`
 * REFUSES to construct for a declaration with non-empty `wireProblems`, and two
 * of this contract's three actions have them (see the contract package's
 * `wire.test.ts`).
 *
 * So this is the cost of the wall, made concrete: losing the remote adapter also
 * loses the checked call path, and it has to be written by hand. It is written
 * out of the kit's own pieces (`readProposalAnswer`, `echoMatches`,
 * `portLifecycle`) rather than freehand, so the parts that ARE reusable stay
 * reused and a reviewer can see exactly which one is missing.
 *
 * Checks 5 (corroboration) and 6 (measured bytes) do not apply: this contract
 * opens no stream and its answers have no second half. Check 3 (the payload goes
 * through the contract's own reader) is the one that matters most here, and it
 * is not weakened by the dispatcher being in-process — an in-process provider is
 * still a different release's worth of code from the consumer.
 *
 * ── Where it may be used ───────────────────────────────────────────────────
 *
 * Trusted callers only: a conformance harness, a vertical test, and — when a
 * deployment grows one — an MCP bridge, which decision 5 puts inside the trusted
 * process precisely because the View wire's bounds do not apply there. It is NOT
 * a way to give an Agent View a port; there is no transport under this one.
 */

import {
  CRDT_DOC_CONTRACT,
  CRDT_DOC_REFUSALS,
  crdtRefusal,
  readCrdtDocAck,
  readCrdtDocDelta,
  readCrdtDocList,
  readCrdtDocSnapshot,
  type CrdtDocAck,
  type CrdtDocDelta,
  type CrdtDocList,
  type CrdtDocPort,
  type CrdtDocReply,
  type CrdtDocSnapshot,
} from "@claude-bot/crdt-doc-contract";
import {
  echoMatches,
  portLifecycle,
  readProposalAnswer,
  wireActionOf,
  type ContractResult,
} from "@claude-bot/typed-port-kit";

/**
 * How this adapter reaches the trusted dispatcher.
 *
 * Typed as `unknown` on the way back on purpose: the catalog answers a
 * `ResourceAnswer`, whose accepted branch has NO `message` field, while the
 * arrival checks want the `ProposalAnswer` envelope both halves of a typed port
 * agree on. On the browser path the shell fills that gap in
 * (`frame-host.ts`'s `answer()`); `normalizeAnswer` below does the same one
 * thing, so the checks see the same envelope on both paths rather than one
 * being quietly weaker.
 */
export type LocalDispatch = (proposal: {
  action: string;
  params: Readonly<Record<string, string>>;
}) => Promise<unknown>;

export interface LocalCrdtPort {
  readonly port: CrdtDocPort;
  /** Refuse everything afterwards. Idempotent. */
  destroy(): void;
}

const MESSAGES = {
  noAnswer: "协作文档通道没有作答。",
  malformedAnswer: "协作文档通道给出了无法识别的回复。",
  refusedWithoutReason: "这次协作文档请求没有完成。",
  closed: "这个视图的会话已经结束，请重新打开。",
  malformed: "协作文档回复没有通过公开契约校验。",
  wrongDoc: "收到的回复不是所请求的那份文档的。",
};

/**
 * Present an in-process dispatcher as `crdt-doc/v1`.
 *
 * `binding` is the App-local name from its `agent-resource-bindings/v1` plan. It
 * selects among what the plan already declared; it is not authority, and the
 * dispatcher resolves it against its own copy of that document.
 */
export function createLocalCrdtPort(dispatch: LocalDispatch, binding: string): LocalCrdtPort {
  const life = portLifecycle(() => crdtRefusal("scope_closed", MESSAGES.closed));

  async function call<T>(
    action: string,
    params: Record<string, string>,
    /** The requested doc to echo-check, or null for the one action with none. */
    doc: string | null,
    read: (value: unknown) => ContractResult<T>,
  ): Promise<CrdtDocReply<T>> {
    return life.guard(async () => {
      let raw: unknown;
      try {
        raw = await dispatch({ action: wireActionOf(action), params: { ...params, binding } });
      } catch {
        // A dispatcher that throws is a broken trusted side, and its message is
        // the field that reliably carries a filesystem path across.
        return crdtRefusal("unavailable", MESSAGES.noAnswer);
      }

      // Check 1: is this an answer?
      const answer = readProposalAnswer(normalizeAnswer(raw));
      if (!answer) return crdtRefusal("unavailable", MESSAGES.malformedAnswer);

      // Check 2: an unrecognised code folds into the closed set rather than
      // being rendered as if this build understood it.
      if (!answer.ok) return CRDT_DOC_REFUSALS.fold(answer.code, answer.message, MESSAGES.refusedWithoutReason);

      // Check 3: the payload goes through the contract's own reader.
      const value = read(answer.result);
      if (!value.ok) return crdtRefusal("unavailable", MESSAGES.malformed);

      // Check 4: the answer is the answer to the question asked. A snapshot of
      // ANOTHER document passes the reader perfectly; only comparing against
      // what was requested finds it, and a consumer that keys panels by ref
      // would otherwise mount the wrong document's text under the right label.
      // `list_docs` names no document, so there is nothing to compare.
      if (doc !== null && !echoMatches(answer.result, "doc", doc)) {
        return crdtRefusal("unavailable", MESSAGES.wrongDoc);
      }

      return { ok: true, value: value.value };
    });
  }

  const port: CrdtDocPort = {
    contract: CRDT_DOC_CONTRACT,
    listDocs: (): Promise<CrdtDocReply<CrdtDocList>> =>
      call("list_docs", {}, null, readCrdtDocList),
    openDoc: (doc: string): Promise<CrdtDocReply<CrdtDocSnapshot>> =>
      call("open_doc", { doc }, doc, readCrdtDocSnapshot),
    applyUpdate: (doc: string, update: string): Promise<CrdtDocReply<CrdtDocAck>> =>
      call("apply_update", { doc, update }, doc, readCrdtDocAck),
    readUpdates: (doc: string, since: string): Promise<CrdtDocReply<CrdtDocDelta>> =>
      call("read_updates", { doc, since }, doc, readCrdtDocDelta),
  };

  return { port, destroy: () => life.destroy() };
}

/**
 * Give an accepted `ResourceAnswer` the empty `message` the envelope requires.
 *
 * Only that: a non-object stays a non-object so check 1 still catches it, and an
 * existing `message` is never replaced — a refusal's text is the far side's
 * words and rewriting it here would be this adapter putting words in its mouth.
 */
function normalizeAnswer(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const row = raw as Record<string, unknown>;
  return typeof row.message === "string" ? row : { ...row, message: "" };
}
