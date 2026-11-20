import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, resetSessionExpiredForTests } from "../lib/api.js";
import { SessionExpiredOverlay } from "./Shell.js";

describe("SessionExpiredOverlay", () => {
  beforeEach(() => {
    resetSessionExpiredForTests();
  });

  it("keeps the focused draft until the user explicitly chooses login", async () => {
    const navigate = vi.fn();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<><SessionExpiredOverlay navigate={navigate} /><textarea aria-label="draft" defaultValue="half a prompt" /></>);
    const draft = screen.getByRole("textbox");
    draft.focus();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await act(async () => {
      await api("/api/overview").catch(() => undefined);
    });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("登录已过期");
    expect(screen.getByRole("button", { name: "前往登录" })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(draft).toHaveFocus();
    expect(draft).toHaveValue("half a prompt");
    fireEvent.click(screen.getByRole("button", { name: "前往登录" }));
    expect(navigate).toHaveBeenCalledWith("/login?next=%2F");
  });
});
