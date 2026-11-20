import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPage } from "../test-utils.js";
import { LoginPage } from "./LoginPage.js";
import { RegisterPage } from "./RegisterPage.js";

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
    dispatchEvent: () => false,
  }));
});

describe("pre-login identity screens", () => {
  it("offers GitHub only when the server says the https OAuth path exists", () => {
    const { rerender } = renderPage(
      <LoginPage rejected={false} reason={null} next="/tickets?mine=1" githubEnabled />,
    );
    expect(screen.getByRole("link", { name: "使用 GitHub 登录" })).toHaveAttribute(
      "href",
      "/auth/github?next=%2Ftickets%3Fmine%3D1",
    );

    rerender(<LoginPage rejected={false} reason={null} next="" githubEnabled={false} />);
    expect(screen.queryByRole("link", { name: "使用 GitHub 登录" })).toBeNull();
  });

  it("shows the verified label, username rule and an exact conflict error", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: '用户名 "taken" 已被使用' }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    renderPage(<RegisterPage label="octocat" error={null} />, "/register");
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText(/以小写字母开头/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent('用户名 "taken" 已被使用'));
  });
});
