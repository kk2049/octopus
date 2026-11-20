import { describe, expect, it } from "vitest";
import { submit_expense } from "./actions.js";
import { project, projectIncremental } from "./projection.js";

const AT = "2026-08-13T10:00:00Z";
function uploaded(user: string, amount: string, log: any[]): any[] {
  const bytes = "%PDF-"; const receipt_pdf = JSON.stringify({ name: `${user}.pdf`, type: "application/pdf", size: 5, data: Buffer.from(bytes).toString("base64") });
  const out = submit_expense({ now: AT, actor: { kind: "user", user, role: "submitter" }, state: project(log) }, { merchant: user, amount, expense_date: "2026-08-12", description: "", receipt_pdf });
  return out.events.map((row: any) => ({ ...row, at: AT, by: `user:${user}` }));
}

describe("viewer-scoped expense projection", () => {
  const alice = uploaded("alice", "120", []);
  const log = [...alice, ...uploaded("bob", "6000", alice)];
  it("gives a manager every row and only safe PDF metadata", () => {
    const view = project(log, { viewer: { kind: "user", user: "manager", role: "manager" } });
    expect(view.intake.completed).toHaveLength(1); expect(view.intake.processing).toHaveLength(1);
    expect(view.intake.can_submit).toBe(false);
    expect(view.intake.completed[0].attachment).toEqual({ name: "alice.pdf", type: "application/pdf", size: 5 });
    expect(view.intake.completed[0].attachment).not.toHaveProperty("data");
  });
  it("gives a submitter only own status/history and no PDF or extracted fields", () => {
    const view = project(log, { viewer: { kind: "user", user: "bob", role: "submitter" } });
    expect(view.intake.mine).toHaveLength(1); expect(view.intake.mine[0].author).toBe("bob");
    expect(view.intake.mine[0].attachment_name).toBe("bob.pdf");
    expect(view.intake.mine[0].attachment_size).toBe(5);
    expect(view.intake.mine[0]).not.toHaveProperty("attachment"); expect(view.intake.mine[0]).not.toHaveProperty("extracted");
    expect(view.intake.completed).toEqual([]); expect(JSON.stringify(view)).not.toContain("alice.pdf");
  });
  it("fails closed when trusted viewer evidence is missing or malformed", () => {
    expect(project(log, { viewer: {} }).intake.mine).toEqual([]);
    expect(project(log, { viewer: { user: "alice", role: "unknown" } }).intake.can_submit).toBe(false);
  });
  it("keeps an internal full fold for backend actions only", () => expect(project(log).records).toHaveLength(2));
});
describe("incremental expense projection", () => {
  it("matches a complete viewer fold across a snapshot boundary", () => {
    const first = uploaded("alice", "120", []);
    const events = [...first, ...uploaded("bob", "6000", first)];
    const context = { viewer: { kind: "user", user: "manager", role: "manager" } };
    expect(projectIncremental(project(first), events.slice(first.length), context)).toEqual(project(events, context));
  });
});
