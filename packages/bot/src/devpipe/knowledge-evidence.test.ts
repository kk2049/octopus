import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { gitOrThrow } from "./worktree.js";
import { ticketEvidenceIdentities, verifyNewHumanEvidence } from "./knowledge-evidence.js";

vi.mock("./worktree.js", () => ({ gitOrThrow: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("returns bounded current-ticket source hashes, without treating agent messages as humans or exposing bodies", () => {
  const store = new Store(":memory:");
  store.saveUser({ username: "alice", uid: 1, home_dir: "/x/alice", created_at: "2026-09-08" });
  const create = (body: string) => store.devTickets.createDevTicket({ title: "source identity", body, requester: "alice", kind: "simple", app_id: null, model: "fixture", effort: "medium" });
  const ticket = create("current private original text");
  const other = create("other private original text");
  try {
    for (let index = 0; index < 12; index++) store.devTickets.addTicketMessage(ticket.id, "alice", "web", `private human message ${index}`);
    store.devTickets.addTicketMessage(ticket.id, "agent", "agent", "agent says this is required");
    const text = ticketEvidenceIdentities(store, ticket.id);
    const rows = text.split("\n").slice(1).map((line) => JSON.parse(line));
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ ref: `ticket:${ticket.id}`, actor: "alice", source_kind: "original_prompt", source_sha256: createHash("sha256").update(ticket.body).digest("hex") });
    expect(rows.some((row) => row.ref === `ticket:${other.id}` || row.actor === "agent")).toBe(false);
    expect(text).not.toContain("private");
  } finally { store.close(); }
});
it("admits human evidence from original ticket data and rejects an agent message or forged source digest", async () => {
  const store = new Store(":memory:");
  store.saveUser({ username: "alice", uid: 1, home_dir: "/x/alice", created_at: "2026-09-07" });
  const statement = "知识规格必须保持完整的原始设计来源";
  const ticket = store.devTickets.createDevTicket({ title: "规格来源", body: statement, requester: "alice", kind: "simple", app_id: null, model: "fixture-model", effort: "medium" });
  const proof = { kind: "requirement", actor: "alice", at: ticket.created_at, ref: `ticket:${ticket.id}`, source_kind: "original_prompt", source_sha256: createHash("sha256").update(statement).digest("hex"), quote: statement, design: statement };
  let record = { id: "cur:test:1:1", statement, provenance: { events: [proof] } };
  vi.mocked(gitOrThrow).mockImplementation(async (_dir, args) => args[1]?.startsWith("before:") ? "" : JSON.stringify(record));
  const input = { repoDir: "/fixture", from: "before", to: "after", files: ["architecture/knowledge/curated/test.jsonl"], store };
  try {
    await expect(verifyNewHumanEvidence(input)).resolves.toBeUndefined();
    record = { ...record, provenance: { events: [{ ...proof, source_sha256: "f".repeat(64) }] } };
    await expect(verifyNewHumanEvidence(input)).rejects.toThrow(/哈希/);
    store.devTickets.addTicketMessage(ticket.id, "agent", "agent", statement);
    const message = store.devTickets.listTicketMessages(ticket.id).at(-1)!;
    record = { ...record, provenance: { events: [{ ...proof, actor: "agent", at: message.created_at, ref: `ticket:${ticket.id}#message:${message.id}`, source_kind: "human_message" }] } };
    await expect(verifyNewHumanEvidence(input)).rejects.toThrow(/角色/);
  } finally { store.close(); }
});
it("treats text written through a token, MCP or the Head as agent evidence; browser and pre-v86 rows keep their standing", async () => {
  const store = new Store(":memory:");
  store.saveUser({ username: "lht", uid: 1, home_dir: "/x/lht", created_at: "2026-10-15" });
  const statement = "工单溯源必须区分本人输入与代写";
  const sha = createHash("sha256").update(statement).digest("hex");
  const create = (actor_kind?: "browser" | "token" | "mcp" | "system") => store.devTickets.createDevTicket({
    title: "provenance", body: statement, requester: "lht", kind: "simple", app_id: null, model: "fixture", effort: "high",
    ...(actor_kind ? { actor_kind } : {}) });
  const scripted = create("token");
  const typed = create("browser");
  const legacy = create();
  const event = (ticket: { id: number; created_at: string }, ref = `ticket:${ticket.id}`, at = ticket.created_at, source_kind = "original_prompt") =>
    ({ kind: "requirement", actor: "lht", at, ref, source_kind, source_sha256: sha, quote: statement, design: statement });
  let record: { id: string; statement: string; provenance: { events: unknown[] } } = { id: "cur:test:2:1", statement, provenance: { events: [] } };
  vi.mocked(gitOrThrow).mockImplementation(async (_dir, args) => args[1]?.startsWith("before:") ? "" : JSON.stringify(record));
  const verify = () => verifyNewHumanEvidence({ repoDir: "/fixture", from: "before", to: "after", files: ["architecture/knowledge/curated/test.jsonl"], store });
  try {
    // The scripted ticket's body is not offered as a human source and cannot be cited as one.
    expect(ticketEvidenceIdentities(store, scripted.id)).not.toContain(`"ticket:${scripted.id}"`);
    record = { ...record, provenance: { events: [event(scripted)] } };
    await expect(verify()).rejects.toThrow(/角色/);
    // A browser-typed body, and a body written before kinds were recorded, still are.
    expect(ticketEvidenceIdentities(store, typed.id)).toContain(`"ticket:${typed.id}"`);
    record = { ...record, provenance: { events: [event(typed)] } };
    await expect(verify()).resolves.toBeUndefined();
    record = { ...record, provenance: { events: [event(legacy)] } };
    await expect(verify()).resolves.toBeUndefined();

    // Same for follow-up messages on the web channel.
    for (const kind of ["token", "mcp", "system"] as const) {
      const message = store.devTickets.addTicketMessage(typed.id, "lht", "web", statement, undefined, kind);
      expect(ticketEvidenceIdentities(store, typed.id)).not.toContain(`#message:${message.id}`);
      record = { ...record, provenance: { events: [event(typed, `ticket:${typed.id}#message:${message.id}`, message.created_at, "human_message")] } };
      await expect(verify()).rejects.toThrow(/角色/);
    }
    const human = store.devTickets.addTicketMessage(typed.id, "lht", "web", statement, undefined, "browser");
    expect(ticketEvidenceIdentities(store, typed.id)).toContain(`#message:${human.id}`);
    record = { ...record, provenance: { events: [event(typed, `ticket:${typed.id}#message:${human.id}`, human.created_at, "human_message")] } };
    await expect(verify()).resolves.toBeUndefined();
  } finally { store.close(); }
});
