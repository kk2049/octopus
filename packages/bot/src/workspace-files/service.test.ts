/**
 * Provider behaviour against a scripted backend.
 *
 * The vertical harness (`conformance.test.ts`) drives the real Runner, which is
 * where "does this actually read a file" is settled. What is here instead is
 * every state a real device makes awkward to produce on demand: a grant revoked
 * halfway through a stream, a file replaced between two windows, a backend that
 * throws, a scope that ends while somebody is reading.
 */

import { describe, expect, it } from "vitest";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { RESOURCE_STREAM_LIMITS, drainResourceStream } from "@claude-bot/resource-stream-contract";
import { WORKSPACE_FILES_LIMITS, readWorkspaceFilesDirectory } from "@claude-bot/workspace-files-contract";
import { WorkspaceFilesService } from "./service.js";
import { RunnerWorkspaceFilesBackend } from "./runner-backend.js";
import {
  backendRefusal,
  type BackendListing,
  type BackendMutation,
  type BackendBinaryWindow,
  type BackendResult,
  type BackendRoot,
  type BackendTextWindow,
  type WorkspaceBinding,
  type WorkspaceFilesAuthority,
  type WorkspaceFilesBackend,
} from "./types.js";

const BINDING: WorkspaceBinding = {
  device: "laptop-routing-id",
  deviceLabel: "我的笔记本",
  workspaceId: "ws_0123456789abcdef01234567",
  workspaceLabel: "demo",
};

const DIGEST = `sha256:${"a".repeat(64)}`;

interface Script {
  roots?: BackendResult<readonly BackendRoot[]>;
  listing?: BackendResult<BackendListing>;
  windows?: Array<BackendResult<BackendTextWindow>>;
  throwOnRead?: boolean;
}

function scriptedBackend(script: Script): WorkspaceFilesBackend & { reads: number; listings: number } {
  let reads = 0;
  let listings = 0;
  const backend = {
    get reads() {
      return reads;
    },
    get listings() {
      return listings;
    },
    async listRoots(): Promise<BackendResult<readonly BackendRoot[]>> {
      return script.roots ?? { ok: true, value: [{ binding: BINDING }] };
    },
    async listEntries(): Promise<BackendResult<BackendListing>> {
      listings += 1;
      return script.listing ?? { ok: true, value: { entries: [], truncated: false } };
    },
    async readText(): Promise<BackendResult<BackendTextWindow>> {
      const index = reads;
      reads += 1;
      if (script.throwOnRead) throw new Error("boom /tmp/canonical/path");
      const window = script.windows?.[index];
      if (!window) return backendRefusal("unavailable", "脚本用完了");
      return window;
    },
  };
  return backend;
}

