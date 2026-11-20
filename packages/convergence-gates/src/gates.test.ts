import { describe, expect, it } from "vitest";

import {
  evaluateCrashSemantics,
  evaluateTcbExtraction,
  evaluateUiParity,
  runSelfHostedAcceptance,
  type SelfHostedAcceptanceDriver,
} from "./gates.js";

describe("convergence gates", () => {
  it("covers every mutation with no automatic retry", () => {
    expect(evaluateCrashSemantics().status).toBe("pass");
  });

  it("fails UI parity if one user-visible fallback is missing", () => {
    expect(evaluateUiParity({
      authenticatedOrigin: true,
      mobile: true,
      accessibility: true,
      draftPreservation: true,
      interactionCards: true,
      stableDeepLinks: true,
      imFallback: false,
    }).status).toBe("fail");
  });

  it("does not accept truthy strings or extra G4 evidence fields", () => {
    const evidence = {
      authenticatedOrigin: "yes",
      mobile: true,
      accessibility: true,
      draftPreservation: true,
      interactionCards: true,
      stableDeepLinks: true,
      imFallback: true,
      rawUrl: "https://not-evidence.invalid",
    } as unknown as Parameters<typeof evaluateUiParity>[0];
    expect(evaluateUiParity(evidence).status).toBe("fail");
  });

  it("runs registration, Gate, revocation, reconnect and upgrade in order", async () => {
    const order: string[] = [];
    const driver: SelfHostedAcceptanceDriver = {
      async register() { order.push("register"); return { deviceAccepted: true, gateAccepted: true }; },
      async gateRoundTrip() { order.push("gate"); return { accepted: true, targetFrames: 1 }; },
      async revoke() { order.push("revoke"); },
      async postRevoke() { order.push("post-revoke"); return { refused: true, targetFrames: 0 }; },
      async reconnect() { order.push("reconnect"); return { registered: true, duplicateFrames: 0 }; },
      async upgrade() { order.push("upgrade"); return { from: "a", to: "b", registered: true }; },
      async afterUpgrade() { order.push("after-upgrade"); return { accepted: true, targetFrames: 1 }; },
    };
    expect((await runSelfHostedAcceptance(driver)).status).toBe("pass");
    expect(order).toEqual(["register", "gate", "revoke", "post-revoke", "reconnect", "upgrade", "after-upgrade"]);
  });

  it("finds every retained TCB owner in this checkout", async () => {
    expect((await evaluateTcbExtraction(new URL("../../..", import.meta.url).pathname)).status).toBe("pass");
  });
});
