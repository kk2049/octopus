/**
 * Memory-half tests for the machines plugin. The jail is the security
 * boundary on the shared bot host, so the escape cases are the point.
 *
 * The module reads its config from the environment at import time, so each
 * case sets env before a fresh dynamic import.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let base: string;
let memoryDir: string;
let outside: string;

/** Config is read lazily from env, so one import serves every case. */
async function loadDispatch(): Promise<(name: string, args: Record<string, unknown>) => Promise<unknown>> {
  process.env.MACHINES_PLUGIN_TEST = "1";
  process.env.MACHINES_MEMORY_DIR = memoryDir;
  delete process.env.MACHINES_API;
  delete process.env.MACHINES_TOKEN;
  delete process.env.MACHINES_DEVICE;
  delete process.env.MACHINES_AUTO_ALLOW;
  const mod = await import("./server.js");
  return mod.dispatch;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mem-"));
  memoryDir = join(base, "memory");
  outside = join(base, "outside");
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "OTHER USER SECRET");
});

afterEach(() => {
  delete process.env.MACHINES_API;
  delete process.env.MACHINES_TOKEN;
  delete process.env.MACHINES_DEVICE;
  delete process.env.MACHINES_AUTO_ALLOW;
  rmSync(base, { recursive: true, force: true });
});

describe("memory tools", () => {
  it("writes, reads back, and lists", async () => {
    const dispatch = await loadDispatch();
    await dispatch("memory_write", { path: "MEMORY.md", content: "数据集在工作站 ws-01" });
    const read = (await dispatch("memory_read", { path: "MEMORY.md" })) as { content: string };
    expect(read.content).toBe("数据集在工作站 ws-01");
    const list = (await dispatch("memory_list", {})) as { returned: number; files: Array<{ path: string }>; next_cursor?: string };
    expect(list.returned).toBe(1);
    expect(list.next_cursor).toBeUndefined();
    expect(list.files[0].path).toBe("MEMORY.md");
  });

  it("creates nested paths and appends", async () => {
    const dispatch = await loadDispatch();
    await dispatch("memory_write", { path: "machines/laptop.md", content: "line1\n" });
    await dispatch("memory_append", { path: "machines/laptop.md", content: "line2\n" });
    expect(readFileSync(join(memoryDir, "machines/laptop.md"), "utf8")).toBe("line1\nline2\n");
  });

  it("searches across files and returns an excerpt", async () => {
    const dispatch = await loadDispatch();
    await dispatch("memory_write", { path: "a.md", content: "无关内容" });
    await dispatch("memory_write", { path: "b.md", content: "模型权重放在 nas 的 /vol/models" });
    const r = (await dispatch("memory_search", { query: "nas" })) as {
      returned: number;
      hits: Array<{ path: string; excerpt: string }>;
    };
    expect(r.returned).toBe(1);
    expect(r.hits[0].path).toBe("b.md");
    expect(r.hits[0].excerpt).toContain("/vol/models");
  });

  it("rejects ../ traversal on read and write", async () => {
    const dispatch = await loadDispatch();
    await expect(dispatch("memory_read", { path: "../outside/secret.txt" })).rejects.toThrow(/越界|不存在/);
    await expect(dispatch("memory_write", { path: "../outside/planted.txt", content: "x" })).rejects.toThrow(/越界/);
  });

  it("rejects an absolute path outside the memory dir", async () => {
    const dispatch = await loadDispatch();
    await expect(dispatch("memory_read", { path: join(outside, "secret.txt") })).rejects.toThrow(/越界/);
  });

  it("rejects a symlink pointing outside (lexical checks miss this)", async () => {
    symlinkSync(join(outside, "secret.txt"), join(memoryDir, "link.md"));
    const dispatch = await loadDispatch();
    await expect(dispatch("memory_read", { path: "link.md" })).rejects.toThrow(/越界/);
    await expect(dispatch("memory_write", { path: "link.md", content: "overwrite" })).rejects.toThrow(/越界/);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("OTHER USER SECRET");
  });

  it("rejects writing through a symlinked directory", async () => {
    symlinkSync(outside, join(memoryDir, "escape"));
    const dispatch = await loadDispatch();
    await expect(dispatch("memory_write", { path: "escape/planted.txt", content: "x" })).rejects.toThrow(/越界/);
  });

  it("rejects content over the size cap", async () => {
    const dispatch = await loadDispatch();
    await expect(
      dispatch("memory_write", { path: "big.md", content: "x".repeat(1024 * 1024 + 1) }),
    ).rejects.toThrow(/过大/);
  });

  it("reads a file over 1 MiB in windows that reassemble it exactly (no silent cut)", async () => {
    const big = "开头\n" + "记忆 memory 😀\n".repeat(150_000) + "结尾";
    writeFileSync(join(memoryDir, "big.md"), big);
    const dispatch = await loadDispatch();
    let offset: number | undefined = 0;
    let text = "";
    while (offset !== undefined) {
      const window = (await dispatch("memory_read", { path: "big.md", offset })) as { content: string; size: number; next_offset?: number; eof: boolean };
      expect(window.size).toBe(Buffer.byteLength(big));
      expect(Buffer.byteLength(window.content)).toBeLessThanOrEqual(1024 * 1024);
      text += window.content;
      offset = window.next_offset;
    }
    expect(text).toBe(big);
  });

  it("lists 2,500 files through cursor pages and creates past the old 1000-file mark", async () => {
    for (let i = 0; i < 2_500; i++) {
      mkdirSync(join(memoryDir, `d${i % 5}`), { recursive: true });
      writeFileSync(join(memoryDir, `d${i % 5}`, `f${i}.md`), "x");
    }
    const dispatch = await loadDispatch();
    await dispatch("memory_write", { path: "new.md", content: "created" });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (await dispatch("memory_list", cursor ? { cursor } : {})) as { files: Array<{ path: string }>; next_cursor?: string };
      expect(page.files.length).toBeLessThanOrEqual(500);
      seen.push(...page.files.map((f) => f.path));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(2_501);
    expect(new Set(seen).size).toBe(2_501);
    expect(seen).toEqual([...seen].sort());
  });

  it("writes in retry-safe chunks and searches every file across pages", async () => {
    const dispatch = await loadDispatch();
    const part = (n: number) => String(n).repeat(512 * 1024);
    let size = 0;
    for (let n = 0; n < 4; n++) {
      size = ((await dispatch("memory_write", { path: "chunked.md", content: part(n), ...(size ? { offset: size } : {}) })) as { size: number }).size;
    }
    await dispatch("memory_write", { path: "chunked.md", content: part(3), offset: 3 * 512 * 1024 });
    expect(readFileSync(join(memoryDir, "chunked.md"), "utf8")).toBe([0, 1, 2, 3].map(part).join(""));
    await expect(dispatch("memory_write", { path: "chunked.md", content: "x", offset: size + 1 })).rejects.toThrow(/offset/);
    writeFileSync(join(memoryDir, "deep.md"), "z".repeat(3 * 1024 * 1024) + " FINDME tail");
    for (let i = 0; i < 3; i++) writeFileSync(join(memoryDir, `hit${i}.md`), `findme ${i}`);
    const hits: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (await dispatch("memory_search", { query: "findme", limit: 1, ...(cursor ? { cursor } : {}) })) as { hits: Array<{ path: string }>; next_cursor?: string };
      hits.push(...page.hits.map((h) => h.path));
      cursor = page.next_cursor;
    } while (cursor);
    expect(hits.sort()).toEqual(["deep.md", "hit0.md", "hit1.md", "hit2.md"]);
  });

  it("machine tools are absent when no gateway is configured", async () => {
    const dispatch = await loadDispatch();
    await expect(dispatch("machine_exec", { command: "echo x" })).rejects.toThrow(/没有连接机器端点/);
  });
});

