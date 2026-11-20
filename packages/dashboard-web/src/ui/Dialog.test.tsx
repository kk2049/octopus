import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Dialog } from "./Dialog.js";

describe("Dialog drawer focus cycle", () => {
  it("wraps Tab and Shift+Tab inside the drawer", async () => {
    const user = userEvent.setup();
    render(
      <Dialog
        open
        variant="drawer"
        title="Permission explanation"
        onOpenChange={() => undefined}
        footer={<button type="button">Apply proposal</button>}
      >
        <button type="button">Change mode</button>
      </Dialog>,
    );

    const dialog = await screen.findByRole("dialog");
    const close = dialog.querySelector<HTMLElement>(".ant-drawer-close");
    const apply = within(dialog).getByRole("button", { name: "Apply proposal" });
    expect(close).not.toBeNull();

    apply.focus();
    await user.tab();
    expect(close).toHaveFocus();

    close!.focus();
    await user.tab({ shift: true });
    expect(apply).toHaveFocus();
  });
});
