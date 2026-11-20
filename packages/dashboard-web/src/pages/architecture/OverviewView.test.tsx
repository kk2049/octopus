import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewView } from "./OverviewView.js";
import type { SafeView } from "./model.js";

const snap: SafeView = {
  meta: undefined,
  zones: [{ id: "web", label: "浏览器", trust: "untrusted", color: "#fff" }],
  modules: [{
    id: "dashboard-web",
    label: "Dashboard Web",
    description: "可信面板浏览器层",
    zone: "web",
    criticality: "normal",
    tags: [],
    docs: [],
    files: 2,
    codeLoc: 100,
    testFiles: 1,
    gitTouches: 3,
    runtimeFanIn: 1,
    runtimeFanOut: 1,
    typeOnlyFanIn: 0,
    typeOnlyFanOut: 0,
    fanIn: 1,
    fanOut: 1,
    annotations: 0,
  }],
  dependencies: [],
  moduleEcosystem: { frontend: [], contracts: [], backend: [], dependencies: [], issues: [] },
  flows: [],
  constraints: [],
  findings: [],
  tcb: null,
  hotspots: [],
};

describe("Architecture overview module interaction", () => {
  it("keeps a plain click on the module and captures only after drag slop", () => {
    const select = vi.fn();
    const capture = vi.fn();
    Object.defineProperty(SVGSVGElement.prototype, "setPointerCapture", {
      configurable: true,
      value: capture,
    });
    render(<OverviewView snap={snap} selected={null} onSelectModule={select} />);

    const module = screen.getByRole("button", { name: "模块 Dashboard Web" });
    fireEvent.pointerDown(module, { pointerId: 7, button: 0, clientX: 10, clientY: 10 });
    expect(capture).not.toHaveBeenCalled();
    fireEvent.click(module);
    expect(select).toHaveBeenCalledWith("dashboard-web");

    const svg = screen.getByRole("img", { name: /circle packing/ });
    fireEvent.pointerMove(svg, { pointerId: 7, clientX: 20, clientY: 10 });
    expect(capture).toHaveBeenCalledWith(7);
  });
});
