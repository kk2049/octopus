import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Json,
  ResearchEvent,
  ResearchNode,
  ResourceBinding,
  DiscussionSourceStage,
  MeetingSummaryExecution,
} from "@claude-bot/research-canvas-contract";
import type { ResearchContext, ResearchGraph } from "./graph.js";
import type { SourceProgress, SourceTranscription } from "./moss.js";
import type { DiscussionSummary } from "./source-summary.js";
import type { DiscussionSegment } from "@claude-bot/research-canvas-contract";
import { ensureFreeSpace } from "./disk.js";
import {
  base64,
  digest,
  id,
  integer,
  jsonObject,
  parse,
  text,
} from "./validation.js";

export interface ResourceChoice {
  id: string;
  kind: ResourceBinding["kind"];
  title: string;
  config: Record<string, Json>;
}
export interface ResearchResourceAdapters {
  list(owner: string): Promise<ResourceChoice[]>;
  validate(
    owner: string,
    kind: ResourceBinding["kind"],
    resource: string,
    config: Record<string, Json>,
  ): Promise<void>;
  read(
    binding: ResourceBinding,
    cursor?: string,
    version?: string,
  ): Promise<unknown>;
  send(
    binding: ResourceBinding,
    message: string,
    request: string,
    current?: () => void,
  ): Promise<string>;
  transcribe(
    binding: ResourceBinding,
    file: { path: string; name: string; mime: string },
    signal: AbortSignal,
    progress?: SourceProgress,
    current?: () => void,
  ): Promise<SourceTranscription>;
  summarize?(binding: ResourceBinding, input: { source: string; title: string; segments: DiscussionSegment[] }, signal: AbortSignal): Promise<DiscussionSummary>;
  createGroup?(owner: string, input: { title: string; agenda: string; request: string }): Promise<string>;
}
interface Upload {
  id: string;
  node: string;
  owner: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  received: number;
  state: "uploading" | "committed";
  file: string | null;
  created: string;
}
export interface ResearchFile {
  id: string;
  node: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  version: number;
  at: string;
  owner: string;
}
interface Outbox {
  id: string;
  node: string;
  owner: string;
  fingerprint: string;
  text: string;
  status: "sending" | "sent" | "unknown";
  message: string | null;
  at: string;
}

