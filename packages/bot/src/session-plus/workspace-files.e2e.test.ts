/**
 * The production path, end to end, with nothing mocked in the middle.
 *
 * A module holding a typed `WorkspaceFilesPort` → the contract's remote client →
 * a proposal → `SessionPlusAppService.dispatch` → the instance handle the
 * catalog issued → the App's shipped binding plan → the SAME grant decision the
 * panel makes (`sessionPlusWorkspaceGrant`) → `grant_intents` → the capability
 * Gate → the independent `workspace-files-runner-v2` Object → a real WebSocket
 * → the real device implementation over a real temp home → and back through the
 * real ref vault, the real stream broker and the contract's own readers.
 *
 * `agent-resources/workspace-files.e2e.test.ts` proves the catalog half of this
 * with a stand-in grant. What this file adds is the two things only production
 * wiring has: the App instance lifecycle (a handle per tab, opened before the
 * tab reads anything and closed with it) and the REAL authorisation decision,
 * so "no consent means no laptop is touched" is a statement about the thing that
 * actually runs.
 *
 * Every assertion about a device is an assertion about FRAMES. "The device was
 * never touched" means no approval card was created and no laptop did any work —
 * which is a stronger claim than "the call was refused".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleRpc } from "@claude-bot/runner/core";
import { addWorkspace } from "@claude-bot/runner/workspaces";
import { AppRuntimeService, InProcessRuntimeClient } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { connectionFor } from "@claude-bot/agent-module-contract";
import {
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_FILES_CONTRACT_V4,
  createRemoteWorkspaceFilesPort,
  createRemoteWorkspaceFilesPortV4,
  workspaceFilesCanWrite,
  workspaceListCursorAfter,
  type ProposalTransport,
  type RemoteWorkspaceFilesV4,
} from "@claude-bot/workspace-files-contract";
import { drainResourceStream } from "@claude-bot/resource-stream-contract";
import { SESSION_PLUS_RESOURCE_BINDINGS, WORKSPACE_BINDING } from "@claude-bot/session-plus-view/plan";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "../runner/gateway.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { startFakeRunner, type FakeRunner } from "../runner/fake-runner.helper.js";
import { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { WorkspaceFilesService } from "../workspace-files/service.js";
import { AgentResourceCatalog } from "../agent-resources/catalog.js";
import {
  workspaceFilesProvider,
  workspaceFilesProviderV2,
  workspaceFilesProviderV3,
  workspaceFilesProviderV4,
} from "../agent-resources/workspace-files-provider.js";
import type { ResourceProviderContext } from "../agent-resources/types.js";
import { WorkspaceDirectoryKeys } from "../workspace-files/directory-key.js";
import { PermissionService } from "../permissions/service.js";
import { sessionPlusSubjectEntry } from "../session-resource/catalog.js";
import { IntentGrantResolver } from "../session-resource/intent-resolver.js";
import { sessionPlusWorkspaceGrant } from "../session-resource/workspace-grant.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS,
  SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT,
  sessionPlusPermissionContractDigest,
} from "../session-resource/contract.js";
import { bundledAppDir } from "../app-core/app-path.js";
import { SessionPlusAppService } from "./app-service.js";
import { sessionPlusIdentity } from "../app-core/identity.js";

const NOW = "2026-08-06T00:00:00.000Z";
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n%%EOF\n",
  "utf8",
);
const BINARY_BYTES = Buffer.alloc(70 * 1024, 0xa5);
const CURRENT_CONTRACT_DIGEST = sessionPlusPermissionContractDigest(
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT,
);

let dir: string;
let home: string;
let root: string;
let store: Store;
let gateway: RunnerGateway;
let caps: RunnerCapabilities;
let files: WorkspaceFilesCapabilities;
let service: WorkspaceFilesService;
let catalog: AgentResourceCatalog;
let permissions: PermissionService;
let app: SessionPlusAppService;
let state: AppStateService;
let runtime: AppRuntimeService;
let laptop: FakeRunner;
/** Every frame that reached a device, in order. */
let frames: Array<{ method: string; args: Record<string, unknown> }>;
/** Every actual workspace grant derivation, recorded at the provider's sole grant seam. */
let workspaceGrantContexts: ResourceProviderContext[];

