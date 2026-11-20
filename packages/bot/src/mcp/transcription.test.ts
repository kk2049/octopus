import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { MeetingTranscriptionCapabilities } from "../meeting-transcription/capability.js";
import { MEETING_TRANSCRIPTION_MCP_TOOLS } from "../meeting-transcription/contract.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { Store } from "../store/store.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { McpSurface } from "./service.js";
import { MCP_MEETING_TRANSCRIPTION_OPERATION_IDS as operations, MCP_SUBJECT_ID, mcpSubjectEntry } from "./catalog.js";
import { mcpSessionExecutionPolicy, mcpTokenPolicy } from "./tokens.js";
import { handleMcpRpc } from "./http.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const store = new Store(":memory:"), kernel = new CapabilityService();
  store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: "now" });
  const dispatch = vi.fn(async (owner: string, operation: string, args: Record<string, unknown>) => ({ owner, operation, ...args, state: "uploading" }));
  const capabilities = new MeetingTranscriptionCapabilities({ service: kernel, transport: { dispatch } as unknown as RunnerTransport,
    userExists: owner => !!store.getUser(owner), hasDevice: owner => owner === "alice" });
  const permissions = new PermissionService({ store, subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false, transcriptionComposed: () => true })],
    extraAccountOperations: [owner => capabilities.accountOperations(owner)] });
  const surface = new McpSurface({ hub: new SessionHubService({ store, permissions }), permissions, meetingTranscription: { capabilities, device: "compute" },
    sessionExecution: { resolve: () => ({}), close: vi.fn(), releaseCredential: vi.fn(), releaseOwner: vi.fn() } as never });
  cleanups.push(() => { surface.close(); permissions.close(); kernel.close(); store.close(); });
  const principal = { owner: "alice", credential: "mcp:fixture", policy: mcpTokenPolicy({ groups: ["transcription"] }) };
  const grant = (autoAllow: readonly string[] = operations, rights: readonly string[] = operations) => permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID,
    owner: "alice", operations: rights, autoAllow, source: "user", createdBy: "alice" });
  return { surface, principal, dispatch, grant, kernel };
}
const args = { job_key: "a".repeat(64), input_sha256: "b".repeat(64), input_bytes: 100, title: "meeting" };

describe("first-party transcription MCP discovery and authority", () => {
  it("mounts the exact closed descriptors and binds owner/device only after explicit consent", async () => {
    const f = fixture();
    expect(f.surface.listTools(f.principal)).toEqual([]);
    expect(await f.surface.callTool(f.principal, "meeting_transcription_begin", args)).toMatchObject({ ok: false, code: "no_authority" });
    f.grant();
    expect(f.surface.listTools(f.principal)).toEqual(MEETING_TRANSCRIPTION_MCP_TOOLS);
    const listed = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, f.surface, f.principal);
    expect(JSON.stringify(listed.body)).toContain("meeting_transcription_upload");
    for (const extra of [{ owner: "other" }, { device: "other" }, { command: "exit 0" }, { path: "/tmp/x" }]) {
      expect(await f.surface.callTool(f.principal, "meeting_transcription_begin", { ...args, ...extra })).toMatchObject({ ok: false, code: "invalid_params" });
    }
    expect(await f.surface.callTool(f.principal, "meeting_transcription_begin", { ...args, job_key: "invalid" })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.surface.callTool(f.principal, "meeting_transcription_begin", args)).toMatchObject({ ok: true, result: { owner: "alice", device: "compute" } });
    expect(f.dispatch).toHaveBeenCalledWith("alice", "meeting_transcription_begin", { ...args, device: "compute" });
    expect(await f.surface.callTool({ ...f.principal, policy: mcpTokenPolicy({ groups: ["execution"] }) }, "meeting_transcription_begin", args)).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(f.surface.listTools({ ...f.principal, owner: "other" })).toEqual([]);
  });

  it("collects one approved upload intention and retains the same account Gate for managed agent tools", async () => {
    const f = fixture(); f.grant([]);
    expect(await f.surface.callTool(f.principal, "meeting_transcription_begin", args)).toMatchObject({ ok: false, code: "approval_required" });
    expect(await f.surface.callTool(f.principal, "meeting_transcription_begin", args)).toMatchObject({ ok: false, code: "approval_required" });
    expect(f.kernel.listPending("alice")).toHaveLength(1); expect(f.dispatch).not.toHaveBeenCalled();
    expect((await f.kernel.approve(f.kernel.listPending("alice")[0]!.id, "alice")).status).toBe("succeeded");
    expect(await f.surface.callTool(f.principal, "meeting_transcription_begin", args)).toMatchObject({ ok: true });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    f.grant();
    const scoped = { ...f.principal, credential: "managed:fixture", policy: mcpSessionExecutionPolicy({ operationId: "op-test", runtimeDevice: "compute", executionDevice: "compute",
      workspaceId: "ws_" + "a".repeat(24), permissionProfile: "full_access" }, { accountTools: true }) };
    expect(f.surface.listTools(scoped).map(tool => tool.name)).toContain("meeting_transcription_status");
    expect(await f.surface.callTool(scoped, "meeting_transcription_status", { job_key: args.job_key, input_sha256: args.input_sha256 })).toMatchObject({ ok: true });
  });

  it("withholds an awaited response after revocation and removes discovered rights immediately", async () => {
    const f = fixture(); f.grant();
    let resolve!: (value: never) => void;
    f.dispatch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.surface.callTool(f.principal, "meeting_transcription_begin", args);
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1));
    f.grant([], []); resolve({ private_result: "must not escape" } as never);
    expect(await pending).toMatchObject({ ok: false, code: "no_authority" });
    expect(f.surface.listTools(f.principal)).toEqual([]);
    expect(await f.surface.callTool(f.principal, "meeting_transcription_begin", args)).toMatchObject({ ok: false });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
});
