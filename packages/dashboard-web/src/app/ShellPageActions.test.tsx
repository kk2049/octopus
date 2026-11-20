import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bootstrap } from "../lib/bootstrap.js";
import { renderPage } from "../test-utils.js";
import { Shell, ShellPageActions } from "./Shell.js";

describe("Shell page actions", () => {
  it("portals a page-owned action into the permanent trusted navigation row", () => {
    (bootstrap as { approvals: boolean; features: string[] }).approvals = false;
    (bootstrap as { approvals: boolean; features: string[] }).features = [];

    renderPage(
      <Shell>
        <ShellPageActions>
          <button type="button">刷新工单</button>
        </ShellPageActions>
      </Shell>,
      "/tickets",
    );

    expect(screen.getByRole("button", { name: "刷新工单" }).closest("[data-shell-page-actions]"))
      .toBeInTheDocument();
  });
});
