/**
 * Controlled cross-scope transfer — the narrow replacement for the generic
 * `deliver(toScope, events)` bypass (SEC-01).
 *
 * A report travelling from one person to another is a legitimate information
 * flow, so the fix is not "forbid cross-scope". The fix is that the only way
 * out of a scope is a declared operation on a fixed Object, reached through the
 * same Gate as every other resource:
 *
 *     handler
 *       -> ctx.capabilities.request("delivery", "send_report", args)
 *            -> kernel: slot -> capability -> ancestry -> fixed Object
 *            -> mandatory policy: resolve recipient, check the mailbox's
 *               receive policy, then either the grant's own terms allow it or
 *               a human decides THIS call
 *       -> this file's adapter (the only holder of the mailbox writer)
 *            -> one fixed `report_received` / `reply_received` envelope
 *
 * What each piece buys, stated plainly because each one was missing before:
 *
 *  · The Object's binding fixes the SENDER and the APP at registration, from
 *    the trusted account the Context belongs to. `from` is therefore not an
 *    argument and cannot be chosen; an app can only ever send as itself.
 *  · The recipient arrives as a NAME and is resolved by a trusted directory to
 *    a canonical user id. It is never a path, so `../tickets/shared`,
 *    `/tmp/x`, `..\outside` and an unknown user all resolve to nothing —
 *    before any policy question is asked, and long before a byte is written.
 *  · The receive policy is the RECIPIENT's, and it fails closed. Alice's
 *    approval authorises disclosing Alice's content; it does not create a
 *    right to write into Bob's resources. Bob's mailbox says who may deposit.
 *  · The envelope is authored here. An app supplies a title and a body; it
 *    cannot choose the event type, forge a system author, or rewrite history.
 *  · Delivery is idempotent on `delivery_id`, which is why these operations
 *    can honestly declare `retrySafe: true` while still being `modify`.
 */

import type {
  CapabilityService,
  ContextId,
  ObjectDefinition,
  Operation,
  OperationSpec,
  PolicyDecision,
  PolicyInput,
} from "@claude-bot/capability-kernel";
import type { HostAuthority } from "./capability-plane.js";

/** The Context-local slot every delivery grant is installed under. */
export const DELIVERY_SLOT = "delivery";

/** Event types the broker may append to a mailbox. Closed set, server-chosen. */
export const REPORT_RECEIVED = "report_received";
export const REPLY_RECEIVED = "reply_received";

/**
 * The trusted user directory, plus the recipient-side receive policy.
 *
 * Both halves are the DEPLOYMENT's, never the app's: an app that could answer
 * "is this a user?" could invent one, and an app that could answer "may I
 * deposit here?" would be answering on the recipient's behalf.
 */
export interface DeliveryDirectory {
  /**
   * Canonicalise whatever the app said into a known user id, or null.
   *
   * Null for: unknown users, empty values, non-strings, anything containing a
   * path separator or `..`, and anything longer than a username can be. This
   * is the function that makes "the recipient is not a path" true.
   */
  resolveRecipient(raw: unknown): string | null;
  /**
   * The recipient's own policy. **Fail closed**: the default answer for a
   * mailbox nobody has configured is `false`, and only an explicit receive
   * grant makes it true. (The product decision about a friendlier default —
   * same-organisation, per-sender, per-app — is the owner's to make; until it
   * is made this is the only safe reading.)
   */
  mayReceive(o: { from: string; to: string; app: string }): boolean;
}

/** The fixed, server-authored shape that lands in a mailbox. */
export type ReportEnvelope =
  | { kind: typeof REPORT_RECEIVED; delivery_id: string; from: string; to: string; title: string; body: string }
  | { kind: typeof REPLY_RECEIVED; delivery_id: string; from: string; to: string; id: string; text: string };

/**
 * The only thing that actually writes a mailbox. Supplied by the Host, which
 * is the only component that owns event logs; the broker never sees a path.
 */
export type MailboxWriter = (o: {
  app: string;
  recipient: string;
  envelope: ReportEnvelope;
}) => Promise<{ delivered: boolean; duplicate: boolean }>;

const ID = { type: "string", required: true, maxLength: 128 } as const;

/**
 * The catalog. Both operations are `modify` — a root therefore never
 * auto-allows them, so a newly wired app sends nothing until somebody says it
 * may, and an agent sends nothing without a decision per call.
 *
 * `retrySafe: true` contradicts the default for `modify`, deliberately: the
 * mailbox dedupes on `delivery_id`, so re-issuing an interrupted delivery is
 * the same as issuing it once. That is exactly the case the flag exists for.
 */
