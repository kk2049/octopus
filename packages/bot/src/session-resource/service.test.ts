import { runnerDisplayName, runnerDisplayNameKey } from "../runner/display-name.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionService } from "../permissions/service.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "../runner/gateway.js";
import { BOT_HOST_DEVICE, decodeResourceId, resourceId } from "../sessionhub/core.js";
import { Store } from "../store/store.js";
import { mergeSessionCatalogList } from "../runner/session-catalog.js";
import { SESSION_PLUS_SUBJECT_ENTRY } from "./catalog.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_AUTO_ALLOW,
  SESSION_PLUS_OPERATIONS,
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_CHAT_UPLOAD_OPERATIONS,
  SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT,
  SESSION_PLUS_TERMINAL_OPERATIONS,
  SESSION_PLUS_TERMINAL_PERMISSION_CONTRACT,
  sessionPlusPermissionContractDigest,
} from "./contract.js";
import { AppAuthorityBundles } from "./bundle.js";
import { IntentGrantResolver } from "./intent-resolver.js";
import { isWorkspaceDirectoryKey } from "@claude-bot/workspace-files-contract";
import { WorkspaceDirectoryKeys } from "../workspace-files/directory-key.js";
import { SessionResourceService, boundedPlacementDevices } from "./service.js";
import { SESSION_ROSTER_STALE_TTL_MS } from "./roster-memory.js";
import { loadSessionPlusManifest, normalizeSessionPlusAction } from "../app-core/manifest.js";

it("projects only recognized path-free Agent diagnostics and preserves old inventory", () => {
  const rows = boundedPlacementDevices([{ device: "mac", inventory: {
    schema: "runner-inventory/v1", execution: {}, agent_backends: [
      { kind: "codex", available: false, reason: "probe_failed", diagnostic_code: "unsafe_permissions", detail: { path: "/secret/install" } },
      { kind: "claude", available: false, reason: "probe_failed", diagnostic_code: "/secret/install" },
      { kind: "omp", available: false, reason: "command_unavailable" },
    ],
  } }], new Set(["mac"]));
  expect(rows[0]).toMatchObject({ agentBackends: [
    { kind: "codex", diagnosticCode: "unsafe_permissions", reason: "probe_failed" },
    { kind: "claude", reason: "probe_failed" },
    { kind: "omp", reason: "command_unavailable" },
  ] });
  expect(JSON.stringify(rows)).not.toContain("/secret/install");
  expect((rows[0].agentBackends as any[])[1]).not.toHaveProperty("diagnosticCode");
});

it("projects the validated offending path of the owner's own unavailable executable", () => {
  const rows = boundedPlacementDevices([{ device: "mac", inventory: {
    schema: "runner-inventory/v1", execution: {}, agent_backends: [
      { kind: "codex", available: false, reason: "probe_failed", diagnostic_code: "unsafe_permissions",
        diagnostic_detail: { path: "/Users/alice/.local/bin", rule: "group_writable" } },
      { kind: "claude", available: false, reason: "probe_failed", diagnostic_code: "unsafe_permissions",
        diagnostic_detail: { path: "relative/bin", rule: "group_writable" } },
    ],
  } }], new Set(["mac"]));
  expect(rows[0]).toMatchObject({ agentBackends: [
    { kind: "codex", diagnosticCode: "unsafe_permissions", diagnosticPath: "/Users/alice/.local/bin", diagnosticRule: "group_writable" },
    { kind: "claude", diagnosticCode: "unsafe_permissions" },
  ] });
  expect((rows[0].agentBackends as any[])[1]).not.toHaveProperty("diagnosticPath");
});

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

