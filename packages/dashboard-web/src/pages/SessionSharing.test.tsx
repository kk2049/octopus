import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { stubApi } from "../test-utils.js";
import { SessionShareButton, SessionSharingPermissions, SharePage, SharedAccessNotice } from "./SessionSharing.js";

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
const share = { shareId: "sh_test", title: "A shared chat", expiresAt: 1, revoked: false, tokenLimit: 1_500_000, tokensUsed: 100, canPrompt: false, issued: true };
describe("shared session controls", () => {
  it("defaults to 1% estimate and one day, issuing only the selected workspace keys", async () => {
    const { calls } = stubApi({ "/api/session-shares/options": { workspaces: [{ key: "opaque-choice", label: "Project", device: "Laptop" }] }, "/api/session-shares/create": { link: "/share#opaque-bearer" } });
    render(<SessionShareButton resource="opaque-session" />);
    fireEvent.click(screen.getByText("分享此会话"));
    await screen.findByText("Laptop · Project");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "生成分享链接" }));
    await screen.findByRole("textbox", { name: "分享链接" });
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/create"))?.init?.body))).toEqual({ resource: "opaque-session", workspaces: ["opaque-choice"], preset: "1", hours: 24 });
  });
  it("redeems a bearer once under StrictMode and offers renewal for an expired lease", async () => {
    window.history.replaceState(null, "", "/share#secret");
    const { calls } = stubApi({ "/api/session-shares/redeem": { shareId: share.shareId, expired: true }, "/api/session-shares/list": { shares: [share], requests: [] }, "/api/session-shares/request": { ok: true } });
    render(<StrictMode><SharePage /></StrictMode>);
    fireEvent.click(await screen.findByRole("button", { name: "申请更多时间" }));
    await screen.findByText("续期申请已送到签发者的共享会话授权卡片。");
    expect(calls.filter((c) => c.url.endsWith("/redeem"))).toHaveLength(1);
    expect(window.location.hash).toBe("");
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/request"))?.init?.body))).toEqual({ shareId: share.shareId, kind: "lease" });
  });
  it("shows renewal decisions on the issuer's permissions card", async () => {
    const { calls } = stubApi({ "/api/session-shares/list": { shares: [share], requests: [{ id: 7, shareId: share.shareId, kind: "budget", status: "pending" }] }, "/api/session-shares/decide": { ok: true } });
    render(<SessionSharingPermissions />);
    fireEvent.click(await screen.findByRole("button", { name: "批准所选额度" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/decide"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/decide"))?.init?.body))).toEqual({ requestId: 7, approve: true, preset: "1", hours: 24 });
  });
  it("renders a lease closure frame without assuming usage fields are present", () => {
    render(<SharedAccessNotice shareId={share.shareId} projection={{ sharedAccess: { expired: true } }} />);
    expect(screen.getByText("共享访问已结束")).toBeTruthy();
  });
});
