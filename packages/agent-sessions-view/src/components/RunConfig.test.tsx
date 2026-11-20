import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ModelChoice } from "@claude-bot/agent-sessions-contract";
import { ModelPicker } from "./RunConfig.js";

it("keeps the user's model and focus when discovery disappears or replaces the catalog", () => {
  function Picker({ models }: { models?: readonly ModelChoice[] }) {
    const [value, setValue] = useState("");
    return <ModelPicker aria-label="Model" source="codex" value={value} onValue={setValue} models={models} />;
  }
  const view = render(<Picker models={[{ value: "local-model", label: "Local" }]} />);
  const picker = screen.getByRole("combobox");
  picker.focus();
  fireEvent.change(picker, { target: { value: "local-model" } });
  view.rerender(<Picker />);
  expect(picker).toHaveValue("local-model");
  expect(picker).toHaveFocus();
  expect(screen.getByRole("option", { name: "GPT-6 Astra" })).toBeInTheDocument();
  view.rerender(<Picker models={[{ value: "new-model", label: "New" }]} />);
  expect(picker).toHaveValue("local-model");
  expect(picker).toHaveFocus();
  expect(screen.queryByRole("option", { name: "GPT-6 Astra" })).toBeNull();
});
