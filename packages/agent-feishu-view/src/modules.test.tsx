import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LayoutPanel, WorkspaceApi } from "@claude-bot/agent-view-react/workspace";
import { FeishuDocumentModule } from "./modules.js";

const workspace = { open: () => true } as unknown as WorkspaceApi;
const panel: LayoutPanel = {
  panelId: "feishu-1", moduleId: "feishu.document-link/v1", slot: "secondary",
  resourceRef: "https://acme.feishu.cn/docx/Abcdef123", resourceKind: "feishu-document",
  label: "发布方案", status: "ready", reason: "", detail: "", config: null, context: null,
};

describe("FeishuDocumentModule", () => {
  it("renders the canonical link without an iframe or active network surface", () => {
    const { container } = render(<FeishuDocumentModule panel={panel} workspace={workspace} />);
    expect(screen.getByRole("heading", { name: "发布方案" })).toBeInTheDocument();
    expect(screen.getByLabelText("飞书文档链接")).toHaveValue(panel.resourceRef);
    expect(container.querySelector("iframe, script, form")).toBeNull();
  });

  it("copies through the browser clipboard only after a user gesture", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await userEvent.click(render(<FeishuDocumentModule panel={panel} workspace={workspace} />).getByRole("button"));
    expect(writeText).toHaveBeenCalledWith(panel.resourceRef);
  });
});
