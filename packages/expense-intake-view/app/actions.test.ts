import { describe, expect, it } from "vitest";
import { approve_expense, reject_expense, submit_expense } from "./actions.js";
import { project } from "./projection.js";

const AT = "2026-08-13T10:00:00Z";
function pdf(bytes = "%PDF-") { const data = Buffer.from(bytes).toString("base64"); return JSON.stringify({ name: "receipt.pdf", type: "application/pdf", size: Buffer.byteLength(bytes), data }); }
const base = { merchant: "铁路", amount: "120.50", expense_date: "2026-08-12", description: "出差", receipt_pdf: pdf() };
function ctx(log: any[] = [], role = "submitter") { return { now: AT, actor: { kind: "user", user: "alice", role }, state: project(log) }; }
function commit(output: any, by = "user:alice") { return output.events.map((row: any) => ({ ...row, at: AT, by })); }

describe("expense actions", () => {
  it("runs the bounded fake extraction flow and auto-approves a small amount", () => {
    const output = submit_expense(ctx(), base);
    expect(output.events.map((row: any) => row.type)).toEqual(["expense_submitted", "agent_step", "agent_step", "expense_completed"]);
    expect(output.result).toEqual({ id: "expense-1", status: "approved" });
    expect(output.events.find((row: any) => row.data.extracted)?.data.extracted.说明).toBe("出差");
  });
  it("routes a large expense to manager review", () => {
    const log = commit(submit_expense(ctx(), { ...base, amount: "6000" }));
    expect(project(log).records[0].status).toBe("review");
    const decided = approve_expense(ctx(log, "manager"), { expense_id: "expense-1" });
    expect(decided.events[0]).toMatchObject({ type: "expense_decided", data: { decision: "approved" } });
    expect(() => reject_expense(ctx(log, "submitter"), { expense_id: "expense-1" })).toThrow(/role/);
  });
  it("rejects mislabeled, forged and oversized upload envelopes", () => {
    expect(() => submit_expense(ctx(), { ...base, receipt_pdf: JSON.stringify({ name: "x.txt", type: "text/plain", size: 5, data: "JVBERi0=" }) })).toThrow(/application\/pdf/);
    expect(() => submit_expense(ctx(), { ...base, receipt_pdf: JSON.stringify({ name: "x.pdf", type: "application/pdf", size: 5, data: "bm90cGRm" }) })).toThrow(/payload/);
    expect(() => submit_expense(ctx(), { ...base, amount: "-1" })).toThrow(/positive decimal/);
  });

  it("keeps expense submission on the submitter side of the workflow", () => {
    expect(() => submit_expense(ctx([], "manager"), base)).toThrow(/role/);
  });
});