describe("SessionResourceService", () => {
  let dir: string;
  let store: Store;
  let frames: Array<{ owner: string; operation: string; args: Record<string, unknown> }>;
  let runner: RunnerCapabilities;
  let permissions: PermissionService;
  let bundles: AppAuthorityBundles;
  let resources: SessionResourceService;
  let workspaceReply: Record<string, unknown>;
  let workspaceFailure: Error | null;
  let terminalScreen: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-plus-resource-"));
    store = new Store(join(dir, "state.db"));
    for (const [owner, uid] of [["alice", 9101], ["bob", 9102]] as const) {
      store.saveUser({ username: owner, uid, home_dir: "/unused", created_at: new Date(NOW).toISOString() });
      store.saveRunnerToken(hashRunnerToken(`rt_${owner}`), owner, "laptop", new Date(NOW).toISOString());
    }
    frames = [];
    workspaceFailure = null;
    terminalScreen = "$ ";
    workspaceReply = {
      workspaces: [{
        id: "ws_0123456789abcdef01234567",
        label: "Octopus",
        display: "~/lht/octopus",
        path: "/canonical/secret/worktree",
        owner: "forged-owner-field",
        approved: true,
      }],
      session_directories: [
        { source: "claude", id: "s1", workspace_id: "ws_0123456789abcdef01234567", relative_path: "packages/bot" },
      ],
    };
    const transport: RunnerTransport = {
      dispatch: async (owner: string, operation: string, args: Record<string, unknown>) => {
        frames.push({ owner, operation, args });
        if (args.id === "continuation-codex" && (args.continuation_settings || args.configure_continuation)) {
          const prompt = args.configure_continuation ? args.continuation_prompt || null : null;
          return { protocol: "codex-continuation/v1", prompt, effectivePrompt: prompt ?? "继续执行", revision: "0" };
        }
        if (operation === "list_recent_sessions") {
          return {
            has_more: false,
            total_found: 1,
            devices: ["laptop"],
            sessions: [{
              id: "s1",
              source: "claude",
              device: "laptop",
              project: "octopus",
              cwd: "/canonical/secret/worktree",
              owner: "forged-owner-field",
              path: "/canonical/secret/transcript.jsonl",
              first_user_text: "hello",
              title: "调研 dsh 生态",
              activity: { state: "tool", tool: "Bash", since: "2026-08-04T14:59:00Z", secret: "drop" },
              runtime: {
                process_state: "alive",
                turn_state: "needs_input",
                control_mode: "external_cli",
                observed_at: "2026-08-04T15:00:00Z",
                event: "PermissionRequest",
                tool: "Bash",
                degraded: false,
                pid: 4242,
                transcript_path: "/canonical/secret/transcript.jsonl",
                capabilities: {
                  observe: true,
                  takeover: true,
                  interrupt: true,
                  steer: false,
                  respond: true,
                  root: true,
                },
                interaction: {
                  id: "ai_question",
                  provider: "claude",
                  kind: "question",
                  title: "Claude Code 需要你的回答",
                  tool: "AskUserQuestion",
                  questions: [{
                    id: "acceptance",
                    header: "验收结果",
                    prompt: "网页提问闭环是否通过？",
                    options: [
                      { label: "通过", description: "卡片正常" },
                      { label: "不通过", description: "卡片异常", canonical_path: "/drop" },
                    ],
                    multiple: false,
                    allow_other: false,
                    secret: false,
                    rpc_id: "drop",
                  }],
                  created_at: "2026-08-04T15:00:00Z",
                  expires_at: "2026-08-04T15:10:00Z",
                  capabilities: { respond: true, allow: true, deny: true, root: true },
                  rpc_id: "drop",
                },
              },
            }],
          };
        }
        if (operation === "search_sessions" && args.query === "paged") {
          const hit = (id: string, mtimeMs: number, snippet: string) => ({
            session: { id, source: "claude", device: "laptop" },
            matches: [{ role: "user", snippet }],
            cursor: JSON.stringify([mtimeMs, `claude:${id}`]),
          });
          return args.cursor
            ? { results: [hit("s2", 100, "older paged hit")], complete: true, scanned: 1, total_candidates: 2 }
            : { results: [hit("s1", 900, "newer paged hit")], complete: false, next_cursor: JSON.stringify([500, "claude:s1"]), scanned: 1, total_candidates: 2 };
        }
        if (operation === "search_sessions") {
          return {
            results: [{
              session: { id: "s1", source: "claude", device: "laptop", owner: "forged" },
              snippet: "matching text",
              path: "/must/not/cross",
              approved: true,
            }],
          };
        }
        if (operation === "read_session") {
          if (args.id === "s-offline") throw new Error("Runner laptop is reconnecting");
          if (args.block !== undefined) {
            // Block 9 plays a Runner that predates block reads: it answers with a page.
            return args.block === 9 ? { rich: true, offset: args.offset, messages: [] } : {
              rich: true,
              offset: args.offset,
              block: args.block,
              field: args.field,
              text: "complete-output",
              char_offset: args.char_offset,
              total_chars: 30,
              next_char_offset: 15,
              path: "/canonical/secret/transcript.jsonl",
            };
          }
          if (args.offset !== undefined) {
            const offset = Number(args.offset);
            const limit = Number(args.max_messages);
            return {
              rich: true,
              total_messages: 600,
              offset,
              messages: Array.from({ length: limit }, (_, index) => ({
                role: (offset + index) % 2 ? "assistant" : "user",
                content: `message-${offset + index}`,
              })),
              activity: { state: "idle" },
            };
          }
          return {
            rich: true,
            path: "/canonical/secret/transcript.jsonl",
            owner: "forged-owner-field",
            messages: [{ role: "user", content: "hello" }],
            activity: { state: "idle" },
          };
        }
        if (operation === "list_session_workspaces") {
          if (workspaceFailure) throw workspaceFailure;
          return workspaceReply;
        }
        if (operation === "upload_session_file") {
          return {
            upload_id: "abcdefghijklmnopqrstuvwx",
            complete: true,
            ...(args.workspace_id ? { workspace_id: args.workspace_id } : {}),
            attachment: {
              label: "notes.txt",
              path: "/tmp/octopus-session-fixture/notes.txt",
              bytes: 5,
              media_type: "text/plain",
              owner: "must-not-cross",
            },
          };
        }
        if (operation === "workspace_terminal") {
          const action = String(args.action ?? "");
          if (action === "input") terminalScreen += `${String(args.input ?? "")}\nterminal-ok\n$ `;
          return {
            terminal_id: `term_${"a".repeat(48)}`,
            screen: action === "close" ? "" : terminalScreen,
            closed: action === "close",
          };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
      listDevices: () => [],
      isOnline: () => true,
      ping: async () => 1,
      disconnect: () => true,
    } as unknown as RunnerTransport;
    runner = new RunnerCapabilities(store, transport, { now: () => NOW });
    permissions = new PermissionService({
      store,
      caps: runner,
      now: () => NOW,
      bootstrapSessionHub: false,
      subjects: [SESSION_PLUS_SUBJECT_ENTRY],
    });
    for (const owner of ["alice", "bob"]) {
      permissions.grant({
        subjectType: "app",
        subjectId: SESSION_PLUS_APP_ID,
        owner,
        operations: SESSION_PLUS_OPERATIONS,
        autoAllow: SESSION_PLUS_AUTO_ALLOW,
        source: "config",
        createdBy: "system:config",
        contractDigest: sessionPlusPermissionContractDigest(),
        publisher: SESSION_PLUS_PUBLISHER,
      });
    }
    bundles = new AppAuthorityBundles({ runner, grants: new IntentGrantResolver(permissions, () => NOW) });
    bundles.open("alice", "alice-instance", "package");
    bundles.open("bob", "bob-instance", "package");
    resources = new SessionResourceService(bundles, permissions, 2_000, 10);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gates Codex settings as read/execute without a model prompt and rejects foreign resources", async () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: "continuation-codex" });
    expect(await resources.execute("alice-instance", "read_codex_continuation", { resource: rid }, {}))
      .toMatchObject({ ok: true, result: { prompt: null, effectivePrompt: "继续执行" } });
    expect(await resources.execute("alice-instance", "save_codex_continuation", { resource: rid, prompt: "繼續執行", revision: "0" }, {}))
      .toMatchObject({ ok: false, code: "approval_required" });
    expect(frames).toHaveLength(1); // Only the read reached the Runner before approval.
    const pending = runner.listPending("alice");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operation: "append_session", requestedBy: { action: "save_codex_continuation" } });
    await expect(runner.approve(pending[0].id, "alice")).resolves.toMatchObject({ status: "succeeded" });
    expect(frames.at(-1)).toMatchObject({ owner: "alice", operation: "append_session", args: {
      device: "laptop", source: "codex", id: "continuation-codex", configure_continuation: true,
      continuation_prompt: "繼續執行", continuation_revision: "0",
    } });
    expect(frames.at(-1)!.args).not.toHaveProperty("prompt");
    const before = frames.length;
    expect((await resources.execute("bob-instance", "save_codex_continuation", { resource: rid, prompt: "bad", revision: "0" }, {})).ok).toBe(false);
    const claude = resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s1" });
    expect((await resources.execute("alice-instance", "save_codex_continuation", { resource: claude, prompt: "bad", revision: "0" }, {})).ok).toBe(false);
    expect((await resources.execute("alice-instance", "save_codex_continuation", { resource: rid, prompt: "   ", revision: "0" }, {})).ok).toBe(false);
    expect(frames).toHaveLength(before);
    const old = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: "old-runner" });
    expect(await resources.execute("alice-instance", "read_codex_continuation", { resource: old }, {}))
      .toMatchObject({ ok: false, code: "resource_failed" });
  });

  it("decorates current and history session labels without changing their resource identities", async () => {
    resources = new SessionResourceService(bundles, permissions, 2_000, 10, null, null, Date.now, undefined, null, null, null, null,
      (owner, device) => runnerDisplayName(store, owner, device));
    store.setSetting("alice", runnerDisplayNameKey("laptop"), "aliyun");
    const recent = await resources.execute("alice-instance", "refresh_sessions", {}, {});
    expect(recent.ok).toBe(true);
    if (!recent.ok) return;
    const row = (recent.patch as any).sessions[0];
    expect(row).toMatchObject({ deviceId: "laptop", deviceLabel: "aliyun" });
    expect((recent.patch as any).sources).toContainEqual({ kind: "runner", device: "laptop", online: true, deviceLabel: "aliyun" });
    const workspace = await resources.execute("alice-instance", "refresh_workspaces", { device: "laptop" }, {});
    expect(workspace.ok).toBe(true);
    if (workspace.ok) expect((workspace.patch as any).workspacesByDevice.laptop).toMatchObject({ device: "laptop", deviceLabel: "aliyun" });
    expect(decodeResourceId(row.resourceId)).toEqual({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s1" });
    store.setSetting("alice", runnerDisplayNameKey("laptop"), "new visible name");
    const history = await resources.execute("alice-instance", "refresh_sessions", { device: "laptop", cursor: "", source: "all" }, {});
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect((history.patch as any).sessionHistory.sessions[0]).toMatchObject({ resourceId: row.resourceId, deviceLabel: "new visible name" });
    const other = await resources.execute("bob-instance", "refresh_sessions", {}, {});
    expect(other.ok).toBe(true);
    if (other.ok) expect((other.patch as any).sessions[0].deviceLabel).toBe("laptop");
    expect(frames.every((frame) => frame.args.device !== "aliyun" && frame.args.device !== "new visible name")).toBe(true);
  });

  it("pages one device through its existing Gate without replacing the recent projection", async () => {
    const out = await resources.execute("alice-instance", "refresh_sessions", { device: "laptop", source: "all", cursor: "", limit: "100" }, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const patch = out.patch as Record<string, any>;
    expect(Object.keys(patch)).toEqual(["sessionHistory"]);
    expect(patch.sessionHistory).toMatchObject({ device: "laptop", cursor: "", sessions: [{ sessionId: "s1" }] });
    expect(JSON.stringify(patch)).not.toContain("canonical/secret");
    const cursor = patch.sessionHistory.nextCursor;
    expect(decodeResourceId(cursor)).toEqual({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s1" });
    expect(frames.at(-1)).toMatchObject({ owner: "alice", operation: "list_recent_sessions", args: { device: "laptop", cursor: "", limit: 100 } });
    await resources.execute("alice-instance", "refresh_sessions", { device: "laptop", source: "all", cursor }, {});
    expect(frames.at(-1)?.args.cursor).toBe(JSON.stringify(["claude", "s1"]));
    const before = frames.length;
    expect((await resources.execute("bob-instance", "refresh_sessions", { device: "laptop", cursor }, {})).ok).toBe(false);
    expect((await resources.execute("alice-instance", "refresh_sessions", { device: "other", cursor }, {})).ok).toBe(false);
    expect(frames).toHaveLength(before);
  });

  it("refreshes recent chats after the actual manifest normalizer fills absent pagination fields", async () => {
    const normalized = normalizeSessionPlusAction(loadSessionPlusManifest(), "refresh_sessions", { source: "all", limit: "200" });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.params).toMatchObject({ device: "", cursor: "" });
    const out = await resources.execute("alice-instance", normalized.action, normalized.params, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.patch.sessions).toEqual([expect.objectContaining({ sessionId: "s1" })]);
    expect(out.patch.sessionHistory).toBeUndefined();
    expect(frames).toContainEqual({ owner: "alice", operation: "list_recent_sessions",
      args: { source: "all", limit: 200, primary_window: true, _octopus_include_session_plus: true } });
  });

  it("keeps a normalized device selection on the first history page and rejects an unbound nonempty cursor", async () => {
    const manifest = loadSessionPlusManifest();
    const first = normalizeSessionPlusAction(manifest, "refresh_sessions", { device: "laptop", cursor: "" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const out = await resources.execute("alice-instance", first.action, first.params, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.patch.sessionHistory).toMatchObject({ device: "laptop", sessions: [{ sessionId: "s1" }] });
    expect(out.patch.sessions).toBeUndefined();
    expect(frames.at(-1)?.args).toMatchObject({ device: "laptop", cursor: "" });
    const invalid = normalizeSessionPlusAction(manifest, "refresh_sessions", { cursor: "invalid-cursor" });
    if (!invalid.ok) throw new Error(invalid.message);
    const count = frames.length;
    expect(await resources.execute("alice-instance", invalid.action, invalid.params, {}))
      .toMatchObject({ ok: false, code: "invalid_resource" });
    expect(frames).toHaveLength(count);
  });

  it("searches through the same normalized action and authorized resource path", async () => {
    const normalized = normalizeSessionPlusAction(loadSessionPlusManifest(), "search_sessions", { query: "matching" });
    if (!normalized.ok) throw new Error(normalized.message);
    const out = await resources.execute("alice-instance", normalized.action, normalized.params, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.patch.search).toMatchObject({ query: "matching", results: [expect.objectContaining({ snippet: "matching text" })] });
    expect(frames.at(-1)).toMatchObject({ operation: "search_sessions", args: { query: "matching" } });
  });

  it("lists and reads through the app ControllerRun with an explicit disclosure projection", async () => {
    const listed = await resources.execute("alice-instance", "refresh_sessions", { source: "all", limit: "20" }, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const projection = listed.patch as Record<string, any>;
    expect(projection.sessions).toHaveLength(1);
    const session = projection.sessions[0];
    expect(Object.keys(session).sort()).toEqual([
      "activity", "cliKind", "completedAt", "cwdDisplay", "deviceId", "deviceLabel", "firstUserText",
      "lastActivity", "preview", "projectLabel", "resourceId", "resumable", "runtime",
      "sessionId", "sortActivity", "status", "title",
    ].sort());
    expect(session).not.toHaveProperty("owner");
    expect(session).not.toHaveProperty("path");
    expect(session.cwdDisplay).toBe("octopus");
    expect(session.title).toBe("调研 dsh 生态");
    expect(session.activity).toMatchObject({ state: "idle" });
    expect(session.status).toBe("live");
    expect(session.activity).not.toHaveProperty("secret");
    expect(session.runtime).toMatchObject({
      process_state: "alive",
      turn_state: "needs_input",
      capabilities: { takeover: true, interrupt: true, steer: false },
    });
    expect(session.runtime).not.toHaveProperty("pid");
    expect(session.runtime).not.toHaveProperty("transcript_path");
    expect(session.runtime.capabilities).not.toHaveProperty("root");
    expect(session.runtime.interaction).toMatchObject({
      id: "ai_question",
      provider: "claude",
      kind: "question",
      questions: [{
        id: "acceptance",
        options: [{ label: "通过" }, { label: "不通过" }],
      }],
    });
    expect(session.runtime.interaction).not.toHaveProperty("rpc_id");
    expect(session.runtime.interaction.questions[0]).not.toHaveProperty("rpc_id");
    expect(session.runtime.interaction.questions[0].options[1]).not.toHaveProperty("canonical_path");
    expect(session.runtime.interaction.capabilities).not.toHaveProperty("root");

    const read = await resources.execute(
      "alice-instance",
      "open_session",
      { resource: session.resourceId, limit: "30" },
      listed.patch,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const data = read.result as Record<string, unknown>;
    expect(data).not.toHaveProperty("owner");
    expect(data).not.toHaveProperty("path");
    expect(data).toMatchObject({ sessionId: "s1", cliKind: "claude", deviceLabel: "laptop" });
    const readFrame = frames.find((frame) => frame.operation === "read_session")!;
    expect(readFrame).toMatchObject({ owner: "alice", args: { id: "s1", source: "claude", device: "laptop" } });

    const audit = permissions.activity("alice", { subjectId: SESSION_PLUS_APP_ID });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((row) => row.subject_type === "app" && row.subject_id === SESSION_PLUS_APP_ID)).toBe(true);
  });

  it.each([false, true])("uploads through the opaque session's trusted execution target (split=%s)", async (split) => {
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      operations: [...SESSION_PLUS_CHAT_UPLOAD_OPERATIONS],
      autoAllow: [...SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT.autoAllow],
      source: "config",
      createdBy: "system:config",
      contractDigest: sessionPlusPermissionContractDigest(
        SESSION_PLUS_PUBLISHER,
        SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT,
      ),
      publisher: SESSION_PLUS_PUBLISHER,
    });
    bundles.destroy("alice-instance");
    bundles.open("alice", "alice-upload-instance", "package");
    frames.length = 0;
    if (split) resources = new SessionResourceService(bundles, permissions, 2_000, 10, null, null, Date.now,
      undefined, null, null, null, (owner, device, source, id) => {
        expect([owner, device, source, id]).toEqual(["alice", "model-head", "claude", "s1"]);
        return { device: "laptop", workspaceId: "ws_0123456789abcdef01234567" };
      });
    const resource = resourceId({ owner: "alice", device: split ? "model-head" : "laptop", cliKind: "claude", sessionId: "s1" });
    const result = await resources.execute("alice-upload-instance", "attach_file", {
      resource,
      name: "notes.txt",
      media_type: "text/plain",
      chunk_index: "0",
      chunk_count: "1",
      data: "aGVsbG8=",
    }, {});
    expect(result).toMatchObject({
      ok: true,
      result: {
        upload_id: "abcdefghijklmnopqrstuvwx",
        complete: true,
        attachment: {
          label: "notes.txt",
          path: "/tmp/octopus-session-fixture/notes.txt",
          bytes: 5,
          mediaType: "text/plain",
        },
      },
    });
    expect(result).not.toHaveProperty("result.attachment.owner");
    expect(frames).toEqual([expect.objectContaining({
      owner: "alice",
      operation: "upload_session_file",
      args: expect.objectContaining({ device: "laptop", id: "s1", chunk_index: 0, chunk_count: 1,
        ...(split ? { workspace_id: "ws_0123456789abcdef01234567" } : {}) }),
    })]);

    frames.length = 0;
    const forged = await resources.execute("alice-upload-instance", "attach_file", {
      resource: resourceId({ owner: "bob", device: "laptop", cliKind: "claude", sessionId: "s1" }),
      name: "notes.txt",
      media_type: "text/plain",
      chunk_index: "0",
      chunk_count: "1",
      data: "aGVsbG8=",
    }, {});
    expect(forged).toMatchObject({ ok: false, code: "invalid_resource" });
    expect(frames).toEqual([]);
  });

  it("uploads a launch draft through the owner's Gate and rejects guests and mixed targets", async () => {
    permissions.grant({ subjectType: "app", subjectId: SESSION_PLUS_APP_ID, owner: "alice",
      operations: [...SESSION_PLUS_CHAT_UPLOAD_OPERATIONS], autoAllow: [...SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT.autoAllow],
      source: "config", createdBy: "system:config", publisher: SESSION_PLUS_PUBLISHER,
      contractDigest: sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT) });
    bundles.open("alice", "draft-instance", "package");
    const params = { device: "laptop", name: "notes.txt", media_type: "text/plain", chunk_index: "0", chunk_count: "1", data: "aGVsbG8=" };
    const answer = await resources.execute("draft-instance", "attach_file", params, {});
    expect(answer).toMatchObject({ ok: true, result: { complete: true, attachment: { label: "notes.txt" } } });
    expect(frames.at(-1)).toMatchObject({ owner: "alice", operation: "upload_session_file", args: { device: "laptop", id: expect.stringMatching(/^draft-/) } });
    const count = frames.length;
    bundles.open("alice", "guest-draft", "package", "guest");
    expect(await resources.execute("guest-draft", "attach_file", params, {})).toMatchObject({ ok: false });
    expect(await resources.execute("draft-instance", "attach_file", { ...params,
      resource: resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: "s1" }) }, {})).toMatchObject({ ok: false });
    expect(frames).toHaveLength(count);
  });

  it("uploads a bot-host session attachment through the local plane without inventing a Runner", async () => {
    const calls: Array<{ plane: string; action: string; operation: string; args: Record<string, unknown> }> = [];
    const localBundles = {
      profile: { app: SESSION_PLUS_APP_ID, publisher: SESSION_PLUS_PUBLISHER, operations: [], autoAllow: [] },
      get: (instanceId: string) => instanceId === "local-instance" ? { owner: "alice" } : null,
      openController: (_instanceId: string, plane: string, action: string) => ({
        caps: {
          request: async (_slot: string, operation: string, args: Record<string, unknown>) => {
            calls.push({ plane, action, operation, args });
            return {
              status: "succeeded",
              result: {
                upload_id: "abcdefghijklmnopqrstuvwx",
                complete: true,
                attachment: {
                  label: "pasted.png",
                  path: "/tmp/octopus-session-local/pasted.png",
                  bytes: 11,
                  media_type: "image/png",
                },
              },
            };
          },
        },
        close() {},
      }),
    } as unknown as AppAuthorityBundles;
    const localResources = new SessionResourceService(
      localBundles,
      { audit() {} } as unknown as PermissionService,
      2_000,
      10,
    );
    const result = await localResources.execute("local-instance", "attach_file", {
      resource: resourceId({ owner: "alice", device: BOT_HOST_DEVICE, cliKind: "codex", sessionId: "local-1" }),
      name: "pasted.png",
      media_type: "image/png",
      chunk_index: "0",
      chunk_count: "1",
      data: "aW1hZ2UtYnl0ZXM=",
    }, {});

    expect(result).toMatchObject({
      ok: true,
      result: {
        complete: true,
        attachment: { label: "pasted.png", path: "/tmp/octopus-session-local/pasted.png" },
      },
    });
    expect(calls).toEqual([{
      plane: "local",
      action: "attach_file",
      operation: "upload_session_file",
      args: expect.not.objectContaining({ device: expect.anything() }),
    }]);
    expect(calls[0]?.args).toMatchObject({ id: "local-1", chunk_index: 0, chunk_count: 1 });
  });

  it.each([false, true])("accepts large local upload receipts without clipping progress (complete=%s)", async (complete) => {
    const calls: Array<{ plane: string; action: string; operation: string; args: Record<string, unknown> }> = [];
    const localBundles = {
      profile: { app: SESSION_PLUS_APP_ID, publisher: SESSION_PLUS_PUBLISHER, operations: [], autoAllow: [] },
      get: (instanceId: string) => instanceId === "local-instance" ? { owner: "alice" } : null,
      openController: (_instanceId: string, plane: string, action: string) => ({
        caps: {
          request: async (_slot: string, operation: string, args: Record<string, unknown>) => {
            calls.push({ plane, action, operation, args });
            return {
              status: "succeeded",
              result: {
                upload_id: "abcdefghijklmnopqrstuvwx",
                complete,
                received_bytes: 9 * 1024 * 1024,
                attachment: {
                  label: "pasted.png",
                  path: "/tmp/octopus-session-local/pasted.png",
                  bytes: 9 * 1024 * 1024,
                  media_type: "image/png",
                },
              },
            };
          },
        },
        close() {},
      }),
    } as unknown as AppAuthorityBundles;
    const localResources = new SessionResourceService(
      localBundles,
      { audit() {} } as unknown as PermissionService,
      2_000,
      10,
    );
    const result = await localResources.execute("local-instance", "attach_file", {
      resource: resourceId({ owner: "alice", device: BOT_HOST_DEVICE, cliKind: "codex", sessionId: "local-1" }),
      name: "pasted.png",
      media_type: "image/png",
      chunk_index: complete ? "35" : "34",
      chunk_count: "36",
      upload_id: "abcdefghijklmnopqrstuvwx",
      data: "aW1hZ2UtYnl0ZXM=",
    }, {});

    expect(result).toMatchObject({ ok: true, result: complete
      ? { complete: true, attachment: { bytes: 9 * 1024 * 1024 } }
      : { complete: false, received_bytes: 35 * 256 * 1024 } });
    expect(calls).toEqual([{
      plane: "local",
      action: "attach_file",
      operation: "upload_session_file",
      args: expect.not.objectContaining({ device: expect.anything() }),
    }]);
    expect(calls[0]?.args).toMatchObject({ id: "local-1", chunk_index: complete ? 35 : 34, chunk_count: 36 });
  });

  it("retains missing devices and failed planes until TTL, then replaces them on recovery", async () => {
    let now = 0;
    let runnerReply: unknown = {
      devices: ["A", "B"],
      sessions: [
        { device: "A", source: "claude", id: "a1", last_activity: "2026-08-13T05:00:00Z" },
        { device: "B", source: "claude", id: "b1", last_activity: "2026-08-13T04:00:00Z" },
      ],
    };
    let localReply: unknown = {
      sessions: [{ source: "claude", id: "local1", last_activity: "2026-08-13T03:00:00Z" }],
    };
    const fakeBundles = {
      profile: { app: "session-plus", publisher: "octopus:first-party", operations: [], autoAllow: [] },
      get: (instanceId: string) => instanceId === "instance" ? { owner: "alice" } : null,
      openController: (_instanceId: string, plane: "runner" | "local") => ({
        caps: {
          request: async () => {
            const reply = plane === "runner" ? runnerReply : localReply;
            if (reply instanceof Error) throw reply;
            return { status: "succeeded", result: reply };
          },
        },
        close() {},
      }),
    } as unknown as AppAuthorityBundles;
    const service = new SessionResourceService(
      fakeBundles,
      { audit() {} } as unknown as PermissionService,
      2_000,
      10,
      null,
      null,
      () => now,
    );
    const refresh = async () => {
      const result = await service.execute("instance", "refresh_sessions", { limit: "20" }, {});
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      return (result.patch.sessions as Array<Record<string, unknown>>);
    };
    const indexed = (rows: Array<Record<string, unknown>>) => new Map(rows.map((row) => [row.deviceId, row]));

    expect(indexed(await refresh()).get("B")).not.toHaveProperty("stale");

    now = 1;
    runnerReply = {
      devices: ["A"],
      sessions: [{ device: "A", source: "claude", id: "a2", last_activity: "2026-08-13T05:01:00Z" }],
    };
    localReply = { sessions: [{ source: "claude", id: "local2", last_activity: "2026-08-13T03:01:00Z" }] };
    let rows = indexed(await refresh());
    expect(rows.get("A")).toMatchObject({ sessionId: "a2" });
    expect(rows.get("A")).not.toHaveProperty("stale");
    expect(rows.get("B")).toMatchObject({ sessionId: "b1", stale: true });
    expect(rows.get("bot-host")).toMatchObject({ sessionId: "local2" });
    expect(rows.get("bot-host")).not.toHaveProperty("stale");

    now = 2;
    runnerReply = {
      devices: ["A", "B"],
      sessions: [
        { device: "A", source: "claude", id: "a3", last_activity: "2026-08-13T05:02:00Z" },
        { device: "B", source: "claude", id: "b2", last_activity: "2026-08-13T04:02:00Z" },
      ],
    };
    rows = indexed(await refresh());
    expect(rows.get("B")).toMatchObject({ sessionId: "b2" });
    expect(rows.get("B")).not.toHaveProperty("stale");

    now = 3;
    runnerReply = new Error("runner plane unavailable");
    localReply = { sessions: [{ source: "claude", id: "local3", last_activity: "2026-08-13T03:03:00Z" }] };
    rows = indexed(await refresh());
    expect(rows.get("A")).toMatchObject({ stale: true });
    expect(rows.get("B")).toMatchObject({ stale: true });
    expect(rows.get("bot-host")).toMatchObject({ sessionId: "local3" });
    expect(rows.get("bot-host")).not.toHaveProperty("stale");

    now = 4;
    runnerReply = {
      devices: ["A"],
      sessions: [{ device: "A", source: "claude", id: "a4", last_activity: "2026-08-13T05:04:00Z" }],
    };
    localReply = new Error("local plane unavailable");
    rows = indexed(await refresh());
    expect(rows.get("A")).not.toHaveProperty("stale");
    expect(rows.get("B")).toMatchObject({ stale: true });
    expect(rows.get("bot-host")).toMatchObject({ sessionId: "local3", stale: true });

    now = 2 + SESSION_ROSTER_STALE_TTL_MS + 1;
    localReply = { sessions: [] };
    rows = indexed(await refresh());
    expect(rows.has("B")).toBe(false);
  });

  describe("staged roster fan-in", () => {
    it.each([600, 20_000])("keeps 200 effective chats and reports genuine remaining coverage out of %i logs", async (total) => {
      const staged = stagedRosterService();
      const execution = staged.service.execute("instance", "refresh_sessions", { limit: "200" }, {});
      const roots = Array.from({ length: 200 }, (_, i) => ({
        device: "laptop", source: "codex", id: "root-" + i, last_activity: "2026-08-20T00:00:00Z",
      }));
      // A newer burst of harness runs has its own budget instead of evicting chats.
      const runs = Array.from({ length: 100 }, (_, i) => ({
        device: "laptop", source: "codex", id: "run-" + i, last_activity: "2026-09-08T00:00:00Z", execution_mode: "exec",
      }));
      const children = Array.from({ length: 300 }, (_, i) => ({
        device: "laptop", source: "codex", id: "child-" + i, is_subagent: true, parent_session_id: "root-0",
        last_activity: "2026-09-07T00:00:00Z",
      }));
      staged.gates.runner[0].resolve({ devices: ["laptop"], total_found: total,
        primary_window: true, index_pending: total > 600, sessions: [...children, ...runs, ...roots] });
      staged.gates.local[0].resolve({ sessions: [] });
      const result = await execution;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const rows = result.patch.sessions as Array<{ parentResourceId?: string; executionMode?: string }>;
      expect(rows.filter((row) => !row.parentResourceId && !row.executionMode)).toHaveLength(200);
      expect(rows.filter((row) => row.executionMode === "exec")).toHaveLength(100);
      expect(rows.filter((row) => row.parentResourceId)).toHaveLength(300);
      expect(result.patch.rosterIndexPending).toBe(total > 600);
      expect(result.patch.rosterTruncated).toBe(total > 600);
    });
    it("keeps old foreground terminals when the Runner and local primary windows are merged", async () => {
      const staged = stagedRosterService();
      const execution = staged.service.execute("instance", "refresh_sessions", { limit: "1" }, {});
      staged.gates.runner[0].resolve({ devices: ["laptop"], primary_window: true, sessions: [
        { device: "laptop", source: "codex", id: "terminal", last_activity: "2020-01-01T00:00:00Z",
          runtime: { process_state: "alive", attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } } },
      ] });
      staged.gates.local[0].resolve({ sessions: [
        { source: "codex", id: "new-background", last_activity: "2026-09-08T00:00:00Z" },
      ] });
      const result = await execution;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.patch.sessions).toEqual([expect.objectContaining({ sessionId: "terminal" })]);
    });
    it("publishes a runner-first loading patch while the local Gate remains pending", async () => {
      const staged = stagedRosterService();
      const patches: Array<Record<string, any>> = [];
      let finalSettled = false;
      const execution = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "20" },
        {},
        { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
      ).then((result) => {
        finalSettled = true;
        return result;
      });

      expect(staged.gates.runner).toHaveLength(1);
      expect(staged.gates.local).toHaveLength(1);
      staged.gates.runner[0].resolve(runnerRoster("runner-fast"));
      await waitFor(() => patches.length === 1);

      expect(finalSettled).toBe(false);
      expect(patches[0]).toMatchObject({
        resourceState: "loading",
        sessions: [{ sessionId: "runner-fast", deviceId: "laptop" }],
        sources: [{ kind: "runner", device: "laptop", online: true }],
      });

      staged.gates.local[0].resolve(localRoster("local-late"));
      const final = await execution;
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect((final.patch.sessions as Array<Record<string, unknown>>).map((row) => row.sessionId).sort()).toEqual([
        "local-late",
        "runner-fast",
      ]);
      expect(final.patch.resourceState).toBe("ready");
      expect(patches).toHaveLength(1);
      expect(staged.gates.runner).toHaveLength(1);
      expect(staged.gates.local).toHaveLength(1);
      expect(staged.calls).toEqual([
        {
          plane: "runner",
          args: { source: "all", limit: 20, primary_window: true, _octopus_include_session_plus: true },
        },
        { plane: "local", args: { source: "all", limit: 20, primary_window: true } },
      ]);
    });

    it("publishes a local-first loading patch while the runner Gate remains pending", async () => {
      const staged = stagedRosterService();
      const patches: Array<Record<string, any>> = [];
      let finalSettled = false;
      const execution = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "20" },
        {},
        { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
      ).then((result) => {
        finalSettled = true;
        return result;
      });

      staged.gates.local[0].resolve(localRoster("local-fast"));
      await waitFor(() => patches.length === 1);

      expect(finalSettled).toBe(false);
      expect(patches[0]).toMatchObject({
        resourceState: "loading",
        sessions: [{ sessionId: "local-fast", deviceId: "bot-host" }],
        sources: [{ kind: "local", device: "bot-host" }],
      });

      staged.gates.runner[0].resolve(runnerRoster("runner-late"));
      const final = await execution;
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect((final.patch.sessions as Array<Record<string, unknown>>).map((row) => row.sessionId).sort()).toEqual([
        "local-fast",
        "runner-late",
      ]);
      expect(final.patch.resourceState).toBe("ready");
      expect(patches).toHaveLength(1);
    });

    it("applies stable activity before the merged roster limit", async () => {
      const staged = stagedRosterService();
      const execution = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "1" },
        {},
      );
      staged.gates.runner[0].resolve({
        devices: ["laptop"],
        sessions: [
          {
            device: "laptop",
            source: "omp",
            id: "noisy",
            last_activity: "2026-08-25T10:30:00Z",
            sort_activity: "2026-08-25T10:00:00Z",
          },
          {
            device: "laptop",
            source: "codex",
            id: "stable-recent",
            last_activity: "2026-08-25T10:20:00Z",
            sort_activity: "2026-08-25T10:10:00Z",
          },
        ],
      });
      staged.gates.local[0].resolve({ sessions: [] });

      const final = await execution;
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect(final.patch.sessions).toMatchObject([
        { sessionId: "stable-recent", sortActivity: "2026-08-25T10:10:00Z" },
      ]);
    });

    it.each(["failure", "empty"] as const)(
      "does not let a first %s completion suppress the later non-empty plane",
      async (first) => {
        const staged = stagedRosterService();
        const patches: Array<Record<string, any>> = [];
        const execution = staged.service.execute(
          "instance",
          "refresh_sessions",
          { limit: "20" },
          {},
          { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
        );

        if (first === "failure") staged.gates.runner[0].reject(new Error("runner unavailable"));
        else staged.gates.runner[0].resolve({ devices: ["laptop"], sessions: [] });
        await flushMicrotasks();
        expect(patches).toHaveLength(0);

        staged.gates.local[0].resolve(localRoster("local-visible"));
        const final = await execution;
        expect(final.ok).toBe(true);
        expect(patches).toHaveLength(1);
        expect(patches[0]).toMatchObject({
          resourceState: "loading",
          sessions: [{ sessionId: "local-visible", deviceId: "bot-host" }],
        });
      },
    );

    it("does not hold the first projection behind the other plane's 60 second timeout", async () => {
      vi.useFakeTimers();
      try {
        const staged = stagedRosterService(60_000);
        const patches: Array<Record<string, any>> = [];
        let finalSettled = false;
        const execution = staged.service.execute(
          "instance",
          "refresh_sessions",
          { limit: "20" },
          {},
          { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
        ).then((result) => {
          finalSettled = true;
          return result;
        });

        staged.gates.runner[0].resolve(runnerRoster("visible-before-timeout"));
        await flushMicrotasks();
        expect(patches).toHaveLength(1);
        expect(patches[0]).toMatchObject({
          resourceState: "loading",
          sessions: [{ sessionId: "visible-before-timeout" }],
        });
        expect(finalSettled).toBe(false);

        await vi.advanceTimersByTimeAsync(59_999);
        expect(finalSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const final = await execution;
        expect(final.ok).toBe(true);
        if (!final.ok) return;
        expect(final.patch).toMatchObject({
          resourceState: "ready",
          errors: [{ source: "local", code: "resource_failed" }],
          sessions: [{ sessionId: "visible-before-timeout" }],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops superseded A writes so a failed C reuses only B's last success", async () => {
      const staged = stagedRosterService();
      let generation = 1;
      const aPatches: Array<Record<string, any>> = [];
      const a = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "20" },
        {},
        { isCurrent: () => generation === 1, onPatch: (patch) => aPatches.push(patch) },
      );

      generation = 2;
      const b = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "20" },
        {},
        { isCurrent: () => generation === 2 },
      );
      staged.gates.runner[1].resolve(runnerRoster("B-runner"));
      staged.gates.local[1].resolve(localRoster("B-local"));
      const bFinal = await b;
      expect(bFinal.ok).toBe(true);

      // A finishes after B became authoritative. Neither its callback nor its
      // successful rows may overwrite the shared last-success memory.
      staged.gates.runner[0].resolve(runnerRoster("A-runner"));
      staged.gates.local[0].resolve(localRoster("A-local"));
      await a;
      expect(aPatches).toHaveLength(0);

      generation = 3;
      const c = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "20" },
        {},
        { isCurrent: () => generation === 3 },
      );
      staged.gates.runner[2].reject(new Error("runner offline"));
      staged.gates.local[2].reject(new Error("local offline"));
      const cFinal = await c;
      expect(cFinal.ok).toBe(true);
      if (!cFinal.ok) return;
      const rows = cFinal.patch.sessions as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.sessionId).sort()).toEqual(["B-local", "B-runner"]);
      expect(rows.every((row) => row.stale === true)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("A-");
      expect(staged.gates.runner).toHaveLength(3);
      expect(staged.gates.local).toHaveLength(3);
    });

    it("bounds and de-duplicates device sources in both partial and final projections", async () => {
      const staged = stagedRosterService();
      const patches: Array<Record<string, any>> = [];
      const execution = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "20" },
        {},
        { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
      );
      const devices = ["x".repeat(65), "device-0", "device-0", ...Array.from(
        { length: 80 },
        (_, index) => `device-${index + 1}`,
      )];
      staged.gates.runner[0].resolve({
        devices,
        sessions: devices.map((device, index) => ({ device, source: "claude", id: `s-${index}` })),
      });
      await waitFor(() => patches.length === 1);
      const partialSources = patches[0].sources as Array<Record<string, unknown>>;
      expect(partialSources).toHaveLength(64);
      expect(new Set(partialSources.map((row) => row.device)).size).toBe(partialSources.length);
      expect(partialSources.every((row) => String(row.device).length <= 64)).toBe(true);

      staged.gates.local[0].resolve(localRoster("local"));
      const final = await execution;
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      const finalSources = final.patch.sources as Array<Record<string, unknown>>;
      expect(finalSources).toHaveLength(65);
      expect(new Set(finalSources.map((row) => row.device)).size).toBe(finalSources.length);
      expect(finalSources.every((row) => String(row.device).length <= 64)).toBe(true);
      expect(JSON.stringify(final.patch)).not.toContain("x".repeat(65));
    });
  });

  describe("populated instance re-reads", () => {
    it("skips the head stage entirely once the projection already shows rows", async () => {
      const staged = stagedRosterService();
      const patches: Array<Record<string, any>> = [];
      const execution = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "200" },
        { sessions: [{ resourceId: "res-kept", sessionId: "kept", deviceId: "laptop" }] },
        { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
      );

      // The only Gates opened are already the full-limit reads: a populated
      // tab must never regress through a 20-row loading frame that lacks rows
      // it is currently showing (the roster-shrink absence flicker).
      expect(staged.gates.runner).toHaveLength(1);
      expect(staged.gates.local).toHaveLength(1);
      staged.gates.runner[0].resolve(runnerRoster("runner-full"));
      await flushMicrotasks();
      expect(patches).toHaveLength(0);

      staged.gates.local[0].resolve(localRoster("local-full"));
      const final = await execution;
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect(final.patch.resourceState).toBe("ready");
      expect((final.patch.sessions as Array<Record<string, unknown>>).map((row) => row.sessionId).sort())
        .toEqual(["local-full", "runner-full"]);
      expect(patches).toHaveLength(0);
      expect(staged.calls).toEqual([
        {
          plane: "runner",
          args: { source: "all", limit: 200, primary_window: true, _octopus_include_session_plus: true },
        },
        { plane: "local", args: { source: "all", limit: 200, primary_window: true } },
      ]);
    });

    it("suppresses the single-stage first-plane partial at small limits too", async () => {
      const staged = stagedRosterService();
      const patches: Array<Record<string, any>> = [];
      const execution = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "20" },
        { sessions: [{ resourceId: "res-kept", sessionId: "kept", deviceId: "laptop" }] },
        { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
      );

      staged.gates.runner[0].resolve(runnerRoster("runner-first"));
      await flushMicrotasks();
      expect(patches).toHaveLength(0);

      staged.gates.local[0].resolve(localRoster("local-late"));
      const final = await execution;
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect(patches).toHaveLength(0);
      expect((final.patch.sessions as Array<Record<string, unknown>>).map((row) => row.sessionId).sort())
        .toEqual(["local-late", "runner-first"]);
    });
  });

  describe("single-stage materialized roster reads", () => {
    it("uses one requested-limit read per plane for an empty projection", async () => {
      const staged = stagedRosterService();
      const patches: Array<Record<string, any>> = [];
      const execution = staged.service.execute(
        "instance",
        "refresh_sessions",
        { source: "codex", limit: "200", since_hours: "12" },
        {},
        { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
      );

      expect(staged.gates.runner).toHaveLength(1);
      expect(staged.gates.local).toHaveLength(1);
      staged.gates.runner[0].resolve(runnerRosterMany("full", 200));
      await flushMicrotasks();
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({ resourceState: "loading" });
      staged.gates.local[0].resolve({ sessions: [] });

      const final = await execution;
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect(final.patch.resourceState).toBe("ready");
      expect(final.patch.sessions).toHaveLength(200);
      expect(staged.calls).toEqual([
        {
          plane: "runner",
          args: {
            source: "codex",
            limit: 200,
            since_hours: 12,
            primary_window: true,
            _octopus_include_session_plus: true,
          },
        },
        { plane: "local", args: { source: "codex", limit: 200, since_hours: 12, primary_window: true } },
      ]);
    });

    it("does not let a superseded result overwrite durable roster memory", async () => {
      const staged = stagedRosterService();
      const baseline = staged.service.execute("instance", "refresh_sessions", { limit: "20" }, {});
      staged.gates.runner[0].resolve(runnerRoster("B-runner"));
      staged.gates.local[0].resolve(localRoster("B-local"));
      expect((await baseline).ok).toBe(true);

      let generation = 1;
      const stale = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "200" },
        {},
        { isCurrent: () => generation === 1 },
      );
      generation = 2;
      staged.gates.runner[1].resolve(runnerRoster("A-runner"));
      staged.gates.local[1].resolve(localRoster("A-local"));
      await stale;

      const failedCurrent = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "20" },
        {},
        { isCurrent: () => generation === 2 },
      );
      staged.gates.runner[2].reject(new Error("runner offline"));
      staged.gates.local[2].reject(new Error("local offline"));
      const final = await failedCurrent;
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      const rows = final.patch.sessions as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.sessionId).sort()).toEqual(["B-local", "B-runner"]);
      expect(rows.every((row) => row.stale === true)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("A-");
    });

    it("clears an older live roster when authority is gone", async () => {
      const staged = stagedRosterService();
      const baseline = staged.service.execute("instance", "refresh_sessions", { limit: "20" }, {});
      staged.gates.runner[0].resolve(runnerRoster("old-runner"));
      staged.gates.local[0].resolve(localRoster("old-local"));
      expect((await baseline).ok).toBe(true);

      staged.authorized.runner = false;
      staged.authorized.local = false;
      const patches: Array<Record<string, any>> = [];
      const revoked = await staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "200" },
        {},
        { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
      );

      expect(revoked).toMatchObject({ ok: false, code: "no_authority" });
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({ resourceState: "empty", sessions: [], sources: [] });
      expect(JSON.stringify(patches[0])).not.toContain("old-");
      expect(staged.gates.runner).toHaveLength(1);
      expect(staged.gates.local).toHaveLength(1);

      staged.authorized.runner = true;
      staged.authorized.local = true;
      const failedAfterRevoke = staged.service.execute("instance", "refresh_sessions", { limit: "20" }, {});
      staged.gates.runner[1].reject(new Error("runner offline"));
      staged.gates.local[1].reject(new Error("local offline"));
      const afterRevoke = await failedAfterRevoke;
      expect(afterRevoke.ok).toBe(true);
      if (afterRevoke.ok) expect(afterRevoke.patch.sessions).toEqual([]);
    });

    it("terminates a pending refresh without projecting approval details", async () => {
      const staged = stagedRosterService();
      const baseline = staged.service.execute("instance", "refresh_sessions", { limit: "20" }, {});
      staged.gates.runner[0].resolve(runnerRoster("remembered-runner"));
      staged.gates.local[0].resolve(localRoster("remembered-local"));
      expect((await baseline).ok).toBe(true);

      const patches: Array<Record<string, any>> = [];
      const execution = staged.service.execute(
        "instance",
        "refresh_sessions",
        { limit: "200" },
        {},
        { isCurrent: () => true, onPatch: (patch) => patches.push(patch) },
      );
      staged.gates.runner[1].resolve({ status: "approval_required", pendingCallId: "runner-secret" });
      staged.gates.local[1].resolve({ status: "approval_required", pendingCallId: "local-secret" });

      const final = await execution;
      expect(final).toMatchObject({ ok: false, code: "approval_required" });
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({ resourceState: "empty", sessions: [], sources: [] });
      expect(JSON.stringify(patches[0])).not.toContain("secret");
    });
  });

  it("pages a complete search through the projection, one asked-for page at a time", async () => {
    const first = await resources.execute("alice-instance", "search_sessions", { query: "paged", source: "all", limit: "10" }, {});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.patch.search).toMatchObject({
      query: "paged",
      cursor: "",
      complete: false,
      nextCursor: JSON.stringify([500, "claude:s1"]),
      results: [{ snippet: "newer paged hit" }],
    });
    expect(frames.at(-1)?.args).not.toHaveProperty("cursor");
    const nextCursor = (first.patch.search as { nextCursor: string }).nextCursor;
    const second = await resources.execute("alice-instance", "search_sessions", { query: "paged", cursor: nextCursor }, {});
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(frames.at(-1)?.args).toMatchObject({ query: "paged", cursor: nextCursor });
    expect(second.patch.search).toMatchObject({ cursor: nextCursor, complete: true, results: [{ snippet: "older paged hit" }] });
    expect(second.patch.search).not.toHaveProperty("nextCursor");

    const count = frames.length;
    expect(await resources.execute("alice-instance", "search_sessions", { query: "paged", cursor: "garbage" }, {}))
      .toMatchObject({ ok: false, code: "invalid_resource" });
    expect(frames).toHaveLength(count);
  });

  it("drops arbitrary search-result fields instead of reflecting a Runner object graph", async () => {
    const searched = await resources.execute(
      "alice-instance",
      "search_sessions",
      { query: "hello", source: "all", limit: "10" },
      {},
    );
    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    const hit = (searched.result as any).results[0];
    expect(Object.keys(hit).sort()).toEqual(["session", "snippet"]);
    expect(hit).not.toHaveProperty("approved");
    expect(hit).not.toHaveProperty("path");
    expect(hit.session).not.toHaveProperty("owner");
  });

  it("reports a device that cannot answer as retryable, not as a refusal", async () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s-offline" });
    expect(await resources.execute("alice-instance", "open_session", { resource: rid, limit: "200" }, {}))
      .toMatchObject({ ok: false, code: "resource_failed" });
  });

  it("prepends an explicitly requested older page without replacing the recent tail", async () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s1" });
    const recent = Array.from({ length: 200 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `recent-${400 + index}`,
    }));
    const result = await resources.execute(
      "alice-instance",
      "open_session",
      { resource: rid, limit: "200", offset: "200" },
      { transcript: { [rid]: { offset: 400, totalMessages: 600, messages: recent } } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `before` keeps the page's end at the shown window when a Runner stops it at its byte budget.
    expect(frames.at(-1)?.args).toMatchObject({ offset: 200, before: 400, max_messages: 200 });
    const transcript = (result.patch as any).transcript[rid];
    expect(transcript).toMatchObject({ offset: 200, totalMessages: 600, hasMore: true });
    expect(transcript.messages).toHaveLength(400);
    expect(transcript.messages[0].content).toBe("message-200");
    expect(transcript.messages.at(-1).content).toBe("recent-599");
  });

  it("reads one complete block window through the session's read authority without touching the projection", async () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s1" });
    const manifest = loadSessionPlusManifest();
    const normalized = normalizeSessionPlusAction(manifest, "open_session", {
      resource: rid, offset: "5", block: "1", field: "output", char_offset: "0",
    });
    if (!normalized.ok) throw new Error(normalized.message);
    const read = await resources.execute("alice-instance", normalized.action, normalized.params, {});
    expect(read).toEqual({
      ok: true,
      result: { offset: 5, block: 1, field: "output", text: "complete-output", charOffset: 0, totalChars: 30, nextCharOffset: 15 },
      patch: {},
    });
    expect(frames.at(-1)).toMatchObject({
      operation: "read_session",
      args: { id: "s1", source: "claude", device: "laptop", rich: true, offset: 5, block: 1, field: "output", char_offset: 0 },
    });
    expect(await resources.execute("alice-instance", "open_session", { resource: rid, offset: "5", block: "9", field: "output" }, {}))
      .toMatchObject({ ok: false, code: "resource_failed", message: expect.stringContaining("尚不支持读取完整内容") });
    const count = frames.length;
    expect(await resources.execute("alice-instance", "open_session", { resource: rid, block: "1" }, {}))
      .toMatchObject({ ok: false, code: "invalid_resource" });
    expect(frames).toHaveLength(count);
  });

  it("projects only public workspace fields and binds the selected device", async () => {
    const listed = await resources.execute(
      "alice-instance",
      "refresh_workspaces",
      { device: "laptop" },
      {},
    );
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.result).toEqual({
      device: "laptop",
      workspaces: [{
        id: "ws_0123456789abcdef01234567",
        label: "Octopus",
        display: "~/lht/octopus",
      }],
    });
    expect(JSON.stringify(listed.result)).not.toContain("/canonical/secret/worktree");
    expect(JSON.stringify(listed.result)).not.toContain("approved");
    expect(listed.patch).toMatchObject({
      workspacesByDevice: { laptop: { device: "laptop", workspaces: [{ label: "Octopus" }] } },
    });
    expect(frames.at(-1)).toMatchObject({
      owner: "alice",
      operation: "list_session_workspaces",
      args: { device: "laptop" },
    });
  });

  describe("workspace-access standing rows", () => {
    const ROWS = [{ operation: "list_workspace_entries", title: "列目录", effective: true, autoAllow: true, alwaysApprove: false, explanation: "已授权，当前有效。" }];

    it("attaches the composition's rows to the roster and workspaces patches, per owner", async () => {
      const owners: string[] = [];
      const withAccess = new SessionResourceService(bundles, permissions, 2_000, 10, null, (owner) => {
        owners.push(owner);
        return ROWS as never;
      });
      const roster = await withAccess.execute("alice-instance", "refresh_sessions", { source: "all", limit: "20" }, {});
      expect(roster.ok).toBe(true);
      if (roster.ok) expect((roster.patch as any).workspaceAccess).toEqual(ROWS);
      const workspaces = await withAccess.execute("alice-instance", "refresh_workspaces", { device: "laptop" }, {});
      expect(workspaces.ok).toBe(true);
      if (workspaces.ok) {
        expect((workspaces.patch as any).workspaceAccess).toEqual(ROWS);
        // The RESULT stays the workspace list itself; standing is patch-only.
        expect(workspaces.result).not.toHaveProperty("workspaceAccess");
      }
      expect(owners.every((owner) => owner === "alice")).toBe(true);
    });

    it("omits the field entirely without a projector, and when the projector fails", async () => {
      const plain = await resources.execute("alice-instance", "refresh_workspaces", { device: "laptop" }, {});
      expect(plain.ok).toBe(true);
      if (plain.ok) expect(plain.patch).not.toHaveProperty("workspaceAccess");
      const broken = new SessionResourceService(bundles, permissions, 2_000, 10, null, () => {
        throw new Error("no projection today");
      });
      const patched = await broken.execute("alice-instance", "refresh_workspaces", { device: "laptop" }, {});
      expect(patched.ok).toBe(true);
      // Absent, not fabricated: a consumer reads absence as "unknown".
      if (patched.ok) expect(patched.patch).not.toHaveProperty("workspaceAccess");
    });
  });

  it("rejects a resource belonging to another owner before sending any transport frame", async () => {
    frames.length = 0;
    const aliceResource = resourceId({
      owner: "alice",
      device: "laptop",
      cliKind: "claude",
      sessionId: "s1",
    });
    const result = await resources.execute(
      "bob-instance",
      "open_session",
      { resource: aliceResource, limit: "30" },
      {},
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_resource" });
    expect(frames).toHaveLength(0);
  });

  it("does not inherit the Session Hub direct-browser auto-allow exception", async () => {
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      operations: ["read_session"],
      autoAllow: [],
      source: "config",
      createdBy: "system:config",
      contractDigest: sessionPlusPermissionContractDigest(),
      publisher: SESSION_PLUS_PUBLISHER,
    });
    bundles.destroy("alice-instance");
    bundles.open("alice", "alice-instance-closed", "package");
    frames.length = 0;
    const result = await resources.execute(
      "alice-instance-closed",
      "open_session",
      {
        resource: resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s1" }),
        limit: "30",
      },
      {},
    );
    expect(result).toMatchObject({ ok: false, code: "approval_required" });
    expect(frames).toHaveLength(0);
    const pending = runner.listPending("alice");
    expect(pending).toHaveLength(1);
    expect(pending[0].requestedBy).toMatchObject({
      owner: "alice",
      app: SESSION_PLUS_APP_ID,
      action: "open_session",
    });
    // This is an App ControllerRun, not the Session Hub's direct-browser
    // exception. The trusted Context metadata makes that distinction auditable.
    expect(pending[0].requestedBy).not.toHaveProperty("surface");
  });

  it("requires one trusted terminal opening and silently reuses only its instance lease", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_alice_desktop"), "alice", "desktop", new Date(NOW).toISOString());
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      operations: [...SESSION_PLUS_TERMINAL_OPERATIONS],
      autoAllow: [...SESSION_PLUS_TERMINAL_PERMISSION_CONTRACT.autoAllow],
      source: "config",
      createdBy: "system:config",
      contractDigest: sessionPlusPermissionContractDigest(
        SESSION_PLUS_PUBLISHER,
        SESSION_PLUS_TERMINAL_PERMISSION_CONTRACT,
      ),
      publisher: SESSION_PLUS_PUBLISHER,
    });
    bundles.destroy("alice-instance");
    bundles.open("alice", "alice-terminal-instance", "package");
    frames.length = 0;
    const current = {
      workspacesByDevice: {
        desktop: {
          device: "desktop",
          workspaces: [{ id: "ws_0123456789abcdef01234567", label: "Desktop" }],
        },
        laptop: {
          device: "laptop",
          workspaces: [{ id: "ws_0123456789abcdef01234567", label: "Octopus" }],
        },
      },
    };

    const first = await resources.execute(
      "alice-terminal-instance",
      "open_terminal",
      { device: "laptop", workspace_id: "ws_0123456789abcdef01234567" },
      current,
    );
    expect(first).toMatchObject({ ok: false, code: "approval_required" });
    expect(frames).toHaveLength(0);
    const pending = runner.listPending("alice");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operation: "open_workspace_terminal" });

    await expect(runner.approve(pending[0].id, "alice")).resolves.toMatchObject({ status: "succeeded" });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      owner: "alice",
      operation: "workspace_terminal",
      args: { action: "open", device: "laptop", workspace_id: "ws_0123456789abcdef01234567" },
    });
    const leaseId = String(frames[0].args.lease_id);
    expect(leaseId).toMatch(/^lease_[0-9a-f]{48}$/);

    const attached = await resources.execute(
      "alice-terminal-instance",
      "open_terminal",
      { device: "laptop", workspace_id: "ws_0123456789abcdef01234567" },
      current,
    );
    expect(attached).toMatchObject({
      ok: true,
      result: { terminal_id: `term_${"a".repeat(48)}`, closed: false },
    });
    expect(frames[1]).toMatchObject({
      operation: "workspace_terminal",
      args: { action: "claim", lease_id: leaseId },
    });

    const sent = await resources.execute(
      "alice-terminal-instance",
      "send_terminal",
      { device: "laptop", terminal_id: `term_${"a".repeat(48)}`, input: "printf terminal-ok" },
      current,
    );
    expect(sent).toMatchObject({ ok: true });
    expect(frames[2]).toMatchObject({
      operation: "workspace_terminal",
      args: { action: "input", lease_id: leaseId, input: "printf terminal-ok" },
    });
    expect(runner.listPending("alice")).toHaveLength(0);

    // A second tab must not overwrite the first tab's approved lease.
    const second = await resources.execute("alice-terminal-instance", "open_terminal",
      { device: "desktop", workspace_id: "ws_0123456789abcdef01234567" }, current);
    expect(second).toMatchObject({ ok: false, code: "approval_required" });
    const secondPending = runner.listPending("alice");
    expect(secondPending).toHaveLength(1);
    await expect(runner.approve(secondPending[0].id, "alice")).resolves.toMatchObject({ status: "succeeded" });
    const desktopLease = String(frames.at(-1)!.args.lease_id);
    expect(desktopLease).not.toBe(leaseId);
    await expect(resources.execute("alice-terminal-instance", "read_terminal",
      { device: "laptop", terminal_id: `term_${"a".repeat(48)}` }, current)).resolves.toMatchObject({ ok: true });
    expect(frames.at(-1)!.args.lease_id).toBe(leaseId);
    await expect(resources.execute("alice-terminal-instance", "close_terminal",
      { device: "laptop", terminal_id: `term_${"a".repeat(48)}` }, current)).resolves.toMatchObject({ ok: true });
    await expect(resources.execute("alice-terminal-instance", "send_terminal",
      { device: "desktop", terminal_id: `term_${"a".repeat(48)}`, input: "echo second" }, current)).resolves.toMatchObject({ ok: true });
    expect(frames.at(-1)!.args.lease_id).toBe(desktopLease);
    await expect(resources.execute("alice-terminal-instance", "read_terminal",
      { device: "laptop", terminal_id: `term_${"a".repeat(48)}` }, current)).resolves.toMatchObject({ ok: false, code: "invalid_resource" });
  });

  it("refuses known unavailable terminals before requesting approval", async () => {
    const result = await resources.execute("alice-instance", "open_terminal",
      { device: "laptop", workspace_id: "ws_0123456789abcdef01234567" }, {
        workspacesByDevice: { laptop: { device: "laptop",
          workspaces: [{ id: "ws_0123456789abcdef01234567", label: "Octopus" }],
          terminal: { available: false, reason: "设备未安装 tmux" },
        } },
      });
    expect(result).toMatchObject({ ok: false, code: "resource_failed", message: "设备未安装 tmux" });
    expect(runner.listPending("alice")).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it("holds a ControllerRun for live follow and reports revocation instead of looking alive", async () => {
    const rid = resourceId({ owner: "alice", device: "laptop", cliKind: "claude", sessionId: "s1" });
    const events: Array<{ type: string; terminal?: boolean; data?: unknown }> = [];
    const watched = resources.watchTranscript("alice-instance", rid, (event) => events.push(event));
    expect(watched.ok).toBe(true);
    if (!watched.ok) return;

    await waitFor(() => events.some((event) => event.type === "data"));
    expect(frames.find((frame) => frame.operation === "read_session")?.args.max_messages).toBe(200);
    expect((events.find((event) => event.type === "data")?.data as any)?.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
    const beforeRevoke = frames.length;
    expect(bundles.destroy("alice-instance")).toBe(true);
    await waitFor(() => events.some((event) => event.type === "error" && event.terminal === true));
    const afterRevoke = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(afterRevoke).toBe(beforeRevoke);
    expect(frames).toHaveLength(afterRevoke);
    watched.subscription.close();
  });

  /**
   * The wiring, as opposed to the derivation.
   *
   * `workspace-files/directory-index.test.ts` proves that one normalized device
   * reply has one bounded association meaning. What is left to check here is
   * that the service actually carries it: that a roster with no workspace
   * refresh behind it has no keys,
   * that a workspace refresh keys the rows already on screen, and that a later
   * roster still has them — the sequence a real view performs.
   */
  describe("with a directory-key minter", () => {
    let keyed: SessionResourceService;

    beforeEach(() => {
      keyed = new SessionResourceService(bundles, permissions, 2_000, 10, new WorkspaceDirectoryKeys());
    });

    it("has no key before the device has been asked where anything is", async () => {
      const listed = await keyed.execute("alice-instance", "refresh_sessions", { limit: "20" }, {});
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const sessions = (listed.patch as Record<string, any>).sessions;
      expect(sessions[0]).not.toHaveProperty("directoryKey");
    });

    it("archives a split session under its execution workspace while reads keep the runtime identity", async () => {
      const workspaceId = "ws_0123456789abcdef01234567";
      const catalog = [{
        runtimeOwner: "alice",
        runtimeDevice: "runtime-a",
        source: "codex" as const,
        sessionId: "split-session",
        catalogId: `spc_${"a".repeat(64)}`,
        executionDevice: "exec-b",
        workspaceId,
        workspaceLabel: "Octopus",
        workspaceDisplay: "~/lht/octopus",
      }];
      const runnerRoster = mergeSessionCatalogList(
        { devices: ["runtime-a"], total_found: 0, sessions: [] },
        [{
          device: "runtime-a",
          catalog,
          result: {
            total_found: 1,
            sessions: [{
              id: "split-session",
              source: "codex",
              cwd_display: "~/.octopus/codex-split-home",
              last_activity: "2026-09-01T08:00:00.000Z",
            }],
          },
        }],
        { limit: 20 },
      );
      const calls: Array<{ plane: string; operation: string; args: Record<string, unknown> }> = [];
      const fakeBundles = {
      profile: { app: "session-plus", publisher: "octopus:first-party", operations: [], autoAllow: [] },
        get: (instanceId: string) => instanceId === "split-instance" ? { owner: "alice" } : null,
        openController: (_instanceId: string, plane: "runner" | "local") => ({
          caps: {
            request: async (_slot: string, operation: string, args: Record<string, unknown>) => {
              calls.push({ plane, operation, args });
              if (operation === "list_recent_sessions") {
                return { status: "succeeded", result: plane === "runner" ? runnerRoster : { sessions: [] } };
              }
              if (operation === "list_session_workspaces") {
                return {
                  status: "succeeded",
                  result: {
                    workspaces: [
                      { id: workspaceId, label: "Octopus", display: "~/lht/octopus" },
                      {
                        id: "ws_abcdef0123456789abcdef01",
                        label: "Copied transcript",
                        display: "~/copies/transcript",
                      },
                    ],
                    // A same-id transcript on the execution device is not
                    // allowed to replace the Host catalog's workspace join.
                    session_directories: [{
                      source: "codex",
                      id: "split-session",
                      workspace_id: "ws_abcdef0123456789abcdef01",
                      relative_path: "",
                    }],
                  },
                };
              }
              throw new Error(`unexpected operation ${operation}`);
            },
          },
          close() {},
        }),
      } as unknown as AppAuthorityBundles;
      const splitService = new SessionResourceService(
        fakeBundles,
        { audit() {} } as unknown as PermissionService,
        2_000,
        10,
        new WorkspaceDirectoryKeys(Buffer.alloc(32, 7)),
      );

      const listed = await splitService.execute("split-instance", "refresh_sessions", { limit: "20" }, {});
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const session = (listed.patch as Record<string, any>).sessions[0];
      expect(session).toMatchObject({
        deviceId: "runtime-a",
        directoryDeviceId: "exec-b",
        projectLabel: "Octopus",
        cwdDisplay: "~/lht/octopus",
      });
      expect(isWorkspaceDirectoryKey(session.directoryKey)).toBe(true);
      expect(decodeResourceId(session.resourceId)).toMatchObject({ device: "runtime-a", sessionId: "split-session" });

      const refreshed = await splitService.execute(
        "split-instance",
        "refresh_workspaces",
        { device: "exec-b" },
        listed.patch as Record<string, any>,
      );
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) return;
      const patch = refreshed.patch as Record<string, any>;
      expect(patch.workspaces.device).toBe("exec-b");
      expect(patch.workspaces.workspaces[0].directoryKey).toBe(session.directoryKey);
      // The catalog already minted the exact workspace-root key, so refreshing
      // that registry must not churn the session row.
      expect(patch).not.toHaveProperty("sessions");

      // Device names are scoped by account. A shared runtime may therefore
      // have the same device label as the owner's execution Runner; the
      // explicit catalog coordinate, rather than string inequality, keeps the
      // durable key in that case too.
      const sameNamedRuntime = {
        sessions: [{
          ...session,
          resourceId: resourceId({
            owner: "alice",
            device: "exec-b",
            cliKind: "codex",
            sessionId: "split-session",
          }),
          deviceId: "exec-b",
          directoryDeviceId: "exec-b",
        }],
      };
      const sameNamedRefresh = await splitService.execute(
        "split-instance",
        "refresh_workspaces",
        { device: "exec-b" },
        sameNamedRuntime,
      );
      expect(sameNamedRefresh.ok).toBe(true);
      if (!sameNamedRefresh.ok) return;
      expect(sameNamedRefresh.patch).not.toHaveProperty("sessions");

      const legacyDisplayRefresh = await splitService.execute(
        "split-instance",
        "refresh_workspaces",
        { device: "exec-b" },
        {
          sessions: [{
            ...session,
            projectLabel: "codex-split-home",
            cwdDisplay: "~/.octopus/codex-split-home",
          }],
        },
      );
      expect(legacyDisplayRefresh.ok).toBe(true);
      if (!legacyDisplayRefresh.ok) return;
      expect((legacyDisplayRefresh.patch as Record<string, any>).sessions[0]).toMatchObject({
        directoryKey: session.directoryKey,
        projectLabel: "Octopus",
        cwdDisplay: "~/lht/octopus",
      });
      expect(calls).toContainEqual({
        plane: "runner",
        operation: "list_recent_sessions",
        args: { source: "all", limit: 20, primary_window: true, _octopus_include_session_plus: true },
      });
    });

    it("keys the workspace rows and the sessions already on screen, then keeps them", async () => {
      const listed = await keyed.execute("alice-instance", "refresh_sessions", { limit: "20" }, {});
      if (!listed.ok) return;

      const refreshed = await keyed.execute(
        "alice-instance",
        "refresh_workspaces",
        { device: "laptop" },
        listed.patch as Record<string, any>,
      );
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) return;
      const patch = refreshed.patch as Record<string, any>;
      const workspaceRow = patch.workspaces.workspaces[0];
      expect(isWorkspaceDirectoryKey(workspaceRow.directoryKey)).toBe(true);

      // The session is in `packages/bot` INSIDE that workspace, so its key is a
      // different directory's — not the root's.
      const patchedSession = patch.sessions[0];
      expect(isWorkspaceDirectoryKey(patchedSession.directoryKey)).toBe(true);
      expect(patchedSession.directoryKey).not.toBe(workspaceRow.directoryKey);

      // A later roster refresh still carries it: the association was remembered,
      // not recomputed from something the roster happens to contain.
      const again = await keyed.execute("alice-instance", "refresh_sessions", { limit: "20" }, patch);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect((again.patch as Record<string, any>).sessions[0].directoryKey).toBe(patchedSession.directoryKey);
    });

    it("rekeys the latest roster without reviving an older workspace read's session fields", async () => {
      const listed = await keyed.execute("alice-instance", "refresh_sessions", { limit: "20" }, {});
      if (!listed.ok) throw new Error("roster refused");
      const located = await keyed.execute("alice-instance", "refresh_workspaces", { device: "laptop" }, listed.patch);
      if (!located.ok) throw new Error("workspace refused");
      const oldSessions = (listed.patch as any).sessions;
      const current = { sessions: [{ ...oldSessions[0], messageCount: 999, preview: "newer roster" }] };
      const reconciled = keyed.reconcileWorkspacePatch("alice-instance", current, located.patch) as any;
      expect(reconciled.sessions).toHaveLength(1);
      expect(reconciled.sessions[0]).toMatchObject({ messageCount: 999, preview: "newer roster", directoryKey: expect.any(String) });
      // Once the newest roster already has correct keys there is no sessions
      // patch at all, rather than falling back to the stale input's full rows.
      expect(keyed.reconcileWorkspacePatch("alice-instance", { sessions: reconciled.sessions }, located.patch))
        .not.toHaveProperty("sessions");
    });

    it("removes an old key when a successful whole-device answer removes its association", async () => {
      const listed = await keyed.execute("alice-instance", "refresh_sessions", { limit: "20" }, {});
      if (!listed.ok) throw new Error("roster refused");
      const located = await keyed.execute(
        "alice-instance",
        "refresh_workspaces",
        { device: "laptop" },
        listed.patch as Record<string, any>,
      );
      if (!located.ok) throw new Error("workspaces refused");
      const current = located.patch as Record<string, any>;
      expect(current.sessions[0].directoryKey).toBeTruthy();

      workspaceReply = { ...workspaceReply, session_directories: [] };
      const replaced = await keyed.execute(
        "alice-instance",
        "refresh_workspaces",
        { device: "laptop" },
        current,
      );
      expect(replaced.ok).toBe(true);
      if (!replaced.ok) return;
      expect((replaced.patch as Record<string, any>).sessions[0]).not.toHaveProperty("directoryKey");
    });

    it("keeps the last key when a device refresh fails instead of inventing deletion", async () => {
      const listed = await keyed.execute("alice-instance", "refresh_sessions", { limit: "20" }, {});
      if (!listed.ok) throw new Error("roster refused");
      const located = await keyed.execute(
        "alice-instance",
        "refresh_workspaces",
        { device: "laptop" },
        listed.patch as Record<string, any>,
      );
      if (!located.ok) throw new Error("workspaces refused");
      const current = located.patch as Record<string, any>;
      const key = current.sessions[0].directoryKey;

      workspaceFailure = new Error("device offline");
      const refused = await keyed.execute(
        "alice-instance",
        "refresh_workspaces",
        { device: "laptop" },
        current,
      );
      expect(refused).toMatchObject({ ok: false });

      // A later roster still reads the last successful snapshot. A refusal is
      // not proof that the association was deleted.
      const again = await keyed.execute("alice-instance", "refresh_sessions", { limit: "20" }, current);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect((again.patch as Record<string, any>).sessions[0].directoryKey).toBe(key);
    });

    it("does not leak the association itself across the boundary", async () => {
      const listed = await keyed.execute("alice-instance", "refresh_sessions", { limit: "20" }, {});
      if (!listed.ok) return;
      const refreshed = await keyed.execute(
        "alice-instance",
        "refresh_workspaces",
        { device: "laptop" },
        listed.patch as Record<string, any>,
      );
      if (!refreshed.ok) return;
      const wire = JSON.stringify(refreshed.patch);
      expect(wire).not.toContain("session_directories");
      expect(wire).not.toContain("relative_path");
      expect(wire).not.toContain("packages/bot");
      expect(wire).not.toContain("/canonical/secret/worktree");
    });

    it("gives two accounts different keys for the same directory", async () => {
      const keys: string[] = [];
      for (const instance of ["alice-instance", "bob-instance"]) {
        const listed = await keyed.execute(instance, "refresh_sessions", { limit: "20" }, {});
        if (!listed.ok) throw new Error("roster refused");
        const refreshed = await keyed.execute(
          instance,
          "refresh_workspaces",
          { device: "laptop" },
          listed.patch as Record<string, any>,
        );
        if (!refreshed.ok) throw new Error("workspaces refused");
        keys.push((refreshed.patch as Record<string, any>).workspaces.workspaces[0].directoryKey);
      }
      expect(keys[0]).not.toBe(keys[1]);
    });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function stagedRosterService(timeoutMs = 2_000): {
  service: SessionResourceService;
  gates: Record<"runner" | "local", Array<Deferred<unknown>>>;
  calls: Array<{ plane: "runner" | "local"; args: Record<string, unknown> }>;
  authorized: Record<"runner" | "local", boolean>;
} {
  const gates: Record<"runner" | "local", Array<Deferred<unknown>>> = { runner: [], local: [] };
  const calls: Array<{ plane: "runner" | "local"; args: Record<string, unknown> }> = [];
  const authorized = { runner: true, local: true };
  const fakeBundles = {
      profile: { app: "session-plus", publisher: "octopus:first-party", operations: [], autoAllow: [] },
    get: (instanceId: string) => instanceId === "instance" ? { owner: "alice" } : null,
    openController: (_instanceId: string, plane: "runner" | "local") => authorized[plane]
      ? ({
        caps: {
          request: async (_kind: string, _operation: string, args: Record<string, unknown>) => {
            calls.push({ plane, args });
            const gate = deferred<unknown>();
            gates[plane].push(gate);
            const result = await gate.promise;
            if (isTestControllerOutcome(result)) return result;
            return { status: "succeeded", result };
          },
        },
        close() {},
      })
      : null,
  } as unknown as AppAuthorityBundles;
  return {
    service: new SessionResourceService(
      fakeBundles,
      { audit() {} } as unknown as PermissionService,
      timeoutMs,
      10,
      null,
      null,
      () => 0,
    ),
    gates,
    calls,
    authorized,
  };
}

function isTestControllerOutcome(value: unknown): value is {
  status: "approval_required" | "denied";
  pendingCallId?: string;
  reason?: string;
} {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return status === "approval_required" || status === "denied";
}

function runnerRoster(sessionId: string): Record<string, unknown> {
  return {
    devices: ["laptop"],
    sessions: [{
      device: "laptop",
      source: "claude",
      id: sessionId,
      last_activity: "2026-08-13T10:00:00Z",
    }],
  };
}

function runnerRosterMany(prefix: string, count: number): Record<string, unknown> {
  return {
    devices: ["laptop"],
    sessions: Array.from({ length: count }, (_, index) => ({
      device: "laptop",
      source: "codex",
      id: `${prefix}-${index}`,
      last_activity: new Date(Date.UTC(2026, 7, 13, 10, 0, index)).toISOString(),
    })),
  };
}

function localRoster(sessionId: string): Record<string, unknown> {
  return {
    sessions: [{
      source: "codex",
      id: sessionId,
      last_activity: "2026-08-13T09:00:00Z",
    }],
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}


it("projects only valid public account model choices on allowed devices", () => {
  const raw = [{device:"mac", inventory:{schema:"runner-inventory/v1", ticket_options:{codex_accounts:[
    {id:"a",label:"codexa",models:[{value:"local-model",label:"Local",home:"/secret",token:"secret"}]},
    {id:"b",label:"codexb",models:[{value:"bad model",label:"Bad"}]},
  ]}}}];
  const rows = boundedPlacementDevices(raw, new Set(["mac"]));
  expect(rows[0]!.codexAccounts).toEqual([
    {id:"a",label:"codexa",models:[{value:"local-model",label:"Local"}]}, {id:"b",label:"codexb"}]);
  expect(boundedPlacementDevices(raw, new Set())).toEqual([]);
});