export const DELIVERY_OPERATIONS: Record<string, OperationSpec> = {
  send_report: {
    args: {
      to: { type: "string", required: true, maxLength: 128 },
      title: { type: "string", required: true, maxLength: 200 },
      body: { type: "string", required: true, maxLength: 64 * 1024 },
      delivery_id: ID,
    },
    effect: "modify",
    retrySafe: true,
    title: "把汇报投递到对方信箱",
  },
  reply_report: {
    args: {
      to: { type: "string", required: true, maxLength: 128 },
      id: ID,
      text: { type: "string", required: true, maxLength: 64 * 1024 },
      delivery_id: ID,
    },
    effect: "modify",
    retrySafe: true,
    title: "把回复投递到对方信箱",
  },
};

export const DELIVERY_OPERATION_NAMES: readonly Operation[] = Object.keys(DELIVERY_OPERATIONS);

interface DeliveryBinding {
  /** Fixed at registration from the account the authority belongs to. */
  sender: string;
  /** Fixed too: an app may only deliver into its own mailboxes. */
  app: string;
  directory: DeliveryDirectory;
  mailbox: MailboxWriter;
}

/**
 * Resolve and vet a recipient. Shared by the policy and the adapter on
 * purpose: the policy's answer decides whether a human is asked, and the
 * adapter re-derives it rather than trusting a value that travelled.
 */
function vetRecipient(
  binding: Pick<DeliveryBinding, "sender" | "app" | "directory">,
  args: Readonly<Record<string, unknown>>,
): { ok: true; to: string } | { ok: false; reason: string } {
  const to = binding.directory.resolveRecipient(args.to);
  if (!to) return { ok: false, reason: "收件人无法解析为已知用户（收件人是用户名，不是路径）" };
  if (to === binding.sender) return { ok: false, reason: "不能投递给自己" };
  if (!binding.directory.mayReceive({ from: binding.sender, to, app: binding.app })) {
    return { ok: false, reason: `${to} 的信箱没有授权接收来自 ${binding.sender} 的投递` };
  }
  return { ok: true, to };
}

/**
 * Mandatory policy for every delivery Object.
 *
 * Order matters. Recipient resolution and the receive policy come FIRST, so a
 * transfer nobody may receive is denied outright rather than turned into an
 * approval card — the sender must not be able to make the recipient's policy
 * look like a question for the sender to answer.
 */
function makeDeliveryPolicy(directory: DeliveryDirectory): (input: PolicyInput) => PolicyDecision {
  return function deliveryPolicy(input: PolicyInput): PolicyDecision {
  const sender = input.object.metadata.sender ?? "";
  const app = input.object.metadata.app ?? "";
  if (!sender || !app) {
    return { kind: "deny", reason: "delivery object is not bound to a sender and an app" };
  }
  const vetted = vetRecipient({ sender, app, directory }, input.args);
  if (!vetted.ok) return { kind: "deny", reason: vetted.reason };

  const a = input.approval;
  if (
    a
    && a.objectId === input.object.id
    && a.operation === input.operation
    && a.argsHash === input.argsHash
    && a.contextId === input.context.id
    && a.slot === input.slot
    && a.approver === sender
  ) {
    return { kind: "allow" };
  }

  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };

  // Everything on the card is server-authored and every field is inside the
  // hashed args, so changing the recipient, the title, the body or the
  // delivery id after approval produces a different hash and a dead approval.
  const details = [
    `收件人：${vetted.to}`,
    `应用：${app}`,
    input.operation === "send_report"
      ? `标题：${String(input.args.title ?? "").slice(0, 200)}`
      : `回复的汇报：${String(input.args.id ?? "").slice(0, 64)}`,
    `正文长度：${String(input.args.body ?? input.args.text ?? "").length} 字符`,
    `投递编号：${String(input.args.delivery_id ?? "").slice(0, 64)}`,
    `发起方：${input.context.metadata.purpose ?? input.context.kind}`,
    `参数指纹：${input.argsHash.slice(0, 16)}`,
  ];
  return {
    kind: "approval_required",
    summary: {
      title: `${input.spec.title ?? input.operation} · ${sender} → ${vetted.to}`,
      target: vetted.to,
      details,
      // Only the sender may authorise disclosing the sender's content. This is
      // NOT the recipient's consent — that is `mayReceive`, checked above.
      allowedApprover: sender,
    },
  };
  };
}

