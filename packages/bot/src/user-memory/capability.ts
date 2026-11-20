/**
 * The user-memory capability plane — `user-memory-v1:<owner>`.
 *
 * ── What this is, and what already existed ──────────────────────────────────
 *
 * Every account has a private memory directory on the BOT host
 * (`<dataDir>/users/<name>/memory`, `User.memoryDir`). Two consumers already
 * exist and neither goes through a Gate:
 *
 *   · the machines MCP plugin's `memory_*` tools, jailed by an env-supplied
 *     root inside the user's own chat session (`plugins/machines/src/server.ts`);
 *   · the router's MEMORY.md head injection into every session's system prompt.
 *
 * Those are the user's own chat surface acting as the user, and they stay
 * untouched. What did NOT exist is an owner-consented, revocable, per-call-
 * approvable authority that an EXTERNAL agent (an mcp_ token) can hold over
 * the same directory. That is this Object.
 *
 * Per the resource-binding rule, a new backend resource gets its OWN
 * capability Object rather than new operations on an existing one: this
 * table versions alone (`v1`), and bumping it retires only this plane's
 * roots and undecided cards — never the Runner's, the scan home's or the
 * workspace plane's.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 *
 * The Object id carries the owner; the binding resolves the directory AT CALL
 * TIME from the trusted user registry (the `local-scan.ts` precedent), never
 * from an argument — there is no owner/home/root field in any schema below.
 * Inside the directory, every path argument passes the shared realpath jail
 * (`session/path-jail.ts`): `../`, absolute paths, symlinks pointing out and
 * writes through symlinked directories all stop before any bytes move.
 *
 * ── Size ────────────────────────────────────────────────────────────────────
 *
 * Bounds apply to one call, never to what the directory holds: a read returns
 * a window (`offset` → `next_offset`), a listing or search a page (`cursor` →
 * `next_cursor`), and a write carries one chunk (`write_memory` at an
 * `offset`, or `append_memory`). The old 1 MiB-per-file and 1000-file caps
 * existed only because a read or a listing returned the whole thing; the
 * directory also holds content other subsystems write (the HQ project
 * repository), which they never bounded. The machines plugin's `memory_*`
 * tools over the same directory follow the same window/page/chunk rules.
 *
 * `bindingFor` is re-read on every use: deleting the account (or un-wiring
 * the directory resolver) revokes the standing root, and everything derived
 * from it fails its next ancestry check. That is what "摘掉即撤销" means here.
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
import { StringDecoder } from "node:string_decoder";
import { resolveForRead, resolveForWrite } from "../session/path-jail.js";
import { readTextWindow, walkFilesSorted, writeAtOffset } from "../session/file-window.js";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";
import { createLogger } from "../logger.js";

const log = createLogger("user-memory-capability");

/** The Context-local slot every user-memory grant is installed under. */
export const USER_MEMORY_SLOT = "user-memory";

/** `${prefix}:${owner}` is the Object id; `v1` moves only when THIS table does. */
export const USER_MEMORY_OBJECT_PREFIX = "user-memory-v1";

export const USER_MEMORY_LIMITS = {
  pathMaxBytes: 512,
  /** Bytes one read returns; `next_offset` continues. Fits the kernel's 8 MiB result even fully escaped. */
  readWindowBytes: 1024 * 1024,
  /**
   * Bytes one write or append carries. One call's encoded arguments are
   * capped at 512 KiB by the kernel; larger content is written in chunks.
   */
  writeMaxBytes: 256 * 1024,
  appendMaxBytes: 256 * 1024,
  /** Files one listing page returns; `next_cursor` continues. */
  listPageMax: 500,
  searchQueryMaxBytes: 256,
  /** Hits one search page returns; `next_cursor` continues over the remaining files. */
  searchMaxHits: 50,
  /** File bytes one search page scans before it hands back a cursor (at least one file). */
  searchScanBytes: 64 * 1024 * 1024,
} as const;

const PATH_ARG = { type: "string", required: true, maxLength: USER_MEMORY_LIMITS.pathMaxBytes } as const;

/**
 * The closed operation table.
 *
 * Three observe/read and two `modify`. There is no owner, no username, no
 * absolute path and no root anywhere in a schema — the kernel refuses
 * arguments a schema does not declare, so "this plane cannot name another
 * account's directory" is a property of the table.
 *
 * `write_memory` is declared `retrySafe: true` against the `modify` default:
 * it is a full-content overwrite, or with `offset` a chunk placed at that
 * offset that also ends the file there — either way running it twice lands the
 * same bytes as running it once, and interrupt recovery may hand an undecided
 * write back to the owner instead of writing it off as `unknown`. `append_memory` keeps the
 * default `false`, stated explicitly: appending twice IS the duplicate.
 */
