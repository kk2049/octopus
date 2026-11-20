import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/query.js";
import { deploymentRequested, type EdgeDeployment } from "../lib/deployment-status.js";
import { DeployProgressBanner } from "./DeployProgressBanner.js";
import { bootstrap } from "../lib/bootstrap.js";
import { BUILD_ID_HEADER } from "../contract.js";

it("keeps drafts and focus through build, outage, checks and completion", async () => {
  sessionStorage.clear();
  const client = createQueryClient();
  const edge = { id: 523, status: "building", observed_at: Date.now(), created_at: new Date(performance.timeOrigin + 1000).toISOString(), http_ready: false };
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(edge)));
  const origin = { intent_id: 523, kind: "ticket_agent" as const, actor: "lht", ticket_id: 511, ticket_title: "Deployment", agent: "codex" };
  render(<QueryClientProvider client={client}><DeployProgressBanner origin={origin} /><textarea aria-label="draft" defaultValue="half a prompt" /></QueryClientProvider>);
  const draft = screen.getByRole("textbox");
  draft.focus();
  expect(await screen.findByTestId("deployment-progress")).toHaveTextContent("当前服务仍可使用");
  expect(screen.getByTestId("deployment-progress")).toHaveTextContent("lht");
  expect(screen.getByTestId("deployment-progress")).toHaveTextContent("#511 Deployment");
  for (const status of ["restarting", "health_gate", "rolling_back", "succeeded"]) {
    await act(async () => { client.setQueryData(["edge-deployment"], { ...edge, status }); });
    expect(draft).toHaveValue("half a prompt");
    expect(draft).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  act(() => client.setQueryData(["edge-deployment"], { ...edge, id: 524 }));
  await waitFor(() => expect(screen.getByTestId("deployment-progress")).not.toHaveTextContent("#511"));
  client.clear();
});

it("shows pending immediately, keeps outage progress, and requires dismissal of rollback", async () => {
  sessionStorage.clear();
  const client = createQueryClient();
  let edge: EdgeDeployment = { id: 265, status: "idle", observed_at: Date.now(), http_ready: true };
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(edge)));
  render(<QueryClientProvider client={client}><DeployProgressBanner /></QueryClientProvider>);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  act(() => deploymentRequested(0));
  expect(screen.getByTestId("deployment-progress")).toBeVisible();
  edge = { id: 266, status: "health_gate", observed_at: Date.now(), http_ready: false };
  act(() => deploymentRequested(266));
  await waitFor(() => expect(screen.getByTestId("deployment-progress")).toHaveTextContent("D266"));
  expect(fetch).toHaveBeenCalledWith("/__octopus/deploy", expect.objectContaining({ credentials: "omit" }));
  act(() => client.setQueryData(["edge-deployment"], { ...edge, status: "rolled_back", http_ready: true }));
  expect(await screen.findByText("本次升级未完成。请在工单页查看原因和实际版本。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "知道了" }));
  expect(screen.queryByTestId("deployment-progress")).toBeNull();
  client.clear();
});

it("does not present a stale successful snapshot as a completed deployment", async () => {
  sessionStorage.setItem("octopus-deploy-observed", "300"); sessionStorage.removeItem("octopus-deploy-dismissed");
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: 300, status: "succeeded", observed_at: Date.now() - 30_000, http_ready: true })));
  const client = createQueryClient();
  render(<QueryClientProvider client={client}><DeployProgressBanner /></QueryClientProvider>);
  expect(await screen.findByText("连接中，正在核对部署状态")).toBeVisible();
  expect(screen.queryByRole("button", { name: "知道了" })).toBeNull();
  client.clear();
});

function completedDeployment(createdAt: number) {
  sessionStorage.clear();
  sessionStorage.setItem("octopus-deploy-observed", "301");
  return { id: 301, status: "succeeded", created_at: new Date(createdAt).toISOString(), observed_at: Date.now(), http_ready: true };
}

it("keeps the refresh action in the original document, including a React remount", async () => {
  const edge = completedDeployment(performance.timeOrigin + 1000);
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(edge)));
  const client = createQueryClient();
  const view = () => <QueryClientProvider client={client}><DeployProgressBanner /></QueryClientProvider>;
  const first = render(view());
  expect(await screen.findByRole("button", { name: "刷新页面" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "知道了" })).toBeNull();
  first.unmount(); render(view());
  expect(screen.getByRole("button", { name: "刷新页面" })).toBeVisible();
  expect(vi.mocked(fetch).mock.calls.every(([url]) => url === "/__octopus/deploy")).toBe(true);
  expect(sessionStorage.getItem("octopus-deploy-dismissed")).toBeNull();
  client.clear();
});

it("automatically consumes success in a new document serving the current bundle", async () => {
  const edge = completedDeployment(performance.timeOrigin - 1000);
  vi.mocked(fetch).mockImplementation(async (url) => url === "/__octopus/deploy"
    ? new Response(JSON.stringify(edge))
    : new Response(JSON.stringify({ intent_id: null }), { headers: { [BUILD_ID_HEADER]: bootstrap.buildId } }));
  const client = createQueryClient();
  render(<QueryClientProvider client={client}><DeployProgressBanner /></QueryClientProvider>);
  await waitFor(() => expect(sessionStorage.getItem("octopus-deploy-dismissed")).toBe("301"));
  expect(screen.queryByTestId("deployment-progress")).toBeNull();
  client.clear();
});

it("does not consume success if an early refresh still loaded an old bundle", async () => {
  const edge = completedDeployment(performance.timeOrigin - 1000);
  vi.mocked(fetch).mockImplementation(async (url) => url === "/__octopus/deploy"
    ? new Response(JSON.stringify(edge))
    : new Response(JSON.stringify({ intent_id: null }), { headers: { [BUILD_ID_HEADER]: "new-server-build" } }));
  const client = createQueryClient();
  render(<QueryClientProvider client={client}><DeployProgressBanner /></QueryClientProvider>);
  await waitFor(() => expect(client.getQueryData(["deploy", "loaded-document", 301, bootstrap.buildId])).toBe(false));
  expect(screen.getByRole("button", { name: "刷新页面" })).toBeVisible();
  expect(sessionStorage.getItem("octopus-deploy-dismissed")).toBeNull();
  client.clear();
});

it("waits for the health gate even if the document already loaded the new bundle", async () => {
  const edge = { ...completedDeployment(performance.timeOrigin - 1000), status: "health_gate" };
  vi.mocked(fetch).mockImplementation(async (url) => url === "/__octopus/deploy"
    ? new Response(JSON.stringify(edge))
    : new Response(JSON.stringify({ intent_id: null }), { headers: { [BUILD_ID_HEADER]: bootstrap.buildId } }));
  const client = createQueryClient();
  render(<QueryClientProvider client={client}><DeployProgressBanner /></QueryClientProvider>);
  expect(await screen.findByTestId("deployment-progress")).toBeVisible();
  expect(sessionStorage.getItem("octopus-deploy-dismissed")).toBeNull();
  act(() => client.setQueryData(["edge-deployment"], { ...edge, status: "succeeded" }));
  await waitFor(() => expect(sessionStorage.getItem("octopus-deploy-dismissed")).toBe("301"));
  expect(screen.queryByTestId("deployment-progress")).toBeNull();
  client.clear();
});
