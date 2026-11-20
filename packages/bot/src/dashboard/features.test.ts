import { describe, expect, it } from "vitest";
import {
  featureDisabledMessage,
  featureEnabled,
  PANEL_FEATURE,
} from "./features.js";

describe("dashboard composition features", () => {
  it("is closed when the feature list is absent or empty", () => {
    expect(featureEnabled(undefined, PANEL_FEATURE.sessionPlus)).toBe(false);
    expect(featureEnabled([], PANEL_FEATURE.sessionPlus)).toBe(false);
  });

  it("does not let one configured feature imply another", () => {
    const enabled = [PANEL_FEATURE.sessionPlus] as const;
    expect(featureEnabled(enabled, PANEL_FEATURE.sessionPlus)).toBe(true);
    expect(featureEnabled(enabled, PANEL_FEATURE.devPipeline)).toBe(false);
  });

  it("keeps the operator-facing absence reason with the feature registry", () => {
    expect(featureDisabledMessage(PANEL_FEATURE.devPipeline)).toBe("self-hosting pipeline disabled");
    expect(featureDisabledMessage(PANEL_FEATURE.sessionPlus)).toBe("session plus disabled");
  });
});