describe("device-scoped machine tools", () => {
  it("hides account discovery and injects the fixed device", async () => {
    process.env.MACHINES_PLUGIN_TEST = "1";
    process.env.MACHINES_API = "http://machines.test";
    process.env.MACHINES_TOKEN = "scoped-token";
    process.env.MACHINES_DEVICE = "lht-val15-ci";
    process.env.MACHINES_AUTO_ALLOW = "1";
    const requests: Array<{ slot: string; operation: string; args: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        slot: string;
        operation: string;
        args: Record<string, unknown>;
      };
      requests.push(body);
      return new Response(JSON.stringify({ ok: true, result: { code: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const mod = await import("./server.js");
      const tools = mod.availableTools();
      expect(tools.map((tool) => tool.name)).not.toContain("machines_list");
      expect(tools.map((tool) => tool.name)).not.toContain("machine_call_result");
      const exec = tools.find((tool) => tool.name === "machine_exec")!;
      expect(exec.description).toContain("固定授权设备 lht-val15-ci");
      expect(exec.description).toContain("直接执行");
      expect(exec.description).not.toContain("每次调用都需要");
      expect(exec.description).not.toContain("machines_list");
      expect(exec.inputSchema.properties).not.toHaveProperty("device");
      expect(exec.inputSchema.required).toEqual(["command"]);

      await mod.dispatch("machine_exec", { command: "pnpm test", cwd: "/work/ticket" });
      expect(requests).toEqual([{
        slot: "runner",
        operation: "exec",
        args: { device: "lht-val15-ci", command: "pnpm test", cwd: "/work/ticket" },
      }]);
      await expect(mod.dispatch("machines_list", {})).rejects.toThrow(/无账户级设备枚举权/);
      await expect(mod.dispatch("machine_exec", { device: "other", command: "true" })).rejects.toThrow(/只授权设备/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
