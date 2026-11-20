import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage, stubApi } from "../test-utils.js";
import { AppsPage } from "./AppsPage.js";

const ID = "ahr_00000000-0000-4000-8000-000000000001";
const DIGEST = "2".repeat(64);

function registry() {
  return {
    apps: [],
    openable: [],
    hotswap_approvals: [{
      id: ID,
      state: "pending",
      ticket_id: 91,
      app_id: "session-plus",
      publisher: "octopus",
      source_commit: "1".repeat(40),
      package_digest: DIGEST,
      previous_digest: "4".repeat(64),
      contract_digest: "3".repeat(64),
      contract_changed: true,
      coexistence: "refresh_required",
      coexistence_reason: "state_epoch_changed",
      requested_by: "devpipe:ticket-91",
      requested_at: "2026-08-15T10:00:00.000Z",
      expires_at: "2026-08-17T10:00:00.000Z",
      outcome: null,
    }],
    reconcile: { activeUnusable: [], installedUnusable: [], undescribable: [], orphanContent: 0 },
  };
}

describe("App hot-swap approval cards", () => {
  it("shows the exact trust facts and approves only the pending id", async () => {
    const api = stubApi({
      [`/api/apps/hotswap/${ID}/approve`]: { ok: true, message: "已激活 exact digest" },
      "/api/apps": registry(),
    });
    const user = userEvent.setup();
    renderPage(<AppsPage />, "/apps");

    expect(await screen.findByRole("heading", { name: "待管理员批准的 activation" })).toBeInTheDocument();
    expect(screen.getByText(`octopus/session-plus`)).toBeInTheDocument();
    expect(screen.getByText(DIGEST)).toBeInTheDocument();
    expect(screen.getByText(/state_epoch_changed/)).toBeInTheDocument();
    expect(screen.getByText(/相对前驱有变化/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "批准并激活" }));
    await waitFor(() => expect(api.calls.some((call) => call.url === `/api/apps/hotswap/${ID}/approve`)).toBe(true));
    const decision = api.calls.find((call) => call.url === `/api/apps/hotswap/${ID}/approve`)!;
    expect(decision.init?.method).toBe("POST");
    expect(decision.init?.body).toBe("{}");
  });
});