async function deliveryAdapter(
  binding: DeliveryBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const vetted = vetRecipient(binding, args);
  // Belt and braces: the policy already refused this, and the gate does not
  // reach an adapter after a deny. Re-deriving here means a future policy edit
  // cannot turn into a write to a mailbox that never opted in.
  if (!vetted.ok) throw new Error(vetted.reason);
  const deliveryId = String(args.delivery_id ?? "");
  const envelope: ReportEnvelope =
    operation === "send_report"
      ? {
          kind: REPORT_RECEIVED,
          delivery_id: deliveryId,
          from: binding.sender,
          to: vetted.to,
          title: String(args.title ?? ""),
          body: String(args.body ?? ""),
        }
      : {
          kind: REPLY_RECEIVED,
          delivery_id: deliveryId,
          from: binding.sender,
          to: vetted.to,
          id: String(args.id ?? ""),
          text: String(args.text ?? ""),
        };
  const out = await binding.mailbox({ app: binding.app, recipient: vetted.to, envelope });
  return { delivery_id: deliveryId, to: vetted.to, status: out.duplicate ? "duplicate" : "delivered" };
}

export interface DeliveryBrokerOptions {
  service: CapabilityService;
  directory: DeliveryDirectory;
  /**
   * Which transfers this deployment considers authorised by the act of a
   * logged-in person pressing the button, rather than by a second decision on
   * the approval page. **Default: none** — every send waits for a human.
   *
   * It lives here, on the issuing side, for the same reason `open({autoAllow})`
   * does on the Runner: "does this need a click?" is a property of the grant,
   * not of the operation, and the policy has no branch for it. The kernel will
   * not do this for us — a root never auto-allows a `modify` by default, and
   * that default is right; saying otherwise has to be somebody's explicit act.
   *
   * It is the CEILING. Agents are capped at nothing regardless (see
   * `DeliveryPlaneOptions.agentAutoAllow`), so opening it is a statement about
   * the human path only.
   */
  rootAutoAllow?: (o: { sender: string; app: string }) => readonly Operation[];
}

/**
 * Registers one delivery Object per (app, sender) and owns its single root.
 *
 * One per PAIR rather than one per app: the sender has to be part of the
 * Object's fixed binding, because an Object whose sender came from an argument
 * would let any holder send as anyone. The app is in it too, so a grant for
 * the reports app cannot be spent depositing into the tickets app's logs.
 *
 * ── Where the root lives, and why it is not its own Context ────────────────
 *
 * The root capability is minted INTO the account-authority Context the
 * resource plane already owns, under the slot `delivery:<app>`. Two reasons,
 * both structural:
 *
 *  · `derive` may only install into a DESCENDANT of the granting Context
 *    (kernel invariant 10). An App Context is a child of the account
 *    authority; a delivery root in a sibling Context could never be derived
 *    into it, and a tree has no second parent to offer.
 *  · Revocation then has exactly one place to happen. Destroying the account
 *    authority — which is what removing a device or deleting a user does —
 *    takes the delivery root with it, and the next call mints a fresh one in
 *    the fresh account Context. A delivery root in a Context of its own would
 *    outlive that, because a destroyed Context does not invalidate a ROOT
 *    capability held by a different, still-live Context.
 */
export class DeliveryBroker {
  private mailbox: MailboxWriter | null = null;

  constructor(private opts: DeliveryBrokerOptions) {}

  /**
   * Hand the broker the one function that writes mailboxes. Called once, by
   * the Host, at construction. Until it happens `authorityFor` returns null,
   * so an unattached broker grants nothing rather than granting something that
   * would fail later.
   */
  attachMailbox(writer: MailboxWriter): void {
    if (this.mailbox) throw new Error("delivery broker already has a mailbox writer");
    this.mailbox = writer;
  }

  get attached(): boolean {
    return this.mailbox !== null;
  }

  /** The Object id for one (app, sender) pair. Stable across restarts. */
  static objectIdFor(app: string, sender: string): string {
    return `delivery:${String(app ?? "").trim()}:${String(sender ?? "").trim()}`;
  }

  /** The slot this app's delivery root occupies on the account Context. */
  static slotFor(app: string): string {
    return `${DELIVERY_SLOT}:${String(app ?? "").trim()}`;
  }

