import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage } from "../../test-utils.js";
import { SubjectOps, type Subject } from "./SubjectOps.js";

const subject: Subject = {
  id: "app", type: "app", title: "App", description: "", editable: true, enforced: true,
  permissions: { requestedCount: 1, grantedCount: 1, effectiveCount: 0, entries: [{
    operation: "read", title: "读取", description: "", risk: "读取私密内容", granted: true, effective: false, explanation: "已撤销设备",
  }] },
};

it("retains bulk selection after a refused save and exposes the server reason", async () => {
  const user = userEvent.setup();
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "当前契约已更换，请重新检查" }), { status: 409 }));
  const message = vi.fn();
  const changed = vi.fn(async () => {});
  renderPage(<SubjectOps subject={subject} editable owner="alice" onChanged={changed} onMessage={message} />);
  await user.click(screen.getByRole("button", { name: "全不选" }));
  await user.click(screen.getByRole("button", { name: "保存授权" }));
  await waitFor(() => expect(message).toHaveBeenCalledWith("err", expect.stringContaining("当前契约已更换")));
  expect(screen.getByRole("checkbox", { name: "授权 读取" })).not.toBeChecked();
  expect(changed).not.toHaveBeenCalled();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

describe("authoritative refresh after saving", () => {
  it("locks selection during the request and adopts the refreshed grant", async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const message = vi.fn();
    const changed = vi.fn();
    function Harness() {
      const [current, setCurrent] = useState(subject);
      return <SubjectOps subject={current} editable owner="alice" onMessage={message} onChanged={async () => {
        changed();
        setCurrent({ ...subject, permissions: { ...subject.permissions, grantedCount: 0,
          entries: subject.permissions.entries.map((entry) => ({ ...entry, granted: false })),
        } });
      }} />;
    }
    const view = renderPage(<Harness />);
    await user.click(screen.getByRole("button", { name: "全不选" }));
    await user.click(screen.getByRole("button", { name: "保存授权" }));
    expect(screen.getByRole("button", { name: "全选" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全部撤销" })).toBeDisabled();
    finish(new Response(JSON.stringify({ diff: { added: [], removed: ["read"] } }), { status: 200 }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    // The fresh authoritative frame is the baseline after the successful write.
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "授权 读取" })).not.toBeChecked());
    view.unmount();
  });
});
