import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderPage, stubApi } from "../../test-utils.js";
import { MergeQueueBox } from "./MergeQueueBox.js";

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 3,
  ticket_id: 12,
  ticket_title: "加一个按钮",
  ticket_slug: null,
  requester: "lilei",
  branch: "contrib/lilei/ticket-12",
  sha: "a".repeat(40),
  base_sha: "b".repeat(40),
  summary: "adds a button",
  status: "awaiting_review",
  pipeline_url: "https://ci/1",
  mr_url: "https://gitlab/mr/5",
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MergeQueueBox", () => {
  it("renders nothing for a contributor and nothing when there was never a proposal", async () => {
    stubApi({ "/api/merge-queue": { may_review: true, proposals: [] } });
    const { container } = renderPage(<MergeQueueBox enabled={false} onOpenTicket={() => {}} />);
    expect(container.querySelector("[data-testid=merge-queue]")).toBeNull();
    const { container: member } = renderPage(<MergeQueueBox enabled onOpenTicket={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(member.querySelector("[data-testid=merge-queue]")).toBeNull();
  });

  it("shows approve/reject to a maintainer and posts the decision with its note", { timeout: 30_000 }, async () => {
    const api = stubApi({
      "/api/merge-queue/decide": { ok: true },
      "/api/merge-queue": { may_review: true, proposals: [proposal()] },
    });
    renderPage(<MergeQueueBox enabled onOpenTicket={() => {}} />);
    await screen.findByTestId("proposal-3");
    expect(screen.getByText(/CI 通过 · 等维护者审批/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MR" })).toHaveAttribute("href", "https://gitlab/mr/5");
    fireEvent.change(screen.getByLabelText("提案 #3 的审批备注"), { target: { value: "缺测试" } });
    fireEvent.click(screen.getByRole("button", { name: /打回/ }));
    await waitFor(() => {
      const call = api.calls.find((c) => c.url.endsWith("/api/merge-queue/decide"));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call!.init?.body))).toEqual({ proposal_id: 3, decision: "reject", note: "缺测试" });
    });
  });

  it("hides the verbs from a member without deploy and offers the batch button only when something is approved", async () => {
    stubApi({ "/api/merge-queue": { may_review: false, proposals: [proposal({ status: "approved" })] } });
    renderPage(<MergeQueueBox enabled onOpenTicket={() => {}} />);
    await screen.findByTestId("proposal-3");
    expect(screen.queryByRole("button", { name: /批准/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /执行批量合并/ })).toBeNull();
  });

  it("runs the batch and opens the merge ticket it created", async () => {
    const opened: number[] = [];
    stubApi({
      "/api/merge-queue/run": { ok: true, ticket: { id: 99 } },
      "/api/merge-queue": { may_review: true, proposals: [proposal({ status: "approved" })] },
    });
    renderPage(<MergeQueueBox enabled onOpenTicket={(id) => opened.push(id)} />);
    fireEvent.click(await screen.findByRole("button", { name: /执行批量合并\(1 个已批准提案\)/ }));
    await waitFor(() => expect(opened).toEqual([99]));
  });
});
