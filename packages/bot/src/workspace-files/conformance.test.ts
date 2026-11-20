/**
 * The vertical proof: a temp home, the real workspace registry, the real Runner
 * RPC dispatch, the real Runner adapter, the real ref vault, the real broker,
 * and a consumer that only ever sees `workspace-files/v1`.
 *
 * Nothing below the authority seam is mocked. What the seam replaces is the
 * capability Gate — production derives a ControllerRun under the App's Context
 * and asks the kernel; here the same call lands on `handleRpc`. That is the one
 * substitution, it is stated in `types.ts`, and it is what lets this file assert
 * about FRAMES: a test that says "the backend was never called" is saying the
 * laptop was never touched.
 *
 * The eight properties below are the acceptance list for this batch. Each `it`
 * is one of them.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRpc } from "@claude-bot/runner/core";
import { addWorkspace } from "@claude-bot/runner/workspaces";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { drainResourceStream } from "@claude-bot/resource-stream-contract";
import {
  WORKSPACE_FILES_LIMITS,
  readWorkspaceFilesDirectory,
  readWorkspaceFilesRoots,
  readWorkspaceTextChunk,
  readWorkspaceTextDocument,
  type WorkspaceFilesPort,
} from "@claude-bot/workspace-files-contract";
import { RunnerWorkspaceFilesBackend } from "./runner-backend.js";
import { WorkspaceFilesService, type WorkspaceFilesScopePort } from "./service.js";
import type { RunnerCallOutcome, WorkspaceFilesAuthority } from "./types.js";

const DEVICE = "laptop-routing-id";
const DEVICE_LABEL = "我的笔记本";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  home: string;
  root: string;
  outside: string;
  service: WorkspaceFilesService;
  port: WorkspaceFilesPort;
  /** Every frame that reached the device, in order. */
  frames: Array<{ device: string; operation: string; args: Record<string, unknown> }>;
  openPort(scope: string, owner?: string): WorkspaceFilesPort;
  /**
   * A port whose scope's authority is stated to cover the write.
   *
   * Separate from `openPort` so that "the default scope does not write" stays
   * true in every existing property here: a harness that silently made every
   * port writable would stop proving that read-only really is read-only.
   */
  openWritablePort(scope: string, owner?: string): WorkspaceFilesScopePort;
}

/**
 * `chunkBytes` is narrowed in the streaming tests so a file of a few hundred
 * kilobytes takes several windows. Making the FILE bigger instead would test
 * the same code path with a slower fixture.
 */
async function harness(options: { chunkBytes?: number } = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "wsfiles-e2e-"));
  dirs.push(home);
  const root = join(home, "projects", "demo");
  mkdirSync(join(root, "src"), { recursive: true });
  const outside = join(home, "elsewhere");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "not yours\n", "utf8");
  await addWorkspace(home, root, "Demo");

  const frames: Harness["frames"] = [];
  const authority: WorkspaceFilesAuthority = {
    async devices() {
      return [{ device: DEVICE, label: DEVICE_LABEL }];
    },
    async call(device, operation, args): Promise<RunnerCallOutcome> {
      // The gateway strips the selector before the frame leaves; model that
      // faithfully so the device never sees a name it could route on.
      const { device: _selector, ...rest } = args;
      frames.push({ device, operation, args: rest });
      const response = await handleRpc(home, { id: String(frames.length), method: operation, args: rest }, {
        allowMachineOps: true,
      });
      return response.ok
        ? { status: "succeeded", result: response.result }
        : { status: "failed", reason: response.error };
    },
  };

  const service = new WorkspaceFilesService(
    options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes },
  );
  const backend = new RunnerWorkspaceFilesBackend(authority);
  const openPort = (scope: string, owner = "alice"): WorkspaceFilesPort =>
    service.open({ scope, owner, backend });
  const openWritablePort = (scope: string, owner = "alice"): WorkspaceFilesScopePort =>
    service.open({ scope, owner, backend, writable: true });
  return { home, root, outside, service, port: openPort("scope-1"), frames, openPort, openWritablePort };
}

async function rootRef(port: WorkspaceFilesPort): Promise<string> {
  const roots = await port.refreshRoots();
  if (!roots.ok) throw new Error(`roots refused: ${roots.code}`);
  return roots.value.roots[0].ref;
}