  /**
   * The root authority a plane may derive from, for one (sender, app).
   *
   * Fail closed at every step: no mailbox writer, no app, a sender the
   * directory does not recognise, a dead account Context — all null, which is
   * an App Context with no delivery slot and therefore an app that cannot send.
   */
  authorityFor(username: string, app: string, accountContextId: ContextId): HostAuthority | null {
    const mailbox = this.mailbox;
    if (!mailbox) return null;
    const sender = String(username ?? "").trim();
    const appName = String(app ?? "").trim();
    if (!sender || !appName || !accountContextId) return null;
    // The sender must itself be a known user: authority to send is authority
    // held by an account, and an account the directory cannot name has none.
    if (this.opts.directory.resolveRecipient(sender) !== sender) return null;
    if (!this.opts.service.contextIsLive(accountContextId)) return null;

    const objectId = DeliveryBroker.objectIdFor(appName, sender);
    const slot = DeliveryBroker.slotFor(appName);
    if (!this.opts.service.hasObject(objectId)) {
      const def: ObjectDefinition<DeliveryBinding> = {
        id: objectId,
        kind: "delivery-mailbox",
        binding: { sender, app: appName, directory: this.opts.directory, mailbox },
        metadata: { sender, app: appName },
        operations: DELIVERY_OPERATIONS,
        // A closure over the deployment's directory, so the recipient rules the
        // policy applies are the same object the adapter re-derives from.
        policy: makeDeliveryPolicy(this.opts.directory),
        adapter: deliveryAdapter as ObjectDefinition<DeliveryBinding>["adapter"],
      };
      this.opts.service.registerObject(def);
    }

    const roots = this.opts.service.rootsOf(objectId);
    if (roots.some((r) => r.contextId === accountContextId && r.slot === slot)) {
      return { contextId: accountContextId, slot };
    }
    // A live root somewhere else means the account authority was re-minted
    // while an old holder survived. Collapse rather than pick a winner: two
    // live roots over one Object is a state where revoking one leaves the other.
    for (const r of roots) this.opts.service.revoke(r.contextId, r.slot);
    const autoAllow = (this.opts.rootAutoAllow?.({ sender, app: appName }) ?? []).filter((op) =>
      DELIVERY_OPERATION_NAMES.includes(op),
    );
    try {
      this.opts.service.mintRoot(accountContextId, slot, objectId, DELIVERY_OPERATION_NAMES, { autoAllow });
    } catch {
      // The slot is occupied by a revoked capability — a slot is never
      // silently replaced. Delivery stays closed until the account authority
      // itself is re-established, which is the fail-closed direction.
      return null;
    }
    return { contextId: accountContextId, slot };
  }

  /** Revoke this (sender, app)'s delivery authority and everything under it. */
  revoke(username: string, app: string): void {
    const objectId = DeliveryBroker.objectIdFor(app, username);
    if (!this.opts.service.hasObject(objectId)) return;
    for (const root of this.opts.service.rootsOf(objectId)) {
      this.opts.service.revoke(root.contextId, root.slot);
    }
  }
}

/**
 * A directory backed by two explicit tables. Small on purpose: it is the shape
 * a deployment's real user store has to satisfy, and it is what the tests use.
 *
 * `users` is the set of canonical ids. `receive` is the set of `${from}->${to}`
 * (optionally `${from}->${to}@${app}`) grants — absent means refused, which is
 * the fail-closed default the backlog requires until the owner rules on a
 * friendlier one.
 */
export class ExplicitDirectory implements DeliveryDirectory {
  private users: Set<string>;
  private receive = new Set<string>();

  constructor(users: Iterable<string> = []) {
    this.users = new Set(users);
  }

  addUser(name: string): void {
    this.users.add(name);
  }

  /** Record an explicit receive grant: `to` accepts reports from `from`. */
  allowReceive(from: string, to: string, app?: string): void {
    this.receive.add(app ? `${from}->${to}@${app}` : `${from}->${to}`);
  }

  revokeReceive(from: string, to: string, app?: string): void {
    this.receive.delete(app ? `${from}->${to}@${app}` : `${from}->${to}`);
  }

  resolveRecipient(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const name = raw.trim();
    // A username is an identifier. Anything that could also be read as a path
    // is refused HERE rather than sanitised, because sanitising invites the
    // question "did we catch every spelling".
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return null;
    if (name.includes("..")) return null;
    return this.users.has(name) ? name : null;
  }

  mayReceive(o: { from: string; to: string; app: string }): boolean {
    return this.receive.has(`${o.from}->${o.to}`) || this.receive.has(`${o.from}->${o.to}@${o.app}`);
  }
}
