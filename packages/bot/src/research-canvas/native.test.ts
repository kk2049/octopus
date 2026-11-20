import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ResearchNode,
  ResearchRun,
  ResourceBinding,
} from "@claude-bot/research-canvas-contract";
import { CANVAS_OPERATIONS } from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { createHash } from "node:crypto";
import { RunnerCapabilities } from "../runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "../runner/gateway.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { SessionOperationCoordinator } from "../sessionhub/operations.js";
import { digest } from "./validation.js";
import { IntentGrantResolver } from "../session-resource/intent-resolver.js";
import {
  RESEARCH_CANVAS_CONTRACT,
  RESEARCH_CANVAS_DIGEST,
  RESEARCH_CANVAS_SUBJECT,
} from "./contract.js";
import { ResearchCapabilities } from "./capability.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchNative } from "./native.js";
import { ResearchCanvasPlane } from "./plane.js";
import { ResearchResources } from "./resources.js";
import { ResearchCollaboration } from "./collaboration.js";
import type { ResearchAutomation } from "./automation.js";

describe("project delegation to the existing native session controller", () => {
  let root: string,
    store: Store,
    runner: RunnerCapabilities,
    native: ResearchNative,
    graph: ResearchGraph,
    operations: SessionOperationCoordinator,
    binding: ResourceBinding,
    capabilities: ResearchCapabilities;
  let frames: {
    owner: string;
    operation: string;
    args: Record<string, unknown>;
  }[];
  const staged = new Map<string, Buffer>();
  const now = "2026-09-17T00:00:00Z",
    alice: ResearchContext = {
      project: "project",
      actor: { kind: "human", owner: "alice" },
    },
    bob: ResearchContext = {
      project: "project",
      actor: { kind: "human", owner: "bob" },
    };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "research-native-"));
    store = new Store(join(root, "state.db"));
    frames = [];
    staged.clear();
    writeFileSync(join(root, "output.md"), "workspace file");
    for (const [index, username] of ["alice", "bob"].entries())
      store.saveUser({
        username,
        uid: 4000 + index,
        home_dir: "/unused",
        created_at: now,
      });
    store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", now);
    const transport: RunnerTransport = {
      dispatch: async (owner, operation, args) => {
        frames.push({ owner, operation, args });
        if (operation === "download_workspace_file") {
          const whole = readFileSync(join(root, "output.md"));
          const offset = Number(args.offset ?? 0);
          const data = whole.subarray(offset, offset + Number(args.max_bytes ?? whole.length));
          return {
            status: "ok",
            workspace_id: args.workspace_id,
            relative_path: args.relative_path,
            encoding: "base64",
            data: data.toString("base64"),
            offset,
            bytes: data.length,
            size: whole.length,
            eof: offset + data.length >= whole.length,
            digest: `sha256:${createHash("sha256").update(whole).digest("hex")}`,
            modified_at: now,
          };
        }
        if (operation === "replace_workspace_text" && args.stage !== undefined) {
          // The Runner's staged write (workspace-files, 2026-10-20): stage
          // windows, then one CAS + replace at commit.
          const id = String(args.upload_id);
          const base = { status: "ok", workspace_id: args.workspace_id, relative_path: args.relative_path, stage: args.stage, upload_id: id };
          if (args.stage === "begin") { staged.set(id, Buffer.alloc(0)); return { ...base, size: 0 }; }
          const upload = staged.get(id);
          if (!upload) return { status: "refused", code: "upload_expired" };
          if (args.stage === "append") {
            if (Number(args.offset) !== upload.length) throw new Error("offset");
            if (Buffer.byteLength(String(args.text)) > 256 * 1024) throw new Error("window");
            staged.set(id, Buffer.concat([upload, Buffer.from(String(args.text))]));
            return { ...base, size: staged.get(id)!.length };
          }
          staged.delete(id);
          const previous = readFileSync(join(root, "output.md"));
          const previousDigest = "sha256:" + createHash("sha256").update(previous).digest("hex");
          if (args.expected_digest !== previousDigest) return { status: "refused", code: "digest_mismatch" };
          if (Number(args.size) !== upload.length) throw new Error("size");
          writeFileSync(join(root, "output.md"), upload);
          return { ...base, encoding: "utf-8", previous_digest: previousDigest, size: upload.length,
            digest: "sha256:" + createHash("sha256").update(upload).digest("hex"), modified_at: now };
        }
        if (operation === "replace_workspace_text") {
          if (Buffer.byteLength(String(args.text)) > 256 * 1024) throw new Error("window");
          const previous = readFileSync(join(root, "output.md"));
          const previousDigest = "sha256:" + createHash("sha256").update(previous).digest("hex");
          if (args.expected_digest !== previousDigest) throw new Error("digest_mismatch");
          const data = Buffer.from(String(args.text));
          writeFileSync(join(root, "output.md"), data);
          return { status: "ok", workspace_id: args.workspace_id, relative_path: args.relative_path,
            encoding: "utf-8", previous_digest: previousDigest, size: data.length,
            digest: "sha256:" + createHash("sha256").update(data).digest("hex"), modified_at: now };
        }
        if (operation === "list_session_workspaces")
          return {
            workspaces: [
              {
                id: "ws_123456789012345678901234",
                label: "project",
                display: "/work/project",
              },
            ],
          };
        if (operation === "read_session")
          return {
            rich: true,
            messages: [
              { role: "assistant", blocks: [{ type: "text", text: "历史" }] },
            ],
            offset: 0,
            total: 1,
          };
        if (operation === "start_session")
          return {
            ok: true,
            agent: "codex",
            session_id: "started-session",
            duration_ms: 1,
          };
        if (operation === "append_session")
          return {
            ok: true,
            agent: "codex",
            result_text: "done",
            duration_ms: 1,
          };
        if (operation === "get_session_operation")
          return { ok: false, code: "not_found" };
        throw new Error(`unexpected operation ${operation}`);
      },
      listDevices: () => [
        { device: "laptop", online: true, created_at: now, last_seen_at: now },
      ],
      isOnline: () => true,
      ping: async () => 1,
      disconnect: () => false,
      openDshTunnel: async () => {
        throw new Error("unexpected");
      },
    };
    runner = new RunnerCapabilities(store, transport);
    const workspaceFiles = new WorkspaceFilesCapabilities({
      service: runner.service,
      transport,
      userExists: () => true,
      hasDevice: (owner) => owner === "alice",
    });
    const permissions = new PermissionService({
      store,
      caps: runner,
      workspaceFiles,
      subjects: [RESEARCH_CANVAS_SUBJECT],
      extraAccountOperations: [() => CANVAS_OPERATIONS],
    });
    for (const owner of ["alice", "bob"])
      permissions.grant({
        subjectType: "app",
        subjectId: "research-v2",
        owner,
        operations: RESEARCH_CANVAS_CONTRACT.operations,
        autoAllow: RESEARCH_CANVAS_CONTRACT.autoAllow,
        source: "config",
        createdBy: "system:test",
        publisher: "octopus:first-party",
        contractDigest: RESEARCH_CANVAS_DIGEST,
      });
    const hub = new SessionHubService({ store, caps: runner, permissions });
    native = new ResearchNative({
      store,
      runner,
      permissions,
      workspaceFiles,
      leases: hub.leases,
      operations: () => operations,
    });
    operations = new SessionOperationCoordinator({
      store,
      caps: runner,
      executors: { "app:research-v2": native.executor },
    });
    store.createSharedAppInstance(
      {
        app_id: "research-v2",
        instance_key: "project",
        creator: "alice",
        status: "open",
        created_at: now,
      },
      "owner",
    );
    store.addSharedAppMember(
      "research-v2",
      "project",
      "bob",
      "researcher",
      20,
      now,
    );
    graph = new ResearchGraph(store, root);
    capabilities = new ResearchCapabilities(
      runner.service,
      graph,
      new IntentGrantResolver(
        permissions,
        Date.now,
        new Map([["research-v2", "octopus:first-party"]]),
      ),
    );
    native.attach(graph, capabilities, () => {});
    const node = (
      graph.mutate(alice, "node_add", {
        request: "node",
        data: JSON.stringify({ type: "agent", title: "native agent" }),
      }) as { node: ResearchNode }
    ).node;
    binding = {
      id: node.id,
      node: node.id,
      kind: "session",
      owner: "alice",
      resource: "runner:laptop:ws_123456789012345678901234",
      version: 1,
      archived: false,
      created: node.created,
      updated: node.updated,
      config: {
        device: "laptop",
        workspace: "ws_123456789012345678901234",
        label: "project",
        provider: "codex",
        directory: "/work/project",
        session: "existing-session",
      },
    };
    graph.repo.put("project", "bindings", node.id, binding, 0);
  });
  afterEach(async () => {
    native.close();
    operations.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    runner.service.close();
    graph.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function run(conversation = `manual:${binding.node}`): ResearchRun {
    return {
      id: crypto.randomUUID(),
      project: "project",
      node: binding.node,
      conversation,
      subscription: null,
      event: null,
      root: "root",
      chain: [],
      binding,
      trigger: "bob",
      prompt: "研究任务",
      status: "queued",
      at: now,
      finished: null,
      model: null,
      usage: null,
      error: null,
    };
  }
  it("reads the exact shared owner session for a project member and refuses after revocation", async () => {
    const transcript = await native.read(
      bob,
      binding,
      `manual:${binding.node}`,
    );
    expect(transcript?.messages).toHaveLength(1);
    expect(
      frames
        .filter((frame) => frame.operation === "read_session")
        .every(
          (frame) =>
            frame.owner === "alice" && frame.args.id === "existing-session",
        ),
    ).toBe(true);
    store.removeSharedAppMember("research-v2", "project", "bob");
    const before = frames.length;
    await expect(
      native.read(bob, binding, `manual:${binding.node}`),
    ).rejects.toThrow("授权");
    expect(frames).toHaveLength(before);
    await expect(
      native.read(
        { ...bob, project: "another" },
        binding,
        `manual:${binding.node}`,
      ),
    ).rejects.toThrow("授权");
  });
  it.each([undefined, "manual", "full_access"])(
    "uses the binding owner and selected profile %s for a member-triggered append without replay",
    async (permissionProfile) => {
      if (permissionProfile) binding.config.permissionProfile = permissionProfile;
      graph.repo.put("project", "bindings", binding.id, binding, 1);
      const task = run(),
        first = await native.submit(bob, task);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const again = await native.submit(bob, task);
      expect(again.id).toBe(first.id);
      expect(
        frames.filter((frame) => frame.operation === "append_session"),
      ).toHaveLength(1);
      expect(
        frames.find((frame) => frame.operation === "append_session"),
      ).toMatchObject({ owner: "alice", args: { id: "existing-session" } });
      expect(
        frames.find((frame) => frame.operation === "append_session")?.args.permission_profile,
      ).toBe(permissionProfile);
      expect(native.completion(task, again)).toBeNull();
    },
  );
  it.each([undefined, "manual", "full_access"])(
    "starts an independent listener with profile %s without resuming the manual conversation",
    async (permissionProfile) => {
      if (permissionProfile) binding.config.permissionProfile = permissionProfile;
      graph.repo.put("project", "bindings", binding.id, binding, 1);
      await native.submit(bob, run("subscription:listener"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        frames.filter((frame) => frame.operation === "append_session"),
      ).toHaveLength(0);
      expect(
        frames.filter((frame) => frame.operation === "start_session"),
      ).toHaveLength(1);
      expect(
        frames.find((frame) => frame.operation === "start_session"),
      ).toMatchObject({
        owner: "alice",
        args: { workspace_id: "ws_123456789012345678901234" },
      });
      expect(
        frames.find((frame) => frame.operation === "start_session")?.args.permission_profile,
      ).toBe(permissionProfile ?? "full_access");
    },
  );
  it.each([null, true, "danger-full-access", "", { approvalPolicy: "never" }])(
    "rejects an invalid binding permission profile %j before contacting a Runner",
    async (permissionProfile) => {
      await expect(native.validate("alice", binding.resource, {
        ...binding.config, permissionProfile,
      })).rejects.toThrow("权限档位");
      expect(frames).toHaveLength(0);
    },
  );
  it("rejects unsupported manual OMP bindings", async () => {
    await expect(native.validate("alice", binding.resource, {
      ...binding.config, provider: "omp", permissionProfile: "manual",
    })).rejects.toThrow("权限档位");
    expect(frames).toHaveLength(0);
  });
  it("requires human resource authority for a profile change and versions the binding", async () => {
    const resources = new ResearchResources(graph, root, {
      list: async () => [],
      validate: async (owner, _kind, resource, config) => native.validate(owner, resource, config),
      read: async () => ({}),
      send: async () => { throw new Error("unexpected send"); },
      transcribe: async () => { throw new Error("unexpected transcription"); },
    }, () => {}, () => {});
    const params = {
      request: "select-profile", node: binding.node,
      data: JSON.stringify({ kind: "session", resource: binding.resource,
        config: { ...binding.config, permissionProfile: "full_access" } }),
    };
    await expect(resources.bind({ ...alice, actor: { kind: "agent", owner: "alice" } }, params)).rejects.toThrow();
    await expect(resources.bind(bob, params)).rejects.toThrow();
    expect(frames).toHaveLength(0);
    expect(await resources.bind(alice, params)).toMatchObject({ binding: {
      owner: "alice", version: 2, config: { permissionProfile: "full_access" },
    } });
    await expect(native.submit(bob, run())).rejects.toThrow("授权");
    expect(frames.some(frame => frame.operation === "append_session")).toBe(false);
  });
  it("enumerates only owner workspaces and validates bindings against a fresh registry read", async () => {
    expect(await native.list("alice")).toEqual([
      expect.objectContaining({
        id: binding.resource,
        config: expect.objectContaining({
          workspace: binding.config.workspace,
        }),
      }),
    ]);
    await native.validate("alice", binding.resource, binding.config);
    await expect(
      native.validate("alice", binding.resource, {
        ...binding.config,
        workspace: "ws_000000000000000000000000",
      }),
    ).rejects.toThrow("工作区");
  });
  it("derives project provenance only from one live execution, with no caller-selected project", () => {
    const task = { ...run(), status: "running" as const };
    graph.repo.put("project", "runs", task.id, task);
    const operationId = `op_${digest(["alice", "app:research-v2", task.id])}`;
    expect(
      native.contextForExecution({
        owner: "alice",
        runtimeDevice: "laptop",
        operationId,
      }),
    ).toMatchObject({
      project: "project",
      actor: {
        kind: "agent",
        owner: "alice",
        agent: binding.node,
        run: task.id,
        trigger: "bob",
      },
    });
    expect(
      native.contextForExecution({
        owner: "bob",
        runtimeDevice: "laptop",
        operationId,
      }),
    ).toBeNull();
    expect(
      native.contextForExecution({
        owner: "alice",
        runtimeDevice: "other",
        operationId,
      }),
    ).toBeNull();
    expect(native.placementForOperation("alice", operationId)).toMatchObject({
      workspace: binding.config.workspace,
    });
    graph.repo.put("project", "bindings", binding.id, {
      ...binding,
      version: 2,
    });
    expect(
      native.contextForExecution({
        owner: "alice",
        runtimeDevice: "laptop",
        operationId,
      }),
    ).toBeNull();
  });

  it("links a real workspace file without graph membership and saves through the owner Gate independently of graph removal", async () => {
    const resources = new ResearchResources(graph, root, {
      list: async () => [], validate: async () => {}, read: async () => ({}),
      send: async () => { throw new Error("unexpected send"); },
      transcribe: async () => { throw new Error("unexpected transcription"); },
    }, () => {}, () => {}, (context, _binding, operation) => capabilities.allowed(context, operation));
    // File actions never touch the automation dependency.
    const plane = new ResearchCanvasPlane(graph, new ResearchCollaboration(graph, root, () => {}),
      resources, {} as ResearchAutomation, capabilities, native);
    await expect(plane.invoke(alice, "agent_stop", { request: "stop-other", node: binding.node, run: "other" })).rejects.toThrow("不属于");
    const original = graph.documents.inspect(alice.project).spec;
    const linked = await plane.invoke(alice, "file_link", {
      request: "link", agent: binding.node, path: "/work/project/output.md",
    }) as { ref: string; resource: ResearchNode };
    expect(linked.resource.data).toMatchObject({ workspace: { agent: binding.node, path: "output.md", binding: 1 } });
    expect(graph.documents.inspect(alice.project).spec).toEqual(original);
    const descriptor = await plane.invoke(alice, "ref_describe", { ref: linked.ref }) as { tools: { name: string }[] };
    expect(descriptor.tools.map(tool => tool.name)).toEqual(["resource_read", "file_write"]);
    const write = { request: "save-linked", node: linked.ref, text: "edited from the graph window" };
    const answer = await plane.invoke(alice, "file_write", write);
    expect(answer).toMatchObject({ status: "saved" });
    expect(readFileSync(join(root, "output.md"), "utf8")).toBe(write.text);
    expect(graph.documents.inspect(alice.project).spec).toEqual(original);
    expect(frames.at(-1)).toMatchObject({ owner: "alice", operation: "replace_workspace_text",
      args: { workspace_id: binding.config.workspace, relative_path: "output.md", text: write.text } });
    // A lost response retry must not overwrite a newer direct workspace edit.
    writeFileSync(join(root, "output.md"), "newer external edit");
    const count = frames.length;
    expect(await plane.invoke(alice, "file_write", write)).toEqual(answer);
    expect(frames).toHaveLength(count);
    expect(readFileSync(join(root, "output.md"), "utf8")).toBe("newer external edit");
    const card = graph.node(alice.project, binding.node);
    graph.mutate(alice, "node_archive", { request: "detach", node: card.id, version: String(card.version) });
    const read = await plane.invoke(bob, "resource_read", { node: linked.ref }) as { data: string };
    expect(Buffer.from(read.data, "base64").toString()).toBe("newer external edit");
    await expect(plane.invoke(bob, "file_write", { ...write, request: "not-editor" })).rejects.toThrow();
    graph.repo.put(alice.project, "bindings", binding.node, { ...binding, version: 2 }, 1);
    await expect(plane.invoke(alice, "resource_read", { node: linked.ref })).rejects.toThrow("绑定已变化");
  });

  it("saves a linked workspace file of any size: whole past one device call, or staged past one action call", async () => {
    const plane = new ResearchCanvasPlane(graph, new ResearchCollaboration(graph, root, () => {}),
      new ResearchResources(graph, root, {
        list: async () => [], validate: async () => {}, read: async () => ({}),
        send: async () => { throw new Error("unexpected send"); },
        transcribe: async () => { throw new Error("unexpected transcription"); },
      }, () => {}, () => {}, (context, _binding, operation) => capabilities.allowed(context, operation)),
      {} as ResearchAutomation, capabilities, native);
    const linked = await plane.invoke(alice, "file_link", { request: "link-big", agent: binding.node, path: "/work/project/output.md" }) as { ref: string };
    // One action call's whole text (196,608 characters) is 576 KiB of UTF-8: more than one device call.
    const whole = "长".repeat(196_608);
    expect(await plane.invoke(alice, "file_write", { request: "whole-big", node: linked.ref, text: whole })).toMatchObject({ status: "saved" });
    expect(readFileSync(join(root, "output.md"), "utf8")).toBe(whole);
    expect(frames.filter(frame => frame.operation === "replace_workspace_text").map(frame => frame.args.stage))
      .toEqual(["begin", "append", "append", "append", "commit"]);

    // Past one action call: begin → append × N → commit, each one call.
    const parts = ["甲".repeat(196_608), "乙".repeat(196_608), "丙".repeat(1000)];
    const begun = await plane.invoke(alice, "file_write", { request: "staged-big", node: linked.ref, stage: "begin" }) as { upload: string; size: number; digest: string };
    expect(begun).toMatchObject({ status: "staged", size: 0, digest: "sha256:" + createHash("sha256").update(whole).digest("hex") });
    let offset = 0;
    for (const part of parts) {
      const appended = await plane.invoke(alice, "file_write", { request: "staged-big", node: linked.ref, stage: "append",
        upload: begun.upload, offset: String(offset), text: part }) as { size: number };
      offset += Buffer.byteLength(part);
      expect(appended.size).toBe(offset);
    }
    // Nothing replaces the file before commit, and another actor cannot use the token.
    expect(readFileSync(join(root, "output.md"), "utf8")).toBe(whole);
    await expect(plane.invoke(bob, "file_write", { request: "steal", node: linked.ref, stage: "commit", upload: begun.upload,
      size: String(offset), expected: begun.digest })).rejects.toThrow();
    const commit = { request: "staged-big", node: linked.ref, stage: "commit", upload: begun.upload, size: String(offset), expected: begun.digest };
    const saved = await plane.invoke(alice, "file_write", commit);
    expect(saved).toMatchObject({ status: "saved", sizeBytes: offset });
    expect(readFileSync(join(root, "output.md"), "utf8")).toBe(parts.join(""));
    // A retried save (a fresh upload of the same body, same request) joins the first receipt.
    const count = frames.length;
    expect(await plane.invoke(alice, "file_write", { ...commit, upload: "f".repeat(32) })).toEqual(saved);
    expect(frames).toHaveLength(count);

    // A stale staged save is refused at commit and leaves the newer file whole.
    const stale = await plane.invoke(alice, "file_write", { request: "staged-stale", node: linked.ref, stage: "begin" }) as { upload: string; digest: string };
    await plane.invoke(alice, "file_write", { request: "staged-stale", node: linked.ref, stage: "append", upload: stale.upload, offset: "0", text: "mine" });
    writeFileSync(join(root, "output.md"), "theirs");
    await expect(plane.invoke(alice, "file_write", { request: "staged-stale", node: linked.ref, stage: "commit", upload: stale.upload,
      size: "4", expected: stale.digest })).rejects.toThrow("本地文件已变化");
    expect(readFileSync(join(root, "output.md"), "utf8")).toBe("theirs");
    // Malformed commit arguments are refused before any intent: not an "unknown" write.
    await expect(plane.invoke(alice, "file_write", { request: "bad-size", node: linked.ref, stage: "commit", upload: stale.upload,
      size: "-1", expected: stale.digest })).rejects.toThrow();
    await expect(plane.invoke(alice, "file_write", { request: "bad-size", node: linked.ref, stage: "commit", upload: "nope",
      size: "4", expected: stale.digest })).rejects.toThrow("upload");
    // A whole save without text is malformed, not an empty file.
    await expect(plane.invoke(alice, "file_write", { request: "no-text", node: linked.ref })).rejects.toThrow("text");
    expect(readFileSync(join(root, "output.md"), "utf8")).toBe("theirs");
    // A commit must name the digest its upload was based on.
    await expect(plane.invoke(alice, "file_write", { request: "no-base", node: linked.ref, stage: "commit", upload: stale.upload, size: "4" }))
      .rejects.toThrow("expected");
  });

  it("does not repeat an indeterminate workspace write", async () => {
    const params = { path: "output.md", text: "changed", digest: "sha256:" + createHash("sha256").update("workspace file").digest("hex") };
    await native.files.write(alice, binding, params);
    writeFileSync(join(root, "output.md"), "another edit");
    await expect(native.files.write(alice, binding, params)).rejects.toThrow();
    expect(readFileSync(join(root, "output.md"), "utf8")).toBe("another edit");
    const count = frames.length;
    await expect(native.files.write(bob, binding, params)).rejects.toThrow("授权");
    await expect(native.files.write(alice, binding, { ...params, path: "../outside" })).rejects.toThrow();
    expect(frames).toHaveLength(count);
  });

  it("reads referenced files through the bound workspace and rejects traversal, stale versions and revoked members", async () => {
    const part = await native.files.read(bob, binding, {
      path: "/work/project/output.md",
    });
    expect(part).toMatchObject({
      file: { name: "output.md", mime: "text/markdown" },
      data: Buffer.from("workspace file").toString("base64"),
      next: null,
    });
    expect(frames.at(-1)).toMatchObject({
      owner: "alice",
      operation: "download_workspace_file",
      args: {
        workspace_id: binding.config.workspace,
        relative_path: "output.md",
      },
    });
    const count = frames.length;
    await expect(
      native.files.read(bob, binding, { path: "/work/secrets" }),
    ).rejects.toThrow("工作区");
    await expect(
      native.files.read(bob, binding, { path: "../secrets" }),
    ).rejects.toThrow("无效");
    expect(frames).toHaveLength(count);
    await expect(
      native.files.read(bob, binding, {
        path: "output.md",
        version: "sha256:stale",
      }),
    ).rejects.toThrow("文件已变化");
    store.removeSharedAppMember("research-v2", "project", "bob");
    await expect(
      native.files.read(bob, binding, { path: "output.md" }),
    ).rejects.toThrow("授权");
  });
});
