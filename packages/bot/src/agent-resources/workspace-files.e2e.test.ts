/**
 * The whole binding, end to end, with nothing mocked in the middle.
 *
 * A module holding a typed `WorkspaceFilesPort` → the remote client → a proposal
 * transport → the catalog → the App's binding plan → the Workspace Files
 * capability plane → the real Gate → a real WebSocket to a device → the real
 * device implementation over a real temp home → and back through the real ref
 * vault, the real stream broker and the contract's own readers.
 *
 * What the substitution is: the trusted shell calls `catalog.openInstance()`
 * once, keeps the returned handle for that App instance, and the "transport"
 * below calls `handle.dispatch` when a proposal arrives. There is no MessagePort
 * here because a port is not what any of these properties are about.
 *
 * Every assertion about a device is an assertion about FRAMES: a test that says
 * "the device was never touched" is saying no approval card was created and no
 * laptop did any work.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRpc } from "@claude-bot/runner/core";
import { addWorkspace } from "@claude-bot/runner/workspaces";
import { readResourceBindings, type ResourceBindingPlan } from "@claude-bot/agent-module-contract";
import { drainResourceStream } from "@claude-bot/resource-stream-contract";
import {
  RESOURCE_ACTIONS,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_FILES_WIRE_ACTIONS,
  createRemoteWorkspaceFilesPort,
  createRemoteWorkspaceFilesPortV4,
  readWorkspaceMutationReceipt,
  workspaceFilesCanWrite,
  type ProposalTransport,
  type RemoteWorkspaceFiles,
} from "@claude-bot/workspace-files-contract";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "../runner/gateway.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { startFakeRunner, type FakeRunner } from "../runner/fake-runner.helper.js";
import { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { GrantWorkspaceFilesAuthority } from "../workspace-files/authority.js";
import { WorkspaceFilesService } from "../workspace-files/service.js";
import { AgentResourceCatalog, type AgentResourceInstance } from "./catalog.js";
import { workspaceFilesProvider, workspaceFilesProviderV4 } from "./workspace-files-provider.js";
import { WorkspaceDirectoryKeys } from "../workspace-files/directory-key.js";
import { ownerFileSessionTarget } from "../workspace-files/owner-file-target.js";
import { resourceId } from "../sessionhub/core.js";
import type { ResourceScopeIdentity } from "./types.js";

const NOW = "2026-08-06T00:00:00.000Z";
const DIGEST = "d".repeat(64);
const CONTRACT_DIGEST = "c".repeat(64);

const PLAN_DOC = {
  schema: "agent-resource-bindings/v1",
  app: "demo",
  bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
  connections: [{ instance: "files", port: "workspace-files/v1", binding: "workspace" }],
};

function plan(): ResourceBindingPlan {
  const read = readResourceBindings(PLAN_DOC);
  if (!read.ok) throw new Error("bad fixture");
  return read.value;
}

let dir: string;
let home: string;
let root: string;
let store: Store;
let gateway: RunnerGateway;
let caps: RunnerCapabilities;
let files: WorkspaceFilesCapabilities;
let service: WorkspaceFilesService;
let catalog: AgentResourceCatalog;
let laptop: FakeRunner;
/** Every frame that reached a device, in order. */
let frames: Array<{ method: string; args: Record<string, unknown> }>;

function identity(overrides: Partial<ResourceScopeIdentity> = {}): ResourceScopeIdentity {
  return {
    owner: "alice",
    publisher: "octopus:first-party",
    app: "demo",
    packageDigest: DIGEST,
    permissionContractDigest: CONTRACT_DIGEST,
    instance: "tab-1",
    plan: plan(),
    ...overrides,
  };
}

/**
 * The composition root's job, in one function: decide what a scope may do.
 *
 * Production resolves the exact contract from `context.permissionContractDigest`
 * and intersects it with the owner's recorded grant. This harness stands in for
 * that decision so the vertical path — handle, catalog, Gate, WebSocket, device,
 * temp home — is what is being exercised.
 */
function grantFor(
  rights: readonly string[] = [
    "list_session_workspaces",
    "list_workspace_entries",
    "read_workspace_text",
    "replace_workspace_text",
  ],
  autoAllow?: readonly string[],
) {
  return (context: { owner: string; app: string; packageDigest: string; instance: string; binding: string }) => {
    const grant = files.open({
      username: context.owner,
      purpose: `${context.app} · 工作区文件`,
      kind: "app-instance",
      rights: rights as never,
      ...(autoAllow === undefined ? {} : { autoAllow: autoAllow as never }),
      metadata: { app: context.app, release: context.packageDigest.slice(0, 20) },
      pool: `app:${context.app}:${context.instance}:${context.binding}`,
    });
    if (!grant) return null;
    return {
      authority: new GrantWorkspaceFilesAuthority({
        grant,
        devices: () => caps.listDevices(context.owner).map((row) => ({ device: row.device, label: row.device })),
      }),
      // Read off the rights this scope was actually derived with, exactly as the
      // production composition root does.
      writable: rights.includes("replace_workspace_text"),
      ownerFiles: rights.includes("access_owner_files"),
      contextId: grant.contextId,
      close: () => grant.destroy(),
    };
  };
}

