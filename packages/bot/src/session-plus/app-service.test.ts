import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readResourceBindings } from "@claude-bot/agent-module-contract";
import { WIRE_PARAM_LIMITS } from "@claude-bot/typed-port-kit";
import { WORKSPACE_FILES_LIMITS } from "@claude-bot/workspace-files-contract";
import { AppRuntimeService, InProcessRuntimeClient } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { bundledAppDir } from "../app-core/app-path.js";
import { SessionPlusAppService } from "./app-service.js";
import { sessionPlusIdentity, type SessionPlusIdentity } from "../app-core/identity.js";
import { loadSessionPlusManifest, type SessionPlusManifest } from "../app-core/manifest.js";
import { SessionPlusOperationBinding } from "./operation-binding.js";
import { SessionPlusInteractionBinding } from "./interaction-binding.js";
import type { SessionPlusSessionChangeBinding } from "./session-change-binding.js";
import type {
  SessionResourceExecuteOptions,
  SessionResourcePort,
  SessionResourceResult,
  SessionResourceWatchEvent,
} from "../session-resource/types.js";
import type {
  SessionOperationCoordinator,
  SessionOperationView,
} from "../sessionhub/operations.js";
import type { SessionHubService } from "../sessionhub/service.js";
import { resourceId } from "../sessionhub/core.js";
import { Store } from "../store/store.js";
import { SessionSharingService } from "./sharing.js";

const dirs: string[] = [];
const runtimes: AppRuntimeService[] = [];
const states: AppStateService[] = [];
const apps: SessionPlusAppService[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.stop();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const state of states.splice(0)) state.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
interface FixtureOptions {
  manifest?: SessionPlusManifest;
  attachments?: (input: { name: string; mediaType: string; data: string }) => Promise<
    | { ok: true; attachment: { label: string; path: string; bytes: number } }
    | { ok: false; message: string }
  >;
}


function fixture(
  now: () => number = () => Date.parse("2026-08-04T00:00:00.000Z"),
  instanceLimits?: { perCredential: number; perOwner: number; global: number },
  options: FixtureOptions = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "session-plus-app-"));
  dirs.push(dir);
  const state = new AppStateService(dir);
  const runtime = new AppRuntimeService(bundledAppDir("session-plus"));
  states.push(state);
  runtimes.push(runtime);
  const app = new SessionPlusAppService({
    state: new InProcessStateClient(state),
    runtime: new InProcessRuntimeClient(runtime),
    identity: sessionPlusIdentity(),
    now,
    instanceLimits,
    ...(options.manifest ? { manifest: options.manifest } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {}),
  });
  apps.push(app);
  return app;
}

const alice = { owner: "alice", credential: "ws:one", session: true };

function uploadChunk(index = 0, count = 1) {
  return {
    action: "attach_file",
    params: {
      resource: "upload-session", name: "image.png", media_type: "image/png",
      chunk_index: String(index), chunk_count: String(count), data: "aGVsbG8=",
      ...(index ? { upload_id: "abcdefghijklmnopqrstuvwx" } : {}),
    },
  };
}

