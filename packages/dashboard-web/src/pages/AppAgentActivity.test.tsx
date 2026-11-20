import { useState } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderPage } from "../test-utils.js";
import { AppAgentActivity } from "./AppAgentActivity.js";

vi.mock("../lib/bootstrap.js", async (original) => ({
  ...await original<typeof import("../lib/bootstrap.js")>(),
  appInstanceHandle: () => "private-tab-handle",
}));

it("shows durable waiting and a final refusal, and consumes a stop receipt exactly once", async () => {
  let stopped = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(new Headers(init?.headers).get("x-app-instance")).toBe("private-tab-handle");
    expect(url).not.toContain("private-tab-handle");
    if (url.includes("agent-stop")) { stopped = true; return Response.json({ ok: true }); }
    return Response.json({ activity: [{ id: "t1", agent: "secretary", state: stopped ? "stopped" : "waiting_resource", updatedAt: "now", reply: "工具拒绝了写入，尚未保存。", canStop: !stopped }] });
  });
  vi.stubGlobal("fetch", fetcher);
  renderPage(<AppAgentActivity appId="research-program" />);
  expect(await screen.findByText("已等待一分钟；保持监听，连接恢复后自动继续。")).toBeInTheDocument();
  expect(screen.getByText("工具拒绝了写入，尚未保存。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "停止此任务" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "停止此任务" })).toBeNull());
  expect(screen.getAllByText(/已停止/).length).toBeGreaterThan(0);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("agent-stop"))).toHaveLength(1);
});

it("does not expose private App activity to a shared-session page", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  renderPage(<AppAgentActivity appId="session-plus" enabled={false} />);
  expect(screen.queryByLabelText("应用任务")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it("drops a stop refusal from a previous App generation", async () => {
  let finish!: (value: Response) => void;
  const stopped = new Promise<Response>(resolve => { finish = resolve; });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("agent-stop")) return stopped;
    return Response.json({ activity: [{ id: "t1", agent: "worker", state: "waiting_resource", canStop: true }] });
  });
  vi.stubGlobal("fetch", fetcher);
  function Host() {
    const [app, setApp] = useState("research-program");
    return <><button onClick={() => setApp("ppt-studio")}>change app</button><AppAgentActivity appId={app} /></>;
  }
  renderPage(<Host />);
  fireEvent.click(await screen.findByRole("button", { name: "停止此任务" }));
  fireEvent.click(screen.getByRole("button", { name: "change app" }));
  await screen.findByRole("button", { name: "停止此任务" });
  await act(async () => { finish(Response.json({ error: "old app denied" }, { status: 403 })); await stopped; });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "停止此任务" })).not.toBeDisabled();
});
