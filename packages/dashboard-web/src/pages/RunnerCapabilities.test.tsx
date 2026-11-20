import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunnerCapabilities } from "./RunnerCapabilities.js";
import type { RunnerCapabilityView } from "../contract.js";
const rows: RunnerCapabilityView[] = [{ kind: "extension", id: "demo", title: "Demo", version: "1",
  revision: "a".repeat(32), status: "ready", tools: [{ name: "echo", description: "<script>unsafe</script>", inputSchema: { type: "object" } }] }];
describe("Runner capability view", () => {
  it("keeps disclosure and search state through inventory updates and renders schemas as text", () => {
    const view = render(<RunnerCapabilities capabilities={rows} online hotRegistration />);
    const root = screen.getByText(/Runner 能力/).closest("details")!;
    root.open = true;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "echo" } });
    const provider = screen.getByText("Demo").closest("details")!;
    provider.open = true;
    view.rerender(<RunnerCapabilities capabilities={[{ ...rows[0]!, version: "2", revision: "b".repeat(32) }]} online hotRegistration />);
    expect(root.open).toBe(true);
    expect(provider.open).toBe(true);
    expect(screen.getByRole("textbox")).toHaveValue("echo");
    expect(screen.getByText("<script>unsafe</script>")).toBeInTheDocument();
    expect(view.container.querySelector("script")).toBeNull();
    expect(screen.getByText(/inputSchema/)).toBeInTheDocument();
  });
  it("does not advertise availability when the device is offline or inventory is missing", () => {
    render(<RunnerCapabilities online={false} hotRegistration={false} />);
    expect(screen.getByText("设备离线，当前能力不可调用。")).toBeInTheDocument();
    expect(screen.getByText("尚未收到能力目录。")).toBeInTheDocument();
    expect(screen.getByText("此设备尚未上报热注册支持。")).toBeInTheDocument();
  });
});