const CURSOR_ARG = { type: "string", maxLength: 4096 } as const;
const OFFSET_ARG = { type: "number", min: 0, integer: true } as const;

export const USER_MEMORY_OPERATIONS: Record<Operation, OperationSpec> = {
  list_memory: {
    args: {
      cursor: CURSOR_ARG,
      limit: { type: "number", min: 1, max: USER_MEMORY_LIMITS.listPageMax, integer: true },
    },
    effect: "observe",
    title: "列出记忆文件",
  },
  read_memory: {
    args: {
      path: PATH_ARG,
      offset: OFFSET_ARG,
      max_bytes: { type: "number", min: 64, max: USER_MEMORY_LIMITS.readWindowBytes, integer: true },
    },
    effect: "read",
    title: "读取记忆文件",
  },
  search_memory: {
    args: {
      query: { type: "string", required: true, maxLength: USER_MEMORY_LIMITS.searchQueryMaxBytes },
      limit: { type: "number", min: 1, max: USER_MEMORY_LIMITS.searchMaxHits, integer: true },
      cursor: CURSOR_ARG,
    },
    effect: "read",
    title: "搜索记忆",
  },
  write_memory: {
    args: {
      path: PATH_ARG,
      content: { type: "string", required: true, maxLength: USER_MEMORY_LIMITS.writeMaxBytes },
      offset: OFFSET_ARG,
    },
    effect: "modify",
    retrySafe: true,
    title: "写入记忆文件",
  },
  append_memory: {
    args: {
      path: PATH_ARG,
      content: { type: "string", required: true, maxLength: USER_MEMORY_LIMITS.appendMaxBytes },
    },
    effect: "modify",
    retrySafe: false,
    title: "追加记忆文件",
  },
};

/** Every operation this resource can back. Used by the permission projection. */
export const USER_MEMORY_OPERATION_NAMES: readonly string[] = Object.keys(USER_MEMORY_OPERATIONS);

interface UserMemoryBinding {
  /** Fixed at registration from the trusted user row. Never from arguments. */
  owner: string;
  /**
   * Resolved at CALL time rather than captured (the `local-scan.ts`
   * precedent), so the answer always comes from the live user registry. The
   * closure is held only by the kernel's registry; no caller can reach it.
   */
  resolveRoot: () => string | undefined;
}

/**
 * Mandatory policy: the same three decisions, in the same order, as every
 * other plane's — exact approval evidence, then the grant's own terms, then
 * ask the owner. Written out rather than shared, because a policy with a
 * parameter is a policy with a branch.
 *
 * The card for a write says the one thing a reader must know that a file
 * write usually does not imply: the head of `MEMORY.md` is injected into the
 * system prompt of every future session, so approving a write to it is
 * approving a durable change to what the agent believes.
 */
function userMemoryPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "user-memory object has no bound owner" };

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
  const relPath = String(input.args.path ?? "");
  if (input.operation === "list_memory") {
    details.push("范围：记忆目录的文件清单（路径/大小/时间，不含内容），一次一页");
  } else if (input.operation === "search_memory") {
    details.push(`检索词：${String(input.args.query ?? "").slice(0, 80)}`);
  } else {
    details.push(`文件：${relPath.slice(0, 300)}`);
  }
  if (input.operation === "write_memory" || input.operation === "append_memory") {
    const bytes = typeof input.args.content === "string" ? Buffer.byteLength(input.args.content, "utf8") : 0;
    const offset = typeof input.args.offset === "number" ? input.args.offset : undefined;
    details.push(
      input.operation === "append_memory"
        ? `将追加：${bytes} 字节（原内容保留）`
        : offset === undefined || offset === 0
          ? `将写入：${bytes} 字节（整份覆盖，不保留旧内容）`
          : `将写入：${bytes} 字节，从第 ${offset} 字节起（保留前 ${offset} 字节，其后的旧内容由这一块取代）`,
    );
    if (relPath.replace(/^\.\//, "") === "MEMORY.md") {
      details.push("注意：MEMORY.md 的开头会自动注入你未来每次会话的 system prompt。");
    }
  }
  details.push(`动作类别：${input.effect}`);
  details.push(`发起方：${input.context.metadata.purpose ?? input.context.kind}`);
  details.push(`参数指纹：${input.argsHash.slice(0, 16)}`);
  return {
    kind: "approval_required",
    summary: {
      title: `${input.spec.title ?? input.operation} · ${owner}/中心记忆区`,
      target: `${owner}/bot-host-memory`,
      details,
      allowedApprover: owner,
    },
  };
}

