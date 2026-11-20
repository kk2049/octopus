import { describe, expect, it } from "vitest";
import { AgentIntegrationPolicyReconciler } from "./agent-integration-policy.js";

describe("AgentIntegrationPolicyReconciler", () => {
  it("serializes changes and converges to the newest requested policy", async () => {
    const applied: boolean[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const reconciler = new AgentIntegrationPolicyReconciler(async (enabled) => {
      applied.push(enabled);
      if (applied.length === 1) await first;
    }, false);

    const enable = reconciler.setDefaultInjection(true);
    const disable = reconciler.setDefaultInjection(false);
    const enableAgain = reconciler.setDefaultInjection(true);
    releaseFirst?.();
    await Promise.all([enable, disable, enableAgain]);

    expect(applied).toEqual([true]);
    await reconciler.setDefaultInjection(false);
    expect(applied).toEqual([true, false]);
    await reconciler.close();
    await reconciler.setDefaultInjection(true);
    expect(applied).toEqual([true, false]);
  });

  it("does not spin after a failed reconciliation and allows an explicit retry", async () => {
    let attempts = 0;
    const reconciler = new AgentIntegrationPolicyReconciler(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("config busy");
    }, false);
    await expect(reconciler.setDefaultInjection(true)).rejects.toThrow("config busy");
    expect(attempts).toBe(1);
    await reconciler.setDefaultInjection(true);
    expect(attempts).toBe(2);
  });
});
