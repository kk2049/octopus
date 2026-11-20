/**
 * The user-skills capability plane — `user-skills-v1:<owner>`.
 *
 * ── The resource ────────────────────────────────────────────────────────────
 *
 * A skill is a directory `<user home>/.claude/skills/<name>/` with `SKILL.md`
 * as its main file (`User.skillsDir`). The user manager creates the root at
 * registration; Claude Code sessions running under that HOME discover skills
 * natively, so writing here changes what those agents can be instructed to
 * do. That sentence is why both write verbs are per-call approvals: a skill
 * is executable instruction, and installing one is closer to installing code
 * than to saving a note.
 *
 * Until this file there was NO registry surface at all — only the directory
 * convention. This Object is the first consented, revocable door: an
 * external agent (an mcp_ token) can be granted list/read, and can PROPOSE
 * writes that the owner approves one card at a time.
 *
 * Per the resource-binding rule this is its own Object with its own version
 * (`v1`), so its table evolves without retiring any other plane's roots or
 * undecided cards.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 *
 * Same shape as `user-memory/capability.ts`: the Object id carries the owner;
 * the binding resolves the skills root at CALL time from the trusted user
 * registry; no schema has an owner/home/root field. Inside the root, the
 * skill NAME is a closed token (`^[a-z][a-z0-9-]{0,63}$`) and a skill FILE is
 * a short relative path whose every segment must start with an alphanumeric —
 * which structurally excludes `.`, `..` and dotfiles — before the shared
 * realpath jail checks the resolved path a second time.
 *
 * ── Size ────────────────────────────────────────────────────────────────────
 *
 * Transport bounds apply to one call: a read returns a window (`offset` →
 * `next_offset`), a listing a page of skills (`cursor` → `next_cursor`), and
 * a write one chunk placed at an `offset`. A file is no longer capped at the
 * 256 KiB one call could carry. What remains are product quotas on the
 * registry itself — one skill ≤ 1 MiB and ≤ 100 files, one account ≤ 200
 * skills: a skill is an instruction bundle the owner's agents load, and the
 * quotas keep it one. They are checked against everything the directory
 * actually holds, including files written through other channels.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  CapabilityService,
  type ContextId,
  type ObjectDefinition,
  type Operation,
  type OperationSpec,
  type PolicyDecision,
  type PolicyInput,
} from "@claude-bot/capability-kernel";
import { resolveForRead, resolveForWrite } from "../session/path-jail.js";
import { readTextWindow, walkFilesSorted, writeAtOffset } from "../session/file-window.js";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { createLogger } from "../logger.js";

const log = createLogger("user-skills-capability");

/** The Context-local slot every user-skills grant is installed under. */
export const USER_SKILLS_SLOT = "user-skills";

/** `${prefix}:${owner}` is the Object id; `v1` moves only when THIS table does. */
export const USER_SKILLS_OBJECT_PREFIX = "user-skills-v1";

/** The closed skill-name vocabulary. Everything else is refused, not escaped. */
export const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * One path segment inside a skill. The first character must be alphanumeric,
 * so `.`, `..` and every dotfile are impossible by construction rather than
 * filtered; the realpath jail still re-checks the resolved result.
 */
const SKILL_FILE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const USER_SKILLS_LIMITS = {
  nameMaxBytes: 64,
  filePathMaxBytes: 200,
  fileMaxDepth: 4,
  /** Bytes one write call carries (the kernel caps encoded args at 512 KiB); larger files go in chunks. */
  writeMaxBytes: 256 * 1024,
  /** Bytes one read returns; `next_offset` continues. */
  readWindowBytes: 1024 * 1024,
  /** Skills one listing page returns; `next_cursor` continues. */
  listPageMax: 50,
  /** Product quotas on the registry (see the header). */
  skillTotalMaxBytes: 1024 * 1024,
  maxFilesPerSkill: 100,
  maxSkills: 200,
} as const;

const NAME_ARG = { type: "string", required: true, maxLength: USER_SKILLS_LIMITS.nameMaxBytes } as const;
const FILE_ARG = { type: "string", maxLength: USER_SKILLS_LIMITS.filePathMaxBytes } as const;
const OFFSET_ARG = { type: "number", min: 0, integer: true } as const;

