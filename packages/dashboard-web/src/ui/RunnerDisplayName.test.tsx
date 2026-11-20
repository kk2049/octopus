import { expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage, stubApi } from "../test-utils.js";
import { RunnerDisplayName } from "./RunnerDisplayName.js";

it("saves a display name against the original owner/device identity", async () => {
  const { calls } = stubApi({ "/api/runner-display-name": { ok: true, display_name: "aliyun" } });
  const onSaved = vi.fn(async () => {});
  renderPage(<RunnerDisplayName username="alice" device="aws-workbench" displayName="Old display" canEdit onSaved={onSaved} />);
  expect(screen.getByText("Old display")).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "修改显示名" }));
  const name = screen.getByRole("textbox", { name: "设备显示名" });
  await user.clear(name);
  await user.type(name, "aliyun");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(calls).toHaveLength(1);
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    username: "alice", device: "aws-workbench", display_name: "aliyun",
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("keeps the entered name and shows a refusal without retrying", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "需要本人操作" }),
    { status: 403, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const onSaved = vi.fn(async () => {});
  renderPage(<RunnerDisplayName username="alice" device="aws-workbench" canEdit onSaved={onSaved} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "修改显示名" }));
  const name = screen.getByRole("textbox", { name: "设备显示名" });
  await user.clear(name);
  await user.type(name, "aliyun");
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText("需要本人操作")).toBeInTheDocument();
  expect(name).toHaveValue("aliyun");
  expect(fetch).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
});

it("falls back to the stable device name and offers no edit for a read-only row", () => {
  renderPage(<RunnerDisplayName username="alice" device="aws-workbench" canEdit={false} onSaved={async () => {}} />);
  expect(screen.getByText("aws-workbench")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "修改显示名" })).not.toBeInTheDocument();
});
