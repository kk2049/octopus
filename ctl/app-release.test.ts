import { describe, expect, it } from "vitest";
import { APP_TICKET_SCOPES } from "../packages/bot/src/devpipe/app-scopes.js";
import { APP_RELEASE_PACK_SCRIPTS, packScriptForApp } from "./app-release.js";

describe("app-release CLI packers", () => {
  it("covers every App that devpipe says this checkout can publish", () => {
    const expected = Object.fromEntries(
      APP_TICKET_SCOPES
        .filter((scope) => scope.packScript != null)
        .map((scope) => [scope.appId, scope.packScript]),
    );
    expect(APP_RELEASE_PACK_SCRIPTS).toEqual(expected);
  });

  it("routes Chess through the existing generic pack script", () => {
    expect(packScriptForApp("chess")).toBe("app:pack:chess");
    expect(packScriptForApp("ppt-studio")).toBe("app:pack:ppt-studio");
    expect(packScriptForApp("meeting-room")).toBe("app:pack:meeting-room");
    expect(packScriptForApp("expense-intake")).toBe("app:pack:expense-intake");
    expect(packScriptForApp("daily-brief")).toBe("app:pack:daily-brief");
    expect(packScriptForApp("report-space")).toBe("app:pack:report-space");
    expect(packScriptForApp("not-an-app")).toBeUndefined();
  });
});
