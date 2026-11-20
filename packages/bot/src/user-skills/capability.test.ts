/**
 * The user-skills capability plane, against the real kernel and a real
 * temporary filesystem.
 *
 * What is pinned:
 *  - the closed name vocabulary: everything outside `^[a-z][a-z0-9-]{0,63}$`
 *    (and every dot-leading / traversal path segment) is refused, not escaped;
 *  - the jail on resolved paths, on top of the lexical checks;
 *  - both mutations are per-call approvals only the owner may approve, and
 *    `remove_skill` deletes a symlinked "skill" as the LINK, never the target;
 *  - bounds: one call carries a window/page/chunk, so a file of any size is
 *    read and written; the per-skill total, file count and skill count are
 *    product quotas checked against everything the directory holds;
 *  - isolation and revocation fail closed.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import {
  USER_SKILLS_LIMITS,
  USER_SKILLS_OPERATIONS,
  USER_SKILLS_OPERATION_NAMES,
  UserSkillsCapabilities,
} from "./capability.js";

const READ_OPS = ["list_skills", "read_skill"] as const;

let dir: string;
let svc: CapabilityService;
let plane: UserSkillsCapabilities;
let users: Set<string>;

const skillsDir = (name: string) => path.join(dir, name, ".claude", "skills");

function openAlice() {
  const grant = plane.open({
    username: "alice",
    purpose: "test",
    rights: USER_SKILLS_OPERATION_NAMES,
    autoAllow: READ_OPS,
  });
  expect(grant).not.toBeNull();
  return grant!;
}

/** Queue the modify call and approve it as the owner, returning the outcome. */
async function approved(grant: ReturnType<typeof openAlice>, operation: string, args: Record<string, unknown>) {
  const asked = await grant.request(operation, args);
  expect(asked.status).toBe("approval_required");
  return await svc.approve((asked as { pendingCallId: string }).pendingCallId, "alice");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "user-skills-"));
  users = new Set(["alice", "bob"]);
  for (const u of users) mkdirSync(skillsDir(u), { recursive: true });
  mkdirSync(path.join(skillsDir("alice"), "greeting"), { recursive: true });
  writeFileSync(path.join(skillsDir("alice"), "greeting", "SKILL.md"), "# greet warmly");
  mkdirSync(path.join(skillsDir("bob"), "secret-skill"), { recursive: true });
  writeFileSync(path.join(skillsDir("bob"), "secret-skill", "SKILL.md"), "bob only");
  svc = new CapabilityService();
  plane = new UserSkillsCapabilities({
    service: svc,
    userExists: (u) => users.has(u),
    skillsDirFor: (u) => (users.has(u) ? skillsDir(u) : undefined),
  });
});

afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the closed table", () => {
  it("declares no identity or root fields anywhere", () => {
    const allowed = new Set(["name", "file", "content", "offset", "max_bytes", "cursor", "limit"]);
    for (const spec of Object.values(USER_SKILLS_OPERATIONS)) {
      for (const key of Object.keys(spec.args)) expect(allowed.has(key)).toBe(true);
    }
  });

  it("both mutations are modify and explicitly retry-safe (idempotent shapes)", () => {
    expect(USER_SKILLS_OPERATIONS.write_skill.effect).toBe("modify");
    expect(USER_SKILLS_OPERATIONS.remove_skill.effect).toBe("modify");
    expect(USER_SKILLS_OPERATIONS.write_skill.retrySafe).toBe(true);
    expect(USER_SKILLS_OPERATIONS.remove_skill.retrySafe).toBe(true);
  });
});

describe("reads", () => {
  it("lists the owner's skills with their files, and reads SKILL.md by default", async () => {
    const grant = openAlice();
    const listed = await grant.request("list_skills", {});
    expect(listed.status).toBe("succeeded");
    const skills = (listed as { result: { skills: Array<{ name: string; has_skill_md: boolean }> } }).result.skills;
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("greeting");
    expect(skills[0].has_skill_md).toBe(true);

    const read = await grant.request("read_skill", { name: "greeting" });
    expect((read as { result: { content: string; file: string } }).result).toMatchObject({
      file: "SKILL.md",
      content: "# greet warmly",
    });
  });

  it("bob's skills are visible only through bob's own grant", async () => {
    const alice = openAlice();
    const out = await alice.request("read_skill", { name: "secret-skill" });
    expect(out.status).toBe("failed");
    const bob = plane.open({ username: "bob", purpose: "test", rights: READ_OPS, autoAllow: READ_OPS })!;
    const read = await bob.request("read_skill", { name: "secret-skill" });
    expect((read as { result: { content: string } }).result.content).toBe("bob only");
  });
});

