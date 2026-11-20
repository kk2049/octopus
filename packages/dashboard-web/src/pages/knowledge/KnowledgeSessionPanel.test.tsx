import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { bootstrap } from "../../lib/bootstrap.js";
import { browserDraftStore } from "../../lib/browser-drafts.js";
import { renderPage } from "../../test-utils.js";
import type { SessionPlusAppProps } from "../../contract.js";
import type { WikiConflictWorkspace } from "./types.js";
import { KnowledgeSessionPanel } from "./KnowledgeSessionPanel.js";

vi.mock("../SessionPlusPage.js", () => ({ SessionPlusPage: () => <div>Sessions+ runtime</div> }));
describe("knowledge Sessions+ workspace", () => {
  it("opens the existing trusted host with the selected conflict", () => {
    bootstrap.pageProps = {};
    renderPage(<KnowledgeSessionPanel />, "/knowledge?tab=review&subject=conflict%3A1");
    expect(screen.getByRole("link", { name: "打开常驻 Sessions+ Agent" })).toHaveAttribute("href", expect.stringContaining("agent=sessions-plus"));
  });
  it("requires an explicit draft action and never starts or sends a session implicitly", async () => {
    const identity = { stableAppId: "session-plus", packageDigest: "a".repeat(64) } as SessionPlusAppProps["identity"];
    bootstrap.pageProps = { sessionPlus: { mode: "app", identity } as SessionPlusAppProps };
    const drafts = browserDraftStore(`agent-view:session-plus:${identity.packageDigest}:knowledge`);
    const workspace = { subject_id: "conflict:1", terminal: false, conflict: null, annotations: [{ body: "原始批注" }] } as WikiConflictWorkspace;
    renderPage(<KnowledgeSessionPanel workspace={workspace} />);
    expect(screen.getByText("Sessions+ runtime")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "将冲突资料放入新会话草稿" }));
    expect(drafts.read("session-new:prompt").text).toContain("原始批注");
    expect(drafts.read("session-new:prompt").text).toContain("conflict:1");
    expect(screen.getByText(/资料已放入新会话草稿/)).toBeInTheDocument();
  });
});
