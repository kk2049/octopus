import type { QuotaResult } from "./claude-quota.js";
import type { RunnerClaudeAccount } from "./inventory.js";

/** Only aggregate subscription windows leave the credential-owning Runner. */
export async function claudeAccountInventory(probe: { snapshot(): Promise<QuotaResult> }): Promise<RunnerClaudeAccount[]> {
  const result = await probe.snapshot();
  if (result.error === "no_credentials") return [];
  const windows = result.cards.flatMap((card) => {
    const windowMinutes = card.key === "session" ? 300 : card.key === "weekly_all" ? 10_080 : undefined;
    return windowMinutes && card.resetsAt
      ? [{ remainingPercent: card.remainPercent, windowMinutes, resetsAt: card.resetsAt }]
      : [];
  });
  return [{ id: "@default", label: "Claude", quota: {
    status: windows.length ? "available" : "unavailable", fetchedAt: result.fetchedAt, windows,
  } }];
}