/**
 * The trusted shell's job, in five lines: hold the handle this instance was
 * issued, forward proposals to it, and translate the answer. The identity is
 * bound ONCE, at `openInstance`, and nothing about the caller is read from a
 * proposal — there is no argument here that could carry one.
 */
function transportFor(handle: AgentResourceInstance): ProposalTransport {
  return {
    async propose(action, params = {}) {
      const answer = await handle.dispatch({ action, params });
      return answer.ok
        ? { ok: true, result: answer.result, message: "" }
        : { ok: false, code: answer.code, result: null, message: answer.message };
    },
  };
}

/** One tab: one handle, one transport, one typed port. */
function openTab(
  who: ResourceScopeIdentity = identity(),
  binding = "workspace",
): { handle: AgentResourceInstance; remote: RemoteWorkspaceFiles } {
  const handle = catalog.openInstance(who);
  return { handle, remote: createRemoteWorkspaceFilesPort(transportFor(handle), binding) };
}

function remoteFor(who: ResourceScopeIdentity = identity(), binding = "workspace"): RemoteWorkspaceFiles {
  return openTab(who, binding).remote;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "resource-binding-"));
  home = join(dir, "home");
  root = join(home, "projects", "demo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(home, "elsewhere"), { recursive: true });
  writeFileSync(join(home, "elsewhere", "secret.txt"), "not yours\n", "utf8");
  await addWorkspace(home, root, "Demo");

  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW });
  store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/bob", created_at: NOW });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", NOW);
  store.saveRunnerToken(hashRunnerToken("rt_bob"), "bob", "laptop", NOW);

  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  const transport = gateway.claimTransport();
  caps = new RunnerCapabilities(store, transport);
  files = new WorkspaceFilesCapabilities({
    service: caps.service,
    transport,
    userExists: (name) => Boolean(store.getUser(name)),
    hasDevice: (name) => store.listRunnerTokens(name).length > 0,
  });
  // A small window, so a few hundred kilobytes takes several pulls without a
  // slow fixture.
  service = new WorkspaceFilesService({ chunkBytes: 64 * 1024 });
  catalog = new AgentResourceCatalog();
  catalog.register(workspaceFilesProvider({ service, openGrant: grantFor() }));
  catalog.seal();

  // The device runs the REAL implementation against the temp home.
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  for (const method of [
    "list_session_workspaces",
    "list_workspace_entries",
    "read_workspace_text",
    "replace_workspace_text",
    "access_owner_files",
  ]) {
    handlers[method] = async (args) => {
      const response = await handleRpc(home, { id: String(frames.length), method, args }, { allowMachineOps: true });
      if (!response.ok) throw new Error(response.error);
      return response.result;
    };
  }
  frames = [];
  laptop = await startFakeRunner(gateway.port, "rt_alice", "laptop", handlers);
  frames = laptop.frames;
});

it.each(["owner", "shared", "approval"] as const)("binds v4 file links through catalog, Gate and Runner: %s", async (mode) => {
  const workspace = await addWorkspace(home, root, "Demo");
  writeFileSync(join(root, "report.md"), "file link\n");
  const scoped = new AgentResourceCatalog();
  scoped.register(workspaceFilesProviderV4({ service, directoryKeys: new WorkspaceDirectoryKeys(),
    openGrant: (context) => {
      const grant = grantFor(["access_owner_files"], mode === "approval" ? [] : ["access_owner_files"])(context);
      return grant ? { ...grant, ownerFiles: mode !== "shared" } : null;
    },
    ownerFileTarget: (owner, ref) => ownerFileSessionTarget(owner, ref, () => ({ device: "laptop", workspaceId: workspace.id })),
  }));
  scoped.seal();
  const parsed = readResourceBindings({ ...PLAN_DOC, bindings: [{ binding: "workspace", contract: "workspace-files/v4" }],
    connections: [{ instance: "files", port: "workspace-files/v4", binding: "workspace" }] });
  if (!parsed.ok) throw new Error("invalid plan");
  const handle = scoped.openInstance(identity({ instance: "v4-tab", plan: parsed.value }));
  const remote = createRemoteWorkspaceFilesPortV4(transportFor(handle), "workspace");
  try {
    const ref = resourceId({ owner: "alice", device: "history-device", cliKind: "codex", sessionId: "split-thread" });
    const resolved = await remote.port.resolveFileLink({ sessionRef: ref, href: "report.md" });
    if (mode !== "owner") {
      expect(resolved).toMatchObject({ ok: false, code: mode === "shared" ? "denied" : "approval_required" });
      expect(frames).toHaveLength(0);
      return;
    }
    expect(resolved.ok).toBe(true); if (!resolved.ok) return;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ method: "access_owner_files", args: { mode: "resolve", workspace_id: workspace.id } });
    expect(await remote.port.openText(resolved.value.entry.ref)).toMatchObject({ ok: true });
    const foreign = resourceId({ owner: "bob", device: "laptop", cliKind: "codex", sessionId: "split-thread" });
    const count = frames.length;
    expect(await remote.port.resolveFileLink({ sessionRef: foreign, href: "report.md" })).toMatchObject({ ok: false, code: "denied" });
    expect(frames).toHaveLength(count);
  } finally { remote.destroy(); await handle.close(); }
});

