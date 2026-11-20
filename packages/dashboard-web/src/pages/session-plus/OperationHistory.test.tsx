import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  OperationHistory,
  recordSessionPlusOperation,
  type SessionPlusOperationRow,
} from "./OperationHistory.js";

describe("Session+ trusted operation history", () => {
  it("shows a server-authored resource wait while retaining the original operation outcome", () => {
    const rows = recordSessionPlusOperation([], { id: "waiting", status: "unknown",
      message: "等待原设备恢复", recovery: { state: "waiting_resource", checkpoint: "private" } });
    expect(rows[0]).toMatchObject({ status: "unknown", recovery: "waiting_resource" });
    expect(JSON.stringify(rows)).not.toContain("private");
    render(<OperationHistory operations={rows} />);
    expect(screen.getByText("等待运行环境")).toBeInTheDocument();
    expect(screen.queryByText("结果未知")).toBeNull();
  });
  it("updates one operation in place and bounds the newest-first history", () => {
    let rows: SessionPlusOperationRow[] = [];
    for (let index = 0; index < 24; index += 1) {
      rows = recordSessionPlusOperation(rows, {
        id: `op-${index}`,
        operation: "append_session",
        status: "running",
        message: `动作 ${index}`,
      });
    }
    rows = recordSessionPlusOperation(rows, {
      id: "op-23",
      operation: "append_session",
      status: "succeeded",
      message: "已完成",
    });

    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ id: "op-23", status: "succeeded", message: "已完成" });
    expect(rows.filter((row) => row.id === "op-23")).toHaveLength(1);
  });

  it("renders server-authored fields as text inside the disclosure", () => {
    const operations = recordSessionPlusOperation([], {
      id: "op-hostile",
      operation: "open_terminal",
      status: "rejected",
      message: '<img src=x onerror="alert(1)">',
      detail: "Gate 拒绝",
    });
    render(<OperationHistory operations={operations} />);

    expect(screen.getByText("历史动作")).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("Gate 拒绝")).toBeInTheDocument();
  });

  it("states honestly when this page has not observed an operation", () => {
    render(<OperationHistory operations={[]} />);
    expect(screen.getByText("本页尚无历史动作。")).toBeInTheDocument();
  });
});
