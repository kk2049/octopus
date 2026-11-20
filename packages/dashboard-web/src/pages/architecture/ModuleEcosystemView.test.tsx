import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ArchModuleEcosystem } from "../ArchitecturePage.js";
import { ModuleEcosystemView } from "./ModuleEcosystemView.js";

const ECOSYSTEM: ArchModuleEcosystem = {
  frontend: [{
    id: "demo.viewer/v1",
    title: "Viewer",
    version: "1.0.0",
    implementation: "@demo/view#Viewer",
    packageId: "@demo/view",
    packagePath: "packages/view",
    slots: ["primary"],
    ports: [{ id: "demo/v1", packageId: "@demo/contract" }],
    opens: ["demo"],
    summary: "用于打开 demo 资源的 Viewer 视图。",
    preview: "detail",
    configKeys: ["source"],
    source: { path: "packages/view/src/manifests.ts", line: 4 },
  }],
  contracts: [{
    id: "demo/v1",
    packageId: "@demo/contract",
    packagePath: "packages/contract",
    summary: "读取演示数据。",
    actions: [{ id: "read", summary: "读取数据", operation: "read_demo" }],
    source: { path: "packages/contract/src/index.ts", line: 1 },
    provision: "trusted-provider",
  }],
  backend: [{
    id: "@demo/backend#demoProvider:demo/v1",
    name: "demoProvider",
    summary: "可信后端：读取演示数据。",
    packageId: "@demo/backend",
    path: "packages/backend/src/provider.ts",
    files: 1,
    loc: 40,
    kind: "provider",
    contracts: ["demo/v1"],
    actions: [{ id: "read", summary: "读取数据", operation: "read_demo" }],
    registered: true,
    dependencies: [],
    source: { path: "packages/backend/src/provider.ts", line: 8 },
  }],
  dependencies: [
    { from: "frontend:@demo/view:demo.viewer/v1", to: "contract:demo/v1", kind: "requires", label: "demo/v1" },
    { from: "contract:demo/v1", to: "backend:@demo/backend#demoProvider:demo/v1", kind: "provides", label: "可信实现" },
  ],
  issues: [],
};

describe("ModuleEcosystemView", () => {
  it("renders the automatic catalog and exposes node details on click", () => {
    render(<ModuleEcosystemView ecosystem={ECOSYSTEM} />);
    expect(screen.getByRole("img", { name: "View 模组、类型契约与可信 Provider 的拓扑依赖图" })).toBeInTheDocument();
    expect(screen.getByText("1 个 View 模组 · 1 个 typed contract · 1 个可信 Provider")).toBeInTheDocument();
    expect(screen.getByText(/图中关系不授予权限/)).toBeInTheDocument();

    const frontend = screen.getByRole("button", { name: "前端模组 Viewer" });
    const hitTarget = frontend.querySelector("rect");
    // Regression: spreading the layout's {w,h} onto <rect> produced unknown
    // attributes and a zero-area shape. Text remained visible, but the parent
    // SVG won browser hit testing, so every real pointer click was swallowed.
    expect(hitTarget).toHaveAttribute("width", "252");
    expect(hitTarget).toHaveAttribute("height", "33");
    expect(hitTarget).not.toHaveAttribute("w");
    expect(hitTarget).not.toHaveAttribute("h");

    fireEvent.click(frontend);
    expect(screen.getAllByText("demo.viewer/v1")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Viewer 的交互最小示例" })).toBeInTheDocument();
    expect(screen.getByText("自动分析完成")).toBeInTheDocument();
    expect(screen.getByText(/仅依赖这个接口/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "可信 Provider demoProvider" }));
    expect(screen.getByText("已注册")).toBeInTheDocument();
    expect(screen.getByText(/资源调用仍经过 Capability Gate/)).toBeInTheDocument();
  });
});
