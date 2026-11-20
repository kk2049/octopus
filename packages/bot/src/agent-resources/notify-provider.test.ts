import { describe, expect, it, vi } from "vitest";
import { NOTIFY_CONTRACT, encodeNotifyCard, readNotifyReceipt } from "@claude-bot/notify-contract";
import { AgentResourceCatalog } from "./catalog.js";
import { NOTIFY_PROPOSAL_ACTIONS, notifyProvider } from "./notify-provider.js";
import type { ResourceProviderContext } from "./types.js";
import type { NotifyDelivery, NotifyDeliveryOutcome, NotifyScopeGrant } from "../notify/types.js";

const PLAN = {
  schema: "agent-resource-bindings/v1" as const,
  app: "session-plus",
  bindings: [{ binding: "notify", contract: NOTIFY_CONTRACT, port: NOTIFY_CONTRACT }],
  connections: [],
};

function identity(instance = "i1") {
  return {
    owner: "alice",
    publisher: "octopus:first-party",
    app: "session-plus",
    packageDigest: "a".repeat(64),
    permissionContractDigest: "b".repeat(32),
    instance,
    plan: PLAN as never,
  };
}

function recorder(outcome: NotifyDeliveryOutcome = { ok: true }) {
  const sent: Array<{ target: string; title: string; lines: readonly string[] }> = [];
  const delivery: NotifyDelivery = {
    async deliver({ target, title, lines }) {
      sent.push({ target: target.id, title, lines });
      return outcome;
    },
  };
  return { sent, delivery };
}

function grantOf(delivery: NotifyDelivery, targets = [{ id: "user:alice", label: "alice" }]) {
  let closed = 0;
  const grant: NotifyScopeGrant = { targets, delivery, close: () => { closed += 1; } };
  return { grant, closed: () => closed };
}

/** A sealed catalog with one notify provider, as a composition root builds it. */
function catalogWith(openGrant: (context: ResourceProviderContext) => NotifyScopeGrant | null) {
  const catalog = new AgentResourceCatalog();
  catalog.register(notifyProvider({ openGrant }));
  catalog.seal();
  return catalog;
}

