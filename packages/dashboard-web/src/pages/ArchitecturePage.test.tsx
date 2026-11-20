import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { createQueryClient } from "../lib/query.js";
import { DashboardUiProvider } from "../ui-kit/UiProvider.js";
import { ArchitecturePage, type ArchitectureApiResponse } from "./ArchitecturePage.js";

const snapshot: ArchitectureApiResponse = {
  generated: true,
  job: null,
  snapshot: {
    meta: {
      commit: "1234567890",
      branch: "v4",
      dirty: false,
      generatedAt: "2026-08-13T00:00:00Z",
      totals: { files: 0, codeLoc: 0, symbols: 0, calls: 0, annotations: 0 },
    },
    zones: [],
    modules: [],
    dependencies: [],
    moduleEcosystem: {
      frontend: [],
      contracts: [],
      backend: [],
      dependencies: [],
      issues: [],
    },
    flows: [],
    constraints: [],
    findings: [],
    tcb: null,
    hotspots: [],
  },
};

describe("ArchitecturePage refresh failures", () => {
  it("opens on the clickable frontend/backend module atlas", () => {
    const client = createQueryClient();
    client.setQueryData(["architecture"], snapshot);

    render(
      <QueryClientProvider client={client}>
        <DashboardUiProvider>
          <MemoryRouter>
            <ArchitecturePage />
          </MemoryRouter>
        </DashboardUiProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("tab", { name: "模组" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/这份快照还没有模组目录/)).toBeInTheDocument();
  });

  it("keeps the last snapshot and selected child view mounted", async () => {
    const client = createQueryClient();
    client.setQueryData(["architecture"], snapshot);
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={client}>
        <DashboardUiProvider>
          <MemoryRouter>
            <ArchitecturePage />
          </MemoryRouter>
        </DashboardUiProvider>
      </QueryClientProvider>,
    );

    const overview = screen.getByRole("tab", { name: "总览" });
    await user.click(overview);
    expect(overview).toHaveAttribute("aria-selected", "true");

    const cached = client.getQueryCache().find({ queryKey: ["architecture"], exact: true });
    expect(cached).toBeDefined();
    await act(async () => {
      cached!.setState({
        error: new Error("refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: cached!.state.errorUpdateCount + 1,
        fetchStatus: "idle",
        status: "error",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await screen.findByText(/刷新失败，显示的是 \d{2}:\d{2} 的数据：refresh failed/))
      .toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "总览" })).toHaveAttribute("aria-selected", "true");
  });
});
