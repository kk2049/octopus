/**
 * `crdt-doc/v1` over the App's one MessagePort.
 *
 * ── Why this file did not exist until now ──────────────────────────────────
 *
 * P6c shipped this package deliberately WITHOUT a remote adapter, and said so
 * in `index.ts`: two of the three actions declare parameters that the View
 * proposal wire's flat 512-character bound could not carry, so
 * `createRemoteCall` refused to construct a port and shipping one anyway would
 * have meant declaring a bound the contract cannot honour. `wire.test.ts` was
 * written as a tripwire for the day per-action bounds landed — "the test fails
 * and tells whoever is holding it that an adapter is now possible".
 *
 * That day was P6b. A contract may now declare ONE parameter of an action up to
 * `WIRE_PARAM_LIMITS.maxDeclaredValueLength` (384 KiB), and the per-message
 * ceiling was raised to hold it. `apply_update` has one big parameter
 * (`update`) beside one small one (`doc`); `read_updates` has one big one
 * (`since`) beside the same small one. Both fit the rule, so
 * `CRDT_DOC_DECLARATION.wireProblems` is empty for all three actions and this
 * file is the thing that was blocked on it.
 *
 * ── The echo rule is load-bearing here, more than anywhere else ────────────
 *
 * Every reply in this contract carries a state vector, and a state vector for
 * the WRONG document passes `readCrdtDocSnapshot`/`Ack`/`Delta` perfectly — it
 * is a completely valid answer about somewhere else. A reader cannot catch
 * that. What makes it worse than notify's version of the same bug is what the
 * consumer does next: it feeds the returned update into a local `Y.Doc` and
 * pushes its own diff back. Merging another document's history into this one is
 * not a wrong label on a screen, it is a durable corruption of both replicas
 * that no origin trail in this version could untangle afterwards. So `doc` is
 * compared against what was asked on every single method.
 *
 * ── No streams, no subscribe ───────────────────────────────────────────────
 *
 * The kit's stream half is opt-in and this contract opens none: three actions,
 * three complete answers. The absence of a fourth "tell me when it changes"
 * method is not an oversight either — see `port.ts`. A View has
 * `connect-src 'none'` and one MessagePort whose only verb is `propose`, so
 * server push has no spelling on this side. ADR 0006 decides the shape that
 * would work (the trusted parent forwards a CONTENT-FREE wake-up and the View
 * issues its own read, which still passes the Gate); when that lands it changes
 * `client.ts`, not this file.
 */

import {
  createRemoteCall,
  type ProposalTransport,
  type RemoteMessages,
} from "@claude-bot/typed-port-kit";

import { CRDT_DOC_CONTRACT, CRDT_DOC_DECLARATION } from "./contract.js";
import {
  readCrdtDocAck,
  readCrdtDocDelta,
  readCrdtDocList,
  readCrdtDocSnapshot,
  type CrdtDocAck,
  type CrdtDocDelta,
  type CrdtDocList,
  type CrdtDocSnapshot,
} from "./projection.js";
import type { CrdtDocPort, CrdtDocReply } from "./port.js";

/**
 * What this port says when something goes wrong below its own vocabulary — in
 * the product's language, because a person reads them in a panel.
 */
const MESSAGES: RemoteMessages = {
  noAnswer: "协作文档通道没有作答。",
  malformedAnswer: "协作文档通道给出了无法识别的回复。",
  refusedWithoutReason: "这次协作文档操作没有完成。",
  closed: "这个视图的会话已经结束，请重新打开。",
};

const MALFORMED_SNAPSHOT = "文档快照没有通过公开契约校验。";
const MALFORMED_ACK = "合并回执没有通过公开契约校验。";
const MALFORMED_DELTA = "增量没有通过公开契约校验。";
const MALFORMED_LIST = "文档列表没有通过公开契约校验。";

/**
 * The one echo rule, shared by all three methods: the answer must be about the
 * document that was asked for. See the header for why this one is not cosmetic.
 */
const WRONG_DOC = "收到的回复不是所请求的那份文档的。";
const ECHO_DOC = [{ field: "doc", param: "doc", message: WRONG_DOC }] as const;

/**
 * A port and the handle that ends it.
 *
 * `destroy()` belongs to the App, not to a module: composition owns the
 * transport, and a module that could end its own would be a module that could
 * end a sibling's.
 */
export interface RemoteCrdtDoc {
  readonly port: CrdtDocPort;
  /** Refuse everything afterwards. Idempotent. */
  destroy(): void;
}

/**
 * Present a proposal transport as `crdt-doc/v1`.
 *
 * `binding` is the App-local name from its `agent-resource-bindings/v1` plan.
 * It selects among what that plan already declared; it is not authority, and
 * the trusted dispatcher resolves it against its own copy of that document
 * rather than trusting this string.
 */
export function createRemoteCrdtDocPort(transport: ProposalTransport, binding: string): RemoteCrdtDoc {
  const call = createRemoteCall({
    declaration: CRDT_DOC_DECLARATION,
    transport,
    binding,
    invalidRequest: "invalid_request",
    closed: "scope_closed",
    messages: MESSAGES,
  });

  const port: CrdtDocPort = {
    contract: CRDT_DOC_CONTRACT,

    async listDocs(): Promise<CrdtDocReply<CrdtDocList>> {
      // No echo rule: this action names no document, so there is nothing the
      // answer could be "about" other than the scope that answered it.
      return call.call({
        action: "list_docs",
        params: {},
        read: readCrdtDocList,
        malformed: MALFORMED_LIST,
      });
    },

    async openDoc(doc: string): Promise<CrdtDocReply<CrdtDocSnapshot>> {
      return call.call({
        action: "open_doc",
        params: { doc },
        read: readCrdtDocSnapshot,
        malformed: MALFORMED_SNAPSHOT,
        echo: ECHO_DOC,
      });
    },

    async applyUpdate(doc: string, update: string): Promise<CrdtDocReply<CrdtDocAck>> {
      // `update` is the declared large parameter. The kit measures it against
      // the DECLARED bound and refuses locally rather than sending something the
      // far side would reject — which matters more here than elsewhere, because
      // a refused push is an edit the author still holds, and a truncated one
      // would be an edit nobody holds.
      return call.call({
        action: "apply_update",
        params: { doc, update },
        read: readCrdtDocAck,
        malformed: MALFORMED_ACK,
        echo: ECHO_DOC,
      });
    },

    async readUpdates(doc: string, since: string): Promise<CrdtDocReply<CrdtDocDelta>> {
      return call.call({
        action: "read_updates",
        params: { doc, since },
        read: readCrdtDocDelta,
        malformed: MALFORMED_DELTA,
        echo: ECHO_DOC,
      });
    },
  };

  return { port, destroy: () => call.destroy() };
}