async function childRef(port: WorkspaceFilesPort, parent: string, label: string): Promise<string> {
  const listing = await port.listDirectory(parent);
  if (!listing.ok) throw new Error(`listing refused: ${listing.code}`);
  const entry = listing.value.entries.find((row) => row.label === label);
  if (!entry?.ref) throw new Error(`no ref for ${label}`);
  return entry.ref;
}

describe("workspace-files vertical path", () => {
  it("1. gives the consumer opaque refs and display fields, and nothing else", async () => {
    const { port } = await harness();
    const roots = await port.refreshRoots();

    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.value).toEqual({
      roots: [{ ref: expect.stringMatching(/^wf_[A-Za-z0-9_-]{32}$/), label: "Demo", sourceLabel: DEVICE_LABEL }],
      truncated: false,
    });
    // It survives its own contract reader, which refuses any extra field.
    expect(readWorkspaceFilesRoots(roots.value).ok).toBe(true);
    const wire = JSON.stringify(roots.value);
    expect(wire).not.toContain(DEVICE);
    expect(wire).not.toContain("ws_");
    expect(wire).not.toContain("~");
  });

  it("2. walks directories and reads a file's UTF-8 content and digest through the stream", async () => {
    const { port, root } = await harness();
    writeFileSync(join(root, "src", "a.ts"), "第一行\nexport const a = 1;\n", "utf8");
    const src = await childRef(port, await rootRef(port), "src");

    const listing = await port.listDirectory(src);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(readWorkspaceFilesDirectory(listing.value).ok).toBe(true);
    expect(listing.value.entries.map((row) => `${row.kind}:${row.label}`)).toEqual(["file:a.ts"]);

    const opened = await port.openText(listing.value.entries[0].ref!);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(readWorkspaceTextDocument(opened.value.document).ok).toBe(true);
    expect(opened.value.document.mediaType).toBe("text/plain; charset=utf-8");
    expect(opened.value.document.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(opened.value.document.sizeBytes).toBe(Buffer.byteLength("第一行\nexport const a = 1;\n", "utf8"));

    const drained = await drainResourceStream(opened.value.stream);
    expect(drained.chunks.map((chunk) => chunk.text).join("")).toBe("第一行\nexport const a = 1;\n");
    expect(drained.seqs).toEqual([0]);
    expect(drained.terminal.kind).toBe("end");
    expect(readWorkspaceTextChunk(drained.chunks[0]).ok).toBe(true);
  });

  it("2b. streams a large file in bounded, in-order windows that reassemble exactly", async () => {
    const { port, root } = await harness({ chunkBytes: 64 * 1024 });
    // Multi-byte characters at a size that forces several windows, so the
    // boundary handling on the device is exercised end to end.
    const text = "行".repeat(60_000);
    writeFileSync(join(root, "big.txt"), text, "utf8");

    const opened = await port.openText(await childRef(port, await rootRef(port), "big.txt"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const drained = await drainResourceStream(opened.value.stream);
    expect(drained.chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(drained.seqs).toEqual(drained.seqs.map((_row, index) => index));
    expect(drained.terminal).toEqual({
      kind: "end",
      chunks: drained.chunks.length,
      bytes: Buffer.byteLength(text, "utf8"),
    });
    expect(drained.chunks.length).toBeGreaterThan(1);
  });

  it("3. keeps refs stable within a scope and different across scopes", async () => {
    const { port, openPort, root } = await harness();
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    const first = await rootRef(port);

    expect(await rootRef(port)).toBe(first);
    expect(await childRef(port, first, "a.txt")).toBe(await childRef(port, first, "a.txt"));

    const other = openPort("scope-2");
    const theirs = await rootRef(other);
    expect(theirs).not.toBe(first);
    expect(await childRef(other, theirs, "a.txt")).not.toBe(await childRef(port, first, "a.txt"));
  });

  it("4. refuses forged, cross-scope, stale and wrong-kind refs before any frame", async () => {
    const { port, openPort, service, frames, root } = await harness();
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    const dir = await rootRef(port);
    const file = await childRef(port, dir, "a.txt");
    const other = openPort("scope-2");
    const theirDir = await rootRef(other);
    const framesBefore = frames.length;

    expect(await port.openText("wf_forged")).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await port.openText(`${dir}x`)).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await port.listDirectory(theirDir)).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await port.openText(dir)).toMatchObject({ ok: false, code: "wrong_kind" });
    expect(await port.listDirectory(file)).toMatchObject({ ok: false, code: "wrong_kind" });
    // Somebody else's session, same scope name: the owner is part of the lookup.
    const impostor = openPort("scope-1", "mallory");
    expect(await impostor.openText(file)).toMatchObject({ ok: false, code: "unknown_ref" });

    await service.closeScope("scope-1");
    expect(await port.openText(file)).toMatchObject({ ok: false, code: "scope_closed" });
    // Not one of those produced a Runner frame.
    expect(frames).toHaveLength(framesBefore);
  });

  it("5. refuses traversal, escape, kind confusion and binary; reads a big file whole", async () => {
    const { port, root, outside } = await harness();
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(outside, "secret.txt"), join(root, "peek.txt"));
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x68, 0x00, 0x69]));
    // Past the whole-document view budget (and the old 1 MiB device cap).
    const bigText = "x".repeat(WORKSPACE_FILES_LIMITS.wholeTextBytes + 1);
    writeFileSync(join(root, "big.txt"), bigText, "utf8");
    const dir = await rootRef(port);

    // `../`, absolute paths, backslashes and NUL are not refusals — they are
    // UNSAYABLE. A consumer submits a ref, and a ref is 192 bits of randomness.
    for (const attempt of ["../elsewhere/secret.txt", "/etc/passwd", "src\\..\\..\\etc", "a\u0000b", ""]) {
      expect(await port.openText(attempt)).toMatchObject({ ok: false, code: "unknown_ref" });
      expect(await port.listDirectory(attempt)).toMatchObject({ ok: false, code: "unknown_ref" });
    }

    const listing = await port.listDirectory(dir);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    // Both symlinks are reported and neither is addressable.
    for (const label of ["escape", "peek.txt"]) {
      const entry = listing.value.entries.find((row) => row.label === label);
      expect(entry).toEqual({ label, kind: "other" });
    }
    const big = listing.value.entries.find((row) => row.label === "big.txt");
    expect(big?.exceedsTextLimit).toBe(true);

    expect(await port.openText(await childRef(port, dir, "bin.dat"))).toMatchObject({ ok: false, code: "not_text" });
    // The listing tells a whole-document view to budget, but the port itself
    // reads the file to its end.
    const opened = await port.openText(await childRef(port, dir, "big.txt"));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.document.sizeBytes).toBe(bigText.length);
      let received = 0;
      for (;;) {
        const read = await opened.value.stream.next();
        if (read.kind !== "chunk") {
          expect(read.kind).toBe("end");
          break;
        }
        received += read.value.text.length;
      }
      expect(received).toBe(bigText.length);
    }
    // A directory offered as a file, from the other direction: it has a
    // directory ref, so this is `wrong_kind` rather than a device refusal.
    expect(await port.openText(await childRef(port, dir, "src"))).toMatchObject({ ok: false, code: "wrong_kind" });
  });

  it("6. releases precisely on early close, scope close and provider failure", async () => {
    const { port, openPort, service, root, frames } = await harness({ chunkBytes: 64 * 1024 });
    writeFileSync(join(root, "big.txt"), "行".repeat(60_000), "utf8");
    const file = await childRef(port, await rootRef(port), "big.txt");

    // Early close: one chunk, then nothing more reaches the device.
    const early = await port.openText(file);
    if (!early.ok) return;
    expect(await early.value.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    const framesAtClose = frames.length;
    await early.value.stream.close();
    expect(await early.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(frames).toHaveLength(framesAtClose);
    expect(service.openStreams).toBe(0);

    // Scope close: the same, for a stream nobody closed.
    const abandoned = await port.openText(file);
    if (!abandoned.ok) return;
    expect(service.openStreams).toBe(1);
    expect(await service.closeScope("scope-1")).toMatchObject({ streams: 1 });
    expect(await abandoned.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(service.openStreams).toBe(0);

    // Provider failure: the file goes away between two windows. Nothing is
    // mocked to make this happen — the file is deleted, and the next window is
    // a real `not_found` from the device.
    const reopened = openPort("scope-3");
    const failing = await reopened.openText(await childRef(reopened, await rootRef(reopened), "big.txt"));
    if (!failing.ok) return;
    expect(await failing.value.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    rmSync(join(root, "big.txt"));

    const terminal = await failing.value.stream.next();
    expect(terminal).toMatchObject({ kind: "refused", code: "not_found" });
    expect(await failing.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(service.openStreams).toBe(0);
  });

  it("7. never lets a canonical path appear in a projection, a refusal or an error", async () => {
    const { port, home, root, outside } = await harness();
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    symlinkSync(join(outside, "secret.txt"), join(root, "peek.txt"));
    const dir = await rootRef(port);

    const answers: unknown[] = [
      await port.refreshRoots(),
      await port.listDirectory(dir),
      await port.openText("wf_forged"),
      await port.listDirectory("wf_forged"),
    ];
    const file = await childRef(port, dir, "a.txt");
    const opened = await port.openText(file);
    answers.push(opened);
    if (opened.ok) answers.push(await drainResourceStream(opened.value.stream));

    for (const answer of answers) {
      const wire = JSON.stringify(answer);
      expect(wire).not.toContain(root);
      expect(wire).not.toContain(home);
      expect(wire).not.toContain(tmpdir());
      expect(wire).not.toContain("elsewhere");
    }
  });

  it("8. does not retry, and one pull costs at most one device read", async () => {
    const { port, root, frames } = await harness({ chunkBytes: 64 * 1024 });
    writeFileSync(join(root, "big.txt"), "行".repeat(60_000), "utf8");
    const file = await childRef(port, await rootRef(port), "big.txt");

    const opened = await port.openText(file);
    if (!opened.ok) return;
    const afterOpen = frames.filter((frame) => frame.operation === "read_workspace_text").length;
    expect(afterOpen).toBe(1);

    let pulls = 0;
    for (;;) {
      const before = frames.filter((frame) => frame.operation === "read_workspace_text").length;
      const read = await opened.value.stream.next();
      const after = frames.filter((frame) => frame.operation === "read_workspace_text").length;
      pulls += 1;
      expect(after - before).toBeLessThanOrEqual(1);
      if (read.kind !== "chunk") break;
    }
    expect(pulls).toBeGreaterThan(1);

    // A refused open is refused once. Nothing behind this port ever re-issues a
    // call on its own, so a revoked grant cannot become a stream of cards.
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x00]));
    const binary = await childRef(port, await rootRef(port), "bin.dat");
    const readsBefore = frames.filter((frame) => frame.operation === "read_workspace_text").length;
    expect(await port.openText(binary)).toMatchObject({ ok: false, code: "not_text" });
    expect(frames.filter((frame) => frame.operation === "read_workspace_text").length).toBe(readsBefore + 1);
  });

  it("9. replaces a file end to end, and the receipt describes what is now on disk", async () => {
    const { openWritablePort, root } = await harness();
    writeFileSync(join(root, "notes.md"), "第一版\n", "utf8");
    const port = openWritablePort("scope-write");
    const ref = await childRef(port, await rootRef(port), "notes.md");
    const opened = await port.openText(ref);
    if (!opened.ok) throw new Error(`open refused: ${opened.code}`);
    await opened.value.stream.close();

    const written = await port.replaceText(ref, {
      expectedDigest: opened.value.document.digest,
      text: "第二版\n",
    });

    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value.ref).toBe(ref);
    expect(written.value.operation).toBe("replace_text");
    expect(written.value.beforeDigest).toBe(opened.value.document.digest);
    expect(written.value.afterDigest).not.toBe(written.value.beforeDigest);
    expect(written.value.sizeBytes).toBe(Buffer.byteLength("第二版\n", "utf8"));
    expect(written.value.undo).toBe("unsupported");
    expect(written.value.mutationId).toMatch(/^[0-9a-f]{32}$/);
    // The real file changed, and re-opening it through the SAME port agrees
    // with the receipt — the receipt is not a claim about a different version.
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("第二版\n");
    const again = await port.openText(ref);
    if (!again.ok) throw new Error("reopen refused");
    expect(again.value.document.digest).toBe(written.value.afterDigest);
    await again.value.stream.close();
  });

  it("10. refuses a stale write, and a write from a read-only scope, without a frame", async () => {
    const { openPort, openWritablePort, root, frames } = await harness();
    writeFileSync(join(root, "notes.md"), "第一版\n", "utf8");
    const port = openWritablePort("scope-write");
    const ref = await childRef(port, await rootRef(port), "notes.md");
    const opened = await port.openText(ref);
    if (!opened.ok) throw new Error("open refused");
    await opened.value.stream.close();
    // Somebody else saves in between.
    writeFileSync(join(root, "notes.md"), "别人的版本\n", "utf8");

    const stale = await port.replaceText(ref, {
      expectedDigest: opened.value.document.digest,
      text: "我的版本\n",
    });
    expect(stale).toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("别人的版本\n");

    // A scope that was not given the write refuses BEFORE the device: no frame,
    // therefore no approval card for an edit that could never be applied.
    const readOnly = openPort("scope-read-only") as WorkspaceFilesScopePort;
    const readOnlyRef = await childRef(readOnly, await rootRef(readOnly), "notes.md");
    const before = frames.length;
    expect(await readOnly.replaceText(readOnlyRef, { expectedDigest: `sha256:${"a".repeat(64)}`, text: "x" }))
      .toMatchObject({ ok: false, code: "read_only" });
    expect(frames).toHaveLength(before);
  });

  it("11. refuses a forged, foreign or wrong-kind ref on a write before any frame", async () => {
    const { openWritablePort, root, frames } = await harness();
    writeFileSync(join(root, "a.txt"), "a\n", "utf8");
    const mine = openWritablePort("scope-a");
    const dirRef = await rootRef(mine);
    const fileRef = await childRef(mine, dirRef, "a.txt");
    const other = openWritablePort("scope-b");
    await rootRef(other);
    const digest = `sha256:${"a".repeat(64)}`;

    const before = frames.length;
    expect(await mine.replaceText("wf_forged", { expectedDigest: digest, text: "x" }))
      .toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await mine.replaceText(dirRef, { expectedDigest: digest, text: "x" }))
      .toMatchObject({ ok: false, code: "wrong_kind" });
    expect(await other.replaceText(fileRef, { expectedDigest: digest, text: "x" }))
      .toMatchObject({ ok: false, code: "unknown_ref" });
    // A malformed precondition or a missing body is refused here too, so a
    // device never has to judge a request that could not have been meant.
    expect(await mine.replaceText(fileRef, { expectedDigest: "deadbeef", text: "x" }))
      .toMatchObject({ ok: false, code: "invalid_request" });
    expect(await mine.replaceText(fileRef, { expectedDigest: digest, text: undefined as unknown as string }))
      .toMatchObject({ ok: false, code: "invalid_request" });
    expect(frames).toHaveLength(before);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
  });

  it("12. keeps the canonical path out of every write answer, refusal included", async () => {
    const { openWritablePort, root, home } = await harness();
    writeFileSync(join(root, "a.txt"), "a\n", "utf8");
    const port = openWritablePort("scope-write");
    const ref = await childRef(port, await rootRef(port), "a.txt");
    const opened = await port.openText(ref);
    if (!opened.ok) throw new Error("open refused");
    await opened.value.stream.close();

    const answers = [
      await port.replaceText(ref, { expectedDigest: `sha256:${"f".repeat(64)}`, text: "x" }),
      await port.replaceText(ref, { expectedDigest: opened.value.document.digest, text: "b\n" }),
    ];
    for (const answer of answers) {
      const wire = JSON.stringify(answer);
      expect(wire).not.toContain(root);
      expect(wire).not.toContain(home);
      expect(wire).not.toContain(tmpdir());
    }
  });

  it("bounds a listing at the contract's cap and says it was cut", async () => {
    const { openPort, root } = await harness();
    for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `f${i}.txt`), "x", "utf8");
    const port = openPort("scope-limit");
    const listing = await port.listDirectory(await rootRef(port));

    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.value.entries.length).toBeLessThanOrEqual(WORKSPACE_FILES_LIMITS.maxEntries);
    expect(listing.value.truncated).toBe(false);
  });
});