describe("SessionPlusAppService", () => {
  it("acknowledges every upload chunk without retransmitting a large roster/transcript or publishing no-op frames", async () => {
    const app = fixture();
    const roster = {
      sessions: Array.from({ length: 500 }, (_, index) => ({ resourceId: `session-${index}`, projectLabel: "Session Plus" })),
      transcript: { "upload-session": { messages: Array.from({ length: 73 }, () => ({ role: "assistant", content: "x".repeat(4096) })) } },
    };
    const attachment = { label: "image.png", path: "/tmp/upload/image.png", bytes: 8 * 1024 * 1024 };
    const execute = vi.fn(async (_id: string, action: string, params: Readonly<Record<string, string>>): Promise<SessionResourceResult> => {
      if (action === "refresh_sessions") return { ok: true, result: null, patch: roster };
      const complete = params.chunk_index === "31";
      return {
        ok: true, patch: {},
        result: { upload_id: "abcdefghijklmnopqrstuvwx", complete, ...(complete ? { attachment } : { received_bytes: (Number(params.chunk_index) + 1) * 256 * 1024 }) },
      };
    });
    app.attachAuthority({ open() {}, destroy: () => true }, { execute });
    const opened = await app.open(alice);
    const loaded = await app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: {} });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("roster failed");
    const projectionBytes = Buffer.byteLength(JSON.stringify(loaded.projection));
    expect(projectionBytes).toBeGreaterThan(300_000);
    const events: unknown[] = [];
    app.subscribe(opened.handle, alice, (event) => events.push(event));
    events.length = 0;
    execute.mockClear();
    let receiptBytes = 0;
    for (let index = 0; index < 32; index += 1) {
      const answer = await app.dispatch(opened.handle, alice, uploadChunk(index, 32));
      expect(answer).toMatchObject({ ok: true, revision: loaded.revision, result: { complete: index === 31 } });
      expect(answer).not.toHaveProperty("projection");
      if (index === 31) expect(answer).toMatchObject({ result: { attachment } });
      else expect(answer).not.toHaveProperty("result.attachment");
      receiptBytes += Buffer.byteLength(JSON.stringify(answer));
    }
    expect(execute).toHaveBeenCalledTimes(32);
    expect(events).toEqual([]);
    expect(receiptBytes).toBeLessThan(16_384);
    // Before the fix each chunk carried the projection twice (HTTP and SSE).
    expect(receiptBytes).toBeLessThan(projectionBytes * 32 * 2 / 100);
    const pinned = await app.dispatch(opened.handle, alice, { action: "pin_session", params: { session: "session-0" } });
    expect(pinned).toMatchObject({ ok: true, revision: loaded.revision + 1, projection: { ...roster, pinned: ["session-0"] } });
  });

  it("admits a human launch upload with an execution target and no session resource", async () => {
    const app = fixture();
    const execute = vi.fn(async (): Promise<SessionResourceResult> => ({ ok: true, patch: {},
      result: { upload_id: "abcdefghijklmnopqrstuvwx", complete: true, attachment: { label: "notes.txt", path: "/tmp/notes.txt" } } }));
    app.attachAuthority({ open() {}, destroy: () => true }, { execute });
    const opened = await app.open(alice);
    const { resource: _resource, ...params } = uploadChunk().params;
    expect(await app.dispatch(opened.handle, alice, { action: "attach_file", params: { ...params, device: "laptop" } })).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps upload refusals actionable and does not replay the write", async () => {
    const app = fixture();
    const execute = vi.fn(async (): Promise<SessionResourceResult> => ({ ok: false, code: "approval_required", message: "文件上传等待可信批准" }));
    app.attachAuthority({ open() {}, destroy: () => true }, { execute });
    const opened = await app.open(alice);
    expect(await app.dispatch(opened.handle, alice, uploadChunk())).toEqual({
      ok: false, code: "resource_refused", resourceCode: "approval_required", message: "文件上传等待可信批准",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("checks the current instance after a slow upload and preserves concurrent projection changes", async () => {
    const app = fixture();
    let finish!: (result: SessionResourceResult) => void;
    const execute = vi.fn(() => new Promise<SessionResourceResult>((resolve) => { finish = resolve; }));
    app.attachAuthority({ open() {}, destroy: () => true }, { execute });
    const opened = await app.open(alice);
    const pending = app.dispatch(opened.handle, alice, uploadChunk());
    const pinned = await app.dispatch(opened.handle, alice, { action: "pin_session", params: { session: "session-0" } });
    const receipt = { upload_id: "abcdefghijklmnopqrstuvwx", complete: true, attachment: { path: "/tmp/upload/image.png" } };
    finish({ ok: true, result: receipt, patch: {} });
    expect(await pending).toEqual({ ok: true, result: receipt, revision: pinned.ok ? pinned.revision : -1 });

    const closed = app.dispatch(opened.handle, alice, uploadChunk());
    app.closeInstance(opened.handle, alice);
    finish({ ok: true, result: receipt, patch: {} });
    expect(await closed).toMatchObject({ ok: false, code: "invalid_instance" });
  });

  it("admits and meters one shared prompt, stops subsequent prompts after exhaustion, and revokes its live instance", async () => {
    const now = Date.now();
    const app = fixture(() => now);
    const store = new Store(":memory:");
    try {
      const sharing = new SessionSharingService(store.sessionShares, () => now); app.attachSharing(sharing);
      const resource = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: "shared" });
      const roster = { sessions: [{ resourceId: resource, deviceId: "laptop", cliKind: "codex", sessionId: "shared" }] };
      const issued = sharing.create("alice", resource, roster, []); sharing.redeem(issued.link.split("#")[1], "bob");
      const principal = { owner: "alice", credential: `bob:share:${issued.id}`, session: true, delegation: { shareId: issued.id, viewer: "bob" } };
      const operation: SessionOperationView = { id: "op-shared", owner: "alice", surface: "app:session-plus", resourceId: resource, device: "laptop", cliKind: "codex", sessionId: "shared", operation: "append_session", status: "running", submittedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), live: true, message: "running" };
      const submit = vi.fn(async () => ({ ok: true, operation }));
      const operations = new SessionPlusOperationBinding({ submit, list: () => [], subscribe: () => () => {}, endContexts: () => 0 } as unknown as SessionOperationCoordinator);
      const execute = vi.fn(async (): Promise<SessionResourceResult> => ({ ok: true, result: { private: "must not leak" }, patch: { ...roster, transcript: { [resource]: { messages: [], usage: { inputTokens: 90, cachedInputTokens: 40, outputTokens: 10 }, runtime: { turn_state: "idle", control_mode: "managed" } } } } }));
      app.attachAuthority({ open() {}, destroy: () => true }, { execute }, operations);
      const opened = await app.open(principal);
      const first = await app.dispatch(opened.handle, principal, { action: "append_session", params: { resource, prompt: "hello" } });
      expect(first).toMatchObject({ ok: true, result: { opId: "op-shared" } });
      expect(submit).toHaveBeenCalledTimes(1);
      sharing.spendCompletion("alice", "laptop", { schema: "runner-managed-completion/v1", provider: "codex", session_id: "shared", turn_id: "native", status: "succeeded", completed_at: new Date(now).toISOString(), usage: { tokens_in: 1_500_001 } });
      expect(await app.dispatch(opened.handle, principal, { action: "append_session", params: { resource, prompt: "over budget" } })).toMatchObject({ ok: false, message: expect.stringContaining("预算") });
      expect(submit).toHaveBeenCalledTimes(1);
      const read = await app.dispatch(opened.handle, principal, { action: "open_session", params: { resource } });
      expect(read).toMatchObject({ ok: true, result: null });
      const events: unknown[] = []; app.subscribe(opened.handle, principal, (event) => events.push(event));
      sharing.revoke(issued.id, "alice");
      expect(events).toContainEqual(expect.objectContaining({ type: "closed", reason: "share_revoked" }));
      expect(await app.dispatch(opened.handle, principal, { action: "open_session", params: { resource } })).toMatchObject({ ok: false });
    } finally { app.stop(); store.close(); }
  });
  it("allows a composition factory to roll back an unpublished authority attachment", () => {
    const app = fixture();
    const detach = app.attachAuthority({ open() {}, destroy: () => true });
    detach();
    detach();

    expect(() => app.attachAuthority({ open() {}, destroy: () => true })).not.toThrow();
  });

  it("keeps installed attach_image rollback releases operational", async () => {
    const current = loadSessionPlusManifest();
    const { attach_file: active, ...rollbackActions } = current.actions;
    if (!active) throw new Error("current manifest has no attach_file action");
    const legacy: SessionPlusManifest = {
      ...current,
      actions: {
        ...rollbackActions,
        attach_image: {
          ...active,
          params: {
            media_type: { ...active.params.media_type!, max: 64 },
            data: { ...active.params.data!, max: 393_216 },
            name: { ...active.params.name!, required: false },
          },
        },
      },
    };
    const attachments = vi.fn(async () => ({
      ok: true as const,
      attachment: { label: "screen.png", path: "/trusted/legacy/screen.png", bytes: 8 },
    }));
    const app = fixture(undefined, undefined, { manifest: legacy, attachments });
    app.attachAuthority({ open() {}, destroy: () => true });
    const opened = await app.open(alice);
    const result = await app.dispatch(opened.handle, alice, {
      action: "attach_image",
      params: { name: "screen.png", media_type: "image/png", data: "aGVsbG8=" },
    });
    expect(result).toMatchObject({
      ok: true,
      result: { label: "screen.png", path: "/trusted/legacy/screen.png", bytes: 8 },
    });
    expect(attachments).toHaveBeenCalledWith({
      owner: "alice",
      name: "screen.png",
      mediaType: "image/png",
      data: "aGVsbG8=",
    });
  });

  it("turns an authenticated Runner change into a content-free sessions wake", async () => {
    const app = fixture();
    const changes: Array<() => void> = [];
    let closed = false;
    const source = {
      subscribe(owner: string, listener: () => void) {
        expect(owner).toBe("alice");
        changes.push(listener);
        return () => { closed = true; };
      },
    } as SessionPlusSessionChangeBinding;
    app.attachAuthority(
      { open() {}, destroy: () => true },
      undefined,
      undefined,
      undefined,
      undefined,
      source,
    );
    const opened = await app.open(alice);
    const events: unknown[] = [];
    const subscription = app.subscribe(opened.handle, alice, (event) => events.push(event));
    expect(changes).toHaveLength(1);
    changes[0]!();
    expect(events).toContainEqual({ type: "wake", binding: "sessions", ref: "sessions" });
    subscription?.close();
    expect(app.closeInstance(opened.handle, alice)).toBe(true);
    expect(closed).toBe(true);
  });

  it("refuses an over-limit open before spending State or sandbox work", async () => {
    const resolve = vi.spyOn(InProcessStateClient.prototype, "resolveStream");
    try {
      const app = fixture(undefined, { perCredential: 1, perOwner: 1, global: 1 });
      await app.open(alice);
      resolve.mockClear();
      await expect(app.open(alice)).rejects.toThrow(/limit/);
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
    }
  });

  it("makes an existing instance stale, rather than throwing, when no release is active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-plus-app-off-"));
    dirs.push(dir);
    const state = new AppStateService(dir);
    const runtime = new AppRuntimeService(bundledAppDir("session-plus"));
    states.push(state);
    runtimes.push(runtime);
    let active: SessionPlusIdentity | null = sessionPlusIdentity();
    const app = new SessionPlusAppService({
      state: new InProcessStateClient(state),
      runtime: new InProcessRuntimeClient(runtime),
      identity: () => active,
      manifest: () => active ? loadSessionPlusManifest() : null,
    });
    apps.push(app);

    const opened = await app.open(alice);
    active = null;
    expect(await app.dispatch(opened.handle, alice, {
      action: "pin_session",
      params: { session: "demo-codex" },
    })).toMatchObject({ ok: false, code: "instance_stale" });
    expect(app.subscribe(opened.handle, alice, () => {})).toBeNull();
    await expect(app.open(alice)).rejects.toThrow(/没有可服务的 release/);
  });

  it("persists a pin through invoke -> immutable commit -> project and across tabs", async () => {
    const app = fixture();
    const one = await app.open(alice);
    expect(one.projection).toMatchObject({ pinned: [] });
    const result = await app.dispatch(one.handle, alice, { action: "pin_session", params: { session: "demo-codex" } });
    expect(result).toMatchObject({ ok: true, revision: 1, projection: { pinned: ["demo-codex"] } });
    const two = await app.open({ ...alice, credential: "ws:two" });
    expect(two.projection).toMatchObject({ pinned: ["demo-codex"] });
  });

  it("persists normalized custom titles across tabs and clears back to provider fallback", async () => {
    const app = fixture();
    const one = await app.open(alice);
    const named = await app.dispatch(one.handle, alice, {
      action: "set_session_title",
      params: { session: "demo-codex", title: "  发布   复盘  " },
    });
    expect(named).toMatchObject({
      ok: true,
      result: { session: "demo-codex", title: "发布 复盘" },
      projection: { customTitles: { "demo-codex": "发布 复盘" } },
    });
    const two = await app.open({ ...alice, credential: "ws:two" });
    expect(two.projection).toMatchObject({ customTitles: { "demo-codex": "发布 复盘" } });

    const overlong = await app.dispatch(one.handle, alice, {
      action: "set_session_title",
      params: { session: "demo-codex", title: "x".repeat(49) },
    });
    expect(overlong).toMatchObject({ ok: false, code: "action_rejected", message: "会话标题最多 48 个字符" });

    const emojiTitle = "😀".repeat(48);
    const astral = await app.dispatch(one.handle, alice, {
      action: "set_session_title",
      params: { session: "demo-codex", title: emojiTitle },
    });
    expect(astral).toMatchObject({ ok: true, result: { title: emojiTitle } });

    const cleared = await app.dispatch(two.handle, { ...alice, credential: "ws:two" }, {
      action: "set_session_title",
      params: { session: "demo-codex", title: "" },
    });
    expect(cleared).toMatchObject({ ok: true, result: { title: "" }, projection: { customTitles: {} } });
  });

  it("persists file annotations across browser instances and clears them explicitly", async () => {
    const app = fixture();
    const one = await app.open(alice);
    const fileKey = "display:laptop:octopus::docs/readme.md";
    const annotations = [{
      id: "annotation-1",
      createdAt: 1_787_830_000_000,
      updatedAt: 1_787_830_000_000,
      note: "调整文档标题",
      target: { kind: "markdown", quote: "标题", prefix: "", suffix: "正文" },
    }];
    const saved = await app.dispatch(one.handle, alice, {
      action: "set_file_annotations",
      params: { payload: JSON.stringify({ file_key: fileKey, annotations }) },
    });
    expect(saved).toMatchObject({
      ok: true,
      result: { file_key: fileKey, count: 1 },
      projection: { fileAnnotations: { [fileKey]: annotations } },
    });

    const twoPrincipal = { ...alice, credential: "ws:two" };
    const two = await app.open(twoPrincipal);
    expect(two.projection).toMatchObject({ fileAnnotations: { [fileKey]: annotations } });

    const cleared = await app.dispatch(two.handle, twoPrincipal, {
      action: "set_file_annotations",
      params: { payload: JSON.stringify({ file_key: fileKey, annotations: [] }) },
    });
    expect(cleared).toMatchObject({ ok: true, projection: { fileAnnotations: {} } });
  });

  it("persists the latest reviewed completion without regressing across tabs", async () => {
    const app = fixture();
    const one = await app.open(alice);
    const newer = "2026-08-25T10:05:00Z";
    const reviewed = await app.dispatch(one.handle, alice, {
      action: "review_session",
      params: { session: "demo-codex", completed_at: newer },
    });
    expect(reviewed).toMatchObject({
      ok: true,
      projection: { reviewedAt: { "demo-codex": newer } },
    });

    await app.dispatch(one.handle, alice, {
      action: "review_session",
      params: { session: "demo-codex", completed_at: "2026-08-25T10:00:00Z" },
    });
    const two = await app.open({ ...alice, credential: "ws:two" });
    expect(two.projection).toMatchObject({ reviewedAt: { "demo-codex": newer } });
  });

  it("keeps a tab's resource projection when a durable action commits", async () => {
    const app = fixture();
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        async execute() {
          return {
            ok: true,
            result: { count: 1 },
            patch: { sessions: [{ resourceId: "demo-codex", projectLabel: "Session Plus" }] },
          };
        },
      },
    );
    const opened = await app.open(alice);
    const refreshed = await app.dispatch(opened.handle, alice, {
      action: "refresh_sessions",
      params: { limit: "20", source: "all" },
    });
    expect(refreshed).toMatchObject({
      ok: true,
      revision: opened.revision + 1,
      projection: { sessions: [{ resourceId: "demo-codex" }] },
    });

    const pinned = await app.dispatch(opened.handle, alice, {
      action: "pin_session",
      params: { session: "demo-codex" },
    });
    expect(pinned).toMatchObject({
      ok: true,
      revision: opened.revision + 2,
      projection: {
        pinned: ["demo-codex"],
        sessions: [{ resourceId: "demo-codex", projectLabel: "Session Plus" }],
      },
    });
  });

  it("merges a slow resource result onto the projection left by a faster overlapping read", async () => {
    const app = fixture();
    let finishSlow!: (result: SessionResourceResult) => void;
    const slowResult = new Promise<SessionResourceResult>((resolve) => { finishSlow = resolve; });
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        async execute(_instanceId, action) {
          if (action === "search_sessions") return await slowResult;
          return {
            ok: true,
            result: { count: 1 },
            patch: { sessions: [{ resourceId: "new-roster-row", projectLabel: "new" }] },
          };
        },
      },
    );
    const opened = await app.open(alice);
    const slow = app.dispatch(opened.handle, alice, {
      action: "search_sessions",
      params: { query: "slow" },
    });
    const fast = await app.dispatch(opened.handle, alice, {
      action: "refresh_sessions",
      params: { limit: "20", source: "all" },
    });
    expect(fast).toMatchObject({ projection: { sessions: [{ resourceId: "new-roster-row" }] } });

    finishSlow({
      ok: true,
      result: { returned: 1 },
      patch: { search: [{ resourceId: "slow-search-hit", snippet: "found" }] },
    });
    const landed = await slow;
    expect(landed).toMatchObject({
      ok: true,
      projection: {
        sessions: [{ resourceId: "new-roster-row", projectLabel: "new" }],
        search: [{ resourceId: "slow-search-hit", snippet: "found" }],
      },
    });
  });

  it("retains both windows when overlapping transcript reads land out of order", async () => {
    const app = fixture();
    let finishSlow!: (result: SessionResourceResult) => void;
    const slowResult = new Promise<SessionResourceResult>((resolve) => { finishSlow = resolve; });
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        async execute(_instanceId, _action, params) {
          const resource = params.resource ?? "";
          if (resource === "slow-resource") return await slowResult;
          const data = { messages: [{ content: "fast" }] };
          return { ok: true, result: data, patch: { transcript: { [resource]: data } } };
        },
      },
    );
    const opened = await app.open(alice);
    const slow = app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "slow-resource" },
    });
    await app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "fast-resource" },
    });
    const slowData = { messages: [{ content: "slow" }] };
    finishSlow({
      ok: true,
      result: slowData,
      patch: { transcript: { "slow-resource": slowData } },
    });

    expect(await slow).toMatchObject({
      ok: true,
      projection: {
        transcript: {
          "fast-resource": { messages: [{ content: "fast" }] },
          "slow-resource": { messages: [{ content: "slow" }] },
        },
      },
    });
  });

  it("does not let a slow read roll one resource back from its live terminal tail", async () => {
    const app = fixture();
    let watchListener: ((event: SessionResourceWatchEvent) => void) | null = null;
    let finishSlow!: (result: SessionResourceResult) => void;
    const slowResult = new Promise<SessionResourceResult>((resolve) => { finishSlow = resolve; });
    let reads = 0;
    const historical = {
      offset: 40,
      totalMessages: 41,
      messages: [{ role: "assistant", content: "历史进度（截断）" }],
    };
    const terminal = {
      offset: 40,
      totalMessages: 42,
      messages: [
        { role: "assistant", content: "历史进度（截断）" },
        { role: "assistant", content: "运行结果收尾完成" },
      ],
    };
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        async execute() {
          reads += 1;
          if (reads === 1) {
            return { ok: true, result: historical, patch: { transcript: { session: historical } } };
          }
          return await slowResult;
        },
        watchTranscript(_id, resource, listener) {
          expect(resource).toBe("session");
          watchListener = listener;
          return { ok: true, subscription: { close() {} } };
        },
      },
    );
    const opened = await app.open(alice);
    await app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "session", limit: "200" },
    });
    const slow = app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "session", limit: "200" },
    });
    expect(watchListener).not.toBeNull();
    watchListener!({ type: "data", resource: "session", data: terminal });
    finishSlow({
      ok: true,
      result: historical,
      patch: { transcript: { session: historical } },
    });

    expect(await slow).toMatchObject({
      ok: true,
      projection: {
        transcript: {
          session: {
            offset: 40,
            totalMessages: 42,
            messages: [
              { content: "历史进度（截断）" },
              { content: "运行结果收尾完成" },
            ],
          },
        },
      },
    });
  });

  it("does not let an already-stale read replace a terminal tail", async () => {
    const app = fixture();
    const terminal = {
      offset: 40,
      totalMessages: 42,
      messages: [
        { role: "assistant", content: "历史进度（截断）" },
        { role: "assistant", content: "运行结果收尾完成" },
      ],
    };
    const historical = {
      offset: 0,
      totalMessages: 41,
      messages: [{ role: "assistant", content: "更老的 history boundary" }],
    };
    let reads = 0;
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        async execute() {
          const data = reads++ === 0 ? terminal : historical;
          return { ok: true, result: data, patch: { transcript: { session: data } } };
        },
        watchTranscript() {
          return { ok: true, subscription: { close() {} } };
        },
      },
    );
    const opened = await app.open(alice);
    await app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "session", limit: "200" },
    });

    const stale = await app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "session", limit: "200" },
    });

    expect(stale).toMatchObject({
      ok: true,
      projection: {
        transcript: {
          session: {
            offset: 40,
            totalMessages: 42,
            messages: [
              { content: "历史进度（截断）" },
              { content: "运行结果收尾完成" },
            ],
          },
        },
      },
    });
  });

  it("gives the roster and transcript distinct revisions so the View cannot drop the transcript", async () => {
    const app = fixture();
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        async execute(_instanceId, action, params): Promise<SessionResourceResult> {
          if (action === "refresh_sessions") {
            return {
              ok: true,
              result: { count: 1 },
              patch: { sessions: [{ resourceId: "local-codex", projectLabel: "开发进度" }] },
            };
          }
          const resource = params.resource ?? "";
          const data = { messages: [{ role: "user", content: "检查一下开发进度" }] };
          return { ok: true, result: data, patch: { transcript: { [resource]: data } } };
        },
      },
    );
    const opened = await app.open(alice);
    const events: unknown[] = [];
    const stream = app.subscribe(opened.handle, alice, (event) => events.push(event));

    const roster = await app.dispatch(opened.handle, alice, {
      action: "refresh_sessions",
      params: { limit: "20", source: "all" },
    });
    const transcript = await app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "local-codex", limit: "30" },
    });

    expect(stream?.initial.revision).toBe(opened.revision);
    expect(roster).toMatchObject({ ok: true, revision: opened.revision + 1 });
    expect(transcript).toMatchObject({
      ok: true,
      revision: opened.revision + 2,
      projection: {
        transcript: {
          "local-codex": { messages: [{ content: "检查一下开发进度" }] },
        },
      },
    });
    expect(events).toMatchObject([
      { type: "view", revision: opened.revision + 1 },
      { type: "view", revision: opened.revision + 2 },
    ]);
    stream?.close();
  });

  it("lets only the latest-started roster refresh publish across inverse completion and a cleared slot", async () => {
    const app = fixture();
    const pending: Array<{
      options: SessionResourceExecuteOptions | undefined;
      finish: (result: SessionResourceResult) => void;
    }> = [];
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        execute(_id, action, _params, _current, options) {
          if (action !== "refresh_sessions") throw new Error(`unexpected ${action}`);
          return new Promise<SessionResourceResult>((resolve) => pending.push({ options, finish: resolve }));
        },
      },
    );
    const opened = await app.open(alice);
    const events: unknown[] = [];
    const stream = app.subscribe(opened.handle, alice, (event) => events.push(event));

    const first = app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: {} });
    const second = app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: {} });
    expect(pending).toHaveLength(2);
    expect(pending[0]!.options?.isCurrent?.()).toBe(false);
    expect(pending[1]!.options?.isCurrent?.()).toBe(true);

    pending[1]!.finish({ ok: true, result: { version: "B" }, patch: { sessions: [{ version: "B" }] } });
    expect(await second).toMatchObject({ ok: true, revision: opened.revision + 1, projection: { sessions: [{ version: "B" }] } });

    // B's identity-cleanup removed the active map entry. C must receive a new
    // global token rather than reusing A's old per-instance value.
    const third = app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: {} });
    expect(pending).toHaveLength(3);
    expect(pending[0]!.options?.isCurrent?.()).toBe(false);
    expect(pending[2]!.options?.isCurrent?.()).toBe(true);

    pending[0]!.finish({ ok: true, result: { version: "A" }, patch: { sessions: [{ version: "A" }] } });
    expect(await first).toMatchObject({
      ok: true,
      revision: opened.revision + 1,
      projection: { sessions: [{ version: "B" }] },
    });
    expect(events).toMatchObject([{ type: "view", revision: opened.revision + 1 }]);

    pending[2]!.finish({ ok: true, result: { version: "C" }, patch: { sessions: [{ version: "C" }] } });
    expect(await third).toMatchObject({ ok: true, revision: opened.revision + 2, projection: { sessions: [{ version: "C" }] } });
    expect(events).toMatchObject([
      { type: "view", revision: opened.revision + 1, projection: { sessions: [{ version: "B" }] } },
      { type: "view", revision: opened.revision + 2, projection: { sessions: [{ version: "C" }] } },
    ]);
    stream?.close();
  });

  it("merges a trusted roster partial and final onto transcript updates made while the refresh is pending", async () => {
    const app = fixture();
    let refreshOptions: SessionResourceExecuteOptions | undefined;
    let finishRefresh!: (result: SessionResourceResult) => void;
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        async execute(_id, action, params, _current, options) {
          if (action === "open_session") {
            const resource = params.resource ?? "";
            const data = { messages: [{ content: "arrived during refresh" }] };
            return { ok: true, result: data, patch: { transcript: { [resource]: data } } };
          }
          refreshOptions = options;
          return await new Promise<SessionResourceResult>((resolve) => { finishRefresh = resolve; });
        },
      },
    );
    const opened = await app.open(alice);
    const events: unknown[] = [];
    const stream = app.subscribe(opened.handle, alice, (event) => events.push(event));
    const refresh = app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: {} });

    await app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "live-session", limit: "20" },
    });
    refreshOptions?.onPatch?.({
      sessions: [{ resourceId: "runner-fast" }],
      resourceState: "loading",
    });
    expect(events.at(-1)).toMatchObject({
      type: "view",
      projection: {
        sessions: [{ resourceId: "runner-fast" }],
        resourceState: "loading",
        transcript: { "live-session": { messages: [{ content: "arrived during refresh" }] } },
      },
    });

    finishRefresh({
      ok: true,
      result: { resourceState: "ready" },
      patch: { sessions: [{ resourceId: "runner-fast" }], resourceState: "ready" },
    });
    expect(await refresh).toMatchObject({
      ok: true,
      projection: {
        resourceState: "ready",
        transcript: { "live-session": { messages: [{ content: "arrived during refresh" }] } },
      },
    });
    stream?.close();
  });

  it("absorbs refresh partials, final patches, and refusals after supersede or close", async () => {
    const app = fixture();
    const pending: Array<{
      options: SessionResourceExecuteOptions | undefined;
      finish: (result: SessionResourceResult) => void;
    }> = [];
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        execute(_id, action, _params, _current, options) {
          if (action !== "refresh_sessions") throw new Error(`unexpected ${action}`);
          return new Promise<SessionResourceResult>((resolve) => pending.push({ options, finish: resolve }));
        },
      },
    );
    const opened = await app.open(alice);
    const events: unknown[] = [];
    app.subscribe(opened.handle, alice, (event) => events.push(event));
    const old = app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: {} });
    const refused = app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: {} });
    pending[1]!.finish({ ok: false, code: "resource_failed", message: "newest failed" });
    expect(await refused).toMatchObject({ ok: false, code: "resource_refused", resourceCode: "resource_failed", message: "newest failed" });
    pending[0]!.options?.onPatch?.({ sessions: [{ resourceId: "stale" }] });
    pending[0]!.finish({ ok: true, result: {}, patch: { sessions: [{ resourceId: "stale" }] } });
    expect(await old).toMatchObject({ ok: true, revision: opened.revision });
    expect(events).toEqual([]);

    const closing = app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: {} });
    expect(app.closeInstance(opened.handle, alice)).toBe(true);
    pending[2]!.options?.onPatch?.({ sessions: [{ resourceId: "after-close" }] });
    pending[2]!.finish({ ok: true, result: {}, patch: { sessions: [{ resourceId: "after-close" }] } });
    expect(await closing).toMatchObject({ ok: false, code: "invalid_instance" });
    expect(events).toEqual([{ type: "closed", reason: "explicit_close" }]);
  });

  it("drops forged identity fields and refuses undeclared actions", async () => {
    const app = fixture();
    const opened = await app.open(alice);
    expect(await app.dispatch(opened.handle, alice, {
      action: "delete_everything",
      params: { session: "demo-codex", owner: "root", approved: true },
    })).toMatchObject({ ok: false, code: "unknown_action" });
    expect(await app.dispatch(opened.handle, { owner: "bob", credential: "ws:one", session: true }, {
      action: "pin_session", params: { session: "demo-codex" },
    })).toMatchObject({ ok: false, code: "invalid_instance" });
    expect(await app.dispatch(opened.handle, alice, {
      action: "pin_session", params: { session: "contains whitespace" },
    })).toMatchObject({ ok: false, code: "action_rejected" });
  });

  it("ends exactly the instances tied to one browser credential", async () => {
    const app = fixture();
    const one = await app.open(alice);
    const twoPrincipal = { ...alice, credential: "ws:two" };
    const two = await app.open(twoPrincipal);
    expect(app.releaseCredential("alice", "ws:one")).toBe(1);
    expect(await app.dispatch(one.handle, alice, { action: "pin_session", params: { session: "demo-codex" } }))
      .toMatchObject({ ok: false, code: "invalid_instance" });
    expect(await app.dispatch(two.handle, twoPrincipal, { action: "pin_session", params: { session: "demo-codex" } }))
      .toMatchObject({ ok: true });
  });

  it("expires the lifecycle record without deleting durable state", async () => {
    let time = 0;
    const app = fixture(() => time);
    const opened = await app.open(alice);
    time = 5 * 60 * 60_000;
    expect(await app.dispatch(opened.handle, alice, { action: "pin_session", params: { session: "demo-codex" } }))
      .toMatchObject({ ok: false, code: "instance_expired" });
  });

  it("keeps resource authority outside Runtime and closes a live follow with the tab", async () => {
    const app = fixture();
    let instanceId = "";
    let destroyed = 0;
    let subscriptionClosed = 0;
    let watchedMaxMessages = 0;
    let watchCalls = 0;
    let watchListener: ((event: SessionResourceWatchEvent) => void) | null = null;
    const authority = {
      open(_owner: string, id: string) { instanceId = id; },
      destroy(id: string) {
        if (id !== instanceId) return false;
        destroyed += 1;
        return true;
      },
    };
    const resources: SessionResourcePort = {
      async execute() {
        const data = { rich: true, offset: 0, totalMessages: 2, messages: [{ role: "user", content: "first" }] };
        return { ok: true, result: data, patch: { transcript: { opaque_resource: data } } };
      },
      watchTranscript(_id, resource, listener, maxMessages) {
        expect(resource).toBe("opaque_resource");
        watchCalls += 1;
        watchedMaxMessages = maxMessages ?? 0;
        watchListener = listener;
        return { ok: true, subscription: { close: () => { subscriptionClosed += 1; } } };
      },
    };
    app.attachAuthority(authority, resources);
    const opened = await app.open(alice);
    const seen: unknown[] = [];
    const stream = app.subscribe(opened.handle, alice, (event) => seen.push(event));
    const read = await app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "opaque_resource", limit: "30" },
    });
    expect(read).toMatchObject({ ok: true, projection: { transcript: { opaque_resource: { rich: true } } } });
    expect(watchedMaxMessages).toBe(30);
    expect(watchCalls).toBe(1);
    await app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "opaque_resource", limit: "20", offset: "10" },
    });
    await app.dispatch(opened.handle, alice, {
      action: "open_session", params: { resource: "opaque_resource", limit: "60", offset: "0" },
    });
    expect(watchCalls).toBe(1);
    expect(watchListener).not.toBeNull();
    watchListener!({
      type: "data",
      resource: "opaque_resource",
      data: { rich: true, offset: 1, totalMessages: 2, messages: [{ role: "assistant", content: "next" }] },
    });
    expect(seen.at(-1)).toMatchObject({
      type: "view",
      projection: {
        transcriptStatus: { resource: "opaque_resource", state: "live" },
        transcript: { opaque_resource: { messages: [{ content: "first" }, { content: "next" }] } },
      },
    });
    watchListener!({
      type: "error",
      resource: "opaque_resource",
      terminal: false,
      message: "正在重试",
    });
    expect(seen.at(-1)).toMatchObject({
      type: "view",
      projection: { transcriptStatus: { resource: "opaque_resource", state: "reconnecting" } },
    });
    watchListener!({ type: "status", resource: "opaque_resource", state: "live" });
    expect(seen.at(-1)).toMatchObject({
      type: "view",
      projection: { transcriptStatus: { resource: "opaque_resource", state: "live", message: "" } },
    });
    expect(app.closeInstance(opened.handle, alice)).toBe(true);
    expect(subscriptionClosed).toBe(1);
    expect(destroyed).toBe(1);
    stream?.close();
  });

  it("returns an admitted operation receipt even when its view closes before submission settles", async () => {
    const app = fixture();
    const resource = resourceId({ owner: "alice", device: "laptop", cliKind: "codex", sessionId: "continued" });
    const operation: SessionOperationView = {
      id: "op-admitted-after-close", owner: "alice", surface: "app:session-plus", resourceId: resource,
      device: "laptop", cliKind: "codex", sessionId: "continued", operation: "append_session", status: "running",
      submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), live: true, message: "accepted",
    };
    let finish!: (value: { ok: true; operation: SessionOperationView }) => void;
    const pending = new Promise<{ ok: true; operation: SessionOperationView }>((resolve) => { finish = resolve; });
    const submit = vi.fn(() => pending);
    const operations = new SessionPlusOperationBinding({
      submit, list: () => [], subscribe: () => () => {}, endContexts: () => 0,
    } as unknown as SessionOperationCoordinator);
    app.attachAuthority({ open() {}, destroy: () => true }, {
      execute: async () => ({ ok: true, result: {}, patch: {} }),
    }, operations);
    const opened = await app.open(alice);
    const admission = app.dispatch(opened.handle, alice, { action: "append_session", params: { resource, prompt: "one input" } });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(app.closeInstance(opened.handle, alice)).toBe(true);
    finish({ ok: true, operation });
    expect(await admission).toMatchObject({ ok: true, result: { opId: operation.id }, projection: {} });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("keeps independent live resources, closes only one, and ignores its retired listener", async () => {
    const app = fixture();
    const listeners = new Map<string, (event: SessionResourceWatchEvent) => void>();
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    const watch = vi.fn((_id: string, resource: string, listener: (event: SessionResourceWatchEvent) => void) => {
      listeners.set(resource, listener);
      const close = vi.fn(); closes.set(resource, close);
      return { ok: true as const, subscription: { close } };
    });
    const execute = vi.fn(async (_id: string, _action: string, params: Readonly<Record<string, string>>): Promise<SessionResourceResult> => {
      const data = { offset: 0, totalMessages: 1, messages: [{ role: "user", content: params.resource }] };
      return { ok: true, result: data, patch: { transcript: { [params.resource]: data } } };
    });
    app.attachAuthority({ open() {}, destroy: () => true }, { execute, watchTranscript: watch });
    const opened = await app.open(alice);
    for (const resource of ["a", "b", "c", "d"]) {
      expect(await app.dispatch(opened.handle, alice, { action: "open_session", params: { resource } })).toMatchObject({ ok: true });
    }
    expect(watch).toHaveBeenCalledTimes(4);
    for (const close of closes.values()) expect(close).not.toHaveBeenCalled();
    await app.dispatch(opened.handle, alice, { action: "open_session", params: { resource: "a" } });
    expect(watch).toHaveBeenCalledTimes(4);
    for (const resource of ["a", "b", "c", "d"]) listeners.get(resource)!({
      type: "data", resource, data: { offset: 1, totalMessages: 2, messages: [{ role: "assistant", content: `live-${resource}` }] },
    });
    const closed = await app.dispatch(opened.handle, alice, { action: "close_session", params: { resource: "b" } });
    expect(closed).toMatchObject({ ok: true, projection: {
      transcriptStatuses: { a: { state: "live" }, b: { state: "closed" }, c: { state: "live" }, d: { state: "live" } },
    } });
    expect(closes.get("b")).toHaveBeenCalledTimes(1);
    expect(closes.get("a")).not.toHaveBeenCalled();
    const revision = closed.ok ? closed.revision : -1;
    listeners.get("b")!({ type: "error", resource: "b", terminal: true, message: "late" });
    const unchanged = await app.dispatch(opened.handle, alice, { action: "close_session", params: { resource: "b" } });
    expect(unchanged).toMatchObject({ ok: true, revision });
    listeners.get("c")!({ type: "error", resource: "c", terminal: true, message: "revoked" });
    expect(closes.get("c")).toHaveBeenCalledTimes(1);
    expect(closes.get("d")).not.toHaveBeenCalled();
    app.closeInstance(opened.handle, alice);
    for (const close of closes.values()) expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps following a chat whose first read hit an unreachable device, and fills it in when the device answers", async () => {
    const app = fixture();
    let listener!: (event: SessionResourceWatchEvent) => void;
    const watch = vi.fn((_id: string, _resource: string, next: (event: SessionResourceWatchEvent) => void) => {
      listener = next;
      return { ok: true as const, subscription: { close: vi.fn() } };
    });
    const execute = vi.fn(async (): Promise<SessionResourceResult> => ({
      ok: false, code: "resource_failed", message: "runner 会话资源暂时不可用",
    }));
    app.attachAuthority({ open() {}, destroy: () => true }, { execute, watchTranscript: watch });
    const opened = await app.open(alice);
    // E.g. the page reloaded right after a deploy, before the Runner was back.
    expect(await app.dispatch(opened.handle, alice, { action: "open_session", params: { resource: "session" } }))
      .toMatchObject({ ok: false, code: "resource_refused", resourceCode: "resource_failed" });
    expect(watch).toHaveBeenCalledTimes(1);
    listener({ type: "data", resource: "session", data: { offset: 0, totalMessages: 1, messages: [{ role: "assistant", content: "回来了" }] } });
    // Any later reply carries the current projection; closing an unrelated tab is the cheapest.
    expect(await app.dispatch(opened.handle, alice, { action: "close_session", params: { resource: "other" } })).toMatchObject({
      ok: true,
      projection: {
        transcript: { session: { messages: [{ content: "回来了" }] } },
        transcriptStatuses: { session: { state: "live" } },
      },
    });
  });

  it("does not follow a chat whose read was refused", async () => {
    const app = fixture();
    const watch = vi.fn(() => ({ ok: true as const, subscription: { close: vi.fn() } }));
    const execute = vi.fn(async (): Promise<SessionResourceResult> => ({ ok: false, code: "resource_denied", message: "denied" }));
    app.attachAuthority({ open() {}, destroy: () => true }, { execute, watchTranscript: watch });
    const opened = await app.open(alice);
    expect(await app.dispatch(opened.handle, alice, { action: "open_session", params: { resource: "session" } }))
      .toMatchObject({ ok: false, resourceCode: "resource_denied" });
    expect(watch).not.toHaveBeenCalled();
  });

  it("a close retires an in-flight tail and permits a fresh cached reopen", async () => {
    const app = fixture();
    let finish!: (result: SessionResourceResult) => void;
    const pending = new Promise<SessionResourceResult>((resolve) => { finish = resolve; });
    const watch = vi.fn(() => ({ ok: true as const, subscription: { close: vi.fn() } }));
    const data = { offset: 0, totalMessages: 1, messages: [{ role: "user", content: "old-read" }] };
    const result = { ok: true as const, result: data, patch: { transcript: { session: data } } };
    const execute = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(result);
    app.attachAuthority({ open() {}, destroy: () => true }, { execute, watchTranscript: watch });
    const opened = await app.open(alice);
    const oldRead = app.dispatch(opened.handle, alice, { action: "open_session", params: { resource: "session" } });
    const closed = await app.dispatch(opened.handle, alice, { action: "close_session", params: { resource: "session" } });
    finish(result);
    expect(await oldRead).toMatchObject({ ok: true, revision: closed.ok ? closed.revision : -1 });
    expect(watch).not.toHaveBeenCalled();
    await app.dispatch(opened.handle, alice, { action: "open_session", params: { resource: "session" } });
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("keeps the ninth and later reads available while pausing only the oldest follow at capacity", async () => {
    const app = fixture();
    const execute = vi.fn(async (_id, _action, params): Promise<SessionResourceResult> => ({
      ok: true, result: {}, patch: { transcript: { [params.resource]: { messages: [{ role: "user", content: params.resource }] } } },
    }));
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const watch = vi.fn(() => {
      const close = vi.fn(); closes.push(close);
      return { ok: true as const, subscription: { close } };
    });
    app.attachAuthority({ open() {}, destroy: () => true }, { execute, watchTranscript: watch });
    const opened = await app.open(alice);
    for (let index = 0; index < 65; index += 1) {
      expect(await app.dispatch(opened.handle, alice, { action: "open_session", params: { resource: `resource-${index}` } }))
        .toMatchObject({ ok: true, projection: { transcript: { [`resource-${index}`]: { messages: expect.any(Array) } } } });
    }
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).not.toHaveBeenCalled();
    const reopened = await app.dispatch(opened.handle, alice, { action: "open_session", params: { resource: "resource-0" } });
    expect(reopened).toMatchObject({ ok: true, projection: { transcriptStatuses: { "resource-1": { state: "paused" } } } });
    expect(watch).toHaveBeenCalledTimes(66);
    app.closeInstance(opened.handle, alice);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it("reconciles a workspace response against the latest projection after its read", async () => {
    const app = fixture();
    let finish!: (result: SessionResourceResult) => void;
    const pending = new Promise<SessionResourceResult>((resolve) => { finish = resolve; });
    const currentSessions = [{ resourceId: "new", messageCount: 3 }];
    const resources: SessionResourcePort = {
      execute: vi.fn(async (_id, action) => action === "refresh_workspaces" ? await pending
        : { ok: true as const, result: {}, patch: { sessions: currentSessions } }),
      reconcileWorkspacePatch: vi.fn((_id, current, patch) => ({
        ...patch, sessions: (current as { sessions: typeof currentSessions }).sessions,
      })),
    };
    app.attachAuthority({ open() {}, destroy: () => true }, resources);
    const opened = await app.open(alice);
    const workspaces = app.dispatch(opened.handle, alice, { action: "refresh_workspaces", params: { device: "laptop" } });
    await app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: {} });
    finish({ ok: true, result: {}, patch: { sessions: [{ resourceId: "old", messageCount: 1 }] } });
    expect(await workspaces).toMatchObject({ ok: true, projection: { sessions: currentSessions } });
  });

  it("does not declassify an approval-plane pending handle to the Agent View", async () => {
    const app = fixture();
    app.attachAuthority(
      { open() {}, destroy: () => true },
      {
        async execute() {
          return {
            ok: false,
            code: "approval_required",
            message: "请在可信审批栏确认",
            pendingCallId: "pc_internal_only",
          };
        },
      },
    );
    const opened = await app.open(alice);
    const result = await app.dispatch(opened.handle, alice, {
      action: "open_session",
      params: { resource: "opaque_resource", limit: "30" },
    });
    expect(result).toMatchObject({ ok: false, code: "resource_refused", resourceCode: "approval_required", message: "请在可信审批栏确认" });
    expect(JSON.stringify(result)).not.toContain("pc_internal_only");
  });

  it("routes a human-only Agent answer through the trusted interaction binding", async () => {
    const app = fixture();
    // A real minted id: device, CLI and session id are rebound from it, so a
    // placeholder string here would test a shape the View never receives.
    const resource = resourceId({
      owner: "alice",
      device: "laptop",
      cliKind: "claude",
      sessionId: "session-1",
    });
    const interactionId = "ai_current";
    const interaction = {
      id: interactionId,
      provider: "claude",
      kind: "question",
      title: "Claude Code 需要你的回答",
      questions: [{
        id: "acceptance",
        header: "验收结果",
        prompt: "网页闭环是否通过？",
        options: [{ label: "通过" }],
        multiple: false,
        allow_other: false,
        secret: false,
      }],
      capabilities: { respond: true, allow: true, deny: true },
    };
    const resources: SessionResourcePort = {
      async execute(_id, action): Promise<SessionResourceResult> {
        if (action === "refresh_sessions") {
          const sessions = [{
            resourceId: resource,
            deviceId: "laptop",
            cliKind: "claude",
            sessionId: "session-1",
          }];
          return { ok: true, result: { sessions }, patch: { sessions } };
        }
        if (action === "open_session") {
          const window = {
            messages: [],
            runtime: {
              process_state: "alive",
              turn_state: "needs_input",
              capabilities: { respond: true },
              interaction,
            },
          };
          return { ok: true, result: window, patch: { transcript: { [resource]: window } } };
        }
        throw new Error(`unexpected ${action}`);
      },
    };
    const respondInteraction = vi.fn(async () => ({ ok: true as const, data: { ok: true } }));
    app.attachAuthority(
      { open() {}, destroy: () => true },
      resources,
      undefined,
      undefined,
      new SessionPlusInteractionBinding({ respondInteraction } as unknown as Pick<
        SessionHubService,
        "respondInteraction"
      >),
    );
    const opened = await app.open(alice);
    await app.dispatch(opened.handle, alice, { action: "refresh_sessions", params: { source: "all", limit: "20" } });
    await app.dispatch(opened.handle, alice, { action: "open_session", params: { resource, limit: "30" } });
    const responseJson = JSON.stringify({ decision: "allow", answers: { acceptance: ["通过"] } });
    const result = await app.dispatch(opened.handle, alice, {
      action: "respond_agent_interaction",
      params: {
        resource,
        interaction_id: interactionId,
        response_json: responseJson,
        owner: "mallory",
        provider: "codex",
      },
    });
    expect(result).toMatchObject({ ok: true, projection: { transcript: { [resource]: { runtime: {} } } } });
    expect(JSON.stringify(result)).not.toContain(interactionId);
    expect(respondInteraction).toHaveBeenCalledWith(expect.objectContaining({ username: "alice", session: true }), {
      owner: "alice",
      device: "laptop",
      provider: "claude",
      sessionId: "session-1",
      interactionId,
      responseJson,
    });
  });

  it("rebinds writes to trusted projections and keeps approval handles outside the View", async () => {
    const app = fixture();
    let instanceId = "";
    let operationListener: ((operation: SessionOperationView) => void) | null = null;
    let subscriptionClosed = 0;
    const submitted: unknown[] = [];
    const ended: Array<{ owner: string; contexts: readonly string[] }> = [];
    const internalOperation: SessionOperationView = {
      id: "op_trusted",
      owner: "alice",
      surface: "app:session-plus",
      resourceId: "spr_opaque",
      device: "laptop",
      cliKind: "claude",
      sessionId: "",
      operation: "start_session",
      status: "waiting_approval",
      pendingCallId: "pc_must_stay_trusted",
      submittedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      live: true,
      message: "等待你批准",
    };
    const coordinator = {
      async submit(surface: string, principal: unknown, input: unknown) {
        submitted.push({ surface, principal, input });
        return {
          ok: true as const,
          operation: internalOperation,
          settled: Promise.resolve({ view: internalOperation }),
        };
      },
      list() { return [internalOperation]; },
      subscribe(_owner: string, listener: (operation: SessionOperationView) => void) {
        operationListener = listener;
        return () => { subscriptionClosed += 1; };
      },
      endContexts(owner: string, contexts: readonly string[]) {
        ended.push({ owner, contexts });
        return contexts.length;
      },
    } as unknown as SessionOperationCoordinator;
    const resources: SessionResourcePort = {
      async execute(_id, action) {
        if (action !== "refresh_workspaces") throw new Error(`unexpected ${action}`);
        const workspaces = {
          device: "laptop",
          workspaces: [{
            id: "ws_0123456789abcdef01234567",
            label: "Trusted label",
            display: "~/trusted-display",
          }],
        };
        return { ok: true, result: workspaces, patch: { workspaces } };
      },
    };
    app.attachAuthority(
      {
        open(_owner, id) { instanceId = id; },
        contextIds(id) { return id === instanceId ? ["ctx_trusted_runner"] : []; },
        destroy: () => true,
      },
      resources,
      new SessionPlusOperationBinding(coordinator),
    );

    const opened = await app.open(alice);
    const instanceEvents: unknown[] = [];
    const instanceSubscription = app.subscribe(opened.handle, alice, (event) => instanceEvents.push(event));
    expect(JSON.stringify(opened.projection)).not.toContain("pc_must_stay_trusted");
    expect(JSON.stringify(opened.projection)).not.toContain('"owner":"alice"');
    await app.dispatch(opened.handle, alice, {
      action: "refresh_workspaces",
      params: { device: "laptop" },
    });
    const result = await app.dispatch(opened.handle, alice, {
      action: "start_session",
      params: {
        device: "laptop",
        workspace_id: "ws_0123456789abcdef01234567",
        source: "claude",
        prompt: "开始",
        workspace_label: "forged label",
        workspace_display: "/canonical/secret",
        client_request_id: "op_forged",
        owner: "mallory",
      },
    });
    expect(result).toMatchObject({ ok: true, result: { opId: "op_trusted", status: "waiting_approval" } });
    expect(JSON.stringify(result)).not.toContain("pc_must_stay_trusted");
    expect(submitted).toMatchObject([{
      surface: "app:session-plus",
      input: {
        instanceId,
        action: "start_session",
        source: "claude",
        prompt: "开始",
        target: {
          kind: "workspace",
          workspace: {
            device: "laptop",
            id: "ws_0123456789abcdef01234567",
            label: "Trusted label",
            display: "~/trusted-display",
          },
        },
      },
    }]);
    expect(JSON.stringify(submitted)).not.toContain("forged label");
    expect(operationListener).not.toBeNull();
    operationListener!(internalOperation);
    expect(instanceEvents.at(-1)).toMatchObject({
      type: "op",
      operation: { id: "op_trusted", status: "waiting_approval" },
    });
    expect(JSON.stringify(instanceEvents.at(-1))).not.toContain("pc_must_stay_trusted");

    expect(app.closeInstance(opened.handle, alice)).toBe(true);
    expect(subscriptionClosed).toBe(1);
    expect(ended).toEqual([{ owner: "alice", contexts: ["ctx_trusted_runner"] }]);
    instanceSubscription?.close();
  });
});

