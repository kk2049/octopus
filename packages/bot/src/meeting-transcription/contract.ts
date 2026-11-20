import { declareContract, refusalVocabulary, mcpToolsOf } from "@claude-bot/typed-port-kit";
import { MEETING_TRANSCRIPTION_ACTIONS } from "@claude-bot/runner/meeting-transcription-protocol";
export const MEETING_TRANSCRIPTION_CONTRACT = declareContract({ contract: "meeting-transcription/v1",
  summary: "Owner-bound, device-managed MOSS recording jobs with bounded transfer and immutable artifacts.",
  actions: MEETING_TRANSCRIPTION_ACTIONS,
  refusals: refusalVocabulary(["invalid_request", "unavailable", "denied", "closed", "conflict", "not_found"], { fallback: "unavailable" }),
});
/** A mounted adapter must close over the trusted owner/device, never add selectors to these descriptors. */
export const MEETING_TRANSCRIPTION_MCP_TOOLS = mcpToolsOf(MEETING_TRANSCRIPTION_CONTRACT, { namePrefix: "meeting_transcription" });
