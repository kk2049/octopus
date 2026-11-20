import { expect, it } from "vitest";
import { localBridgeCaller } from "./gateway.js";

it("accepts only a well-formed Runner-resolved caller session", () => {
  expect(localBridgeCaller({ source: "claude", session_id: "11111111-2222-4333-8444-555555555555" })).toEqual({ source: "claude", sessionId: "11111111-2222-4333-8444-555555555555" });
  for (const bad of [null, "x", [], { source: "bash", session_id: "a" }, { source: "codex", session_id: "" }, { source: "codex", session_id: "a b" }, { source: "codex", session_id: "x".repeat(201) }, { source: "codex" }]) {
    expect(localBridgeCaller(bad), JSON.stringify(bad)).toBeUndefined();
  }
});
