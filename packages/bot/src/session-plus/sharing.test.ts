import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { resourceId } from "../sessionhub/core.js";
import { STALE_SHARE_METER_MS, SessionSharingService } from "./sharing.js";
import type { SessionPlusPrincipal } from "../app-core/instance.js";
import type { WorkspaceFilesScopeGrant } from "../agent-resources/workspace-files-provider.js";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  let now = 1_800_000_000_000;
  const service = new SessionSharingService(store.sessionShares, () => now);
  const resource = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: "chat" });
  const other = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: "private" });
  const projection = { sessions: [{ resourceId: resource, title: "Shared", cliKind: "codex", deviceId: "laptop" }, { resourceId: other, title: "SECRET" }],
    workspacesByDevice: { laptop: { device: "laptop", workspaces: [{ id: "work", label: "Work" }, { id: "private", label: "SECRET" }] } } };
  const issued = service.create("alice", resource, projection, [JSON.stringify(["laptop", "work"])]);
  const secret = issued.link.split("#")[1];
  service.redeem(secret, "bob");
  const principal: SessionPlusPrincipal = { owner: "alice", credential: "bob-credential:share", session: true, delegation: { shareId: issued.id, viewer: "bob" } };
  service.bind("instance", principal);
  return { store, service, resource, other, projection, issued, principal, secret, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("temporary session delegation", () => {
  it("issues bounded defaults, stores only a hash, and requires positive membership", () => {
    const f = fixture(); const row = f.store.sessionShares.get(f.issued.id)!;
    expect(row.tokenLimit).toBe(1_500_000); expect(row.expiresAt - row.createdAt).toBe(86_400_000);
    expect(JSON.stringify(row)).not.toContain(f.secret);
    expect(() => f.service.access(row.id, "mallory")).toThrow();
    expect(() => f.service.create("bob", f.resource, f.projection, [])).toThrow();
    expect(() => f.service.create("alice", f.resource, f.projection, ["forged"])).toThrow();
    expect(() => f.service.create("alice", f.resource, f.projection, [], "100", 24)).toThrow();
  });
  it("filters first/live/durable projections and rejects new chats, siblings, and other resource planes", () => {
    const f = fixture();
    const projected = f.service.project(f.principal, { ...f.projection, pinned: [f.other], customTitles: { [f.other]: "SECRET" },
      transcript: { [f.resource]: { messages: ["permitted"] }, [f.other]: { messages: ["SECRET"] } },
      operations: [{ id: "private", resourceId: f.other, detail: "SECRET" }] } as unknown as RuntimeJson);
    expect(JSON.stringify(projected)).not.toContain("SECRET");
    expect(projected).toMatchObject({ sessions: [{ resourceId: f.resource }], transcript: { [f.resource]: { messages: ["permitted"] } }, sharedAccess: { canPrompt: true } });
    for (const action of ["start_session", "fallback_session", "resource.crdt.list", "pin_session"]) expect(() => f.service.check("instance", action, {})).toThrow();
    expect(() => f.service.check("instance", "append_session", { resource: f.other })).toThrow();
    expect(() => f.service.check("instance", "attach_file", { device: "laptop" })).toThrow();
    expect(() => f.service.check("instance", "attach_file", { resource: f.resource, device: "laptop" })).toThrow();
    expect(() => f.service.check("instance", "attach_file", { resource: f.resource })).not.toThrow();
    expect(() => f.service.check("instance", "open_terminal", { device: "laptop", workspace_id: "private" })).toThrow();
  });
  it("expires existing access, deduplicates renewal events, and only lets the issuer decide", () => {
    const f = fixture(); f.advance(86_400_000);
    expect(() => f.service.check("instance", "open_session", { resource: f.resource })).toThrow(/到期/);
    expect(() => f.service.access(f.issued.id, "bob")).toThrow(/到期/);
    f.service.redeem(f.secret, "bob");
    f.service.request(f.issued.id, "bob", "lease"); f.service.request(f.issued.id, "bob", "lease");
    const requests = f.store.sessionShares.requests("alice"); expect(requests).toHaveLength(1);
    expect(() => f.service.decide("bob", requests[0].id, true)).toThrow();
    f.service.decide("alice", requests[0].id, true, "1", 1);
    expect(f.service.access(f.issued.id, "bob").expiresAt).toBe(f.now() + 3_600_000);
    expect(() => f.service.decide("alice", requests[0].id, true)).toThrow();
    f.service.revoke(f.issued.id, "alice");
    expect(() => f.service.redeem(f.secret, "bob")).toThrow(/撤销/);
  });
  it("charges a native completed turn once even after the browser closes, then denies only new prompts", () => {
    const f = fixture(); f.service.beginPrompt("instance", 100);
    expect(() => f.service.beginPrompt("instance", 100)).toThrow(/仍在执行/);
    f.service.promptSubmitted("instance", "op");
    const completion = { schema: "runner-managed-completion/v1" as const, provider: "codex" as const, session_id: "chat", turn_id: "native-turn", status: "succeeded" as const, completed_at: new Date(f.now() + 1000).toISOString(), usage: { tokens_in: 800_000, tokens_cached: 700_000, tokens_out: 50 } };
    f.service.unbind("instance");
    f.service.spendCompletion("mallory", "laptop", completion);
    expect(f.store.sessionShares.get(f.issued.id)?.tokensUsed).toBe(0);
    f.service.spendCompletion("alice", "laptop", completion); f.service.spendCompletion("alice", "laptop", completion);
    expect(f.store.sessionShares.get(f.issued.id)?.tokensUsed).toBe(1_500_050);
    f.service.bind("instance", f.principal);
    expect(() => f.service.check("instance", "append_session", { resource: f.resource })).toThrow(/预算/);
    expect(() => f.service.check("instance", "open_session", { resource: f.resource })).not.toThrow();
    expect(() => f.service.check("instance", "respond_agent_interaction", { resource: f.resource })).not.toThrow();
    f.service.request(f.issued.id, "bob", "budget"); f.service.decide("alice", f.store.sessionShares.requests("alice")[0].id, true, "0.5");
    expect(() => f.service.check("instance", "append_session", { resource: f.resource })).not.toThrow();
  });
  it("prevents a second link from admitting a parallel prompt, and a failed turn releases the lock (B14)", () => {
    const f = fixture(); const second = f.service.create("alice", f.resource, f.projection, []);
    f.service.redeem(second.link.split("#")[1], "bob");
    f.service.bind("second", { ...f.principal, delegation: { shareId: second.id, viewer: "bob" } });
    expect(() => f.service.beginPrompt("instance", NaN)).toThrow(/用量/);
    f.service.beginPrompt("instance", 100);
    expect(() => f.service.beginPrompt("second", 100)).toThrow(/仍在执行/);
    // A failed turn carries no usage. It used to leave the meter pending for
    // ever, refusing every later shared prompt on this session.
    f.service.spendCompletion("alice", "laptop", { schema: "runner-managed-completion/v1", provider: "codex", session_id: "chat", turn_id: "missing", status: "failed", completed_at: new Date(f.now()).toISOString() });
    expect(f.store.sessionShares.get(f.issued.id)).toMatchObject({ meter: null, tokensUsed: 0 });
    expect(() => f.service.beginPrompt("second", 100)).not.toThrow();
  });

  it("keeps what the transcript already charged when a turn ends without accounting", () => {
    const f = fixture();
    f.service.beginPrompt("instance", 100);
    f.service.project(f.principal, { transcript: { [f.resource]: { usage: { input_tokens: 150, cached_input_tokens: 0, output_tokens: 30 } } } } as unknown as RuntimeJson);
    expect(f.store.sessionShares.get(f.issued.id)?.tokensUsed).toBe(80);
    f.service.spendCompletion("alice", "laptop", { schema: "runner-managed-completion/v1", provider: "codex", session_id: "chat", turn_id: "no-usage", status: "succeeded", completed_at: new Date(f.now()).toISOString() });
    expect(f.store.sessionShares.get(f.issued.id)).toMatchObject({ meter: null, tokensUsed: 80 });
  });

  it("releases a lock whose prompt operation ended without a turn, and only then", () => {
    const f = fixture();
    const statuses = new Map<string, string>([["op-live", "running"], ["op-failed", "failed"]]);
    f.service.attachOperationStatus((owner, id) => owner === "alice" ? statuses.get(id) ?? null : null);
    f.service.beginPrompt("instance", 100);
    f.service.promptSubmitted("instance", "op-live");
    expect(() => f.service.beginPrompt("instance", 100)).toThrow(/仍在执行/);
    statuses.set("op-live", "unknown");
    expect(() => f.service.beginPrompt("instance", 100)).not.toThrow();
    f.service.promptSubmitted("instance", "op-failed");
    expect(() => f.service.beginPrompt("instance", 100)).not.toThrow();
  });

  it("releases a lock no completion settled within the stale bound, or whose share was revoked", () => {
    const f = fixture(); const second = f.service.create("alice", f.resource, f.projection, []);
    f.service.redeem(second.link.split("#")[1], "bob");
    f.service.bind("second", { ...f.principal, delegation: { shareId: second.id, viewer: "bob" } });
    f.service.beginPrompt("instance", 100);
    f.advance(STALE_SHARE_METER_MS - 1);
    expect(() => f.service.beginPrompt("second", 100)).toThrow(/仍在执行/);
    f.advance(1);
    expect(() => f.service.beginPrompt("second", 100)).not.toThrow();
    // The first link's next prompt now waits on the second's lock, until the
    // second share is revoked: a dead share's lock blocks nobody.
    expect(() => f.service.beginPrompt("instance", 100)).toThrow(/仍在执行/);
    f.service.revoke(second.id, "alice");
    expect(() => f.service.beginPrompt("instance", 100)).not.toThrow();
  });

  it("lets the issuer or an administrator reset a stuck lock, and nobody else", () => {
    const f = fixture();
    f.service.beginPrompt("instance", 100);
    expect(f.service.summary(f.store.sessionShares.get(f.issued.id)!).metering).toBe(true);
    expect(() => f.service.resetMeter(f.issued.id, "bob")).toThrow(/签发者/);
    expect(f.store.sessionShares.get(f.issued.id)?.meter).not.toBeNull();
    f.service.resetMeter(f.issued.id, "alice");
    expect(f.store.sessionShares.get(f.issued.id)?.meter).toBeNull();
    f.service.beginPrompt("instance", 100);
    f.service.resetMeter(f.issued.id, "root", true);
    expect(f.store.sessionShares.get(f.issued.id)?.meter).toBeNull();
  });
  it("narrows actual workspace dispatch and refuses every late read after expiry", async () => {
    const f = fixture();
    const call = vi.fn(async () => ({ status: "succeeded" as const, result: { workspaces: [{ id: "work", label: "Work" }, { id: "private", label: "SECRET" }] } }));
    const grant: WorkspaceFilesScopeGrant = { contextId: "owner-context", ownerFiles: true, ownerFilesWritable: true, writable: true, close() {}, authority: { devices: async () => [{ device: "laptop", label: "Laptop" }, { device: "private", label: "Other" }], call } };
    const scoped = f.service.narrowWorkspaceGrant("instance:resource:1", grant)!;
    expect(scoped.ownerFiles).toBe(false);
    expect(scoped.ownerFilesWritable).toBe(false);
    expect(await scoped.authority.devices()).toHaveLength(1);
    expect(await scoped.authority.call("laptop", "list_session_workspaces", {})).toMatchObject({ result: { workspaces: [{ id: "work" }] } });
    call.mockClear();
    expect(await scoped.authority.call("laptop", "read_workspace_text", { workspace_id: "private" })).toEqual({ status: "denied" });
    expect(await scoped.authority.call("laptop", "access_owner_files", {})).toEqual({ status: "denied" });
    expect(await scoped.authority.call("laptop", "replace_owner_text", { workspace_id: "work", absolute_path: "/private.txt" })).toEqual({ status: "denied" });
    expect(call).not.toHaveBeenCalled();
    f.advance(86_400_000);
    await expect(scoped.authority.call("laptop", "read_workspace_text", { workspace_id: "work" })).rejects.toThrow(/到期/);
    expect(call).not.toHaveBeenCalled();
  });
  it("refuses a completed file read when its tab was closed during IO", async () => {
    const f = fixture();
    let finish!: (value: { status: "succeeded"; result: unknown }) => void;
    const grant: WorkspaceFilesScopeGrant = { contextId: "ctx", ownerFiles: true, writable: true, close() {}, authority: { devices: async () => [], call: () => new Promise((resolve) => { finish = resolve; }) } };
    const read = f.service.narrowWorkspaceGrant("instance", grant)!.authority.call("laptop", "read_workspace_text", { workspace_id: "work" });
    f.service.unbind("instance"); finish({ status: "succeeded", result: { text: "late bytes" } });
    await expect(read).rejects.toThrow(/结束/);
  });
  it("persists membership, renewals and turn accounting across a Store reopen, without charging cached input twice", () => {
    const f = fixture();
    const dir = mkdtempSync(join(tmpdir(), "share-ledger-"));
    let disk = new Store(join(dir, "db"));
    try {
      disk.sessionShares.put(f.store.sessionShares.get(f.issued.id)!);
      let service = new SessionSharingService(disk.sessionShares, f.now);
      service.redeem(f.secret, "bob"); service.bind("disk", f.principal);
      service.beginPrompt("disk", 100);
      service.project(f.principal, { transcript: { [f.resource]: { usage: { input_tokens: 170, cached_input_tokens: 60, output_tokens: 30 } } } });
      service.request(f.issued.id, "bob", "budget");
      expect(disk.sessionShares.get(f.issued.id)?.tokensUsed).toBe(100);
      disk.close(); disk = new Store(join(dir, "db"));
      service = new SessionSharingService(disk.sessionShares, f.now);
      expect(service.access(f.issued.id, "bob")).toMatchObject({ tokensUsed: 100, meter: { baseline: 100, observed: 200 } });
      expect(disk.sessionShares.requests("alice")).toHaveLength(1);
      const completion = { schema: "runner-managed-completion/v1" as const, provider: "codex" as const, session_id: "chat", turn_id: "settled", status: "succeeded" as const, completed_at: new Date(f.now()).toISOString(), usage: { tokens_cached: 120, tokens_out: 10 } };
      service.spendCompletion("alice", "laptop", completion); service.spendCompletion("alice", "laptop", completion);
      expect(disk.sessionShares.get(f.issued.id)).toMatchObject({ tokensUsed: 130, meter: null });
    } finally { disk.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