const alice = { owner: "alice", credential: "ws:one", session: true };

/**
 * One browser tab, as the panel opens it.
 *
 * The transport is the trusted shell's job in four lines: forward the proposal
 * to the App service with the handle THIS tab holds, and translate the answer.
 * There is nothing here a View could put an identity into.
 */
async function openTab(principal = alice): Promise<{
  handle: string;
  remote: RemoteWorkspaceFilesV4;
  transport: ProposalTransport;
}> {
  const opened = await app.open(principal);
  const transport: ProposalTransport = {
    async propose(action, params = {}) {
      const answer = await app.dispatch(opened.handle, principal, { action, params }, opened.resourceGeneration);
      if (answer.ok) return { ok: true, result: answer.result, message: "" };
      return {
        ok: false,
        code: answer.code === "resource_refused" ? String(answer.resourceCode) : answer.code,
        result: null,
        message: answer.message,
      };
    },
  };
  // The current release binds `workspace-files/v4`: text read/write, bounded
  // image/PDF preview and explicit regular-file download on one opaque-ref port.
  return {
    handle: opened.handle,
    remote: createRemoteWorkspaceFilesPortV4(transport, WORKSPACE_BINDING),
    transport,
  };
}

/** Record the current release's consent for one owner, as the permission page would. */
function grantWorkspaceOperations(
  owner: string,
  operations: readonly string[] = SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS,
  autoAllow: readonly string[] = SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT.autoAllow,
): void {
  permissions.grant({
    subjectType: "app",
    subjectId: SESSION_PLUS_APP_ID,
    owner,
    operations: [...operations],
    autoAllow: [...autoAllow],
    source: "user",
    createdBy: owner,
    contractDigest: CURRENT_CONTRACT_DIGEST,
    publisher: SESSION_PLUS_PUBLISHER,
  });
}

