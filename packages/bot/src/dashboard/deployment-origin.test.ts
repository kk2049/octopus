import { describe, expect, it } from "vitest";
import type { DeployIntentRow, DevTicketRow } from "../store/repositories/dev-tickets.js";
import { deploymentOrigin, deploymentSource } from "./deployment-origin.js";

const alice = { username: "alice", admin: false, dev: true, via: "bearer" as const };
const ticket = { id: 523, title: "Deployment progress", model: "codex", requester: "alice" } as DevTicketRow;
describe("deployment attribution", () => {
  it("distinguishes the authenticated web and CLI paths without guessing an agent", () => {
    expect(deploymentSource(undefined, { ...alice, via: "cookie" }, () => ticket)).toEqual({ kind: "web" });
    expect(deploymentSource(undefined, alice, () => ticket)).toEqual({ kind: "cli_api" });
  });
  it("resolves reported ticket metadata from the record and rejects unrelated tickets", () => {
    const raw = { kind: "ticket_agent", ticket_id: 523, actor: "mallory", ticket_title: "forged", agent: "forged" };
    expect(deploymentSource(raw, alice, () => ticket)).toEqual({ kind: "ticket_agent", ticket_id: 523, ticket_title: ticket.title, agent: "codex" });
    expect(() => deploymentSource(raw, { ...alice, username: "bob" }, () => ticket)).toThrow(/不能引用/);
    expect(() => deploymentSource(raw, alice, () => undefined)).toThrow(/不能引用/);
  });
  it("accepts bounded CLI display metadata without preserving extra input", () => {
    expect(deploymentSource({ kind: "cli_agent", agent: "Codex", session: "session-1", device: "laptop", token: "SECRET" }, alice, () => ticket))
      .toEqual({ kind: "cli_agent", agent: "Codex", session: "session-1", device: "laptop" });
    for (const agent of ["", "a".repeat(121), "line\nbreak", 123]) {
      expect(() => deploymentSource({ kind: "cli_agent", agent }, alice, () => ticket)).toThrow();
    }
    expect(() => deploymentSource({ kind: "web" }, alice, () => ticket)).toThrow();
  });
  it("keeps attribution account-scoped and labels missing historical evidence", () => {
    const row = { id: 2, triggered_by: "alice", trigger_source: JSON.stringify({ kind: "ticket_agent", ticket_id: 523, actor: "forged" }) } as DeployIntentRow;
    expect(deploymentOrigin(row, alice)).toMatchObject({ intent_id: 2, actor: "alice", ticket_id: 523 });
    expect(deploymentOrigin(row, { ...alice, username: "bob", dev: false })).toBeNull();
    expect(deploymentOrigin({ ...row, trigger_source: null }, alice)?.kind).toBe("unknown");
    expect(deploymentOrigin({ ...row, trigger_source: "malformed" }, alice)?.kind).toBe("unknown");
  });
});
