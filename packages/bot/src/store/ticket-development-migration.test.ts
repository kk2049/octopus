import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it("upgrades v74, retains historical users, and binds only an unstarted ticket to its verified child", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "development-v74-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "store.db"), before = new Database(file);
  migrateFixtureTo(before, 74);
  before.prepare("INSERT INTO users(username,uid,home_dir,created_at) VALUES(?,?,?,?)").run("alice", 1, dir, new Date().toISOString()); before.close();
  const store = new Store(file); cleanups.push(async () => store.close());
  const ticket = store.devTickets.createDevTicket({ title: "development", body: "task", requester: "alice", model: "codex-gpt-6-astra", effort: "xhigh", kind: "simple", app_id: null });
  store.devTickets.runner.bind(ticket.id, { owner: "alice", device: "model", executionDevice: "execution", workspaceId: "parent", source: "codex" });
  const binding = { ticketId: ticket.id, owner: "alice", device: "execution", parentWorkspaceId: "parent", worktreeWorkspaceId: "child", repositoryId: "octopus", developmentId: "dev_ticket", baseSha: "a".repeat(40) };
  store.devTickets.development.bind(binding);
  expect(() => store.devTickets.runner.bindDevelopmentWorkspace(ticket.id, "other-child")).toThrow();
  expect(store.devTickets.runner.bindDevelopmentWorkspace(ticket.id, "child")).toMatchObject({ workspaceId: "child", executionDevice: "execution" });
  expect(() => store.devTickets.development.bind({ ...binding, device: "another-runner" })).toThrow();
  store.devTickets.updateDevTicket(ticket.id, { session_id: "original-native" });
  expect(() => store.devTickets.runner.bindDevelopmentWorkspace(ticket.id, "child")).toThrow();
  expect(store.devTickets.getDevTicket(ticket.id)?.session_id).toBe("original-native");
  expect(store.devTickets.development.sessionRequired("alice", "model", "codex", "original-native")).toBe(true);
  for (const [owner, runtime, source, sid] of [["bob", "model", "codex", "original-native"], ["alice", "execution", "codex", "original-native"],
    ["alice", "model", "claude", "original-native"], ["alice", "model", "codex", "another-session"]]) {
    expect(store.devTickets.development.sessionRequired(owner!, runtime!, source!, sid!)).toBe(false);
  }

  const initial = { id: "z-old", ticketId: ticket.id, key: "prepare", action: "prepare" as const, args: {}, state: "prepared" as const };
  store.devTickets.development.save(initial);
  store.devTickets.development.save({ ...initial, id: "a-new" });
  store.devTickets.development.save({ ...initial, state: "dispatched" });
  expect(store.devTickets.development.operation(ticket.id, "prepare")?.id).toBe("a-new");
});

it("persists a shared ticket author separately and recovers only the physical owner's exact session", () => {
  const store = new Store(":memory:");
  try {
    for (const username of ["owner", "developer"]) store.saveUser({ username, uid: username === "owner" ? 1 : 2, home_dir: "/unused", created_at: "now" });
    const ticket = store.devTickets.createDevTicket({ title: "shared", body: "task", requester: "developer", model: "codex-gpt-6-astra", effort: "xhigh", kind: "simple", app_id: null });
    store.devTickets.runner.bind(ticket.id, { owner: "owner", requester: "developer", parentWorkspaceId: "parent",
      device: "model", executionDevice: "4090", workspaceId: "parent", source: "codex" });
    store.devTickets.development.bind({ ticketId: ticket.id, owner: "owner", requester: "developer", device: "4090",
      parentWorkspaceId: "parent", worktreeWorkspaceId: "child", repositoryId: "octopus", developmentId: "dev_shared", baseSha: "a".repeat(40) });
    expect(store.devTickets.runner.bindDevelopmentWorkspace(ticket.id, "child")).toMatchObject({ owner: "owner", requester: "developer", parentWorkspaceId: "parent", workspaceId: "child" });
    store.devTickets.updateDevTicket(ticket.id, { session_id: "native" });
    expect(store.devTickets.development.sessionRequired("owner", "model", "codex", "native")).toBe(true);
    expect(store.devTickets.development.sessionRequired("developer", "model", "codex", "native")).toBe(false);
    expect(store.devTickets.development.sessionRequired("owner", "4090", "codex", "native")).toBe(false);
    expect(() => store.devTickets.development.bind({ ...store.devTickets.development.binding(ticket.id)!, requester: "owner" })).toThrow();
  } finally { store.close(); }
});
