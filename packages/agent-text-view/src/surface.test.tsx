import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { CodeMirrorTextSurface } from "./components/CodeMirrorTextSurface.js";
import { DocumentPane } from "./components/DocumentPane.js";

vi.mock("@claude-bot/agent-view-react/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claude-bot/agent-view-react/ui")>();
  return { ...actual, documentStyleNonce: () => "textview_nonce_2026" };
});

const surface = (overrides: Partial<ComponentProps<typeof CodeMirrorTextSurface>> = {}) => (
  <CodeMirrorTextSurface
    doc={"alpha beta\nsecond alpha\n"}
    docKey="opaque-ref|sha256:a"
    readOnly
    line={null}
    lineToken=""
    {...overrides}
  />
);

describe("CodeMirrorTextSurface", () => {
  it("only highlights occurrences during explicit search, never on cursor placement or selection", async () => {
    render(surface());

    expect(document.querySelectorAll(".cm-lineNumbers .cm-gutterElement").length).toBeGreaterThanOrEqual(2);
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    const editor = EditorView.findFromDOM(content)!;
    expect(document.querySelector(".cm-selectionMatch, .cm-searchMatch")).toBeNull();
    act(() => editor.dispatch({ selection: { anchor: 0, head: 5 } }));
    expect(document.querySelector(".cm-selectionMatch, .cm-searchMatch, .cm-search")).toBeNull();

    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "查找内容" })).toHaveValue("alpha");
    expect(document.querySelectorAll(".cm-searchMatch")).toHaveLength(2);
    // CodeMirror derives this panel from the read-only state. A viewer must not
    // offer a replacement that it cannot persist.
    expect(document.querySelector('.cm-search input[name="replace"]')).toBeNull();
    expect(document.querySelector('.cm-search button[name="replace"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "下一处" }));
    expect(editor.state.selection.main.from).toBe(18);
    await userEvent.click(screen.getByRole("button", { name: "上一处" }));
    expect(editor.state.selection.main.from).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "关闭查找" }));
    expect(document.querySelector(".cm-searchMatch, .cm-selectionMatch, .cm-search")).toBeNull();
    expect(document.activeElement).toBe(content);
  });

  it("preserves the search draft, options and field selection when permission changes", async () => {
    const rendered = render(surface({ readOnly: false }));
    await userEvent.click(screen.getByRole("button", { name: "查找" }));
    const search = screen.getByRole("textbox", { name: "查找内容" });
    await userEvent.type(search, "alpha|beta");
    await userEvent.click(screen.getByRole("checkbox", { name: "正则表达式" }));
    await userEvent.type(screen.getByRole("textbox", { name: "替换为" }), "replacement");
    await userEvent.click(search);
    (search as HTMLInputElement).setSelectionRange(1, 4);
    // The document selection must not replace a partially edited search query.
    act(() => EditorView.findFromDOM(document.querySelector(".cm-content")!)!
      .dispatch({ selection: { anchor: 0, head: 5 } }));

    rendered.rerender(surface({ readOnly: true }));
    const nextSearch = screen.getByRole("textbox", { name: "查找内容" }) as HTMLInputElement;
    expect(nextSearch).toHaveValue("alpha|beta");
    expect(nextSearch).toHaveFocus();
    expect([nextSearch.selectionStart, nextSearch.selectionEnd]).toEqual([1, 4]);
    expect(screen.getByRole("checkbox", { name: "正则表达式" })).toBeChecked();
    expect(screen.queryByRole("textbox", { name: "替换为" })).toBeNull();

    rendered.rerender(surface({ readOnly: false }));
    expect(screen.getByRole("textbox", { name: "替换为" })).toHaveValue("replacement");
    await userEvent.click(screen.getByRole("button", { name: "全部替换" }));
    expect(document.querySelector(".cm-content")).toHaveTextContent("replacement replacementsecond replacement");
  });

  it("does not rebuild search or steal document focus when saving becomes available", async () => {
    const rendered = render(surface({ readOnly: false }));
    await userEvent.click(screen.getByRole("button", { name: "查找" }));
    const search = screen.getByRole("textbox", { name: "查找内容" });
    await userEvent.type(search, "alpha");
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.click(content);

    rendered.rerender(surface({ readOnly: false, onSave: () => true }));
    expect(screen.getByRole("textbox", { name: "查找内容" })).toBe(search);
    expect(content).toHaveFocus();
    expect(search).toHaveValue("alpha");
  });

  it("does not move focus from another document's search on permission changes", async () => {
    const pair = (readOnly: boolean) => <>
      {surface({ readOnly, domIdScope: "first" })}
      {surface({ docKey: "second", domIdScope: "second" })}
    </>;
    const rendered = render(pair(false));
    for (const button of screen.getAllByRole("button", { name: "查找" })) {
      await userEvent.click(button);
    }
    const otherSearch = screen.getAllByRole("textbox", { name: "查找内容" })[1];
    await userEvent.type(otherSearch, "other");

    rendered.rerender(pair(true));
    expect(otherSearch).toHaveFocus();
    expect(otherSearch).toHaveValue("other");
  });

  it("keeps one editor mounted while wrap changes", async () => {
    render(surface());
    const root = document.querySelector(".av-text-surface")!;
    const editor = root.querySelector(".cm-editor");
    expect(root).toHaveAttribute("data-wrap", "1");

    await userEvent.click(screen.getByRole("button", { name: "关闭自动换行" }));
    expect(root).toHaveAttribute("data-wrap", "0");
    expect(root.querySelector(".cm-editor")).toBe(editor);

    await userEvent.click(screen.getByRole("button", { name: "开启自动换行" }));
    expect(root).toHaveAttribute("data-wrap", "1");
    expect(root.querySelector(".cm-editor")).toBe(editor);
  });

  it("registers Mod-S and replacement only for an editable surface", async () => {
    const save = vi.fn(() => true);
    const view = render(surface({ readOnly: false, onSave: save }));
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    fireEvent.keyDown(content, { key: "s", code: "KeyS", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith("alpha beta\nsecond alpha\n");

    await userEvent.click(screen.getByRole("button", { name: "查找" }));
    expect(document.querySelector('.cm-search input[name="replace"]')).toBeInstanceOf(HTMLInputElement);

    view.rerender(surface({ readOnly: true, onSave: save }));
    fireEvent.keyDown(content, { key: "s", code: "KeyS", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.cm-search input[name="replace"]')).toBeNull();
  });

  it("round-trips an existing CRLF convention through an explicit save", async () => {
    const save = vi.fn(() => true);
    render(surface({ doc: "first\r\nsecond\r\n", readOnly: false, onSave: save }));
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.click(content);
    await userEvent.type(content, "x");
    fireEvent.keyDown(content, { key: "s", code: "KeyS", ctrlKey: true });

    expect(save).toHaveBeenCalledWith("xfirst\r\nsecond\r\n");
  });

  it("numbers every mixed-EOL line and saves with the first existing convention", async () => {
    const save = vi.fn(() => true);
    const view = render(surface({
      doc: "first\r\nsecond\nthird\rfourth",
      cleanToken: "sha256:old",
      readOnly: false,
      onSave: save,
    }));
    const numbers = [...document.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")]
      .filter((element) => element.style.visibility !== "hidden")
      .map((element) => element.textContent);
    expect(numbers).toEqual(["1", "2", "3", "4"]);

    const content = document.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.click(content);
    await userEvent.type(content, "x");
    fireEvent.keyDown(content, { key: "s", code: "KeyS", ctrlKey: true });
    const saved = "xfirst\r\nsecond\r\nthird\r\nfourth";
    expect(save).toHaveBeenCalledWith(saved);

    view.rerender(surface({
      doc: saved,
      cleanToken: "sha256:new",
      readOnly: false,
      onSave: save,
    }));
    await waitFor(() => expect(
      [...document.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")]
        .filter((element) => element.style.visibility !== "hidden")
        .map((element) => element.textContent),
    ).toEqual(["1", "2", "3", "4"]));
  });

  it("marks CodeMirror's runtime styles with the document nonce", async () => {
    render(surface());
    await waitFor(() => {
      expect(
        [...document.head.querySelectorAll("style")].some(
          (style) => (style as HTMLStyleElement).nonce === "textview_nonce_2026",
        ),
      ).toBe(true);
    });
  });

  it("applies stream updates without reporting them as a person's edit", async () => {
    const onDirtyChange = vi.fn();
    const view = render(surface({ doc: "part", onDirtyChange }));
    view.rerender(surface({ doc: "part complete", onDirtyChange }));

    await waitFor(() => expect(document.querySelector(".cm-content")).toHaveTextContent("part complete"));
    expect(onDirtyChange).not.toHaveBeenCalled();
  });

  it("keeps streamed snapshots out of the person's undo history", async () => {
    const view = render(surface({ doc: "part", readOnly: false }));
    view.rerender(surface({ doc: "part complete", readOnly: false }));
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    await waitFor(() => expect(content).toHaveTextContent("part complete"));

    fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true });
    expect(content).toHaveTextContent("part complete");
  });

  it("does not overwrite a dirty buffer when authority becomes read-only", async () => {
    const onDirtyChange = vi.fn();
    const view = render(surface({ doc: "base", readOnly: false, onDirtyChange }));
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.click(content);
    await userEvent.type(content, "draft ");
    expect(content).toHaveTextContent("draft base");

    view.rerender(surface({ doc: "base", readOnly: true, onDirtyChange }));
    expect(content).toHaveTextContent("draft base");
    expect(document.querySelector(".av-text-surface")).toHaveAttribute("data-readonly", "1");
  });

  it("advances the saved baseline without erasing an undo made while save was pending", async () => {
    const onDirtyChange = vi.fn();
    const view = render(surface({
      doc: "base",
      cleanToken: "sha256:old",
      readOnly: false,
      onDirtyChange,
    }));
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.click(content);
    await userEvent.type(content, "x");
    expect(content).toHaveTextContent("xbase");

    fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true });
    await waitFor(() => expect(content).toHaveTextContent("base"));
    view.rerender(surface({
      doc: "xbase",
      cleanToken: "sha256:new",
      readOnly: false,
      onDirtyChange,
    }));

    expect(content).toHaveTextContent("base");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("does not steal body focus when the save callback identity changes", async () => {
    const firstSave = vi.fn(() => true);
    const view = render(surface({ readOnly: false, onSave: firstSave }));
    await userEvent.click(screen.getByRole("button", { name: "查找" }));
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.click(content);
    expect(document.activeElement).toBe(content);

    view.rerender(surface({ readOnly: false, onSave: vi.fn(() => true) }));
    expect(document.activeElement).toBe(content);
  });

  it("reports only dirty transitions while keeping the draft inside CodeMirror", async () => {
    const onDirtyChange = vi.fn();
    render(surface({ readOnly: false, onDirtyChange }));
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.click(content);
    await userEvent.type(content, "xyz");
    expect(onDirtyChange).toHaveBeenCalledTimes(1);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("keeps the legacy controlled callback as an explicit compatibility path", async () => {
    const onTextChange = vi.fn();
    render(surface({ readOnly: false, onTextChange }));
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.click(content);
    await userEvent.type(content, "x");

    expect(onTextChange).toHaveBeenCalled();
    expect(onTextChange).toHaveBeenLastCalledWith("xalpha beta\nsecond alpha\n");
  });
});

describe("DocumentPane", () => {
  it("shares metadata, refusal, digest and stable viewer hooks without owning callbacks", async () => {
    const reload = vi.fn();
    const close = vi.fn();
    render(
      <DocumentPane
        variant="viewer"
        document={{
          label: "notes.txt",
          mediaType: "text/plain; charset=utf-8",
          sizeBytes: 1536,
          digest: "sha256:abc",
        }}
        label="fallback"
        status="refused"
        streaming={false}
        message="host text"
        code="approval_required"
        hasPartialContent
        onReload={reload}
        onClose={close}
      >
        <div>surface</div>
      </DocumentPane>,
    );

    expect(document.querySelector("#wsviewer.wsviewer.av-document-pane")).toBeInTheDocument();
    expect(screen.getByText(/1\.5 KB/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("可信审批栏");
    expect(screen.getByRole("note")).toHaveTextContent("已经读到的部分内容");
    expect(screen.getByText("sha256:abc")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(reload).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
