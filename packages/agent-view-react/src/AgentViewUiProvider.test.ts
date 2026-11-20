import { afterEach, describe, expect, it } from "vitest";

import { agentViewAntTheme } from "./AgentViewUiProvider.js";

describe("agentViewAntTheme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("projects geometry and typography entirely from CSS tokens", () => {
    document.documentElement.style.setProperty("--av-rs", "10px");
    document.documentElement.style.setProperty("--av-rm", "14px");
    document.documentElement.style.setProperty("--av-font", "AppleSystem");
    document.documentElement.style.setProperty("--av-control-h", "34px");
    document.documentElement.style.setProperty("--av-control-weight", "590");
    document.documentElement.style.setProperty("--av-card-padding", "16px");

    const themed = agentViewAntTheme("future-profile:light");
    expect(themed.token).toMatchObject({
      borderRadius: 10,
      borderRadiusLG: 14,
      controlHeight: 34,
      fontFamily: "AppleSystem",
    });
    expect(themed.components?.Button).toMatchObject({ controlHeight: 34, fontWeight: 590 });
    expect(themed.components?.Card).toMatchObject({ bodyPadding: 16, borderRadiusLG: 14 });
    expect(themed.components?.Select).toMatchObject({ controlHeight: 34 });
  });
});