beforeEach(async () => {
  // Owner-root descent intentionally uses bounded directory listings. Keep
  // this suite's real files under its checkout, not a shared /tmp whose other
  // jobs can push the random fixture beyond the 500-entry listing window.
  dir = mkdtempSync(join(process.cwd(), "session-plus-files-"));
  home = join(dir, "home");
  root = join(home, "projects", "demo");
  mkdirSync(join(root, "src"), { recursive: true });
  await addWorkspace(home, root, "Demo");
  writeFileSync(join(root, "src", "a.ts"), "第一行\nexport const a = 1;\n", "utf8");
  writeFileSync(join(root, "sample.pdf"), PDF_BYTES);
  writeFileSync(join(root, "archive.bin"), BINARY_BYTES);

  store = new Store(join(dir, "bot.db"));
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
  permissions = new PermissionService({
    store,
    caps,
    // The third plane, so the permission projection can say what this account
    // actually holds rather than reporting `account_lacks_operation` forever.
    workspaceFiles: files,
    bootstrapSessionHub: false,
    // The subject exactly as the panel composes it, declaring the ask of the
    // release being served.
    subjects: [sessionPlusSubjectEntry(() => SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT)],
  });
  service = new WorkspaceFilesService({ chunkBytes: 64 * 1024 });
  catalog = new AgentResourceCatalog();
  // The SAME decision the panel makes. Not a copy of it.
  const resolveWorkspaceGrant = sessionPlusWorkspaceGrant({
    capabilities: files,
    grants: new IntentGrantResolver(permissions),
    devices: (owner) => caps.listDevices(owner).map((row) => ({ device: row.device, label: row.device })),
  });
  workspaceGrantContexts = [];
  const openGrant = (context: ResourceProviderContext) => {
    workspaceGrantContexts.push(context);
    return resolveWorkspaceGrant(context);
  };
  catalog.register(workspaceFilesProvider({ service, openGrant }));
  // All rollback targets plus the current media-capable binding. They share
  // one scope only when a release plan names one of them.
  const directoryKeys = new WorkspaceDirectoryKeys();
  catalog.register(workspaceFilesProviderV2({ service, openGrant, directoryKeys }));
  catalog.register(workspaceFilesProviderV3({ service, openGrant, directoryKeys }));
  catalog.register(workspaceFilesProviderV4({ service, openGrant, directoryKeys }));
  catalog.seal();

  state = new AppStateService(join(dir, "state"));
  runtime = new AppRuntimeService(bundledAppDir("session-plus"));
  app = new SessionPlusAppService({
    state: new InProcessStateClient(state),
    runtime: new InProcessRuntimeClient(runtime),
    identity: sessionPlusIdentity(),
  });
  app.attachAuthority(
    { open: () => ({}), destroy: () => true },
    undefined,
    undefined,
    {
      planFor: () => SESSION_PLUS_RESOURCE_BINDINGS,
      openInstance: (identity) => catalog.openInstance(identity),
    },
  );

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  for (const method of [
    "list_session_workspaces",
    "list_workspace_entries",
    "access_owner_files",
    "replace_owner_text",
    "read_workspace_text",
    "read_workspace_binary",
    "download_workspace_file",
    "replace_workspace_text",
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

afterEach(async () => {
  app?.stop();
  if (catalog) await catalog.shutdown();
  laptop?.close();
  if (gateway) await gateway.stop();
  if (runtime) await runtime.stop();
  state?.close();
  caps?.service.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("clicking a file in a real Session Plus release", () => {
  it("keeps both v4 document-panel families on one binding, provider scope, vault and grant", async () => {
    grantWorkspaceOperations("alice");
    const tab = await openTab();

    // These are the two duplicable panel families shipped by the release. A
    // derived panel inherits the prototype's connection; its runtime panel id
    // is layout state and therefore has no place in this trusted request path.
    const prototypes = ["file-viewer", "editor"] as const;
    expect(SESSION_PLUS_RESOURCE_BINDINGS.templates.map((row) => row.instance))
      .toEqual(expect.arrayContaining([...prototypes]));
    const panels = prototypes.map((instance) => {
      const connection = connectionFor(
        SESSION_PLUS_RESOURCE_BINDINGS,
        instance,
        WORKSPACE_FILES_CONTRACT_V4,
      );
      if (!connection) throw new Error(`release template ${instance} lost its workspace connection`);
      expect(connection.binding).toBe(WORKSPACE_BINDING);
      return createRemoteWorkspaceFilesPortV4(tab.transport, connection.binding);
    });

    const viewerRoots = await panels[0].port.refreshRoots();
    const editorRoots = await panels[1].port.refreshRoots();
    expect(viewerRoots.ok).toBe(true);
    expect(editorRoots.ok).toBe(true);
    if (!viewerRoots.ok || !editorRoots.ok) return;

    // Same opaque ref is direct evidence that both clients reached the same
    // scope-local vault rather than two provider instances that happen to list
    // the same device workspace.
    expect(editorRoots.value.roots[0]!.ref).toBe(viewerRoots.value.roots[0]!.ref);
    expect(catalog.openScopes).toBe(1);
    expect(workspaceGrantContexts).toHaveLength(1);

    const context = workspaceGrantContexts[0]!;
    expect(context.binding).toBe(WORKSPACE_BINDING);
    expect(context.contract).toBe(WORKSPACE_FILES_CONTRACT_V4);
    expect(context.instance).not.toMatch(/file-viewer|editor/);
    // Keep the provider boundary binding-only: adding panel/template/module
    // identity here would turn presentation instances into authority scopes.
    expect(Object.keys(context).sort()).toEqual([
      "app",
      "binding",
      "contract",
      "instance",
      "owner",
      "packageDigest",
      "permissionContractDigest",
      "publisher",
      "scope",
    ]);
  });

  it("reads a real workspace through the whole chain and closes with the tab", async () => {
    grantWorkspaceOperations("alice");
    const tab = await openTab();

    const roots = await tab.remote.port.refreshRoots();
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.value.roots.map((row) => row.label)).toEqual(["Demo", "/"]);

    const listing = await tab.remote.port.listDirectory(roots.value.roots[0]!.ref);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const src = listing.value.entries.find((row) => row.label === "src")!;
    const inner = await tab.remote.port.listDirectory(src.ref!);
    expect(inner.ok).toBe(true);
    if (!inner.ok) return;

    const opened = await tab.remote.port.openText(inner.value.entries[0]!.ref!);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const drained = await drainResourceStream(opened.value.stream);
    expect(drained.chunks.map((row) => row.text).join("")).toBe("第一行\nexport const a = 1;\n");
    expect(drained.terminal.kind).toBe("end");

    // Nothing that crossed names a machine, a workspace id or a path.
    const wire = JSON.stringify([roots.value, listing.value, opened.value.document]);
    expect(wire).not.toContain("ws_");
    expect(wire).not.toContain(root);
    expect(wire).not.toContain(home);

    // Closing the tab ends the scope: the refs stop resolving and the streams
    // are released, synchronously enough that nothing new can start.
    expect(app.closeInstance(tab.handle, alice)).toBe(true);
    const after = frames.length;
    expect(await tab.remote.port.refreshRoots()).toMatchObject({ ok: false });
    expect(frames).toHaveLength(after);
    expect(service.openStreams).toBe(0);
  });

  it("opens an OS-accessible absolute file outside every registered workspace", async () => {
    const outside = join(home, "AUTONOMOUS-ROADMAP.md");
    writeFileSync(outside, "owner runner\n", "utf8");
    grantWorkspaceOperations("alice");
    const tab = await openTab();

    const roots = await tab.remote.port.refreshRoots();
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    const ownerRoot = roots.value.roots.find((row) => row.label === "/");
    expect(ownerRoot?.ref).toBeTruthy();
    const labels = outside.split("/").filter(Boolean);
    const resolved = await tab.remote.port.resolvePath!(ownerRoot!.ref, labels);
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const opened = await tab.remote.port.openText(resolved.value.ref);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const drained = await drainResourceStream(opened.value.stream);
    expect(drained.chunks.map((chunk) => chunk.text).join("")).toBe("owner runner\n");
    // An owner root resolves with one direct stat: no root enumeration and no
    // per-ancestor listing walk, so directory truncation cannot hide the file.
    expect(frames.filter((frame) => frame.method === "access_owner_files").map((frame) => frame.args.mode))
      .toEqual(["stat", "text"]);
    expect(frames.find((frame) => frame.method === "access_owner_files")?.args.absolute_path).toBe(outside);
    expect(JSON.stringify([roots.value, resolved.value, opened.value.document])).not.toContain(outside);
  });

  it("opens and drains a PDF through the released v3 media path", async () => {
    grantWorkspaceOperations("alice");
    const tab = await openTab();
    const roots = await tab.remote.port.refreshRoots();
    if (!roots.ok) throw new Error(`roots: ${roots.code}`);
    const listing = await tab.remote.port.listDirectory(roots.value.roots[0]!.ref);
    if (!listing.ok) throw new Error(`listing: ${listing.code}`);
    const pdf = listing.value.entries.find((row) => row.label === "sample.pdf");
    if (!pdf?.ref) throw new Error("PDF fixture is missing");

    const opened = await tab.remote.port.openMedia(pdf.ref);
    expect(opened).toMatchObject({
      ok: true,
      value: {
        document: {
          label: "sample.pdf",
          mediaType: "application/pdf",
          sizeBytes: PDF_BYTES.byteLength,
        },
      },
    });
    if (!opened.ok) return;
    const drained = await drainResourceStream(opened.value.stream);
    expect(Buffer.concat(drained.chunks.map((chunk) => Buffer.from(chunk.data, "base64"))))
      .toEqual(PDF_BYTES);
    expect(drained.terminal.kind).toBe("end");
    expect(frames.map((frame) => frame.method)).toContain("read_workspace_binary");
    expect(service.openStreams).toBe(0);
  });

  it("downloads an unsupported binary through its separately consented operation", async () => {
    grantWorkspaceOperations("alice");
    const tab = await openTab();
    const roots = await tab.remote.port.refreshRoots();
    if (!roots.ok) throw new Error(`roots: ${roots.code}`);
    const listing = await tab.remote.port.listDirectory(roots.value.roots[0]!.ref);
    if (!listing.ok) throw new Error(`listing: ${listing.code}`);
    const binary = listing.value.entries.find((row) => row.label === "archive.bin");
    if (!binary?.ref) throw new Error("binary fixture is missing");

    const opened = await tab.remote.port.downloadFile(binary.ref);
    expect(opened).toMatchObject({
      ok: true,
      value: {
        document: {
          label: "archive.bin",
          mediaType: "application/octet-stream",
          sizeBytes: BINARY_BYTES.byteLength,
        },
      },
    });
    if (!opened.ok) return;
    const drained = await drainResourceStream(opened.value.stream);
    expect(Buffer.concat(drained.chunks.map((chunk) => Buffer.from(chunk.data, "base64"))))
      .toEqual(BINARY_BYTES);
    expect(drained.terminal.kind).toBe("end");
    const downloadFrames = frames.filter((frame) => frame.method === "download_workspace_file");
    expect(downloadFrames.length).toBeGreaterThan(1);
    expect(frames.map((frame) => frame.method)).not.toContain("read_workspace_binary");
  });

  it("touches no laptop at all when nobody has consented", async () => {
    // No grant row. The provider's `open` returns null, the catalog answers
    // `no_authority`, and the interesting number is the frame count.
    const tab = await openTab();
    expect(await tab.remote.port.refreshRoots()).toMatchObject({ ok: false, code: "no_authority" });
    expect(await tab.remote.port.listDirectory("anything")).toMatchObject({ ok: false, code: "no_authority" });
    expect(frames).toHaveLength(0);
    expect(caps.service.listPending("alice")).toHaveLength(0);
  });

  it("gives an old grant only its historical intersection", async () => {
    // A grant recorded before workspace file reads existed. The current release
    // asks for more, but only the four recorded operations survive intersection.
    grantWorkspaceOperations("alice", [
      "list_recent_sessions",
      "search_sessions",
      "read_session",
      "list_session_workspaces",
    ]);
    const tab = await openTab();
    // `refresh_roots` spends `list_session_workspaces`, which IS in the old
    // grant — so the enumeration works and the two new reads do not.
    const roots = await tab.remote.port.refreshRoots();
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    const before = frames.length;
    expect(await tab.remote.port.listDirectory(roots.value.roots[0]!.ref))
      .toMatchObject({ ok: false, code: "denied" });
    // Refused by the Gate at the plane, before anything reached the laptop.
    expect(frames).toHaveLength(before);
  });

  it("keeps the owner root while separately approving non-auto-allowed reads", async () => {
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      operations: [...SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS],
      autoAllow: [],
      source: "user",
      createdBy: "alice",
      contractDigest: CURRENT_CONTRACT_DIGEST,
      publisher: SESSION_PLUS_PUBLISHER,
    });
    const tab = await openTab();
    const roots = await tab.remote.port.refreshRoots();
    expect(roots).toMatchObject({
      ok: true,
      value: { roots: [{ label: "/" }] },
    });
    if (!roots.ok) return;
    // Workspace enumeration has its own pending approval, but cannot suppress
    // the owner-local root. Accessing that root spends the distinct owner op.
    expect(caps.service.listPending("alice")).toHaveLength(1);
    expect(await tab.remote.port.listDirectory(roots.value.roots[0]!.ref))
      .toMatchObject({ ok: false, code: "approval_required" });
    expect(caps.service.listPending("alice")).toHaveLength(2);
    expect(frames).toHaveLength(0);
  });

  it("refuses a binding this release's plan does not declare, with zero frames", async () => {
    grantWorkspaceOperations("alice");
    const opened = await app.open(alice);
    const forged: ProposalTransport = {
      async propose(action, params = {}) {
        const answer = await app.dispatch(opened.handle, alice, { action, params }, opened.resourceGeneration);
        return answer.ok
          ? { ok: true, result: answer.result, message: "" }
          : { ok: false, code: String((answer as { resourceCode?: string }).resourceCode ?? answer.code), result: null, message: answer.message };
      },
    };
    // A View that forges a wire string stops at the dispatcher's FIRST question:
    // the plan does not contain this binding name.
    const remote = createRemoteWorkspaceFilesPort(forged, "archive");
    expect(await remote.port.refreshRoots()).toMatchObject({ ok: false, code: "invalid_request" });
    expect(frames).toHaveLength(0);
  });

  it("refuses another account's ref, with zero frames", async () => {
    grantWorkspaceOperations("alice");
    grantWorkspaceOperations("bob");
    const mine = await openTab();
    const roots = await mine.remote.port.refreshRoots();
    if (!roots.ok) throw new Error("roots");
    const theirs = await openTab({ owner: "bob", credential: "ws:bob", session: true });
    const before = frames.length;
    // A ref minted for alice's scope, submitted from bob's. It stops at the
    // vault, which is step two — before any binding exists to dispatch on.
    expect(await theirs.remote.port.listDirectory(roots.value.roots[0]!.ref))
      .toMatchObject({ ok: false, code: "unknown_ref" });
    expect(frames).toHaveLength(before);
  });

  it("refuses everything after the release moves on, with zero frames", async () => {
    grantWorkspaceOperations("alice");
    const tab = await openTab();
    expect((await tab.remote.port.refreshRoots()).ok).toBe(true);
    const before = frames.length;

    // An activation ends this owner's instances; the tab keeps its handle and
    // gets nothing with it, and the resource handle closed alongside.
    app.releaseOwner("alice", "release_activated");
    expect(await tab.remote.port.refreshRoots()).toMatchObject({ ok: false });
    expect(frames).toHaveLength(before);
  });

  it("ends every scope when the device credential changes, before the new one exists", async () => {
    grantWorkspaceOperations("alice");
    files.attachToRunnerLifecycle(caps, (owner) => {
      void catalog.closeOwner(owner);
    });
    const tab = await openTab();
    expect((await tab.remote.port.refreshRoots()).ok).toBe(true);
    const before = frames.length;

    caps.mintDeviceToken("alice", "laptop");
    expect(await tab.remote.port.refreshRoots()).toMatchObject({ ok: false });
    expect(frames).toHaveLength(before);
    // A new tab is where a fresh decision belongs — and the old handle never
    // reopens, whatever it does next.
    expect(await tab.remote.port.listDirectory("anything")).toMatchObject({ ok: false });
    expect(frames).toHaveLength(before);
  });
});

/**
 * Saving from the frame, on the release this build actually serves.
 *
 * The current self-service contract grants owner-local text replacement and the
 * v4 binding carries the whole body through the trusted coordinator. The
 * expected digest still provides optimistic concurrency, and the contract's
 * byte bound still rejects an oversized body before a Runner frame is sent.
 */
describe("saving from a real Session Plus release", () => {
  async function openOwnerFile(tab: { remote: RemoteWorkspaceFilesV4 }, absolute: string) {
    const roots = await tab.remote.port.refreshRoots();
    if (!roots.ok) throw new Error(`roots: ${roots.code}`);
    const ownerRoot = roots.value.roots.find((row) => row.label === "/");
    if (!ownerRoot) throw new Error("missing owner root");
    const resolved = await tab.remote.port.resolvePath!(ownerRoot.ref, absolute.split("/").filter(Boolean));
    if (!resolved.ok) throw new Error(`resolve: ${resolved.code}`);
    const opened = await tab.remote.port.openText(resolved.value.ref);
    if (!opened.ok) throw new Error(`open: ${opened.code}`);
    await opened.value.stream.close();
    return { ref: opened.value.document.ref, expectedDigest: opened.value.document.digest };
  }

  it("saves owner-root files outside workspaces through the independent Gate and refuses stale saves", async () => {
    const absolute = join(home, "draft.txt");
    writeFileSync(absolute, "original\n");
    grantWorkspaceOperations("alice");
    const tab = await openTab();
    const { ref, expectedDigest } = await openOwnerFile(tab, absolute);
    const before = frames.length;
    const saved = await tab.remote.port.replaceText!(ref, { expectedDigest, text: "edited\n" });
    expect(saved).toMatchObject({ ok: true, value: { beforeDigest: expectedDigest, undo: "unsupported" } });
    expect(frames.slice(before)).toMatchObject([{ method: "replace_owner_text", args: { absolute_path: absolute } }]);
    expect(readFileSync(absolute, "utf8")).toBe("edited\n");
    expect(JSON.stringify(saved)).not.toContain(absolute);
    expect(caps.service.listPending("alice")).toEqual([]);
    expect(await tab.remote.port.replaceText!(ref, { expectedDigest, text: "stale\n" }))
      .toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(readFileSync(absolute, "utf8")).toBe("edited\n");

    const other = await openTab({ ...alice, credential: "ws:other" });
    const count = frames.length;
    expect(await other.remote.port.replaceText!(ref, { expectedDigest, text: "foreign\n" }))
      .toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await tab.remote.port.replaceText!("forged-ref", { expectedDigest, text: "forged\n" }))
      .toMatchObject({ ok: false, code: "unknown_ref" });
    files.revokeAccount("alice");
    expect(await tab.remote.port.replaceText!(ref, { expectedDigest, text: "revoked\n" }))
      .toMatchObject({ ok: false, code: "denied" });
    expect(frames).toHaveLength(count);
    expect(readFileSync(absolute, "utf8")).toBe("edited\n");
  });

  it("never treats an owner read plus workspace write as permission to write outside a workspace", async () => {
    const absolute = join(home, "read-only.txt");
    writeFileSync(absolute, "keep\n");
    const operations = SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS.filter((op) => op !== "replace_owner_text");
    grantWorkspaceOperations("alice", operations, operations);
    const tab = await openTab();
    const { ref, expectedDigest } = await openOwnerFile(tab, absolute);
    const before = frames.length;
    expect(await tab.remote.port.replaceText!(ref, { expectedDigest, text: "forbidden\n" }))
      .toMatchObject({ ok: false, code: "read_only" });
    expect(frames).toHaveLength(before);
    expect(caps.service.listPending("alice")).toEqual([]);
    expect(readFileSync(absolute, "utf8")).toBe("keep\n");
  });

  it("keeps workspace writes independent when only owner-root writes are granted", async () => {
    const absolute = join(home, "owner-only.txt");
    writeFileSync(absolute, "keep\n");
    const operations = SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS.filter((op) => op !== "replace_workspace_text");
    grantWorkspaceOperations("alice", operations, operations);
    const tab = await openTab();
    const workspace = await openFile(tab);
    const before = frames.length;
    expect(await tab.remote.port.replaceText!(workspace.ref, { expectedDigest: workspace.digest, text: "no\n" }))
      .toMatchObject({ ok: false, code: "read_only" });
    expect(frames).toHaveLength(before);
    const ownerFile = await openOwnerFile(tab, absolute);
    expect(await tab.remote.port.replaceText!(ownerFile.ref, { expectedDigest: ownerFile.expectedDigest, text: "yes\n" }))
      .toMatchObject({ ok: true });
    expect(readFileSync(absolute, "utf8")).toBe("yes\n");
  });

  it("requires an owner approval when the write exists without its auto-allow term", async () => {
    const absolute = join(home, "approve.txt");
    writeFileSync(absolute, "keep\n");
    grantWorkspaceOperations("alice", SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS,
      SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT.autoAllow.filter((op) => op !== "replace_owner_text"));
    const tab = await openTab();
    const { ref, expectedDigest } = await openOwnerFile(tab, absolute);
    const before = frames.length;
    expect(await tab.remote.port.replaceText!(ref, { expectedDigest, text: "approve me\n" }))
      .toMatchObject({ ok: false, code: "approval_required" });
    expect(frames).toHaveLength(before);
    expect(caps.service.listPending("alice")).toMatchObject([{ operation: "replace_owner_text" }]);
    expect(caps.service.listPending("bob")).toEqual([]);
    expect(readFileSync(absolute, "utf8")).toBe("keep\n");
  });

  async function openFile(tab: { remote: RemoteWorkspaceFilesV4 }): Promise<{ ref: string; digest: string }> {
    const roots = await tab.remote.port.refreshRoots();
    if (!roots.ok) throw new Error(`roots: ${roots.code}`);
    const listing = await tab.remote.port.listDirectory(roots.value.roots[0]!.ref);
    if (!listing.ok) throw new Error(`listing: ${listing.code}`);
    const src = listing.value.entries.find((row) => row.label === "src")!;
    const inner = await tab.remote.port.listDirectory(src.ref!);
    if (!inner.ok) throw new Error(`inner: ${inner.code}`);
    const opened = await tab.remote.port.openText(inner.value.entries[0]!.ref!);
    if (!opened.ok) throw new Error(`open: ${opened.code}`);
    await opened.value.stream.close();
    return { ref: opened.value.document.ref, digest: opened.value.document.digest };
  }

  it("lists a directory past one page from a real release by following the cursor", async () => {
    grantWorkspaceOperations("alice");
    const tab = await openTab();
    const many = join(root, "many");
    mkdirSync(many);
    for (let i = 0; i < 1_200; i += 1) writeFileSync(join(many, `f${String(i).padStart(4, "0")}`), "x");
    const roots = await tab.remote.port.refreshRoots();
    if (!roots.ok) throw new Error(`roots: ${roots.code}`);
    const top = await tab.remote.port.listDirectory(roots.value.roots[0]!.ref);
    if (!top.ok) throw new Error(`listing: ${top.code}`);
    const dir = top.value.entries.find((row) => row.label === "many")!.ref!;
    const labels: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await tab.remote.port.listDirectory(dir, after);
      if (!page.ok) throw new Error(`page: ${page.code} ${page.message}`);
      labels.push(...page.value.entries.map((row) => row.label));
      if (!page.value.truncated) break;
      after = workspaceListCursorAfter(page.value.entries)!;
    }
    expect(labels).toHaveLength(1_200);
    expect(new Set(labels).size).toBe(1_200);
  });

  it("carries a whole file body through the trusted coordinator and writes it atomically", async () => {
    grantWorkspaceOperations("alice");
    const tab = await openTab();
    expect(workspaceFilesCanWrite(tab.remote.port)).toBe(true);
    const { ref, digest } = await openFile(tab);
    const before = frames.length;
    const text = `${"行".repeat(50_000)}\n`;

    const saved = await tab.remote.port.replaceText!(ref, {
      expectedDigest: digest,
      text,
    });

    expect(saved).toMatchObject({ ok: true });
    expect(frames.slice(before).map((row) => row.method)).toEqual(["replace_workspace_text"]);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(text);
    expect(caps.service.listPending("alice").filter((row) => row.operation === "replace_workspace_text")).toEqual([]);
  });

  it("saves 3 MiB from a real release as one staged upload, each step one silent Gate call", async () => {
    // 2026-10-20: the body is no longer refused for its size. The release's
    // remote port stages it through the trusted coordinator — begin, windows,
    // commit — and the file is replaced once, at commit, under the CAS.
    grantWorkspaceOperations("alice");
    const tab = await openTab();
    const { ref, digest } = await openFile(tab);
    const before = frames.length;
    const text = "第 N 行：staged through the real coordinator\n".repeat(70_000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(3 * 1024 * 1024);

    const saved = await tab.remote.port.replaceText!(ref, { expectedDigest: digest, text });

    expect(saved).toMatchObject({ ok: true, value: { ref, beforeDigest: digest, sizeBytes: Buffer.byteLength(text) } });
    const writes = frames.slice(before);
    expect(new Set(writes.map((row) => row.method))).toEqual(new Set(["replace_workspace_text"]));
    expect(writes.length).toBeGreaterThan(Math.ceil(Buffer.byteLength(text) / WORKSPACE_FILES_LIMITS.maxWriteTextBytes));
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(text);
    expect(caps.service.listPending("alice").filter((row) => row.operation === "replace_workspace_text")).toEqual([]);
  });
});
