import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HardRefreshAction } from "./HardRefreshAction.js";

/**
 * Ticket #180. The old ↻ refetched three queries that already poll every
 * 5–10 seconds, so pressing it changed nothing on screen and could not pick up
 * a redeployed panel — which is how it came to be reported as not working.
 */
describe("ticket page hard refresh", () => {
  it("reloads the document immediately when there is nothing to lose", async () => {
    const reload = vi.fn();
    const user = userEvent.setup();
    render(<HardRefreshAction draftAtRisk={false} reload={reload} />);

    await user.click(screen.getByRole("button", { name: "重新加载页面" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("acknowledges the press and refuses to queue a second navigation", async () => {
    const reload = vi.fn();
    const user = userEvent.setup();
    render(<HardRefreshAction draftAtRisk={false} reload={reload} />);
    const button = screen.getByRole("button", { name: "重新加载页面" });

    await user.click(button);
    expect(button).toBeDisabled(); // the tap is visibly received while the document goes away
    await user.click(button);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("asks first when an unsent draft would be destroyed", async () => {
    const reload = vi.fn();
    const user = userEvent.setup();
    render(<HardRefreshAction draftAtRisk reload={reload} />);

    await user.click(screen.getByRole("button", { name: "重新加载页面" }));
    expect(reload).not.toHaveBeenCalled();
    expect(await screen.findByText(/没发出的内容/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(reload).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重新加载页面" }));
    await user.click(await screen.findByRole("button", { name: "重新加载" }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
