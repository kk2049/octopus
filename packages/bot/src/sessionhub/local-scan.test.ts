import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityService, type AuditRecord } from "@claude-bot/capability-kernel";
import { SessionAttachmentStore } from "@claude-bot/runner/session-attachments";
import { LocalScanCapabilities, type LocalScanGrant } from "./local-scan.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

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

function openListGrant(local: LocalScanCapabilities, owner: string, at: number): LocalScanGrant {
  const grant = local.open({
    username: owner,
    purpose: `test-roster-${at}`,
    rights: ["list_recent_sessions"],
    autoAllow: ["list_recent_sessions"],
  });
  if (!grant) throw new Error("expected local scan grant");
  return grant;
}

describe("bot-host roster read coordination", () => {
  it.each([1, 33])("writes %i bounded chunks through the real Gate without accepting a device selector", async (chunkCount) => {
    const attachmentRoot = mkdtempSync(join(tmpdir(), "bot-host-attachment-test-"));
    roots.push(attachmentRoot);
    const local = new LocalScanCapabilities({
      service: new CapabilityService(),
      userExists: (owner) => owner === "alice",
      scanHomeFor: () => "/trusted/alice",
      sessionAttachments: new SessionAttachmentStore({ root: attachmentRoot }),
    });
    const grant = local.open({
      username: "alice",
      purpose: "test-local-upload",
      rights: ["upload_session_file"],
      autoAllow: ["upload_session_file"],
    });
    if (!grant) throw new Error("expected local upload grant");

    const args = {
      id: "session-1",
      name: "pasted.png",
      media_type: "image/png",
      chunk_index: 0,
      chunk_count: chunkCount,
      data: Buffer.alloc(256 * 1024, 65).toString("base64"),
    };
    let uploadId: string | undefined;
    let uploaded;
    for (let index = 0; index < chunkCount; index += 1) {
      uploaded = await grant.request("upload_session_file", { ...args, chunk_index: index,
        ...(uploadId ? { upload_id: uploadId } : {}) });
      expect(uploaded.status).toBe("succeeded");
      if (uploaded.status !== "succeeded") throw new Error("expected uploaded chunk");
      uploadId = (uploaded.result as { upload_id: string }).upload_id;
    }
    if (uploaded?.status !== "succeeded") throw new Error("expected completed upload");
    const attachment = (uploaded.result as { attachment: { path: string; bytes: number } }).attachment;
    expect(attachment.bytes).toBe(chunkCount * 256 * 1024);
    const contents = readFileSync(attachment.path);
    expect(contents.length).toBe(attachment.bytes);
    expect(contents.every((byte) => byte === 65)).toBe(true);

    await expect(grant.request("upload_session_file", { ...args, device: "forged-runner" }))
      .resolves.toMatchObject({ status: "denied" });
    grant.close();
  });

  it("keeps primary-window reads and distinct full-history cursors in separate flights", async () => {
    const gate = deferred<unknown>();
    const seen: Record<string, unknown>[] = [];
    const local = new LocalScanCapabilities({ service: new CapabilityService(), userExists: () => true,
      scanHomeFor: () => "/trusted/alice",
      listRecentSessions: async (_home, args) => { seen.push(args); return await gate.promise; },
    });
    const grant = openListGrant(local, "alice", 0);
    const args = [
      { source: "all", limit: 200, primary_window: true },
      { source: "all", limit: 200, cursor: "" },
      { source: "all", limit: 200, cursor: '["codex","session-id"]' },
    ];
    const requests = args.map((arg) => grant.request("list_recent_sessions", arg));
    await vi.waitFor(() => expect(seen).toEqual(args));
    gate.resolve({ sessions: [] });
    expect((await Promise.all(requests)).every((result) => result.status === "succeeded")).toBe(true);
    grant.close();
  });

  it("runs every capability Gate but joins one identical in-flight filesystem read", async () => {
    const audits: AuditRecord[] = [];
    const service = new CapabilityService({ audit: (record) => audits.push(record) });
    const gate = deferred<unknown>();
    let reads = 0;
    const local = new LocalScanCapabilities({
      service,
      userExists: (owner) => owner === "alice",
      scanHomeFor: () => "/trusted/alice",
      listRecentSessions: async () => {
        reads += 1;
        return await gate.promise;
      },
    });
    const grants = Array.from({ length: 18 }, (_, at) => openListGrant(local, "alice", at));
    const requests = grants.map((grant, index) => grant.request("list_recent_sessions", index % 2 === 0
      ? { source: "all", limit: 20 }
      : {}));

    await vi.waitFor(() => expect(reads).toBe(1));
    expect(audits.filter((row) =>
      row.event === "invoked"
      && row.operation === "list_recent_sessions"
      && row.decision === "allow")).toHaveLength(18);

    gate.resolve({ returned: 1, sessions: [{ id: "s1" }] });
    const results = await Promise.all(requests);
    expect(results.every((result) => result.status === "succeeded")).toBe(true);
    expect(reads).toBe(1);
    for (const grant of grants) grant.close();
  });

  it("preserves an OMP-only roster filter instead of widening it to all", async () => {
    const seen: Record<string, unknown>[] = [];
    const local = new LocalScanCapabilities({
      service: new CapabilityService(),
      userExists: () => true,
      scanHomeFor: () => "/trusted/alice",
      listRecentSessions: async (_home, args) => {
        seen.push(args);
        return { sessions: [] };
      },
    });
    const grant = openListGrant(local, "alice", 99);
    await expect(grant.request("list_recent_sessions", { source: "omp", limit: 20 }))
      .resolves.toMatchObject({ status: "succeeded" });
    expect(seen).toEqual([{ source: "omp", limit: 20 }]);
    grant.close();
  });

  it("does not join reads across a trusted home change", async () => {
    const service = new CapabilityService();
    const gates = [deferred<unknown>(), deferred<unknown>()];
    const homes: string[] = [];
    let currentHome = "/trusted/alice-a";
    const local = new LocalScanCapabilities({
      service,
      userExists: (owner) => owner === "alice",
      scanHomeFor: () => currentHome,
      listRecentSessions: async (home) => {
        homes.push(home);
        return await gates[homes.length - 1].promise;
      },
    });
    const grant = openListGrant(local, "alice", 1);
    const first = grant.request("list_recent_sessions", { source: "all", limit: 20 });
    await vi.waitFor(() => expect(homes).toEqual(["/trusted/alice-a"]));

    currentHome = "/trusted/alice-b";
    const second = grant.request("list_recent_sessions", { source: "all", limit: 20 });
    await vi.waitFor(() => expect(homes).toEqual(["/trusted/alice-a", "/trusted/alice-b"]));

    for (const gate of gates) gate.resolve({ sessions: [] });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    grant.close();
  });

  it("isolates args and owners, then clears a failed flight for retry", async () => {
    const service = new CapabilityService();
    const gates = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
    let reads = 0;
    const local = new LocalScanCapabilities({
      service,
      userExists: (owner) => owner === "alice" || owner === "bob",
      scanHomeFor: () => "/trusted/shared",
      listRecentSessions: async () => {
        const gate = gates[reads++];
        return await gate.promise;
      },
    });
    const alice20 = openListGrant(local, "alice", 1);
    const alice21 = openListGrant(local, "alice", 2);
    const bob20 = openListGrant(local, "bob", 3);
    const requests = [
      alice20.request("list_recent_sessions", { source: "all", limit: 20 }),
      alice21.request("list_recent_sessions", { source: "all", limit: 21 }),
      bob20.request("list_recent_sessions", { source: "all", limit: 20 }),
    ];
    await vi.waitFor(() => expect(reads).toBe(3));
    for (const gate of gates) gate.resolve({ sessions: [] });
    expect((await Promise.all(requests)).every((result) => result.status === "succeeded")).toBe(true);

    let attempts = 0;
    const retrying = new LocalScanCapabilities({
      service: new CapabilityService(),
      userExists: () => true,
      scanHomeFor: () => "/trusted/retry",
      listRecentSessions: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient scan failure");
        return { sessions: [] };
      },
    });
    const retryGrant = openListGrant(retrying, "alice", 4);
    await expect(retryGrant.request("list_recent_sessions", { limit: 20 })).resolves.toMatchObject({
      status: "failed",
    });
    await expect(retryGrant.request("list_recent_sessions", { limit: 20 })).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(attempts).toBe(2);

    for (const grant of [alice20, alice21, bob20, retryGrant]) grant.close();
  });
});