afterEach(async () => {
  laptop.close();
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("a module reading through the binding", () => {
  it("enumerates roots, walks a directory and streams a file", async () => {
    writeFileSync(join(root, "src", "a.ts"), "第一行\nexport const a = 1;\n", "utf8");
    const remote = remoteFor(identity());

    const roots = await remote.port.refreshRoots();
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.value.roots.map((row) => row.label)).toEqual(["Demo"]);

    const listing = await remote.port.listDirectory(roots.value.roots[0].ref);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const src = listing.value.entries.find((row) => row.label === "src")!;

    const inner = await remote.port.listDirectory(src.ref!);
    expect(inner.ok).toBe(true);
    if (!inner.ok) return;
    const opened = await remote.port.openText(inner.value.entries[0].ref!);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const drained = await drainResourceStream(opened.value.stream);
    expect(drained.chunks.map((row) => row.text).join("")).toBe("第一行\nexport const a = 1;\n");
    expect(drained.terminal.kind).toBe("end");
    // Nothing on the wire names a machine, a workspace id or a path.
    const wire = JSON.stringify([roots.value, listing.value, opened.value.document]);
    expect(wire).not.toContain("ws_");
    expect(wire).not.toContain(root);
    expect(wire).not.toContain(home);
  });

  it("streams a large file in bounded, in-order windows that reassemble exactly", async () => {
    const text = "行".repeat(60_000);
    writeFileSync(join(root, "big.txt"), text, "utf8");
    const remote = remoteFor(identity());
    const roots = await remote.port.refreshRoots();
    if (!roots.ok) throw new Error("roots");
    const listing = await remote.port.listDirectory(roots.value.roots[0].ref);
    if (!listing.ok) throw new Error("listing");
    const big = listing.value.entries.find((row) => row.label === "big.txt")!;

    const opened = await remote.port.openText(big.ref!);
    if (!opened.ok) throw new Error(`open refused: ${opened.code}`);
    const drained = await drainResourceStream(opened.value.stream);

    expect(drained.chunks.map((row) => row.text).join("")).toBe(text);
    expect(drained.chunks.length).toBeGreaterThan(1);
    expect(drained.seqs).toEqual(drained.seqs.map((_row, index) => index));
    expect(drained.terminal).toEqual({
      kind: "end",
      chunks: drained.chunks.length,
      bytes: Buffer.byteLength(text, "utf8"),
    });
  });

  it("refuses a forged ref, a foreign ref and a wrong-kind ref before any frame", async () => {
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    const mine = remoteFor(identity());
    const roots = await mine.port.refreshRoots();
    if (!roots.ok) throw new Error("roots");
    const dirRef = roots.value.roots[0].ref;
    const listing = await mine.port.listDirectory(dirRef);
    if (!listing.ok) throw new Error("listing");
    const fileRef = listing.value.entries.find((row) => row.label === "a.txt")!.ref!;

    // A second tab of the SAME person: a different scope, so a ref minted in one
    // is meaningless in the other.
    const otherTab = remoteFor(identity({ instance: "tab-2" }));
    await otherTab.port.refreshRoots();
    const before = frames.length;

    expect(await mine.port.openText("wf_forged")).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await mine.port.openText(dirRef)).toMatchObject({ ok: false, code: "wrong_kind" });
    expect(await mine.port.listDirectory(fileRef)).toMatchObject({ ok: false, code: "wrong_kind" });
    expect(await otherTab.port.openText(fileRef)).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await otherTab.port.listDirectory(dirRef)).toMatchObject({ ok: false, code: "unknown_ref" });
    // `../`, absolute paths and NUL are not refusals — they are UNSAYABLE.
    for (const attempt of ["../elsewhere/secret.txt", "/etc/passwd", "a\u0000b", ""]) {
      expect(await mine.port.openText(attempt)).toMatchObject({ ok: false, code: "unknown_ref" });
    }

    expect(frames).toHaveLength(before);
  });

  it("refuses a ref across publishers, even with the same app and instance id", async () => {
    // A stable app id is chosen by whoever publishes one, so two publishers may
    // pick `demo`. If the scope key did not carry the publisher, their refs,
    // streams and retirement records would be one namespace — and the second
    // publisher would resolve the first's file handles.
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    const first = remoteFor(identity({ publisher: "octopus:first-party" }));
    const roots = await first.port.refreshRoots();
    if (!roots.ok) throw new Error("roots");
    const dirRef = roots.value.roots[0].ref;
    const listing = await first.port.listDirectory(dirRef);
    if (!listing.ok) throw new Error("listing");
    const fileRef = listing.value.entries.find((row) => row.label === "a.txt")!.ref!;

    const impostor = remoteFor(identity({ publisher: "someone:else" }));
    await impostor.port.refreshRoots();
    const before = frames.length;

    expect(await impostor.port.openText(fileRef)).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await impostor.port.listDirectory(dirRef)).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(frames).toHaveLength(before);
  });

  it("never reopens a retired instance, and a late proposal on it reaches no device", async () => {
    const { handle } = openTab();
    expect(await handle.dispatch({ action: "resource.refresh_roots", params: { binding: "workspace" } }))
      .toMatchObject({ ok: true });
    await handle.close();
    const before = frames.length;

    // The id is retired for good. Re-opening it would undo what the close meant:
    // a handle whose owner's credential was just replaced would start answering
    // again from new authority, with nobody having decided that. A new tab gets
    // a new instance id, which is where a fresh decision belongs.
    expect(() => catalog.openInstance(identity({ instance: "tab-1" }))).toThrow(/已经结束/);
    // And the message that was already in flight on the old channel finds a
    // closed handle rather than opening a provider for the first time.
    expect(await handle.dispatch({ action: "resource.refresh_roots", params: { binding: "workspace" } }))
      .toMatchObject({ ok: false, code: "scope_closed" });
    expect(frames).toHaveLength(before);
  });

  it("gives another account nothing, and touches no device doing it", async () => {
    const before = frames.length;
    // Bob has a registered device, so his plane does hold authority — but the
    // device set it names is HIS, and his laptop is not connected. What matters
    // is the second assertion: Alice's laptop, which is connected and has the
    // workspace, was never consulted.
    const bob = remoteFor(identity({ owner: "bob" }));
    const roots = await bob.port.refreshRoots();

    expect(roots.ok).toBe(false);
    expect(frames).toHaveLength(before);
  });

  it("refuses a binding this App's plan does not declare, before any frame", async () => {
    const before = frames.length;
    const wrong = remoteFor(identity(), "secrets");
    expect(await wrong.port.refreshRoots()).toMatchObject({ ok: false, code: "invalid_request" });
    expect(frames).toHaveLength(before);
  });

  it("refuses an action outside the provider's closed set", async () => {
    const { handle } = openTab();
    // `resource.replace_text` used to be the example here; it is served now, so
    // the example has to be something that really is outside the set — otherwise
    // this test would keep passing while checking nothing.
    const answer = await handle.dispatch({
      action: "resource.delete_file",
      params: { binding: "workspace", ref: "wf_x" },
    });
    expect(answer).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("does not follow a symlink, because there is nothing to submit", async () => {
    symlinkSync(join(home, "elsewhere", "secret.txt"), join(root, "peek.txt"));
    const remote = remoteFor(identity());
    const roots = await remote.port.refreshRoots();
    if (!roots.ok) throw new Error("roots");
    const listing = await remote.port.listDirectory(roots.value.roots[0].ref);
    if (!listing.ok) throw new Error("listing");

    expect(listing.value.entries.find((row) => row.label === "peek.txt")).toEqual({
      label: "peek.txt",
      kind: "other",
    });
  });
});