/**
 * The typed-resource half: one handle per instance, opened before the tab has
 * read anything and closed with it.
 *
 * Every assertion counts what reached the BINDER, not what came back, because
 * the interesting failures are all "a provider was opened when it should not
 * have been": a release with no plan, a proposal after the tab closed, or a
 * refusal that quietly became a generic rejection and lost the sentence a
 * person could act on.
 */
describe("SessionPlusAppService typed resources", () => {
  const PLAN_DOC = {
    schema: "agent-resource-bindings/v1",
    app: "session-plus",
    bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
    connections: [{ instance: "files", port: "workspace-files/v1", binding: "workspace" }],
  };

  function binderFixture(options: { plan?: boolean } = {}) {
    const opened: Array<Record<string, unknown>> = [];
    const dispatched: Array<{ action: string; params: Record<string, string> }> = [];
    const closed: string[] = [];
    let answer: { ok: true; result: unknown } | { ok: false; code: string; message: string } = {
      ok: true,
      result: { roots: [], truncated: false },
    };
    const read = readResourceBindings(PLAN_DOC);
    if (!read.ok) throw new Error("bad fixture");
    /** Runs while a dispatch is awaiting the device, to simulate a race. */
    let duringRead: (() => void) | null = null;
    const binder = {
      planFor: () => (options.plan === false ? null : read.value),
      openInstance: (identity: Record<string, unknown>) => {
        opened.push(identity);
        return {
          dispatch: async (proposal: { action: string; params: Readonly<Record<string, string>> }) => {
            dispatched.push({ action: proposal.action, params: { ...proposal.params } });
            duringRead?.();
            return answer;
          },
          close: async () => {
            closed.push(String(identity.instance));
          },
        };
      },
    };
    return {
      binder,
      opened,
      dispatched,
      closed,
      refuse(code: string, message: string) {
        answer = { ok: false, code, message };
      },
      whileReading(fn: () => void) {
        duringRead = fn;
      },
    };
  }

  function appWithBinder(binder: Parameters<SessionPlusAppService["attachAuthority"]>[3]) {
    const app = fixture();
    app.attachAuthority(
      { open: () => ({}), destroy: () => true },
      undefined,
      undefined,
      binder,
    );
    return app;
  }

  it("registers the instance before it has read anything, with the full trusted identity", async () => {
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    // Registered at open, not on the first read: a tab closed before its first
    // file request must be a RETIRED instance rather than a provider that gets
    // opened minutes later by a late message.
    expect(harness.opened).toHaveLength(1);
    expect(harness.opened[0]).toMatchObject({
      owner: "alice",
      publisher: sessionPlusIdentity().publisher,
      app: "session-plus",
      packageDigest: sessionPlusIdentity().packageDigest,
      permissionContractDigest: sessionPlusIdentity().permissionContractDigest,
    });
    expect(String(harness.opened[0]!.instance)).toBeTruthy();
    expect(harness.dispatched).toHaveLength(0);
    expect(opened.handle).toBeTruthy();
  });

  it("routes a resource proposal to the handle without touching the App's action surface", async () => {
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    const out = await app.dispatch(opened.handle, alice, {
      action: "resource.refresh_roots",
      params: { binding: "workspace" },
    }, opened.resourceGeneration);
    expect(out).toMatchObject({ ok: true, result: { roots: [], truncated: false } });
    expect(harness.dispatched).toEqual([
      { action: "resource.refresh_roots", params: { binding: "workspace" } },
    ]);
  });

  it("retires one iframe generation before publishing the next resource handle", async () => {
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    expect(opened.resourceGeneration).toBe(1);

    expect(app.resetResourceGeneration(opened.handle, alice, 1)).toBe(2);
    expect(harness.closed).toEqual([expect.stringContaining(":resource:1")]);
    expect(harness.opened).toHaveLength(2);
    expect(harness.opened[1]).toMatchObject({ instance: expect.stringContaining(":resource:2") });
    // A duplicate/lost-response retry is idempotent: no third handle and no
    // second teardown. Anything older than that still conflicts below.
    expect(app.resetResourceGeneration(opened.handle, alice, 1)).toBe(2);
    expect(harness.closed).toHaveLength(1);
    expect(harness.opened).toHaveLength(2);

    expect(await app.dispatch(opened.handle, alice, {
      action: "resource.refresh_roots",
      params: { binding: "workspace" },
    }, 1)).toMatchObject({ ok: false, code: "resource_refused", resourceCode: "scope_closed",
      // The refusal tells the person the action did not run and what to do next.
      message: expect.stringMatching(/没有执行.*重新操作/) });
    expect(harness.dispatched).toHaveLength(0);

    expect(await app.dispatch(opened.handle, alice, {
      action: "resource.refresh_roots",
      params: { binding: "workspace" },
    }, 2)).toMatchObject({ ok: true });
    expect(harness.dispatched).toHaveLength(1);
    expect(app.resetResourceGeneration(opened.handle, alice, 0)).toBeNull();
  });

  it("does not answer an old read that crosses a generation reset", async () => {
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    harness.whileReading(() => {
      expect(app.resetResourceGeneration(opened.handle, alice, opened.resourceGeneration)).toBe(2);
    });
    const out = await app.dispatch(opened.handle, alice, {
      action: "resource.refresh_roots",
      params: { binding: "workspace" },
    }, opened.resourceGeneration);
    expect(out).toMatchObject({ ok: false, code: "resource_refused", resourceCode: "scope_closed" });
  });

  it("does not leak an old provider refusal across a generation reset", async () => {
    const harness = binderFixture();
    harness.refuse("approval_required", "旧代次的批准提示");
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    harness.whileReading(() => {
      expect(app.resetResourceGeneration(opened.handle, alice, opened.resourceGeneration)).toBe(2);
    });
    const out = await app.dispatch(opened.handle, alice, {
      action: "resource.open_text",
      params: { binding: "workspace", ref: "wf_old" },
    }, opened.resourceGeneration);
    expect(out).toMatchObject({ ok: false, code: "resource_refused", resourceCode: "scope_closed" });
    expect(out).not.toMatchObject({ message: "旧代次的批准提示" });
  });

  it("does not leak an old provider refusal after its tab closes", async () => {
    const harness = binderFixture();
    harness.refuse("approval_required", "已经关闭的批准提示");
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    harness.whileReading(() => app.closeInstance(opened.handle, alice));
    const out = await app.dispatch(opened.handle, alice, {
      action: "resource.open_text",
      params: { binding: "workspace", ref: "wf_old" },
    }, opened.resourceGeneration);
    expect(out).toMatchObject({ ok: false, code: "invalid_instance" });
    expect(out).not.toMatchObject({ message: "已经关闭的批准提示" });
  });

  it("bounds a proposal's parameters without knowing what any of them mean", async () => {
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    await app.dispatch(opened.handle, alice, {
      action: "resource.list_directory",
      params: {
        binding: "workspace",
        ref: "wf_dir",
        NotAKey: "dropped",
        nested: { hostile: true },
        number: 7,
      } as never,
    }, opened.resourceGeneration);
    const params = harness.dispatched[0]!.params;
    expect(params.ref).toBe("wf_dir");
    expect(params.NotAKey).toBeUndefined();
    expect(params.nested).toBeUndefined();
    expect(params.number).toBeUndefined();
  });

  /**
   * The editor batch's wire ruling, at the point where it is enforced.
   *
   * 512 characters is still the bound for a parameter nobody declared anything
   * about. A contract may raise it for ONE parameter of one action, and the
   * coordinator honours the declaration it compiled in — reached through the
   * binding name in the App's own plan, never through anything the View says.
   */
  describe("declared parameter bounds", () => {
    const DIGEST = `sha256:${"a".repeat(64)}`;

    async function propose(params: Record<string, unknown>, action = "resource.replace_text") {
      const harness = binderFixture();
      const app = appWithBinder(harness.binder);
      const opened = await app.open(alice);
      const out = await app.dispatch(
        opened.handle,
        alice,
        { action, params: params as never },
        opened.resourceGeneration,
      );
      return { out, dispatched: harness.dispatched };
    }

    it("carries a whole file body on the one parameter the contract declares large", async () => {
      const text = "x".repeat(200_000);
      const { out, dispatched } = await propose({
        binding: "workspace",
        ref: "wf_file",
        expected_digest: DIGEST,
        text,
      });
      expect(out).toMatchObject({ ok: true });
      expect(dispatched[0]!.params.text).toHaveLength(200_000);
    });

    it("refuses an undeclared parameter of the same action over the default bound", async () => {
      // Raising `text` raised nothing else. `ref` is declared at 200, so 600
      // characters is over the wire's default and the proposal never leaves.
      const { out, dispatched } = await propose({
        binding: "workspace",
        ref: "r".repeat(600),
        expected_digest: DIGEST,
        text: "hi",
      });
      expect(out).toMatchObject({ ok: false, code: "resource_refused", resourceCode: "invalid_request" });
      expect(dispatched).toEqual([]);
    });

    it("refuses a body over the bound the contract declared", async () => {
      const { out, dispatched } = await propose({
        binding: "workspace",
        ref: "wf_file",
        expected_digest: DIGEST,
        text: "x".repeat(WORKSPACE_FILES_LIMITS.maxWriteTextBytes + 1),
      });
      expect(out).toMatchObject({ ok: false, resourceCode: "invalid_request" });
      expect(dispatched).toEqual([]);
    });

    it("refuses a body over the wire's ceiling", async () => {
      const { out, dispatched } = await propose({
        binding: "workspace",
        ref: "wf_file",
        expected_digest: DIGEST,
        text: "x".repeat(WIRE_PARAM_LIMITS.maxDeclaredValueLength + 1),
      });
      expect(out).toMatchObject({ ok: false, resourceCode: "invalid_request" });
      expect(dispatched).toEqual([]);
    });

    it("gives an invented binding name the default bound, not a raised one", async () => {
      // The binding selects among what the App's PLAN declared. A name that is
      // not in it resolves to no contract, so every parameter falls back to 512
      // — the narrow answer for every unknown.
      const { out, dispatched } = await propose({
        binding: "not-in-the-plan",
        ref: "wf_file",
        expected_digest: DIGEST,
        text: "x".repeat(600),
      });
      expect(out).toMatchObject({ ok: false, resourceCode: "invalid_request" });
      expect(dispatched).toEqual([]);
    });

    it("gives an invented action the default bound", async () => {
      const { out, dispatched } = await propose(
        { binding: "workspace", text: "x".repeat(600) },
        "resource.replace_text_v2",
      );
      expect(out).toMatchObject({ ok: false, resourceCode: "invalid_request" });
      expect(dispatched).toEqual([]);
    });

    it("keeps 512 for a read action's parameters", async () => {
      const { out, dispatched } = await propose(
        { binding: "workspace", ref: "r".repeat(513) },
        "resource.open_text",
      );
      expect(out).toMatchObject({ ok: false, resourceCode: "invalid_request" });
      expect(dispatched).toEqual([]);
    });
  });

  it("answers with the projection as it is AFTER the read, not as it was before", async () => {
    // The frame host replaces the View's projection with whatever a reply
    // carries. A file read can take seconds, and a transcript frame can arrive
    // over SSE while it does — so replying with the copy captured before the
    // await would silently revert that update in the tab.
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    harness.whileReading(() => {
      app.instances.update(opened.handle, {
        ...(opened.projection as Record<string, never>),
        notice: "arrived while the device was being read",
      } as never);
    });
    const out = await app.dispatch(opened.handle, alice, {
      action: "resource.read_workspace_text",
      params: { binding: "workspace", ref: "wf_x" },
    }, opened.resourceGeneration);
    expect(out).toMatchObject({
      ok: true,
      projection: { notice: "arrived while the device was being read" },
    });
  });

  it("refuses rather than answering a tab that ended while the device was read", async () => {
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    harness.whileReading(() => app.closeInstance(opened.handle, alice));
    const out = await app.dispatch(opened.handle, alice, {
      action: "resource.refresh_roots",
      params: { binding: "workspace" },
    }, opened.resourceGeneration);
    expect(out).toMatchObject({ ok: false, code: "invalid_instance" });
  });

  it("passes a provider's own refusal code through instead of flattening it", async () => {
    const harness = binderFixture();
    harness.refuse("approval_required", "这次读取需要设备主人先确认。");
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    const out = await app.dispatch(opened.handle, alice, {
      action: "resource.open_text",
      params: { binding: "workspace", ref: "r-1" },
    }, opened.resourceGeneration);
    // `approval_required` is an instruction. Collapsing it into
    // `action_rejected` would replace it with "the action was refused".
    expect(out).toMatchObject({
      ok: false,
      code: "resource_refused",
      resourceCode: "approval_required",
      message: "这次读取需要设备主人先确认。",
    });
  });

  it("refuses every resource proposal when the release ships no plan", async () => {
    const harness = binderFixture({ plan: false });
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    expect(harness.opened).toHaveLength(0);
    const out = await app.dispatch(opened.handle, alice, {
      action: "resource.refresh_roots",
      params: { binding: "workspace" },
    }, opened.resourceGeneration);
    expect(out).toMatchObject({ ok: false, code: "action_rejected" });
    expect(harness.dispatched).toHaveLength(0);
  });

  it("refuses a resource proposal when no catalog was composed at all", async () => {
    const app = fixture();
    app.attachAuthority({ open: () => ({}), destroy: () => true });
    const opened = await app.open(alice);
    expect(await app.dispatch(opened.handle, alice, {
      action: "resource.refresh_roots",
      params: { binding: "workspace" },
    }, opened.resourceGeneration)).toMatchObject({ ok: false, code: "action_rejected" });
  });

  it("closes the handle when the tab closes, and refuses afterwards", async () => {
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    expect(app.closeInstance(opened.handle, alice)).toBe(true);
    expect(harness.closed).toHaveLength(1);
    expect(await app.dispatch(opened.handle, alice, {
      action: "resource.refresh_roots",
      params: { binding: "workspace" },
    }, opened.resourceGeneration)).toMatchObject({ ok: false, code: "invalid_instance" });
    expect(harness.dispatched).toHaveLength(0);
  });

  it("closes the handle when the credential ends and when the owner does", async () => {
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    await app.open(alice);
    await app.open({ ...alice, credential: "ws:two" });
    expect(app.releaseCredential("alice", "ws:one")).toBe(1);
    expect(harness.closed).toHaveLength(1);
    expect(app.releaseOwner("alice")).toBe(1);
    expect(harness.closed).toHaveLength(2);
  });

  it("leaves an unknown non-resource action alone", async () => {
    const harness = binderFixture();
    const app = appWithBinder(harness.binder);
    const opened = await app.open(alice);
    expect(await app.dispatch(opened.handle, alice, { action: "resourceish", params: {} }))
      .toMatchObject({ ok: false, code: "unknown_action" });
    expect(harness.dispatched).toHaveLength(0);
  });
});
