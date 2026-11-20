import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/query.js";
import { SystemStatus, systemSeverity } from "./SystemStatus.js";

function renderStatus() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <SystemStatus />
    </QueryClientProvider>,
  );
}

describe("system status severity", () => {
  it("uses quiet, warning and critical bands for host pressure", () => {
    expect(systemSeverity(0)).toBe("normal");
    expect(systemSeverity(74)).toBe("normal");
    expect(systemSeverity(75)).toBe("warning");
    expect(systemSeverity(89)).toBe("warning");
    expect(systemSeverity(90)).toBe("critical");
    expect(systemSeverity(140)).toBe("critical");
  });
});

describe("SystemStatus", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      hostname: "octopus-main",
      cpuPercent: 37,
      memoryPercent: 82,
      windowMs: 10_040,
      sampledAt: "2026-08-21T12:00:00.000Z",
      hosts: [
        {
          id: "main",
          label: "主站",
          kind: "main",
          sources: [],
          hostname: "octopus-main",
          cpuPercent: 37,
          memoryPercent: 82,
          windowMs: 10_040,
          sampledAt: "2026-08-21T12:00:00.000Z",
        },
        {
          id: "runner:build-one",
          label: "build-runner",
          kind: "runner",
          sources: ["claude", "codex", "omp"],
          hostname: "build-one",
          cpuPercent: 71,
          memoryPercent: 91,
          windowMs: 15_000,
          sampledAt: "2026-08-21T12:00:05.000Z",
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  });

  it("shows compact CPU and memory percentages with exact sampling semantics", async () => {
    renderStatus();
    const panel = await screen.findByRole("group", { name: "机器资源状态" });
    expect(panel).toHaveTextContent("主站CPU37%内存82%");
    expect(panel).toHaveTextContent("build-runnerClaude / Codex / OMPCPU71%内存91%");
    expect(screen.getByLabelText("主站 · CPU:最近 10 秒平均,37%")).toHaveAttribute(
      "title",
      "主站 · CPU · 最近 10 秒平均 · 37%",
    );
    expect(screen.getByLabelText("主站 · 内存:当前使用,82%")).toHaveAttribute(
      "title",
      "主站 · 内存 · 当前使用 · 82%",
    );
    expect(screen.getByLabelText("主站 · 内存:当前使用,82%").className).toContain("warning");
    expect(screen.getByLabelText("build-runner · 内存:当前使用,91%").className).toContain("critical");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/dev/system-status", expect.anything());
  });

  it("keeps working against the legacy main-host-only response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      cpuPercent: 12,
      memoryPercent: 34,
      windowMs: 10_000,
      sampledAt: "2026-08-21T12:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    renderStatus();
    expect(await screen.findByLabelText("主站 · CPU:最近 10 秒平均,12%")).toBeInTheDocument();
  });
});