/** Write the whole content, atomically: temp in the SAME directory, then rename. */
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

/**
 * One page of a case-insensitive substring search, in path order. A page ends
 * at `limit` hits or after `searchScanBytes` of file content (at least one
 * file), and `next_cursor` resumes after the last file it searched, so every
 * file is reachable. Files are read in chunks; the first hit in a file is
 * reported with a short excerpt.
 */
async function searchFiles(root: string, query: string, limit: number, cursor: string | undefined) {
  const needle = query.toLowerCase();
  const hits: Array<{ path: string; excerpt: string }> = [];
  let scanned = 0;
  let last: string | undefined;
  let more = false;
  for await (const file of walkFilesSorted(root, cursor)) {
    if (hits.length >= limit || (last !== undefined && scanned >= USER_MEMORY_LIMITS.searchScanBytes)) { more = true; break; }
    last = file.path;
    try {
      const found = await firstMatch(file.full, needle, (bytes) => { scanned += bytes; });
      if (found !== null) hits.push({ path: file.path, excerpt: found });
    } catch {
      // unreadable file — skip
    }
  }
  return { query, returned: hits.length, hits, ...(more && last !== undefined ? { next_cursor: last } : {}) };
}

/** The excerpt around the first case-insensitive occurrence of `needle`, reading the file in chunks. */
async function firstMatch(file: string, needle: string, counted: (bytes: number) => void): Promise<string | null> {
  const handle = await fs.open(file, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = "";
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      counted(bytesRead);
      const text = carry + (bytesRead ? decoder.write(chunk.subarray(0, bytesRead)) : decoder.end());
      const index = text.toLowerCase().indexOf(needle);
      if (index >= 0) {
        // Up to 200 characters after the hit, reading on once if this chunk ends sooner.
        let tail = text.slice(index, index + 200);
        if (tail.length < 200 && bytesRead) {
          const { bytesRead: more } = await handle.read(chunk, 0, 4096, null);
          tail = (text + decoder.write(chunk.subarray(0, more))).slice(index, index + 200);
        }
        return text.slice(Math.max(0, index - 100), index) + tail;
      }
      if (!bytesRead) return null;
      // Keep enough to find a hit that spans chunks and show 100 characters before it.
      carry = text.slice(-(needle.length + 100));
    }
  } finally {
    await handle.close();
  }
}

/**
 * The adapter — the resource's only holder. Everything it touches sits under
 * the call-time-resolved root, behind the shared realpath jail.
 */
