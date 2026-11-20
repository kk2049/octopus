import { describe, expect, it } from "vitest";
import { INTAKE_LIMITS, readIntake } from "./intake.js";

const record = { id: "expense-1", title: "差旅", subtitle: "alice", badge: "处理中", tone: "warn", status: "review", author: "alice", merchant: "铁路", amount: "¥120.00", date: "2026-08-12", description: "出差", extracted: { 商户: "铁路" }, attachment: { name: "a.pdf", type: "application/pdf", size: 20, data: "JVBERi0" }, history: [{ at: "now", title: "提取", detail: "完成", tone: "ok" }] };

describe("readIntake", () => {
  it("reads the manager collections and bounded attachment", () => {
    const out = readIntake({ mode: "manager", can_submit: true, completed: [record], processing: [], mine: [], stats: { 已完成: "1" } });
    expect(out).toMatchObject({ status: "ok", mode: "manager", canSubmit: true });
    expect(out.completed[0]?.attachment?.data).toBe("JVBERi0");
  });
  it("drops malformed records and attachments", () => {
    const out = readIntake({ mode: "submitter", completed: [], processing: [], mine: [{ ...record, id: "bad id", attachment: { ...record.attachment, data: "x".repeat(INTAKE_LIMITS.attachmentChars + 1) } }] });
    expect(out.mine).toEqual([]);
  });
  it("refuses oversized collections", () => {
    expect(readIntake({ completed: Array(201).fill(record), processing: [], mine: [] }).status).toBe("too_large");
  });
});
