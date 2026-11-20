import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { loadSessionPlusManifest, normalizeSessionPlusAction } from "../app-core/manifest.js";

it.each([
  ["session-plus", undefined, ["append_session", "resume_session", "takeover_session", "fallback_session"]],
  ["research-program", fileURLToPath(new URL("../../../research-program-view/app/", import.meta.url)),
    ["append_session", "resume_session", "takeover_session"]],
] as const)("%s accepts long session messages using the existing wire budget", (appId, appDir, actions) => {
  const manifest = loadSessionPlusManifest(appDir, { appId });
  const prompt = "继续完成任务。".repeat(3_000);
  for (const action of actions) {
    const spec = manifest.actions[action];
    expect(spec.params.prompt.max).toBe(MACHINE_LIMITS.appendMaxPromptBytes);
    expect(Boolean(spec.humanOnly)).toBe(appId === "research-program" || action === "takeover_session" || action === "fallback_session");
    expect(normalizeSessionPlusAction(manifest, action, { resource: "opaque-session", prompt }))
      .toMatchObject({ ok: true, params: { prompt } });
    expect(normalizeSessionPlusAction(manifest, action, { resource: "opaque-session", prompt: "x".repeat(MACHINE_LIMITS.appendMaxPromptBytes + 1) }).ok)
      .toBe(false);
    expect(normalizeSessionPlusAction(manifest, action, { resource: "opaque-session", prompt }, "agent").ok)
      .toBe(!spec.humanOnly);
  }
});