describe("the closed vocabulary and the jail", () => {
  it("refuses names outside the whitelist without touching the filesystem", async () => {
    const grant = openAlice();
    for (const bad of ["Bad", "a_b", "../greeting", "..", ".hidden", "x".repeat(65), ""]) {
      const out = await grant.request("read_skill", { name: bad });
      // Over-length names die at the schema (denied); the rest at the
      // adapter's vocabulary check (failed). Both refuse before any bytes.
      expect(["failed", "denied"]).toContain(out.status);
    }
  });

  it("refuses traversal and dot-leading file segments", async () => {
    const grant = openAlice();
    for (const bad of ["../../MEMORY.md", "a/../../b", ".git/config", "refs/.hidden", "a/b/c/d/e"]) {
      const out = await grant.request("read_skill", { name: "greeting", file: bad });
      expect(out.status).toBe("failed");
    }
  });

  it("refuses reading through a symlink that leaves the skills root", async () => {
    mkdirSync(path.join(skillsDir("alice"), "linky"));
    symlinkSync(
      path.join(skillsDir("bob"), "secret-skill", "SKILL.md"),
      path.join(skillsDir("alice"), "linky", "SKILL.md"),
    );
    const grant = openAlice();
    const out = await grant.request("read_skill", { name: "linky" });
    expect(out.status).toBe("failed");
    expect(JSON.stringify(out)).not.toContain("bob only");
  });
});

describe("mutations", () => {
  it("write creates the skill directory and SKILL.md after the owner's approval", async () => {
    const grant = openAlice();
    const out = await approved(grant, "write_skill", { name: "new-skill", content: "# do the thing" });
    expect(out.status).toBe("succeeded");
    expect(readFileSync(path.join(skillsDir("alice"), "new-skill", "SKILL.md"), "utf8")).toBe("# do the thing");
  });

  it("a non-owner cannot approve, and nothing lands", async () => {
    const grant = openAlice();
    const asked = await grant.request("write_skill", { name: "evil", content: "x" });
    const denied = await svc.approve((asked as { pendingCallId: string }).pendingCallId, "bob");
    expect(denied.status).toBe("denied");
    expect(existsSync(path.join(skillsDir("alice"), "evil"))).toBe(false);
  });

  it("nested reference files write inside the skill only", async () => {
    const grant = openAlice();
    const out = await approved(grant, "write_skill", {
      name: "greeting",
      file: "references/tone.md",
      content: "friendly",
    });
    expect(out.status).toBe("succeeded");
    expect(readFileSync(path.join(skillsDir("alice"), "greeting", "references", "tone.md"), "utf8")).toBe("friendly");
  });

  it("remove deletes the whole skill and is idempotent about absence", async () => {
    const grant = openAlice();
    const removed = await approved(grant, "remove_skill", { name: "greeting" });
    expect(removed.status).toBe("succeeded");
    expect((removed as { result: { existed: boolean } }).result.existed).toBe(true);
    expect(existsSync(path.join(skillsDir("alice"), "greeting"))).toBe(false);

    const again = await approved(grant, "remove_skill", { name: "greeting" });
    expect(again.status).toBe("succeeded");
    expect((again as { result: { existed: boolean } }).result.existed).toBe(false);
  });

  it("removing a symlinked 'skill' removes the LINK, never the target", async () => {
    symlinkSync(path.join(skillsDir("bob"), "secret-skill"), path.join(skillsDir("alice"), "linked"));
    const grant = openAlice();
    const out = await approved(grant, "remove_skill", { name: "linked" });
    expect(out.status).toBe("succeeded");
    expect(existsSync(path.join(skillsDir("alice"), "linked"))).toBe(false);
    expect(readFileSync(path.join(skillsDir("bob"), "secret-skill", "SKILL.md"), "utf8")).toBe("bob only");
  });
});

