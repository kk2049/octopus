/**
 * The approval drawer, which is the one control on this panel that turns a human
 * click into execution on somebody's machine.
 *
 * The properties under test are the ones that make that safe: the browser sends
 * only the opaque pending id (it cannot say what will run), the summary comes
 * from the server, and a double click cannot approve twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryClient } from "../lib/query.js";
import { ApprovalDrawer, rememberPending, useApprovalQueue } from "./Approvals.js";
import {
  recordAgenticOperation,
  resetAgenticActivityForTests,
} from "./agentic-activity.js";

const PENDING = {
  id: "pc_1",
  title: "在 laptop 上执行命令",
  operation: "exec",
  target: "runner-account:alice · laptop",
  details: ["command: rm -rf /tmp/x"],
  expiresAt: "2026-08-01T10:00:00.000Z",
  requestedBy: { purpose: "会话续跑", surface: "sessions" },
};

function Harness() {
  const queue = useApprovalQueue(true);
  return <ApprovalDrawer open onOpenChange={() => {}} queue={queue} />;
}

function renderDrawer() {
  const client = createQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("the approval drawer", () => {
  let calls: Array<{ url: string; init: RequestInit | undefined }>;

  beforeEach(() => {
    resetAgenticActivityForTests();
    calls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("/api/capabilities/pending/")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ pending: [PENDING] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  it("renders only what the server wrote about the frozen call", async () => {
    renderDrawer();
    expect(await screen.findByText("在 laptop 上执行命令")).toBeInTheDocument();
    expect(screen.getByText(/runner-account:alice · laptop/)).toBeInTheDocument();
    expect(screen.getByText(/发起：会话续跑/)).toBeInTheDocument();
  });

  it("renders OAuth recovery as a link without approval controls", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      pending: [],
      notices: [{
        id: "feishu-reauth:alice:1",
        kind: "feishu_reauth",
        title: "飞书授权需要更新",
        detail: "doc_read 暂停：授权已过期",
        url: "https://accounts.example/device?code=ABCD",
        actionLabel: "打开飞书授权",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    renderDrawer();
    const notice = (await screen.findByText("飞书授权需要更新")).closest("section")!;
    expect(notice).toHaveAttribute("data-testid", "attention-notice");
    expect(screen.getByRole("link", { name: "打开飞书授权" })).toHaveAttribute(
      "href", "https://accounts.example/device?code=ABCD",
    );
    expect(notice.querySelector('[data-action="approve"]')).toBeNull();
    expect(notice.querySelector('[data-action="reject"]')).toBeNull();
  });

  it("sends the opaque id and an empty body — never a target or arguments", async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole("button", { name: "批准并执行" }));
    const decision = calls.find((call) => call.url.includes("/approve"))!;
    expect(decision.url).toBe("/api/capabilities/pending/pc_1/approve");
    expect(decision.init?.body).toBe("{}");
    expect(String(decision.init?.body)).not.toContain("exec");
  });

  it("attaches the CSRF header to the decision", async () => {
    document.cookie = "octopus_csrf=tok; path=/";
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole("button", { name: "批准并执行" }));
    const decision = calls.find((call) => call.url.includes("/approve"))!;
    expect(new Headers(decision.init?.headers).get("x-csrf-token")).toBe("tok");
  });

  it("is single-flight: a second click cannot approve the same call twice", async () => {
    // The decision is held open, so the second click lands while the first is
    // still in flight — which is the case a plain `disabled` toggle can lose to
    // a fast double click.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/approve")) {
        await held;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ pending: [PENDING] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderDrawer();
    const button = await screen.findByRole("button", { name: "批准并执行" });
    await user.click(button);
    await user.click(button);
    expect(calls.filter((call) => call.url.includes("/approve"))).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.getByText("执行完成。")).toBeInTheDocument());
  });

  it("says an accepted submission is RUNNING, not finished", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/approve")) {
        return new Response(JSON.stringify({ operation_id: "op-9" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ pending: [PENDING] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole("button", { name: "批准并执行" }));
    await waitFor(() =>
      expect(screen.getByText(/已批准,正在执行/)).toBeInTheDocument(),
    );
  });

  it("surfaces the server's refusal rather than pretending it worked", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/approve")) {
        return new Response(JSON.stringify({ error: "批准只能在浏览器登录会话中完成" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ pending: [PENDING] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole("button", { name: "批准并执行" }));
    expect(await screen.findByText("批准只能在浏览器登录会话中完成")).toBeInTheDocument();
  });

  it("keeps the stable hooks the real-browser suite decides a card through", async () => {
    // Explicit attributes identify and decide a card from outside the app,
    // which is the only vantage a browser test of a MessagePort boundary has.
    renderDrawer();
    const card = (await screen.findByText("在 laptop 上执行命令")).closest("section")!;
    expect(card).toHaveAttribute("data-testid", "approval-card");
    expect(card.querySelector('button[data-action="approve"]')).not.toBeNull();
    expect(card.querySelector('button[data-action="reject"]')).not.toBeNull();
  });

  it("is a dialog with an accessible name, so a keyboard reaches it", async () => {
    renderDrawer();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("审批与动态");
  });

  it("shows compact Agentic App activity without parameters or transcript content", async () => {
    recordAgenticOperation({ id: "session-plus", title: "会话+" }, {
      id: "op-1",
      operation: "append_session",
      status: "running",
      message: "本机 CLI 正在运行",
      updatedAt: "2026-08-13T10:00:00.000Z",
      prompt: "must not render",
    });
    renderDrawer();
    expect(await screen.findByText("append_session")).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.queryByText("must not render")).not.toBeInTheDocument();
  });
});

describe("approval auto-open memory", () => {
  it("opens once for a new pending id and does not nag on later polls", () => {
    const seen = new Set<string>();
    expect(rememberPending(seen, [{ id: "pc-1" }])).toBe(true);
    expect(rememberPending(seen, [{ id: "pc-1" }])).toBe(false);
    expect(rememberPending(seen, [{ id: "pc-1" }, { id: "pc-2" }])).toBe(true);
  });
});
