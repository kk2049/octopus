/**
 * The Workspace Files capability plane, and the split it depends on.
 *
 * Two things are being proved here, and the second is the reason this batch
 * exists at all:
 *
 *  1. the three reads behave like every other capability the moment they exist —
 *     bounded by the same limits the device enforces, routed to exactly the
 *     device the caller named, unreachable from another account, refused when a
 *     grant does not hold them, and card-generating when a grant does not
 *     auto-allow them;
 *  2. installing this plane does not touch `runner-account-v2`. A live root
 *     stays live, its rights stay the same, and an undecided approval card is
 *     still approvable afterwards — which is the property a per-module Object
 *     bump would have destroyed, on every account, every time a backend module
 *     shipped.
 *
 * What a listing actually contains is settled by `conformance.test.ts`, which
 * drives the real device code; nothing here mocks below the transport.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "../runner/gateway.js";
import {
  RUNNER_ACCOUNT_OBJECT_PREFIX,
  RUNNER_OPERATIONS,
  RunnerCapabilities,
} from "../runner/capability.js";
import { startFakeRunner, type FakeRunner } from "../runner/fake-runner.helper.js";
import {
  WORKSPACE_FILES_OBJECT_PREFIX,
  WORKSPACE_FILES_OPERATIONS,
  WORKSPACE_FILES_SLOT,
  WorkspaceFilesCapabilities,
} from "./capability.js";

const NOW = "2026-08-06T00:00:00.000Z";
const WORKSPACE = `ws_${"0".repeat(24)}`;
const WORKSPACE_OPS = [
  "list_workspace_entries",
  "read_workspace_text",
  "read_workspace_binary",
  "download_workspace_file",
] as const;
const WRITE_OP = "replace_workspace_text";
const OWNER_OP = "access_owner_files";
const OWNER_WRITE_OP = "replace_owner_text";
const ALL_OPS = ["list_session_workspaces", ...WORKSPACE_OPS, OWNER_OP, WRITE_OP, OWNER_WRITE_OP] as const;

const echo = {
  list_session_workspaces: () => ({ workspaces: [] }),
  list_workspace_entries: (a: Record<string, unknown>) => ({
    status: "ok",
    workspace_id: a.workspace_id,
    relative_path: a.relative_path ?? "",
    entries: [],
    truncated: false,
  }),
  read_workspace_text: (a: Record<string, unknown>) => ({
    status: "ok",
    workspace_id: a.workspace_id,
    relative_path: a.relative_path,
    size: 0,
    modified_at: NOW,
    digest: `sha256:${"0".repeat(64)}`,
    encoding: "utf-8",
    offset: 0,
    bytes: 0,
    eof: true,
    text: "",
  }),
  read_workspace_binary: (a: Record<string, unknown>) => ({
    status: "ok",
    workspace_id: a.workspace_id,
    relative_path: a.relative_path,
    size: 0,
    modified_at: NOW,
    digest: `sha256:${"0".repeat(64)}`,
    encoding: "base64",
    offset: 0,
    bytes: 0,
    eof: true,
    data: "",
  }),
  download_workspace_file: (a: Record<string, unknown>) => ({
    status: "ok",
    workspace_id: a.workspace_id,
    relative_path: a.relative_path,
    size: 0,
    modified_at: NOW,
    digest: `sha256:${"0".repeat(64)}`,
    encoding: "base64",
    offset: 0,
    bytes: 0,
    eof: true,
    data: "",
  }),
  exec: () => ({ exit_code: 0, stdout: "", stderr: "" }),
};

let dir: string;
let store: Store;
let gateway: RunnerGateway;
let caps: RunnerCapabilities;
let files: WorkspaceFilesCapabilities;
let laptop: FakeRunner;
let desktop: FakeRunner;
let mallory: FakeRunner;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wsfiles-cap-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW });
  store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/bob", created_at: NOW });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", NOW);
  store.saveRunnerToken(hashRunnerToken("rt_alice2"), "alice", "desktop", NOW);
  store.saveRunnerToken(hashRunnerToken("rt_bob"), "bob", "laptop", NOW);
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  const transport = gateway.claimTransport();
  caps = new RunnerCapabilities(store, transport);
  // The two planes share ONE service, because a Context minted by one kernel is
  // meaningless to another and the store takes a single-writer lease.
  files = new WorkspaceFilesCapabilities({
    service: caps.service,
    transport,
    userExists: (name) => Boolean(store.getUser(name)),
    hasDevice: (name) => store.listRunnerTokens(name).length > 0,
  });
  laptop = await startFakeRunner(gateway.port, "rt_alice", "laptop", echo);
  desktop = await startFakeRunner(gateway.port, "rt_alice2", "desktop", echo);
  mallory = await startFakeRunner(gateway.port, "rt_bob", "laptop", echo);
});

afterEach(async () => {
  laptop.close();
  desktop.close();
  mallory.close();
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("the closed operation table", () => {
  it("is one observe, five reads and two modifies, on its own Object", () => {
    expect(Object.keys(WORKSPACE_FILES_OPERATIONS).sort()).toEqual([...ALL_OPS].sort());
    expect(WORKSPACE_FILES_OPERATIONS.list_session_workspaces.effect).toBe("observe");
    for (const operation of WORKSPACE_OPS) expect(WORKSPACE_FILES_OPERATIONS[operation].effect).toBe("read");
    expect(WORKSPACE_FILES_OPERATIONS[OWNER_OP].effect).toBe("read");
    expect(WORKSPACE_FILES_OPERATIONS[WRITE_OP].effect).toBe("modify");
    // The version moved with the table, and only with it. Adding an operation
    // under the old id is not a thing that quietly works: the kernel persists
    // the sorted operation list as part of an Object's identity and refuses a
    // differing one, so this constant and that table change together or the
    // process cannot register its own Object.
    expect(WORKSPACE_FILES_OBJECT_PREFIX).toBe("workspace-files-runner-v8");
    expect(WORKSPACE_FILES_SLOT).toBe("workspace-files");
  });

  it("declares the write retry-safe because it is a compare-and-swap", () => {
    // The effect-derived default for `modify` is false, which is right for
    // `exec` and `write_file`. This one states otherwise on purpose: re-running
    // it either applies the same edit to the same version or finds the digest no
    // longer matches, so there is no input for which it applies twice. Interrupt
    // recovery reads exactly this field.
    expect(WORKSPACE_FILES_OPERATIONS[WRITE_OP].retrySafe).toBe(true);
    expect(WORKSPACE_FILES_OPERATIONS[OWNER_WRITE_OP]).toMatchObject({ effect: "modify", retrySafe: true });
    expect(WORKSPACE_FILES_OPERATIONS.read_workspace_text.retrySafe).toBeUndefined();
  });

  it("keeps workspace files split while the account Object evolves independently", () => {
    // The account Object moved for its own append-session argument contract.
    // Workspace file reads and writes remain on their independent
    // version/revocation line.
    expect(RUNNER_ACCOUNT_OBJECT_PREFIX).toBe("runner-account-v12");
    expect(Object.keys(RUNNER_OPERATIONS)).toContain("workspace_terminal");
    expect(Object.keys(RUNNER_OPERATIONS)).not.toContain("list_workspace_entries");
    expect(Object.keys(RUNNER_OPERATIONS)).not.toContain("read_workspace_text");
    expect(Object.keys(RUNNER_OPERATIONS)).not.toContain(OWNER_OP);
    expect(Object.keys(RUNNER_OPERATIONS)).not.toContain(WRITE_OP);
  });

  it("lets an owner-local child explicitly auto-allow the compare-and-swap write", () => {
    const grant = files.open({
      username: "alice",
      purpose: "files",
      rights: [...WORKSPACE_OPS, WRITE_OP],
      autoAllow: [...WORKSPACE_OPS, WRITE_OP],
    });
    expect(grant).not.toBeNull();
    expect([...files.service.termsOf(grant!.contextId, WORKSPACE_FILES_SLOT).autoAllow].sort())
      .toEqual([...WORKSPACE_OPS, WRITE_OP].sort());
  });

  it("names a device and a device-resolved workspace, and never a path", () => {
    for (const operation of WORKSPACE_OPS) {
      const args = WORKSPACE_FILES_OPERATIONS[operation].args;
      expect(args.device.required).toBe(true);
      expect(args.workspace_id.required).toBe(true);
      expect(Object.keys(args)).not.toContain("path");
      expect(Object.keys(args)).not.toContain("directory");
      expect(args.workspace_id.type === "string" && args.workspace_id.maxLength)
        .toBe(MACHINE_LIMITS.workspaceIdMaxBytes);
      expect(args.relative_path.type === "string" && args.relative_path.maxLength)
        .toBe(MACHINE_LIMITS.workspaceRelativePathMaxBytes);
    }
    const read = WORKSPACE_FILES_OPERATIONS.read_workspace_text.args;
    expect(read.relative_path.required).toBe(true);
    expect(read.max_bytes.type === "number" && read.max_bytes.max).toBe(MACHINE_LIMITS.workspaceTextChunkMaxBytes);
    // Windows cost O(window) on the device, so an offset is bounded only by
    // its numeric representation: a file of any size can be read to its end.
    expect(read.offset.type === "number" && read.offset.max).toBe(MACHINE_LIMITS.workspaceFileMaxOffset);
    // A listing may be left off the root, which is what makes `""` expressible
    // without a second operation.
    expect(WORKSPACE_FILES_OPERATIONS.list_workspace_entries.args.relative_path.required).toBeUndefined();
    // Enumerating devices is gateway-local presence, not a permission token:
    // an operation that never reaches a device would grant nothing.
    expect(Object.keys(WORKSPACE_FILES_OPERATIONS)).not.toContain("__list_devices");
  });

  it("keeps owner access on its own operation, with optional session execution placement", () => {
    const args = WORKSPACE_FILES_OPERATIONS[OWNER_OP].args;
    expect(args.device.required).toBe(true);
    expect(args.mode).toMatchObject({ required: true, enum: ["list", "text", "binary", "download", "stat", "resolve"] });
    expect(args.absolute_path).toMatchObject({ maxLength: MACHINE_LIMITS.pathMaxBytes });
    expect(args.workspace_id).toMatchObject({ maxLength: MACHINE_LIMITS.workspaceIdMaxBytes });
    expect(Object.keys(args)).not.toContain("relative_path");
  });
});

describe("routing and isolation", () => {
  it("does not derive owner writes from an owner read or a workspace write", async () => {
    const grant = files.open({ username: "alice", purpose: "old consent", rights: [OWNER_OP, WRITE_OP], autoAllow: [OWNER_OP, WRITE_OP] })!;
    expect(await grant.request(OWNER_WRITE_OP, {
      device: "laptop", absolute_path: "/draft.txt", expected_digest: `sha256:${"0".repeat(64)}`, text: "no",
    })).toMatchObject({ status: "denied" });
    expect(laptop.frames).toEqual([]);
    expect(desktop.frames).toEqual([]);
    expect(mallory.frames).toEqual([]);
    expect(files.service.listPending("alice")).toEqual([]);
  });

  it("reaches exactly the named device and no other", async () => {
    const grant = files.open({ username: "alice", purpose: "files", rights: WORKSPACE_OPS })!;
    const listing = await grant.request("list_workspace_entries", {
      device: "desktop",
      workspace_id: WORKSPACE,
      relative_path: "src",
    });

    expect(listing.status).toBe("succeeded");
    expect(desktop.frames.map((frame) => frame.method)).toEqual(["list_workspace_entries"]);
    // The gateway strips the selector before the frame leaves; the device
    // resolves its own registry and never learns which name routed to it.
    expect(desktop.frames[0].args).toEqual({ workspace_id: WORKSPACE, relative_path: "src" });
    expect(laptop.frames).toHaveLength(0);
    expect(mallory.frames).toHaveLength(0);
  });

  it("cannot be pointed at another account's device", async () => {
    const grant = files.open({ username: "alice", purpose: "files", rights: WORKSPACE_OPS })!;
    const out = await grant.request("read_workspace_text", {
      device: "laptop",
      workspace_id: WORKSPACE,
      relative_path: "a.txt",
    });

    expect(out.status).toBe("succeeded");
    // "alice/laptop" is Alice's laptop. Bob's device of the same name got
    // nothing, because the Object's owner is fixed and `device` only selects
    // inside that owner's connection set.
    expect(laptop.frames).toHaveLength(1);
    expect(mallory.frames).toHaveLength(0);
  });

  it("refuses a grant that does not hold them, before any frame", async () => {
    const narrow = files.open({
      username: "alice",
      purpose: "roots only",
      rights: ["list_session_workspaces"],
    })!;
    const out = await narrow.request("read_workspace_text", {
      device: "laptop",
      workspace_id: WORKSPACE,
      relative_path: "a.txt",
    });

    expect(out.status).toBe("denied");
    expect(laptop.frames).toHaveLength(0);
  });

  it("cannot reach a Runner operation that is not in this table", async () => {
    const grant = files.open({ username: "alice", purpose: "files", rights: WORKSPACE_OPS })!;
    // The account CAN exec — through the other Object. Holding this plane says
    // nothing about that one, which is the separation being bought.
    const out = await grant.request("exec" as never, { device: "laptop", command: "id" });

    expect(out.status).toBe("denied");
    expect(laptop.frames).toHaveLength(0);
  });

  it("refuses values past the ceiling the device enforces, before any frame", async () => {
    const grant = files.open({ username: "alice", purpose: "files", rights: WORKSPACE_OPS })!;
    const over = await grant.request("read_workspace_text", {
      device: "laptop",
      workspace_id: WORKSPACE,
      relative_path: "x".repeat(MACHINE_LIMITS.workspaceRelativePathMaxBytes + 1),
    });
    const missingDevice = await grant.request("list_workspace_entries", { workspace_id: WORKSPACE });

    expect(over.status).toBe("denied");
    expect(missingDevice.status).toBe("denied");
    expect(laptop.frames).toHaveLength(0);
  });

  it("asks the owner when the grant does not auto-allow them, and names what is being read", async () => {
    const supervised = files.open({
      username: "alice",
      purpose: "files",
      kind: "agent-run",
      rights: WORKSPACE_OPS,
      autoAllow: [],
    })!;
    const out = await supervised.request("list_workspace_entries", {
      device: "laptop",
      workspace_id: WORKSPACE,
      relative_path: "",
    });

    expect(out.status).toBe("approval_required");
    expect(laptop.frames).toHaveLength(0);
    const card = caps.listPending("alice").find((row) => row.operation === "list_workspace_entries")!;
    expect(card.target).toBe("alice/laptop");
    expect(card.details.join("\n")).toContain("(工作区根目录)");
    expect(card.details.join("\n")).toContain(WORKSPACE);
  });

  it("holds nothing for an account with no device and nothing for an unknown one", async () => {
    store.deleteRunnerToken("bob", "laptop");
    expect(files.open({ username: "bob", purpose: "files", rights: WORKSPACE_OPS })).toBeNull();
    expect(files.open({ username: "nobody", purpose: "files", rights: WORKSPACE_OPS })).toBeNull();
    expect(files.accountOperations("bob")).toEqual([]);
  });
});

describe("the two Objects are independent", () => {
  it("does not disturb a live runner-account-v2 root or its undecided card", async () => {
    const runnerGrant = caps.open({
      username: "alice",
      purpose: "shell",
      kind: "agent-run",
      rights: ["exec"],
    })!;
    const pending = await runnerGrant.request("exec", { device: "laptop", command: "id" });
    expect(pending.status).toBe("approval_required");
    const before = caps.service.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`);
    expect(before).toHaveLength(1);

    // Registering the plane and using it is the event a version bump would have
    // made destructive.
    const filesGrant = files.open({ username: "alice", purpose: "files", rights: WORKSPACE_OPS })!;
    expect((await filesGrant.request("list_workspace_entries", {
      device: "laptop",
      workspace_id: WORKSPACE,
    })).status).toBe("succeeded");

    const after = caps.service.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`);
    expect(after.map((row) => row.contextId)).toEqual(before.map((row) => row.contextId));
    // The card an owner had not decided yet is still decidable.
    if (pending.status !== "approval_required") throw new Error("unreachable");
    const approved = await caps.approve(pending.pendingCallId, "alice");
    expect(approved.status).toBe("succeeded");
  });

  it("keeps its own root, so revoking one does not revoke the other", async () => {
    caps.ensureAccount("alice");
    expect(files.accountAuthority("alice")).not.toBeNull();
    const runnerRoot = caps.accountAuthority("alice")!;

    files.revokeAccount("alice");

    // The Runner root is untouched; the Workspace Files one is gone until the
    // next use mints a fresh one.
    expect(caps.service.contextIsLive(runnerRoot.contextId)).toBe(true);
    expect(caps.service.rootsOf(`${WORKSPACE_FILES_OBJECT_PREFIX}:alice`)).toHaveLength(0);
    expect(caps.service.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)).toHaveLength(1);
  });
});

describe("the device set is the one thing they share", () => {
  it("closes this plane before a replacement credential exists", async () => {
    const closed: string[] = [];
    files.attachToRunnerLifecycle(caps, (username) => closed.push(username));
    const grant = files.open({ username: "alice", purpose: "files", rights: WORKSPACE_OPS })!;
    expect((await grant.request("list_workspace_entries", {
      device: "laptop",
      workspace_id: WORKSPACE,
    })).status).toBe("succeeded");

    caps.mintDeviceToken("alice", "desktop");

    expect(closed).toEqual(["alice"]);
    // The grant was derived from a root that no longer exists: the ancestry
    // check fails on the NEXT call, with no frame leaving the process.
    const framesBefore = laptop.frames.length;
    const after = await grant.request("list_workspace_entries", { device: "laptop", workspace_id: WORKSPACE });
    expect(after.status).toBe("denied");
    expect(laptop.frames).toHaveLength(framesBefore);
  });

  it("refuses to write the new credential when a plane will not close down", () => {
    const detach = caps.onTargetSetChanged(() => {
      throw new Error("scope teardown failed");
    });
    let alsoRan = false;
    caps.onTargetSetChanged(() => {
      alsoRan = true;
    });

    const before = store.listRunnerTokens("alice").map((row) => row.token_hash);
    expect(() => caps.mintDeviceToken("alice", "desktop")).toThrow(/设备凭据变更未完成/);
    // Every listener is attempted: one failing must not leave the others
    // holding authority over a device set that changed.
    expect(alsoRan).toBe(true);
    // Availability is the price. What must not happen is a NEW credential next
    // to authority that was never torn down.
    const after = store.listRunnerTokens("alice").map((row) => row.token_hash);
    expect(after).toEqual(before.filter((hash) => after.includes(hash)));
    expect(after.length).toBeLessThan(before.length);
    detach();
  });

  it("stops announcing once a plane detaches", () => {
    let seen = 0;
    const detach = caps.onTargetSetChanged(() => {
      seen += 1;
    });
    caps.revokeDeviceToken("alice", "desktop");
    expect(seen).toBe(1);
    detach();
    caps.revokeDeviceToken("alice", "laptop");
    expect(seen).toBe(1);
  });
});