describe("bounds", () => {
  it("content over the schema cap is denied before the adapter", async () => {
    const grant = openAlice();
    const out = await grant.request("write_skill", {
      name: "big",
      content: "x".repeat(USER_SKILLS_LIMITS.writeMaxBytes + 1),
    });
    expect(out.status).toBe("denied");
  });

  it("a skill's total size cap refuses the write that would cross it", async () => {
    const grant = openAlice();
    const chunk = "x".repeat(USER_SKILLS_LIMITS.writeMaxBytes);
    // 4 × 256 KiB fills the 1 MiB skill budget exactly.
    for (let i = 0; i < 4; i++) {
      const out = await approved(grant, "write_skill", { name: "fat", file: `part${i}.md`, content: chunk });
      expect(out.status).toBe("succeeded");
    }
    const over = await approved(grant, "write_skill", { name: "fat", file: "part4.md", content: "y" });
    expect(over.status).toBe("failed");
    // Overwriting an existing part stays inside the budget and succeeds.
    const rewrite = await approved(grant, "write_skill", { name: "fat", file: "part0.md", content: "small now" });
    expect(rewrite.status).toBe("succeeded");
  });

  it("writes and reads one file larger than a call in chunks, inside the skill quota", async () => {
    const grant = openAlice();
    const part = (n: number) => String(n).repeat(USER_SKILLS_LIMITS.writeMaxBytes);
    let size = 0;
    for (let n = 0; n < 3; n++) {
      const out = await approved(grant, "write_skill", { name: "long", file: "REFERENCE.md", content: part(n), offset: size });
      expect(out.status).toBe("succeeded");
      size = (out as { result: { size: number } }).result.size;
    }
    const whole = [0, 1, 2].map(part).join("");
    expect(readFileSync(path.join(skillsDir("alice"), "long", "REFERENCE.md"), "utf8")).toBe(whole);
    let text = "";
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const out = await grant.request("read_skill", { name: "long", file: "REFERENCE.md", offset, max_bytes: 300_000 });
      const window = (out as { result: { content: string; next_offset?: number } }).result;
      text += window.content;
      offset = window.next_offset;
    }
    expect(text).toBe(whole);
    // A fourth chunk fills the 1 MiB quota exactly; one more byte is refused.
    const fourth = await approved(grant, "write_skill", { name: "long", file: "REFERENCE.md", content: part(3), offset: size });
    expect(fourth.status).toBe("succeeded");
    const full = (fourth as { result: { size: number } }).result.size;
    expect(full).toBe(USER_SKILLS_LIMITS.skillTotalMaxBytes);
    const over = await approved(grant, "write_skill", { name: "long", file: "REFERENCE.md", content: "!", offset: full });
    expect(over.status).toBe("failed");
  });

  it("pages the skill list and counts files written by other channels", async () => {
    for (let i = 0; i < 7; i++) {
      mkdirSync(path.join(skillsDir("alice"), `s${i}`), { recursive: true });
      writeFileSync(path.join(skillsDir("alice"), `s${i}`, "SKILL.md"), `skill ${i}`);
    }
    for (let i = 0; i < 150; i++) writeFileSync(path.join(skillsDir("alice"), "s0", `extra${i}.md`), "x");
    const grant = openAlice();
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const out = await grant.request("list_skills", cursor ? { cursor, limit: 3 } : { limit: 3 });
      const page = (out as { result: { skills: Array<{ name: string; file_count: number; files: string[] }>; next_cursor?: string } }).result;
      for (const skill of page.skills) {
        names.push(skill.name);
        if (skill.name === "s0") expect(skill.files).toHaveLength(skill.file_count);
        if (skill.name === "s0") expect(skill.file_count).toBe(151);
      }
      cursor = page.next_cursor;
    } while (cursor);
    expect(names).toEqual(["greeting", "s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  it("the per-skill file count cap refuses the file that would cross it", async () => {
    for (let i = 0; i < USER_SKILLS_LIMITS.maxFilesPerSkill; i++) {
      writeFileSync(path.join(skillsDir("alice"), "greeting", `f${i}.md`), "x");
    }
    const grant = openAlice();
    const out = await approved(grant, "write_skill", { name: "greeting", file: "onemore.md", content: "x" });
    expect(out.status).toBe("failed");
  });
});

describe("revocation", () => {
  it("revokeAccount fails every held grant closed", async () => {
    const grant = openAlice();
    expect((await grant.request("list_skills", {})).status).toBe("succeeded");
    plane.revokeAccount("alice");
    expect((await grant.request("list_skills", {})).status).toBe("denied");
  });

  it("deleting the account fails the very next adapter call", async () => {
    const grant = openAlice();
    users.delete("alice");
    expect((await grant.request("list_skills", {})).status).toBe("failed");
    expect(plane.open({ username: "alice", purpose: "test", rights: READ_OPS })).toBeNull();
    expect((await grant.request("list_skills", {})).status).toBe("denied");
  });
});
