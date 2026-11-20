import { declareContract, refusalVocabulary, mcpToolsOf } from "@claude-bot/typed-port-kit";
import { CAPABILITY_ACTIONS } from "@claude-bot/runner/capability-protocol";
export const RUNNER_EXTENSION_CONTRACT = declareContract({
  contract: "runner-capabilities/v1", summary: "Owner-bound discovery and revision-pinned invocation of locally registered MCP providers.",
  actions: CAPABILITY_ACTIONS,
  refusals: refusalVocabulary(["invalid_input", "unavailable", "stale_revision", "capacity", "request_conflict", "indeterminate"], { fallback: "unavailable" }),
});
export const RUNNER_EXTENSION_MCP_TOOLS = mcpToolsOf(RUNNER_EXTENSION_CONTRACT, { namePrefix: "runner_capability" });
