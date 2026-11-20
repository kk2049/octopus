/**
 * McpSurface's memory and skill tool groups against a REAL PermissionService,
 * REAL capability planes and a real temporary filesystem — nothing below the
 * directory is faked.
 *
 * The properties pinned here are the surface's own:
 *  - tools/list mirrors the effective projection (ungranted groups absent);
 *  - owner comes from the token: two tokens over the same tool names reach
 *    two different directories, and neither can name the other's;
 *  - the jail refuses through the MCP argument surface too;
 *  - a write surfaces as `approval_required`, the owner's approval executes
 *    it, and both token release and subject revocation kill the undecided
 *    cards the token queued;
 *  - undeclared arguments are refused as such.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { Store } from "../store/store.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { UserMemoryCapabilities } from "../user-memory/capability.js";
import { UserSkillsCapabilities } from "../user-skills/capability.js";
import { MCP_MEMORY_OPERATION_IDS, MCP_SKILL_OPERATION_IDS, MCP_SUBJECT_ID, mcpSubjectEntry } from "./catalog.js";
import { McpSurface } from "./service.js";

const NOW = "2026-08-10T00:00:00.000Z";
const READ_OPS = ["list_memory", "read_memory", "search_memory", "list_skills", "read_skill"];

describe("McpSurface memory/skill groups", () => {
  let dir: string;
  let store: Store;
  let svc: CapabilityService;
  let permissions: PermissionService;
  let surface: McpSurface;
  const alice = { owner: "alice", credential: "mcp:a1" };
  const bob = { owner: "bob", credential: "mcp:b1" };

  const memDir = (name: string) => path.join(dir, name, "memory");
  const skillsDir = (name: string) => path.join(dir, name, ".claude", "skills");

  const grant = (owner: string, operations: string[], autoAllow: string[] = READ_OPS.filter((op) => operations.includes(op))) =>
    permissions.grant({
      subjectType: "service",
      subjectId: MCP_SUBJECT_ID,
      owner,
      operations,
      autoAllow,
      source: "user",
      createdBy: owner,
    });

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mcp-memory-skill-"));
    store = new Store(path.join(dir, "t.db"));
    for (const [name, uid] of [["alice", 5001], ["bob", 5002]] as const) {
      store.saveUser({ username: name, uid, home_dir: path.join(dir, name), created_at: NOW });
      mkdirSync(memDir(name), { recursive: true });
      mkdirSync(skillsDir(name), { recursive: true });
    }
    writeFileSync(path.join(memDir("alice"), "MEMORY.md"), "alice remembers");
    writeFileSync(path.join(memDir("bob"), "MEMORY.md"), "bob remembers");
    writeFileSync(path.join(dir, "alice", "secret.txt"), "outside the jail");
    mkdirSync(path.join(skillsDir("bob"), "bobs-skill"));
    writeFileSync(path.join(skillsDir("bob"), "bobs-skill", "SKILL.md"), "bob only");

    svc = new CapabilityService();
    const userExists = (u: string) => Boolean(store.getUser(u));
    const memory = new UserMemoryCapabilities({
      service: svc,
      userExists,
      memoryDirFor: (u) => (store.getUser(u) ? memDir(u) : undefined),
    });
    const skills = new UserSkillsCapabilities({
      service: svc,
      userExists,
      skillsDirFor: (u) => (store.getUser(u) ? skillsDir(u) : undefined),
    });
    permissions = new PermissionService({
      store,
      userMemory: memory,
      userSkills: skills,
      subjects: [
        mcpSubjectEntry({
          workspaceComposed: () => false,
          crdtComposed: () => false,
          memoryComposed: () => true,
          skillsComposed: () => true,
        }),
      ],
    });
    const hub = new SessionHubService({ store, permissions });
    surface = new McpSurface({ hub, permissions, memory, skills, publicUrl: "https://bot.example" });
  });

  afterAll(() => {
    surface.close();
    svc.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tools/list is empty before any grant, and an ungranted call refuses without touching the directory", async () => {
    expect(surface.listTools("alice")).toEqual([]);
    const out = await surface.callTool(alice, "memory_write", { path: "planted.md", content: "x" });
    expect(out).toMatchObject({ ok: false, code: "no_authority" });
  });

  it("granting the read operations lists exactly the read tools", () => {
    grant("alice", READ_OPS);
    const names = surface.listTools("alice").map((t) => t.name);
    expect(names.sort()).toEqual(["memory_list", "memory_read", "memory_search", "skill_list", "skill_read"]);
  });

  it("reads answer the token owner's own directory", async () => {
    const read = await surface.callTool(alice, "memory_read", { path: "MEMORY.md" });
    expect(read.ok).toBe(true);
    expect((read as { result: { content: string } }).result.content).toBe("alice remembers");

    grant("bob", READ_OPS);
    const bobRead = await surface.callTool(bob, "memory_read", { path: "MEMORY.md" });
    expect((bobRead as { result: { content: string } }).result.content).toBe("bob remembers");

    const bobSkills = await surface.callTool(bob, "skill_list", {});
    const names = (bobSkills as { result: { skills: Array<{ name: string }> } }).result.skills.map((s) => s.name);
    expect(names).toEqual(["bobs-skill"]);
    // Alice's listing does not contain bob's skill.
    const aliceSkills = await surface.callTool(alice, "skill_list", {});
    expect((aliceSkills as { result: { skills: unknown[] } }).result.skills).toEqual([]);
  });

  it("the jail holds at the MCP argument surface, and foreign names read as absent", async () => {
    const escape = await surface.callTool(alice, "memory_read", { path: "../secret.txt" });
    expect(escape).toMatchObject({ ok: false, code: "failed" });
    expect(JSON.stringify(escape)).not.toContain("outside the jail");

    const foreign = await surface.callTool(alice, "skill_read", { name: "bobs-skill" });
    expect(foreign).toMatchObject({ ok: false, code: "failed" });
    expect(JSON.stringify(foreign)).not.toContain("bob only");
  });

  it("undeclared arguments are refused as such", async () => {
    const out = await surface.callTool(alice, "memory_read", { path: "MEMORY.md", owner: "bob" });
    expect(out).toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("a granted write to one's own memory runs without a card (O1); the answer is then readable", async () => {
    grant("alice", [...MCP_MEMORY_OPERATION_IDS, ...MCP_SKILL_OPERATION_IDS]);
    const written = await surface.callTool(alice, "memory_write", { path: "notes.md", content: "from mcp" });
    expect(written.ok).toBe(true);
    expect(svc.listPending("alice")).toHaveLength(0);

    const read = await surface.callTool(alice, "memory_read", { path: "notes.md" });
    expect((read as { result: { content: string } }).result.content).toBe("from mcp");
  });

  it("skill_write installs a skill silently; the irreversible skill_remove still asks", async () => {
    const written = await surface.callTool(alice, "skill_write", { name: "made-by-mcp", content: "# steps" });
    expect(written.ok).toBe(true);
    const read = await surface.callTool(alice, "skill_read", { name: "made-by-mcp" });
    expect((read as { result: { content: string } }).result.content).toBe("# steps");

    const removal = await surface.callTool(alice, "skill_remove", { name: "made-by-mcp" });
    expect(removal).toMatchObject({ ok: false, code: "approval_required" });
    await svc.approve(svc.listPending("alice")[0].id, "alice");
    const gone = await surface.callTool(alice, "skill_read", { name: "made-by-mcp" });
    expect(gone).toMatchObject({ ok: false, code: "failed" });
  });

  it("releasing the token hard-kills the cards it queued", async () => {
    const asked = await surface.callTool(alice, "skill_remove", { name: "never-made" });
    expect(asked).toMatchObject({ ok: false, code: "approval_required" });
    expect(svc.listPending("alice")).toHaveLength(1);
    surface.releaseCredential(alice.owner, alice.credential);
    expect(svc.listPending("alice")).toHaveLength(0);
    // The grant row still stands, so the next call simply reopens a scope.
    const read = await surface.callTool(alice, "memory_read", { path: "MEMORY.md" });
    expect(read.ok).toBe(true);
  });

  it("revoking the subject grant closes the owner's scopes and empties tools/list", async () => {
    const asked = await surface.callTool(alice, "skill_remove", { name: "never-made-2" });
    expect(asked).toMatchObject({ ok: false, code: "approval_required" });
    permissions.revoke({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice", by: "alice" });
    expect(svc.listPending("alice")).toHaveLength(0);
    expect(await surface.callTool(alice, "memory_read", { path: "MEMORY.md" })).toMatchObject({
      ok: false,
      code: "no_authority",
    });
    expect(surface.listTools("alice")).toEqual([]);
    // Bob's authority is untouched by alice's revocation.
    const bobRead = await surface.callTool(bob, "memory_read", { path: "MEMORY.md" });
    expect(bobRead.ok).toBe(true);
  });
});
