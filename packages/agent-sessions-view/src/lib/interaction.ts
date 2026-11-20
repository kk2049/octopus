import type {
  AgentInteraction,
  AgentInteractionResponse,
} from "@claude-bot/agent-sessions-contract";

/**
 * Keep only what the compact success receipt may show. Secret answers are
 * replaced immediately and the optional message is not retained at all.
 */
export function interactionReceiptResponse(
  interaction: AgentInteraction,
  response: AgentInteractionResponse,
): AgentInteractionResponse {
  const secret = new Set(
    (interaction.questions ?? []).filter((question) => question.secret).map((question) => question.id),
  );
  return {
    decision: response.decision,
    answers: Object.fromEntries(Object.entries(response.answers).map(([id, values]) => [
      id,
      secret.has(id) && values.length ? ["敏感回答"] : values,
    ])),
  };
}