function window(over: Partial<BackendTextWindow> = {}): BackendResult<BackendTextWindow> {
  return {
    ok: true,
    value: {
      sizeBytes: 6,
      digest: DIGEST,
      modifiedAt: "2026-08-06T00:00:00.000Z",
      offset: 0,
      bytes: 6,
      eof: true,
      text: "hello\n",
      ...over,
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function openedFileRef(service: WorkspaceFilesService, backend: WorkspaceFilesBackend, scope = "scope-1") {
  const port = service.open({ scope, owner: "alice", backend });
  const roots = await port.refreshRoots();
  if (!roots.ok) throw new Error("roots refused");
  const listing = await port.listDirectory(roots.value.roots[0].ref);
  if (!listing.ok) throw new Error("listing refused");
  const file = listing.value.entries.find((entry) => entry.kind === "file");
  return { port, ref: file?.ref ?? "", listing: listing.value, roots: roots.value };
}

const ONE_FILE: BackendResult<BackendListing> = {
  ok: true,
  value: {
    entries: [
      { name: "a.txt", kind: "file", relativePath: "a.txt", sizeBytes: 6, modifiedAt: "2026-08-06T00:00:00.000Z" },
      { name: "link", kind: "other" },
    ],
    truncated: false,
  },
};

/**
 * Three sets of numbers describe the same reads: the contract's (what a
 * consumer may be handed), the device's (what a Runner will produce), and the
 * stream's (what a chunk may carry). They are separate declarations because
 * they bound different things, and that is exactly why they have to be checked
 * against each other — a contract that promised more than the device produces
 * is a refusal after an approval, and one that promised less silently caps a
 * file nobody said was capped.
 */
describe("one canonical set of size limits", () => {
  it("the contract, the device and the stream agree", () => {
    // No side caps the total: the contract and the device both describe any
    // offset a safe integer can name, and the stream carries any length.
    expect(WORKSPACE_FILES_LIMITS.maxTextBytes).toBe(MACHINE_LIMITS.workspaceFileMaxOffset);
    expect(WORKSPACE_FILES_LIMITS.textChunkBytes).toBe(MACHINE_LIMITS.workspaceTextChunkMaxBytes);
    expect(WORKSPACE_FILES_LIMITS.maxEntries).toBe(MACHINE_LIMITS.workspaceListMaxEntries);
    // A chunk has to fit in a chunk, and a file has to fit in a stream.
    expect(WORKSPACE_FILES_LIMITS.textChunkBytes).toBeLessThanOrEqual(RESOURCE_STREAM_LIMITS.maxChunkBytes);
    expect(WORKSPACE_FILES_LIMITS.maxTextBytes).toBeLessThanOrEqual(RESOURCE_STREAM_LIMITS.maxStreamBytes);
    // ...and the whole file has to be reachable within the stream's chunk count.
    expect(Math.ceil(WORKSPACE_FILES_LIMITS.maxTextBytes / WORKSPACE_FILES_LIMITS.textChunkBytes))
      .toBeLessThanOrEqual(RESOURCE_STREAM_LIMITS.maxChunks);
    // A view budget is smaller than what the port can read, never larger.
    expect(WORKSPACE_FILES_LIMITS.wholeTextBytes).toBeLessThan(WORKSPACE_FILES_LIMITS.maxTextBytes);
  });
});

describe("WorkspaceFilesService projections", () => {
  it("gives a consumer opaque refs and display labels, never routing identity", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({ listing: ONE_FILE });
    const { listing, roots } = await openedFileRef(service, backend);

    const wire = JSON.stringify({ roots, listing });
    expect(wire).not.toContain(BINDING.device);
    expect(wire).not.toContain(BINDING.workspaceId);
    expect(wire).not.toContain("a.txt\":\"a.txt\"");
    expect(wire).toContain("我的笔记本");
    expect(roots.roots[0]).toEqual({ ref: expect.stringMatching(/^wf_/), label: "demo", sourceLabel: "我的笔记本" });
    // The projection survives its own contract reader, unknown fields and all.
    expect(readWorkspaceFilesDirectory(listing).ok).toBe(true);
  });

  it("reports a symlink without a ref, so there is nothing to submit", async () => {
    const service = new WorkspaceFilesService();
    const { listing } = await openedFileRef(service, scriptedBackend({ listing: ONE_FILE }));
    const link = listing.entries.find((entry) => entry.kind === "other");
    expect(link).toEqual({ label: "link", kind: "other" });
    expect(link).not.toHaveProperty("ref");
  });

  it("flags a file past the whole-document view budget so a view can load it deliberately", async () => {
    const service = new WorkspaceFilesService();
    const big: BackendResult<BackendListing> = {
      ok: true,
      value: {
        entries: [{ name: "big.bin", kind: "file", relativePath: "big.bin", sizeBytes: WORKSPACE_FILES_LIMITS.wholeTextBytes + 1 }],
        truncated: true,
      },
    };
    const { listing } = await openedFileRef(service, scriptedBackend({ listing: big }));
    expect(listing.entries[0].exceedsTextLimit).toBe(true);
    expect(listing.truncated).toBe(true);
  });

  it("enforces its configured listing cap even if an injected backend ignores it", async () => {
    const service = new WorkspaceFilesService({ listLimit: 1 });
    const backend = scriptedBackend({
      listing: {
        ok: true,
        value: {
          entries: [
            { name: "a.txt", kind: "file", relativePath: "a.txt" },
            { name: "b.txt", kind: "file", relativePath: "b.txt" },
          ],
          truncated: false,
        },
      },
    });
    const port = service.open({ scope: "scope-limit", owner: "alice", backend });
    const roots = await port.refreshRoots();
    if (!roots.ok) return;
    const listing = await port.listDirectory(roots.value.roots[0].ref);

    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.value.entries.map((entry) => entry.label)).toEqual(["a.txt"]);
    expect(listing.value.truncated).toBe(true);
  });
});

describe("WorkspaceFilesService refusals", () => {
  it("turns ref capacity into a bounded refusal without returning a partial projection", async () => {
    const service = new WorkspaceFilesService({ maxRefsPerScope: 1 });
    const backend = scriptedBackend({ listing: ONE_FILE });
    const port = service.open({ scope: "scope-capacity", owner: "alice", backend });
    const roots = await port.refreshRoots();
    if (!roots.ok) return;

    const listing = await port.listDirectory(roots.value.roots[0].ref);
    expect(listing).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(listing)).not.toContain(BINDING.device);
    expect(JSON.stringify(listing)).not.toContain(BINDING.workspaceId);
  });

  it("refuses a forged, cross-scope or wrong-kind ref before any backend call", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({ listing: ONE_FILE });
    const { port, ref, roots } = await openedFileRef(service, backend);
    const listingsBefore = backend.listings;
    const readsBefore = backend.reads;

    expect(await port.openText("wf_forged")).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await port.openText(roots.roots[0].ref)).toMatchObject({ ok: false, code: "wrong_kind" });
    expect(await port.listDirectory(ref)).toMatchObject({ ok: false, code: "wrong_kind" });

    const other = service.open({ scope: "scope-2", owner: "alice", backend });
    expect(await other.openText(ref)).toMatchObject({ ok: false, code: "unknown_ref" });
    // Same scope, different person: also unknown, and also without a frame.
    const impostor = service.open({ scope: "scope-1", owner: "mallory", backend });
    expect(await impostor.openText(ref)).toMatchObject({ ok: false, code: "unknown_ref" });

    expect(backend.listings).toBe(listingsBefore);
    expect(backend.reads).toBe(readsBefore);
  });

  it("passes an approval requirement through as an answer, not an exception", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({
      listing: ONE_FILE,
      windows: [backendRefusal("approval_required", "需要先批准")],
    });
    const { port, ref } = await openedFileRef(service, backend);
    expect(await port.openText(ref)).toMatchObject({ ok: false, code: "approval_required" });
  });

  it("answers `scope_closed` on its own port after the scope ends", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({ listing: ONE_FILE });
    const { port, ref, roots } = await openedFileRef(service, backend);

    // Two refs: the workspace root and `a.txt`. The symlink was never given one.
    expect(await service.closeScope("scope-1")).toEqual({ refs: 2, streams: 0 });
    expect(await port.refreshRoots()).toMatchObject({ ok: false, code: "scope_closed" });
    expect(await port.listDirectory(roots.roots[0].ref)).toMatchObject({ ok: false, code: "scope_closed" });
    expect(await port.openText(ref)).toMatchObject({ ok: false, code: "scope_closed" });
  });

  it("lets scope closure win over an in-flight root refresh without resurrecting refs", async () => {
    const roots = deferred<BackendResult<readonly BackendRoot[]>>();
    const backend: WorkspaceFilesBackend = {
      listRoots: () => roots.promise,
      listEntries: async () => ({ ok: true, value: { entries: [], truncated: false } }),
      readText: async () => backendRefusal("unavailable", "unused"),
    };
    const service = new WorkspaceFilesService();
    const port = service.open({ scope: "scope-race", owner: "alice", backend });
    const pending = port.refreshRoots();

    await service.closeScope("scope-race");
    roots.resolve({ ok: true, value: [{ binding: BINDING }] });
    expect(await pending).toMatchObject({ ok: false, code: "scope_closed" });
    expect(await service.closeScope("scope-race")).toEqual({ refs: 0, streams: 0 });
  });

  it("lets scope closure win over an in-flight listing without minting child refs", async () => {
    const listing = deferred<BackendResult<BackendListing>>();
    const backend: WorkspaceFilesBackend = {
      listRoots: async () => ({ ok: true, value: [{ binding: BINDING }] }),
      listEntries: () => listing.promise,
      readText: async () => backendRefusal("unavailable", "unused"),
    };
    const service = new WorkspaceFilesService();
    const port = service.open({ scope: "scope-list-race", owner: "alice", backend });
    const roots = await port.refreshRoots();
    if (!roots.ok) return;
    const pending = port.listDirectory(roots.value.roots[0].ref);

    expect(await service.closeScope("scope-list-race")).toEqual({ refs: 1, streams: 0 });
    listing.resolve(ONE_FILE);
    expect(await pending).toMatchObject({ ok: false, code: "scope_closed" });
    expect(await service.closeScope("scope-list-race")).toEqual({ refs: 0, streams: 0 });
  });

  it("lets scope closure win over an in-flight open without leaving a stream", async () => {
    const first = deferred<BackendResult<BackendTextWindow>>();
    const base = scriptedBackend({ listing: ONE_FILE });
    const backend: WorkspaceFilesBackend = {
      listRoots: () => base.listRoots(),
      listEntries: (binding, path, limit) => base.listEntries(binding, path, limit),
      readText: () => first.promise,
    };
    const service = new WorkspaceFilesService();
    const { port, ref } = await openedFileRef(service, backend, "scope-open-race");
    const pending = port.openText(ref);

    await service.closeScope("scope-open-race");
    first.resolve(window());
    expect(await pending).toMatchObject({ ok: false, code: "scope_closed" });
    expect(service.openStreams).toBe(0);
  });
});

