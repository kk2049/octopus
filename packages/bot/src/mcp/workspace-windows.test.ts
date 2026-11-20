/**
 * The MCP workspace tools reach what the editor and the file tree reach
 * (2026-10-20): every entry of a directory through `after`/`next_after`, and a
 * text file of any size — whole up to the tool's window (staged internally),
 * or through explicit begin / append / commit beyond it.
 *
 * The device is real: a temp home, the real registry and `handleRpc`, behind
 * the authority seam the surface opens per token.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRpc } from "@claude-bot/runner/core";
import { addWorkspace } from "@claude-bot/runner/workspaces";
import { STAGED_TEXT_IDLE_MS, sweepStagedTexts } from "@claude-bot/runner/workspace-files";
import { WORKSPACE_FILES_LIMITS } from "@claude-bot/workspace-files-contract";
import { Store } from "../store/store.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { WorkspaceFilesService } from "../workspace-files/service.js";
import type { RunnerCallOutcome } from "../workspace-files/types.js";
import { MCP_WORKSPACE_OPERATION_IDS, MCP_SUBJECT_ID, mcpSubjectEntry } from "./catalog.js";
import { McpSurface } from "./service.js";

const NOW = "2026-10-20T00:00:00.000Z";
const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("MCP workspace tools without totals", () => {
  let dir: string;
  let home: string;
  let root: string;
  let store: Store;
  let surface: McpSurface;
  const alice = { owner: "alice", credential: "mcp:a1" };
  const frames: Array<{ operation: string; args: Record<string, unknown> }> = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-windows-"));
    home = join(dir, "home");
    root = join(home, "proj");
    mkdirSync(root, { recursive: true });
    await addWorkspace(home, root, "proj");
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    const permissions = new PermissionService({
      store,
      subjects: [mcpSubjectEntry({ workspaceComposed: () => true, crdtComposed: () => false })],
      extraAccountOperations: [() => [...MCP_WORKSPACE_OPERATION_IDS]],
    });
    permissions.grant({
      subjectType: "service",
      subjectId: MCP_SUBJECT_ID,
      owner: "alice",
      operations: [...MCP_WORKSPACE_OPERATION_IDS],
      autoAllow: [...MCP_WORKSPACE_OPERATION_IDS],
      source: "user",
      createdBy: "alice",
    });
    surface = new McpSurface({
      hub: new SessionHubService({ store, permissions }),
      permissions,
      workspaceFilesService: new WorkspaceFilesService(),
      openWorkspaceAuthority: ({ rights }) => ({
        authority: {
          devices: async () => [{ device: "mac", label: "mac" }],
          async call(_device, operation, args): Promise<RunnerCallOutcome> {
            const { device: _selector, ...rest } = args;
            frames.push({ operation, args: rest });
            const response = await handleRpc(home, { id: String(frames.length), method: operation, args: rest }, {
              allowMachineOps: true,
            });
            return response.ok
              ? { status: "succeeded", result: response.result }
              : { status: "failed", reason: response.error };
          },
        },
        writable: rights.includes("replace_workspace_text"),
        close: () => {},
      }),
      publicUrl: "https://bot.example",
    });
  });

  afterAll(async () => {
    await sweepStagedTexts(Date.now() + STAGED_TEXT_IDLE_MS + 1);
    surface.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  type Listing = { entries: Array<{ ref?: string; label: string }>; truncated: boolean; next_after?: string };

  async function call(tool: string, args: Record<string, unknown>) {
    const out = await surface.callTool(alice, tool, args);
    if (!out.ok) throw new Error(`${tool}: ${out.code} ${out.message}`);
    return out.result;
  }

  async function rootRef(): Promise<string> {
    return (await call("list_session_workspaces", {}) as { roots: Array<{ ref: string }> }).roots[0]!.ref;
  }

  async function fileRef(label: string): Promise<string> {
    const listing = await call("list_workspace_entries", { ref: await rootRef() }) as Listing;
    return listing.entries.find((row) => row.label === label)!.ref!;
  }

  it("lists 1,200 entries by following next_after", async () => {
    const big = join(root, "many");
    mkdirSync(big);
    for (let i = 0; i < 1_200; i += 1) writeFileSync(join(big, `f${String(i).padStart(4, "0")}`), "x");
    const many = (await call("list_workspace_entries", { ref: await rootRef() }) as Listing)
      .entries.find((row) => row.label === "many")!.ref!;
    const labels: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await call("list_workspace_entries", { ref: many, ...(after ? { after } : {}) }) as Listing;
      labels.push(...page.entries.map((row) => row.label));
      if (!page.truncated) {
        expect(page.next_after).toBeUndefined();
        break;
      }
      after = page.next_after;
      expect(after).toBe(`file/${labels.at(-1)}`);
    }
    expect(labels).toHaveLength(1_200);
    expect(new Set(labels).size).toBe(1_200);
  });

  it("reads a text file of any size one window per call by following next_offset", async () => {
    const text = "第一行 mixed ascii 文本\n".repeat(40_000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(4 * WORKSPACE_FILES_LIMITS.textChunkBytes);
    writeFileSync(join(root, "long.log"), text);
    const ref = await fileRef("long.log");
    type Window = { document: { digest: string; sizeBytes: number }; offset: number; bytes: number; next_offset: number; eof: boolean; text: string };
    const parts: string[] = [];
    let offset = 0;
    let calls = 0;
    for (;;) {
      const before = frames.length;
      const window = await call("read_workspace_text", { ref, offset }) as Window;
      calls += 1;
      // One device read per call, and no answer holds more than one window.
      expect(frames.slice(before).filter((frame) => frame.operation === "read_workspace_text")).toHaveLength(1);
      expect(window.bytes).toBeLessThanOrEqual(WORKSPACE_FILES_LIMITS.textChunkBytes);
      expect(window).toMatchObject({ offset, document: { digest: sha(text), sizeBytes: Buffer.byteLength(text) } });
      expect(window.next_offset).toBe(offset + window.bytes);
      parts.push(window.text);
      if (window.eof) break;
      offset = window.next_offset;
    }
    expect(parts.join("")).toBe(text);
    expect(calls).toBe(Math.ceil(Buffer.byteLength(text) / WORKSPACE_FILES_LIMITS.textChunkBytes));
    // A smaller window on request, cut between characters.
    const small = await call("read_workspace_text", { ref, max_bytes: 4096 }) as Window;
    expect(small.bytes).toBeLessThanOrEqual(4096);
    expect(text.startsWith(small.text)).toBe(true);
    // An offset inside a character is refused rather than answered with mojibake.
    expect(await surface.callTool(alice, "read_workspace_text", { ref, offset: 1 })).toMatchObject({ ok: false });
  });

  it("replaces a whole text far past one call's window in one tool call", async () => {
    writeFileSync(join(root, "big.md"), "v1\n");
    const text = "一行文字 with ascii\n".repeat(60_000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(4 * WORKSPACE_FILES_LIMITS.maxWriteTextBytes);
    const before = frames.length;
    const receipt = await call("replace_workspace_text", {
      ref: await fileRef("big.md"),
      expected_digest: sha("v1\n"),
      text,
    }) as { afterDigest: string; sizeBytes: number };
    expect(receipt).toMatchObject({ afterDigest: sha(text), sizeBytes: Buffer.byteLength(text) });
    expect(readFileSync(join(root, "big.md"), "utf8")).toBe(text);
    const stages = frames.slice(before).filter((frame) => frame.operation === "replace_workspace_text")
      .map((frame) => frame.args.stage);
    expect(stages[0]).toBe("begin");
    expect(stages.at(-1)).toBe("commit");
  });

  it("writes beyond the tool's own window through explicit begin / append / commit", async () => {
    writeFileSync(join(root, "huge.md"), "v1\n");
    const ref = await fileRef("huge.md");
    const begun = await call("replace_workspace_text", { ref, stage: "begin", expected_digest: sha("v1\n") }) as {
      upload: string;
      sizeBytes: number;
    };
    expect(begun.sizeBytes).toBe(0);
    const parts = ["α".repeat(300_000), "β".repeat(300_000)];
    let offset = 0;
    for (const part of parts) {
      const appended = await call("replace_workspace_text", { ref, stage: "append", upload: begun.upload, offset, text: part }) as {
        sizeBytes: number;
      };
      offset += Buffer.byteLength(part);
      expect(appended.sizeBytes).toBe(offset);
    }
    // Nothing is replaced until commit.
    expect(readFileSync(join(root, "huge.md"), "utf8")).toBe("v1\n");
    const receipt = await call("replace_workspace_text", {
      ref,
      stage: "commit",
      upload: begun.upload,
      expected_digest: sha("v1\n"),
      size: offset,
    }) as { afterDigest: string };
    expect(receipt.afterDigest).toBe(sha(parts.join("")));
    expect(readFileSync(join(root, "huge.md"), "utf8")).toBe(parts.join(""));
  });

  it("refuses a stale commit and leaves the file as somebody else saved it", async () => {
    writeFileSync(join(root, "race.md"), "v1\n");
    const ref = await fileRef("race.md");
    const begun = await call("replace_workspace_text", { ref, stage: "begin", expected_digest: sha("v1\n") }) as { upload: string };
    await call("replace_workspace_text", { ref, stage: "append", upload: begun.upload, offset: 0, text: "mine" });
    writeFileSync(join(root, "race.md"), "theirs\n");
    const out = await surface.callTool(alice, "replace_workspace_text", {
      ref, stage: "commit", upload: begun.upload, expected_digest: sha("v1\n"), size: 4,
    });
    expect(out).toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(readFileSync(join(root, "race.md"), "utf8")).toBe("theirs\n");
  });
});