async function userMemoryAdapter(
  binding: UserMemoryBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const root = binding.resolveRoot();
  // Not an authorisation failure — the gate already said yes. The account has
  // no memory directory, which is an operational fact about this deployment.
  if (!root) throw new Error("该账号在 bot 主机上没有记忆目录");
  // Idempotent self-heal: the jail needs a real root, and the user manager
  // creates this directory anyway.
  await fs.mkdir(root, { recursive: true, mode: 0o700 }).catch(() => {});

  switch (operation) {
    case "list_memory": {
      const limit = Number(args.limit ?? USER_MEMORY_LIMITS.listPageMax);
      const cursor = typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
      const files: Array<{ path: string; size: number; mtime: string }> = [];
      let more = false;
      for await (const file of walkFilesSorted(root, cursor)) {
        if (files.length >= limit) { more = true; break; }
        const st = await fs.stat(file.full).catch(() => null);
        if (st) files.push({ path: file.path, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      }
      return { returned: files.length, files, ...(more ? { next_cursor: files.at(-1)!.path } : {}) };
    }
    case "read_memory": {
      const target = await resolveForRead(root, String(args.path ?? ""));
      const window = await readTextWindow(target, Number(args.offset ?? 0), Number(args.max_bytes ?? USER_MEMORY_LIMITS.readWindowBytes));
      return { path: args.path, ...window };
    }
    case "search_memory": {
      const query = String(args.query ?? "");
      if (!query) throw new Error("search_memory 需要 query");
      const limit = Math.max(1, Math.min(USER_MEMORY_LIMITS.searchMaxHits, Number(args.limit ?? 10) || 10));
      return await searchFiles(root, query, limit, typeof args.cursor === "string" && args.cursor ? args.cursor : undefined);
    }
    case "write_memory":
    case "append_memory": {
      const content = String(args.content ?? "");
      const bytes = Buffer.byteLength(content, "utf8");
      const target = await resolveForWrite(root, String(args.path ?? ""));
      const existing = await fs.lstat(target).catch(() => null);
      if (existing && !existing.isFile()) throw new Error("目标不是普通文件，拒绝写入");
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (operation === "append_memory") {
        await fs.appendFile(target, content, { encoding: "utf8", mode: 0o600 });
        return { path: args.path, bytes, mode: "append", size: (await fs.stat(target)).size };
      }
      const offset = Number(args.offset ?? 0);
      if (offset > 0) {
        if (!existing) throw new Error(`文件不存在：分块写入的第一块请用 offset 0（或不传 offset）`);
        return { path: args.path, bytes, mode: "write", offset, size: await writeAtOffset(target, offset, content) };
      }
      await atomicWrite(target, content);
      return { path: args.path, bytes, mode: "write", size: bytes };
    }
    default:
      // Unreachable: the registry rejects operations it does not declare.
      throw new Error(`unsupported user-memory operation: ${operation}`);
  }
}

/** A narrow, closable authority over one account's memory directory. */
export class UserMemoryGrant extends SlotGrant {
  constructor(svc: CapabilityService, contextId: ContextId, purpose: string, owner: string, borrowed = false) {
    super(svc, contextId, USER_MEMORY_SLOT, purpose, owner, borrowed);
  }
}

export interface UserMemoryCapabilitiesOptions {
  /** The process's ONE capability service — shared, never a second instance. */
  service: CapabilityService;
  /** The trusted user directory. An account that does not exist holds nothing. */
  userExists: (username: string) => boolean;
  /** Trusted resolver: `User.memoryDir` for a live account. Server-side only. */
  memoryDirFor: (username: string) => string | undefined;
  now?: () => number;
}

export class UserMemoryCapabilities {
  private authority: AccountAuthority<UserMemoryBinding>;

  constructor(private opts: UserMemoryCapabilitiesOptions) {
    this.authority = new AccountAuthority<UserMemoryBinding>({
      service: opts.service,
      slot: USER_MEMORY_SLOT,
      objectPrefix: USER_MEMORY_OBJECT_PREFIX,
      kind: "user-memory",
      operations: USER_MEMORY_OPERATIONS,
      policy: userMemoryPolicy,
      adapter: userMemoryAdapter as ObjectDefinition<UserMemoryBinding>["adapter"],
      now: opts.now,
      // The account's own memory: writes may be silent once a grant says so
      // (O1). The root is only a ceiling; every caller still states its terms.
      rootAutoAllow: (_username, defaults) => [...defaults, "write_memory", "append_memory"],
      /**
       * Re-read on EVERY use. Returning null does not merely refuse —
       * `AccountAuthority` revokes whatever root is still standing, so
       * deleting the account ends every grant derived over its memory.
       */
      bindingFor: (name) => {
        if (!opts.userExists(name)) return null;
        if (!this.rootFor(name)) return null;
        // The closure re-asks BOTH trusted facts at call time, so a deleted
        // account fails its very next adapter call, not merely its next open.
        return { owner: name, resolveRoot: () => (opts.userExists(name) ? this.rootFor(name) : undefined) };
      },
      onWarning: (message, fields) => log.warn(fields, message),
    });
  }

  /** Shared process kernel, for the trusted composition that owns the planes. */
  get service(): CapabilityService {
    return this.opts.service;
  }

  /** The trusted directory, or undefined. Server-side only; never sent to a browser. */
  rootFor(username: string): string | undefined {
    const dir = this.opts.memoryDirFor(String(username ?? "").trim());
    return dir && dir.trim() ? dir : undefined;
  }

  /**
   * Derive a Context over this account's memory directory. Null is a
   * fail-closed answer: no user row, no directory, or none of `rights`
   * survives the intersection.
   */
  open(o: {
    username: string;
    purpose: string;
    rights: readonly Operation[];
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
    pool?: string;
  }): UserMemoryGrant | null {
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
    return new UserMemoryGrant(this.opts.service, derived.contextId, o.purpose, username, derived.borrowed);
  }

  /** What this account's memory root holds right now. */
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
