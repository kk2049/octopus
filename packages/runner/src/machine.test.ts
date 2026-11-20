import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, truncateSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  machineExec,
  machineReadFile,
  machineWriteFile,
  machineListDir,
  machineHostInfo,
  machineAppendSession,
  pruneExecSpills,
  execSpillDir,
  EXEC_MAX_OUTPUT,
  EXEC_SPILL_KEEP_FILES,
  EXEC_SPILL_TTL_MS,
  FILE_MAX_BYTES,
  LIST_MAX_ENTRIES,
  WRITE_MAX_BYTES,
  APPEND_MAX_PROMPT,
} from "./machine.js";
import { handleRpc } from "./core.js";
import type { AgentControlPlane } from "./agent-control-plane.js";
import { AgentInteractionBroker } from "./agent-interactions.js";
import { LaunchJournal } from "./launch-journal.js";
import { CodexAccountRouter } from "./codex-account-routing.js";
import { KnowledgeIndexManager } from "./knowledge-index.js";
import { fakeExecutables } from "../../../tools/test-support/fake-executables.mjs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "machine-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("machineExec", () => {
  it("runs a command and returns stdout with exit code 0", async () => {
    const r = await machineExec({ command: "echo hello", cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.cwd).toBe(dir);
  });

  it("reports a non-zero exit without throwing", async () => {
    const r = await machineExec({ command: "exit 3", cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(3);
  });

  it("captures stderr separately", async () => {
    const r = await machineExec({ command: "echo oops >&2", cwd: dir });
    expect(r.stderr.trim()).toBe("oops");
  });

  it("kills a command that exceeds its timeout instead of hanging", async () => {
    const r = await machineExec({ command: "sleep 30", cwd: dir, timeout_ms: 1000 });
    expect(r.ok).toBe(false);
    expect(r.timed_out).toBe(true);
    expect(r.duration_ms).toBeLessThan(10_000);
  });

  it("completes a command printing far more than the old buffer and spills its whole output", async () => {
    const spill = join(dir, "spill");
    // ~1.9 MB on stdout: the old `exec` maxBuffer (200 KB) SIGKILLed this midway.
    const r = await machineExec({ command: "seq 1 300000; echo done", cwd: dir }, spill);
    const expected = `${Array.from({ length: 300_000 }, (_, i) => i + 1).join("\n")}\ndone\n`;
    expect(r).toMatchObject({ ok: true, exit_code: 0, signal: null, timed_out: false, truncated: true });
    expect(r.stdout_bytes).toBe(Buffer.byteLength(expected));
    expect(r.stdout_path).toBeDefined();
    expect(r.stdout_path!.startsWith(spill)).toBe(true);
    expect(readFileSync(r.stdout_path!, "utf8")).toBe(expected);
    // Inline answer: bounded head + tail around a marker that names the file.
    expect(r.stdout.startsWith("1\n2\n3\n")).toBe(true);
    expect(r.stdout.endsWith("299999\n300000\ndone\n")).toBe(true);
    expect(r.stdout).toContain(`完整输出见 ${r.stdout_path}`);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(EXEC_MAX_OUTPUT + 400);
    const omitted = Number(/省略中间 (\d+) 字节/.exec(r.stdout)?.[1]);
    const [head, tail] = r.stdout.split(/\n…\[省略中间 \d+ 字节；[^\]]*\]…\n/);
    expect(Buffer.byteLength(head) + omitted + Buffer.byteLength(tail)).toBe(r.stdout_bytes);
    expect(expected.startsWith(head) && expected.endsWith(tail)).toBe(true);
    // stderr stayed inside its window, so nothing was spilled for it.
    expect(r.stderr_path).toBeUndefined();
    expect(r.stdout_spill_truncated).toBeUndefined();
    expect(readdirSync(spill)).toEqual([expect.stringMatching(/^\d+-[0-9a-f]+\.stdout\.log$/)]);
  });

  it("stops growing a spill at its disk bound but keeps draining, never killing the command", async () => {
    const spill = join(dir, "spill");
    const cap = 300_000;
    const r = await machineExec({ command: "seq 1 300000; echo done", cwd: dir }, spill, cap);
    const expected = `${Array.from({ length: 300_000 }, (_, i) => i + 1).join("\n")}\ndone\n`;
    expect(r).toMatchObject({ ok: true, exit_code: 0, timed_out: false, truncated: true, stdout_spill_truncated: true });
    expect(r.stdout_bytes).toBe(Buffer.byteLength(expected));
    expect(readFileSync(r.stdout_path!, "utf8")).toBe(expected.slice(0, cap));
    // The inline tail is still the true end of the stream.
    expect(r.stdout.endsWith("299999\n300000\ndone\n")).toBe(true);
    expect(r.stdout).toContain(`仅前 ${cap} 字节保存在 ${r.stdout_path}`);
    expect(r.stderr_spill_truncated).toBeUndefined();
  });

  it("windows each stream on its own and never cuts a UTF-8 character", async () => {
    const spill = join(dir, "spill");
    const r = await machineExec({
      command: `for i in $(seq 1 40000); do printf '章鱼'; done >&2; echo short`,
      cwd: dir,
    }, spill);
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("short\n");
    expect(r.stdout_path).toBeUndefined();
    expect(r.stderr_bytes).toBe(40_000 * Buffer.byteLength("章鱼"));
    expect(r.stderr).not.toContain("\uFFFD");
    expect(r.stderr.startsWith("章鱼章鱼")).toBe(true);
    expect(r.stderr.endsWith("章鱼章鱼")).toBe(true);
    expect(readFileSync(r.stderr_path!, "utf8")).toBe("章鱼".repeat(40_000));
  });

  it("keeps output inline and unspilled while it fits the window", async () => {
    const spill = join(dir, "spill");
    const r = await machineExec({ command: `head -c ${EXEC_MAX_OUTPUT} /dev/zero | tr '\\0' 'a'`, cwd: dir }, spill);
    expect(r).toMatchObject({ ok: true, truncated: false, stdout_bytes: EXEC_MAX_OUTPUT });
    expect(r.stdout).toBe("a".repeat(EXEC_MAX_OUTPUT));
    expect(existsSync(spill)).toBe(false);
  });

  it("says so in the answer, rather than naming a file, when the spill cannot be written", async () => {
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "");
    const r = await machineExec({ command: `head -c ${EXEC_MAX_OUTPUT * 3} /dev/zero | tr '\\0' 'a'`, cwd: dir }, blocked);
    expect(r).toMatchObject({ ok: true, exit_code: 0, truncated: true, stdout_bytes: EXEC_MAX_OUTPUT * 3 });
    expect(r.stdout_path).toBeUndefined();
    expect(r.stdout).toContain("完整输出未能保存");
  });

  it("reports a timeout and keeps what the killed command had already printed", async () => {
    const spill = join(dir, "spill");
    const r = await machineExec({ command: `seq 1 40000; sleep 30`, cwd: dir, timeout_ms: 2000 }, spill);
    expect(r).toMatchObject({ ok: false, timed_out: true, signal: "SIGKILL", truncated: true });
    expect(r.duration_ms).toBeLessThan(10_000);
    expect(readFileSync(r.stdout_path!, "utf8").endsWith("39999\n40000\n")).toBe(true);
  });

  it("reports a shell that could not start as before", async () => {
    const r = await machineExec({ command: "echo hi", cwd: join(dir, "missing") }, join(dir, "spill"));
    expect(r).toMatchObject({ ok: false, exit_code: "ENOENT", stdout: "", stderr: "", truncated: false });
  });

  it("spills under the Runner's home when dispatched over RPC", async () => {
    const resp = await handleRpc(dir, { id: "1", method: "exec", args: { command: "seq 1 50000", cwd: dir } }, {
      allowMachineOps: true,
    });
    const result = resp.result as { stdout_path: string };
    expect(result.stdout_path.startsWith(execSpillDir(dir))).toBe(true);
  });

  it("prunes spills past their day or beyond the newest few, never a live one or a foreign file", async () => {
    const spill = join(dir, "spill");
    mkdirSync(spill);
    const now = Date.now();
    const name = (at: number, stream = "stdout") => `${at}-abcdef.${stream}.log`;
    const live = name(now - 1_000);
    const expired = name(now - EXEC_SPILL_TTL_MS - 1);
    const recent = Array.from({ length: EXEC_SPILL_KEEP_FILES + 3 }, (_, i) => name(now - 3_600_000 - i * 1_000));
    for (const file of [live, expired, ...recent, "notes.txt"]) writeFileSync(join(spill, file), "x");
    await pruneExecSpills(spill, now);
    const left = new Set(readdirSync(spill));
    expect(left.has(live)).toBe(true);
    expect(left.has("notes.txt")).toBe(true);
    expect(left.has(expired)).toBe(false);
    // The live file counts toward the newest few; the oldest recent ones go.
    expect(recent.filter((file) => left.has(file))).toEqual(recent.slice(0, EXEC_SPILL_KEEP_FILES - 1));
  });

  it("requires a command", async () => {
    await expect(machineExec({})).rejects.toThrow(/command/);
  });

  it("executes a multiline Unicode script beyond the old command caps without truncation", async () => {
    const payload = "章鱼".repeat(6_000);
    const r = await machineExec({ command: `cat <<'OCTOPUS_TEXT'\n${payload}\nOCTOPUS_TEXT`, cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe(`${payload}\n`);
    expect(r.truncated).toBe(false);
  });
});

describe("machine file ops", () => {
  it("writes then reads a file back", async () => {
    const p = join(dir, "sub", "note.txt");
    const w = (await machineWriteFile({ path: p, content: "记忆内容" })) as { bytes: number };
    expect(w.bytes).toBeGreaterThan(0);
    const r = (await machineReadFile({ path: p })) as { content: string; truncated: boolean };
    expect(r.content).toBe("记忆内容");
    expect(r.truncated).toBe(false);
  });

  it("appends when asked", async () => {
    const p = join(dir, "log.txt");
    await machineWriteFile({ path: p, content: "a" });
    await machineWriteFile({ path: p, content: "b", append: true });
    expect(readFileSync(p, "utf8")).toBe("ab");
  });

  it("pages a file larger than one window back to its exact text", async () => {
    const p = join(dir, "big.txt");
    const text = "章鱼 octopus 八爪\n".repeat(Math.ceil((FILE_MAX_BYTES * 2.5) / 24));
    writeFileSync(p, text);
    const pages: Array<{ content: string; offset: number; next_offset: number; eof: boolean; truncated: boolean; size: number }> = [];
    let offset = 0;
    for (;;) {
      const page = (await machineReadFile({ path: p, offset })) as (typeof pages)[number];
      pages.push(page);
      expect(page.offset).toBe(offset);
      expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(FILE_MAX_BYTES);
      if (page.eof) break;
      offset = page.next_offset;
    }
    expect(pages).toHaveLength(3);
    expect(pages.every((page) => page.truncated && page.size === Buffer.byteLength(text))).toBe(true);
    expect(pages.map((page) => page.content).join("")).toBe(text);
    expect(pages.at(-1)!.next_offset).toBe(Buffer.byteLength(text));
  });

  it("answers an offset at or past the end with an empty final window", async () => {
    const p = join(dir, "small.txt");
    writeFileSync(p, "abc");
    expect(await machineReadFile({ path: p, offset: 3 })).toMatchObject({ content: "", eof: true, next_offset: 3 });
    expect(await machineReadFile({ path: p, offset: 99 })).toMatchObject({ content: "", eof: true, bytes: 0 });
    await expect(machineReadFile({ path: p, offset: -1 })).rejects.toThrow(/offset/);
  });

  it("truncates an over-long read at max_bytes", async () => {
    const p = join(dir, "big.txt");
    writeFileSync(p, "x".repeat(5000));
    const r = (await machineReadFile({ path: p, max_bytes: 1024 })) as { content: string; truncated: boolean };
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(1024);
  });

  it("refuses to read a directory", async () => {
    await expect(machineReadFile({ path: dir })).rejects.toThrow(/普通文件/);
  });

  it("lists a directory with types and a cap", async () => {
    writeFileSync(join(dir, "a.txt"), "x");
    mkdirSync(join(dir, "d"));
    const r = (await machineListDir({ path: dir })) as {
      total: number;
      entries: Array<{ name: string; type: string }>;
    };
    expect(r.total).toBe(2);
    expect(r.entries.find((e) => e.name === "a.txt")?.type).toBe("file");
    expect(r.entries.find((e) => e.name === "d")?.type).toBe("dir");
  });

  it("pages a directory larger than one listing to every entry, in name order", async () => {
    const names = Array.from({ length: LIST_MAX_ENTRIES * 2 + 201 }, (_, i) => `f-${String(i).padStart(5, "0")}`);
    for (const name of [...names].reverse()) writeFileSync(join(dir, name), "");
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = (await machineListDir({ path: dir, limit: LIST_MAX_ENTRIES, ...(cursor ? { cursor } : {}) })) as {
        total: number;
        cursor?: string;
        next_cursor: string | null;
        entries: Array<{ name: string }>;
      };
      pages++;
      expect(page.total).toBe(names.length);
      expect(page.cursor).toBe(cursor);
      seen.push(...page.entries.map((entry) => entry.name));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(names);
  });

  it("keeps a cursor stable when entries change between pages", async () => {
    for (const name of ["a", "b", "c", "d"]) writeFileSync(join(dir, name), "");
    const first = (await machineListDir({ path: dir, limit: 2 })) as { entries: Array<{ name: string }>; next_cursor: string };
    expect(first.entries.map((entry) => entry.name)).toEqual(["a", "b"]);
    rmSync(join(dir, "a"));
    writeFileSync(join(dir, "0"), "");
    const second = (await machineListDir({ path: dir, limit: 2, cursor: first.next_cursor })) as {
      entries: Array<{ name: string }>;
      next_cursor: string | null;
    };
    expect(second.entries.map((entry) => entry.name)).toEqual(["c", "d"]);
    expect(second.next_cursor).toBeNull();
  });

  it("writes content larger than one call as appended chunks", async () => {
    const p = join(dir, "out", "large.txt");
    const text = "章鱼 append chunk\n".repeat(Math.ceil((WRITE_MAX_BYTES * 2.5) / 21));
    const all = Buffer.from(text);
    const chunk = 256 * 1024;
    let written = 0;
    let start = 0;
    while (start < all.length) {
      // Chunk on character boundaries, as a caller holding the text would.
      let end = Math.min(all.length, start + chunk);
      while (end < all.length && (all[end] & 0xc0) === 0x80) end--;
      const content = all.subarray(start, end).toString("utf8");
      const result = (await machineWriteFile({ path: p, content, append: start > 0 })) as { bytes: number; size: number; mode: string };
      written += result.bytes;
      expect(result).toMatchObject({ size: written, mode: start > 0 ? "append" : "write" });
      start = end;
    }
    expect(written).toBe(all.length);
    expect(readFileSync(p, "utf8")).toBe(text);
    await expect(machineWriteFile({ path: p, content: "章".repeat(WRITE_MAX_BYTES / 3 + 1) }))
      .rejects.toThrow(/分块写入/);
    expect(readFileSync(p, "utf8")).toBe(text);
  });

  it("host_info reports where we are", async () => {
    const info = (await machineHostInfo()) as { hostname: string; home: string };
    expect(info.hostname).toBeTruthy();
    expect(info.home).toBeTruthy();
  });
});

describe("append_session", () => {
  const SESSION_ID = "dddd4444-0000-0000-0000-000000000000";

  /** Fixture: one claude session whose cwd is a real dir inside the sandbox. */
  function makeSession(home: string): string {
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    const sessDir = join(home, ".claude", "projects", "proj");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, `${SESSION_ID}.jsonl`),
      JSON.stringify({
        type: "user",
        sessionId: SESSION_ID,
        cwd,
        timestamp: "2026-07-20T10:00:00.000Z",
        message: { role: "user", content: "起个头" },
      }) + "\n",
    );
    return cwd;
  }

  it("saves Codex continuation settings without dispatch and rejects mixed controls/Claude", async () => {
    makeSession(dir);
    const codexId = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
    const sessions = join(dir, ".codex", "sessions"); mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `rollout-${codexId}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: codexId, cwd: dir } }) + "\n");
    const saveContinuationSettings = vi.fn(async () => ({ protocol: "codex-continuation/v1" }));
    const continueSession = vi.fn();
    const continuationSettings = vi.fn(() => ({ protocol: "codex-continuation/v1", effectivePrompt: "继续执行" }));
    const plane = { saveContinuationSettings, continueSession, continuationSettings } as unknown as AgentControlPlane;
    expect(await handleRpc(dir, { id: "config-read", method: "read_session", args: {
      source: "codex", id: codexId, continuation_settings: true, max_messages: 1,
    } }, { agentControlPlane: plane })).toMatchObject({ ok: true, result: { protocol: "codex-continuation/v1" } });
    expect(continuationSettings).toHaveBeenCalledWith("codex", codexId);
    const args = { id: codexId, source: "codex", configure_continuation: true, continuation_prompt: "  Please continue  ", continuation_revision: "0" };
    await machineAppendSession(dir, args, undefined, undefined, plane);
    expect(saveContinuationSettings).toHaveBeenCalledWith("codex", codexId, "  Please continue  ", "0");
    expect(continueSession).not.toHaveBeenCalled();
    for (const extra of [{ prompt: "run" }, { interrupt: true }, { takeover: true }, { model: "x" }, { steer_only: true }]) {
      await expect(machineAppendSession(dir, { ...args, ...extra }, undefined, undefined, plane)).rejects.toThrow(/不能同时/);
    }
    await expect(machineAppendSession(dir, { ...args, source: "claude", id: SESSION_ID }, undefined, undefined, plane)).rejects.toThrow(/仅支持 Codex/);
    expect(saveContinuationSettings).toHaveBeenCalledTimes(1);
  });

  it("validates id / prompt / prompt length before touching anything", async () => {
    await expect(machineAppendSession(dir, { prompt: "x" })).rejects.toThrow(/id/);
    await expect(machineAppendSession(dir, { id: "x" })).rejects.toThrow(/prompt/);
    await expect(machineAppendSession(dir, { id: "x", prompt: "y".repeat(APPEND_MAX_PROMPT + 1) })).rejects.toThrow(/过长/);
    await expect(machineAppendSession(dir, { id: "x", prompt: "章".repeat(Math.floor(APPEND_MAX_PROMPT / 3) + 1) })).rejects.toThrow(/字节/);
    await expect(machineAppendSession(dir, { id: "no-such", prompt: "y" })).rejects.toThrow(/not found/);
  });

  it("continues a transcript larger than the JS string limit using only its native metadata", async () => {
    const cwd = makeSession(dir);
    // Sparse file: the large logical size consumes no proportional disk/RAM.
    truncateSync(join(dir, ".claude", "projects", "proj", `${SESSION_ID}.jsonl`), 600 * 1024 * 1024);
    const continueSession = vi.fn(async () => ({ ok: true, session_id: SESSION_ID }));
    await expect(machineAppendSession(dir, { id: SESSION_ID, source: "claude", prompt: "继续" },
      undefined, undefined, { continueSession } as unknown as AgentControlPlane)).resolves.toMatchObject({ ok: true });
    expect(continueSession).toHaveBeenCalledOnce();
    expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_ID, cwd, prompt: "继续" }));
  });

  it("passes a long Unicode continuation intact to the managed provider", async () => {
    makeSession(dir);
    const prompt = "继续完成任务。".repeat(3_000);
    const continueSession = vi.fn(async () => ({ ok: true, transport: "agent-sdk" }));
    await expect(machineAppendSession(dir, { id: SESSION_ID, source: "claude", prompt },
      undefined, undefined, { continueSession } as unknown as AgentControlPlane))
      .resolves.toMatchObject({ ok: true });
    expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
  });

  it("passes Claude manual mode to a new managed attachment and rejects it on interrupt", async () => {
    makeSession(dir);
    const continueSession = vi.fn(async () => ({ ok: true, transport: "agent-sdk" }));
    await expect(machineAppendSession(dir, {
      id: SESSION_ID,
      source: "claude",
      prompt: "继续",
      permission_profile: "manual",
    }, undefined, undefined, { continueSession } as unknown as AgentControlPlane))
      .resolves.toMatchObject({ ok: true, transport: "agent-sdk" });
    expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      permissionProfile: "manual",
    }));
    await expect(machineAppendSession(dir, {
      id: SESSION_ID,
      source: "claude",
      interrupt: true,
      permission_profile: "manual",
    })).rejects.toThrow(/停止轮次不接受/);
  });

  it("routes prompt-free Codex release to the exact control-plane session", async () => {
    const codexId = "019f0000-1111-7000-8000-000000000418";
    const cwd = join(dir, "release-work");
    const sessionDir = join(dir, ".codex", "sessions", "2026", "08", "27");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, `rollout-2026-08-27T12-57-00-${codexId}.jsonl`),
      `${JSON.stringify({
        timestamp: "2026-08-27T12:57:00.000Z",
        type: "session_meta",
        payload: { id: codexId, cwd },
      })}\n`,
    );
    const releaseSession = vi.fn(async () => ({ ok: true, released: true }));
    const controlPlane = { releaseSession } as unknown as AgentControlPlane;

    await expect(machineAppendSession(dir, {
      id: codexId,
      source: "codex",
      release_control: true,
    }, undefined, undefined, controlPlane)).resolves.toMatchObject({ ok: true, released: true });
    expect(releaseSession).toHaveBeenCalledWith("codex", codexId);

    await expect(machineAppendSession(dir, {
      id: codexId,
      source: "codex",
      release_control: true,
      permission_profile: "full_access",
    }, undefined, undefined, controlPlane)).rejects.toThrow(/放锁动作不接受/);
    await expect(machineAppendSession(dir, {
      id: codexId,
      source: "codex",
      release_control: true,
      model: "gpt-5.6-terra",
    }, undefined, undefined, controlPlane)).rejects.toThrow(/放锁动作不接受/);
    await expect(machineAppendSession(dir, {
      id: codexId,
      source: "codex",
      release_control: true,
      takeover: true,
      prompt: "不能混用",
    }, undefined, undefined, controlPlane)).rejects.toThrow(/不能同时执行/);
  });

  it("reopens the scoped execution path for a split session and refuses an uncredentialed resume", async () => {
    makeSession(dir);
    const journal = new LaunchJournal(dir);
    await journal.begin({
      client_request_id: "op_split_resume",
      workspace_id: "ws_0123456789abcdef01234567",
      source: "claude",
      remote_execution: true,
      execution_device: "val15",
      prompt_hash: "0".repeat(64),
    });
    await journal.markManagedStarted("op_split_resume", SESSION_ID, "agent-sdk");

    const methods: string[] = [];
    const server = http.createServer((request, response) => {
      methods.push(request.method ?? "");
      expect(request.headers.authorization).toBe("Bearer mcp_resume_secret");
      if (request.method === "DELETE") {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body) as { id: string; method: string };
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "octopus", version: "1" } }
          : { tools: [{ name: "run_workspace_command" }] };
        response.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test MCP server did not listen");
    const continueSession = vi.fn(async (input: { remoteMcpUrl?: string }) => {
      expect(input.remoteMcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/session\//);
      expect(JSON.stringify(input)).not.toContain("mcp_resume_secret");
      return { ok: true, transport: "agent-sdk" };
    });
    try {
      await expect(machineAppendSession(dir, {
        id: SESSION_ID,
        source: "claude",
        prompt: "继续",
      }, undefined, undefined, { continueSession } as unknown as AgentControlPlane))
        .rejects.toThrow(/执行凭证已失效/);

      await expect(machineAppendSession(dir, {
        id: SESSION_ID,
        source: "claude",
        prompt: "继续",
        execution_device: "val15",
        workspace_id: "ws_0123456789abcdef01234567",
        _octopus_execution_operation_id: "op_split_resume",
        _octopus_execution_expires_at: Date.now() + 60_000,
        _octopus_execution_mcp_url: `http://127.0.0.1:${address.port}/api/mcp`,
        _octopus_execution_mcp_token: "mcp_resume_secret",
      }, undefined, undefined, { continueSession } as unknown as AgentControlPlane,
      undefined, dir, undefined, undefined, undefined,
      "http://127.0.0.1:39003/devpipe", "development_ticket_578"))
        .resolves.toMatchObject({ ok: true, transport: "agent-sdk" });
      expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({
        recoveryPlacement: expect.objectContaining({ developmentId: "development_ticket_578" }),
      }));
      expect(methods).not.toContain("DELETE");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retains the split proxy until completion after an early input receipt", async () => {
    makeSession(dir);
    const journal = new LaunchJournal(dir);
    await journal.begin({ client_request_id: "op_split_lifetime", workspace_id: "ws_0123456789abcdef01234567",
      source: "claude", remote_execution: true, execution_device: "val15", prompt_hash: "0".repeat(64) });
    await journal.markManagedStarted("op_split_lifetime", SESSION_ID, "agent-sdk");
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    const server = http.createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "octopus", version: "1" },
          tools: [{ name: "run_workspace_command" }] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test MCP server did not listen");
    let proxyUrl = "";
    const received = vi.fn(async () => {});
    const plane = { continueSession: vi.fn(async (input: { remoteMcpUrl?: string; onInput?: (input: unknown) => Promise<void> }) => {
      proxyUrl = input.remoteMcpUrl!;
      await input.onInput?.({ phase: "local_queued", evidence: "local_queue", at: new Date().toISOString(), session_id: SESSION_ID });
      await completion;
      return { ok: true };
    }) } as unknown as AgentControlPlane;
    let finished = false;
    const pending = machineAppendSession(dir, { id: SESSION_ID, source: "claude", prompt: "继续",
      execution_device: "val15", workspace_id: "ws_0123456789abcdef01234567",
      _octopus_execution_operation_id: "op_split_lifetime", _octopus_execution_expires_at: Date.now() + 60_000,
      _octopus_execution_mcp_url: `http://127.0.0.1:${address.port}/api/mcp`, _octopus_execution_mcp_token: "mcp_secret",
    }, undefined, undefined, plane, undefined, undefined, undefined, undefined, received)
      .then((result) => { finished = true; return result; });
    // Observe rejection immediately: a failed upstream probe must fail this
    // case and still release its fixtures, never become an unhandled rejection.
    let failure: unknown;
    const observed = pending.catch((error: unknown) => { failure = error; });
    try {
      await vi.waitFor(() => {
        if (failure) throw failure;
        expect(received).toHaveBeenCalledOnce();
      });
      expect(finished).toBe(false);
      // A live local proxy answers an invalid method itself without a remote request.
      expect((await fetch(proxyUrl, { method: "PUT" })).status).toBe(404);
      complete();
      await expect(pending).resolves.toMatchObject({ ok: true });
      await expect(fetch(proxyUrl, { method: "PUT" })).rejects.toThrow();
    } finally {
      complete();
      await observed;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    ["claude", SESSION_ID, "manual"],
    ["codex", "019f0000-1111-7000-8000-000000000123", ""],
  ] as const)("reports a %s managed setup failure once and never runs a headless CLI", async (source, id, permission) => {
    if (source === "claude") makeSession(dir);
    else {
      const sessDir = join(dir, ".codex", "sessions", "2026", "07", "25");
      mkdirSync(sessDir, { recursive: true });
      writeFileSync(join(sessDir, `rollout-2026-07-25T00-00-00-${id}.jsonl`),
        JSON.stringify({ timestamp: "2026-07-25T00:00:00.000Z", type: "session_meta", payload: { id, cwd: dir } }) + "\n");
    }
    const fake = fakeExecutables({ [source]: `#!/bin/sh\ntouch '${join(dir, "cli-ran")}'\n` }, { home: dir });
    fake.apply();
    // The 2026-09-27 class: the managed channel cannot open the thread before owning the prompt.
    const continueSession = vi.fn(async () => {
      throw Object.assign(new Error("thread/resume failed: already has an active writer"), { safeFallback: true });
    });
    try {
      await expect(machineAppendSession(dir, { id, source, prompt: "继续", ...(permission ? { permission_profile: permission } : {}) },
        undefined, new AgentInteractionBroker(), { continueSession } as unknown as AgentControlPlane))
        .resolves.toMatchObject({ ok: false, agent: source, session_id: id, code: "failed",
          error: expect.stringContaining("already has an active writer") });
      expect(continueSession).toHaveBeenCalledOnce();
      expect(existsSync(join(dir, "cli-ran"))).toBe(false);
      // After the prompt may have crossed, the error stays an uncertain outcome.
      continueSession.mockRejectedValueOnce(Object.assign(new Error("acknowledgement lost"), { safeFallback: false }));
      await expect(machineAppendSession(dir, { id, source, prompt: "继续" }, undefined, undefined,
        { continueSession } as unknown as AgentControlPlane)).rejects.toThrow("acknowledgement lost");
      expect(existsSync(join(dir, "cli-ran"))).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  it("routes interrupt as a prompt-free native control intent", async () => {
    makeSession(dir);
    const interruptSession = vi.fn(async () => ({ ok: true, control_action: "interrupt" }));
    const result = await machineAppendSession(
      dir,
      { id: SESSION_ID, source: "claude", interrupt: true },
      undefined,
      undefined,
      { interruptSession } as unknown as AgentControlPlane,
    );
    expect(result).toMatchObject({ ok: true, control_action: "interrupt" });
    expect(interruptSession).toHaveBeenCalledWith("claude", SESSION_ID);
  });

  it("validates and forwards model and effort only to a provider-managed continuation", async () => {
    makeSession(dir);
    const continueSession = vi.fn(async () => ({ ok: true, control_action: "managed_resume" }));
    await expect(machineAppendSession(
      dir,
      {
        id: SESSION_ID,
        source: "claude",
        prompt: "换模型并更仔细地继续",
        model: "sonnet",
        effort: "max",
      },
      undefined,
      undefined,
      { continueSession } as unknown as AgentControlPlane,
    )).resolves.toMatchObject({ ok: true, control_action: "managed_resume" });
    expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      sessionId: SESSION_ID,
      prompt: "换模型并更仔细地继续",
      model: "sonnet",
      effort: "max",
    }));

    await expect(machineAppendSession(
      dir,
      { id: SESSION_ID, source: "claude", prompt: "无效档位", effort: "off" },
      undefined,
      undefined,
      { continueSession } as unknown as AgentControlPlane,
    )).rejects.toThrow(/append_session claude effort 无效/);
    expect(continueSession).toHaveBeenCalledTimes(1);

    await expect(machineAppendSession(
      dir,
      { id: SESSION_ID, source: "claude", prompt: "无效模型", model: "not a model" },
      undefined,
      undefined,
      { continueSession } as unknown as AgentControlPlane,
    )).rejects.toThrow(/append_session model 无效/);
    expect(continueSession).toHaveBeenCalledTimes(1);
  });

  it("refuses without a managed control plane instead of resuming a CLI", async () => {
    makeSession(dir);
    await expect(machineAppendSession(dir, { id: SESSION_ID, prompt: "x" })).rejects.toThrow(/托管 Agent 控制面/);
  });

  it("codex: continues in the exact account home that owns the thread", async () => {
    const codexHomeA = join(dir, "codex-a");
    const codexHomeB = join(dir, "codex-b");
    const codexId = "019f0000-1111-7000-8000-000000000789";
    const cwd = join(dir, "account-work");
    mkdirSync(cwd, { recursive: true });
    const sessDir = join(codexHomeB, "sessions", "2026", "08", "23");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, `rollout-2026-08-23T00-00-00-${codexId}.jsonl`),
      JSON.stringify({ timestamp: "2026-08-23T00:00:00.000Z", type: "session_meta", payload: { id: codexId, cwd } }) + "\n");
    const continueSession = vi.fn(async () => ({ ok: true, transport: "app-server" }));
    await expect(machineAppendSession(dir, { id: codexId, source: "codex", prompt: "继续" }, undefined, undefined,
      { continueSession } as unknown as AgentControlPlane, undefined,
      { home: dir, codexHomes: [{ label: "a", codexHome: codexHomeA }, { label: "b", codexHome: codexHomeB }] }))
      .resolves.toMatchObject({ ok: true });
    expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", sessionId: codexId, cwd, codexHome: codexHomeB }));
  });

  it("codex: explicitly forks an exhausted account session into a healthy account", async () => {
    const codexHomeA = join(dir, "codex-fallback-a");
    const codexHomeB = join(dir, "codex-fallback-b");
    const codexId = "019f0000-1111-7000-8000-000000000790";
    const fallbackId = "019f0000-1111-7000-8000-000000000791";
    const cwd = join(dir, "fallback-work");
    const sessDir = join(codexHomeA, "sessions", "2026", "08", "23");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessDir, { recursive: true });
    mkdirSync(codexHomeB, { recursive: true });
    const sourcePath = join(sessDir, `rollout-2026-08-23T00-00-00-${codexId}.jsonl`);
    writeFileSync(sourcePath, JSON.stringify({
      timestamp: "2026-08-23T00:00:00.000Z",
      type: "session_meta",
      payload: { id: codexId, cwd },
    }) + "\n");
    const fake = fakeExecutables({}, { home: dir });
    const bin = fake.bin;
    const capture = join(dir, "fallback-home-capture.txt");
    const server = join(dir, "fallback-app-server.cjs");
    writeFileSync(server, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => {
  const line = JSON.stringify(value) + "\\n";
  process.stdout.write(line);
};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "thread/fork") {
    if (msg.params.path !== ${JSON.stringify(sourcePath)}) {
      return send({ id: msg.id, error: { message: "wrong source path" } });
    }
    return send({ id: msg.id, result: { thread: { id: ${JSON.stringify(fallbackId)} } } });
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-fallback" } } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: ${JSON.stringify(fallbackId)}, turnId: "turn-fallback", delta: "fallback complete"
    } });
    return send({ method: "turn/completed", params: {
      threadId: ${JSON.stringify(fallbackId)}, turn: { id: "turn-fallback", status: "completed" }
    } });
  }
});
`);
    writeFileSync(join(bin, "codex"), [
      "#!/bin/sh",
      `echo "$CODEX_HOME" >> "${capture}"`,
      `exec "${process.execPath}" "${server}"`,
    ].join("\n"));
    chmodSync(join(bin, "codex"), 0o755);
    fake.apply();
    const router = new CodexAccountRouter({
      accounts: { current: codexHomeA, reserve: codexHomeB },
      readRateLimits: async (slot) => ({
        rateLimitsByLimitId: {
          codex: {
            primary: {
              usedPercent: slot === "current" ? 100 : 40,
              windowDurationMins: 10_080,
              resetsAt: (Date.now() + 60_000) / 1000,
            },
          },
        },
      }),
    });
    try {
      await expect(machineAppendSession(
        dir,
        { id: codexId, source: "codex", prompt: "用备用账号继续", account_fallback: true },
        undefined,
        new AgentInteractionBroker(),
        undefined,
        undefined,
        {
          home: dir,
          codexHomes: [
            { label: "a", codexHome: codexHomeA },
            { label: "b", codexHome: codexHomeB },
          ],
        },
        router,
      )).resolves.toMatchObject({
        ok: true,
        session_id: codexId,
        new_session_id: fallbackId,
        account_label: "b",
        transport: "app-server-fork",
        result_text: "fallback complete",
      });
      expect(readFileSync(capture, "utf8").trim()).toBe(codexHomeB);
    } finally {
      fake.cleanup();
    }
  });
});

describe("handleRpc machine-op gating", () => {
  const req = (method: string, args: Record<string, unknown> = {}) => ({ id: "1", method, args });

  it("refuses machine ops when the device disabled them", async () => {
    for (const m of [
      "exec", "write_file", "read_file", "list_dir", "host_info", "append_session", "upload_session_file",
      "start_session", "gui_request_control", "gui_capture_screen", "gui_click", "gui_scroll", "gui_drag",
      "gui_type_text", "gui_key_press", "gui_release_control",
    ]) {
      const resp = await handleRpc(dir, req(m, { command: "echo x", path: join(dir, "f") }), {
        allowMachineOps: false,
      });
      expect(resp.ok).toBe(false);
      expect(resp.error).toMatch(/未开启机器操作/);
    }
  });

  it("allows them when enabled and logs an audit line", async () => {
    const audit: string[] = [];
    const resp = await handleRpc(dir, req("exec", { command: "echo ok", cwd: dir }), {
      allowMachineOps: true,
      onMachineOp: (method, summary) => audit.push(`${method} ${summary}`),
    });
    expect(resp.ok).toBe(true);
    expect(audit[0]).toContain("exec $ echo ok");
  });

  it("execution-only mode permits OS operations but refuses every session and agent surface", async () => {
    const exec = await handleRpc(dir, req("exec", { command: "echo endpoint", cwd: dir }), {
      allowMachineOps: true,
      executionOnly: true,
    });
    expect(exec).toMatchObject({ ok: true, result: { stdout: expect.stringContaining("endpoint") } });

    for (const method of [
      "list_recent_sessions",
      "session_plus_list_sessions",
      "session_plus_search_sessions",
      "session_plus_read_session",
      "read_session",
      "append_session",
      "start_session",
      "workspace_terminal",
      "codex_exec_open",
      "codex_agent_open",
      "knowledge_index_start",
      "gui_request_control",
      "gui_capture_screen",
    ]) {
      const response = await handleRpc(dir, req(method), { allowMachineOps: true, executionOnly: true });
      expect(response.ok, method).toBe(false);
      expect(response.error, method).toMatch(/仅暴露执行环境/);
    }
  });

  it("execution-only dispatch reaches only the explicitly composed knowledge methods", async () => {
    const manager = new KnowledgeIndexManager({
      jobsRoot: join(dir, "jobs"), checkoutRoot: join(dir, "checkout"), wrapperEntry: "/unused-wrapper",
      enforceWorkRoots: false, inputOrigins: ["https://octopus.example"],
    });
    const status = { job_key: "a".repeat(64), repo_sha: "b".repeat(40), state: "running" as const,
      created_at: "2026-09-13T00:00:00Z", updated_at: "2026-09-13T00:00:00Z", log_tail: "", files: [] };
    const start = vi.spyOn(manager, "rpcStart").mockResolvedValue(status);
    const observe = vi.spyOn(manager, "rpcStatus").mockResolvedValue(status);
    const cancel = vi.spyOn(manager, "rpcCancel").mockResolvedValue(status);
    const read = vi.spyOn(manager, "rpcRead").mockResolvedValue({ job_key: status.job_key, file: "manifest.json",
      offset: 0, bytes: 0, data: "", eof: true, sha256: "c".repeat(64) });
    const opts = { executionOnly: true, allowMachineOps: true, knowledgeIndex: manager };
    for (const method of ["knowledge_index_start", "knowledge_index_status", "knowledge_index_cancel", "knowledge_index_read"]) {
      expect(await handleRpc(dir, req(method, { job_key: status.job_key }), opts)).toMatchObject({ ok: true });
      expect(await handleRpc(dir, req(method), { ...opts, knowledgeIndex: undefined })).toMatchObject({ ok: false });
      expect(await handleRpc(dir, req(method), { ...opts, allowMachineOps: false })).toMatchObject({ ok: false });
    }
    for (const method of ["start_session", "append_session", "codex_exec_open", "workspace_terminal", "knowledge_index_arbitrary"]) {
      expect(await handleRpc(dir, req(method), opts)).toMatchObject({ ok: false });
    }
    for (const spy of [start, observe, cancel, read]) expect(spy).toHaveBeenCalledExactlyOnceWith({ job_key: status.job_key });
  });

  it("investigation ops still work with machine ops disabled", async () => {
    const cwd = join(dir, "existing-project");
    const sessionDir = join(dir, ".claude", "projects", "existing-project");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "aaaaaaaa-0000-4000-8000-000000000000.jsonl"), JSON.stringify({
      type: "user",
      sessionId: "aaaaaaaa-0000-4000-8000-000000000000",
      cwd,
      timestamp: "2026-08-05T00:00:00.000Z",
      message: { role: "user", content: "existing work" },
    }) + "\n");

    const resp = await handleRpc(dir, req("list_recent_sessions", { limit: 1 }), { allowMachineOps: false });
    expect(resp.ok).toBe(true);
    expect(resp).toMatchObject({
      result: { sessions: [{ cwd_display: "~/existing-project" }] },
    });
    // With the machine-op kill switch off there is no roster, so there is
    // nothing to associate either — an honest absence, not a guess.
    const workspaces = await handleRpc(dir, req("list_session_workspaces"), { allowMachineOps: false });
    expect(workspaces).toMatchObject({ ok: true, result: { workspaces: [], session_directories: [] } });

    // Both RPCs use the same home-keyed sessions module cache in this Runner
    // process. A file born inside the 3s TTL is intentionally picked up by the
    // next full scan, not by a duplicate workspace-only tree walk.
    const lateCwd = join(dir, "late-project");
    mkdirSync(lateCwd, { recursive: true });
    writeFileSync(join(sessionDir, "bbbbbbbb-0000-4000-8000-000000000000.jsonl"), JSON.stringify({
      type: "user",
      sessionId: "bbbbbbbb-0000-4000-8000-000000000000",
      cwd: lateCwd,
      timestamp: "2026-08-05T00:01:00.000Z",
      message: { role: "user", content: "late work" },
    }) + "\n");
    const writableWorkspaces = await handleRpc(dir, req("list_session_workspaces"), { allowMachineOps: true });
    expect(writableWorkspaces).toMatchObject({
      ok: true,
      result: {
        workspaces: [],
        session_directories: [],
      },
    });
  });

  it("keeps CODEX_HOME local to the Runner while scanning its Codex sessions", async () => {
    const codexHome = join(dir, "custom-codex-state");
    const id = "019f0000-2222-7000-8000-000000000998";
    const sessionDir = join(codexHome, "sessions", "2026", "08", "21");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `rollout-2026-08-21T09-00-00-${id}.jsonl`), [
      { timestamp: "2026-08-21T09:00:00.000Z", type: "session_meta", payload: { id, cwd: dir } },
      { timestamp: "2026-08-21T09:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "custom root" } },
    ].map((line) => JSON.stringify(line)).join("\n"));

    const resp = await handleRpc(dir, req("list_recent_sessions", { source: "codex", limit: 20 }), {
      allowMachineOps: false,
      sessionScanRoot: { home: dir, codexHome },
    });
    expect(resp).toMatchObject({
      ok: true,
      result: { returned: 1, sessions: [{ id, source: "codex" }] },
    });
    const continueSession = vi.fn(async () => ({ ok: true }));
    await expect(handleRpc(dir, req("append_session", { source: "codex", id, prompt: "continue",
      codex_home: "/untrusted/wire/home" }), {
      allowMachineOps: true, sessionScanRoot: { home: dir, codexHome },
      agentControlPlane: { continueSession } as unknown as AgentControlPlane,
    })).resolves.toMatchObject({ ok: true });
    expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({ codexHome }));
  });

  it("reads dev-ticket transcripts only from the fixed isolated Codex root", async () => {
    const ordinaryCodexHome = join(dir, "ordinary-codex-state");
    const splitCodexHome = join(dir, ".octopus", "codex-split-home");
    const id = "01a0380f-f9c3-7a41-a2fc-caf6be86678a";
    const sessionDir = join(splitCodexHome, "sessions", "2026", "08", "25");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `rollout-2026-08-25T08-36-01-${id}.jsonl`), [
      { timestamp: "2026-08-25T08:36:01.000Z", type: "session_meta", payload: { id, cwd: dir } },
      { timestamp: "2026-08-25T08:36:02.000Z", type: "event_msg", payload: { type: "user_message", message: "ticket 374" } },
    ].map((line) => JSON.stringify(line)).join("\n"));

    await expect(handleRpc(dir, req("codex_agent_read_session", { id }), {
      allowMachineOps: false,
      sessionScanRoot: { home: dir, codexHome: ordinaryCodexHome },
    })).resolves.toMatchObject({
      ok: false,
      error: "Codex agent transcript root is unavailable on this Runner",
    });

    await expect(handleRpc(dir, req("codex_agent_read_session", { id }), {
      allowMachineOps: true,
      executionOnly: true,
      codexAgentSessionScanRoot: { home: dir, codexHome: splitCodexHome },
    })).resolves.toMatchObject({
      ok: false,
      error: "该设备仅暴露执行环境，不提供 session、Agent、Codex relay、DSH 或未启用的知识索引操作",
    });

    const opts = {
      allowMachineOps: false,
      sessionScanRoot: { home: dir, codexHome: ordinaryCodexHome },
      codexAgentSessionScanRoot: { home: dir, codexHome: splitCodexHome },
    };
    const privateRead = await handleRpc(dir, req("codex_agent_read_session", {
      id,
      max_messages: 200,
      // Neither caller-selected paths nor namespaces may escape the fixed root.
      path: join(ordinaryCodexHome, "other.jsonl"),
      source: "claude",
    }), opts);
    expect(privateRead).toMatchObject({
      ok: true,
      result: {
        meta: { id, source: "codex" },
        messages: [{ role: "user", blocks: [{ type: "text", text: "ticket 374" }] }],
      },
    });

    // Keeping the roots separate also prevents dev-ticket sessions from
    // appearing in the user's ordinary Sessions inventory/read surface.
    await expect(handleRpc(dir, req("read_session", { id, source: "codex", rich: true }), opts))
      .resolves.toMatchObject({ ok: false, error: `session not found for id: ${id}` });
  });

  it("selectively lists, searches and reads only cataloged Sessions+ rows from split home", async () => {
    const ordinaryCodexHome = join(dir, "ordinary-codex-state");
    const splitCodexHome = join(dir, ".octopus", "codex-split-home");
    const visibleId = "01a0380f-f9c3-7a41-a2fc-caf6be866701";
    const ticketId = "01a0380f-f9c3-7a41-a2fc-caf6be866702";
    const legacyId = "01a0380f-f9c3-7a41-a2fc-caf6be866703";
    const sessionDir = join(splitCodexHome, "sessions", "2026", "09", "01");
    mkdirSync(sessionDir, { recursive: true });
    const writeTranscript = (id: string, message: string): void => {
      writeFileSync(join(sessionDir, `rollout-2026-09-01T08-00-00-${id}.jsonl`), [
        { timestamp: "2026-09-01T08:00:00.000Z", type: "session_meta", payload: { id, cwd: dir } },
        { timestamp: "2026-09-01T08:00:01.000Z", type: "event_msg", payload: { type: "user_message", message } },
      ].map((line) => JSON.stringify(line)).join("\n"));
    };
    writeTranscript(visibleId, "visible advanced placement");
    writeTranscript(ticketId, "ticket-only secret phrase");
    writeTranscript(legacyId, "older visible placement");

    const catalogId = `spc_${"a".repeat(64)}`;
    const workspaceId = "ws_0123456789abcdef01234567";
    const journal = new LaunchJournal(dir);
    await journal.begin({
      client_request_id: "op_sessionsplus123",
      workspace_id: workspaceId,
      source: "codex",
      remote_execution: true,
      execution_device: "exec-b",
      prompt_hash: "b".repeat(64),
    });
    await journal.markManagedStarted(
      "op_sessionsplus123",
      visibleId,
      "app-server",
      catalogId,
    );
    await journal.begin({
      client_request_id: "op_sessionspluslegacy",
      workspace_id: workspaceId,
      source: "codex",
      remote_execution: true,
      execution_device: "exec-b",
      prompt_hash: "c".repeat(64),
    });
    // Pre-catalog split sessions keep v1 placement evidence. The Host
    // migration supplies the exact former execution-binding tuple, so they
    // remain visible without making uncataloged ticket transcripts visible.
    await journal.markManagedStarted("op_sessionspluslegacy", legacyId, "app-server");
    const catalog = [
      {
        id: visibleId,
        catalog_id: catalogId,
        execution_device: "exec-b",
        workspace_id: workspaceId,
      },
      {
        id: legacyId,
        execution_device: "exec-b",
        workspace_id: workspaceId,
      },
    ];
    const opts = {
      allowMachineOps: false,
      sessionScanRoot: { home: dir, codexHome: ordinaryCodexHome },
      sessionPlusSessionScanRoot: { home: dir, codexHome: splitCodexHome },
    };

    await expect(handleRpc(dir, req("session_plus_list_sessions", {
      source: "codex",
      limit: 20,
      _octopus_session_catalog: catalog,
    }), opts)).resolves.toMatchObject({
      ok: true,
      result: {
        returned: 2,
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: visibleId, source: "codex" }),
          expect.objectContaining({ id: legacyId, source: "codex" }),
        ]),
      },
    });
    await expect(handleRpc(dir, req("session_plus_search_sessions", {
      source: "codex",
      query: "ticket-only secret phrase",
      limit: 20,
      _octopus_session_catalog: catalog,
    }), opts)).resolves.toMatchObject({ ok: true, result: { returned: 0 } });
    await expect(handleRpc(dir, req("session_plus_search_sessions", {
      source: "codex",
      query: "advanced placement",
      limit: 20,
      _octopus_session_catalog: catalog,
    }), opts)).resolves.toMatchObject({
      ok: true,
      result: { returned: 1, results: [{ session: { id: visibleId } }] },
    });
    await expect(handleRpc(dir, req("session_plus_read_session", {
      id: visibleId,
      source: "codex",
      rich: true,
      _octopus_session_catalog: [catalog[0]],
    }), opts)).resolves.toMatchObject({
      ok: true,
      result: { meta: { id: visibleId }, messages: [{ role: "user" }] },
    });
    await expect(handleRpc(dir, req("session_plus_read_session", {
      id: ticketId,
      source: "codex",
      rich: true,
      _octopus_session_catalog: [{ ...catalog[0], id: ticketId }],
    }), opts)).resolves.toMatchObject({
      ok: false,
      error: "Sessions+ session catalog 未授权这个会话",
    });
    await expect(handleRpc(dir, req("list_recent_sessions", { source: "codex", limit: 20 }), opts))
      .resolves.toMatchObject({ ok: true, result: { returned: 0 } });
  });

  it("write_file through rpc actually lands on disk", async () => {
    const p = join(dir, "via-rpc.txt");
    const resp = await handleRpc(dir, req("write_file", { path: p, content: "hi" }), { allowMachineOps: true });
    expect(resp.ok).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});

describe("RUNNER_EXEC_NICE", () => {
  it("is off unless the env names a level in 1..19", async () => {
    const { execNiceLevel, execCommandLine } = await import("./machine.js");
    expect(execNiceLevel({})).toBe(0);
    expect(execNiceLevel({ RUNNER_EXEC_NICE: "0" })).toBe(0);
    expect(execNiceLevel({ RUNNER_EXEC_NICE: "20" })).toBe(0);
    expect(execNiceLevel({ RUNNER_EXEC_NICE: "abc" })).toBe(0);
    expect(execNiceLevel({ RUNNER_EXEC_NICE: "10" })).toBe(10);
    expect(execCommandLine("echo hi", {})).toBe("echo hi");
  });

  it("re-nices the command through bash with the caller's quoting preserved", async () => {
    const { execCommandLine } = await import("./machine.js");
    const line = execCommandLine(`echo 'it''s' "q"`, { RUNNER_EXEC_NICE: "10" });
    expect(line).toContain("nice -n 10");
    expect(line).toContain("ionice -c 3");
    expect(line).toContain(`bash -c 'echo '\\''it'\\'''\\''s'\\'' "q"'`);
    // The wrapped line must itself run and reproduce the command's output.
    const { execSync } = await import("node:child_process");
    expect(execSync(line, { shell: "/bin/bash" }).toString().trim()).toBe(`its q`);
  });

  it("uses a trusted Git Bash path on Windows without changing Unix defaults", async () => {
    const { runnerExecShell } = await import("./machine.js");
    expect(runnerExecShell({}, "linux")).toBe("/bin/bash");
    expect(runnerExecShell({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32")).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(runnerExecShell({ RUNNER_EXEC_SHELL: "D:\\Application\\Git\\bin\\bash.exe" }, "win32"))
      .toBe("D:\\Application\\Git\\bin\\bash.exe");
  });
});
