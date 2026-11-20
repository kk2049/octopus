import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchEvent,
  ResearchNode,
  ResourceBinding,
} from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import {
  ResearchResources,
  type ResearchFile,
  type ResearchResourceAdapters,
} from "./resources.js";

describe("project files and irreversible resource receipts", () => {
  let root: string,
    store: Store,
    graph: ResearchGraph,
    resources: ResearchResources;
  let events: ResearchEvent[], adapters: ResearchResourceAdapters;
  const context: ResearchContext = {
    project: "project",
    actor: { kind: "human", owner: "alice" },
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "research-resources-"));
    store = new Store(join(root, "state.db"));
    graph = new ResearchGraph(store, root);
    store.createSharedAppInstance(
      {
        app_id: "research-v2",
        instance_key: "project",
        creator: "alice",
        status: "open",
        created_at: new Date().toISOString(),
      },
      "owner",
    );
    events = [];
    adapters = {
      list: async () => [],
      validate: async () => {},
      read: async () => ({}),
      send: vi.fn(async () => "receipt"),
      transcribe: async () => ({ text: "会议结论", model: null }),
    };
    resources = new ResearchResources(
      graph,
      root,
      adapters,
      (event) => events.push(event),
      () => {},
    );
  });
  afterEach(() => {
    graph.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function node(type = "file", data = {}) {
    return (
      graph.mutate(context, "node_add", {
        request: crypto.randomUUID(),
        data: JSON.stringify({ type, title: type, data }),
      }) as { node: ResearchNode }
    ).node;
  }
  function begin(target: ResearchNode, bytes: Buffer) {
    return (
      resources.begin(context, {
        request: crypto.randomUUID(),
        node: target.id,
        data: JSON.stringify({
          name: "artifact.txt",
          mime: "text/plain",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      }) as { upload: { id: string } }
    ).upload.id;
  }
  function commit(target: ResearchNode, content: string) {
    const bytes = Buffer.from(content),
      upload = begin(target, bytes);
    resources.chunk(context, {
      upload,
      offset: "0",
      data: bytes.toString("base64"),
    });
    return {
      upload,
      file: (
        resources.commit(context, { upload, request: crypto.randomUUID() }) as {
          file: ResearchFile;
        }
      ).file,
    };
  }
  it("resumes after restart, checks duplicate chunks, and commits one event for one version", async () => {
    const collection = node("collection"),
      target = node("file", { collection: collection.id }),
      bytes = Buffer.from("完整产物");
    const upload = begin(target, bytes),
      chunk = {
        upload,
        offset: "0",
        data: bytes.subarray(0, 3).toString("base64"),
      };
    resources.chunk(context, chunk);
    resources = new ResearchResources(
      graph,
      root,
      adapters,
      (event) => events.push(event),
      () => {},
    );
    expect(resources.chunk(context, chunk)).toEqual({ received: 3 });
    expect(() =>
      resources.chunk(context, {
        ...chunk,
        data: Buffer.from("bad").toString("base64"),
      }),
    ).toThrow("不一致");
    expect(() =>
      resources.commit(context, { upload, request: "commit" }),
    ).toThrow("尚未完成");
    resources.chunk(context, {
      upload,
      offset: "3",
      data: bytes.subarray(3).toString("base64"),
    });
    const first = resources.commit(context, { upload, request: "commit" });
    expect(resources.commit(context, { upload, request: "commit" })).toEqual(
      first,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: collection.id,
      type: "file.created",
    });
    const read = (await resources.read(context, { node: target.id })) as {
      data: string;
    };
    expect(Buffer.from(read.data, "base64")).toEqual(bytes);
  });
  it("accepts a version past the old 64 MiB ceiling and refuses only what the disk cannot hold", () => {
    const target = node("audio"),
      declare = (bytes: number) =>
        resources.begin(context, {
          request: crypto.randomUUID(),
          node: target.id,
          data: JSON.stringify({ name: "long.wav", mime: "audio/wav", bytes, sha256: "a".repeat(64) }),
        }) as { upload: { id: string; bytes: number } };
    const large = declare(100 * 1024 * 1024).upload;
    expect(large.bytes).toBe(100 * 1024 * 1024);
    expect(
      resources.chunk(context, { upload: large.id, offset: "0", data: Buffer.alloc(32_000).toString("base64") }),
    ).toEqual({ received: 32_000 });
    expect(() => declare(Number.MAX_SAFE_INTEGER)).toThrow("磁盘剩余空间不足");
  });
  it("keeps a pinned old file readable after a newer committed version", async () => {
    const target = node(),
      first = commit(target, "旧版"),
      next = commit(target, "新版");
    expect(first.file.id).not.toBe(next.file.id);
    expect(next.file.version).toBe(2);
    const old = (await resources.read(context, {
      node: target.id,
      version: first.file.id,
    })) as { data: string };
    expect(Buffer.from(old.data, "base64").toString()).toBe("旧版");
    expect(events.at(-1)?.type).toBe("file.updated");
    expect(() => resources.file(context, node().id, first.file.id)).toThrow(
      "不存在",
    );
  });
  it("treats an empty first cursor as zero and pins read-only source files", async () => {
    const bytes = Buffer.from("固定来源"),
      sha256 = createHash("sha256").update(bytes).digest("hex"),
      target = node("file", {
        meta: { read_only: true, bytes: bytes.length, sha256 },
      });
    const upload = begin(target, bytes);
    resources.chunk(context, {
      upload,
      offset: "0",
      data: bytes.toString("base64"),
    });
    resources.commit(context, { upload, request: "readonly-commit" });
    const read = (await resources.read(context, {
      node: target.id,
      cursor: "",
    })) as { data: string };
    expect(Buffer.from(read.data, "base64")).toEqual(bytes);
    expect(() =>
      resources.begin(context, {
        request: "readonly-replacement",
        node: target.id,
        data: JSON.stringify({
          name: "replacement.txt",
          mime: "text/plain",
          bytes: bytes.length,
          sha256,
        }),
      }),
    ).toThrow("只读来源节点不能覆盖");
    expect(() =>
      resources.begin(context, {
        request: "readonly-mismatch",
        node: node("file", {
          meta: { read_only: true, bytes: bytes.length, sha256 },
        }).id,
        data: JSON.stringify({
          name: "wrong.txt",
          mime: "text/plain",
          bytes: 1,
          sha256: createHash("sha256").update("x").digest("hex"),
        }),
      }),
    ).toThrow("只读来源文件摘要不匹配");
  });
  it("refuses a complete but corrupted upload without publishing a file or event", () => {
    const upload = begin(node(), Buffer.from("good"));
    resources.chunk(context, {
      upload,
      offset: "0",
      data: Buffer.from("evil").toString("base64"),
    });
    expect(() =>
      resources.commit(context, { upload, request: "commit" }),
    ).toThrow("完整性");
    expect(events).toEqual([]);
  });
  it("does not repeat an externally ambiguous group send, including after restart", async () => {
    const target = node("group");
    await resources.bind(context, {
      request: "bind",
      node: target.id,
      data: JSON.stringify({ kind: "group", resource: "oc_test", config: {} }),
    });
    vi.mocked(adapters.send).mockRejectedValue(new Error("lost response"));
    expect(
      await resources.send(context, {
        node: target.id,
        request: "send",
        text: "结论",
      }),
    ).toMatchObject({ status: "unknown" });
    resources = new ResearchResources(
      graph,
      root,
      adapters,
      () => {},
      () => {},
    );
    expect(
      await resources.send(context, {
        node: target.id,
        request: "send",
        text: "结论",
      }),
    ).toMatchObject({ status: "unknown" });
    expect(adapters.send).toHaveBeenCalledTimes(1);
    await expect(
      resources.send(context, {
        node: target.id,
        request: "send",
        text: "另一个结论",
      }),
    ).rejects.toThrow("其他消息");
  });
  it("records one transcription artifact with the original audio version and decision maker", () => {
    const audio = node("audio"),
      original = commit(audio, "audio").file;
    const agent: ResearchContext = {
      ...context,
      actor: {
        kind: "agent",
        owner: "alice",
        trigger: "bob",
        agent: audio.id,
        run: "transcription-run",
        model: "actual-transcriber",
      },
    };
    const artifact = resources.transcriptionArtifact(
      agent,
      audio.id,
      original.id,
      "会议记录",
    );
    expect(
      resources.transcriptionArtifact(agent, audio.id, original.id, "会议记录")
        .id,
    ).toBe(artifact.id);
    expect(artifact.created).toMatchObject({
      owner: "alice",
      trigger: "bob",
      model: "actual-transcriber",
    });
    expect(
      events.filter((event) => event.type === "audio.transcribed"),
    ).toHaveLength(1);
    expect(events.at(-1)?.payload).toMatchObject({
      audioVersion: original.id,
      artifact: artifact.id,
    });
    expect(
      graph.repo.get<ResourceBinding>("project", "bindings", artifact.id)?.kind,
    ).toBe("file");
  });
  it("retains the causal event chain through an Agent-produced file", () => {
    const target = node(),
      bytes = Buffer.from("result"),
      upload = begin(target, bytes);
    resources.chunk(context, {
      upload,
      offset: "0",
      data: bytes.toString("base64"),
    });
    graph.repo.put("project", "runs", "parent", {
      id: "parent",
      root: "origin-event",
      chain: ["subscription-one"],
    });
    resources.commit(
      { ...context, actor: { kind: "agent", owner: "alice", run: "parent" } },
      { upload, request: "commit" },
    );
    expect(events.at(-1)).toMatchObject({
      root: "origin-event",
      chain: ["subscription-one"],
    });
  });
  it("rechecks resource owner consent and never sends after it is revoked", async () => {
    const target = node("group");
    await resources.bind(context, {
      request: "binding",
      node: target.id,
      data: JSON.stringify({ kind: "group", resource: "oc_test", config: {} }),
    });
    resources = new ResearchResources(
      graph,
      root,
      adapters,
      () => {},
      () => {},
      () => false,
    );
    await expect(
      resources.send(context, {
        request: "send",
        node: target.id,
        text: "message",
      }),
    ).rejects.toThrow("授权");
    expect(adapters.send).not.toHaveBeenCalled();
  });
});
