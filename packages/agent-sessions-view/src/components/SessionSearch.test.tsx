import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@claude-bot/agent-sessions-contract";
import { SessionSearch } from "./SessionSearch.js";

describe("session search freshness", () => {
  it("clears hits on every edit, including clear and retyping, and ignores late mismatched results", () => {
    const onSubmit = vi.fn();
    const onSelect = vi.fn();
    const result = (query: string): SearchResult => ({
      query, results: [{ session: { resourceId: "hit" }, snippet: `${query} result` }],
    });
    function Search({ answer }: { answer: SearchResult }) {
      const [query, onQuery] = useState("");
      return <SessionSearch query={query} onQuery={onQuery} result={answer} onSubmit={onSubmit} onSelect={onSelect} />;
    }
    const view = render(<Search answer={result("arch")} />);
    const input = screen.getByRole("searchbox", { name: "搜索会话正文" });
    const submit = screen.getByRole("button", { name: "搜索" });
    expect(submit).toBeDisabled();
    expect(screen.queryByText("arch result")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "arch" } });
    fireEvent.click(submit);
    expect(screen.getByText("arch result")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "town" } });
    expect(screen.queryByText("arch result")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    view.rerender(<Search answer={result("arch")} />);
    expect(screen.queryByText("arch result")).not.toBeInTheDocument();
    view.rerender(<Search answer={result("town")} />);
    expect(screen.getByText("town result")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText("town result")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "town" } });
    expect(screen.queryByText("town result")).not.toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("pages forward and back by cursor and shows only the page it asked for", () => {
    const onSubmit = vi.fn();
    function Search({ answer }: { answer: SearchResult }) {
      const [query, onQuery] = useState("arch");
      return <SessionSearch query={query} onQuery={onQuery} result={answer} onSubmit={onSubmit} onSelect={vi.fn()} />;
    }
    const first: SearchResult = {
      query: "arch", cursor: "", complete: false, nextCursor: "c1",
      results: [{ session: { resourceId: "new" }, snippet: "newest hit" }],
    };
    const second: SearchResult = {
      query: "arch", cursor: "c1", complete: true, incompleteSources: ["laptop-old"],
      results: [{ session: { resourceId: "old" }, snippet: "older hit" }],
    };
    const view = render(<Search answer={first} />);
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(onSubmit).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByText("newest hit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "继续搜索更早的会话" }));
    expect(onSubmit).toHaveBeenLastCalledWith("c1");
    // The first page's answer is not the page that was asked for any more.
    expect(screen.queryByText("newest hit")).not.toBeInTheDocument();
    view.rerender(<Search answer={second} />);
    expect(screen.getByText("older hit")).toBeInTheDocument();
    expect(screen.getByText(/第 2 页/)).toBeInTheDocument();
    expect(screen.getByText("未能完整搜索：laptop-old")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续搜索更早的会话" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(onSubmit).toHaveBeenLastCalledWith(undefined);
    view.rerender(<Search answer={first} />);
    expect(screen.getByText("newest hit")).toBeInTheDocument();
  });
});