/**
 * The closed operation table: one observe, one read, two `modify`.
 *
 * `write_skill` is `retrySafe: true` against the modify default — a full-file
 * overwrite, or a chunk placed at `offset` that also ends the file there,
 * lands the same bytes twice — and `remove_skill` likewise: removing
 * an already-removed skill is the removed state. Interrupt recovery therefore
 * hands both back to the owner as pending decisions instead of `unknown`.
 */
export const USER_SKILLS_OPERATIONS: Record<Operation, OperationSpec> = {
  list_skills: {
    args: {
      cursor: { type: "string", maxLength: USER_SKILLS_LIMITS.nameMaxBytes },
      limit: { type: "number", min: 1, max: USER_SKILLS_LIMITS.listPageMax, integer: true },
    },
    effect: "observe",
    title: "列出技能",
  },
  read_skill: {
    args: {
      name: NAME_ARG,
      file: FILE_ARG,
      offset: OFFSET_ARG,
      max_bytes: { type: "number", min: 64, max: USER_SKILLS_LIMITS.readWindowBytes, integer: true },
    },
    effect: "read",
    title: "读取技能文件",
  },
  write_skill: {
    args: {
      name: NAME_ARG,
      file: FILE_ARG,
      content: { type: "string", required: true, maxLength: USER_SKILLS_LIMITS.writeMaxBytes },
      offset: OFFSET_ARG,
    },
    effect: "modify",
    retrySafe: true,
    title: "写入技能文件",
  },
  remove_skill: {
    args: { name: NAME_ARG },
    effect: "modify",
    retrySafe: true,
    title: "删除技能",
  },
};

/** Every operation this resource can back. Used by the permission projection. */
export const USER_SKILLS_OPERATION_NAMES: readonly string[] = Object.keys(USER_SKILLS_OPERATIONS);

interface UserSkillsBinding {
  owner: string;
  /** Resolved at CALL time from the trusted user registry. */
  resolveRoot: () => string | undefined;
}

function requireSkillName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`技能名不合法（需匹配 ^[a-z][a-z0-9-]{0,63}$）：${name.slice(0, 80)}`);
  }
  return name;
}

/** Empty/omitted means the skill's main file. */
function requireSkillFile(value: unknown): string {
  const file = String(value ?? "").trim() || "SKILL.md";
  const segments = file.split("/");
  if (segments.length > USER_SKILLS_LIMITS.fileMaxDepth) {
    throw new Error(`技能文件路径层级过深（最多 ${USER_SKILLS_LIMITS.fileMaxDepth} 层）：${file.slice(0, 120)}`);
  }
  for (const segment of segments) {
    if (!SKILL_FILE_SEGMENT_RE.test(segment)) {
      throw new Error(`技能文件路径段不合法：${segment.slice(0, 80)}`);
    }
  }
  return segments.join("/");
}

/**
 * Mandatory policy — same three decisions in the same order as every plane.
 * The write card says out loud that a skill is an instruction the owner's
 * agents will follow, because that is what a person is actually approving.
 */
function userSkillsPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "user-skills object has no bound owner" };

  const a = input.approval;
  if (
    a
    && a.objectId === input.object.id
    && a.operation === input.operation
    && a.argsHash === input.argsHash
    && a.contextId === input.context.id
    && a.slot === input.slot
    && a.approver === owner
  ) {
    return { kind: "allow" };
  }

  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };

  const details: string[] = [];
  const name = String(input.args.name ?? "").slice(0, 80);
  if (input.operation === "list_skills") {
    details.push("范围：技能目录清单（名字、文件列表、大小，不含内容），一次一页");
  } else {
    details.push(`技能：${name}`);
  }
  if (input.operation === "read_skill") {
    details.push(`文件：${String(input.args.file ?? "SKILL.md").slice(0, 200) || "SKILL.md"}`);
  }
  if (input.operation === "write_skill") {
    const bytes = typeof input.args.content === "string" ? Buffer.byteLength(input.args.content, "utf8") : 0;
    details.push(`文件：${String(input.args.file ?? "SKILL.md").slice(0, 200) || "SKILL.md"}`);
    const offset = typeof input.args.offset === "number" ? input.args.offset : 0;
    details.push(offset > 0
      ? `将写入：${bytes} 字节，从第 ${offset} 字节起（保留前 ${offset} 字节，其后的旧内容由这一块取代）`
      : `将写入：${bytes} 字节（整份覆盖，不保留旧内容）`);
    details.push("注意：技能是会被你的 agent 加载执行的指令。批准这次写入 = 改变 agent 未来的行为。");
  }
  if (input.operation === "remove_skill") {
    details.push("将删除整个技能目录，不可恢复。");
  }
  details.push(`动作类别：${input.effect}`);
  details.push(`发起方：${input.context.metadata.purpose ?? input.context.kind}`);
  details.push(`参数指纹：${input.argsHash.slice(0, 16)}`);
  return {
    kind: "approval_required",
    summary: {
      title: `${input.spec.title ?? input.operation} · ${owner}/技能库`,
      target: `${owner}/bot-host-skills`,
      details,
      allowedApprover: owner,
    },
  };
}

