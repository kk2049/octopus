import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UiButton, UiCheckbox, UiInput, UiSelect } from "./primitives.js";
import styles from "./primitives.module.css";

describe("UiButton", () => {
  it("maps product intent to Ant while preserving the existing DOM hook", async () => {
    const onClick = vi.fn();
    render(
      <UiButton tone="primary" onClick={onClick}>
        保存
      </UiButton>,
    );

    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("ant-btn", "ant-btn-primary", "primary");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("uses Ant's real loading state instead of label-only feedback", () => {
    render(<UiButton loading>检查中</UiButton>);
    const button = screen.getByRole("button", { name: "检查中" });
    expect(button).toBeDisabled();
    expect(button.querySelector(".ant-btn-loading-icon")).not.toBeNull();
  });
});

describe("ordinary control adapters", () => {
  it("keeps native input and checkbox semantics while Ant owns their rendering", async () => {
    const onChecked = vi.fn();
    render(
      <>
        <label htmlFor="name">名称</label>
        <UiInput id="name" />
        <UiCheckbox onChange={(event) => onChecked(event.target.checked)}>允许读取</UiCheckbox>
      </>,
    );

    expect(screen.getByRole("textbox", { name: "名称" })).toHaveClass("ant-input");
    await userEvent.click(screen.getByRole("checkbox", { name: "允许读取" }));
    expect(onChecked).toHaveBeenCalledWith(true);
  });

  it("exposes a product-level value callback for Ant selects", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <UiSelect
        aria-label="主题"
        value="classic"
        options={[
          { value: "classic", label: "经典" },
          { value: "ink", label: "Ink" },
        ]}
        onValueChange={onValueChange}
      />,
    );

    const combobox = screen.getByRole("combobox", { name: "主题" });
    expect(combobox.closest(".ant-select")).toHaveTextContent("经典");
    await user.click(combobox);
    await user.click(await screen.findByText("Ink"));
    expect(onValueChange).toHaveBeenCalledWith("ink");
  });
});

/**
 * `primitives.module.css` reaches past the adapter and addresses Ant's own
 * class names by hand. Nothing else checks that those names still exist: a
 * rule that matches zero elements is not a failure, it is silence.
 *
 * Ticket #202 is what that silence costs. After the Ant v5 → v6 upgrade the
 * Select overrides still named `.ant-select-selector` and
 * `.ant-select-selection-item`, which v6 does not render for a single choice,
 * so three separate attempts to fix an unreadable model/effort picker changed
 * nothing on screen while every test stayed green — the existing assertions
 * are `toHaveTextContent`, and text content is exactly what a `color`/`opacity`
 * defect leaves intact. (That is also why the value could still be copied out
 * of a control that looked empty.)
 *
 * So: render every state the stylesheet talks about and require each Ant class
 * it names to actually appear. The next upgrade that renames one fails here
 * instead of on somebody's screen.
 */
describe("Select style hooks", () => {
  // Keep the asset name out of `new URL(..., import.meta.url)`: Vite rewrites
  // that static pattern to an HTTP URL in jsdom, which Node cannot read.
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "primitives.module.css"),
    "utf8",
  );

  /**
   * Declarations only — the comments in that file deliberately name the dead v5
   * classes to explain why they are gone, and those must not be required here.
   */
  function antSelectClassesStyledHere(): string[] {
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
    return [
      ...new Set([...declarations.matchAll(/\.(ant-select[\w-]*)/g)].map((match) => match[1]!)),
    ].sort();
  }

  it("only addresses Ant class names that a rendered Select really has", async () => {
    const user = userEvent.setup();
    const rendered = new Set<string>();
    const collect = () => {
      for (const node of document.body.querySelectorAll("[class]")) {
        for (const name of node.classList) rendered.add(name);
      }
    };

    // A chosen value with the dropdown open: `.ant-select`, `.ant-select-open`
    // and `.ant-select-content-has-value` — the trigger row people complained
    // about, in the state where v6 dims it.
    const chosen = render(
      <UiSelect
        aria-label="模型"
        value="opus"
        options={[
          { value: "opus", label: "模型: Opus 4.7" },
          { value: "codex", label: "模型: Codex" },
        ]}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "模型" }));
    await screen.findByText("模型: Codex");
    collect();
    chosen.unmount();

    // No value: `.ant-select-placeholder`, which v6 renamed from v5's
    // `.ant-select-selection-placeholder`.
    render(<UiSelect aria-label="模型" placeholder="选择模型" options={[]} />);
    await screen.findByText("选择模型");
    collect();

    const styled = antSelectClassesStyledHere();
    expect(styled).toContain("ant-select-content-has-value");
    expect(styled.filter((name) => !rendered.has(name))).toEqual([]);
  });
});

it("keeps long wrapped choices and the selected state readable when reopened", async () => {
  const longLabel = "Agent source: AWS · codex · independently registered account with a long name";
  render(<UiSelect aria-label="Source" wrapLabels value="aws" options={[
    { value: "aws", label: longLabel }, { value: "other", label: "Other" },
  ]} />);
  const source = screen.getByRole("combobox", { name: "Source" });
  expect(source.closest(".ant-select")).toHaveClass(styles.selectWrap);
  expect(source.closest(".ant-select")).toHaveTextContent(longLabel);
  await userEvent.click(source);
  const selected = screen.getByRole("option", { name: longLabel });
  expect(selected).toHaveAttribute("aria-selected", "true");
  expect(selected.querySelector(`.${styles.selectOptionLabel}`)).toHaveTextContent(longLabel);
});

it("leaves the Select keyboard layer transparent under native input and focus styling", async () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "primitives.module.css"), "utf8");
  const style = document.createElement("style");
  style.textContent = `
    input, input:focus { background: white; border: 1px solid blue; box-shadow: inset 0 0 0 10px white; min-height: 44px; }
    ${css.replace(/:global\(([^)]+)\)/g, "$1").replace(/\.select(?=[\s:.{])/g, `.${styles.select}`)}
  `;
  document.head.append(style);
  try {
    render(<UiSelect aria-label="Model" value="codex" options={[{ value: "codex", label: "Codex" }]} />);
    const input = screen.getByRole("combobox", { name: "Model" });
    expect(input).toHaveClass("ant-select-input");
    await userEvent.click(input);
    expect(input).toHaveFocus();
    const computed = getComputedStyle(input);
    expect(computed.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(computed.borderTopWidth).toBe("0px");
    expect(computed.boxShadow).toBe("none");
    expect(computed.minHeight).toBe("0");
  } finally {
    style.remove();
  }
});