describe("WorkspaceFilesService text streams", () => {
  it("serves the window fetched while opening without a second read", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({ listing: ONE_FILE, windows: [window()] });
    const { port, ref } = await openedFileRef(service, backend);

    const opened = await port.openText(ref);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(backend.reads).toBe(1);
    expect(opened.value.document).toEqual({
      ref,
      label: "a.txt",
      mediaType: "text/plain; charset=utf-8",
      sizeBytes: 6,
      digest: DIGEST,
      modifiedAt: "2026-08-06T00:00:00.000Z",
    });

    const drained = await drainResourceStream(opened.value.stream);
    expect(drained.chunks).toEqual([{ text: "hello\n" }]);
    expect(drained.terminal).toEqual({ kind: "end", chunks: 1, bytes: 6 });
    // One open + one terminal, and NOT one read per pull.
    expect(backend.reads).toBe(1);
  });

  it("stops when the file changes underneath a partly-read stream", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({
      listing: ONE_FILE,
      windows: [
        window({ bytes: 3, text: "hel", eof: false }),
        window({ offset: 3, bytes: 3, text: "LO!", eof: true, digest: `sha256:${"b".repeat(64)}` }),
      ],
    });
    const { port, ref } = await openedFileRef(service, backend);
    const opened = await port.openText(ref);
    if (!opened.ok) return;

    const drained = await drainResourceStream(opened.value.stream);
    expect(drained.chunks).toEqual([{ text: "hel" }]);
    expect(drained.terminal).toMatchObject({ kind: "refused", code: "unavailable" });
    // Terminal means terminal: no further read of any kind.
    const reads = backend.reads;
    expect(await opened.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(backend.reads).toBe(reads);
  });

  it("refuses a backend that marks a prefix as EOF instead of reporting truncation", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({
      listing: ONE_FILE,
      windows: [window({ bytes: 3, text: "hel", eof: true })],
    });
    const { port, ref } = await openedFileRef(service, backend);

    expect(await port.openText(ref)).toMatchObject({ ok: false, code: "unavailable" });
    expect(service.openStreams).toBe(0);
  });

  it("does not expose diagnostic text supplied by an injected backend", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({
      listing: ONE_FILE,
      windows: [backendRefusal("denied", "ENOENT /tmp/private/canonical-path")],
    });
    const { port, ref } = await openedFileRef(service, backend);
    const refused = await port.openText(ref);

    expect(refused).toMatchObject({ ok: false, code: "denied" });
    expect(JSON.stringify(refused)).not.toContain("/tmp/private");
  });

  it("turns a revoked grant mid-stream into a `denied` terminal and never retries", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({
      listing: ONE_FILE,
      windows: [window({ bytes: 3, text: "hel", eof: false }), backendRefusal("denied", "撤销了")],
    });
    const { port, ref } = await openedFileRef(service, backend);
    const opened = await port.openText(ref);
    if (!opened.ok) return;

    const drained = await drainResourceStream(opened.value.stream);
    expect(drained.chunks).toEqual([{ text: "hel" }]);
    expect(drained.terminal).toMatchObject({ kind: "refused", code: "denied" });
    expect(backend.reads).toBe(2);
  });

  it("never echoes a backend exception, canonical path and all", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({ listing: ONE_FILE, throwOnRead: true });
    const { port, ref } = await openedFileRef(service, backend);

    // A throw is a bug on the trusted side, and it still resolves as a bounded
    // refusal: Node's fs errors carry the path they failed on.
    const refused = await port.openText(ref);
    expect(refused).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(refused)).not.toContain("/tmp/canonical");

    // The same has to hold for a throw DURING a stream, which is the contract
    // guard's job rather than the provider's.
    const streaming = scriptedBackend({
      listing: ONE_FILE,
      windows: [window({ bytes: 3, text: "hel", eof: false })],
    });
    const second = await openedFileRef(service, streaming, "scope-2");
    const opened = await second.port.openText(second.ref);
    if (!opened.ok) return;
    await opened.value.stream.next();
    const terminal = await opened.value.stream.next();
    expect(terminal).toMatchObject({ kind: "refused" });
    expect(JSON.stringify(terminal)).not.toContain("/tmp/canonical");
  });

  it("closeScope cancels an open stream and releases its cursor exactly once", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({
      listing: ONE_FILE,
      windows: [window({ bytes: 3, text: "hel", eof: false }), window({ offset: 3, bytes: 3, text: "lo\n", eof: true })],
    });
    const { port, ref } = await openedFileRef(service, backend);
    const opened = await port.openText(ref);
    if (!opened.ok) return;

    expect(service.openStreams).toBe(1);
    expect(await service.closeScope("scope-1")).toMatchObject({ streams: 1 });
    expect(service.openStreams).toBe(0);

    const reads = backend.reads;
    expect(await opened.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(backend.reads).toBe(reads);
  });

  it("a consumer that closes early stops the backend immediately", async () => {
    const service = new WorkspaceFilesService();
    const backend = scriptedBackend({
      listing: ONE_FILE,
      windows: [window({ bytes: 3, text: "hel", eof: false }), window({ offset: 3, bytes: 3, text: "lo\n", eof: true })],
    });
    const { port, ref } = await openedFileRef(service, backend);
    const opened = await port.openText(ref);
    if (!opened.ok) return;

    expect(await opened.value.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    await opened.value.stream.close();
    await opened.value.stream.close();
    // The source reads at most one window ahead of the consumer, and nothing
    // after it is closed.
    const atClose = backend.reads;
    expect(atClose).toBeLessThanOrEqual(2);

    expect(await opened.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(backend.reads).toBe(atClose);
    expect(service.openStreams).toBe(0);
  });
});