/** Every plain file of ONE skill directory, in path order; symlinks skipped. */
async function walkSkillFiles(dir: string): Promise<Array<{ path: string; size: number }>> {
  const out: Array<{ path: string; size: number }> = [];
  for await (const file of walkFilesSorted(dir)) {
    const st = await fs.stat(file.full).catch(() => null);
    if (st) out.push({ path: file.path, size: st.size });
  }
  return out;
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomBytes(6).toString("hex")}`);
  await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function userSkillsAdapter(
  binding: UserSkillsBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const root = binding.resolveRoot();
  if (!root) throw new Error("该账号在 bot 主机上没有技能目录");
  await fs.mkdir(root, { recursive: true, mode: 0o700 }).catch(() => {});

  switch (operation) {
    case "list_skills": {
      const limit = Number(args.limit ?? USER_SKILLS_LIMITS.listPageMax);
      const cursor = typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
      const dirents = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      // A symlinked directory is not a skill this plane will describe.
      const names = dirents.filter((d) => d.isDirectory() && SKILL_NAME_RE.test(d.name)).map((d) => d.name)
        .filter((name) => cursor === undefined || name > cursor).sort();
      const skills: Array<{ name: string; has_skill_md: boolean; file_count: number; total_bytes: number; files: string[] }> = [];
      for (const name of names.slice(0, limit)) {
        const files = await walkSkillFiles(path.join(root, name));
        skills.push({
          name,
          has_skill_md: files.some((f) => f.path === "SKILL.md"),
          file_count: files.length,
          total_bytes: files.reduce((sum, f) => sum + f.size, 0),
          files: files.map((f) => f.path),
        });
      }
      return { returned: skills.length, skills, ...(names.length > limit ? { next_cursor: skills.at(-1)!.name } : {}) };
    }
    case "read_skill": {
      const name = requireSkillName(args.name);
      const file = requireSkillFile(args.file);
      const target = await resolveForRead(root, `${name}/${file}`);
      const window = await readTextWindow(target, Number(args.offset ?? 0), Number(args.max_bytes ?? USER_SKILLS_LIMITS.readWindowBytes));
      return { name, file, ...window };
    }
    case "write_skill": {
      const name = requireSkillName(args.name);
      const file = requireSkillFile(args.file);
      const content = String(args.content ?? "");
      const bytes = Buffer.byteLength(content, "utf8");
      const offset = Number(args.offset ?? 0);
      const skillDir = path.join(root, name);
      const dirStat = await fs.lstat(skillDir).catch(() => null);
      if (dirStat && !dirStat.isDirectory()) throw new Error(`技能名被一个非目录占用：${name}`);
      if (!dirStat) {
        const dirents = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        const count = dirents.filter((d) => d.isDirectory()).length;
        if (count >= USER_SKILLS_LIMITS.maxSkills) {
          throw new Error(`技能数已达上限 (${USER_SKILLS_LIMITS.maxSkills})，请先整理`);
        }
      }
      const files = dirStat ? await walkSkillFiles(skillDir) : [];
      const existing = files.find((f) => f.path === file);
      if (offset > 0 && !existing) throw new Error("文件不存在：分块写入的第一块请用 offset 0（或不传 offset）");
      if (existing && offset > existing.size) {
        throw new Error(`offset ${offset} 超过当前文件大小 ${existing.size}：分块写入时每块的 offset 等于上一块返回的 size`);
      }
      if (!existing && files.length >= USER_SKILLS_LIMITS.maxFilesPerSkill) {
        throw new Error(`该技能文件数已达上限 (${USER_SKILLS_LIMITS.maxFilesPerSkill})`);
      }
      const size = offset + bytes;
      const nextTotal = files.reduce((sum, f) => sum + f.size, 0) - (existing?.size ?? 0) + size;
      if (nextTotal > USER_SKILLS_LIMITS.skillTotalMaxBytes) {
        throw new Error(`该技能总大小将超过上限 (${USER_SKILLS_LIMITS.skillTotalMaxBytes} 字节)`);
      }
      const target = await resolveForWrite(root, `${name}/${file}`);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (offset > 0) return { name, file, bytes, offset, size: await writeAtOffset(target, offset, content) };
      await atomicWrite(target, content);
      return { name, file, bytes, size };
    }
    case "remove_skill": {
      const name = requireSkillName(args.name);
      const target = path.join(root, name);
      const st = await fs.lstat(target).catch(() => null);
      if (!st) return { name, existed: false };
      if (st.isSymbolicLink()) {
        // Remove the LINK, never what it points at.
        await fs.unlink(target);
        return { name, existed: true };
      }
      // Jail re-check on the resolved directory before the recursive delete.
      const real = await resolveForRead(root, name);
      await fs.rm(real, { recursive: true, force: true });
      return { name, existed: true };
    }
    default:
      throw new Error(`unsupported user-skills operation: ${operation}`);
  }
}

/** A narrow, closable authority over one account's skills directory. */
export class UserSkillsGrant extends SlotGrant {
  constructor(svc: CapabilityService, contextId: ContextId, purpose: string, owner: string, borrowed = false) {
    super(svc, contextId, USER_SKILLS_SLOT, purpose, owner, borrowed);
  }
}

export interface UserSkillsCapabilitiesOptions {
  /** The process's ONE capability service — shared, never a second instance. */
  service: CapabilityService;
  /** The trusted user directory. An account that does not exist holds nothing. */
  userExists: (username: string) => boolean;
  /** Trusted resolver: `User.skillsDir` for a live account. Server-side only. */
  skillsDirFor: (username: string) => string | undefined;
  now?: () => number;
}

export class UserSkillsCapabilities {
  private authority: AccountAuthority<UserSkillsBinding>;

  constructor(private opts: UserSkillsCapabilitiesOptions) {
    this.authority = new AccountAuthority<UserSkillsBinding>({
      service: opts.service,
      slot: USER_SKILLS_SLOT,
      objectPrefix: USER_SKILLS_OBJECT_PREFIX,
      kind: "user-skills",
      operations: USER_SKILLS_OPERATIONS,
      policy: userSkillsPolicy,
      adapter: userSkillsAdapter as ObjectDefinition<UserSkillsBinding>["adapter"],
      now: opts.now,
      // The account's own skills: writing one may be silent once granted (O1);
      // removing a whole skill directory stays a per-call approval.
      rootAutoAllow: (_username, defaults) => [...defaults, "write_skill"],
      bindingFor: (name) => {
        if (!opts.userExists(name)) return null;
        if (!this.rootFor(name)) return null;
        // Both trusted facts re-asked at call time (see user-memory).
        return { owner: name, resolveRoot: () => (opts.userExists(name) ? this.rootFor(name) : undefined) };
      },
      onWarning: (message, fields) => log.warn(fields, message),
    });
  }

  get service(): CapabilityService {
    return this.opts.service;
  }

  rootFor(username: string): string | undefined {
    const dir = this.opts.skillsDirFor(String(username ?? "").trim());
    return dir && dir.trim() ? dir : undefined;
  }

  open(o: {
    username: string;
    purpose: string;
    rights: readonly Operation[];
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
    pool?: string;
  }): UserSkillsGrant | null {
    const username = String(o.username ?? "").trim();
    const derived = this.authority.derive({
      username,
      purpose: o.purpose,
      kind: "session",
      rights: o.rights,
      autoAllow: o.autoAllow,
      metadata: o.metadata,
      pool: o.pool,
    });
    if (!derived) return null;
    return new UserSkillsGrant(this.opts.service, derived.contextId, o.purpose, username, derived.borrowed);
  }

  /** What this account's skills root holds right now. */
  accountOperations(username: string): string[] {
    return this.authority.rightsOfAccount(username);
  }

  /** Teardown half of a revocation; `surface` narrows to one pool prefix. */
  dropPooled(username: string, surface?: string): number {
    return this.authority.dropPooled(username, surface);
  }

  revokeAccount(username: string): void {
    this.authority.revokeAccount(username);
  }

  /** Test/diagnostics. */
  get pooledContexts(): number {
    return this.authority.pooledContexts;
  }
}