export class ResearchResources {
  private sourceProcessor?: (context: ResearchContext, binding: ResourceBinding, file: ResearchFile, signal: AbortSignal) => Promise<{ artifact: ResearchNode; model: string | null }>;
  attachSourceProcessor(process: NonNullable<ResearchResources["sourceProcessor"]>): void { this.sourceProcessor = process; }
  async processTranscription(context: ResearchContext, binding: ResourceBinding, file: ResearchFile, signal: AbortSignal): Promise<{ artifact: ResearchNode; model: string | null }> {
    if (this.sourceProcessor) return this.sourceProcessor(context, binding, file, signal);
    const result = await this.adapters.transcribe(binding, { path: this.blobPath(file.sha256), name: file.name, mime: file.mime }, signal);
    return { artifact: this.transcriptionArtifact(context, binding.node, file.id, result.text), model: result.model };
  }
  constructor(
    readonly graph: ResearchGraph,
    private readonly root: string,
    readonly adapters: ResearchResourceAdapters,
    private readonly emit: (event: ResearchEvent) => void,
    private readonly changed: (project: string) => void,
    private readonly ownerAllowed: (
      context: ResearchContext,
      binding: ResourceBinding,
      operation: string,
    ) => boolean = () => true,
  ) {
    mkdirSync(join(root, "uploads"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "blobs"), { recursive: true, mode: 0o700 });
    for (const project of graph.repo.projects())
      for (const row of graph.records<Outbox>(project, "outbox")) {
        if (row.status === "sending")
          graph.repo.put(project, "outbox", row.id, {
            ...row,
            status: "unknown",
          });
      }
  }
  async list(context: ResearchContext): Promise<ResourceChoice[]> {
    this.graph.role(context);
    return this.adapters.list(context.actor.owner);
  }
  binding(
    context: ResearchContext,
    node: string,
    kind?: ResourceBinding["kind"],
    operation = "read_project",
  ): ResourceBinding {
    this.graph.role(context);
    this.graph.resourceNode(context.project, node);
    const binding = this.graph.repo.get<ResourceBinding>(
      context.project,
      "bindings",
      node,
    );
    if (!binding || binding.archived || (kind && binding.kind !== kind))
      throw new Error("节点尚未绑定可用资源");
    this.graph.role({
      project: context.project,
      actor: { kind: "human", owner: binding.owner },
    });
    if (!this.ownerAllowed(context, binding, operation))
      throw new Error("资源归属人的项目授权已撤销");
    return binding;
  }
  async bind(
    context: ResearchContext,
    params: Record<string, string>,
    current: () => void = () => {},
  ): Promise<unknown> {
    current();
    this.graph.authorize(context, "manage_resources");
    const data = parse(params.data),
      node = this.graph.resourceNode(context.project, params.node);
    const kind = text(data.kind, "资源类型", 32) as ResourceBinding["kind"];
    if (!(node.type === kind || (node.type === "agent" && kind === "session")))
      throw new Error("资源类型与节点不匹配");
    if (!["agent", "session", "group"].includes(kind))
      throw new Error("文件和音频通过上传绑定");
    const config = jsonObject(data.config),
      resource = text(data.resource, "资源", 512);
    // Positive owner evidence is obtained from the adapter, never a client flag.
    await this.adapters.validate(context.actor.owner, kind, resource, config);
    current();
    this.graph.authorize(context, "manage_resources");
    this.graph.resourceNode(context.project, node.id);
    const fingerprint = digest({ action: "resource_bind", params });
    return this.graph.repo.atomic(() => {
      const prior = this.graph.repo.receipt(
        context.project,
        context.actor.owner,
        params.request,
        fingerprint,
      );
      if (prior) return prior;
      const old = this.graph.repo.get<ResourceBinding>(
        context.project,
        "bindings",
        node.id,
      );
      const stamp = this.graph.provenance(context);
      const binding: ResourceBinding = {
        id: node.id,
        node: node.id,
        kind,
        owner: context.actor.owner,
        resource,
        config,
        version: (old?.version ?? 0) + 1,
        archived: false,
        created: old?.created ?? stamp,
        updated: stamp,
      };
      this.graph.repo.put(
        context.project,
        "bindings",
        node.id,
        binding,
        old?.version ?? 0,
      );
      this.graph.repo.remember(
        context.project,
        context.actor.owner,
        params.request,
        fingerprint,
        { binding },
      );
      this.changed(context.project);
      return { binding };
    });
  }
  async read(
    context: ResearchContext,
    params: Record<string, string>,
  ): Promise<unknown> {
    const node = this.graph.resourceNode(context.project, params.node);
    this.graph.role(context);
    if (node.type === "file" || node.type === "audio")
      return this.readFile(context, params);
    const binding = this.binding(context, node.id);
    const result = await this.adapters.read(
      binding,
      params.cursor,
      params.version,
    );
    if (this.binding(context, node.id).version !== binding.version)
      throw new Error("读取期间资源绑定已变化");
    return result;
  }
  begin(context: ResearchContext, params: Record<string, string>): unknown {
    this.graph.authorize(context, "edit_project");
    const node = this.graph.resourceNode(context.project, params.node);
    if (!["file", "audio"].includes(node.type))
      throw new Error("请选择文件或会议音频节点");
    if (node.data.workspace) throw new Error("此节点指向真实工作区文件，请使用 file_write 保存");
    const data = parse(params.data);
    const meta = node.data.meta;
    const readOnly =
      meta && typeof meta === "object" && !Array.isArray(meta) &&
      meta.read_only === true;
    const fingerprint = digest({ action: "file_begin", params });
    const prior = this.graph.repo.receipt(
      context.project,
      context.actor.owner,
      params.request,
      fingerprint,
    );
    if (prior)
      return {
        upload: this.upload(context, (prior as { upload: Upload }).upload.id),
      };
    const sha256 = text(data.sha256, "文件校验值", 64);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("文件 SHA-256 无效");
    if (readOnly) {
      const expectedSha = typeof meta.sha256 === "string" ? meta.sha256 : "";
      const expectedBytes =
        typeof meta.bytes === "number" ? meta.bytes : undefined;
      if (
        !expectedSha ||
        expectedBytes === undefined ||
        sha256 !== expectedSha ||
        data.bytes !== expectedBytes
      )
        throw new Error("只读来源文件摘要不匹配");
      if (this.graph.repo.fileVersions(context.project, node.id, "").length)
        throw new Error("只读来源节点不能覆盖");
    }
    const upload: Upload = {
      id: id("upload"),
      node: node.id,
      owner: context.actor.owner,
      name: text(data.name, "文件名", 240),
      mime: text(data.mime, "文件类型", 160, "application/octet-stream"),
      // Any size: chunks are bounded windows and the commit hashes the staged file in 256 KiB reads.
      bytes: integer(data.bytes, 0, Number.MAX_SAFE_INTEGER),
      sha256,
      received: 0,
      state: "uploading",
      file: null,
      created: new Date().toISOString(),
    };
    ensureFreeSpace(join(this.root, "blobs"), upload.bytes);
    const handle = openSync(this.uploadPath(upload.id), "wx", 0o600);
    closeSync(handle);
    this.graph.repo.atomic(() => {
      this.graph.repo.put(
        context.project,
        "uploads",
        upload.id,
        upload,
        0,
        false,
      );
      this.graph.repo.remember(
        context.project,
        context.actor.owner,
        params.request,
        fingerprint,
        { upload },
      );
    });
    return { upload };
  }
  chunk(context: ResearchContext, params: Record<string, string>): unknown {
    this.graph.authorize(context, "edit_project");
    const upload = this.upload(context, params.upload);
    if (upload.state === "committed")
      return { received: upload.received, committed: true };
    const bytes = base64(params.data, 36_000),
      offset = integer(params.offset, 0, upload.bytes);
    if (offset + bytes.length > upload.bytes || offset > upload.received)
      throw new Error("上传偏移不连续");
    const path = this.uploadPath(upload.id);
    const fd = openSync(path, "r+");
    try {
      if (offset < upload.received) {
        const old = Buffer.alloc(bytes.length);
        readSync(fd, old, 0, bytes.length, offset);
        if (offset + bytes.length > upload.received || !old.equals(bytes))
          throw new Error("重复上传块与原内容不一致");
      } else {
        ensureFreeSpace(join(this.root, "blobs"), bytes.length);
        // A crash after fsync and before the SQLite ack leaves a safe trailing block.
        truncateSync(path, upload.received);
        writeSync(fd, bytes, 0, bytes.length, offset);
        fsyncSync(fd);
        upload.received += bytes.length;
        this.graph.repo.put(
          context.project,
          "uploads",
          upload.id,
          upload,
          null,
          false,
        );
      }
    } finally {
      closeSync(fd);
    }
    return { received: upload.received };
  }
  commit(context: ResearchContext, params: Record<string, string>): unknown {
    this.graph.authorize(context, "edit_project");
    const upload = this.upload(context, params.upload);
    if (upload.state === "committed")
      return {
        file: this.graph.repo.get(context.project, "files", upload.file!),
      };
    if (upload.received !== upload.bytes) throw new Error("上传尚未完成");
    const temporary = this.uploadPath(upload.id),
      final = this.blobPath(upload.sha256);
    const path = existsSync(temporary) ? temporary : final;
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(256 * 1024),
      fd = openSync(path, "r");
    try {
      for (let offset = 0; offset < upload.bytes; ) {
        const n = readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, upload.bytes - offset),
          offset,
        );
        if (!n) throw new Error("上传文件不完整");
        hash.update(buffer.subarray(0, n));
        offset += n;
      }
    } finally {
      closeSync(fd);
    }
    if (
      statSync(path).size !== upload.bytes ||
      hash.digest("hex") !== upload.sha256
    )
      throw new Error("文件完整性校验失败");
    if (path === temporary) {
      renameSync(temporary, final);
      const dir = openSync(join(this.root, "blobs"), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
    return this.graph.repo.atomic(() => {
      const old = this.graph.repo.get<ResourceBinding>(
        context.project,
        "bindings",
        upload.node,
      );
      const node = this.graph.resourceNode(context.project, upload.node);
      const meta = node.data.meta;
      const readOnly =
        meta && typeof meta === "object" && !Array.isArray(meta) &&
        meta.read_only === true;
      if (readOnly) {
        const expectedSha =
          typeof meta.sha256 === "string" ? meta.sha256 : "";
        const expectedBytes =
          typeof meta.bytes === "number" ? meta.bytes : undefined;
        if (
          !expectedSha ||
          expectedBytes === undefined ||
          upload.sha256 !== expectedSha ||
          upload.bytes !== expectedBytes
        )
          throw new Error("只读来源文件摘要不匹配");
        if (old) throw new Error("只读来源节点不能覆盖");
      }
      const stamp = this.graph.provenance(context),
        version = (old?.version ?? 0) + 1;
      const file: ResearchFile = {
        id: id("file"),
        node: upload.node,
        name: upload.name,
        mime: upload.mime,
        bytes: upload.bytes,
        sha256: upload.sha256,
        version,
        at: stamp.at,
        owner: context.actor.owner,
      };
      this.graph.repo.put(context.project, "files", file.id, file, 0);
      const binding: ResourceBinding = {
        id: node.id,
        node: node.id,
        kind: node.type === "audio" ? "audio" : "file",
        owner: context.actor.owner,
        resource: file.id,
        config: {},
        version,
        archived: false,
        created: old?.created ?? stamp,
        updated: stamp,
      };
      this.graph.repo.put(
        context.project,
        "bindings",
        node.id,
        binding,
        old?.version ?? 0,
      );
      this.graph.repo.put(
        context.project,
        "uploads",
        upload.id,
        { ...upload, state: "committed", file: file.id },
        null,
        false,
      );
      if (node.type === "audio") this.meetingStatus(context.project, node.id, file.id, "uploaded");
      this.emit({
        id: `file:${file.id}`,
        project: context.project,
        source: old ? node.id : String(node.data.collection || node.id),
        type: old ? "file.updated" : "file.created",
        version,
        at: stamp.at,
        trigger: stamp.trigger,
        ...this.eventTrace(context, `file:${file.id}`),
        payload: { node: node.id, file: file.id, name: file.name },
      });
      this.changed(context.project);
      return { file };
    });
  }
  versions(context: ResearchContext, params: Record<string, string>): unknown {
    this.graph.role(context);
    this.graph.resourceNode(context.project, params.node);
    const rows = this.graph.repo.fileVersions(
      context.project,
      params.node,
      params.after ?? "",
    );
    return {
      files: rows.slice(0, 100),
      next: rows.length > 100 ? rows[99].id : null,
    };
  }
  /** Lightweight card projection. Never put audio bytes or transcript text in graph snapshots. */
  meetingStatus(project: string, nodeId: string, fileId: string, stage: DiscussionSourceStage, summaryState?: MeetingSummaryExecution["state"]): void {
    const binding = this.graph.repo.get<ResourceBinding>(project, "bindings", nodeId);
    if (binding?.resource !== fileId) return;
    const file = this.graph.repo.get<ResearchFile>(project, "files", fileId);
    const node = this.graph.repo.get<ResearchNode>(project, "node-resources", nodeId);
    if (!file || !node || node.type !== "audio") return;
    const meta = node.data.meta && typeof node.data.meta === "object" && !Array.isArray(node.data.meta) ? node.data.meta : {};
    const meeting = { fileVersion: file.version, fileName: file.name, bytes: file.bytes, stage, ...(summaryState ? { summaryState } : {}) };
    if (digest(meta.meeting ?? null) === digest(meeting)) return;
    this.graph.repo.put(project, "node-resources", node.id, { ...node, version: node.version + 1,
      data: { ...node.data, meta: { ...meta, meeting } } }, node.version);
    this.changed(project);
  }
  file(context: ResearchContext, node: string, version?: string): ResearchFile {
    this.graph.role(context);
    this.graph.resourceNode(context.project, node);
    const binding = this.graph.repo.get<ResourceBinding>(
      context.project,
      "bindings",
      node,
    );
    const file = this.graph.repo.get<ResearchFile>(
      context.project,
      "files",
      version || binding?.resource || "",
    );
    if (!file || file.node !== node) throw new Error("文件版本不存在");
    return file;
  }
  private readFile(
    context: ResearchContext,
    params: Record<string, string>,
  ): unknown {
    const file = this.file(context, params.node, params.version);
    // Optional wire fields may be normalized to an empty string by a typed
    // port. Treat that representation exactly like an omitted first cursor.
    const cursor = params.cursor || "0",
      offset = integer(cursor, 0, file.bytes),
      data = Buffer.alloc(Math.min(24_000, file.bytes - offset));
    const fd = openSync(this.blobPath(file.sha256), "r");
    try {
      const n = readSync(fd, data, 0, data.length, offset);
      return {
        file,
        offset,
        data: data.subarray(0, n).toString("base64"),
        next: offset + n < file.bytes ? offset + n : null,
      };
    } finally {
      closeSync(fd);
    }
  }
  transcriptionArtifact(
    context: ResearchContext,
    source: string,
    audioVersion: string,
    content: string,
  ): ResearchNode {
    const key = `transcription:${audioVersion}`,
      fingerprint = digest([source, audioVersion]);
    const previous = this.graph.repo.receipt<ResearchNode>(
      context.project,
      context.actor.owner,
      key,
      fingerprint,
    );
    if (previous) return previous;
    const bytes = Buffer.from(content, "utf8"),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = this.blobPath(sha256);
    if (!existsSync(path)) {
      const temporary = this.uploadPath(id("artifact")),
        fd = openSync(temporary, "wx", 0o600);
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      const dir = openSync(join(this.root, "blobs"), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
    return this.graph.repo.atomic(() => {
      const audio = this.graph.resourceNode(context.project, source);
      const { node } = this.graph.mutate(context, "node_add", {
        request: `${key}:node`,
        data: JSON.stringify({
          type: "file",
          title: `${audio.title} · 转写.md`,
          x: audio.x + 320,
          y: audio.y,
          summary: "会议音频的完整转写，保留原录音版本与模型来源。",
        }),
      }) as { node: ResearchNode };
      const stamp = this.graph.provenance(context);
      const file: ResearchFile = {
        id: id("file"),
        node: node.id,
        name: node.title,
        mime: "text/markdown",
        bytes: bytes.length,
        sha256,
        version: 1,
        at: stamp.at,
        owner: context.actor.owner,
      };
      this.graph.repo.put(context.project, "files", file.id, file, 0);
      this.graph.repo.put(
        context.project,
        "bindings",
        node.id,
        {
          id: node.id,
          node: node.id,
          kind: "file",
          owner: context.actor.owner,
          resource: file.id,
          config: {},
          version: 1,
          archived: false,
          created: stamp,
          updated: stamp,
        } satisfies ResourceBinding,
        0,
      );
      this.graph.mutate(context, "edge_add", {
        request: `${key}:edge`,
        source,
        target: node.id,
        label: "转写",
      });
      this.graph.repo.remember(
        context.project,
        context.actor.owner,
        key,
        fingerprint,
        node,
      );
      this.emit({
        id: key,
        project: context.project,
        source,
        type: "audio.transcribed",
        version: 1,
        at: stamp.at,
        trigger: stamp.trigger,
        ...this.eventTrace(context, key),
        payload: { audioVersion, artifact: node.id, file: file.id },
      });
      this.changed(context.project);
      return node;
    });
  }
  /** Preserve the existing listener event for a complete first-party source, once per audio version. */
  transcriptionCompleted(context: ResearchContext, source: string, audioVersion: string, artifact: ResearchNode): void {
    const key = `transcription:${audioVersion}`, fingerprint = digest([source, audioVersion, artifact.id]);
    if (this.graph.repo.receipt(context.project, "source-transcription-event", key, fingerprint)) return;
    const file = this.file(context, artifact.id), stamp = this.graph.provenance(context);
    this.graph.repo.atomic(() => {
      this.emit({ id: key, project: context.project, source, type: "audio.transcribed", version: 1,
        at: stamp.at, trigger: stamp.trigger, ...this.eventTrace(context, key),
        payload: { audioVersion, artifact: artifact.id, file: file.id } });
      this.graph.repo.remember(context.project, "source-transcription-event", key, fingerprint, { emitted: true });
    });
  }
  /** Source artifacts use the existing upload/version path and durable idempotency. */
  sourceFile(context: ResearchContext, source: string, sourceVersion: string, kind: string, content: string, mime = "text/markdown"): ResearchNode {
    this.graph.authorize(context, "edit_graph");
    const parent = this.graph.resourceNode(context.project, source);
    const bytes = Buffer.from(content, "utf8"), sha256 = createHash("sha256").update(bytes).digest("hex");
    const request = "source_" + digest([source, sourceVersion, kind]).slice(0, 40);
    const result = this.graph.mutate(context, "node_add", { request: request + "_node", data: JSON.stringify({ type: "file",
      title: `${parent.title} · ${kind}`, summary: "讨论来源的固定派生文件，保留原始版本与来源。",
      data: { meta: { sourceNode: parent.id, sourceVersion, read_only: true, sha256, bytes: bytes.length, sourceKind: kind } } }) }) as { node: ResearchNode };
    const existing = this.graph.repo.get<ResourceBinding>(context.project, "bindings", result.node.id);
    if (existing) {
      const file = this.file(context, result.node.id);
      if (file.sha256 !== sha256) throw new Error("同一来源版本的固定产物内容已变化");
      return result.node;
    }
    const begin = this.begin(context, { request: request + "_begin", node: result.node.id, data: JSON.stringify({
      name: `${parent.title}-${kind}.${mime === "application/json" ? "json" : "md"}`, mime, bytes: bytes.length, sha256 }) }) as { upload: { id: string; received: number } };
    for (let offset = begin.upload.received; offset < bytes.length; offset += 32000)
      this.chunk(context, { upload: begin.upload.id, offset: String(offset), data: bytes.subarray(offset, offset + 32000).toString("base64") });
    this.commit(context, { request: request + "_commit", upload: begin.upload.id });
    this.graph.mutate(context, "edge_add", { request: request + "_edge", source: result.node.id, target: parent.id, label: "依据" });
    return result.node;
  }
  async send(
    context: ResearchContext,
    params: Record<string, string>,
  ): Promise<unknown> {
    this.graph.authorize(context, "send_message");
    const binding = this.binding(context, params.node, "group", "send_message"),
      message = text(params.text, "消息", 8000);
    const key = `send_${digest([context.actor.owner, params.request])}`,
      fingerprint = digest([binding.id, binding.version, message]);
    const existing = this.graph.repo.get<Outbox>(
      context.project,
      "outbox",
      key,
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("发送请求 ID 已用于其他消息");
      return existing;
    }
    const row: Outbox = {
      id: key,
      node: binding.node,
      owner: context.actor.owner,
      fingerprint,
      text: message,
      status: "sending",
      message: null,
      at: new Date().toISOString(),
    };
    this.graph.repo.put(context.project, "outbox", key, row, 0);
    try {
      const receipt = await this.adapters.send(binding, message, key, () => {
        this.graph.authorize(context, "send_message");
        if (
          this.binding(context, binding.node, "group", "send_message")
            .version !== binding.version
        )
          throw new Error("发送前群绑定已变化");
      });
      this.graph.repo.put(context.project, "outbox", key, {
        ...row,
        status: "sent",
        message: receipt,
      });
      this.changed(context.project);
      return { status: "sent", message: receipt };
    } catch {
      this.graph.repo.put(context.project, "outbox", key, {
        ...row,
        status: "unknown",
      });
      this.changed(context.project);
      return {
        status: "unknown",
        id: key,
        message: "飞书发送结果未确认，请核对群历史；不会自动重试",
      };
    }
  }
  private upload(context: ResearchContext, key: string): Upload {
    const upload = this.graph.repo.get<Upload>(context.project, "uploads", key);
    if (!upload || upload.owner !== context.actor.owner)
      throw new Error("上传不存在或不属于当前成员");
    this.graph.resourceNode(context.project, upload.node);
    return upload;
  }
  private eventTrace(
    context: ResearchContext,
    fallback: string,
  ): { root: string; chain: string[] } {
    const parent = context.actor.run
      ? this.graph.repo.get<{ root: string; chain: string[] }>(
          context.project,
          "runs",
          context.actor.run,
        )
      : null;
    return { root: parent?.root ?? fallback, chain: parent?.chain ?? [] };
  }
  private uploadPath(key: string): string {
    return join(this.root, "uploads", digest(key));
  }
  blobPath(sha: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("文件校验值无效");
    return join(this.root, "blobs", sha);
  }
}