describe("WorkspaceFilesService media streams", () => {
  it("preserves the backend receiver for every binary window", async () => {
    const body = Buffer.from("%PDF-test", "ascii");
    const backend: WorkspaceFilesBackend & { reads: number } = {
      reads: 0,
      async listRoots() {
        return { ok: true, value: [{ binding: BINDING }] };
      },
      async listEntries() {
        return ONE_FILE;
      },
      async readText() {
        return backendRefusal("unavailable", "unused");
      },
      async readBinary(
        _binding: WorkspaceBinding,
        _path: string,
        offset: number,
      ): Promise<BackendResult<BackendBinaryWindow>> {
        this.reads += 1;
        const bytes = offset === 0 ? 5 : body.byteLength - offset;
        return {
          ok: true,
          value: {
            sizeBytes: body.byteLength,
            digest: DIGEST,
            modifiedAt: "2026-08-06T00:00:00.000Z",
            offset,
            bytes,
            eof: offset + bytes === body.byteLength,
            data: body.subarray(offset, offset + bytes).toString("base64"),
          },
        };
      },
    };
    const service = new WorkspaceFilesService();
    const { port, ref } = await openedFileRef(service, backend, "media-receiver");

    const opened = await port.openMedia(ref);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const drained = await drainResourceStream(opened.value.stream);

    expect(Buffer.concat(drained.chunks.map((chunk) => Buffer.from(chunk.data, "base64")))).toEqual(body);
    expect(drained.terminal).toEqual({ kind: "end", chunks: 2, bytes: body.byteLength });
    expect(backend.reads).toBe(2);
  });
});