describe("notify/v1 provider", () => {
  it("declares exactly the contract's two actions, with the wire prefix", () => {
    expect(NOTIFY_PROPOSAL_ACTIONS).toEqual(["resource.send_text", "resource.send_card"]);
  });

  it("delivers text to a ref it minted, and answers with a contract-valid receipt", async () => {
    const { sent, delivery } = recorder();
    let refs: string[] = [];
    const catalog = catalogWith(() => grantOf(delivery).grant);
    const handle = catalog.openInstance(identity());
    // The consumer cannot enumerate; a trusted surface hands it a ref. This
    // test takes the one the provider minted the only way anything can — by
    // watching what a bad ref is refused against.
    const bad = await handle.dispatch({ action: "resource.send_text", params: { binding: "notify", recipient: "nr_forged", body: "hi" } });
    expect(bad).toMatchObject({ ok: false, code: "bad_recipient" });
    refs = mintedRefs(catalog);
    const answer = await handle.dispatch({
      action: "resource.send_text",
      params: { binding: "notify", recipient: refs[0]!, body: "上线了" },
    });
    expect(answer.ok).toBe(true);
    expect(sent).toEqual([{ target: "user:alice", title: "通知", lines: ["上线了"] }]);
    // The receipt is read with the contract's own reader, so a shape this side
    // invented would fail here rather than at a consumer.
    const receipt = readNotifyReceipt((answer as { result: unknown }).result);
    expect(receipt.ok).toBe(true);
    expect(receipt.ok && receipt.value.recipient).toBe(refs[0]);
  });

  it("delivers a card decoded by the contract, and refuses one that is not", async () => {
    const { sent, delivery } = recorder();
    const catalog = catalogWith(() => grantOf(delivery).grant);
    const handle = catalog.openInstance(identity());
    // A scope is opened lazily, on first use — deriving authority for a panel
    // nobody looked at is authority nobody asked for. So one refused call comes
    // first, and only then do refs exist.
    await handle.dispatch({ action: "resource.send_text", params: { binding: "notify", recipient: "x", body: "hi" } });
    const ref = mintedRefs(catalog)[0]!;
    const ok = await handle.dispatch({
      action: "resource.send_card",
      params: { binding: "notify", recipient: ref, card: encodeNotifyCard({ title: "部署完成", lines: ["v3 已上线"] })! },
    });
    expect(ok.ok).toBe(true);
    expect(sent[0]).toMatchObject({ title: "部署完成", lines: ["v3 已上线"] });

    const bad = await handle.dispatch({
      action: "resource.send_card",
      params: { binding: "notify", recipient: ref, card: JSON.stringify({ title: "x", lines: ["a"], extra: 1 }) },
    });
    expect(bad).toMatchObject({ ok: false, code: "invalid_request" });
    expect(sent).toHaveLength(1);
  });

  it("holds nothing when the deployment granted nothing, and never opens a channel", async () => {
    const { sent, delivery } = recorder();
    void delivery;
    const catalog = catalogWith(() => null);
    const handle = catalog.openInstance(identity());
    expect(await handle.dispatch({
      action: "resource.send_text",
      params: { binding: "notify", recipient: "nr_x", body: "hi" },
    })).toMatchObject({ ok: false, code: "no_authority" });
    expect(sent).toHaveLength(0);
  });

  it("does not let one instance use another's ref", async () => {
    // The ref is KEPT, not encoded — so a ref from another scope is a lookup
    // miss rather than a check somebody has to remember to write.
    const { delivery } = recorder();
    const catalog = catalogWith(() => grantOf(delivery).grant);
    const mine = catalog.openInstance(identity("i1"));
    await mine.dispatch({ action: "resource.send_text", params: { binding: "notify", recipient: "x", body: "hi" } });
    const myRef = mintedRefs(catalog)[0]!;
    const theirs = catalog.openInstance({ ...identity("i2"), owner: "bob" });
    await theirs.dispatch({ action: "resource.send_text", params: { binding: "notify", recipient: "x", body: "hi" } });
    expect(await theirs.dispatch({
      action: "resource.send_text",
      params: { binding: "notify", recipient: myRef, body: "hi" },
    })).toMatchObject({ ok: false, code: "bad_recipient" });
  });

  it("stops answering the moment the scope closes, and gives the grant back", async () => {
    const { delivery, sent } = recorder();
    const held = grantOf(delivery);
    const catalog = catalogWith(() => held.grant);
    const handle = catalog.openInstance(identity());
    await handle.dispatch({ action: "resource.send_text", params: { binding: "notify", recipient: "x", body: "hi" } });
    const ref = mintedRefs(catalog)[0]!;
    await handle.close();
    expect(held.closed()).toBe(1);
    expect(await handle.dispatch({
      action: "resource.send_text",
      params: { binding: "notify", recipient: ref, body: "hi" },
    })).toMatchObject({ ok: false, code: "scope_closed" });
    expect(sent).toHaveLength(0);
  });

  it("rate limits per scope, and says later rather than never", async () => {
    const { sent, delivery } = recorder();
    const catalog = new AgentResourceCatalog();
    catalog.register(notifyProvider({ openGrant: () => grantOf(delivery).grant, limit: { messages: 2, windowMs: 60_000 } }));
    catalog.seal();
    const handle = catalog.openInstance(identity());
    await handle.dispatch({ action: "resource.send_text", params: { binding: "notify", recipient: "x", body: "hi" } });
    const ref = mintedRefs(catalog)[0]!;
    for (let i = 0; i < 2; i++) {
      expect((await handle.dispatch({
        action: "resource.send_text",
        params: { binding: "notify", recipient: ref, body: `m${i}` },
      })).ok).toBe(true);
    }
    expect(await handle.dispatch({
      action: "resource.send_text",
      params: { binding: "notify", recipient: ref, body: "m3" },
    })).toMatchObject({ ok: false, code: "rate_limited" });
    expect(sent).toHaveLength(2);
  });

  it("passes a channel refusal through, and never a channel exception", async () => {
    const catalog = catalogWith(() => grantOf({
      async deliver() {
        throw new Error("/var/run/secret.sock refused");
      },
    }).grant);
    const handle = catalog.openInstance(identity());
    await handle.dispatch({ action: "resource.send_text", params: { binding: "notify", recipient: "x", body: "hi" } });
    const ref = mintedRefs(catalog)[0]!;
    const answer = await handle.dispatch({
      action: "resource.send_text",
      params: { binding: "notify", recipient: ref, body: "hi" },
    });
    expect(answer).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(answer)).not.toContain("secret.sock");
  });
});

/**
 * The refs one open scope minted.
 *
 * There is deliberately no public way to ask — a consumer receives refs from a
 * trusted surface, and enumeration is exactly what `notify/v1` removes. The
 * test reaches into the catalog's scope state instead of adding an API that
 * would exist only for tests.
 */
function mintedRefs(catalog: AgentResourceCatalog): string[] {
  const instances = (catalog as unknown as {
    instances: Map<string, { scopes: Map<string, { state: { refs: Map<string, unknown> } }> }>;
  }).instances;
  for (const record of instances.values()) {
    for (const scope of record.scopes.values()) return [...scope.state.refs.keys()];
  }
  return [];
}