describe("writing through the binding", () => {
  /** One `resource.replace_text` proposal, exactly as the dispatcher receives it. */
  async function propose(
    handle: AgentResourceInstance,
    params: Record<string, string>,
  ): Promise<{ ok: boolean; code?: string; result?: unknown }> {
    return await handle.dispatch({ action: RESOURCE_ACTIONS.replaceText, params: { binding: "workspace", ...params } });
  }

  /** Open a file through the typed port and hand back its ref and digest. */
  async function openFile(
    remote: RemoteWorkspaceFiles,
    label: string,
  ): Promise<{ ref: string; digest: string }> {
    const roots = await remote.port.refreshRoots();
    if (!roots.ok) throw new Error(`roots refused: ${roots.code}`);
    const listing = await remote.port.listDirectory(roots.value.roots[0].ref);
    if (!listing.ok) throw new Error(`listing refused: ${listing.code}`);
    const ref = listing.value.entries.find((row) => row.label === label)?.ref;
    if (!ref) throw new Error(`no ref for ${label}`);
    const opened = await remote.port.openText(ref);
    if (!opened.ok) throw new Error(`open refused: ${opened.code}`);
    await opened.value.stream.close();
    return { ref, digest: opened.value.document.digest };
  }

  /**
   * Approve the one card this account is holding, and hand back what ran.
   *
   * Every write made by the default grant in these tests becomes a card. The
   * account root is only a ceiling; a child must explicitly opt into owner-local
   * silent writes, as the dedicated test below does. The result comes back to
   * the approver rather than to the port, which is why the proposal above
   * already answered `approval_required`.
   */
  async function approveOnly(operation: string): Promise<{ status: string; result?: unknown }> {
    const cards = caps.listPending("alice").filter((row) => row.operation === operation);
    expect(cards).toHaveLength(1);
    return await caps.service.approve(cards[0].id, "alice");
  }

  it("reads a file, and replaces it once its owner approves", async () => {
    writeFileSync(join(root, "notes.md"), "第一版\n", "utf8");
    const { handle, remote } = openTab();
    const { ref, digest } = await openFile(remote, "notes.md");

    const proposed = await propose(handle, { ref, expected_digest: digest, text: "第二版\n" });
    // Nothing has been written yet, and the answer says why.
    expect(proposed).toMatchObject({ ok: false, code: "approval_required" });
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("第一版\n");

    const ran = await approveOnly("replace_workspace_text");

    expect(ran.status).toBe("succeeded");
    // The real file on the real device, through a real socket.
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("第二版\n");
    expect(ran.result).toMatchObject({
      status: "ok",
      previous_digest: digest,
      size: Buffer.byteLength("第二版\n", "utf8"),
      encoding: "utf-8",
    });
    // Even the device's own answer, which never crosses to a View, carries no
    // canonical path.
    const wire = JSON.stringify(ran.result);
    expect(wire).not.toContain(root);
    expect(wire).not.toContain(home);
  });

  it("refuses a stale edit somebody else overtook while the card was waiting", async () => {
    writeFileSync(join(root, "shared.md"), "原始\n", "utf8");
    const { handle, remote } = openTab();
    const { ref, digest } = await openFile(remote, "shared.md");

    expect(await propose(handle, { ref, expected_digest: digest, text: "我的版本\n" }))
      .toMatchObject({ ok: false, code: "approval_required" });
    // Minutes pass between the card being made and somebody pressing it. That is
    // exactly the window a compare-and-swap exists for, and it is why the
    // precondition is checked on the DEVICE at execution rather than here at
    // proposal time.
    writeFileSync(join(root, "shared.md"), "别人的版本\n", "utf8");

    const ran = await approveOnly("replace_workspace_text");

    expect(ran.status).toBe("succeeded");
    expect(ran.result).toEqual({ status: "refused", code: "digest_mismatch" });
    expect(readFileSync(join(root, "shared.md"), "utf8")).toBe("别人的版本\n");
  });

  it("cannot apply one approved edit twice", async () => {
    writeFileSync(join(root, "once.md"), "一\n", "utf8");
    const { handle, remote } = openTab();
    const { ref, digest } = await openFile(remote, "once.md");
    const params = { ref, expected_digest: digest, text: "二\n" };

    await propose(handle, params);
    expect((await approveOnly("replace_workspace_text")).status).toBe("succeeded");
    expect(readFileSync(join(root, "once.md"), "utf8")).toBe("二\n");

    // Replaying the identical proposal — the shape a retry, a double click or an
    // interrupt-recovery replay takes — cannot apply it a second time.
    await propose(handle, params);
    const replay = await approveOnly("replace_workspace_text");
    expect(replay.result).toEqual({ status: "refused", code: "digest_mismatch" });
    expect(readFileSync(join(root, "once.md"), "utf8")).toBe("二\n");
  });

  // A directory's permissions do not bind root, and there is no honest way to
  // simulate that; a silently vacuous run would be worse than a skip.
  const asUser = process.getuid?.() === 0 ? it.skip : it;
  asUser("leaves the previous content whole when the swap itself fails", async () => {
    const locked = join(root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "a.txt"), "原始内容\n", "utf8");
    const { handle, remote } = openTab();
    const roots = await remote.port.refreshRoots();
    if (!roots.ok) throw new Error("roots");
    const top = await remote.port.listDirectory(roots.value.roots[0].ref);
    if (!top.ok) throw new Error("listing");
    const dirRef = top.value.entries.find((row) => row.label === "locked")!.ref!;
    const inner = await remote.port.listDirectory(dirRef);
    if (!inner.ok) throw new Error("inner listing");
    const ref = inner.value.entries.find((row) => row.label === "a.txt")!.ref!;
    const opened = await remote.port.openText(ref);
    if (!opened.ok) throw new Error("open");
    await opened.value.stream.close();

    chmodSync(locked, 0o555);
    try {
      await propose(handle, {
        ref,
        expected_digest: opened.value.document.digest,
        text: "新内容\n",
      });
      const ran = await approveOnly("replace_workspace_text");
      // The floor this whole shape exists for: a write that could not happen
      // leaves the old file byte for byte, and no half-written temp behind.
      expect(ran.result).toEqual({ status: "refused", code: "denied" });
      expect(readFileSync(join(locked, "a.txt"), "utf8")).toBe("原始内容\n");
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(readdirSync(locked).sort()).toEqual(["a.txt"]);
  });

  it("gives a scope without the write nothing to write with, and touches no device", async () => {
    writeFileSync(join(root, "a.txt"), "a\n", "utf8");
    const readOnly = new AgentResourceCatalog();
    readOnly.register(workspaceFilesProvider({
      service,
      openGrant: grantFor(["list_session_workspaces", "list_workspace_entries", "read_workspace_text"]),
    }));
    readOnly.seal();
    const handle = readOnly.openInstance(identity({ instance: "read-only-tab" }));
    const remote = createRemoteWorkspaceFilesPort(transportFor(handle), "workspace");
    const { ref, digest } = await openFile(remote, "a.txt");

    const before = frames.length;
    const answer = await propose(handle, { ref, expected_digest: digest, text: "pwned\n" });

    expect(answer).toMatchObject({ ok: false, code: "read_only" });
    expect(frames).toHaveLength(before);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    await readOnly.shutdown();
  });

  it("keeps a write behind a card when the child grant does not opt in", async () => {
    writeFileSync(join(root, "a.txt"), "a\n", "utf8");
    // The owner root permits the full closed table as a ceiling, but this child
    // asks to auto-allow only reads. The write therefore remains supervised.
    const supervised = new AgentResourceCatalog();
    supervised.register(workspaceFilesProvider({
      service,
      openGrant: grantFor(undefined, [
        "list_session_workspaces",
        "list_workspace_entries",
        "read_workspace_text",
      ]),
    }));
    supervised.seal();
    const handle = supervised.openInstance(identity({ instance: "supervised-write" }));
    const remote = createRemoteWorkspaceFilesPort(transportFor(handle), "workspace");
    const { ref, digest } = await openFile(remote, "a.txt");

    // The body has to be distinctive enough that "not in the card details"
    // means "the body was not leaked" and nothing else. A single letter + LF
    // like "b\n" collides on ~6% of runs with the last hex nibble of the
    // opaque `ws_<24 hex>` workspace id when `details.join("\n")` puts that
    // nibble immediately before the next field's newline — a false positive
    // that pipeline #15 finally caught. Keeping the assertion phrased as
    // "the body is not in the card"; the fix is to pick a body that could
    // never coincidentally appear elsewhere.
    const secretBody = "pwned-body-do-not-leak\n";
    const answer = await propose(handle, { ref, expected_digest: digest, text: secretBody });

    expect(answer).toMatchObject({ ok: false, code: "approval_required" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    const card = caps.listPending("alice").find((row) => row.operation === "replace_workspace_text");
    expect(card?.target).toBe("alice/laptop");
    // The card says how much lands and that nothing is kept — the two facts a
    // read's card does not have to carry.
    expect(card?.details.join("\n")).toContain("将写入");
    expect(card?.details.join("\n")).toContain("不保留可撤销的旧副本");
    // And it does not carry the content itself.
    expect(card?.details.join("\n")).not.toContain(secretBody);
    expect(card?.details.join("\n")).not.toContain("pwned-body");
    await supervised.shutdown();
  });

  it("lets an owner-local child explicitly auto-allow the CAS write", async () => {
    writeFileSync(join(root, "silent.txt"), "old\n", "utf8");
    const silent = new AgentResourceCatalog();
    silent.register(workspaceFilesProvider({
      service,
      openGrant: grantFor(undefined, [
        "list_session_workspaces",
        "list_workspace_entries",
        "read_workspace_text",
        "replace_workspace_text",
      ]),
    }));
    silent.seal();
    const handle = silent.openInstance(identity({ instance: "silent-write" }));
    const remote = createRemoteWorkspaceFilesPort(transportFor(handle), "workspace");
    const { ref, digest } = await openFile(remote, "silent.txt");

    const answer = await propose(handle, { ref, expected_digest: digest, text: "owner-local\n" });

    expect(answer).toMatchObject({ ok: true });
    expect(readFileSync(join(root, "silent.txt"), "utf8")).toBe("owner-local\n");
    expect(caps.listPending("alice").filter((row) => row.operation === "replace_workspace_text"))
      .toEqual([]);
    await silent.shutdown();
  });

  it("saves through the Agent View's own port, once its owner approves", async () => {
    // P6a could not: a file body did not fit in a 512-character proposal
    // parameter, so the client had no `replaceText` at all. The editor batch
    // raised the bound for ONE declared parameter, and this is the whole path an
    // editor module actually uses — port method, proposal, provider, Gate, card,
    // device, file.
    writeFileSync(join(root, "editor.md"), "旧内容\n", "utf8");
    const { remote } = openTab();
    expect(workspaceFilesCanWrite(remote.port)).toBe(true);
    expect([...WORKSPACE_FILES_WIRE_ACTIONS]).toContain("replace_text");
    const { ref, digest } = await openFile(remote, "editor.md");

    const saved = await remote.port.replaceText!(ref, { expectedDigest: digest, text: "新内容\n" });

    // "Submitted, waiting for a person" is the normal outcome of a save, and it
    // is what the panel renders. Nothing has been written.
    expect(saved).toMatchObject({ ok: false, code: "approval_required" });
    expect(readFileSync(join(root, "editor.md"), "utf8")).toBe("旧内容\n");

    const ran = await approveOnly("replace_workspace_text");
    expect(ran.status).toBe("succeeded");
    expect(readFileSync(join(root, "editor.md"), "utf8")).toBe("新内容\n");
    // Re-reading is how the panel confirms — the result went to the approver.
    const reopened = await remote.port.openText(ref);
    if (!reopened.ok) throw new Error(`reopen refused: ${reopened.code}`);
    expect(reopened.value.document.digest).not.toBe(digest);
    await reopened.value.stream.close();
  });

  it("carries a body far larger than one ordinary parameter", async () => {
    // The reason the fuse moved. 512 characters was every parameter's bound;
    // this is a real file going through the real dispatcher.
    const text = `${"行".repeat(50_000)}\n`;
    writeFileSync(join(root, "long.md"), "短\n", "utf8");
    const { remote } = openTab();
    const { ref, digest } = await openFile(remote, "long.md");

    expect(await remote.port.replaceText!(ref, { expectedDigest: digest, text })).toMatchObject({
      ok: false,
      code: "approval_required",
    });
    expect((await approveOnly("replace_workspace_text")).status).toBe("succeeded");
    expect(readFileSync(join(root, "long.md"), "utf8")).toBe(text);
  });

  it("stages a body over one call's window, and under per-call approval stops at its first card", async () => {
    // 2026-10-20: the window is per call, so a larger body is a staged upload
    // rather than a local refusal. Every step spends the same write operation
    // through the Gate, so in a scope where each write is approved the very
    // first step (begin) makes ONE card, nothing further is sent, and nothing
    // touches the file.
    writeFileSync(join(root, "guard.md"), "短\n", "utf8");
    const { remote } = openTab();
    const { ref, digest } = await openFile(remote, "guard.md");
    const before = frames.length;

    const out = await remote.port.replaceText!(ref, {
      expectedDigest: digest,
      text: "x".repeat(WORKSPACE_FILES_LIMITS.maxWriteTextBytes + 1),
    });

    expect(out).toMatchObject({ ok: false, code: "approval_required" });
    const cards = caps.listPending("alice").filter((row) => row.operation === "replace_workspace_text");
    expect(cards).toHaveLength(1);
    expect(frames).toHaveLength(before);
    expect(readFileSync(join(root, "guard.md"), "utf8")).toBe("短\n");
  });

  it("does not tell the View that a stale save was stale — the approver learns it", async () => {
    // Worth pinning because it shapes the editor's UI. Every write is approved
    // individually, so the port's answer is `approval_required` and the outcome
    // — including a compare-and-swap that failed — goes to whoever pressed the
    // button. A panel therefore cannot report "saved" or "conflict" on its own;
    // it says "submitted, waiting" and offers a re-read. `digest_mismatch` at
    // the port is a shape it must still handle (a harness produces it, and so
    // would any scope where the write were not card-gated), but on this path it
    // is not what arrives.
    writeFileSync(join(root, "raced.md"), "第一版\n", "utf8");
    const { remote } = openTab();
    const { ref, digest } = await openFile(remote, "raced.md");
    writeFileSync(join(root, "raced.md"), "别人的版本\n", "utf8");

    expect(await remote.port.replaceText!(ref, { expectedDigest: digest, text: "我的版本\n" })).toMatchObject({
      ok: false,
      code: "approval_required",
    });
    const ran = await approveOnly("replace_workspace_text");

    expect(ran.result).toEqual({ status: "refused", code: "digest_mismatch" });
    expect(readFileSync(join(root, "raced.md"), "utf8")).toBe("别人的版本\n");
  });

  it("refuses a save on a read-only scope, and touches no device", async () => {
    // The other sentence a panel has to be able to render: this port CAN write,
    // this scope may not. Two different things, and P6a's port docstring says
    // why conflating them either hides a working button or offers a broken one.
    const readOnly = new AgentResourceCatalog();
    readOnly.register(workspaceFilesProvider({
      service,
      openGrant: grantFor(["list_session_workspaces", "list_workspace_entries", "read_workspace_text"]),
    }));
    readOnly.seal();
    const handle = readOnly.openInstance(identity({ instance: "read-only-tab" }));
    const remote = createRemoteWorkspaceFilesPort(transportFor(handle), "workspace");
    writeFileSync(join(root, "locked.md"), "只读\n", "utf8");
    const { ref, digest } = await openFile(remote, "locked.md");
    const before = frames.length;

    expect(workspaceFilesCanWrite(remote.port)).toBe(true);
    expect(await remote.port.replaceText!(ref, { expectedDigest: digest, text: "改了\n" })).toMatchObject({
      ok: false,
      code: "read_only",
    });
    expect(frames).toHaveLength(before);
    expect(caps.listPending("alice").filter((row) => row.operation === "replace_workspace_text")).toEqual([]);
    await readOnly.shutdown();
  });
});

describe("ending a scope", () => {
  it("closes the streams and the capability, and refuses afterwards", async () => {
    writeFileSync(join(root, "big.txt"), "行".repeat(60_000), "utf8");
    const remote = remoteFor(identity());
    const roots = await remote.port.refreshRoots();
    if (!roots.ok) throw new Error("roots");
    const listing = await remote.port.listDirectory(roots.value.roots[0].ref);
    if (!listing.ok) throw new Error("listing");
    const opened = await remote.port.openText(listing.value.entries.find((row) => row.label === "big.txt")!.ref!);
    if (!opened.ok) throw new Error(`open refused: ${opened.code}`);
    expect(await opened.value.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    expect(service.openStreams).toBe(1);

    await catalog.closeInstance({ owner: "alice", publisher: "octopus:first-party", app: "demo", instance: "tab-1" });

    expect(service.openStreams).toBe(0);
    const framesAfterClose = frames.length;
    expect(await opened.value.stream.next()).toMatchObject({ kind: "refused" });
    expect(await remote.port.refreshRoots()).toMatchObject({ ok: false, code: "scope_closed" });
    // Nothing reached the device after the scope ended.
    expect(frames).toHaveLength(framesAfterClose);
  });

  it("ends every open scope when the device set changes, before the new credential exists", async () => {
    files.attachToRunnerLifecycle(caps, (owner) => {
      void catalog.closeOwner(owner);
    });
    const remote = remoteFor(identity());
    expect((await remote.port.refreshRoots()).ok).toBe(true);
    expect(catalog.openScopes).toBe(1);

    caps.mintDeviceToken("alice", "laptop");

    // Closed on return, whatever the release is still doing.
    expect(catalog.openScopes).toBe(0);
    const framesBefore = frames.length;
    expect(await remote.port.refreshRoots()).toMatchObject({ ok: false });
    expect(frames).toHaveLength(framesBefore);
  });

  it("holds nothing for an account whose last device is gone", async () => {
    store.deleteRunnerToken("alice", "laptop");
    const remote = remoteFor(identity({ instance: "tab-fresh" }));
    expect(await remote.port.refreshRoots()).toMatchObject({ ok: false, code: "no_authority" });
  });
});

describe("approval", () => {
  it("makes a card rather than a read when the grant does not auto-allow", async () => {
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    const supervised = new AgentResourceCatalog();
    supervised.register(workspaceFilesProvider({ service, openGrant: grantFor(undefined, []) }));
    supervised.seal();
    const handle = supervised.openInstance(identity({ instance: "supervised" }));
    const transport: ProposalTransport = {
      async propose(action, params = {}) {
        const answer = await handle.dispatch({ action, params });
        return answer.ok
          ? { ok: true, result: answer.result, message: "" }
          : { ok: false, code: answer.code, result: null, message: answer.message };
      },
    };
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");

    const before = frames.length;
    const roots = await remote.port.refreshRoots();

    // A read that needs a person becomes a card, not a value — and the laptop
    // has done nothing yet.
    expect(roots).toMatchObject({ ok: false, code: "approval_required" });
    expect(frames).toHaveLength(before);
    const card = caps.listPending("alice").find((row) => row.operation === "list_session_workspaces");
    expect(card?.target).toBe("alice/laptop");
    await supervised.shutdown();
  });

  it("never re-issues a refused read on its own", async () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x00]));
    const remote = remoteFor(identity());
    const roots = await remote.port.refreshRoots();
    if (!roots.ok) throw new Error("roots");
    const listing = await remote.port.listDirectory(roots.value.roots[0].ref);
    if (!listing.ok) throw new Error("listing");
    const binary = listing.value.entries.find((row) => row.label === "bin.dat")!.ref!;

    const before = frames.filter((row) => row.method === "read_workspace_text").length;
    expect(await remote.port.openText(binary)).toMatchObject({ ok: false, code: "not_text" });
    // Exactly one attempt. Nothing behind this port retries, so a revoked grant
    // cannot become a stream of approval cards.
    expect(frames.filter((row) => row.method === "read_workspace_text")).toHaveLength(before + 1);
  });
});

describe("the proposal cannot name anything", () => {
  it("ignores owner, scope and instance claims in the params", async () => {
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    const mine = remoteFor(identity());
    const roots = await mine.port.refreshRoots();
    if (!roots.ok) throw new Error("roots");

    // Straight at Bob's handle, with everything a hostile View might try to
    // claim in order to be served as Alice.
    const { handle } = openTab(identity({ owner: "bob" }));
    const answer = await handle.dispatch({
      action: RESOURCE_ACTIONS.listDirectory,
      params: {
        binding: "workspace",
        ref: roots.value.roots[0].ref,
        owner: "alice",
        scope: JSON.stringify(["alice", "demo", "tab-1", "workspace"]),
        instance: "tab-1",
        device: "laptop",
        workspace_id: "ws_000000000000000000000000",
        approved: "true",
      },
    });

    // Bob's scope, Alice's ref: not resolvable, and no frame.
    expect(answer).toMatchObject({ ok: false });
    if (answer.ok) return;
    expect(answer.code).toBe("unknown_ref");
  });
});