describe("RunnerWorkspaceFilesBackend window validation", () => {
  it.each([
    {},
    { absolute_path: "/other.txt" },
    { previous_digest: `sha256:${"b".repeat(64)}` },
    { size: 999 },
  ])("revalidates the owner-write receipt against the exact requested file and content: %j", async (changes) => {
    const calls: string[] = [];
    const backend = new RunnerWorkspaceFilesBackend({
      devices: async () => [],
      call: async (_device, operation) => {
        calls.push(operation);
        return { status: "succeeded", result: {
          status: "ok", encoding: "utf-8", absolute_path: "/draft.txt",
          previous_digest: DIGEST, digest: `sha256:${"c".repeat(64)}`,
          size: 4, modified_at: "2026-09-25T00:00:00.000Z", ...changes,
        } };
      },
    });
    const reply = await backend.replaceText({ ...BINDING, ownerRoot: true }, "/draft.txt", DIGEST, "new\n");
    expect(reply).toMatchObject(Object.keys(changes).length ? { ok: false, code: "unavailable" } : { ok: true });
    expect(calls).toEqual(["replace_owner_text"]);
  });

  it("projects an owner root and reads it even when workspace enumeration is denied", async () => {
    const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
    const authority: WorkspaceFilesAuthority = {
      devices: async () => [{ device: "laptop", label: "laptop" }],
      call: async (_device, operation, args) => {
        calls.push({ operation, args });
        if (operation === "list_session_workspaces") return { status: "denied" };
        if (operation !== "access_owner_files") return { status: "failed" };
        if (args.mode === "list") {
          return {
            status: "succeeded",
            result: {
              status: "ok",
              mode: "list",
              absolute_path: "/",
              entries: [{ name: "AUTONOMOUS-ROADMAP.md", kind: "file", absolute_path: "/AUTONOMOUS-ROADMAP.md", size: 6 }],
              truncated: false,
            },
          };
        }
        return {
          status: "succeeded",
          result: {
            status: "ok",
            mode: "text",
            absolute_path: "/AUTONOMOUS-ROADMAP.md",
            size: 6,
            modified_at: "2026-08-26T00:00:00.000Z",
            digest: DIGEST,
            encoding: "utf-8",
            offset: 0,
            bytes: 6,
            eof: true,
            text: "hello\n",
          },
        };
      },
    };
    const backend = new RunnerWorkspaceFilesBackend(authority, { ownerFiles: true });
    const port = new WorkspaceFilesService().open({ scope: "owner-root", owner: "alice", backend });
    const roots = await port.refreshRoots();
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.value.roots).toEqual([{ ref: expect.any(String), label: "/", sourceLabel: "laptop" }]);

    const listing = await port.listDirectory(roots.value.roots[0]!.ref);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const opened = await port.openText(listing.value.entries[0]!.ref!);
    expect(opened.ok).toBe(true);
    expect(calls.map((call) => call.operation)).toEqual([
      "list_session_workspaces",
      "access_owner_files",
      "access_owner_files",
    ]);
    expect(calls[1]!.args).toMatchObject({ mode: "list", absolute_path: "/" });
    expect(calls[2]!.args).toMatchObject({ mode: "text", absolute_path: "/AUTONOMOUS-ROADMAP.md" });
  });

  it("shares normalized facts without changing v1 root labels or skipping Gate", async () => {
    let calls = 0;
    const long = "l".repeat(200);
    const authority: WorkspaceFilesAuthority = {
      devices: async () => [{ device: "laptop", label: "Laptop" }],
      call: async () => {
        calls += 1;
        return {
          status: "succeeded",
          result: {
            workspaces: [
              // Whitespace is data in workspace-files/v1; no trim here.
              { id: "ws_0123456789abcdef01234567", label: "  spaced  " },
              // A hostile device can repeat an id. The v1 reader historically
              // preserves both rows; sharing normalization must not de-dupe it.
              { id: "ws_0123456789abcdef01234567", label: "duplicate" },
              // Sessions truncates at 120 later, but v1 accepts up to 255.
              { id: "ws_1123456789abcdef01234567", label: long },
              { id: "ws_2123456789abcdef01234567", label: "x".repeat(256) },
            ],
            session_directories: [],
          },
        };
      },
    };
    const backend = new RunnerWorkspaceFilesBackend(authority);

    const first = await backend.listRoots();
    const second = await backend.listRoots();
    expect(first).toMatchObject({
      ok: true,
      value: [
        { binding: { workspaceLabel: "  spaced  " } },
        { binding: { workspaceLabel: "duplicate" } },
        { binding: { workspaceLabel: long } },
      ],
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("x".repeat(256));
    // Parser reuse cannot cache an allow decision: every external refresh still
    // spends its own Gate call.
    expect(calls).toBe(2);
  });

  it("refuses EOF unless the returned window reaches the declared file end", async () => {
    const authority: WorkspaceFilesAuthority = {
      devices: async () => [],
      call: async () => ({
        status: "succeeded",
        result: {
          status: "ok",
          workspace_id: BINDING.workspaceId,
          relative_path: "a.txt",
          size: 6,
          modified_at: "2026-08-06T00:00:00.000Z",
          digest: DIGEST,
          encoding: "utf-8",
          offset: 0,
          bytes: 3,
          eof: true,
          text: "hel",
        },
      }),
    };
    const backend = new RunnerWorkspaceFilesBackend(authority);

    expect(await backend.readText(BINDING, "a.txt", 0, 3))
      .toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("the write path re-validates the device's receipt", () => {
  const NEW_DIGEST = `sha256:${"b".repeat(64)}`;

  /** A backend whose replace answer can be made to disagree with the request. */
  function writingBackend(mutation: Partial<BackendMutation> = {}): WorkspaceFilesBackend & { writes: number } {
    const base = scriptedBackend({ listing: ONE_FILE, windows: [window(), window()] });
    let writes = 0;
    return {
      listRoots: () => base.listRoots(),
      listEntries: (...args: Parameters<WorkspaceFilesBackend["listEntries"]>) => base.listEntries(...args),
      readText: (...args: Parameters<WorkspaceFilesBackend["readText"]>) => base.readText(...args),
      get writes() {
        return writes;
      },
      async replaceText(
        _binding: WorkspaceBinding,
        _path: string,
        expectedDigest: string,
        text: string,
      ): Promise<BackendResult<BackendMutation>> {
        writes += 1;
        return {
          ok: true,
          value: {
            sizeBytes: Buffer.byteLength(text, "utf8"),
            digest: NEW_DIGEST,
            previousDigest: expectedDigest,
            modifiedAt: "2026-08-07T00:00:00.000Z",
            ...mutation,
          },
        };
      },
    } as WorkspaceFilesBackend & { writes: number };
  }

  /** One scope's port plus a file ref, with the write either allowed or not. */
  async function fileRef(backend: WorkspaceFilesBackend, scope: string, writable: boolean) {
    const port = new WorkspaceFilesService().open({ scope, owner: "alice", backend, writable });
    const roots = await port.refreshRoots();
    if (!roots.ok) throw new Error("roots refused");
    const listing = await port.listDirectory(roots.value.roots[0].ref);
    if (!listing.ok) throw new Error("listing refused");
    return { port, ref: listing.value.entries.find((entry) => entry.kind === "file")!.ref! };
  }

  it("mints a receipt that echoes the ref and both digests", async () => {
    const backend = writingBackend();
    const { port, ref } = await fileRef(backend, "write-1", true);

    const written = await port.replaceText(ref, { expectedDigest: DIGEST, text: "hello\n" });

    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value).toEqual({
      ref,
      mutationId: expect.stringMatching(/^[0-9a-f]{32}$/),
      operation: "replace_text",
      beforeDigest: DIGEST,
      afterDigest: NEW_DIGEST,
      sizeBytes: 6,
      committedAt: "2026-08-07T00:00:00.000Z",
      undo: "unsupported",
    });
    // Two writes are two mutation ids: an id that repeated would make one ledger
    // entry indistinguishable from its predecessor.
    const second = await port.replaceText(ref, { expectedDigest: NEW_DIGEST, text: "hello\n" });
    if (!second.ok) throw new Error("second write refused");
    expect(second.value.mutationId).not.toBe(written.value.mutationId);
  });

  it("refuses a receipt about a different version or a different number of bytes", async () => {
    const lies: Array<Partial<BackendMutation>> = [
      { previousDigest: NEW_DIGEST },
      { sizeBytes: 999 },
      { digest: "not-a-digest" },
    ];
    for (const [index, lie] of lies.entries()) {
      const backend = writingBackend(lie);
      const { port, ref } = await fileRef(backend, `write-lie-${index}`, true);

      const written = await port.replaceText(ref, { expectedDigest: DIGEST, text: "hello\n" });

      // The write may well have happened on the device. What must not happen is
      // this process reporting "saved" on the strength of an answer that
      // describes something else — a receipt is what a person reads.
      expect(written, JSON.stringify(lie)).toMatchObject({ ok: false, code: "unavailable" });
      expect(backend.writes).toBe(1);
    }
  });

  it("never reaches the backend for a read-only scope or a malformed request", async () => {
    const readOnly = writingBackend();
    const closed = await fileRef(readOnly, "ro", false);
    expect(await closed.port.replaceText(closed.ref, { expectedDigest: DIGEST, text: "x" }))
      .toMatchObject({ ok: false, code: "read_only" });

    const writable = writingBackend();
    const open = await fileRef(writable, "bad-request", true);
    expect(await open.port.replaceText(open.ref, { expectedDigest: "nope", text: "x" }))
      .toMatchObject({ ok: false, code: "invalid_request" });
    expect(await open.port.replaceText(open.ref, {
      expectedDigest: DIGEST,
      text: "x".repeat(WORKSPACE_FILES_LIMITS.maxWriteTextBytes + 1),
    })).toMatchObject({ ok: false, code: "too_large" });

    expect(readOnly.writes).toBe(0);
    expect(writable.writes).toBe(0);
  });

  it("says `read_only` when the backend cannot write at all", async () => {
    // A backend with no `replaceText` is a read-only backend, and saying so is
    // more useful than inventing a failure for it.
    const backend = scriptedBackend({ listing: ONE_FILE, windows: [window()] });
    const { port, ref } = await fileRef(backend, "no-write", true);

    expect(await port.replaceText(ref, { expectedDigest: DIGEST, text: "x" }))
      .toMatchObject({ ok: false, code: "read_only" });
  });
});

describe("WorkspaceFilesService read-ahead", () => {
  it("overlaps the next device read with the consumer, never more than one window ahead", async () => {
    const service = new WorkspaceFilesService();
    const windows = [
      window({ sizeBytes: 9, bytes: 3, text: "abc", eof: false }),
      window({ sizeBytes: 9, offset: 3, bytes: 3, text: "def", eof: false }),
      window({ sizeBytes: 9, offset: 6, bytes: 3, text: "ghi", eof: true }),
    ];
    const backend = scriptedBackend({ listing: ONE_FILE, windows });
    const { port, ref } = await openedFileRef(service, backend);
    const opened = await port.openText(ref);
    if (!opened.ok) return;
    const text: string[] = [];
    for (;;) {
      const before = backend.reads;
      const read = await opened.value.stream.next();
      // Each pull starts at most one new backend read.
      expect(backend.reads - before).toBeLessThanOrEqual(1);
      if (read.kind !== "chunk") {
        expect(read.kind).toBe("end");
        break;
      }
      text.push(read.value.text);
      // The window after this one is already on its way.
      await Promise.resolve();
    }
    expect(text.join("")).toBe("abcdefghi");
    expect(backend.reads).toBe(3);
  });
});

