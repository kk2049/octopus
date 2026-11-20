import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ArchFrontendModule } from "../ArchitecturePage.js";
import { FrontendModuleDemo } from "./FrontendModuleDemo.js";

function frontend(overrides: Partial<ArchFrontendModule>): ArchFrontendModule {
  return {
    id: "session.search/v1",
    title: "搜索",
    version: "1.0.0",
    implementation: "@demo/view#Search",
    packageId: "@demo/view",
    packagePath: "packages/view",
    slots: ["navigation"],
    ports: [],
    opens: [],
    summary: "搜索已有会话。",
    preview: "search",
    configKeys: [],
    source: { path: "packages/view/src/manifests.ts", line: 1 },
    ...overrides,
  };
}

describe("FrontendModuleDemo", () => {
  it("renders a searchable live example instead of decorative placeholder bars", () => {
    render(<FrontendModuleDemo module={frontend({})} />);

    expect(screen.getByRole("region", { name: "搜索 的交互最小示例" })).toBeInTheDocument();
    const input = screen.getByRole("searchbox", { name: "搜索会话" });
    fireEvent.change(input, { target: { value: "#95" } });
    expect(screen.getByRole("button", { name: /工单 #95/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Session Plus/ })).not.toBeInTheDocument();
  });

  it("keeps board interaction local to the fake-data demo", () => {
    render(<FrontendModuleDemo module={frontend({ id: "board.grid/v1", title: "网格盘面", preview: "board" })} />);

    fireEvent.click(screen.getByRole("button", { name: "e4 ♙" }));
    expect(screen.getByText("已选择 e4")).toBeInTheDocument();
  });

  it("submits a form only to in-memory status", () => {
    render(<FrontendModuleDemo module={frontend({ id: "session.new/v1", title: "启动新的本地 Agent", preview: "form" })} />);

    fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));
    expect(screen.getByRole("status")).toHaveTextContent("示例已接收：检查架构快照");
  });
});
